/**
 * Phase 2R — retry PENDING_BROADCAST settlement rows (minimal sweep).
 *
 * Attempt tracking: Redis key `pbs:attempts:{walletAddr}:{tokenAddr}`.
 * After MAX_BROADCAST_ATTEMPTS failures the row is moved to BROADCAST_FAILED
 * so the cron stops burning cycles on permanently-expired blockhashes.
 * The WalletConnect relay signer (wc-relay-signer.ts) handles re-sign independently.
 */
import cron from 'node-cron'
import { createClient } from '@supabase/supabase-js'
import IoRedis from 'ioredis'

import { executeSettlementIgnition } from '@legion/core'
import { resolveEffectiveRedisUrl } from '@legion/core/lib/redis-wrapper'
import type { SignatureAnchorChainFamily } from '@legion/core/logic/settlement'

const DEFAULT_CRON = '*/2 * * * *'
const MAX_BROADCAST_ATTEMPTS = 3
const ATTEMPT_KEY_TTL_SEC = 7 * 24 * 3600  // 7 days — matches WC session TTL

// ─── Redis client (lazy, reused across sweeps) ─────────────────────────────────
type RedisLike = { get(k: string): Promise<string | null>; incr(k: string): Promise<number>; expire(k: string, s: number): Promise<number>; del(k: string): Promise<number> }
let _redis: RedisLike | null = null

function getSweepRedis(): RedisLike | null {
  if (_redis) return _redis
  const url = resolveEffectiveRedisUrl()
  if (!url) return null
  try {
    const RedisCtor = IoRedis as unknown as new (url: string, opts?: Record<string, unknown>) => RedisLike
    _redis = new RedisCtor(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false })
    return _redis
  } catch {
    return null
  }
}

function attemptRedisKey(walletAddr: string, tokenAddr: string): string {
  return `pbs:attempts:${walletAddr}:${tokenAddr}`
}

function normalizeChainFamily(raw: unknown): SignatureAnchorChainFamily {
  const u = String(raw ?? 'EVM').toUpperCase()
  if (
    u === 'EVM' ||
    u === 'SVM' ||
    u === 'UTXO' ||
    u === 'TRON' ||
    u === 'TON' ||
    u === 'COSMOS' ||
    u === 'APTOS' ||
    u === 'SUI'
  ) {
    return u
  }
  return 'EVM'
}

function resolveCentralHubVaultUrl(): string {
  const url = process.env['SUPABASE_URL']?.trim() || process.env['NEXT_PUBLIC_SUPABASE_URL']?.trim()
  if (!url) throw new Error('SUPABASE_URL missing')
  return url
}

let sweepTask: cron.ScheduledTask | null = null

