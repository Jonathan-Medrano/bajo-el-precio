const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function expandUrl(url, maxHops = 6) {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetch(current, { redirect: "manual", headers: { "User-Agent": UA } });
    const loc = res.headers.get("location");
    if (!loc) return current;
    current = new URL(loc, current).href;
  }
  return current;
}
