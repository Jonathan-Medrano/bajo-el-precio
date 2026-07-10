// Twitter/X client via Playwright — reuses the shared ML browser context (same .browser profile).
// No API key needed. The persistent profile at .browser/ already has the Twitter session.
//
// If the session expires, set TWITTER_EMAIL + TWITTER_PASSWORD for automatic re-login.
// TWITTER_USERNAME is optional — X sometimes asks for it as a verification step.

import { getContext } from "./ml/price-reader.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

function twitterCreds() {
  const { TWITTER_EMAIL: email, TWITTER_PASSWORD: password, TWITTER_USERNAME: username } = process.env;
  return email && password ? { email, password, username } : null;
}

async function doGoogleLogin(page, creds) {
  // Google OAuth flow: x.com → accounts.google.com → x.com
  await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(jitter(1500, 2500));

  // Click "Continue with Google"
  const googleBtn = page.locator('[data-testid="google.login"], a[href*="google"], [role="button"]:has-text("Google")').first();
  await googleBtn.waitFor({ state: "visible", timeout: 10000 });
  await googleBtn.click();
  await sleep(jitter(2000, 3500));

  // Google: enter email
  const emailInput = page.locator('input[type="email"], input#identifierId').first();
  await emailInput.waitFor({ state: "visible", timeout: 15000 });
  await emailInput.type(creds.email, { delay: jitter(80, 140) });
  await sleep(jitter(500, 900));
  await page.locator('#identifierNext, [jsname="LgbsSe"]').first().click()
    .catch(() => page.keyboard.press("Enter"));
  await sleep(jitter(2000, 3000));

  // Google: enter password
  const pwInput = page.locator('input[type="password"]').first();
  await pwInput.waitFor({ state: "visible", timeout: 15000 });
  await pwInput.type(creds.password, { delay: jitter(80, 140) });
  await sleep(jitter(500, 900));
  await page.locator('#passwordNext, [jsname="LgbsSe"]').first().click()
    .catch(() => page.keyboard.press("Enter"));
  await sleep(jitter(4000, 6000));

  // Dismiss any "Allow" / "Continue" consent screen if present
  const allowBtn = page.locator('[data-idom-class*="allow"], button:has-text("Allow"), button:has-text("Continue")').first();
  if (await allowBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await allowBtn.click();
    await sleep(jitter(2000, 3000));
  }
}

async function doDirectLogin(page, creds) {
  // Native X email+password flow (for accounts not using Google OAuth)
  await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(jitter(1500, 2500));

  const emailInput = await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
  await emailInput.click();
  await page.keyboard.type(creds.email, { delay: jitter(80, 140) });
  await sleep(jitter(500, 900));
  await page.locator('[role="button"]:has-text("Next"), [data-testid="LoginForm_Forward_Button"]')
    .first().click().catch(() => page.keyboard.press("Enter"));
  await sleep(jitter(1500, 2500));

  // Username verification (X sometimes asks)
  const verifyInput = page.locator('[data-testid="ocfEnterTextTextInput"]');
  if (await verifyInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    const handle = creds.username || creds.email.split("@")[0];
    await verifyInput.type(handle, { delay: jitter(80, 140) });
    await sleep(jitter(400, 800));
    await page.locator('[data-testid="ocfEnterTextNextButton"]').click()
      .catch(() => page.keyboard.press("Enter"));
    await sleep(jitter(1500, 2000));
  }

  const pwInput = await page.waitForSelector('input[name="password"]', { timeout: 12000 });
  await pwInput.click();
  await page.keyboard.type(creds.password, { delay: jitter(80, 140) });
  await sleep(jitter(500, 900));
  await page.keyboard.press("Enter");
  await sleep(jitter(3000, 5000));
}

async function doLogin(page, creds) {
  console.log("[twitter-pw] sesión expirada, relogueando...");

  // Try Google OAuth first (account linked to Google), fallback to direct login
  const useGoogle = process.env.TWITTER_USE_GOOGLE !== "0";
  if (useGoogle) {
    await doGoogleLogin(page, creds);
  } else {
    await doDirectLogin(page, creds);
  }

  const loggedIn = await page.locator(
    '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]'
  ).first().isVisible({ timeout: 20000 }).catch(() => false);
  if (!loggedIn) {
    console.warn("[twitter-pw] Google login falló, reintentando con login directo...");
    await doDirectLogin(page, creds);
    const ok = await page.locator(
      '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]'
    ).first().isVisible({ timeout: 20000 }).catch(() => false);
    if (!ok) throw new Error(`login falló (${page.url()}) — verificá credenciales o 2FA`);
  }
  console.log("[twitter-pw] login exitoso");
}

