// Resend email client — single HTTP POST, no npm package needed.
// Required env var: RESEND_API_KEY
// Optional:         FROM_EMAIL (defaults to onboarding@resend.dev for sandbox)
//
// To use in production: verify your domain at resend.com and set FROM_EMAIL.

const RESEND_API = "https://api.resend.com/emails";

function emailCreds() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return { key, from: process.env.FROM_EMAIL || "Bajó el Precio <onboarding@resend.dev>" };
}

const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");

/**
 * Send a price-drop notification email.
 * Returns true on success, false if credentials missing or request fails.
 */
export async function sendPriceDropEmail({ to, productTitle, currentPrice, targetPrice, productUrl, historyUrl }) {
  const c = emailCreds();
  if (!c) { console.warn("[email] RESEND_API_KEY faltante, skip"); return false; }

  const subject = `📉 Bajó el precio: ${productTitle.slice(0, 60)}`;
  const objetivo = targetPrice ? `<p style="margin:0 0 16px">Tu objetivo era <strong>${fmt(targetPrice)}</strong> — ¡ya está por debajo!</p>` : "";

  const html = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:system-ui,sans-serif;color:#111827">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
    <tr>
      <td style="background:#e64c1e;padding:20px 24px">
        <span style="color:#fff;font-weight:700;font-size:18px">📉 Bajó el Precio</span>
      </td>
    </tr>
    <tr>
      <td style="padding:24px">
        <p style="margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Alerta de precio</p>
        <p style="margin:0 0 16px;font-size:17px;font-weight:600;line-height:1.4">${productTitle}</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:#dcfce7;border-radius:8px;padding:14px 18px;width:100%">
          <tr>
            <td>
              <p style="margin:0;font-size:26px;font-weight:800;color:#14532d">${fmt(currentPrice)}</p>
              <p style="margin:4px 0 0;font-size:13px;color:#16a34a">Nuevo precio registrado</p>
            </td>
          </tr>
        </table>
        ${objetivo}
        <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%">
          <tr>
            <td style="padding-right:8px;width:50%">
              <a href="${productUrl}" style="display:block;text-align:center;background:#e64c1e;color:#fff;font-weight:600;font-size:14px;padding:12px;border-radius:8px;text-decoration:none">Comprar en ML</a>
            </td>
            <td style="padding-left:8px;width:50%">
              <a href="${historyUrl}" style="display:block;text-align:center;background:#f3f4f6;color:#374151;font-weight:600;font-size:14px;padding:12px;border-radius:8px;text-decoration:none">Ver historial</a>
            </td>
          </tr>
        </table>
        <p style="margin:0;font-size:12px;color:#9ca3af">Recibís este email porque lo pediste en <a href="https://bajoelprecio.fly.dev" style="color:#e64c1e">bajoelprecio.fly.dev</a>. No compartimos tu email con nadie.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: c.from, to: [to], subject, html }),
    });
    const data = await res.json();
    if (!res.ok || data.statusCode >= 400) {
      console.error("[email] error:", JSON.stringify(data));
      return false;
    }
    console.log("[email] enviado a", to, "id:", data.id);
    return true;
  } catch (e) {
    console.error("[email] fetch error:", e.message);
    return false;
  }
}
