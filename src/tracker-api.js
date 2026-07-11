// Tracker por API: re-lee el precio de TODOS los productos trackeados vía /products/:id/items.
// Sin Playwright ni anti-bot → no hay tope práctico: barre todo el catálogo trackeado por ciclo.
// (El tracker.js con Playwright queda como fallback para casos que la API no cubra.)
import { pathToFileURL } from "node:url";
import { prisma } from "./db.js";
import { readCatalogProduct } from "./ml/catalog-price.js";
import { onNewPrice } from "./alerts.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEEDS_META = (p) => !p.title || p.title === "(por scrapear)" || !p.image;

/** Un ciclo: lee y guarda un PricePoint por cada producto trackeado. */
export async function trackerApiCycle({ limit = 100000, delayMs = 120 } = {}) {
  const products = await prisma.product.findMany({
    orderBy: [{ queries: "desc" }, { lastScraped: "asc" }],
    take: limit,
    select: { id: true, title: true, image: true },
  });
  console.log(`[${new Date().toISOString()}] Tracker API: ${products.length} productos`);

  let ok = 0, noprice = 0, blocked = 0;
  for (const p of products) {
    try {
      const r = await readCatalogProduct(p.id, { withMeta: NEEDS_META(p) });
      if (r.blocked) {
        blocked++;
        await sleep(2000); // backoff suave ante rate-limit (429/403)
        continue;
      }
      if (r.price) {
        await prisma.pricePoint.create({ data: { productId: p.id, price: r.price } });
        await onNewPrice(p.id, r.price);
        ok++;
        if (ok % 100 === 0) console.log(`  ${ok} con precio... (último ${p.id} $${r.price})`);
      } else {
        noprice++;
      }
      // Persist title/image regardless of price — image can come back even when no active listing
      if (r.title || r.image) {
        await prisma.product.update({
          where: { id: p.id },
          data: {
            ...(r.title ? { title: r.title } : {}),
            ...(r.image ? { image: r.image } : {}),
          },
        });
      }
    } catch (e) {
      console.warn(`  ${p.id} error: ${e.message}`);
    }
    await sleep(delayMs);
  }
  console.log(`Ciclo API terminado. ok=${ok} sin_precio=${noprice} bloqueos=${blocked}`);
  return { ok, noprice, blocked };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--loop")) {
    const hours = Number(process.env.TRACK_INTERVAL_HOURS) || 6;
    console.log(`🔁 Tracker API en LOOP cada ${hours}h.`);
    for (;;) {
      await trackerApiCycle();
      console.log(`Próximo ciclo en ${hours}h.`);
      await sleep(hours * 3_600_000);
    }
  } else {
    await trackerApiCycle();
    await prisma.$disconnect();
  }
}
