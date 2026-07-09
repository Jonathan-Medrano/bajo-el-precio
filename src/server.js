import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { trackProduct, getHistory, observeProduct, subscribeAlert, listAlerts, unsubscribeAlert } from "./service.js";
import { findCheapestEquivalent } from "./finder.js";
import { pickByView } from "./cuotas.js";
import { affiliateUrl } from "./affiliate.js";
import { getPlan, grantPremium } from "./plans.js";
import { createApiKey, apiKeyMiddleware } from "./apikeys.js";
import { renderProductPage, renderSitemap } from "./seo-page.js";
import { mpWebhookHandler } from "./mercadopago.js";
import { telegramWebhookHandler } from "./bot.js";
import { renderOgImage } from "./og-image.js";
import { prisma } from "./db.js";
import { sendChannel } from "./telegram.js";

const baseUrlOf = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN || req.header("x-admin-token") !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "no autorizado" });
  }
  next();
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
// Preservar rawBody para verificación de firma HMAC (MercadoPago webhook)
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

// CORS (para el frontend React en dev)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(join(__dirname, "..", "public"))); // frontend vanilla (legacy)

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "keepa-ml" }));

// Stats globales para el contador del hero de la landing.
app.get("/api/stats", async (_req, res) => {
  const [products, datapoints, alerts] = await Promise.all([
    prisma.product.count({ where: { prices: { some: {} } } }),
    prisma.pricePoint.count(),
    prisma.alert.count(),
  ]);
  res.json({ products, datapoints, alerts });
});

// Dashboard — soporta /dashboard sin extensión .html
app.get("/dashboard", (_req, res) => {
  res.sendFile(join(__dirname, "..", "public", "dashboard.html"));
});

// --- Imagen social (Open Graph / Twitter card) por producto -------------------
// Card 1200x630 con foto + precio + bajada + gráfico. Es la base del funnel de Twitter:
// sirve de twitter:image del enlace Y como imagen nativa a adjuntar en el tweet.
app.get("/og/:id.png", async (req, res) => {
  try {
    const png = await renderOgImage(req.params.id);
    if (!png) return res.status(404).send("no encontrado");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600"); // 1h: el precio no cambia tan seguido
    res.send(png);
  } catch (e) {
    console.error("og-image error:", e.message);
    res.status(500).send("error");
  }
});

// --- SEO: páginas públicas por producto (motor de tráfico orgánico) -----------
app.get("/p/:id", async (req, res) => {
  const data = await getHistory(req.params.id);
  const baseUrl = baseUrlOf(req);
  const appUrl = process.env.WEB_URL || baseUrl;
  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  if (data.error) {
    return res.status(404).send(`<!doctype html><meta charset="utf-8"><title>No encontrado</title><p>Producto no encontrado. <a href="${appUrl}">Volver al inicio</a></p>`);
  }
  // Productos relacionados (misma categoría) para enlazado interno = mejor SEO.
  const relatedRaw = await prisma.product.findMany({
    where: {
      id: { not: data.product.id },
      prices: { some: {} },
      ...(data.product.category ? { category: data.product.category } : {}),
    },
    select: { id: true, title: true, prices: { orderBy: { seenAt: "desc" }, take: 1, select: { price: true } } },
    orderBy: { queries: "desc" },
    take: 8,
  });
  const related = relatedRaw.map((r) => ({ id: r.id, title: r.title, price: r.prices[0]?.price ?? null }));
  res.send(renderProductPage(data, { baseUrl, appUrl, related }));
});

app.get("/sitemap.xml", async (req, res) => {
  const products = await prisma.product.findMany({
    where: { prices: { some: {} } },
    select: { id: true, lastScraped: true },
    orderBy: { lastScraped: "desc" },
  });
  res.set("Content-Type", "application/xml").send(renderSitemap(products, baseUrlOf(req)));
});

app.get("/robots.txt", (req, res) => {
  res.set("Content-Type", "text/plain").send(`User-agent: *\nAllow: /\n\nSitemap: ${baseUrlOf(req)}/sitemap.xml\n`);
});

// Referral redirect: /ref/:chatId → Telegram deep link
app.get("/ref/:code", (req, res) => {
  const code = req.params.code.replace(/\D/g, "");
  if (!code) return res.redirect("/");
  res.redirect(302, `https://t.me/bajoelprecio_bot?start=ref_${code}`);
});

async function fetchDeals({ category } = {}) {
  const products = await prisma.product.findMany({
    where: {
      prices: { some: {} },
      ...(category ? { category: { equals: category, mode: "insensitive" } } : {}),
    },
    select: {
      id: true, title: true, image: true, category: true, url: true,
      prices: { orderBy: { seenAt: "desc" }, take: 60, select: { price: true, seenAt: true } },
    },
    orderBy: { queries: "desc" },
    take: 500,
  });

  const deals = [];
  for (const p of products) {
    const prices = p.prices;
    if (prices.length < 3) continue;
    const current = prices.at(0).price;
    const min = Math.min(...prices.map((x) => x.price));
    const avg = prices.reduce((s, x) => s + x.price, 0) / prices.length;
    if (current > min * 1.08) continue;
    const savingPct = Math.round(((avg - current) / avg) * 100);
    deals.push({ id: p.id, title: p.title, image: p.image, url: p.url, category: p.category, current, min, avg: Math.round(avg), savingPct });
  }

  deals.sort((a, b) => b.savingPct - a.savingPct);
  return deals.slice(0, 50);
}

