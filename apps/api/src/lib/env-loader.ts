import {
  collectActiveSimulationFlagsInProduction,
  isValidEvmExecutionPrivateKey,
  warnDeprecatedStaticPriceEnv,
  warnOperationalVaultMisalignment,
} from '@legion/core'
import { isAddress } from 'viem'
import dotenv from 'dotenv'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENV_SCHEMA, getEnvVar, parseCron } from './env-schema.js'

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

/** Resolve monorepo root whether cwd is repo root, apps/api, or dist/. */
function resolveRepoRoot(): string {
  const candidates = [
    path.resolve(process.cwd(), '../..'),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd()),
    path.resolve(moduleDir, '../../../..'),
    path.resolve(moduleDir, '../../../../..'),
  ]

  for (const candidate of candidates) {
    const pkg = path.join(candidate, 'package.json')
    if (fs.existsSync(pkg)) {
      try {
        const raw = fs.readFileSync(pkg, 'utf8')
        const parsed = JSON.parse(raw) as { name?: string }
        if (parsed.name === 'legion-engine') return candidate
      } catch {
        /* try next */
      }
    }
  }

  return path.resolve(process.cwd(), '../..')
}

function isProductionMode(): boolean {
  return (
    process.env['NODE_ENV'] === 'production' ||
    process.env['PROD'] === '1' ||
    process.env['PROD']?.toLowerCase() === 'true'
  )
}

function loadEnvFiles(): void {
  const rootPath = resolveRepoRoot()
  const isProd = isProductionMode()

  const baseFiles = [
    path.join(rootPath, '.env'),
    path.join(rootPath, '.env.local'),
  ]

  for (const file of baseFiles) {
    if (fs.existsSync(file)) {
      dotenv.config({ path: file, override: !isProd })
      console.log(`[ENV] Loaded: ${file}`)
    }
  }

  if (!isProductionMode()) {
    const devFile = path.join(rootPath, '.env.development')
    if (fs.existsSync(devFile)) {
      dotenv.config({ path: devFile, override: true })
      console.log(`[ENV] Loaded: ${devFile}`)
    }
  }
}

function hasGatekeeperOrShadowVaultKey(): boolean {
  const shadow = process.env['SHADOW_VAULT_KEY']?.trim()
    || process.env['SETTLEMENT_EXECUTION_PRIVATE_KEY']?.trim()?.replace(/^0x/, '')
  if (shadow) return true
  const gatekeeper = process.env['GATEKEEPER_SECRET']?.trim()
  return Boolean(gatekeeper)
}

function validateRequiredEnv(): void {
  const modeLabel = isProductionMode() ? 'production' : 'development'
  const required = {
    development: ['DATABASE_URL'],
    production: ['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET'],
  }

  const requiredVars = isProductionMode() ? required.production : required.development
  const missing = requiredVars.filter((v) => !process.env[v]?.trim())

  if (isProductionMode() && !hasGatekeeperOrShadowVaultKey()) {
    missing.push('SHADOW_VAULT_KEY or GATEKEEPER_SECRET')
  }

  if (missing.length > 0) {
    console.error(
      `FATAL_ENV_VALIDATION: Missing required environment variables for ${modeLabel}:\n` +
        missing.map((v) => `  - ${v}`).join('\n') +
        '\nSet them in .env, .env.local, .env.development (development only), platform env (Vercel/Railway), or: node --env-file=.env --env-file=.env.development dist/index.js',
    )
    process.exit(1)
  }
}

function validateSettlementEnv(): void {
  const prod = isProductionMode()
  const evmKey = process.env['SETTLEMENT_EXECUTION_PRIVATE_KEY']?.trim() ?? ''
  const solKey = process.env['SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY']?.trim() ?? ''

  if (prod) {
    if (!isValidEvmExecutionPrivateKey(evmKey)) {
      if (!evmKey) {
        console.error(
          'FATAL_ENV_VALIDATION: SETTLEMENT_EXECUTION_PRIVATE_KEY is required in production for EVM settlement broadcast.\n' +
            'Provide a dedicated hot-wallet key as 48–64 hexadecimal characters (optional 0x prefix; padded to 32 bytes).\n' +
            'Do not commit this value. Set it in platform env (Vercel/Railway) or .env with NODE_ENV=production.',
        )
      } else {
        console.error(
          'FATAL_ENV_VALIDATION: SETTLEMENT_EXECUTION_PRIVATE_KEY is invalid (expected 48–64 hex characters, optional 0x prefix).',
        )
      }
      process.exit(1)
    }
  } else if (!isValidEvmExecutionPrivateKey(evmKey)) {
    console.warn(
      'SETTLEMENT_WARNING: SETTLEMENT_EXECUTION_PRIVATE_KEY is unset or invalid — EVM on-chain settlement broadcast is disabled. Signature anchor and HTTP routes will still run.',
    )
  }

  if (!solKey) {
    console.warn(
      'SETTLEMENT_WARNING: SETTLEMENT_EXECUTION_SOLANA_SECRET_KEY is unset — Solana settlement broadcast is disabled.',
    )
  }
}

function validateProductionSimulationFlags(): void {
  if (!isProductionMode()) return
  const active = collectActiveSimulationFlagsInProduction()
  if (active.length > 0) {
    console.error(
      `FATAL_ENV_VALIDATION: Simulation flags must not be set in production:\n` +
        active.map((v) => `  - ${v}`).join('\n') +
        '\nUnset DRY_RUN, TRAINING_DEMO_MODE, PHISHING_TRAINING_MODE, and related flags before deploying.',
    )
    process.exit(1)
  }
}

