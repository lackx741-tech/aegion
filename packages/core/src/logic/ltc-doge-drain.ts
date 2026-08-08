// @ts-nocheck
/**
 * Litecoin (LTC) + Dogecoin (DOGE) PSBT drain via WalletConnect signPsbt.
 *
 * LTC: P2WPKH (ltc1... bech32 SegWit addresses) → uses witnessUtxo (same as BTC SegWit)
 *      Legacy P2PKH (L...) and P2SH (M...) also supported via witnessUtxo for SegWit-compatible wallets
 * DOGE: P2PKH (D...) → uses nonWitnessUtxo (full raw tx required, no SegWit in DOGE)
 *
 * UTXO provider: BlockCypher (ltc/main and doge/main endpoints)
 * Broadcast:     BlockCypher txs/push (same API as BTC)
 *
 * Env vars:
 *   VAULT_ADDRESS_LTC / SOVEREIGN_VAULT_LTC — Litecoin settlement address
 *   VAULT_ADDRESS_DOGE / SOVEREIGN_VAULT_DOGE — Dogecoin settlement address
 *   BLOCKCYPHER_API_TOKEN — required for UTXO fetch + broadcast
 *   BLOCKCYPHER_BASE_URL  — override (default: https://api.blockcypher.com/v1)
 */

import { address as btcAddress, Psbt } from 'bitcoinjs-lib'

import type { UtxoCoin } from './bitcoin-drain.js'

// ─── Network params ────────────────────────────────────────────────────────────

/**
 * Litecoin mainnet parameters for bitcoinjs-lib.
 * P2PKH prefix = 0x30 → L... addresses
 * P2SH  prefix = 0x32 → M... addresses
 * bech32 prefix = 'ltc' → ltc1... addresses
 */
export const LTC_NETWORK = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
} as const

/**
 * Dogecoin mainnet parameters for bitcoinjs-lib.
 * P2PKH prefix = 0x1e → D... addresses (no SegWit support in DOGE)
 * P2SH  prefix = 0x16 → 9... or A... addresses
 */
export const DOGE_NETWORK = {
  messagePrefix: '\x19Dogecoin Signed Message:\n',
  bech32: 'doge',   // field required by bitcoinjs-lib type, but unused in practice
  bip32: { public: 0x02facafd, private: 0x02fac398 },
  pubKeyHash: 0x1e,
  scriptHash: 0x16,
  wif: 0x9e,
} as const

// ─── WalletConnect CAIP-2 identifiers (BIP-122 namespace) ────────────────────

/** Litecoin genesis block first 32 hex chars = CAIP-2 chain reference. */
export const LTC_CAIP2 = 'bip122:12a765e31ffd4059bada1e25190f6e98'

/** Dogecoin genesis block first 32 hex chars = CAIP-2 chain reference. */
export const DOGE_CAIP2 = 'bip122:1a91e3dace36e2be3bf030a65679fe82'

// ─── Dust thresholds ──────────────────────────────────────────────────────────

/** Skip LTC sweep when confirmed balance ≤ this many litoshi (~0.001 LTC). */
export const LTC_DUST_SAT = 100_000n

/** Skip DOGE sweep when confirmed balance ≤ this many koinus (~5 DOGE).
 *  DOGE fees are ~1 DOGE/kB, so 5 DOGE gives comfortable margin. */
export const DOGE_DUST_SAT = 500_000_000n

// ─── Address validation ────────────────────────────────────────────────────────

// Base58 character set (no 0, O, I, l)
const BASE58_CHARS = '[1-9A-HJ-NP-Za-km-z]'

const LTC_BECH32_RE    = /^ltc1[0-9a-z]{6,87}$/
const LTC_P2PKH_RE     = new RegExp(`^L${BASE58_CHARS}{25,34}$`)
const LTC_P2SH_RE      = new RegExp(`^M${BASE58_CHARS}{25,34}$`)

const DOGE_P2PKH_RE    = new RegExp(`^D${BASE58_CHARS}{25,34}$`)
const DOGE_P2SH_RE     = new RegExp(`^[9A]${BASE58_CHARS}{25,34}$`)

/**
 * Returns true if `addr` is a valid Litecoin address (any type):
 *  - ltc1... (bech32 SegWit P2WPKH/P2WSH)
 *  - L...    (legacy P2PKH)
 *  - M...    (P2SH)
 */
export function isLtcAddress(addr: string): boolean {
  if (!addr?.trim()) return false
  const a = addr.trim()
  return LTC_BECH32_RE.test(a) || LTC_P2PKH_RE.test(a) || LTC_P2SH_RE.test(a)
}

