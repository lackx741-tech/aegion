"""
enrich_twitter.py — Twitter handle enrichment for whale_scan.json
Uses Neynar user/by_username to get full verified_accounts data
"""
import sys, os, json, time, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)
from dotenv import load_dotenv
load_dotenv(".env")

NEYNAR_KEY = os.getenv("NEYNAR_KEY", "")
IN_FILE    = "whale_scan.json"
OUT_FILE   = "whale_scan_enriched.json"

with open(IN_FILE, encoding="utf-8") as f:
    whales = json.load(f)

print(f"Loaded {len(whales)} whales from {IN_FILE}")
print(f"Neynar key: {'SET' if NEYNAR_KEY else 'MISSING'}\n")

def get_fc_profile(username):
    """Get full Farcaster profile by username including verified_accounts"""
    try:
        r = requests.get(
            "https://api.neynar.com/v2/farcaster/user/by_username",
            params={"username": username},
            headers={"api_key": NEYNAR_KEY, "accept": "application/json"},
            timeout=10
        )
        data = r.json()
        user = data.get("user") or {}
        return user
    except Exception as e:
        print(f"  ERROR for @{username}: {e}")
        return {}

def get_fc_by_address(addr):
    """Fallback: look up Farcaster profile by ETH address"""
    try:
        r = requests.get(
            "https://api.neynar.com/v2/farcaster/user/bulk-by-address",
            params={"addresses": addr},
            headers={"api_key": NEYNAR_KEY, "accept": "application/json"},
            timeout=10
        )
        data = r.json()
        # Response is {addr: [user, ...]}
        for users in data.values():
            if users:
                return users[0]
        return {}
    except Exception as e:
        print(f"  ERROR for addr {addr[:12]}: {e}")
        return {}

enriched = []
for w in whales:
    fc_handle = w.get("farcaster", "")
    addr      = w.get("addr", "")
    print(f"  ${w['total_usd']:>12,.0f}  @{fc_handle:<20}", end="  ", flush=True)

    user = {}
    if fc_handle:
        user = get_fc_profile(fc_handle)
    if not user and addr:
        user = get_fc_by_address(addr)

    # Extract Twitter from verified_accounts
    verified = user.get("verified_accounts") or []
    tw = next((a.get("username","") for a in verified if a.get("platform") in ("twitter", "x")), "")

    # Also check verified_addresses for extra ETH wallets
    extra_addrs = (user.get("verified_addresses") or {}).get("eth_addresses") or []

    # Get profile details
    bio = (user.get("profile") or {}).get("bio", {}).get("text", "") or w.get("bio", "")
    followers = user.get("follower_count", 0) or w.get("followers", 0)
    display   = user.get("display_name", "") or w.get("display_name", "")
    pfp       = (user.get("pfp") or {}).get("url","") or w.get("pfp","")

    updated = {**w,
               "twitter":      tw,
               "display_name": display,
               "bio":          bio[:200],
               "followers":    followers,
               "pfp":          pfp,
               "extra_wallets": [a for a in extra_addrs if a.lower() != addr.lower()],
               "warpcast":     f"https://warpcast.com/{fc_handle}" if fc_handle else w.get("warpcast",""),
    }
    enriched.append(updated)
    status = f"tw=@{tw}" if tw else "tw=NONE"
    print(f"{status}  followers={followers:,}")
    time.sleep(0.3)

with open(OUT_FILE, "w", encoding="utf-8") as f:
    json.dump(enriched, f, indent=2, default=str)

print(f"\n{'='*60}")
print(f"  Saved {len(enriched)} enriched whales → {OUT_FILE}")
with_tw = sum(1 for w in enriched if w.get("twitter"))
print(f"  With Twitter: {with_tw}/{len(enriched)}")
print(f"\n  Full list:")
for w in enriched:
    tw  = w.get("twitter") or "-"
    fc  = w.get("farcaster","?")
    ens = w.get("ens") or w["addr"][:14]
    print(f"    ${w['total_usd']:>12,.0f}  fc=@{fc:<22}  tw=@{tw:<20}  wc={w.get('warpcast','')}")
