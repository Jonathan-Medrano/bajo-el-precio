import { pathToFileURL } from "node:url";
import { prisma } from "./db.js";
import { readCatalogProduct } from "./ml/catalog-price.js";
import { onNewPrice } from "./alerts.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Concurrencia segura: 8 requests en paralelo con 400ms entre batches.
const CONCURRENCY = 8;
const BATCH_DELAY_MS = 400;

async function refreshProduct(p) {
  const needsMeta = !p.title || p.title === "(por scrapear)" || !p.image;
  const r = await readCatalogProduct(p.id, { withMeta: needsMeta });
  if (r.blocked) return false;

  // Persist title/image regardless of price — stubs need metadata even with no active listing.
  const metaUpdate = {};
  if (r.title) metaUpdate.title = r.title;
  if (r.image) metaUpdate.image = r.image;
  if (r.cheapestUrl) metaUpdate.url = r.cheapestUrl;

  if (!r.price) {
    if (Object.keys(metaUpdate).length) {
      await prisma.product.update({ where: { id: p.id }, data: metaUpdate });
    }
    return false;
  }

  const lastPoint = await prisma.pricePoint.findFirst({
    where: { productId: p.id },
    orderBy: { seenAt: "desc" },
    select: { price: true },
  });
  if (!lastPoint || lastPoint.price !== r.price) {
    await prisma.pricePoint.create({ data: { productId: p.id, price: r.price } });
    await onNewPrice(p.id, r.price);
  }
  await prisma.product.update({
    where: { id: p.id },
    data: { lastTracked: new Date(), ...metaUpdate },
  });
  console.log(`  ${p.id} $${r.price}`);
  return true;
}

/**
 * Tracker via ML /products/{id}/items (Bearer auth required).
 * Works for all catalog product IDs — the vast majority of ML Argentina products.
 * Playwright removed: blocked from Fly.io cloud IPs regardless.
 */
export async function trackerCycle({ limit = 200 } = {}) {
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
  const products = await prisma.product.findMany({
    where: { OR: [{ lastTracked: null }, { lastTracked: { lt: twoHoursAgo } }] },
    orderBy: [{ alerts: { _count: "desc" } }, { queries: "desc" }, { lastTracked: "asc" }],
    take: limit,
    select: { id: true, title: true, image: true },
  });
  console.log(`[${new Date().toISOString()}] Tracker: ${products.length} productos`);

  let ok = 0, skip = 0;
  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(refreshProduct));
    ok += results.filter(Boolean).length;
    skip += results.filter(r => !r).length;
    if (i + CONCURRENCY < products.length) await sleep(BATCH_DELAY_MS);
  }

  console.log(`Tracker terminado: ${ok} OK, ${skip} sin precio.`);
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
