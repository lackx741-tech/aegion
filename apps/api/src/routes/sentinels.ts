/**
 * Sentinel Pulse — live infrastructure probes mapped to institutional sentinel roles.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { sendSuccess } from '../lib/api-response.js'
import {
  aggregateSentinelPulse,
  runSentinelInfrastructureProbes,
  type SentinelInfrastructureProbes,
  type SentinelProbeResult,
} from '../lib/sentinel-probes.js'
import { createAuthUnificationPreHandler } from '../middleware/auth-unification.js'

const SENTINEL_DEFINITIONS = [
  {
    priority: 1,
    id: 'mask',
    institutional_role: 'Session trust & infiltration plane',
    dna: 'Hardware wallet UX, attestation',
    probe: 'auth_config' as const,
  },
  {
    priority: 2,
    id: 'scout',
    institutional_role: 'Omni-chain asset telemetry',
    dna: 'Indexers, USD_ValueMap',
    probe: 'rpc_mesh' as const,
  },
  {
    priority: 3,
    id: 'closer',
    institutional_role: 'Settlement & bundle assembly',
    dna: 'Flashbots / Jito lanes',
    probe: 'rpc_evm' as const,
  },
  {
    priority: 4,
    id: 'dispatcher',
    institutional_role: 'Execution routing & LP mesh',
    dna: 'Dispatcher surface',
    probe: 'redis' as const,
  },
  {
    priority: 5,
    id: 'shadow',
    institutional_role: 'Privacy & egress cloaking',
    dna: 'OpSec, envelopes',
    probe: 'shadow_config' as const,
  },
  {
    priority: 6,
    id: 'gatekeeper',
    institutional_role: 'Sovereign command & policy',
    dna: 'War-room, approvals',
    probe: 'postgres' as const,
  },
] as const

type SentinelProbeKey = (typeof SENTINEL_DEFINITIONS)[number]['probe']

function probeAuthConfig(): SentinelProbeResult {
  const t0 = performance.now()
  const jwt = process.env['JWT_SECRET']?.trim() ?? ''
  const ok = jwt.length >= 16
  return {
    ok,
    status: ok ? 'online' : 'offline',
    latency_ms: Math.round(performance.now() - t0),
    configured: jwt.length > 0,
    detail: ok ? 'JWT_SECRET configured' : 'JWT_SECRET missing or too short',
  }
}

function probeShadowConfig(): SentinelProbeResult {
  const t0 = performance.now()
  const shadow = (process.env['SHADOW_VAULT_KEY']?.trim()
    || process.env['SETTLEMENT_EXECUTION_PRIVATE_KEY']?.trim()?.replace(/^0x/, '')) ?? ''
  const gatekeeper = process.env['GATEKEEPER_SECRET']?.trim() ?? ''
  const ok = /^[0-9a-fA-F]{64}$/.test(shadow) || gatekeeper.length > 0
  return {
    ok,
    status: ok ? 'online' : 'degraded',
    latency_ms: Math.round(performance.now() - t0),
    configured: shadow.length > 0 || gatekeeper.length > 0,
    detail: ok
      ? shadow.length > 0
        ? 'SHADOW_VAULT_KEY configured'
        : 'GATEKEEPER_SECRET configured'
      : 'SHADOW_VAULT_KEY (64 hex) or GATEKEEPER_SECRET required for sealed signatures',
  }
}

function probeRpcMesh(probes: SentinelInfrastructureProbes): SentinelProbeResult {
  const t0 = performance.now()
  const evm = probes.rpc_evm
  const sol = probes.rpc_solana
  const ok = evm.ok && sol.ok
  const configured = evm.configured || sol.configured
  let status: SentinelProbeResult['status'] = 'offline'
  if (ok) status = 'online'
  else if (evm.ok || sol.ok) status = 'degraded'
  return {
    ok,
    status,
    latency_ms: Math.round(performance.now() - t0),
    configured,
    detail: `evm=${evm.status} solana=${sol.status}`,
  }
}

function resolveSentinelProbe(
  key: SentinelProbeKey,
  infra: SentinelInfrastructureProbes,
): SentinelProbeResult {
  switch (key) {
    case 'postgres':
      return infra.postgres
    case 'redis':
      return infra.redis
    case 'rpc_evm':
      return infra.rpc_evm
    case 'rpc_mesh':
      return probeRpcMesh(infra)
    case 'auth_config':
      return probeAuthConfig()
    case 'shadow_config':
      return probeShadowConfig()
    default: {
      const _exhaustive: never = key
      return _exhaustive
    }
  }
}

export async function registerSentinelsRoute(app: FastifyInstance): Promise<void> {
  const authPre = createAuthUnificationPreHandler(app)

  app.get('/api/v1/sentinels', { preHandler: authPre }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const t0 = performance.now()
    const infrastructure = await runSentinelInfrastructureProbes()

    const sentinels = SENTINEL_DEFINITIONS.map((s) => {
      const probe = resolveSentinelProbe(s.probe, infrastructure)
      return {
        priority: s.priority,
        id: s.id,
        institutional_role: s.institutional_role,
        dna: s.dna,
        sentinel_pulse: probe.status,
        integrity_lock: probe.ok ? ('verified' as const) : ('fault' as const),
        probe: s.probe,
        probe_ok: probe.ok,
        probe_latency_ms: probe.latency_ms,
        ...(probe.detail ? { probe_detail: probe.detail } : {}),
      }
    })

    const sentinel_pulse = aggregateSentinelPulse(infrastructure)
    const allProbesOk = sentinels.every((s) => s.probe_ok)

    return sendSuccess(reply, 200, 'Sentinel status retrieved', {
      sentinel_pulse,
      integrity_lock: allProbesOk ? 'verified' : 'fault',
      status_latency_ms: Math.round(performance.now() - t0),
      infrastructure,
      sentinels,
    })
  })
}
