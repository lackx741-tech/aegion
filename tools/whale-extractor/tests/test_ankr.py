import os, requests
from dotenv import load_dotenv
load_dotenv()

KEY = os.getenv("ANKR_KEY","")
print(f"Ankr key: {'YES' if KEY else 'NO'}")

# Test multi-chain balance for worthalter
addr = "0xf6b6f07862a02c85628b3a9688beae07fea9c863"
chains = ["eth","bsc","polygon","arbitrum","base","optimism","avalanche","fantom"]

r = requests.post(
    f"https://rpc.ankr.com/multichain/{KEY}",
    json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
          "params":{"blockchain": chains, "walletAddress": addr, "onlyWhitelisted": False}},
    timeout=20)

print(f"Status: {r.status_code}")
data = r.json()
if r.status_code == 200:
    result = data.get("result",{})
    total = result.get("totalBalanceUsd","0")
    print(f"Total USD: ${float(total):,.2f}")
    print("Assets by chain:")
    for asset in result.get("assets",[])[:15]:
        usd = float(asset.get("balanceUsd","0") or 0)
        if usd > 100:
            print(f"  {asset.get('blockchain',''):<12} {asset.get('tokenSymbol',''):<8} ${usd:>12,.2f}")
else:
    print(f"Error: {r.text[:300]}")
