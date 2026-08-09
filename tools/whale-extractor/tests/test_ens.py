"""Debug ENS subgraph and balance check"""
import requests, json

ENS_URL = "https://api.thegraph.com/subgraphs/name/ensdomains/ens"

# Test 1: ENS resolvers with twitter
print("=== ENS subgraph test ===")
for key in ["com.twitter", "url", "email"]:
    q = """
    query($cursor: String!, $keys: [String!]!) {
      resolvers(first:5, where:{texts_contains:$keys, id_gt:$cursor}
               orderBy:id, orderDirection:asc) {
        id addr{id} domain{name} texts
      }
    }"""
    r = requests.post(ENS_URL, json={"query":q,"variables":{"cursor":"","keys":[key]}}, timeout=15)
    data = r.json()
    resolvers = data.get("data",{}).get("resolvers",[])
    errors = data.get("errors",[])
    print(f"\nkey='{key}': {len(resolvers)} results, errors={errors[:1]}")
    for res in resolvers[:3]:
        addr = (res.get("addr") or {}).get("id","?")
        name = (res.get("domain") or {}).get("name","?")
        texts = res.get("texts",[])
        print(f"  {name} → {addr[:14]} texts={texts}")

# Test 2: Direct balance check on those addresses
print("\n=== Balance check on first 3 ENS twitter addresses ===")
import os
from dotenv import load_dotenv
load_dotenv(".env")
ALCHEMY_KEYS = [k.strip() for k in os.getenv("ALCHEMY_KEYS","").split(",") if k.strip()]
ALCHEMY_KEY = ALCHEMY_KEYS[0] if ALCHEMY_KEYS else ""

# Get some addresses
q2 = """query {
  resolvers(first:10, where:{texts_contains:["com.twitter"]}, orderBy:id) {
    addr{id} domain{name}
  }
}"""
r2 = requests.post(ENS_URL, json={"query":q2}, timeout=15)
addrs = [(res.get("domain",{}).get("name","?"), res.get("addr",{}).get("id",""))
         for res in r2.json().get("data",{}).get("resolvers",[])
         if res.get("addr",{}).get("id")]

print(f"Got {len(addrs)} ENS twitter addresses")
if addrs:
    test_addrs = [a[1] for a in addrs[:5]]
    url = f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}"
    calls = [{"jsonrpc":"2.0","id":f"eth_{a}","method":"eth_getBalance","params":[a,"latest"]} for a in test_addrs]
    resp = requests.post(url, json=calls, timeout=15)
    rows = {r.get("id"):r.get("result","0x0") for r in resp.json()}
    ETH_PRICE = 1920.0
    for name, addr in addrs[:5]:
        eth = int(rows.get(f"eth_{addr}","0x0") or "0x0",16)/1e18
        print(f"  {name}: {eth:.4f} ETH = ${eth*ETH_PRICE:,.2f}")
