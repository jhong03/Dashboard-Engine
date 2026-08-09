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

  // A rich-text translation ([data-i18n-html]) may contain a FEW inline
  // formatting tags — but a community-supplied locale file is untrusted, so we
  // never assign it via innerHTML. Instead we parse it inertly and rebuild it
  // keeping ONLY these tags, with NO attributes: no script, no handlers, no
  // remote content can survive.
  var HTML_WHITELIST = { B: 1, STRONG: 1, I: 1, EM: 1, CODE: 1, KBD: 1, SMALL: 1, U: 1, BR: 1 };

  function sanitizeChildrenInto(sourceNode, destNode) {
    var kids = sourceNode.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var node = kids[i];
      if (node.nodeType === 3) { // text
        destNode.appendChild(document.createTextNode(node.nodeValue));
      } else if (node.nodeType === 1) { // element
        if (HTML_WHITELIST[node.tagName]) {
          var clean = document.createElement(node.tagName.toLowerCase()); // no attributes copied
          sanitizeChildrenInto(node, clean);
          destNode.appendChild(clean);
        } else {
          // Disallowed element -> keep only its (sanitized) text/children.
          sanitizeChildrenInto(node, destNode);
        }
      }
    }
  }

  // Replace `el`'s content with a sanitized render of the (possibly-formatted)
  // translation string. <template> parses inertly (scripts never run).
  function setHtml(el, html) {
    var tpl = document.createElement('template');
    tpl.innerHTML = String(html == null ? '' : html);
    el.textContent = '';
    sanitizeChildrenInto(tpl.content, el);
  }

  // Fill translatable markup under `root` (default: document):
  //   [data-i18n="key"]                     -> textContent
  //   [data-i18n-html="key"]                -> sanitized inline HTML (b/i/em/code/…)
  //   [data-i18n-attr="attr:key;attr2:key"] -> setAttribute(attr, t(key))
  function applyDom(root) {
    root = root || document;
    var els = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = t(els[i].getAttribute('data-i18n'));
    }
    var htmlEls = root.querySelectorAll('[data-i18n-html]');
    for (var h = 0; h < htmlEls.length; h++) {
      setHtml(htmlEls[h], t(htmlEls[h].getAttribute('data-i18n-html')));
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

  // Swap the active dictionary at runtime (a live language change, no reload).
  // Updates <html lang> and re-fills every [data-i18n] element; the caller
  // re-renders any dynamically-built strings afterwards.
  function setDict(newDict, lang) {
    dict = (newDict && typeof newDict === 'object') ? newDict : dict;
    if (lang) window.I18n.lang = lang;
    try { document.documentElement.lang = window.I18n.lang; } catch (e) { /* no-op */ }
    applyDom(document);
  }

  window.t = t;
  window.I18n = {
    t: t,
    applyDom: applyDom,
    setHtml: setHtml,
    setDict: setDict,
    lang: payload.lang || 'en',
    available: Array.isArray(payload.available) ? payload.available : ['en'],
  };

  // Reflect the active language on <html lang> for accessibility/spellcheck.
  try { document.documentElement.lang = window.I18n.lang; } catch (e) { /* no-op */ }

  // Translate the static markup as soon as the DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyDom(document); });
  } else {
    applyDom(document);
  }
})();
