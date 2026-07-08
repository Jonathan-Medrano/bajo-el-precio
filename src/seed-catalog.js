/**
 * Seed the catalog with popular/trending products from MercadoLibre Argentina.
 *
 * Sources:
 *  1. ML "Tendencias" page — most searched terms right now
 *  2. ML highlighted sections per category (Tecnología, Gaming, Electro, etc.)
 *
 * Run: node src/seed-catalog.js [--dry-run]
 * Or via admin endpoint: POST /admin/seed-catalog  (requires ADMIN_TOKEN header)
 */

import { chromium } from "playwright";
import { prisma } from "./db.js";
import { readProductPrice } from "./ml/price-reader.js";
import { parseProductId } from "./link-parser.js";
import { pathToFileURL } from "node:url";
import { searchProducts } from "./ml/api-client.js";

const DRY_RUN = process.argv.includes("--dry-run");
// Web page for trending searches (Playwright scrapes the HTML)
const ML_TRENDS_URL = "https://tendencias.mercadolibre.com.ar/";

// Top categories seeded with ML search/listing URLs — curated from ML trends July 2026:
// Smart TV, celulares 5G, Gaming, Notebooks IA, Auriculares, Relojes inteligentes, Electro inverter
const CATEGORY_SEEDS = [
  { category: "Gaming",            url: "https://listado.mercadolibre.com.ar/videojuegos/_Deals_true" },
  { category: "Celulares",         url: "https://listado.mercadolibre.com.ar/celulares-smartphones/celulares-y-smartphones/_Deals_true" },
  { category: "Notebooks",         url: "https://listado.mercadolibre.com.ar/computacion/laptops-y-accesorios/laptops-y-accesorios/_Deals_true" },
  { category: "Televisores",       url: "https://listado.mercadolibre.com.ar/electronica/television/televisores/_Deals_true" },
  { category: "Auriculares",       url: "https://listado.mercadolibre.com.ar/electronica/audio/auriculares/_Deals_true" },
  { category: "Relojes inteligentes", url: "https://listado.mercadolibre.com.ar/electronica/relojes-accesorios/smartwatch-y-relojes-inteligentes/_Deals_true" },
  { category: "Electrodomésticos", url: "https://listado.mercadolibre.com.ar/electrodomesticos/_Deals_true" },
  { category: "Consolas",          url: "https://listado.mercadolibre.com.ar/videojuegos/consolas-y-videojuegos/_Deals_true" },
  { category: "Tablets",           url: "https://listado.mercadolibre.com.ar/computacion/tablets-y-accesorios/_Deals_true" },
];

