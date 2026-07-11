// Shared nav component for all SSR pages.
// Static HTML files (index.html, dashboard.html) use their own inline nav
// that mirrors these exact CSS rules.

const LOGO_SVG = `<svg viewBox="0 0 36 36" width="26" height="26" aria-hidden="true">
  <rect width="36" height="36" rx="9" fill="#e64c1e"/>
  <polyline points="7,11 14,17 21,13 28,24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M28 24 L28 19 M28 24 L23 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const MOON_SVG = `<svg class="icon-moon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SUN_SVG  = `<svg class="icon-sun" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

const TOGGLE = `<button id="theme-toggle" aria-label="Cambiar tema" title="Cambiar tema">${MOON_SVG}${SUN_SVG}</button>`;

export const NAV_CSS = `
.nav{background:rgba(255,255,255,.95);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.nav-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;height:60px;max-width:1100px;margin:0 auto;padding:0 24px}
.nav-logo{display:flex;align-items:center;gap:9px;font-weight:800;font-size:15px;color:var(--text);letter-spacing:-.01em;text-decoration:none;flex-shrink:0}
.nav-links{display:flex;align-items:center;gap:2px;min-width:0}
.nav-link{padding:7px 13px;border-radius:8px;font-size:13.5px;font-weight:500;color:var(--text-soft);transition:background 80ms,color 80ms;white-space:nowrap;text-decoration:none}
.nav-link:hover{background:var(--bg);color:var(--text)}
.nav-link[aria-current="page"]{background:var(--brand-bg);color:var(--brand);font-weight:600}
.nav-link.cta{background:var(--brand);color:#fff;font-weight:600;margin-left:4px}
.nav-link.cta:hover{background:var(--brand-dark)}
@media(max-width:640px){.nav-link:not(.cta){display:none}}
`;

/**
 * Builds the nav HTML for SSR pages.
 * @param {object} [opts]
 * @param {"home"|"deals"|"dashboard"|null} [opts.active] - highlights the current page link
 * @param {string} [opts.baseUrl] - base URL prefix for internal links (e.g. "https://bajoelprecio.fly.dev")
 */
export function buildNav({ active = null, baseUrl = "" } = {}) {
  const link = (href, label, key) => {
    const isActive = active === key ? ' aria-current="page"' : "";
    return `<a class="nav-link"${isActive} href="${baseUrl}${href}">${label}</a>`;
  };

  const links = [
    active !== "home" ? link("/", "Inicio", "home") : "",
    link("/deals", "🔥 Ofertas", "deals"),
    link("/dashboard", "Mis alertas", "dashboard"),
    link("/developers", "API", "api"),
    TOGGLE,
    `<a class="nav-link cta" href="https://t.me/bajoelprecio_bot" target="_blank" rel="noopener">Telegram →</a>`,
  ].filter(Boolean).join("");

  return `<nav class="nav" aria-label="Navegación principal">
  <div class="nav-inner">
    <a class="nav-logo" href="${baseUrl}/">${LOGO_SVG} Bajó el Precio</a>
    <div class="nav-links" role="list">${links}</div>
  </div>
</nav>`;
}
