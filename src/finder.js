import { extractSpecs, getMatcher, tokens, keywordOverlap, extractNumericAttrs, numericMatch } from "./specs.js";
import { searchListings } from "./search.js";

const BRANDS = [
  "samsung", "motorola", "moto", "xiaomi", "redmi", "poco", "apple", "iphone",
  "lg", "nokia", "huawei", "realme", "oppo", "tcl", "zte", "alcatel", "honor",
];

const KNOWN_BRANDS = [
  ...BRANDS,
  "sony", "philips", "jbl", "noblex", "bgh", "hisense", "aoc", "viewsonic", "gigabyte",
  "asus", "acer", "hp", "dell", "lenovo", "msi", "kanji", "pcbox", "gadnic", "randers",
  "liliana", "atma", "peabody", "ultracomb", "oasis", "spinning", "sportop", "dreamfit",
];

function findBrand(title) {
  const t = ` ${String(title).toLowerCase()} `;
  return KNOWN_BRANDS.find((b) => new RegExp(`\\b${b}\\b`).test(t)) ?? null;
}

function buildQuery(title, specs) {
  if (specs.storage != null) {
    const brand = BRANDS.find((b) => title.toLowerCase().includes(b)) ?? "";
    return [brand, specs.model, `${specs.storage}gb`].filter(Boolean).join(" ").trim();
  }
  return [...tokens(title)].slice(0, 6).join(" ") || title;
}

export async function findCheapestEquivalent(sourceTitle, opts = {}) {
  const mode = opts.mode ?? "estricto";
  const condition = opts.condition ?? "nuevo";
  const international = opts.international ?? false;

  const source = extractSpecs(sourceTitle);
  const isPhone = source.storage != null;
  const query = buildQuery(sourceTitle, source);
  let listings = await searchListings(query, { limit: 40 });

  if (condition !== "todos") listings = listings.filter((l) => l.condition === condition);
  if (!international) listings = listings.filter((l) => !l.international);

  const specMatch = getMatcher(mode);
  const minOverlap = mode === "flexible" ? 0.5 : 0.7;
  const srcBrand = isPhone ? null : findBrand(sourceTitle);
  const srcAttrs = isPhone ? {} : extractNumericAttrs(sourceTitle);

  const matches = listings
    .map((l) => ({ ...l, specs: extractSpecs(l.title) }))
    .filter((l) => {
      if (isPhone) return specMatch(source, l.specs);
      if (keywordOverlap(sourceTitle, l.title) < minOverlap) return false;
      if (srcBrand && !new RegExp(`\\b${srcBrand}\\b`).test(` ${l.title.toLowerCase()} `)) return false;
      if (mode === "estricto" && !numericMatch(srcAttrs, extractNumericAttrs(l.title))) return false;
      return true;
    })
    .sort((a, b) => a.price - b.price);

  return { source, isPhone, query, opts: { mode, condition, international }, totalResultados: listings.length, matches, cheapest: matches[0] ?? null };
}
