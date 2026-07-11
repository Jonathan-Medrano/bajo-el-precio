const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ALLOWED_HOSTS_RE = /^([a-z0-9-]+\.)?(mercadolibre\.com(\.ar|\.com\.mx|\.com\.co|\.com\.br)?|meli\.la|mercadopago\.com(\.ar)?)$/i;
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|fc00:|fd)/;

function isSafeUrl(href) {
  try {
    const u = new URL(href);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    if (PRIVATE_IP_RE.test(u.hostname)) return false;
    if (!ALLOWED_HOSTS_RE.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function expandUrl(url, maxHops = 6) {
  if (!isSafeUrl(url)) return url;
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA }, signal: ctrl.signal })
      .finally(() => clearTimeout(timer));
    const loc = res.headers.get("location");
    if (!loc) return current;
    const next = new URL(loc, current).href;
    if (!isSafeUrl(next)) return current;
    current = next;
  }
  return current;
}
