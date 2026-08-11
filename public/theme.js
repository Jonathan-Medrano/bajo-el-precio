(function () {
  function isDark() {
    return document.documentElement.dataset.theme === 'dark';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.setAttribute('aria-label', isDark() ? 'Activar modo claro' : 'Activar modo oscuro');
    btn.addEventListener('click', function () {
      var dark = !isDark();
      if (dark) {
        document.documentElement.dataset.theme = 'dark';
      } else {
        delete document.documentElement.dataset.theme;
      }
      localStorage.setItem('theme', dark ? 'dark' : 'light');
      btn.setAttribute('aria-label', dark ? 'Activar modo claro' : 'Activar modo oscuro');
    });
  });
})();
