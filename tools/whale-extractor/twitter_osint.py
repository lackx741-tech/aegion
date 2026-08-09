"""
twitter_osint.py — EVM whale wallets ka Twitter dhundho via DeBank/OpenSea/Galxe,
filter karo low-activity non-crypto users, email extract karo.
"""
import sys, os, json, time, requests, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv; load_dotenv(".env")

TW_BEARER  = os.getenv("TWITTER_BEARER","")
SERPER_KEY = os.getenv("SERPER_KEY","")
INTELX_KEY = os.getenv("INTELX_KEY","")
INTELX_HOST= os.getenv("INTELX_HOST","https://free.intelx.io")
OS_KEY     = os.getenv("OPENSEA_KEY","")

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
CRYPTO_KW = {"crypto","defi","web3","nft","blockchain","hodl","trading","trader",
             "investor","bitcoin","ethereum","btc","eth","token","dao","degen",
             "whale","altcoin","airdrop","yield","staking","protocol","wagmi","gm"}

with open("outputs/whale_final_50.json", encoding="utf-8") as f:
    all50 = json.load(f)

evm = [r for r in all50 if r.get("source_chain","eth") != "tron"]
print(f"EVM wallets to check: {len(evm)}")
print("="*60)

# ── 1. OpenSea profile ──────────────────────────────────────────────────────
def opensea_profile(addr):
    hdrs = {"Accept":"application/json"}
    if OS_KEY: hdrs["x-api-key"] = OS_KEY
    try:
        r = requests.get(f"https://api.opensea.io/api/v2/accounts/{addr}",
                         headers=hdrs, timeout=10)
        if r.ok:
            d = r.json()
            username = d.get("username","")
            twitter  = d.get("twitter_username","")
            discord  = d.get("discord_username","")
            bio      = d.get("bio","")
            return {"os_username": username, "twitter": twitter,
                    "discord": discord, "bio": bio}
    except Exception as e:
        pass
    return {}

# ── 2. DeBank social info ───────────────────────────────────────────────────
def debank_profile(addr):
    try:
        r = requests.get(f"https://api.debank.com/user?id={addr.lower()}",
                         headers={"User-Agent":"Mozilla/5.0"}, timeout=10)
        if r.ok:
            d = r.json().get("data",{}).get("user",{})
            tw = d.get("twitter_name","") or d.get("twitter_username","")
            return {"twitter": tw, "debank_name": d.get("name","")}
    except Exception:
        pass
    return {}

# ── 3. Galxe (Galaxy) — wallet → Twitter ───────────────────────────────────
GALXE_GQL = "https://graphigo.prd.galaxy.eco/query"
def galxe_profile(addr):
    query = """query($addr:String!){
      addressInfo(address:$addr){
        id username avatar twitterUserName discordUserName email
      }
    }"""
    try:
        r = requests.post(GALXE_GQL,
            json={"query": query, "variables": {"addr": addr}},
            headers={"Content-Type":"application/json"}, timeout=10)
        if r.ok:
            info = r.json().get("data",{}).get("addressInfo",{})
            if info:
                return {
                    "galxe_user": info.get("username",""),
                    "twitter": info.get("twitterUserName",""),
                    "email": info.get("email",""),
                    "discord": info.get("discordUserName",""),
                }
    except Exception:
        pass
    return {}

