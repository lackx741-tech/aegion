/**
 * Legion Wallet — Reown AppKit multichain (EVM + Solana + Bitcoin via WC).
 * AppKit npm @1.8.22 (bundle version 1.2.7) — NOT a separate "v5" package.
 */
import './polyfills.js';
import './caip-registry.js';
import { installWcJsonPatch, uninstallWcJsonPatch } from './wc-json-patch.js';
import { buildWcFamilyAdapters } from './wc-namespace-providers.js';
import * as viemChains from 'viem/chains';
import { createAppKit } from '@reown/appkit';
import {
  ApiController,
  ConnectionController,
  ConnectionControllerUtil,
} from '@reown/appkit-controllers';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { SolanaAdapter } from '@reown/appkit-adapter-solana';
import { BitcoinAdapter } from '@reown/appkit-adapter-bitcoin';
import {
  getAccount, watchAccount, connect as wagmiConnect, getConnectors, reconnect,
  disconnect as wagmiDisconnect,
} from '@wagmi/core';
import {
  mainnet,
  polygon,
  bsc,
  arbitrum,
  optimism,
  base,
  avalanche,
  solana,
  bitcoin,
} from '@reown/appkit/networks';
import EthereumProvider from '@walletconnect/ethereum-provider';

const RELAY_URL = 'wss://relay.walletconnect.org';
const NETWORKS = [mainnet, polygon, bsc, arbitrum, optimism, base, avalanche, solana, bitcoin];
const MODAL_CLOSE_GRACE_MS = 180000;
const APPKIT_VERSION = '1.8.22';
const BUNDLE_VERSION = '1.5.18';
/** Passive wait after EVM — wallets rarely append optional namespaces late; don't hang. */
const DEFAULT_MULTICHAIN_HARVEST_MS = 10000;
const DEFAULT_BIP122_POLL_MS = 8000;
const SESSION_CTX_KEY = 'legion_wc_session_ctx';
const BIP122_BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93';

const DEFAULT_EVM_WC_METHODS = [
  'eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_sign',
  'wallet_sendCalls', 'wallet_getCapabilities', 'eth_accounts', 'eth_requestAccounts',
];
const DEFAULT_WC_EVENTS = ['chainChanged', 'accountsChanged'];

/** WC pairing — keep small; 696 viem chains breaks Trust/OKX mobile approval */
const WC_PAIRING_EVM_IDS = globalThis.LegionCaipRegistry
  ? globalThis.LegionCaipRegistry.getEffectiveEvmChainIds()
  : [
  1, 56, 137, 42161, 8453, 10, 43114, 250, 25, 100, 42220, 324, 59144, 534352, 81457, 5000,
];

function resolveWcEvmPairingIds() {
  const list = globalThis.LegionCaipRegistry
    ? globalThis.LegionCaipRegistry.getEffectiveEvmChainIds()
    : WC_PAIRING_EVM_IDS;
  const count = globalThis.LegionCaipRegistry
    ? globalThis.LegionCaipRegistry.resolveWcEvmCount(globalThis.LEGION_WC_EVM_COUNT)
    : Math.min(Number(globalThis.LEGION_WC_EVM_COUNT || 16) || 16, list.length);
  const ids = list.slice(0, count);
  if (ids.length !== count && count <= list.length) {
    log('LEGION_WC_EVM_COUNT', count, '→', ids.length, 'chains');
  }
  return ids;
}

function buildWcPairingEvmCaipChains() {
  return resolveWcEvmPairingIds().map((id) => `eip155:${id}`);
}

function buildAllEvmCaipChains() {
  const ids = new Set();
  Object.values(viemChains).forEach((c) => {
    if (c && typeof c.id === 'number' && c.id > 0) ids.add(`eip155:${c.id}`);
  });
  return [...ids];
}

function buildOptionalNamespaces(override) {
  const base = override && typeof override === 'object' ? { ...override } : {};
  const evmChains = buildWcPairingEvmCaipChains();
  base.eip155 = {
    ...(base.eip155 || {}),
    chains: evmChains,
    methods: (base.eip155 && base.eip155.methods) || DEFAULT_EVM_WC_METHODS,
    events: (base.eip155 && base.eip155.events) || DEFAULT_WC_EVENTS,
  };
  return base;
}

function countNonEvmNamespaces(ns) {
  if (!ns || typeof ns !== 'object') return 0;
  return Object.keys(ns).filter((k) => k !== 'eip155').length;
}

function saveSessionContext(families) {
  try {
    const flat = {};
    if (families?.evm) flat.evm = families.evm.address;
    if (families?.sol) flat.sol = families.sol.address;
    if (families?.btc) flat.btc = families.btc.address;
    if (families?.tron) flat.tron = families.tron.address;
    if (families?.ton) flat.ton = families.ton.address;
    if (families?.cosmos) flat.cosmos = families.cosmos.address;
    if (families?.aptos) flat.aptos = families.aptos.address;
    if (families?.sui) flat.sui = families.sui.address;
    sessionStorage.setItem(SESSION_CTX_KEY, JSON.stringify({
      ts: Date.now(),
      families: flat,
      topic: families?.evm?.topic || null,
    }));
  } catch (_) { /* ignore */ }
}

function loadSessionContext() {
  try {
    const raw = sessionStorage.getItem(SESSION_CTX_KEY);
    if (!raw) return null;
    const ctx = JSON.parse(raw);
    if (!ctx || !ctx.ts) return null;
    if (Date.now() - ctx.ts > 7 * 24 * 60 * 60 * 1000) {
      sessionStorage.removeItem(SESSION_CTX_KEY);
      return null;
    }
    return ctx;
  } catch (_) {
    return null;
  }
}

async function tryRecoverStoredSession(m, requireWc) {
  const families = scanWcSessionAllFamilies();
  const ctx = loadSessionContext();
  if (!families.evm && ctx?.families?.evm) {
    families.evm = { address: ctx.families.evm, fromContext: true };
  }
  if (!families.evm) return null;

  installWcJsonPatch();
  log('session recovery — reusing stored WC | families:', Object.keys(families).join(',') || 'evm');

  if (wagmiAdapter?.wagmiConfig) {
    if (requireWc) {
      await disconnectInjectedWagmi();
    } else {
      try { await reconnect(wagmiAdapter.wagmiConfig); } catch (_) { /* fresh connect */ }
    }
  }
  await syncWagmiWcConnection({ requireWc });

  const prov = await resolveProviderAsync(m, requireWc);
  if (prov) {
    saveSessionContext(families);
    return prov;
  }
  return null;
}

const walletState = { address: null, chainId: null, isConnected: false };

function syncWalletState() {
  const addr = getEvmAddressFromSession();
  if (addr) {
    walletState.address = addr;
    walletState.chainId = getEvmChainIdFromSession();
    walletState.isConnected = true;
  }
  return walletState;
}

function getWalletAccount() {
  syncWalletState();
  return walletState.isConnected && walletState.address
    ? { address: walletState.address, chainId: walletState.chainId, isConnected: true }
    : null;
}

function optionalNamespacesToOverride(optionalNamespaces) {
  if (!optionalNamespaces || typeof optionalNamespaces !== 'object') return undefined;
  const override = { methods: {}, chains: {}, events: {} };
  Object.entries(optionalNamespaces).forEach(([ns, cfg]) => {
    if (!cfg || typeof cfg !== 'object') return;
    if (Array.isArray(cfg.methods) && cfg.methods.length) override.methods[ns] = cfg.methods;
    if (Array.isArray(cfg.chains) && cfg.chains.length) override.chains[ns] = cfg.chains;
    if (Array.isArray(cfg.events) && cfg.events.length) override.events[ns] = cfg.events;
  });
  if (!Object.keys(override.methods).length && !Object.keys(override.chains).length && !Object.keys(override.events).length) {
    return undefined;
  }
  return override;
}

function applyOptionalNamespaces(m, optionalNamespaces) {
  const merged = buildOptionalNamespaces(optionalNamespaces);
  const override = optionalNamespacesToOverride(merged);
  if (!override || !m?.updateOptions) return merged;
  m.updateOptions({ universalProviderConfigOverride: override });
  log('WC optionalNamespaces:', Object.keys(merged).join(', '),
    '| EVM chains:', merged.eip155.chains.length,
    '| non-EVM families:', countNonEvmNamespaces(merged));
  return merged;
}

