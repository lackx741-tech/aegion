"""ankr_portfolio.py — True multi-chain portfolio via Ankr (8 chains)"""
import sys, os, json, csv, time, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv(".env")

ANKR_KEY = os.getenv("ANKR_KEY","")
CHAINS = ["eth","bsc","polygon","arbitrum","base","optimism","avalanche","fantom","gnosis"]

def ankr_balance(addr):
    try:
        r = requests.post(
            f"https://rpc.ankr.com/multichain/{ANKR_KEY}",
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
                  "params":{"blockchain":CHAINS,"walletAddress":addr,"onlyWhitelisted":False}},
            timeout=25)
        if r.status_code == 200:
            res = r.json().get("result",{})
            total = float(res.get("totalBalanceUsd","0") or 0)
            active = list({a["blockchain"] for a in res.get("assets",[]) if float(a.get("balanceUsd","0") or 0) >= 100})
            top = sorted(res.get("assets",[]), key=lambda x: float(x.get("balanceUsd","0") or 0), reverse=True)[:5]
            top_str = ", ".join(f"{a['tokenSymbol']}(${float(a.get('balanceUsd','0')):,.0f})" for a in top if float(a.get("balanceUsd","0") or 0) > 0)
            return round(total,2), sorted(active), top_str
    except Exception as e:
        pass
    return 0.0, [], ""

with open("whales_ALL_final.json", encoding="utf-8") as f:
    whales = json.load(f)

print(f"Ankr 9-chain scan for {len(whales)} whales...\n")
results = []

for i, w in enumerate(whales, 1):
    addr = w.get("addr","")
    display = w.get("display_name","") or w.get("farcaster","")
    old = w.get("total_usd",0)

    usd, chains, top_assets = ankr_balance(addr)
    true_usd = max(usd, old)

    diff = usd - old
    flag = "  ▲ BIGGER!" if usd > old * 1.1 else ""
    print(f"[{i:02d}] {display[:25]:<25}  old=${old:>9,.0f}  ankr=${usd:>12,.0f}  chains={chains}{flag}")
    if top_assets:
        print(f"      Assets: {top_assets[:80]}")

    results.append({**w, "ankr_usd": usd, "true_usd": true_usd,
                    "chains_active": ", ".join(chains), "top_assets": top_assets})
    time.sleep(0.3)

results.sort(key=lambda x: x["true_usd"], reverse=True)

with open("whales_ankr_portfolio.json","w",encoding="utf-8") as f:
    json.dump(results, f, indent=2, default=str)

with open("whales_ankr_portfolio.csv","w",newline="",encoding="utf-8") as f:
    cw = csv.writer(f)
    cw.writerow(["Rank","True_USD_9chains","Old_USD","Name","Chains","Top_Assets",
                 "Farcaster","Twitter","Etherscan","Address"])
    for i, r in enumerate(results, 1):
        fc = r.get("farcaster","")
        tw = r.get("twitter","") or ""
        cw.writerow([i, "${:,.0f}".format(r["true_usd"]), "${:,.0f}".format(r.get("total_usd",0)),
                     r.get("display_name",""), r.get("chains_active",""), r.get("top_assets",""),
                     "@"+fc if fc else "", "@"+tw if tw else "",
                     f"https://etherscan.io/address/{r.get('addr','')}",
                     r.get("addr","")])

print(f"\n{'='*70}")
above_2m = [r for r in results if r["true_usd"] >= 2_000_000]
above_500k = [r for r in results if r["true_usd"] >= 500_000]
print(f"$2M+  wallets: {len(above_2m)}")
print(f"$500k+ wallets: {len(above_500k)}")
print(f"\nFull ranking:")
for i, r in enumerate(results,1):
    fc = r.get("farcaster","")
    tw = r.get("twitter","") or ""
    print(f"  {i:2}. ${r['true_usd']:>12,.0f}  {r.get('display_name','')[:22]:<22}  @{fc:<20}  X=@{tw}")
