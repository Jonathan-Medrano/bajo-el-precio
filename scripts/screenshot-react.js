import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1180 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForSelector(".prod", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: "C:\\Users\\Usuario\\Desktop\\ideas\\keepa-ml\\react.png" });
console.log("screenshot -> keepa-ml/react.png");
if (errors.length) console.log("Errores de consola:", errors.slice(0, 5));
await browser.close();
