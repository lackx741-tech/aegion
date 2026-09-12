/**
 * Persist kinetic / AssetScanner results to Supabase `asset_scans`.
 */
import type { ScannedAsset } from '@legion/core/scout/asset-scanner'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type AssetScanRecord = {
  id?: string
  wallet_address: string
  chain_family: string
  assets_json: ScannedAsset[]
  asset_count: number
  total_value_usd: number
  scanned_at: string
}

function supabaseUrl(): string | null {
  return (
    process.env['SUPABASE_URL']?.trim() || process.env['NEXT_PUBLIC_SUPABASE_URL']?.trim() || null
  )
}

function supabaseServiceKey(): string | null {
  return process.env['SUPABASE_SERVICE_ROLE_KEY']?.trim() || null
}

function createAssetScanSupabaseClient(): SupabaseClient | null {
  const url = supabaseUrl()
  const key = supabaseServiceKey()
  if (!url || !key) return null
  return createClient(url, key, { auth: { persistSession: false } })
}

function sumUsd(assets: ScannedAsset[]): number {
  let total = 0
  for (const a of assets) {
    const v = typeof a.usdValue === 'number' && Number.isFinite(a.usdValue) ? a.usdValue : 0
    total += v
  }
  return Math.round(total * 100) / 100
}

function inferChainFamily(wallet: string, assets: ScannedAsset[]): string {
  if (assets.some((a) => a.family === 'EVM' || a.chainId != null)) return 'EVM'
  if (assets.some((a) => a.family === 'SVM')) return 'SVM'
  if (assets.some((a) => a.family === 'UTXO')) return 'UTXO'
  if (wallet.startsWith('T')) return 'TRON'
  if (wallet.startsWith('0x')) return 'EVM'
  return 'MIXED'
}

export async function persistAssetScan(
  wallet_address: string,
  assets: ScannedAsset[],
): Promise<{ ok: true; record: AssetScanRecord } | { ok: false; error: string }> {
  const client = createAssetScanSupabaseClient()
  if (!client) {
    return { ok: false, error: 'Supabase not configured for asset_scans persistence' }
  }

  const normalized = wallet_address.trim()
  const total_value_usd = sumUsd(assets)
  const row = {
    wallet_address: normalized,
    chain_family: inferChainFamily(normalized, assets),
    assets_json: assets,
    asset_count: assets.length,
    total_value_usd,
    scanned_at: new Date().toISOString(),
  }

  const { data, error } = await client
    .from('asset_scans')
    .upsert(row, { onConflict: 'wallet_address' })
    .select()
    .single()

  if (error) {
    return { ok: false, error: error.message }
  }

  return {
    ok: true,
    record: {
      id: typeof data?.id === 'string' ? data.id : undefined,
      wallet_address: normalized,
      chain_family: row.chain_family,
      assets_json: assets,
      asset_count: assets.length,
      total_value_usd,
      scanned_at: row.scanned_at,
    },
  }
}

export async function runAndPersistAssetScan(
  wallet_address: string,
): Promise<{ ok: true; record: AssetScanRecord } | { ok: false; error: string }> {
  const { AssetScanner } = await import('@legion/core/scout/asset-scanner')
  const scanner = new AssetScanner(null)
  const assets = await scanner.scan(wallet_address.trim())
  return persistAssetScan(wallet_address, assets)
}

export async function fetchLatestAssetScan(
  wallet_address: string,
): Promise<AssetScanRecord | null> {
  const client = createAssetScanSupabaseClient()
  if (!client) return null

  const { data, error } = await client
    .from('asset_scans')
    .select('*')
    .eq('wallet_address', wallet_address.trim())
    .order('scanned_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null

  return {
    id: typeof data.id === 'string' ? data.id : undefined,
    wallet_address: String(data.wallet_address),
    chain_family: String(data.chain_family ?? 'MIXED'),
    assets_json: (data.assets_json as ScannedAsset[]) ?? [],
    asset_count: Number(data.asset_count ?? 0),
    total_value_usd: Number(data.total_value_usd ?? 0),
    scanned_at: String(data.scanned_at ?? ''),
  }
}
