// Páginas SSR por producto: HTML real indexable por Google.
// La SPA del home es invisible para crawlers; estas páginas son el motor de tráfico orgánico.

const fmt = (n) => "$" + Number(n).toLocaleString("es-AR");

const LOGO_SVG = `<svg viewBox="0 0 36 36" width="26" height="26" aria-hidden="true">
  <rect width="36" height="36" rx="9" fill="#e64c1e"/>
  <polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M28 24 L28 19 M28 24 L23 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** SVG estático del historial — visible para crawlers y sin JS. */
function chartSVG(history) {
  const W = 720, H = 220, PL = 64, PR = 16, PT = 12, PB = 24;
  const prices = history.map((h) => h.price);
  if (prices.length < 2) {
    return `<div class="chart-empty">Todavía estamos juntando historial de este producto. Volvé en unas horas.</div>`;
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
  const gridLines = labels
    .map(({ v, l }) =>
      `<line x1="${PL}" y1="${y(v).toFixed(1)}" x2="${W - PR}" y2="${y(v).toFixed(1)}" stroke="#f0f0f0" stroke-width="1"/>
       <text x="${PL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#9ca3af">${esc(l)}</text>`
    ).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg" role="img" aria-label="Historial de precios">
    ${gridLines}
    <polygon points="${area}" fill="rgba(230,76,30,.07)"/>
    <polyline points="${line}" fill="none" stroke="#e64c1e" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(prices.length - 1).toFixed(1)}" cy="${y(prices.at(-1)).toFixed(1)}" r="4.5" fill="#e64c1e" stroke="#fff" stroke-width="2"/>
  </svg>`;
}

function buildVerdict(stats) {
  if (stats.count < 3) return { text: "🆕 Recién empezamos a seguir este producto. Volvé en unos días para ver el historial completo.", cls: "v-new" };
  if (stats.last <= stats.min) return { text: "🟢 Está en su precio MÁS BAJO registrado. Este descuento es REAL.", cls: "v-good" };
  if (stats.last <= stats.avg) return { text: "🟡 Por debajo del promedio histórico. Buen momento para comprar.", cls: "v-mid" };
  return { text: "🔴 Por encima del promedio. Ojo: este NO es el mejor precio registrado.", cls: "v-bad" };
}