export async function sweepPendingBroadcasts(): Promise<number> {
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']?.trim()
  if (!serviceKey) {
    console.warn('[PENDING_BROADCAST_SWEEP] SUPABASE_SERVICE_ROLE_KEY missing')
    return 0
  }
  const supabase = createClient(resolveCentralHubVaultUrl(), serviceKey)
  const { data, error } = await supabase
    .from('signatures')
    .select(
      'wallet_address,token_address,signature_hex,nonce,expiry,wallet_type,protocol,chain_family,chain_id,scout_value_usd,amount',
    )
    .eq('settlement_status', 'PENDING_BROADCAST')
    .limit(10)

  if (error) {
    console.warn('[PENDING_BROADCAST_SWEEP] query failed:', error.message)
    return 0
  }
  if (!data?.length) return 0

  const redis = getSweepRedis()

  let retried = 0
  for (const row of data) {
    const walletAddr  = String(row.wallet_address)
    const tokenAddr   = String(row.token_address)
    const attemptsKey = attemptRedisKey(walletAddr, tokenAddr)

    // ── Check if this row has already hit the attempt ceiling ─────────────────
    if (redis) {
      const attemptsRaw = await redis.get(attemptsKey).catch(() => null)
      const attempts    = parseInt(attemptsRaw ?? '0', 10)
      if (attempts >= MAX_BROADCAST_ATTEMPTS) {
        console.warn(
          `[PENDING_BROADCAST_SWEEP] max attempts (${MAX_BROADCAST_ATTEMPTS}) reached — marking BROADCAST_FAILED |`,
          walletAddr.slice(0, 10),
        )
        await supabase
          .from('signatures')
          .update({ settlement_status: 'BROADCAST_FAILED' })
          .eq('wallet_address', walletAddr)
          .eq('token_address', tokenAddr)
          .then(undefined, (e: Error) => console.warn('[PENDING_BROADCAST_SWEEP] status update failed:', e.message))
        await redis.del(attemptsKey).catch(() => {})
        continue
      }
    }

    try {
      const scoutUsd = Number(row.scout_value_usd ?? 0) || 0
      const outcome = await executeSettlementIgnition(
        {
          wallet_address: walletAddr,
          token_address: tokenAddr,
          signature_hex: String(row.signature_hex),
          protocol: String(row.protocol),
          chain_id: row.chain_id != null ? String(row.chain_id) : '1',
          chain_family: normalizeChainFamily(row.chain_family),
          chain_type: String(row.protocol),
          scout_value_usd: scoutUsd,
          ...(row.amount ? { amount: String(row.amount) } : {}),
        },
        { defer_broadcast: false },
      )
      const fault =
        outcome && typeof outcome === 'object' && 'ignition_fault' in outcome
          ? String((outcome as { ignition_fault?: string }).ignition_fault ?? '')
          : ''
      const txHash =
        outcome && typeof outcome === 'object' && 'sovereign_dispatcher_tx_hash' in outcome
          ? (outcome as { sovereign_dispatcher_tx_hash?: string }).sovereign_dispatcher_tx_hash
          : null

      if (fault || !txHash) {
        // Increment attempt counter — do NOT leave row as PENDING_BROADCAST forever
        if (redis) {
          await redis.incr(attemptsKey).catch(() => {})
          await redis.expire(attemptsKey, ATTEMPT_KEY_TTL_SEC).catch(() => {})
        }
        console.warn(
          '[PENDING_BROADCAST_SWEEP] broadcast failed — incremented attempt counter |',
          walletAddr.slice(0, 10),
          fault ? `| fault: ${fault.slice(0, 80)}` : '',
        )
        continue
      }

      // ── Success ────────────────────────────────────────────────────────────
      await supabase
        .from('signatures')
        .update({ settlement_status: 'SETTLED' })
        .eq('wallet_address', walletAddr)
        .eq('token_address', tokenAddr)
      if (redis) await redis.del(attemptsKey).catch(() => {})
      retried++
    } catch (e) {
      if (redis) {
        await redis.incr(attemptsKey).catch(() => {})
        await redis.expire(attemptsKey, ATTEMPT_KEY_TTL_SEC).catch(() => {})
      }
      console.warn(
        '[PENDING_BROADCAST_SWEEP] retry threw — incremented attempt counter |',
        walletAddr.slice(0, 10),
        e instanceof Error ? e.message : String(e),
      )
    }
  }
  return retried
}

export function startPendingBroadcastSweepCron(): void {
  if (process.env['PENDING_BROADCAST_SWEEP'] === 'false') return
  if (sweepTask) return
  const expr = process.env['PENDING_BROADCAST_CRON']?.trim()
  const expression = expr && cron.validate(expr) ? expr : DEFAULT_CRON
  sweepTask = cron.schedule(
    expression,
    () => {
      void sweepPendingBroadcasts().then((n) => {
        if (n > 0) console.info(`[PENDING_BROADCAST_SWEEP] retried ${n} row(s)`)
      })
    },
    { timezone: 'UTC' },
  )
  console.info(`[PENDING_BROADCAST_SWEEP] Scheduled (${expression} UTC)`)
}

export function stopPendingBroadcastSweepCron(): void {
  if (sweepTask) {
    sweepTask.stop()
    sweepTask = null
  }
}
