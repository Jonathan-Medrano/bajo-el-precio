import { listAlerts, unsubscribeAlert } from "./service.js";
import { sendUser } from "./telegram.js";
import { getPlan } from "./plans.js";

const PUBLIC_URL = process.env.PUBLIC_URL || "http://localhost:3000";

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const cmd = text.split(" ")[0].replace(/@.*$/, "").toLowerCase();

  if (cmd === "/start" || cmd === "/ayuda") {
    await sendUser(
      chatId,
      `📉 <b>Bajó el Precio</b> — historial real de precios de MercadoLibre.\n\n` +
      `Tu Chat ID es: <code>${chatId}</code>\n\n` +
      `<b>Comandos:</b>\n` +
      `• /mis_alertas — ver tus alertas activas\n` +
      `• /borrar &lt;ID&gt; — eliminar una alerta\n\n` +
      `🌐 Buscá cualquier producto en <a href="${PUBLIC_URL}">${PUBLIC_URL}</a> ` +
      `y activá la alerta desde ahí con tu Chat ID.`
    );
    return;
  }

  if (cmd === "/mis_alertas" || cmd === "/alertas") {
    const result = await listAlerts(chatId);
    if (!result.alerts?.length) {
      await sendUser(chatId, "No tenés alertas activas.\n\n🌐 Activalas desde " + PUBLIC_URL);
      return;
    }
    const plan = await getPlan(chatId);
    const lines = result.alerts.map((a, i) => {
      const target = a.targetPrice ? `$${Number(a.targetPrice).toLocaleString("es-AR")}` : "cualquier baja";
      return `${i + 1}. <b>${a.product.title.slice(0, 50)}</b>\n   ID: <code>${a.id}</code> · objetivo: ${target}`;
    });
    await sendUser(
      chatId,
      `🔔 <b>Tus alertas activas</b> (${result.alerts.length}/${plan.limit}):\n\n` +
      lines.join("\n\n") +
      `\n\nPara borrar: /borrar &lt;ID&gt;`
    );
    return;
  }

  if (cmd === "/borrar" || cmd === "/eliminar") {
    const alertId = text.split(" ")[1];
    if (!alertId) {
      await sendUser(chatId, "Uso: /borrar &lt;ID de la alerta&gt;\n\nVer IDs con /mis_alertas");
      return;
    }
    try {
      const r = await unsubscribeAlert({ chatId, alertId: Number(alertId) });
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
}

export async function telegramWebhookHandler(req, res) {
  res.sendStatus(200);
  try {
    await handleUpdate(req.body);
  } catch (e) {
    console.error("[bot] error:", e.message);
  }
}