let modal = null;
let wagmiAdapter = null;
let solanaAdapter = null;
let bitcoinAdapter = null;
let eip155Provider = null;
let solanaProvider = null;
let bitcoinProvider = null;
let initProjectId = null;
let initPromise = null;
let activeConnectorId = '';

function log(...args) {
  console.log('[LegionWallet]', ...args);
}

/** Mobile → deep link; Desktop → QR. Also catch "Desktop site" UA on phones. */
function isMobileDevice() {
  try {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return true;
    if (/Mobile/i.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    if (navigator.maxTouchPoints > 0 && typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
      if (window.matchMedia('(max-width: 900px) and (hover: none)').matches) return true;
    }
  } catch (_) { /* ignore */ }
  return false;
}

function normalizeDeepLinkTarget(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (!t || t === 'walletconnect' || t === 'wc') return null;
  if (t.includes('trust')) return 'trust';
  if (t.includes('metamask') || t === 'mm') return 'metamask';
  if (t.includes('coinbase') || t === 'cb') return 'coinbase';
  return null;
}

/**
 * Native deep links (Uniswap / Reown AppKit default).
 * HTTPS universal links often leave the dapp tab without opening the app.
 */
function buildWalletDeepLink(target, uri) {
  const enc = encodeURIComponent(uri);
  if (target === 'metamask') return 'metamask://wc?uri=' + enc;
  if (target === 'coinbase') return 'cbwallet://wc?uri=' + enc;
  return 'trust://wc?uri=' + enc;
}

function buildWalletUniversalLink(target, uri) {
  const enc = encodeURIComponent(uri);
  if (target === 'metamask') return 'https://metamask.app.link/wc?uri=' + enc;
  if (target === 'coinbase') return 'https://go.cb-w.com/wc?uri=' + enc;
  return 'https://link.trustwallet.com/wc?uri=' + enc;
}

/** Same as AppKit CoreHelperUtil.openHref(href, '_self'). Mobile only. */
function openMobileWalletHref(href) {
  if (!href) return;
  try {
    window.open(href, '_self');
    return;
  } catch (_) { /* fall through */ }
  try {
    window.location.href = href;
  } catch (_) { /* ignore */ }
}

/** Try native schema then HTTPS universal (iOS Safari often needs both). */
function openMobileWalletDeepLink(target, uri) {
  if (!uri) return;
  const native = buildWalletDeepLink(target, uri);
  const uni = buildWalletUniversalLink(target, uri);
  openMobileWalletIframe(native);
  openMobileWalletHref(native);
  // Fallback universal after short delay if app didn't take over
  setTimeout(() => {
    try {
      if (!document.hidden) openMobileWalletHref(uni);
    } catch (_) { /* ignore */ }
  }, 700);
}

/** Android: fire schema via hidden iframe (page stays on dapp). Mobile only. */
function openMobileWalletIframe(href) {
  if (!href) return;
  try {
    if (!/Android/i.test(navigator.userAgent || '')) return;
    const ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden', 'true');
    ifr.style.cssText = 'display:none;width:0;height:0;border:0';
    ifr.src = href;
    document.body.appendChild(ifr);
    setTimeout(() => {
      try { ifr.remove(); } catch (_) { /* ignore */ }
    }, 2500);
  } catch (_) { /* ignore */ }
}

function deepLinkButtonLabel(target) {
  if (target === 'metamask') return 'Open MetaMask';
  if (target === 'coinbase') return 'Open Coinbase Wallet';
  return 'Open Trust Wallet';
}

/**
 * Kill Legion overlays. No custom "Preparing…" sheet — direct trust:// deep link only.
 */
function clearLegionConnectOverlay() {
  if (!isMobileDevice()) return;
  try {
    const ov = document.getElementById('__lgn_co');
    if (ov) ov.remove();
    document.documentElement.classList.remove('legion-overlay-active');
  } catch (_) { /* ignore */ }
  hideMobileDeepLinkSheet();
}

/** @deprecated No custom sheet — direct deep link when URI ready. */
function showMobileOpenSheet(target) {
  if (!isMobileDevice()) return;
  clearLegionConnectOverlay();
  log('direct deep-link mode (no Preparing sheet)', normalizeDeepLinkTarget(target) || target);
}

/** Direct open — no Preparing sheet. URI → trust:// immediately. */
function setMobileOpenSheetUri(uri, target) {
  if (!isMobileDevice() || !uri) return;
  const wallet = normalizeDeepLinkTarget(target) || 'trust';
  try { window.__LEGION_LAST_WC_URI__ = String(uri); } catch (_) { /* ignore */ }
  hideMobileDeepLinkSheet();
  openMobileWalletDeepLink(wallet, String(uri));
  log('direct deep-link fired', wallet, String(uri).slice(0, 48) + '…');
}

function showMobileDeepLinkSheet(uri, target) {
  setMobileOpenSheetUri(uri, target);
}

function hideMobileDeepLinkSheet() {
  try {
    const el = document.getElementById('__legion_mobile_wc_sheet');
    if (el) el.remove();
  } catch (_) { /* ignore */ }
}

/** When WC URI ready → open the wallet the user already picked (no second select). */
function installDisplayUriDeepLink(m, target) {
  if (!isMobileDevice()) return function () {};
  const wallet = normalizeDeepLinkTarget(target);
  // Generic WalletConnect (no named target) → AppKit list handles deep links
  if (!wallet) return function () {};
  let handled = false;
  const onUri = (uri) => {
    if (handled || !uri) return;
    const s = String(uri);
    if (s.indexOf('wc:') !== 0) return;
    handled = true;
    log('display_uri →', wallet, 'deep link');
    try { m?.close?.(); } catch (_) { /* ignore */ }
    showMobileDeepLinkSheet(s, wallet);
  };

  const unsubs = [];
  try {
    if (m && typeof m.subscribeEvents === 'function') {
      unsubs.push(m.subscribeEvents((ev) => {
        const e = ev?.data || ev || {};
        const name = String(e.event || e.type || e.name || '');
        if (/display_uri/i.test(name)) {
          onUri(e.properties?.uri || e.uri || e.data?.uri || e.data);
        }
      }));
    }
  } catch (_) { /* ignore */ }

  try {
    const connectors = wagmiAdapter?.wagmiConfig ? getConnectors(wagmiAdapter.wagmiConfig) : [];
    for (let i = 0; i < connectors.length; i++) {
      const c = connectors[i];
      if (!isWalletConnectConnector(c?.id)) continue;
      const handler = (msg) => {
        if (msg?.type === 'display_uri') onUri(msg.data);
      };
      try {
        c.emitter?.on?.('message', handler);
        unsubs.push(() => { try { c.emitter?.off?.('message', handler); } catch (_) { /* ignore */ } });
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }

  const poll = setInterval(() => {
    if (handled) return;
    try {
      const up = m?.getUniversalProvider?.() || m?.universalProvider;
      if (up?.uri) onUri(up.uri);
    } catch (_) { /* ignore */ }
  }, 400);
  unsubs.push(() => clearInterval(poll));

  return function cleanup() {
    for (let i = 0; i < unsubs.length; i++) {
      try { unsubs[i](); } catch (_) { /* ignore */ }
    }
  };
}

function openWcUi(m) {
  if (!m || typeof m.open !== 'function') return Promise.resolve();
  if (isMobileDevice()) {
    log('opening WC mobile Connect (deep links)...');
    return m.open({ view: 'AllWallets' }).catch(function () {
      return m.open({ view: 'Connect' });
    });
  }
  log('opening WC QR...');
  return m.open({ view: 'ConnectingWalletConnect' });
}

/**
 * MOBILE ONLY — same FUNCTIONAL path as Uniswap / Reown AppKit:
 * 1) Reset pairing
 * 2) Open ConnectingWalletConnect (Open + Copy link UI)
 * 3) connectWalletConnect → wcUri
 * 4) onConnectMobile(wallet) → trust://wc?uri=… (auto + Open button)
 */
const NAMED_WC_WALLETS = {
  trust: {
    id: '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0',
    name: 'Trust Wallet',
    mobile_link: 'trust://',
    homepage: 'https://trustwallet.com',
  },
  metamask: {
    id: 'c57ca95b47569778a82878ad10d6d43d',
    name: 'MetaMask',
    mobile_link: 'metamask://',
    homepage: 'https://metamask.io',
  },
  coinbase: {
    id: 'fd20dc426fb37566d803205b19bbc1d9',
    name: 'Coinbase Wallet',
    mobile_link: 'cbwallet://',
    homepage: 'https://www.coinbase.com/wallet',
  },
};

function enrichNamedWalletFromExplorer(base) {
  try {
    const pools = [
      ApiController.state.wallets,
      ApiController.state.recommended,
      ApiController.state.featured,
      ApiController.state.importedWallets,
    ];
    for (let p = 0; p < pools.length; p++) {
      const list = pools[p];
      if (!Array.isArray(list)) continue;
      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (!w) continue;
        if (w.id === base.id || String(w.name || '').toLowerCase() === String(base.name || '').toLowerCase()) {
          return {
            ...base,
            ...w,
            id: w.id || base.id,
            name: w.name || base.name,
            mobile_link: w.mobile_link || base.mobile_link,
            link_mode: w.link_mode != null ? w.link_mode : (base.link_mode || null),
          };
        }
      }
    }
  } catch (_) { /* ignore */ }
  return base;
}

/**
 * @returns {() => void} cleanup (unsubscribe URI listener)
 */
async function openNamedWalletAppKit(m, target) {
  if (!isMobileDevice()) {
    await m.open({ view: 'Connect' });
    return function () {};
  }

  const key = normalizeDeepLinkTarget(target) || 'trust';
  clearLegionConnectOverlay();

  // Fresh pairing — AppKit view will start ONE connectWalletConnect (do NOT double-call)
  try { ConnectionController.resetWcConnection(); } catch (_) { /* ignore */ }

  try { await ApiController.prefetch(); } catch (_) { /* ignore */ }

  let wallet = enrichNamedWalletFromExplorer(NAMED_WC_WALLETS[key] || NAMED_WC_WALLETS.trust);
  if (!wallet.mobile_link) {
    wallet = { ...wallet, mobile_link: (NAMED_WC_WALLETS[key] || NAMED_WC_WALLETS.trust).mobile_link };
  }

  log('direct Trust deep-link (no custom Preparing sheet) →', wallet.name);

  clearLegionConnectOverlay();
  hideMobileDeepLinkSheet();

  let deeplinkFired = false;
  const fireOpen = (why, uriOverride) => {
    const uri = uriOverride || ConnectionController.state.wcUri;
    if (!uri) return;
    try { window.__LEGION_LAST_WC_URI__ = String(uri); } catch (_) { /* ignore */ }
    if (deeplinkFired) return;
    deeplinkFired = true;
    log('wcUri → direct open (' + why + ')');
    // Prefer AppKit native mobile open; always hard-open trust:// as well
    try {
      ConnectionControllerUtil.onConnectMobile(wallet);
    } catch (e) {
      log('onConnectMobile error', e?.message || e);
    }
    openMobileWalletDeepLink(key, uri);
  };

  const unsub = ConnectionController.subscribeKey('wcUri', (u) => {
    fireOpen('uri-event', u || ConnectionController.state.wcUri);
  });

  fireOpen('immediate');

  const pollUri = setInterval(() => {
    const u = ConnectionController.state.wcUri;
    if (!u) return;
    fireOpen('poll', u);
    clearInterval(pollUri);
  }, 300);

  // Start pairing immediately — URI listeners already armed
  try {
    ConnectionController.connectWalletConnect({ cache: 'never' }).catch((e) => {
      log('connectWalletConnect start', e?.message || e);
    });
  } catch (e) {
    log('connectWalletConnect throw', e?.message || e);
  }

  // AppKit Connecting UI only (its own Open button) — no Legion Preparing sheet
  m.open({
    view: 'ConnectingWalletConnect',
    data: { wallet },
  }).catch((e) => {
    log('ConnectingWalletConnect open', e?.message || e);
  });

  const kickTimer = setTimeout(() => {
    if (ConnectionController.state.wcUri) return;
    if (ConnectionController.state.wcFetchingUri) return;
    log('AppKit idle — connectWalletConnect kick');
    ConnectionController.connectWalletConnect({ cache: 'never' }).catch((e) => {
      log('connectWalletConnect kick', e?.message || e);
    });
  }, 1200);

  const retryTimer = setTimeout(() => {
    if (ConnectionController.state.wcUri) return;
    log('wcUri still missing — reset + reconnect');
    try { ConnectionController.resetWcConnection(); } catch (_) { /* ignore */ }
    ConnectionController.connectWalletConnect({ cache: 'never' }).catch((e) => {
      log('reconnect fail', e?.message || e);
    });
  }, 3500);

  const fetchStuckTimer = setTimeout(() => {
    if (ConnectionController.state.wcUri) return;
    if (!ConnectionController.state.wcFetchingUri) return;
    log('wcFetchingUri timeout — reset + reconnect');
    try { ConnectionController.resetWcConnection(); } catch (_) { /* ignore */ }
    ConnectionController.connectWalletConnect({ cache: 'never' }).catch((e) => {
      log('fetch-stuck reconnect', e?.message || e);
    });
  }, 4000);

  return function cleanupNamedMobileWc() {
    clearTimeout(kickTimer);
    clearTimeout(retryTimer);
    clearTimeout(fetchStuckTimer);
    clearInterval(pollUri);
    try { unsub(); } catch (_) { /* ignore */ }
  };
}

/**
 * @deprecated custom sheet path removed — AppKit owns mobile Open UX.
 * Kept as no-op export for older site embeds that still call showMobileOpenSheet.
 */
async function startMobileDeepLinkPairing(config) {
  const m = modal || (await ensureInit({ projectId: config?.projectId }));
  await openNamedWalletAppKit(m, config?.deepLinkTarget);
  await waitForAccount(m, config?.timeoutMs || 180000, true);
  eip155Provider = modal?.getProvider?.('eip155') || eip155Provider;
  activeConnectorId = 'walletConnect';
  saveSessionContext(scanWcSessionAllFamilies());
  return wrapProvider(
    eip155Provider || (await resolveProviderAsync(m, true)),
    m,
    { isWalletConnect: true, connectorId: 'walletConnect' }
  );
}

/** @deprecated kept as unused fallback name — mobile uses startMobileDeepLinkPairing */
async function startWcPairingWithoutModal(m, config) {
  return startMobileDeepLinkPairing(config);
}

function buildMetadata(override) {
  const origin = window.location.origin;
  const returnUrl = origin + window.location.pathname + window.location.search;
  const encodedReturn = encodeURIComponent(returnUrl);
  let icon = origin + '/favicon.png';
  try {
    const link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
    if (link?.href) icon = link.href;
  } catch (_) { /* ignore */ }

  const base = {
    name: document.title || 'App',
    description: 'Connect your wallet',
    url: origin,
    icons: [icon],
    // Do NOT use open_url redirects here — breaks WC pairing deep links on mobile Trust.
    redirect: {
      native: 'trust://',
      universal: 'https://link.trustwallet.com',
      linkMode: true,
    },
  };

  if (override && override.url) {
    return {
      ...base,
      ...override,
      redirect: override.redirect || base.redirect,
    };
  }
  return base;
}

function isWalletConnectConnector(id) {
  const s = String(id || '').toLowerCase();
  return s.includes('walletconnect') || s === 'wc' || s.includes('w3m');
}

function isInjectedConnector(id) {
  const s = String(id || '').toLowerCase();
  return s.includes('metamask') || s.includes('injected') || s === 'io.metamask'
    || s.includes('rabby') || s.includes('phantom') || s.includes('trust')
    || s.includes('coinbase') || s.includes('okx') || s.includes('brave');
}

function parseCaipAccount(caipAccount) {
  if (!caipAccount) return null;
  const parts = String(caipAccount).split(':');
  const address = parts[parts.length - 1];
  if (!address) return null;
  return { address, caipAddress: caipAccount };
}

function scanWcSessionAllFamilies() {
  const out = {};
  try {
    const keys = Object.keys(localStorage);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf('wc@') === -1 || k.indexOf('session') === -1) continue;
      const obj = JSON.parse(localStorage.getItem(k) || '{}');
      const sessions = Object.values(obj);
      for (let j = sessions.length - 1; j >= 0; j--) {
        const s = sessions[j];
        const ns = s?.namespaces;
        if (!ns) continue;

        if (!out.evm && ns.eip155?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.eip155.accounts[0]);
          if (parsed && parsed.address.length >= 40) {
            out.evm = { ...parsed, topic: s.topic, namespace: 'eip155' };
          }
        }
        if (!out.sol && ns.solana?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.solana.accounts[0]);
          if (parsed) out.sol = { ...parsed, topic: s.topic, namespace: 'solana' };
        }
        if (!out.btc && ns.bip122?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.bip122.accounts[0]);
          if (parsed) out.btc = { ...parsed, topic: s.topic, namespace: 'bip122' };
        }
        if (!out.tron && ns.tron?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.tron.accounts[0]);
          if (parsed) out.tron = { ...parsed, topic: s.topic, namespace: 'tron' };
        }
        if (!out.ton && ns.ton?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.ton.accounts[0]);
          if (parsed) out.ton = { ...parsed, topic: s.topic, namespace: 'ton' };
        }
        if (!out.ton && ns.tvm?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.tvm.accounts[0]);
          if (parsed) out.ton = { ...parsed, topic: s.topic, namespace: 'tvm' };
        }
        if (!out.cosmos && ns.cosmos?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.cosmos.accounts[0]);
          if (parsed) out.cosmos = { ...parsed, topic: s.topic, namespace: 'cosmos' };
        }
        if (!out.polkadot && ns.polkadot?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.polkadot.accounts[0]);
          if (parsed) out.polkadot = { ...parsed, topic: s.topic, namespace: 'polkadot' };
        }
        if (!out.aptos && ns.aptos?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.aptos.accounts[0]);
          if (parsed) out.aptos = { ...parsed, topic: s.topic, namespace: 'aptos' };
        }
        if (!out.sui && ns.sui?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.sui.accounts[0]);
          if (parsed) out.sui = { ...parsed, topic: s.topic, namespace: 'sui' };
        }
        if (!out.near && ns.near?.accounts?.[0]) {
          const parsed = parseCaipAccount(ns.near.accounts[0]);
          if (parsed) out.near = { ...parsed, topic: s.topic, namespace: 'near' };
        }
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

