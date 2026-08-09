"""Debug: check what each API actually returns for test wallets."""
import requests, json, os, sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv; load_dotenv(".env")

OS_KEY     = os.getenv("OPENSEA_KEY","")
TW_BEARER  = os.getenv("TWITTER_BEARER","")
SERPER_KEY = os.getenv("SERPER_KEY","")

# NFT collector wallets (highest NFT count)
WALLETS = [
    "0x0639556f03714a74a5feeaf5736a4a64ff70d206",  # 446 NFTs, 8yr OG
    "0x46340b20830761efd32832a74d7169b29feb9758",  # 430 NFTs, 7.6yr OG
    "0x5bdf85216ec1e38d6458c870992a69e38e03f7ef",  # 308 NFTs
    "0xb23360ccdd9ed1b15d45e5d3824bb409c8d7c460",  # 167 NFTs
]

for addr in WALLETS:
    print(f"\n{'='*60}")
    print(f"WALLET: {addr}")

    # 1. OpenSea
    hdrs = {"Accept":"application/json","x-api-key": OS_KEY} if OS_KEY else {"Accept":"application/json"}
    r = requests.get(f"https://api.opensea.io/api/v2/accounts/{addr}", headers=hdrs, timeout=10)
    print(f"\nOpenSea status: {r.status_code}")
    if r.ok:
        d = r.json()
        print(f"  username: {d.get('username','')}")
        print(f"  twitter:  {d.get('twitter_username','')}")
        print(f"  bio:      {d.get('bio','')[:80]}")
    else:
        print(f"  Error: {r.text[:100]}")

    # 2. DeBank
    r2 = requests.get(f"https://api.debank.com/user?id={addr.lower()}",
                      headers={"User-Agent":"Mozilla/5.0"}, timeout=10)
    print(f"\nDeBank status: {r2.status_code}")
    if r2.ok:
        d2 = r2.json()
        user = d2.get("data",{}).get("user",{})
        print(f"  name: {user.get('name','')}")
        print(f"  twitter: {user.get('twitter_name','') or user.get('twitter_username','')}")
        print(f"  keys: {list(user.keys())[:10]}")
    else:
        print(f"  Error: {r2.text[:100]}")

    # 3. Galxe
    q = '{"query":"query($a:String!){addressInfo(address:$a){username twitterUserName discordUserName email}}","variables":{"a":"' + addr + '"}}'
    r3 = requests.post("https://graphigo.prd.galaxy.eco/query",
                       data=q, headers={"Content-Type":"application/json"}, timeout=10)
    print(f"\nGalxe status: {r3.status_code}")
    if r3.ok:
        d3 = r3.json()
        info = d3.get("data",{}).get("addressInfo",{})
        print(f"  galxe: {info}")
    else:
        print(f"  Error: {r3.text[:120]}")

    # 4. Serper: Twitter search for wallet
    if SERPER_KEY:
        r4 = requests.post("https://google.serper.dev/search",
            json={"q": f'site:twitter.com OR site:x.com "{addr}"', "num": 5},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type":"application/json"}, timeout=10)
        print(f"\nSerper Twitter search status: {r4.status_code}")
        if r4.ok:
            for res in r4.json().get("organic",[])[:3]:
                print(f"  {res.get('title','')[:60]}  |  {res.get('link','')[:60]}")
        else:
            print(f"  Error: {r4.text[:100]}")

    print()
