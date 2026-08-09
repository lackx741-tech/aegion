"""
quick_scan.py — Farcaster + ENS + Balance, no heavy OSINT
Public data only: on-chain balance + voluntary social profiles
"""
import sys, os, json, time, re, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
os.chdir(SCRIPT_DIR)

from dotenv import load_dotenv
load_dotenv(".env")

NEYNAR_KEY   = os.getenv("NEYNAR_KEY", "")
ALCHEMY_KEYS = [k.strip() for k in os.getenv("ALCHEMY_KEYS","").split(",") if k.strip()]
ALCHEMY_KEY  = ALCHEMY_KEYS[0] if ALCHEMY_KEYS else os.getenv("ALCHEMY_KEY","")
MORALIS_KEY  = os.getenv("MORALIS_KEY", "")

MIN_USD        = 5_000    # $5k+ on mainnet hot wallet = active DeFi user
FOLLOWER_TOP_N = 5000    # check top 5000 most-followed Farcaster users
TARGET         = 200     # max output
OUT_FILE       = "whale_scan.json"

ETH_PRICE = 1934.0
try:
    r = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", timeout=5)
    ETH_PRICE = float(r.json()["ethereum"]["usd"])
except Exception:
    pass

CHANNELS = ["ethereum","defi","base","crypto","nft","uniswap","aave","bitcoin","solana","web3","stablecoin"]

results = []
seen    = set()

# ── Step 1: Collect Farcaster users with verified ETH addresses ───────────────
print(f"\n{'='*60}")
print("  STEP 1: Farcaster channels → verified ETH addresses")
print(f"{'='*60}")

