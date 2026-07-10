// Páginas SSR por producto: HTML real indexable por Google.
// La SPA del home es invisible para crawlers; estas páginas son el motor de tráfico orgánico.

import { NAV_CSS, buildNav } from "./nav.js";
import { THEME_CSS, THEME_HEAD_SCRIPT } from "./theme.js";

const fmt = (n) => "$" + Number(n).toLocaleString("es-AR");

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** SVG estático del historial — visible para crawlers y sin JS. */
function chartSVG(history) {
  const W = 720, H = 220, PL = 64, PR = 16, PT = 16, PB = 28;
  const prices = history.map((h) => h.price);
  if (prices.length < 2) {
    return `<div class="chart-empty">Todavía estamos juntando historial. Volvé en unas horas.</div>`;
  }
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || 1;
  const x = (i) => PL + (i / (prices.length - 1)) * (W - PL - PR);
  const y = (p) => PT + (1 - (p - min) / span) * (H - PT - PB);
  const line = prices.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
  const area = `${PL},${H - PB} ${line} ${(W - PR).toFixed(1)},${H - PB}`;
  const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const labels = [
    { v: max, l: `Máx ${fmt(max)}` },
    { v: avg, l: `Prom ${fmt(avg)}` },
    { v: min, l: `Mín ${fmt(min)}` },
  ];
  const gridLines = labels.map(({ v, l }) =>
    `<line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}" stroke="#f0f0f0" stroke-width="1.5"/>
     <text x="${PL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#9ca3af">${esc(l)}</text>`
  ).join("");

  // Dates along X axis
  const dateLabels = [];
  const step = Math.max(1, Math.floor(prices.length / 5));
  for (let i = 0; i < prices.length; i += step) {
    const d = history[i]?.seenAt ? new Date(history[i].seenAt).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" }) : "";
    if (d) dateLabels.push(`<text x="${x(i).toFixed(1)}" y="${H}" text-anchor="middle" font-size="10" fill="#9ca3af">${esc(d)}</text>`);
  }

  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Historial de precios">
    ${gridLines}
    ${dateLabels.join("")}
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#e64c1e" stop-opacity=".12"/>
        <stop offset="100%" stop-color="#e64c1e" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${area}" fill="url(#areaGrad)"/>
    <polyline points="${line}" fill="none" stroke="#e64c1e" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(prices.length - 1).toFixed(1)}" cy="${y(prices.at(-1)).toFixed(1)}" r="5" fill="#e64c1e" stroke="#fff" stroke-width="2.5"/>
  </svg>`;
}

function buildVerdict(stats) {
  if (stats.count < 3) return { text: "🆕 Recién empezamos a seguir este producto. Volvé en unos días para ver el historial completo.", cls: "v-new" };
  if (stats.last <= stats.min) return { text: "🟢 Está en su precio MÁS BAJO registrado. Este descuento es REAL.", cls: "v-good" };
  if (stats.last <= stats.avg) return { text: "🟡 Por debajo del promedio histórico. Buen momento para comprar.", cls: "v-mid" };
  return { text: "🔴 Por encima del promedio. Ojo: este NO es el mejor precio registrado.", cls: "v-bad" };
}

function scoreColor(score) {
  if (score == null) return "#6b7280";
  if (score >= 9) return "#16a34a";
  if (score >= 7) return "#22c55e";
  if (score >= 5) return "#ca8a04";
  if (score >= 3) return "#f97316";
  return "#dc2626";
}

/** HTML completo de la página de un producto — indexable por Google, compartible en redes. */
export function renderProductPage({ product, history, stats, intelligence }, { baseUrl, appUrl, related = [] }) {
  const title = product.title || "Producto";
  const pageUrl = `${baseUrl}/p/${product.id}`;
  const verdict = buildVerdict(stats);
  const score = intelligence?.score ?? null;
  const intelLine = intelligence?.confidence >= 30
    ? `<p class="intel-rec">${esc(intelligence.recommendation)}</p>`
    : "";

  const desc = stats.count
    ? `Historial real de precios de "${title}" en MercadoLibre. Precio actual ${fmt(stats.last)}, mínimo ${fmt(stats.min)}, máximo ${fmt(stats.max)}. Sin descuentos truchos.`
    : `Seguimos el precio de "${title}" en MercadoLibre. Mirá si el descuento es real.`;

  const ogImage = `${baseUrl}/og/${product.id}.png`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: title,
    ...(product.image ? { image: [product.image] } : {}),
    ...(product.category ? { category: product.category } : {}),
    ...(stats.count ? {
      offers: {
        "@type": "AggregateOffer",
        priceCurrency: "ARS",
        lowPrice: stats.min,
        highPrice: stats.max,
        price: stats.last,
        offerCount: 1,
        availability: "https://schema.org/InStock",
        url: product.rawUrl || pageUrl,
      },
    } : {}),
  };

  const statCardsHtml = stats.count
    ? [
        { l: "Precio actual", v: stats.last, hi: stats.last > stats.avg },
        { l: "Mínimo histórico", v: stats.min, lo: true },
        { l: "Promedio", v: stats.avg },
        { l: "Máximo histórico", v: stats.max },
      ].map(({ l, v, hi, lo }) =>
        `<div class="stat-card${hi ? " stat-hi" : lo ? " stat-lo" : ""}"><span>${esc(l)}</span><b>${fmt(v)}</b></div>`
      ).join("")
    : "";

  const shareUrl = encodeURIComponent(pageUrl);
  const shareText = encodeURIComponent(`Historial real de "${title}" → `);
  const shareHtml = `<div class="share-row">
    <span>Compartir:</span>
    <a href="https://wa.me/?text=${shareText}${shareUrl}" target="_blank" rel="noopener">WhatsApp</a>
    <a href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}" target="_blank" rel="noopener">X / Twitter</a>
    <button onclick="navigator.clipboard.writeText('${esc(pageUrl)}');this.textContent='✓ Copiado!'">Copiar link</button>
  </div>`;

  const relatedHtml = related.length
    ? `<section class="related-section">
        <div class="section-label">Más en ${esc(product.category || "MercadoLibre")}</div>
        <div class="related-grid">
          ${related.map((r) =>
            `<a class="related-card" href="${esc(baseUrl)}/p/${esc(r.id)}">
              ${r.image ? `<div class="rc-img-wrap"><img src="${esc(r.image)}" alt="" loading="lazy"></div>` : `<div class="rc-img-ph"></div>`}
              <div class="rc-body">
                <span class="rc-title">${esc(r.title)}</span>
                ${r.price != null ? `<span class="rc-price">${fmt(r.price)}</span>` : ""}
              </div>
            </a>`).join("")}
        </div>
      </section>`
    : "";

  const priceDiff = stats.count && stats.last && stats.min
    ? Math.round(((stats.last - stats.min) / stats.min) * 100)
    : null;
  const priceDiffHtml = priceDiff !== null && priceDiff > 0
    ? `<span class="price-diff">+${priceDiff}% sobre el mínimo</span>`
    : priceDiff === 0
    ? `<span class="price-diff at-min">En el mínimo histórico</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Historial de precios | Bajó el Precio</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(pageUrl)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><rect width='36' height='36' rx='9' fill='%23e64c1e'/><polyline points='7,11 14,17 21,13 28,24' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/></svg>">
