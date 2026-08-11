import { timingSafeEqual, randomInt, createHmac } from "node:crypto";
import compression from "compression";
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
import { NAV_CSS, buildNav } from "./nav.js";
import { THEME_CSS, THEME_HEAD_SCRIPT } from "./theme.js";
import { mpWebhookHandler } from "./mercadopago.js";
import { telegramWebhookHandler } from "./bot.js";
import { renderOgImage } from "./og-image.js";
import { renderIgImage } from "./ig-image.js";
import { prisma } from "./db.js";
import { sendChannel } from "./telegram.js";
import { tweetDeals } from "./twitter.js";
import { setCookies as setTwitterCookies } from "./twitter-store.js";
import { postDealsCarouselToInstagram } from "./instagram.js";
import { sendPriceDropEmail } from "./email.js";

const baseUrlOf = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
function requireAdmin(req, res, next) {
  const token = req.header("x-admin-token") ?? "";
  if (!ADMIN_TOKEN || token.length !== ADMIN_TOKEN.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return res.status(403).json({ error: "no autorizado" });
  }
  next();
}

// Session tokens: HMAC-SHA256(chatId, SESSION_SECRET) issued at link time.
// Stateless — no DB needed. Clients store the token and send it as x-chat-token.
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("[startup] FATAL: SESSION_SECRET no configurado — abortando");
    process.exit(1);
  } else {
    console.warn("[startup] SESSION_SECRET no configurado — usando fallback de desarrollo");
  }
}
const _sessionSecret = SESSION_SECRET || "dev-secret-change-me";
function signChatId(chatId) {
  return createHmac("sha256", _sessionSecret).update(String(chatId)).digest("hex");
}
function requireChatAuth(req, res, next) {
  const chatId = req.params.chatId ?? req.body?.chatId;
  const token = req.header("x-chat-token") ?? "";
  if (!chatId || !token) return res.status(401).json({ error: "sesión requerida" });
  const expected = signChatId(chatId);
  if (token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(403).json({ error: "token inválido" });
  }
  req.verifiedChatId = String(chatId);
  next();
}

// In-memory rate limiter — per-IP, sliding window. No external dependencies.
const _rateLimiters = new Map();
// Prune expired entries every 10 min to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateLimiters) if (now > v.reset) _rateLimiters.delete(k);
}, 10 * 60_000).unref();
function makeRateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const entry = _rateLimiters.get(key) ?? { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    _rateLimiters.set(key, entry);
    if (entry.count > max) return res.status(429).json({ error: "demasiadas solicitudes" });
    next();
  };
}

// 5-minute in-memory cache for expensive catalog queries.
const _cache = new Map();
function cached(key, ttlMs, fn) {
  const entry = _cache.get(key);
  if (entry && Date.now() < entry.exp) return Promise.resolve(entry.val);
  return fn().then(val => { _cache.set(key, { val, exp: Date.now() + ttlMs }); return val; });
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.set("trust proxy", 1); // Fly.io proxy — necesario para que req.ip sea la IP real del cliente
app.use(compression());
// Preservar rawBody para verificación de firma HMAC (MercadoPago webhook)
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); }
}));

// CORS: open for GET (public API + extension), restricted for user-auth endpoints.
// The real protection on user data is requireChatAuth (x-chat-token HMAC).
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-chat-token, x-admin-token");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Security headers — basic hardening without helmet dependency.
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.static(join(__dirname, "..", "public"), { maxAge: "1d", etag: true }));

// Consent banner + Meta Pixel — generado dinámicamente para inyectar META_PIXEL_ID desde env.
// Incluido en todas las páginas via <script src="/consent.js" defer></script>.
app.get("/consent.js", (_req, res) => {
  const pixelId = process.env.META_PIXEL_ID || "";
  res.set("Content-Type", "application/javascript; charset=utf-8");
  res.set("Cache-Control", "public, max-age=300"); // 5 min — cambia solo cuando deployás
  res.send(buildConsentScript(pixelId));
});

function buildConsentScript(pixelId) {
  return `(function(){
  var COOKIE='bep_consent';
  function gc(n){return(document.cookie.split('; ').find(function(r){return r.startsWith(n+'=');})||'').split('=')[1];}
  function sc(n,v,days){var d=new Date();d.setTime(d.getTime()+days*864e5);document.cookie=n+'='+v+';expires='+d.toUTCString()+';path=/;SameSite=Lax';}

  ${pixelId ? `
  var _pixelLoaded=false;
  function loadPixel(){
    if(_pixelLoaded)return; _pixelLoaded=true;
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init','${pixelId}');
    fbq('track','PageView');
  }
  window.bepPixelEvent=function(event,data){if(_pixelLoaded&&window.fbq)fbq('track',event,data||{});};
  ` : `window.bepPixelEvent=function(){};`}

  function hideBanner(){var b=document.getElementById('bep-consent');if(b)b.remove();}

  function accept(){sc(COOKIE,'analytics',365);hideBanner();${pixelId ? 'loadPixel();' : ''}}
  function decline(){sc(COOKIE,'essential',365);hideBanner();}

  function showBanner(){
    if(document.getElementById('bep-consent'))return;
    var el=document.createElement('div');
    el.id='bep-consent';
    el.innerHTML='<style>#bep-consent{position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#1a1a1a;color:#e5e7eb;font-family:system-ui,sans-serif;font-size:13px;padding:14px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;box-shadow:0 -2px 16px rgba(0,0,0,.35)}#bep-consent p{margin:0;flex:1;min-width:200px;line-height:1.5}#bep-consent p a{color:#e64c1e;text-decoration:underline}#bep-consent .bep-btns{display:flex;gap:8px;flex-shrink:0}#bep-consent button{border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer}#bep-consent .bep-ok{background:#e64c1e;color:#fff}#bep-consent .bep-ok:hover{background:#c03d18}#bep-consent .bep-no{background:rgba(255,255,255,.1);color:#e5e7eb}#bep-consent .bep-no:hover{background:rgba(255,255,255,.15)}</style>'
      +'<p>Usamos cookies de análisis para mejorar el sitio. <a href="/privacidad" target="_blank">Política de privacidad</a></p>'
      +'<div class="bep-btns"><button class="bep-ok" id="bep-ok">Aceptar</button><button class="bep-no" id="bep-no">Solo esenciales</button></div>';
    document.body.appendChild(el);
    document.getElementById('bep-ok').onclick=accept;
    document.getElementById('bep-no').onclick=decline;
  }

  var consent=gc(COOKIE);
  if(consent==='analytics'){${pixelId ? 'loadPixel();' : ''}}
  else if(!consent){document.addEventListener('DOMContentLoaded',function(){setTimeout(showBanner,1500);});}
})();`;
}

