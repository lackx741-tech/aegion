"""
ens_whale_scan.py — ENS social records → extended token balance → whale list
Targets wallets that explicitly set up ENS profiles (more likely real DeFi OGs)
"""
import sys, os, json, time, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)
from dotenv import load_dotenv
load_dotenv(".env")

ALCHEMY_KEYS = [k.strip() for k in os.getenv("ALCHEMY_KEYS","").split(",") if k.strip()]
ALCHEMY_KEY  = ALCHEMY_KEYS[0] if ALCHEMY_KEYS else ""
NEYNAR_KEY   = os.getenv("NEYNAR_KEY","")
MIN_USD      = 100_000   # $100k on mainnet = likely $500k+ total wealth
OUT_FILE     = "ens_whale_results.json"

ETH_PRICE = 1934.0
try:
    r0 = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",timeout=5)
    ETH_PRICE = float(r0.json()["ethereum"]["usd"])
    print(f"  ETH price: ${ETH_PRICE:,.2f}")
except:
    print(f"  ETH price (cached): ${ETH_PRICE:,.2f}")

# ── STEP 1: ENS subgraph — wallets with social text records ─────────────────
print(f"\n{'='*60}")
print("  STEP 1: ENS subgraph → social text records")
print(f"{'='*60}")

ENS_URL = "https://api.thegraph.com/subgraphs/name/ensdomains/ens"
SOCIAL_KEYS = ["url", "com.twitter", "com.github", "org.telegram", "email", "com.discord"]

ENS_QUERY = """
query($cursor: String!, $keys: [String!]!) {
  resolvers(
    first: 1000
    where: { texts_contains: $keys, id_gt: $cursor }
    orderBy: id, orderDirection: asc
  ) {
    id
    addr { id }
    domain { name }
    texts
  }
}
"""

ens_wallets = {}  # addr.lower() → {ens, texts[]}
for key in SOCIAL_KEYS:
    cursor  = ""
    fetched = 0
    page    = 0
    print(f"  ENS key='{key}'...", end=" ", flush=True)
    while page < 25:
        try:
            r = requests.post(ENS_URL,
                json={"query": ENS_QUERY, "variables": {"cursor": cursor, "keys": [key]}},
                timeout=25)
            batch = r.json().get("data",{}).get("resolvers",[])
        except:
            break
        if not batch:
            break
        for item in batch:
            addr = ((item.get("addr") or {}).get("id") or "").lower()
            if not addr or addr == "0x0000000000000000000000000000000000000000":
                continue
            if addr not in ens_wallets:
                ens_wallets[addr] = {
                    "ens":   (item.get("domain") or {}).get("name",""),
                    "texts": item.get("texts",[]),
                    "twitter":"","telegram":"","email":"","github":"","discord":""
                }
            fetched += 1
        cursor = batch[-1]["id"]
        page  += 1
        if len(batch) < 1000:
            break
        time.sleep(0.05)
    print(f"{fetched} found ({len(ens_wallets)} unique wallets total)")

print(f"\n  Total ENS-social wallets: {len(ens_wallets)}")

# ── STEP 2: Batch balance check (ETH + 9 major tokens) ──────────────────────
print(f"\n{'='*60}")
print(f"  STEP 2: Batch balance (ETH + 9 tokens) → filter ${MIN_USD//1000}k+")
print(f"{'='*60}")

_TOKENS = [
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6,  "USDC",  1.0),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7", 6,  "USDT",  1.0),
    ("0x6b175474e89094c44da98b954eedeac495271d0f", 18, "DAI",   1.0),
    ("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", 8,  "WBTC",  108_000.0),
    ("0xae7ab96520de3a18e5e111b5eaab095312d7fe84", 18, "stETH", ETH_PRICE),
    ("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18, "WETH",  ETH_PRICE),
    ("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", 18, "UNI",   8.0),
    ("0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", 18, "AAVE",  200.0),
    ("0x514910771af9ca656af840dff83e8264ecf986ca", 18, "LINK",  16.0),
]
BAL_SIG = "0x70a08231"
ALCHEMY_URL = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
BATCH = 8   # 8 wallets × 10 calls = 80 calls/batch

addr_list  = list(ens_wallets.keys())
rich       = []
total_done = 0

