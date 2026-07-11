import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { fetchItem, fetchCatalogBestPrice } from "./api-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = join(__dirname, "..", "..", process.env.BROWSER_PROFILE || ".browser");
const TWITTER_COOKIES_FILE = join(USER_DATA_DIR, "twitter-session.json");

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
  // Restore persisted Twitter session if Chromium didn't load it (happens after forced kill on deploy)
  try {
    const saved = JSON.parse(readFileSync(TWITTER_COOKIES_FILE, "utf8"));
    if (Array.isArray(saved) && saved.length) {
      await context.addCookies(saved);
      console.log(`[browser] restored ${saved.length} Twitter cookies from ${TWITTER_COOKIES_FILE}`);
    }
  } catch {
    // file doesn't exist yet — no-op
  }
  return context;
}

export async function saveTwitterCookies(cookies) {
  writeFileSync(TWITTER_COOKIES_FILE, JSON.stringify(cookies, null, 2), "utf8");
  console.log(`[browser] saved ${cookies.length} Twitter cookies to ${TWITTER_COOKIES_FILE}`);
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
export async function readProductPriceFromApi(productId, type = "item") {
  const isCatalog = productId.toUpperCase().startsWith("MLAU") || type === "catalog";

  // Catalog products → Search API (works from cloud IPs without OAuth)
  if (isCatalog) {
    try {
      const data = await fetchCatalogBestPrice(productId);
      const result = data?.results?.[0];
      if (!result?.price) return null;
      return {
        id: productId,
        price: Math.round(result.price),
        title: result.title ?? null,
        image: result.thumbnail ?? null,
        cheapestUrl: result.permalink ?? null,
        blocked: false,
        source: "api",
      };
    } catch {
      return null;
    }
  }

  // Regular items → direct API (blocked on cloud without OAuth; falls back to catalog search)
  try {
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
    // fetchItem blocked (403) — try catalog search as last resort
    try {
      const data = await fetchCatalogBestPrice(productId);
      const result = data?.results?.[0];
      if (!result?.price) return null;
      return {
        id: productId,
        price: Math.round(result.price),
        title: result.title ?? null,
        image: result.thumbnail ?? null,
        cheapestUrl: result.permalink ?? null,
        blocked: false,
        source: "api",
      };
    } catch {
      return null;
    }
  }
}

/**
 * Reads prices for MLA* items using individual /items/{id} calls (parallel, queue-rate-limited).
 * The batch endpoint GET /items?ids=... requires OAuth — use single-item API instead.
 * Returns a Map of { productId → { price, title, image, cheapestUrl } }.
 */
export async function readItemsBatchFromApi(itemIds) {
  const results = new Map();
  if (!itemIds.length) return results;

  await Promise.all(
    itemIds.map(async (id) => {
      try {
        const item = await fetchItem(id);
        if (item?.price) {
          results.set(id, {
            price: Math.round(item.price),
            title: item.title ?? null,
            image: item.thumbnail ?? null,
            cheapestUrl: item.permalink ?? null,
          });
        }
      } catch {
        // 404 / blocked — tracker falls back to Playwright
      }
    })
  );

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