app.get("/api/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "keepa-ml", db: "ok" });
  } catch {
    res.status(503).json({ ok: false, service: "keepa-ml", db: "error" });
  }
});

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
app.get("/og/:id.png", makeRateLimit(20, 60_000), async (req, res) => {
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

// --- Imagen Instagram 1080x1080 cuadrada por producto -------------------------
// Formato cuadrado optimizado para feed de Instagram y carousel ads.
app.get("/og-ig/:id.png", makeRateLimit(20, 60_000), async (req, res) => {
  try {
    const png = await renderIgImage(req.params.id);
    if (!png) return res.status(404).send("no encontrado");
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(png);
  } catch (e) {
    console.error("ig-image error:", e.message);
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
    select: { id: true, title: true, image: true, prices: { orderBy: { seenAt: "desc" }, take: 1, select: { price: true } } },
    orderBy: { queries: "desc" },
    take: 8,
  });
  const related = relatedRaw.map((r) => ({ id: r.id, title: r.title, image: r.image, price: r.prices[0]?.price ?? null }));
  res.send(renderProductPage(data, { baseUrl, appUrl, related }));
});

app.get("/sitemap.xml", async (req, res) => {
  const [products, rawCats] = await Promise.all([
    prisma.product.findMany({
      where: { prices: { some: {} } },
      select: { id: true, lastScraped: true },
      orderBy: { lastScraped: "desc" },
    }),
    prisma.product.findMany({
      where: { prices: { some: {} }, category: { not: null } },
      select: { category: true },
      distinct: ["category"],
    }),
  ]);
  const categories = rawCats.map(r => r.category).filter(Boolean);
  res.set("Content-Type", "application/xml").send(renderSitemap(products, baseUrlOf(req), categories));
});

app.get("/robots.txt", (req, res) => {
  res.set("Content-Type", "text/plain").send(`User-agent: *\nAllow: /\n\nSitemap: ${baseUrlOf(req)}/sitemap.xml\n`);
});

app.get("/privacidad", (_req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Política de Privacidad | Bajó el Precio</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><rect width='36' height='36' rx='9' fill='%23e64c1e'/><polyline points='7,11 14,17 21,13 28,24' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#f9fafb;color:#111827;line-height:1.6;padding:40px 20px}
    .wrap{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:40px}
    h1{font-size:clamp(22px,4vw,32px);font-weight:800;margin-bottom:8px}
    .updated{font-size:13px;color:#6b7280;margin-bottom:32px}
    h2{font-size:17px;font-weight:700;margin:28px 0 8px}
    p{font-size:15px;color:#374151;margin-bottom:12px}
    a{color:#e64c1e}
    .back{display:inline-block;margin-top:32px;font-size:14px;color:#6b7280}
  </style>
</head>
<body>
<div class="wrap">
  <h1>Política de Privacidad</h1>
  <p class="updated">Última actualización: julio 2026</p>

  <h2>¿Qué datos recopilamos?</h2>
  <p>Cuando creás una alerta de precio a través de nuestro bot de Telegram, guardamos tu <strong>chat ID de Telegram</strong> (un número público que Telegram asigna a cada cuenta). Este ID es el único identificador que usamos para enviarte notificaciones.</p>
  <p>También registramos los <strong>IDs de productos de MercadoLibre</strong> que rastreás y los precios históricos observados.</p>
  <p>No recopilamos nombre, email, teléfono, ni ningún otro dato personal.</p>

  <h2>¿Para qué usamos estos datos?</h2>
  <p>Exclusivamente para enviarte notificaciones de Telegram cuando el precio de un producto que rastreás baja del umbral que configuraste.</p>

  <h2>¿Compartimos tus datos?</h2>
  <p>No. Los datos no se venden ni comparten con terceros. Son usados únicamente por este servicio para funcionar.</p>

  <h2>¿Cuánto tiempo los guardamos?</h2>
  <p>Mientras tengas alertas activas. Al borrar todas tus alertas, tu chat ID deja de estar asociado a ningún producto activo.</p>

  <h2>¿Cómo podés borrar tus datos?</h2>
  <p>Escribile <code>/borrar</code> al bot <a href="https://t.me/bajoelprecio_bot">@bajoelprecio_bot</a> para eliminar todas tus alertas. Alternativamente, podés contactarnos vía Telegram.</p>

  <h2>Cookies</h2>
  <p>Usamos dos tipos de cookies:</p>
  <p><strong>Esenciales:</strong> guardamos tu preferencia de tema (oscuro/claro) en <code>localStorage</code> y la cookie <code>bep_consent</code> para recordar tu elección de privacidad. Estas no pueden desactivarse.</p>
  <p><strong>De análisis (opcionales):</strong> si aceptás, instalamos el pixel de Meta (Facebook) para medir el alcance de nuestros anuncios y mejorar la experiencia. Esta cookie solo se activa con tu consentimiento y podés rechazarla o cambiar tu decisión.</p>
  <p>Para cambiar tu preferencia, limpiá las cookies del sitio desde la configuración de tu navegador.</p>

  <a class="back" href="/">← Volver al inicio</a>
</div>
</body></html>`);
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
      image: { not: null },
      title: { not: "(por scrapear)" },
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
    const min = prices.reduce((m, x) => x.price < m ? x.price : m, Infinity);
    const avg = prices.reduce((s, x) => s + x.price, 0) / prices.length;
    if (current > min * 1.08) continue;
    const savingPct = Math.round(((avg - current) / avg) * 100);
    deals.push({ id: p.id, title: p.title, image: p.image, url: affiliateUrl(p.url) || p.url, category: p.category, current, min, avg: Math.round(avg), savingPct });
  }

  deals.sort((a, b) => b.savingPct - a.savingPct);
  return deals.slice(0, 50);
}

app.get("/api/deals", makeRateLimit(60, 60_000), async (req, res) => {
  try {
    const category = req.query.category || null;
    const take = Math.min(50, Math.max(1, parseInt(req.query.take) || 50));
    const deals = await cached(`deals:${category ?? "all"}`, 5 * 60_000, () => fetchDeals({ category }));
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json(deals.slice(0, take).map((d) => ({ id: d.id, title: d.title, image: d.image, price: d.current, min: d.min, avg: d.avg, savingPct: d.savingPct, url: d.url, category: d.category })));
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

    const PAGE_SIZE = 24;
    const makeCard = (d) => `
        <a class="deal-card" href="/p/${esc(d.id)}">
          <div class="deal-img-wrap">
            ${d.image ? `<img src="${esc(d.image)}" alt="${esc(d.title)}" loading="lazy">` : `<div class="deal-img-ph"></div>`}
            <div class="saving-badge">−${d.savingPct}% vs prom.</div>
          </div>
          <div class="deal-body">
            <div class="deal-title">${esc(d.title)}</div>
            <div class="deal-price">${fmt(d.current)}</div>
            <div class="deal-was">Promedio: <span>${fmt(d.avg)}</span></div>
            <div class="deal-cta">Ver historial →</div>
          </div>
        </a>`;
    const firstBatch = deals.slice(0, PAGE_SIZE);
    const moreBatch = deals.slice(PAGE_SIZE);
    const cards = firstBatch.length
      ? firstBatch.map(makeCard).join("")
      : `<div class="deals-empty">
          <p>Por ahora no hay productos en precio mínimo verificado.</p>
          <p>El tracker actualiza continuamente — volvé en unas horas.</p>
        </div>`;
    const moreJson = moreBatch.length
      ? JSON.stringify(moreBatch.map(d => ({ id: d.id, title: d.title, image: d.image || "", price: d.current, avg: d.avg, savingPct: d.savingPct }))).replace(/<\//g, "<\\/")
      : null;

    // Extract unique categories for filter pills
    const cats = [...new Set(deals.map(d => d.category).filter(Boolean))].sort();

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
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  ${THEME_HEAD_SCRIPT}
  <style>
    :root {
      --brand:#e64c1e; --brand-dark:#c03d18; --brand-bg:#fff3ef; --brand-light:#fde8e0;
      --text:#111827; --text-soft:#6b7280; --text-xsoft:#9ca3af;
      --bg:#f9fafb; --surface:#ffffff; --border:#e5e7eb;
      --green:#16a34a; --green-bg:#dcfce7;
      --radius:12px; --radius-lg:16px;
      --shadow-md:0 4px 6px -1px rgba(0,0,0,.08),0 2px 4px -1px rgba(0,0,0,.04);
      --shadow-lg:0 10px 24px rgba(0,0,0,.10),0 4px 8px rgba(0,0,0,.06);
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html{scroll-behavior:smooth}
    body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
    a{color:inherit;text-decoration:none}
    img{max-width:100%;display:block}
    .container{max-width:1100px;margin:0 auto;padding:0 24px}
    ${NAV_CSS}
    .page-hero{padding:56px 0 40px;background:linear-gradient(180deg,#fff8f6 0%,var(--bg) 100%)}
    .hero-badge{display:inline-flex;align-items:center;gap:7px;background:var(--brand-bg);color:var(--brand);font-size:12.5px;font-weight:600;padding:5px 13px;border-radius:999px;margin-bottom:18px;border:1px solid rgba(230,76,30,.2)}
    .badge-dot{width:7px;height:7px;background:var(--brand);border-radius:50%;display:inline-block;box-shadow:0 0 0 2px rgba(230,76,30,.3)}
    .page-hero h1{font-size:clamp(28px,5vw,48px);font-weight:900;letter-spacing:-.03em;margin-bottom:12px;line-height:1.1}
    .page-hero p{font-size:16px;color:var(--text-soft);max-width:540px;line-height:1.65}
    .cat-strip{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px}
    .cat-pill{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background:var(--surface);border:1px solid var(--border);border-radius:999px;font-size:13px;font-weight:600;color:var(--text);transition:background 80ms,border-color 80ms,color 80ms;white-space:nowrap}
    .cat-pill:hover,.cat-pill.active{background:var(--brand-bg);border-color:var(--brand);color:var(--brand)}
    .deals-body{padding:40px 0 72px}
    .deals-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
    .deal-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;display:flex;flex-direction:column;transition:box-shadow 120ms,transform 120ms,border-color 120ms}
    .deal-card:hover{box-shadow:var(--shadow-lg);transform:translateY(-3px);border-color:rgba(230,76,30,.25)}
    .deal-img-wrap{aspect-ratio:1;background:var(--bg);overflow:hidden;position:relative}
    .deal-img-wrap img{width:100%;height:100%;object-fit:contain}
    .deal-img-ph{aspect-ratio:1;background:var(--bg)}
    .saving-badge{position:absolute;top:10px;left:10px;background:var(--green);color:#fff;font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:999px;box-shadow:0 2px 6px rgba(22,163,74,.3)}
    .deal-body{padding:14px 16px 16px;display:flex;flex-direction:column;flex:1}
    .deal-title{font-size:13px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:500;margin-bottom:8px;min-height:38px}
    .deal-price{font-size:22px;font-weight:900;letter-spacing:-.02em;margin-bottom:3px}
    .deal-was{font-size:12px;color:var(--text-xsoft)}
    .deal-was span{text-decoration:line-through}
    .deal-cta{margin-top:auto;padding-top:10px;font-size:12.5px;font-weight:600;color:var(--brand)}
    .deals-empty{grid-column:1/-1;text-align:center;padding:80px 20px;color:var(--text-soft)}
    .deals-empty p{font-size:16px;margin-bottom:8px}
    .load-more-wrap{text-align:center;padding:32px 0 56px}
    .load-more-btn{background:var(--surface);border:2px solid var(--border);color:var(--text);font-size:14px;font-weight:600;padding:12px 32px;border-radius:999px;cursor:pointer;transition:border-color 80ms,color 80ms,background 80ms;font-family:inherit}
    .load-more-btn:hover{border-color:var(--brand);color:var(--brand);background:var(--brand-bg)}
    .load-more-btn:disabled{opacity:.5;cursor:default;pointer-events:none}
    footer{padding:40px 0;border-top:1px solid var(--border);background:var(--surface)}
    .footer-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .footer-logo{font-size:15px;font-weight:800;color:var(--text);display:flex;align-items:center;gap:8px;letter-spacing:-.01em}
    .footer-links{display:flex;gap:20px;flex-wrap:wrap}
    .footer-links a{font-size:13px;color:var(--text-soft)}
    .footer-links a:hover{color:var(--text)}
    .footer-copy{font-size:12px;color:var(--text-xsoft);margin-top:12px}
    @media(max-width:600px){
      .page-hero{padding:40px 0 24px}
      .page-hero h1{font-size:clamp(24px,6vw,38px)}
      .page-hero p{font-size:15px}
      .cat-strip{gap:6px;margin-top:20px}
      .cat-pill{padding:6px 11px;font-size:12px}
      .deals-body{padding:24px 0 48px}
      .deals-grid{grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px}
      .deal-body{padding:10px 12px 12px}
      .deal-price{font-size:18px}
      .deals-empty{padding:48px 16px}
      footer{padding:24px 0}
      .footer-inner{flex-direction:column;align-items:flex-start;gap:10px}
      .footer-links{gap:12px}
    }
    ${THEME_CSS}
  </style>
</head>
<body>
${buildNav({ active: "deals" })}

<div class="page-hero">
  <div class="container">
    <div class="hero-badge">
      <span class="badge-dot"></span>
      ${deals.length} producto${deals.length !== 1 ? "s" : ""} verificado${deals.length !== 1 ? "s" : ""} ahora
    </div>
    <h1>🔥 Ofertas reales en MercadoLibre</h1>
    <p>Solo aparecen productos cuyo precio actual está dentro del 8% de su mínimo histórico verificado. Sin inflados, sin especulación.</p>
    ${cats.length > 1 ? `<nav class="cat-strip" aria-label="Filtrar por categoría">
      <a class="cat-pill active" href="/deals">Todas</a>
      ${cats.map(c => `<a class="cat-pill" href="/deals/${esc(encodeURIComponent(c.toLowerCase()))}">${esc(c)}</a>`).join("")}
    </nav>` : ""}
  </div>
</div>

<main class="deals-body">
  <div class="container">
    <div class="deals-grid" id="deals-grid">
      ${cards}
    </div>
    ${moreJson ? `
    <script type="application/json" id="__more">${moreJson}</script>
    <div class="load-more-wrap" id="__lm_wrap">
      <button class="load-more-btn" id="__lm_btn">Cargar ${moreBatch.length} productos más</button>
    </div>
    <script>
    (function(){
      var btn=document.getElementById('__lm_btn'),grid=document.getElementById('deals-grid');
      btn.onclick=function(){
        btn.disabled=true;btn.textContent='Cargando…';
        var data=JSON.parse(document.getElementById('__more').textContent);
        function e(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
        function f(n){return '$'+Math.round(n).toLocaleString('es-AR');}
        grid.insertAdjacentHTML('beforeend',data.map(function(d){return(
          '<a class="deal-card" href="/p/'+e(d.id)+'">'
          +'<div class="deal-img-wrap">'
          +(d.image?'<img src="'+e(d.image)+'" alt="'+e(d.title)+'" loading="lazy">':'<div class="deal-img-ph"></div>')
          +'<div class="saving-badge">−'+d.savingPct+'% vs prom.</div>'
          +'</div><div class="deal-body">'
          +'<div class="deal-title">'+e(d.title)+'</div>'
          +'<div class="deal-price">'+f(d.price)+'</div>'
          +'<div class="deal-was">Promedio: <span>'+f(d.avg)+'</span></div>'
          +'<div class="deal-cta">Ver historial →</div>'
          +'</div></a>'
        );}).join(''));
        document.getElementById('__lm_wrap').remove();
        document.getElementById('__more').remove();
      };
    })();
    </script>` : ""}
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
        <a href="/deals">Ofertas</a>
        <a href="/dashboard">Mis alertas</a>
        <a href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Bot Telegram</a>
        <a href="/privacidad">Privacidad</a>
      </div>
    </div>
    <p class="footer-copy">Herramienta independiente. No afiliada a MercadoLibre S.A. · Datos con fines informativos.</p>
  </div>
</footer>
<script src="/theme.js"></script>
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

    const CAT_PAGE_SIZE = 24;
    const makeCatCard = (d) => `
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
        </a>`;
    const catFirst = deals.slice(0, CAT_PAGE_SIZE);
    const catMore = deals.slice(CAT_PAGE_SIZE);
    const cards = catFirst.length
      ? catFirst.map(makeCatCard).join("")
      : `<div class="deals-empty">
          <p>No hay ofertas verificadas en ${esc(catLabel)} por ahora.</p>
          <p>El tracker actualiza continuamente — volvé en unas horas.</p>
        </div>`;
    const catMoreJson = catMore.length
      ? JSON.stringify(catMore.map(d => ({ id: d.id, title: d.title, image: d.image || "", price: d.current, avg: d.avg, savingPct: d.savingPct }))).replace(/<\//g, "<\\/")
      : null;

    const html = `<!DOCTYPE html>
<html lang="es-AR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ofertas en ${esc(catLabel)} — MercadoLibre | Bajó el Precio</title>
  <meta name="description" content="Los mejores precios verificados en ${esc(catLabel)} de MercadoLibre Argentina. Historial real, sin inflados.">
  <link rel="canonical" href="${esc(baseUrl)}/deals/${esc(catParam)}">
  <meta property="og:title" content="Ofertas en ${esc(catLabel)} | Bajó el Precio">
  <meta property="og:description" content="Los mejores precios verificados en ${esc(catLabel)} de MercadoLibre Argentina. Historial real, sin inflados.">
  <meta property="og:url" content="${esc(baseUrl)}/deals/${esc(catParam)}">
  <meta property="og:type" content="website">
  ${deals[0]?.image ? `<meta property="og:image" content="${esc(deals[0].image)}">` : ""}
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 36 36'><rect width='36' height='36' rx='9' fill='%23e64c1e'/><polyline points='7,11 14,17 21,13 28,24' fill='none' stroke='%23fff' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  ${THEME_HEAD_SCRIPT}
  <style>
    :root { --brand:#e64c1e;--brand-dark:#c03d18;--brand-bg:#fff3ef;--text:#111827;--text-soft:#6b7280;--text-xsoft:#9ca3af;--bg:#f9fafb;--surface:#ffffff;--border:#e5e7eb;--radius:12px;--shadow:0 1px 3px rgba(0,0,0,.08);--shadow-md:0 4px 6px -1px rgba(0,0,0,.08); }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
    a{color:inherit;text-decoration:none}img{max-width:100%;display:block}
    .container{max-width:1100px;margin:0 auto;padding:0 20px}
    ${NAV_CSS}
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
    .load-more-wrap{text-align:center;padding:24px 0 48px}
    .load-more-btn{background:var(--surface);border:2px solid var(--border);color:var(--text);font-size:14px;font-weight:600;padding:12px 32px;border-radius:999px;cursor:pointer;transition:border-color 80ms,color 80ms,background 80ms;font-family:inherit}
    .load-more-btn:hover{border-color:var(--brand);color:var(--brand);background:var(--brand-bg)}
    .load-more-btn:disabled{opacity:.5;cursor:default;pointer-events:none}
    @media(max-width:600px){
      .deals-header{padding:32px 0 20px}
      .deals-header h1{font-size:clamp(22px,6vw,36px)}
      .deals-header p{font-size:15px}
      .deals-grid{grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:10px;padding-bottom:40px}
      .deal-body{padding:10px 12px 12px}
      .deal-prices{flex-wrap:wrap;gap:4px}
      .deal-current{font-size:17px}
    }
    ${THEME_CSS}
  </style>
</head>
<body>
${buildNav({ active: "deals" })}
<main><div class="container">
  <div class="deals-header">
    <div class="breadcrumb"><a href="/deals">Ofertas</a> › ${esc(catLabel)}</div>
    <div class="deals-count">${deals.length} productos verificados</div>
    <h1>🔥 Ofertas en ${esc(catLabel)}</h1>
    <p>Productos de MercadoLibre en precio mínimo verificado. Historial real, sin inflados.</p>
  </div>
  <div class="deals-grid" id="deals-grid">${cards}</div>
  ${catMoreJson ? `
  <script type="application/json" id="__more">${catMoreJson}</script>
  <div class="load-more-wrap" id="__lm_wrap">
    <button class="load-more-btn" id="__lm_btn">Cargar ${catMore.length} productos más</button>
  </div>
  <script>
  (function(){
    var btn=document.getElementById('__lm_btn'),grid=document.getElementById('deals-grid');
    btn.onclick=function(){
      btn.disabled=true;btn.textContent='Cargando…';
      var data=JSON.parse(document.getElementById('__more').textContent);
      function e(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
      function f(n){return '$'+Math.round(n).toLocaleString('es-AR');}
      grid.insertAdjacentHTML('beforeend',data.map(function(d){return(
        '<a class="deal-card" href="/p/'+e(d.id)+'">'
        +'<div class="deal-img-wrap">'
        +(d.image?'<img src="'+e(d.image)+'" alt="'+e(d.title)+'" loading="lazy">':'<div class="deal-img-ph"></div>')
        +'</div><div class="deal-body">'
        +'<div class="deal-title">'+e(d.title)+'</div>'
        +'<div class="deal-prices"><span class="deal-current">'+f(d.price)+'</span><span class="deal-avg">'+f(d.avg)+'</span></div>'
        +'<div class="deal-badge">−'+d.savingPct+'% vs promedio</div>'
        +'<div class="deal-cta">Ver historial →</div>'
        +'</div></a>'
      );}).join(''));
      document.getElementById('__lm_wrap').remove();
      document.getElementById('__more').remove();
    };
  })();
  </script>` : ""}
</div></main>
<footer style="padding:40px 0;border-top:1px solid var(--border)">
  <div class="container" style="font-size:12px;color:var(--text-soft)">
    Herramienta independiente. No afiliada a MercadoLibre S.A.
  </div>
</footer>
<script src="/theme.js"></script>
</body></html>`;

    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (e) {
    console.error("deals/:category error:", e.message);
    res.status(500).send("Error interno");
  }
});

// Página de pricing /premium — temporalmente deshabilitada hasta configurar MP
app.get("/premium", (_req, res) => res.redirect("/"));
app.get("/premium/_disabled", (_req, res) => {
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
  ${THEME_HEAD_SCRIPT}
  <style>
    :root{--brand:#e64c1e;--brand-dark:#c03d18;--brand-bg:#fff3ef;--text:#111827;--text-soft:#6b7280;--text-xsoft:#9ca3af;--bg:#f9fafb;--surface:#fff;--border:#e5e7eb;--radius:12px;--radius-lg:16px;--shadow-md:0 4px 6px -1px rgba(0,0,0,.08)}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-decoration:none}
    .container{max-width:640px;margin:0 auto;padding:0 20px}
    ${NAV_CSS}
    .hero{padding:64px 0 48px;text-align:center}
    .hero h1{font-size:clamp(28px,5vw,48px);font-weight:800;letter-spacing:-.02em;line-height:1.1;margin-bottom:16px}
    .hero p{font-size:18px;color:#6b7280;max-width:480px;margin:0 auto 32px}
    .plans{display:grid;gap:16px;margin-bottom:48px}
    .plan{background:#fff;border:2px solid #e5e7eb;border-radius:16px;padding:32px;text-align:center;transition:border-color 80ms}
    .plan.recommended{border-color:#e64c1e;position:relative}
    .plan-badge{position:absolute;top:-13px;left:50%;transform:translateX(-50%);background:#e64c1e;color:#fff;font-size:12px;font-weight:700;padding:4px 16px;border-radius:999px;white-space:nowrap}
    .plan-name{font-size:14px;font-weight:600;color:#6b7280;margin-bottom:8px}
    .plan-price{font-size:clamp(28px,8vw,40px);font-weight:800;line-height:1}
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
    @media(max-width:600px){
      .hero{padding:40px 0 32px}
      .hero h1{font-size:clamp(24px,6vw,36px);line-height:1.15}
      .hero p{font-size:16px}
      .plan{padding:20px}
      .faq{padding-bottom:40px}
      .faq h2{font-size:20px}
    }
    ${THEME_CSS}
  </style>
</head>
<body>
${buildNav({ active: null })}
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
<script src="/theme.js"></script>
</body></html>`;
  res.set("Content-Type", "text/html; charset=utf-8").send(html);
});

app.get("/premium/gracias", (_req, res) => {
  res.redirect("https://t.me/bajoelprecio_bot");
});

// Trackear un producto — intenta la API primero (fast-path), Playwright si falla.
// Timeout de Express es 30s, así que hacemos todo lo posible en ese tiempo.
app.post("/api/track", makeRateLimit(10, 60_000), async (req, res) => {
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
app.get("/api/product/:id", makeRateLimit(60, 60_000), async (req, res) => {
  res.json(await getHistory(req.params.id));
});

const ML_ID_RE = /^MLAU?[A-Z0-9]{4,}$/i;
const ML_URL_RE = /^https?:\/\/([a-z0-9-]+\.)?mercadolibre\.com(\.ar|\.com\.mx|\.com\.co|\.com\.br)?\//i;
const ML_IMAGE_RE = /^https?:\/\/([a-z0-9-]+\.)?mlstatic\.com\//i;

// Observación de la extensión: registra un punto de precio (leído de la página, sin scrapear).
app.post("/api/observe", makeRateLimit(30, 60_000), async (req, res) => {
  const { id, price, title, image, url, category } = req.body ?? {};
  if (!id || !ML_ID_RE.test(String(id))) return res.status(400).json({ error: "id inválido" });
  const parsedPrice = Number(price);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) return res.status(400).json({ error: "precio inválido" });
  if (url && !ML_URL_RE.test(String(url))) return res.status(400).json({ error: "url inválida" });
  if (image && !ML_IMAGE_RE.test(String(image))) return res.status(400).json({ error: "imagen inválida" });
  const safeTitle = title != null ? String(title).slice(0, 200) : undefined;
  const safeCategory = category != null ? String(category).slice(0, 100) : undefined;
  try {
    res.json(await observeProduct({ id, price: parsedPrice, title: safeTitle, image: image || undefined, url: url || undefined, category: safeCategory }));
  } catch (e) {
    console.error("observe error:", e.message);
    res.status(500).json({ error: "fallo" });
  }
});

// Alertas: requiere auth para evitar que un atacante agote el límite de alertas de otro usuario.
app.post("/api/alerts", makeRateLimit(30, 60_000), requireChatAuth, async (req, res) => {
  try {
    res.json(await subscribeAlert(req.body ?? {}));
  } catch (e) {
    console.error("alert subscribe error:", e.message);
    res.status(500).json({ error: "fallo" });
  }
});
app.get("/api/alerts/:chatId", makeRateLimit(30, 60_000), requireChatAuth, async (req, res) => {
  res.json(await listAlerts(req.params.chatId));
});
app.delete("/api/alerts", makeRateLimit(20, 60_000), requireChatAuth, async (req, res) => {
  const { alertId, productId } = req.body ?? {};
  if (alertId !== undefined) {
    const parsed = parseInt(alertId, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return res.status(400).json({ error: "alertId inválido" });
  }
  try {
    res.json(await unsubscribeAlert({ chatId: req.verifiedChatId, alertId, productId }));
  } catch (e) {
    res.status(500).json({ error: "fallo" });
  }
});

// Email alert: captura email de usuarios sin Telegram para notificarlos cuando baje el precio.
app.post("/api/email-alert", makeRateLimit(5, 60_000), async (req, res) => {
  const { email, productId, targetPrice } = req.body ?? {};
  if (!email || !productId) return res.status(400).json({ error: "falta email o productId" });
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) return res.status(400).json({ error: "email inválido" });
  const tp = targetPrice != null ? parseInt(targetPrice, 10) : null;
  if (tp !== null && (!Number.isFinite(tp) || tp <= 0)) return res.status(400).json({ error: "targetPrice inválido" });
  try {
    await prisma.emailAlert.upsert({
      where: { email_productId: { email: email.toLowerCase(), productId } },
      update: { targetPrice: tp },
      create: { email: email.toLowerCase(), productId, targetPrice: tp },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("email-alert error:", e.message);
    res.status(500).json({ error: "fallo" });
  }
});

// Telegram linking: genera un código de 6 dígitos válido 5 min.
// El modal web lo muestra; el usuario lo manda al bot para vincular su chatId.
app.post("/api/link-code", makeRateLimit(10, 60_000), async (req, res) => {
  try {
    const code = String(randomInt(100000, 1000000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.linkingCode.upsert({
      where: { code },
      update: { chatId: null, expiresAt },
      create: { code, expiresAt },
    });
    // Limpiar expirados (best-effort, no bloquea la respuesta)
    prisma.linkingCode.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
    res.json({ code });
  } catch {
    res.status(500).json({ error: "fallo" });
  }
});

// Polling del modal: cuando el bot confirme el código, devuelve el chatId y borra el registro.
// Rate limit estricto: el código es de 6 dígitos (~900k combinaciones) — sin límite sería brute-forceable.
app.get("/api/link-status/:code", makeRateLimit(10, 60_000), async (req, res) => {
  try {
    const { code } = req.params;
    // Atomic: check + delete in one transaction to avoid double-confirm race.
    const row = await prisma.$transaction(async (tx) => {
      const r = await tx.linkingCode.findUnique({ where: { code } });
      if (!r || r.expiresAt < new Date() || !r.chatId) return r ?? null;
      await tx.linkingCode.delete({ where: { code } });
      return r;
    });
    if (!row || row.expiresAt < new Date()) return res.status(404).json({ linked: false });
    if (!row.chatId) return res.json({ linked: false });
    res.json({ linked: true, chatId: row.chatId, token: signChatId(row.chatId) });
  } catch {
    res.status(500).json({ error: "fallo" });
  }
});

// Estado del plan de un usuario (para el bot/web: cuántas alertas usó, su tope).
app.get("/api/plan/:chatId", makeRateLimit(30, 60_000), requireChatAuth, async (req, res) => {
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
// Seed del catálogo vía highlights API (funciona desde cloud IPs con Bearer token).
app.post("/admin/seed-catalog", requireAdmin, async (_req, res) => {
  res.json({ ok: true, message: "seed-products iniciado en background" });
  import("./seed-products.js")
    .then(({ seedProducts }) => seedProducts())
    .then(() => import("./enrich-images.js").then(({ enrichImages }) => enrichImages()))
    .catch(console.error);
});
// Dispara un ciclo del tracker en background (para debugging / forzar corrida).
app.post("/admin/run-tracker", requireAdmin, async (_req, res) => {
  res.json({ ok: true, message: "tracker iniciado en background" });
  import("./tracker.js").then(({ trackerCycle }) => trackerCycle()).catch(console.error);
});
// Enriquece imágenes faltantes en background (fallback de 5 niveles por producto).
app.post("/admin/enrich-images", requireAdmin, async (_req, res) => {
  res.json({ ok: true, message: "enrich-images iniciado en background" });
  import("./enrich-images.js").then(({ enrichImages }) => enrichImages()).catch(console.error);
});

app.post("/admin/recategorize", requireAdmin, async (_req, res) => {
  res.json({ ok: true, message: "recategorize iniciado en background" });
  import("./recategorize.js").then(({ recategorize }) => recategorize()).catch(console.error);
});
// --- OAuth bootstrap: ML dejo de aceptar client_credentials para LEER (highlights/search).
// Login de una sola vez para conseguir un refresh_token; despues se rota solo. El token
// de admin va por query (?token=) porque esto lo abrís a mano en el navegador, no por header.
app.get("/admin/ml-oauth/start", (req, res) => {
  const token = String(req.query.token ?? "");
  if (!ADMIN_TOKEN || token.length !== ADMIN_TOKEN.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return res.status(403).send("no autorizado");
  }
  const redirectUri = `${baseUrlOf(req)}/admin/ml-oauth/callback`;
  const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${process.env.ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(authUrl);
});
app.get("/admin/ml-oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send(`falta ?code (query recibida: ${JSON.stringify(req.query)})`);
  const redirectUri = `${baseUrlOf(req)}/admin/ml-oauth/callback`;
  try {
    const r = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: process.env.ML_CLIENT_ID,
        client_secret: process.env.ML_CLIENT_SECRET,
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);
    res.send(`<pre>Listo. Pegá esto en cazaofertas/.env como ML_REFRESH_TOKEN (reemplazando la linea vacia):

ML_REFRESH_TOKEN=${data.refresh_token}

(usuario ML autorizado: ${data.user_id})</pre>`);
  } catch (e) {
    res.status(500).send(`error: ${e.message}`);
  }
});
// Dispara el digest social manualmente (útil para probar las credenciales antes del primer post automático).
// Postea a Twitter/X e Instagram con los deals actuales.
app.post("/admin/post-social", requireAdmin, async (_req, res) => {
  try {
    const deals = await fetchDeals();
    if (!deals.length) return res.json({ ok: false, message: "sin deals disponibles" });
    const [twitterResult, igResult] = await Promise.allSettled([
      tweetDeals(deals.slice(0, 3)),
      postDealsCarouselToInstagram(deals.slice(0, 5)),
    ]);
    res.json({
      ok: true,
      deals: deals.length,
      twitter: twitterResult.status === "fulfilled" ? "ok" : twitterResult.reason?.message,
      instagram: igResult.status === "fulfilled" ? "ok" : igResult.reason?.message,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Debug: devuelve estado de la sesión de Twitter en producción.
app.get("/admin/twitter-debug", requireAdmin, async (_req, res) => {
  let page;
  try {
    const { getContext } = await import("./ml/price-reader.js");
    const ctx = await getContext();
    const cookies = await ctx.cookies(["https://x.com", "https://twitter.com"]);
    const authCookies = cookies.filter(c => ["auth_token", "ct0", "twid"].includes(c.name))
      .map(c => ({ name: c.name, value: c.value.slice(0, 16) + "...", domain: c.domain }));
    page = await ctx.newPage();
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, 6000));
    const url = page.url();
    const title = await page.title();
    const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    const hasAccountBtn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible({ timeout: 3000 }).catch(() => false);
    const hasHomeLink = await page.locator('[data-testid="AppTabBar_Home_Link"]').isVisible({ timeout: 3000 }).catch(() => false);
    const hasTweetBtn = await page.locator('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]').isVisible({ timeout: 3000 }).catch(() => false);
    const snippet = bodyText.slice(0, 300).replace(/\n/g, " ");
    res.json({ url, title, hasAccountBtn, hasHomeLink, hasTweetBtn, authCookies, snippet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await page?.close();
  }
});
// Postea solo a Twitter/X (testing individual).
app.post("/admin/post-twitter", requireAdmin, async (_req, res) => {
  try {
    const deals = await fetchDeals();
    if (!deals.length) return res.json({ ok: false, message: "sin deals" });
    await tweetDeals(deals.slice(0, 3));
    res.json({ ok: true, deal: deals[0].title });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Postea a Instagram con los top deals del día (o con IDs específicos).
// Body opcional: { productIds: ["MLA123", "MLA456"] } para forzar productos específicos.
app.post("/admin/post-instagram", requireAdmin, async (req, res) => {
  try {
    let deals;
    const { productIds } = req.body ?? {};
    if (Array.isArray(productIds) && productIds.length) {
      const histories = await Promise.all(
        productIds.slice(0, 10).map(async (pid) => {
          const d = await getHistory(pid);
          if (d.error) return null;
          return {
            id: pid,
            title: d.product?.title ?? pid,
            current: d.stats?.last ?? 0,
            savingPct: d.stats?.max && d.stats?.last && d.stats.max > d.stats.last
              ? Math.round((1 - d.stats.last / d.stats.max) * 100)
              : 0,
            category: d.product?.category ?? null,
          };
        })
      );
      deals = histories.filter(Boolean);
    } else {
      deals = await fetchDeals();
    }
    if (!deals.length) return res.json({ ok: false, message: "sin deals" });
    const postId = await postDealsCarouselToInstagram(deals.slice(0, 5));
    res.json({ ok: true, postId, deals: deals.length, first: deals[0].title });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Preview del carousel de Instagram: muestra las slides en el browser sin publicar.
// GET /admin/ig-preview?n=5         → top N deals del día
// GET /admin/ig-preview?ids=MLA,MLB → productos específicos
app.get("/admin/ig-preview", requireAdmin, async (req, res) => {
  try {
    const baseUrl = baseUrlOf(req);
    let deals;
    const ids = req.query.ids ? String(req.query.ids).split(",").map(s => s.trim()).filter(Boolean) : null;
    if (ids?.length) {
      deals = ids.map(id => ({ id }));
    } else {
      const n = Math.min(parseInt(req.query.n ?? "5", 10) || 5, 10);
      deals = (await fetchDeals()).slice(0, n);
    }
    if (!deals.length) return res.status(404).send("Sin deals disponibles");

    const slides = deals.map(d => ({
      img: `${baseUrl}/og-ig/${d.id}.png`,
      title: d.title ?? d.id,
      id: d.id,
    }));

    const html = `<!DOCTYPE html><html lang="es">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IG Preview — Bajó el Precio</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; font-family: system-ui, sans-serif; color: #fff; padding: 24px; }
  h1 { font-size: 18px; margin-bottom: 20px; color: #e64c1e; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
  .slide { background: #1e1e1e; border-radius: 12px; overflow: hidden; }
  .slide img { width: 100%; aspect-ratio: 1; display: block; }
  .slide footer { padding: 10px 14px; font-size: 12px; color: #aaa; }
  .slide footer a { color: #e64c1e; text-decoration: none; font-size: 11px; }
  .hint { margin-bottom: 16px; font-size: 13px; color: #666; }
</style>
</head>
<body>
<h1>Preview carousel Instagram (${slides.length} slides)</h1>
<p class="hint">Estas imágenes se verían como slides en el feed. No se publicó nada.</p>
<div class="grid">
${slides.map((s, i) => `
  <div class="slide">
    <img src="${s.img}" alt="slide ${i + 1}" loading="lazy">
    <footer>
      Slide ${i + 1} — <code>${s.id}</code>
      &nbsp;·&nbsp;<a href="${s.img}" target="_blank">Ver PNG ↗</a>
      &nbsp;·&nbsp;<a href="${baseUrl}/p/${s.id}" target="_blank">Ver producto ↗</a>
    </footer>
  </div>`).join("")}
</div>
</body></html>`;

    res.set("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Inyecta cookies de Twitter en el contexto Playwright persistente.
// Usar con el script scripts/export-twitter-cookies.js para subir sesión local.
// Body: { cookies: [ { name, value, domain, path, ... } ] }
app.post("/admin/set-twitter-cookies", requireAdmin, async (req, res) => {
  const { cookies } = req.body ?? {};
  if (!Array.isArray(cookies) || !cookies.length) return res.status(400).json({ error: "falta cookies" });
  setTwitterCookies(cookies);
  const { getContext, saveTwitterCookies } = await import("./ml/price-reader.js");
  const ctx = await getContext();
  await ctx.addCookies(cookies);
  saveTwitterCookies(cookies); // persist to volume so cookies survive deploys
  res.json({ ok: true, count: cookies.length });
});
// Test de email: envía un email de prueba a la dirección indicada.
// Body: { to: "test@example.com" }
app.post("/admin/test-email", requireAdmin, async (req, res) => {
  const { to } = req.body ?? {};
  if (!to) return res.status(400).json({ error: "falta to" });
  const deals = await fetchDeals();
  const deal = deals[0];
  if (!deal) return res.json({ ok: false, message: "sin deals para el test" });
  const ok = await sendPriceDropEmail({
    to,
    productTitle: deal.title,
    currentPrice: deal.current,
    targetPrice: null,
    productUrl: deal.url || `https://bajoelprecio.fly.dev/p/${deal.id}`,
    historyUrl: `https://bajoelprecio.fly.dev/p/${deal.id}`,
  });
  res.json({ ok, to, product: deal.title });
});
app.get("/debug/ml-status", requireAdmin, async (_req, res) => {
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
  ${THEME_HEAD_SCRIPT}
  <style>
    :root{--brand:#e64c1e;--brand-dark:#c03d18;--brand-bg:#fff3ef;--text:#111827;--text-soft:#6b7280;--text-xsoft:#9ca3af;--bg:#f9fafb;--surface:#fff;--border:#e5e7eb;--radius:12px}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;-webkit-font-smoothing:antialiased}
    a{color:var(--brand);text-decoration:none}
    a:hover{text-decoration:underline}
    .container{max-width:860px;margin:0 auto;padding:0 20px}
    ${NAV_CSS}
    .hero{padding:64px 0 48px}
    .hero h1{font-size:clamp(28px,5vw,48px);font-weight:800;letter-spacing:-.02em;margin-bottom:16px}
    .hero p{font-size:18px;color:var(--text-soft);max-width:600px;margin-bottom:32px}
    .pill{display:inline-block;background:#fff3ef;color:var(--brand);font-size:13px;font-weight:600;padding:4px 14px;border-radius:999px;margin-bottom:20px}
    .plans{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:48px 0}
    @media(max-width:600px){
      .plans{grid-template-columns:1fr;margin:32px 0}
      .plan{padding:20px}
      .hero{padding:40px 0 32px}
      .hero h1{font-size:clamp(24px,6vw,38px)}
      .hero p{font-size:16px}
      .section{margin:32px 0}
      .endpoint{padding:14px}
      pre{padding:14px;font-size:12px}
      .plan .price{font-size:clamp(22px,6vw,32px)}
    }
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
    ${THEME_CSS}
  </style>
</head>
<body>
${buildNav({ active: null })}
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
    <a href="/">Bajó el Precio</a> · <a href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Telegram</a> · <a href="/deals">Deals</a> · <a href="/privacidad">Privacidad</a>
    <div style="margin-top:8px">Datos de MercadoLibre Argentina. No afiliado con MercadoLibre S.A.</div>
  </div>
</footer>
<script src="/theme.js"></script>
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
app.get("/api/compare/:id", makeRateLimit(5, 60_000), async (req, res) => {
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
app.get("/api/catalog", makeRateLimit(30, 60_000), async (_req, res) => {
  const byCat = await cached("catalog:all", 5 * 60_000, async () => {
    const products = await prisma.product.findMany({
      where: { prices: { some: {} }, image: { not: null }, title: { not: "(por scrapear)" } },
      select: {
        id: true,
        title: true,
        url: true,
        image: true,
        category: true,
        queries: true,
        prices: { orderBy: { seenAt: "desc" }, take: 24, select: { price: true } },
      },
      orderBy: { queries: "desc" },
    });
    const result = {};
    for (const p of products) {
      const prices = p.prices.map((x) => x.price).reverse();
      const cat = p.category || "Otros";
      (result[cat] ??= []).push({
        id: p.id,
        title: p.title,
        url: affiliateUrl(p.url),
        image: p.image,
        queries: p.queries,
        price: prices.at(-1) ?? null,
        min: prices.length ? prices.reduce((m, p) => p < m ? p : m, Infinity) : null,
        max: prices.length ? prices.reduce((m, p) => p > m ? p : m, -Infinity) : null,
        spark: prices,
      });
    }
    return result;
  });
  res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  res.json(byCat);
});

// Trending: los productos más buscados de las últimas 24h (para un carrusel de la landing).
app.get("/api/trending", makeRateLimit(30, 60_000), async (_req, res) => {
  const oneDayAgo = new Date(Date.now() - 24 * 3_600_000);
  const products = await prisma.product.findMany({
    where: {
      prices: { some: { seenAt: { gte: oneDayAgo } } },
      image: { not: null },
      title: { not: "(por scrapear)" },
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
  res.set("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
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
app.get("/api/products", makeRateLimit(30, 60_000), async (_req, res) => {
  const products = await prisma.product.findMany({
    orderBy: { queries: "desc" },
    select: { id: true, title: true, queries: true, _count: { select: { prices: true } } },
    take: 100,
  });
  res.json(products);
});

// Global error handler — catches anything thrown inside async route handlers (Express v5 auto-propagates).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status ?? err.statusCode ?? 500;
  const detail = process.env.NODE_ENV !== "production" ? err.stack?.split("\n")[1]?.trim() : undefined;
  console.error(`[error] ${req.method} ${req.path} ${status}:`, err.message, detail ?? "");
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 ? "error interno" : err.message });
});

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
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
      .then(() => import("./enrich-images.js").then(({ enrichImages }) => enrichImages()))
      .catch((e) => console.error("[tracker] error:", e.message))
      .finally(() => { trackerRunning = false; });
  };

  // Run enrich-images early at startup so null images get resolved quickly after each deploy.
  setTimeout(() => import("./enrich-images.js").then(({ enrichImages }) => enrichImages()).catch(console.error), 15_000);

  // Primera corrida: espera 5min para que el server arranque limpio.
  setTimeout(() => {
    console.log(`[tracker] primera corrida programada en 5min, luego cada ${hours}h`);
    runTracker();
    setInterval(runTracker, intervalMs);
  }, 5 * 60_000);

  // Discovery via ML highlights API (category tree walk) — works from cloud IPs with Bearer token.
  // Search API (/sites/MLA/search) is blocked from datacenter IPs; highlights is not.
  let seedRunning = false;
  const runSeed = () => {
    if (seedRunning) { console.log("[seed] ya corriendo, skip"); return; }
    seedRunning = true;
    import("./seed-products.js")
      .then(({ seedProducts }) => seedProducts())
      .then(() => import("./enrich-images.js").then(({ enrichImages }) => enrichImages()))
      .catch((e) => console.error("[seed] error:", e.message))
      .finally(() => { seedRunning = false; });
  };

  // First seed: wait 10min so startup noise settles and tracker has a head start.
  setTimeout(() => {
    console.log("[seed] primera seed en 10min via highlights API, luego cada 2h");
    runSeed();
    setInterval(runSeed, 2 * 3_600_000);
  }, 10 * 60_000);

  // Daily digest: postea los top 3 deals a Telegram, Twitter/X e Instagram a las 09:00 ART (12:00 UTC)
  const digestEnabled = process.env.ALERTS_ENABLED === "1" && process.env.TELEGRAM_CHANNEL;
  if (digestEnabled) {
    const runDigest = async () => {
      try {
        const deals = await fetchDeals();
        if (!deals.length) return;

        // Telegram
        const fmtArs = n => "$" + Math.round(n).toLocaleString("es-AR");
        const lines = deals.slice(0, 3).map((d, i) =>
          `${i + 1}. <b>${d.title.slice(0, 60)}</b>\n   ${fmtArs(d.current)} (-${d.savingPct}% vs promedio)\n   <a href="${process.env.PUBLIC_URL}/p/${d.id}">Ver historial</a>`
        );
        const tgText = `🔥 <b>Mejores ofertas del día</b>\n\n${lines.join("\n\n")}\n\n<a href="${process.env.PUBLIC_URL}/deals">Ver todas las ofertas →</a>`;
        await sendChannel(tgText).catch(e => console.warn("[digest:tg]", e.message));

        // Twitter/X — thread con top 3
        tweetDeals(deals.slice(0, 3)).catch(e => console.warn("[digest:twitter]", e.message));

        // Instagram — desactivado hasta definir el diseño final de los creatives.
        // Para postear manualmente: POST /admin/post-instagram con x-admin-token
        // postDealsCarouselToInstagram(deals.slice(0, 5)).catch(e => console.warn("[digest:instagram]", e.message));

        console.log("[digest] enviado a todos los canales");
      } catch (e) {
        console.warn("[digest] error:", e.message);
      }
    };

    const scheduleDigest = () => {
      const now = new Date();
      const nextUTC12 = new Date(now);
      nextUTC12.setUTCHours(12, 0, 0, 0);
      if (nextUTC12 <= now) nextUTC12.setUTCDate(nextUTC12.getUTCDate() + 1);
      const msUntil = nextUTC12 - now;
      setTimeout(async () => { await runDigest(); scheduleDigest(); }, msUntil);
      console.log(`[digest] próximo en ${Math.round(msUntil / 60_000)}min`);
    };
    scheduleDigest();
  }
});
