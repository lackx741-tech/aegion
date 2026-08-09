"""
mega_scan.py — Full multi-chain whale scan
Chains  : ETH Mainnet + Base + Arbitrum + Optimism
Tokens  : Native + 15 major ERC20 per chain
Source  : 30+ Farcaster channels → top 10,000 by followers
Output  : whales_mega.json  +  whales_mega.csv
"""
import sys, os, json, csv, time, requests
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(SCRIPT_DIR)
from dotenv import load_dotenv
load_dotenv(".env")

NEYNAR_KEY   = os.getenv("NEYNAR_KEY", "")
ALCHEMY_KEYS = [k.strip() for k in os.getenv("ALCHEMY_KEYS","").split(",") if k.strip()]
if not ALCHEMY_KEYS:
    single = os.getenv("ALCHEMY_KEY","")
    if single: ALCHEMY_KEYS = [single]

MIN_USD        = 10_000    # $10k total across ALL chains
FOLLOWER_TOP_N = 10_000   # check top 10k most-followed Farcaster users
TARGET         = 500
OUT_JSON       = "whales_mega.json"
OUT_CSV        = "whales_mega.csv"
BATCH          = 5         # wallets per RPC batch

print(f"Alchemy keys loaded: {len(ALCHEMY_KEYS)}")
_key_idx = 0
def _alk():
    global _key_idx
    k = ALCHEMY_KEYS[_key_idx % len(ALCHEMY_KEYS)]
    _key_idx += 1
    return k

# ── Token prices from CoinGecko ───────────────────────────────────────────────
print("\nFetching token prices from CoinGecko...")
PRICES = {}
_IDS = "ethereum,bitcoin,uniswap,aave,chainlink,curve-dao-token,maker,havven,lido-dao,rocket-pool,arbitrum,optimism,staked-ether"
try:
    r = requests.get(
        "https://api.coingecko.com/api/v3/simple/price",
        params={"ids": _IDS, "vs_currencies": "usd"},
        timeout=10)
    _p = r.json()
    PRICES = {k: v.get("usd", 0) for k, v in _p.items()}
    print(f"  ETH=${PRICES.get('ethereum',0):,.0f}  BTC=${PRICES.get('bitcoin',0):,.0f}  "
          f"UNI=${PRICES.get('uniswap',0):.2f}  ARB=${PRICES.get('arbitrum',0):.2f}  OP=${PRICES.get('optimism',0):.2f}")
except Exception as e:
    print(f"  Price fetch failed: {e} — using fallbacks")
    PRICES = {"ethereum":3500,"bitcoin":108000}

ETH = PRICES.get("ethereum", 3500)
BTC = PRICES.get("bitcoin", 108000)

