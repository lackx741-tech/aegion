"""
tronscan_lookup.py — Lookup TRON wallet names/labels from TronScan API
and search for contact info via multiple sources.
"""
import sys, os, json, time, requests, re
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from dotenv import load_dotenv
load_dotenv(".env")

SERPER_KEY = os.getenv("SERPER_KEY","")
INTELX_KEY = os.getenv("INTELX_KEY","")
INTELX_HOST = os.getenv("INTELX_HOST","https://free.intelx.io")
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

with open("outputs/whale_data.json") as f:
    records = json.load(f)

tron_records = [r for r in records if r.get("source_chain") == "tron"]
print(f"TRON wallets to check: {len(tron_records)}")

def tronscan_account(addr: str) -> dict:
    """Fetch TronScan account info — may have name, risk tags, type."""
    try:
        r = requests.get(
            f"https://apilist.tronscan.io/api/account",
            params={"address": addr},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10)
        if r.ok:
            return r.json()
    except Exception:
        pass
    return {}

def tronscan_token_label(addr: str) -> str:
    """Check if address is a known token contract or exchange wallet."""
    try:
        r = requests.get(
            f"https://apilist.tronscan.io/api/address/token_list",
            params={"address": addr, "limit": 1},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10)
        if r.ok:
            d = r.json()
            return d.get("name","") or d.get("label","") or ""
    except Exception:
        pass
    return ""

def serper_search(addr: str) -> dict:
    """Search Google for the TRON address to find any associated identity."""
    if not SERPER_KEY:
        return {}
    results = []
    email_found = ""
    twitter_found = ""
    try:
        r = requests.post(
            "https://google.serper.dev/search",
            json={"q": f'"{addr}"', "num": 10},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10)
        if r.ok:
            for res in r.json().get("organic", []):
                snippet = res.get("title","") + " " + res.get("snippet","")
                link = res.get("link","")
                results.append({"title": res.get("title",""), "link": link, "snippet": res.get("snippet","")[:100]})
                # Look for email
                if not email_found:
                    hits = EMAIL_RE.findall(snippet)
                    for h in hits:
                        if "noreply" not in h and "example" not in h:
                            email_found = h
                            break
                # Look for Twitter handle
                if not twitter_found and "twitter.com/" in link:
                    m = re.search(r"twitter\.com/([A-Za-z0-9_]{1,50})", link)
                    if m and m.group(1) not in ("intent","share","status"):
                        twitter_found = "@" + m.group(1)
    except Exception as e:
        pass
    return {"results": results, "email": email_found, "twitter": twitter_found}

def intelx_search(query: str) -> list:
    if not INTELX_KEY or not query:
        return []
    try:
        r = requests.post(
            f"{INTELX_HOST}/phonebook/search",
            json={"term": query, "target": 2, "maxresults": 10, "terminate": []},
            headers={"x-key": INTELX_KEY}, timeout=10)
        sid = r.json().get("id","")
        if not sid:
            return []
        time.sleep(3)
        r2 = requests.get(
            f"{INTELX_HOST}/phonebook/search/result",
            params={"id": sid, "limit": 10, "offset": 0},
            headers={"x-key": INTELX_KEY}, timeout=10)
        selectors = r2.json().get("selectors", [])
        return [s["selectorvalue"] for s in selectors
                if s.get("selectorvalue") and "@" in s.get("selectorvalue","")]
    except Exception:
        return []

results = []
found_any = False

for i, rec in enumerate(tron_records, 1):
    addr = rec.get("wallet_address","")
    bal = float(rec.get("usd_balance",0))
    print(f"\n[{i}/{len(tron_records)}] {addr}  ${bal/1e6:.2f}M")

    info = {}

    # 1. TronScan account metadata
    ts = tronscan_account(addr)
    name = ts.get("name","") or ts.get("accountName","") or ""
    acc_type = ts.get("accountType","")  # 0=normal, 1=contract, 2=Sr
    risk = ts.get("risk","") or ts.get("riskLevel","") or ""
    tag  = ts.get("tag","") or ""

    if name:
        print(f"  TronScan name: {name}")
        info["name"] = name
        found_any = True
    if tag:
        print(f"  TronScan tag:  {tag}")
        info["tag"] = tag
        found_any = True

    # 2. Serper web search for the full address
    web = serper_search(addr)
    if web.get("email"):
        print(f"  ✓ Email found: {web['email']}")
        info["email"] = web["email"]
        found_any = True
    if web.get("twitter"):
        print(f"  ✓ Twitter found: {web['twitter']}")
        info["twitter"] = web["twitter"]
        found_any = True
    if web.get("results"):
        top = web["results"][0]
        print(f"  Web: {top['title'][:60]}  |  {top['link'][:60]}")
        info["web_results"] = web["results"]

    # 3. IntelX search with full TRON address
    emails = intelx_search(addr)
    if emails:
        print(f"  ✓ IntelX emails: {emails}")
        info["intelx_emails"] = emails
        found_any = True

    rec_out = dict(rec)
    rec_out.update(info)
    results.append(rec_out)

    time.sleep(0.8)  # rate limit

# Save enriched results
with open("outputs/tron_enriched.json", "w", encoding="utf-8") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

print(f"\n{'='*60}")
print(f"Done. Any contact info found: {found_any}")
print(f"Saved → outputs/tron_enriched.json")

# Summary of non-empty fields
with_name    = [r for r in results if r.get("name")]
with_tag     = [r for r in results if r.get("tag")]
with_email   = [r for r in results if r.get("email")]
with_twitter = [r for r in results if r.get("twitter")]
print(f"\nTronScan names: {len(with_name)}")
print(f"TronScan tags:  {len(with_tag)}")
print(f"Emails found:   {len(with_email)}")
print(f"Twitter found:  {len(with_twitter)}")
if with_email:
    for r in with_email:
        print(f"  {r['wallet_address']}  ${float(r['usd_balance'])/1e6:.2f}M  → {r['email']}")
