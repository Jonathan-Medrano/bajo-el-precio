/**
 * Catalog seed + price updater via ML Search API.
 *
 * Strategy: the ML Search API (/sites/MLA/search) works from cloud IPs without auth,
 * and returns current prices in every result. We use it both to:
 *   a) discover new products (save to DB if not exists)
 *   b) update prices for existing products (save a new PricePoint)
 *
 * Run: node src/seed-catalog.js [--dry-run]
 * Or via admin endpoint: POST /admin/seed-catalog
 */

import { prisma } from "./db.js";
import { pathToFileURL } from "node:url";

const DRY_RUN = process.argv.includes("--dry-run");

// 60+ curated queries across all major ML Argentina categories.
// Mix of categories, brands, subcategories, and price-range terms.
const SEARCH_QUERIES = [
  // Celulares y telefonía
  { category: "Celulares", q: "celular samsung galaxy" },
  { category: "Celulares", q: "iphone apple usado" },
  { category: "Celulares", q: "motorola moto g" },
  { category: "Celulares", q: "xiaomi redmi note" },
  { category: "Celulares", q: "celular 5g barato" },
  { category: "Celulares", q: "celular libre android" },

  // Notebooks y computación
  { category: "Notebooks", q: "notebook lenovo intel" },
  { category: "Notebooks", q: "laptop hp core i5" },
  { category: "Notebooks", q: "macbook pro apple" },
  { category: "Notebooks", q: "notebook acer aspire" },
  { category: "Notebooks", q: "notebook gamer rtx" },
  { category: "Computación", q: "mouse teclado inalambrico" },
  { category: "Computación", q: "monitor led 24 pulgadas" },
  { category: "Computación", q: "disco ssd 1tb" },
  { category: "Computación", q: "ram ddr4 16gb" },

  // Televisores
  { category: "Televisores", q: "smart tv samsung 55 4k" },
  { category: "Televisores", q: "televisor lg oled" },
  { category: "Televisores", q: "smart tv tcl 50 google tv" },
  { category: "Televisores", q: "smart tv 43 pulgadas hd" },

  // Audio
  { category: "Auriculares", q: "auriculares bluetooth sony" },
  { category: "Auriculares", q: "airpods apple" },
  { category: "Auriculares", q: "auriculares inalambricos jbl" },
  { category: "Auriculares", q: "auriculares gaming rgb" },
  { category: "Audio", q: "parlante bluetooth portatil" },
  { category: "Audio", q: "soundbar samsung" },

  // Gaming
  { category: "Gaming", q: "playstation 5 ps5" },
  { category: "Gaming", q: "nintendo switch oled" },
  { category: "Gaming", q: "xbox series x controller" },
  { category: "Gaming", q: "joystick dualsense ps5" },
  { category: "Gaming", q: "silla gamer ergonomica" },
  { category: "Gaming", q: "monitor gamer 144hz" },

  // Tablets
  { category: "Tablets", q: "tablet samsung galaxy tab" },
  { category: "Tablets", q: "ipad apple" },
  { category: "Tablets", q: "tablet xiaomi android" },

  // Relojes y wearables
  { category: "Relojes inteligentes", q: "smartwatch samsung galaxy watch" },
  { category: "Relojes inteligentes", q: "reloj inteligente xiaomi band" },
  { category: "Relojes inteligentes", q: "apple watch serie" },

  // Fotografía
  { category: "Cámaras", q: "camara mirrorless sony alpha" },
  { category: "Cámaras", q: "camara reflex canon nikon" },
  { category: "Cámaras", q: "gopro action camera" },

  // Electrodomésticos
  { category: "Electrodomésticos", q: "heladera no frost inverter" },
  { category: "Electrodomésticos", q: "lavarropas automatico 8kg" },
  { category: "Electrodomésticos", q: "microondas samsung digital" },
  { category: "Electrodomésticos", q: "aire acondicionado split frio calor" },
  { category: "Electrodomésticos", q: "aspiradora robot irobot" },

  // Cocina y hogar
  { category: "Hogar", q: "cafetera nespresso dolce gusto" },
  { category: "Hogar", q: "freidora de aire philips" },
  { category: "Hogar", q: "licuadora procesadora" },

  // Herramientas
  { category: "Herramientas", q: "taladro atornillador inalambrico dewalt" },
  { category: "Herramientas", q: "amoladora angular bosch" },
  { category: "Herramientas", q: "soldadora inverter" },
  { category: "Herramientas", q: "compresor de aire portatil" },

  // Automotor
  { category: "Automotor", q: "dashcam camara auto" },
  { category: "Automotor", q: "sensor estacionamiento auto" },
  { category: "Automotor", q: "aceite motor 10w40" },
  { category: "Automotor", q: "bateria auto 12v" },

  // Deportes
  { category: "Deportes", q: "bicicleta rodado 29" },
  { category: "Deportes", q: "cinta de correr electrica" },

  // Impresión 3D
  { category: "Impresión 3D", q: "filamento pla 1.75mm" },
  { category: "Impresión 3D", q: "impresora 3d bambu creality" },

  // Streaming y TV
  { category: "Streaming", q: "chromecast google tv" },
  { category: "Streaming", q: "amazon fire tv stick" },
  { category: "Streaming", q: "roku streaming" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Search ML for products and save prices for both new and existing products.
 * This is the core loop: search API → upsert product → save pricePoint.
 */
async function runSearchSeed({ resultsPerQuery = 50, delayMs = 300 } = {}) {
  console.log(`[seed] ${new Date().toISOString()} — ${SEARCH_QUERIES.length} queries × ${resultsPerQuery} resultados`);

  let totalNew = 0, totalUpdated = 0;

  for (const { category, q } of SEARCH_QUERIES) {
    try {
      const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=${resultsPerQuery}&fields=results.id,results.title,results.price,results.thumbnail,results.permalink,results.catalog_product_id`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`  [${category}] HTTP ${res.status} para "${q}"`);
        await sleep(delayMs * 3);
        continue;
      }
      const data = await res.json();
      const items = data?.results ?? [];

      let newCount = 0, updCount = 0;
      for (const item of items) {
        const rawId = item.id?.replace(/-/g, "").toUpperCase();
        if (!rawId?.startsWith("MLA")) continue;
        const price = item.price ? Math.round(item.price) : null;
        if (!price) continue;

        if (DRY_RUN) {
          console.log(`  [dry] ${rawId} $${price} ${item.title?.slice(0, 40)}`);
          continue;
        }

        // Upsert product — update metadata if exists, create if new
        const existing = await prisma.product.findUnique({ where: { id: rawId } });
        if (!existing) {
          await prisma.product.create({
            data: {
              id: rawId,
              title: item.title ?? "Producto",
              url: item.permalink ?? null,
              image: item.thumbnail ?? null,
              category,
              lastTracked: new Date(),
            },
          });
          newCount++;
        } else {
          // Update stale metadata (title/image can change over time)
          await prisma.product.update({
            where: { id: rawId },
            data: {
              ...(item.title && { title: item.title }),
              ...(item.thumbnail && { image: item.thumbnail }),
              ...(item.permalink && { url: item.permalink }),
              lastTracked: new Date(),
            },
          });
          updCount++;
        }

        // Always save current price as a new datapoint
        await prisma.pricePoint.create({ data: { productId: rawId, price } });
      }

      totalNew += newCount;
      totalUpdated += updCount;
      console.log(`  [${category}] "${q}" → ${items.length} items, ${newCount} nuevos, ${updCount} actualizados`);
    } catch (e) {
      console.warn(`  [${category}] error en "${q}": ${e.message}`);
    }

    await sleep(delayMs);
  }

  console.log(`[seed] terminado: ${totalNew} nuevos, ${totalUpdated} precios actualizados`);
  return { totalNew, totalUpdated };
}

export async function seedCatalog(opts = {}) {
  return runSearchSeed(opts);
}

/**
 * For products in DB that weren't updated by the general seed queries,
 * search ML by their title and try to find a matching price.
 * Covers ~30-60% of uncovered products (those that appear in ML search results).
 */
export async function refreshUncoveredProducts({ limit = 150, delayMs = 250 } = {}) {
  const cutoff = new Date(Date.now() - 8 * 3_600_000);
  const products = await prisma.product.findMany({
    where: {
      prices: { some: {} },
      OR: [{ lastTracked: null }, { lastTracked: { lt: cutoff } }],
    },
    select: { id: true, title: true },
    orderBy: { lastTracked: "asc" },
    take: limit,
  });

  if (!products.length) {
    console.log("[refresh] all products recently updated");
    return { updated: 0 };
  }

  console.log(`[refresh] checking ${products.length} stale products via title search`);
  let updated = 0;

  for (const product of products) {
    try {
      const q = product.title.slice(0, 55).trim();
      const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}&limit=20&fields=results.id,results.price,results.thumbnail,results.permalink`;
      const res = await fetch(url);
      if (!res.ok) { await sleep(delayMs * 3); continue; }
      const data = await res.json();
      const match = data?.results?.find(r => r.id === product.id);
      if (match?.price) {
        await prisma.pricePoint.create({ data: { productId: product.id, price: Math.round(match.price) } });
        await prisma.product.update({
          where: { id: product.id },
          data: {
            lastTracked: new Date(),
            ...(match.thumbnail && { image: match.thumbnail }),
            ...(match.permalink && { url: match.permalink }),
          },
        });
        updated++;
      } else {
        // Not found in results — mark as checked so we don't retry for 8h
        await prisma.product.update({ where: { id: product.id }, data: { lastTracked: new Date() } });
      }
    } catch (e) {
      console.warn(`[refresh] ${product.id}: ${e.message}`);
    }
    await sleep(delayMs);
  }

  console.log(`[refresh] done: ${updated}/${products.length} prices updated`);
  return { updated };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSearchSeed({ resultsPerQuery: 50 });
  await prisma.$disconnect();
}
