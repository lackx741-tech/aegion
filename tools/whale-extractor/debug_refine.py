import os, json, time, requests
from dotenv import load_dotenv

load_dotenv("../../.env")
load_dotenv(".env")

import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))

ANKR_KEY      = os.getenv("ANKR_KEY","")
ETHERSCAN_KEYS = [k.strip() for k in os.getenv("ETHERSCAN_KEYS","").split(",") if k.strip()]
if not ETHERSCAN_KEYS:
    ETHERSCAN_KEYS = [os.getenv("ETHERSCAN_KEY","")]

ANKR_URL = f"https://rpc.ankr.com/multichain/{ANKR_KEY}"

print(f"ANKR_KEY set: {bool(ANKR_KEY)}")
print(f"ETHERSCAN_KEYS count: {len(ETHERSCAN_KEYS)}, first set: {bool(ETHERSCAN_KEYS[0])}")

# Load one wallet
with open("outputs/targets_multichain.json") as f:
    targets = json.load(f)

addr = targets[3]["wallet_address"]  # a stablecoin hoarder
print(f"\nTesting wallet: {addr}")

# Test 1: ankr_balance_full
print("\n--- Test 1: Ankr Balance ---")
chains = ["eth","bsc","polygon","arbitrum","base","optimism","avalanche","fantom"]
try:
    r = requests.post(ANKR_URL,
        json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
              "params":{"blockchain": chains, "walletAddress": addr,
                        "onlyWhitelisted": False}},
        timeout=20)
    print(f"Status: {r.status_code}")
    if r.ok:
        res = r.json().get("result", {})
        total = float(res.get("totalBalanceUsd","0") or 0)
        assets = res.get("assets", [])
        print(f"Total USD: ${total/1000:.0f}K")
        print(f"Assets count: {len(assets)}")
        chain_usd = {}
        for a in assets:
            usd = float(a.get("balanceUsd","0") or 0)
            if usd > 0:
                chain = a.get("blockchain","")
                chain_usd[chain] = chain_usd.get(chain, 0) + usd
        print(f"Chain breakdown: {chain_usd}")
        if chain_usd:
            primary = max(chain_usd, key=chain_usd.get)
            print(f"Primary chain: {primary}")
    else:
        print(f"Error: {r.text[:200]}")
except Exception as e:
    print(f"Exception: {e}")

# Test 2: Etherscan TX
print("\n--- Test 2: Etherscan TX (ETH) ---")
ETHERSCAN_CHAIN_IDS = {"eth":1,"bsc":56,"polygon":137,"arbitrum":42161,"optimism":10,"base":8453,"avalanche":43114}
try:
    key = ETHERSCAN_KEYS[0]
    r = requests.get("https://api.etherscan.io/v2/api",
        params={"chainid": 1, "module":"account","action":"txlist",
                "address": addr, "startblock": 0, "endblock": 99999999,
                "page": 1, "offset": 20, "sort": "desc",
                "apikey": key},
        timeout=15)
    print(f"Status: {r.status_code}")
    if r.ok:
        data = r.json()
        print(f"API status: {data.get('status')} | message: {data.get('message')}")
        txs = data.get("result", [])
        if isinstance(txs, list):
            print(f"TX count: {len(txs)}")
            if txs:
                print(f"Latest TX: {txs[0].get('timeStamp','?')} | to: {txs[0].get('to','?')[:20]}")
        else:
            print(f"Result (not list): {str(txs)[:200]}")
    else:
        print(f"Error: {r.text[:200]}")
except Exception as e:
    print(f"Exception: {e}")

# Test 3: BSC TX for same address
print("\n--- Test 3: Etherscan v2 BSC (chainid=56) ---")
try:
    key = ETHERSCAN_KEYS[0]
    r = requests.get("https://api.etherscan.io/v2/api",
        params={"chainid": 56, "module":"account","action":"txlist",
                "address": addr, "startblock": 0, "endblock": 99999999,
                "page": 1, "offset": 20, "sort": "desc",
                "apikey": key},
        timeout=15)
    print(f"Status: {r.status_code}")
    if r.ok:
        data = r.json()
        print(f"API status: {data.get('status')} | message: {data.get('message')}")
        txs = data.get("result", [])
        if isinstance(txs, list):
            print(f"TX count on BSC: {len(txs)}")
        else:
            print(f"Result: {str(txs)[:200]}")
except Exception as e:
    print(f"Exception: {e}")
