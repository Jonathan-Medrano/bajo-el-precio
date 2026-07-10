// Trae imágenes de los productos sin imagen, vía la API de ML.
// Estrategia: /products/{id} → pictures[0]
//             Fallback 1: /products/{id}/items → thumbnail del mejor item
//             Fallback 2: /items/{item_id} → pictures[0] del item (alta resolución)
import { pathToFileURL } from "node:url";
import { prisma } from "./db.js";
import { getAppToken } from "./ml/auth.js";

const ML = "https://api.mercadolibre.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BATCH = 8;
const DELAY_MS = 300;

async function fetchImage(id, token) {
  const headers = { Authorization: `Bearer ${token}` };

  // All IDs use the catalog product path — /items/{id} is blocked from cloud IPs.
  // 1) Catalog product metadata — higher-quality pictures
  try {
    const res = await fetch(`${ML}/products/${id}`, { headers });
    if (res.ok) {
      const data = await res.json();
      const pic = data.pictures?.[0];
      const img = pic?.secure_url || pic?.url || null;
      if (img) return img;
    }
  } catch { /* continue to fallback */ }

  // 2) Fallback: thumbnail + item_id — try active items first, then any status
  for (const suffix of ["?status=active&sort=price_asc&limit=1", "?sort=price_asc&limit=1"]) {
    try {
      const res = await fetch(`${ML}/products/${id}/items${suffix}`, { headers });
      if (res.ok) {
        const data = await res.json();
        const item = data.results?.[0];
        const thumb = item?.secure_thumbnail || item?.thumbnail || null;
        if (thumb) return thumb;

        // 3) Deep fallback: high-res pictures from the item listing itself
        if (item?.item_id) {
          try {
            const itemRes = await fetch(`${ML}/items/${item.item_id}`, { headers });
            if (itemRes.ok) {
              const itemData = await itemRes.json();
              const pic = itemData.pictures?.[0];
              const img = pic?.secure_url || pic?.url || null;
              if (img) return img;
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  // 4) Last resort: search API with catalog_product_id filter
  try {
    const res = await fetch(
      `${ML}/sites/MLA/search?catalog_product_id=${id}&limit=1&fields=results.thumbnail,results.secure_thumbnail`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      const result = data.results?.[0];
      const img = result?.secure_thumbnail || result?.thumbnail || null;
      if (img) return img;
    }
  } catch { /* skip */ }

  return null;
}

async function fetchImageByTitle(title, token) {
  if (!title) return null;
  const headers = { Authorization: `Bearer ${token}` };
  const q = encodeURIComponent(title.slice(0, 80));
  try {
    const res = await fetch(
      `${ML}/sites/MLA/search?q=${q}&limit=1&fields=results.thumbnail,results.secure_thumbnail`,
      { headers }
    );
    if (res.ok) {
      const data = await res.json();
      const r = data.results?.[0];
      return r?.secure_thumbnail ?? r?.thumbnail ?? null;
    }
  } catch { /* skip */ }
  return null;
}

export async function enrichImages() {
  const products = await prisma.product.findMany({ where: { OR: [{ image: null }, { image: "" }] }, select: { id: true, title: true } });
  console.log(`${products.length} productos sin imagen.`);
  if (!products.length) return 0;

  const token = await getAppToken();
  let n = 0;

  for (let i = 0; i < products.length; i += BATCH) {
    const batch = products.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (p) => {
        let img = await fetchImage(p.id, token);
        // 5th fallback: title-based search when all catalog/item APIs fail
        if (!img) img = await fetchImageByTitle(p.title, token);
        if (img) {
          await prisma.product.update({ where: { id: p.id }, data: { image: img } });
          n++;
        }
      })
    );
    if (i + BATCH < products.length) await sleep(DELAY_MS);
    if ((i / BATCH) % 10 === 0) console.log(`  ${i + batch.length}/${products.length} procesados, ${n} imágenes`);
  }

  console.log(`${n} imágenes agregadas.`);
  return n;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await enrichImages();
  await prisma.$disconnect();
}
