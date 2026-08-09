import requests, os, json
from dotenv import load_dotenv; load_dotenv(".env")
ANKR_KEY = os.getenv("ANKR_KEY","")
ANKR_URL = f"https://rpc.ankr.com/multichain/{ANKR_KEY}"

# Check actual response format
r = requests.post(ANKR_URL, json={
    "jsonrpc":"2.0","id":1,
    "method":"ankr_getTokenHolders",
    "params":{
        "blockchain":"eth",
        "contractAddress":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        "pageSize":5
    }
}, timeout=20)
print(f"Status: {r.status_code}")
d = r.json()
print(json.dumps(d, indent=2)[:1500])
