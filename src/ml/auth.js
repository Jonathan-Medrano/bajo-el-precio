// Token de la API de ML via client_credentials (solo para DESCUBRIR productos populares).
const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
let cached = null;

export async function getAppToken() {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.ML_CLIENT_ID ?? "",
    client_secret: process.env.ML_CLIENT_SECRET ?? "",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`token ML fallo: HTTP ${res.status}`);
  const data = await res.json();
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 21_600) * 1000 };
  return cached.token;
}
