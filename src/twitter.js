// Twitter/X API v2 client — OAuth 1.0a signed with Node's built-in crypto.
// Required env vars (add via `fly secrets set`):
//   TWITTER_API_KEY, TWITTER_API_SECRET        — app credentials (Consumer Key/Secret)
//   TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET — account credentials (already authed)
import { createHmac, randomBytes } from "node:crypto";

const TWITTER_API = "https://api.twitter.com";

const pct = (s) => encodeURIComponent(String(s ?? ""));

function oauthSign(method, url, oauthParams, consumerSecret, tokenSecret) {
  const sortedPairs = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join("&");
  const base = `${method}&${pct(url)}&${pct(sortedPairs)}`;
  const sigKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  return createHmac("sha1", sigKey).update(base).digest("base64");
}

function buildAuthHeader(method, url, key, secret, tok, tokSec) {
  const nonce = randomBytes(16).toString("hex");
  const ts = String(Math.floor(Date.now() / 1000));
  const params = {
    oauth_consumer_key: key,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: ts,
    oauth_token: tok,
    oauth_version: "1.0",
  };
  params.oauth_signature = oauthSign(method, url, params, secret, tokSec);
  const parts = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`);
  return "OAuth " + parts.join(", ");
}

function creds() {
  const { TWITTER_API_KEY: key, TWITTER_API_SECRET: secret, TWITTER_ACCESS_TOKEN: tok, TWITTER_ACCESS_SECRET: tokSec } = process.env;
  if (!key || !secret || !tok || !tokSec) return null;
  return { key, secret, tok, tokSec };
}

/**
 * Post a single tweet. Returns the tweet ID or null if credentials missing.
 * @param {string} text
 * @param {string|null} [replyToId]
 */
export async function tweet(text, replyToId = null) {
  const c = creds();
  if (!c) { console.warn("[twitter] credenciales faltantes, skip"); return null; }

  const url = `${TWITTER_API}/2/tweets`;
  const auth = buildAuthHeader("POST", url, c.key, c.secret, c.tok, c.tokSec);
  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.errors) {
    console.error("[twitter] error:", JSON.stringify(data));
    return null;
  }
  console.log("[twitter] tweeted:", data.data.id);
  return data.data.id;
}

const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");

/**
 * Post top deals as a Twitter thread.
 * First tweet = top deal; replies = #2 and #3.
 */
export async function tweetDeals(deals) {
  if (!deals?.length) return;
  const baseUrl = process.env.PUBLIC_URL || "https://bajoelprecio.fly.dev";
  const top = deals[0];

  const anchor = [
    `🔥 ${top.title.slice(0, 90)}`,
    "",
    `${fmt(top.current)} — −${top.savingPct}% vs promedio histórico`,
    "",
    `Historial real: ${baseUrl}/p/${top.id}`,
    "",
    "#MercadoLibre #Ofertas #BajoElPrecio",
  ].join("\n");

  const anchorId = await tweet(anchor);
  if (!anchorId) return;

  let lastId = anchorId;
  for (const d of deals.slice(1, 3)) {
    const text = [
      `${fmt(d.current)} — −${d.savingPct}% vs promedio`,
      d.title.slice(0, 100),
      `${baseUrl}/p/${d.id}`,
    ].join("\n");
    const id = await tweet(text, lastId);
    if (id) lastId = id;
  }
}
