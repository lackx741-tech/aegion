"""
target_scan_500.py — 15-Category Scanner + Personalized Messages
Target: 500 wallets, $10K+, classified + personalized on-chain message
"""
import sys, os, json, time, csv, requests, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv("../../.env")   # main backend .env (Solana, Aptos, Sui RPCs)
load_dotenv(".env")         # whale-extractor .env (overrides if duplicate)

ALCHEMY_KEY   = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip()
ANKR_KEY      = os.getenv("ANKR_KEY","")
ETHERSCAN_KEY = os.getenv("ETHERSCAN_KEY","")

# Solana RPC — Helius preferred, Chainstack fallback
SOLANA_RPC = (os.getenv("RPC_SOLANA_PRIVATE","") or
              os.getenv("SOLANA_RPC_URL","") or
              os.getenv("SOLANA_CHAINSTACK_URL","") or
              "https://api.mainnet-beta.solana.com")

# Extract Helius API key from RPC URL (format: https://mainnet.helius-rpc.com/?api-key=KEY)
_helius_match = SOLANA_RPC.split("api-key=")
HELIUS_KEY = _helius_match[1].split("&")[0] if len(_helius_match) > 1 else ""
HELIUS_DAS  = f"https://mainnet.helius-rpc.com/?api-key={HELIUS_KEY}" if HELIUS_KEY else ""

ANKR_URL    = f"https://rpc.ankr.com/multichain/{ANKR_KEY}"
ALCHEMY_URL = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"

print(f"Solana RPC: {SOLANA_RPC[:50]}...")

MIN_USD  = 10_000
MAX_USD  = 5_000_000   # $5M cap — anything above is almost certainly institutional
TARGET   = 500
NOW      = int(time.time())
D30      = 30 * 86400
D90      = 90 * 86400
D365     = 365 * 86400

# ── Known addresses to skip ────────────────────────────────────────────────
SKIP = {
    "0x28c6c06298d514db089934071355e5743bf21d60",
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
    "0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503",
    "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43",
    "0x503828976d22510aad0201ac7ec88293211d23da",
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d",
    "0x77696bb39917c91a0c3908d577d5e322095425ca",
    "0x0d0707963952f2fba59dd06f2b425ace40b492fe",
    "0xbeb5fc579115071764c7423a4f12edde41f106ed",
    "0xf977814e90da44bfa03b6295a0616a897441acec",
    "0xe92d1a43df510f82c66382592a047d288f85226f",
    "0xab5c66752a9e8167967685f1450532fb96d5d24f",
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
    "0x61189da79177950a7272c88c6058b96d4bcd6be",
    "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be",
}

# ── Exchange sender addresses (origin detection) ───────────────────────────
EXCHANGES = {
    "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase",
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase",
    "0x61189da79177950a7272c88c6058b96d4bcd6be":  "Coinbase",
    "0xa090e606e30bd747d4e6245a1517ebe430f0057e": "Coinbase",
    "0x28c6c06298d514db089934071355e5743bf21d60": "Binance",
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance",
    "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance",
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Kraken",
    "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "Kraken",
}

# ── DeFi protocol addresses ────────────────────────────────────────────────
DEFI = {
    "aave":      "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
    "compound":  "0xc3d688b66703497daa19211eedff47f25384cdc3",
    "curve":     "0xd51a44d3fae010294c616388b506acda1bfaae46",
    "uniswap_v3":"0xe592427a0aece92de3edee1f18e0157c05861564",
    "uniswap_v2":"0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
    "1inch":     "0x1111111254eeb25477b68fb85ed929f73a960582",
    "lido":      "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    "convex":    "0xf403c135812408bfbe8713b5a23a04b3d48aae31",
}

STABLE_SYMBOLS = {"USDC","USDT","DAI","BUSD","FRAX","TUSD","USDP","GUSD","LUSD"}

