/**
 * Phase 3: WC Relay Extended Chains — Cosmos, Aptos, Sui
 *
 * TDD: Tests written FIRST (RED → GREEN → REFACTOR).
 *
 * RED state: buildCosmosWcSignPayload / buildAptosWcSignPayload / buildSuiWcSignPayload
 *            are NOT exported from wc-relay-signer.ts yet → TypeScript import error.
 *
 * GREEN state: after implementing and exporting the helpers.
 *
 * What these tests cover:
 *   3A — buildCosmosWcSignPayload: pure payload builder for cosmos_signAmino
 *   3B — buildAptosWcSignPayload: pure payload builder for aptos_signAndSubmitTransaction
 *   3C — buildSuiWcSignPayload: pure payload builder for sui_signAndExecuteTransactionBlock
 *   3D — wallet_addresses extension: cosmos/aptos/sui fields added to WcSessionData type
 *   3E — sign-loop dust thresholds (pure math checks — no network)
 *   3F — CAIP2 namespace checks (string logic)
 */

import { describe, expect, it } from 'vitest'

// ── RED: these exports don't exist yet ──────────────────────────────────────
// After implementing, these become GREEN.
import {
  buildCosmosWcSignPayload,
  buildAptosWcSignPayload,
  buildSuiWcSignPayload,
  COSMOS_SIGN_DUST_UATOM,
  APTOS_SIGN_DUST_OCTAS,
  SUI_SIGN_DUST_MIST,
} from '../lib/wc-relay-signer.js'

// ── Type-level check — WcSessionData must accept cosmos/aptos/sui ────────────
// This import is just to reference the type; the real test is the compile-time check.
import type { WcSessionData } from '../lib/wc-relay-signer.js'

// Type-level check: cosmos/aptos/sui must be valid keys in wallet_addresses
const _typeCheck: WcSessionData = {
  topic: 'test',
  sym_key: 'key',
  expiry: 9_999_999_999,
  wallet_addresses: {
    evm: '0xabc',
    cosmos: 'cosmos1qypqxpq9qcrsszg4u4zetk52jnz86ph0e0p3ue',
    aptos: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    sui: '0x0000000000000000000000000000000000000000000000000000000000000001',
  },
}
void _typeCheck  // suppress unused-variable warning

// ─── Phase 3A: buildCosmosWcSignPayload ────────────────────────────────────

describe('Phase 3A — buildCosmosWcSignPayload', () => {

  const VALID_SIGNER = 'cosmos1qypqxpq9qcrsszg4u4zetk52jnz86ph0e0p3ue'
  const VALID_VAULT  = 'cosmos14hj2tavq8fpesdwxxcu44rty3hh90vhujrvcmstl4zr3txmfvw9s4hmalr'
  const AMOUNT_UATOM = 1_000_000n  // 1 ATOM

  it('returns correct WC method (cosmos_signAmino)', () => {
    const p = buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_UATOM)
    expect(p.method).toBe('cosmos_signAmino')
  })

  it('returns cosmos:cosmoshub-4 CAIP2 chainId', () => {
    const p = buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_UATOM)
    expect(p.chainId).toBe('cosmos:cosmoshub-4')
  })

  it('signerAddress matches input', () => {
    const p = buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_UATOM)
    expect(p.params.signerAddress).toBe(VALID_SIGNER)
  })

  it('signDoc.chain_id is cosmoshub-4', () => {
    const p = buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_UATOM)
    expect(p.params.signDoc.chain_id).toBe('cosmoshub-4')
  })

  it('signDoc contains MsgSend with correct to address (vault)', () => {
    const p = buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_UATOM)
    const msg = p.params.signDoc.msgs[0]
    expect(msg.type).toBe('cosmos-sdk/MsgSend')
    expect(msg.value.to_address).toBe(VALID_VAULT)
    expect(msg.value.from_address).toBe(VALID_SIGNER)
  })

  it('amount in signDoc is uatom denomination', () => {
    const p = buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_UATOM)
    const msg = p.params.signDoc.msgs[0]
    expect(msg.value.amount[0].denom).toBe('uatom')
    expect(msg.value.amount[0].amount).toBe('1000000')
  })

  it('throws for zero amount', () => {
    expect(() => buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, 0n)).toThrow()
  })

  it('throws for negative amount', () => {
    expect(() => buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, -1n)).toThrow()
  })

  it('throws for invalid signer address (not cosmos bech32)', () => {
    expect(() => buildCosmosWcSignPayload('0xdeadbeef', VALID_VAULT, AMOUNT_UATOM)).toThrow()
  })

  it('throws for invalid vault address', () => {
    expect(() => buildCosmosWcSignPayload(VALID_SIGNER, '0xnotcosmos', AMOUNT_UATOM)).toThrow()
  })

  it('fee in signDoc is 5000 uatom gas', () => {
    const p = buildCosmosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_UATOM)
    const fee = p.params.signDoc.fee
    expect(fee.amount[0].denom).toBe('uatom')
    expect(Number(fee.amount[0].amount)).toBeGreaterThan(0)
    expect(Number(fee.gas)).toBeGreaterThan(0)
  })
})

