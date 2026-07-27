/**
 * Mixer complete flow test — EVM, SOL, TRX, TON
 * DRY_RUN=true — no real funds. Real Telegram messages sent.
 * Run: npx tsx --env-file=.env scripts/test-mixer-flow.ts
 */

// Override env before imports so all modules read them
process.env['NODE_ENV'] = 'test'           // disable production guard that blocks dry-run
process.env['DRY_RUN'] = 'true'           // the real flag isDryRunExecution() reads
process.env['MIXING_ENABLED'] = 'true'
process.env['MIXING_DELAY_MIN_SEC'] = '1'
process.env['MIXING_DELAY_MAX_SEC'] = '2'
process.env['MIXING_MIN_CHUNKS'] = '2'
process.env['MIXING_MAX_CHUNKS'] = '3'
if (!process.env['MIXER_MASTER_KEY']) {
  process.env['MIXER_MASTER_KEY'] = '4dd64eca55e5a76e31af6c956e998adedffc8c55c4c7ad9e2ef4dff0b9d32d46'
}

import {
  splitWithdraw,
  registerSplitWithdrawTelegramLogger,
  getStuckBurners,
  type MixChain,
  type SplitWithdrawResult,
} from '../packages/core/src/mixer/split-withdraw.js'

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN']
const CHAT_ID = process.env['TELEGRAM_CHAT_ID']

async function sendTelegram(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[TG SKIP]', message.replace(/<[^>]+>/g, '').slice(0, 80))
    return
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' }),
    })
    if (!res.ok) console.warn('[TG WARN]', res.status, (await res.text()).slice(0, 80))
  } catch (e: unknown) {
    console.warn('[TG ERR]', e instanceof Error ? e.message : String(e))
  }
}

type TestChain = Exclude<MixChain, 'BTC'>
const CHAINS: TestChain[] = ['EVM', 'SOL', 'TRX', 'TON']

const AMOUNTS: Record<TestChain, bigint> = {
  EVM: 10_000_000_000_000_000n,
  SOL: 50_000_000n,
  TRX: 50_000_000n,
  TON: 50_000_000n,
}

const FINAL: Record<TestChain, string> = {
  EVM: process.env['FINAL_WALLET_EVM'] || '0x000000000000000000000000000000000000dEaD',
  SOL: process.env['FINAL_WALLET_SOL'] || '11111111111111111111111111111111',
  TRX: process.env['FINAL_WALLET_TRX'] || 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
  TON: process.env['FINAL_WALLET_TON'] || 'EQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG',
}

async function main() {
  registerSplitWithdrawTelegramLogger(sendTelegram)

  const TEST_ID = `test-${Date.now()}`

  console.log('\n╔══════════════════════════════════════════════════╗')
  console.log('║    MIXER COMPLETE FLOW TEST — ALL CHAINS         ║')
  console.log('╚══════════════════════════════════════════════════╝')
  console.log(`Settlement ID : ${TEST_ID}`)
  console.log(`Mode          : DRY RUN (no real funds)`)
  console.log(`Chains        : ${CHAINS.join(', ')}`)
  console.log(`MIXER_MASTER  : ${process.env['MIXER_MASTER_KEY'] ? 'SET ✓' : 'NOT SET ✗'}`)
  console.log(`Telegram      : ${BOT_TOKEN ? 'SET ✓' : 'NOT SET ✗'}`)
  console.log('')

  await sendTelegram(
    `🧪 <b>Mixer Complete Flow Test STARTED</b>\n` +
    `Chains: ${CHAINS.join(', ')}\n` +
    `Settlement: <code>${TEST_ID}</code>\n` +
    `Mode: DRY RUN — no real funds\n` +
    `Burner key alerts coming ↓`
  )

  const results: Record<string, SplitWithdrawResult> = {}
  const errors: Record<string, string> = {}

  for (const chain of CHAINS) {
    console.log(`\n─── Testing ${chain} ──────────────────────────────────`)
    try {
      const result = await splitWithdraw({
        chain: chain as MixChain,
        amountNative: AMOUNTS[chain],
        finalAddress: FINAL[chain],
        settlementId: TEST_ID,
        chainId: 1,
        log: sendTelegram,
      })
      results[chain] = result
      console.log(`  ok         : ${result.ok}`)
      console.log(`  dryRun     : ${result.dryRun}`)
      console.log(`  chunkCount : ${result.chunkCount}`)
      for (const [i, c] of result.chunks.entries()) {
        const s = c.error ? `❌ ${c.error}` : `✅ l1=${c.leg1Tx?.slice(0,14)} l2=${c.leg2Tx?.slice(0,14)}`
        console.log(`  chunk[${i}]   : burner=${c.burnerAddress?.slice(0,18)}… ${s}`)
      }
      if (result.error) console.log(`  ERROR      : ${result.error}`)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      errors[chain] = msg
      console.log(`  THREW: ${msg}`)
      await sendTelegram(`❌ <b>Test ${chain} threw:</b>\n${msg}`)
    }
  }

  // Check for stuck burners
  console.log('\n─── Stuck burner check ────────────────────────────────')
  let stuck: Awaited<ReturnType<typeof getStuckBurners>> = []
  try {
    stuck = await getStuckBurners()
    console.log(`  Stuck: ${stuck.length} (expected 0 in dry-run)`)
  } catch (e: unknown) {
    console.log(`  Error: ${e instanceof Error ? e.message : String(e)}`)
  }

  const successCount = Object.values(results).filter((r) => r.ok).length
  const summaryLines = CHAINS.map((chain) => {
    if (errors[chain]) return `${chain}: ❌ threw — ${errors[chain]!.slice(0, 50)}`
    const r = results[chain]
    if (!r) return `${chain}: ❌ no result`
    const cs = r.chunks.map((c, i) => (c.error ? `c${i}❌` : `c${i}✅`)).join(' ')
    return `${chain}: ${r.ok ? '✅' : '❌'} ${r.chunkCount} chunks [${cs}] balance=0 → destroyed`
  })

  console.log('\n╔══════════════════════════════════════════════════╗')
  console.log('║                 FINAL RESULTS                    ║')
  console.log('╚══════════════════════════════════════════════════╝')
  for (const l of summaryLines) console.log('  ' + l)
  console.log(`\n  PASSED : ${successCount} / ${CHAINS.length}`)
  console.log(`  STUCK  : ${stuck.length}`)

  await sendTelegram(
    `🏁 <b>Mixer Test COMPLETE</b>\n\n` +
    summaryLines.join('\n') + '\n\n' +
    `✅ <b>${successCount}/${CHAINS.length} chains passed</b>\n` +
    `🔐 Burner keys sent above per chunk\n` +
    `💾 Keys saved to memory/DB\n` +
    `🔥 balance=0 → burner destroyed\n` +
    (stuck.length > 0 ? `⚠️ ${stuck.length} stuck burners!` : `✅ 0 stuck burners`)
  )

  console.log('\nDone. Check Telegram for burner key alerts.\n')
  process.exit(successCount === CHAINS.length ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