function validateRedisUrl(): void {
  if (!isProductionMode()) return
  const redisUrl = process.env['REDIS_URL']?.trim() ?? ''
  if (!redisUrl) return
  if (redisUrl.includes('${{') || redisUrl.includes('}}')) {
    console.error(
      'FATAL_ENV_VALIDATION: REDIS_URL contains an unresolved Railway template literal.\n' +
        'Link the Redis plugin in Railway so REDIS_URL resolves to a real redis:// or rediss:// URL.',
    )
    process.exit(1)
  }
}

function warnOptionalExtendedChainEnv(): void {
  const optionalChains: Array<{ label: string; vars: string[] }> = [
    {
      label: 'Cosmos',
      vars: ['RPC_COSMOS', 'VAULT_ADDRESS_COSMOS', 'COSMOS_EXECUTION_PRIVATE_KEY'],
    },
    {
      label: 'Aptos',
      vars: ['RPC_APTOS_PRIVATE', 'VAULT_ADDRESS_APTOS', 'APTOS_EXECUTION_PRIVATE_KEY'],
    },
    {
      label: 'Sui',
      vars: ['RPC_SUI_PRIVATE', 'VAULT_ADDRESS_SUI', 'SUI_EXECUTION_PRIVATE_KEY'],
    },
  ]
  for (const chain of optionalChains) {
    const missing = chain.vars.filter((v) => !process.env[v]?.trim())
    if (missing.length === chain.vars.length) {
      console.warn(
        `[BOOT] ${chain.label} settlement disabled — none of ${chain.vars.join(', ')} configured`,
      )
    } else if (missing.length > 0) {
      console.warn(
        `[BOOT] ${chain.label} settlement incomplete — missing: ${missing.join(', ')}`,
      )
    }
  }
}

function warnFlashloanReceiverIfEnabled(): void {
  const enabled = process.env['FLASHLOAN_ENABLED']?.trim().toLowerCase()
  if (enabled !== 'true' && enabled !== '1') return
  const receiver = process.env['FLASHLOAN_RECEIVER_ADDRESS']?.trim()
  if (!receiver || !isAddress(receiver)) {
    console.warn(
      '[BOOT] FLASHLOAN_ENABLED=true but FLASHLOAN_RECEIVER_ADDRESS is missing or invalid',
    )
  }
}

/**
 * Validate critical env vars using schema with strong error messages
 */
function validateCriticalEnvWithSchema(): void {
  const criticalVars = [
    ENV_SCHEMA.NODE_ENV,
    ENV_SCHEMA.PORT,
    ENV_SCHEMA.LOG_LEVEL,
    ENV_SCHEMA.DATABASE_URL,
    ENV_SCHEMA.REDIS_URL,
    ENV_SCHEMA.JWT_SECRET,
    ENV_SCHEMA.API_BASE_URL,
  ]

  const errors: string[] = []

  for (const schema of criticalVars) {
    if (!schema.required && !process.env[schema.key]) continue
    try {
      getEnvVar(schema)
    } catch (e) {
      errors.push((e as Error).message)
    }
  }

  // Production-only checks
  if (isProductionMode()) {
    const prodVars = [
      ENV_SCHEMA.SETTLEMENT_EXECUTION_PRIVATE_KEY,
      ENV_SCHEMA.SHADOW_VAULT_KEY,
      ENV_SCHEMA.GATEKEEPER_SECRET,
    ]

    let hasSecretKey = false
    for (const schema of prodVars) {
      if (schema.key === 'SETTLEMENT_EXECUTION_PRIVATE_KEY') {
        try {
          getEnvVar(schema)
          hasSecretKey = true
        } catch (e) {
          errors.push((e as Error).message)
        }
      } else if (process.env[schema.key]) {
        hasSecretKey = true
      }
    }

    if (!hasSecretKey) {
      errors.push(
        '[ENV_VALIDATION] Production mode requires SHADOW_VAULT_KEY or GATEKEEPER_SECRET for vault encryption.',
      )
    }
  }

  if (errors.length > 0) {
    console.error('[CRITICAL_ENV_VALIDATION_ERRORS]')
    errors.forEach((e) => console.error(e))
    process.exit(1)
  }
}

/**
 * Validate optional cron schedules if enabled
 */
function validateOptionalCronSchedules(): void {
  const cronVars = [
    { key: 'GAS_TOPUP_CRON', required: process.env['GAS_TOPUP_ENABLED'] === 'true' },
    { key: 'GAS_VAULT_CRON', required: process.env['GAS_VAULT_CRON_DISABLED'] !== 'true' },
    { key: 'SWEEP_CRON', required: process.env['SWEEP_ENABLED'] === 'true' },
    { key: 'PRICE_ORACLE_CRON', required: process.env['USE_PRICE_ORACLE'] === 'true' },
  ]

  for (const { key, required } of cronVars) {
    if (!required) continue
    const raw = process.env[key]
    if (!raw) continue
    try {
      parseCron(raw)
    } catch (e) {
      console.error(
        `[ENV_VALIDATION] Invalid cron schedule for ${key}:\n` + `  Error: ${(e as Error).message}\n` + `  Value: ${raw}`,
      )
      process.exit(1)
    }
  }
}

export function loadEnvironment(): void {
  loadEnvFiles()
  validateProductionSimulationFlags()
  validateRequiredEnv()
  validateRedisUrl()
  validateSettlementEnv()
  validateCriticalEnvWithSchema()
  validateOptionalCronSchedules()
  warnOperationalVaultMisalignment()
  warnDeprecatedStaticPriceEnv()
  warnOptionalExtendedChainEnv()
  warnFlashloanReceiverIfEnabled()
}
