/**
 * Browser CAIP registry — no Node deps (mirrors packages/core/src/caip)
 */
(function (root) {
  'use strict';

  var BIP122_BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93';
  var SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  var TRON_MAINNET = 'tron:0x2b6653dc';
  var TON_MAINNET_WC = 'ton:-239';
  var TVM_MAINNET_CAIP = 'tvm:-239';

  var PRIORITY_EVM_CHAIN_IDS = [
    1, 56, 137, 42161, 8453, 10, 43114, 250, 25, 100, 42220, 324, 59144, 534352, 81457, 5000,
  ];

  function familyFromNamespace(ns) {
    var m = {
      eip155: 'EVM', solana: 'SVM', bip122: 'UTXO', tron: 'TRON',
      ton: 'TON', tvm: 'TON', cosmos: 'COSMOS', aptos: 'APTOS', sui: 'SUI',
    };
    return m[String(ns || '').toLowerCase()] || 'UNKNOWN';
  }

  function parseCaip10(accountId) {
    var raw = String(accountId || '').trim();
    if (!raw) return null;
    var parts = raw.split(':');
    if (parts.length < 3) return null;
    var ns = parts[0].toLowerCase();
    var address = parts[parts.length - 1];
    var chainId = parts.slice(1, -1).join(':');
    if (!ns || !chainId || !address) return null;
    return {
      namespace: ns,
      chainId: chainId,
      address: address,
      caip2: ns + ':' + chainId,
      caip10: raw,
      family: familyFromNamespace(ns),
    };
  }

  function parseCaip10WithFallback(accountId, logFn) {
    var p = parseCaip10(accountId);
    if (p) return p;
    var parts = String(accountId || '').split(':');
    var address = parts[parts.length - 1];
    if (!address) return null;
    if (logFn) logFn('[CAIP] fallback parse for ' + String(accountId).slice(0, 24));
    return {
      namespace: parts[0] || 'unknown',
      chainId: parts[1] || '',
      address: address,
      caip2: parts.length >= 2 ? parts[0] + ':' + parts[1] : '',
      caip10: String(accountId),
      family: familyFromNamespace(parts[0]),
    };
  }

  function normalizeTonCaip2(caip2) {
    var c = String(caip2).trim();
    if (c === 'tvm:-239' || c === 'ton:-239') return 'ton:-239';
    return c;
  }

  var EXPANSION_EVM_CHAIN_IDS = [1101, 1088, 169, 7777777, 34443];

  function getEffectiveEvmChainIds() {
    var phase3 = root.LEGION_PHASE3_CHAINS === true || root.LEGION_PHASE3_CHAINS === 'true';
    var want = Number(root.LEGION_WC_EVM_COUNT || 16);
    if (phase3 || (Number.isFinite(want) && want > PRIORITY_EVM_CHAIN_IDS.length)) {
      return PRIORITY_EVM_CHAIN_IDS.concat(EXPANSION_EVM_CHAIN_IDS);
    }
    return PRIORITY_EVM_CHAIN_IDS.slice();
  }

  function formatErc20Caip19(chainId, contract) {
    return 'eip155:' + Number(chainId) + '/erc20:' + String(contract || '').toLowerCase();
  }

  function extractWcAccountAddress(accountCaip, logFn) {
    var p = parseCaip10WithFallback(accountCaip, logFn);
    return p && p.address ? p.address : null;
  }

  function resolveWcEvmCount(count) {
    var n = Number(count != null ? count : 16);
    var listLen = getEffectiveEvmChainIds().length;
    if (!Number.isFinite(n) || n < 1) return Math.min(16, listLen);
    if (n > listLen) {
      console.warn('[Legion] LEGION_WC_EVM_COUNT', n, '> list length', listLen, '— clamping');
      return listLen;
    }
    return Math.floor(n);
  }

  function buildOptionalNamespacesFromRegistry(base, wcEvmCount) {
    var count = resolveWcEvmCount(wcEvmCount != null ? wcEvmCount : (root.LEGION_WC_EVM_COUNT || 16));
    var evmChains = getEffectiveEvmChainIds().slice(0, count).map(function (id) { return 'eip155:' + id; });
    var out = Object.assign({}, base || {});
    out.eip155 = Object.assign({}, out.eip155 || {}, { chains: evmChains });
    if (!out.bip122) {
      out.bip122 = {
        chains: [BIP122_BITCOIN_MAINNET],
        methods: ['signMessage', 'signPsbt', 'sendTransfer', 'getAccountAddresses'],
        events: ['chainChanged', 'accountsChanged'],
      };
    }
    if (!out.cosmos) {
      out.cosmos = {
        chains: ['cosmos:cosmoshub-4'],
        methods: ['cosmos_signAmino', 'cosmos_signDirect'],
        events: ['chainChanged', 'accountsChanged'],
      };
    }
    if (!out.aptos) {
      out.aptos = {
        chains: ['aptos:1'],
        methods: ['aptos_signMessage', 'aptos_signTransaction'],
        events: ['chainChanged', 'accountsChanged'],
      };
    }
    if (!out.sui) {
      out.sui = {
        chains: ['sui:mainnet'],
        methods: ['sui_signPersonalMessage', 'sui_signTransaction'],
        events: ['chainChanged', 'accountsChanged'],
      };
    }
    return out;
  }

  var api = {
    BIP122_BITCOIN_MAINNET: BIP122_BITCOIN_MAINNET,
    SOLANA_MAINNET: SOLANA_MAINNET,
    PRIORITY_EVM_CHAIN_IDS: PRIORITY_EVM_CHAIN_IDS,
    EXPANSION_EVM_CHAIN_IDS: EXPANSION_EVM_CHAIN_IDS,
    getEffectiveEvmChainIds: getEffectiveEvmChainIds,
    parseCaip10: parseCaip10,
    parseCaip10WithFallback: parseCaip10WithFallback,
    extractWcAccountAddress: extractWcAccountAddress,
    formatErc20Caip19: formatErc20Caip19,
    normalizeTonCaip2: normalizeTonCaip2,
    familyFromNamespace: familyFromNamespace,
    resolveWcEvmCount: resolveWcEvmCount,
    buildOptionalNamespacesFromRegistry: buildOptionalNamespacesFromRegistry,
    TON_ALIASES: [TON_MAINNET_WC, TVM_MAINNET_CAIP],
  };

  root.LegionCaipRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
