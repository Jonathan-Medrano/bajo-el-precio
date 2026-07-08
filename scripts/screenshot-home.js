import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForSelector(".sidebar", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(700);
await page.screenshot({ path: "C:\\Users\\Usuario\\Desktop\\ideas\\keepa-ml\\home.png" });
console.log("screenshot -> keepa-ml/home.png");
if (errors.length) console.log("Errores:", errors.slice(0, 5));
await browser.close();
