// Envío a Telegram (canal + DM) con fetch crudo. Mismo token que cazaofertas / precio-historico.
// Solo ENVIAMOS (sendMessage), no hacemos polling — así no chocamos con el bot de precio-historico,
// que es el único consumidor de getUpdates de ese token.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL = process.env.TELEGRAM_CHANNEL; // @bajoelprecio_ar
const ENABLED = process.env.ALERTS_ENABLED === "1";
const API = "https://api.telegram.org";

export function alertsEnabled() {
  return ENABLED && Boolean(TOKEN);
}

async function call(method, payload) {
  if (!TOKEN) throw new Error("falta TELEGRAM_BOT_TOKEN");
  const res = await fetch(`${API}/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.error_code} ${data.description}`);
  return data.result;
}

/** Postea al canal público (broadcast). */
export function sendChannel(text, reply_markup) {
  return call("sendMessage", {
    chat_id: CHANNEL,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup,
  });
}

/** DM a un usuario puntual (alerta personalizada). */
export function sendUser(chatId, text, reply_markup) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup,
  });
}
