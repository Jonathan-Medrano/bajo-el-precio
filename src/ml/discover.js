// Descubrimiento de productos populares para trackear.
// Camina el ÁRBOL completo de categorías de ML y pide los "highlights" (más vendidos)
// de cada nodo. La API de /search está cerrada (403), pero highlights por categoría
// funciona — y recorriendo el árbol entero rinde miles de productos de catálogo.
import { getAppToken } from "./auth.js";

const B = "https://api.mercadolibre.com";
const S = process.env.ML_SITE || "MLA";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiJson(path, token) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`${B}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Nodos de categoría: top-level + hasta `depth` niveles de hijos. depth=0 = solo las 32 tops. */
async function categoryNodes(token, depth) {
  const tops = await apiJson(`/sites/${S}/categories`, token);
  if (!Array.isArray(tops)) return [];
  const nodes = tops.map((c) => ({ id: c.id, group: c.name }));
  let frontier = nodes.slice();
  for (let lvl = 0; lvl < depth; lvl++) {
    const next = [];
    for (const node of frontier) {
      const cat = await apiJson(`/categories/${node.id}`, token);
      await sleep(80);
      for (const ch of cat?.children_categories ?? []) {
        const n = { id: ch.id, group: node.group }; // agrupamos por la categoría top
        nodes.push(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return nodes;
}

/** IDs de catálogo destacados (más vendidos) de un nodo de categoría. */
async function highlightIds(token, categoryId) {
  const data = await apiJson(`/highlights/${S}/category/${categoryId}`, token);
  const out = [];
  for (const c of data?.content ?? []) {
    if (c.type === "PRODUCT" && c.id) out.push(c.id);
  }
  return out;
}

/**
 * Descubre productos populares recorriendo el árbol de categorías.
 * Mantiene el contrato previo: devuelve [{ id, category }].
 * @param {{ depth?: number, onProgress?: (i:{done:number,total:number,found:number,group:string})=>void }} opts
 * @returns {Promise<Array<{id:string, category:string}>>}
 */
export async function discoverProducts({ depth = Number(process.env.DISCOVER_DEPTH ?? 1), onProgress } = {}) {
  const token = await getAppToken();
  const nodes = await categoryNodes(token, depth);
  const seen = new Map(); // id -> group (categoría top)
  let done = 0;
  for (const node of nodes) {
    const ids = await highlightIds(token, node.id);
    for (const id of ids) if (!seen.has(id)) seen.set(id, node.group);
    done++;
    onProgress?.({ done, total: nodes.length, found: seen.size, group: node.group });
    await sleep(100);
  }
  return [...seen].map(([id, category]) => ({ id, category }));
}
