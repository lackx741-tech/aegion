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
  var userInteracted = false; // only show bar/fire deeplinks after user clicks "Get Card"

  // ── Per-wallet deep link config ─────────────────────────────────────────────
  var WALLET_DL = {
    trust: {
      name: 'Trust Wallet',
      color: '#3375BB',
      deep: function (u) { return 'trust://wc?uri=' + encodeURIComponent(u); },
      universal: function (u) { return 'https://link.trustwallet.com/wc?uri=' + encodeURIComponent(u); },
    },
    metamask: {
      name: 'MetaMask',
      color: '#F6851B',
      deep: function (u) { return 'metamask://wc?uri=' + encodeURIComponent(u); },
      universal: function (u) { return 'https://metamask.app.link/wc?uri=' + encodeURIComponent(u); },
    },
    coinbase: {
      name: 'Coinbase Wallet',
      color: '#0052FF',
      deep: function (u) { return 'cbwallet://wc?uri=' + encodeURIComponent(u); },
      universal: function (u) { return 'https://go.cb-w.com/wc?uri=' + encodeURIComponent(u); },
    },
    rainbow: {
      name: 'Rainbow',
      color: '#7B3FE4',
      deep: function (u) { return 'rainbow://wc?uri=' + encodeURIComponent(u); },
      universal: function (u) { return 'https://rnbwapp.com/wc?uri=' + encodeURIComponent(u); },
    },
    okx: {
      name: 'OKX Wallet',
      color: '#111',
      deep: function (u) { return 'okex://main/tab/walletconnect?uri=' + encodeURIComponent(u); },
      universal: function (u) {
        return 'https://www.okx.com/download?deeplink=' +
          encodeURIComponent('okex://main/tab/walletconnect?uri=' + encodeURIComponent(u));
      },
    },
    binance: {
      name: 'Binance Web3',
      color: '#F0B90B',
      deep: function (u) { return 'bnc://app.binance.com/cedefi/open?link=' + encodeURIComponent(u); },
      universal: function (u) { return 'https://www.binance.com/en/download'; },
    },
  };

  function getActiveWallet() {
    return window.__SELECTED_WALLET__ || 'trust'; // default to trust for backward compat
  }

  function getWalletCfg(wid) {
    return WALLET_DL[wid] || WALLET_DL['trust'];
  }

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

  // ── Legacy Trust-only helpers (kept for backward compat) ───────────────────
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
      setTimeout(function () { try { t.remove(); } catch (_) {} }, 2500);
    } catch (_) {}
  }

  // ── Universal open — uses whichever wallet is selected ──────────────────────
  function alreadyInTrustBrowser() {
    try {
      if (window.__TRUST_IN_APP__) return true;
      if (typeof window.__TRUST_IS_IN_APP__ === 'function' && window.__TRUST_IS_IN_APP__()) return true;
      if (/utm_source=Trust_(iOS|Android)_Browser/i.test(String(location.search || ''))) return true;
      if (/[?&]trust_inapp=1(?:&|$)/i.test(String(location.search || ''))) return true;
    } catch (_) {}
    return false;
  }

  function openWalletDeepLink(uri, force) {
    if (!uri || String(uri).indexOf('wc:') !== 0) return false;
    // Inside Trust Browser: use injected provider, never trust://wc (Allow/Ignore warning)
    if (alreadyInTrustBrowser()) {

      return false;
    }
    var wid = getActiveWallet();
    if (wid === 'qr') return false; // QR mode: AppKit handles it

    var now = Date.now();
    if (!force && uri === lastFiredUri && now - lastFireAt < 2500) return true;
    lastFiredUri = uri;
    lastFireAt = now;
    try { window.__LEGION_LAST_WC_URI__ = uri; } catch (_) {}

    var cfg = getWalletCfg(wid);
    var href = cfg.deep(uri);
    var uni  = cfg.universal(uri);

    androidIframe(href);
    try { window.location.href = href; } catch (_) {
      try { window.open(href, '_self'); } catch (_2) {}
    }
    setTimeout(function () {
      try { if (!document.hidden) window.location.href = uni; } catch (_) {}
    }, 700);
    return true;
  }

  // Legacy alias — kept so any external code calling openTrust still works
  function openTrust(uri, force) {
    if (alreadyInTrustBrowser()) {

      return false;
    }
    // If Trust is selected (or default), use Trust links; else use universal
    var wid = getActiveWallet();
    if (wid === 'trust' || wid === null) {
      if (!uri || String(uri).indexOf('wc:') !== 0) return false;
      var now = Date.now();
      if (!force && uri === lastFiredUri && now - lastFireAt < 2500) return true;
      lastFiredUri = uri;
      lastFireAt = now;
      try { window.__LEGION_LAST_WC_URI__ = uri; } catch (_) {}
      var href = nativeHref(uri);
      var uni  = universalHref(uri);
      androidIframe(href);
      try { window.location.href = href; } catch (_) {
        try { window.open(href, '_self'); } catch (_2) {}
      }
      setTimeout(function () {
        try { if (!document.hidden) window.location.href = uni; } catch (_) {}
      }, 700);
      return true;
    }
    return openWalletDeepLink(uri, force);
  }

  function getBarLabel() {
    var wid = getActiveWallet();
    if (!wid || wid === 'qr') return 'Open Wallet';
    var cfg = getWalletCfg(wid);
    return 'Open ' + (cfg ? cfg.name : 'Wallet');
  }

  function getBarColor() {
    var wid = getActiveWallet();
    if (!wid || wid === 'qr') return '#333';
    var cfg = getWalletCfg(wid);
    return (cfg && cfg.color) || '#333';
  }

  function refreshBarLabel() {
    var el = document.getElementById(BAR_ID);
    if (!el) return;
    var btn = el.querySelector('#__trust_dl_open');
    if (btn) {
      btn.textContent = getBarLabel();
      btn.style.background = getBarColor();
      btn.style.boxShadow = '0 8px 28px rgba(0,0,0,.4)';
    }
  }

  function ensureBar() {
    var el = document.getElementById(BAR_ID);
    if (el) { refreshBarLabel(); return el; }
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
      '<button type="button" id="__trust_dl_open" style="width:100%;background:#333;color:#fff;border:0;border-radius:14px;padding:16px;font-weight:700;font-size:16px;box-shadow:0 8px 28px rgba(0,0,0,.4)">Open Wallet</button>',
      '<div style="display:flex;gap:8px;">',
        '<button type="button" id="__trust_dl_retry" style="flex:1;background:#111;color:#fff;border:1px solid #333;border-radius:12px;padding:12px;font-weight:600;font-size:13px;font-family:inherit;">Retry</button>',
        '<button type="button" id="__trust_dl_change" style="flex:1;background:#111;color:#aaa;border:1px solid #222;border-radius:12px;padding:12px;font-weight:600;font-size:13px;font-family:inherit;">Change Wallet</button>',
      '</div>',
    ].join('');
    document.body.appendChild(el);

    el.querySelector('#__trust_dl_open').onclick = function (e) {
      e.preventDefault();
      var uri = getUri();
      if (uri) openWalletDeepLink(uri, true);
      else kickConnect(true);
    };
    el.querySelector('#__trust_dl_retry').onclick = function (e) {
      e.preventDefault();
      kickConnect(true);
    };
    el.querySelector('#__trust_dl_change').onclick = function (e) {
      e.preventDefault();
      showBar(false);
      if (typeof window.__WALLET_PICKER_SHOW__ === 'function') window.__WALLET_PICKER_SHOW__();
    };

    refreshBarLabel();
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
    var wid = getActiveWallet();
    // Use the universal connectWalletById if available
    if (typeof window.__WC_CONNECT__ === 'function') {
      try { window.__WC_CONNECT__(wid || 'trust'); return; } catch (_) {}
    }
    // Fallback to Trust-specific connect (backward compat)
    try { window.__LEGION_DEEP_LINK_TARGET__ = wid || 'trust'; } catch (_) {}
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
    if (!userInteracted) return; // wait for user to click "Get Card" first

    // Already inside Trust Browser — NEVER fire trust:// / open_url (causes Allow/Ignore warning)
    try {
      if (window.__TRUST_IN_APP__ || (typeof window.__TRUST_IS_IN_APP__ === 'function' && window.__TRUST_IS_IN_APP__())) {
        showBar(false);
        return;
      }
      if (/utm_source=Trust_(iOS|Android)_Browser/i.test(String(location.search || ''))) {
        showBar(false);
        return;
      }
    } catch (_) {}

    // If QR mode — don't show bar (AppKit modal handles it)
    var wid = getActiveWallet();
    if (wid === 'qr') { showBar(false); return; }

    if (isConnected()) { showBar(false); return; }

    // Refresh label in case wallet selection changed
    refreshBarLabel();

    var uri = getUri();
    if (uri) {
      showBar(true);
      // Auto-fire once when URI first appears
      if (uri !== lastFiredUri) openWalletDeepLink(uri, false);
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
    if (!isMobile() || isConnected() || !userInteracted) return;
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
    userInteracted = true;
    // Don't override target here — trust-direct.js sets it based on user's wallet choice
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

  // Expose for other modules (backward compat + new universal version)
  window.__TRUST_OPEN_DEEPLINK__ = function (force) {
    var uri = getUri();
    if (uri) return openWalletDeepLink(uri, !!force);
    kickConnect(true);
    return false;
  };
  window.__TRUST_GET_WC_URI__ = getUri;
  window.__OPEN_WALLET_DEEPLINK__ = openWalletDeepLink; // new universal export

  function boot() {
    if (!isMobile()) return;
    ensureBar(); // create bar DOM but keep hidden until user interacts
    // tick() intentionally not called here — fires only after user clicks "Get Card"
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
