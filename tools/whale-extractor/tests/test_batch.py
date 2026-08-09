"""Quick test of batch portfolio on known wallets"""
import requests, os
from dotenv import load_dotenv
load_dotenv(".env")

ALCHEMY_KEYS = [k.strip() for k in os.getenv("ALCHEMY_KEYS","").split(",") if k.strip()]
ALCHEMY_KEY  = ALCHEMY_KEYS[0] if ALCHEMY_KEYS else ""

ETH_PRICE = 1934.0
try:
    r0 = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", timeout=5)
    ETH_PRICE = float(r0.json()["ethereum"]["usd"])
except:
    pass

_TOKENS = [
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6,  "USDC",  1.0),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7", 6,  "USDT",  1.0),
    ("0x6b175474e89094c44da98b954eedeac495271d0f", 18, "DAI",   1.0),
    ("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", 8,  "WBTC",  108000.0),
    ("0xae7ab96520de3a18e5e111b5eaab095312d7fe84", 18, "stETH", ETH_PRICE),
    ("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", 18, "WETH",  ETH_PRICE),
    ("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", 18, "UNI",   8.0),
    ("0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9", 18, "AAVE",  200.0),
    ("0x514910771af9ca656af840dff83e8264ecf986ca", 18, "LINK",  16.0),
]
BAL_SIG = "0x70a08231"

# Known wallets
addrs = [
    "0x3DdfA8eC3052539b6C9549F12cEA2C295cfF5296",  # Justin Sun
    "0x50EC05ADe8280758E2077fcBC08D878D4aef79C3",  # Hayden Adams
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",  # Vitalik
]

url  = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
calls = []
for a in addrs:
    calls.append({"jsonrpc":"2.0","id":f"eth_{a}","method":"eth_getBalance","params":[a,"latest"]})
    pad = a[2:].lower().zfill(64)
    for contract,_,sym,_ in _TOKENS:
        calls.append({"jsonrpc":"2.0","id":f"{sym}_{a}","method":"eth_call",
                      "params":[{"to":contract,"data":BAL_SIG+pad},"latest"]})

resp = requests.post(url, json=calls, timeout=20)
rows = {r.get("id"): r.get("result","0x") for r in resp.json()}

names = ["Justin Sun","Hayden Adams","Vitalik"]
for name,a in zip(names,addrs):
    eth = int(rows.get(f"eth_{a}","0x0") or "0x0",16)/1e18
    total = eth * ETH_PRICE
    breakdown = [f"ETH={eth:.2f}"]
    for _,dec,sym,price in _TOKENS:
        raw = rows.get(f"{sym}_{a}","0x") or "0x"
        if raw and raw != "0x":
            bal = int(raw,16)/(10**dec)
            usd = bal*price
            if usd > 100:
                total += usd
                breakdown.append(f"{sym}={usd:,.0f}")
    print(f"{name}: ${total:,.2f}  |  {', '.join(breakdown[:4])}")
