#!/usr/bin/env node
// Reads Twitter cookies from the local .browser Playwright profile
// and uploads them to the production server so the bot can tweet.
//
// Usage: node scripts/export-twitter-cookies.js
//
// Requirements:
//   - The local .browser/ directory must have a Twitter session (already logged in)
//   - The production server must be running

import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = join(__dirname, "..", ".browser");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "60ec3fb79d1485a2";
const SERVER = process.env.SERVER_URL || "https://bajoelprecio.fly.dev";

console.log("Abriendo perfil local de Playwright en:", BROWSER_DIR);

const ctx = await chromium.launchPersistentContext(BROWSER_DIR, {
  headless: true,
  args: ["--disable-blink-features=AutomationControlled"],
});

// Get all cookies for x.com (Twitter)
const cookies = await ctx.cookies(["https://x.com", "https://twitter.com"]);
await ctx.close();

if (!cookies.length) {
  console.error("No se encontraron cookies para x.com/twitter.com.");
  console.error("Asegurate de haber iniciado sesión en Twitter dentro del perfil .browser/");
  process.exit(1);
}

// Filter to key auth cookies
const authCookies = cookies.filter(c =>
  ["auth_token", "ct0", "twid", "guest_id", "kdt", "remember_checked_on"].includes(c.name)
);

console.log(`Cookies totales: ${cookies.length}, auth relevantes: ${authCookies.length}`);
console.log("Cookies a subir:", authCookies.map(c => `${c.name}=${c.value.slice(0, 8)}...`).join(", "));

// Upload to production
const res = await fetch(`${SERVER}/admin/set-twitter-cookies`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-admin-token": ADMIN_TOKEN,
  },
  body: JSON.stringify({ cookies }),
});

const data = await res.json();
if (data.ok) {
  console.log(`✅ ${data.count} cookies subidas a producción.`);
  console.log("Ahora podés probar: curl -X POST https://bajoelprecio.fly.dev/admin/post-twitter -H \"x-admin-token: 60ec3fb79d1485a2\"");
} else {
  console.error("❌ Error del servidor:", data);
  process.exit(1);
}
