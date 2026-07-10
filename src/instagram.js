// Instagram Graph API client — posts deal images via Meta Content Publishing API.
// Required env vars (add via `fly secrets set`):
//   INSTAGRAM_USER_ID     — numeric ID of the Instagram Business/Creator account
//   INSTAGRAM_ACCESS_TOKEN — long-lived Page Access Token with instagram_basic + content_publish scopes
//
// Image source: /og-ig/:id.png endpoint (1080x1080 square, Instagram-optimized).
// Instagram fetches images directly from these public HTTPS URLs — no upload step needed.

const IG_API = "https://graph.facebook.com/v19.0";

function igCreds() {
  const { INSTAGRAM_USER_ID: userId, INSTAGRAM_ACCESS_TOKEN: token } = process.env;
  if (!userId || !token) return null;
  return { userId, token };
}

/**
 * Create a single-image container.
 * Returns the creation ID (used in publish step).
 */
async function createMediaContainer({ imageUrl, caption, userId, token }) {
  const res = await fetch(`${IG_API}/${userId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: token }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(JSON.stringify(data.error ?? data));
  return data.id;
}

/** Publish a previously created container. */
async function publishContainer({ creationId, userId, token }) {
  const res = await fetch(`${IG_API}/${userId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(JSON.stringify(data.error ?? data));
  return data.id;
}

const fmt = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const tag = (s) => s.toLowerCase().replace(/[^\w]/g, "").slice(0, 24);

const BASE_HASHTAGS = "#mercadolibre #ofertasML #bajoelprecio #descuentos #comprasinteligentes #argentina #precio";

function buildSingleCaption(deal, baseUrl) {
  const saving = deal.savingPct >= 5
    ? `⬇️ −${deal.savingPct}% vs el precio máximo histórico`
    : `💰 Precio actual: ${fmt(deal.current)}`;
  const extra = deal.category ? ` #${tag(deal.category)}` : "";

  return [
    `⚠️ ¿El descuento es real o te están metiendo el dedo?`,
    "",
    `📦 ${deal.title.slice(0, 110)}`,
    saving,
    "",
    `Rastreamos el historial real de precios en MercadoLibre para que vos decidas con datos, no con marketing.`,
    "",
    `👉 Ver historial: ${baseUrl}/p/${deal.id}`,
    `🔔 Activá tu alerta gratis en ${baseUrl}`,
    "",
    BASE_HASHTAGS + extra,
  ].join("\n");
}

function buildCarouselCaption(deals, baseUrl) {
  const count = deals.length;
  const extra = deals[0]?.category ? ` #${tag(deals[0].category)}` : "";

  return [
    `⚠️ MercadoLibre te muestra "50% OFF"... pero ¿es real?`,
    "",
    `👆 Swipe para ver ${count} descuentos con historial real de precios.`,
    `No opiniones — datos.`,
    "",
    `Bajó el Precio rastrea el historial de cada producto para que sepas si el precio de hoy es realmente una oferta o solo marketing.`,
    "",
    `✅ Gratis, sin registro en: ${baseUrl}`,
    `🔔 Activá alertas de precio por Telegram`,
    "",
    BASE_HASHTAGS + extra,
  ].join("\n");
}

/**
 * Post the top deal to Instagram with its OG image.
 * The image is fetched from `${baseUrl}/og/${deal.id}.png` — must be publicly accessible.
 */
export async function postDealToInstagram(deal) {
  const c = igCreds();
  if (!c) { console.warn("[instagram] credenciales faltantes, skip"); return null; }

  const baseUrl = process.env.PUBLIC_URL || "https://bajoelprecio.fly.dev";
  const imageUrl = `${baseUrl}/og-ig/${deal.id}.png`;
  const caption = buildSingleCaption(deal, baseUrl);

  try {
    const creationId = await createMediaContainer({ imageUrl, caption, ...c });
    // Instagram requires a short delay between container creation and publish
    await new Promise((r) => setTimeout(r, 3000));
    const postId = await publishContainer({ creationId, ...c });
    console.log("[instagram] publicado:", postId);
    return postId;
  } catch (e) {
    console.error("[instagram] error:", e.message);
    return null;
  }
}

/**
 * Post top deals as a carousel (up to 10 slides).
 * Uses CAROUSEL container type — better engagement than single images.
 */
export async function postDealsCarouselToInstagram(deals) {
  const c = igCreds();
  if (!c || !deals?.length) { console.warn("[instagram] credenciales faltantes o sin deals, skip"); return null; }

  const baseUrl = process.env.PUBLIC_URL || "https://bajoelprecio.fly.dev";
  const slides = deals.slice(0, Math.min(deals.length, 10));

  try {
    // Step 1: create individual image containers (children)
    const childIds = [];
    for (const d of slides) {
      const res = await fetch(`${IG_API}/${c.userId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: `${baseUrl}/og-ig/${d.id}.png`,
          is_carousel_item: true,
          access_token: c.token,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(`child error: ${JSON.stringify(data.error ?? data)}`);
      childIds.push(data.id);
      await new Promise((r) => setTimeout(r, 500));
    }

    const caption = buildCarouselCaption(deals, baseUrl);

    // Step 2: create carousel container
    const carRes = await fetch(`${IG_API}/${c.userId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        media_type: "CAROUSEL",
        children: childIds.join(","),
        caption,
        access_token: c.token,
      }),
    });
    const carData = await carRes.json();
    if (!carRes.ok || carData.error) throw new Error(`carousel error: ${JSON.stringify(carData.error ?? carData)}`);

    await new Promise((r) => setTimeout(r, 3000));

    // Step 3: publish
    const pubRes = await fetch(`${IG_API}/${c.userId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: carData.id, access_token: c.token }),
    });
    const pubData = await pubRes.json();
    if (!pubRes.ok || pubData.error) throw new Error(`publish error: ${JSON.stringify(pubData.error ?? pubData)}`);
    console.log("[instagram] carousel publicado:", pubData.id);
    return pubData.id;
  } catch (e) {
    console.error("[instagram] error:", e.message);
    return null;
  }
}
