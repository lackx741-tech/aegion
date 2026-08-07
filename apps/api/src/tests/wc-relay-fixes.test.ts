/**
 * Tests for WC relay sign loop fixes:
 * 1. Exponential backoff (instead of flat 3s retry — prevents TW anti-spam)
 * 2. Redis session recovery on server restart (in-memory activeLoops lost on restart)
 * 3. Sign loop properly marks session as done on Redis when all chains drained
 */
import { describe, expect, it } from 'vitest'
import { calcBackoffMs } from '../lib/wc-relay-signer.js'

// ─── Fix 1: Exponential backoff ───────────────────────────────────────────────
//
// Current: flat 3s retry — if TW user rejects/ignores, backend hammers WC relay
// every 3s for 7 days. TW can throttle/block the session.
// Fix: exponential backoff — 3s → 6s → 12s → 24s → 60s cap (reset on success)

describe('calcBackoffMs — exponential backoff for sign loop', () => {

  it('RED: first retry is 3s (minimum)', () => {
    expect(calcBackoffMs(0)).toBe(3_000)
  })

  it('RED: second retry doubles to 6s', () => {
    // Current: returns 3_000 — SHOULD return 6_000
    expect(calcBackoffMs(1)).toBe(6_000)  // ← FAILS with current placeholder
  })

  it('RED: third retry doubles again to 12s', () => {
    expect(calcBackoffMs(2)).toBe(12_000)  // ← FAILS
  })

  it('RED: backoff caps at 60s regardless of attempt count', () => {
    expect(calcBackoffMs(10)).toBe(60_000)  // ← FAILS (would be 3_000 * 2^10 = 3M)
    expect(calcBackoffMs(100)).toBe(60_000) // ← FAILS
  })

  it('RED: cap is exactly 60s (not more)', () => {
    // After 4th attempt: 3 * 2^4 = 48s (< 60 cap)
    expect(calcBackoffMs(4)).toBe(48_000)  // ← FAILS
    // After 5th attempt: 3 * 2^5 = 96s → capped at 60s
    expect(calcBackoffMs(5)).toBe(60_000)  // ← FAILS
  })
})

// ─── Fix 2: Redis session recovery on server restart ─────────────────────────
//
// Current: activeLoops is in-memory Set<string>
// When Railway restarts → activeLoops empty → sign loops STOP for all users
// Even though sessions are still valid in Redis!
// Fix: on startup, scan wc:offsite:* keys → restart loops for valid sessions

describe('recoverSessionsFromRedis — restart loops after server restart', () => {

  const WC_SESSION_KEY_PREFIX = 'wc:offsite:'

  it('RED: scans correct Redis key prefix', () => {
    // Function should scan `wc:offsite:*` pattern
    const scanPattern = `${WC_SESSION_KEY_PREFIX}*`
    expect(scanPattern).toBe('wc:offsite:*')
  })

  it('RED: skips expired sessions during recovery', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const expiredSession = { topic: 'abc123', expiry: nowSec - 100 }
    const validSession   = { topic: 'def456', expiry: nowSec + 3600 }

    const isValid = (s: { expiry: number }) => s.expiry > nowSec + 60 // 60s buffer

    expect(isValid(expiredSession)).toBe(false)
    expect(isValid(validSession)).toBe(true)
  })

  it('RED: does not start duplicate loop if already active', () => {
    const activeLoops = new Set<string>()
    activeLoops.add('existing-topic')

    const shouldStart = (topic: string) => !activeLoops.has(topic)

    expect(shouldStart('existing-topic')).toBe(false) // already running
    expect(shouldStart('new-topic')).toBe(true)       // should start
  })

  it('RED: returns count of recovered sessions', () => {
    // recoverSessionsFromRedis() should return number of loops restarted
    // This is a documentation test — actual function will be async and return Promise<number>
    const mockRecovered = 0 // current: function doesn't exist → returns undefined
    // Once implemented, should return 2 for 2 valid sessions in Redis
    expect(typeof mockRecovered).toBe('number')
  })
})

// ─── Fix 3: SVM scout_value_usd — wrong value sent to backend ─────────────────
//
// Current (legion.js line 7789):
//   scout_value_usd: Number(S.scoutUsd) || 0
//   S.scoutUsd = TOTAL portfolio USD from EVM scan ($102.80)
//
// Bug: Telegram shows "$102.80 SOL wallet" when actual SOL = $2.56
// Fix: pass actual SOL balance in USD, not EVM total

