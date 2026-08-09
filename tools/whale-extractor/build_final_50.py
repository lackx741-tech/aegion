"""
build_final_50.py — After EVM scan completes, combines EVM + valid TRON records,
runs email enrichment, and outputs final 50 whale list.

Known TRON exchange/contract/sanctioned addresses to exclude:
"""
import sys, os, json, time, csv, re, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv(".env")

INTELX_KEY  = os.getenv("INTELX_KEY","")
INTELX_HOST = os.getenv("INTELX_HOST","https://free.intelx.io")
SERPER_KEY  = os.getenv("SERPER_KEY","")
TW_BEARER   = os.getenv("TWITTER_BEARER","")
ALCHEMY_KEY = os.getenv("ALCHEMY_KEYS","").split(",")[0].strip()
GITHUB_TOKEN= os.getenv("GITHUB_TOKEN","")

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

# Known non-personal TRON addresses (exchanges, contracts, sanctioned)
EXCLUDE_TRON = {
    "TFQbqaNbmq2xsVor2NbufLkYZvxFC9wC7k",  # OFAC-sanctioned (OpenSanctions ofac-17521)
    "TSUUVjysXV8YqHytSNjfkNXnnB49QDvZpx",  # Smart contract (CreatedByContract on TronScan)
    "TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5",  # sTRX staking proxy contract
    "TF2fmSbg5HAD34KPUH7WtWCxxvgXHohzYM",  # Huobi exchange wallet (in Huobi POR snapshot)
    "TYh6mgoMNZTCsgpYHBz7gttEfrQmDMABub",  # Huobi exchange wallet (in Huobi POR snapshot)
    "TZ1SsapyhKNWaVLca6P2qgVzkHTdk6nkXa",  # HTX/Justin Sun USDD reserve wallet (Protos)
    "TGTsSX3L2BF7jcYW1695k63uTmU7YBVGQu",  # USDT-blacklisted address (@USDTBanList tweet)
    "TKFuckiRGCTerroristsNoBiTEXy2r7mNX",  # Name contains "Terrorists" — likely sanctions-related
}

# ── ENS helpers ────────────────────────────────────────────────────────────────
import hashlib

def _namehash(name: str) -> str:
    node = b'\x00' * 32
    if name:
        for label in reversed(name.split('.')):
            node = hashlib.sha3_256(node + hashlib.sha3_256(label.encode()).digest()).digest()
    return node.hex()

def ens_reverse(addr: str) -> str:
    if not ALCHEMY_KEY or not addr.startswith("0x"): return ""
    try:
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

def twitter_bio_email(handle: str) -> str:
    if not handle or not TW_BEARER: return ""
    clean = handle.lstrip("@")
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{clean}",
            params={"user.fields":"description,url,entities"},
            headers={"Authorization": f"Bearer {TW_BEARER}"}, timeout=10)
        if r.status_code != 200: return ""
        u = r.json().get("data", {})
        # Check entities for expanded URL
        url_text = ""
        for ent in (u.get("entities",{}).get("url",{}).get("urls") or []):
            url_text += " " + ent.get("expanded_url","")
        bio = u.get("description","") + " " + u.get("url","") + url_text
        hits = EMAIL_RE.findall(bio)
        for h in hits:
            if "noreply" not in h and "example" not in h:
                return h
    except Exception:
        pass
    return ""

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
        return list(dict.fromkeys([
            s["selectorvalue"] for s in selectors
            if s.get("selectorvalue") and "@" in s.get("selectorvalue","")
        ]))[:5]
    except Exception:
        return []

def serper_email(query: str) -> str:
    if not SERPER_KEY or not query: return ""
    try:
        r = requests.post(
            "https://google.serper.dev/search",
            json={"q": query, "num": 10},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10)
        if not r.ok: return ""
        for res in r.json().get("organic", []):
            text = res.get("title","") + " " + res.get("snippet","")
            hits = EMAIL_RE.findall(text)
            for h in hits:
                if "noreply" not in h and "example" not in h:
                    return h
    except Exception:
        pass
    return ""

