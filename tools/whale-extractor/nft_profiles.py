"""
nft_profiles.py — NFT wallet profiles from Blur/Foundation/LooksRare + deep Serper.
Focus on 4 OG NFT collector wallets with 150-450 NFTs.
"""
import sys, os, json, time, requests, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv; load_dotenv(".env")

SERPER_KEY   = os.getenv("SERPER_KEY","")
TW_BEARER    = os.getenv("TWITTER_BEARER","")
ALCHEMY_KEY  = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip()
ETHERSCAN_KEY= os.getenv("ETHERSCAN_KEY","")
INTELX_KEY   = os.getenv("INTELX_KEY","")
INTELX_HOST  = os.getenv("INTELX_HOST","https://free.intelx.io")

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
CRYPTO_KW = {"crypto","defi","web3","nft","blockchain","hodl","trading","trader",
             "investor","bitcoin","ethereum","btc","eth","token","dao","degen",
             "whale","altcoin","airdrop","yield","staking","protocol","wagmi","gm",
             "pump","ape","mint","floor","opensea","blur","buydip"}

# All 15 EVM wallets - NFT collectors first
WALLETS = [
    ("0x0639556f03714a74a5feeaf5736a4a64ff70d206", 26.38, "NFT Collector", 95.9, 446),
    ("0x46340b20830761efd32832a74d7169b29feb9758", 97.30, "NFT Collector", 91.5, 430),
    ("0x5bdf85216ec1e38d6458c870992a69e38e03f7ef", 24.50, "NFT Collector", 54.1, 308),
    ("0xb23360ccdd9ed1b15d45e5d3824bb409c8d7c460", 39.74, "NFT Collector", 57.7, 167),
    ("0x92ea7496eba5f001d620005f88f3e8e686e3d4ea", 51.94, "NFT Collector", 19.0, 34),
    ("0x7f604d597c15b2e2f60dc645844f68b1d781b752", 63.70, "NFT Collector", 14.8, 22),
    ("0x2cff890f0378a11913b6129b2e97417a2c302680", 32.49, "NFT Collector", 20.4, 20),
    ("0x93228d328c9c74c2bfe9f97638bbb5ef322f2bd5", 56.31, "Cross-chain Degen", 13.6, 11),
    ("0x0e331a293bb22e93e2e5e417d84d755ae185da02", 38.88, "Cross-chain Degen", 12.5, 10),
    ("0x3d2335cac7b31411467ef03168c5869452fb7e86", 43.57, "High-Value Whale", 12.8, 8),
    ("0x173810f8ca9c4c631aeb1d6c36d007f054fee980", 26.96, "High-Value Whale", 14.4, 8),
    ("0xf440139a62b2b939699c5b3e09f88e40464ab9bc", 44.44, "Cross-chain Degen", 6.0, 0),
    ("0xaa8ba7d4611437141192e7ceced531bc0a133efb", 46.22, "Smart Money", 10.3, 9),
    ("0x6fe39f2831caf58529779efdb73341aa64df50ab", 88.44, "Cross-chain Degen", 8.2, 0),
    ("0x1887fa9edadeab7562b01cc3f4fa246ace2c3cdd", 29.44, "Cross-chain Degen", 13.0, 13),
]

def blur_profile(addr):
    hdrs = {"User-Agent":"Mozilla/5.0","Accept":"application/json",
            "Origin":"https://blur.io","Referer":"https://blur.io/"}
    try:
        r = requests.get(f"https://core-api.prod.blur.io/v1/users/{addr.lower()}",
                         headers=hdrs, timeout=10)
        if r.ok:
            d = r.json()
            return {"blur_username": d.get("username",""),
                    "blur_twitter": d.get("twitterUsername","") or d.get("twitter",""),
                    "blur_bio": d.get("bio",""),
                    "blur_verified": d.get("verified",False)}
    except Exception:
        pass
    return {}

def foundation_profile(addr):
    q = """query($a:String!){
      user(publicKey:$a){
        username bio twitterUsername instagramUsername websiteUrl
        links { facebook instagram snapchat tiktok twitch twitter youtube }
      }
    }"""
    try:
        r = requests.post("https://api.foundation.app/graphql",
            json={"query":q,"variables":{"a":addr}},
            headers={"Content-Type":"application/json","User-Agent":"Mozilla/5.0"},
            timeout=10)
        if r.ok:
            u = (r.json().get("data") or {}).get("user") or {}
            if u:
                tw = u.get("twitterUsername","") or (u.get("links") or {}).get("twitter","")
                return {"fn_username": u.get("username",""),
                        "fn_twitter": tw, "fn_bio": u.get("bio","")}
    except Exception:
        pass
    return {}