# ── Chain configs ─────────────────────────────────────────────────────────────
# (chain_id, name, alchemy_slug, native_symbol, tokens[])
# Each token: (contract, decimals, symbol, usd_price)
CHAINS = [
    ("eth", "Ethereum", "eth-mainnet", "ETH", ETH, [
        ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6,  "USDC",  1.0),
        ("0xdac17f958d2ee523a2206206994597c13d831ec7", 6,  "USDT",  1.0),
        ("0x6b175474e89094c44da98b954eedeac495271d0f", 18, "DAI",   1.0),
        ("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", 8,  "WBTC",  BTC),
        ("0xae7ab96520de3a18e5e111b5eaab095312d7fe84", 18, "stETH", ETH),
        ("0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", 18, "wstETH",ETH*1.18),
        ("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18, "WETH",  ETH),
        ("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", 18, "UNI",   PRICES.get("uniswap",8)),
        ("0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", 18, "AAVE",  PRICES.get("aave",200)),
        ("0x514910771af9ca656af840dff83e8264ecf986ca", 18, "LINK",  PRICES.get("chainlink",16)),
        ("0xd533a949740bb3306d119cc777fa900ba034cd52", 18, "CRV",   PRICES.get("curve-dao-token",0.5)),
        ("0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2", 18, "MKR",   PRICES.get("maker",1500)),
        ("0x5a98fcbea516cf06857215779fd812ca3bef1b32", 18, "LDO",   PRICES.get("lido-dao",1.5)),
        ("0xd33526068d116ce69f19a9ee46f0bd304f21a51f", 18, "RPL",   PRICES.get("rocket-pool",8)),
    ]),
    ("base", "Base", "base-mainnet", "ETH", ETH, [
        ("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 6,  "USDC",  1.0),
        ("0x50c5725949a6f0c72e6c4a641f24049a917db0cb", 18, "DAI",   1.0),
        ("0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", 18, "cbETH", ETH),
        ("0x4200000000000000000000000000000000000006", 18, "WETH",  ETH),
        ("0x940181a94a35a4569e4529a3cdfb74e38fd98631", 18, "AERO",  PRICES.get("aerodrome-finance",1.0)),
        ("0x4ed4e862860bed51a9570b96d89af5e1b0efefed", 18, "DEGEN", 0.003),
    ]),
    ("arb", "Arbitrum", "arb-mainnet", "ETH", ETH, [
        ("0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", 6,  "USDC.e",1.0),
        ("0xaf88d065e77c8cc2239327c5edb3a432268e5831", 6,  "USDC",  1.0),
        ("0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", 6,  "USDT",  1.0),
        ("0x912ce59144191c1204e64559fe8253a0e49e6548", 18, "ARB",   PRICES.get("arbitrum",1.2)),
        ("0x82af49447d8a07e3bd95bd0d56f35241523fbab1", 18, "WETH",  ETH),
        ("0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a", 18, "GMX",   PRICES.get("gmx",20)),
        ("0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f", 8,  "WBTC",  BTC),
    ]),
    ("op", "Optimism", "opt-mainnet", "ETH", ETH, [
        ("0x7f5c764cbc14f9669b88837ca1490cca17c31607", 6,  "USDC.e",1.0),
        ("0x0b2c639c533813f4aa9d7837caf62653d097ff85", 6,  "USDC",  1.0),
        ("0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", 6,  "USDT",  1.0),
        ("0x4200000000000000000000000000000000000042", 18, "OP",    PRICES.get("optimism",2.5)),
        ("0x4200000000000000000000000000000000000006", 18, "WETH",  ETH),
        ("0x68f180fcce6836688e9084f035309e29bf0a2095", 8,  "WBTC",  BTC),
    ]),
]

BAL_SIG = "0x70a08231"  # balanceOf(address)

def _batch_chain(addrs, chain_slug, native_price, tokens):
    """Batch RPC call for native + ERC20 on one chain for a list of addresses."""
    url = f"https://{chain_slug}.g.alchemy.com/v2/{_alk()}"
    calls = []
    for a in addrs:
        calls.append({"jsonrpc":"2.0","id":f"n_{a}","method":"eth_getBalance","params":[a,"latest"]})
        pad = a[2:].lower().zfill(64)
        for contract, _, sym, _ in tokens:
            calls.append({"jsonrpc":"2.0","id":f"{sym}_{a}","method":"eth_call",
                          "params":[{"to":contract,"data":BAL_SIG+pad},"latest"]})
    try:
        resp = requests.post(url, json=calls, timeout=25)
        rows_list = resp.json()
        if not isinstance(rows_list, list):
            return {}
        rows = {r.get("id"): r.get("result","0x") for r in rows_list}
    except Exception:
        return {}

    out = {}
    for a in addrs:
        try:
            native = int(rows.get(f"n_{a}","0x0") or "0x0", 16) / 1e18
        except Exception:
            native = 0.0
        total = native * native_price
        breakdown = {}
        if native > 0.0001:
            breakdown["ETH"] = round(native, 6)
        for contract, dec, sym, price in tokens:
            try:
                raw = rows.get(f"{sym}_{a}", "0x") or "0x"
                bal = int(raw, 16) / (10 ** dec) if raw and raw != "0x" else 0.0
                usd = bal * price
                if usd >= 1:
                    total += usd
                    breakdown[sym] = round(bal, 6)
            except Exception:
                pass
        out[a] = {"native": round(native, 6), "total": round(total, 2), "tokens": breakdown}
    return out

def scan_wallets_multichain(addrs):
    """Check all 4 chains in PARALLEL for a batch of addresses."""
    results = {a: {"total_usd": 0.0, "chains": {}} for a in addrs}

    def _fetch_chain(chain_tuple):
        chain_id, chain_name, slug, native_sym, native_price, tokens = chain_tuple
        data = _batch_chain(addrs, slug, native_price, tokens)
        return chain_id, chain_name, native_price, data

    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(_fetch_chain, c) for c in CHAINS]
        for fut in as_completed(futures):
            chain_id, chain_name, native_price, chain_data = fut.result()
            for a in addrs:
                d = chain_data.get(a, {"native": 0, "total": 0, "tokens": {}})
                results[a]["chains"][chain_id] = {
                    "name":   chain_name,
                    "native": d["native"],
                    "total":  d["total"],
                    "tokens": d["tokens"],
                }
                results[a]["total_usd"] += d["total"]

    for a in addrs:
        results[a]["total_usd"] = round(results[a]["total_usd"], 2)
    return results

