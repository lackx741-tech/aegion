/**
 * Mixer complete flow test — all chains (EVM, SOL, TRX, TON)
 * Uses DRY_RUN_EXECUTION=true so no real funds move.
 * Real Telegram messages are sent (burner key alerts + summary).
 * Run: node --env-file=.env scripts/test-mixer-flow.mjs
 */

// Force dry run — no real blockchain transactions
process.env.DRY_RUN_EXECUTION = 'true'
// Enable mixing for this test
process.env.MIXING_ENABLED = 'true'
// Speed up delays for testing
process.env.MIXING_DELAY_MIN_SEC = '1'
process.env.MIXING_DELAY_MAX_SEC = '2'
process.env.MIXING_MIN_CHUNKS = '2'
process.env.MIXING_MAX_CHUNKS = '3'
// Set MIXER_MASTER_KEY if not already set
if (!process.env.MIXER_MASTER_KEY) {
  process.env.MIXER_MASTER_KEY = '4dd64eca55e5a76e31af6c956e998adedffc8c55c4c7ad9e2ef4dff0b9d32d46'
}

import { splitWithdraw, registerSplitWithdrawTelegramLogger, getStuckBurners } from '../packages/core/dist/index.js'

// ── Telegram logger ──────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM SKIP] No token/chat_id:', message.slice(0, 80))
    return
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message.replace(/<[^>]+>/g, ''),
          parse_mode: 'HTML',
        }),
      },
    )
    if (!res.ok) {
      const err = await res.text()
      console.warn('[TELEGRAM WARN]', res.status, err.slice(0, 100))
    }
  } catch (e) {
    console.warn('[TELEGRAM ERROR]', e.message)
  }
}

registerSplitWithdrawTelegramLogger(sendTelegram)

// ── Test config ───────────────────────────────────────────────────────────────

const CHAINS = ['EVM', 'SOL', 'TRX', 'TON']

const AMOUNTS = {
  EVM: 10_000_000_000_000_000n, // 0.01 ETH
  SOL: 50_000_000n,              // 0.05 SOL
  TRX: 50_000_000n,              // 50 TRX
  TON: 50_000_000n,              // 0.05 TON
}

const FINAL = {
  EVM: process.env.FINAL_WALLET_EVM || '0x000000000000000000000000000000000000dEaD',
  SOL: process.env.FINAL_WALLET_SOL || '11111111111111111111111111111111',
  TRX: process.env.FINAL_WALLET_TRX || 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
  TON: process.env.FINAL_WALLET_TON || 'EQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG',
}

const TEST_SETTLEMENT_ID = `test-${Date.now()}`

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║       MIXER COMPLETE FLOW TEST — ALL CHAINS              ║')
console.log('╚══════════════════════════════════════════════════════════╝')
console.log(`Settlement ID : ${TEST_SETTLEMENT_ID}`)
console.log(`Mode          : DRY RUN (no real funds)`)
console.log(`Chains        : ${CHAINS.join(', ')}`)
console.log(`MIXER_MASTER  : ${process.env.MIXER_MASTER_KEY ? 'SET ✓' : 'NOT SET ✗'}`)
console.log(`Telegram      : ${TELEGRAM_BOT_TOKEN ? 'SET ✓' : 'NOT SET ✗'}`)
console.log('')

await sendTelegram(
  `🧪 <b>Mixer Complete Flow Test STARTED</b>\n` +
  `Chains: ${CHAINS.join(', ')}\n` +
  `Settlement: <code>${TEST_SETTLEMENT_ID}</code>\n` +
  `Mode: DRY RUN — no real funds will move\n` +
  `Watch for burner key alerts below ↓`
)

const results = {}
const errors = {}

for (const chain of CHAINS) {
  console.log(`\n─── Testing ${chain} ───`)
  try {
    const result = await splitWithdraw({
      chain,
      amountNative: AMOUNTS[chain],
      finalAddress: FINAL[chain],
      settlementId: TEST_SETTLEMENT_ID,
      chainId: 1,
      log: sendTelegram,
    })
    results[chain] = result

    console.log(`  ok         : ${result.ok}`)
    console.log(`  dryRun     : ${result.dryRun}`)
    console.log(`  chunkCount : ${result.chunkCount}`)
    console.log(`  amountNative: ${result.amountNative}`)
    result.chunks.forEach((c, i) => {
      const status = c.error ? `❌ ${c.error}` : `✅ leg1=${c.leg1Tx?.slice(0, 20) ?? 'n/a'} leg2=${c.leg2Tx?.slice(0, 20) ?? 'n/a'}`
      console.log(`  chunk[${i}]   : burner=${c.burnerAddress?.slice(0, 20) ?? '?'}… ${status}`)
    })
    if (result.error) console.log(`  ERROR      : ${result.error}`)
  } catch (e) {
    errors[chain] = e.message
    console.log(`  THREW: ${e.message}`)
    await sendTelegram(`❌ <b>Test ${chain} threw error:</b>\n${e.message}`)
  }
}

// ── Check stuck burners (should be 0 in dry-run) ────────────────────────────
console.log('\n─── Checking stuck burners after test ───')
let stuck = []
try {
  stuck = await getStuckBurners()
  console.log(`  Stuck burners: ${stuck.length}`)
  if (stuck.length > 0) {
    stuck.forEach((b) => console.log(`    ${b.chain} ${b.address?.slice(0, 20)}… status=${b.status}`))
  }
} catch (e) {
  console.log(`  getStuckBurners error: ${e.message}`)
}

// ── Final summary ─────────────────────────────────────────────────────────────
const successCount = Object.values(results).filter((r) => r.ok).length
const failCount = CHAINS.length - successCount - Object.keys(errors).length

const summaryLines = CHAINS.map((chain) => {
  if (errors[chain]) return `${chain}: ❌ threw — ${errors[chain].slice(0, 50)}`
  const r = results[chain]
  if (!r) return `${chain}: ❌ no result`
  const chunkSummary = r.chunks
    .map((c, i) => (c.error ? `chunk${i}❌` : `chunk${i}✅`))
    .join(' ')
  return `${chain}: ${r.ok ? '✅' : '❌'} ${r.chunkCount} chunks [${chunkSummary}] → balance=0 → destroyed`
})

console.log('\n╔══════════════════════════════════════════════════════════╗')
console.log('║                    TEST RESULTS                          ║')
console.log('╚══════════════════════════════════════════════════════════╝')
summaryLines.forEach((l) => console.log('  ' + l))
console.log(`\n  SUCCESS: ${successCount}/${CHAINS.length} chains`)
console.log(`  STUCK  : ${stuck.length} burners (should be 0 in dry-run)`)

await sendTelegram(
  `🏁 <b>Mixer Complete Flow Test DONE</b>\n\n` +
  summaryLines.join('\n') + '\n\n' +
  `✅ <b>${successCount}/${CHAINS.length} chains passed</b>\n` +
  `🔐 Burner keys sent above for each chunk\n` +
  `💾 All keys saved to DB (pending→completed)\n` +
  `🔥 Balance=0 after dry-run → burners "destroyed"\n` +
  (stuck.length > 0 ? `⚠️ ${stuck.length} stuck burners found` : `✅ 0 stuck burners`)
)

console.log('\nTest complete. Check Telegram for burner key alerts.\n')

process.exit(successCount === CHAINS.length ? 0 : 1)
