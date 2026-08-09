'use strict';

// Renderer-side UI localization runtime. Loaded FIRST on every localized page
// (before manager.js/editor.js/renderer.js) so window.t() exists when they run.
//
// The active locale's dictionary is handed to the page by the preload as a
// read-only global `window.__i18n = { lang, dict, available }` (see the preloads).
// FAIL-SOFT: a missing dict or key returns the key's English (or the key itself),
// so the UI never shows blanks.
//
// Two ways to translate:
//   • Static HTML — mark an element `data-i18n="key"` (sets textContent) and/or
//     `data-i18n-attr="placeholder:key;title:key2"` (sets attributes). Call
//     I18n.applyDom(root) after inserting markup (done automatically on load).
//   • Dynamic JS — call t('key', { name: '…' }).

(function () {
  var payload = (window.__i18n && typeof window.__i18n === 'object') ? window.__i18n : {};
  var dict = (payload.dict && typeof payload.dict === 'object') ? payload.dict : {};

  function t(key, params) {
    var s = dict[key];
    if (typeof s !== 'string') s = key; // fall back to the key (English key names read fine)
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (_, k) {
        return params[k] != null ? String(params[k]) : '{' + k + '}';
      });
    }
    return s;
  }

  // Fill translatable markup under `root` (default: document):
  //   [data-i18n="key"]                     -> textContent
  //   [data-i18n-attr="attr:key;attr2:key"] -> setAttribute(attr, t(key))
  function applyDom(root) {
    root = root || document;
    var els = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = t(els[i].getAttribute('data-i18n'));
    }
    var attrEls = root.querySelectorAll('[data-i18n-attr]');
    for (var j = 0; j < attrEls.length; j++) {
      var spec = attrEls[j].getAttribute('data-i18n-attr') || '';
      var pairs = spec.split(';');
      for (var p = 0; p < pairs.length; p++) {
        var idx = pairs[p].indexOf(':');
        if (idx < 0) continue;
        var attr = pairs[p].slice(0, idx).trim();
        var key = pairs[p].slice(idx + 1).trim();
        if (attr && key) attrEls[j].setAttribute(attr, t(key));
      }
    }
  }

  window.t = t;
  window.I18n = {
    t: t,
    applyDom: applyDom,
    lang: payload.lang || 'en',
    available: Array.isArray(payload.available) ? payload.available : ['en'],
  };

  // Translate the static markup as soon as the DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyDom(document); });
  } else {
    applyDom(document);
  }
})();
