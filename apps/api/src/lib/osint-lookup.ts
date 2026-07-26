/**
 * OSINT lookup helpers for the Telegram control bot.
 * Uses already-configured keys: ETHERSCAN_KEY, NEYNAR_KEY, SERPER_KEY, ALCHEMY_KEY
 */

const ETHERSCAN_KEY = process.env['ETHERSCAN_KEY'] ?? ''
const NEYNAR_KEY    = process.env['NEYNAR_KEY'] ?? ''
const SERPER_KEY    = process.env['SERPER_KEY'] ?? ''
const ALCHEMY_KEY   = process.env['ALCHEMY_KEY'] ?? ''

async function fetchJson(url: string, opts: RequestInit = {}): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), ...opts })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

interface FarcasterResult {
  display_name: string
  username: string
  fid: number
  followers: number
  bio: string
  eth_wallets: string[]
  sol_wallets: string[]
}

async function lookupFarcaster(address: string): Promise<FarcasterResult | null> {
  if (!NEYNAR_KEY) return null
  const url = `https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses=${address.toLowerCase()}`
  const data = await fetchJson(url, { headers: { 'api_key': NEYNAR_KEY } }) as Record<string, unknown> | null
  if (!data) return null
  const entries = Object.values(data)
  if (!entries.length) return null
  const users = entries[0] as unknown[]
  if (!users?.length) return null
  const u = users[0] as Record<string, unknown>
  const verifications = (u['verifications'] as string[] | undefined) ?? []
  const sol = ((u['verified_addresses'] as Record<string, unknown> | undefined)?.['sol_addresses'] as string[] | undefined) ?? []
  return {
    display_name: String(u['display_name'] ?? ''),
    username: String(u['username'] ?? ''),
    fid: Number(u['fid'] ?? 0),
    followers: Number(u['follower_count'] ?? 0),
    bio: String(((u['profile'] as Record<string,unknown> | undefined)?.['bio'] as Record<string,unknown> | undefined)?.['text'] ?? '').slice(0, 120),
    eth_wallets: verifications,
    sol_wallets: sol,
  }
}

interface EtherscanResult {
  balance_eth: number
  first_tx_date: string | null
  tx_count: number
}

async function lookupEtherscan(address: string): Promise<EtherscanResult | null> {
  if (!ETHERSCAN_KEY) return null
  const [balData, txData] = await Promise.all([
    fetchJson(`https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${ETHERSCAN_KEY}`) as Promise<Record<string,unknown>|null>,
    fetchJson(`https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${ETHERSCAN_KEY}`) as Promise<Record<string,unknown>|null>,
  ])

  const balWei = balData?.['result'] ? BigInt(String(balData['result'])) : 0n
  const balEth = Number(balWei) / 1e18

  let firstTx: string | null = null
  let txCount = 0
  if (txData?.['status'] === '1') {
    const list = txData['result'] as Record<string,unknown>[]
    if (list?.length) {
      const ts = Number(list[0]?.['timeStamp'] ?? 0)
      if (ts) firstTx = new Date(ts * 1000).toISOString().slice(0, 10)
    }
  }

  // get tx count via getTransactionCount
  const countData = await fetchJson(
    `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionCount&address=${address}&tag=latest&apikey=${ETHERSCAN_KEY}`
  ) as Record<string,unknown>|null
  if (countData?.['result']) {
    txCount = parseInt(String(countData['result']), 16)
  }

  return { balance_eth: balEth, first_tx_date: firstTx, tx_count: txCount }
}

async function lookupENS(address: string): Promise<string | null> {
  // Use eth.blockscout.com for reverse ENS resolution (free, no key)
  const data = await fetchJson(
    `https://api.etherscan.io/api?module=account&action=addresstag&address=${address}&apikey=${ETHERSCAN_KEY}`
  ) as Record<string,unknown>|null
  if (data?.['status'] === '1' && data['result']) return String(data['result'])

  // Fallback: Alchemy ENS lookup
  if (!ALCHEMY_KEY) return null
  const body = {
    id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers',
    params: [{ fromAddress: address, category: ['external'], maxCount: '0x1' }],
  }
  // Just check ENS via eth_call on mainnet
  const ensData = await fetchJson(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_call', params: [
      { to: '0x3671aE578E63FdF66ad4F3E12CC0c0d71Ac7510C', data: `0x55ea6c47000000000000000000000000${address.slice(2).toLowerCase()}` },
      'latest',
    ]}),
  }) as Record<string,unknown>|null
  if (ensData?.['result'] && ensData['result'] !== '0x') {
    // decode bytes32 → try to extract name
    try {
      const hex = String(ensData['result']).replace('0x', '')
      const bytes = Buffer.from(hex, 'hex')
      const name = bytes.toString('utf8').replace(/\0/g, '').trim()
      if (name && /^[\w.-]+\.eth$/.test(name)) return name
    } catch { /* ignore */ }
  }
  return null
}