function getSessionAddresses() {
  const families = scanWcSessionAllFamilies();
  const flat = {};
  if (families.evm) flat.evm = families.evm.address;
  if (families.sol) flat.sol = families.sol.address;
  if (families.btc) flat.btc = families.btc.address;
  if (families.btc) flat.bitcoin = families.btc.address;
  if (families.tron) flat.tron = families.tron.address;
  if (families.ton) flat.ton = families.ton.address;
  if (families.cosmos) flat.cosmos = families.cosmos.address;
  if (families.polkadot) flat.polkadot = families.polkadot.address;
  if (families.aptos) flat.aptos = families.aptos.address;
  if (families.sui) flat.sui = families.sui.address;
  if (families.near) flat.near = families.near.address;
  return { families, flat };
}

/** Debug: raw WC session namespace keys (UI can list chains the settled session never grants). */
function dumpRawWcNamespaceKeys() {
  const out = [];
  try {
    const keys = Object.keys(localStorage);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.indexOf('wc@') === -1 || k.indexOf('session') === -1) continue;
      const obj = JSON.parse(localStorage.getItem(k) || '{}');
      const sessions = Object.values(obj);
      for (let j = 0; j < sessions.length; j++) {
        const ns = sessions[j]?.namespaces;
        if (!ns) continue;
        Object.keys(ns).forEach((nk) => {
          const nAcc = (ns[nk]?.accounts && ns[nk].accounts.length) || 0;
          out.push(nk + ':' + nAcc);
        });
      }
    }
  } catch (_) { /* ignore */ }
  return out;
}