def github_commit_email(username: str) -> str:
    if not username: return ""
    clean = username.replace("https://github.com/","").replace("http://github.com/","").strip("/")
    if not clean: return ""
    try:
        hdrs = {"Authorization": f"token {GITHUB_TOKEN}"} if GITHUB_TOKEN else {}
        r = requests.get(f"https://api.github.com/users/{clean}/events/public?per_page=30",
                         headers=hdrs, timeout=10)
        for ev in (r.json() if isinstance(r.json(), list) else []):
            for c in (ev.get("payload") or {}).get("commits", []):
                email = (c.get("author") or {}).get("email","")
                if email and "noreply" not in email and "@" in email:
                    return email
    except Exception:
        pass
    return ""

def enrich_evm(w: dict) -> dict:
    """Deep email enrichment for EVM wallets."""
    addr    = w.get("wallet_address","")
    balance = float(w.get("usd_balance",0))
    ens     = w.get("ens_name","") or ""
    twitter = w.get("twitter_handle","") or w.get("ens_twitter","") or ""
    fc      = w.get("farcaster_user","") or ""
    email   = w.get("email","") or w.get("ens_email","") or ""
    github  = ""

    result = {
        "wallet_address": addr,
        "usd_balance":    balance,
        "source_chain":   w.get("source_chain","eth"),
        "chains_active":  w.get("chains_active",""),
        "age_months":     w.get("wallet_age_months",0),
        "category":       w.get("whale_category",""),
        "ens_name":       ens,
        "twitter":        twitter,
        "farcaster":      fc,
        "email":          email,
        "email_source":   "existing" if email else "",
        "ai_summary":     w.get("ai_summary",""),
        "outreach":       w.get("outreach_channel","onchain"),
        "notes":          "",
    }

    if email:
        return result

    # 1. ENS already fetched during main scan — only fallback lookup if missing
    if not ens and addr.startswith("0x"):
        ens = ens_reverse(addr)
        if ens:
            result["ens_name"] = ens
            print(f"    ENS: {ens}")

    # 2. ENS text records
    if ens:
        for key in ["email", "com.twitter", "com.github", "org.telegram"]:
            val = ens_text(ens, key)
            if val:
                if key == "email":
                    result["email"] = val; result["email_source"] = "ENS text"
                    print(f"    ✓ ENS email: {val}"); return result
                elif key == "com.twitter" and not twitter:
                    twitter = result["twitter"] = val
                elif key == "com.github" and not github:
                    github = val

    # 3. Twitter bio email
    if twitter:
        email = twitter_bio_email(twitter)
        if email:
            result["email"] = email; result["email_source"] = "Twitter bio"
            print(f"    ✓ Twitter email: {email}"); return result

    # 4. GitHub commit email
    if github:
        email = github_commit_email(github)
        if email:
            result["email"] = email; result["email_source"] = "GitHub"
            print(f"    ✓ GitHub email: {email}"); return result

    # 5. IntelX: ENS, Twitter, address prefix
    for query in [q for q in [ens, twitter, addr] if q]:
        emails = intelx_emails(query)
        if emails:
            result["email"] = emails[0]; result["email_source"] = f"IntelX"
            if len(emails) > 1:
                result["notes"] = "extras: " + ", ".join(emails[1:])
            print(f"    ✓ IntelX: {emails[0]}"); return result
        time.sleep(1)

    # 6. Serper web search
    q = f'"{ens}" email' if ens else (f'"{twitter}" email contact crypto' if twitter else
                                      f'"{addr}" email site:github.com OR site:twitter.com')
    email = serper_email(q)
    if email:
        result["email"] = email; result["email_source"] = "web search"
        print(f"    ✓ Serper: {email}")

    if not result["email"]:
        print(f"    — no email")

    return result