for i in range(0, len(addr_list), BATCH):
    chunk = addr_list[i:i+BATCH]
    calls = []
    for a in chunk:
        calls.append({"jsonrpc":"2.0","id":f"eth_{a}","method":"eth_getBalance","params":[a,"latest"]})
        pad = a[2:].lower().zfill(64)
        for contract,_,sym,_ in _TOKENS:
            calls.append({"jsonrpc":"2.0","id":f"{sym}_{a}","method":"eth_call",
                          "params":[{"to":contract,"data":BAL_SIG+pad},"latest"]})
    try:
        resp = requests.post(ALCHEMY_URL, json=calls, timeout=20)
        rows = {r.get("id"): r.get("result","0x") for r in (resp.json() if isinstance(resp.json(),list) else [])}
    except:
        rows = {}

    for a in chunk:
        try:
            eth = int(rows.get(f"eth_{a}","0x0") or "0x0",16)/1e18
        except:
            eth = 0.0
        portfolio = [{"symbol":"ETH","balance":round(eth,4),"usd":round(eth*ETH_PRICE,2)}]
        total_usd = eth * ETH_PRICE
        for contract,dec,sym,price in _TOKENS:
            try:
                raw = rows.get(f"{sym}_{a}","0x") or "0x"
                bal = int(raw,16)/(10**dec) if raw and raw!="0x" else 0
                usd = round(bal*price,2)
                if usd >= 1:
                    portfolio.append({"symbol":sym,"balance":round(bal,4),"usd":usd})
                    total_usd += usd
            except:
                pass
        if total_usd >= MIN_USD:
            portfolio.sort(key=lambda x: x["usd"], reverse=True)
            entry = {**ens_wallets[a],
                     "addr":      a,
                     "total_usd": round(total_usd,2),
                     "portfolio": portfolio[:8],
                     "etherscan": f"https://etherscan.io/address/{a}"}
            rich.append(entry)
            tw = ens_wallets[a].get("twitter","") or ""
            print(f"\n  ★ ${total_usd:>10,.0f}  {ens_wallets[a]['ens']:<25}  tw={tw[:20]}")

    total_done += len(chunk)
    sys.stdout.write(f"\r  [{total_done}/{len(addr_list)}] Qualified ${MIN_USD//1000}k+: {len(rich)}   ")
    sys.stdout.flush()
    time.sleep(0.03)

# Sort by balance
rich.sort(key=lambda x: x["total_usd"], reverse=True)
print(f"\n\n  Total ${MIN_USD//1000}k+ wallets with ENS social: {len(rich)}")

# ── STEP 3: Enrich with Farcaster lookup ─────────────────────────────────────
print(f"\n{'='*60}")
print("  STEP 3: Farcaster lookup for qualified wallets")
print(f"{'='*60}")

FC_CACHE = {}
def lookup_farcaster(addr):
    if addr in FC_CACHE:
        return FC_CACHE[addr]
    try:
        r = requests.get("https://api.neynar.com/v2/farcaster/user/bulk-by-address",
                         params={"addresses": addr},
                         headers={"api_key": NEYNAR_KEY},
                         timeout=8)
        data = r.json()
        users = list(data.values())[0] if data else []
        if users:
            u = users[0]
            result = {
                "farcaster": u.get("username",""),
                "fc_display": u.get("display_name",""),
                "fc_followers": u.get("follower_count",0),
                "fc_twitter": next((a.get("username","") for a in (u.get("verified_accounts") or []) if a.get("platform") in ("twitter","x")),""),
                "warpcast": f"https://warpcast.com/{u.get('username','')}",
            }
            FC_CACHE[addr] = result
            return result
    except:
        pass
    FC_CACHE[addr] = {}
    return {}

for i, w in enumerate(rich, 1):
    sys.stdout.write(f"\r  [{i}/{len(rich)}] Farcaster lookup...")
    sys.stdout.flush()
    fc = lookup_farcaster(w["addr"])
    w.update(fc)
    time.sleep(0.2)

# ── Save & Summary ────────────────────────────────────────────────────────────
with open(OUT_FILE,"w",encoding="utf-8") as f:
    json.dump(rich, f, indent=2, default=str)

print(f"\n\n{'='*60}")
print(f"  DONE — {len(rich)} wallets saved to {OUT_FILE}")
print(f"{'='*60}")
with_tw = sum(1 for w in rich if w.get("twitter") or w.get("fc_twitter"))
with_fc = sum(1 for w in rich if w.get("farcaster"))
with_tg = sum(1 for w in rich if w.get("telegram"))
print(f"  With Twitter/X  : {with_tw}")
print(f"  With Farcaster  : {with_fc}")
print(f"  With Telegram   : {with_tg}")
print(f"\n  TOP 10 by balance:")
for w in rich[:10]:
    tw = w.get("twitter") or w.get("fc_twitter") or "-"
    print(f"    ${w['total_usd']:>12,.0f}  {w['ens']:<28}  @{tw}")
