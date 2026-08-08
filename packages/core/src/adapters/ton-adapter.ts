// @ts-nocheck
/**
 * @file ton-adapter.ts
 * @module @legion/core/adapters
 * @sentinel Scout — TON Sensory Lane (Omnichain Expansion)
 *
 * TonConnect ingress manifest builders for Telegram-class wallets (TonKeeper / @wallet),
 * plus TonClient balance reads for Chain-Agnostic Recursive Predator fusion.
 */

import { Address, beginCell } from '@ton/core'
import { TonClient, fromNano } from '@ton/ton'

import { BaseChainAdapter, type DiscoveredAsset, type Uint256 } from './base-adapter.js'

export type TonConnectIngressManifest = {
  url: string
  name: string
  iconUrl: string
}

/**
 * TonConnect manifest payload — bind `baseUrl` to the deployed Omnichain Ingress origin.
 */
export function buildTonConnectIngressManifest(baseUrl: string): TonConnectIngressManifest {
  const u = baseUrl.replace(/\/+$/, '')
  return {
    url: u,
    name: 'Legion Engine — Omnichain Ingress',
    iconUrl: `${u}/icon-256.png`,
  }
}

export function isTonFriendlySensoryAddress(candidate: string): boolean {
  const s = candidate.trim()
  if (!s) return false
  try {
    Address.parse(s)
    return true
  } catch {
    return false
  }
}

export async function probeTonNativeBalanceNano(
  jsonRpcEndpoint: string,
  friendlyAddress: string,
  apiKey?: string,
): Promise<bigint | null> {
  try {
    const endpoint = jsonRpcEndpoint.replace(/\/+$/, '')
    const client =
      apiKey != null && apiKey !== ''
        ? new TonClient({ endpoint, apiKey })
        : new TonClient({ endpoint })
    const addr = Address.parse(friendlyAddress.trim())
    const n = await client.getBalance(addr)
    return BigInt(n)
  } catch {
    return null
  }
}

export function tonNativeNanoToUsd(nano: bigint, tonUsd: number): number {
  const ton = Number(fromNano(nano))
  if (!Number.isFinite(ton) || !Number.isFinite(tonUsd)) return 0
  return ton * tonUsd
}

export type TonAdapterOptions = {
  jsonRpcEndpoint: string
  apiKey?: string
}

export class TonAdapter extends BaseChainAdapter {
  readonly chainId = 'ton:mainnet'
  private readonly endpoint: string
  private readonly apiKey: string

  constructor(options: TonAdapterOptions) {
    super()
    this.endpoint = options.jsonRpcEndpoint.replace(/\/+$/, '')
    this.apiKey = options.apiKey?.trim() ?? ''
  }

  async getBalance(address: string): Promise<Uint256> {
    const n = await probeTonNativeBalanceNano(
      this.endpoint,
      address,
      this.apiKey !== '' ? this.apiKey : undefined,
    )
    return (n ?? 0n).toString()
  }

  getTransferData(_target: string, _amount: Uint256): string {
    // Encode a minimal TON internal message body (empty comment cell) as base64 BOC.
    // The actual destination + amount are set at the message-wrapper level by the caller;
    // this body is the payload attached to the internal message (comment field = empty).
    try {
      const body = beginCell()
        .storeUint(0, 32) // op = 0 → plain comment transfer
        .storeStringTail('') // empty comment
        .endCell()
      return body.toBoc().toString('base64')
    } catch {
      return '0x'
    }
  }

  async estimateExecutionGas(_params: unknown): Promise<Uint256> {
    // Conservative native-transfer fee estimate: ~0.005 TON = 5_000_000 nanotons.
    // Jetton transfers require ~0.05 TON (50_000_000); callers should override for Jettons.
    return '5000000'
  }

  async discoverAssets(owner: string): Promise<DiscoveredAsset[]> {
    const assets: DiscoveredAsset[] = []

    // ── Native TON balance ──────────────────────────────────────────────────
    const nano = await probeTonNativeBalanceNano(
      this.endpoint,
      owner,
      this.apiKey !== '' ? this.apiKey : undefined,
    )
    if (nano != null && nano > 0n) {
      assets.push({
        assetAddress: null,
        balance: nano.toString(),
        symbol: 'TON',
        decimals: 9,
      })
    }

    // ── Jetton balances via tonapi.io REST ───────────────────────────────────
    // Uses TON_API_KEY env var. Falls back silently when not configured.
    try {
      const tonApiKey = process.env['TON_API_KEY']?.trim() ?? ''
      const tonApiBase = process.env['TON_API_BASE_URL']?.trim() ?? 'https://tonapi.io'
      if (tonApiKey) {
        const url = `${tonApiBase}/v2/accounts/${encodeURIComponent(owner)}/jettons`
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${tonApiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        })
        if (resp.ok) {
          const data = await resp.json()
          const balances = Array.isArray(data?.balances) ? data.balances : []
          for (const item of balances) {
            const raw = item?.balance ?? '0'
            if (!raw || raw === '0') continue
            const meta = item?.jetton ?? {}
            assets.push({
              assetAddress: meta.address ?? item.jetton_address ?? null,
              balance: String(raw),
              symbol: meta.symbol ?? 'JETTON',
              decimals: Number(meta.decimals ?? 9),
            })
          }
        }
      }
    } catch {
      // Jetton scan is best-effort — never block on failure
    }

    return assets
  }
}