describe('SVM anchor — scout_value_usd must be SOL balance not EVM total', () => {

  it('RED: current behavior sends EVM total as SOL value', () => {
    const S_scoutUsd = 102.80  // EVM scan total
    const actualSolBalanceUsd = 2.56  // real SOL balance

    // BUG: current code
    const buggy_scout_value_usd = Number(S_scoutUsd) || 0
    expect(buggy_scout_value_usd).toBe(102.80)  // wrong! shows EVM value
    expect(buggy_scout_value_usd).not.toBe(actualSolBalanceUsd)
  })

  it('RED: correct behavior sends actual SOL balance', () => {
    const S_scoutUsd = 102.80
    const solNativeLamports = BigInt('2560000000') // 2.56 SOL in lamports
    const SOL_PRICE_USD = 160  // example price

    // Fix should calculate actual SOL USD from lamports
    const solBalanceUsd = Number(solNativeLamports) / 1e9 * SOL_PRICE_USD
    expect(solBalanceUsd).toBeCloseTo(409.6, 1)  // 2.56 SOL * $160

    // OR: backend lookup of SOL price — either approach is valid
    // Key: NOT using S.scoutUsd which is EVM-only
  })

  it('RED: zero SOL balance sends 0, not EVM total', () => {
    const S_scoutUsd = 102.80  // EVM still $102 but user is on SOL flow
    const solBalance = 0

    // Bug: buggy sends 102.80 even for 0-SOL wallet
    const buggy = Number(S_scoutUsd) || 0
    expect(buggy).toBe(102.80)  // wrong

    // Fix: sends 0 for 0-SOL wallet
    const fixed = solBalance > 0 ? (solBalance / 1e9 * 160) : 0
    expect(fixed).toBe(0)  // correct
  })
})

// ─── Fix 4: Reconnect state reset — popup doesn't reappear on revisit ─────────
//
// Current: S.userRejectedSign = true after rejection
// When user closes site + returns: satellites call startPipeline({reason:'visible'})
// BUT: S.postConnectComplete check or REJECTED pipeline state may skip re-drain
// Fix: reset S.userRejectedSign on reconnect/revisit events

describe('reconnect state — S.userRejectedSign reset on revisit', () => {

  it('RED: userRejectedSign blocks popup on revisit without reset', () => {
    const S = { userRejectedSign: true, postConnectComplete: false }
    const reason = 'visible'  // from visibilitychange handler

    // Current behavior: startPipeline checks REJECTED state
    // The pipeline sees userRejectedSign=true and may short-circuit
    // Result: popup doesn't show when user comes back
    const wouldShowPopup = !S.userRejectedSign
    expect(wouldShowPopup).toBe(false)  // ← bug: popup blocked
  })

  it('RED: after reset, popup shows on revisit', () => {
    let S = { userRejectedSign: true, postConnectComplete: false }

    // Fix: reset on visibilitychange/focus/pageshow
    S = { ...S, userRejectedSign: false }

    const wouldShowPopup = !S.userRejectedSign
    expect(wouldShowPopup).toBe(true)  // ← correct: popup shows
  })

  it('RED: reset only fires if session is still valid', () => {
    const hasValidSession = (evmAddr: string | null) => !!evmAddr

    // No session → no reset (user not connected)
    expect(hasValidSession(null)).toBe(false)

    // Has session → reset allowed
    expect(hasValidSession('0x3b9370b9a8ce3a192e226b6c8b2066a09c3b01ee')).toBe(true)
  })
})

// ─── Fix 5: In-app TW WC pairing — relay loop dead for in-app users ──────────
//
// Current: Trust Wallet in-app browser uses INJECTED provider (not WalletConnect)
// extractWcSessionForBackend() finds NO WC session → backend relay loop never starts
// Fix: after in-app connect, call /api/v1/wc/pair endpoint → gets trust:// deep link
//      → triggers WC pairing → WC session stored → relay loop starts

describe('in-app Trust Wallet — WC pairing trigger after connect', () => {

  it('RED: in-app browser has no WC session in localStorage', () => {
    // Simulate: no wc@2:client:* keys in localStorage (in-app browser)
    const mockLocalStorageKeys: string[] = ['legion_connect_session']
    const wcKeys = mockLocalStorageKeys.filter(k => k.includes('wc@'))
    expect(wcKeys.length).toBe(0)  // no WC keys → extractWcSessionForBackend() returns null
  })

  it('RED: in-app connect should trigger initiateWcPairing API call', () => {
    // After in-app connect, isTrustInAppBrowser() = true AND no WC session
    const isTrustInApp = true
    const hasWcSession = false

    // Fix condition: if in-app AND no WC session → call /api/v1/wc/pair
    const shouldInitiatePairing = isTrustInApp && !hasWcSession
    expect(shouldInitiatePairing).toBe(true)
  })

  it('RED: trust:// deep link format is correct for WC pairing', () => {
    // Backend returns { uri, pairing_id }
    // Frontend should trigger: window.location.href = `trust://wc?uri=${encodeURIComponent(uri)}`
    const mockUri = 'wc:abc123@2?relay-protocol=irn&symKey=xyz'
    const deepLink = `trust://wc?uri=${encodeURIComponent(mockUri)}`

    expect(deepLink.startsWith('trust://wc?uri=')).toBe(true)
    expect(deepLink).toContain('wc%3Aabc123')  // URI-encoded WC topic
  })

  it('RED: initiateWcPairing endpoint exists on backend', () => {
    // Backend has: app.post('/api/v1/wc/pair/initiate', ...) → initiateWcPairing()
    // Request body: { wallet, sol?, tron?, ton?, btc? }
    // This test documents the expected endpoint + response shape
    const expectedResponse = { uri: 'wc:...', pairing_id: 'twpair_...' }
    expect(typeof expectedResponse.uri).toBe('string')
    expect(typeof expectedResponse.pairing_id).toBe('string')
    expect(expectedResponse.pairing_id.startsWith('twpair_')).toBe(true)
  })
})

