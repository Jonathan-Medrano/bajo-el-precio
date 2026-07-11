// Lee el "mejor precio" (catálogo) de un producto de ML vía API pública /products/:id/items.
// Sin Playwright, sin anti-bot → escala a miles de productos por ciclo (API-first, scraper-last).
import { getAppToken } from "./auth.js";

const B = "https://api.mercadolibre.com";

async function apiGet(path, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  return fetch(`${B}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
    .finally(() => clearTimeout(timer));
}

/** Mejor item = más barato entre los nuevos (o cualquier condición si no hay nuevos). */
function bestItem(items = []) {
  const valid = items.filter((x) => Number.isFinite(x.price) && x.price > 0);
  const news = valid.filter((x) => x.condition === "new");
  const pool = news.length ? news : valid;
  if (!pool.length) return null;
  return pool.reduce((best, x) => (x.price < best.price ? x : best));
}

/**
 * Lee precio + metadata de un producto de catálogo vía API.
 * Mismo shape que el reader de Playwright: { id, blocked, price, title, image }.
 * @param {string} productId  ID de catálogo (ej: MLA68759699)
 * @param {{ withMeta?: boolean }} opts  withMeta=false omite name/imagen (ahorra 1 request por producto)
 */
export async function readCatalogProduct(productId, { withMeta = true } = {}) {
  const token = await getAppToken();

  // 1) Ofertas del catálogo → mejor precio.
  const itemsRes = await apiGet(`/products/${productId}/items`, token);
  if (itemsRes.status === 429 || itemsRes.status === 403) return { id: productId, blocked: true };
  if (!itemsRes.ok) return { id: productId, blocked: false, price: null };
  const itemsData = await itemsRes.json();
  const best = bestItem(itemsData.results ?? []);
  const price = best ? Math.round(best.price) : null;
  const cheapestUrl = best?.item_id
    ? `https://articulo.mercadolibre.com.ar/${best.item_id.replace(/^([A-Z]+)(\d+)$/, "$1-$2")}`
    : null;

  // 2) Metadata (name + imagen). Best-effort: si falla, igual devolvemos el precio.
  let title, image;
  if (withMeta) {
    try {
      const prodRes = await apiGet(`/products/${productId}`, token);
      if (prodRes.ok) {
        const p = await prodRes.json();
        title = p.name ?? undefined;
        const pic = p.pictures?.[0];
        image = pic?.secure_url ?? pic?.url ?? undefined;
      }
    } catch {
      /* metadata opcional */
    }
    // Fallback: thumbnail del item más barato (siempre disponible cuando hay precio).
    if (!image && best) {
      image = best.secure_thumbnail ?? best.thumbnail ?? undefined;
    }
  }

  return { id: productId, blocked: false, price, cheapestUrl, title, image };
}
