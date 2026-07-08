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
