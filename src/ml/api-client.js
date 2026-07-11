import PQueue from "p-queue";
import pRetry, { AbortError } from "p-retry";
import { getAppToken } from "./auth.js";

const ML_API = "https://api.mercadolibre.com";

// 1500 req/min = 25 req/sec. We cap at 20 to leave headroom.
const queue = new PQueue({ intervalCap: 20, interval: 1000 });

let resumeTimer = null;
// ML's PolicyAgent blocks unauthenticated requests from cloud IPs (Fly.io, AWS…).
// Set ML_CLIENT_ID + ML_CLIENT_SECRET in Fly secrets to enable authenticated mode.
// getAppToken() returns null when credentials are missing (graceful degradation).

function handleRateLimitHeaders(headers) {
  const remaining = parseInt(
    headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining") ?? "999",
    10
  );
  const resetSecs = parseInt(
    headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset") ?? "0",
    10
  );

  if (!isNaN(remaining) && remaining < 50 && !isNaN(resetSecs) && resetSecs > 0) {
    const waitMs = resetSecs * 1000 + 300;
    console.warn(`[ml-api] Remaining=${remaining}, pausing queue ${waitMs}ms`);
    queue.pause();
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      queue.start();
    }, waitMs);
  }
}

async function mlFetch(path) {
  const token = await getAppToken().catch(() => null);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  const res = await fetch(`${ML_API}${path}`, { headers, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
  handleRateLimitHeaders(res.headers);

  if (res.status === 429) {
    const retryAfterSecs = parseInt(res.headers.get("retry-after") ?? "5", 10);
    await new Promise((r) => setTimeout(r, retryAfterSecs * 1000));
    throw new Error(`[ml-api] 429 on ${path}`);
  }

  if (res.status === 401) {
    throw new AbortError(`[ml-api] 401 on ${path} — check ML_CLIENT_ID/ML_CLIENT_SECRET`);
  }

  if (res.status === 404) throw new AbortError(`[ml-api] 404 Not found: ${path}`);
  if (res.status >= 400) throw new AbortError(`[ml-api] ${res.status} on ${path}`);

  return res.json();
}

const retry = (fn) =>
  pRetry(fn, { retries: 3, minTimeout: 500, factor: 2, randomize: true });

/** GET /items/{id} — needs Bearer token when called from cloud IPs. */
export function fetchItem(itemId) {
  return queue.add(() => retry(() => mlFetch(`/items/${itemId}`)));
}

/**
 * GET /items?ids=MLA1,MLA2,...
 * Max 20 IDs. Returns [{ code, body }] where body is the item or null on 404.
 * Requires OAuth token.
 */
export function fetchItemsBatch(itemIds) {
  if (!itemIds.length) return Promise.resolve([]);
  const ids = itemIds.slice(0, 20).join(",");
  return queue.add(() => retry(() => mlFetch(`/items?ids=${ids}`)));
}

/**
 * GET /products/{id}/items?status=active&sort=price_asc&limit=1
 * Returns the cheapest active listing for a catalog product.
 * Requires Bearer token. Works from cloud IPs (unlike Search API).
 */
export async function fetchCatalogBestPrice(catalogId) {
  const [meta, items] = await Promise.all([
    queue.add(() => retry(() => mlFetch(`/products/${catalogId}`))).catch(() => null),
    queue.add(() => retry(() => mlFetch(`/products/${catalogId}/items?status=active&sort=price_asc&limit=1`))),
  ]);
  const best = items?.results?.[0];
  if (!best?.price) return { results: [] };
  // Link to the specific cheapest listing, not the catalog page (which shows a different "recommended" item)
  const itemUrl = best.item_id
    ? `https://articulo.mercadolibre.com.ar/${best.item_id.replace(/^([A-Z]+)(\d+)$/, "$1-$2")}`
    : `https://www.mercadolibre.com.ar/p/${catalogId}`;
  // Use || (not ??) so empty strings fall through to the next source
  let thumbnail =
    meta?.pictures?.[0]?.secure_url ||
    meta?.pictures?.[0]?.url ||
    best?.secure_thumbnail ||
    best?.thumbnail ||
    null;
  // Deep fallback: fetch full item to get high-res pictures when catalog/item thumbnail is absent
  if (!thumbnail && best?.item_id) {
    try {
      const itemData = await queue.add(() => retry(() => mlFetch(`/items/${best.item_id}`)));
      thumbnail = itemData?.pictures?.[0]?.secure_url || itemData?.pictures?.[0]?.url || null;
    } catch { /* skip */ }
  }
  return {
    results: [{
      id: catalogId,
      price: best.price,
      title: meta?.name ?? null,
      thumbnail,
      permalink: itemUrl,
    }],
  };
}

export function searchProducts(query, limit = 50) {
  return queue.add(() =>
    retry(() =>
      mlFetch(
        `/sites/MLA/search?q=${encodeURIComponent(query)}&limit=${limit}&fields=results.id,results.title,results.price,results.thumbnail,results.secure_thumbnail,results.permalink,results.catalog_product_id,results.category_id`
      )
    )
  );
}
