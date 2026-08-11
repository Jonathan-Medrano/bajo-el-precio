// Descubrimiento de productos populares para trackear.
// ML le cerro el acceso de LECTURA a la API oficial a esta app (403 PolicyAgent en
// /sites/.../categories, /categories/:id Y /highlights - probado con y sin token,
// con client_credentials Y con Authorization Code). Scrapeamos el listado publico
// con el mismo browser/sesion que ya usa price-reader.js para leer precios.
import { getContext } from "./price-reader.js";
import { CATEGORIES } from "../categories.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * (max - min));

// Tope de productos por categoria: cada uno despues se trackea individual.
const MAX_PER_CATEGORY = 30;

const CHALLENGE_RE = /por seguridad|completá este paso|completa este paso|captcha|are you a robot|ingresa a tu cuenta|ingresá a tu cuenta/i;

// Saca tildes y puntuacion (ej. "Electrónica, Audio y Video" -> "electronica-audio-y-video"):
// sin esto el slug queda invalido para nombres con acentos o comas y la categoria no matchea nada.
const slugify = (name) => name
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, "")
  .trim()
  .replace(/\s+/g, "-");

/**
 * Descubre productos populares recorriendo el listado publico de cada categoria.
 * Mantiene el contrato previo: devuelve [{ id, category }].
 * @param {{ onProgress?: (i:{done:number,total:number,found:number,group:string})=>void }} opts
 * @returns {Promise<Array<{id:string, category:string}>>}
 */
export async function discoverProducts({ onProgress } = {}) {
  const ctx = await getContext();
  const seen = new Map(); // id -> category

  let done = 0;
  for (const cat of CATEGORIES) {
    const page = await ctx.newPage();
    try {
      const url = `https://listado.mercadolibre.com.ar/${slugify(cat.name)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(jitter(1500, 2800));

      const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
      if (CHALLENGE_RE.test(bodyText) || /account-verification|\/gz\//.test(page.url())) {
        console.warn(`  discover ${cat.id} (${cat.name}) -> desafio/login anti-bot, salteo`);
        continue;
      }

      const hrefs = await page.evaluate(() => {
        const cards = document.querySelectorAll(
          ".ui-search-result__wrapper, .poly-card, [class*='ui-search-result']"
        );
        const out = [];
        cards.forEach((card) => {
          const link = card.querySelector(
            "a.poly-component__title, a[class*='title'], a[href*='mercadolibre'], a[href*='articulo']"
          );
          if (link?.href) out.push(link.href);
        });
        return out;
      });

      let taken = 0;
      for (const href of hrefs) {
        if (taken >= MAX_PER_CATEGORY) break;
        const m = href.match(/\/(p|up)\/(ML[A-Z]*\d+)/i);
        if (!m) continue; // slot patrocinado (click1...) u otro formato: no compatible con /p/:id
        const id = m[2].toUpperCase();
        if (seen.has(id)) continue;
        seen.set(id, cat.name);
        taken++;
      }
    } catch (e) {
      console.warn(`  discover ${cat.id} (${cat.name}) -> error: ${e.message}`);
    } finally {
      await page.close();
    }
    done++;
    onProgress?.({ done, total: CATEGORIES.length, found: seen.size, group: cat.name });
    await sleep(jitter(2000, 4000));
  }

  return [...seen].map(([id, category]) => ({ id, category }));
}