/** HTML completo de la página de un producto — indexable por Google, compartible en redes. */
export function renderProductPage({ product, history, stats, intelligence }, { baseUrl, appUrl, related = [] }) {
  const title = product.title || "Producto";
  const pageUrl = `${baseUrl}/p/${product.id}`;
  const verdict = buildVerdict(stats);
  const intelLine = intelligence && intelligence.confidence >= 30
    ? `<div style="font-size:13px;margin-top:6px;opacity:.85">${esc(intelligence.recommendation)}</div>`
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
    ...(stats.count
      ? {
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
        }
      : {}),
  };

  const statCardsHtml = stats.count
    ? [
        { l: "Precio actual", v: stats.last, hi: stats.last > stats.avg },
        { l: "Mínimo histórico", v: stats.min },
        { l: "Máximo histórico", v: stats.max },
        { l: "Promedio", v: stats.avg },
      ]
        .map(({ l, v, hi }) =>
          `<div class="stat-card${hi ? " stat-hi" : ""}"><span>${esc(l)}</span><b>${fmt(v)}</b></div>`
        )
        .join("")
    : "";

  const shareUrl = encodeURIComponent(pageUrl);
  const shareText = encodeURIComponent(`Historial real de "${title}" en ML → `);
  const shareHtml = `<div class="share-row">
    <span>Compartir:</span>
    <a href="https://wa.me/?text=${shareText}${shareUrl}" target="_blank" rel="noopener">WhatsApp</a>
    <a href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}" target="_blank" rel="noopener">X / Twitter</a>
    <button onclick="navigator.clipboard.writeText('${esc(pageUrl)}');this.textContent='✓ Copiado!'">Copiar link</button>
  </div>`;

  const relatedHtml = related.length
    ? `<section class="related-section">
        <h2>Más en ${esc(product.category || "MercadoLibre")}</h2>
        <div class="related-grid">
          ${related
            .map(
              (r) =>
                `<a class="related-card" href="${baseUrl}/p/${esc(r.id)}">
                  <span class="rc-title">${esc(r.title)}</span>
                  ${r.price != null ? `<span class="rc-price">${fmt(r.price)}</span>` : ""}
                </a>`
            )
            .join("")}
        </div>
      </section>`
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
:root{--brand:#e64c1e;--brand-dark:#c03d18;--brand-bg:#fff3ef;--text:#111827;--text-soft:#6b7280;--text-xsoft:#9ca3af;--bg:#f9fafb;--surface:#ffffff;--border:#e5e7eb;--radius:12px}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
.nav{background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
.nav-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;height:60px;max-width:900px;margin:0 auto;padding:0 20px}
.nav-logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
.nav-cta{padding:7px 16px;background:var(--brand);color:#fff;border-radius:8px;font-size:13px;font-weight:700;transition:background 80ms,transform 80ms}
.nav-cta:hover{background:var(--brand-dark)}
.nav-cta:active{transform:scale(.97)}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px}
.crumb{font-size:12px;color:var(--text-xsoft);margin-bottom:16px}
.crumb a{color:var(--text-xsoft)}
.crumb a:hover{color:var(--text)}
.product-header{display:grid;grid-template-columns:140px 1fr;gap:24px;align-items:start;margin-bottom:28px}
.product-img{width:140px;height:140px;object-fit:contain;border-radius:var(--radius);background:var(--surface);border:1px solid var(--border)}
.product-img-ph{width:140px;height:140px;border-radius:var(--radius);background:var(--bg)}
.product-title{font-size:22px;font-weight:800;letter-spacing:-.02em;line-height:1.3;margin-bottom:10px}
.product-current{font-size:32px;font-weight:800;color:var(--brand);line-height:1;font-variant-numeric:tabular-nums}
.product-badge{display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;margin-left:10px;vertical-align:middle}
.badge-low{background:#ecfdf5;color:#065f46}
.badge-high{background:#fef2f2;color:#991b1b}
.stats-row{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 16px;flex:1;min-width:130px}
.stat-card.stat-hi{border-color:#fca5a5;background:#fef2f2}
.stat-card span{display:block;font-size:10px;color:var(--text-xsoft);margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em;font-weight:500}
.stat-card b{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}
.chart-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.chart-svg{width:100%;height:auto;display:block}
.chart-empty{padding:40px;text-align:center;color:var(--text-xsoft);font-size:14px}
.verdict{padding:14px 18px;border-radius:10px;font-weight:600;font-size:14px;margin-bottom:16px}
.v-good{background:#ecfdf5;color:#065f46}
.v-bad{background:#fef2f2;color:#991b1b}
.v-mid{background:#fffbeb;color:#92400e}
.v-new{background:#eff6ff;color:#1e40af}
.cta-row{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:8px;padding:12px 22px;border-radius:10px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;border:none;transition:opacity 80ms,transform 80ms;text-decoration:none}
.btn:hover{opacity:.88}
.btn:active{transform:scale(.97)}
.btn-ml{background:#fff159;color:#2d3277;border:1px solid #e6c800;flex:1;justify-content:center}
.btn-alert{background:var(--brand);color:#fff;flex:1;justify-content:center}
.btn-tg{background:#229ed9;color:#fff;flex:1;justify-content:center}
.meta-note{font-size:12px;color:var(--text-xsoft);margin-bottom:16px}
.share-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--text-xsoft);margin-bottom:24px}
.share-row a,.share-row button{font-size:13px;color:#3b82f6;background:none;border:none;cursor:pointer;font-family:inherit;padding:0}
.share-row a:hover,.share-row button:hover{text-decoration:underline}
.related-section{margin-top:32px}
.related-section h2{font-size:17px;font-weight:700;margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid var(--brand);display:inline-block}
.related-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.related-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:6px;transition:box-shadow 80ms,border-color 80ms,transform 80ms}
.related-card:hover{border-color:var(--brand);box-shadow:0 0 0 1px rgba(0,0,0,.04),0 2px 4px rgba(0,0,0,.05);transform:translateY(-1px)}
.rc-title{font-size:13px;line-height:1.4;height:36px;overflow:hidden;color:var(--text)}
.rc-price{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums}
footer{max-width:900px;margin:0 auto;padding:28px 20px;border-top:1px solid var(--border);font-size:12px;color:var(--text-xsoft)}
footer a{color:var(--text-soft)}
.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;align-items:center;justify-content:center;padding:20px}
.modal-backdrop.open{display:flex}
.modal{background:var(--surface);border-radius:20px;padding:32px;max-width:420px;width:100%;box-shadow:0 20px 48px rgba(0,0,0,.18);position:relative}
.modal h3{font-size:20px;font-weight:700;margin-bottom:8px}
.modal p{font-size:14px;color:var(--text-soft);margin-bottom:16px;line-height:1.6}
.modal-input{width:100%;padding:12px 14px;border:2px solid var(--border);border-radius:10px;font-size:15px;font-family:inherit;outline:none;margin-bottom:10px;transition:border-color 80ms,box-shadow 80ms}
.modal-input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(230,76,30,.12)}
.modal-row{display:flex;gap:10px}
.modal-close{position:absolute;right:16px;top:16px;background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-soft)}
#modal-status{font-size:13px;color:var(--text-soft);margin-top:8px;min-height:18px}
@media(max-width:600px){
  .product-header{grid-template-columns:1fr}
  .product-img,.product-img-ph{width:100%;height:180px;object-fit:contain}
  .stats-row{gap:8px}
  .stat-card{min-width:calc(50% - 4px)}
  .cta-row{flex-direction:column}
}
</style>
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <a class="nav-logo" href="${esc(appUrl)}">${LOGO_SVG} Bajó el Precio</a>
    <a class="nav-cta" href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Bot Telegram</a>
  </div>
</nav>

<div class="wrap">
  <div class="crumb">
    <a href="${esc(appUrl)}">Inicio</a> ›
    ${product.category ? `<a href="${esc(appUrl)}/?cat=${esc(product.category)}">${esc(product.category)}</a> › ` : ""}
    Historial de precios
  </div>

  <div class="product-header">
    ${product.image
      ? `<img class="product-img" src="${esc(product.image)}" alt="${esc(title)}" loading="eager">`
      : `<div class="product-img-ph"></div>`}
    <div>
      <h1 class="product-title">${esc(title)}</h1>
      ${stats.count
        ? `<div>
            <span class="product-current">${fmt(stats.last)}</span>
            <span class="product-badge ${stats.last <= stats.min ? "badge-low" : "badge-high"}">
              ${stats.last <= stats.min ? "Precio mínimo" : "Por encima del mínimo"}
            </span>
          </div>`
        : `<div style="color:var(--text-xsoft);font-size:14px">Sin precio aún — el tracker lo actualizará pronto.</div>`}
    </div>
  </div>

  <div class="stats-row">${statCardsHtml}</div>

  <div class="chart-card">
    ${chartSVG(history)}
  </div>

  <div class="verdict ${verdict.cls}">${esc(verdict.text)}${intelLine}</div>

  <div class="cta-row">
    <a class="btn btn-ml" href="${esc(product.url || product.rawUrl || "#")}" rel="nofollow sponsored" target="_blank">
      Ver en MercadoLibre →
    </a>
    <button class="btn btn-alert" id="alert-btn">
      🔔 Alertarme cuando baje
    </button>
  </div>

  <p class="meta-note">
    Seguido desde ${product.firstSeen ? new Date(product.firstSeen).toLocaleDateString("es-AR") : "hoy"}.
    ${stats.count} ${stats.count === 1 ? "registro" : "registros"} de precio. Datos con fines informativos.
  </p>

  ${shareHtml}
  ${relatedHtml}
</div>

<footer>
  <strong>Bajó el Precio</strong> — Historial real de precios de MercadoLibre Argentina. No estamos afiliados a MercadoLibre S.A.
  <br><a href="${esc(appUrl)}">Inicio</a> · <a href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Bot de Telegram</a> · <a href="${esc(appUrl)}/sitemap.xml">Sitemap</a>
</footer>

<!-- Alert modal -->
<div class="modal-backdrop" id="modal" role="dialog" aria-modal="true">
  <div class="modal">
    <button class="modal-close" id="modal-close" aria-label="Cerrar">✕</button>
    <h3>Activar alerta de precio</h3>
    <p>Te avisamos por Telegram cuando el precio baje al valor que elegís.</p>
    <input class="modal-input" id="modal-chatid" type="text" placeholder="Tu Chat ID de Telegram (ej: 123456789)">
    <input class="modal-input" id="modal-price" type="number" placeholder="Precio objetivo en pesos (opcional)" min="0">
    <p style="font-size:12px;color:var(--text-xsoft);margin-bottom:14px">
      No sabés tu ID? Mandá <strong>/start</strong> a <a href="https://t.me/bajoelprecio_bot" target="_blank" style="color:var(--brand)">@bajoelprecio_bot</a>.
    </p>
    <div class="modal-row">
      <button class="btn" style="background:var(--bg);color:var(--text);border:1px solid var(--border);flex:none;padding:11px 18px" id="modal-cancel">Cancelar</button>
      <button class="btn btn-alert" style="flex:1;justify-content:center" id="modal-save">Activar alerta</button>
    </div>
    <p id="modal-status"></p>
  </div>
</div>

<script>
  const PRODUCT_ID = '${esc(product.id)}';
  const PRODUCT_TITLE = '${esc(title.replace(/'/g, "\\'"))}';

  document.getElementById('alert-btn').addEventListener('click', () => {
    document.getElementById('modal').classList.add('open');
    document.getElementById('modal-chatid').focus();
  });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal').addEventListener('click', e => { if (e.target === document.getElementById('modal')) closeModal(); });

  function closeModal() { document.getElementById('modal').classList.remove('open'); }

  document.getElementById('modal-save').addEventListener('click', async () => {
    const chatId = document.getElementById('modal-chatid').value.trim();
    const targetPrice = document.getElementById('modal-price').value.trim();
    const statusEl = document.getElementById('modal-status');
    if (!chatId) { statusEl.textContent = 'Ingresá tu Chat ID.'; return; }
    document.getElementById('modal-save').disabled = true;
    statusEl.textContent = 'Guardando...';
    try {
      const r = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, productId: PRODUCT_ID, targetPrice: targetPrice || null, title: PRODUCT_TITLE })
      });
      const d = await r.json();
      if (d.ok) {
        statusEl.textContent = '✅ ¡Alerta activada! Te avisamos cuando baje.';
        setTimeout(closeModal, 2500);
      } else if (d.error === 'limit') {
        statusEl.innerHTML = '⭐ Llegaste al límite. <a href="/premium" style="color:var(--brand);font-weight:600">Activá Plan Pro</a> para alertas ilimitadas.';
      } else {
        statusEl.textContent = 'Error. Verificá el Chat ID.';
      }
    } catch { statusEl.textContent = 'Error de conexión.'; }
    finally { document.getElementById('modal-save').disabled = false; }
  });
</script>
</body>
</html>`;
}

/** sitemap.xml — todas las URLs de producto para Google. */
export function renderSitemap(products, baseUrl) {
  const urls = products
    .map(
      (p) =>
        `<url><loc>${esc(baseUrl)}/p/${esc(p.id)}</loc><lastmod>${new Date(p.lastScraped ?? Date.now()).toISOString().slice(0, 10)}</lastmod><changefreq>daily</changefreq></url>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(baseUrl)}/</loc></url>${urls}</urlset>`;
}