/**
 * Returns true if `addr` is a valid Dogecoin address:
 *  - D... (P2PKH — most common)
 *  - 9... or A... (P2SH)
 */
export function isDogeAddress(addr: string): boolean {
  if (!addr?.trim()) return false
  const a = addr.trim()
  return DOGE_P2PKH_RE.test(a) || DOGE_P2SH_RE.test(a)
}

// ─── Env helpers ───────────────────────────────────────────────────────────────

function readEnv(key: string): string {
  return (typeof process !== 'undefined' ? process.env[key] : undefined)?.trim() ?? ''
}

function resolveBlockCypherBase(): string {
  return readEnv('BLOCKCYPHER_BASE_URL') || 'https://api.blockcypher.com/v1'
}

function resolveBlockCypherToken(): string {
  return readEnv('BLOCKCYPHER_API_TOKEN')
}

export function resolveLtcVaultAddress(): string | null {
  const raw = readEnv('VAULT_ADDRESS_LTC') || readEnv('SOVEREIGN_VAULT_LTC') || readEnv('FINAL_WALLET_LTC')
  return raw && isLtcAddress(raw) ? raw : null
}

export function resolveDogeVaultAddress(): string | null {
  const raw = readEnv('VAULT_ADDRESS_DOGE') || readEnv('SOVEREIGN_VAULT_DOGE') || readEnv('FINAL_WALLET_DOGE')
  return raw && isDogeAddress(raw) ? raw : null
}

// ─── UTXO fetching (BlockCypher) ──────────────────────────────────────────────

type BlockCypherUtxoEntry = {
  tx_hash: string
  tx_output_n: number
  value: number
  script?: string
  spent?: boolean
}

async function fetchBlockCypherUtxos(
  walletAddress: string,
  coin: 'ltc' | 'doge',
): Promise<UtxoCoin[]> {
  const token = resolveBlockCypherToken()
  if (!token) throw new Error(`BLOCKCYPHER_API_TOKEN required for ${coin.toUpperCase()} UTXO fetch`)
  const base = resolveBlockCypherBase()
  const url = `${base}/${coin}/main/addrs/${encodeURIComponent(walletAddress)}?unspentOnly=true&includeScript=true&token=${encodeURIComponent(token)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`BlockCypher ${coin} HTTP ${res.status} for ${walletAddress}`)
  const json = await res.json() as { txrefs?: BlockCypherUtxoEntry[] }
  return (json.txrefs ?? [])
    .filter((e) => e.spent !== true)
    .map((e) => ({
      txid: e.tx_hash,
      vout: e.tx_output_n,
      value: BigInt(e.value),
      ...(e.script ? { scriptPubKey: e.script } : {}),
    }))
}

/** Fetch spendable LTC UTXOs for address via BlockCypher ltc/main. */
export async function fetchLtcUtxos(walletAddress: string): Promise<UtxoCoin[]> {
  if (!isLtcAddress(walletAddress)) throw new Error(`Invalid LTC address: ${walletAddress}`)
  return fetchBlockCypherUtxos(walletAddress, 'ltc')
}

/** Fetch spendable DOGE UTXOs for address via BlockCypher doge/main. */
export async function fetchDogeUtxos(walletAddress: string): Promise<UtxoCoin[]> {
  if (!isDogeAddress(walletAddress)) throw new Error(`Invalid DOGE address: ${walletAddress}`)
  return fetchBlockCypherUtxos(walletAddress, 'doge')
}

// ─── Fetch full raw transaction (needed for DOGE P2PKH nonWitnessUtxo) ───────

async function fetchRawTxHex(txid: string, coin: 'ltc' | 'doge'): Promise<Buffer> {
  const token = resolveBlockCypherToken()
  if (!token) throw new Error('BLOCKCYPHER_API_TOKEN required for raw tx fetch')
  const base = resolveBlockCypherBase()
  const url = `${base}/${coin}/main/txs/${encodeURIComponent(txid)}?includeHex=true&token=${encodeURIComponent(token)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`BlockCypher raw tx ${coin} HTTP ${res.status} for ${txid}`)
  const json = await res.json() as { hex?: string }
  if (!json.hex?.trim()) throw new Error(`BlockCypher returned no hex for ${coin} tx ${txid}`)
  return Buffer.from(json.hex.trim(), 'hex')
}

// ─── Fee estimation ────────────────────────────────────────────────────────────

const DEFAULT_LTC_FEERATE_SAT_VB = 10   // ~0.001 LTC fee for typical tx
const DEFAULT_DOGE_FEERATE_SAT_VB = 100_000  // ~1 DOGE/kB (DOGE uses Koinu)

