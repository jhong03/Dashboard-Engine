'use strict';

// Loading splash for the Manager. Main injects the brand logo (as a data: URI)
// and pushes status text ("Initializing…", "Warming up…", …) while the Manager
// loads and warms its thumbnail cache off-screen; then main reveals the real
// Manager window and closes this splash. Two tiny hooks, called from main.

window.__splashLogo = function (src) {
  var el = document.getElementById('logo');
  if (el && src) el.src = src;
};

window.__splashStatus = function (text) {
  var el = document.getElementById('status');
  if (el && typeof text === 'string') el.textContent = text;
};
