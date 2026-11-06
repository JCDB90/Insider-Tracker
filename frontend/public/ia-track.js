// First-touch attribution for the static SEO pages (stocks, insiders,
// company, signals, market, articles). Records the first page — and ticker,
// if the page is about one — this browser ever visited, under the same
// localStorage key and shape the React app uses (see FIRST_TOUCH_KEY in
// src/App.jsx), which writes it to user_profiles.landing_page at signup.
//
// Include with: <script src="/ia-track.js" data-ticker="AL2SI" defer></script>
(function () {
  var KEY = 'ia_first_touch';

  // Keep in sync with sourceTypeForPath() in src/App.jsx.
  function sourceType(path) {
    var m = /^\/(stocks|insiders|company|signals|market|articles)\//.exec(path || '');
    if (!m) return path === '/' || path === '/signup' ? 'app' : 'page';
    return { stocks: 'stock', insiders: 'insider', company: 'company', signals: 'signal', market: 'market', articles: 'article' }[m[1]];
  }

  try {
    if (localStorage.getItem(KEY)) return;
    var script = document.currentScript;
    var page = window.location.pathname;
    localStorage.setItem(KEY, JSON.stringify({
      page: page,
      source_type: sourceType(page),
      ticker: (script && script.getAttribute('data-ticker')) || null,
      ts: Date.now(),
    }));
  } catch (e) { /* storage blocked */ }
})();