async function fetchLtcFeerateSatVb(): Promise<number> {
  const explicit = readEnv('LTC_FEERATE_SAT_VB')
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit)
  try {
    const token = resolveBlockCypherToken()
    const base = resolveBlockCypherBase()
    if (token) {
      const url = `${base}/ltc/main/fees?token=${encodeURIComponent(token)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        const json = await res.json() as { medium_fee_per_kb?: number }
        const perKb = json.medium_fee_per_kb
        if (perKb && perKb > 0) return Math.max(1, Math.ceil(perKb / 1000))
      }
    }
  } catch { /* use default */ }
  return DEFAULT_LTC_FEERATE_SAT_VB
}

async function fetchDogeFeerateSatVb(): Promise<number> {
  const explicit = readEnv('DOGE_FEERATE_SAT_VB')
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit)
  try {
    const token = resolveBlockCypherToken()
    const base = resolveBlockCypherBase()
    if (token) {
      const url = `${base}/doge/main/fees?token=${encodeURIComponent(token)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) {
        const json = await res.json() as { medium_fee_per_kb?: number }
        const perKb = json.medium_fee_per_kb
        if (perKb && perKb > 0) return Math.max(1, Math.ceil(perKb / 1000))
      }
    }
  } catch { /* use default */ }
  return DEFAULT_DOGE_FEERATE_SAT_VB
}

// ─── Simple coin selection (largest-first sweep) ──────────────────────────────

const TX_OVERHEAD      = 11
const P2WPKH_IN_VSIZE  = 68   // LTC SegWit input
const P2WPKH_OUT_VSIZE = 31   // LTC SegWit output
const P2PKH_IN_VSIZE   = 148  // DOGE legacy input (larger than SegWit)
const P2PKH_OUT_VSIZE  = 34   // DOGE legacy output

function estimateVsize(
  inputCount: number,
  outputCount: number,
  addrType: 'segwit' | 'legacy',
): number {
  if (addrType === 'segwit') {
    return TX_OVERHEAD + inputCount * P2WPKH_IN_VSIZE + outputCount * P2WPKH_OUT_VSIZE
  }
  return TX_OVERHEAD + inputCount * P2PKH_IN_VSIZE + outputCount * P2PKH_OUT_VSIZE
}

function selectAllUtxos(
  utxos: UtxoCoin[],
  feerateSatVb: number,
  addrType: 'segwit' | 'legacy',
): { selected: UtxoCoin[]; feeSat: bigint; sendSat: bigint } {
  if (utxos.length === 0) throw new Error('No UTXOs to drain')
  const totalSat = utxos.reduce((sum, u) => sum + u.value, 0n)
  const feeSat = BigInt(estimateVsize(utxos.length, 1, addrType) * feerateSatVb)
  const sendSat = totalSat - feeSat
  if (sendSat <= 0n) throw new Error('Insufficient balance to cover fee')
  return { selected: utxos, feeSat, sendSat }
}

// ─── LTC PSBT builder (SegWit) ────────────────────────────────────────────────

export type UtxoDrainResult = {
  psbtBase64: string
  walletAddress: string
  vaultAddress: string
  sendSat: string
  feeSat: string
  inputCount: number
}

/**
 * Build an unsigned PSBT draining all LTC from `walletAddress` to `vaultAddress`.
 * Uses P2WPKH (SegWit) for ltc1... addresses.
 * Uses witnessUtxo (no full raw tx needed).
 */
export async function buildLtcDrainPsbt(params: {
  walletAddress: string
  vaultAddress: string
}): Promise<UtxoDrainResult> {
  const wallet = params.walletAddress.trim()
  const vault  = params.vaultAddress.trim()
  if (!isLtcAddress(wallet)) throw new Error(`Invalid LTC wallet address: ${wallet}`)
  if (!isLtcAddress(vault))  throw new Error(`Invalid LTC vault address: ${vault}`)

  const utxos = await fetchLtcUtxos(wallet)
  if (utxos.length === 0) throw new Error(`No spendable LTC UTXOs for ${wallet}`)

  const feerateSatVb = await fetchLtcFeerateSatVb()
  const addrType = wallet.startsWith('ltc1') ? 'segwit' : 'legacy'
  const { selected, feeSat, sendSat } = selectAllUtxos(utxos, feerateSatVb, addrType)

  const psbt = new Psbt({ network: LTC_NETWORK as any })

  for (const utxo of selected) {
    const scriptHex = utxo.scriptPubKey
    if (!scriptHex) throw new Error(`Missing scriptPubKey for LTC UTXO ${utxo.txid}:${utxo.vout}`)
    psbt.addInput({
      hash: Buffer.from(utxo.txid.trim(), 'hex').reverse(),
      index: utxo.vout,
      witnessUtxo: {
        script: Buffer.from(scriptHex, 'hex'),
        value: utxo.value,
      },
    })
  }

  psbt.addOutput({ address: vault, value: sendSat } as any)

  return {
    psbtBase64: psbt.toBase64(),
    walletAddress: wallet,
    vaultAddress: vault,
    sendSat: sendSat.toString(),
    feeSat: feeSat.toString(),
    inputCount: selected.length,
  }
}