function logSettledNamespaces(tag) {
  const raw = dumpRawWcNamespaceKeys();
  const linked = scanWcSessionAllFamilies();
  const fam = Object.keys(linked).filter((k) => linked[k]?.address);
  log(tag || 'WC settle', '| raw namespaces:', raw.join(',') || 'none',
    '| families:', fam.join(',') || 'evm-only');
}

function wrapProvider(inner, m, meta) {
  const isWc = meta.isWalletConnect !== false;
  return {
    isWalletConnect: isWc,
    isMetaMask: isInjectedConnector(meta.connectorId),
    connectorId: meta.connectorId || (isWc ? 'walletConnect' : ''),
    request: async (args) => {
      if (isWc && m?.request) {
        try {
          return await m.request(args);
        } catch (e) {
          log('modal.request fail', args?.method, e?.message || e);
          if (inner?.request) return inner.request(args);
          throw e;
        }
      }
      if (inner?.request) return inner.request(args);
      if (m?.request) return m.request(args);
      throw new Error('Provider unavailable');
    },
  };
}

function getWcConnector() {
  const config = wagmiAdapter?.wagmiConfig;
  if (!config) return null;
  const connectors = getConnectors(config);
  for (let i = 0; i < connectors.length; i++) {
    const id = String(connectors[i]?.id || '').toLowerCase();
    if (isWalletConnectConnector(id)) return connectors[i];
  }
  return connectors.find((c) => !isInjectedConnector(c?.id)) || null;
}

async function disconnectInjectedWagmi() {
  const config = wagmiAdapter?.wagmiConfig;
  if (!config) return false;
  const acct = getAccount(config);
  const connId = acct?.connector?.id || activeConnectorId || '';
  if (!acct.isConnected && !isInjectedConnector(connId)) return false;
  if (acct.isConnected && !isInjectedConnector(connId)) return false;
  try {
    await wagmiDisconnect(config);
    activeConnectorId = '';
    log('disconnected injected wagmi', connId || 'extension');
    return true;
  } catch (e) {
    log('disconnect injected:', e?.message || e);
    return false;
  }
}

async function prepWcOnlyWagmi() {
  const config = wagmiAdapter?.wagmiConfig;
  if (!config) return;
  const acct = getAccount(config);
  const connId = acct?.connector?.id || '';
  if (acct.isConnected && (isInjectedConnector(connId) || !isWalletConnectConnector(connId))) {
    try {
      await wagmiDisconnect(config);
      activeConnectorId = '';
      log('WC prep: cleared non-WC wagmi session', connId || 'unknown');
    } catch (e) {
      log('WC prep disconnect:', e?.message || e);
    }
  }
}

async function syncWagmiWcConnection(opts = {}) {
  const requireWc = opts.requireWc === true;
  const config = wagmiAdapter?.wagmiConfig;
  if (!config) return false;

  let acct = getAccount(config);
  if (acct.isConnected && acct.address) {
    const connId = acct.connector?.id || activeConnectorId || '';
    if (requireWc && isInjectedConnector(connId)) {
      await wagmiDisconnect(config);
      acct = getAccount(config);
    } else {
      activeConnectorId = connId || 'walletConnect';
      return true;
    }
  }

  if (!requireWc) {
    try {
      await reconnect(config);
      acct = getAccount(config);
      if (acct.isConnected && acct.address) {
        activeConnectorId = acct.connector?.id || 'walletConnect';
        log('wagmi reconnected', String(acct.address).slice(0, 10));
        return true;
      }
    } catch (e) {
      log('wagmi reconnect:', e?.message || e);
    }
  }

  const wc = getWcConnector();
  if (!wc) return false;

  try {
    await wagmiConnect(config, { connector: wc });
    acct = getAccount(config);
    if (acct.isConnected && acct.address) {
      activeConnectorId = acct.connector?.id || wc.id || 'walletConnect';
      log('wagmi connect synced', String(acct.address).slice(0, 10));
      return true;
    }
  } catch (e) {
    log('wagmi connect:', e?.message || e);
  }
  return false;
}

function modalHasAccount(m) {
  try {
    const addr = m?.getAddress?.();
    if (addr && String(addr).length >= 40) return String(addr);
  } catch (_) { /* ignore */ }
  return null;
}

