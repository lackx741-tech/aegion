"""
ens_email_hunt.py — Query ENS subgraph for wallets with email/twitter TEXT records,
verify $2M+ multi-chain portfolio via Ankr, output contact-ready whale list.
"""
import sys, os, json, time, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv(".env")

ALCHEMY_KEY = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip()
ANKR_KEY    = os.getenv("ANKR_KEY","")
NEYNAR_KEY  = os.getenv("NEYNAR_KEY","")
MIN_ETH_USD = 100_000    # ETH mainnet pre-filter (cheap)
MIN_TOTAL   = 2_000_000  # Full multi-chain filter via Ankr

ETH_PRICE = 1934.0
try:
    r0 = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",timeout=5)
    ETH_PRICE = float(r0.json()["ethereum"]["usd"])
    print(f"  ETH: ${ETH_PRICE:,.2f}")
except Exception:
    pass

ENS_GQL = "https://api.thegraph.com/subgraphs/name/ensdomains/ens"

# Query ENS wallets that have set email or twitter text records
QUERY = """
query($cursor: String!, $key: String!) {
  resolvers(first: 1000, where: {texts_contains: [$key], id_gt: $cursor},
            orderBy: id, orderDirection: asc) {
    id
    addr { id }
    domain { name }
    texts
  }
}
"""

# Keys most likely to yield contact info
TARGET_KEYS = ["email", "com.twitter", "com.github", "org.telegram"]

print(f"\n{'='*60}")
print("STEP 1: ENS subgraph — wallets with social text records")
print(f"{'='*60}")

ens_wallets = {}
for key in TARGET_KEYS:
    cursor = ""; page = 0; cnt = 0
    print(f"  key='{key}'...", end=" ", flush=True)
    while page < 30:
        try:
            r = requests.post(ENS_GQL,
                json={"query": QUERY, "variables": {"cursor": cursor, "key": key}},
                timeout=25)
            batch = r.json().get("data",{}).get("resolvers",[])
        except Exception as e:
            print(f"Error: {e}")
            break
        if not batch: break
        for item in batch:
            addr = ((item.get("addr") or {}).get("id") or "").lower()
            if not addr or addr == "0x0000000000000000000000000000000000000000": continue
            if addr not in ens_wallets:
                ens_wallets[addr] = {
                    "ens": (item.get("domain") or {}).get("name",""),
                    "texts": item.get("texts",[])
                }
            cnt += 1
        cursor = batch[-1]["id"]; page += 1
        if len(batch) < 1000: break
        time.sleep(0.05)
    print(f"{cnt} ({len(ens_wallets)} unique)")

print(f"\n  Total ENS-social wallets: {len(ens_wallets)}")

# ── STEP 2: Quick ETH balance pre-filter ─────────────────────────────────────
print(f"\n{'='*60}")
print(f"STEP 2: ETH balance pre-filter (≥${MIN_ETH_USD//1000}k on mainnet)")
print(f"{'='*60}")

ALCHEMY_URL = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
addr_list   = list(ens_wallets.keys())
prefiltered = []
BATCH = 50

for i in range(0, len(addr_list), BATCH):
    chunk = addr_list[i:i+BATCH]
    calls = [{"jsonrpc":"2.0","id": a,"method":"eth_getBalance","params":[a,"latest"]} for a in chunk]
    try:
        resp = requests.post(ALCHEMY_URL, json=calls, timeout=30)
        rows = {r.get("id"): r.get("result","0x0") for r in (resp.json() if isinstance(resp.json(),list) else [])}
    except Exception:
        rows = {}
    for a in chunk:
        raw = rows.get(a,"0x0") or "0x0"
        try:
            eth_usd = int(raw,16)/1e18 * ETH_PRICE
        except Exception:
            eth_usd = 0
        if eth_usd >= MIN_ETH_USD:
            prefiltered.append(a)
    sys.stdout.write(f"\r  [{min(i+BATCH,len(addr_list))}/{len(addr_list)}] pre-passed: {len(prefiltered)}  ")
    sys.stdout.flush()
    if i % 1000 == 0 and i > 0:
        time.sleep(0.5)

print(f"\n  Pre-filter passed: {len(prefiltered)}")

# ── STEP 3: Ankr full multi-chain check ──────────────────────────────────────
print(f"\n{'='*60}")
print(f"STEP 3: Ankr multi-chain check (≥${MIN_TOTAL//1000}k total)")
print(f"{'='*60}")

