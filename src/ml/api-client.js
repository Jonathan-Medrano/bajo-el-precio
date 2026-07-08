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
  const res = await fetch(`${ML_API}${path}`, { headers });
  handleRateLimitHeaders(res.headers);

  if (res.status === 429) {
    const retryAfterSecs = parseInt(res.headers.get("retry-after") ?? "5", 10);
    await new Promise((r) => setTimeout(r, retryAfterSecs * 1000));
    throw new Error(`[ml-api] 429 on ${path}`);
  }

  if (res.status === 401) {
    // Token rejected or missing — invalidate cached token and abort (don't retry without token)
    _appToken = null;
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
 * GET /sites/MLA/search?catalog_product_id={id}&sort=price_asc&limit=1
 * Returns the cheapest active listing for a catalog product (MLAU*).
 */
export function fetchCatalogBestPrice(catalogId) {
  const site = process.env.ML_SITE ?? "MLA";
  return queue.add(() =>
    retry(() =>
      mlFetch(`/sites/${site}/search?catalog_product_id=${catalogId}&sort=price_asc&limit=1&fields=results.id,results.title,results.price,results.thumbnail,results.permalink`)
    )
  );
}

export function searchProducts(query, limit = 50) {
  return queue.add(() =>
    retry(() =>
      mlFetch(
        `/sites/MLA/search?q=${encodeURIComponent(query)}&limit=${limit}&fields=results.id,results.title,results.price,results.thumbnail,results.permalink,results.catalog_product_id`
      )
    )
  );
}
