/**
 * Vault native gas balance monitor — runs on a 6-hour cron, warns via Telegram when low.
 */
import cron from 'node-cron'

import { fetchVaultGasBalances, type VaultGasBalanceRow } from '@legion/core'
import { isTelegramConfigured, sendTelegramMessage } from '../lib/telegram.js'
// Deployer gas warning disabled — contract already deployed, no longer needed
// import { runDeployerGasWarningCheck } from './deployer-gas-warning.js'

const DEFAULT_CRON = '0 */6 * * *'
const DEFAULT_MIN_NATIVE = 0.01

function resolveMinNativeThreshold(): number {
  const raw = process.env['GAS_VAULT_MIN_NATIVE']?.trim()
  if (!raw) return DEFAULT_MIN_NATIVE
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_NATIVE
}

function isGasVaultCronDisabled(): boolean {
  const raw = process.env['GAS_VAULT_CRON_DISABLED']?.trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes'
}

function resolveCronExpression(): string {
  const raw = process.env['GAS_VAULT_CRON']?.trim()
  return raw && cron.validate(raw) ? raw : DEFAULT_CRON
}

function truncateAddress(addr: string): string {
  const a = addr.trim()
  if (a.length <= 16) return a
  return `${a.slice(0, 8)}…${a.slice(-6)}`
}

function isBelowThreshold(row: VaultGasBalanceRow, threshold: number): boolean {
  if (row.error) return false
  return row.native_amount < threshold
}

function buildWarningMessage(
  low: VaultGasBalanceRow[],
  threshold: number,
  all: VaultGasBalanceRow[],
): string {
  const lines = [
    '⚠️ <b>VAULT GAS LOW</b>',
    '━━━━━━━━━━━━━━━━',
    `Threshold: <b>${threshold}</b> native units per chain`,
    '',
    ...low.map(
      (r) =>
        `⛽ <b>${r.chain}</b> <code>${truncateAddress(r.address)}</code>\n` +
        `   Balance: <b>${r.native_display}</b>${r.error ? ` (probe error: ${r.error})` : ''}`,
    ),
    '',
    '<b>All vault probes:</b>',
    ...all.map((r) => {
      const flag = isBelowThreshold(r, threshold) ? '🔴' : '🟢'
      return `${flag} ${r.chain}: ${r.native_display}${r.error ? ` — ${r.error}` : ''}`
    }),
    '',
    `🕐 ${new Date().toISOString()}`,
  ]
  return lines.join('\n')
}

/** Run one gas balance sweep and send Telegram warnings for vaults below threshold. */
export async function runVaultGasWarningCheck(): Promise<void> {
  const threshold = resolveMinNativeThreshold()
  console.info(`[GAS_CRON] Vault gas check starting (threshold=${threshold})`)

  const rows = await fetchVaultGasBalances()
  if (rows.length === 0) {
    console.info('[GAS_CRON] No vault addresses configured — skip')
    return
  }

  const low = rows.filter((r) => isBelowThreshold(r, threshold))
  for (const row of rows) {
    const status = row.error ? 'error' : row.native_amount < threshold ? 'LOW' : 'ok'
    console.info(
      `[GAS_CRON] ${row.chain} ${truncateAddress(row.address)} ${row.native_display} [${status}]`,
    )
  }

  if (low.length === 0) {
    console.info('[GAS_CRON] All vault gas balances above threshold')
  } else {
    if (!isTelegramConfigured()) {
      console.warn('[GAS_CRON] Telegram not configured — cannot send low-gas warning')
    } else {
      await sendTelegramMessage(buildWarningMessage(low, threshold, rows))
      console.info(`[GAS_CRON] Sent low-gas warning for ${low.length} chain(s)`)
    }
  }

  // Deployer gas check disabled — contract already deployed
}

let gasCronTask: cron.ScheduledTask | null = null

/** Schedule vault gas checks (default every 6 hours). */
export function startVaultGasWarningCron(): void {
  if (isGasVaultCronDisabled()) {
    console.info('[GAS_CRON] Disabled via GAS_VAULT_CRON_DISABLED')
    return
  }
  if (gasCronTask) {
    console.info('[GAS_CRON] Already scheduled')
    return
  }

  const expression = resolveCronExpression()
  gasCronTask = cron.schedule(
    expression,
    () => {
      void runVaultGasWarningCheck().catch((err) => {
        console.warn(
          '[GAS_CRON] Run failed:',
          err instanceof Error ? err.message : String(err),
        )
      })
    },
    { timezone: 'UTC' },
  )

  console.info(`[GAS_CRON] Scheduled (${expression} UTC)`)

  void runVaultGasWarningCheck().catch((err) => {
    console.warn('[GAS_CRON] Initial run failed:', err instanceof Error ? err.message : String(err))
  })
}

export function stopVaultGasWarningCron(): void {
  if (gasCronTask) {
    gasCronTask.stop()
    gasCronTask = null
    console.info('[GAS_CRON] Stopped')
  }
}
