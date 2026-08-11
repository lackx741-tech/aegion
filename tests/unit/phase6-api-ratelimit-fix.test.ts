/**
 * Phase 6 — API Rate Limit Fix Assertions
 *
 * TDD: These tests FAIL first (RED), then pass after fixes (GREEN).
 *
 * Problems found:
 *   1. BLOCKCYPHER_BASE_URL defaults to '' → broken URL for BTC/LTC/DOGE
 *   2. TRON TronWeb constructor created WITHOUT api-key headers → rate limited
 *   3. TON WcRelay fetch has NO api-key header → rate limited on toncenter.com
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')

const utxoAdapter   = readFileSync(join(ROOT, 'packages/core/src/adapters/utxo-adapter.ts'),   'utf8')
const wcRelaySigner = readFileSync(join(ROOT, 'apps/api/src/lib/wc-relay-signer.ts'),           'utf8')

// ─── 1. BlockCypher — BTC/LTC/DOGE URL must have real default ────────────────
describe('utxo-adapter: BLOCKCYPHER_BASE_URL has real default (not empty)', () => {

  it('default is https://api.blockcypher.com/v1 (not empty string)', () => {
    // Before fix: ?? ''  →  broken URL when env not set
    // After  fix: ?? 'https://api.blockcypher.com/v1'
    expect(utxoAdapter).toContain("?? 'https://api.blockcypher.com/v1'")
  })

  it('empty-string default is gone', () => {
    expect(utxoAdapter).not.toMatch(/BLOCKCYPHER_BASE_URL.*\?\?\s*''/)
  })

})

// ─── 2. TRON — TronWeb must receive api-key headers at construction ───────────
describe('wc-relay-signer: TronWeb constructor receives tronApiHeaders', () => {

  it('TronWeb is constructed with headers (not bare fullHost only)', () => {
    // Before fix: new TronWeb({ fullHost })
    // After  fix: new TronWeb({ fullHost, headers: tronApiHeaders })
    expect(wcRelaySigner).toContain('new TronWeb({ fullHost, headers: tronApiHeaders })')
  })

  it('bare TronWeb({ fullHost }) without headers is gone', () => {
    expect(wcRelaySigner).not.toContain('new TronWeb({ fullHost })')
  })

})

// ─── 3. TON — WcRelay fetch must send API key header ────────────────────────
describe('wc-relay-signer: TON getAddressBalance fetch sends API key', () => {

  it('reads TONCENTER_API_KEY env var for TON section', () => {
    // Code must read the key to be able to send it
    expect(wcRelaySigner).toContain('TONCENTER_API_KEY')
  })

  it('TON fetch call includes headers option', () => {
    // fetch() must have a second argument with headers
    expect(wcRelaySigner).toMatch(/getAddressBalance[\s\S]{0,200}headers/)
  })

})
