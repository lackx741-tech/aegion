"""
moralis_recheck.py
Re-check all whales with Moralis 12-chain net-worth
+ GitHub commit email extraction
"""
import sys, os, json, time, csv
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from whale_extractor import fetch_networth_moralis, fetch_ens_records, fetch_arkham_identity
from osint_bot import fetch_social_profile

with open("whales_ALL_final.json", encoding="utf-8") as f:
    whales = json.load(f)

print(f"Re-enriching {len(whales)} whales with Moralis 12-chain + GitHub commit emails\n")
print(f"{'='*70}")

results = []

for i, w in enumerate(whales, 1):
    addr    = w.get("addr","")
    fc      = w.get("farcaster","")
    tw      = w.get("twitter","") or ""
    display = w.get("display_name","") or fc
    old_bal = w.get("total_usd",0)

    print(f"\n[{i:02d}/{len(whales)}] {display[:30]}")
    print(f"         Old balance: ${old_bal:>12,.0f}  ({fc})")

    # Moralis 12-chain net-worth
    moralis_usd, chains_active = 0.0, ""
    try:
        moralis_usd, chains_active = fetch_networth_moralis(addr)
        print(f"         Moralis 12ch: ${moralis_usd:>12,.0f}  [{chains_active}]")
    except Exception as e:
        print(f"         Moralis err : {e}")

    # GitHub commit email (from public events API)
    github_email = ""
    github_name  = ""
    github_commit_emails = []
    if tw or fc:
        handle = tw or fc
        try:
            profile = fetch_social_profile(handle)
            gh = profile.get("platforms", {}).get("github", {})
            if gh.get("email"):
                github_email = gh["email"]
                print(f"         GitHub email: {github_email}")
            if gh.get("commit_emails"):
                github_commit_emails = gh["commit_emails"]
                print(f"         Commit emails: {', '.join(github_commit_emails[:3])}")
            if gh.get("name"):
                github_name = gh["name"]
        except Exception as e:
            print(f"         GitHub err: {e}")
        time.sleep(0.5)

    best_email = (
        w.get("email","") or
        github_email or
        (github_commit_emails[0] if github_commit_emails else "")
    )

    true_usd = max(moralis_usd, old_bal)

    results.append({
        "rank":           i,
        "addr":           addr,
        "display_name":   display,
        "farcaster":      fc,
        "twitter":        tw,
        "old_usd":        old_bal,
        "moralis_usd":    moralis_usd,
        "true_usd":       true_usd,
        "chains_active":  chains_active,
        "email":          best_email,
        "github_email":   github_email,
        "commit_emails":  ", ".join(github_commit_emails[:3]),
        "github_name":    github_name,
        "bio":            (w.get("bio","") or "")[:200],
        "followers":      w.get("followers",0),
        "warpcast":       f"https://warpcast.com/{fc}" if fc else "",
        "twitter_url":    f"https://twitter.com/{tw}" if tw else "",
        "etherscan":      f"https://etherscan.io/address/{addr}",
    })

# Sort by true_usd
results.sort(key=lambda x: x["true_usd"], reverse=True)

# Save JSON
with open("whales_moralis_enriched.json","w",encoding="utf-8") as f:
    json.dump(results, f, indent=2, default=str)

# Save CSV
with open("whales_moralis_enriched.csv","w",newline="",encoding="utf-8") as f:
    cw = csv.writer(f)
    cw.writerow(["Rank","True_USD_12chains","Old_USD_4chains","Display_Name",
                 "Email","GitHub_Email","Commit_Emails",
                 "Chains_Active","Farcaster","Twitter",
                 "Warpcast","Twitter_URL","Etherscan","Followers","Address"])
    for r in results:
        fc = r["farcaster"]
        tw = r["twitter"] or ""
        cw.writerow([
            r["rank"],
            "${:,.0f}".format(r["true_usd"]),
            "${:,.0f}".format(r["old_usd"]),
            r["display_name"],
            r["email"],
            r["github_email"],
            r["commit_emails"],
            r["chains_active"],
            "@"+fc if fc else "",
            "@"+tw if tw else "",
            r["warpcast"],
            r["twitter_url"],
            r["etherscan"],
            r["followers"],
            r["addr"],
        ])

print(f"\n{'='*70}")
print(f"RESULTS saved: whales_moralis_enriched.csv")
print(f"{'='*70}\n")
print(f"{'Rank':<4} {'True USD (12ch)':>16} {'Old (4ch)':>12} {'Name':<25} {'Email'}")
print("-"*85)
for r in results:
    tw = r["twitter"] or ""
    print(f"  {r['rank']:<3} ${r['true_usd']:>13,.0f}  ${r['old_usd']:>10,.0f}  {r['display_name'][:23]:<25} {r['email'] or '—'}")

with_email = [r for r in results if r["email"]]
above_2m   = [r for r in results if r["true_usd"] >= 2_000_000]
print(f"\nTotal: {len(results)} | $2M+: {len(above_2m)} | With email: {len(with_email)}")