def looksrare_profile(addr):
    try:
        r = requests.get(f"https://api.looksrare.org/api/v2/accounts?address={addr}",
                         headers={"Accept":"application/json"}, timeout=10)
        if r.ok:
            d = r.json().get("data",{})
            if d:
                return {"lr_name": d.get("name",""),
                        "lr_bio": d.get("biography",""),
                        "lr_twitter": d.get("twitterLink",""),
                        "lr_website": d.get("websiteLink","")}
    except Exception:
        pass
    return {}

def etherscan_label(addr):
    try:
        r = requests.get(
            f"https://api.etherscan.io/api?module=account&action=txlist&address={addr}"
            f"&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey={ETHERSCAN_KEY}",
            timeout=10)
        return {}
    except Exception:
        pass
    return {}

def serper_deep(addr, nfts=0):
    """Multi-query Serper to find wallet owner's Twitter identity."""
    if not SERPER_KEY: return []
    results = []
    queries = [
        f'"{addr}" twitter.com',
        f'"{addr[:16]}" site:twitter.com',
    ]
    if nfts > 50:
        queries.append(f'"{addr}" owner identity crypto')
    for q in queries:
        try:
            r = requests.post("https://google.serper.dev/search",
                json={"q": q, "num": 10},
                headers={"X-API-KEY": SERPER_KEY, "Content-Type":"application/json"},
                timeout=10)
            if r.ok:
                for res in r.json().get("organic",[])[:5]:
                    link = res.get("link","")
                    title = res.get("title","")
                    snippet = res.get("snippet","")
                    # Extract Twitter handle from link
                    tw_match = re.search(r"(?:twitter|x)\.com/([A-Za-z0-9_]{2,50})(?:/|$)", link)
                    handle = tw_match.group(1) if tw_match else ""
                    if handle and handle not in ("search","intent","share","status","i","home","messages","notifications","explore"):
                        results.append({"handle":handle,"title":title,"snippet":snippet[:100],"link":link,"query":q})
        except Exception:
            pass
        time.sleep(0.3)
    return results

def twitter_check(handle):
    if not handle or not TW_BEARER: return {}
    clean = handle.strip().lstrip("@")
    if not clean or "/" in clean: return {}
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{clean}",
            params={"user.fields":"description,public_metrics,entities,location,url"},
            headers={"Authorization":f"Bearer {TW_BEARER}"}, timeout=10)
        if not r.ok: return {}
        u = r.json().get("data",{})
        if not u: return {}
        bio = u.get("description","")
        url_text = " ".join(e.get("expanded_url","")
                           for e in (u.get("entities",{}).get("url",{}).get("urls") or []))
        full = bio + " " + u.get("url","") + " " + url_text
        email = next((e for e in EMAIL_RE.findall(full)
                     if "noreply" not in e and "example" not in e), "")
        bio_words = set(bio.lower().split())
        crypto_score = len(bio_words & CRYPTO_KW)
        m = u.get("public_metrics",{})
        return {
            "handle": clean,
            "name": u.get("name",""),
            "bio": bio[:200],
            "location": u.get("location",""),
            "tweet_count": m.get("tweet_count",0),
            "followers": m.get("followers_count",0),
            "email": email,
            "crypto_score": crypto_score,
        }
    except Exception:
        return {}

def intelx_search(q):
    if not INTELX_KEY or not q: return ""
    try:
        r = requests.post(f"{INTELX_HOST}/phonebook/search",
            json={"term":q,"target":2,"maxresults":5,"terminate":[]},
            headers={"x-key":INTELX_KEY}, timeout=10)
        sid = r.json().get("id","")
        if not sid: return ""
        time.sleep(3)
        r2 = requests.get(f"{INTELX_HOST}/phonebook/search/result",
            params={"id":sid,"limit":5,"offset":0},
            headers={"x-key":INTELX_KEY}, timeout=10)
        for s in r2.json().get("selectors",[]):
            v = s.get("selectorvalue","")
            if "@" in v and "noreply" not in v:
                return v
    except Exception:
        pass
    return ""

all_results = []
print(f"Checking {len(WALLETS)} EVM wallets...\n")