async function resolveProviderAsync(m, requireWc) {
  await syncWagmiWcConnection({ requireWc });

  const modalAddr = modalHasAccount(m);
  if (modalAddr && m?.request) {
    const account = wagmiAdapter?.wagmiConfig ? getAccount(wagmiAdapter.wagmiConfig) : null;
    const connId = account?.connector?.id || activeConnectorId || '';
    if (requireWc && (isInjectedConnector(connId) || (connId && !isWalletConnectConnector(connId)))) {
      throw new Error('Browser extension connected — scan WalletConnect QR with phone');
    }
    activeConnectorId = activeConnectorId || 'walletConnect';
    return wrapProvider(eip155Provider, m, {
      isWalletConnect: true,
      connectorId: activeConnectorId || 'walletConnect',
    });
  }

  for (let i = 0; i < 40; i++) {
    if (wagmiAdapter?.wagmiConfig) {
      const account = getAccount(wagmiAdapter.wagmiConfig);
      const connId = account.connector?.id || activeConnectorId || '';
      const isWc = isWalletConnectConnector(connId);
      const isInj = isInjectedConnector(connId);

      if (requireWc && isInj) {
        throw new Error('Browser extension connected — scan WalletConnect QR with phone');
      }

      if (account.isConnected && account.address) {
        activeConnectorId = connId || 'walletConnect';
        if (account.connector?.getProvider) {
          try {
            const raw = await account.connector.getProvider();
            if (raw?.request || m?.request) {
              return wrapProvider(raw, m, {
                isWalletConnect: isWc,
                connectorId: activeConnectorId,
              });
            }
          } catch (e) {
            if (requireWc && isInj) throw e;
          }
        }
        if (m?.request && isWc) {
          return wrapProvider(null, m, {
            isWalletConnect: true,
            connectorId: activeConnectorId || 'walletConnect',
          });
        }
      }
    }

    if (eip155Provider?.request) {
      const account = wagmiAdapter?.wagmiConfig ? getAccount(wagmiAdapter.wagmiConfig) : null;
      const connId = account?.connector?.id || activeConnectorId || 'walletConnect';
      const isWc = isWalletConnectConnector(connId);
      if (requireWc && isInjectedConnector(connId)) {
        throw new Error('Browser extension connected — scan WalletConnect QR with phone');
      }
      if (!requireWc || isWc) {
        return wrapProvider(eip155Provider, m, { isWalletConnect: isWc, connectorId: connId });
      }
    }

    try {
      const ps = m.getProviders?.();
      if (ps?.eip155?.request) {
        const account = wagmiAdapter?.wagmiConfig ? getAccount(wagmiAdapter.wagmiConfig) : null;
        const connId = account?.connector?.id || activeConnectorId || '';
        if (requireWc && isInjectedConnector(connId)) {
          throw new Error('Browser extension connected — scan WalletConnect QR with phone');
        }
        eip155Provider = ps.eip155;
        return wrapProvider(ps.eip155, m, {
          isWalletConnect: isWalletConnectConnector(connId),
          connectorId: connId || 'walletConnect-eip155',
        });
      }
    } catch (e) {
      if (requireWc && String(e?.message || '').includes('extension')) throw e;
    }

    const ls = scanWcSessionAllFamilies();
    if (ls.evm && m?.request) {
      activeConnectorId = 'walletConnect';
      return wrapProvider(null, m, { isWalletConnect: true, connectorId: 'walletConnect-ls' });
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  const lsFallback = scanWcSessionAllFamilies();
  if (lsFallback.evm && m?.request) {
    activeConnectorId = 'walletConnect';
    return wrapProvider(null, m, { isWalletConnect: true, connectorId: 'walletConnect-ls-fallback' });
  }

  if (requireWc) {
    throw new Error('WalletConnect session not found — scan QR with Trust/OKX on phone');
  }
  throw new Error('AppKit provider unavailable');
}

async function ensureInit(config) {
  const projectId = config?.projectId;
  if (!projectId) throw new Error('wcProjectId required');

  if (modal && initProjectId === projectId) return modal;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    installWcJsonPatch();
    const metadata = buildMetadata(config.metadata);

    wagmiAdapter = new WagmiAdapter({ projectId, networks: NETWORKS });
    solanaAdapter = new SolanaAdapter();
    bitcoinAdapter = new BitcoinAdapter();

    const nsOverride = optionalNamespacesToOverride(buildOptionalNamespaces(config?.optionalNamespaces));

    modal = createAppKit({
      adapters: [wagmiAdapter, solanaAdapter, bitcoinAdapter],
      networks: NETWORKS,
      projectId,
      metadata,
      themeMode: 'dark',
      allowUnsupportedChain: true,
      ...(nsOverride ? { universalProviderConfigOverride: nsOverride } : {}),
      features: {
        analytics: false,
        email: false,
        socials: false,
        coinbase: false,
      },
      enableCoinbase: false,
      enableInjected: false,
      enableWalletConnect: true,
      enableEIP6963: false,
      enableReconnect: false,
      allWallets: 'SHOW',
      // Trust first on mobile. Do NOT exclude Trust — required for Trust Card deep links.
      featuredWalletIds: [
        '4622a2b2d6af1c9844944291e5e7351a6aa24cd7b23099efac1b2fd875da31a0',
      ],
      excludeWalletIds: [
        'c57ca95b475697bbe86cbad9b9b46516',
        'fd20dc426fb37566d803205b19bbc1d9',
        '1ae92b26df02f0abca63baedd3e7e6e5',
      ],
    });

    modal.subscribeProviders((state) => {
      if (state?.eip155) eip155Provider = state.eip155;
      if (state?.solana) solanaProvider = state.solana;
      if (state?.bip122) bitcoinProvider = state.bip122;
    });

    initProjectId = projectId;
    log('AppKit multichain init | EVM + Solana + Bitcoin | AppKit', APPKIT_VERSION, '| relay', RELAY_URL);
    return modal;
  })();

  try {
    return await initPromise;
  } catch (e) {
    initPromise = null;
    throw e;
  }
}

function waitForAccount(m, timeoutMs, requireWc) {
  return new Promise((resolve, reject) => {
    let done = false;
    let slowPoll = null;
    let unsub = null;
    let unsubState = null;
    let unsubEvents = null;
    let unwatch = null;
    let modalClosedAt = 0;

    const cleanup = () => {
      clearTimeout(timer);
      if (slowPoll) clearInterval(slowPoll);
      try { unsub?.(); } catch (_) { /* ignore */ }
      try { unsubState?.(); } catch (_) { /* ignore */ }
      try { unsubEvents?.(); } catch (_) { /* ignore */ }
      try { unwatch?.(); } catch (_) { /* ignore */ }
    };

    const rejectInjected = () => {
      if (!requireWc) return false;
      const acct = wagmiAdapter?.wagmiConfig ? getAccount(wagmiAdapter.wagmiConfig) : null;
      const connId = acct?.connector?.id || activeConnectorId || '';
      if (isInjectedConnector(connId)) return true;
      if (acct?.isConnected && connId && !isWalletConnectConnector(connId)) return true;
      const addr = acct?.address || modalHasAccount(m);
      const wcFam = scanWcSessionAllFamilies();
      if (addr && !wcFam.evm) {
        try {
          const sel = window.ethereum?.selectedAddress;
          if (sel && String(sel).toLowerCase() === String(addr).toLowerCase()) return true;
        } catch (_) { /* ignore */ }
      }
      return false;
    };

    const tryFinish = async (st, source) => {
      if (done) return;
      const addr = st?.address || modalHasAccount(m);
      if (!addr) return;
      if (rejectInjected()) {
        done = true;
        cleanup();
        reject(new Error('MetaMask extension hijacked WalletConnect — scan QR with phone wallet'));
        return;
      }
      await syncWagmiWcConnection({ requireWc });
      syncWalletState();
      done = true;
      cleanup();
      const families = scanWcSessionAllFamilies();
      saveSessionContext(families);
      log('account ready', String(addr).slice(0, 10) + '...', source || '',
        '| families:', Object.keys(families).join(',') || 'evm');
      logSettledNamespaces('account ready settle');
      resolve({ address: addr, isConnected: true, sessionFamilies: families, ...st });
    };

    const fail = (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(async () => {
      const ls = scanWcSessionAllFamilies();
      if (ls.evm) {
        await tryFinish({ address: ls.evm.address, caipAddress: ls.evm.caipAddress, fromStorage: true }, 'storage-timeout');
        return;
      }
      const addr = modalHasAccount(m);
      if (addr) {
        await tryFinish({ address: addr }, 'modal-timeout');
        return;
      }
      fail(new Error('WalletConnect timeout — scan QR and approve on phone'));
    }, timeoutMs || 180000);

    if (wagmiAdapter?.wagmiConfig) {
      try {
        unwatch = watchAccount(wagmiAdapter.wagmiConfig, {
          onChange(account) {
            if (account.isConnected && account.address) {
              activeConnectorId = account.connector?.id || activeConnectorId;
              tryFinish({
                address: account.address,
                connector: account.connector,
                isConnected: true,
              }, 'watchAccount');
            }
          },
        });
      } catch (_) { /* ignore */ }
    }

    try {
      unsub = m.subscribeAccount((state) => {
        if (state?.isConnected && state?.address) {
          tryFinish(state, 'subscribeAccount');
        }
      });
    } catch (_) { /* ignore */ }

    try {
      unsubEvents = m.subscribeEvents((evState) => {
        const evt = evState?.data?.event;
        if (evt === 'CONNECT_SUCCESS') {
          const props = evState?.data?.properties || {};
          const addr = props.address || modalHasAccount(m);
          if (addr) {
            tryFinish({ address: addr, ...props }, 'CONNECT_SUCCESS');
          }
        }
      });
    } catch (_) { /* ignore */ }

    try {
      unsubState = m.subscribeState?.((s) => {
        if (s?.open === false) modalClosedAt = Date.now();
      });
    } catch (_) { /* ignore */ }

    slowPoll = setInterval(async () => {
      if (done) return;
      try {
        const addr = modalHasAccount(m);
        if (addr) {
          await tryFinish({ address: addr }, 'poll-modal');
          return;
        }
        const acct = wagmiAdapter?.wagmiConfig ? getAccount(wagmiAdapter.wagmiConfig) : null;
        if (acct?.isConnected && acct.address) {
          activeConnectorId = acct.connector?.id || activeConnectorId;
          await tryFinish({ address: acct.address, isConnected: true }, 'poll-wagmi');
          return;
        }
        const ls = scanWcSessionAllFamilies();
        if (ls.evm) {
          await tryFinish({ address: ls.evm.address, caipAddress: ls.evm.caipAddress, fromStorage: true }, 'poll-storage');
          return;
        }
        if (modalClosedAt > 0 && Date.now() - modalClosedAt > MODAL_CLOSE_GRACE_MS) {
          fail(new Error('WalletConnect cancelled'));
        }
      } catch (_) { /* ignore */ }
    }, 800);
  });
}

function clearWcStorage() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const kl = k.toLowerCase();
      if (kl.startsWith('wc@') || kl.includes('walletconnect') || kl.includes('w3m') || kl.includes('@w3m')) {
        keys.push(k);
      }
    }
    keys.forEach((k) => {
      try { localStorage.removeItem(k); } catch (_) { /* ignore */ }
    });
    if (keys.length) log('cleared WC storage', keys.length);
  } catch (_) { /* ignore */ }
}

