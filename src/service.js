import { prisma } from "./db.js";
import { parseProductId, isShortLink } from "./link-parser.js";
import { expandUrl } from "./link-expander.js";
import { readProductPrice, readProductPriceFromApi } from "./ml/price-reader.js";
import { affiliateUrl } from "./affiliate.js";
import { onNewPrice } from "./alerts.js";
import { getPlan } from "./plans.js";

/** Resuelve un input (link, link corto, id) al producto. */
export async function resolveId(input) {
  const urlMatch = String(input ?? "").match(/https?:\/\/\S+/);
  let toParse = input;
  if (urlMatch && isShortLink(urlMatch[0])) {
    try {
      toParse = await expandUrl(urlMatch[0]);
    } catch {
      /* seguimos con el texto */
    }
  }
  return parseProductId(toParse);
}

/** Trackea un producto: lee su precio, lo guarda (upsert) y registra un PricePoint. */
export async function trackProduct(input) {
  const parsed = await resolveId(input);
  if (!parsed) return { error: "no_product" };

  // API-first: más rápido y sin riesgo de CAPTCHA. Playwright como fallback.
  let reading = await readProductPriceFromApi(parsed.id);
  if (!reading) reading = await readProductPrice(parsed.id, parsed.url);
  if (reading.blocked) return { error: "blocked" };
  if (!reading.price) return { error: "no_price" };

  // cheapestUrl = URL del listing con mejor precio ahora. Si no hay (Playwright), usamos parsed.url.
  const bestUrl = reading.cheapestUrl ?? parsed.url;
  await prisma.product.upsert({
    where: { id: parsed.id },
    update: { title: reading.title ?? undefined, url: bestUrl, image: reading.image ?? undefined, queries: { increment: 1 } },
    create: { id: parsed.id, title: reading.title ?? "Producto", url: bestUrl, image: reading.image, queries: 1 },
  });
  await prisma.pricePoint.create({ data: { productId: parsed.id, price: reading.price } });
  await onNewPrice(parsed.id, reading.price);

  return getHistory(parsed.id);
}

/** Registra una observación de precio que mandó la extensión (lee el precio de la página, NO scrapea). */
export async function observeProduct({ id, price, title, image, url, category }) {
  if (!id || !price || !Number.isFinite(price)) return { error: "missing" };
  await prisma.product.upsert({
    where: { id },
    update: { title: title ?? undefined, image: image ?? undefined, url: url ?? undefined, category: category ?? undefined },
    create: { id, title: title ?? "Producto", image, url, category },
  });
  // Anti-spam: no duplicar el mismo precio si el último punto es reciente (< 2h).
  const last = await prisma.pricePoint.findFirst({ where: { productId: id }, orderBy: { seenAt: "desc" } });
  const recent = last && Date.now() - new Date(last.seenAt).getTime() < 2 * 3_600_000;
  if (!last || last.price !== price || !recent) {
    await prisma.pricePoint.create({ data: { productId: id, price } });
    await onNewPrice(id, price);
  }
  return getHistory(id);
}

/** Suscribe a un usuario a las bajas de un producto. Crea el producto si no existe. */
export async function subscribeAlert({ chatId, productId, targetPrice, title, url, image }) {
  if (!chatId || !productId) return { error: "missing" };

  // Límite del plan: bloquea solo si es una alerta NUEVA y ya llegó al tope.
  const existing = await prisma.alert.findUnique({
    where: { chatId_productId: { chatId: String(chatId), productId } },
  });
  if (!existing) {
    const plan = await getPlan(chatId);
    if (!plan.premium && plan.used >= plan.limit) {
      return { error: "limit", limit: plan.limit, used: plan.used };
    }
  }

  await prisma.product.upsert({
    where: { id: productId },
    update: { title: title ?? undefined, url: url ?? undefined, image: image ?? undefined },
    create: { id: productId, title: title ?? "Producto", url, image },
  });
  const target = Number.isFinite(Number(targetPrice)) && Number(targetPrice) > 0 ? Math.round(Number(targetPrice)) : null;
  const alert = await prisma.alert.upsert({
    where: { chatId_productId: { chatId: String(chatId), productId } },
    update: { targetPrice: target, lastNotifiedPrice: null },
    create: { chatId: String(chatId), productId, targetPrice: target },
  });
  return { ok: true, alert };
}

/** Lista las alertas de un usuario (con el precio actual de cada producto). */
export async function listAlerts(chatId) {
  const alerts = await prisma.alert.findMany({
    where: { chatId: String(chatId) },
    include: { product: { include: { prices: { orderBy: { seenAt: "desc" }, take: 1 } } } },
    orderBy: { createdAt: "desc" },
  });
  return alerts.map((a) => ({
    id: a.id,
    productId: a.productId,
    title: a.product.title,
    targetPrice: a.targetPrice,
    currentPrice: a.product.prices[0]?.price ?? null,
  }));
}

/** Borra una suscripción por alertId. */
export async function unsubscribeAlert({ chatId, alertId }) {
  const deleted = await prisma.alert.deleteMany({ where: { id: Number(alertId), chatId: String(chatId) } });
  return { ok: deleted.count > 0 };
}

/** Devuelve el producto + su historial de precios + stats (para el gráfico). */
export async function getHistory(id) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: { prices: { orderBy: { seenAt: "asc" } } },
  });
  if (!product) return { error: "not_found" };

  const prices = product.prices.map((p) => p.price);
  const stats = prices.length
    ? {
        count: prices.length,
        min: Math.min(...prices),
        max: Math.max(...prices),
        avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        last: prices[prices.length - 1],
      }
    : { count: 0 };

  const intelligence = buildIntelligence(prices);

  return {
    product: { id: product.id, title: product.title, url: affiliateUrl(product.url), image: product.image, rawUrl: product.url, category: product.category, firstSeen: product.firstSeen },
    history: product.prices.map((p) => ({ price: p.price, seenAt: p.seenAt })),
    stats,
    intelligence,
  };
}

function buildIntelligence(prices) {
  if (prices.length < 5) {
    return { confidence: 0, isDeal: false, trend: "estable", recommendation: "⚪ Insuficiente historial para recomendar" };
  }

  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const current = prices[prices.length - 1];

  const recent5 = prices.slice(-5);
  const prev5 = prices.slice(-10, -5);
  const avgRecent = recent5.reduce((s, p) => s + p, 0) / recent5.length;
  const avgPrev = prev5.length ? prev5.reduce((s, p) => s + p, 0) / prev5.length : avgRecent;

  const THRESHOLD = avgPrev * 0.02;
  const trend = avgRecent < avgPrev - THRESHOLD ? "bajando" : avgRecent > avgPrev + THRESHOLD ? "subiendo" : "estable";

  const isDeal = current <= avg * 0.95;

  let confidence = 0;
  if (prices.length >= 10) confidence += 30;
  if (prices.length >= 30) confidence += 20;
  if (isDeal) confidence += 25;
  if (trend === "bajando") confidence += 25;

  let recommendation;
  if (confidence >= 70 && isDeal) {
    recommendation = "🟢 Comprar ahora — precio bajo confirmado por historial";
  } else if (confidence >= 50 && isDeal) {
    recommendation = "🟡 Buen momento — está por debajo del promedio";
  } else if (trend === "subiendo") {
    recommendation = "🔴 Está subiendo — el historial sugiere esperar";
  } else {
    recommendation = "⚪ Insuficiente historial para recomendar";
  }

  return { confidence, isDeal, trend, recommendation };
}
