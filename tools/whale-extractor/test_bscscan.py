import os, json, sys, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv("../../.env")
load_dotenv(".env")

BSCSCAN_KEY     = os.getenv("BSCSCAN_KEY","")
POLYGONSCAN_KEY = os.getenv("POLYGONSCAN_KEY","")
ARBISCAN_KEY    = os.getenv("ARBISCAN_KEY","")

print(f"BscScan key  : {'SET' if BSCSCAN_KEY else 'MISSING'}")
print(f"PolygonScan  : {'SET' if POLYGONSCAN_KEY else 'MISSING'}")
print(f"Arbiscan     : {'SET' if ARBISCAN_KEY else 'MISSING'}")

with open("outputs/targets_multichain.json") as f:
    targets = json.load(f)

# Test BSC wallet
addr = targets[3]["wallet_address"]
print(f"\nTesting BSC for: {addr}")

r = requests.get("https://api.bscscan.com/api",
    params={"module":"account","action":"txlist","address":addr,
            "page":1,"offset":10,"sort":"desc","apikey":BSCSCAN_KEY},
    timeout=15)
data = r.json()
status = data.get("status")
msg    = data.get("message")
txs    = data.get("result",[])
print(f"Status: {status} | Msg: {msg}")
if isinstance(txs, list) and txs:
    import datetime
    ts = int(txs[0].get("timeStamp",0))
    dt = datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d") if ts else "?"
    print(f"TXs found: {len(txs)} | Latest: {dt}")
    print(f"Last TX to: {txs[0].get('to','?')[:20]}")
elif isinstance(txs, str):
    print(f"Result string: {txs[:100]}")
else:
    print(f"Empty / no TXs")