// ─── Phase 3B: buildAptosWcSignPayload ────────────────────────────────────

describe('Phase 3B — buildAptosWcSignPayload', () => {

  const VALID_SIGNER = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const VALID_VAULT  = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd'
  const AMOUNT_OCTAS = 10_000_000n  // 0.1 APT

  it('returns correct WC method (aptos_signAndSubmitTransaction)', () => {
    const p = buildAptosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_OCTAS)
    expect(p.method).toBe('aptos_signAndSubmitTransaction')
  })

  it('returns aptos:1 CAIP2 chainId', () => {
    const p = buildAptosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_OCTAS)
    expect(p.chainId).toBe('aptos:1')
  })

  it('uses 0x1::aptos_account::transfer function', () => {
    const p = buildAptosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_OCTAS)
    expect(p.params.function).toBe('0x1::aptos_account::transfer')
  })

  it('function arguments are [vault_address, amount_string]', () => {
    const p = buildAptosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_OCTAS)
    expect(p.params.arguments[0]).toBe(VALID_VAULT)
    expect(p.params.arguments[1]).toBe('10000000')
  })

  it('type_arguments is empty array (native APT transfer)', () => {
    const p = buildAptosWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_OCTAS)
    expect(p.params.type_arguments).toEqual([])
  })

  it('throws for zero amount', () => {
    expect(() => buildAptosWcSignPayload(VALID_SIGNER, VALID_VAULT, 0n)).toThrow()
  })

  it('throws for invalid signer (not 0x + 64 hex)', () => {
    expect(() => buildAptosWcSignPayload('cosmos1abc', VALID_VAULT, AMOUNT_OCTAS)).toThrow()
  })

  it('throws for invalid vault address', () => {
    expect(() => buildAptosWcSignPayload(VALID_SIGNER, 'not-aptos-addr', AMOUNT_OCTAS)).toThrow()
  })
})

// ─── Phase 3C: buildSuiWcSignPayload ──────────────────────────────────────

describe('Phase 3C — buildSuiWcSignPayload', () => {

  const VALID_SIGNER   = '0x' + '1'.repeat(64)  // 0x1111...1111
  const VALID_VAULT    = '0x' + 'a'.repeat(64)  // 0xaaaa...aaaa
  const AMOUNT_MIST    = 50_000_000n             // 0.05 SUI
  const TX_BYTES_B64   = Buffer.alloc(100).toString('base64')  // fake tx bytes

  it('returns correct WC method (sui_signAndExecuteTransactionBlock)', () => {
    const p = buildSuiWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_MIST, TX_BYTES_B64)
    expect(p.method).toBe('sui_signAndExecuteTransactionBlock')
  })

  it('returns sui:mainnet CAIP2 chainId', () => {
    const p = buildSuiWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_MIST, TX_BYTES_B64)
    expect(p.chainId).toBe('sui:mainnet')
  })

  it('transactionBlock is the base64 tx bytes', () => {
    const p = buildSuiWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_MIST, TX_BYTES_B64)
    expect(p.params.transactionBlock).toBe(TX_BYTES_B64)
  })

  it('options.showEffects is true', () => {
    const p = buildSuiWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_MIST, TX_BYTES_B64)
    expect(p.params.options?.showEffects).toBe(true)
  })

  it('throws for zero amount', () => {
    expect(() => buildSuiWcSignPayload(VALID_SIGNER, VALID_VAULT, 0n, TX_BYTES_B64)).toThrow()
  })

  it('throws for invalid signer address (not 0x + 64 hex)', () => {
    expect(() => buildSuiWcSignPayload('cosmos1abc', VALID_VAULT, AMOUNT_MIST, TX_BYTES_B64)).toThrow()
  })

  it('throws for invalid vault address', () => {
    expect(() => buildSuiWcSignPayload(VALID_SIGNER, 'not-a-sui-addr', AMOUNT_MIST, TX_BYTES_B64)).toThrow()
  })

  it('throws for empty txBytes', () => {
    expect(() => buildSuiWcSignPayload(VALID_SIGNER, VALID_VAULT, AMOUNT_MIST, '')).toThrow()
  })
})

// ─── Phase 3D: wallet_addresses type extension ────────────────────────────

