"""
verify_evm_whales.py
Reads evm_whales_from_log.json (275 candidates from log), checks each via Ankr,
keeps those with $2M+ total multi-chain portfolio, combines with TRON records,
saves combined_whales.json for email_enricher.py
"""
import sys, os, json, time, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv(".env")

ANKR_KEY   = os.getenv("ANKR_KEY","")
ALCHEMY_KEY= os.getenv("ALCHEMY_KEYS","").split(",")[0].strip() or os.getenv("ALCHEMY_KEY","")
MIN_USD    = 2_000_000

def ankr_balance(addr: str) -> float:
    """Get total USD balance across all chains via Ankr."""
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

def eth_balance_usd(addr: str) -> float:
    """Quick ETH balance check via Alchemy."""
    if not ALCHEMY_KEY: return 0.0
    try:
        r = requests.post(
            f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}",
            json={"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":[addr,"latest"]},
            timeout=10)
        eth = int(r.json().get("result","0x0"), 16) / 1e18
        # Get ETH price
        r2 = requests.get(
            "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
            timeout=10)
        eth_price = r2.json().get("ethereum",{}).get("usd", 2000)
        return eth * eth_price
    except Exception:
        return 0.0

# Load candidate EVM addresses from log extraction
with open("evm_whales_from_log.json") as f:
    candidates = json.load(f)

# Deduplicate
seen = set()
unique_candidates = []
for c in candidates:
    if c["wallet_address"] not in seen:
        seen.add(c["wallet_address"])
        unique_candidates.append(c)

print(f"EVM candidates to verify: {len(unique_candidates)}")
print(f"ANKR_KEY: {'OK' if ANKR_KEY else 'MISSING'}")
print()

verified_evm = []
for i, c in enumerate(unique_candidates, 1):
    addr = c["wallet_address"]
    print(f"[{i}/{len(unique_candidates)}] {addr}... ", end="", flush=True)

    total = ankr_balance(addr)
    if total < 200_000:
        # Quick check shows very low balance - skip
        print(f"  ${total/1e3:.0f}K - skip")
        continue

    print(f"  ${total/1e6:.2f}M", end=" ", flush=True)

    if total >= MIN_USD:
        verified_evm.append({
            "wallet_address": addr,
            "usd_balance": total,
            "source_chain": "eth",
            "chains_active": "eth",
            "ens_name": "",
            "twitter_handle": "",
            "farcaster_user": "",
            "email": "",
            "ens_email": "",
            "whale_category": "High-Value Whale",
            "outreach_channel": "onchain",
        })
        print(f" ✓ WHALE #{len(verified_evm)}")
    else:
        print(f"  < $2M - skip")

    if i % 10 == 0:
        time.sleep(1)

print(f"\n✅  Verified EVM whales: {len(verified_evm)}")

# Load TRON records
with open("outputs/whale_data.json") as f:
    tron_records = json.load(f)
print(f"TRON records: {len(tron_records)}")

# Combine
combined = tron_records + verified_evm
combined.sort(key=lambda x: float(x.get("usd_balance",0)), reverse=True)
top50 = combined[:50]

with open("outputs/combined_whales.json", "w", encoding="utf-8") as f:
    json.dump(combined, f, indent=2, ensure_ascii=False)

print(f"\n✅  Combined: {len(combined)} whales → saved outputs/combined_whales.json")
print(f"    TRON: {len(tron_records)}  EVM: {len(verified_evm)}")
print(f"\n    Top 10:")
for w in combined[:10]:
    addr = w.get("wallet_address","")
    bal = float(w.get("usd_balance",0))
    chain = w.get("source_chain","?")
    print(f"      {addr[:18]}...  ${bal/1e6:.2f}M  [{chain}]")