# ── STEP 1: Farcaster → verified ETH addresses ───────────────────────────────
print(f"\n{'='*65}")
print("  STEP 1: Farcaster (30+ channels) → verified ETH addresses")
print(f"{'='*65}")

CHANNELS = [
    # Core DeFi / ETH
    "ethereum","defi","uniswap","aave","compound","makerdao","curve","yearn",
    "lido","rocketpool","balancer","synthetix","dydx","gmx","pendle",
    # NFT / Collectors
    "nft","nouns","pudgy","azuki","milady","farcaster-og",
    # L2 / Base
    "base","arbitrum","optimism","zora","polygon","layer2",
    # Broad crypto
    "bitcoin","solana","crypto","web3","stablecoin","trading","dao",
    # Farcaster-native
    "warpcast","far","founders","builders",
]

all_candidates = []
seen_addr      = set()

for ch in CHANNELS:
    cursor = ""
    pages  = 0
    ch_count = 0
    print(f"  #{ch:<18}", end="", flush=True)
    while pages < 5:   # up to 5000 per channel
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
                if al in seen_addr:
                    continue
                seen_addr.add(al)
                tw = next((a.get("username","")
                           for a in (u.get("verified_accounts") or [])
                           if a.get("platform") in ("twitter","x")), "")
                all_candidates.append({
                    "addr":      addr,
                    "farcaster": u.get("username",""),
                    "display":   u.get("display_name",""),
                    "bio":       (u.get("profile") or {}).get("bio",{}).get("text","")[:150],
                    "followers": u.get("follower_count", 0),
                    "twitter":   tw,
                    "pfp":       (u.get("pfp") or {}).get("url",""),
                })
                ch_count += 1
        cursor = (data.get("next") or {}).get("cursor","")
        pages += 1
        if not cursor or not users:
            break
        time.sleep(0.12)
    print(f" +{ch_count:>5} → total {len(all_candidates):>6}")

print(f"\n  Total unique Farcaster wallets: {len(all_candidates):,}")

# ── STEP 2: Sort by followers → top N → multi-chain scan ─────────────────────
print(f"\n{'='*65}")
print(f"  STEP 2: Top {FOLLOWER_TOP_N:,} by followers → 4-chain portfolio scan")
print(f"{'='*65}")

top_cands = sorted(all_candidates, key=lambda x: x["followers"], reverse=True)[:FOLLOWER_TOP_N]
if top_cands:
    print(f"  Follower range: {top_cands[0]['followers']:,} → {top_cands[-1]['followers']:,}")

rich   = []
total_c = len(top_cands)
done_c  = 0

for i in range(0, total_c, BATCH):
    chunk = top_cands[i:i+BATCH]
    addrs = [c["addr"] for c in chunk]
    results_map = scan_wallets_multichain(addrs)

    for c in chunk:
        r = results_map.get(c["addr"], {"total_usd":0,"chains":{}})
        total_usd = r["total_usd"]
        chains    = r["chains"]
        if total_usd >= MIN_USD:
            rich.append({**c,
                         "total_usd": total_usd,
                         "chains":    chains})
            chain_str = " | ".join(
                f"{cid}=${v['total']:,.0f}"
                for cid, v in chains.items()
                if v["total"] > 100
            )
            print(f"\n  ★ ${total_usd:>10,.0f}  @{c['farcaster']:<22}  {chain_str}")

    done_c += len(chunk)
    sys.stdout.write(f"\r  [{done_c:>5}/{total_c}] Whales ${MIN_USD//1000}k+: {len(rich):>3}   ")
    sys.stdout.flush()

    if len(rich) >= TARGET:
        print(f"\n  Target {TARGET} reached!")
        break

