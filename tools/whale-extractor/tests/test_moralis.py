import requests, os, json
from dotenv import load_dotenv
load_dotenv(".env")
KEY = os.getenv("MORALIS_KEY","")

# Test a known whale (not Vitalik who has too many spam tokens)
# Using a well-known DeFi whale with clean portfolio
test_wallets = [
    ("hayden.eth / Uniswap founder",    "0x50EC05ADe8280758E2077fcBC08D878D4aef79C3"),
    ("dcf god (DeFi whale)",            "0x35bfa7ee4f4de56b831fcf5cb8d70c48e37b88c3"),
    ("justin.sun.eth",                  "0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296"),
]

for name, addr in test_wallets:
    print(f"\nTesting: {name}")
    # Method 1: net-worth
    r = requests.get(
        f"https://deep-index.moralis.io/api/v2.2/wallets/{addr}/net-worth",
        params={"exclude_spam":"true","exclude_unverified_contracts":"true","chains[]":["eth","polygon","bsc","arbitrum","base"]},
        headers={"X-API-Key": KEY},
        timeout=15)
    print(f"  net-worth status: {r.status_code}")
    if r.status_code == 200:
        d = r.json()
        print(f"  Total: ${float(d.get('total_networth_usd') or 0):,.2f}")
    else:
        print(f"  Error: {r.text[:100]}")

    # Method 2: token balances with USD
    r2 = requests.get(
        f"https://deep-index.moralis.io/api/v2.2/wallets/{addr}/tokens",
        params={"chain":"eth","limit":10,"exclude_spam":"true"},
        headers={"X-API-Key": KEY},
        timeout=15)
    print(f"  tokens status: {r2.status_code}")
    if r2.status_code == 200:
        tokens = r2.json().get("result",[])
        total = sum(float(t.get("usd_value") or 0) for t in tokens)
        print(f"  Top tokens total: ${total:,.2f}")
        for t in tokens[:3]:
            print(f"    {t.get('symbol')}: ${float(t.get('usd_value') or 0):,.2f}")

