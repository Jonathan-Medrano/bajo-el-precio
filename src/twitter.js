// Twitter/X client via direct GraphQL API calls — no Playwright needed.
// Uses auth_token + ct0 from the persistent cookie store (twitter-session.json on the volume).
// Cookie transfer: scripts/login-twitter-manual.js (local) → /admin/set-twitter-cookies (prod)

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getCookies } from "./twitter-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_FILE = join(__dirname, "..", process.env.BROWSER_PROFILE || ".browser", "twitter-session.json");

// X's public bearer token (hardcoded in their JS bundle, used by the web app)
const BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// CreateTweet GraphQL query ID — update here if X changes it
const CREATE_TWEET_QUERY_ID = "SoVnbfCycZ7fERGCwpZkYA";

function loadCookies() {
  try {
    const raw = readFileSync(COOKIES_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function transactionId() {
  // x-client-transaction-id: X validates this loosely — it just needs to be present and look reasonable.
  // Format the web app uses: base64(keyBytes + timestamp + random)
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return Buffer.from(`${ts}${rand}`).toString("base64").replace(/=/g, "");
}

function getAuthHeaders() {
  const store = getCookies() || loadCookies();
  if (!store) return null;
  const find = (name) => store.find((c) => c.name === name)?.value;
  const auth_token = find("auth_token");
  const ct0 = find("ct0");
  if (!auth_token || !ct0) return null;
  return {
    Authorization: `Bearer ${BEARER}`,
    "Content-Type": "application/json",
    Cookie: `auth_token=${auth_token}; ct0=${ct0}`,
    "x-csrf-token": ct0,
    "x-client-transaction-id": transactionId(),
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": "es",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Origin: "https://x.com",
    Referer: "https://x.com/compose/post",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "accept-language": "es-AR,es;q=0.9",
  };
}

async function createTweetV1(text, headers) {
  // Legacy REST API — predates the GraphQL bot detection system
  const body = new URLSearchParams({ status: text.slice(0, 280) });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  const resp = await fetch("https://api.twitter.com/1.1/statuses/update.json", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
  const data = await resp.json();
  if (!resp.ok || data.errors) {
    const errMsg = data.errors?.[0]?.message ?? JSON.stringify(data).slice(0, 200);
    throw new Error(`v1 falló (${resp.status}): ${errMsg}`);
  }
  console.log(`[twitter-api] v1 tweet: ${data.id_str}`);
  return data.id_str;
}

async function createTweetGraphQL(text, headers) {
  const body = {
    variables: {
      tweet_text: text.slice(0, 280),
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
      disallowed_reply_options: null,
    },
    features: {
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: false,
      tweet_awards_web_tipping_enabled: false,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: false,
      rweb_video_timestamps_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
      interactive_text_enabled: true,
      responsive_web_text_conversations_enabled: false,
      responsive_web_enhance_cards_enabled: false,
    },
    queryId: CREATE_TWEET_QUERY_ID,
  };
  const ctrl2 = new AbortController();
  const timer2 = setTimeout(() => ctrl2.abort(), 15_000);
  const resp = await fetch(
    `https://x.com/i/api/graphql/${CREATE_TWEET_QUERY_ID}/CreateTweet`,
    { method: "POST", headers, body: JSON.stringify(body), signal: ctrl2.signal }
  ).finally(() => clearTimeout(timer2));
  const data = await resp.json();
  if (!resp.ok || data.errors) {
    const errMsg = data.errors?.[0]?.message ?? JSON.stringify(data).slice(0, 200);
    throw new Error(`GraphQL falló (${resp.status}): ${errMsg}`);
  }
  const tweetId = data.data?.create_tweet?.tweet_results?.result?.rest_id;
  console.log(`[twitter-api] GraphQL tweet: ${tweetId}`);
  return tweetId;
}

async function createTweet(text) {
  const headers = getAuthHeaders();
  if (!headers) throw new Error("sin cookies de Twitter — corré scripts/login-twitter-manual.js");

  // Try v1.1 first (older, less bot detection), fallback to GraphQL
  try {
    return await createTweetV1(text, headers);
  } catch (e1) {
    console.warn("[twitter-api] v1 falló, intentando GraphQL:", e1.message);
    return await createTweetGraphQL(text, headers);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");

/**
 * Post a single tweet. Returns tweet ID on success.
 */
export async function tweet(text) {
  try {
    return await createTweet(text);
  } catch (e) {
    console.error("[twitter-api] error:", e.message);
    throw e;
  }
}

/**
 * Post top deals — up to 3 sequential tweets.
 */
export async function tweetDeals(deals) {
  if (!deals?.length) return;
  const baseUrl = process.env.PUBLIC_URL || "https://bajoelprecio.fly.dev";
  const top = deals[0];
  const text = [
    `🔥 Mejores ofertas de MercadoLibre hoy`,
    "",
    top.title.slice(0, 80),
    `${fmt(top.current)} — −${top.savingPct}% vs histórico`,
    "",
    `👉 ${baseUrl}/p/${top.id}`,
    "",
    "#MercadoLibre #Ofertas #BajoElPrecio",
  ].join("\n").slice(0, 280);
  await createTweet(text);
  console.log("[twitter-api] digest publicado");
}

/**
 * Tweet a real-time price drop — mirrors the Telegram broadcast.
 */
export async function tweetPriceDrop({ title, currentPrice, prevMin, savingPct, productId, webUrl }) {
  const pctStr = savingPct > 0 ? `−${savingPct}%` : "nuevo mínimo";
  const text = [
    `📉 ${pctStr} en MercadoLibre`,
    "",
    title.slice(0, 85),
    "",
    `Ahora: ${fmt(currentPrice)} (antes mínimo: ${fmt(prevMin)})`,
    "",
    `👉 Historial real de precios: ${webUrl}`,
    "",
    "#MercadoLibre #BajoElPrecio #Ofertas #Argentina",
  ].join("\n").slice(0, 280);
  return tweet(text);
}
