"""
email_enricher.py — Post-scan email/contact finder for $2M+ whales
Reads whale_data.json → enriches with email from:
  1. ENS text records (email, github, twitter, telegram fields)
  2. Twitter bio email extraction
  3. IntelX phonebook search (by address/ENS/twitter)
  4. Serper/Google web search
  5. GitHub public events commit email
Writes whale_final_50.json and whale_final_50.csv
"""
import sys, os, re, json, time, hashlib, csv, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv(".env")

ALCHEMY_KEY   = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip() or os.getenv("ALCHEMY_KEY","")
INTELX_KEY    = os.getenv("INTELX_KEY","")
INTELX_HOST   = os.getenv("INTELX_HOST","https://free.intelx.io")
SERPER_KEY    = os.getenv("SERPER_KEY","")
TW_BEARER     = os.getenv("TWITTER_BEARER","")
GITHUB_TOKEN  = os.getenv("GITHUB_TOKEN","")

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

# ── ENS helpers ────────────────────────────────────────────────────────────────
def _namehash(name: str) -> str:
    node = b'\x00' * 32
    if name:
        for label in reversed(name.split('.')):
            node = hashlib.sha3_256(node + hashlib.sha3_256(label.encode()).digest()).digest()
    return node.hex()

def ens_reverse(addr: str) -> str:
    try:
        reverse_node = _namehash(addr[2:].lower() + ".addr.reverse")
        data = "0x691f3431" + "000000000000000000000000" + addr[2:].lower().zfill(64)
        r = requests.post(
            f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}",
            json={"jsonrpc":"2.0","id":1,"method":"eth_call",
                  "params":[{"to":"0x4976fb03c32e5b8cfe2b6dcb31ac5dec6bc5e8b5","data":data},"latest"]},
            timeout=8)
        raw = r.json().get("result","")
        if raw and raw != "0x" and len(raw) > 130:
            offset = int(raw[2:66], 16) * 2 + 2
            length = int(raw[offset:offset+64], 16)
            name = bytes.fromhex(raw[offset+64:offset+64+length*2]).decode("utf-8","ignore").strip()
            return name if "." in name else ""
    except Exception:
        pass
    return ""

def ens_text(ens_name: str, key: str) -> str:
    if not ens_name: return ""
    try:
        node = _namehash(ens_name)
        key_enc = key.encode()
        pad_len = 32 - (len(key_enc) % 32) if len(key_enc) % 32 else 0
        key_padded = (key_enc + b'\x00' * pad_len).hex()
        data = ("0x59d1d43c" + node
                + "0000000000000000000000000000000000000000000000000000000000000040"
                + hex(len(key_enc))[2:].zfill(64)
                + key_padded.ljust(64, "0"))
        r = requests.post(
            f"https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_KEY}",
            json={"jsonrpc":"2.0","id":1,"method":"eth_call",
                  "params":[{"to":"0x4976fb03c32e5b8cfe2b6dcb31ac5dec6bc5e8b5","data":data},"latest"]},
            timeout=8)
        raw = r.json().get("result","")
        if raw and raw != "0x" and len(raw) > 130:
            offset = int(raw[2:66], 16) * 2 + 2
            length = int(raw[offset:offset+64], 16)
            return bytes.fromhex(raw[offset+64:offset+64+length*2]).decode("utf-8","ignore").strip()
    except Exception:
        pass
    return ""

# ── Twitter ────────────────────────────────────────────────────────────────────
def twitter_bio_email(handle: str) -> str:
    if not handle or not TW_BEARER: return ""
    clean = handle.lstrip("@")
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{clean}",
            params={"user.fields":"description,url"},
            headers={"Authorization": f"Bearer {TW_BEARER}"},
            timeout=10)
        if r.status_code != 200: return ""
        u = r.json().get("data", {})
        bio = u.get("description","") + " " + u.get("url","")
        hits = EMAIL_RE.findall(bio)
        for h in hits:
            if "noreply" not in h and "example" not in h:
                return h
    except Exception:
        pass
    return ""

