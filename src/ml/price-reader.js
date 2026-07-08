import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchItem, fetchItemsBatch, fetchCatalogBestPrice } from "./api-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = join(__dirname, "..", "..", process.env.BROWSER_PROFILE || ".browser");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

let context = null;

export async function getContext() {
  if (context) return context;
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: process.env.HEADLESS !== "0",
    viewport: { width: 1366, height: 900 },
    locale: "es-AR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  return context;
}

export async function closeContext() {
  if (context) {
    await context.close();
    context = null;
  }
}

const CHALLENGE_RE = /por seguridad|completá este paso|completa este paso|captcha|are you a robot/i;

/**
 * Lee el precio vía la API pública de ML (sin auth, sin Playwright).
 * Para MLA*: GET /items/{id}. Para MLAU*: search con catalog_product_id.
 * Retorna null si falla — el caller puede hacer fallback a Playwright.
 */
export async function readProductPriceFromApi(productId) {
  try {
    if (productId.toUpperCase().startsWith("MLAU")) {
      const data = await fetchCatalogBestPrice(productId);
      const result = data?.results?.[0];
      if (!result?.price) return null;
      return {
        id: productId,
        price: Math.round(result.price),
        title: result.title ?? null,
        image: result.thumbnail ?? null,
        // permalink = URL del listing más barato (el vendedor con mejor precio ahora)
        cheapestUrl: result.permalink ?? null,
        blocked: false,
        source: "api",
      };
    }

    const item = await fetchItem(productId);
    if (!item?.price) return null;
    return {
      id: productId,
      price: Math.round(item.price),
      title: item.title ?? null,
      image: item.thumbnail ?? null,
      cheapestUrl: item.permalink ?? null,
      blocked: false,
      source: "api",
    };
  } catch {
    return null;
  }
}

/**
 * Batch: lee precios de hasta 20 items MLA* en una sola request.
 * Retorna un Map de { productId → { price, title, image } } para los que tuvieron precio.
 */
export async function readItemsBatchFromApi(itemIds) {
  const results = new Map();
  if (!itemIds.length) return results;

  const CHUNK = 20;
  for (let i = 0; i < itemIds.length; i += CHUNK) {
    const chunk = itemIds.slice(i, i + CHUNK);
    try {
      const batch = await fetchItemsBatch(chunk);
      for (const entry of batch ?? []) {
        if (entry.code === 200 && entry.body?.price) {
          const b = entry.body;
          results.set(b.id, { price: Math.round(b.price), title: b.title ?? null, image: b.thumbnail ?? null });
        }
      }
    } catch {
      // batch failed — tracker will fall back per-item via Playwright
    }
  }
  return results;
}

/** Lee el "Mejor precio" (buy box) actual de un producto de catálogo de ML. */
export async function readProductPrice(productId, url = `https://www.mercadolibre.com.ar/p/${productId}`) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    if (CHALLENGE_RE.test(title)) return { id: productId, url, blocked: true };

    await page
      .waitForSelector('meta[itemprop="price"], .andes-money-amount__fraction', { timeout: 10000 })
      .catch(() => {});

    const data = await page.evaluate(() => {
      const parseMeta = (s) => {
        if (s == null) return null;
        const n = Math.round(parseFloat(s));
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      return {
        title: document.querySelector("h1")?.textContent?.trim() ?? null,
        price: parseMeta(document.querySelector('meta[itemprop="price"]')?.getAttribute("content")),
        image: document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? null,
      };
    });

    await sleep(jitter(500, 1200));
    return { id: productId, url, blocked: false, title: data.title, price: data.price, image: data.image };
  } finally {
    await page.close();
  }
}
