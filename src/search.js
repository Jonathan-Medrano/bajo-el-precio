import { getContext } from "./ml/price-reader.js";
import { parseInstallments } from "./cuotas.js";

/** Scrapea resultados de búsqueda de ML: { title, price (real), previous, installments, international, condition, link, cuotas }. */
export async function searchListings(query, { limit = 40 } = {}) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  const slug = String(query).trim().toLowerCase().replace(/\s+/g, "-");
  const url = `https://listado.mercadolibre.com.ar/${slug}`;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .waitForSelector(".poly-card, li.ui-search-layout__item, .andes-money-amount__fraction", { timeout: 12000 })
      .catch(() => {});

    const listings = await page.evaluate((lim) => {
      const toInt = (s) => {
        if (!s) return null;
        const n = parseInt(String(s).replace(/[^\d]/g, ""), 10);
        return Number.isFinite(n) ? n : null;
      };
      const cards = [...document.querySelectorAll(".poly-card, li.ui-search-layout__item")];
      const out = [];
      const seen = new Set();
      for (const c of cards) {
        const title = c.querySelector(".poly-component__title, .ui-search-item__title, h2, h3")?.textContent?.trim();
        const price =
          toInt(c.querySelector(".poly-price__current .andes-money-amount__fraction")?.textContent) ??
          toInt(c.querySelector(".andes-money-amount__fraction")?.textContent);
        const previous = toInt(c.querySelector("s .andes-money-amount__fraction")?.textContent);
        const installments = c.querySelector(".poly-price__installments")?.textContent?.trim().replace(/\s+/g, " ") ?? null;
        const link =
          c.querySelector("a[href*='/p/'], a[href*='/up/'], a[href*='MLA-'], a[href*='articulo']")?.href ??
          c.querySelector("a")?.href ?? null;
        const international = /internacional|desde el exterior/i.test(c.innerHTML);
        const condition = /\busado\b|reacondicionad|refurbished|open ?box/i.test(c.innerText) ? "usado" : "nuevo";
        if (title && price && link && !seen.has(link)) {
          seen.add(link);
          out.push({ title, price, previous, installments, international, condition, link });
          if (out.length >= lim) break;
        }
      }
      return out;
    }, limit);
    return listings.map((l) => ({ ...l, cuotas: parseInstallments(l.installments) }));
  } finally {
    await page.close();
  }
}
