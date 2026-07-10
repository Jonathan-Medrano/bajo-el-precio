// Twitter/X client via Playwright — no API key needed.
// Uses a persistent browser profile to survive restarts (stored in .browser/twitter/).
//
// Required env vars:
//   TWITTER_EMAIL    — email o username de la cuenta
//   TWITTER_PASSWORD — contraseña
// Optional:
//   TWITTER_USERNAME — username (@handle) para el paso de verificación que X a veces pide

import { chromium } from "playwright";
import { join } from "node:path";

const BROWSER_DIR = join(process.cwd(), process.env.BROWSER_PROFILE || ".browser", "twitter");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

function twitterCreds() {
  const { TWITTER_EMAIL: email, TWITTER_PASSWORD: password, TWITTER_USERNAME: username } = process.env;
  if (!email || !password) return null;
  return { email, password, username };
}

async function openContext() {
  return chromium.launchPersistentContext(BROWSER_DIR, {
    headless: process.env.HEADLESS !== "0",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
}

async function doLogin(page, creds) {
  console.log("[twitter-pw] iniciando login...");
  await page.goto("https://x.com/i/flow/login", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(jitter(1500, 2500));

  // Step 1: email / username
  const emailInput = await page.waitForSelector('input[autocomplete="username"]', { timeout: 15000 });
  await emailInput.click();
  await page.keyboard.type(creds.email, { delay: jitter(80, 140) });
  await sleep(jitter(500, 900));

  // Click "Next"
  await page.locator('[role="button"]:has-text("Next"), [data-testid="LoginForm_Forward_Button"]')
    .first().click().catch(() => page.keyboard.press("Enter"));
  await sleep(jitter(1500, 2500));

  // Step 1.5: X sometimes asks for username to verify it's you
  const verifyInput = page.locator('[data-testid="ocfEnterTextTextInput"]');
  if (await verifyInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    const handle = creds.username || creds.email.split("@")[0];
    await verifyInput.type(handle, { delay: jitter(80, 140) });
    await sleep(jitter(400, 800));
    await page.locator('[data-testid="ocfEnterTextNextButton"]').click()
      .catch(() => page.keyboard.press("Enter"));
    await sleep(jitter(1500, 2000));
  }

  // Step 2: password
  const pwInput = await page.waitForSelector('input[name="password"]', { timeout: 12000 });
  await pwInput.click();
  await page.keyboard.type(creds.password, { delay: jitter(80, 140) });
  await sleep(jitter(500, 900));
  await page.keyboard.press("Enter");
  await sleep(jitter(3000, 5000));

  // Verify we're logged in
  const loggedIn = await page.locator(
    '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], [aria-label="Home timeline"]'
  ).first().isVisible({ timeout: 20000 }).catch(() => false);

  if (!loggedIn) {
    // Check if 2FA is blocking us
    const url = page.url();
    throw new Error(`login falló (url: ${url}) — ¿2FA activo? Configurá TWITTER_USERNAME si lo pedía`);
  }
  console.log("[twitter-pw] login exitoso");
}

async function isLoggedIn(page) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(jitter(1500, 2500));
  const url = page.url();
  return !url.includes("/login") && !url.includes("/flow/login") && !url.includes("/i/flow");
}

/**
 * Post a single tweet. Returns true on success.
 */
export async function tweet(text) {
  const creds = twitterCreds();
  if (!creds) { console.warn("[twitter-pw] credenciales faltantes, skip"); return false; }

  let ctx;
  try {
    ctx = await openContext();
    const page = await ctx.newPage();

    // Navigate home; login if session expired
    const logged = await isLoggedIn(page);
    if (!logged) {
      await doLogin(page, creds);
      // After login, navigate to home
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(jitter(2000, 3000));
    }

    // Find and click compose box
    const compose = page.locator('[data-testid="tweetTextarea_0"], [aria-label="Post text"][contenteditable="true"]').first();
    await compose.waitFor({ timeout: 15000 });
    await compose.click();
    await sleep(jitter(500, 900));

    // Type tweet text (280 char limit enforced by X, we trim)
    const safeText = text.slice(0, 280);
    await page.keyboard.type(safeText, { delay: jitter(25, 60) });
    await sleep(jitter(800, 1500));

    // Click "Post" button
    const postBtn = page.locator('[data-testid="tweetButtonInline"]').first();
    await postBtn.waitFor({ timeout: 10000 });
    await postBtn.click();
    await sleep(jitter(3000, 5000));

    console.log("[twitter-pw] tweet publicado");
    await page.close();
    return true;
  } catch (e) {
    console.error("[twitter-pw] error:", e.message);
    return false;
  } finally {
    if (ctx) await ctx.close();
  }
}

const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");

/**
 * Post top deals — anchor tweet + 2 reply tweets (thread).
 * Playwright version: posts each tweet sequentially; thread replies via the "Reply" button.
 */
export async function tweetDeals(deals) {
  if (!deals?.length) return;
  const creds = twitterCreds();
  if (!creds) { console.warn("[twitter-pw] credenciales faltantes, skip"); return; }

  const baseUrl = process.env.PUBLIC_URL || "https://bajoelprecio.fly.dev";
  let ctx;
  try {
    ctx = await openContext();
    const page = await ctx.newPage();

    const logged = await isLoggedIn(page);
    if (!logged) {
      await doLogin(page, creds);
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(jitter(2000, 3000));
    }

    // Post anchor tweet (top deal)
    const top = deals[0];
    const anchorText = [
      `🔥 ${top.title.slice(0, 90)}`,
      "",
      `${fmt(top.current)} — −${top.savingPct}% vs promedio histórico`,
      "",
      `Historial real: ${baseUrl}/p/${top.id}`,
      "",
      "#MercadoLibre #Ofertas #BajoElPrecio",
    ].join("\n").slice(0, 280);

    const compose = page.locator('[data-testid="tweetTextarea_0"]').first();
    await compose.waitFor({ timeout: 15000 });
    await compose.click();
    await page.keyboard.type(anchorText, { delay: jitter(25, 55) });
    await sleep(jitter(800, 1500));

    await page.locator('[data-testid="tweetButtonInline"]').first().click();
    await sleep(jitter(4000, 6000));

    // Post remaining deals as follow-up tweets (not threaded for simplicity — threading requires URL extraction)
    for (const d of deals.slice(1, 3)) {
      const followText = [
        `${fmt(d.current)} — −${d.savingPct}% vs promedio`,
        d.title.slice(0, 100),
        `${baseUrl}/p/${d.id}`,
        "#MercadoLibre #BajoElPrecio",
      ].join("\n").slice(0, 280);

      // X sometimes doesn't re-open compose after posting — click the box again
      await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(jitter(2000, 3000));

      const box = page.locator('[data-testid="tweetTextarea_0"]').first();
      await box.waitFor({ timeout: 15000 });
      await box.click();
      await page.keyboard.type(followText, { delay: jitter(25, 55) });
      await sleep(jitter(800, 1500));
      await page.locator('[data-testid="tweetButtonInline"]').first().click();
      await sleep(jitter(4000, 6000));
    }

    console.log("[twitter-pw] digest publicado");
    await page.close();
  } catch (e) {
    console.error("[twitter-pw] tweetDeals error:", e.message);
  } finally {
    if (ctx) await ctx.close();
  }
}

/**
 * Tweet a real-time price drop alert (fired from alerts.js when pct >= 10).
 */
export async function tweetPriceDrop({ title, currentPrice, prevMin, savingPct, productId, webUrl }) {
  const text = [
    `📉 ¡Bajó el precio!`,
    "",
    `${title.slice(0, 80)}`,
    "",
    `${fmt(currentPrice)} — −${savingPct}% vs mínimo anterior (${fmt(prevMin)})`,
    "",
    `Historial real: ${webUrl}`,
    "",
    "#MercadoLibre #BajoElPrecio #Ofertas",
  ].join("\n").slice(0, 280);
  return tweet(text);
}
