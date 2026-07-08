import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 980 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForSelector(".prod", { timeout: 20000 });
await page.click(".prod"); // primer producto (A16)
await page.waitForSelector(".modal", { timeout: 10000 }).catch(() => {});
await page.waitForSelector(".cprice", { timeout: 30000 }).catch(() => {}); // espera la comparación
await page.waitForTimeout(800);
await page.screenshot({ path: "C:\\Users\\Usuario\\Desktop\\ideas\\keepa-ml\\react-modal.png" });
console.log("screenshot -> keepa-ml/react-modal.png");
if (errors.length) console.log("Errores:", errors.slice(0, 5));
await browser.close();
