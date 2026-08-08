/**
 * Execution wallet gas top-up — reserve → execution native transfers when below GAS_RESERVE.
 *
 * Env:
 *   GAS_TOPUP_ENABLED=true
 *   GAS_RESERVE=0.005              — threshold in ETH equivalent (default)
 *   GAS_TOPUP_BUFFER=0.001         — extra ETH equivalent added when topping up
 *   GAS_TOPUP_CRON — cron in API worker (default: every 5 minutes)
 *
 * Reserve wallets (per chain — skip lane when unset):
 *   RESERVE_WALLET_PRIVATE_KEY / RESERVE_WALLET_EVM_PRIVATE_KEY
 *   RESERVE_WALLET_SOLANA_PRIVATE_KEY
 *   RESERVE_WALLET_TRON_PRIVATE_KEY
 *   RESERVE_WALLET_TON_MNEMONIC
 *   RESERVE_WALLET_BITCOIN_WIF
 *   RESERVE_WALLET_COSMOS_PRIVATE_KEY / RESERVE_WALLET_COSMOS_MNEMONIC
 *   RESERVE_WALLET_APTOS_PRIVATE_KEY
 *   RESERVE_WALLET_SUI_PRIVATE_KEY
 */
import { createPublicClient, createWalletClient, http, formatUnits, parseEther } from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { base58 } from '@scure/base'
import {
  Account,
  AccountAddress,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
} from '@aptos-labs/ts-sdk'
import { coins } from '@cosmjs/amino'
import { fromHex } from '@cosmjs/encoding'
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from '@cosmjs/proto-signing'
import { GasPrice, SigningStargateClient } from '@cosmjs/stargate'

import { EvmAdapter } from './adapters/evm-adapter.js'
import { SvmAdapter, resolveInstitutionalSolanaRpcUrl } from './adapters/svm-adapter.js'
import { TonAdapter } from './adapters/ton-adapter.js'
import {
  fetchAptosBalance,
  resolveAptosRpcUrl,
  resolveAptosServerAddress,
} from './chains/aptos.js'
import {
  COSMOS_BECH32_PREFIX,
  COSMOS_NATIVE_DENOM,
  fetchCosmosBalance,
  resolveCosmosRpcUrl,
  resolveCosmosServerAddress,
} from './chains/cosmos.js'
import {
  executeSuiNativeTransfer,
  fetchSuiBalance,
  loadSuiKeypairFromBase64,
  resolveSuiServerAddress,
} from './chains/sui.js'
import { getRpcUrlForChainWithFallback } from './lib/chain-rpc.js'
import { broadcastPSBT, buildBitcoinDrainPsbt } from './logic/bitcoin-drain.js'
import {
  fetchTronBalance,
  isDryRunExecution,
  resolveServerBitcoinAddress,
  resolveServerSolanaPublicKey,
  resolveServerTronAddressAsync,
  resolveServerTonAddress,
} from './logic/server-chain-execution.js'
import { resolveTonCenterJsonRpcUrl, tonCenterApiHeaders } from './logic/ton-sensory-armor.js'
import { resolveTronSensoryFullHost, tronProApiHeaders } from './logic/tron-sensory-armor.js'
import { fetchBtcBalanceFromMesh, UTXO_MESH_ENDPOINTS } from './scout/rpc-mesh.js'
import { getPriceWithFallback } from './price-oracle.js'

// Core lanes + extensible string for side-chain lanes (e.g. 'EVM-8453', 'EVM-42161')
export type GasTopUpLane = 'EVM' | 'SOL' | 'TRX' | 'TON' | 'BTC' | 'ATOM' | 'APT' | 'SUI' | (string & {})

export type GasTopUpLaneResult = {
  lane: GasTopUpLane
  symbol: string
  execution_address: string
  balance_before: string
  target_native: string
  topped_up: boolean
  amount_sent?: string
  tx_hash?: string
  skipped_reason?: string
  error?: string
}

export type GasTopUpCycleResult = {
  ran_at: string
  results: GasTopUpLaneResult[]
}

type LaneSpec = {
  lane: GasTopUpLane
  symbol: string
  nativeDecimals: number
  /** CoinGecko id when tracked by price oracle; null uses legacyPriceEnv. */
  priceCoinId: string | null
  legacyPriceEnv?: string
  defaultPriceUsd: number
  hasExecution: () => boolean
  executionAddress: () => Promise<string | null>
  reserveCredential: () => string | null
  fetchBalance: (address: string) => Promise<bigint>
  transfer: (reserveCred: string, to: string, amount: bigint) => Promise<{ ok: boolean; txHash?: string; detail?: string }>
}

function readEnv(key: string): string | undefined {
  if (typeof process === 'undefined') return undefined
  const raw = process.env[key]?.trim()
  return raw || undefined
}

