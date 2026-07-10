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
import { searchProducts } from "./ml/api-client.js";
import { mapMlCategory } from "./ml/categories.js";
import { pathToFileURL } from "node:url";

const DRY_RUN = process.argv.includes("--dry-run");

// 120+ curated queries across major ML Argentina categories.
// Covers tech, lifestyle, fashion, beauty, home, and sports — the highest-volume segments.
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
  { category: "Computación", q: "teclado mecanico inalambrico oficina" },
  { category: "Computación", q: "webcam full hd 1080p streaming" },
  { category: "Computación", q: "disco rigido externo 2tb 4tb" },
  { category: "Computación", q: "hub usb tipo c multipuertos" },
  { category: "Computación", q: "tarjeta de video rtx 4060 rx 7600" },

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
  { category: "Gaming", q: "juego ps5 xbox serie x fisico" },
  { category: "Gaming", q: "auricular gaming headset 7.1" },
  { category: "Gaming", q: "teclado mecanico gaming rgb" },
  { category: "Gaming", q: "mouse gamer logitech razer" },
  { category: "Gaming", q: "capture card capturadora hdmi" },

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
  { category: "Deportes", q: "bicicleta electrica plegable" },
  { category: "Deportes", q: "mancuernas pesas ajustables" },
  { category: "Deportes", q: "raqueta padel adidas head" },
  { category: "Deportes", q: "pelota futbol nike adidas" },
  { category: "Deportes", q: "colchoneta yoga pilates" },

  // Impresión 3D
  { category: "Impresión 3D", q: "filamento pla 1.75mm" },
  { category: "Impresión 3D", q: "impresora 3d bambu creality" },

  // Streaming y TV
  { category: "Streaming", q: "chromecast google tv" },
  { category: "Streaming", q: "amazon fire tv stick" },
  { category: "Streaming", q: "roku streaming" },

  // Zapatillas y calzado deportivo
  { category: "Zapatillas", q: "zapatillas nike running hombre" },
  { category: "Zapatillas", q: "zapatillas adidas mujer" },
  { category: "Zapatillas", q: "zapatillas new balance 574" },
  { category: "Zapatillas", q: "zapatillas puma fila hombre" },
  { category: "Zapatillas", q: "zapatillas converse all star" },
  { category: "Zapatillas", q: "zapatillas basquet jordan nike" },
  { category: "Zapatillas", q: "zapatillas trail running" },

  // Indumentaria deportiva
  { category: "Indumentaria", q: "ropa deportiva conjunto gym mujer" },
  { category: "Indumentaria", q: "buzo canguro adidas nike hoodie" },
  { category: "Indumentaria", q: "short deportivo dry fit hombre" },

  // Perfumes y fragancias
  { category: "Perfumes", q: "perfume carolina herrera 212" },
  { category: "Perfumes", q: "perfume paco rabanne one million" },
  { category: "Perfumes", q: "perfume armani versace hombre" },
  { category: "Perfumes", q: "perfume mujer chanel dior" },
  { category: "Perfumes", q: "colonia masiva importada" },

  // Belleza y cosméticos
  { category: "Belleza", q: "maquillaje maybelline loreal base" },
  { category: "Belleza", q: "secador de pelo profesional" },
  { category: "Belleza", q: "plancha de pelo ghd babyliss" },
  { category: "Belleza", q: "kit cuidado de la piel crema serum" },
  { category: "Belleza", q: "depiladora electrica mujer" },

  // Suplementos deportivos
  { category: "Suplementos", q: "whey protein 1kg 3kg" },
  { category: "Suplementos", q: "creatina monohidrato 500g" },
  { category: "Suplementos", q: "pre workout xtend bcaa" },
  { category: "Suplementos", q: "vitamina c zinc omega 3" },
  { category: "Suplementos", q: "proteina vegana colageno" },

  // Colchones y descanso
  { category: "Colchones", q: "colchon resortes dos plazas" },
  { category: "Colchones", q: "colchon memory foam serta" },
  { category: "Colchones", q: "sommier y colchon 140x190" },
  { category: "Colchones", q: "almohada cervical visco" },

  // Muebles y escritorios
  { category: "Muebles", q: "escritorio esquinero oficina casa" },
  { category: "Muebles", q: "silla ergonomica oficina lumbar" },
  { category: "Muebles", q: "cajonera organizador madera melamina" },
  { category: "Muebles", q: "estanteria biblioteca modular" },

  // Cámaras de seguridad
  { category: "Seguridad", q: "camara ip wifi interior exterior" },
  { category: "Seguridad", q: "kit cctv 4 camaras grabador dvr" },
  { category: "Seguridad", q: "alarma wifi inalambrica casa" },
  { category: "Seguridad", q: "timbre con camara video doorbell" },

  // Smart home y domótica
  { category: "Smart Home", q: "alexa echo dot amazon" },
  { category: "Smart Home", q: "google home nest mini" },
  { category: "Smart Home", q: "lamparas led inteligentes smart wifi" },
  { category: "Smart Home", q: "enchufe smart wifi inteligente" },

  // Energía y UPS
  { category: "Energía", q: "ups estabilizador de tension 1000va" },
  { category: "Energía", q: "generador electrico grupo electrogeno" },
  { category: "Energía", q: "panel solar kit hogar" },

  // Impresoras
  { category: "Impresoras", q: "impresora multifuncion hp epson" },
  { category: "Impresoras", q: "impresora laser monocromatica" },
  { category: "Impresoras", q: "tinta cartucho hp epson original" },

  // Redes y networking
  { category: "Redes", q: "router wifi 6 mesh ax" },
  { category: "Redes", q: "repetidor wifi tp-link extensor" },
  { category: "Redes", q: "switch ethernet 8 puertos gigabit" },

  // Bebés y niños
  { category: "Bebés", q: "cochecito bebe travel system" },
  { category: "Bebés", q: "silla de auto bebe isofix" },
  { category: "Bebés", q: "cuna para bebe colecho" },
  { category: "Bebés", q: "juguete educativo lego playmobil" },
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
      const data = await searchProducts(q, resultsPerQuery).catch(e => {
        console.warn(`  [${category}] error en "${q}": ${e.message}`);
        return null;
      });
      if (!data) { await sleep(delayMs * 3); continue; }
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

        const thumb = item.secure_thumbnail || item.thumbnail || null;
        const resolvedCategory = mapMlCategory(item.category_id, category);

        // Upsert product — update metadata if exists, create if new
        const existing = await prisma.product.findUnique({ where: { id: rawId } });
        if (!existing) {
          await prisma.product.create({
            data: {
              id: rawId,
              title: item.title ?? "Producto",
              url: item.permalink ?? null,
              image: thumb,
              category: resolvedCategory,
              lastTracked: new Date(),
            },
          });
          newCount++;
        } else {
          await prisma.product.update({
            where: { id: rawId },
            data: {
              ...(item.title && { title: item.title }),
              ...(thumb && !existing.image && { image: thumb }),
              ...(item.permalink && { url: item.permalink }),
              // Update category only when we have a ML-native one (overrides query-derived)
              ...(item.category_id && { category: resolvedCategory }),
              lastTracked: new Date(),
            },
          });
          updCount++;
        }

        // Only save a new price point if the price changed since the last recording
        const lastPoint = await prisma.pricePoint.findFirst({
          where: { productId: rawId },
          orderBy: { seenAt: "desc" },
          select: { price: true },
        });
        if (!lastPoint || lastPoint.price !== price) {
          await prisma.pricePoint.create({ data: { productId: rawId, price } });
        }
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
      const data = await searchProducts(q, 20).catch(() => null);
      if (!data) { await sleep(delayMs * 3); continue; }
      const match = data?.results?.find(r => r.id === product.id);
      if (match?.price) {
        const newPrice = Math.round(match.price);
        const lastPoint = await prisma.pricePoint.findFirst({
          where: { productId: product.id },
          orderBy: { seenAt: "desc" },
          select: { price: true },
        });
        if (!lastPoint || lastPoint.price !== newPrice) {
          await prisma.pricePoint.create({ data: { productId: product.id, price: newPrice } });
        }
        await prisma.product.update({
          where: { id: product.id },
          data: {
            lastTracked: new Date(),
            ...((match.secure_thumbnail || match.thumbnail) && { image: match.secure_thumbnail || match.thumbnail }),
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
