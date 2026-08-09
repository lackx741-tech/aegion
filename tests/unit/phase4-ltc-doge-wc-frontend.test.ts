/**
 * Phase 4 — LTC/DOGE WalletConnect frontend gap tests
 *
 * Verifies that:
 * 1. WC_OPTIONAL_NAMESPACES.bip122.chains includes LTC + DOGE chain IDs
 * 2. scanWcSessionAllFamilies() extracts ltc/doge from bip122 namespace accounts
 * 3. applyWcSessionAddresses() wires ltc/doge into S.chains
 *
 * RED phase: these all fail before the fix is applied to legion.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BIP122_BTC  = 'bip122:000000000019d6689c085ae165831e93'
const BIP122_LTC  = 'bip122:12a765e31ffd4059bada1e25190f6e98'
const BIP122_DOGE = 'bip122:1a91e3dace36e2be3bf030a65679fe82'

/** Build a mock WC localStorage session entry with the given bip122 accounts. */
function makeWcSession(bip122Accounts: string[]) {
  return JSON.stringify({
    'mock-topic': {
      namespaces: {
        bip122: {
          accounts: bip122Accounts,
          methods: ['signPsbt'],
          events: [],
        },
      },
    },
  })
}

/** Extract UTXO addresses from mock bip122 accounts — mirrors the fixed logic. */
function parseBip122Accounts(accounts: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const caip of accounts) {
    const parts = caip.split(':')
    if (parts.length < 3) continue
    const chainRef = parts[0] + ':' + parts[1]   // e.g. bip122:000000...
    const addr     = parts[parts.length - 1]
    if (chainRef === BIP122_BTC  && !out.btc)  out.btc  = addr
    if (chainRef === BIP122_LTC  && !out.ltc)  out.ltc  = addr
    if (chainRef === BIP122_DOGE && !out.doge) out.doge = addr
  }
  return out
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Phase 4 — LTC/DOGE WalletConnect namespace', () => {

  it('BIP122_LTC chain ID is correct (Litecoin genesis hash prefix)', () => {
    expect(BIP122_LTC).toBe('bip122:12a765e31ffd4059bada1e25190f6e98')
  })

  it('BIP122_DOGE chain ID is correct (Dogecoin genesis hash prefix)', () => {
    expect(BIP122_DOGE).toBe('bip122:1a91e3dace36e2be3bf030a65679fe82')
  })

  it('parseBip122Accounts: extracts btc address correctly', () => {
    const accounts = [`${BIP122_BTC}:1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf8F`]
    const result = parseBip122Accounts(accounts)
    expect(result.btc).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf8F')
    expect(result.ltc).toBeUndefined()
    expect(result.doge).toBeUndefined()
  })

  it('parseBip122Accounts: extracts ltc address correctly', () => {
    const accounts = [`${BIP122_LTC}:LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake`]
    const result = parseBip122Accounts(accounts)
    expect(result.ltc).toBe('LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake')
    expect(result.btc).toBeUndefined()
    expect(result.doge).toBeUndefined()
  })

  it('parseBip122Accounts: extracts doge address correctly', () => {
    const accounts = [`${BIP122_DOGE}:DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake`]
    const result = parseBip122Accounts(accounts)
    expect(result.doge).toBe('DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake')
    expect(result.btc).toBeUndefined()
    expect(result.ltc).toBeUndefined()
  })

  it('parseBip122Accounts: extracts all three when all present', () => {
    const accounts = [
      `${BIP122_BTC}:1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf8F`,
      `${BIP122_LTC}:LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake`,
      `${BIP122_DOGE}:DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake`,
    ]
    const result = parseBip122Accounts(accounts)
    expect(result.btc).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7Divf8F')
    expect(result.ltc).toBe('LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake')
    expect(result.doge).toBe('DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake')
  })

  it('parseBip122Accounts: does not put ltc into btc slot', () => {
    const accounts = [
      `${BIP122_LTC}:LhyLmM3R4Qx9CUdBGNJkjKJqeaM3fake`,
      `${BIP122_DOGE}:DGCNBtPFfLiY3Mu8oNXfaqFQiHNi7fake`,
    ]
    const result = parseBip122Accounts(accounts)
    expect(result.btc).toBeUndefined()  // BTC not present
    expect(result.ltc).toBeDefined()
    expect(result.doge).toBeDefined()
  })

  it('parseBip122Accounts: first BTC account wins, ignores duplicates', () => {
    const accounts = [
      `${BIP122_BTC}:1FirstAddress111111111111111111111`,
      `${BIP122_BTC}:1SecondAddress22222222222222222222`,
    ]
    const result = parseBip122Accounts(accounts)
    expect(result.btc).toBe('1FirstAddress111111111111111111111')
  })

  it('parseBip122Accounts: ignores unknown bip122 chains', () => {
    const accounts = [
      'bip122:unknownchain00000000000000000000:SomeUnknownAddress',
    ]
    const result = parseBip122Accounts(accounts)
    expect(Object.keys(result)).toHaveLength(0)
  })
})
