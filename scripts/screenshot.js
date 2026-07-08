import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 880, height: 820 } });
await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await page.fill("#url", "https://www.mercadolibre.com.ar/up/MLAU3829685373");
await page.click("#go");
await page.waitForSelector("#result", { state: "visible", timeout: 40000 }).catch(() => {});
await page.waitForTimeout(2500); // que renderice el gráfico
await page.screenshot({ path: "C:\\Users\\Usuario\\Desktop\\ideas\\keepa-ml\\demo.png" });
console.log("screenshot -> keepa-ml/demo.png");
await browser.close();