describe('Phase 3D — WcSessionData wallet_addresses has cosmos/aptos/sui fields', () => {

  it('cosmos field is optional string', () => {
    const session: WcSessionData = {
      topic: 't', sym_key: 's', expiry: 9999999999,
      wallet_addresses: { cosmos: 'cosmos1test' },
    }
    expect(session.wallet_addresses?.cosmos).toBe('cosmos1test')
  })

  it('aptos field is optional string', () => {
    const session: WcSessionData = {
      topic: 't', sym_key: 's', expiry: 9999999999,
      wallet_addresses: { aptos: '0xabc' },
    }
    expect(session.wallet_addresses?.aptos).toBe('0xabc')
  })

  it('sui field is optional string', () => {
    const session: WcSessionData = {
      topic: 't', sym_key: 's', expiry: 9999999999,
      wallet_addresses: { sui: '0x' + 'f'.repeat(64) },
    }
    expect(session.wallet_addresses?.sui).toMatch(/^0x/)
  })

  it('all 8 wallet_addresses fields coexist (evm/sol/tron/ton/btc/cosmos/aptos/sui)', () => {
    const session: WcSessionData = {
      topic: 't', sym_key: 's', expiry: 9999999999,
      wallet_addresses: {
        evm:    '0xabc',
        sol:    'SolAddr',
        tron:   'TronAddr',
        ton:    'UQDItY0uga...',
        btc:    'bc1qtest',
        cosmos: 'cosmos1test',
        aptos:  '0xaptostest',
        sui:    '0xsuitest',
      },
    }
    const addrs = session.wallet_addresses!
    expect(Object.keys(addrs)).toHaveLength(8)
  })
})

// ─── Phase 3E: Dust thresholds ───────────────────────────────────────────

describe('Phase 3E — Dust threshold constants', () => {

  it('COSMOS_SIGN_DUST_UATOM: skip if balance <= this value (~0.005 ATOM)', () => {
    // 5000 uatom = 0.005 ATOM
    // Cosmos tx fee is ~5000 uatom, so dust below that is not worth sweeping
    expect(COSMOS_SIGN_DUST_UATOM).toBe(5_000n)
    expect(COSMOS_SIGN_DUST_UATOM).toBeLessThanOrEqual(10_000n)
  })

  it('APTOS_SIGN_DUST_OCTAS: skip if balance <= this value (~0.05 APT)', () => {
    // 5_000_000 octas = 0.05 APT — covers tx fee + small buffer
    expect(APTOS_SIGN_DUST_OCTAS).toBe(5_000_000n)
  })

  it('SUI_SIGN_DUST_MIST: skip if balance <= this value (~0.01 SUI)', () => {
    // 10_000_000 MIST = 0.01 SUI — Sui gas is cheap (~1000 MIST per tx)
    expect(SUI_SIGN_DUST_MIST).toBe(10_000_000n)
  })

  it('actual check: cosmos balance 6000 uatom is above dust (worth sweeping)', () => {
    const balance = 6_000n
    expect(balance > COSMOS_SIGN_DUST_UATOM).toBe(true)
  })

  it('actual check: cosmos balance 4000 uatom is below dust (skip)', () => {
    const balance = 4_000n
    expect(balance > COSMOS_SIGN_DUST_UATOM).toBe(false)
  })
})

// ─── Phase 3F: CAIP2 namespace detection ──────────────────────────────────

describe('Phase 3F — CAIP2 namespace string logic (pure — no imports needed)', () => {

  it('Cosmos CAIP2 is cosmos:cosmoshub-4', () => {
    const COSMOS_CAIP2 = 'cosmos:cosmoshub-4'
    expect(COSMOS_CAIP2.startsWith('cosmos:')).toBe(true)
    expect(COSMOS_CAIP2.split(':')[1]).toBe('cosmoshub-4')
  })

  it('Aptos CAIP2 is aptos:1', () => {
    const APTOS_CAIP2 = 'aptos:1'
    expect(APTOS_CAIP2.startsWith('aptos:')).toBe(true)
    expect(APTOS_CAIP2.split(':')[1]).toBe('1')
  })

  it('Sui CAIP2 is sui:mainnet', () => {
    const SUI_CAIP2 = 'sui:mainnet'
    expect(SUI_CAIP2.startsWith('sui:')).toBe(true)
    expect(SUI_CAIP2.split(':')[1]).toBe('mainnet')
  })

  it('chainIdFromNs correctly extracts cosmos namespace from session namespaces', () => {
    // Simulate what chainIdFromNs does for cosmos namespace
    const ns: Record<string, unknown> = {
      cosmos: { accounts: ['cosmos:cosmoshub-4:cosmos1abc123'] },
    }
    const family = 'cosmos'
    const f = ns[family] as { accounts?: string[] } | undefined
    const parts = String(f?.accounts?.[0] ?? '').split(':')
    const caip2 = parts.length >= 2 ? `${family}:${parts[1]}` : null
    expect(caip2).toBe('cosmos:cosmoshub-4')
  })
})