def ankr_total(addr: str) -> float:
    if not ANKR_KEY: return 0.0
    try:
        r = requests.post(
            f"https://rpc.ankr.com/multichain/{ANKR_KEY}",
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
                  "params":{"blockchain":["eth","bsc","polygon","arbitrum","base",
                             "optimism","avalanche","fantom","gnosis"],"walletAddress":addr,
                             "onlyWhitelisted":False}},
            timeout=20)
        if r.ok:
            return float(r.json().get("result",{}).get("totalBalanceUsd","0") or 0)
    except Exception:
        pass
    return 0.0

def ens_text_record(ens_name: str, key: str) -> str:
    """Fetch a specific ENS text record via ensideas.com."""
    if not ens_name: return ""
    try:
        r = requests.get(f"https://api.ensideas.com/ens/resolve/{ens_name}", timeout=8)
        if r.ok:
            return r.json().get("records",{}).get(key,"") or ""
    except Exception:
        pass
    return ""

def farcaster_lookup(addr: str) -> dict:
    if not NEYNAR_KEY: return {}
    try:
        r = requests.get("https://api.neynar.com/v2/farcaster/user/bulk-by-address",
                         params={"addresses": addr},
                         headers={"api_key": NEYNAR_KEY}, timeout=8)
        data = r.json()
        users = list(data.values())[0] if data else []
        if users:
            u = users[0]
            fc_tw = next((a.get("username","") for a in (u.get("verified_accounts") or [])
                         if a.get("platform") in ("twitter","x")),"")
            return {
                "farcaster": u.get("username",""),
                "fc_followers": u.get("follower_count",0),
                "fc_twitter": fc_tw,
            }
    except Exception:
        pass
    return {}

whales = []
for i, addr in enumerate(prefiltered, 1):
    sys.stdout.write(f"\r  [{i}/{len(prefiltered)}] whales found: {len(whales)}  ")
    sys.stdout.flush()
    total = ankr_total(addr)
    if total < MIN_TOTAL:
        continue
    # Found a $2M+ whale with ENS social records!
    ens = ens_wallets[addr]["ens"]
    texts = ens_wallets[addr]["texts"]
    print(f"\n  ★ ${total/1e6:.2f}M  {ens}  texts={texts}")

    # Fetch specific text records
    email   = ens_text_record(ens, "email")
    twitter = ens_text_record(ens, "com.twitter")
    github  = ens_text_record(ens, "com.github")
    tg      = ens_text_record(ens, "org.telegram")

    if email:    print(f"    email: {email}")
    if twitter:  print(f"    twitter: {twitter}")
    if github:   print(f"    github: {github}")
    if tg:       print(f"    telegram: {tg}")

    # Farcaster lookup
    fc = farcaster_lookup(addr)
    if fc.get("farcaster"): print(f"    farcaster: {fc['farcaster']} ({fc.get('fc_followers',0)} followers)")

    whales.append({
        "wallet_address": addr,
        "usd_balance": total,
        "source_chain": "eth",
        "chains_active": "eth+multi",
        "ens_name": ens,
        "email": email,
        "twitter": twitter,
        "github": github,
        "telegram": tg,
        "farcaster": fc.get("farcaster",""),
        "fc_twitter": fc.get("fc_twitter",""),
        "fc_followers": fc.get("fc_followers",0),
        "outreach": "email" if email else ("twitter" if twitter else "onchain"),
        "email_source": "ENS text record" if email else "",
    })
    time.sleep(0.3)

whales.sort(key=lambda x: x["usd_balance"], reverse=True)
with open("outputs/ens_email_whales.json","w",encoding="utf-8") as f:
    json.dump(whales, f, indent=2, ensure_ascii=False)

print(f"\n\n{'='*60}")
print(f"✅  ENS email hunt complete: {len(whales)} whales with $2M+")
with_email = [w for w in whales if w.get("email")]
with_tw    = [w for w in whales if w.get("twitter") or w.get("fc_twitter")]
print(f"   With email:   {len(with_email)}")
print(f"   With Twitter: {len(with_tw)}")
print(f"   Saved → outputs/ens_email_whales.json")
print(f"\n   Top whales:")
for w in whales[:20]:
    bal   = w["usd_balance"]
    ens   = w["ens_name"]
    email = w.get("email","-")
    tw    = w.get("twitter") or w.get("fc_twitter","-")
    print(f"     ${bal/1e6:.2f}M  {ens:<30}  email={email}  tw={tw}")
