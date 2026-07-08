// Lee el "mejor precio" (catálogo) de un producto de ML vía API pública /products/:id/items.
// Sin Playwright, sin anti-bot → escala a miles de productos por ciclo (API-first, scraper-last).
import { getAppToken } from "./auth.js";

const B = "https://api.mercadolibre.com";

async function apiGet(path, token) {
  return fetch(`${B}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

/** Mejor precio = mínimo entre las ofertas nuevas del catálogo (cae a cualquier condición si no hay nuevas). */
function bestPrice(items = []) {
  const valid = items.filter((x) => Number.isFinite(x.price) && x.price > 0);
  const news = valid.filter((x) => x.condition === "new");
  const pool = news.length ? news : valid;
  if (!pool.length) return null;
  return Math.round(Math.min(...pool.map((x) => x.price)));
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
  const price = bestPrice(itemsData.results ?? []);

  // 2) Metadata (name + imagen). Best-effort: si falla, igual devolvemos el precio.
  let title, image;
  if (withMeta) {
    try {
      const prodRes = await apiGet(`/products/${productId}`, token);
      if (prodRes.ok) {
        const p = await prodRes.json();
        title = p.name ?? undefined;
        image = p.pictures?.[0]?.url ?? p.pictures?.[0]?.secure_url ?? undefined;
      }
    } catch {
      /* metadata opcional */
    }
  }

  return { id: productId, blocked: false, price, title, image };
}