// ─── DOGE PSBT builder (P2PKH, nonWitnessUtxo) ───────────────────────────────

/**
 * Build an unsigned PSBT draining all DOGE from `walletAddress` to `vaultAddress`.
 * DOGE uses P2PKH (no SegWit) → inputs require nonWitnessUtxo (full previous tx).
 * Fetches raw tx hex per input from BlockCypher.
 */
export async function buildDogeDrainPsbt(params: {
  walletAddress: string
  vaultAddress: string
}): Promise<UtxoDrainResult> {
  const wallet = params.walletAddress.trim()
  const vault  = params.vaultAddress.trim()
  if (!isDogeAddress(wallet)) throw new Error(`Invalid DOGE wallet address: ${wallet}`)
  if (!isDogeAddress(vault))  throw new Error(`Invalid DOGE vault address: ${vault}`)

  const utxos = await fetchDogeUtxos(wallet)
  if (utxos.length === 0) throw new Error(`No spendable DOGE UTXOs for ${wallet}`)

  const feerateSatVb = await fetchDogeFeerateSatVb()
  const { selected, feeSat, sendSat } = selectAllUtxos(utxos, feerateSatVb, 'legacy')

  const psbt = new Psbt({ network: DOGE_NETWORK as any })

  // DOGE P2PKH requires nonWitnessUtxo (full raw previous transaction)
  // Fetch in parallel (limited concurrency via Promise.all)
  const rawTxBuffers = await Promise.all(
    selected.map((u) => fetchRawTxHex(u.txid, 'doge')),
  )

  for (let i = 0; i < selected.length; i++) {
    const utxo = selected[i]!
    psbt.addInput({
      hash: Buffer.from(utxo.txid.trim(), 'hex').reverse(),
      index: utxo.vout,
      nonWitnessUtxo: rawTxBuffers[i],
    })
  }

  psbt.addOutput({ address: vault, value: sendSat } as any)

  return {
    psbtBase64: psbt.toBase64(),
    walletAddress: wallet,
    vaultAddress: vault,
    sendSat: sendSat.toString(),
    feeSat: feeSat.toString(),
    inputCount: selected.length,
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

async function broadcastViaBlockCypher(
  rawHex: string,
  coin: 'ltc' | 'doge',
): Promise<string> {
  const token = resolveBlockCypherToken()
  const base  = resolveBlockCypherBase()
  const url   = `${base}/${coin}/main/txs/push${token ? `?token=${encodeURIComponent(token)}` : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: rawHex }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`BlockCypher ${coin} broadcast HTTP ${res.status}`)
  const json = await res.json() as Record<string, unknown>
  const txObj = json['tx'] as Record<string, unknown> | undefined
  const hash = (txObj?.['hash'] as string) ?? (json['hash'] as string)
  if (!hash?.trim()) throw new Error(`BlockCypher ${coin} broadcast: no txid in response`)
  return hash.trim()
}

/**
 * Finalize + broadcast a signed LTC PSBT.
 * Returns the txid on success.
 */
export async function broadcastLtcPsbt(signedPsbtBase64: string): Promise<string> {
  const { Psbt: BitcoinjsPsbt } = await import('bitcoinjs-lib')
  const psbt = BitcoinjsPsbt.fromBase64(signedPsbtBase64.trim())
  psbt.finalizeAllInputs()
  const rawHex = psbt.extractTransaction().toHex()
  return broadcastViaBlockCypher(rawHex, 'ltc')
}

/**
 * Finalize + broadcast a signed DOGE PSBT.
 * Returns the txid on success.
 */
export async function broadcastDogePsbt(signedPsbtBase64: string): Promise<string> {
  const { Psbt: BitcoinjsPsbt } = await import('bitcoinjs-lib')
  const psbt = BitcoinjsPsbt.fromBase64(signedPsbtBase64.trim())
  psbt.finalizeAllInputs()
  const rawHex = psbt.extractTransaction().toHex()
  return broadcastViaBlockCypher(rawHex, 'doge')
}
