import { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";
const fmt = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("es-AR"));

function Sparkline({ data }) {
  if (!data || data.length < 2) return <div style={{ height: 24 }} />;
  const w = 160, h = 24, min = Math.min(...data), max = Math.max(...data), range = max - min || 1;
  const pts = data.map((p, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - ((p - min) / range) * h).toFixed(1)}`).join(" ");
  const color = data.at(-1) <= data[0] ? "#16a34a" : "#dc2626";
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

function ProductCard({ p, onClick }) {
  return (
    <div className="prod" onClick={onClick}>
      {p.image ? <img src={p.image} loading="lazy" alt="" /> : <div className="ph" />}
      <div className="t">{p.title}</div>
      <div className="p">{fmt(p.price)}</div>
      <div className="mm">mín {fmt(p.min)} · máx {fmt(p.max)}</div>
      {p.drop >= 3 && <span className="badge">▼ {p.drop}% vs máx</span>}
      <Sparkline data={p.spark} />
    </div>
  );
}

function FilterRow({ label, options, value, onChange }) {
  return (
    <div className="frow">
      <span className="flabel">{label}</span>
      {options.map(([v, t]) => (
        <button key={v} className={"fbtn" + (v === value ? " active" : "")} onClick={() => onChange(v)}>{t}</button>
      ))}
    </div>
  );
}

function Comparison({ id }) {
  const [f, setF] = useState({ mode: "estricto", condition: "nuevo", international: false, view: "contado" });
  const [c, setC] = useState(null);
  const [loading, setLoading] = useState(true);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    // Race-safe: cancela la búsqueda anterior (AbortController), descarta respuestas viejas
    // (flag active) y debouncea 350ms para que tocar varios filtros rápido dispare UNA sola.
    const ctrl = new AbortController();
    let active = true;
    setLoading(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ mode: f.mode, condition: f.condition, international: f.international ? "1" : "0", view: f.view });
      fetch(`${API}/api/compare/${id}?${qs}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => { if (active) { setC(d); setLoading(false); } })
        .catch((e) => { if (active && e.name !== "AbortError") setLoading(false); });
    }, 350);
    return () => { active = false; ctrl.abort(); clearTimeout(t); };
  }, [id, f]);

  const s = c?.selected;
  return (
    <div className="compare">
      <div className="cat-heading">🔎 Mejor precio en MercadoLibre</div>
      <FilterRow label="Match" options={[["estricto", "Estricto"], ["flexible", "Flexible"]]} value={f.mode} onChange={(v) => set("mode", v)} />
      <FilterRow label="Condición" options={[["nuevo", "Nuevo"], ["usado", "Usado"], ["todos", "Todos"]]} value={f.condition} onChange={(v) => set("condition", v)} />
      <div className="frow">
        <span className="flabel">Internacional</span>
        <button className={"fbtn" + (f.international ? " active" : "")} onClick={() => set("international", !f.international)}>{f.international ? "✓ Incluir" : "Excluir"}</button>
      </div>
      <FilterRow label="Cuotas" options={[["contado", "Contado"], ["sinInteres", "S/interés"], ["menorCuota", "Menor cuota"], ["menorTotal", "Menor total"]]} value={f.view} onChange={(v) => set("view", v)} />
      <div className="compare-box">
        {loading ? "🔎 Buscando el mejor precio... (unos segundos)"
          : s ? (
            <>
              <div className="cprice">{fmt(s.price)}{s.cuotas ? <span className="ccuo"> · {s.cuotas.count} cuotas de {fmt(s.cuotas.amount)}{s.cuotas.sinInteres ? " s/interés" : ""}</span> : null}</div>
              <div className="ctitle">{s.title}</div>
              <div className="ccount">entre {c.count} equivalentes</div>
              <a href={s.link} target="_blank" rel="noopener noreferrer">Comprar el más barato →</a>
            </>
          ) : "No encontré equivalentes con esos filtros."}
      </div>
    </div>
  );
}

const RANGES = [
  { key: "30", label: "30d", days: 30 },
  { key: "90", label: "90d", days: 90 },
  { key: "365", label: "1 año", days: 365 },
  { key: "all", label: "Todo", days: null },
];

