#!/usr/bin/env node
// Opens a real browser window so you can log in to Twitter manually.
// After you log in, press ENTER in this terminal.
// The script then exports your cookies and uploads them to production.
//
// Usage: node scripts/login-twitter-manual.js

import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BROWSER_DIR = join(__dirname, "..", ".browser");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "60ec3fb79d1485a2";
const SERVER = process.env.SERVER_URL || "https://bajoelprecio.fly.dev";

console.log("Abriendo browser en modo VISIBLE para login manual...");
console.log("Perfil:", BROWSER_DIR);

const ctx = await chromium.launchPersistentContext(BROWSER_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = await ctx.newPage();
await page.goto("https://x.com/login");

console.log("\n👆 Iniciá sesión en la ventana del browser que se abrió.");
console.log('   Si te pide "Sign in with Google", hacelo normalmente.');
console.log("\n⏎  Cuando estés logueado y veas tu feed, presioná ENTER acá:");

// Wait for user to confirm login
const rl = createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => rl.question("", resolve));
rl.close();

// Extract cookies
const cookies = await ctx.cookies(["https://x.com", "https://twitter.com"]);
await ctx.close();

if (!cookies.length) {
  console.error("No se encontraron cookies. ¿Iniciaste sesión correctamente?");
  process.exit(1);
}

const authCookies = cookies.filter(c =>
  ["auth_token", "ct0", "twid"].includes(c.name)
);
console.log(`\n✅ Cookies obtenidas: ${cookies.length} total, ${authCookies.length} de auth.`);

// Upload to production
console.log("Subiendo cookies a producción...");
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
  console.log('\nProbá el primer tweet con:');
  console.log('  curl -X POST https://bajoelprecio.fly.dev/admin/post-twitter -H "x-admin-token: 60ec3fb79d1485a2"');
} else {
  console.error("❌ Error del servidor:", data);
  process.exit(1);
}
