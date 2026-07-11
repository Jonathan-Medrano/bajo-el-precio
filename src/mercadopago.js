/**
 * Webhook de MercadoPago para activar plan Premium.
 *
 * Flujo:
 *  1. Usuario paga el link de pago de MP (creado manualmente o via SDK).
 *  2. MP llama a POST /webhooks/mp con el evento.
 *  3. Verificamos la firma HMAC-SHA256 (MP_WEBHOOK_SECRET en .env).
 *  4. Obtenemos el pago via API de MP y extraemos el chatId del external_reference.
 *  5. Llamamos a grantPremium(chatId, { days }) y notificamos por Telegram.
 *
 * El chatId debe viajar en el campo `external_reference` del link de pago.
 * Ejemplo de link: https://mpago.la/XXX?external_reference=CHATID_123456789
 *
 * Precio/días sugeridos:
 *  - $1.500 ARS / mes → 30 días
 *  - $3.500 ARS / trimestre → 90 días
 */

import crypto from "node:crypto";
import { grantPremium } from "./plans.js";
import { sendUser } from "./telegram.js";

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;

// Mapa precio (en centavos ARS) → días de premium
const PRICE_TO_DAYS = [
  { minAmount: 350_000, days: 90 },   // $3.500 = trimestre
  { minAmount: 140_000, days: 30 },   // $1.500 = mes  (ajustado a inflación)
  { minAmount: 0,       days: 30 },   // fallback
];

function daysFromAmount(amountCents) {
  for (const { minAmount, days } of PRICE_TO_DAYS) {
    if (amountCents >= minAmount) return days;
  }
  return 30;
}

function verifySignature(req) {
  if (!MP_WEBHOOK_SECRET) {
    console.error("[mp-webhook] MP_WEBHOOK_SECRET no configurado — rechazando request");
    return false;
  }
  const sig = req.headers["x-signature"];
  const reqId = req.headers["x-request-id"] ?? "";
  if (!sig) return false;

  const parts = Object.fromEntries(sig.split(",").map((s) => s.trim().split("=")));
  const ts = parts.ts ?? "";
  const hash = parts.v1 ?? "";
  const body = req.rawBody ?? JSON.stringify(req.body);
  const manifest = `id:${req.body?.data?.id ?? ""};request-id:${reqId};ts:${ts};`;
  const expected = crypto.createHmac("sha256", MP_WEBHOOK_SECRET).update(manifest).digest("hex");
  if (expected.length !== hash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
}

async function getPayment(paymentId) {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN no configurado");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
  if (!r.ok) throw new Error(`MP API ${r.status}`);
  return r.json();
}

export const PLANS = [
  { label: "Pro Mensual", amount: 4990, days: 30 },
  { label: "Pro Anual",   amount: 39990, days: 365 },
];

export async function createPaymentPreference(chatId, planIndex = 0) {
  if (!MP_ACCESS_TOKEN) throw new Error("MP_ACCESS_TOKEN no configurado");
  const plan = PLANS[planIndex] ?? PLANS[0];
  const publicUrl = process.env.PUBLIC_URL || "https://bajoelprecio.fly.dev";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const r = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    signal: ctrl.signal,
    body: JSON.stringify({
      items: [{ title: `Bajó el Precio ${plan.label}`, quantity: 1, currency_id: "ARS", unit_price: plan.amount }],
      external_reference: String(chatId),
      back_urls: {
        success: `${publicUrl}/premium/gracias`,
        failure: `${publicUrl}/premium`,
        pending: `${publicUrl}/premium`,
      },
      auto_return: "approved",
      statement_descriptor: "Bajo el Precio",
    }),
  }).finally(() => clearTimeout(timer));
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`MP preference error ${r.status}: ${body}`);
  }
  const data = await r.json();
  return { initPoint: data.init_point, sandboxInitPoint: data.sandbox_init_point, plan };
}

/** Handler para montar en Express: app.post("/webhooks/mp", mpWebhookHandler) */
export async function mpWebhookHandler(req, res) {
  // Responder rápido para evitar retries de MP
  res.status(200).json({ ok: true });

  try {
    if (!verifySignature(req)) {
      console.warn("[mp-webhook] firma inválida, ignorando");
      return;
    }

    const { type, action, data } = req.body ?? {};
    if (type !== "payment" || action !== "payment.updated") return;

    const paymentId = data?.id;
    if (!paymentId) return;

    const payment = await getPayment(paymentId);
    console.log(`[mp-webhook] payment ${paymentId} status: ${payment.status}`);

    if (payment.status !== "approved") return;

    const chatId = String(payment.external_reference ?? "").trim();
    if (!chatId) {
      console.warn("[mp-webhook] sin external_reference en el pago");
      return;
    }

    // Calcular días según monto (transaction_amount está en pesos, no centavos en MP)
    const amountCents = Math.round(payment.transaction_amount * 100);
    const days = daysFromAmount(amountCents);

    const sub = await grantPremium(chatId, { days });
    console.log(`[mp-webhook] premium activado: chatId=${chatId} days=${days} hasta ${sub.premiumUntil}`);

    // Notificar al usuario por Telegram
    await sendUser(
      chatId,
      `🎉 <b>¡Premium activado!</b>\n\nTu plan Premium está activo por <b>${days} días</b>.\n` +
      `Alertas ilimitadas, sin restricciones.\n\n` +
      `Gracias por apoyar Bajó el Precio 🙌`
    ).catch(() => {});
  } catch (e) {
    console.error("[mp-webhook] error:", e.message);
  }
}