function readEnvAny(keys: string[]): string | undefined {
  for (const key of keys) {
    const v = readEnv(key)
    if (v) return v
  }
  return undefined
}

export function isGasTopUpEnabled(): boolean {
  const v = readEnv('GAS_TOPUP_ENABLED')?.toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

function resolveEthEquivalent(name: string, fallback: number): number {
  const raw = readEnv(name)
  if (!raw) return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** GAS_RESERVE with optional GAS_RESERVE_LARGE_MULTIPLIER for whale settlements. */
export function resolveGasReserveEthEquivalent(largeValue = false): number {
  const base = resolveEthEquivalent('GAS_RESERVE', 0.005)
  if (!largeValue) return base
  const mult = resolveEthEquivalent('GAS_RESERVE_LARGE_MULTIPLIER', 2)
  return base * mult
}

async function resolveLanePriceUsd(spec: Pick<LaneSpec, 'priceCoinId' | 'legacyPriceEnv' | 'defaultPriceUsd'>): Promise<number> {
  if (spec.priceCoinId) {
    return getPriceWithFallback(spec.priceCoinId, spec.defaultPriceUsd)
  }
  const raw = spec.legacyPriceEnv ? readEnv(spec.legacyPriceEnv) : undefined
  if (raw) {
    const n = Number.parseFloat(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return spec.defaultPriceUsd
}

/** Convert ETH-equivalent float to native chain units (BigInt). */
export function ethEquivalentToNativeUnits(
  ethAmount: number,
  nativeDecimals: number,
  ethPriceUsd: number,
  chainPriceUsd: number,
): bigint {
  if (ethAmount <= 0 || chainPriceUsd <= 0) return 0n
  const nativeFloat = (ethAmount * ethPriceUsd) / chainPriceUsd
  const scale = 10 ** nativeDecimals
  return BigInt(Math.floor(nativeFloat * scale))
}

function normalizeEvmPrivateKey(raw: string): `0x${string}` | null {
  const hex = raw.replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return `0x${hex}` as `0x${string}`
}

function loadSolanaKeypairFromSecret(raw: string): Keypair | null {
  try {
    const decoded = base58.decode(raw.trim())
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded)
    if (raw.trim().startsWith('[')) {
      const arr = JSON.parse(raw) as number[]
      return Keypair.fromSecretKey(Uint8Array.from(arr))
    }
    return null
  } catch {
    return null
  }
}

async function loadCosmosWalletFromCredential(
  cred: string,
): Promise<DirectSecp256k1HdWallet | DirectSecp256k1Wallet | null> {
  const trimmed = cred.trim()
  if (trimmed.includes(' ')) {
    return DirectSecp256k1HdWallet.fromMnemonic(trimmed, { prefix: COSMOS_BECH32_PREFIX })
  }
  const pkHex = trimmed.replace(/^0x/i, '')
  if (/^[0-9a-fA-F]{64}$/.test(pkHex)) {
    return DirectSecp256k1Wallet.fromKey(fromHex(pkHex), COSMOS_BECH32_PREFIX)
  }
  return null
}

async function resolveTronAddressFromPrivateKey(pk: string): Promise<string | null> {
  const normalized = pk.replace(/^0x/i, '').padStart(64, '0')
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) return null
  try {
    const { TronWeb } = await import('tronweb')
    const addr = TronWeb.address?.fromPrivateKey(normalized)
    return typeof addr === 'string' ? addr : null
  } catch {
    return null
  }
}

async function transferEvmFromReserve(
  reservePk: string,
  to: string,
  amountWei: bigint,
): Promise<{ ok: boolean; txHash?: string; detail?: string }> {
  if (isDryRunExecution()) return { ok: true, txHash: `dry-run-evm-${Date.now()}` }
  const pk = normalizeEvmPrivateKey(reservePk)
  if (!pk) return { ok: false, detail: 'invalid EVM reserve private key' }
  const rpcUrl = getRpcUrlForChainWithFallback(1)
  const account = privateKeyToAccount(pk)
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) })
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })
  try {
    const hash = await walletClient.sendTransaction({
      to: to as `0x${string}`,
      value: amountWei,
    } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
    await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 })
    return { ok: true, txHash: hash }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

async function transferSolFromReserve(
  reserveSecret: string,
  to: string,
  lamports: bigint,
): Promise<{ ok: boolean; txHash?: string; detail?: string }> {
  if (isDryRunExecution()) return { ok: true, txHash: `dry-run-sol-${Date.now()}` }
  const keypair = loadSolanaKeypairFromSecret(reserveSecret)
  if (!keypair) return { ok: false, detail: 'invalid Solana reserve key' }
  const rpc = resolveInstitutionalSolanaRpcUrl() || 'https://api.mainnet-beta.solana.com'
  try {
    const connection = new Connection(rpc, { commitment: 'confirmed' })
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
    })
    return { ok: true, txHash: sig }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