# ── 4. Twitter user details ─────────────────────────────────────────────────
def twitter_user(handle):
    if not handle or not TW_BEARER: return {}
    clean = handle.lstrip("@").strip()
    if not clean or "/" in clean or "." in clean: return {}
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{clean}",
            params={"user.fields":"description,public_metrics,url,entities,location"},
            headers={"Authorization": f"Bearer {TW_BEARER}"}, timeout=10)
        if r.status_code == 404: return {"not_found": True}
        if not r.ok: return {}
        u = r.json().get("data",{})
        metrics = u.get("public_metrics",{})
        bio = u.get("description","")
        # Expand URLs in bio
        url_text = ""
        for ent in (u.get("entities",{}).get("url",{}).get("urls") or []):
            url_text += " " + ent.get("expanded_url","")
        full_text = bio + " " + u.get("url","") + url_text

        emails = EMAIL_RE.findall(full_text)
        email = next((e for e in emails if "noreply" not in e and "example" not in e), "")

        bio_words = set(bio.lower().split())
        crypto_score = len(bio_words & CRYPTO_KW)
        tweet_count  = metrics.get("tweet_count",9999)
        followers    = metrics.get("followers_count",0)

        return {
            "handle": clean,
            "name": u.get("name",""),
            "bio": bio[:150],
            "location": u.get("location",""),
            "tweet_count": tweet_count,
            "followers": followers,
            "email_from_bio": email,
            "crypto_score": crypto_score,
        }
    except Exception as e:
        return {}

# ── 5. IntelX email search ──────────────────────────────────────────────────
def intelx_email(query):
    if not INTELX_KEY or not query: return ""
    try:
        r = requests.post(f"{INTELX_HOST}/phonebook/search",
            json={"term": query, "target": 2, "maxresults": 5, "terminate": []},
            headers={"x-key": INTELX_KEY}, timeout=10)
        sid = r.json().get("id","")
        if not sid: return ""
        time.sleep(3)
        r2 = requests.get(f"{INTELX_HOST}/phonebook/search/result",
            params={"id": sid, "limit": 5, "offset": 0},
            headers={"x-key": INTELX_KEY}, timeout=10)
        for s in r2.json().get("selectors",[]):
            v = s.get("selectorvalue","")
            if "@" in v and "noreply" not in v:
                return v
    except Exception:
        pass
    return ""

# ── 6. Serper web search for email ─────────────────────────────────────────
def serper_email(query):
    if not SERPER_KEY or not query: return ""
    try:
        r = requests.post("https://google.serper.dev/search",
            json={"q": query, "num": 10},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type":"application/json"},
            timeout=10)
        if not r.ok: return ""
        for res in r.json().get("organic",[]):
            text = res.get("title","") + " " + res.get("snippet","")
            hits = EMAIL_RE.findall(text)
            for h in hits:
                if "noreply" not in h and "example" not in h:
                    return h
    except Exception:
        pass
    return ""

# ── Main loop ───────────────────────────────────────────────────────────────
results = []
qualified = []  # low-activity non-crypto users with email