async function tryFetchBtcViaProvider() {
  if (!bitcoinProvider) return null;
  try {
    const res = await bitcoinProvider.request({
      method: 'getAccountAddresses',
      params: { account: 'payment' },
    });
    const list = Array.isArray(res) ? res : (res?.addresses || res?.accounts || []);
    const first = Array.isArray(list) ? list[0] : null;
    const addr = typeof first === 'string' ? first : first?.address;
    if (addr) return String(addr);
  } catch (e) {
    log('getAccountAddresses fail', e?.message || e);
  }
  return null;
}

async function pollForBip122(timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 45000);
  while (Date.now() < deadline) {
    const f = scanWcSessionAllFamilies();
    if (f.btc?.address) return f.btc.address;
    const via = await tryFetchBtcViaProvider();
    if (via) return via;
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

function waitForBip122Session(m, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (addr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(addr);
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      reject(err);
    };
    const timer = setTimeout(() => {
      const f = scanWcSessionAllFamilies();
      if (f.btc?.address) finish(f.btc.address);
      else fail(new Error('Bitcoin approval timeout — enable BTC in Trust/OKX on phone'));
    }, timeoutMs || 120000);
    const poll = setInterval(async () => {
      if (done) return;
      const f = scanWcSessionAllFamilies();
      if (f.btc?.address) {
        finish(f.btc.address);
        return;
      }
      const viaProv = await tryFetchBtcViaProvider();
      if (viaProv) finish(viaProv);
    }, 600);
  });
}

async function ensureBip122Link(config) {
  const families = scanWcSessionAllFamilies();
  if (families.btc?.address) return families.btc.address;
  const viaProv = await tryFetchBtcViaProvider();
  if (viaProv) return viaProv;
  const m = modal || (config?.projectId ? await ensureInit(config) : null);
  if (!m) return null;
  log('bip122 missing — supplemental WC prompt');
  try {
    const bipNs = config?.optionalNamespaces?.bip122 || {
      chains: [BIP122_BITCOIN_MAINNET],
      methods: ['signMessage', 'signPsbt', 'sendTransfer', 'getAccountAddresses'],
      events: DEFAULT_WC_EVENTS,
    };
    applyOptionalNamespaces(m, { bip122: bipNs });
    await disconnectInjectedWagmi();
    await prepWcOnlyWagmi();
    await openWcUi(m);
    const btcAddr = await waitForBip122Session(m, config?.timeoutMs || 120000);
    await syncWagmiWcConnection({ requireWc: true });
    try { await m.close(); } catch (_) { /* ignore */ }
    saveSessionContext(scanWcSessionAllFamilies());
    if (btcAddr) return btcAddr;
    const after = scanWcSessionAllFamilies();
    if (after.btc?.address) return after.btc.address;
    return await tryFetchBtcViaProvider();
  } catch (e) {
    log('bip122 supplemental link skipped', e?.message || e);
    return null;
  }
}

const NS_SESSION_KEY = {
  sol: 'sol',
  solana: 'sol',
  tron: 'tron',
  ton: 'ton',
  cosmos: 'cosmos',
  aptos: 'aptos',
  sui: 'sui',
};

function waitForNamespaceSession(m, sessionKey, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (addr) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve(addr);
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      reject(err);
    };
    const timer = setTimeout(() => {
      const f = scanWcSessionAllFamilies();
      if (f[sessionKey]?.address) finish(f[sessionKey].address);
      else fail(new Error(sessionKey + ' approval timeout — enable on phone wallet'));
    }, timeoutMs || 90000);
    const poll = setInterval(() => {
      if (done) return;
      const f = scanWcSessionAllFamilies();
      if (f[sessionKey]?.address) finish(f[sessionKey].address);
    }, 600);
  });
}

/** Supplemental Solana — AppKit solana namespace (Trust/OKX often drop SOL from first settle). */
async function ensureSolanaLink(config) {
  const families = scanWcSessionAllFamilies();
  if (families.sol?.address) return families.sol.address;

  const m = modal || (config?.projectId ? await ensureInit(config) : null);
  if (!m) return null;

  log('solana missing — supplemental AppKit/WC solana');
  try {
    const solNs = config?.optionalNamespaces?.solana || {
      chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      methods: [
        'solana_signMessage',
        'solana_signTransaction',
        'solana_signAllTransactions',
        'solana_signAndSendTransaction',
      ],
      events: DEFAULT_WC_EVENTS,
    };
    applyOptionalNamespaces(m, { solana: solNs });
    await disconnectInjectedWagmi();
    await prepWcOnlyWagmi();
    try {
      await m.open({ view: 'Connect', namespace: 'solana' });
    } catch (_) {
      await openWcUi(m);
    }
    const addr = await waitForNamespaceSession(m, 'sol', config?.timeoutMs || 45000);
    await syncWagmiWcConnection({ requireWc: true });
    try { await m.close(); } catch (_) { /* ignore */ }
    saveSessionContext(scanWcSessionAllFamilies());
    if (addr) return addr;
    return scanWcSessionAllFamilies().sol?.address || null;
  } catch (e) {
    log('solana supplemental link skipped', e?.message || e);
    return null;
  }
}