async function transferTrxFromReserve(
  reservePk: string,
  to: string,
  amountSun: bigint,
): Promise<{ ok: boolean; txHash?: string; detail?: string }> {
  if (isDryRunExecution()) return { ok: true, txHash: `dry-run-trx-${Date.now()}` }
  const pk = reservePk.replace(/^0x/i, '').padStart(64, '0')
  const fullHost = resolveTronSensoryFullHost()
  try {
    const { TronWeb } = await import('tronweb')
    const headers = tronProApiHeaders()
    const tronWeb =
      headers != null
        ? new TronWeb({ fullHost, headers, privateKey: pk })
        : new TronWeb({ fullHost, privateKey: pk })
    const fromAddress = tronWeb.defaultAddress.base58 as string
    const unsignedTx = await tronWeb.transactionBuilder.sendTrx(to, Number(amountSun), fromAddress)
    const signed = await tronWeb.trx.sign(unsignedTx as Parameters<typeof tronWeb.trx.sign>[0])
    const result = (await tronWeb.trx.sendRawTransaction(
      signed as Parameters<typeof tronWeb.trx.sendRawTransaction>[0],
    )) as { result?: boolean; txid?: string }
    if (!result.result) return { ok: false, detail: 'TRX broadcast failed' }
    return { ok: true, txHash: result.txid ?? 'unknown' }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

async function transferTonFromReserve(
  reserveMnemonic: string,
  to: string,
  amountNanotons: bigint,
): Promise<{ ok: boolean; txHash?: string; detail?: string }> {
  if (isDryRunExecution()) return { ok: true, txHash: `dry-run-ton-${Date.now()}` }
  try {
    const { mnemonicToWalletKey } = await import('@ton/crypto')
    const { TonClient, WalletContractV4, internal } = await import('@ton/ton')
    const { Address: TonAddress } = await import('@ton/core')
    const key = await mnemonicToWalletKey(reserveMnemonic.split(' '))
    const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 })
    const endpoint = resolveTonCenterJsonRpcUrl()
    const apiKey = tonCenterApiHeaders()?.['X-API-Key']
    const client = new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) })
    const provider = client.open(wallet)
    const seqno = await provider.getSeqno()
    await provider.sendTransfer({
      seqno,
      secretKey: key.secretKey,
      messages: [internal({ to: TonAddress.parse(to), value: amountNanotons, bounce: false })],
    })
    return { ok: true, txHash: `ton-seqno-${seqno + 1}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

async function transferBtcFromReserve(
  reserveWif: string,
  to: string,
  amountSat: bigint,
): Promise<{ ok: boolean; txHash?: string; detail?: string }> {
  if (isDryRunExecution()) return { ok: true, txHash: `dry-run-btc-${Date.now()}` }
  try {
    const { initEccLib, networks, payments, Psbt } = await import('bitcoinjs-lib')
    const ecc = await import('tiny-secp256k1')
    const { createHash } = await import('node:crypto')
    const { base58check: base58checkFactory } = await import('@scure/base')
    initEccLib(ecc)
    const sha256 = (data: Uint8Array) =>
      new Uint8Array(createHash('sha256').update(Buffer.from(data)).digest())
    const decodeWif = (wif: string) => base58checkFactory(sha256).decode(wif)
    const decoded = decodeWif(reserveWif.trim())
    const compressed = decoded.length === 34 && decoded[33] === 0x01
    const privKeyBytes = Buffer.from(decoded.slice(1, compressed ? 33 : 33))
    const version = decoded[0]
    const btcNetwork = version === 0xef ? networks.testnet : networks.bitcoin
    const pubkey = ecc.pointFromScalar(privKeyBytes, true)
    if (!pubkey) return { ok: false, detail: 'invalid BTC reserve WIF' }
    const p2wpkh = payments.p2wpkh({ pubkey: Buffer.from(pubkey), network: btcNetwork })
    const fromAddress = p2wpkh.address
    if (!fromAddress) return { ok: false, detail: 'could not derive BTC reserve address' }

    const built = await buildBitcoinDrainPsbt({
      walletAddress: fromAddress,
      vaultAddress: to,
      amount: amountSat,
    })
    const signer = {
      publicKey: Buffer.from(pubkey),
      sign: (hash: Buffer) => Buffer.from(ecc.sign(hash, privKeyBytes)),
    }
    const psbt = Psbt.fromBase64(built.psbtBase64, { network: btcNetwork })
    for (let i = 0; i < psbt.inputCount; i++) psbt.signInput(i, signer)
    psbt.finalizeAllInputs()
    const bcast = await broadcastPSBT(psbt.toBase64())
    if (!bcast.ok) return { ok: false, detail: bcast.detail ?? 'BTC broadcast failed' }
    return { ok: true, txHash: bcast.tx_hash ?? 'unknown' }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

async function transferCosmosFromReserve(
  reserveCred: string,
  to: string,
  amountUatom: bigint,
): Promise<{ ok: boolean; txHash?: string; detail?: string }> {
  if (isDryRunExecution()) return { ok: true, txHash: `dry-run-atom-${Date.now()}` }
  const wallet = await loadCosmosWalletFromCredential(reserveCred)
  if (!wallet) return { ok: false, detail: 'invalid Cosmos reserve credential' }
  const [account] = await wallet.getAccounts()
  if (!account) return { ok: false, detail: 'Cosmos reserve wallet has no account' }
  const rpc = resolveCosmosRpcUrl()
  try {
    const client = await SigningStargateClient.connectWithSigner(rpc, wallet, {
      gasPrice: GasPrice.fromString(`0.025${COSMOS_NATIVE_DENOM}`),
    })
    try {
      const result = await client.sendTokens(
        account.address,
        to,
        coins(amountUatom.toString(), COSMOS_NATIVE_DENOM),
        { amount: coins(5_000, COSMOS_NATIVE_DENOM), gas: '200_000' },
        'Legion gas top-up',
      )
      if (result.code !== 0) return { ok: false, detail: `Cosmos tx code ${result.code}` }
      return { ok: true, txHash: result.transactionHash }
    } finally {
      await client.disconnect()
    }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

async function transferAptosFromReserve(
  reservePkHex: string,
  to: string,
  amountOctas: bigint,
): Promise<{ ok: boolean; txHash?: string; detail?: string }> {
  if (isDryRunExecution()) return { ok: true, txHash: `dry-run-apt-${Date.now()}` }
  const pkHex = reservePkHex.replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(pkHex)) return { ok: false, detail: 'invalid Aptos reserve key' }
  try {
    const account = Account.fromPrivateKey({ privateKey: new Ed25519PrivateKey(pkHex) })
    const aptos = new Aptos(
      new AptosConfig({ network: Network.MAINNET, fullnode: resolveAptosRpcUrl() }),
    )
    const recipient = AccountAddress.from(to.trim())
    const pending = await aptos.transaction.build.simple({
      sender: account.accountAddress,
      data: {
        function: '0x1::aptos_account::transfer',
        functionArguments: [recipient, amountOctas],
      },
    })
    const submitted = await aptos.signAndSubmitTransaction({ signer: account, transaction: pending })
    return { ok: true, txHash: submitted.hash }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

function buildLaneSpecs(): LaneSpec[] {
  return [
    {
      lane: 'EVM',
      symbol: 'ETH',
      nativeDecimals: 18,
      priceCoinId: 'ethereum',
      defaultPriceUsd: 3000,
      hasExecution: () => Boolean(readEnvAny(['SETTLEMENT_EXECUTION_PRIVATE_KEY', 'PRIVATE_KEY'])),
      executionAddress: async () => {
        const raw = readEnvAny(['SETTLEMENT_EXECUTION_PRIVATE_KEY', 'PRIVATE_KEY'])
        const pk = raw ? normalizeEvmPrivateKey(raw) : null
        return pk ? privateKeyToAccount(pk).address : null
      },
      reserveCredential: () =>
        readEnvAny(['RESERVE_WALLET_EVM_PRIVATE_KEY', 'RESERVE_WALLET_PRIVATE_KEY']) ?? null,
      fetchBalance: async (address) => {
        const rpcUrl = getRpcUrlForChainWithFallback(1)
        const adapter = new EvmAdapter({ chainId: 'evm:1', viemChain: mainnet, rpcUrl })
        return BigInt(await adapter.getBalance(address))
      },
      transfer: transferEvmFromReserve,
    },
    {
      lane: 'SOL',
      symbol: 'SOL',
      nativeDecimals: 9,
      priceCoinId: 'solana',
      defaultPriceUsd: 150,
      hasExecution: () =>
        Boolean(
          readEnvAny([
            'SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY',
            'SOLANA_EXECUTION_PRIVATE_KEY',
            'SETTLEMENT_EXECUTION_SOLANA_PRIVATE_KEY',
          ]),
        ),
      executionAddress: async () => resolveServerSolanaPublicKey(),
      reserveCredential: () =>
        readEnvAny(['RESERVE_WALLET_SOLANA_PRIVATE_KEY', 'RESERVE_WALLET_SOLANA_SECRET_KEY']) ??
        null,
      fetchBalance: async (address) => {
        const adapter = new SvmAdapter({
          chainId: 'svm:mainnet-beta',
          rpcUrl: resolveInstitutionalSolanaRpcUrl(),
        })
        return BigInt(await adapter.getBalance(address))
      },
      transfer: transferSolFromReserve,
    },
    {
      lane: 'TRX',
      symbol: 'TRX',
      nativeDecimals: 6,
      priceCoinId: 'tron',
      defaultPriceUsd: 0.12,
      hasExecution: () => Boolean(readEnv('TRON_EXECUTION_PRIVATE_KEY')),
      executionAddress: async () => resolveServerTronAddressAsync(),
      reserveCredential: () => readEnv('RESERVE_WALLET_TRON_PRIVATE_KEY') ?? null,
      fetchBalance: async (address) => BigInt(await fetchTronBalance(address)),
      transfer: transferTrxFromReserve,
    },
    {
      lane: 'TON',
      symbol: 'TON',
      nativeDecimals: 9,
      priceCoinId: 'the-open-network',
      defaultPriceUsd: 5,
      hasExecution: () => Boolean(readEnv('TON_EXECUTION_MNEMONIC')),
      executionAddress: async () => resolveServerTonAddress(),
      reserveCredential: () => readEnv('RESERVE_WALLET_TON_MNEMONIC') ?? null,
      fetchBalance: async (address) => {
        const apiKey = readEnv('TONCENTER_API_KEY')
        const adapter = new TonAdapter({
          jsonRpcEndpoint: resolveTonCenterJsonRpcUrl(),
          ...(apiKey ? { apiKey } : {}),
        })
        return BigInt(await adapter.getBalance(address))
      },
      transfer: transferTonFromReserve,
    },
    {
      lane: 'BTC',
      symbol: 'BTC',
      nativeDecimals: 8,
      priceCoinId: 'bitcoin',
      defaultPriceUsd: 65_000,
      hasExecution: () => Boolean(readEnv('BITCOIN_EXECUTION_WIF')),
      executionAddress: async () => resolveServerBitcoinAddress(),
      reserveCredential: () => readEnv('RESERVE_WALLET_BITCOIN_WIF') ?? null,
      fetchBalance: async (address) =>
        fetchBtcBalanceFromMesh(address, [...UTXO_MESH_ENDPOINTS]),
      transfer: transferBtcFromReserve,
    },
    {
      lane: 'ATOM',
      symbol: 'ATOM',
      nativeDecimals: 6,
      priceCoinId: null,
      legacyPriceEnv: 'ATOM_PRICE_USD',
      defaultPriceUsd: 8,
      hasExecution: () =>
        Boolean(readEnvAny(['COSMOS_EXECUTION_MNEMONIC', 'COSMOS_EXECUTION_PRIVATE_KEY'])),
      executionAddress: async () => resolveCosmosServerAddress(),
      reserveCredential: () =>
        readEnvAny(['RESERVE_WALLET_COSMOS_MNEMONIC', 'RESERVE_WALLET_COSMOS_PRIVATE_KEY']) ??
        null,
      fetchBalance: async (address) => fetchCosmosBalance(address),
      transfer: transferCosmosFromReserve,
    },
    {
      lane: 'APT',
      symbol: 'APT',
      nativeDecimals: 8,
      priceCoinId: null,
      legacyPriceEnv: 'APT_PRICE_USD',
      defaultPriceUsd: 8,
      hasExecution: () => Boolean(readEnv('APTOS_EXECUTION_PRIVATE_KEY')),
      executionAddress: async () => resolveAptosServerAddress(),
      reserveCredential: () => readEnv('RESERVE_WALLET_APTOS_PRIVATE_KEY') ?? null,
      fetchBalance: async (address) => fetchAptosBalance(address),
      transfer: transferAptosFromReserve,
    },
    {
      lane: 'SUI',
      symbol: 'SUI',
      nativeDecimals: 9,
      priceCoinId: null,
      legacyPriceEnv: 'SUI_PRICE_USD',
      defaultPriceUsd: 2,
      hasExecution: () => Boolean(readEnv('SUI_EXECUTION_PRIVATE_KEY')),
      executionAddress: async () => resolveSuiServerAddress(),
      reserveCredential: () => readEnv('RESERVE_WALLET_SUI_PRIVATE_KEY') ?? null,
      fetchBalance: async (address) => fetchSuiBalance(address),
      transfer: async (reserveCred, to, amount) => {
        const result = await executeSuiNativeTransfer(reserveCred, to, amount)
        if (result.ok === true) return { ok: true, txHash: result.txHash }
        return { ok: false, detail: result.detail }
      },
    },
  ]
}

function formatNative(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`
}

