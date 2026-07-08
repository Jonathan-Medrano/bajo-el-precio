// Trae imágenes de los productos sin imagen, vía la API de ML (/products/{id}). Rápido, sin browser.
import { pathToFileURL } from "node:url";
import { prisma } from "./db.js";
import { getAppToken } from "./ml/auth.js";

export async function enrichImages() {
  const products = await prisma.product.findMany({ where: { image: null }, select: { id: true } });
  console.log(`${products.length} productos sin imagen.`);
  const token = await getAppToken();
  let n = 0;
  for (const p of products) {
    try {
      const res = await fetch(`https://api.mercadolibre.com/products/${p.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const img = data.pictures?.[0]?.secure_url ?? data.pictures?.[0]?.url ?? null;
      if (img) {
        await prisma.product.update({ where: { id: p.id }, data: { image: img } });
        n++;
      }
    } catch {
      /* skip */
    }
  }
  console.log(`${n} imágenes agregadas.`);
  return n;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await enrichImages();
  await prisma.$disconnect();
}
