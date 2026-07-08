// Valida el código propio de la extensión (sin depender del anti-bot de ML):
//  1) detectId() contra URLs reales de ML
//  2) injectBox()/chartSVG() renderizando datos REALES de la API
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const API = "http://localhost:3000";

// 1) detectId — replicamos el regex del content.js y lo probamos.
function detectId(href) {
  const path = new URL(href).pathname;
  let m = path.match(/\/(?:p|up)\/(ML[A-Z]*\d+)/i);
  if (m) return m[1].toUpperCase();
  m = href.match(/(ML[A-Z]-?\d{6,})/i);
  if (m) return m[1].toUpperCase().replace("-", "");
  return null;
}
const cases = [
  ["https://www.mercadolibre.com.ar/up/MLAU3829685373", "MLAU3829685373"],
  ["https://www.mercadolibre.com.ar/p/MLA1234567", "MLA1234567"],
  ["https://articulo.mercadolibre.com.ar/MLA-987654321-celular", "MLA987654321"],
  ["https://www.mercadolibre.com.ar/ofertas", null],
];
console.log("— detectId —");
let allOk = true;
for (const [url, exp] of cases) {
  const got = detectId(url);
  const ok = got === exp;
  allOk = allOk && ok;
  console.log(`${ok ? "✅" : "❌"} ${url.slice(28)} -> ${got} (esperado ${exp})`);
}

// 2) Tomamos un producto real CON historial y renderizamos el box.
const list = await fetch(`${API}/api/products`).then((r) => r.json());
const withHistory = list.find((p) => p._count.prices >= 2) || list[0];
const data = await fetch(`${API}/api/product/${withHistory.id}`).then((r) => r.json());
console.log(`\n— render — producto ${withHistory.id} (${data.stats.count} puntos)`);

const ctx = await chromium.launchPersistentContext(".browser-render", { headless: true, viewport: { width: 520, height: 700 } });
const page = await ctx.newPage();
try {
  await page.goto("about:blank");
  const css = readFileSync("extension/content.css", "utf8");
  const js = readFileSync("extension/content.js", "utf8");
  await page.evaluate((c) => { const s = document.createElement("style"); s.textContent = c; document.head.appendChild(s); }, css);
  // Exponemos las funciones internas para invocar el render con datos reales.
  await page.evaluate(`(()=>{${js}\nwindow.__bp={injectBox,chartSVG};})()`);
  await page.evaluate(({ id, d }) => window.__bp.injectBox(id, d), { id: withHistory.id, d: data });
  await page.waitForSelector("#bp-box", { timeout: 5000 });
  const verdict = await page.$eval(".bp-verdict", (e) => e.textContent.trim());
  const cta = await page.$eval(".bp-cta", (e) => e.getAttribute("href"));
  const hasChart = await page.$(".bp-chart").then(Boolean);
  console.log("✅ BOX INYECTADO");
  console.log("   veredicto:", verdict);
  console.log("   gráfico SVG:", hasChart ? "sí" : "no (pocos puntos)");
  console.log("   CTA:", cta);
  await page.$("#bp-box").then((b) => b.screenshot({ path: "extension-box.png" }));
  console.log("   screenshot -> keepa-ml/extension-box.png");
} catch (e) {
  console.log("❌ render falló:", e.message);
} finally {
  await ctx.close();
}
console.log(allOk ? "\n✅ detectId: todos los casos OK" : "\n❌ detectId: revisar");
