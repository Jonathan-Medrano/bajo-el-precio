// Motor de alertas. Se llama después de registrar un nuevo PricePoint.
//  - Broadcast: si el producto tocó un NUEVO mínimo histórico -> postea al canal.
//  - Por usuario: si alguna suscripción matchea (precio <= objetivo, o nuevo mínimo) -> DM.
// Si ALERTS_ENABLED != 1, NO envía nada: solo loguea lo que enviaría (dry-run seguro).

import { prisma } from "./db.js";
import { affiliateUrl } from "./affiliate.js";
import { sendChannel, sendUser, alertsEnabled } from "./telegram.js";

const MIN_HISTORY = 3; // no gritamos "bajó" sin algo de historial
const WEB_URL = process.env.PUBLIC_URL || process.env.WEB_URL || "http://localhost:3000";
const fmt = (n) => "$" + Number(n).toLocaleString("es-AR");

/** Llamar DESPUÉS de crear el PricePoint. productId + el precio recién registrado. */
export async function onNewPrice(productId, newPrice) {
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: { prices: { orderBy: { seenAt: "desc" } }, alerts: true },
    });
    if (!product) return;

    const others = product.prices.slice(1).map((p) => p.price); // todos menos el recién creado
    const prevMin = others.length ? Math.min(...others) : null;
    const isNewLow = prevMin != null && newPrice < prevMin;
    const enoughHistory = others.length >= MIN_HISTORY;

    // --- Broadcast al canal ---
    if (isNewLow && enoughHistory) {
      const pct = Math.round((1 - newPrice / prevMin) * 100);
      const link = affiliateUrl(product.url) || `${WEB_URL}/?id=${product.id}`;
      const text =
        `📉 <b>¡BAJÓ EL PRECIO!</b>\n\n` +
        `<b>${escapeHtml(product.title)}</b>\n\n` +
        `💵 Ahora: <b>${fmt(newPrice)}</b>\n` +
        `🟢 Nuevo mínimo histórico (antes ${fmt(prevMin)}${pct > 0 ? `, -${pct}%` : ""})\n\n` +
        `🔗 <a href="${link}">Comprar en MercadoLibre</a>`;
      const markup = { inline_keyboard: [[{ text: "📊 Ver historial", url: `${WEB_URL}/?id=${product.id}` }]] };
      await fire("CANAL", text, () => sendChannel(text, markup));
    }

    // --- Alertas por usuario (DM) ---
    for (const alert of product.alerts) {
      const matchTarget = alert.targetPrice != null ? newPrice <= alert.targetPrice : isNewLow;
      const notSpam = alert.lastNotifiedPrice == null || newPrice < alert.lastNotifiedPrice;
      if (!matchTarget || !notSpam) continue;

      const link = affiliateUrl(product.url) || `${WEB_URL}/?id=${product.id}`;
      const objetivo = alert.targetPrice != null ? ` (tu objetivo: ${fmt(alert.targetPrice)})` : "";
      const text =
        `🔔 <b>¡Bajó un producto que seguís!</b>\n\n` +
        `<b>${escapeHtml(product.title)}</b>\n\n` +
        `💵 Ahora: <b>${fmt(newPrice)}</b>${objetivo}\n\n` +
        `🔗 <a href="${link}">Comprar en MercadoLibre</a>`;
      const ok = await fire(`DM ${alert.chatId}`, text, () => sendUser(alert.chatId, text));
      if (ok) {
        await prisma.alert.update({ where: { id: alert.id }, data: { lastNotifiedPrice: newPrice } });
      }
    }
  } catch (e) {
    console.warn(`[alertas] ${productId}: ${e.message}`);
  }
}

// Envía si está habilitado; si no, dry-run (loguea). Devuelve true si "avisó" (real o dry-run).
async function fire(label, text, send) {
  if (!alertsEnabled()) {
    console.log(`[alertas dry-run -> ${label}]\n${text}\n`);
    return true;
  }
  try {
    await send();
    console.log(`[alertas -> ${label}] enviado`);
    return true;
  } catch (e) {
    console.warn(`[alertas -> ${label}] error: ${e.message}`);
    return false;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
