#!/usr/bin/env node
// Opens a browser, checks if already logged in to Twitter.
// If not: waits for you to log in (120s or ENTER).
// Then exports cookies to production.
//
// Usage (real terminal): node scripts/login-twitter-manual.js

import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = join(__dirname, "..", ".browser");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) { console.error("Falta ADMIN_TOKEN. Setealo: $env:ADMIN_TOKEN='tu-token'"); process.exit(1); }
const SERVER = process.env.SERVER_URL || "https://bajoelprecio.fly.dev";

console.log("Abriendo browser...");
const ctx = await chromium.launchPersistentContext(BROWSER_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = await ctx.newPage();
await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 30000 });
await new Promise(r => setTimeout(r, 3000));

const url = page.url();
const isLoggedIn = !url.includes("/login") && !url.includes("/flow") &&
  await page.locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"]')
    .first().isVisible({ timeout: 5000 }).catch(() => false);

if (isLoggedIn) {
  console.log("✅ Ya estás logueado. Exportando cookies...");
} else {
  console.log("\n👆 No hay sesión activa. Iniciá sesión como @bajoelprecio_ar.");
  console.log("   Tenés 120 segundos (o presioná ENTER cuando estés listo).\n");

  await Promise.race([
    new Promise((resolve) => {
      if (!process.stdin.isTTY) return;
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.once("data", resolve);
    }),
    new Promise((resolve) => setTimeout(resolve, 120_000)),
  ]);

  console.log("\nExportando cookies...");
}

// Extract BEFORE closing
let cookies;
try {
  cookies = await ctx.cookies(["https://x.com", "https://twitter.com"]);
} catch (e) {
  console.error("Error al leer cookies:", e.message);
  process.exit(1);
}

await ctx.close();

if (!cookies.length) {
  console.error("Sin cookies — ¿cerraste el browser antes de tiempo?");
  process.exit(1);
}

const hasAuth = cookies.some(c => c.name === "auth_token");
if (!hasAuth) {
  console.error("Falta auth_token — la sesión no quedó guardada.");
  process.exit(1);
}

const authCookies = cookies.filter(c => ["auth_token", "ct0", "twid"].includes(c.name));
console.log(`Cookies: ${cookies.length} total, ${authCookies.length} de auth.`);
console.log("twid:", authCookies.find(c => c.name === "twid")?.value?.slice(0, 20) + "...");

console.log("\nSubiendo a producción...");
const res = await fetch(`${SERVER}/admin/set-twitter-cookies`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
  body: JSON.stringify({ cookies }),
});

const data = await res.json();
if (data.ok) {
  console.log(`✅ ${data.count} cookies subidas.`);
  console.log('\nProbá: curl -X POST https://bajoelprecio.fly.dev/admin/post-twitter -H "x-admin-token: $ADMIN_TOKEN"');
} else {
  console.error("❌ Error:", data);
  process.exit(1);
}
