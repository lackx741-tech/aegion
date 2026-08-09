"""Debug: check what Moralis actually returns for top Farcaster wallets"""
import requests, os, json
from dotenv import load_dotenv
load_dotenv(".env")

NEYNAR_KEY  = os.getenv("NEYNAR_KEY","")
MORALIS_KEY = os.getenv("MORALIS_KEY","")

# Get top 10 Farcaster users from ethereum channel
r = requests.get("https://api.neynar.com/v2/farcaster/channel/followers",
    params={"id":"ethereum","limit":50},
    headers={"api_key": NEYNAR_KEY},
    timeout=15)
users = r.json().get("users",[])

print(f"Got {len(users)} users")
checked = 0
for u in users:
    addrs = (u.get("verified_addresses") or {}).get("eth_addresses") or []
    if not addrs:
        continue
    addr = addrs[0]
    fc   = u.get("username","?")
    foll = u.get("follower_count",0)

    # Moralis net worth
    r2 = requests.get(
        f"https://deep-index.moralis.io/api/v2.2/wallets/{addr}/net-worth",
        params={"exclude_spam":"true"},
        headers={"X-API-Key": MORALIS_KEY},
        timeout=12)
    if r2.status_code == 200:
        nw = float(r2.json().get("total_networth_usd") or 0)
        print(f"@{fc:<20} {foll:<7} ${nw:>12,.2f}")
    else:
        print(f"@{fc:<20} {foll:<7} ERROR {r2.status_code}: {r2.text[:100]}")
        break  # show first error only
    checked += 1
    if checked >= 15:
        break
