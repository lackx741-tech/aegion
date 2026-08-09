"""
crypto_whale_scan.py — Pure crypto hodlers via Ankr getTokenHolders.
Target: High balance, 0-15 NFTs, dormant, old wallets.
Conversion score system for easy-to-convert ranking.
"""
import sys, os, json, time, requests, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv; load_dotenv(".env")

ALCHEMY_KEY   = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip()
ANKR_KEY      = os.getenv("ANKR_KEY","")
ETHERSCAN_KEY = os.getenv("ETHERSCAN_KEY","")

ANKR_URL  = f"https://rpc.ankr.com/multichain/{ANKR_KEY}"
ALCHEMY_URL = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"

MIN_USD  = 2_000_000
MAX_NFTS = 15
TARGET   = 100

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
}

SEED_TOKENS = [
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDC",  1.0,   6),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT",  1.0,   6),
    ("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "WBTC",  105000.0, 8),
    ("0xae7ab96520de3a18e5e111b5eaab095312d7fe84", "stETH", 3800.0,  18),
    ("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "WETH",  3800.0,  18),
    ("0x6b175474e89094c44da98b954eedeac495271d0f", "DAI",   1.0,   18),
]

def is_contract(addr):
    """Check if address is a smart contract (skip contracts)."""
    try:
        r = requests.post(ALCHEMY_URL,
            json={"jsonrpc":"2.0","id":1,"method":"eth_getCode",
                  "params":[addr,"latest"]}, timeout=8)
        if r.ok:
            code = r.json().get("result","0x")
            return len(code) > 4  # contracts have code > "0x"
    except Exception:
        pass
    return False

def ankr_token_holders(token_addr, limit=500):
    """Ankr ankr_getTokenHolders — balance is already human-readable."""
    holders = []
    page_token = ""
    while len(holders) < limit:
        body = {
            "jsonrpc": "2.0", "id": 1,
            "method": "ankr_getTokenHolders",
            "params": {
                "blockchain": "eth",
                "contractAddress": token_addr,
                "pageSize": 100,
            }
        }
        if page_token:
            body["params"]["pageToken"] = page_token
        try:
            r = requests.post(ANKR_URL, json=body, timeout=20)
            if not r.ok:
                break
            data = r.json().get("result", {})
            batch = data.get("holders", [])
            if not batch:
                break
            for h in batch:
                addr = h.get("holderAddress","").lower()
                # balance is already human-readable (decimals already applied)
                bal_human = float(h.get("balance","0") or 0)
                if addr and addr not in SKIP:
                    holders.append((addr, bal_human))
            page_token = data.get("nextPageToken","")
            if not page_token:
                break
        except Exception as e:
            break
        time.sleep(0.3)
    return holders

def ankr_total_balance(addr):
    """Multi-chain total USD balance."""
    try:
        r = requests.post(ANKR_URL,
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
                  "params":{"blockchain":["eth","bsc","polygon","arbitrum",
                             "base","optimism","avalanche","fantom","gnosis"],
                             "walletAddress":addr,"onlyWhitelisted":False}},
            timeout=20)
        if r.ok:
            return float(r.json().get("result",{}).get("totalBalanceUsd","0") or 0)
    except Exception:
        pass
    return 0.0

def get_nft_count(addr):
    """NFT count via Alchemy (just total, fast)."""
    try:
        r = requests.get(
            f"{ALCHEMY_URL}/getNFTs",
            params={"owner":addr,"withMetadata":"false","pageSize":1},
            timeout=10)
        if r.ok:
            return int(r.json().get("totalCount",0) or 0)
    except Exception:
        pass
    return 999