async function ensureLoggedIn(page) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(jitter(1500, 2500));
  const url = page.url();
  if (!url.includes("/login") && !url.includes("/flow/login") && !url.includes("/i/flow")) return;

  const creds = twitterCreds();
  if (!creds) throw new Error("sesión de Twitter expirada y sin credenciales (TWITTER_EMAIL/PASSWORD)");
  await doLogin(page, creds);
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(jitter(2000, 3000));
}

async function composeAndPost(page, text) {
  // Navigate directly to the compose URL — avoids home page overlay intercept issues
  await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(jitter(2000, 3000));

  // The compose modal: textarea or contenteditable div
  const compose = page.locator('[data-testid="tweetTextarea_0"], [contenteditable="true"][data-lexical-editor="true"]').first();
  await compose.waitFor({ state: "visible", timeout: 15000 });
  await compose.click({ force: true });
  await sleep(jitter(400, 800));
  await page.keyboard.type(text.slice(0, 280), { delay: jitter(25, 60) });
  await sleep(jitter(800, 1500));

  // "Post" button — try both inline and modal variants
  const postBtn = page.locator('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]').first();
  await postBtn.waitFor({ state: "visible", timeout: 10000 });
  await postBtn.click({ force: true });
  await sleep(jitter(3000, 5000));
}

/**
 * Post a single tweet using the shared ML browser context.
 * Returns true on success.
 */
export async function tweet(text) {
  let page;
  try {
    const ctx = await getContext();
    page = await ctx.newPage();
    await ensureLoggedIn(page);
    await composeAndPost(page, text);
    console.log("[twitter-pw] tweet publicado");
    return true;
  } catch (e) {
    console.error("[twitter-pw] error:", e.message);
    return false;
  } finally {
    await page?.close();
  }
}

const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");

/**
 * Post top deals — 3 sequential tweets (one per deal).
 */
export async function tweetDeals(deals) {
  if (!deals?.length) return;
  const baseUrl = process.env.PUBLIC_URL || "https://bajoelprecio.fly.dev";
  let page;
  try {
    const ctx = await getContext();
    page = await ctx.newPage();
    await ensureLoggedIn(page);

    const top = deals[0];
    const anchorText = [
      `🔥 Las mejores ofertas de MercadoLibre hoy`,
      "",
      `${top.title.slice(0, 75)} — ${fmt(top.current)} (−${top.savingPct}% vs promedio)`,
      "",
      `👉 Ver historial: ${baseUrl}/p/${top.id}`,
      "",
      "Más abajo 👇 #MercadoLibre #Ofertas #BajoElPrecio",
    ].join("\n").slice(0, 280);

    await composeAndPost(page, anchorText);

    for (const d of deals.slice(1, 3)) {
      const text = [
        `📉 ${fmt(d.current)} — −${d.savingPct}% vs promedio histórico`,
        "",
        d.title.slice(0, 100),
        "",
        `👉 ${baseUrl}/p/${d.id}`,
        "#MercadoLibre #BajoElPrecio",
      ].join("\n").slice(0, 280);

      await composeAndPost(page, text);
    }

    console.log("[twitter-pw] digest publicado");
  } catch (e) {
    console.error("[twitter-pw] tweetDeals error:", e.message);
  } finally {
    await page?.close();
  }
}

/**
 * Tweet a real-time price drop alert — mirrors Telegram channel broadcast.
 * Format: price drop info + link to product history page (traffic driver).
 */
export async function tweetPriceDrop({ title, currentPrice, prevMin, savingPct, productId, webUrl }) {
  const pctStr = savingPct > 0 ? `−${savingPct}%` : "nuevo mínimo";
  // Keep title short enough that the URL fits in 280 chars
  const shortTitle = title.slice(0, 85);
  const text = [
    `📉 ${pctStr} en MercadoLibre`,
    "",
    shortTitle,
    "",
    `Ahora: ${fmt(currentPrice)} (antes mínimo: ${fmt(prevMin)})`,
    "",
    `👉 Historial real de precios: ${webUrl}`,
    "",
    "#MercadoLibre #BajoElPrecio #Ofertas #Argentina",
  ].join("\n").slice(0, 280);
  return tweet(text);
}
