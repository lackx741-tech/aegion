"""Quick e2e test of refine pipeline on 3 wallets."""
import os, sys, json, time, requests, threading
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv("../../.env"); load_dotenv(".env")

ANKR_KEY       = os.getenv("ANKR_KEY","")
ETHERSCAN_KEYS = [k.strip() for k in os.getenv("ETHERSCAN_KEYS","").split(",") if k.strip()] or [os.getenv("ETHERSCAN_KEY","")]
ANKR_URL       = f"https://rpc.ankr.com/multichain/{ANKR_KEY}"
STABLE         = {"USDC","USDT","DAI","BUSD","FRAX","TUSD","USDP","GUSD","LUSD","USDE","PYUSD"}
NOW            = int(time.time())
DEFI_ROUTERS = {
    "0xe592427a0aece92de3edee1f18e0157c05861564":"uniswap_v3",
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d":"uniswap_v2",
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2":"aave",
    "0x10ed43c718714eb63d5aa57b78b54704e256024e":"pancakeswap",
    "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff":"quickswap",
}

def ankr_balance(addr):
    chains = ["eth","bsc","polygon","arbitrum","base","optimism","avalanche","fantom"]
    r = requests.post(ANKR_URL, json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
        "params":{"blockchain":chains,"walletAddress":addr,"onlyWhitelisted":False}}, timeout=20)
    if not r.ok: return 0,[],{},"eth"
    res = r.json().get("result",{})
    total = float(res.get("totalBalanceUsd","0") or 0)
    tokens, chain_usd = [], {}
    for a in res.get("assets",[]):
        usd = float(a.get("balanceUsd","0") or 0)
        if usd > 0:
            ch = a.get("blockchain","")
            chain_usd[ch] = chain_usd.get(ch,0) + usd
            tokens.append({"symbol":a.get("tokenSymbol",""),"usd":usd,"blockchain":ch})
    primary = max(chain_usd, key=chain_usd.get) if chain_usd else "eth"
    return total, tokens, chain_usd, primary

def ankr_txs(addr, chain="eth", limit=50):
    r = requests.post(ANKR_URL, json={"id":1,"jsonrpc":"2.0","method":"ankr_getTransactionsByAddress",
        "params":{"blockchain":chain,"address":[addr],"pageSize":limit,"descOrder":True}}, timeout=20)
    if not r.ok: return []
    txs = r.json().get("result",{}).get("transactions",[])
    out = []
    for tx in txs:
        ts = tx.get("timestamp",0)
        if isinstance(ts,str): ts = int(ts,16) if ts.startswith("0x") else int(ts or 0)
        val = tx.get("value","0")
        if isinstance(val,str) and val.startswith("0x"): val = str(int(val,16))
        out.append({"timeStamp":str(ts),"from":(tx.get("from","") or "").lower(),"to":(tx.get("to","") or "").lower(),"value":val})
    return out

def classify(total, stable_pct, chains, tx_90d, idle_months, old_months, defi_used, tokens, from_exch, recent_in, regular_in):
    has_defi   = len(defi_used) > 0
    truly_idle = idle_months > 3 and tx_90d == 0
    active     = tx_90d >= 10
    new_wallet = old_months < 3
    multi_ch   = chains >= 4

    if recent_in > total * 0.5 and new_wallet: return 7, "Recent Windfall"
    if regular_in and tx_90d < 10 and stable_pct > 50: return 9, "Crypto Salary"
    if has_defi and tx_90d >= 5 and stable_pct < 80: return 3, "Yield Seeker"
    if has_defi and truly_idle: return 11, "DeFi Dropout"
    if multi_ch and tx_90d >= 3: return 6, "Multi-Chain Chaos"
    if from_exch and idle_months > 2 and tx_90d < 5 and stable_pct < 60: return 12, "Silent Accumulator"
    top_ns = max((t["usd"] for t in tokens if t["symbol"] not in STABLE), default=0)
    if top_ns > total * 0.7 and total > 200_000: return 14, "Concentration Gamble"
    if tokens and total > 0:
        top = max((t["usd"] for t in tokens), default=0)
        if top/total > 0.85 and len(tokens) <= 3: return 15, "Single Token Max"
    if tx_90d == 0 and old_months > 6 and stable_pct < 50 and not has_defi: return 10, "Bull FOMO Trader"
    if tx_90d == 0 and total > 100_000 and idle_months > 6: return 13, "Gas Paralyzed"
    if not has_defi and idle_months > 6 and stable_pct < 70: return 2, "Idle Self-Custody"
    if stable_pct >= 70: return 5, "Stablecoin Hoarder"
    if active: return 4, "Active Trader"
    return 5, "Stablecoin Hoarder"

with open("outputs/targets_multichain.json") as f:
    targets = json.load(f)

print("Testing 3 wallets end-to-end:\n")
for w in targets[:3]:
    addr = w["wallet_address"]
    print(f"=== {addr} ===")
    total, tokens, chain_usd, primary = ankr_balance(addr)
    print(f"  Balance: ${total/1000:.0f}K | primary={primary}")
    txs = ankr_txs(addr, chain=primary, limit=50)
    print(f"  TXs: {len(txs)}")

    timestamps = [int(tx["timeStamp"]) for tx in txs if tx["timeStamp"]]
    last_ts  = max(timestamps) if timestamps else 0
    first_ts = min(timestamps) if timestamps else 0
    tx_90d   = sum(1 for t in timestamps if t >= NOW - 90*86400)
    tx_30d   = sum(1 for t in timestamps if t >= NOW - 30*86400)
    months_idle = round((NOW - last_ts)  / (86400*30.44), 1) if last_ts else 99
    months_old  = round((NOW - first_ts) / (86400*30.44), 1) if first_ts else 0

    stable_usd  = sum(t["usd"] for t in tokens if t["symbol"] in STABLE)
    stable_pct  = round(stable_usd/total*100,1) if total else 0
    chains_active = len([c for c in chain_usd if chain_usd[c] > 10])
    defi_used   = set()
    from_exch   = ""
    recent_in   = 0.0
    incoming    = {}
    for tx in txs:
        if tx["to"] in DEFI_ROUTERS: defi_used.add(DEFI_ROUTERS[tx["to"]])
        if tx["to"] == addr.lower():
            v = int(tx["value"] or 0) / 1e18 * 3500
            if v > 10_000: recent_in = max(recent_in, v)
            if tx["from"]: incoming[tx["from"]] = incoming.get(tx["from"],0)+1
    regular_in = any(v >= 3 for v in incoming.values())

    cat_id, cat = classify(total, stable_pct, chains_active, tx_90d, months_idle, months_old,
                            defi_used, tokens, from_exch, recent_in, regular_in)
    missed = total * (stable_pct/100) * 0.05 * max(months_idle,1)/12
    print(f"  Category: {cat} (#{cat_id})")
    print(f"  tx_90d={tx_90d} idle={months_idle:.0f}mo stable={stable_pct:.0f}% missed=${missed/1000:.1f}K/yr")
    print()