<meta property="og:type" content="product">
<meta property="og:title" content="${esc(title)} — Historial de precios | Bajó el Precio">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:site_name" content="Bajó el Precio">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)} — Historial de precios">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
${THEME_HEAD_SCRIPT}
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/<\/script>/gi, "<\\/script>")}</script>
<style>
:root{
  --brand:#e64c1e;--brand-dark:#c03d18;--brand-bg:#fff3ef;--brand-light:#fde8e0;
  --text:#111827;--text-soft:#6b7280;--text-xsoft:#9ca3af;
  --bg:#f9fafb;--surface:#ffffff;--border:#e5e7eb;
  --green:#16a34a;--green-bg:#dcfce7;--green-text:#14532d;
  --yellow-bg:#fef9c3;--yellow-text:#713f12;
  --red:#dc2626;--red-bg:#fee2e2;--red-text:#7f1d1d;
  --radius:12px;--radius-lg:16px;
  --shadow:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);
  --shadow-md:0 4px 6px -1px rgba(0,0,0,.08),0 2px 4px -1px rgba(0,0,0,.04);
  --shadow-lg:0 10px 24px rgba(0,0,0,.10),0 4px 8px rgba(0,0,0,.06);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
img{max-width:100%;display:block}
${NAV_CSS}
.wrap{max-width:960px;margin:0 auto;padding:32px 24px 72px}
.crumb{font-size:12px;color:var(--text-xsoft);margin-bottom:20px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.crumb a{color:var(--text-xsoft)}
.crumb a:hover{color:var(--text)}
.crumb-sep{opacity:.5}

/* Product header */
.product-header{display:grid;grid-template-columns:180px 1fr;gap:28px;align-items:start;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:28px;margin-bottom:20px;box-shadow:var(--shadow)}
.product-img{width:180px;height:180px;object-fit:contain;border-radius:var(--radius);background:var(--bg)}
.product-img-ph{width:180px;height:180px;border-radius:var(--radius);background:var(--bg)}
.product-title{font-size:clamp(18px,3vw,24px);font-weight:800;letter-spacing:-.02em;line-height:1.3;margin-bottom:14px}
.price-row{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.product-current{font-size:clamp(28px,5vw,42px);font-weight:900;letter-spacing:-.03em;line-height:1}
.price-diff{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:var(--red-bg);color:var(--red-text)}
.price-diff.at-min{background:var(--green-bg);color:var(--green-text)}
.score-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:10px;font-size:13px;font-weight:700;margin-top:8px}
.product-meta{font-size:12.5px;color:var(--text-xsoft);margin-top:10px;line-height:1.7}

/* Stats */
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;text-align:center}
.stat-card.stat-hi{border-color:#fca5a5;background:var(--red-bg)}
.stat-card.stat-lo{border-color:#86efac;background:var(--green-bg)}
.stat-card span{display:block;font-size:10.5px;color:var(--text-xsoft);margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.stat-card b{font-size:19px;font-weight:800;letter-spacing:-.01em}

/* Chart */
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;margin-bottom:16px;box-shadow:var(--shadow)}
.chart-title{font-size:13px;font-weight:600;color:var(--text-soft);margin-bottom:16px}
.chart-svg{width:100%;height:auto;display:block}
.chart-empty{padding:48px;text-align:center;color:var(--text-xsoft);font-size:14px}

/* Verdict */
.verdict{padding:16px 20px;border-radius:var(--radius);font-weight:600;font-size:14px;margin-bottom:16px;line-height:1.55}
.v-good{background:var(--green-bg);color:var(--green-text)}
.v-bad{background:var(--red-bg);color:var(--red-text)}
.v-mid{background:var(--yellow-bg);color:var(--yellow-text)}
.v-new{background:#eff6ff;color:#1e40af}
.intel-rec{font-size:13px;margin-top:6px;opacity:.85;font-weight:500}

/* CTA */
.cta-row{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:13px 22px;border-radius:10px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;border:none;transition:opacity 80ms,transform 80ms;text-decoration:none;flex:1}
.btn:hover{opacity:.88}
.btn:active{transform:scale(.97)}
.btn-ml{background:#fff159;color:#2d3277;border:1.5px solid #d4b800}
.btn-alert{background:var(--brand);color:#fff}
.btn-tg{background:#229ed9;color:#fff}
.meta-note{font-size:12px;color:var(--text-xsoft);margin-bottom:16px;line-height:1.7}

/* Share */
.share-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--text-xsoft);margin-bottom:32px;padding:14px 0;border-top:1px solid var(--border)}
.share-row a,.share-row button{font-size:13px;color:#3b82f6;background:none;border:none;cursor:pointer;font-family:inherit;padding:0;font-weight:500}
.share-row a:hover,.share-row button:hover{text-decoration:underline}

/* Section label */
.section-label{font-size:11.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--brand);margin-bottom:14px}

/* Related */
.related-section{margin-top:8px}
.related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.related-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column;transition:box-shadow 80ms,transform 80ms,border-color 80ms}
.related-card:hover{box-shadow:var(--shadow-md);transform:translateY(-2px);border-color:rgba(230,76,30,.25)}
.rc-img-wrap{aspect-ratio:1;background:var(--bg);overflow:hidden}
.rc-img-wrap img{width:100%;height:100%;object-fit:contain}
.rc-img-ph{aspect-ratio:1;background:var(--bg)}
.rc-body{padding:10px 12px 12px}
.rc-title{font-size:12.5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--text);height:36px}
.rc-price{display:block;font-size:16px;font-weight:800;letter-spacing:-.01em;margin-top:5px}

/* Footer */
footer{max-width:960px;margin:0 auto;padding:32px 24px;border-top:1px solid var(--border)}
.footer-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:12px}
.footer-logo{font-size:15px;font-weight:800;color:var(--text);display:flex;align-items:center;gap:8px}
.footer-links{display:flex;gap:20px;flex-wrap:wrap}
.footer-links a{font-size:13px;color:var(--text-soft)}
.footer-links a:hover{color:var(--text)}
.footer-copy{font-size:12px;color:var(--text-xsoft)}

/* Modal */
.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)}
.modal-backdrop.open{display:flex}
.modal{background:var(--surface);border-radius:20px;padding:28px 24px;max-width:400px;width:100%;box-shadow:var(--shadow-lg);position:relative}
.modal h3{font-size:18px;font-weight:800;margin-bottom:6px}
.modal>p{font-size:14px;color:var(--text-soft);margin-bottom:16px;line-height:1.5}
.modal-input{width:100%;padding:12px 14px;border:2px solid var(--border);border-radius:10px;font-size:15px;font-family:inherit;outline:none;margin-bottom:10px;transition:border-color .12s,box-shadow .12s;box-sizing:border-box}
.modal-input:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(230,76,30,.1)}
.modal-close{position:absolute;right:14px;top:14px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-soft);line-height:1;padding:4px}
#modal-status{font-size:13px;color:var(--text-soft);margin-top:10px;min-height:18px}
.link-code-box{background:var(--bg);border:2px dashed var(--border);border-radius:12px;padding:16px;text-align:center;margin-bottom:16px}
.link-code{font-size:36px;font-weight:900;letter-spacing:8px;color:var(--brand);font-variant-numeric:tabular-nums;line-height:1}
.link-code-hint{font-size:12px;color:var(--text-xsoft);margin-top:6px}
.modal-linked{background:rgba(34,197,94,.1);border:1.5px solid rgba(34,197,94,.3);border-radius:10px;padding:10px 14px;font-size:14px;font-weight:600;color:#16a34a;margin-bottom:14px;display:flex;align-items:center;gap:8px}
[data-theme="dark"] .modal-linked{color:#4ade80}
.modal-actions{display:flex;gap:8px;flex-direction:column}
.btn-full{width:100%;box-sizing:border-box}

@media(max-width:640px){
  .wrap{padding:20px 16px 48px}
  .product-header{grid-template-columns:1fr;padding:20px}
  .product-img{width:100%;aspect-ratio:1;height:auto;object-fit:contain}
  .product-img-ph{width:100%;aspect-ratio:1;height:auto}
  .product-title{font-size:clamp(17px,4vw,22px)}
  .stats-row{grid-template-columns:repeat(2,1fr);gap:8px}
  .stat-card{padding:11px 12px}
  .stat-card b{font-size:17px}
  .chart-card{padding:16px}
  .cta-row{flex-direction:column}
  .btn{flex:none;width:100%;padding:13px 16px}
  .related-grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  footer{padding:24px 16px}
  .footer-inner{flex-direction:column;align-items:flex-start;gap:10px}
  .footer-links{gap:12px;flex-wrap:wrap}
}
@media(max-width:480px){
  .modal{padding:22px 18px;border-radius:16px}
  .modal h3{font-size:17px}
  .link-code{font-size:28px;letter-spacing:6px}
}
${THEME_CSS}
</style>
</head>
<body>
${buildNav({ active: null, baseUrl: appUrl })}

<div class="wrap">
  <div class="crumb">
    <a href="${esc(appUrl)}">Inicio</a>
    <span class="crumb-sep">›</span>
    ${product.category ? `<a href="${esc(appUrl)}/deals/${esc(encodeURIComponent(product.category.toLowerCase()))}">${esc(product.category)}</a><span class="crumb-sep">›</span>` : ""}
    <span>${esc(title.length > 60 ? title.slice(0, 60) + "…" : title)}</span>
  </div>

  <div class="product-header">
    ${product.image
      ? `<img class="product-img" src="${esc(product.image)}" alt="${esc(title)}" loading="eager">`
      : `<div class="product-img-ph"></div>`}
    <div>
      <h1 class="product-title">${esc(title)}</h1>
      ${stats.count ? `
        <div class="price-row">
          <span class="product-current">${fmt(stats.last)}</span>
          ${priceDiffHtml}
        </div>
        ${score != null ? `<div class="score-chip" style="background:${scoreColor(score)}22;color:${scoreColor(score)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
          Deal Score: ${score}/10
        </div>` : ""}
        <p class="product-meta">
          Seguido desde ${product.firstSeen ? new Date(product.firstSeen).toLocaleDateString("es-AR") : "hoy"} ·
          ${stats.count} ${stats.count === 1 ? "registro" : "registros"} de precio ·
          Actualizado cada 6 h
        </p>
      ` : `<p style="color:var(--text-xsoft);font-size:14px;margin-top:8px">Sin precio aún — el tracker lo actualizará pronto.</p>`}
    </div>
  </div>

  ${stats.count ? `<div class="stats-row">${statCardsHtml}</div>` : ""}

  <div class="chart-card">
    <div class="chart-title">Historial de precios</div>
    ${chartSVG(history)}
  </div>

  <div class="verdict ${verdict.cls}">${esc(verdict.text)}${intelLine}</div>

  <div class="cta-row">
    <a class="btn btn-ml" href="${esc(product.url || product.rawUrl || "#")}" rel="nofollow sponsored" target="_blank">
      Ver en MercadoLibre
    </a>
    <button class="btn btn-alert" id="alert-btn">
      🔔 Alertarme cuando baje
    </button>
  </div>

  ${shareHtml}
  ${relatedHtml}
</div>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">
      <svg viewBox="0 0 36 36" width="22" height="22" aria-hidden="true">
        <rect width="36" height="36" rx="9" fill="#e64c1e"/>
        <polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Bajó el Precio
    </div>
    <div class="footer-links">
      <a href="${esc(appUrl)}">Inicio</a>
      <a href="${esc(appUrl)}/deals">Ofertas</a>
      <a href="${esc(appUrl)}/dashboard">Mis alertas</a>
      <a href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Bot Telegram</a>
    </div>
  </div>
  <p class="footer-copy">Herramienta independiente. No afiliada a MercadoLibre S.A. Datos con fines informativos.</p>
</footer>

<div class="modal-backdrop" id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="modal">
    <button class="modal-close" id="modal-close" aria-label="Cerrar">✕</button>
    <h3 id="modal-title">🔔 Alerta de precio</h3>

    <!-- Paso 1: vincular Telegram (se oculta una vez vinculado) -->
    <div id="modal-link-section">
      <p>Vinculá tu Telegram una sola vez — después activás alertas con un clic.</p>
      <div class="link-code-box">
        <div class="link-code" id="modal-code">······</div>
        <div class="link-code-hint" id="modal-code-hint">Generando código…</div>
      </div>
      <a class="btn btn-alert btn-full" id="modal-tg-btn" href="#" target="_blank" rel="noopener">
        Abrir bot en Telegram →
      </a>
      <p id="modal-link-status" style="font-size:12px;color:var(--text-xsoft);margin-top:10px;text-align:center;min-height:16px"></p>
    </div>

    <!-- Paso 2: configurar alerta (se muestra cuando ya está vinculado) -->
    <div id="modal-linked-section" style="display:none">
      <div class="modal-linked" id="modal-linked-badge">✓ Telegram vinculado</div>
      <input class="modal-input" id="modal-price" type="number" placeholder="Precio objetivo en $ (opcional — vacío = cualquier baja)" min="0">
      <div class="modal-actions">
        <button class="btn btn-alert btn-full" id="modal-save">Activar alerta</button>
        <button style="background:none;border:none;font-size:12px;color:var(--text-xsoft);cursor:pointer;padding:4px" id="modal-unlink">Desvincular cuenta</button>
      </div>
      <p id="modal-status"></p>
    </div>
  </div>
</div>

<script>
  const PRODUCT_ID = ${JSON.stringify(product.id).replace(/<\/script>/gi, "<\\/script>")};
  const PRODUCT_TITLE = ${JSON.stringify(title).replace(/<\/script>/gi, "<\\/script>")};

  let _pollTimer = null;

  function closeModal() {
    document.getElementById('modal').classList.remove('open');
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  function showLinked(chatId) {
    document.getElementById('modal-link-section').style.display = 'none';
    const sec = document.getElementById('modal-linked-section');
    sec.style.display = '';
    document.getElementById('modal-linked-badge').textContent = '✓ ' + chatId;
    document.getElementById('modal-status').textContent = '';
    document.getElementById('modal-price').value = '';
  }

  async function startLinking() {
    document.getElementById('modal-code').textContent = '······';
    document.getElementById('modal-code-hint').textContent = 'Generando código…';
    document.getElementById('modal-link-status').textContent = '';
    document.getElementById('modal-tg-btn').href = '#';
    try {
      const r = await fetch('/api/link-code', { method: 'POST' });
      const { code } = await r.json();
      document.getElementById('modal-code').textContent = code;
      document.getElementById('modal-code-hint').textContent = 'Enviá este código al bot de Telegram';
      document.getElementById('modal-tg-btn').href = 'https://t.me/bajoelprecio_bot?start=link_' + code;
      document.getElementById('modal-link-status').textContent = 'Esperando vinculación…';
      if (_pollTimer) clearInterval(_pollTimer);
      _pollTimer = setInterval(async () => {
        try {
          const pr = await fetch('/api/link-status/' + code);
          if (!pr.ok) { clearInterval(_pollTimer); _pollTimer = null; document.getElementById('modal-link-status').textContent = 'Código expirado. Recargá el modal.'; return; }
          const pd = await pr.json();
          if (pd.chatId) {
            clearInterval(_pollTimer); _pollTimer = null;
            localStorage.setItem('tg_chatid', pd.chatId);
            showLinked(pd.chatId);
          }
        } catch {}
      }, 2000);
    } catch {
      document.getElementById('modal-code-hint').textContent = 'Error al generar código. Recargá la página.';
    }
  }

  async function openModal() {
    document.getElementById('modal').classList.add('open');
    const saved = localStorage.getItem('tg_chatid');
    if (saved) {
      showLinked(saved);
    } else {
      document.getElementById('modal-link-section').style.display = '';
      document.getElementById('modal-linked-section').style.display = 'none';
      await startLinking();
    }
  }

  document.getElementById('alert-btn').addEventListener('click', openModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal(); });

  document.getElementById('modal-unlink').addEventListener('click', () => {
    localStorage.removeItem('tg_chatid');
    document.getElementById('modal-linked-section').style.display = 'none';
    document.getElementById('modal-link-section').style.display = '';
    startLinking();
  });

  document.getElementById('modal-save').addEventListener('click', async () => {
    const chatId = localStorage.getItem('tg_chatid');
    const targetPrice = document.getElementById('modal-price').value.trim();
    const statusEl = document.getElementById('modal-status');
    if (!chatId) { statusEl.textContent = 'Vinculá tu Telegram primero.'; return; }
    document.getElementById('modal-save').disabled = true;
    statusEl.textContent = 'Guardando…';
    try {
      const r = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, productId: PRODUCT_ID, targetPrice: targetPrice || null, title: PRODUCT_TITLE })
      });
      const d = await r.json();
      if (d.ok) {
        statusEl.textContent = '✅ ¡Alerta activada! Te avisamos cuando baje.';
        setTimeout(closeModal, 2200);
      } else if (d.error === 'limit') {
        statusEl.innerHTML = '⭐ Llegaste al límite. <a href="/premium" style="color:var(--brand);font-weight:600">Activá Plan Pro</a>.';
      } else {
        statusEl.textContent = 'Error al guardar. Intentá de nuevo.';
      }
    } catch { statusEl.textContent = 'Error de conexión.'; }
    finally { document.getElementById('modal-save').disabled = false; }
  });
</script>
<script src="/theme.js"></script>
</body>
</html>`;
}

/** sitemap.xml — todas las URLs de producto para Google. */
export function renderSitemap(products, baseUrl, categories = []) {
  const today = new Date().toISOString().slice(0, 10);
  const catUrls = categories.map(c =>
    `<url><loc>${esc(baseUrl)}/deals/${esc(encodeURIComponent(c))}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`
  ).join("");
  const staticUrls = [
    `<url><loc>${esc(baseUrl)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${esc(baseUrl)}/deals</loc><changefreq>daily</changefreq><priority>0.9</priority></url>`,
    catUrls,
  ].join("");
  const productUrls = products
    .map((p) =>
      `<url><loc>${esc(baseUrl)}/p/${esc(p.id)}</loc><lastmod>${new Date(p.lastScraped ?? Date.now()).toISOString().slice(0, 10)}</lastmod><changefreq>daily</changefreq><priority>0.6</priority></url>`
    ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticUrls}${productUrls}</urlset>`;
}