for addr, bal, cat, age, nft_count in WALLETS:
    print(f"\n{'='*60}")
    print(f"${bal:.1f}M  {cat}  age={age:.0f}mo  NFTs={nft_count}")
    print(f"{addr}")

    found_twitter = ""
    found_email   = ""
    source = ""
    tw_data = {}

    # 1. Blur profile
    blur = blur_profile(addr)
    if blur.get("blur_twitter"):
        found_twitter = blur["blur_twitter"]
        source = "Blur"
        print(f"  Blur Twitter: @{found_twitter}")
    elif blur.get("blur_username"):
        print(f"  Blur username: {blur['blur_username']} (no Twitter)")

    # 2. Foundation profile
    if not found_twitter:
        fn = foundation_profile(addr)
        if fn.get("fn_twitter"):
            found_twitter = fn["fn_twitter"]
            source = "Foundation"
            print(f"  Foundation Twitter: @{found_twitter}")
        elif fn.get("fn_username"):
            print(f"  Foundation user: {fn['fn_username']} (no Twitter)")

    # 3. LooksRare profile
    if not found_twitter:
        lr = looksrare_profile(addr)
        if lr.get("lr_twitter"):
            found_twitter = lr["lr_twitter"]
            source = "LooksRare"
            print(f"  LooksRare Twitter: @{found_twitter}")
        elif lr.get("lr_name"):
            print(f"  LooksRare name: {lr['lr_name']} (no Twitter)")

    # 4. Serper deep search
    serper_hits = serper_deep(addr, nft_count)
    if serper_hits:
        print(f"  Serper hits ({len(serper_hits)}):")
        for h in serper_hits[:4]:
            print(f"    @{h['handle']:<25}  {h['title'][:50]}")

    # 5. Twitter check for any found handle
    if found_twitter:
        tw_data = twitter_check(found_twitter)
        if tw_data:
            tc = tw_data.get("tweet_count",0)
            cs = tw_data.get("crypto_score",0)
            fl = tw_data.get("followers",0)
            print(f"  @{found_twitter}: {tc} tweets | {fl} followers | crypto={cs}")
            print(f"  Bio: {tw_data.get('bio','')[:100]}")
            if tw_data.get("email"):
                found_email = tw_data["email"]
                print(f"  ✓ Email in bio: {found_email}")

    # Also check Serper handles via Twitter
    if not found_email and serper_hits:
        for hit in serper_hits[:3]:
            h = hit["handle"]
            if h in ("snxwhalewatch","0xShibStats","GodotSancho","AnonymHodler",
                     "snxwhalewatch","etherscan"):
                continue  # skip known bots/trackers
            tw = twitter_check(h)
            if tw and tw.get("tweet_count",9999) < 3000:
                cs = tw.get("crypto_score",0)
                tc = tw.get("tweet_count",0)
                print(f"  Checking @{h}: {tc} tweets, crypto_score={cs}, bio={tw.get('bio','')[:70]}")
                if tw.get("email"):
                    found_email = tw["email"]
                    found_twitter = h
                    source = "Serper+Twitter"
                    tw_data = tw
                    print(f"  ✓ Found email: {found_email}")
                    break
            time.sleep(0.3)

    # 6. IntelX on Twitter handle
    if found_twitter and not found_email:
        ix = intelx_search(found_twitter)
        if ix:
            found_email = ix
            print(f"  ✓ IntelX: {found_email}")
        time.sleep(1)

    if not found_twitter and not found_email:
        print(f"  — nothing found")

    all_results.append({
        "wallet_address": addr,
        "usd_balance": bal,
        "category": cat,
        "age_months": age,
        "nft_count": nft_count,
        "twitter_handle": found_twitter,
        "twitter_source": source,
        "tweet_count": tw_data.get("tweet_count",0),
        "followers": tw_data.get("followers",0),
        "crypto_score": tw_data.get("crypto_score",0),
        "twitter_bio": tw_data.get("bio",""),
        "twitter_name": tw_data.get("name",""),
        "location": tw_data.get("location",""),
        "email": found_email,
        "serper_handles": [h["handle"] for h in serper_hits[:5]],
    })
    time.sleep(0.8)

with open("outputs/nft_twitter_profiles.json","w",encoding="utf-8") as f:
    json.dump(all_results, f, indent=2, ensure_ascii=False)

print(f"\n{'='*60}")
print("FINAL RESULTS")
print(f"{'='*60}")
with_tw    = [r for r in all_results if r.get("twitter_handle")]
with_email = [r for r in all_results if r.get("email")]
stealth    = [r for r in with_tw if r.get("crypto_score",9)<=1 and r.get("tweet_count",9999)<2000]

print(f"Twitter found:  {len(with_tw)}/15")
print(f"Emails found:   {len(with_email)}/15")
print(f"Stealth users:  {len(stealth)}")

if with_tw:
    print(f"\n--- Twitter Results ---")
    for r in sorted(with_tw, key=lambda x: x.get("tweet_count",9999)):
        tc = r.get("tweet_count",0); cs = r.get("crypto_score",0)
        fl = r.get("followers",0); em = r.get("email","")
        flag = " ★STEALTH" if cs<=1 and tc<2000 else ""
        print(f"  ${r['usd_balance']:.1f}M  @{r['twitter_handle']:<22} "
              f"tweets={tc:<6} crypto={cs} email={em or '-'}{flag}")

if with_email:
    print(f"\n--- Emails ---")
    for r in with_email:
        print(f"  ${r['usd_balance']:.1f}M  @{r['twitter_handle']}  →  {r['email']}")

print(f"\nSaved → outputs/nft_twitter_profiles.json")