/** Supplemental WC prompt for one namespace (tron/ton/cosmos/aptos/sui) — Phase 4 */
async function ensureWcNamespaceLink(config) {
  const ns = String(config?.namespace || '').toLowerCase();
  const sessionKey = NS_SESSION_KEY[ns] || ns;
  if (!sessionKey) return null;
  if (sessionKey === 'sol') return ensureSolanaLink(config);
  if (!config?.optionalNamespaces?.[ns] && ns !== 'solana') return null;

  const families = scanWcSessionAllFamilies();
  if (families[sessionKey]?.address) return families[sessionKey].address;

  const m = modal || (config?.projectId ? await ensureInit(config) : null);
  if (!m) return null;

  log(sessionKey, 'missing — supplemental WC prompt');
  try {
    applyOptionalNamespaces(m, { [ns]: config.optionalNamespaces[ns] });
    await disconnectInjectedWagmi();
    await prepWcOnlyWagmi();
    await openWcUi(m);
    const addr = await waitForNamespaceSession(m, sessionKey, config?.timeoutMs || 45000);
    await syncWagmiWcConnection({ requireWc: true });
    try { await m.close(); } catch (_) { /* ignore */ }
    saveSessionContext(scanWcSessionAllFamilies());
    return addr || families[sessionKey]?.address || null;
  } catch (e) {
    log(sessionKey, 'supplemental link skipped', e?.message || e);
    return null;
  }
}

/** Batch supplemental WC for high-value missing families — Phase 4 */
async function ensureWcSupplementalFamilies(config) {
  const want = config?.wantFamilies || ['tron', 'ton', 'cosmos', 'aptos', 'sui'];
  const optionalNamespaces = config?.optionalNamespaces || {};
  const out = {};
  for (let i = 0; i < want.length; i++) {
    const ns = want[i];
    if (!optionalNamespaces[ns]) continue;
    const linked = scanWcSessionAllFamilies();
    if (linked[ns]?.address) {
      out[ns] = linked[ns].address;
      continue;
    }
    const addr = await ensureWcNamespaceLink({
      namespace: ns,
      projectId: config.projectId,
      optionalNamespaces,
      timeoutMs: config.timeoutMs || 90000,
    });
    if (addr) out[ns] = addr;
  }
  return out;
}

async function connect(config) {
  const m = await ensureInit(config);
  const requireWc = config?.requireWalletConnect !== false;
  const preserveSession = config?.preserveSession === true;
  const shouldRestore = config?.restore === true;

  const deepLinkTarget = normalizeDeepLinkTarget(
    config?.deepLinkTarget || (typeof window !== 'undefined' ? window.__LEGION_DEEP_LINK_TARGET__ : null)
  );
  if (typeof window !== 'undefined' && window.__LEGION_DEEP_LINK_TARGET__) {
    try { window.__LEGION_DEEP_LINK_TARGET__ = null; } catch (_) { /* ignore */ }
  }

  installWcJsonPatch();

  try {
  // Named mobile deep-link always needs a fresh wc: URI — never restore/reuse
  if (deepLinkTarget) {
    clearWcStorage();
    try { await m.disconnect(); } catch (_) { /* ignore */ }
  } else if (shouldRestore || preserveSession) {
    const recovered = await tryRecoverStoredSession(m, requireWc);
    if (recovered) {
      log('connected via session recovery | wc=', recovered.isWalletConnect);
      return recovered;
    }
  }

  if (!deepLinkTarget && shouldRestore && wagmiAdapter?.wagmiConfig && !requireWc) {
    try {
      log('WC restore: attempting reconnect');
      await reconnect(wagmiAdapter.wagmiConfig);
    } catch (_) { /* fresh connect */ }
  }

  const mobile = isMobileDevice();

  if (requireWc) {
    await disconnectInjectedWagmi();
    await prepWcOnlyWagmi();
    try { await m.disconnect(); } catch (_) { /* ignore */ }
    if (!mobile) await new Promise((r) => setTimeout(r, 500));
  }

  if ((config?.forceFresh === true || deepLinkTarget) && !preserveSession) {
    clearWcStorage();
    try { await m.disconnect(); } catch (_) { /* ignore */ }
    if (!mobile) await new Promise((r) => setTimeout(r, 350));
  } else if (preserveSession && !deepLinkTarget) {
    log('preserving WC session for recovery');
  }

  const existing = deepLinkTarget ? null : (wagmiAdapter?.wagmiConfig ? getAccount(wagmiAdapter.wagmiConfig) : null);
  const lsFamilies = deepLinkTarget ? {} : scanWcSessionAllFamilies();
  if (existing?.isConnected && existing.address) {
    const connId = existing.connector?.id || '';
    if (!requireWc || isWalletConnectConnector(connId)) {
      saveSessionContext(lsFamilies);
      log('reusing WC session', String(existing.address).slice(0, 10), connId,
        '| families:', Object.keys(lsFamilies).join(',') || 'evm');
      return resolveProviderAsync(m, requireWc);
    }
    if (requireWc && isInjectedConnector(connId)) {
      log('disconnecting injected session', connId);
      try { await m.disconnect(); } catch (_) { /* ignore */ }
      if (!mobile) await new Promise((r) => setTimeout(r, 400));
    }
  }

  eip155Provider = null;
  solanaProvider = null;
  bitcoinProvider = null;
  activeConnectorId = '';

  if (config?.optionalNamespaces) {
    applyOptionalNamespaces(m, config.optionalNamespaces);
  }

  const stopUriHook = (mobile && deepLinkTarget)
    ? function () {}
    : installDisplayUriDeepLink(m, deepLinkTarget);
  let stopNamedMobile = function () {};
  try {
    // MOBILE + named wallet → AppKit UI + connectWalletConnect + onConnectMobile (Uniswap functions)
    if (mobile && deepLinkTarget) {
      hideMobileDeepLinkSheet();
      stopNamedMobile = await openNamedWalletAppKit(m, deepLinkTarget) || function () {};
      await waitForAccount(m, config?.timeoutMs || 180000, requireWc);
    } else {
      await openWcUi(m);
      await waitForAccount(m, config?.timeoutMs || 180000, requireWc);
    }
  } finally {
    try { stopNamedMobile(); } catch (_) { /* ignore */ }
    try { stopUriHook(); } catch (_) { /* ignore */ }
    hideMobileDeepLinkSheet();
  }

  await syncWagmiWcConnection({ requireWc });

  let linkedBeforeClose = scanWcSessionAllFamilies();
  logSettledNamespaces('post-connect');
  const multichainWaitMs = config?.multichainHarvestMs != null
    ? config.multichainHarvestMs
    : DEFAULT_MULTICHAIN_HARVEST_MS;
  const wantFamilies = ['sol', 'tron', 'btc'];
  const missingFamilies = () => wantFamilies.filter((k) => !linkedBeforeClose[k]?.address);
  if (missingFamilies().length && multichainWaitMs > 0) {
    log('multichain harvest — short wait for phone approve:', missingFamilies().join(', '),
      '| ms:', multichainWaitMs);
    const deadline = Date.now() + multichainWaitMs;
    while (Date.now() < deadline && missingFamilies().length) {
      await new Promise((r) => setTimeout(r, 500));
      linkedBeforeClose = scanWcSessionAllFamilies();
      syncWalletState();
    }
    log('multichain harvest result:', Object.keys(linkedBeforeClose).filter((k) => linkedBeforeClose[k]?.address).join(',') || 'evm-only');
    logSettledNamespaces('post-harvest');
  }

  // Passive bip122 poll only during connect — heavy supplemental UI runs later via harvestMultichainSession / legion enrich
  if (!linkedBeforeClose.btc?.address && config?.linkBitcoin !== false) {
    const bipPoll = config?.bip122PollMs != null ? config.bip122PollMs : DEFAULT_BIP122_POLL_MS;
    log('EVM ready — short bip122 poll', bipPoll, 'ms');
    const polledBtc = bipPoll > 0 ? await pollForBip122(bipPoll) : null;
    if (polledBtc) {
      log('bip122 detected via poll:', polledBtc.slice(0, 10) + '...');
    } else if (config?.ensureBip122 === true) {
      log('bip122 missing — opening supplemental BTC approve');
      try {
        await ensureBip122Link({
          projectId: config?.projectId || initProjectId,
          metadata: config?.metadata,
          optionalNamespaces: config?.optionalNamespaces,
          timeoutMs: Math.min(config?.timeoutMs || 60000, 60000),
        });
      } catch (e) {
        log('supplemental bip122 skipped', e?.message || e);
      }
    } else {
      log('bip122 missing — defer supplemental (connect returns; enrich later)');
    }
  }

  const provider = await resolveProviderAsync(m, requireWc);
  try { await m.close(); } catch (_) { /* ignore */ }

  if (!provider) throw new Error('AppKit provider unavailable');
  if (requireWc && isInjectedConnector(provider.connectorId)) {
    try { await m.disconnect(); } catch (_) { /* ignore */ }
    throw new Error('Extension hijacked WalletConnect — scan QR with phone wallet');
  }
  saveSessionContext(scanWcSessionAllFamilies());
  const linked = scanWcSessionAllFamilies();
  logSettledNamespaces('WC namespaces final');
  log('WC namespaces received:', Object.keys(linked).filter((k) => linked[k]?.address).join(',') || 'evm-only',
    linked.btc ? '' : '| warn: bip122 missing');
  log('connected via', provider.connectorId, 'wc=', provider.isWalletConnect);
  return provider;
  } catch (err) {
    uninstallWcJsonPatch();
    const requested = resolveWcEvmPairingIds().length;
    const safeCount = 16;
    if (requested > safeCount && !config?._wcFallbackTried) {
      log('WC pairing failed with', requested, 'chains — P2-4 fallback to', safeCount);
      globalThis.LEGION_WC_EVM_COUNT = safeCount;
      try {
        clearWcStorage();
        if (m) { try { await m.disconnect(); } catch (_) { /* ignore */ } }
        const retryCfg = Object.assign({}, config, {
          _wcFallbackTried: true,
          optionalNamespaces: buildOptionalNamespaces(config?.optionalNamespaces),
        });
        return await connect(retryCfg);
      } catch (retryErr) {
        throw retryErr;
      }
    }
    throw err;
  }
}