for i, rec in enumerate(evm, 1):
    addr = rec["wallet_address"]
    bal  = float(rec["usd_balance"])
    cat  = rec.get("category","")
    print(f"\n[{i}/{len(evm)}] {addr[:16]}…  ${bal/1e6:.2f}M  {cat}")

    twitter_handle = ""
    email = ""
    source = ""
    tw_info = {}

    # --- Platform lookups ---
    os_data = opensea_profile(addr)
    if os_data.get("twitter"):
        twitter_handle = os_data["twitter"]
        source = "OpenSea"
        print(f"  OpenSea Twitter: @{twitter_handle}")
    elif os_data.get("os_username"):
        print(f"  OpenSea username: {os_data['os_username']} (no Twitter)")

    if not twitter_handle:
        db = debank_profile(addr)
        if db.get("twitter"):
            twitter_handle = db["twitter"]
            source = "DeBank"
            print(f"  DeBank Twitter: @{twitter_handle}")
        elif db.get("debank_name"):
            print(f"  DeBank name: {db['debank_name']} (no Twitter)")

    if not twitter_handle:
        gx = galxe_profile(addr)
        if gx.get("twitter"):
            twitter_handle = gx["twitter"]
            source = "Galxe"
            print(f"  Galxe Twitter: @{twitter_handle}")
        if gx.get("email"):
            email = gx["email"]
            print(f"  Galxe email: {email}")

    # --- Twitter profile check ---
    if twitter_handle:
        tw_info = twitter_user(twitter_handle)
        if tw_info.get("not_found"):
            print(f"  Twitter @{twitter_handle} not found")
            twitter_handle = ""
        elif tw_info:
            tc = tw_info.get("tweet_count",0)
            cs = tw_info.get("crypto_score",0)
            fl = tw_info.get("followers",0)
            print(f"  @{twitter_handle} — {tc} tweets | {fl} followers | crypto_score={cs}")
            print(f"  Bio: {tw_info.get('bio','')[:100]}")

            # Get email from Twitter bio
            if tw_info.get("email_from_bio"):
                email = tw_info["email_from_bio"]
                print(f"  ✓ Email in bio: {email}")

    # --- IntelX / Serper for email ---
    if twitter_handle and not email:
        ix = intelx_email(twitter_handle)
        if ix:
            email = ix; print(f"  ✓ IntelX: {email}")
        else:
            time.sleep(1)

    if twitter_handle and not email:
        q = f'"{twitter_handle}" email contact'
        em = serper_email(q)
        if em:
            email = em; print(f"  ✓ Serper: {email}")

    # --- Also try wallet address on Serper if no Twitter found ---
    if not twitter_handle and not email:
        q = f'"{addr}" site:twitter.com OR site:x.com'
        em = serper_email(q)
        if em:
            email = em; print(f"  ✓ Serper addr: {email}")

    if not twitter_handle and not email:
        print(f"  — nothing found")

    rec_out = {
        "wallet_address": addr,
        "usd_balance": bal,
        "source_chain": "eth",
        "chains_active": rec.get("chains_active",""),
        "category": cat,
        "twitter_handle": twitter_handle,
        "twitter_source": source,
        "tweet_count": tw_info.get("tweet_count",0) if tw_info else 0,
        "followers": tw_info.get("followers",0) if tw_info else 0,
        "crypto_score": tw_info.get("crypto_score",0) if tw_info else 0,
        "twitter_bio": tw_info.get("bio","") if tw_info else "",
        "twitter_name": tw_info.get("name","") if tw_info else "",
        "location": tw_info.get("location","") if tw_info else "",
        "email": email,
        "email_source": source if email else "",
    }
    results.append(rec_out)

    # Qualify: has twitter + low crypto talk + not too many tweets
    if twitter_handle and tw_info and not tw_info.get("not_found"):
        tc = tw_info.get("tweet_count",9999)
        cs = tw_info.get("crypto_score",0)
        if cs <= 1 and tc < 2000:
            qualified.append(rec_out)
            print(f"  ★ QUALIFIED (stealth, cs={cs}, tweets={tc})")

    time.sleep(0.5)

# Save all results
with open("outputs/evm_twitter_osint.json","w",encoding="utf-8") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

print(f"\n{'='*60}")
print(f"RESULTS")
print(f"{'='*60}")
found_tw    = [r for r in results if r.get("twitter_handle")]
found_email = [r for r in results if r.get("email")]
print(f"Twitter found:     {len(found_tw)}/{len(evm)}")
print(f"Emails found:      {len(found_email)}/{len(evm)}")
print(f"Stealth qualified: {len(qualified)}")

if found_tw:
    print(f"\n--- Twitter Found ---")
    for r in sorted(found_tw, key=lambda x: x.get("tweet_count",9999)):
        tc = r.get("tweet_count",0); cs = r.get("crypto_score",0)
        fl = r.get("followers",0); em = r.get("email","")
        flag = "★ STEALTH" if cs<=1 and tc<2000 else ""
        print(f"  ${r['usd_balance']/1e6:.1f}M  @{r['twitter_handle']:<25} tweets={tc:<6} cs={cs}  email={em or '-'}  {flag}")

if found_email:
    print(f"\n--- Emails Found ---")
    for r in found_email:
        print(f"  ${r['usd_balance']/1e6:.1f}M  @{r['twitter_handle']}  → {r['email']}")

print(f"\nSaved → outputs/evm_twitter_osint.json")