# ── IntelX ─────────────────────────────────────────────────────────────────────
def intelx_emails(query: str) -> list:
    if not INTELX_KEY or not query: return []
    try:
        r = requests.post(
            f"{INTELX_HOST}/phonebook/search",
            json={"term": query, "target": 2, "maxresults": 10, "terminate": []},
            headers={"x-key": INTELX_KEY}, timeout=10)
        sid = r.json().get("id","")
        if not sid: return []
        time.sleep(3)
        r2 = requests.get(
            f"{INTELX_HOST}/phonebook/search/result",
            params={"id": sid, "limit": 10, "offset": 0},
            headers={"x-key": INTELX_KEY}, timeout=10)
        selectors = r2.json().get("selectors", [])
        emails = [s["selectorvalue"] for s in selectors
                  if s.get("selectorvalue") and (s.get("selectortype")==1 or "@" in s.get("selectorvalue",""))]
        return list(dict.fromkeys(emails))[:5]
    except Exception:
        return []

# ── Serper ─────────────────────────────────────────────────────────────────────
def serper_email(query: str) -> str:
    if not SERPER_KEY or not query: return ""
    try:
        r = requests.post(
            "https://google.serper.dev/search",
            json={"q": query, "num": 10},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10)
        for res in r.json().get("organic", []):
            text = res.get("title","") + " " + res.get("snippet","")
            hits = EMAIL_RE.findall(text)
            for h in hits:
                if "noreply" not in h and "example" not in h:
                    return h
    except Exception:
        pass
    return ""

# ── GitHub ─────────────────────────────────────────────────────────────────────
def github_commit_email(username: str) -> str:
    if not username: return ""
    clean = username.replace("https://github.com/","").replace("http://github.com/","").strip("/")
    if not clean: return ""
    try:
        hdrs = {"Authorization": f"token {GITHUB_TOKEN}"} if GITHUB_TOKEN else {}
        r = requests.get(f"https://api.github.com/users/{clean}/events/public?per_page=30",
                         headers=hdrs, timeout=10)
        for ev in r.json() if isinstance(r.json(), list) else []:
            for c in (ev.get("payload") or {}).get("commits", []):
                email = (c.get("author") or {}).get("email","")
                if email and "noreply" not in email and "@" in email:
                    return email
    except Exception:
        pass
    return ""

# ── Main enrichment ────────────────────────────────────────────────────────────
def enrich(w: dict) -> dict:
    addr    = w.get("wallet_address","")
    balance = float(w.get("usd_balance", 0))
    ens     = w.get("ens_name","") or ""
    twitter = w.get("twitter_handle","") or w.get("ens_twitter","") or ""
    fc      = w.get("farcaster_user","") or ""
    email   = w.get("email","") or w.get("ens_email","") or ""
    github  = w.get("ens_url","") if "github.com" in (w.get("ens_url","") or "") else ""

    print(f"  [{addr[:10]}]  ${balance:>15,.0f}  ENS={ens or '-'}  TW={twitter or '-'}")

    result = {
        "wallet_address": addr,
        "usd_balance":    balance,
        "ens_name":       ens,
        "chains_active":  w.get("chains_active",""),
        "age_months":     w.get("wallet_age_months",0),
        "category":       w.get("whale_category",""),
        "twitter":        twitter,
        "farcaster":      fc,
        "email":          email,
        "email_source":   "existing" if email else "",
        "ai_summary":     w.get("ai_summary",""),
        "msg_email":      w.get("msg_email",""),
        "outreach":       w.get("outreach_channel","onchain"),
    }

    # Already have email
    if email:
        print(f"    ✓ email already: {email}")
        return result

    # 1. ENS reverse lookup if not found
    if not ens and ALCHEMY_KEY:
        ens = ens_reverse(addr)
        if ens:
            result["ens_name"] = ens
            print(f"    ENS found: {ens}")

    # 2. ENS text records: email, com.twitter, com.github, org.telegram
    if ens:
        for key in ["email", "com.twitter", "com.github", "org.telegram"]:
            val = ens_text(ens, key)
            if val:
                if key == "email":
                    result["email"] = val; result["email_source"] = "ENS"
                    print(f"    ✓ ENS email: {val}"); return result
                elif key == "com.twitter" and not twitter:
                    twitter = result["twitter"] = val
                elif key == "com.github" and not github:
                    github = val
                elif key == "org.telegram":
                    result["farcaster"] = result["farcaster"] or val

    # 3. Twitter bio email
    if twitter:
        email = twitter_bio_email(twitter)
        if email:
            result["email"] = email; result["email_source"] = "Twitter bio"
            print(f"    ✓ Twitter bio email: {email}"); return result

    # 4. GitHub commit email
    if github:
        email = github_commit_email(github)
        if email:
            result["email"] = email; result["email_source"] = "GitHub commits"
            print(f"    ✓ GitHub email: {email}"); return result

    # 5. IntelX search: by ENS, then by address, then by twitter
    for query in [q for q in [ens, twitter, addr[:20] if not ens else ""] if q]:
        emails = intelx_emails(query)
        if emails:
            result["email"] = emails[0]; result["email_source"] = f"IntelX:{query[:20]}"
            result["intelx_extras"] = ", ".join(emails[1:])
            print(f"    ✓ IntelX: {emails[0]}"); return result
        time.sleep(1)

    # 6. Serper/Google web search
    if ens:
        email = serper_email(f'"{ens}" email contact')
    elif twitter:
        email = serper_email(f'"{twitter}" crypto email contact')
    else:
        email = serper_email(f'"{addr}" email site:github.com OR site:twitter.com')
    if email:
        result["email"] = email; result["email_source"] = "web search"
        print(f"    ✓ Web search email: {email}")

    if not result["email"]:
        print(f"    — no email found → onchain outreach only")

    return result


