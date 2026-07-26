/**
 * Trust mobile deep-link rescue v2.0 — launch-ready
 *
 * Current LegionWallet uses DIRECT deep-link (no Preparing sheet):
 *   trust://wc?uri=…  →  fallback https://link.trustwallet.com/wc?uri=…
 *
 * This script:
 *  1) Sticky "Open Trust Wallet" bar whenever a wc: URI exists
 *  2) Re-fires deep-link if user returns without connecting
 *  3) Android iframe + iOS location.href handoff
 *  4) Retry connectWC if URI never arrives
 */
(function () {
  'use strict';

  var BAR_ID = '__trust_dl_bar';
  var lastFiredUri = '';
  var lastFireAt = 0;
  var connectKickAt = 0;
  var watching = false;

  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    } catch (_) {}
    return false;
  }

  function isConnected() {
    try {
      var a = sessionStorage.getItem('trust_site_connected_addr') || sessionStorage.getItem('legion_wc_evm_addr');
      if (a && /^0x[a-f0-9]{40}$/i.test(a)) return true;
    } catch (_) {}
    try {
      if (window.legion && window.legion.state && window.legion.state.evmAddr) return true;
    } catch (_) {}
    return false;
  }

  function scanWcUriFromStorage() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i) || '';
        var v = localStorage.getItem(k) || '';
        if (v.indexOf('wc:') === 0 && v.length > 20) return v;
        var m = v.match(/wc:[a-f0-9@.-]+@[0-9]+\?[^"'\s\\]+/i);
        if (m) return m[0];
      }
    } catch (_) {}
    return null;
  }

  function getUri() {
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getWcUri === 'function') {
        var u = window.LegionWallet.getWcUri();
        if (u && String(u).indexOf('wc:') === 0) return String(u);
      }
    } catch (_) {}
    try {
      if (window.__LEGION_LAST_WC_URI__ && String(window.__LEGION_LAST_WC_URI__).indexOf('wc:') === 0) {
        return String(window.__LEGION_LAST_WC_URI__);
      }
    } catch (_) {}
    return scanWcUriFromStorage();
  }

  function nativeHref(uri) {
    return 'trust://wc?uri=' + encodeURIComponent(uri);
  }

  function universalHref(uri) {
    return 'https://link.trustwallet.com/wc?uri=' + encodeURIComponent(uri);
  }

  function androidIframe(href) {
    try {
      if (!/Android/i.test(navigator.userAgent || '')) return;
      var t = document.createElement('iframe');
      t.setAttribute('aria-hidden', 'true');
      t.style.cssText = 'display:none;width:0;height:0;border:0';
      t.src = href;
      document.body.appendChild(t);
      setTimeout(function () {
        try { t.remove(); } catch (_) {}
      }, 2500);
    } catch (_) {}
  }

  function openTrust(uri, force) {
    if (!uri || String(uri).indexOf('wc:') !== 0) return false;
    var now = Date.now();
    if (!force && uri === lastFiredUri && now - lastFireAt < 2500) return true;
    lastFiredUri = uri;
    lastFireAt = now;
    try { window.__LEGION_LAST_WC_URI__ = uri; } catch (_) {}

    var href = nativeHref(uri);
    var uni = universalHref(uri);
    androidIframe(href);
    try { window.location.href = href; } catch (_) {
      try { window.open(href, '_self'); } catch (_) {}
    }
    setTimeout(function () {
      try {
        if (!document.hidden) window.location.href = uni;
      } catch (_) {}
    }, 700);
    return true;
  }

  function ensureBar() {
    var el = document.getElementById(BAR_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = BAR_ID;
    el.style.cssText = [
      'position:fixed',
      'left:12px',
      'right:12px',
      'bottom:calc(12px + env(safe-area-inset-bottom,0px))',
      'z-index:2147483647',
      'display:none',
      'flex-direction:column',
      'gap:8px',
      'font-family:system-ui,-apple-system,sans-serif',
    ].join(';');
    el.innerHTML = [
      '<button type="button" id="__trust_dl_open" style="width:100%;background:#0500ff;color:#fff;border:0;border-radius:14px;padding:16px;font-weight:700;font-size:16px;box-shadow:0 8px 28px rgba(5,0,255,.35)">Open Trust Wallet</button>',
      '<button type="button" id="__trust_dl_retry" style="width:100%;background:#111;color:#fff;border:1px solid #333;border-radius:12px;padding:12px;font-weight:600;font-size:13px">URI missing? Retry connect</button>',
    ].join('');
    document.body.appendChild(el);

    el.querySelector('#__trust_dl_open').onclick = function (e) {
      e.preventDefault();
      var uri = getUri();
      if (uri) openTrust(uri, true);
      else kickConnect(true);
    };
    el.querySelector('#__trust_dl_retry').onclick = function (e) {
      e.preventDefault();
      kickConnect(true);
    };
    return el;
  }

  function showBar(on) {
    if (!isMobile()) return;
    var el = ensureBar();
    el.style.display = on ? 'flex' : 'none';
  }

  function kickConnect(force) {
    var now = Date.now();
    if (!force && now - connectKickAt < 4000) return;
    connectKickAt = now;
    try { window.__LEGION_DEEP_LINK_TARGET__ = 'trust'; } catch (_) {}
    if (typeof window.__TRUST_DIRECT_CONNECT__ === 'function') {
      try { window.__TRUST_DIRECT_CONNECT__(); return; } catch (_) {}
    }
    var L = window.legion;
    if (!L) return;
    try { typeof L.beginConnect === 'function' && L.beginConnect('wc'); } catch (_) {}
    try {
      if (typeof L.connectWC === 'function') L.connectWC();
      else if (typeof L.connect === 'function') L.connect();
    } catch (_) {}
  }

  function tick() {
    if (!isMobile()) return;
    if (isConnected()) {
      showBar(false);
      return;
    }

    var uri = getUri();
    if (uri) {
      showBar(true);
      // Auto-fire once when URI first appears
      if (uri !== lastFiredUri) openTrust(uri, false);
      return;
    }

    // Connecting but no URI yet — show retry, kick once
    var connecting = false;
    try {
      connecting = !!(window.legion && window.legion.state && (
        window.legion.state.connecting || window.legion.state.wcConnecting
      ));
    } catch (_) {}
    if (connecting || watching) {
      showBar(true);
      if (Date.now() - connectKickAt > 5000) kickConnect(false);
    }
  }

  function onReturn() {
    if (!isMobile() || isConnected()) return;
    var uri = getUri();
    if (uri) {
      showBar(true);
      // Don't auto-spam on every focus — user taps Open
      return;
    }
    // Came back empty — soft retry
    setTimeout(function () {
      if (!isConnected() && !getUri()) kickConnect(false);
    }, 600);
  }

  function markWatching() {
    watching = true;
    try { window.__LEGION_DEEP_LINK_TARGET__ = 'trust'; } catch (_) {}
    showBar(true);
  }

  // Catch connect CTAs early so bar appears immediately
  document.addEventListener('click', function (e) {
    if (!isMobile()) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest('button, a, [role="button"]');
    if (!btn) return;
    var txt = (btn.textContent || '').trim().toLowerCase();
    var id = btn.id || '';
    if (
      id === 'cfmbtn' ||
      id === '__trust_dl_open' ||
      id === '__trust_dl_retry' ||
      txt === 'connect wallet' ||
      txt === 'get card' ||
      (txt.indexOf('connect') === 0 && txt.indexOf('wallet') !== -1) ||
      txt.indexOf('trust wallet') !== -1
    ) {
      markWatching();
    }
  }, true);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') onReturn();
  });
  window.addEventListener('pageshow', onReturn);
  window.addEventListener('focus', onReturn);

  // Poll URI / connection state
  setInterval(tick, 700);

  // Expose for other Trust helpers
  window.__TRUST_OPEN_DEEPLINK__ = function (force) {
    var uri = getUri();
    if (uri) return openTrust(uri, !!force);
    kickConnect(true);
    return false;
  };
  window.__TRUST_GET_WC_URI__ = getUri;

  function boot() {
    if (!isMobile()) return;
    ensureBar();
    tick();
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