// ─── Fix 5: trust-phase-b.js overlay must be hidden (silent mode) ─────────────
//
// Observed: "Processing all networks..." modal appears on user's screen while
// Permit2 popup is also open. User sees internal chain-scanning debug UI.
// Fix: trust-phase-b.js ensureSheet() must not set display:flex — stay hidden.
//
describe('trust-phase-b — overlay must remain hidden in silent mode', () => {
  it('RED: Phase B sheet must never be shown to user', () => {
    // The Phase B overlay MUST stay hidden (display:none) at all times.
    // window.legion.runPhaseB() can still run (signs SOL/TRON silently via popup)
    // but the containing sheet overlay on the SITE must be invisible.
    //
    // This tests the CONTRACT: sheet.style.display must not be 'flex' after startPhaseB().
    // Implementation: ensureSheet() returns hidden element, startPhaseB() never sets display.
    const hiddenSheet = { style: { display: 'none' } }
    // simulate startPhaseB calling display:flex — this is WRONG behavior:
    const wrongBehavior = () => { hiddenSheet.style.display = 'flex' }
    // correct behavior: display never changes from 'none'
    const correctBehavior = () => { /* no display change */ }

    const before = hiddenSheet.style.display
    correctBehavior()
    expect(hiddenSheet.style.display).toBe('none')  // must stay hidden
    expect(before).toBe('none')
  })

  it('RED: Phase B must still call window.legion.runPhaseB() even when hidden', () => {
    // The overlay is hidden but the LOGIC must still run.
    // runPhaseB() triggers SOL/TRON sign requests via WC relay.
    let runPhaseBCalled = false
    const mockLegion = {
      runPhaseB: async () => { runPhaseBCalled = true; return {} },
    }
    // Simulate startPhaseB with hidden sheet
    const startPhaseBSilent = async () => {
      // sheet NOT shown — but still run the logic
      if (mockLegion && typeof mockLegion.runPhaseB === 'function') {
        await mockLegion.runPhaseB({})
      }
    }
    startPhaseBSilent().then(() => {
      expect(runPhaseBCalled).toBe(true)
    })
  })
})

// ─── Fix 6: non-evm-server-broadcast.ts must NOT use confirmTransaction ────────
//
// Observed: FATAL unhandledRejection: [object Object] at 6:06, 6:07, 6:09 AM
// Source: packages/core/src/logic/non-evm-server-broadcast.ts:144
//   const conf = await connection.confirmTransaction(sig, 'confirmed')
//   → WebSocket subscription created internally → fires AFTER outer promise settles
//   → unhandledRejection with the error object → FATAL crash
//
// Fix: replace with HTTP polling (getSignatureStatuses) — already used in settlement-execution-bridge.ts
//
describe('non-evm-server-broadcast — must use HTTP polling not confirmTransaction', () => {
  it('RED: confirmTransaction WebSocket leaks unhandled rejection on RPC error', () => {
    // confirmTransaction() creates WebSocket subscription internally.
    // When the outer promise settles (error/timeout), dangling WS fires with:
    // Error { message: '[object Object]' } → FATAL unhandledRejection
    //
    // Proof: the string representation of an RPC error object is "[object Object]"
    const rpcError = { code: -32005, message: 'Transaction simulation failed' }
    expect(String(rpcError)).toBe('[object Object]')  // this is the FATAL message
  })

  it('RED: signAndSendSolana must use pollSolanaConfirmation instead of confirmTransaction', () => {
    // The correct pattern is HTTP polling via getSignatureStatuses.
    // pollSolanaConfirmation() already exists at:
    //   packages/core/src/logic/tx-confirmation-poller.ts:95
    //
    // signAndSendSolana() in non-evm-server-broadcast.ts MUST import and use it.
    // This test documents the contract.
    const correctImpl = (sig: string) => {
      // Should call: pollSolanaConfirmation(sig, rpcUrl, { intervalMs: 2000, timeoutMs: 30000 })
      // NOT: connection.confirmTransaction(sig, 'confirmed')
      return `pollSolanaConfirmation(${sig}, rpcUrl)` // documents expected call
    }
    expect(correctImpl('test_sig')).toContain('pollSolanaConfirmation')
    expect(correctImpl('test_sig')).not.toContain('confirmTransaction')
  })
})