const SEARCH_QUERIES = [
  { category: "Celulares",           q: "celular smartphone 5g" },
  { category: "Notebooks",           q: "notebook laptop i7" },
  { category: "Televisores",         q: "smart tv 4k" },
  { category: "Gaming",              q: "playstation xbox gaming" },
  { category: "Auriculares",         q: "auriculares bluetooth inalambricos" },
  { category: "Relojes inteligentes", q: "smartwatch reloj inteligente" },
  { category: "Electrodomésticos",   q: "heladera no frost inverter" },
  { category: "Consolas",            q: "consola ps5 nintendo switch" },
  { category: "Tablets",             q: "tablet android 10 pulgadas" },
  { category: "Cámaras",             q: "camara mirrorless" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => Math.floor(a + Math.random() * (b - a));

async function getContext() {
  return chromium.launchPersistentContext(
    process.env.BROWSER_PROFILE || ".browser",
    {
      headless: process.env.HEADLESS !== "0",
      viewport: { width: 1366, height: 900 },
      locale: "es-AR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      args: ["--disable-blink-features=AutomationControlled"],
    }
  );
}

/** Scrape the ML trends page to get top search keywords + product links. */
async function scrapeTrends(ctx) {
  const page = await ctx.newPage();
  const products = [];
  try {
    await page.goto(ML_TRENDS_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("a[href*='mercadolibre.com.ar']", { timeout: 10000 }).catch(() => {});

    const links = await page.$$eval("a[href*='mercadolibre.com.ar/']", (anchors) =>
      anchors
        .map((a) => ({ href: a.href, text: a.textContent?.trim() }))
        .filter((l) => /\/(MLA|MLAU)\d/.test(l.href) && l.href.includes("mercadolibre.com.ar"))
    );
    products.push(...links.slice(0, 20));
    console.log(`  [tendencias] ${products.length} links encontrados`);
  } catch (e) {
    console.warn(`  [tendencias] error: ${e.message}`);
  } finally {
    await page.close();
  }
  return products;
}

/** Scrape top N product links from a category listing page. */
async function scrapeCategory(ctx, { category, url }, limit = 10) {
  const page = await ctx.newPage();
  const products = [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Wait for any product link to appear (ML 2025+ layout)
    await page.waitForSelector("a[href]", { timeout: 12000 }).catch(() => {});
    await sleep(2000); // let JS render

    // ML uses several layouts; grab ALL links that look like product URLs
    const links = await page.$$eval("a[href]", (anchors) =>
      anchors
        .map((a) => a.href)
        .filter((h) => h && /mercadolibre\.com\.ar\/(p\/|[^/]+-)?(MLA|MLAU)[-\d]/.test(h))
        .slice(0, 30)
    );
    const unique = [...new Set(links)].slice(0, limit);
    for (const href of unique) {
      products.push({ href, category });
    }
    console.log(`  [${category}] ${products.length} productos encontrados`);
  } catch (e) {
    console.warn(`  [${category}] error: ${e.message}`);
  } finally {
    await page.close();
  }
  return products;
}

async function seedFromApi(limit = 10) {
  console.log("\nFase API: buscando con ML Search API");
  const results = [];
  for (const { category, q } of SEARCH_QUERIES) {
    try {
      const data = await searchProducts(q, 50);
      const items = (data?.results ?? []).slice(0, limit);
      for (const r of items) {
        const rawId = r.catalog_product_id ?? r.id ?? "";
        const id = rawId.replace(/-/g, "").toUpperCase();
        if (!id.startsWith("MLA")) continue;
        results.push({ id, title: r.title, url: r.permalink, image: r.thumbnail, category, price: r.price ? Math.round(r.price) : null });
      }
      console.log(`  [${category}] ${items.length} productos`);
    } catch (e) {
      console.warn(`  [${category}] error: ${e.message}`);
    }
    await sleep(500);
  }
  return results;
}

/** Save a product to DB if it doesn't exist yet. */
async function saveProduct({ id, title, url, image, category, price }) {
  if (DRY_RUN) {
    console.log(`  [dry-run] ${id} | ${title?.slice(0, 50)} | $${price}`);
    return;
  }
  await prisma.product.upsert({
    where: { id },
    update: { ...(title && { title }), ...(image && { image }), ...(category && { category }), queries: { increment: 0 } },
    create: { id, title: title ?? "Producto", url, image, category },
  });
  if (price) {
    await prisma.pricePoint.create({ data: { productId: id, price } });
  }
  console.log(`  ✓ ${id} | $${price?.toLocaleString("es-AR") ?? "?"} | ${category ?? ""}`);
}

export async function seedCatalog({ categorySeedLimit = 10, trendLimit = 15 } = {}) {
  console.log(`\n[seed-catalog] ${new Date().toISOString()}${DRY_RUN ? " (DRY RUN)" : ""}`);
  const allLinks = [];

  // Fase 1: ML Search API (rápido, sin Playwright)
  const apiResults = await seedFromApi(categorySeedLimit);
  allLinks.push(...apiResults);
  console.log(`\nFase API: ${apiResults.length} links encontrados`);

  // Fase 2: Playwright (fallback si la API no encontró suficiente)
  if (apiResults.length < 30) {
    const ctx = await getContext();
    try {
      console.log("\nFase Playwright fallback");
      const trendLinks = await scrapeTrends(ctx);
      allLinks.push(...trendLinks.slice(0, trendLimit).map((l) => ({ href: l.href, category: "Tendencias" })));
      await sleep(jitter(1000, 2000));
      for (const seed of CATEGORY_SEEDS) {
        const catLinks = await scrapeCategory(ctx, seed, categorySeedLimit);
        allLinks.push(...catLinks);
        await sleep(jitter(1500, 3000));
      }
    } finally {
      await ctx.close();
    }
  }

  // Fase 3: guardar los que vienen de la API (ya tienen id, title, price)
  let savedApi = 0;
  for (const item of apiResults) {
    const exists = await prisma.product.findUnique({ where: { id: item.id } });
    if (exists) { console.log(`  skip ${item.id} (ya existe)`); continue; }
    await saveProduct(item);
    savedApi++;
  }

  // Fase 4: los links de Playwright → scraping de precio individual
  const playwrightLinks = allLinks.filter(l => l.href);
  const seen = new Set(apiResults.map(r => r.id));
  const toProcess = [];
  for (const l of playwrightLinks) {
    const parsed = parseProductId(l.href);
    if (!parsed?.id || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    const exists = await prisma.product.findUnique({ where: { id: parsed.id } });
    if (exists) { console.log(`  skip ${parsed.id} (ya existe)`); continue; }
    toProcess.push({ ...parsed, category: l.category });
  }

  if (toProcess.length > 0) {
    console.log(`\nFase precios: ${toProcess.length} productos nuevos`);
    const ctx = await getContext();
    try {
      for (const p of toProcess) {
        try {
          const reading = await readProductPrice(p.id, p.url);
          if (reading.blocked) { console.warn(`  ${p.id} bloqueado, skip`); await sleep(jitter(15000, 25000)); continue; }
          if (!reading.price) { console.warn(`  ${p.id} sin precio`); continue; }
          await saveProduct({ id: p.id, title: reading.title, url: p.url, image: reading.image, category: p.category, price: reading.price });
        } catch (e) {
          console.warn(`  ${p.id} error: ${e.message}`);
        }
        await sleep(jitter(3000, 6000));
      }
    } finally {
      await ctx.close();
    }
  }

  console.log(`\n[seed-catalog] terminado. API: ${savedApi} nuevos.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seedCatalog();
  await prisma.$disconnect();
}
