// Shared dark-mode CSS + FOUC-prevention script for all pages (SSR + static).
// Static pages inline these manually; SSR pages import them here.

export const THEME_CSS = `
[data-theme="dark"]{
  --bg:#0f172a;--surface:#1e293b;--border:#334155;
  --text:#f1f5f9;--text-soft:#94a3b8;--text-xsoft:#64748b;
  --brand-bg:#3d1a0f;--brand-light:#4a1f12;
  --green-bg:#052e16;--green-text:#86efac;
  --yellow-bg:#422006;--yellow-text:#fde68a;
  --red-bg:#450a0a;--red-text:#fca5a5;
  --shadow-sm:0 1px 3px rgba(0,0,0,.4);
  --shadow:0 1px 3px rgba(0,0,0,.4),0 1px 2px rgba(0,0,0,.3);
  --shadow-md:0 4px 16px rgba(0,0,0,.5);
  --shadow-lg:0 8px 30px rgba(0,0,0,.6);
}
[data-theme="dark"] .nav{background:rgba(15,23,42,.95)}
[data-theme="dark"] .hero,[data-theme="dark"] .page-hero{background:linear-gradient(180deg,#1a0f0a 0%,var(--bg) 70%)}
[data-theme="dark"] input,[data-theme="dark"] textarea{background:var(--surface);color:var(--text);border-color:var(--border)}
[data-theme="dark"] .modal-input,[data-theme="dark"] .field-input{background:var(--surface);color:var(--text)}
#theme-toggle{width:34px;height:34px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text-soft);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 80ms,border-color 80ms;padding:0;margin-left:6px}
#theme-toggle:hover{background:var(--bg)}
.icon-sun{display:none}
[data-theme="dark"] .icon-moon{display:none}
[data-theme="dark"] .icon-sun{display:block}
`;

// Inline in <head> to prevent FOUC before CSS loads.
export const THEME_HEAD_SCRIPT = `<script>(function(){var t=localStorage.getItem('theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');if(t==='dark')document.documentElement.dataset.theme='dark';})()</script>`;
