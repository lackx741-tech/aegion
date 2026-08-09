import json, sys

with open("outputs/targets_multichain.json") as f:
    data = json.load(f)

print(f"Total wallets: {len(data)}\n")

# Category distribution
cats = {}
for w in data:
    c = w["category"]
    cats[c] = cats.get(c, 0) + 1
print("=== Category Breakdown ===")
for cat, count in sorted(cats.items(), key=lambda x: -x[1]):
    print(f"  {cat:<25} {count}")

print("\n=== Spot Check — Top 10 wallets (detail) ===")
for i, w in enumerate(data[:10]):
    print(f"\n[{i+1}] {w['wallet_address']}")
    print(f"     Balance : ${w['total_usd']/1000:.0f}K")
    print(f"     Category: {w['category']}")
    print(f"     Chains  : {w['chains_active']}")
    print(f"     TX 90d  : {w['tx_90d']}")
    print(f"     Idle    : {w['months_idle']:.0f} months")
    print(f"     Stable% : {w['stable_pct']}%")
    print(f"     DeFi    : {w['defi_used'] or 'none'}")
    print(f"     Msg     : {w['msg_short']}")

print("\n=== Idle months distribution ===")
idle_buckets = {"0-1mo": 0, "1-3mo": 0, "3-6mo": 0, "6-12mo": 0, "12mo+": 0, "unknown(99)": 0}
for w in data:
    m = w["months_idle"]
    if m == 99: idle_buckets["unknown(99)"] += 1
    elif m <= 1: idle_buckets["0-1mo"] += 1
    elif m <= 3: idle_buckets["1-3mo"] += 1
    elif m <= 6: idle_buckets["3-6mo"] += 1
    elif m <= 12: idle_buckets["6-12mo"] += 1
    else: idle_buckets["12mo+"] += 1
for k, v in idle_buckets.items():
    print(f"  {k:<12} {v} wallets")

print("\n=== TX 90d distribution ===")
tx_buckets = {"0 tx": 0, "1-5 tx": 0, "6-20 tx": 0, "21-50 tx": 0, "50+ tx": 0}
for w in data:
    t = w["tx_90d"]
    if t == 0: tx_buckets["0 tx"] += 1
    elif t <= 5: tx_buckets["1-5 tx"] += 1
    elif t <= 20: tx_buckets["6-20 tx"] += 1
    elif t <= 50: tx_buckets["21-50 tx"] += 1
    else: tx_buckets["50+ tx"] += 1
for k, v in tx_buckets.items():
    print(f"  {k:<10} {v} wallets")

print("\n=== Balance distribution ===")
bal_buckets = {"10K-50K": 0, "50K-200K": 0, "200K-500K": 0, "500K-1M": 0, "1M-5M": 0}
for w in data:
    b = w["total_usd"]
    if b < 50000: bal_buckets["10K-50K"] += 1
    elif b < 200000: bal_buckets["50K-200K"] += 1
    elif b < 500000: bal_buckets["200K-500K"] += 1
    elif b < 1000000: bal_buckets["500K-1M"] += 1
    else: bal_buckets["1M-5M"] += 1
for k, v in bal_buckets.items():
    print(f"  {k:<12} {v} wallets")

# Random samples from different categories
print("\n=== Random samples per category ===")
import random
random.seed(42)
seen_cats = set()
for w in random.sample(data, len(data)):
    cat = w["category"]
    if cat not in seen_cats:
        seen_cats.add(cat)
        print(f"\n  [{cat}]")
        print(f"  Addr   : {w['wallet_address']}")
        print(f"  Balance: ${w['total_usd']/1000:.0f}K | Idle: {w['months_idle']:.0f}mo | TX90: {w['tx_90d']} | Chains: {w['chains_active']}")
        print(f"  Stable%: {w['stable_pct']}% | DeFi: {w['defi_used'] or 'none'}")
