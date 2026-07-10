// Planes y límites. La monetización B2C: free limitado, premium ilimitado.
import { prisma } from "./db.js";

export const FREE_ALERT_LIMIT = Number(process.env.FREE_ALERT_LIMIT) || 999;

/** ¿El usuario (chatId) tiene premium vigente? */
export async function isPremium(chatId) {
  const sub = await prisma.subscriber.findUnique({ where: { chatId: String(chatId) } });
  if (!sub || sub.plan !== "premium") return false;
  if (sub.premiumUntil && sub.premiumUntil.getTime() < Date.now()) return false;
  return true;
}

/** Devuelve el plan + uso de alertas de un usuario (para mostrarle su estado). */
export async function getPlan(chatId) {
  const premium = await isPremium(chatId);
  const [used, referrals] = await Promise.all([
    prisma.alert.count({ where: { chatId: String(chatId) } }),
    premium ? Promise.resolve(0) : prisma.referral.count({ where: { referrerId: String(chatId) } }),
  ]);
  const limit = premium ? null : FREE_ALERT_LIMIT + referrals;
  return { plan: premium ? "premium" : "free", premium, used, limit };
}

/** Otorga premium a un usuario (lo usa el admin / el webhook de pago a futuro). */
export async function grantPremium(chatId, { days } = {}) {
  const premiumUntil = days ? new Date(Date.now() + days * 86_400_000) : null;
  return prisma.subscriber.upsert({
    where: { chatId: String(chatId) },
    update: { plan: "premium", premiumUntil },
    create: { chatId: String(chatId), plan: "premium", premiumUntil },
  });
}
