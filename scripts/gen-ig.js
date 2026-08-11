/**
 * Genera imágenes Instagram 1080x1080 localmente para iterar el diseño.
 *
 * Uso:
 *   node scripts/gen-ig.js                    ← top deal del día
 *   node scripts/gen-ig.js MLA18652382
 *   node scripts/gen-ig.js MLA123 MLA456 MLA789
 *
 * Output: ig-previews/<ID>.png
 */

import { Resvg } from "@resvg/resvg-js";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://bajoelprecio.fly.dev";
const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, "..", "ig-previews");

// ─── Tokens ────────────────────────────────────────────────────────────────
const S = 1080;
const SPLIT = 560;          // y donde termina la foto
const DARK = "#0f0f10";
const ORANGE = "#e64c1e";
const GREEN  = "#15803d";
const WHITE  = "#ffffff";
const MUTED  = "rgba(255,255,255,0.45)";

const fmt = (n) => "$" + Number(n).toLocaleString("es-AR");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Trunca el título a maxChars, sin cortar palabras.
function truncate(text, maxChars = 42) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
}

async function imageDataUri(url) {
  if (!url) return null;
  const jpg = url.replace(/\.webp(\?.*)?$/i, ".jpg");
  try {
    const res = await fetch(jpg, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mime = res.headers.get("content-type") || "image/jpeg";
    if (/webp/i.test(mime)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch { return null; }
}

// ─── SVG ───────────────────────────────────────────────────────────────────
function buildSvg({ title, imgUri, last, prevAvg, min, max, count, drop, isMin }) {

  // ── Zona foto (0 … SPLIT) ─────────────────────────────────────────────
  const photo = imgUri
    ? `<clipPath id="cp"><rect x="0" y="0" width="${S}" height="${SPLIT}"/></clipPath>
       <image href="${imgUri}" x="0" y="0" width="${S}" height="${SPLIT}"
              preserveAspectRatio="xMidYMid slice" clip-path="url(#cp)"/>`
    : `<rect width="${S}" height="${SPLIT}" fill="#1e1e1e"/>`;

  // Gradiente inferior suave para que el badge no flote en el aire
  const photoGrad = `
    <defs>
      <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="60%" stop-color="#000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000" stop-opacity=".55"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${S}" height="${SPLIT}" fill="url(#pg)" clip-path="url(#cp)"/>`;

  // ── Zona oscura (SPLIT … S) ────────────────────────────────────────────
  const darkBg = `<rect x="0" y="${SPLIT}" width="${S}" height="${S - SPLIT}" fill="${DARK}"/>`;

  // ── Badge % (centrado en el split) ────────────────────────────────────
  const badgeR = 110;
  const badgeCY = SPLIT;
  const badgeColor = isMin ? GREEN : ORANGE;
  const badgeLabel = isMin ? "MÍNIMO\nHISTÓRICO" : `−${drop}%`;
  const badgeSvg = drop >= 3 ? `
    <circle cx="${S / 2}" cy="${badgeCY}" r="${badgeR}" fill="${badgeColor}"/>
    ${isMin
      ? `<text x="${S/2}" y="${badgeCY - 14}" font-size="38" font-weight="900" fill="${WHITE}" text-anchor="middle">MÍNIMO</text>
         <text x="${S/2}" y="${badgeCY + 36}" font-size="38" font-weight="900" fill="${WHITE}" text-anchor="middle">HISTÓRICO</text>`
      : `<text x="${S/2}" y="${badgeCY - 16}" font-size="72" font-weight="900" fill="${WHITE}" text-anchor="middle">−${drop}%</text>
         <text x="${S/2}" y="${badgeCY + 32}" font-size="28" font-weight="700" fill="rgba(255,255,255,.8)" text-anchor="middle">vs precio histórico</text>`
    }` : "";

  // ── Zona oscura: título ────────────────────────────────────────────────
  const titleY = SPLIT + 148;
  const shortTitle = truncate(title, 44);
  const titleSvg = `<text x="60" y="${titleY}" font-size="40" font-weight="700"
    fill="${WHITE}" dominant-baseline="hanging">${esc(shortTitle)}</text>`;

  // ── Precios: ANTES (tachado) → AHORA (grande naranja) ─────────────────
  const priceY = titleY + 100;
  const priceSvg = last != null ? `
    ${prevAvg && prevAvg > last ? `
      <text x="60" y="${priceY}" font-size="36" fill="${MUTED}" dominant-baseline="hanging">
        antes ${esc(fmt(prevAvg))}
      </text>
      <line x1="60" y1="${priceY + 22}" x2="${60 + fmt(prevAvg).length * 20}" y2="${priceY + 22}"
            stroke="${MUTED}" stroke-width="2.5"/>
    ` : ""}
    <text x="60" y="${priceY + (prevAvg && prevAvg > last ? 62 : 0)}"
          font-size="110" font-weight="900" fill="${ORANGE}" dominant-baseline="hanging"
    >${esc(fmt(last))}</text>
  ` : "";

  // ── Branding bottom ────────────────────────────────────────────────────
  const botY = S - 64;
  const branding = `
    <rect x="0" y="${botY}" width="${S}" height="64" fill="rgba(255,255,255,0.05)"/>
    <text x="60" y="${botY + 40}" font-size="28" font-weight="800" fill="${ORANGE}">Bajó el Precio</text>
    <text x="${S - 60}" y="${botY + 40}" font-size="24" font-weight="500" fill="${MUTED}"
          text-anchor="end">bajoelprecio.fly.dev</text>
  `;

  // ── Logo top-left (marca de agua discreta) ─────────────────────────────
  const watermark = `
    <rect x="0" y="0" width="280" height="46" fill="rgba(0,0,0,.45)" rx="0"/>
    <text x="20" y="32" font-size="24" font-weight="800" fill="${WHITE}">Bajó el Precio</text>
  `;

  return `<svg xmlns="http://www.w3.org/2000/svg"
    width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" fill="${DARK}"/>
  ${photo}
  ${photoGrad}
  ${darkBg}
  ${badgeSvg}
  ${titleSvg}
  ${priceSvg}
  ${branding}
  ${watermark}
</svg>`;
}

// ─── Render ────────────────────────────────────────────────────────────────
async function renderOne(id) {
  process.stdout.write(`  ${id} — fetcheando...`);
  const res = await fetch(`${BASE_URL}/api/product/${id}`);
  const data = await res.json();
  if (data.error) { console.log(` ✗ ${data.error}`); return null; }

  const stats  = data.stats ?? {};
  const last   = stats.last ?? null;
  const min    = stats.min ?? null;
  const max    = stats.max ?? null;
  const avg    = stats.avg ?? null;
  const count  = stats.count ?? 0;
  const isMin  = count >= 3 && last != null && min != null && last <= min;
  const drop   = max && last && max > last ? Math.round((1 - last / max) * 100) : 0;

  process.stdout.write(" renderizando...");
  const imgUri = await imageDataUri(data.product?.image);

  const svg = buildSvg({
    title:   data.product?.title ?? id,
    imgUri,
    last,
    prevAvg: avg,
    min, max, count, drop, isMin,
  });

  const resvg = new Resvg(svg, {
    fitTo:      { mode: "width", value: S },
    font:       { loadSystemFonts: true },
    background: "#0f0f10",
  });
  const png = resvg.render().asPng();

  const outPath = join(OUT_DIR, `${id}.png`);
  await writeFile(outPath, png);
  console.log(` ✓  →  ig-previews/${id}.png`);
  return outPath;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  let ids = process.argv.slice(2).filter(Boolean);
  if (!ids.length) {
    process.stdout.write("Fetcheando top deal...");
    const r = await fetch(`${BASE_URL}/api/deals?limit=1`);
    const deals = await r.json();
    ids = deals.slice(0, 1).map(d => d.id);
    console.log(` ${ids[0]}`);
  }

  console.log(`\nGenerando ${ids.length} imagen(es)...\n`);
  for (const id of ids) await renderOne(id.toUpperCase());
  console.log("\nListo. ig-previews/<ID>.png");
}

main().catch(e => { console.error(e.message); process.exit(1); });
