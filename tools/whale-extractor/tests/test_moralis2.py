import os, requests
from dotenv import load_dotenv
load_dotenv()

KEY = os.getenv("MORALIS_KEY","")
print(f"Key set: {'YES' if KEY else 'NO'} (len={len(KEY)})")

addr = "0xf6b6f07862a02c85628b3a9688beae07fea9c863"  # worthalter

r = requests.get(
    f"https://deep-index.moralis.io/api/v2.2/wallets/{addr}/net-worth",
    headers={"X-API-Key": KEY, "Accept": "application/json"},
    params=[("chains[]","eth"),("chains[]","bsc"),("chains[]","polygon"),
            ("exclude_spam","true"),("exclude_unverified_contracts","true")],
    timeout=20)

print(f"Status: {r.status_code}")
print(f"Response: {r.text[:500]}")