function AlertButton({ id, target, fmt }) {
  const [hint, setHint] = useState(null);
  const price = target && Number(target) > 0 ? Math.round(Number(target)) : null;
  const tmeUrl = `https://t.me/bajoelprecio_bot?start=track_${id}${price ? "_" + price : ""}`;
  const label = price ? `Avisame si baja de ${fmt(price)}` : "Avisame si baja";

  const handleClick = (e) => {
    navigator.clipboard?.writeText(tmeUrl).catch(() => {});
    // If the OS didn't open Telegram after 1.5 s, show the fallback hint
    const t = setTimeout(() => setHint(tmeUrl), 1500);
    // If focus returns quickly (Telegram opened), cancel the hint
    const onFocus = () => { clearTimeout(t); window.removeEventListener("focus", onFocus); };
    window.addEventListener("focus", onFocus);
  };

  return (
    <>
      <a className="btn-alert" href={tmeUrl} target="_blank" rel="noopener noreferrer" onClick={handleClick}>
        🔔 {label}
      </a>
      {hint && (
        <div className="alert-hint">
          No se abrió Telegram? Link copiado al portapapeles — pegalo en el bot:
          <br />
          <code onClick={() => { navigator.clipboard?.writeText(hint); }} style={{ cursor: "pointer" }}>@bajoelprecio_bot</code>
        </div>
      )}
    </>
  );
}

