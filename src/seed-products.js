// Siembra productos populares (recorriendo el árbol de categorías de ML) para que el tracker los siga.
import { pathToFileURL } from "node:url";
import { prisma } from "./db.js";
import { discoverProducts } from "./ml/discover.js";

export async function seedProducts() {
  const products = await discoverProducts({
    onProgress: ({ done, total, found, group }) => {
      if (done % 25 === 0 || done === total) {
        console.log(`  categorías ${done}/${total} — ${found} productos (${group})`);
      }
    },
  });
  console.log(`Descubiertos ${products.length} productos populares.`);
  let n = 0;
  for (const p of products) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: { category: p.category },
      create: {
        id: p.id,
        title: "(por scrapear)",
        url: `https://www.mercadolibre.com.ar/p/${p.id}`,
        category: p.category,
      },
    });
    n++;
  }
  console.log(`Seedeados ${n} productos para trackear.`);
  return n;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seedProducts();
  await prisma.$disconnect();
}
