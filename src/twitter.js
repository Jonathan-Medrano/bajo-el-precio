import crypto from "node:crypto";

const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const TWITTER_API_SECRET = process.env.TWITTER_API_SECRET;
const TWITTER_ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const TWITTER_ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;

// In-memory rate limit: max 10 tweets/day, 24h cooldown per product
const posted = new Map(); // productId -> lastTimestamp
let dayCounter = 0;
let currentDay = 0;
const MAX_PER_DAY = 10;
const COOLDOWN = 24 * 3_600_000;

function pct(s) {
  return encodeURIComponent(String(s))
    .replace(/!/g, "%21").replace(/'/g, "%27")
    .replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\*/g, "%2A");
}

function sign(method, url, params, consumerSecret, tokenSecret) {
  const sorted = Object.keys(params).sort().map(k => `${pct(k)}=${pct(params[k])}`).join("&");
  const base = `${method}&${pct(url)}&${pct(sorted)}`;
  const key = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  return crypto.createHmac("sha1", key).update(base).digest("base64");
}

export async function tweetPriceDrop({ title, currentPrice, prevMin, savingPct, productId, webUrl }) {
  if (!TWITTER_API_KEY) return; // secrets not configured, skip silently

  const now = Date.now();
  const today = Math.floor(now / 86_400_000);
  if (currentDay !== today) { currentDay = today; dayCounter = 0; }
  if (dayCounter >= MAX_PER_DAY) return;
  const lastPosted = posted.get(productId);
  if (lastPosted && (now - lastPosted) < COOLDOWN) return;

  const fmt = n => "$" + Number(n).toLocaleString("es-AR");
  const text = [
    `📉 ${title.slice(0, 80).trim()}`,
    ``,
    `💵 Ahora: ${fmt(currentPrice)}`,
    savingPct > 0 ? `📊 Nuevo mínimo (antes ${fmt(prevMin)}, -${savingPct}%)` : "",
    ``,
    `Ver historial → ${webUrl}`,
    ``,
    `#MercadoLibre #Ofertas #Argentina`,
  ].filter(l => l !== null).join("\n");

  const tweetUrl = "https://api.twitter.com/2/tweets";
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = String(Math.floor(now / 1000));

  const oauthParams = {
    oauth_consumer_key: TWITTER_API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: ts,
    oauth_token: TWITTER_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  oauthParams.oauth_signature = sign("POST", tweetUrl, oauthParams, TWITTER_API_SECRET, TWITTER_ACCESS_SECRET);

  const authHeader = "OAuth " + Object.keys(oauthParams).sort()
    .map(k => `${pct(k)}="${pct(oauthParams[k])}"`)
    .join(", ");

  try {
    const r = await fetch(tweetUrl, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!r.ok) {
      console.warn(`[twitter] ${r.status}: ${await r.text()}`);
      return;
    }
    dayCounter++;
    posted.set(productId, now);
    console.log(`[twitter] tweeted: ${title.slice(0, 50)}`);
  } catch (e) {
    console.warn(`[twitter] ${e.message}`);
  }
}
