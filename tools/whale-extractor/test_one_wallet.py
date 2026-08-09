"""Quick test: run refine on first 3 wallets."""
import os, sys, json, time, requests, threading
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv("../../.env")
load_dotenv(".env")

ANKR_KEY        = os.getenv("ANKR_KEY","")
ETHERSCAN_KEYS  = [k.strip() for k in os.getenv("ETHERSCAN_KEYS","").split(",") if k.strip()]
if not ETHERSCAN_KEYS: ETHERSCAN_KEYS = [os.getenv("ETHERSCAN_KEY","")]
BSCSCAN_KEY     = os.getenv("BSCSCAN_KEY","")
POLYGONSCAN_KEY = os.getenv("POLYGONSCAN_KEY","")
ARBISCAN_KEY    = os.getenv("ARBISCAN_KEY","")
OPSCAN_KEY      = os.getenv("OPSCAN_KEY","")
SNOWTRACE_KEY   = os.getenv("SNOWTRACE_KEY","")
BASESCAN_KEY    = os.getenv("BASESCAN_KEY", ETHERSCAN_KEYS[0] if ETHERSCAN_KEYS else "")

print(f"Keys: ANKR={'SET' if ANKR_KEY else 'MISSING'} ETH={'SET' if ETHERSCAN_KEYS[0] else 'MISSING'} BSC={'SET' if BSCSCAN_KEY else 'MISSING'} POLY={'SET' if POLYGONSCAN_KEY else 'MISSING'}")

ANKR_URL = f"https://rpc.ankr.com/multichain/{ANKR_KEY}"
CHAIN_EXPLORER = {
    "eth":       ("https://api.etherscan.io/api",             ETHERSCAN_KEYS[0]),
    "bsc":       ("https://api.bscscan.com/api",              BSCSCAN_KEY),
    "polygon":   ("https://api.polygonscan.com/api",          POLYGONSCAN_KEY),
    "arbitrum":  ("https://api.arbiscan.io/api",              ARBISCAN_KEY),
    "optimism":  ("https://api-optimistic.etherscan.io/api",  OPSCAN_KEY),
    "base":      ("https://api.basescan.org/api",             BASESCAN_KEY),
    "avalanche": ("https://api.snowtrace.io/api",             SNOWTRACE_KEY),
}
STABLE_SYMBOLS = {"USDC","USDT","DAI","BUSD","FRAX","TUSD","USDP","GUSD","LUSD","USDE","PYUSD"}
NOW = int(time.time())
D90, D30 = 90*86400, 30*86400

def ankr_balance_full(addr):
    chains = ["eth","bsc","polygon","arbitrum","base","optimism","avalanche","fantom"]
    try:
        r = requests.post(ANKR_URL,
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
                  "params":{"blockchain": chains, "walletAddress": addr, "onlyWhitelisted": False}},
            timeout=20)
        if r.ok:
            res = r.json().get("result", {})
            total = float(res.get("totalBalanceUsd","0") or 0)
            assets = res.get("assets",[])
            tokens, chain_usd = [], {}
            for a in assets:
                usd = float(a.get("balanceUsd","0") or 0)
                if usd > 0:
                    ch = a.get("blockchain","")
                    chain_usd[ch] = chain_usd.get(ch,0) + usd
                    tokens.append({"symbol": a.get("tokenSymbol",""), "usd": usd, "blockchain": ch})
            primary = max(chain_usd, key=chain_usd.get) if chain_usd else "eth"
            return total, tokens, chain_usd, primary
    except Exception as e:
        print(f"  ankr_balance error: {e}")
    return 0, [], {}, "eth"

def explorer_txs(addr, chain="eth", limit=50):
    """Ankr-based TX history, all chains."""
    try:
        r = requests.post(ANKR_URL,
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getTransactionsByAddress",
                  "params":{"blockchain": chain, "address": [addr],
                            "pageSize": limit, "descOrder": True}},
            timeout=20)
        if r.ok:
            res = r.json().get("result", {})
            txs = res.get("transactions",[])
            if txs:
                normalized = []
                for tx in txs:
                    ts = tx.get("timestamp",0)
                    if isinstance(ts, str):
                        ts = int(ts,16) if ts.startswith("0x") else int(ts or 0)
                    val = tx.get("value","0")
                    if isinstance(val,str) and val.startswith("0x"): val = str(int(val,16))
                    normalized.append({"timeStamp":str(ts),"from":(tx.get("from","") or "").lower(),"to":(tx.get("to","") or "").lower(),"value":val})
                return normalized
            else:
                # Show raw response for debug
                raw = r.json()
                err = raw.get("error", raw.get("message",""))
                print(f"  ankr [{chain}] no txs — {err}")
    except Exception as e:
        print(f"  explorer_txs error [{chain}]: {e}")
    return []

with open("outputs/targets_multichain.json") as f:
    targets = json.load(f)

print(f"\nTesting 3 wallets:\n")
for w in targets[:3]:
    addr = w["wallet_address"]
    print(f"=== {addr} ===")
    total, tokens, chain_usd, primary = ankr_balance_full(addr)
    print(f"  Ankr: ${total/1000:.0f}K | primary={primary} | chains={list(chain_usd.keys())}")

    txs = explorer_txs(addr, chain=primary, limit=50)
    print(f"  TXs from {primary}: {len(txs)}")

    timestamps = [int(tx.get("timeStamp",0)) for tx in txs if tx.get("timeStamp")]
    last_ts  = max(timestamps) if timestamps else 0
    first_ts = min(timestamps) if timestamps else 0
    tx_90d = sum(1 for t in timestamps if t >= NOW - D90)

    months_idle = round((NOW - last_ts) / (86400*30.44), 1) if last_ts else 99
    months_old  = round((NOW - first_ts) / (86400*30.44), 1) if first_ts else 0

    stable_usd = sum(t["usd"] for t in tokens if t["symbol"] in STABLE_SYMBOLS)
    stable_pct = round(stable_usd/total*100, 1) if total else 0

    print(f"  tx_90d={tx_90d} | idle={months_idle:.0f}mo | stable={stable_pct:.0f}%")
    print()