rich.sort(key=lambda x: x["total_usd"], reverse=True)
print(f"\n\n  Total ${MIN_USD//1000}k+ multi-chain wallets: {len(rich)}")

# ── STEP 3: Build output ──────────────────────────────────────────────────────
print(f"\n{'='*65}")
print("  STEP 3: Building output (JSON + CSV)")
print(f"{'='*65}")

final = []
for i, w in enumerate(rich[:TARGET], 1):
    # Per-chain breakdown
    chain_totals = {cid: v["total"] for cid, v in w["chains"].items()}
    top_tokens = []
    for cid, cv in w["chains"].items():
        for sym, bal in cv.get("tokens", {}).items():
            top_tokens.append({"chain": cid, "symbol": sym, "balance": bal})
    top_tokens = top_tokens[:15]

    final.append({
        "rank":         i,
        "addr":         w["addr"],
        "total_usd":    w["total_usd"],
        "eth_usd":      chain_totals.get("eth", 0),
        "base_usd":     chain_totals.get("base", 0),
        "arb_usd":      chain_totals.get("arb", 0),
        "op_usd":       chain_totals.get("op", 0),
        "chains":       chain_totals,
        "top_tokens":   top_tokens,
        "farcaster":    w["farcaster"],
        "display_name": w["display"],
        "bio":          w["bio"],
        "followers":    w["followers"],
        "twitter":      w["twitter"],
        "pfp":          w["pfp"],
        "warpcast":     f"https://warpcast.com/{w['farcaster']}" if w["farcaster"] else "",
        "etherscan":    f"https://etherscan.io/address/{w['addr']}",
    })

# Save JSON
with open(OUT_JSON, "w", encoding="utf-8") as f:
    json.dump(final, f, indent=2, default=str)

# Save CSV
with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
    cw = csv.writer(f)
    cw.writerow(["Rank","Total_USD","ETH_USD","Base_USD","Arb_USD","OP_USD",
                 "Display_Name","Bio","Farcaster","Twitter_X","Warpcast","Etherscan","Followers"])
    for r in final:
        tw = "@" + r["twitter"] if r["twitter"] else ""
        fc = "@" + r["farcaster"] if r["farcaster"] else ""
        cw.writerow([
            r["rank"],
            "${:,.0f}".format(r["total_usd"]),
            "${:,.0f}".format(r["eth_usd"]),
            "${:,.0f}".format(r["base_usd"]),
            "${:,.0f}".format(r["arb_usd"]),
            "${:,.0f}".format(r["op_usd"]),
            r["display_name"],
            (r["bio"] or "")[:100],
            fc, tw,
            r["warpcast"],
            r["etherscan"],
            r["followers"],
        ])

# ── Summary ───────────────────────────────────────────────────────────────────
print(f"\n{'='*65}")
print(f"  DONE — {len(final)} whales saved")
print(f"  JSON : {OUT_JSON}")
print(f"  CSV  : {OUT_CSV}")
print(f"{'='*65}")
with_tw  = sum(1 for w in final if w["twitter"])
with_fc  = sum(1 for w in final if w["farcaster"])
avg_bal  = sum(w["total_usd"] for w in final) / max(len(final),1)
print(f"  With Twitter   : {with_tw}/{len(final)}")
print(f"  With Farcaster : {with_fc}/{len(final)}")
print(f"  Avg Portfolio  : ${avg_bal:,.0f}")
print(f"\n  TOP 10 multi-chain whales:")
for w in final[:10]:
    tw   = f"tw=@{w['twitter']}" if w["twitter"] else "tw=—"
    ch   = " | ".join(
        f"{cid}=${v:,.0f}"
        for cid, v in sorted(w["chains"].items(), key=lambda x: x[1], reverse=True)
        if v > 500
    )
    print(f"    ${w['total_usd']:>12,.0f}  fc=@{w['farcaster']:<22}  {tw}")
    print(f"                          {ch}")
print()
