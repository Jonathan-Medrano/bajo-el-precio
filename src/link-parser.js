// Extrae el ID de producto de cualquier link de MercadoLibre.
// El ID se saca del PATH (/up/, /p/, /MLA-...), NUNCA de los query params.

const SITE = "https://www.mercadolibre.com.ar";

export function isShortLink(input) {
  return /meli\.la\//i.test(String(input ?? ""));
}

export function parseProductId(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;

  const slugToTitle = (slug) =>
    slug.replace(/-+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

  let m = s.match(/\/([^/]+)\/up\/(ML[A-Z]*\d+)/i);
  if (m) {
    const id = m[2].toUpperCase();
    return { id, type: "catalog", url: `${SITE}/up/${id}`, titleHint: slugToTitle(m[1]) };
  }
  if ((m = s.match(/\/up\/(ML[A-Z]*\d+)/i))) {
    const id = m[1].toUpperCase();
    return { id, type: "catalog", url: `${SITE}/up/${id}` };
  }
  m = s.match(/\/([^/]+)\/p\/(ML[A-Z]*\d+)/i);
  if (m) {
    const id = m[2].toUpperCase();
    return { id, type: "catalog", url: `${SITE}/p/${id}`, titleHint: slugToTitle(m[1]) };
  }
  if ((m = s.match(/\/p\/(ML[A-Z]*\d+)/i))) {
    const id = m[1].toUpperCase();
    return { id, type: "catalog", url: `${SITE}/p/${id}` };
  }
  m = s.match(/\/(ML[A-Z])-?(\d{8,})/i);
  if (m) {
    const site = m[1].toUpperCase();
    return { id: site + m[2], type: "item", url: `https://articulo.mercadolibre.com.ar/${site}-${m[2]}` };
  }
  if (!/[/?#]|https?:/i.test(s)) {
    m = s.match(/^(ML[A-Z]*\d{6,})$/i);
    if (m) {
      const id = m[1].toUpperCase();
      return { id, type: "unknown", url: `${SITE}/p/${id}` };
    }
  }
  return null;
}