app.get("/api/deals", async (req, res) => {
  try {
    const category = req.query.category || null;
    const deals = await fetchDeals({ category });
    res.json(deals.map((d) => ({ id: d.id, title: d.title, image: d.image, price: d.current, min: d.min, avg: d.avg, savingPct: d.savingPct, url: d.url, category: d.category })));
  } catch (e) {
    console.error("deals error:", e.message);
    res.status(500).json({ error: "fallo" });
  }
});

app.get("/deals", async (req, res) => {
  const baseUrl = baseUrlOf(req);
  try {
    const deals = await fetchDeals();
    const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const ogImage = deals[0] ? `${baseUrl}/og/${deals[0].id}.png` : "";

    const cards = deals.length
      ? deals.map((d) => `
        <a class="deal-card" href="/p/${esc(d.id)}">
          <div class="deal-img-wrap">
            ${d.image ? `<img src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy">` : `<div class="deal-img-ph"></div>`}
          </div>
          <div class="deal-body">
            <div class="deal-title">${esc(d.title)}</div>
            <div class="deal-prices">
              <span class="deal-current">${fmt(d.current)}</span>
              <span class="deal-avg">${fmt(d.avg)}</span>
            </div>
            <div class="deal-badge">−${d.savingPct}% vs promedio</div>
            <div class="deal-cta">Ver historial →</div>
          </div>
        </a>`).join("")
      : `<div class="deals-empty">
          <p>Por ahora no hay productos en precio mínimo verificado.</p>
          <p>El tracker actualiza continuamente — volvé en unas horas.</p>
        </div>`;

    const html = `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ofertas reales en MercadoLibre | Bajó el Precio</title>
  <meta name="description" content="Productos de MercadoLibre en su precio mínimo verificado. Historial real, sin inflados. Actualizado continuamente.">
  <meta property="og:title" content="Ofertas reales en MercadoLibre | Bajó el Precio">
  <meta property="og:description" content="Productos en precio mínimo verificado. Sin descuentos inventados.">
  <meta property="og:type" content="website">
  ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ""}
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><rect width='36' height='36' rx='9' fill='%23e64c1e'/><polyline points='7,11 14,17 21,13 28,24' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --brand: #e64c1e; --brand-dark: #c03d18; --brand-bg: #fff3ef;
      --text: #111827; --text-soft: #6b7280; --text-xsoft: #9ca3af;
      --bg: #f9fafb; --surface: #ffffff; --border: #e5e7eb;
      --radius: 12px;
      --shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.04);
      --shadow-md: 0 4px 6px -1px rgba(0,0,0,.08), 0 2px 4px -1px rgba(0,0,0,.04);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
    a { color: inherit; text-decoration: none; }
    img { max-width: 100%; display: block; }
    .container { max-width: 1100px; margin: 0 auto; padding: 0 20px; }
    .nav { background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; }
    .nav-inner { display: flex; align-items: center; justify-content: space-between; gap: 16px; height: 60px; }
    .nav-logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; color: var(--text); }
    .nav-links { display: flex; align-items: center; gap: 4px; }
    .nav-link { padding: 7px 14px; border-radius: 8px; font-size: 14px; font-weight: 500; color: var(--text-soft); transition: background 80ms, color 80ms; }
    .nav-link:hover { background: var(--bg); color: var(--text); }
    .nav-link.cta { background: var(--brand); color: #fff; }
    .nav-link.cta:hover { background: var(--brand-dark); }
    .deals-header { padding: 48px 0 32px; }
    .deals-header h1 { font-size: clamp(24px, 4vw, 40px); font-weight: 800; letter-spacing: -.02em; margin-bottom: 10px; }
    .deals-header p { font-size: 16px; color: var(--text-soft); max-width: 580px; line-height: 1.6; }
    .deals-count { display: inline-block; background: var(--brand-bg); color: var(--brand); font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 999px; margin-bottom: 16px; }
    .deals-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; padding-bottom: 64px; }
    .deal-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; transition: box-shadow 120ms, transform 120ms; }
    .deal-card:hover { box-shadow: 0 0 0 2px rgba(230,76,30,.35), 0 4px 6px -1px rgba(0,0,0,.08), 0 2px 4px -1px rgba(0,0,0,.04); transform: translateY(-2px); }
    .deal-img-wrap { background: var(--bg); aspect-ratio: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; }
    .deal-img-wrap img { width: 100%; height: 100%; object-fit: contain; }
    .deal-img-ph { width: 100%; aspect-ratio: 1; background: var(--bg); }
    .deal-body { padding: 14px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
    .deal-title { font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--text); font-weight: 500; }
    .deal-prices { display: flex; align-items: baseline; gap: 8px; margin-top: 2px; }
    .deal-current { font-size: 20px; font-weight: 800; color: var(--text); }
    .deal-avg { font-size: 13px; color: var(--text-xsoft); text-decoration: line-through; }
    .deal-badge { display: inline-block; background: #ecfdf5; color: #065f46; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; }
    .deal-cta { font-size: 13px; color: var(--brand); font-weight: 600; margin-top: auto; padding-top: 8px; }
    .deals-empty { grid-column: 1 / -1; text-align: center; padding: 80px 20px; color: var(--text-soft); }
    .deals-empty p { font-size: 16px; margin-bottom: 8px; }
    footer { padding: 40px 0; border-top: 1px solid var(--border); }
    .footer-inner { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .footer-logo { font-size: 15px; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
    .footer-links { display: flex; gap: 20px; flex-wrap: wrap; }
    .footer-links a { font-size: 13px; color: var(--text-soft); }
    .footer-links a:hover { color: var(--text); }
    .footer-copy { font-size: 12px; color: var(--text-xsoft); margin-top: 12px; }
    @media (max-width: 600px) { .deals-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; } }
  </style>
</head>
<body>
<nav class="nav">
  <div class="container nav-inner">
    <a class="nav-logo" href="/">
      <svg viewBox="0 0 36 36" width="28" height="28" aria-hidden="true">
        <rect width="36" height="36" rx="9" fill="#e64c1e"/>
        <polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M28 24 L28 19 M28 24 L23 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Bajó el Precio
    </a>
    <div class="nav-links">
      <a class="nav-link" href="/">Buscar</a>
      <a class="nav-link" href="/dashboard">Mis alertas</a>
      <a class="nav-link cta" href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Telegram →</a>
    </div>
  </div>
</nav>

<main>
  <div class="container">
    <div class="deals-header">
      <div class="deals-count">${deals.length} productos verificados</div>
      <h1>🔥 Ofertas reales ahora</h1>
      <p>Solo aparecen productos cuyo precio actual está dentro del 8% de su mínimo histórico verificado. Sin inflados, sin especulación.</p>
    </div>
    <div class="deals-grid">
      ${cards}
    </div>
  </div>
</main>

<footer>
  <div class="container">
    <div class="footer-inner">
      <div class="footer-logo">
        <svg viewBox="0 0 36 36" width="22" height="22" aria-hidden="true">
          <rect width="36" height="36" rx="9" fill="#e64c1e"/>
          <polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Bajó el Precio
      </div>
      <div class="footer-links">
        <a href="/">Inicio</a>
        <a href="/dashboard">Mis alertas</a>
        <a href="/deals">Deals</a>
        <a href="/developers">API</a>
        <a href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Bot Telegram</a>
        <a href="/sitemap.xml">Sitemap</a>
      </div>
    </div>
    <p class="footer-copy">Herramienta independiente. No afiliada a MercadoLibre S.A. · Datos con fines informativos.</p>
  </div>
</footer>
</body>
</html>`;

    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (e) {
    console.error("deals page error:", e.message);
    res.status(500).send("Error interno");
  }
});

// Deals filtrados por categoría (redirige a /deals con filtro visible en title/h1)
app.get("/deals/:category", async (req, res) => {
  const catParam = req.params.category;
  const catLabel = catParam.charAt(0).toUpperCase() + catParam.slice(1).toLowerCase();
  const baseUrl = baseUrlOf(req);
  try {
    const deals = await fetchDeals({ category: catLabel });
    const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const cards = deals.length
      ? deals.map((d) => `
        <a class="deal-card" href="/p/${esc(d.id)}">
          <div class="deal-img-wrap">
            ${d.image ? `<img src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy">` : `<div class="deal-img-ph"></div>`}
          </div>
          <div class="deal-body">
            <div class="deal-title">${esc(d.title)}</div>
            <div class="deal-prices">
              <span class="deal-current">${fmt(d.current)}</span>
              <span class="deal-avg">${fmt(d.avg)}</span>
            </div>
            <div class="deal-badge">−${d.savingPct}% vs promedio</div>
            <div class="deal-cta">Ver historial →</div>
          </div>
        </a>`).join("")
      : `<div class="deals-empty">
          <p>No hay ofertas verificadas en ${esc(catLabel)} por ahora.</p>
          <p>El tracker actualiza continuamente — volvé en unas horas.</p>
        </div>`;

    const html = `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ofertas en ${esc(catLabel)} — MercadoLibre | Bajó el Precio</title>
  <meta name="description" content="Los mejores precios verificados en ${esc(catLabel)} de MercadoLibre Argentina. Historial real, sin inflados.">
  <meta property="og:title" content="Ofertas en ${esc(catLabel)} | Bajó el Precio">
  <meta property="og:type" content="website">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><rect width='36' height='36' rx='9' fill='%23e64c1e'/><polyline points='7,11 14,17 21,13 28,24' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root { --brand:#e64c1e;--brand-dark:#c03d18;--brand-bg:#fff3ef;--text:#111827;--text-soft:#6b7280;--text-xsoft:#9ca3af;--bg:#f9fafb;--surface:#ffffff;--border:#e5e7eb;--radius:12px;--shadow:0 1px 3px rgba(0,0,0,.08);--shadow-md:0 4px 6px -1px rgba(0,0,0,.08); }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
    a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
    .container{max-width:1100px;margin:0 auto;padding:0 20px}
    .nav{background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
    .nav-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;height:60px}
    .nav-logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
    .nav-links{display:flex;align-items:center;gap:4px}
    .nav-link{padding:7px 14px;border-radius:8px;font-size:14px;font-weight:500;color:var(--text-soft);transition:background 80ms,color 80ms}
    .nav-link:hover{background:var(--bg);color:var(--text)}
    .nav-link.cta{background:var(--brand);color:#fff}
    .nav-link.cta:hover{background:var(--brand-dark)}
    .deals-header{padding:48px 0 32px}
    .deals-header h1{font-size:clamp(24px,4vw,40px);font-weight:800;letter-spacing:-.02em;margin-bottom:10px}
    .deals-header p{font-size:16px;color:var(--text-soft);max-width:580px;line-height:1.6}
    .deals-count{display:inline-block;background:var(--brand-bg);color:var(--brand);font-size:13px;font-weight:600;padding:4px 12px;border-radius:999px;margin-bottom:16px}
    .breadcrumb{font-size:13px;color:var(--text-soft);margin-bottom:12px}
    .breadcrumb a{color:var(--brand)}
    .deals-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;padding-bottom:64px}
    .deal-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;display:flex;flex-direction:column;transition:box-shadow 80ms,border-color 80ms,transform 80ms}
    .deal-card:hover{box-shadow:0 0 0 2px rgba(230,76,30,.35),0 4px 6px -1px rgba(0,0,0,.08),0 2px 4px -1px rgba(0,0,0,.04);transform:translateY(-2px)}
    .deal-img-wrap{background:var(--bg);aspect-ratio:1;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .deal-img-wrap img{width:100%;height:100%;object-fit:contain}
    .deal-img-ph{width:100%;aspect-ratio:1;background:var(--bg)}
    .deal-body{padding:14px;display:flex;flex-direction:column;gap:6px;flex:1}
    .deal-title{font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:500}
    .deal-prices{display:flex;align-items:baseline;gap:8px;margin-top:2px}
    .deal-current{font-size:20px;font-weight:800}
    .deal-avg{font-size:13px;color:var(--text-xsoft);text-decoration:line-through}
    .deal-badge{display:inline-block;background:#ecfdf5;color:#065f46;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px}
    .deal-cta{font-size:13px;color:var(--brand);font-weight:600;margin-top:auto;padding-top:8px}
    .deals-empty{grid-column:1/-1;text-align:center;padding:80px 20px;color:var(--text-soft)}
    @media(max-width:600px){.deals-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}}
  </style>
</head>
<body>
<nav class="nav"><div class="container nav-inner">
  <a class="nav-logo" href="/">
    <svg viewBox="0 0 36 36" width="28" height="28"><rect width="36" height="36" rx="9" fill="#e64c1e"/><polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Bajó el Precio
  </a>
  <div class="nav-links">
    <a class="nav-link" href="/">Buscar</a>
    <a class="nav-link" href="/deals">Ofertas</a>
    <a class="nav-link cta" href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Telegram →</a>
  </div>
</div></nav>
<main><div class="container">
  <div class="deals-header">
    <div class="breadcrumb"><a href="/deals">Ofertas</a> › ${esc(catLabel)}</div>
    <div class="deals-count">${deals.length} productos verificados</div>
    <h1>🔥 Ofertas en ${esc(catLabel)}</h1>
    <p>Productos de MercadoLibre en precio mínimo verificado. Historial real, sin inflados.</p>
  </div>
  <div class="deals-grid">${cards}</div>
</div></main>
<footer style="padding:40px 0;border-top:1px solid var(--border)">
  <div class="container" style="font-size:12px;color:var(--text-soft)">
    Herramienta independiente. No afiliada a MercadoLibre S.A.
  </div>
</footer>
</body></html>`;

    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (e) {
    console.error("deals/:category error:", e.message);
    res.status(500).send("Error interno");
  }
});

// Página de pricing /premium
app.get("/premium", (_req, res) => {
  const html = `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Plan Pro | Bajó el Precio</title>
  <meta name="description" content="Activá alertas ilimitadas y notificaciones inmediatas con el Plan Pro de Bajó el Precio.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><rect width='36' height='36' rx='9' fill='%23e64c1e'/><polyline points='7,11 14,17 21,13 28,24' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:#f9fafb;color:#111827;line-height:1.5;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-decoration:none}
    .container{max-width:640px;margin:0 auto;padding:0 20px}
    .nav{background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:100}
    .nav-inner{display:flex;align-items:center;justify-content:space-between;height:60px}
    .nav-logo{font-weight:700;font-size:16px;display:flex;align-items:center;gap:10px}
    .hero{padding:64px 0 48px;text-align:center}
    .hero h1{font-size:clamp(28px,5vw,48px);font-weight:800;letter-spacing:-.02em;line-height:1.1;margin-bottom:16px}
    .hero p{font-size:18px;color:#6b7280;max-width:480px;margin:0 auto 32px}
    .plans{display:grid;gap:16px;margin-bottom:48px}
    .plan{background:#fff;border:2px solid #e5e7eb;border-radius:16px;padding:32px;text-align:center;transition:border-color 80ms}
    .plan.recommended{border-color:#e64c1e;position:relative}
    .plan-badge{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:#e64c1e;color:#fff;font-size:12px;font-weight:700;padding:4px 16px;border-radius:999px;white-space:nowrap}
    .plan-name{font-size:14px;font-weight:600;color:#6b7280;margin-bottom:8px}
    .plan-price{font-size:40px;font-weight:800;line-height:1}
    .plan-price span{font-size:16px;font-weight:500;color:#6b7280}
    .plan-features{list-style:none;margin:24px 0;text-align:left;display:flex;flex-direction:column;gap:10px}
    .plan-features li{display:flex;align-items:center;gap:10px;font-size:15px}
    .plan-features li::before{content:"✅";font-size:14px}
    .btn{display:block;width:100%;padding:14px;border-radius:12px;font-size:16px;font-weight:700;text-align:center;transition:background 80ms,transform 80ms;cursor:pointer}
    .btn:active{transform:scale(.98)}
    .btn-primary{background:#e64c1e;color:#fff}
    .btn-primary:hover{background:#c03d18}
    .btn-secondary{background:#f3f4f6;color:#111827}
    .btn-secondary:hover{background:#e5e7eb}
    .free-note{text-align:center;font-size:14px;color:#6b7280;margin-top:24px}
    .faq{padding-bottom:64px}
    .faq h2{font-size:24px;font-weight:800;margin-bottom:24px;text-align:center}
    .faq-item{margin-bottom:16px}
    .faq-q{font-weight:600;margin-bottom:4px}
    .faq-a{font-size:14px;color:#6b7280;line-height:1.6}
  </style>
</head>
<body>
<nav class="nav"><div class="container nav-inner">
  <a class="nav-logo" href="/">
    <svg viewBox="0 0 36 36" width="28" height="28"><rect width="36" height="36" rx="9" fill="#e64c1e"/><polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    Bajó el Precio
  </a>
  <a href="/" style="font-size:14px;font-weight:500;color:#6b7280">← Volver</a>
</div></nav>
<main><div class="container">
  <div class="hero">
    <h1>Comprar en el momento justo.<br>Sin perder una oferta.</h1>
    <p>El Plan Pro te da alertas ilimitadas y notificaciones inmediatas cuando el precio baja.</p>
  </div>
  <div class="plans">
    <div class="plan recommended">
      <div class="plan-badge">⭐ Más popular</div>
      <div class="plan-name">PRO MENSUAL</div>
      <div class="plan-price">$4.990 <span>ARS / mes</span></div>
      <ul class="plan-features">
        <li>Hasta 50 alertas de precio</li>
        <li>Notificaciones inmediatas por Telegram</li>
        <li>Acceso a todos los históricos</li>
        <li>Soporte prioritario</li>
      </ul>
      <a class="btn btn-primary" href="https://t.me/bajoelprecio_bot?start=premium">Activar en Telegram →</a>
    </div>
    <div class="plan">
      <div class="plan-name">GRATUITO</div>
      <div class="plan-price">$0 <span>para siempre</span></div>
      <ul class="plan-features">
        <li>3 alertas de precio</li>
        <li>Historial completo de precios</li>
        <li>Extensión de Chrome</li>
      </ul>
      <a class="btn btn-secondary" href="/">Usar gratis →</a>
    </div>
  </div>
  <p class="free-note">Pagá con cualquier tarjeta o saldo de MercadoPago. Cancelá cuando quieras.</p>
  <div class="faq">
    <h2>Preguntas frecuentes</h2>
    <div class="faq-item">
      <div class="faq-q">¿Cómo activo el plan?</div>
      <div class="faq-a">Escribile /premium al bot de Telegram. Te manda un link de pago de MercadoPago. Después del pago, se activa automáticamente en segundos.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">¿Qué diferencia hay entre "inmediata" y "batch"?</div>
      <div class="faq-a">En el plan free las notificaciones van en lotes cada hora. En Pro, el bot te avisa dentro de los primeros minutos de que el precio baje.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">¿Puedo cancelar?</div>
      <div class="faq-a">Sí. El plan es por período (30 días). No se renueva solo — si no pagás el siguiente mes, volvés automáticamente al plan gratis.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">¿Qué pasa con mis alertas si vuelvo al plan gratis?</div>
      <div class="faq-a">Se conservan hasta 3. Las demás quedan pausadas hasta que actives Premium nuevamente.</div>
    </div>
  </div>
</div></main>
</body></html>`;
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
});

app.get("/premium/gracias", (_req, res) => {
  res.redirect("https://t.me/bajoelprecio_bot");
});

// Trackear un producto — intenta la API primero (fast-path), Playwright si falla.
// Timeout de Express es 30s, así que hacemos todo lo posible en ese tiempo.
app.post("/api/track", async (req, res) => {
  const input = req.body?.url ?? req.query.url;
  if (!input) return res.status(400).json({ error: "falta 'url'" });
  try {
    // Race: si tarda más de 25s devolvemos un partial (el producto existe en DB, sin precio fresco)
    const result = await Promise.race([
      trackProduct(input),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 25_000)),
    ]);
    res.json(result);
  } catch (e) {
    if (e.message === "timeout") {
      // Devolvemos lo que haya en DB aunque sin el precio fresco
      const { resolveId } = await import("./service.js");
      const parsed = await resolveId(input);
      if (parsed) {
        const history = await getHistory(parsed.id);
        if (!history.error) return res.json({ ...history, stale: true });
      }
      return res.status(202).json({ error: "timeout", retry: true });
    }
    console.error("track error:", e.message);
    res.status(500).json({ error: "fallo interno" });
  }
});

// Historial de un producto ya trackeado.
app.get("/api/product/:id", async (req, res) => {
  res.json(await getHistory(req.params.id));
});

// Observación de la extensión: registra un punto de precio (leído de la página, sin scrapear).
app.post("/api/observe", async (req, res) => {
  const { id, price, title, image, url, category } = req.body ?? {};
  try {
    res.json(await observeProduct({ id, price: Number(price), title, image, url, category }));
  } catch (e) {
    console.error("observe error:", e.message);
    res.status(500).json({ error: "fallo" });
  }
});

// Alertas: el bot de Telegram registra/lista/borra suscripciones de baja de precio.
app.post("/api/alerts", async (req, res) => {
  try {
    res.json(await subscribeAlert(req.body ?? {}));
  } catch (e) {
    console.error("alert subscribe error:", e.message);
    res.status(500).json({ error: "fallo" });
  }
});
app.get("/api/alerts/:chatId", async (req, res) => {
  res.json(await listAlerts(req.params.chatId));
});
app.delete("/api/alerts", async (req, res) => {
  try {
    res.json(await unsubscribeAlert(req.body ?? {}));
  } catch (e) {
    res.status(500).json({ error: "fallo" });
  }
});

// Estado del plan de un usuario (para el bot/web: cuántas alertas usó, su tope).
app.get("/api/plan/:chatId", async (req, res) => {
  res.json(await getPlan(req.params.chatId));
});

// --- Admin (gated por ADMIN_TOKEN) -------------------------------------------
// Otorgar premium a un usuario (a futuro lo dispara el webhook de MercadoPago).
app.post("/api/premium", requireAdmin, async (req, res) => {
  const { chatId, days } = req.body ?? {};
  if (!chatId) return res.status(400).json({ error: "falta chatId" });
  const sub = await grantPremium(chatId, { days: days ? Number(days) : undefined });
  res.json({ ok: true, plan: sub.plan, premiumUntil: sub.premiumUntil });
});
// Crear una API key B2B.
app.post("/api/keys", requireAdmin, async (req, res) => {
  const { name, plan } = req.body ?? {};
  res.json(await createApiKey({ name, plan }));
});
// MercadoPago IPN: activa Premium cuando un pago es aprobado.
app.post("/webhooks/mp", mpWebhookHandler);
// Telegram bot webhook: /start, /mis_alertas, /borrar
app.post("/webhooks/telegram", telegramWebhookHandler);
// Importación masiva de productos desde otra instancia (migración local→prod).
// Body: { products: [{id, title, url, image, category, price}] }
app.post("/admin/import-products", requireAdmin, async (req, res) => {
  const { products } = req.body ?? {};
  if (!Array.isArray(products)) return res.status(400).json({ error: "esperaba {products:[]}" });
  let ok = 0, skip = 0;
  for (const p of products) {
    if (!p.id) continue;
    try {
      await prisma.product.upsert({
        where: { id: p.id },
        update: { ...(p.title && { title: p.title }), ...(p.image && { image: p.image }), ...(p.url && { url: p.url }), ...(p.category && { category: p.category }) },
        create: { id: p.id, title: p.title ?? "Producto", url: p.url ?? null, image: p.image ?? null, category: p.category ?? null },
      });
      if (p.price) {
        await prisma.pricePoint.create({ data: { productId: p.id, price: Number(p.price) } });
      }
      ok++;
    } catch { skip++; }
  }
  res.json({ ok: true, imported: ok, skipped: skip });
});
// Seed del catálogo con productos trending de ML (dispara en background).
app.post("/admin/seed-catalog", requireAdmin, async (_req, res) => {
  res.json({ ok: true, message: "seeding iniciado en background" });
  // Fire and forget — no esperamos el resultado para no timeout
  import("./seed-catalog.js").then(({ seedCatalog }) => seedCatalog()).catch(console.error);
});
// Dispara un ciclo del tracker en background (para debugging / forzar corrida).
app.post("/admin/run-tracker", requireAdmin, async (_req, res) => {
  res.json({ ok: true, message: "tracker iniciado en background" });
  import("./tracker.js").then(({ trackerCycle }) => trackerCycle()).catch(console.error);
});
// Debug: llama la API de ML (con token si está configurado) y devuelve el status HTTP.
// TEMP: sin auth de admin para diagnosticar desde producción.
app.get("/debug/ml-status", async (_req, res) => {
  const hasToken = !!(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET);
  const [itemResult, searchResult] = await Promise.all([
    import("./ml/api-client.js").then(({ fetchItem }) => fetchItem("MLA1499474404"))
      .then(d => ({ ok: true, price: d?.price ?? null }))
      .catch(e => ({ ok: false, error: e.message })),
    fetch("https://api.mercadolibre.com/sites/MLA/search?q=celular&limit=1&fields=results.id,results.price")
      .then(r => r.json())
      .then(d => ({ ok: true, status: 200, id: d?.results?.[0]?.id, price: d?.results?.[0]?.price }))
      .catch(e => ({ ok: false, error: e.message })),
  ]);
  res.json({ authenticated: hasToken, item_api: itemResult, search_api: searchResult });
});

// --- Developers landing page --------------------------------------------------
app.get("/developers", (req, res) => {
  const baseUrl = baseUrlOf(req);
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>API de Precios MercadoLibre | Bajó el Precio — Developers</title>
  <meta name="description" content="API de historial de precios de MercadoLibre para Argentina. 100 requests/día gratis. Plan Pro sin límite.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{--brand:#e64c1e;--brand-dark:#c03d18;--text:#111827;--text-soft:#6b7280;--bg:#f9fafb;--surface:#fff;--border:#e5e7eb;--radius:12px}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
    a{color:var(--brand);text-decoration:none}
    a:hover{text-decoration:underline}
    .container{max-width:860px;margin:0 auto;padding:0 20px}
    .nav{background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
    .nav-inner{display:flex;align-items:center;justify-content:space-between;height:60px}
    .nav-logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;color:var(--text);text-decoration:none}
    .nav-link{padding:7px 14px;border-radius:8px;font-size:14px;font-weight:500;color:var(--text-soft)}
    .nav-link:hover{text-decoration:none;background:var(--bg);color:var(--text)}
    .hero{padding:64px 0 48px}
    .hero h1{font-size:clamp(28px,5vw,48px);font-weight:800;letter-spacing:-.02em;margin-bottom:16px}
    .hero p{font-size:18px;color:var(--text-soft);max-width:600px;margin-bottom:32px}
    .pill{display:inline-block;background:#fff3ef;color:var(--brand);font-size:13px;font-weight:600;padding:4px 14px;border-radius:999px;margin-bottom:20px}
    .plans{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:48px 0}
    @media(max-width:600px){.plans{grid-template-columns:1fr}}
    .plan{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:28px}
    .plan.pro{border-color:var(--brand);background:#fff8f6}
    .plan h3{font-size:18px;font-weight:700;margin-bottom:6px}
    .plan .price{font-size:32px;font-weight:800;margin:12px 0 4px;color:var(--text)}
    .plan .price-sub{font-size:13px;color:var(--text-soft);margin-bottom:16px}
    .plan ul{list-style:none;font-size:14px;color:var(--text-soft);display:flex;flex-direction:column;gap:8px}
    .plan ul li::before{content:"✓ ";color:#059669;font-weight:700}
    .btn{display:inline-block;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none}
    .btn-brand{background:var(--brand);color:#fff;margin-top:20px}
    .btn-brand:hover{background:var(--brand-dark);text-decoration:none}
    .btn-ghost{border:1px solid var(--border);color:var(--text);margin-top:20px}
    .btn-ghost:hover{background:var(--bg);text-decoration:none}
    .section{margin:48px 0}
    .section h2{font-size:22px;font-weight:700;margin-bottom:16px}
    pre{background:#1e1e2e;color:#cdd6f4;border-radius:var(--radius);padding:20px;overflow-x:auto;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.6;margin:12px 0}
    code{font-family:'JetBrains Mono',monospace;font-size:13px;background:#f3f4f6;padding:2px 6px;border-radius:4px}
    .endpoint{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
    .method{display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;font-family:'JetBrains Mono',monospace}
    .endpoint h4{font-size:15px;font-weight:600;margin:8px 0 4px;font-family:'JetBrains Mono',monospace;color:var(--brand-dark)}
    .endpoint p{font-size:14px;color:var(--text-soft);margin-bottom:12px}
    footer{padding:40px 0;border-top:1px solid var(--border);text-align:center;font-size:13px;color:var(--text-soft);margin-top:48px}
  </style>
</head>
<body>
<nav class="nav">
  <div class="container nav-inner">
    <a class="nav-logo" href="/">
      <svg viewBox="0 0 36 36" width="28" height="28" aria-hidden="true"><rect width="36" height="36" rx="9" fill="#e64c1e"/><polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M28 24 L28 19 M28 24 L23 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Bajó el Precio
    </a>
    <a class="nav-link" href="/">← Volver</a>
  </div>
</nav>
<main>
<div class="container">
  <div class="hero">
    <div class="pill">API pública Beta</div>
    <h1>Historial de precios ML<br>en tu app</h1>
    <p>Accedé a series temporales reales de precios de MercadoLibre Argentina. Sin scraping, sin esperas. Datos acumulados desde 2025.</p>
  </div>

  <div class="plans">
    <div class="plan">
      <h3>Free</h3>
      <div class="price">$0</div>
      <div class="price-sub">para siempre</div>
      <ul>
        <li>100 requests / día</li>
        <li>Historial completo</li>
        <li>Stats: min / max / avg</li>
        <li>Sin tarjeta</li>
      </ul>
      <a class="btn btn-ghost" href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Conseguir API key gratis →</a>
    </div>
    <div class="plan pro">
      <h3>Pro</h3>
      <div class="price">$4.990 <span style="font-size:18px;font-weight:500">ARS</span></div>
      <div class="price-sub">/ mes · sin límite de requests</div>
      <ul>
        <li>Requests ilimitados</li>
        <li>Webhook de cambio de precio</li>
        <li>SLA de respuesta</li>
        <li>Soporte directo</li>
      </ul>
      <a class="btn btn-brand" href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Contactar para Pro →</a>
    </div>
  </div>

  <div class="section">
    <h2>Endpoints</h2>

    <div class="endpoint">
      <span class="method">GET</span>
      <h4>/v1/product/:id</h4>
      <p>Historial completo de un producto por su ID de MercadoLibre.</p>
      <pre>curl ${baseUrl}/v1/product/MLA47675165 \\
  -H "x-api-key: km_tu_api_key"</pre>
      <pre>{
  "id": "MLA47675165",
  "title": "Celular Moto G15 256gb 8ram",
  "stats": { "last": 399999, "min": 379000, "max": 449000, "avg": 412000, "count": 12 },
  "history": [
    { "price": 399999, "seenAt": "2025-07-08T22:37:45.000Z" },
    { "price": 410000, "seenAt": "2025-07-07T16:22:11.000Z" }
  ]
}</pre>
    </div>

    <div class="endpoint">
      <span class="method">GET</span>
      <h4>/v1/products</h4>
      <p>Lista de todos los productos rastreados (IDs + categoría + cantidad de datapoints).</p>
      <pre>curl ${baseUrl}/v1/products \\
  -H "x-api-key: km_tu_api_key"</pre>
    </div>
  </div>

  <div class="section">
    <h2>Autenticación</h2>
    <p>Enviá tu API key en el header <code>x-api-key</code> en cada request. También podés pasarla como query param: <code>?api_key=km_...</code></p>
    <p style="margin-top:12px">Para obtener tu key gratuita, enviá <code>/start</code> al bot de Telegram y pedísela.</p>
  </div>

  <div class="section">
    <h2>Rate limits</h2>
    <p>El plan gratuito tiene un límite de 100 requests por día (rolling 24h). Los headers de respuesta incluyen:</p>
    <pre>X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87</pre>
    <p style="margin-top:12px">Al superar el límite se devuelve <code>HTTP 429</code> con un JSON explicativo.</p>
  </div>
</div>
</main>
<footer>
  <div class="container">
    <a href="/">Bajó el Precio</a> · <a href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Telegram</a> · <a href="/deals">Deals</a>
    <div style="margin-top:8px">Datos de MercadoLibre Argentina. No afiliado con MercadoLibre S.A.</div>
  </div>
</footer>
</body>
</html>`);
});

// --- API pública B2B v1 (gated por x-api-key + cuota) ------------------------
app.get("/v1/product/:id", apiKeyMiddleware, async (req, res) => {
  const data = await getHistory(req.params.id);
  if (data.error) return res.status(404).json(data);
  res.json({ id: data.product.id, title: data.product.title, stats: data.stats, history: data.history });
});
app.get("/v1/products", apiKeyMiddleware, async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { prices: { some: {} } },
    select: { id: true, title: true, category: true, _count: { select: { prices: true } } },
    orderBy: { queries: "desc" },
    take: 500,
  });
  res.json(products.map((p) => ({ id: p.id, title: p.title, category: p.category, points: p._count.prices })));
});

// Comparación: busca el MÁS BARATO equivalente en ML, con filtros (como el bot de Telegram).
app.get("/api/compare/:id", async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id }, select: { title: true } });
  if (!product) return res.status(404).json({ error: "not_found" });
  const { mode = "estricto", condition = "nuevo", international = "0", view = "contado" } = req.query;
  try {
    const result = await findCheapestEquivalent(product.title, {
      mode,
      condition,
      international: international === "1" || international === "true",
    });
    const selected = pickByView(result.matches, view);
    res.json({
      query: result.query,
      count: result.matches.length,
      selected: selected
        ? { title: selected.title, price: selected.price, link: affiliateUrl(selected.link), cuotas: selected.cuotas, condition: selected.condition }
        : null,
    });
  } catch (e) {
    console.error("compare error:", e.message);
    res.status(500).json({ error: "fallo" });
  }
});

// Catálogo: productos (ya scrapeados) agrupados por categoría, con su precio actual. Para el home.
app.get("/api/catalog", async (_req, res) => {
  const products = await prisma.product.findMany({
    where: { prices: { some: {} } },
    select: {
      id: true,
      title: true,
      url: true,
      image: true,
      category: true,
      queries: true,
      prices: { orderBy: { seenAt: "asc" }, select: { price: true } },
    },
    orderBy: { queries: "desc" },
  });
  const byCat = {};
  for (const p of products) {
    const prices = p.prices.map((x) => x.price);
    const cat = p.category || "Otros";
    (byCat[cat] ??= []).push({
      id: p.id,
      title: p.title,
      url: affiliateUrl(p.url),
      image: p.image,
      queries: p.queries,
      price: prices.at(-1) ?? null,
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      spark: prices.slice(-24),
    });
  }
  res.json(byCat);
});

// Trending: los productos más buscados de las últimas 24h (para un carrusel de la landing).
app.get("/api/trending", async (_req, res) => {
  const oneDayAgo = new Date(Date.now() - 24 * 3_600_000);
  const products = await prisma.product.findMany({
    where: {
      prices: { some: { seenAt: { gte: oneDayAgo } } },
    },
    select: {
      id: true,
      title: true,
      image: true,
      category: true,
      queries: true,
      prices: {
        orderBy: { seenAt: "desc" },
        take: 2,
        select: { price: true, seenAt: true },
      },
      _count: { select: { alerts: true } },
    },
    orderBy: [{ alerts: { _count: "desc" } }, { queries: "desc" }],
    take: 20,
  });
  res.json(
    products.map((p) => ({
      id: p.id,
      title: p.title,
      image: p.image,
      category: p.category,
      price: p.prices[0]?.price ?? null,
      prevPrice: p.prices[1]?.price ?? null,
      alerts: p._count.alerts,
      queries: p.queries,
    }))
  );
});

// Lista de productos trackeados.
app.get("/api/products", async (_req, res) => {
  const products = await prisma.product.findMany({
    orderBy: { queries: "desc" },
    select: { id: true, title: true, queries: true, _count: { select: { prices: true } } },
    take: 100,
  });
  res.json(products);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`✅ API keepa-ml en http://localhost:${port}`);

  // Auto-tracker loop: corre en background cada TRACK_INTERVAL_HOURS horas.
  const hours = Number(process.env.TRACK_INTERVAL_HOURS) || 6;
  const intervalMs = hours * 3_600_000;

  let trackerRunning = false;
  const runTracker = () => {
    if (trackerRunning) { console.log("[tracker] ya corriendo, skip"); return; }
    trackerRunning = true;
    import("./tracker.js")
      .then(({ trackerCycle }) => trackerCycle())
      .catch((e) => console.error("[tracker] error:", e.message))
      .finally(() => { trackerRunning = false; });
  };

  // Primera corrida: espera 5min para que el server arranque limpio.
  setTimeout(() => {
    console.log(`[tracker] primera corrida programada en 5min, luego cada ${hours}h`);
    runTracker();
    setInterval(runTracker, intervalMs);
  }, 5 * 60_000);

  // Daily digest: postea los top 3 deals al canal a las 09:00 ART (12:00 UTC)
  const digestEnabled = process.env.ALERTS_ENABLED === "1" && process.env.TELEGRAM_CHANNEL;
  if (digestEnabled) {
    const scheduleDigest = () => {
      const now = new Date();
      const nextUTC12 = new Date(now);
      nextUTC12.setUTCHours(12, 0, 0, 0);
      if (nextUTC12 <= now) nextUTC12.setUTCDate(nextUTC12.getUTCDate() + 1);
      const msUntil = nextUTC12 - now;
      setTimeout(async () => {
        try {
          const deals = await fetchDeals();
          if (!deals.length) { scheduleDigest(); return; }
          const fmt = n => "$" + Math.round(n).toLocaleString("es-AR");
          const lines = deals.slice(0, 3).map((d, i) =>
            `${i + 1}. <b>${d.title.slice(0, 60)}</b>\n   ${fmt(d.current)} (-${d.savingPct}% vs promedio)\n   <a href="${process.env.PUBLIC_URL}/p/${d.id}">Ver historial</a>`
          );
          const text = `🔥 <b>Mejores ofertas del día</b>\n\n${lines.join("\n\n")}\n\n<a href="${process.env.PUBLIC_URL}/deals">Ver todas las ofertas →</a>`;
          await sendChannel(text).catch(e => console.warn("[digest]", e.message));
          console.log("[digest] enviado");
        } catch (e) {
          console.warn("[digest] error:", e.message);
        }
        scheduleDigest();
      }, msUntil);
      console.log(`[digest] próximo en ${Math.round(msUntil / 60_000)}min`);
    };
    scheduleDigest();
  }
});
