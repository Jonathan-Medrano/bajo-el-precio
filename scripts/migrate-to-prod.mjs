/**
 * Exporta productos de la DB local y los importa en producción.
 * Uso: node scripts/migrate-to-prod.mjs [BATCH_SIZE]
 */
import { PrismaClient } from "@prisma/client";

const LOCAL_DB = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/keepa";
const PROD_URL = process.env.PROD_URL || "https://bajoelprecio.fly.dev";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) { console.error("Falta ADMIN_TOKEN env var"); process.exit(1); }
const BATCH = Number(process.argv[2] || 200);

const prisma = new PrismaClient({ datasources: { db: { url: LOCAL_DB } } });

const products = await prisma.product.findMany({
  where: { prices: { some: {} } },
  select: {
    id: true, title: true, url: true, image: true, category: true,
    prices: { orderBy: { seenAt: "desc" }, take: 1, select: { price: true } },
  },
  orderBy: { queries: "desc" },
});
await prisma.$disconnect();

const flat = products.map(p => ({
  id: p.id,
  title: p.title,
  url: p.url,
  image: p.image,
  category: p.category,
  price: p.prices[0]?.price ?? null,
}));

console.log(`Exportados ${flat.length} productos. Enviando en batches de ${BATCH}...`);

let total = 0;
for (let i = 0; i < flat.length; i += BATCH) {
  const batch = flat.slice(i, i + BATCH);
  const r = await fetch(`${PROD_URL}/admin/import-products`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ products: batch }),
  });
  const d = await r.json();
  total += d.imported ?? 0;
  console.log(`  batch ${Math.floor(i/BATCH)+1}: +${d.imported} importados, ${d.skipped} skipped`);
}
console.log(`\nTotal importados: ${total}/${flat.length}`);
