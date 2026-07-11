import { prisma } from "./db.js";
import { parseProductId, isShortLink } from "./link-parser.js";
import { expandUrl } from "./link-expander.js";
import { readProductPrice, readProductPriceFromApi } from "./ml/price-reader.js";
import { affiliateUrl } from "./affiliate.js";
import { onNewPrice } from "./alerts.js";
import { getPlan, FREE_ALERT_LIMIT } from "./plans.js";

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
  let reading = await readProductPriceFromApi(parsed.id, parsed.type);
  if (!reading) reading = await readProductPrice(parsed.id, parsed.url);
  if (reading.blocked) return { error: "blocked" };

  if (!reading.price) {
    // No fresh price available (API blocked, Playwright blocked).
    // If the product is already in DB, return stale history rather than an error.
    const stale = await getHistory(parsed.id);
    if (!stale.error) return { ...stale, stale: true };
    return { error: "no_price" };
  }

  // cheapestUrl = URL del listing con mejor precio ahora. Si no hay (Playwright), usamos parsed.url.
  const bestUrl = reading.cheapestUrl ?? parsed.url;
  const bestTitle = reading.title ?? parsed.titleHint ?? undefined;
  await prisma.product.upsert({
    where: { id: parsed.id },
    update: { title: bestTitle, url: bestUrl, image: reading.image ?? undefined, queries: { increment: 1 } },
    create: { id: parsed.id, title: bestTitle ?? "Producto", url: bestUrl, image: reading.image, queries: 1 },
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

  const cid = String(chatId);
  const target = Number.isFinite(Number(targetPrice)) && Number(targetPrice) > 0 ? Math.round(Number(targetPrice)) : null;

  // Upsert del producto antes de la transacción (no necesita atomicidad con el alert)
  await prisma.product.upsert({
    where: { id: productId },
    update: { title: title ?? undefined, url: url ?? undefined, image: image ?? undefined },
    create: { id: productId, title: title ?? "Producto", url, image },
  });

  // Transacción atómica: verificar límite + crear alerta sin race condition.
  // Sin esto, dos requests paralelas podían superar el límite free juntas.
  // getPlan usa el cliente global de Prisma, no sirve dentro de $transaction —
  // por eso replicamos la lógica inline usando el cliente tx.
  const alert = await prisma.$transaction(async (tx) => {
    const existing = await tx.alert.findUnique({
      where: { chatId_productId: { chatId: cid, productId } },
    });
    if (!existing) {
      const [sub, used, referrals] = await Promise.all([
        tx.subscriber.findUnique({ where: { chatId: cid } }),
        tx.alert.count({ where: { chatId: cid } }),
        tx.referral.count({ where: { referrerId: cid } }),
      ]);
      const premium = sub?.plan === "premium" && (!sub.premiumUntil || sub.premiumUntil > new Date());
      const limit = premium ? Infinity : FREE_ALERT_LIMIT + referrals;
      if (!premium && used >= limit) {
        throw Object.assign(new Error("limit"), { limitError: true, limit: FREE_ALERT_LIMIT + referrals, used });
      }
    }
    return tx.alert.upsert({
      where: { chatId_productId: { chatId: cid, productId } },
      update: { targetPrice: target, lastNotifiedPrice: null },
      create: { chatId: cid, productId, targetPrice: target },
    });
  }).catch((e) => {
    if (e.limitError) return e;
    throw e;
  });

  if (alert.limitError) return { error: "limit", limit: alert.limit, used: alert.used };
  return { ok: true, alert };
}

/** Lista las alertas de un usuario con historial completo (para el dashboard). */
export async function listAlerts(chatId) {
  const alerts = await prisma.alert.findMany({
    where: { chatId: String(chatId) },
    include: {
      product: {
        include: { prices: { orderBy: { seenAt: "desc" }, take: 200, select: { price: true } } },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return alerts.map((a) => {
    const prices = a.product.prices.map((p) => p.price).reverse();
    const current = prices.at(-1) ?? null;
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;
    const avg = prices.length ? Math.round(prices.reduce((s, p) => s + p, 0) / prices.length) : null;
    return {
      id: a.id,
      productId: a.productId,
      title: a.product.title,
      image: a.product.image,
      url: a.product.url,
      targetPrice: a.targetPrice,
      currentPrice: current,
      min,
      max,
      avg,
      spark: prices.slice(-24),
      score: dealScore(prices),
      trend: prices.length >= 5 ? buildIntelligence(prices).trend : "estable",
    };
  });
}

/** Borra una suscripción por alertId o productId. */
export async function unsubscribeAlert({ chatId, alertId, productId }) {
  if (alertId != null) {
    const deleted = await prisma.alert.deleteMany({ where: { id: Number(alertId), chatId: String(chatId) } });
    return { ok: deleted.count > 0 };
  }
  if (productId) {
    const deleted = await prisma.alert.deleteMany({ where: { chatId: String(chatId), productId: String(productId) } });
    return { ok: deleted.count > 0 };
  }
  return { ok: false };
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
    return { confidence: 0, isDeal: false, trend: "estable", recommendation: "⚪ Insuficiente historial para recomendar", score: null };
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

  return { confidence, isDeal, trend, recommendation, score: dealScore(prices) };
}

/** Puntaje del deal de 1 (pésimo) a 10 (mínimo histórico). */
function dealScore(prices) {
  if (prices.length < 3) return null;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const current = prices.at(-1);
  const range = max - min;

  // Precio muy estable → score neutro
  if (range < min * 0.02) return 5;

  // Posición en el rango histórico: 10 = en el mínimo, 1 = en el máximo
  const posScore = 10 - ((current - min) / range) * 9;

  // Ajuste de tendencia: bajando es bueno (+1), subiendo es malo (-1)
  const recent = prices.slice(-4);
  const earlier = prices.slice(-8, -4);
  let trendAdj = 0;
  if (earlier.length >= 2) {
    const r = recent.reduce((s, p) => s + p, 0) / recent.length;
    const e = earlier.reduce((s, p) => s + p, 0) / earlier.length;
    const pct = (r - e) / e;
    if (pct < -0.03) trendAdj = 1;
    else if (pct > 0.03) trendAdj = -1;
  }

  return Math.max(1, Math.min(10, Math.round(posScore + trendAdj)));
}
