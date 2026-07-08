// Bajó el Precio — content script.
// Corre en las páginas de producto de MercadoLibre. Lee el precio (que YA está en la
// página), lo manda a nuestra API para registrar el punto, y dibuja el historial.

const DEFAULT_API = "https://bajoelprecio.fly.dev";
const fmt = (n) => "$" + Number(n).toLocaleString("es-AR");

(async function main() {
  const id = detectId();
  if (!id) return;

  const price = readPrice();
  const title = document.querySelector("h1")?.textContent?.trim() || null;
  const image = document.querySelector('meta[property="og:image"]')?.content || null;
  const url = location.href.split("#")[0].split("?")[0];

  // Lee la URL del servidor desde storage (configurable en opciones de la extensión)
  const { api = DEFAULT_API } = await chrome.storage.sync.get({ api: DEFAULT_API });

  let data;
  try {
    const r = await fetch(`${api}/api/observe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, price, title, image, url }),
    });
    data = await r.json();
  } catch {
    return;
  }
  if (!data || data.error || !data.history) return;

  injectBox(id, data, api);
})();

// --- Detección del producto ---------------------------------------------------

function detectId() {
  // /p/MLA..., /up/MLAU..., o articulo...MLA-123...
  const path = location.pathname;
  let m = path.match(/\/(?:p|up)\/(ML[A-Z]*\d+)/i);
  if (m) return m[1].toUpperCase();
  m = location.href.match(/(ML[A-Z]-?\d{6,})/i);
  if (m) return m[1].toUpperCase().replace("-", "");
  return null;
}

function readPrice() {
  // El precio fiable está en el meta itemprop=price (en centavos: "272799.20").
  const meta = document.querySelector('meta[itemprop="price"]');
  if (meta?.content) {
    const v = parseFloat(meta.content);
    if (Number.isFinite(v)) return Math.round(v);
  }
  // Fallback: el precio visible del buy box.
  const frac = document.querySelector(".andes-money-amount__fraction");
  if (frac) {
    const v = parseInt(frac.textContent.replace(/\D/g, ""), 10);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// --- Render -------------------------------------------------------------------

function injectBox(id, { product, history, stats }, api = DEFAULT_API) {
  if (document.getElementById("bp-box")) return;

  const now = stats.last;
  const isLow = stats.count > 1 && now <= stats.min;
  const isHigh = stats.count > 1 && now >= stats.max;
  let verdict, vClass;
  if (stats.count < 2) {
    verdict = "📊 Estamos empezando a juntar el historial de este producto.";
    vClass = "bp-neutral";
  } else if (isLow) {
    verdict = "🟢 ¡Está en su precio MÁS BAJO! Buen momento para comprar.";
    vClass = "bp-good";
  } else if (isHigh) {
    verdict = "🔴 Está en su precio más ALTO. Conviene esperar.";
    vClass = "bp-bad";
  } else {
    const overMin = Math.round(((now - stats.min) / stats.min) * 100);
    verdict = `🟡 Está ${overMin}% por encima del mínimo histórico (${fmt(stats.min)}).`;
    vClass = "bp-mid";
  }

  const box = document.createElement("div");
  box.id = "bp-box";
  box.innerHTML = `
    <div class="bp-head">
      <span class="bp-logo">📉 Bajó el Precio</span>
      <span class="bp-count">${stats.count} ${stats.count === 1 ? "registro" : "registros"}</span>
    </div>
    <div class="bp-verdict ${vClass}">${verdict}</div>
    ${stats.count > 1 ? chartSVG(history) : ""}
    <div class="bp-stats">
      <div><span>Mínimo</span><b class="bp-min">${fmt(stats.min)}</b></div>
      <div><span>Promedio</span><b>${fmt(stats.avg)}</b></div>
      <div><span>Máximo</span><b class="bp-max">${fmt(stats.max)}</b></div>
    </div>
    <a class="bp-cta" href="${api}/p/${id}" target="_blank" rel="noopener">
      📊 Ver historial completo →
    </a>
  `;

  // Insertar arriba del buy box / precio.
  const anchor =
    document.querySelector(".ui-pdp-price") ||
    document.querySelector(".ui-pdp-container__col-right") ||
    document.querySelector("h1");
  if (anchor?.parentElement) {
    anchor.parentElement.insertBefore(box, anchor);
  } else {
    document.body.appendChild(box);
  }
}

function chartSVG(history) {
  const W = 300, H = 90, P = 6;
  const prices = history.map((h) => h.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = max - min || 1;
  const stepX = (W - P * 2) / Math.max(prices.length - 1, 1);
  const pts = prices.map((p, i) => {
    const x = P + i * stepX;
    const y = P + (1 - (p - min) / span) * (H - P * 2);
    return [x, y];
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${P},${H - P} ${line} ${(P + (prices.length - 1) * stepX).toFixed(1)},${H - P}`;
  const [lx, ly] = pts[pts.length - 1];
  return `
    <svg class="bp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polygon points="${area}" fill="rgba(52,131,250,0.12)" />
      <polyline points="${line}" fill="none" stroke="#3483fa" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round" />
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" fill="#3483fa" />
    </svg>`;
}