# Format: (contract_addr, symbol, price_usd, ankr_blockchain, limit, skip_top)
# skip_top = pehle N holders skip karo (woh sab institutions hote hain)
SEED_TOKENS = [
    # ── Ethereum (top holders skip karo, middle range lo) ──────────────────
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","USDC",   1.0,   "eth",      400, 100),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7","USDT",   1.0,   "eth",      400, 100),
    ("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2","WETH",   3500.0,"eth",      300, 50),
    ("0x6b175474e89094c44da98b954eedeac495271d0f","DAI",    1.0,   "eth",      300, 50),
    ("0xae7ab96520de3a18e5e111b5eaab095312d7fe84","stETH",  3500.0,"eth",      200, 30),
    # ── BSC — zyada retail users, chhote amounts ───────────────────────────
    ("0x55d398326f99059ff775485246999027b3197955","USDT",   1.0,   "bsc",      400, 50),
    ("0xe9e7cea3dedca5984780bafc599bd69add087d56","BUSD",   1.0,   "bsc",      300, 50),
    ("0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d","USDC",   1.0,   "bsc",      300, 50),
    # ── Polygon — DeFi users, more individual ──────────────────────────────
    ("0x2791bca1f2de4661ed88a30c99a7a9449aa84174","USDC",   1.0,   "polygon",  300, 30),
    ("0xc2132d05d31c914a87c6611c10748aeb04b58e8f","USDT",   1.0,   "polygon",  300, 30),
    # ── Avalanche — different crowd, mostly retail ─────────────────────────
    ("0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e","USDC",   1.0,   "avalanche",200, 20),
    ("0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7","USDT",   1.0,   "avalanche",200, 20),
    # ── Arbitrum — active DeFi users ───────────────────────────────────────
    ("0xff970a61a04b1ca14834a43f5de4533ebddb5cc8","USDC",   1.0,   "arbitrum", 200, 20),
    ("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9","USDT",   1.0,   "arbitrum", 200, 20),
    # ── Base — newest chain, mostly retail ────────────────────────────────
    ("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","USDC",   1.0,   "base",     200, 10),
    # ── Optimism ──────────────────────────────────────────────────────────
    ("0x7f5c764cbc14f9669b88837ca1490cca17c31607","USDC",   1.0,   "optimism", 200, 10),
    # Solana is seeded separately via helius_solana_holders() below
]

# ══════════════════════════════════════════════════════════════════════════
#  API helpers
# ══════════════════════════════════════════════════════════════════════════

def ankr_holders(token_addr, limit=300, blockchain="eth", skip_top=0):
    """Fetch token holders. skip_top = skip first N (institutions); take next `limit` ones."""
    all_holders, page, total_seen = [], "", 0
    max_pages = (limit + skip_top) // 100 + 5  # hard ceiling to avoid infinite loops
    pages_fetched = 0
    while len(all_holders) < limit and pages_fetched < max_pages:
        body = {"jsonrpc":"2.0","id":1,"method":"ankr_getTokenHolders",
                "params":{"blockchain":blockchain,"contractAddress":token_addr,"pageSize":100}}
        if page: body["params"]["pageToken"] = page
        try:
            r = requests.post(ANKR_URL, json=body, timeout=15)
            if not r.ok: break
            d = r.json().get("result",{})
            holders = d.get("holders",[])
            if not holders: break
            for h in holders:
                total_seen += 1
                if total_seen <= skip_top:
                    continue          # skip top N — sab institutions hain
                addr = h.get("holderAddress","").lower()
                if addr and addr not in SKIP:
                    all_holders.append((addr, float(h.get("balance","0") or 0)))
            pages_fetched += 1
            page = d.get("nextPageToken","")
            if not page: break
        except: break
        time.sleep(0.2)
    return all_holders[:limit]

def ankr_balance(addr, chains=None):
    """Multi-chain balance + token breakdown. EVM by default."""
    if chains is None:
        chains = ["eth","bsc","polygon","arbitrum","base",
                  "optimism","avalanche","fantom","gnosis"]
    try:
        r = requests.post(ANKR_URL,
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
                  "params":{"blockchain":chains,
                             "walletAddress":addr,"onlyWhitelisted":False}},
            timeout=20)
        if r.ok:
            res = r.json().get("result",{})
            total = float(res.get("totalBalanceUsd","0") or 0)
            assets = res.get("assets",[])
            active_chains = set()
            tokens = []
            for a in assets:
                usd = float(a.get("balanceUsd","0") or 0)
                if usd > 0:
                    active_chains.add(a.get("blockchain",""))
                    tokens.append({
                        "symbol":     a.get("tokenSymbol",""),
                        "usd":        usd,
                        "blockchain": a.get("blockchain",""),
                    })
            return total, tokens, len(active_chains)
    except: pass
    return 0.0, [], 0

# ── Solana helpers ─────────────────────────────────────────────────────────

def is_solana_addr(addr):
    """Solana addresses are base58, 32-44 chars, no 0x prefix."""
    return not addr.startswith("0x") and 32 <= len(addr) <= 44

def solana_rpc(method, params):
    """Generic Solana JSON-RPC call."""
    try:
        r = requests.post(SOLANA_RPC,
            json={"jsonrpc":"2.0","id":1,"method":method,"params":params},
            timeout=15)
        if r.ok:
            return r.json().get("result")
    except: pass
    return None

def solana_balance(addr):
    """Total USD balance for a Solana address using Ankr."""
    return ankr_balance(addr, chains=["solana"])

def solana_tx_history(addr, limit=50):
    """Get recent Solana tx signatures."""
    sigs = solana_rpc("getSignaturesForAddress",
                      [addr, {"limit": limit, "commitment": "finalized"}])
    return sigs or []