def get_wallet_age_and_tx(addr):
    """First tx timestamp + recent tx count via Etherscan V2."""
    age_months = 0.0
    tx_90d = 99
    try:
        # Etherscan V2
        r = requests.get(
            f"https://api.etherscan.io/v2/api",
            params={"chainid":1,"module":"account","action":"txlist",
                    "address":addr,"startblock":0,"endblock":99999999,
                    "page":1,"offset":50,"sort":"asc",
                    "apikey":ETHERSCAN_KEY},
            timeout=12)
        if r.ok:
            txs = r.json().get("result",[])
            if isinstance(txs, list) and txs:
                first_ts = int(txs[0].get("timeStamp",0))
                age_months = round((time.time() - first_ts) / (86400*30.44), 1)
                cutoff = int(time.time()) - 90*86400
                # get recent — fetch desc
                r2 = requests.get(
                    f"https://api.etherscan.io/v2/api",
                    params={"chainid":1,"module":"account","action":"txlist",
                            "address":addr,"startblock":0,"endblock":99999999,
                            "page":1,"offset":50,"sort":"desc",
                            "apikey":ETHERSCAN_KEY},
                    timeout=12)
                if r2.ok:
                    recent_txs = r2.json().get("result",[])
                    if isinstance(recent_txs, list):
                        tx_90d = len([t for t in recent_txs
                                     if int(t.get("timeStamp",0)) >= cutoff])
    except Exception:
        pass
    return age_months, tx_90d

def conversion_score(balance, nft_count, age_months, tx_90d):
    score = 0
    # Balance (25 pts)
    if balance >= 50_000_000: score += 25
    elif balance >= 20_000_000: score += 20
    elif balance >= 10_000_000: score += 15
    elif balance >= 5_000_000: score += 10
    else: score += 5

    # NFT count — LOWER is better (30 pts)
    if nft_count == 0: score += 30
    elif nft_count <= 3: score += 25
    elif nft_count <= 8: score += 15
    elif nft_count <= 15: score += 8

    # Wallet age — OLDER is better (25 pts)
    if age_months >= 72: score += 25
    elif age_months >= 48: score += 20
    elif age_months >= 36: score += 15
    elif age_months >= 24: score += 10
    elif age_months >= 12: score += 5

    # Dormancy — LESS tx is better (20 pts)
    if tx_90d == 0: score += 20
    elif tx_90d <= 2: score += 15
    elif tx_90d <= 5: score += 10
    elif tx_90d <= 10: score += 5

    return score

def classify(nft_count, age_months, tx_90d, balance):
    if nft_count == 0 and tx_90d == 0 and age_months >= 36:
        return "Pure HODL OG"
    elif nft_count == 0 and tx_90d <= 3:
        return "Pure Crypto"
    elif age_months >= 60 and tx_90d <= 5:
        return "OG Hodler"
    elif tx_90d == 0 and balance >= 10_000_000:
        return "Sleeping Giant"
    elif nft_count <= 5:
        return "Low-NFT Whale"
    return "Mixed"

# ── STEP 1: Collect holders ─────────────────────────────────────────────────
print("="*60)
print("STEP 1: Fetching top holders via Ankr")
print("="*60)

seen = set()
candidates = []

for token_addr, name, price, decimals in SEED_TOKENS:
    print(f"\n  {name} ({token_addr[:10]}...):", end=" ", flush=True)
    holders = ankr_token_holders(token_addr, limit=400)
    added = 0
    for addr, bal_human in holders:
        if addr in seen or addr in SKIP:
            continue
        try:
            # bal_human already in token units (e.g. USDC, WBTC)
            est_usd = bal_human * price
            if est_usd >= 800_000:
                # skip obvious contracts (top 50 holders are usually exchanges/contracts)
                seen.add(addr)
                candidates.append(addr)
                added += 1
        except Exception:
            pass
    print(f"{len(holders)} holders → {added} added (total candidates: {len(candidates)})")
    time.sleep(0.5)

print(f"\nTotal unique candidates: {len(candidates)}")
if not candidates:
    print("ERROR: No candidates. Check ANKR_KEY or network.")
    sys.exit(1)

# ── STEP 2: Enrich ──────────────────────────────────────────────────────────
print(f"\n{'='*60}")
print("STEP 2: Enriching (multi-chain balance + NFTs + age + activity)")
print("="*60)