def main():
    import sys
    in_file  = sys.argv[1] if len(sys.argv) > 1 else "outputs/whale_data.json"
    out_json = "outputs/whale_final_50.json"
    out_csv  = "outputs/whale_final_50.csv"

    if not os.path.exists(in_file):
        print(f"ERROR: {in_file} not found — run whale_extractor.py --run first")
        sys.exit(1)

    with open(in_file, encoding="utf-8") as f:
        all_records = json.load(f)

    # Filter to $2M+ only, sort by balance desc
    whales = [w for w in all_records if float(w.get("usd_balance",0)) >= 2_000_000]
    whales.sort(key=lambda x: float(x.get("usd_balance",0)), reverse=True)

    print(f"\n🐋  Email Enricher — {len(whales)} whales at $2M+ (from {len(all_records)} total)\n")
    print("=" * 65)

    enriched = []
    for i, w in enumerate(whales, 1):
        print(f"\n[{i}/{len(whales)}]", end=" ")
        enriched.append(enrich(w))
        time.sleep(0.5)

    # Sort again by balance
    enriched.sort(key=lambda x: x["usd_balance"], reverse=True)
    top50 = enriched[:50]

    # Save JSON
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(top50, f, indent=2, ensure_ascii=False)
    print(f"\n✅  Saved {len(top50)} records → {out_json}")

    # Save CSV
    fieldnames = ["wallet_address","usd_balance","ens_name","chains_active","age_months",
                  "category","twitter","farcaster","email","email_source","outreach","ai_summary"]
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(top50)
    print(f"✅  Saved {len(top50)} records → {out_csv}")

    # Summary stats
    with_email = [x for x in top50 if x.get("email")]
    with_twitter = [x for x in top50 if x.get("twitter")]
    print(f"\n📊  Summary:")
    print(f"    Total $2M+ whales: {len(top50)}")
    print(f"    With email:        {len(with_email)}")
    print(f"    With Twitter:      {len(with_twitter)}")
    print(f"    On-chain only:     {len(top50)-len(with_email)-len(with_twitter)}")
    print(f"\n    Top 10 by balance:")
    for x in top50[:10]:
        bal = x["usd_balance"]
        bal_str = f"${bal/1e6:.2f}M" if bal < 1e9 else f"${bal/1e9:.2f}B"
        email_str = x.get("email","—")
        tw_str = x.get("twitter","")
        print(f"      {x['wallet_address'][:16]}…  {bal_str}  email={email_str}  TW={tw_str or '-'}")

if __name__ == "__main__":
    main()
