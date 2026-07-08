// API B2B: keys con cuota diaria. La monetización por volumen (modelo Keepa).
import { randomBytes } from "node:crypto";
import { prisma } from "./db.js";

const PLAN_QUOTAS = { free: 100, pro: 5_000, business: 50_000 };

/** Crea una API key nueva. */
export async function createApiKey({ name, plan = "free" }) {
  const key = "km_" + randomBytes(24).toString("hex");
  const dailyQuota = PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.free;
  const created = await prisma.apiKey.create({ data: { key, name: name ?? "sin nombre", plan, dailyQuota } });
  return { key, plan: created.plan, dailyQuota: created.dailyQuota };
}

/** Middleware Express: valida la x-api-key, resetea el contador diario y controla la cuota. */
export async function apiKeyMiddleware(req, res, next) {
  const key = req.header("x-api-key") || req.query.api_key;
  if (!key) return res.status(401).json({ error: "falta x-api-key" });

  const record = await prisma.apiKey.findUnique({ where: { key } });
  if (!record || !record.active) return res.status(403).json({ error: "api key inválida" });

  // Reset diario: si pasó un día desde lastReset, arranca de cero.
  const dayMs = 86_400_000;
  const now = Date.now();
  let requestsToday = record.requestsToday;
  if (now - record.lastReset.getTime() >= dayMs) {
    requestsToday = 0;
    await prisma.apiKey.update({ where: { key }, data: { requestsToday: 0, lastReset: new Date(now) } });
  }

  if (requestsToday >= record.dailyQuota) {
    res.set("X-RateLimit-Limit", String(record.dailyQuota));
    res.set("X-RateLimit-Remaining", "0");
    return res.status(429).json({ error: "cuota diaria agotada", limit: record.dailyQuota, plan: record.plan });
  }

  await prisma.apiKey.update({ where: { key }, data: { requestsToday: { increment: 1 } } });
  res.set("X-RateLimit-Limit", String(record.dailyQuota));
  res.set("X-RateLimit-Remaining", String(record.dailyQuota - requestsToday - 1));
  req.apiKey = record;
  next();
}
