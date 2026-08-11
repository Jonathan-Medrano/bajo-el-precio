/**
 * One-shot recategorization of existing products using the ML /items?ids= batch API.
 * Fixes products whose category was derived from the search query instead of ML's own
 * category (e.g. smartwatches ending up under "Celulares").
 *
 * Run: node src/recategorize.js [--dry-run]
 * Or via admin endpoint: POST /admin/recategorize
 */
import { pathToFileURL } from "node:url";
import { prisma } from "./db.js";
import { fetchItemsBatch } from "./ml/api-client.js";
import { mapMlCategory } from "./ml/categories.js";

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH = 20; // /items?ids= max
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function recategorize() {
  const products = await prisma.product.findMany({
    where: { id: { startsWith: "MLA" } },
    select: { id: true, category: true },
  });

  console.log(`[recategorize] ${products.length} productos MLA*`);
  let changed = 0, skipped = 0;

  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    const ids = batch.map((p) => p.id);

    let items;
    try {
      items = await fetchItemsBatch(ids);
    } catch (e) {
      console.warn(`[recategorize] batch error: ${e.message}`);
      await sleep(2000);
      continue;
    }

    for (const entry of items ?? []) {
      if (entry.code !== 200 || !entry.body) continue;
      const item = entry.body;
      const resolved = mapMlCategory(item.category_id, null);
      if (!resolved) { skipped++; continue; }

      const existing = batch.find((p) => p.id === item.id);
      if (!existing || existing.category === resolved) { skipped++; continue; }

      if (DRY_RUN) {
        console.log(`  [dry] ${item.id}: "${existing.category}" → "${resolved}" (${item.category_id})`);
        changed++;
        continue;
      }

      await prisma.product.update({
        where: { id: item.id },
        data: { category: resolved },
      });
      console.log(`  ${item.id}: "${existing.category}" → "${resolved}"`);
      changed++;
    }

    if (i + BATCH < products.length) await sleep(300);
    if ((i / BATCH) % 20 === 0) console.log(`  ${i + batch.length}/${products.length} procesados, ${changed} cambios`);
  }

  console.log(`[recategorize] listo: ${changed} recategorizados, ${skipped} sin cambio`);
  return { changed, skipped };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await recategorize();
  await prisma.$disconnect();
}
