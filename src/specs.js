// Extrae specs tecnicas del titulo de un producto para matchear equivalentes.
export function extractSpecs(title) {
  const t = " " + String(title ?? "").toLowerCase().replace(/[.,]/g, " ") + " ";
  const network = /\b5\s?g\b/.test(t) ? "5G" : "4G";
  const gb = [...t.matchAll(/(\d+)\s*(gb|gigas?)\b/g)].map((m) => parseInt(m[1], 10));
  let storage = null;
  let ram = null;
  if (gb.length >= 2) {
    storage = Math.max(...gb);
    ram = Math.min(...gb);
  } else if (gb.length === 1) {
    storage = gb[0];
  }
  const tb = t.match(/(\d+)\s*tb\b/);
  if (tb) storage = parseInt(tb[1], 10) * 1024;
  const model = (t.match(/\b([a-z]{1,2}\d{1,3}[a-z]?)\b/) || [])[1] || null;
  return { model, storage, ram, network };
}

const eqOrNull = (a, b) => a == null || b == null || a === b;

export function matchesStrict(src, cand) {
  return (
    !!src.model && !!cand.model && src.model === cand.model &&
    src.storage != null && src.storage === cand.storage &&
    src.network === cand.network && eqOrNull(src.ram, cand.ram)
  );
}

export function matchesFlexible(src, cand) {
  return !!src.model && !!cand.model && src.model === cand.model && src.storage != null && src.storage === cand.storage;
}

export function getMatcher(mode) {
  return mode === "flexible" ? matchesFlexible : matchesStrict;
}

const STOP = new Set([
  "de", "con", "y", "el", "la", "los", "las", "para", "en", "por", "un", "una", "del", "al",
  "color", "celular", "telefono", "teléfono", "smartphone", "ml", "nuevo", "usado", "x",
]);

export function tokens(title) {
  return new Set(
    String(title ?? "").toLowerCase().replace(/[^\wáéíóúñ\s]/gi, " ").split(/\s+/).filter((w) => w.length >= 2 && !STOP.has(w))
  );
}

export function keywordOverlap(srcTitle, candTitle) {
  const a = tokens(srcTitle);
  const b = tokens(candTitle);
  if (!a.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / a.size;
}

export function extractNumericAttrs(title) {
  const t = " " + String(title ?? "").toLowerCase().replace(/[.,]/g, " ") + " ";
  const a = {};
  let m;
  if ((m = t.match(/(\d{2,3})\s*(?:pulgadas?|pulg\b|''|["'″])/))) {
    a.pulgadas = +m[1];
  } else if (/\b(monitor|televisor|smart\s?tv|\btv\b|led|odyssey|ultragear)\b/.test(t)) {
    if ((m = t.match(/\b(1[7-9]|[2-4]\d|5[0-5])\b(?!\s*(?:hz|ms|w\b|gb|mhz))/))) a.pulgadas = +m[1];
  }
  if ((m = t.match(/(\d{2,4})\s*(?:litros?|lts?)\b/))) a.litros = +m[1];
  if ((m = t.match(/(\d+(?:\.\d+)?)\s*hp\b/))) a.hp = parseFloat(m[1]);
  return a;
}

export function numericMatch(srcAttrs, candAttrs) {
  for (const k of Object.keys(srcAttrs)) {
    if (candAttrs[k] != null && candAttrs[k] !== srcAttrs[k]) return false;
  }
  return true;
}