all_candidates = []
for ch in CHANNELS:
    cursor = ""
    pages  = 0
    print(f"  #{ch}...", end="", flush=True)
    while pages < 3:
        params = {"id": ch, "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        try:
            r = requests.get("https://api.neynar.com/v2/farcaster/channel/followers",
                             params=params,
                             headers={"api_key": NEYNAR_KEY, "accept": "application/json"},
                             timeout=15)
            data  = r.json()
            users = data.get("users") or []
        except Exception:
            break
        for u in users:
            eth_addrs = (u.get("verified_addresses") or {}).get("eth_addresses") or []
            for addr in eth_addrs:
                al = addr.lower()
                if al in seen:
                    continue
                seen.add(al)
                tw_verified = next((a.get("username","")
                                    for a in (u.get("verified_accounts") or [])
                                    if a.get("platform") in ("twitter", "x")), "")
                all_candidates.append({
                    "addr":      addr,
                    "farcaster": u.get("username",""),
                    "display":   u.get("display_name",""),
                    "bio":       (u.get("profile") or {}).get("bio",{}).get("text","")[:120],
                    "followers": u.get("follower_count", 0),
                    "twitter":   tw_verified,
                    "pfp":       (u.get("pfp") or {}).get("url",""),
                })
        cursor = (data.get("next") or {}).get("cursor","")
        pages += 1
        if not cursor or not users:
            break
        time.sleep(0.15)
    print(f" {len(all_candidates)} total")

print(f"\n  Total unique Farcaster wallets: {len(all_candidates)}")

# ── Step 2: Sort by followers → take top N → Moralis net worth ───────────────
print(f"\n{'='*60}")
print(f"  STEP 2: Top {FOLLOWER_TOP_N} by followers → Moralis full net worth")
print(f"{'='*60}")

# Sort by follower count descending — high-follower = OG/influencer/likely whale
top_cands = sorted(all_candidates, key=lambda x: x["followers"], reverse=True)[:FOLLOWER_TOP_N]
print(f"  Top follower range: {top_cands[0]['followers']:,} → {top_cands[-1]['followers']:,}")

_TOKENS = [
    # (contract, decimals, symbol, approx_usd_per_token)
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6,  "USDC",  1.0),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7", 6,  "USDT",  1.0),
    ("0x6b175474e89094c44da98b954eedeac495271d0f", 18, "DAI",   1.0),
    ("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", 8,  "WBTC",  108000.0),
    ("0xae7ab96520de3a18e5e111b5eaab095312d7fe84", 18, "stETH", ETH_PRICE),
    ("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", 18, "wstETH",ETH_PRICE * 1.18),
    ("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18, "WETH",  ETH_PRICE),
    ("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", 18, "UNI",   8.0),
    ("0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", 18, "AAVE",  200.0),
    ("0x514910771af9ca656af840dff83e8264ecf986ca", 18, "LINK",  16.0),
]
BAL_SIG = "0x70a08231"

def _batch_portfolio(addrs):
    """Single Alchemy batch: ETH + 10 major tokens for a list of addresses."""
    url = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
    calls = []
    for a in addrs:
        calls.append({"jsonrpc":"2.0","id":f"eth_{a}","method":"eth_getBalance","params":[a,"latest"]})
        pad = a[2:].lower().zfill(64)
        for contract,_,sym,_ in _TOKENS:
            calls.append({"jsonrpc":"2.0","id":f"{sym}_{a}","method":"eth_call",
                          "params":[{"to":contract,"data":BAL_SIG+pad},"latest"]})
    try:
        resp = requests.post(url, json=calls, timeout=20)
        rows = {r.get("id"): r.get("result","0x") for r in (resp.json() if isinstance(resp.json(),list) else [])}
    except:
        rows = {}
    out = {}
    for a in addrs:
        try:
            eth = int(rows.get(f"eth_{a}","0x0") or "0x0", 16)/1e18
        except:
            eth = 0.0
        total = eth * ETH_PRICE
        for contract,dec,sym,price in _TOKENS:
            try:
                raw = rows.get(f"{sym}_{a}","0x") or "0x"
                bal = int(raw,16)/(10**dec) if raw and raw!="0x" else 0
                total += bal * price
            except:
                pass
        out[a] = (round(eth,4), round(total,2))
    return out

def alchemy_networth(addr):
    res = _batch_portfolio([addr])
    eth, total = res.get(addr, (0,0))
    return total

rich   = []
BATCH  = 5   # 5 wallets × 11 calls = 55 calls per batch (safe Alchemy limit)
total_c = len(top_cands)
for i in range(0, total_c, BATCH):
    chunk = top_cands[i:i+BATCH]
    addrs = [c["addr"] for c in chunk]
    results_map = _batch_portfolio(addrs)
    for c in chunk:
        total_usd = results_map.get(c["addr"], (0,0))[1]
        eth       = results_map.get(c["addr"], (0,0))[0]
        if total_usd >= MIN_USD:
            rich.append({**c, "eth": eth, "stable_usd": 0, "total_usd": total_usd})
            print(f"\n    ★ WHALE: @{c['farcaster']} | ${total_usd:,.0f} | {c['addr'][:16]}")
    done = min(i+BATCH, total_c)
    sys.stdout.write(f"\r  [{done}/{total_c}] Whales found: {len(rich)}   ")
    sys.stdout.flush()
    time.sleep(0.05)

print(f"\n  Wallets with ${MIN_USD//1000}k+: {len(rich)}")

# ── Step 3: ENS + Moralis full portfolio for qualified wallets ────────────────
print(f"\n{'='*60}")
print("  STEP 3: ENS name + full token portfolio (Moralis)")
print(f"{'='*60}")

def get_ens(addr):
    try:
        url = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
        r = requests.post(url, json={"jsonrpc":"2.0","id":1,"method":"eth_call",
            "params":[{"to":"0x4976fb03c32e5b8cfe2b6dcb31ac5dec6bc5e8b5",
                       "data":"0x691f3431"+"000000000000000000000000"+addr[2:].lower()},
                      "latest"]}, timeout=8)
        raw = r.json().get("result","")
        if raw and raw != "0x" and len(raw) > 130:
            offset = int(raw[2:66],16)*2 + 2
            length = int(raw[offset:offset+64],16)
            name   = bytes.fromhex(raw[offset+64:offset+64+length*2]).decode("utf-8","ignore")
            return name if name else ""
    except:
        return ""

def get_portfolio(addr):
    if not MORALIS_KEY:
        return []
    try:
        r = requests.get(
            f"https://deep-index.moralis.io/api/v2.2/wallets/{addr}/tokens",
            params={"chain":"eth","limit":30},
            headers={"X-API-Key": MORALIS_KEY},
            timeout=12)
        tokens = []
        for t in (r.json().get("result") or []):
            usd = float(t.get("usd_value") or 0)
            if usd < 10:
                continue
            tokens.append({
                "symbol":   t.get("symbol","?"),
                "name":     t.get("name",""),
                "balance":  round(float(t.get("balance_formatted") or 0),4),
                "usd":      round(usd,2),
                "contract": t.get("token_address",""),
            })
        return sorted(tokens, key=lambda x: x["usd"], reverse=True)[:20]
    except:
        return []

final = []
for i, w in enumerate(rich[:TARGET], 1):
    sys.stdout.write(f"\r  [{i}/{min(len(rich),TARGET)}] ENS+Portfolio...   ")
    sys.stdout.flush()
    addr = w["addr"]
    ens  = get_ens(addr)
    port = get_portfolio(addr)
    final.append({
        "rank":        i,
        "addr":        addr,
        "ens":         ens,
        "total_usd":   w["total_usd"],
        "eth":         w["eth"],
        "stable_usd":  w["stable_usd"],
        "portfolio":   port,
        "farcaster":   w["farcaster"],
        "display_name":w["display"],
        "bio":         w["bio"],
        "followers":   w["followers"],
        "twitter":     w["twitter"],
        "pfp":         w["pfp"],
        "etherscan":   f"https://etherscan.io/address/{addr}",
        "warpcast":    f"https://warpcast.com/{w['farcaster']}" if w["farcaster"] else "",
    })
    if i % 10 == 0:
        with open(OUT_FILE,"w",encoding="utf-8") as f:
            json.dump(final, f, indent=2, default=str)
    time.sleep(0.3)

# Save final
with open(OUT_FILE,"w",encoding="utf-8") as f:
    json.dump(final, f, indent=2, default=str)

# ── Summary ───────────────────────────────────────────────────────────────────
print(f"\n\n{'='*60}")
print(f"  DONE — {len(final)} wallets saved to {OUT_FILE}")
print(f"{'='*60}")
with_twitter    = sum(1 for w in final if w["twitter"])
with_farcaster  = sum(1 for w in final if w["farcaster"])
with_ens        = sum(1 for w in final if w["ens"])
with_portfolio  = sum(1 for w in final if w["portfolio"])
avg_bal         = sum(w["total_usd"] for w in final)/max(len(final),1)
print(f"  With Twitter   : {with_twitter}/{len(final)}")
print(f"  With Farcaster : {with_farcaster}/{len(final)}")
print(f"  With ENS       : {with_ens}/{len(final)}")
print(f"  With Portfolio : {with_portfolio}/{len(final)}")
print(f"  Avg Balance    : ${avg_bal:,.0f}")
print(f"\n  Top 5 whales:")
for w in final[:5]:
    print(f"    ${w['total_usd']:>12,.0f}  {w['ens'] or w['addr'][:14]}  "
          f"fc=@{w['farcaster']}  tw=@{w['twitter'] or '-'}")
print(f"\n  File: {OUT_FILE}\n")