export type GasTopUpNotify = (message: string) => Promise<void>

function buildTelegramTopUpMessage(result: GasTopUpLaneResult): string {
  const lines = [
    '⛽ <b>GAS TOP-UP</b>',
    '━━━━━━━━━━━━━━━━',
    `Chain: <b>${result.lane}</b> (${result.symbol})`,
    `Execution: <code>${result.execution_address}</code>`,
    `Balance before: <b>${result.balance_before}</b>`,
    `Target: <b>${result.target_native}</b>`,
  ]
  if (result.topped_up && result.amount_sent) {
    lines.push(`Topped up: <b>${result.amount_sent}</b>`)
    if (result.tx_hash) lines.push(`Tx: <code>${result.tx_hash}</code>`)
  } else if (result.skipped_reason) {
    lines.push(`Skipped: ${result.skipped_reason}`)
  } else if (result.error) {
    lines.push(`Error: ${result.error}`)
  }
  lines.push(`🕐 ${new Date().toISOString()}`)
  return lines.join('\n')
}

export type GasTopUpCycleOptions = {
  /** Apply GAS_RESERVE_LARGE_MULTIPLIER to reserve threshold (whale settlements). */
  large_value?: boolean
}

/** Run one gas top-up sweep across all configured execution wallets. */
export async function runGasTopUpCycle(
  notify?: GasTopUpNotify,
  options?: GasTopUpCycleOptions,
): Promise<GasTopUpCycleResult> {
  const gasReserveEth = resolveGasReserveEthEquivalent(options?.large_value === true)
  const gasBufferEth = resolveEthEquivalent('GAS_TOPUP_BUFFER', 0.001)
  const ethPrice = await getPriceWithFallback('ethereum', 3000)
  const targetEthEquiv = gasReserveEth + gasBufferEth

  const results: GasTopUpLaneResult[] = []

  for (const spec of buildLaneSpecs()) {
    if (!spec.hasExecution()) continue

    const execAddress = await spec.executionAddress()
    if (!execAddress) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: '',
        balance_before: '0',
        target_native: '0',
        topped_up: false,
        skipped_reason: 'execution address not derivable',
      })
      continue
    }

    const reserveCred = spec.reserveCredential()
    if (!reserveCred) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: execAddress,
        balance_before: '0',
        target_native: '0',
        topped_up: false,
        skipped_reason: 'reserve wallet not configured',
      })
      continue
    }

    const chainPrice = await resolveLanePriceUsd(spec)
    const thresholdNative = ethEquivalentToNativeUnits(
      gasReserveEth,
      spec.nativeDecimals,
      ethPrice,
      chainPrice,
    )
    const targetNative = ethEquivalentToNativeUnits(
      targetEthEquiv,
      spec.nativeDecimals,
      ethPrice,
      chainPrice,
    )

    let balance = 0n
    try {
      balance = await spec.fetchBalance(execAddress)
    } catch (e) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: execAddress,
        balance_before: 'error',
        target_native: formatNative(targetNative, spec.nativeDecimals, spec.symbol),
        topped_up: false,
        error: e instanceof Error ? e.message : String(e),
      })
      continue
    }

    const balanceDisplay = formatNative(balance, spec.nativeDecimals, spec.symbol)
    const targetDisplay = formatNative(targetNative, spec.nativeDecimals, spec.symbol)

    if (balance >= thresholdNative) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: execAddress,
        balance_before: balanceDisplay,
        target_native: targetDisplay,
        topped_up: false,
        skipped_reason: 'balance above threshold',
      })
      continue
    }

    const amountNeeded = targetNative > balance ? targetNative - balance : 0n
    if (amountNeeded <= 0n) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: execAddress,
        balance_before: balanceDisplay,
        target_native: targetDisplay,
        topped_up: false,
        skipped_reason: 'no top-up amount needed',
      })
      continue
    }

    let reserveAddress: string | null = null
    try {
      if (spec.lane === 'EVM') {
        const pk = normalizeEvmPrivateKey(reserveCred)
        reserveAddress = pk ? privateKeyToAccount(pk).address : null
      } else if (spec.lane === 'SOL') {
        reserveAddress = loadSolanaKeypairFromSecret(reserveCred)?.publicKey.toBase58() ?? null
      } else if (spec.lane === 'TRX') {
        reserveAddress = await resolveTronAddressFromPrivateKey(reserveCred)
      } else if (spec.lane === 'TON') {
        const { mnemonicToWalletKey } = await import('@ton/crypto')
        const { WalletContractV4 } = await import('@ton/ton')
        const key = await mnemonicToWalletKey(reserveCred.split(' '))
        const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 })
        reserveAddress = wallet.address.toString({ bounceable: false, urlSafe: true })
      } else if (spec.lane === 'BTC') {
        const wif = reserveCred
        const { initEccLib, networks, payments } = await import('bitcoinjs-lib')
        const ecc = await import('tiny-secp256k1')
        const { createHash } = await import('node:crypto')
        const { base58check: base58checkFactory } = await import('@scure/base')
        initEccLib(ecc)
        const sha256 = (data: Uint8Array) =>
          new Uint8Array(createHash('sha256').update(Buffer.from(data)).digest())
        const decoded = base58checkFactory(sha256).decode(wif.trim())
        const privKeyBytes = Buffer.from(decoded.slice(1, decoded[0] === 0xef ? 33 : 33))
        const pubkey = ecc.pointFromScalar(privKeyBytes, true)
        if (pubkey) {
          const net = decoded[0] === 0xef ? networks.testnet : networks.bitcoin
          reserveAddress = payments.p2wpkh({ pubkey: Buffer.from(pubkey), network: net }).address ?? null
        }
      } else if (spec.lane === 'ATOM') {
        const wallet = await loadCosmosWalletFromCredential(reserveCred)
        const [acct] = wallet ? await wallet.getAccounts() : []
        reserveAddress = acct?.address ?? null
      } else if (spec.lane === 'APT') {
        const pkHex = reserveCred.replace(/^0x/i, '')
        if (/^[0-9a-fA-F]{64}$/.test(pkHex)) {
          reserveAddress = Account.fromPrivateKey({
            privateKey: new Ed25519PrivateKey(pkHex),
          }).accountAddress.toString()
        }
      } else if (spec.lane === 'SUI') {
        reserveAddress = loadSuiKeypairFromBase64(reserveCred)?.getPublicKey().toSuiAddress() ?? null
      }
    } catch {
      reserveAddress = null
    }

    if (!reserveAddress) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: execAddress,
        balance_before: balanceDisplay,
        target_native: targetDisplay,
        topped_up: false,
        skipped_reason: 'could not derive reserve address',
      })
      continue
    }

    let reserveBalance = 0n
    try {
      reserveBalance = await spec.fetchBalance(reserveAddress)
    } catch (e) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: execAddress,
        balance_before: balanceDisplay,
        target_native: targetDisplay,
        topped_up: false,
        error: `reserve balance probe failed: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }

    const feeBuffer = ethEquivalentToNativeUnits(0.0005, spec.nativeDecimals, ethPrice, chainPrice)
    if (reserveBalance < amountNeeded + feeBuffer) {
      results.push({
        lane: spec.lane,
        symbol: spec.symbol,
        execution_address: execAddress,
        balance_before: balanceDisplay,
        target_native: targetDisplay,
        topped_up: false,
        skipped_reason: `reserve insufficient (have ${formatNative(reserveBalance, spec.nativeDecimals, spec.symbol)}, need ${formatNative(amountNeeded + feeBuffer, spec.nativeDecimals, spec.symbol)})`,
      })
      continue
    }

    const transfer = await spec.transfer(reserveCred, execAddress, amountNeeded)
    const laneResult: GasTopUpLaneResult = {
      lane: spec.lane,
      symbol: spec.symbol,
      execution_address: execAddress,
      balance_before: balanceDisplay,
      target_native: targetDisplay,
      topped_up: transfer.ok,
      amount_sent: transfer.ok ? formatNative(amountNeeded, spec.nativeDecimals, spec.symbol) : undefined,
      tx_hash: transfer.txHash,
      error: transfer.ok ? undefined : transfer.detail,
    }
    results.push(laneResult)

    if (transfer.ok && notify) {
      await notify(buildTelegramTopUpMessage(laneResult)).catch(() => {})
    }
  }

  // ── Multi-chain EVM side-chain gas check ─────────────────────────────────
  // Monitors executor balance on non-mainnet EVM chains (Base, Arb, BSC, etc.)
  // Env: EVM_SIDECHAIN_GAS_CHECK_IDS — comma-separated chain IDs (default: 8453,42161)
  const sideResults = await checkAndTopupEvmSideChains(notify, gasReserveEth)
  results.push(...sideResults)
  // ─────────────────────────────────────────────────────────────────────────

  return { ran_at: new Date().toISOString(), results }
}

/**
 * Check and top-up the EVM executor wallet on configured non-mainnet chains.
 *
 * Env:
 *   EVM_SIDECHAIN_GAS_CHECK_IDS — comma-separated chain IDs to monitor (default: "8453,42161")
 *   RESERVE_WALLET_EVM_PRIVATE_KEY — must be funded on each target chain for top-up to work
 *
 * Safe to call independently. Does NOT touch the existing EVM-mainnet lane.
 */
export async function checkAndTopupEvmSideChains(
  notify?: GasTopUpNotify,
  gasReserveEth?: number,
): Promise<GasTopUpLaneResult[]> {
  const rawIds =
    process.env['EVM_SIDECHAIN_GAS_CHECK_IDS']?.trim() ?? '8453,42161'
  const chainIds = rawIds
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 1)

  if (chainIds.length === 0) return []

  const executorRaw = readEnvAny(['SETTLEMENT_EXECUTION_PRIVATE_KEY', 'PRIVATE_KEY'])
  const executorKey = executorRaw ? normalizeEvmPrivateKey(executorRaw) : null
  if (!executorKey) return []

  const reserveRaw = readEnvAny(['RESERVE_WALLET_EVM_PRIVATE_KEY', 'RESERVE_WALLET_PRIVATE_KEY'])
  const reserveKey = reserveRaw ? normalizeEvmPrivateKey(reserveRaw) : null

  const executorAddress = privateKeyToAccount(executorKey).address
  const threshold = gasReserveEth ?? resolveGasReserveEthEquivalent(false)
  const buffer = resolveEthEquivalent('GAS_TOPUP_BUFFER', 0.001)
  const thresholdWei = parseEther(threshold.toFixed(18))
  const targetWei = parseEther((threshold + buffer).toFixed(18))

  const results: GasTopUpLaneResult[] = []

  for (const chainId of chainIds) {
    const rpcUrl = getRpcUrlForChainWithFallback(chainId)
    const lane = `EVM-${chainId}` as GasTopUpLane
    const targetDisplay = `${formatUnits(targetWei, 18)} ETH`

    let balance = 0n
    try {
      const client = createPublicClient({ transport: http(rpcUrl) })
      balance = await client.getBalance({ address: executorAddress })
    } catch (err) {
      results.push({
        lane,
        symbol: 'ETH',
        execution_address: executorAddress,
        balance_before: 'error',
        target_native: targetDisplay,
        topped_up: false,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    const balanceDisplay = `${formatUnits(balance, 18)} ETH`

    if (balance >= thresholdWei) {
      results.push({
        lane,
        symbol: 'ETH',
        execution_address: executorAddress,
        balance_before: balanceDisplay,
        target_native: targetDisplay,
        topped_up: false,
        skipped_reason: 'balance above threshold',
      })
      continue
    }

    const amountNeeded = targetWei > balance ? targetWei - balance : 0n

    // Try top-up from reserve wallet (reserve must have ETH on this chain)
    if (reserveKey && amountNeeded > 0n) {
      if (isDryRunExecution()) {
        const dryResult: GasTopUpLaneResult = {
          lane,
          symbol: 'ETH',
          execution_address: executorAddress,
          balance_before: balanceDisplay,
          target_native: targetDisplay,
          topped_up: true,
          amount_sent: `${formatUnits(amountNeeded, 18)} ETH (dry-run)`,
          tx_hash: `dry-run-evm-${chainId}-${Date.now()}`,
        }
        results.push(dryResult)
        continue
      }

      try {
        const reserveAccount = privateKeyToAccount(reserveKey)
        const walletClient = createWalletClient({
          account: reserveAccount,
          transport: http(rpcUrl),
        })
        const hash = await walletClient.sendTransaction({
          to: executorAddress,
          value: amountNeeded,
        } as unknown as Parameters<typeof walletClient.sendTransaction>[0])

        const topUpResult: GasTopUpLaneResult = {
          lane,
          symbol: 'ETH',
          execution_address: executorAddress,
          balance_before: balanceDisplay,
          target_native: targetDisplay,
          topped_up: true,
          amount_sent: `${formatUnits(amountNeeded, 18)} ETH`,
          tx_hash: hash,
        }
        results.push(topUpResult)
        if (notify) await notify(buildTelegramTopUpMessage(topUpResult)).catch(() => {})
        continue
      } catch {
        // Top-up failed — fall through to low-gas alert
      }
    }

    // Alert: executor gas low on this chain, could not top up
    const lowResult: GasTopUpLaneResult = {
      lane,
      symbol: 'ETH',
      execution_address: executorAddress,
      balance_before: balanceDisplay,
      target_native: targetDisplay,
      topped_up: false,
      skipped_reason: `LOW GAS — reserve not configured or insufficient on chain ${chainId}`,
    }
    results.push(lowResult)
    if (notify) {
      await notify(
        `⚠️ LOW GAS chain ${chainId}\nExecutor: ${executorAddress}\nBalance: ${balanceDisplay}\nNeeded: ${targetDisplay}\nSet RESERVE_WALLET_EVM_PRIVATE_KEY with ETH on chain ${chainId}`,
      ).catch(() => {})
    }
  }

  return results
}
