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

async function fetchDeals() {
  const products = await prisma.product.findMany({
    where: { prices: { some: {} } },
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
    deals.push({ id: p.id, title: p.title, image: p.image, url: p.url, current, min, avg: Math.round(avg), savingPct });
  }

  deals.sort((a, b) => b.savingPct - a.savingPct);
  return deals.slice(0, 50);
}

app.get("/api/deals", async (_req, res) => {
  try {
    const deals = await fetchDeals();
    res.json(deals.map((d) => ({ id: d.id, title: d.title, image: d.image, price: d.current, min: d.min, avg: d.avg, savingPct: d.savingPct, url: d.url })));
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
    .deal-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; transition: box-shadow 80ms, border-color 80ms, transform 80ms; }
    .deal-card:hover { box-shadow: var(--shadow-md); border-color: var(--brand); transform: translateY(-2px); }
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
});
