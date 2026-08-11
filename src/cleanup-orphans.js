// One-shot: deletes products with no image and no price history (dead catalog entries).
import { prisma } from "./db.js";

const result = await prisma.product.deleteMany({
  where: { image: null, prices: { none: {} } },
});
console.log(`Deleted ${result.count} orphan product(s) with no image and no price history.`);
await prisma.$disconnect();
