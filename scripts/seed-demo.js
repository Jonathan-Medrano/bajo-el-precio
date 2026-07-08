// Siembra un historial DEMO (de ejemplo) para mostrar que el gráfico funciona.
// Los datos reales los acumula el tracker con el tiempo.
import { prisma } from "../src/db.js";

const id = "MLAU3829685373";
const DAY = 86_400_000;
const now = Date.now();

const series = [310000, 305000, 299999, 312000, 308000, 285000, 272000, 279000, 295000, 299999, 281092];
const points = series.map((price, i) => ({
  productId: id,
  price,
  seenAt: new Date(now - (series.length - 1 - i) * 3 * DAY), // cada 3 días hacia atrás
}));

await prisma.product.upsert({
  where: { id },
  update: {},
  create: {
    id,
    title: "Celular Samsung Galaxy A16 128 Gb 4 Gb De Ram 50 Mpx Negro",
    url: "https://www.mercadolibre.com.ar/up/MLAU3829685373",
  },
});
await prisma.pricePoint.deleteMany({ where: { productId: id } });
await prisma.pricePoint.createMany({ data: points });

console.log(`Sembrados ${points.length} puntos DEMO para ${id} (último: $${series.at(-1).toLocaleString("es-AR")})`);
await prisma.$disconnect();