async function searchWeb(query: string): Promise<string[]> {
  if (!SERPER_KEY) return []
  const data = await fetchJson('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 5 }),
  }) as Record<string,unknown>|null
  if (!data) return []
  const organic = data['organic'] as Array<Record<string,unknown>> | undefined
  return (organic ?? []).slice(0, 5).map(r => `• <a href="${r['link']}">${String(r['title'] ?? '').slice(0, 80)}</a>`)
}

interface TokenBalance {
  symbol: string
  balance: number
  value_usd: number
}

async function lookupTopTokens(address: string): Promise<TokenBalance[]> {
  if (!ALCHEMY_KEY) return []
  const data = await fetchJson(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'alchemy_getTokenBalances', params: [address] }),
  }) as Record<string,unknown>|null
  if (!data) return []
  // just return count for now
  const balances = (data as any)?.result?.tokenBalances ?? []
  return [{ symbol: 'ERC20 tokens found', balance: balances.length, value_usd: 0 }]
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return ''
  return n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K`
    : `$${n.toFixed(2)}`
}

export async function buildOsintReport(address: string): Promise<string> {
  const addr = address.trim().toLowerCase()
  const addrDisplay = `${addr.slice(0, 8)}…${addr.slice(-6)}`

  await Promise.resolve() // ensure async context

  const [eth, fc, webMentions, tokens] = await Promise.all([
    lookupEtherscan(addr),
    lookupFarcaster(addr),
    searchWeb(`"${addr}" wallet crypto`),
    lookupTopTokens(addr),
  ])

  const lines: string[] = [
    `🔍 <b>OSINT: <code>${addrDisplay}</code></b>`,
    '━━━━━━━━━━━━━━━━',
  ]

  // On-chain data
  if (eth) {
    lines.push(`💰 <b>Balance:</b> ${eth.balance_eth.toFixed(4)} ETH`)
    lines.push(`📊 <b>Transactions:</b> ${eth.tx_count.toLocaleString()}`)
    if (eth.first_tx_date) {
      const ageYears = ((Date.now() - new Date(eth.first_tx_date).getTime()) / (365.25 * 86400000)).toFixed(1)
      lines.push(`📅 <b>First tx:</b> ${eth.first_tx_date} (${ageYears}y old)`)
    }
  }

  // Token count
  if (tokens.length > 0) {
    lines.push(`🪙 <b>ERC-20 tokens:</b> ${tokens[0]?.balance}`)
  }

  // Farcaster identity
  if (fc) {
    lines.push('', '👤 <b>Farcaster Identity</b>')
    lines.push(`  <b>Name:</b> ${fc.display_name}`)
    lines.push(`  <b>Username:</b> @${fc.username} (FID: ${fc.fid})`)
    lines.push(`  <b>Followers:</b> ${fc.followers.toLocaleString()}`)
    if (fc.bio) lines.push(`  <b>Bio:</b> ${fc.bio}`)
    if (fc.eth_wallets.length > 1) {
      lines.push(`  <b>Linked wallets (${fc.eth_wallets.length}):</b>`)
      fc.eth_wallets.slice(0, 5).forEach(w => lines.push(`    <code>${w}</code>`))
    }
    if (fc.sol_wallets.length) {
      lines.push(`  <b>SOL wallets:</b> ${fc.sol_wallets.slice(0,2).map(w => `<code>${w.slice(0,12)}…</code>`).join(', ')}`)
    }
  } else {
    lines.push('', '👤 <b>Farcaster:</b> No profile found')
  }

  // Web mentions
  if (webMentions.length > 0) {
    lines.push('', '🌐 <b>Web Mentions</b>')
    webMentions.forEach(m => lines.push(`  ${m}`))
  }

  lines.push('', `🔗 <a href="https://etherscan.io/address/${addr}">Etherscan</a> | <a href="https://debank.com/profile/${addr}">DeBank</a>`)

  return lines.join('\n')
}
