import { pathToFileURL } from "node:url";
import { prisma } from "./db.js";
import { readItemsBatchFromApi, readProductPriceFromApi, readProductPrice, closeContext } from "./ml/price-reader.js";
import { onNewPrice } from "./alerts.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => Math.floor(a + Math.random() * (b - a));
// Máximo de bloqueos CONSECUTIVOS antes de abortar el ciclo.
// Un bloqueo no es definitivo: ML suele desbloquearse en 30-60s, así que dormimos y reintentamos.
const MAX_CONSECUTIVE_BLOCKS = 3;
// Tras un bloqueo: esperar entre 45s y 90s antes de seguir (deja que ML se olvide de nosotros).
const BLOCK_SLEEP_MS = () => jitter(45_000, 90_000);

async function savePrice(product, price, title, image, cheapestUrl) {
  await prisma.pricePoint.create({ data: { productId: product.id, price } });
  await prisma.product.update({
    where: { id: product.id },
    data: {
      lastScraped: new Date(),
      ...(title && { title }),
      ...(image && { image }),
      // Actualizar url al listing más barato actual para que el botón "Ver en ML" apunte al mejor precio.
      ...(cheapestUrl && { url: cheapestUrl }),
    },
  });
  await onNewPrice(product.id, price);
  console.log(`  ${product.id} $${price}`);
}

/**
 * Ciclo del tracker con API-first:
 *  1. Agrupa productos por tipo: MLA* (batch API) vs MLAU* / desconocidos.
 *  2. Batchea los MLA* → una request cada 20 productos.
 *  3. Los que no obtuvieron precio (o son MLAU*) → Playwright como fallback.
 */
export async function trackerCycle({ limit = 200 } = {}) {
  // Prioridad: productos con alertas activas > más buscados > más viejos (stale-first).
  // lastScraped es @updatedAt (nunca null) — lo comparamos directo con el umbral de 2h.
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  const products = await prisma.product.findMany({
    where: { lastScraped: { lt: twoHoursAgo } },
    orderBy: [
      { alerts: { _count: "desc" } },
      { queries: "desc" },
      { lastScraped: "asc" },
    ],
    take: limit,
  });
  console.log(`[${new Date().toISOString()}] Tracker: ${products.length} productos`);

  // Separar por tipo
  const mlaItems = products.filter((p) => /^MLA\d/i.test(p.id));
  const others = products.filter((p) => !/^MLA\d/i.test(p.id));
  const playwrightFallback = [];

  // ── FASE 1: batch API para items MLA* ────────────────────────────────────
  if (mlaItems.length) {
    console.log(`  API batch: ${mlaItems.length} items MLA*`);
    const ids = mlaItems.map((p) => p.id);
    const apiResults = await readItemsBatchFromApi(ids);

    for (const p of mlaItems) {
      const r = apiResults.get(p.id);
      if (r?.price) {
        await savePrice(p, r.price, r.title, r.image, r.cheapestUrl);
      } else {
        playwrightFallback.push(p); // no vino precio → Playwright
      }
    }
    console.log(`  API: ${apiResults.size} OK, ${playwrightFallback.length} fallback Playwright`);
  }

  // ── FASE 2: MLAU* via API (catalog search) ───────────────────────────────
  for (const p of others) {
    try {
      const r = await readProductPriceFromApi(p.id);
      if (r?.price) {
        await savePrice(p, r.price, r.title, r.image, r.cheapestUrl);
      } else {
        playwrightFallback.push(p);
      }
    } catch {
      playwrightFallback.push(p);
    }
  }

  // ── FASE 3: Playwright fallback ──────────────────────────────────────────
  if (playwrightFallback.length) {
    console.log(`  Playwright fallback: ${playwrightFallback.length} productos`);
    let consecutiveBlocks = 0;
    for (const p of playwrightFallback) {
      try {
        const r = await readProductPrice(p.id, p.url ?? undefined);
        if (r.blocked) {
          consecutiveBlocks++;
          const waitMs = BLOCK_SLEEP_MS();
          console.warn(`  ${p.id} bloqueado (${consecutiveBlocks}/${MAX_CONSECUTIVE_BLOCKS}) — esperando ${(waitMs/1000).toFixed(0)}s`);
          if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
            console.warn("  demasiados bloqueos consecutivos, abortando Playwright");
            break;
          }
          await sleep(waitMs);
          continue;
        }
        consecutiveBlocks = 0; // reset tras éxito
        if (r.price) await savePrice(p, r.price, r.title, r.image);
      } catch (e) {
        console.warn(`  ${p.id} error: ${e.message}`);
      }
      await sleep(jitter(3000, 7000));
    }
  }

  await closeContext();
  console.log("Ciclo del tracker terminado.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--loop")) {
    const hours = Number(process.env.TRACK_INTERVAL_HOURS) || 6;
    console.log(`Tracker en LOOP cada ${hours}h.`);
    for (;;) {
      await trackerCycle();
      console.log(`Próximo ciclo en ${hours}h.`);
      await new Promise((r) => setTimeout(r, hours * 3_600_000));
    }
  } else {
    await trackerCycle();
    await prisma.$disconnect();
  }
}
