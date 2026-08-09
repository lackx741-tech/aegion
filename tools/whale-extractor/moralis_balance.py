"""moralis_balance.py — 12-chain true portfolio for existing whales"""
import sys, os, json, csv, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from whale_extractor import fetch_networth_moralis

with open("whales_ALL_final.json", encoding="utf-8") as f:
    whales = json.load(f)

results = []
for i, w in enumerate(whales, 1):
    addr    = w.get("addr","")
    display = w.get("display_name","") or w.get("farcaster","")
    old_usd = w.get("total_usd",0)

    usd, chains = fetch_networth_moralis(addr)
    true_usd = max(usd, old_usd)

    print(f"[{i:02d}] {display[:28]:<28}  old=${old_usd:>10,.0f}  moralis=${usd:>10,.0f}  chains=[{chains}]")
    results.append({**w, "moralis_usd": usd, "true_usd": true_usd, "chains_active": chains})
    time.sleep(0.2)

results.sort(key=lambda x: x["true_usd"], reverse=True)

with open("whales_true_portfolio.json","w",encoding="utf-8") as f:
    json.dump(results, f, indent=2, default=str)

with open("whales_true_portfolio.csv","w",newline="",encoding="utf-8") as f:
    cw = csv.writer(f)
    cw.writerow(["Rank","True_USD","Moralis_USD","Old_USD","Name","Farcaster","Twitter","Chains","Etherscan","Address"])
    for i, r in enumerate(results, 1):
        fc = r.get("farcaster","")
        tw = r.get("twitter","") or ""
        cw.writerow([i, "${:,.0f}".format(r["true_usd"]), "${:,.0f}".format(r["moralis_usd"]),
                     "${:,.0f}".format(r.get("total_usd",0)),
                     r.get("display_name",""), "@"+fc if fc else "", "@"+tw if tw else "",
                     r.get("chains_active",""), f"https://etherscan.io/address/{r.get('addr','')}",
                     r.get("addr","")])

print(f"\nSaved whales_true_portfolio.csv")
above_2m = [r for r in results if r["true_usd"] >= 2_000_000]
print(f"$2M+ wallets: {len(above_2m)}")
for r in results[:10]:
    print(f"  ${r['true_usd']:>12,.0f}  {r.get('display_name','')[:25]}")
