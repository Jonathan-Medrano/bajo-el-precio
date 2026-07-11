import { listAlerts, unsubscribeAlert, subscribeAlert, getHistory } from "./service.js";
import { sendUser } from "./telegram.js";
import { getPlan, FREE_ALERT_LIMIT } from "./plans.js";
import { createApiKey } from "./apikeys.js";
import { prisma } from "./db.js";

const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";

const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtArs = (n) => "$" + Number(n).toLocaleString("es-AR");

async function processReferral(referrerId, newUserId) {
  try {
    await prisma.referral.create({ data: { referrerId, newUserId } });
    await sendUser(referrerId, `🎉 ¡Un amigo usó tu link de referido! Ganaste +1 alerta extra.`).catch(() => {});
  } catch {
    // Unique constraint on newUserId → already referred, silent skip
  }
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const cmd = text.split(" ")[0].replace(/@.*$/, "").toLowerCase();

  if (cmd === "/start" || cmd === "/ayuda") {
    const startPayload = text.split(" ")[1];

    // Vinculación web: /start link_XXXXXX — el modal web generó este código
    if (startPayload?.startsWith("link_")) {
      const code = startPayload.slice(5);
      try {
        const updated = await prisma.linkingCode.updateMany({
          where: { code, chatId: null, expiresAt: { gt: new Date() } },
          data: { chatId },
        });
        if (updated.count > 0) {
          await sendUser(chatId,
            `✅ <b>¡Todo listo!</b>\n\n` +
            `Tu cuenta está conectada. Ahora podés activar alertas de precio desde la web con un click.\n\n` +
            `🌐 <a href="${PUBLIC_URL}">${PUBLIC_URL}</a>`
          );
          return;
        }
      } catch (e) {
        console.error("[bot] link error:", e.message);
      }
      await sendUser(chatId, `⚠️ El código expiró o ya fue usado. Volvé a la web para generar uno nuevo.`);
      return;
    }

    // Alerta directa desde la web: /start track_PRODUCTID o track_PRODUCTID_PRICE
    if (startPayload?.startsWith("track_")) {
      const parts = startPayload.slice(6).split("_");
      const productId = parts[0]?.toUpperCase();
      const targetPrice = parts[1] ? parseInt(parts[1], 10) : null;
      if (!productId) {
        await sendUser(chatId, "❌ Link inválido. Volvé a la web y tocá el botón de alerta.");
        return;
      }
      const result = await subscribeAlert({ chatId, productId, targetPrice: targetPrice || null });
      if (result.error === "limit") {
        await sendUser(chatId,
          `⚠️ Llegaste al límite de alertas (${result.used}/${result.limit}).\n\n` +
          `Borrá una con /mis_alertas o activá /premium para tener alertas ilimitadas.`
        );
        return;
      }
      const data = await getHistory(productId);
      const title = data.product?.title ?? productId;
      const targetMsg = targetPrice ? `cuando baje de ${fmtArs(targetPrice)}` : "cuando llegue a su mínimo histórico";
      await sendUser(chatId,
        `👀 <b>Siguiendo producto</b>\n\n` +
        `📦 ${escHtml(title.slice(0, 80))}\n` +
        `🔔 Te aviso ${targetMsg}\n\n` +
        `👉 <a href="${PUBLIC_URL}/p/${productId}">Ver historial</a>`
      );
      return;
    }

    // Referido: /start ref_CHATID
    if (startPayload?.startsWith("ref_")) {
      const referrerId = startPayload.slice(4);
      if (referrerId && referrerId !== chatId) {
        await processReferral(referrerId, chatId);
      }
    }

    const refLink = `https://t.me/bajoelprecio_bot?start=ref_${chatId}`;
    await sendUser(
      chatId,
      `📉 <b>Bajó el Precio</b> — historial real de precios de MercadoLibre.\n\n` +
      `<b>Comandos:</b>\n` +
      `• /mis_alertas — tus alertas activas\n` +
      `• /plan — tu plan y uso de alertas\n` +
      `• /premium — activar plan sin límites\n` +
      `• /apikey — obtener tu API key gratuita\n` +
      `• /borrar &lt;ID&gt; — eliminar una alerta\n\n` +
      `🌐 Buscá cualquier producto en <a href="${PUBLIC_URL}">${PUBLIC_URL}</a>\n\n` +
      `💌 <b>Referí amigos:</b> +1 alerta extra por cada uno\n` +
      `<a href="${refLink}">${refLink}</a>`
    );
    return;
  }

  if (cmd === "/mis_alertas" || cmd === "/alertas") {
    const alerts = await listAlerts(chatId);
    if (!alerts.length) {
      await sendUser(chatId, "No tenés alertas activas.\n\n🌐 Activalas desde " + PUBLIC_URL);
      return;
    }
    const lines = alerts.map((a, i) => {
      const price = a.currentPrice ? fmtArs(a.currentPrice) : "–";
      const target = a.targetPrice ? fmtArs(a.targetPrice) : "cualquier baja";
      return `${i + 1}. <b>${escHtml(a.title.slice(0, 50))}</b>\n   Ahora: ${price} · Objetivo: ${target}\n   ID: <code>${a.id}</code>`;
    });
    // Telegram cap is 4096 chars — send in chunks of 15 to stay safe
    const CHUNK = 15;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK);
      const header = i === 0 ? `🔔 <b>Tus alertas activas</b> (${alerts.length}):\n\n` : "";
      const footer = i + CHUNK >= lines.length ? `\n\nPara borrar: /borrar &lt;ID&gt;` : "";
      await sendUser(chatId, header + chunk.join("\n\n") + footer);
    }
    return;
  }

  if (cmd === "/plan") {
    const p = await getPlan(chatId);
    if (p.premium) {
      const sub = await prisma.subscriber.findUnique({ where: { chatId } });
      const exp = sub?.premiumUntil
        ? ` (hasta el ${new Date(sub.premiumUntil).toLocaleDateString("es-AR")})`
        : " (sin vencimiento)";
      await sendUser(chatId,
        `⭐ <b>Plan: Premium</b>${escHtml(exp)}\n\n` +
        `Tenés alertas ilimitadas activas. ¡Gracias por apoyar el proyecto!`
      );
    } else {
      const referrals = p.limit - FREE_ALERT_LIMIT;
      await sendUser(chatId,
        `🆓 <b>Plan: Free</b>\n\n` +
        `Alertas usadas: <b>${p.used}/${p.limit}</b>\n` +
        `Referidos: ${referrals}\n\n` +
        `Con /premium accedés a alertas ilimitadas.\n` +
        `O referí amigos para ganar +1 alerta extra por cada uno.`
      );
    }
    return;
  }

  if (cmd === "/premium") {
    const p = await getPlan(chatId);
    if (p.premium) {
      const sub = await prisma.subscriber.findUnique({ where: { chatId } });
      const exp = sub?.premiumUntil
        ? ` (vence el ${new Date(sub.premiumUntil).toLocaleDateString("es-AR")})`
        : "";
      await sendUser(chatId,
        `⭐ <b>Ya sos Premium</b>${escHtml(exp)}\n\nTenés alertas ilimitadas activas. ¡Gracias!`
      );
      return;
    }
    await sendUser(chatId,
      `⭐ <b>Bajó el Precio Premium</b>\n\n` +
      `Alertas ilimitadas, notificaciones más rápidas y sin restricciones.\n\n` +
      `⏳ Los planes de pago estarán disponibles próximamente. ¡Gracias por la paciencia!`
    );
    return;
  }

  if (cmd === "/apikey") {
    try {
      const existing = await prisma.apiKey.findFirst({ where: { name: `tg:${chatId}`, active: true } });
      if (existing) {
        await sendUser(chatId,
          `🔑 <b>Tu API key</b>\n\n` +
          `<code>${existing.key}</code>\n\n` +
          `Plan: ${existing.plan} · ${existing.dailyQuota.toLocaleString("es-AR")} req/día\n\n` +
          `📄 <a href="${PUBLIC_URL}/developers">Documentación</a>`
        );
      } else {
        const keyData = await createApiKey({ name: `tg:${chatId}`, plan: "free" });
        await sendUser(chatId,
          `🔑 <b>Tu API key gratuita</b>\n\n` +
          `<code>${keyData.key}</code>\n\n` +
          `100 requests/día · historial completo · sin tarjeta de crédito\n\n` +
          `📄 <a href="${PUBLIC_URL}/developers">Ver documentación y endpoints</a>`
        );
      }
    } catch (e) {
      console.error("[bot] apikey error:", e.message);
      await sendUser(chatId, "❌ No pude generar la API key. Intentá de nuevo.");
    }
    return;
  }

  if (cmd === "/borrar" || cmd === "/eliminar") {
    const alertId = text.split(" ")[1];
    if (!alertId) {
      await sendUser(chatId, "Uso: /borrar &lt;ID de la alerta&gt;\n\nVer IDs con /mis_alertas");
      return;
    }
    const parsed = parseInt(alertId, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      await sendUser(chatId, "❌ ID inválido. Usá el número que aparece en /mis_alertas");
      return;
    }
    try {
      const r = await unsubscribeAlert({ chatId, alertId: parsed });
      if (r.ok) {
        await sendUser(chatId, "✅ Alerta eliminada.");
      } else {
        await sendUser(chatId, "No encontré esa alerta. Verificá el ID con /mis_alertas");
      }
    } catch {
      await sendUser(chatId, "No pude eliminar la alerta. Verificá el ID con /mis_alertas");
    }
    return;
  }

  // Handle MercadoLibre URLs or IDs sent directly to the bot
  const mlUrlMatch = text.match(/mercadolibre\.com\.ar\/[^\s]+(?:MLA\d+|MLAU[\w]+)/i)
    || text.match(/(MLA[U]?\d+)/i);
  if (mlUrlMatch) {
    const idMatch = text.match(/\b(MLAU?[\w\d]+\d)/i);
    if (!idMatch) {
      await sendUser(chatId, "No pude encontrar el ID del producto. Mandame la URL completa de MercadoLibre.");
      return;
    }
    const productId = idMatch[1].toUpperCase();
    const data = await getHistory(productId);
    if (data.error === "not_found") {
      await sendUser(chatId,
        `🔍 <b>Producto no rastreado todavía</b>\n\n` +
        `ID: <code>${productId}</code>\n\n` +
        `Todavía no tenemos historial de este producto. Agregalo desde la web para empezar a rastrearlo:\n` +
        `${PUBLIC_URL}/p/${productId}`
      );
      return;
    }
    const statsLine = data.stats.count
      ? `Precio actual: <b>${fmtArs(data.stats.last)}</b> · Mínimo: ${fmtArs(data.stats.min)} · Máximo: ${fmtArs(data.stats.max)} · ${data.stats.count} registros`
      : "Juntando historial…";
    const result = await subscribeAlert({ chatId, productId });
    let alertLine;
    if (result.error === "limit") {
      alertLine = `\n\n⚠️ Llegaste al límite de alertas (${result.used}/${result.limit}). Activá /premium para más.`;
    } else if (result.created) {
      alertLine = `\n\n🔔 <b>Alerta activada.</b> Te aviso cuando baje de precio.`;
    } else {
      alertLine = `\n\n✅ Ya tenías una alerta para este producto.`;
    }
    await sendUser(chatId,
      `📦 <b>${escHtml(data.product.title.slice(0, 80))}</b>\n\n` +
      statsLine +
      `\n\n🌐 <a href="${PUBLIC_URL}/p/${productId}">Ver historial completo</a>` +
      alertLine
    );
    return;
  }
}

export async function telegramWebhookHandler(req, res) {
  res.sendStatus(200);
  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error("[bot] error:", e.message);
  }
}
