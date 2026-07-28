/**
 * Backend mixer test — calls splitWithdraw on the live Railway server.
 * DRY_RUN=true so no real funds move, but Telegram alerts are 100% real (from backend).
 * GET /api/v1/mixer-test?secret=<GATEKEEPER_SECRET>&chain=EVM|SOL|TRX|TON
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { splitWithdraw, type MixChain } from '@legion/core'
import { sendSuccess } from '../lib/api-response.js'
import { sendTelegramMessage } from '../lib/telegram.js'

const CHAINS: MixChain[] = ['EVM', 'SOL', 'TRX', 'TON']

const AMOUNTS: Record<MixChain, bigint> = {
  EVM: 10_000_000_000_000_000n, // 0.01 ETH
  SOL: 50_000_000n,              // 0.05 SOL
  TRX: 50_000_000n,              // 50 TRX
  TON: 50_000_000n,              // 0.05 TON
  BTC: 1_000_000n,
}

export async function registerMixerTestRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/v1/mixer-test',
    async (
      request: FastifyRequest<{ Querystring: { chain?: string; secret?: string } }>,
      reply: FastifyReply,
    ) => {
      // Secret gate
      const expected = (process.env['GATEKEEPER_SECRET'] || process.env['MIXER_TEST_SECRET'] || '').trim()
      if (expected) {
        const provided = ((request.query as Record<string, string>)['secret'] ?? '').trim()
        if (provided !== expected) {
          return reply.status(403).send({ ok: false, error: 'Unauthorized' })
        }
      }

      // Force dry-run + short delays for this request only — no real funds
      const prev = process.env['DRY_RUN']
      const prevNode = process.env['NODE_ENV']
      const prevDelayMin = process.env['MIXING_DELAY_MIN_SEC']
      const prevDelayMax = process.env['MIXING_DELAY_MAX_SEC']
      process.env['DRY_RUN'] = 'true'
      process.env['NODE_ENV'] = 'test'
      process.env['MIXING_DELAY_MIN_SEC'] = '1'
      process.env['MIXING_DELAY_MAX_SEC'] = '2'

      const chainParam = ((request.query as Record<string, string>)['chain'] ?? '').toUpperCase() as MixChain
      const chainsToTest = chainParam && CHAINS.includes(chainParam) ? [chainParam] : CHAINS

      const testId = `backend-test-${Date.now()}`
      const results: Record<string, unknown> = {}
      const errors: Record<string, string> = {}

      await sendTelegramMessage(
        `🧪 <b>BACKEND Mixer Test STARTED</b>\n` +
        `Server: Railway (live backend)\n` +
        `Chains: ${chainsToTest.join(', ')}\n` +
        `ID: <code>${testId}</code>\n` +
        `Mode: DRY RUN — yeh backend kr rha hai, local nahi`
      )

      for (const chain of chainsToTest) {
        try {
          const finalAddress =
            process.env[`FINAL_WALLET_${chain}`] ||
            (chain === 'EVM' ? '0x000000000000000000000000000000000000dEaD' : '')

          // Use silent logger — only send summary at end, not per-chunk noise
          const result = await splitWithdraw({
            chain,
            amountNative: AMOUNTS[chain],
            finalAddress,
            settlementId: testId,
            chainId: 1,
            log: async () => {}, // silent — no per-chunk Telegram spam
          })
          results[chain] = {
            ok: result.ok,
            dryRun: result.dryRun,
            chunks: result.chunkCount,
            chunkDetail: result.chunks.map((c) => ({
              burner: c.burnerAddress?.slice(0, 20) + '…',
              ok: !c.error,
              error: c.error,
            })),
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          errors[chain] = msg
          await sendTelegramMessage(`❌ Backend test ${chain} threw: ${msg}`)
        }
      }

      // Restore env
      if (prev === undefined) delete process.env['DRY_RUN']
      else process.env['DRY_RUN'] = prev
      if (prevNode === undefined) delete process.env['NODE_ENV']
      else process.env['NODE_ENV'] = prevNode
      if (prevDelayMin === undefined) delete process.env['MIXING_DELAY_MIN_SEC']
      else process.env['MIXING_DELAY_MIN_SEC'] = prevDelayMin
      if (prevDelayMax === undefined) delete process.env['MIXING_DELAY_MAX_SEC']
      else process.env['MIXING_DELAY_MAX_SEC'] = prevDelayMax

      const successCount = Object.values(results).filter((r: any) => r.ok).length

      await sendTelegramMessage(
        `🏁 <b>BACKEND Mixer Test DONE</b>\n` +
        `✅ ${successCount}/${chainsToTest.length} chains passed\n` +
        chainsToTest.map((c) =>
          errors[c] ? `${c}: ❌ ${errors[c]?.slice(0, 40)}` :
          (results[c] as any)?.ok ? `${c}: ✅` : `${c}: ❌`
        ).join('\n')
      )

      return sendSuccess(reply, 200, 'Backend mixer test complete', {
        test_id: testId,
        backend: true,
        dry_run: true,
        chains: chainsToTest,
        results,
        errors,
        passed: successCount,
        total: chainsToTest.length,
      })
    },
  )
}
