"""Debug: check which holder source actually works."""
import requests, os, json
from dotenv import load_dotenv; load_dotenv(".env")

ETHERSCAN_KEY = os.getenv("ETHERSCAN_KEY","")
MORALIS_KEY   = os.getenv("MORALIS_KEY","") or os.getenv("MORALIS_API_KEY","")
ALCHEMY_KEY   = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip()

USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

print("=== Etherscan tokenholderlist ===")
r = requests.get("https://api.etherscan.io/api",
    params={"module":"token","action":"tokenholderlist",
            "contractaddress":USDC,"page":1,"offset":5,
            "apikey":ETHERSCAN_KEY}, timeout=15)
print(f"Status: {r.status_code}")
print(f"Response: {r.text[:300]}")

print("\n=== Moralis ERC20 holders ===")
if MORALIS_KEY:
    r2 = requests.get(
        f"https://deep-index.moralis.io/api/v2.2/erc20/{USDC}/owners",
        params={"chain":"eth","order":"DESC","limit":5},
        headers={"X-API-Key": MORALIS_KEY}, timeout=15)
    print(f"Status: {r2.status_code}")
    print(f"Response: {r2.text[:400]}")
else:
    print("MORALIS_KEY not set")

print("\n=== The Graph USDC holders ===")
query = """{
  accountBalances(
    first: 5
    orderBy: amount
    orderDirection: desc
    where: {token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount_gt: "1000000000000"}
  ) {
    account { id }
    amount
  }
}"""
r3 = requests.post(
    "https://api.thegraph.com/subgraphs/name/messari/usdc-on-ethereum",
    json={"query": query}, timeout=15)
print(f"Status: {r3.status_code}")
print(f"Response: {r3.text[:400]}")

print("\n=== Alchemy getTokensForOwner test (reverse) ===")
# Test with a known whale address
test_addr = "0x0639556f03714a74a5feeaf5736a4a64ff70d206"
r4 = requests.post(
    f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}",
    json={"id":1,"jsonrpc":"2.0","method":"alchemy_getTokenBalances",
          "params":[test_addr, [USDC]]}, timeout=10)
print(f"Status: {r4.status_code}")
d = r4.json().get("result",{})
for tb in d.get("tokenBalances",[]):
    print(f"  USDC balance hex: {tb.get('tokenBalance','')}")