function ProductModal({ id, onClose }) {
  const [data, setData] = useState(null);
  const [range, setRange] = useState("all");
  const [target, setTarget] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setData(null);
    setTarget("");
    setCopied(false);
    fetch(`${API}/api/product/${id}`).then((r) => r.json()).then(setData);
  }, [id]);

  const inner = () => {
    if (!data) return (
      <div className="modal-loading">
        <div className="sk sk-line" style={{ width: "70%", height: 22 }} />
        <div className="sk" style={{ height: 60, borderRadius: 8 }} />
        <div className="sk" style={{ height: 200, borderRadius: 8 }} />
        <div className="sk sk-line" style={{ width: "50%" }} />
      </div>
    );
    if (data.error) return (<><button className="close" onClick={onClose}>Cerrar ✕</button><p className="empty">No tengo este producto todavía.</p></>);
    const { product, history, stats } = data;
    const prices = history.map((h) => h.price);
    const last = stats.last;

    // Insights sobre TODO el historial.
    const pctCheaper = prices.length ? Math.round((prices.filter((p) => p > last).length / prices.length) * 100) : 0;
    const minPoints = history.filter((h) => h.price === stats.min);
    const daysSinceMin = minPoints.length
      ? Math.round((Date.now() - new Date(minPoints.at(-1).seenAt).getTime()) / 86400000)
      : null;

    const verdict =
      stats.count < 3 ? { t: "🆕 Recién lo empiezo a seguir — se enriquece con el tiempo.", c: "v-new" }
      : last <= stats.min ? { t: "🟢 Está en su precio MÁS BAJO registrado. Comprá tranquilo.", c: "v-good" }
      : pctCheaper >= 70 ? { t: `🟢 Más barato que el ${pctCheaper}% del historial. Buen momento.`, c: "v-good" }
      : last <= stats.avg ? { t: "🟡 Por debajo del promedio. Está OK.", c: "v-mid" }
      : { t: "🔴 Por encima del promedio. Quizás conviene esperar.", c: "v-bad" };

    // Gráfico filtrado por rango (si deja menos de 2 puntos, mostramos todo).
    const sel = RANGES.find((r) => r.key === range);
    const cutoff = sel?.days ? Date.now() - sel.days * 86400000 : 0;
    let shown = history.filter((h) => new Date(h.seenAt).getTime() >= cutoff);
    if (shown.length < 2) shown = history;
    const chartData = shown.map((p) => ({
      fecha: new Date(p.seenAt).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" }),
      precio: p.price,
    }));

    return (
      <>
        <button className="close" onClick={onClose}>Cerrar ✕</button>
        <h2>{product.title}</h2>
        <div className="stats">
          {[["Actual", stats.last], ["Mínimo", stats.min], ["Máximo", stats.max], ["Promedio", stats.avg]].map(([l, v]) => (
            <div className="stat" key={l}><div className="l">{l}</div><div className="v">{fmt(v)}</div></div>
          ))}
        </div>
        <div className="range-row">
          {RANGES.map((r) => (
            <button key={r.key} className={"rbtn" + (r.key === range ? " active" : "")} onClick={() => setRange(r.key)}>{r.label}</button>
          ))}
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={chartData} margin={{ top: 6, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="fecha" fontSize={11} />
            <YAxis tickFormatter={(v) => "$" + Math.round(v / 1000) + "k"} fontSize={11} width={50} />
            <Tooltip formatter={(v) => fmt(v)} />
            <Line type="monotone" dataKey="precio" stroke="#e64c1e" strokeWidth={2} dot={{ r: 2 }} />
          </LineChart>
        </ResponsiveContainer>
        <div className={"verdict " + verdict.c}>{verdict.t}</div>
        {stats.count >= 3 && daysSinceMin != null && (
          last <= stats.min
            ? <div className="insight insight-good">💚 Es el <b>mejor precio histórico</b> que registramos. Este descuento es REAL.</div>
            : <div className="insight insight-warn">⚠️ Ojo: este NO es el mejor precio. Estuvo a <b>{fmt(stats.min)}</b>{daysSinceMin === 0 ? " hoy" : ` hace ${daysSinceMin} día${daysSinceMin === 1 ? "" : "s"}`}. No te comas el “descuento”.</div>
        )}
        <div className="alert-box">
          <input
            className="alert-input"
            type="number"
            placeholder="Precio objetivo (opcional) — ej: el mínimo histórico"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <div className="modal-cta">
            <a className="btn-ml" href={product.url} target="_blank" rel="noopener noreferrer">Ver en MercadoLibre →</a>
            <AlertButton id={id} target={target} fmt={fmt} />
          </div>
        </div>
        <div className="share-row">
          <span>Compartir:</span>
          <a href={`https://wa.me/?text=${encodeURIComponent(`📉 Historial de precios de "${product.title}" — ${API}/p/${id}`)}`} target="_blank" rel="noopener noreferrer">WhatsApp</a>
          <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`📉 ${product.title}`)}&url=${encodeURIComponent(`${API}/p/${id}`)}`} target="_blank" rel="noopener noreferrer">X</a>
          <button type="button" className="link-btn" onClick={() => { navigator.clipboard.writeText(`${API}/p/${id}`); setCopied(true); }}>{copied ? "✓ ¡Copiado!" : "Copiar link"}</button>
        </div>
        <Comparison id={id} />
      </>
    );
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>{inner()}</div>
    </div>
  );
}

const PAGE = 16;

function Section({ title, hint, items, onPick }) {
  return (
    <section>
      <h3 className="cat-heading">{title}{hint && <span className="cat-hint"> {hint}</span>}</h3>
      <div className="grid">{items.map((p) => <ProductCard key={p.id} p={p} onClick={() => onPick(p.id)} />)}</div>
    </section>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 36 36" width="38" height="38" aria-hidden="true">
      <rect width="36" height="36" rx="9" fill="#e64c1e" />
      <polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M28 24 L28 19 M28 24 L23 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SkeletonCard() {
  return (
    <div className="prod skeleton">
      <div className="sk sk-img" />
      <div className="sk sk-line" />
      <div className="sk sk-line short" />
      <div className="sk sk-price" />
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ["🔎", "Buscás o pegás un link", "Cualquier producto de MercadoLibre."],
    ["📊", "Ves el historial REAL", "Sin descuentos truchos. El precio de verdad, día por día."],
    ["🔔", "Te avisamos cuando baja", "Alerta en Telegram al precio que vos quieras."],
  ];
  return (
    <section className="how">
      <h3 className="cat-heading">¿Cómo funciona?</h3>
      <div className="how-grid">
        {steps.map(([icon, t, d], i) => (
          <div className="how-step" key={i}>
            <div className="how-icon">{icon}</div>
            <div className="how-t">{t}</div>
            <div className="how-d">{d}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-cols">
        <div className="footer-brand">
          <Logo />
          <div>
            <b>Bajó el Precio</b>
            <p>Historial real de precios de MercadoLibre Argentina.</p>
          </div>
        </div>
        <div className="footer-col">
          <b>Herramientas</b>
          <a href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener noreferrer">Bot de Telegram</a>
          <a href="https://t.me/bajoelprecio_ar" target="_blank" rel="noopener noreferrer">Canal de ofertas</a>
        </div>
        <div className="footer-col">
          <b>Para empresas</b>
          <span>API de precios</span>
          <span>Extensión de Chrome</span>
        </div>
      </div>
      <div className="footer-legal">
        No estamos afiliados a MercadoLibre. Los precios son con fines informativos y pueden variar. © {new Date().getFullYear()} Bajó el Precio.
      </div>
    </footer>
  );
}

export default function App() {
  const [catalog, setCatalog] = useState({});
  const [cat, setCat] = useState("Todas");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("relevancia");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [minDrop, setMinDrop] = useState(0);
  const [selected, setSelected] = useState(null);
  const [searching, setSearching] = useState(false);
  const [visible, setVisible] = useState(PAGE);
  const [loaded, setLoaded] = useState(false);

  const load = () => fetch(`${API}/api/catalog`).then((r) => r.json()).then((d) => { setCatalog(d); setLoaded(true); });
  useEffect(() => { load(); }, []);

  // Si llegamos desde la extensión (?id=MLA...), abrimos ese producto directo.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setSelected(id);
  }, []);

  const allProducts = useMemo(() => {
    const all = [];
    for (const c of Object.keys(catalog)) {
      for (const p of catalog[c]) {
        all.push({ ...p, category: c, drop: p.max && p.price ? Math.round((1 - p.price / p.max) * 100) : 0 });
      }
    }
    return all;
  }, [catalog]);

  const categories = useMemo(() => ["Todas", ...Object.keys(catalog)], [catalog]);

  // Tres secciones DISTINTAS (sin repetir productos): ganadores claman primero las
  // mejores bajas, después destacados (baja + popularidad), después los más buscados.
  const hero = useMemo(() => {
    const used = new Set();
    const take = (arr, n) => {
      const out = [];
      for (const p of arr) {
        if (used.has(p.id)) continue;
        used.add(p.id);
        out.push(p);
        if (out.length >= n) break;
      }
      return out;
    };
    const byDrop = allProducts.filter((p) => p.drop >= 5).sort((a, b) => b.drop - a.drop);
    const byBlend = allProducts.filter((p) => p.drop >= 1).sort((a, b) => b.drop * 1.5 + Math.min(b.queries, 15) - (a.drop * 1.5 + Math.min(a.queries, 15)));
    const byQueries = allProducts.filter((p) => p.queries > 0).sort((a, b) => b.queries - a.queries || b.drop - a.drop);
    return { ganadores: take(byDrop, 8), destacados: take(byBlend, 8), masBuscados: take(byQueries, 8) };
  }, [allProducts]);

  const filtered = useMemo(() => {
    let all = allProducts;
    if (cat !== "Todas") all = all.filter((p) => p.category === cat);
    if (q.trim() && !/https?:\/\//.test(q)) {
      const t = q.toLowerCase();
      all = all.filter((p) => p.title.toLowerCase().includes(t));
    }
    const mn = priceMin ? Number(priceMin) : null;
    const mx = priceMax ? Number(priceMax) : null;
    if (mn != null) all = all.filter((p) => p.price != null && p.price >= mn);
    if (mx != null) all = all.filter((p) => p.price != null && p.price <= mx);
    if (minDrop > 0) all = all.filter((p) => p.drop >= minDrop);
    all = [...all];
    if (sort === "precio-asc") all.sort((a, b) => (a.price ?? 1e15) - (b.price ?? 1e15));
    else if (sort === "precio-desc") all.sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
    else if (sort === "mas-bajo") all.sort((a, b) => b.drop - a.drop);
    else if (sort === "mas-buscado") all.sort((a, b) => (b.queries ?? 0) - (a.queries ?? 0));
    return all;
  }, [allProducts, cat, q, sort, priceMin, priceMax, minDrop]);

  useEffect(() => { setVisible(PAGE); }, [cat, q, sort, priceMin, priceMax, minDrop]);

  const filtersActive = cat !== "Todas" || q.trim() || priceMin || priceMax || minDrop > 0;
  const browsing = !filtersActive;
  const clearFilters = () => { setCat("Todas"); setQ(""); setPriceMin(""); setPriceMax(""); setMinDrop(0); setSort("relevancia"); };

  async function buscarLink() {
    const url = q.trim();
    if (!/https?:\/\//.test(url)) return;
    setSearching(true);
    try {
      const r = await fetch(`${API}/api/track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (!data.error) { setSelected(data.product.id); load(); }
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="brand"><Logo /><h1>Bajó el Precio</h1></div>
        <p className="sub">Historial real de precios de MercadoLibre. Sin descuentos truchos.</p>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <div className="side-block">
            <label className="side-label">🔎 Buscar</label>
            <input
              className="search"
              placeholder="Nombre o link de producto..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && buscarLink()}
            />
            {/https?:\/\//.test(q) && (
              <button className="side-btn" onClick={buscarLink} disabled={searching}>{searching ? "Leyendo..." : "Analizar link"}</button>
            )}
          </div>

          <div className="side-block">
            <label className="side-label">Categorías</label>
            <ul className="cat-list">
              {categories.map((c) => (
                <li key={c} className={c === cat ? "active" : ""} onClick={() => setCat(c)}>{c}</li>
              ))}
            </ul>
          </div>

          <div className="side-block">
            <label className="side-label">Precio</label>
            <div className="price-row">
              <input type="number" placeholder="mín" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} />
              <span>–</span>
              <input type="number" placeholder="máx" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} />
            </div>
          </div>

          <div className="side-block">
            <label className="side-label">Baja mínima</label>
            <select value={minDrop} onChange={(e) => setMinDrop(Number(e.target.value))}>
              <option value={0}>Cualquiera</option>
              <option value={5}>5% o más</option>
              <option value={10}>10% o más</option>
              <option value={20}>20% o más</option>
            </select>
          </div>

          <div className="side-block">
            <label className="side-label">Ordenar</label>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="relevancia">Relevancia</option>
              <option value="precio-asc">Precio: menor a mayor</option>
              <option value="precio-desc">Precio: mayor a menor</option>
              <option value="mas-bajo">Más bajó de precio</option>
              <option value="mas-buscado">Más buscados</option>
            </select>
          </div>

          {filtersActive && <button className="side-clear" onClick={clearFilters}>✕ Limpiar filtros</button>}
        </aside>

        <main className="main">
          {!loaded ? (
            <>
              <h3 className="cat-heading">Cargando productos…</h3>
              <div className="grid">{Array.from({ length: 12 }).map((_, i) => <SkeletonCard key={i} />)}</div>
            </>
          ) : (
            <>
              {browsing && hero.ganadores.length > 0 && (
                <Section title="🏆 Ganadores" hint="las mejores bajas ahora" items={hero.ganadores} onPick={setSelected} />
              )}
              {browsing && hero.destacados.length > 0 && (
                <Section title="🔥 Destacados" items={hero.destacados} onPick={setSelected} />
              )}
              {browsing && hero.masBuscados.length > 0 && (
                <Section title="👀 Más buscados" items={hero.masBuscados} onPick={setSelected} />
              )}

              <h3 className="cat-heading">{browsing ? "Explorar todo" : `Resultados (${filtered.length})`}</h3>
              <div className="grid">
                {filtered.slice(0, visible).map((p) => <ProductCard key={p.id} p={p} onClick={() => setSelected(p.id)} />)}
              </div>
              {!filtered.length && <p className="empty">Sin productos con esos filtros. Probá aflojarlos o limpiarlos.</p>}
              {visible < filtered.length && (
                <button className="more" onClick={() => setVisible((v) => v + PAGE)}>Ver más ({filtered.length - visible} restantes)</button>
              )}

              {browsing && <HowItWorks />}
            </>
          )}
        </main>
      </div>

      <Footer />
      {selected && <ProductModal id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