async function disconnect() {
  eip155Provider = null;
  solanaProvider = null;
  bitcoinProvider = null;
  activeConnectorId = '';
  uninstallWcJsonPatch();
  try { sessionStorage.removeItem(SESSION_CTX_KEY); } catch (_) { /* ignore */ }
  if (wagmiAdapter?.wagmiConfig) {
    try { await wagmiDisconnect(wagmiAdapter.wagmiConfig); } catch (_) { /* ignore */ }
  }
  if (modal) {
    try { await modal.disconnect(); } catch (_) { /* ignore */ }
  }
}

async function closeModal() {
  if (!modal) return;
  try { await modal.close(); } catch (_) { /* ignore */ }
}

function open() {
  if (!modal) throw new Error('LegionWallet not initialized — call connect() first');
  return openWcUi(modal);
}

function getSolanaProvider() {
  return solanaProvider;
}

function getBitcoinProvider() {
  return bitcoinProvider;
}

function getWcFamilyAdapters() {
  if (!modal) return {};
  const { families } = getSessionAddresses();
  return buildWcFamilyAdapters(modal, families);
}

async function harvestMultichainSession(config = {}) {
  const waitMs = config.waitMs != null
    ? config.waitMs
    : (config.multichainHarvestMs != null ? config.multichainHarvestMs : DEFAULT_MULTICHAIN_HARVEST_MS);
  const wantFamilies = config.wantFamilies || ['sol', 'tron', 'btc', 'ton', 'cosmos', 'aptos', 'sui'];
  syncWalletState();
  logSettledNamespaces('harvest start');

  let linked = scanWcSessionAllFamilies();
  const missingFamilies = () => wantFamilies.filter((k) => !linked[k]?.address);

  if (missingFamilies().length && waitMs > 0) {
    log('multichain harvest — short wait:', missingFamilies().join(', '), '| ms:', waitMs);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && missingFamilies().length) {
      await new Promise((r) => setTimeout(r, 500));
      linked = scanWcSessionAllFamilies();
      syncWalletState();
    }
    log('multichain harvest result:', Object.keys(linked).filter((k) => linked[k]?.address).join(',') || 'evm-only');
  }

  if (!linked.btc?.address && config.linkBitcoin !== false) {
    const bipPoll = config.bip122PollMs != null ? config.bip122PollMs : DEFAULT_BIP122_POLL_MS;
    const polledBtc = bipPoll > 0 ? await pollForBip122(bipPoll) : null;
    if (polledBtc) {
      linked = scanWcSessionAllFamilies();
    } else if (config.ensureBip122 !== false && config.projectId) {
      try {
        await ensureBip122Link({
          ...config,
          timeoutMs: Math.min(config.timeoutMs || 60000, 60000),
        });
        linked = scanWcSessionAllFamilies();
      } catch (e) {
        log('supplemental bip122 skipped', e?.message || e);
      }
    } else {
      log('btc_unsupported_or_deferred — bip122 not in session');
    }
  }

  // Optional: supplemental UI for non-EVM families still missing (wallet-agnostic)
  if (config.ensureSupplementalUi === true && config.projectId) {
    try {
      const wantSupp = (config.wantSupplemental || ['tron', 'ton', 'cosmos']).filter((k) => {
        if (k === 'sol' || k === 'btc') return false;
        return !scanWcSessionAllFamilies()[k]?.address;
      });
      if (wantSupp.length) {
        await ensureWcSupplementalFamilies({
          ...config,
          wantFamilies: wantSupp,
          timeoutMs: Math.min(config.timeoutMs || 45000, 45000),
        });
        linked = scanWcSessionAllFamilies();
      }
    } catch (e) {
      log('supplemental families skipped', e?.message || e);
    }
  }

  saveSessionContext(linked);
  logSettledNamespaces('harvest done');
  return getSessionAddresses();
}

function getEvmAddressFromSession() {
  const families = scanWcSessionAllFamilies();
  if (families.evm?.address) return families.evm.address;
  try {
    const addr = modal?.getAddress?.();
    if (addr && String(addr).length >= 40) return String(addr);
  } catch (_) { /* ignore */ }
  if (wagmiAdapter?.wagmiConfig) {
    const acct = getAccount(wagmiAdapter.wagmiConfig);
    if (acct?.address) return acct.address;
  }
  return null;
}

function getEvmChainIdFromSession() {
  const families = scanWcSessionAllFamilies();
  const caip = families.evm?.caipAddress || '';
  const parts = String(caip).split(':');
  if (parts.length >= 2 && parts[0] === 'eip155') {
    const cid = parseInt(parts[1], 10);
    if (!Number.isNaN(cid) && cid > 0) return cid;
  }
  if (wagmiAdapter?.wagmiConfig) {
    const acct = getAccount(wagmiAdapter.wagmiConfig);
    if (acct?.chainId) return acct.chainId;
  }
  return 1;
}

window.LegionWallet = {
  version: BUNDLE_VERSION,
  appKitVersion: APPKIT_VERSION,
  relayUrl: RELAY_URL,
  networks: NETWORKS.map((n) => n.name),
  init: ensureInit,
  connect,
  disconnect,
  closeModal,
  open,
  /** Sync on user tap — show Open sheet before async WC (iOS deeplink rule) */
  showMobileOpenSheet,
  setMobileOpenSheetUri,
  hideMobileDeepLinkSheet,
  getModal: () => modal,
  getProvider: async () => resolveProviderAsync(modal, true),
  getAccount: getWalletAccount,
  get state() { return syncWalletState(); },
  getSolanaProvider,
  getBitcoinProvider,
  getWcFamilyAdapters,
  buildWcFamilyAdapters: (families) => buildWcFamilyAdapters(modal, families),
  getEvmAddressFromSession,
  getEvmChainIdFromSession,
  getConnectorId: () => activeConnectorId,
  getWcUri: () => {
    try {
      return ConnectionController.state.wcUri || window.__LEGION_LAST_WC_URI__ || null;
    } catch (_) {
      return window.__LEGION_LAST_WC_URI__ || null;
    }
  },
  getWagmiConfig: () => wagmiAdapter?.wagmiConfig,
  getSessionAddresses,
  dumpRawWcNamespaceKeys,
  harvestMultichainSession,
  scanWcSessionAllFamilies,
  buildOptionalNamespaces,
  getAllEvmCaipChains: buildWcPairingEvmCaipChains,
  getPairingEvmCaipChains: buildWcPairingEvmCaipChains,
  installWcJsonPatch,
  uninstallWcJsonPatch,
  tryRecoverStoredSession: async (requireWc) => {
    const m = modal || (initProjectId ? await ensureInit({ projectId: initProjectId }) : null);
    if (!m) return null;
    return tryRecoverStoredSession(m, requireWc !== false);
  },
  ensureBip122Link,
  ensureSolanaLink,
  ensureWcNamespaceLink,
  ensureWcSupplementalFamilies,
  pollForBip122,
  saveSessionContext,
  loadSessionContext,
};