def main():
    in_file = sys.argv[1] if len(sys.argv) > 1 else "outputs/whale_data.json"

    print(f"\nLoading {in_file}…")
    with open(in_file, encoding="utf-8") as f:
        all_records = json.load(f)

    # Separate EVM and TRON
    evm   = [r for r in all_records if r.get("source_chain","eth") != "tron" and
             float(r.get("usd_balance",0)) >= 2_000_000]
    tron  = [r for r in all_records if r.get("source_chain") == "tron" and
             float(r.get("usd_balance",0)) >= 2_000_000 and
             r.get("wallet_address","") not in EXCLUDE_TRON]

    print(f"EVM whales (≥$2M): {len(evm)}")
    print(f"TRON whales (≥$2M, filtered): {len(tron)}")
    print(f"Total combined: {len(evm)+len(tron)}")

    # Enrich EVM (has ENS/Twitter potential)
    enriched_evm = []
    print(f"\n{'='*60}")
    print("ENRICHING EVM WALLETS…")
    print(f"{'='*60}")
    for i, w in enumerate(evm, 1):
        addr = w.get("wallet_address","")
        bal  = float(w.get("usd_balance",0))
        ens  = w.get("ens_name","") or "-"
        tw   = w.get("twitter_handle","") or "-"
        print(f"\n[EVM {i}/{len(evm)}] {addr[:12]}…  ${bal/1e6:.2f}M  ENS={ens}  TW={tw}")
        enriched_evm.append(enrich_evm(w))
        time.sleep(0.4)

    # TRON: minimal enrichment (no ENS, minimal contact info)
    enriched_tron = []
    print(f"\n{'='*60}")
    print("PROCESSING TRON WALLETS (onchain only)…")
    print(f"{'='*60}")
    for w in tron:
        addr = w.get("wallet_address","")
        bal  = float(w.get("usd_balance",0))
        enriched_tron.append({
            "wallet_address": addr,
            "usd_balance":    bal,
            "source_chain":   "tron",
            "chains_active":  "tron",
            "age_months":     w.get("wallet_age_months",0),
            "category":       w.get("whale_category",""),
            "ens_name":       "",
            "twitter":        "",
            "farcaster":      "",
            "email":          "",
            "email_source":   "",
            "ai_summary":     w.get("ai_summary",""),
            "outreach":       "onchain",
            "notes":          "",
        })

    # Combine and sort
    combined = enriched_evm + enriched_tron
    combined.sort(key=lambda x: float(x.get("usd_balance",0)), reverse=True)
    top50 = combined[:50]

    # Save JSON
    with open("outputs/whale_final_50.json", "w", encoding="utf-8") as f:
        json.dump(top50, f, indent=2, ensure_ascii=False)

    # Save CSV
    fields = ["wallet_address","usd_balance","source_chain","chains_active",
              "age_months","category","ens_name","twitter","farcaster",
              "email","email_source","outreach","ai_summary","notes"]
    with open("outputs/whale_final_50.csv", "w", newline="", encoding="utf-8") as f:
        w2 = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w2.writeheader()
        w2.writerows(top50)

    # Stats
    print(f"\n{'='*60}")
    print(f"✅  FINAL OUTPUT — Top 50 Whales")
    print(f"{'='*60}")
    print(f"  Total candidates: {len(combined)}")
    print(f"  EVM: {len(enriched_evm)}  TRON: {len(enriched_tron)}")
    with_email = [x for x in top50 if x.get("email")]
    with_tw    = [x for x in top50 if x.get("twitter")]
    with_ens   = [x for x in top50 if x.get("ens_name")]
    print(f"  With email:   {len(with_email)}")
    print(f"  With Twitter: {len(with_tw)}")
    print(f"  With ENS:     {len(with_ens)}")
    print(f"  Onchain only: {len(top50)-len(with_email)-len(with_tw)}")
    print(f"\n  {'#':<3} {'Address':<20} {'Balance':>12} {'Chain':<6} {'Email':<30} {'Twitter':<20}")
    print(f"  {'-'*95}")
    for rank, x in enumerate(top50[:50], 1):
        addr  = x["wallet_address"]
        bal   = x["usd_balance"]
        chain = x.get("source_chain","eth")[:4]
        email = x.get("email","")[:28] or "-"
        tw    = x.get("twitter","")[:18] or "-"
        print(f"  {rank:<3} {addr[:18]:<20} ${bal/1e6:>10.2f}M {chain:<6} {email:<30} {tw}")
    print(f"\n  Saved → outputs/whale_final_50.json")
    print(f"  Saved → outputs/whale_final_50.csv")


if __name__ == "__main__":
    main()