results = []
lock = threading.Lock()
done = [0]

def enrich(addr):
    try:
        total = ankr_total_balance(addr)
        if total < MIN_USD:
            return None
        nft_count = get_nft_count(addr)
        if nft_count > MAX_NFTS:
            return None
        age_months, tx_90d = get_wallet_age_and_tx(addr)
        score = conversion_score(total, nft_count, age_months, tx_90d)
        cat   = classify(nft_count, age_months, tx_90d, total)
        return {
            "wallet_address": addr,
            "usd_balance": round(total, 2),
            "nft_count": nft_count,
            "age_months": age_months,
            "tx_last_90d": tx_90d,
            "conversion_score": score,
            "category": cat,
            "source_chain": "eth",
        }
    except Exception:
        return None

with ThreadPoolExecutor(max_workers=4) as pool:
    futures = {pool.submit(enrich, a): a for a in candidates}
    for fut in as_completed(futures):
        done[0] += 1
        rec = fut.result()
        if rec:
            with lock:
                results.append(rec)
            n   = rec["nft_count"]
            b   = rec["usd_balance"]
            age = rec["age_months"]
            sc  = rec["conversion_score"]
            cat = rec["category"]
            print(f"  [{done[0]:>3}/{len(candidates)}] ✓ ${b/1e6:>6.1f}M | "
                  f"NFTs={n:<3} | {age:>4.0f}mo | tx90={rec['tx_last_90d']:<3} "
                  f"| score={sc:<3} | {cat}")
        elif done[0] % 25 == 0:
            sys.stdout.write(f"\r  [{done[0]:>3}/{len(candidates)}] "
                           f"found={len(results)}...   ")
            sys.stdout.flush()
        time.sleep(0.05)

# ── STEP 3: Rank + Save ──────────────────────────────────────────────────────
results.sort(key=lambda x: x["conversion_score"], reverse=True)
top100 = results[:TARGET]

with open("outputs/crypto_whales_100.json","w",encoding="utf-8") as f:
    json.dump(top100, f, indent=2, ensure_ascii=False)

import csv
with open("outputs/crypto_whales_100.csv","w",newline="",encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(top100[0].keys()) if top100 else [],
                       extrasaction="ignore")
    if top100:
        w.writeheader(); w.writerows(top100)

# ── Report ────────────────────────────────────────────────────────────────────
print(f"\n\n{'='*60}")
print(f"FINAL TARGETS: {len(top100)}")
print(f"{'='*60}")

cats = {}
for r in top100:
    cats[r["category"]] = cats.get(r["category"],0) + 1
for k,v in sorted(cats.items(), key=lambda x:-x[1]):
    print(f"  {k:<20} {v}")

zero_nft = sum(1 for r in top100 if r["nft_count"]==0)
dormant  = sum(1 for r in top100 if r["tx_last_90d"]==0)
score80  = sum(1 for r in top100 if r["conversion_score"]>=80)
total_v  = sum(r["usd_balance"] for r in top100)

print(f"\n  Zero NFTs:         {zero_nft}")
print(f"  Fully dormant:     {dormant}")
print(f"  Score ≥80:         {score80}")
print(f"  Total value:       ${total_v/1e9:.2f}B")

print(f"\n{'#':<4}{'Address':<22}{'Balance':>10}{'NFTs':>5}"
      f"{'Age':>7}{'90d':>5}{'Score':>6}  Category")
print("  "+"-"*80)
for i,r in enumerate(top100[:50],1):
    print(f"  {i:<3} {r['wallet_address'][:18]:<22}"
          f"${r['usd_balance']/1e6:>7.1f}M"
          f"{r['nft_count']:>5}"
          f"{r['age_months']:>6.0f}mo"
          f"{r['tx_last_90d']:>5}"
          f"{r['conversion_score']:>6}  {r['category']}")

print(f"\nSaved → outputs/crypto_whales_100.json + .csv")
