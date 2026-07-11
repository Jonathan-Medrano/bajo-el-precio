// Generador de la imagen social (Open Graph / Twitter card) por producto.
// Renderiza un SVG 1200x630 con foto + precio + bajada + mini-gráfico, y lo pasa a PNG
// con @resvg/resvg-js (sin navegador). Es la pieza que hace que un tweet/enlace tenga
// gancho visual: la card muestra la CURVA y la BAJADA, no la foto pelada.
import { Resvg } from "@resvg/resvg-js";
import { getHistory } from "./service.js";

const W = 1200, H = 630;
const ORANGE = "#e64c1e";
const GREEN = "#1a9e57";
const INK = "#2d2d2d";
const MUTED = "#8a8a8a";

const fmt = (n) => "$" + Number(n).toLocaleString("es-AR");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Parte el título en `maxLines` líneas de ~maxChars; corta con … si sobra. */
function wrapTitle(title, maxChars = 24, maxLines = 2) {
  const words = String(title ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length <= maxChars) {
      cur = (cur + " " + w).trim();
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    const used = lines.join(" ").split(/\s+/).length;
    if (used < words.length) lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,1}$/, "…");
  }
  return lines.slice(0, maxLines);
}

const MLSTATIC_RE = /^https:\/\/([a-z0-9-]+\.)?mlstatic\.com\//i;

/** Baja la imagen del producto y la devuelve como data URI (resvg no resuelve URLs remotas).
 *  resvg NO renderiza WebP embebido y ML sirve .webp → pedimos la variante .jpg (mismo CDN). */
async function imageDataUri(url) {
  if (!url) return null;
  if (!MLSTATIC_RE.test(url)) return null; // defense-in-depth: solo CDN de ML
  const jpg = url.replace(/\.webp(\?.*)?$/i, ".jpg");
  try {
    const res = await fetch(jpg, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") || "image/jpeg";
    if (/webp/i.test(mime)) return null; // por las dudas: no embebemos webp
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Polyline del mini-gráfico, escalada a un rect (x,y,w,h). */
function sparkline(prices, x, y, w, h) {
  if (prices.length < 2) return "";
  const min = prices.reduce((m, p) => p < m ? p : m, Infinity), max = prices.reduce((m, p) => p > m ? p : m, -Infinity);
  const span = max - min || 1;
  const pts = prices.map((p, i) => {
    const px = x + (i / (prices.length - 1)) * w;
    const py = y + h - ((p - min) / span) * h;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(",");
  return (
    `<polyline points="${pts.join(" ")}" fill="none" stroke="${ORANGE}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${last[0]}" cy="${last[1]}" r="9" fill="${ORANGE}"/>`
  );
}

/** Construye el SVG de la card. Columna derecha con posiciones FIJAS (x=490) para que
 *  título / precio / badge / gráfico nunca se superpongan, dependa o no del alto del título. */
function buildSvg({ title, imgUri, prices, last, min, max, count }) {
  const CX = 490; // inicio de la columna derecha
  const isLow = count >= 2 && last != null && last <= min;
  const dropPct = max && last && max > last ? Math.round((1 - last / max) * 100) : 0;
  const titleLines = wrapTitle(title, 24, 2);

  const img = imgUri
    ? `<clipPath id="r"><rect x="60" y="150" width="380" height="380" rx="20"/></clipPath>` +
      `<image href="${imgUri}" x="60" y="150" width="380" height="380" preserveAspectRatio="xMidYMid slice" clip-path="url(#r)"/>`
    : `<rect x="60" y="150" width="380" height="380" rx="20" fill="#f0f0f0"/>`;

  // Título: hasta 2 líneas arriba de la columna.
  const titleSvg = titleLines
    .map((l, i) => `<text x="${CX}" y="${205 + i * 52}" font-size="42" font-weight="700" fill="${INK}">${esc(l)}</text>`)
    .join("");

  // Precio: posición fija, grande.
  const priceSvg = last != null
    ? `<text x="${CX}" y="375" font-size="94" font-weight="800" fill="${ORANGE}">${esc(fmt(last))}</text>`
    : `<text x="${CX}" y="360" font-size="40" font-weight="700" fill="${MUTED}">Juntando historial…</text>`;

  // Badge verde de bajada (debajo del precio, fija).
  let badgeSvg = "";
  const label = isLow
    ? `▼ MÍNIMO HISTÓRICO${dropPct ? `  ·  -${dropPct}%` : ""}`
    : dropPct > 0
    ? `▼ -${dropPct}% vs máximo`
    : null;
  if (label) {
    const w = Math.round(label.length * 16 + 56);
    badgeSvg =
      `<rect x="${CX}" y="405" width="${w}" height="58" rx="29" fill="${GREEN}"/>` +
      `<text x="${CX + 28}" y="443" font-size="28" font-weight="700" fill="#fff">${esc(label)}</text>`;
  }

  // Mini-gráfico: caja al pie de la columna derecha (no choca con la foto, que está a la izquierda).
  const chartSvg = prices && prices.length >= 2
    ? `<rect x="${CX}" y="488" width="650" height="92" rx="14" fill="#fafafa"/>` + sparkline(prices, CX + 24, 506, 600, 56)
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect width="${W}" height="12" fill="${ORANGE}"/>
  <!-- marca -->
  <rect x="60" y="56" width="48" height="48" rx="12" fill="${ORANGE}"/>
  <polyline points="69,75 79,83 89,78 99,93" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M99 93 L99 86 M99 93 L92 93" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="124" y="90" font-size="34" font-weight="800" fill="${INK}">Bajó el Precio</text>
  <text x="${W - 60}" y="90" font-size="26" font-weight="600" fill="${MUTED}" text-anchor="end">historial real de MercadoLibre</text>
  ${img}
  ${titleSvg}
  ${priceSvg}
  ${badgeSvg}
  ${chartSvg}
</svg>`;
}

/**
 * Devuelve { png: Buffer } con la card del producto, o null si no existe.
 */
export async function renderOgImage(id) {
  const data = await getHistory(id);
  if (data.error) return null;
  const prices = data.history.map((h) => h.price);
  const imgUri = await imageDataUri(data.product.image);

  const svg = buildSvg({
    title: data.product.title,
    imgUri,
    prices,
    last: data.stats.last ?? null,
    min: data.stats.min ?? null,
    max: data.stats.max ?? null,
    count: data.stats.count ?? 0,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { loadSystemFonts: true },
    background: "#ffffff",
  });
  return resvg.render().asPng();
}