def solana_nft_count(addr):
    """Count NFTs via Solana RPC token accounts (rough estimate)."""
    result = solana_rpc("getTokenAccountsByOwner",
                        [addr,
                         {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
                         {"encoding": "jsonParsed"}])
    if not result:
        return 0
    accounts = result.get("value", [])
    # NFTs = token accounts where decimals=0 and amount=1
    nft_count = sum(
        1 for acc in accounts
        if acc.get("account",{}).get("data",{}).get("parsed",{})
               .get("info",{}).get("tokenAmount",{}).get("decimals",99) == 0
        and acc.get("account",{}).get("data",{}).get("parsed",{})
               .get("info",{}).get("tokenAmount",{}).get("uiAmount",0) == 1
    )
    return nft_count

def helius_solana_holders(mint_addr, limit=300, skip_top=20):
    """
    Fetch Solana token holders via Helius DAS getTokenAccounts.
    Returns [(wallet_addr, usd_balance)] — actual wallets, not ATAs.
    """
    if not HELIUS_DAS:
        return []
    holders, cursor, seen_count = [], None, 0
    max_pages = 4    # hard cap — 4 pages = 400 accounts max, plenty
    pages = 0
    while len(holders) < limit and pages < max_pages:
        params = {"mint": mint_addr, "limit": 100,
                  "options": {"showZeroBalance": False}}
        if cursor:
            params["cursor"] = cursor
        try:
            r = requests.post(HELIUS_DAS,
                json={"jsonrpc":"2.0","id":1,
                      "method":"getTokenAccounts","params": params},
                timeout=8)
            if not r.ok: break
            data = r.json().get("result", {})
            accounts = data.get("token_accounts", [])
            if not accounts: break
            for acc in accounts:
                seen_count += 1
                if seen_count <= skip_top:
                    continue
                owner  = acc.get("owner","")
                amount = float(acc.get("amount", 0) or 0)
                # amount is in raw decimals for USDC/USDT (6 decimals)
                usd    = amount / 1_000_000  # convert lamports to dollars
                if (owner and len(owner) >= 32
                        and MIN_USD <= usd <= MAX_USD
                        and owner not in seen):
                    holders.append((owner, usd))
            pages += 1
            cursor = data.get("cursor")
            if not cursor: break
        except: break
        time.sleep(0.2)
    return holders[:limit]

def etherscan_txs(addr, limit=50, sort="asc"):
    try:
        r = requests.get("https://api.etherscan.io/v2/api",
            params={"chainid":1,"module":"account","action":"txlist",
                    "address":addr,"startblock":0,"endblock":99999999,
                    "page":1,"offset":limit,"sort":sort,
                    "apikey":ETHERSCAN_KEY}, timeout=12)
        if r.ok:
            txs = r.json().get("result",[])
            if isinstance(txs, list): return txs
    except: pass
    return []

def get_nft_count(addr):
    try:
        r = requests.get(f"{ALCHEMY_URL}/getNFTs",
            params={"owner":addr,"withMetadata":"false","pageSize":1}, timeout=10)
        if r.ok:
            return int(r.json().get("totalCount",0) or 0)
    except: pass
    return 0

def is_contract(addr):
    try:
        r = requests.post(ALCHEMY_URL,
            json={"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":[addr,"latest"]},
            timeout=8)
        if r.ok:
            return len(r.json().get("result","0x")) > 4
    except: pass
    return False

# ══════════════════════════════════════════════════════════════════════════
#  Classification
# ══════════════════════════════════════════════════════════════════════════

def classify(data):
    total       = data["total_usd"]
    tokens      = data["tokens"]
    chains      = data["chains_active"]
    nfts        = data["nft_count"]
    tx_count    = data["tx_count"]
    tx_90d      = data["tx_90d"]
    tx_30d      = data["tx_30d"]
    first_ts    = data["first_tx_ts"]
    last_ts     = data["last_tx_ts"]
    months_old  = (NOW - first_ts) / (86400*30.44) if first_ts else 0
    months_idle = (NOW - last_ts)  / (86400*30.44) if last_ts else 99

    stable_usd  = sum(t["usd"] for t in tokens if t["symbol"] in STABLE_SYMBOLS)
    stable_pct  = stable_usd / total * 100 if total > 0 else 0
    top_pct     = max((t["usd"]/total*100 for t in tokens), default=0)

    defi_used   = data["defi_protocols_used"]
    has_lido    = "lido" in defi_used
    defi_count  = len(defi_used - {"lido"})

    from_exchange      = data["from_exchange"]
    recent_large_in    = data["recent_large_incoming_usd"]
    regular_incoming   = data["regular_incoming"]
    dead_token_count   = data["dead_token_count"]

    # ── Priority classification ───────────────────────────────────────────

    # Cat 7: Recent Windfall — just received, hasn't acted
    if recent_large_in >= 10_000 and tx_30d <= 3 and tx_90d <= 8:
        return 7, "Recent Windfall"

    # Cat 10: Returning Wallet — long sleep, just woke
    if months_idle >= 12 and tx_30d >= 1:
        return 10, "Returning Wallet"

    # Cat 3: Stablecoin Hoarder — 70%+ stables, no DeFi
    if stable_pct >= 70 and defi_count == 0 and not has_lido:
        return 3, "Stablecoin Hoarder"

    # Cat 11: Yield Seeker — Lido only, no complex DeFi
    if has_lido and defi_count == 0:
        return 11, "Yield Seeker"

    # Cat 5: NFT Exit — had NFTs, sold, ETH sitting
    if nfts <= 3 and data.get("had_nft_sale") and months_idle <= 4:
        return 5, "NFT Exit Holder"

    # Cat 2: Idle Self-Custody — came from exchange, nothing since
    if from_exchange and defi_count == 0 and months_idle >= 2 and tx_90d <= 5:
        return 2, "Idle Self-Custody"

    # Cat 12: Crypto Salary — regular incoming, not deploying
    if regular_incoming and defi_count == 0 and tx_90d <= 10:
        return 12, "Crypto Salary"

    # Cat 4: Single Token Max — 85%+ in one non-stable token
    if top_pct >= 85 and stable_pct <= 30 and defi_count == 0:
        return 4, "Single Token Max"

    # Cat 8: Multi-Chain Chaos — 4+ chains, scattered
    if chains >= 4 and tx_90d >= 5:
        return 8, "Multi-Chain Chaos"

    # Cat 6: DeFi Dropout — used DeFi before, stopped 3+ months ago
    if defi_count >= 1 and months_idle >= 3 and tx_90d <= 2:
        return 6, "DeFi Dropout"

    # Cat 9: Silent Accumulator — 2+ years, many small buys
    if months_old >= 24 and tx_count >= 20 and tx_90d <= 8:
        return 9, "Silent Accumulator"

    # Cat 15: Gas Paralyzed — balance but never transacts
    if tx_count <= 8 and months_idle >= 6:
        return 15, "Gas Paralyzed"

    # Cat 13: Concentration Gamble — heavy single altcoin, volatile
    if top_pct >= 70 and stable_pct <= 15 and defi_count <= 2:
        return 13, "Concentration Gamble"

    # Cat 14: Bull FOMO — only active during market pumps
    if tx_90d <= 2 and tx_count >= 10 and months_old >= 18:
        return 14, "Bull FOMO Trader"

    # Cat 16: Wreckage Holder — many tokens, most dead
    if len(tokens) >= 6 and dead_token_count >= 3:
        return 16, "Wreckage Holder"

    return 2, "Idle Self-Custody"

# ══════════════════════════════════════════════════════════════════════════
#  Personalized Message Generator
# ══════════════════════════════════════════════════════════════════════════

def gen_message(data, cat_id):
    bal     = data["total_usd"]
    bal_k   = f"${bal/1e3:.0f}K" if bal < 1e6 else f"${bal/1e6:.1f}M"
    addr8   = data["wallet_address"][:8]
    idle_mo = round((NOW - data["last_tx_ts"]) / (86400*30.44)) if data["last_tx_ts"] else 0
    stable  = sum(t["usd"] for t in data["tokens"] if t["symbol"] in STABLE_SYMBOLS)
    stable_k = f"${stable/1e3:.0f}K"

    msgs = {
        2: {  # Idle Self-Custody
            "short": f"Wallet {addr8}: {bal_k} {idle_mo}mo se idle. Next step ready hai — legion.io/w/{addr8}",
            "full":  f"Tumhara {bal_k} {idle_mo} months se exchange se bahar aaya hai but kuch nahi hua. "
                     f"Legion pe simple 3-step setup — apna paisa apne liye kaam karwao."
        },
        3: {  # Stablecoin Hoarder
            "short": f"{stable_k} stable idle {idle_mo}mo. "
                     f"Yeh ${stable*0.05*(idle_mo/12)/1e3:.1f}K earn kar sakta tha — legion.io/w/{addr8}",
            "full":  f"Tumhara {stable_k} USDC/USDT {idle_mo} months se 0% earn kar raha hai. "
                     f"Inflation ne already ${stable*0.04*(idle_mo/12)/1e3:.0f}K value kha li. "
                     f"Legion pe 5% APY pe set karo — koi complex DeFi nahi, 1 click."
        },
        4: {  # Single Token Max
            "short": f"{bal_k} mostly ek hi token mein. Concentration risk high hai — legion.io/w/{addr8}",
            "full":  f"Tumhara {bal_k} portfolio 85%+ ek token pe concentrated hai. "
                     f"2022 mein aise wallets ne 60-80% value lose ki. "
                     f"Legion pe simple diversification — ek token se 3-4 mein split, "
                     f"saath mein yield bhi."
        },
        5: {  # NFT Exit Holder
            "short": f"NFT sale ke baad {bal_k} ETH idle hai. Is ETH ko kaam pe lagao — legion.io/w/{addr8}",
            "full":  f"Tumne NFTs sell kiye, ab {bal_k} ETH wallet mein hai but kuch nahi ho raha. "
                     f"ETH ko stETH mein convert karo — same exposure, 3.5% extra yearly. "
                     f"Legion pe 2 min mein."
        },
        6: {  # DeFi Dropout
            "short": f"DeFi try kiya tha — ab {idle_mo}mo se ruka hua hai. "
                     f"Naya simple version aa gaya — legion.io/w/{addr8}",
            "full":  f"Tumne pehle DeFi try kiya but complicated laga ya kuch hua. "
                     f"Hum sab simplify kar dete hain — same benefits, "
                     f"1/10 complexity. {bal_k} ready karo wapas kaam pe."
        },
        7: {  # Recent Windfall
            "short": f"Haal mein {bal_k} receive kiya — "
                     f"3 steps mein set ho jao legion.io/start",
            "full":  f"Tumne recently {bal_k} receive kiya — "
                     f"congratulations. Ab is paison ko sahi jagah lagana zaroori hai. "
                     f"Legion pe step-by-step guide hai — "
                     f"koi DeFi knowledge nahi chahiye."
        },
        8: {  # Multi-Chain Chaos
            "short": f"{bal_k} 4+ chains pe scattered. "
                     f"Sab ek jagah dekho — legion.io/w/{addr8}",
            "full":  f"Tumhara {bal_k} portfolio 4+ chains pe hai — "
                     f"track karna mushkil hota hai. "
                     f"Legion pe ek dashboard mein sab dikhta hai, "
                     f"aur best yield cross-chain automatically milti hai."
        },
        9: {  # Silent Accumulator
            "short": f"2+ saal se accumulate kar rahe ho — "
                     f"{bal_k} ready hai next level ke liye. legion.io/w/{addr8}",
            "full":  f"Tumne 2+ saal meh patiently {bal_k} accumulate kiya. "
                     f"Ab sirf hold karna enough nahi — "
                     f"same amount pe 4-6% extra earn possible hai bina risk badhaye. "
                     f"Legion pe next step."
        },
        10: {  # Returning Wallet
            "short": f"Wapas aa gaye? {bal_k} safe hai. "
                     f"Bahut kuch badla — yahan se shuru karo: legion.io/w/{addr8}",
            "full":  f"Tumhara wallet kaafi time se inactive tha — "
                     f"welcome back. {bal_k} safe hai. "
                     f"Crypto bahut badla hai {idle_mo} months mein. "
                     f"Legion pe quick catch-up — "
                     f"tumhare wallet ke liye best options already ready hain."
        },
        11: {  # Yield Seeker
            "short": f"Lido se aage bhi options hain — "
                     f"{bal_k} pe +1.8% APY milega. legion.io/w/{addr8}",
            "full":  f"Lido accha hai but sirf shuruat hai. "
                     f"Tumhara {bal_k} Lido + Curve combo pe "
                     f"1.8% extra APY earn kar sakta hai — same risk level. "
                     f"Legion automatically best yield dhundhta hai."
        },
        12: {  # Crypto Salary
            "short": f"Har mahine crypto aa raha hai but deploy nahi ho raha — "
                     f"legion.io/w/{addr8}",
            "full":  f"Tumhara crypto salary har mahine aa rahi hai "
                     f"but {bal_k} waise hi pada hai. "
                     f"Auto-compound set karo Legion pe — "
                     f"incoming automatically yield pe chala jaye."
        },
        13: {  # Concentration Gamble
            "short": f"{bal_k} mostly ek volatile token mein — "
                     f"partial hedge consider karo: legion.io/w/{addr8}",
            "full":  f"Tumhara {bal_k} portfolio ek volatile token pe heavy hai. "
                     f"2022 jaise correction aaya toh 70%+ loss possible. "
                     f"Legion pe 30% stablecoin hedge lagao — "
                     f"upside same, downside protected."
        },
        14: {  # Bull FOMO Trader
            "short": f"Bull run ka wait mat karo — "
                     f"{bal_k} abhi bhi kaam kar sakta hai: legion.io/w/{addr8}",
            "full":  f"Market pump ka wait karne se returns miss hote hain. "
                     f"Tumhara {bal_k} bear market mein bhi "
                     f"4-6% APY earn kar sakta hai. "
                     f"Legion pe set karo — pump aane pe bhi ready rahoge."
        },
        15: {  # Gas Paralyzed
            "short": f"{bal_k} ready hai but gas ka darr rok raha hai? "
                     f"Hum handle karte hain — legion.io/w/{addr8}",
            "full":  f"Gas fees confusing lagte hain — "
                     f"bahut log is wajah se ruk jaate hain. "
                     f"Legion pe gas automatically optimize hota hai, "
                     f"tumhe calculate nahi karna. {bal_k} deploy karo aaj."
        },
        16: {  # Wreckage Holder
            "short": f"Kuch tokens dead hain but {bal_k} jo bacha hai "
                     f"uspe ab seriously kaam karo: legion.io/w/{addr8}",
            "full":  f"Portfolio mein kuch tokens sahi nahi gaye — "
                     f"yeh common hai. Jo {bal_k} bacha hai "
                     f"use sahi tarike se deploy karo. "
                     f"Legion pe stable strategy — "
                     f"is baar proven yields, experiments nahi."
        },
    }

    default = {
        "short": f"Wallet {addr8}: {bal_k} ka full analysis ready hai — legion.io/w/{addr8}",
        "full":  f"Tumhara {bal_k} portfolio analyze kiya — "
                 f"kuch actionable insights hain. Legion pe dekho."
    }

    return msgs.get(cat_id, default)

# ══════════════════════════════════════════════════════════════════════════
#  Solana Enrichment (separate path — different APIs)
# ══════════════════════════════════════════════════════════════════════════

# Solana DeFi protocol wallets (for defi_used detection)
SOLANA_DEFI = {
    "jupiter":  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "orca":     "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "raydium":  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "marinade": "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",  # Solana staking
    "lido_sol": "CrX7kMhLC3cSsXJdT7JDgqrRVWGnUpX3gfEfxxU2NVLi",  # stSOL
}

def enrich_solana(addr):
    """Enrichment for Solana wallets. Uses Solana RPC + Ankr."""
    try:
        # 1. Balance via Ankr Solana
        total, tokens, chain_count = solana_balance(addr)
        if total < MIN_USD or total > MAX_USD:
            return None

        # 2. NFT count
        nft_count = solana_nft_count(addr)

        # 3. TX history (recent 50)
        sigs = solana_tx_history(addr, limit=50)
        tx_count = len(sigs)

        # Timestamps from signatures
        timestamps = [s.get("blockTime", 0) for s in sigs if s.get("blockTime")]
        first_ts = min(timestamps) if timestamps else 0
        last_ts  = max(timestamps) if timestamps else 0

        cutoff_90 = NOW - D90
        cutoff_30 = NOW - D30
        tx_90d = sum(1 for ts in timestamps if ts >= cutoff_90)
        tx_30d = sum(1 for ts in timestamps if ts >= cutoff_30)

        # 4. DeFi detection — check if any known Solana DeFi program in recent txs
        defi_used = set()
        tx_programs = set()
        for s in sigs:
            memo = s.get("memo") or ""
            for name, prog in SOLANA_DEFI.items():
                if prog.lower() in memo.lower():
                    defi_used.add(name)

        # Marinade/Lido staking = "yield seeker"
        has_lido = "lido_sol" in defi_used or "marinade" in defi_used

        # 5. Regular incoming check (same sender multiple times)
        # Solana sigs don't give sender easily — skip for now
        regular_incoming = False
        from_exchange = ""
        recent_large_in = 0.0
        dead_count = sum(1 for t in tokens if t["usd"] < 10)

        data = {
            "wallet_address":            addr,
            "total_usd":                 total,
            "tokens":                    tokens,
            "chains_active":             max(chain_count, 1),
            "nft_count":                 nft_count,
            "tx_count":                  tx_count,
            "tx_90d":                    tx_90d,
            "tx_30d":                    tx_30d,
            "first_tx_ts":               first_ts,
            "last_tx_ts":                last_ts,
            "defi_protocols_used":       defi_used,
            "from_exchange":             from_exchange,
            "recent_large_incoming_usd": recent_large_in,
            "regular_incoming":          regular_incoming,
            "dead_token_count":          dead_count,
            "had_nft_sale":              False,
        }

        cat_id, cat_name = classify(data)
        msg = gen_message(data, cat_id)

        return {
            "wallet_address": addr,
            "total_usd":      round(total, 2),
            "category_id":    cat_id,
            "category":       cat_name,
            "chains_active":  max(chain_count, 1),
            "nft_count":      nft_count,
            "tx_90d":         tx_90d,
            "tx_30d":         tx_30d,
            "months_old":     round((NOW-first_ts)/(86400*30.44),1) if first_ts else 0,
            "months_idle":    round((NOW-last_ts)/(86400*30.44),1) if last_ts else 99,
            "from_exchange":  "",
            "defi_used":      ",".join(sorted(defi_used)),
            "stable_pct":     round(sum(t["usd"] for t in tokens
                              if t["symbol"] in STABLE_SYMBOLS)/total*100,1) if total else 0,
            "chain_type":     "solana",
            "msg_short":      msg["short"],
            "msg_full":       msg["full"],
        }
    except:
        return None

# ══════════════════════════════════════════════════════════════════════════
#  EVM Enrichment
# ══════════════════════════════════════════════════════════════════════════

def enrich(addr):
    try:
        # 1. Multi-chain balance
        total, tokens, chain_count = ankr_balance(addr)
        if total < MIN_USD or total > MAX_USD:
            return None   # too small = not worth it; too large = institution

        # 2. Skip contracts
        if is_contract(addr):
            return None

        # 3. NFT count
        nft_count = get_nft_count(addr)

        # 4. Transaction history (oldest first)
        old_txs  = etherscan_txs(addr, limit=50, sort="asc")
        new_txs  = etherscan_txs(addr, limit=50, sort="desc")

        first_ts = int(old_txs[0]["timeStamp"]) if old_txs else 0
        last_ts  = int(new_txs[0]["timeStamp"]) if new_txs else 0
        tx_count = len(old_txs)  # approximate

        cutoff_90 = NOW - D90
        cutoff_30 = NOW - D30
        tx_90d = sum(1 for t in new_txs if int(t.get("timeStamp",0)) >= cutoff_90)
        tx_30d = sum(1 for t in new_txs if int(t.get("timeStamp",0)) >= cutoff_30)

        # 5. DeFi interactions check
        all_to = {t.get("to","").lower() for t in old_txs + new_txs}
        defi_used = set()
        for name, paddr in DEFI.items():
            if paddr.lower() in all_to:
                defi_used.add(name)

        # 6. Exchange origin (first tx from exchange?)
        from_exchange = ""
        if old_txs:
            first_from = old_txs[0].get("from","").lower()
            from_exchange = EXCHANGES.get(first_from, "")

        # 7. Recent large incoming
        recent_in = 0.0
        for t in new_txs:
            ts = int(t.get("timeStamp",0))
            if ts >= cutoff_30 and t.get("to","").lower() == addr:
                val = int(t.get("value","0")) / 1e18 * 3500
                recent_in = max(recent_in, val)

        # 8. Regular incoming (salary check)
        senders = [t.get("from","").lower() for t in new_txs
                   if t.get("to","").lower() == addr]
        from_counts = {}
        for s in senders:
            from_counts[s] = from_counts.get(s,0) + 1
        regular_incoming = any(v >= 3 for v in from_counts.values())

        # 9. Dead token count (tokens < $10 value)
        dead_count = sum(1 for t in tokens if t["usd"] < 10)

        # 10. NFT sale detection (approximate)
        had_nft_sale = nft_count <= 5 and any(
            "transferfrom" in t.get("functionName","").lower() or
            "safetransfer" in t.get("functionName","").lower()
            for t in new_txs
        )

        data = {
            "wallet_address":          addr,
            "total_usd":               total,
            "tokens":                  tokens,
            "chains_active":           chain_count,
            "nft_count":               nft_count,
            "tx_count":                tx_count,
            "tx_90d":                  tx_90d,
            "tx_30d":                  tx_30d,
            "first_tx_ts":             first_ts,
            "last_tx_ts":              last_ts,
            "defi_protocols_used":     defi_used,
            "from_exchange":           from_exchange,
            "recent_large_incoming_usd": recent_in,
            "regular_incoming":        regular_incoming,
            "dead_token_count":        dead_count,
            "had_nft_sale":            had_nft_sale,
        }

        cat_id, cat_name = classify(data)
        msg = gen_message(data, cat_id)

        return {
            "wallet_address":   addr,
            "total_usd":        round(total, 2),
            "category_id":      cat_id,
            "category":         cat_name,
            "chains_active":    chain_count,
            "nft_count":        nft_count,
            "tx_90d":           tx_90d,
            "tx_30d":           tx_30d,
            "months_old":       round((NOW-first_ts)/(86400*30.44),1) if first_ts else 0,
            "months_idle":      round((NOW-last_ts)/(86400*30.44),1) if last_ts else 99,
            "from_exchange":    from_exchange,
            "defi_used":        ",".join(sorted(defi_used)),
            "stable_pct":       round(sum(t["usd"] for t in tokens
                                if t["symbol"] in STABLE_SYMBOLS)/total*100,1) if total else 0,
            "msg_short":        msg["short"],
            "msg_full":         msg["full"],
            "chain_type":       "evm",
        }
    except Exception as e:
        return None

# ══════════════════════════════════════════════════════════════════════════
#  Main
# ══════════════════════════════════════════════════════════════════════════

print("="*60)
print("STEP 1: Collecting seed wallets from Ankr")
print("="*60)

seen = set()
candidates = []

for token_addr, name, price, chain, limit, skip_top in SEED_TOKENS:
    print(f"  [{chain.upper()}] {name}...", end=" ", flush=True)
    holders = ankr_holders(token_addr, limit=limit, blockchain=chain, skip_top=skip_top)
    added = 0
    for addr, bal in holders:
        if addr in seen or addr in SKIP:
            continue
        est = bal * price
        if MIN_USD <= est <= MAX_USD:   # only retail-range estimates
            seen.add(addr)
            candidates.append(addr)
            added += 1
    print(f"{added} added (total: {len(candidates)})")
    time.sleep(0.3)

# ── Solana seeds via Helius ─────────────────────────────────────────────
SOL_TOKENS = [
    ("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"),
    ("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  "USDT"),
]
print("  [SOLANA] Skipping seed collection (Helius DAS pagination unstable) — enrich_solana() ready for future use")

print(f"\nTotal candidates: {len(candidates)}")

print("\n" + "="*60)
print("STEP 2: Enriching + Classifying")
print("="*60)

results = []
lock = threading.Lock()
done_count = [0]

CAT_COUNTS = {}

def process(addr):
    rec = enrich_solana(addr) if is_solana_addr(addr) else enrich(addr)
    with lock:
        done_count[0] += 1
        n = done_count[0]
        if rec:
            results.append(rec)
            c = rec["category"]
            CAT_COUNTS[c] = CAT_COUNTS.get(c,0) + 1
            bal = rec["total_usd"]
            print(f"  [{n:>4}] ✓ ${bal/1e3:>7.1f}K | {rec['category']:<22} | "
                  f"chains={rec['chains_active']} tx90={rec['tx_90d']:<3} "
                  f"idle={rec['months_idle']:.0f}mo | {rec['msg_short'][:55]}")
        elif n % 50 == 0:
            print(f"  [{n:>4}] scanned... found={len(results)}")
    time.sleep(0.05)

with ThreadPoolExecutor(max_workers=5) as pool:
    list(pool.map(process, candidates))

# Sort: priority categories first, then by balance
PRIORITY = {7:1, 3:2, 2:3, 12:4, 11:5, 9:6, 10:7, 6:8, 5:9, 4:10, 8:11, 13:12, 15:13, 14:14, 16:15}
results.sort(key=lambda x: (PRIORITY.get(x["category_id"],99), -x["total_usd"]))
top500 = results[:TARGET]

# ── Save ──────────────────────────────────────────────────────────────────
os.makedirs("outputs", exist_ok=True)

with open("outputs/targets_multichain.json","w",encoding="utf-8") as f:
    json.dump(top500, f, indent=2, ensure_ascii=False)

fields = ["wallet_address","total_usd","category_id","category","chain_type","chains_active",
          "nft_count","tx_90d","tx_30d","months_old","months_idle",
          "from_exchange","defi_used","stable_pct","msg_short","msg_full"]

with open("outputs/targets_multichain.csv","w",newline="",encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
    w.writeheader()
    w.writerows(top500)

# ── Final report ──────────────────────────────────────────────────────────
print(f"\n{'='*60}")
print(f"RESULTS: {len(top500)} targets")
print(f"{'='*60}")

print("\nCategory breakdown:")
for cat, cnt in sorted(CAT_COUNTS.items(), key=lambda x:-x[1]):
    bar = "█" * min(cnt, 40)
    print(f"  {cat:<25} {cnt:>3}  {bar}")

total_v = sum(r["total_usd"] for r in top500)
print(f"\nTotal wallet value: ${total_v/1e9:.2f}B")
print(f"Avg per wallet:     ${total_v/len(top500)/1e3:.0f}K" if top500 else "")

print(f"\n{'#':<4} {'Address':<12} {'Balance':>9} {'Category':<22} {'Message preview'}")
print("  " + "-"*85)
for i, r in enumerate(top500[:30], 1):
    print(f"  {i:<3} {r['wallet_address'][:10]:<12} "
          f"${r['total_usd']/1e3:>7.1f}K "
          f"{r['category']:<22} "
          f"{r['msg_short'][:40]}")

print(f"\nSaved → outputs/targets_multichain.json + .csv")
print(f"        Chains: ETH + BSC + Polygon + Avalanche + Arbitrum + Base + Optimism")
print(f"        Each record has msg_short (on-chain) + msg_full (landing page)")
