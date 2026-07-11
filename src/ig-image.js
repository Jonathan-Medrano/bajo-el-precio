// Generador de imágenes cuadradas 1080x1080 optimizadas para Instagram feed y carousel ads.
// Diseño: fondo blanco, foto dominante arriba, precio grande, badge de ahorro, CTA y branding.
import { Resvg } from "@resvg/resvg-js";
import { getHistory } from "./service.js";

const S = 1080;
const ORANGE = "#e64c1e";
const GREEN = "#16a34a";
const INK = "#111827";
const MUTED = "#6b7280";
const SOFT_BG = "#fff3ef";

const fmt = (n) => "$" + Number(n).toLocaleString("es-AR");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function wrapText(text, maxCharsPerLine = 28, maxLines = 2) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length <= maxCharsPerLine) {
      cur = (cur + " " + w).trim();
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length >= maxLines - 1) { if (cur) lines.push(cur); break; }
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  // truncate last line if needed
  const used = lines.join(" ").split(/\s+/).length;
  if (used < words.length && lines.length === maxLines) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{3}$/, "…");
  }
  return lines;
}

const MLSTATIC_RE = /^https:\/\/([a-z0-9-]+\.)?mlstatic\.com\//i;

async function imageDataUri(url) {
  if (!url) return null;
  if (!MLSTATIC_RE.test(url)) return null;
  const jpg = url.replace(/\.webp(\?.*)?$/i, ".jpg");
  try {
    const res = await fetch(jpg, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") || "image/jpeg";
    if (/webp/i.test(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

function sparkline(prices, x, y, w, h) {
  if (!prices || prices.length < 2) return "";
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || 1;
  const pts = prices.map((p, i) => {
    const px = x + (i / (prices.length - 1)) * w;
    const py = y + h - ((p - min) / span) * h;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  });
  const [lx, ly] = pts[pts.length - 1].split(",");
  return (
    `<polyline points="${pts.join(" ")}" fill="none" stroke="${ORANGE}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${lx}" cy="${ly}" r="7" fill="${ORANGE}"/>`
  );
}

function buildSquareSvg({ title, imgUri, prices, last, min, max, avg, count, savingPct }) {
  const isMin = count >= 3 && last != null && last <= min;
  const drop = savingPct > 0 ? savingPct : (max && last && max > last ? Math.round((1 - last / max) * 100) : 0);
  const titleLines = wrapText(title, 28, 2);

  // Layout zones (top-to-bottom):
  // 0-44: top bar (branding strip)
  // 44-460: product image (416px)
  // 460-540: title
  // 540-650: price
  // 650-720: savings badge
  // 720-820: sparkline chart
  // 820-960: CTA / credibility
  // 960-1080: bottom bar

  const imgBlock = imgUri
    ? `<clipPath id="img"><rect x="40" y="44" width="1000" height="416" rx="24"/></clipPath>` +
      `<image href="${imgUri}" x="40" y="44" width="1000" height="416" preserveAspectRatio="xMidYMid slice" clip-path="url(#img)"/>`
    : `<rect x="40" y="44" width="1000" height="416" rx="24" fill="#f3f4f6"/>` +
      `<text x="540" y="270" font-size="48" text-anchor="middle" fill="${MUTED}">Sin imagen</text>`;

  // Gradient overlay at bottom of image for text legibility
  const overlay = `<defs><linearGradient id="ov" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#fff" stop-opacity="0"/><stop offset="100%" stop-color="#fff" stop-opacity=".85"/></linearGradient></defs>` +
    `<rect x="40" y="300" width="1000" height="160" fill="url(#ov)" clip-path="url(#img)"/>`;

  const titleSvg = titleLines
    .map((l, i) => `<text x="540" y="${490 + i * 58}" font-size="46" font-weight="700" fill="${INK}" text-anchor="middle">${esc(l)}</text>`)
    .join("");

  const priceSvg = last != null
    ? `<text x="540" y="650" font-size="100" font-weight="900" fill="${ORANGE}" text-anchor="middle">${esc(fmt(last))}</text>`
    : `<text x="540" y="640" font-size="40" font-weight="700" fill="${MUTED}" text-anchor="middle">Precio no disponible</text>`;

  let badgeSvg = "";
  if (isMin) {
    badgeSvg = `<rect x="240" y="670" width="600" height="66" rx="33" fill="${GREEN}"/>` +
      `<text x="540" y="713" font-size="32" font-weight="700" fill="#fff" text-anchor="middle">▼ MÍNIMO HISTÓRICO${drop ? ` — −${drop}% vs máximo` : ""}</text>`;
  } else if (drop >= 5) {
    badgeSvg = `<rect x="300" y="670" width="480" height="66" rx="33" fill="${ORANGE}"/>` +
      `<text x="540" y="713" font-size="32" font-weight="700" fill="#fff" text-anchor="middle">▼ −${drop}% vs precio máximo</text>`;
  }

  const chartBg = prices && prices.length >= 3
    ? `<rect x="40" y="754" width="1000" height="116" rx="16" fill="#fafafa" stroke="#f3f4f6" stroke-width="1"/>` +
      `<text x="64" y="780" font-size="22" font-weight="600" fill="${MUTED}">Historial de precios</text>` +
      sparkline(prices, 64, 788, 952, 68)
    : "";

  const ctaSvg = `
    <rect x="40" y="890" width="1000" height="148" rx="20" fill="${SOFT_BG}"/>
    <text x="540" y="944" font-size="30" font-weight="700" fill="${ORANGE}" text-anchor="middle">¿El descuento es real o es marketing?</text>
    <text x="540" y="986" font-size="28" font-weight="600" fill="${INK}" text-anchor="middle">Mirá el historial completo gratis en:</text>
    <text x="540" y="1024" font-size="30" font-weight="800" fill="${ORANGE}" text-anchor="middle">bajoelprecio.fly.dev</text>
  `;

  // Top branding bar
  const topBar = `
    <rect width="${S}" height="44" fill="${ORANGE}"/>
    <rect x="24" y="10" width="28" height="28" rx="7" fill="rgba(255,255,255,.25)"/>
    <polyline points="30,19 37,25 43,22 50,31" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="62" y="31" font-size="24" font-weight="800" fill="#fff">Bajó el Precio</text>
    <text x="${S - 24}" y="31" font-size="20" font-weight="600" fill="rgba(255,255,255,.85)" text-anchor="end">historial real de MercadoLibre</text>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="#ffffff"/>
  ${overlay}
  ${imgBlock}
  ${topBar}
  ${titleSvg}
  ${priceSvg}
  ${badgeSvg}
  ${chartBg}
  ${ctaSvg}
</svg>`;
}

/**
 * Renders a 1080x1080 PNG for Instagram. Returns Buffer or null.
 * @param {string} id - product ID (MLA...)
 * @param {object} [overrides] - { savingPct } for pre-computed savings
 */
export async function renderIgImage(id, overrides = {}) {
  const data = await getHistory(id);
  if (data.error) return null;
  const prices = data.history.map((h) => h.price);
  const imgUri = await imageDataUri(data.product.image);
  const stats = data.stats;

  const savingPct = overrides.savingPct ??
    (stats.max && stats.last && stats.max > stats.last
      ? Math.round((1 - stats.last / stats.max) * 100)
      : 0);

  const svg = buildSquareSvg({
    title: data.product.title,
    imgUri,
    prices,
    last: stats.last ?? null,
    min: stats.min ?? null,
    max: stats.max ?? null,
    avg: stats.avg ?? null,
    count: stats.count ?? 0,
    savingPct,
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: S },
    font: { loadSystemFonts: true },
    background: "#ffffff",
  });
  return resvg.render().asPng();
}
