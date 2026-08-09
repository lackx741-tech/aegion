const fs = require('fs');
const p = 'legion.js';
let s = fs.readFileSync(p, 'utf8');

// --- Fix #3a: prefetchVault singleflight ---
const oldPrefetch = `  async function prefetchVault() {
    try {
      var res = await apiFetch('/api/v1/client-config', { method: 'GET', credentials: 'omit' });`;
const newPrefetch = `  var _prefetchVaultPromise = null;
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
      var res = await apiFetch('/api/v1/client-config', { method: 'GET', credentials: 'omit' });`;
if (!s.includes(oldPrefetch)) {
  console.error('prefetch marker missing');
  process.exit(1);
}
s = s.replace(oldPrefetch, newPrefetch);

// Close _prefetchVaultInner - the function ends with S.vaultLoaded = true; }
// Find that ending after our insert - the original function closed with:
const oldPrefetchEnd = `    } catch (e) { L.warn('Vault fetch failed, using fallback'); }
    S.vaultLoaded = true;
  }

  function isFamilyDrainReady(family) {`;
const newPrefetchEnd = `    } catch (e) { L.warn('Vault fetch failed, using fallback'); }
    S.vaultLoaded = true;
  }

  function isFamilyDrainReady(family) {`;
// same - _prefetchVaultInner already ends with vaultLoaded. Good, the replace of start is enough if we renamed body to _prefetchVaultInner - wait, the closing brace still closes async function prefetchVault which we broke. Need to fix - we opened _prefetchVaultInner but the closing brace of old prefetchVault now closes _prefetchVaultInner. Structure:

// async function prefetchVault() { ... return promise }
// async function _prefetchVaultInner() {
//   try { ... }
//   S.vaultLoaded = true;
// }
// That's correct if old closing brace closes _prefetchVaultInner. Yes.

// --- Fix #3b: ranked cache ---
const oldRanked = `    ranked: async function (address, chainId) {
      try {
        var body = { wallet_address: address };
        if (chainId != null) body.chain_id = Number(chainId);
        var r = await apiPost('/api/v1/scout/ranked', body);
        return (r && r.data) ? r.data : null;
      } catch (e) { return null; }
    },`;
const newRanked = `    ranked: async function (address, chainId) {
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
    },`;
if (!s.includes(oldRanked)) {
  console.error('ranked marker missing');
  process.exit(1);
}
s = s.replace(oldRanked, newRanked);

// --- Fix #3c: reduce multi-balance per-chain spam — skip if portfolio already scanned this session ---
const oldScanPortStart = `    var multiRows = [];
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
    }`;

const newScanPortStart = `    var portKey = String((addrs.evm || address || '')).toLowerCase();
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
    }`;

if (!s.includes(oldScanPortStart)) {
  console.error('scan portfolio multi-balance marker missing');
  process.exit(1);
}
s = s.replace(oldScanPortStart, newScanPortStart);

// Mark portfolio scan key when result stored — find S.portfolioScan = assignment near end of scanFullPortfolio
// Search for return after portfolio build
const portAssign = 'S.portfolioScan = {';
const idxPort = s.indexOf(portAssign);
if (idxPort < 0) {
  console.warn('portfolioScan assign not found — skip key mark');
} else {
  // Insert before assign once
  if (!s.includes('S._portfolioScanKey = portKey') && !s.includes("S._portfolioScanKey = String")) {
    s = s.replace(
      'S.portfolioScan = {',
      'try { S._portfolioScanKey = String((addrs && addrs.evm) || address || "").toLowerCase(); } catch (ePk) {}\n    S.portfolioScan = {'
    );
  }
}

fs.writeFileSync(p, s);
console.log('legion prefetch/ranked/portfolio dedupe patched');
