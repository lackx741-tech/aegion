"""
enrich_whales.py — Targeted email/contact enrichment for $2M+ whales
Reads whale_results.json, finds $2M+ candidates, tries GitHub API + IntelX + web for email
"""
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import json, os, re, time, requests
from dotenv import load_dotenv

load_dotenv(".env")

INTELX_KEY  = os.getenv("INTELX_KEY", "")
INTELX_HOST = os.getenv("INTELX_HOST", "https://free.intelx.io")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
SERPER_KEY  = os.getenv("SERPER_KEY", "")
TWITTER_BEARER = os.getenv("TWITTER_BEARER", "")
MIN_USD = 2_000_000

# ── known exchange/bridge/protocol addresses to skip ──────────────────────────
SKIP_KEYWORDS = (
    "mexc", "binance", "okx", "wormhole", "bridge", "foundation",
    "coinbase", "exchange", "protocol", "astar",
)

def gh_user_email(username: str) -> str:
    """GitHub public profile email (if set)."""
    if not username:
        return ""
    clean = username.strip().rstrip("/")
    # strip URL prefix if present
    clean = clean.replace("https://github.com/", "").replace("http://github.com/", "")
    if not clean:
        return ""
    try:
        hdrs = {}
        if GITHUB_TOKEN:
            hdrs["Authorization"] = f"token {GITHUB_TOKEN}"
        r = requests.get(f"https://api.github.com/users/{clean}", headers=hdrs, timeout=8)
        data = r.json()
        return data.get("email") or ""
    except Exception:
        return ""

def gh_commit_email(username: str) -> str:
    """Try to get email from GitHub public events/commits."""
    if not username:
        return ""
    clean = username.strip().rstrip("/").replace("https://github.com/", "")
    if not clean:
        return ""
    try:
        hdrs = {}
        if GITHUB_TOKEN:
            hdrs["Authorization"] = f"token {GITHUB_TOKEN}"
        # Get public events
        r = requests.get(f"https://api.github.com/users/{clean}/events/public?per_page=30",
                        headers=hdrs, timeout=10)
        events = r.json()
        if not isinstance(events, list):
            return ""
        for ev in events:
            if ev.get("type") == "PushEvent":
                commits = (ev.get("payload") or {}).get("commits", [])
                for c in commits:
                    author = c.get("author") or {}
                    email = author.get("email", "")
                    # filter noreply
                    if email and "noreply" not in email and "@" in email:
                        return email
        return ""
    except Exception:
        return ""

def intelx_search(query: str, timeout: int = 15) -> dict:
    """IntelX phonebook search — returns emails and phones."""
    if not INTELX_KEY or not query:
        return {"emails": [], "phones": []}
    try:
        # Start search
        r = requests.post(
            f"{INTELX_HOST}/phonebook/search",
            json={"term": query, "target": 2, "maxresults": 20, "terminate": []},
            headers={"x-key": INTELX_KEY},
            timeout=10,
        )
        sid = r.json().get("id", "")
        if not sid:
            return {"emails": [], "phones": []}

        time.sleep(2)

        # Fetch results
        r2 = requests.get(
            f"{INTELX_HOST}/phonebook/search/result",
            params={"id": sid, "limit": 20, "offset": 0},
            headers={"x-key": INTELX_KEY},
            timeout=10,
        )
        data = r2.json()
        selectors = data.get("selectors", [])

        emails, phones = [], []
        for s in selectors:
            val = s.get("selectorvalue", "")
            t   = s.get("selectortype", 0)
            if not val:
                continue
            if t == 1 or "@" in val:   # email
                emails.append(val)
            elif t == 3:               # phone
                phones.append(val)

        return {"emails": list(dict.fromkeys(emails)), "phones": list(dict.fromkeys(phones))}
    except Exception:
        return {"emails": [], "phones": []}

def serper_email_search(query: str) -> list:
    """Google search (via Serper) to find email for a whale."""
    if not SERPER_KEY or not query:
        return []
    try:
        r = requests.post(
            "https://google.serper.dev/search",
            json={"q": query, "num": 10},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10,
        )
        results = r.json().get("organic", [])
        emails = []
        email_re = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
        for res in results:
            text = res.get("title", "") + " " + res.get("snippet", "")
            found = email_re.findall(text)
            for e in found:
                if "noreply" not in e and "example" not in e:
                    emails.append(e)
        return list(dict.fromkeys(emails))[:3]
    except Exception:
        return []

def enrich_whale(whale: dict) -> dict:
    """Enrich a single whale with email from all available sources."""
    addr    = whale["addr"]
    ens     = whale.get("ens", "")
    contact = whale.get("contact", {})
    balance = whale["total_usd"]
    twitter = contact.get("twitter", "")
    github  = contact.get("github", "")
    tg      = contact.get("telegram", "")

    print(f"\n  🔍 Enriching {ens or addr[:16]}...  (${balance:,.0f})")

    result = {
        "addr":     addr,
        "ens":      ens,
        "balance":  balance,
        "eth":      whale.get("eth", 0),
        "age_mo":   whale.get("age_mo", 0),
        "tokens":   whale.get("top_tokens", ""),
        "email":    "",
        "telegram": tg,
        "twitter":  twitter,
        "github":   github,
        "instagram": contact.get("instagram", ""),
        "discord":  contact.get("discord", ""),
        "entity":   contact.get("entity", ""),
        "source":   "",
        "intelx_emails": [],
        "intelx_phones": [],
        "web_mentions":  contact.get("web_mentions", []),
    }

    # 1. ENS email (already tried)
    if contact.get("email"):
        result["email"] = contact["email"]
        result["source"] = "ENS"
        print(f"    ✅ ENS email: {result['email']}")
        return result

    # 2. GitHub public profile email
    if github:
        gh_name = github.replace("https://github.com/", "").replace("http://github.com/", "")
        email = gh_user_email(gh_name)
        if email:
            result["email"] = email
            result["source"] = "GitHub profile"
            print(f"    ✅ GitHub profile email: {email}")
            return result
        print(f"    ↳ GitHub no public email, trying commits...")
        email = gh_commit_email(gh_name)
        if email:
            result["email"] = email
            result["source"] = "GitHub commits"
            print(f"    ✅ GitHub commit email: {email}")
            return result

    # 3. IntelX phonebook — by ENS name / GitHub / Twitter
    searches = []
    if ens:
        searches.append(ens)
    if twitter and "@" in twitter:
        tw_clean = twitter.lstrip("@").split("/")[-1]
        searches.append(tw_clean)
        searches.append(f"@{tw_clean}")
    if github:
        gh_name = github.replace("https://github.com/", "").replace("http://github.com/", "")
        searches.append(gh_name)

    for q in searches[:3]:
        print(f"    ↳ IntelX search: {q}")
        ix = intelx_search(q)
        if ix["emails"]:
            result["email"] = ix["emails"][0]
            result["source"] = f"IntelX({q})"
            result["intelx_emails"] = ix["emails"]
            result["intelx_phones"] = ix["phones"]
            print(f"    ✅ IntelX email: {ix['emails'][0]}")
            return result
        if ix["phones"]:
            result["intelx_phones"] = ix["phones"]
        time.sleep(2.5)

    # 4. Google search for email
    if ens or twitter or github:
        label = ens or twitter or github
        q = f'"{label}" site:twitter.com OR site:github.com email'
        print(f"    ↳ Web search: {q[:60]}")
        emails = serper_email_search(q)
        if emails:
            result["email"] = emails[0]
            result["source"] = "web search"
            print(f"    ✅ Web email: {emails[0]}")

    if not result["email"]:
        print(f"    ✗ No email found")

    return result


def main():
    print("=" * 60)
    print("  🐋 WHALE EMAIL ENRICHMENT")
    print("=" * 60)

    with open("whale_results.json", encoding="utf-8") as f:
        data = json.load(f)

    # Filter $2M+ and skip obvious CEX/bridge/protocol
    candidates = []
    for w in data:
        bal = float(w.get("total_usd", 0))
        if bal < MIN_USD:
            continue
        ens = w.get("ens", "")
        entity = w.get("contact", {}).get("entity", "")
        label = (ens + entity).lower()
        skip = any(kw in label for kw in SKIP_KEYWORDS)
        # Also skip known contract patterns
        addr = w["addr"].lower()
        if addr.startswith("0x000000000000") or addr == "0x3ee18b2214aff97000d974cf647e7c347e8fa585":
            skip = True
        if skip:
            print(f"  ⏭  Skipping {ens or addr[:16]}...  (${bal:,.0f}) — org/contract/CEX")
            continue
        candidates.append(w)

    # Sort by: has_contact_signal first, then by balance
    def score(w):
        c = w.get("contact", {})
        signals = sum([
            bool(c.get("email")), bool(c.get("telegram")), bool(c.get("twitter")),
            bool(c.get("github")), bool(c.get("instagram")), bool(c.get("farcaster")),
        ])
        return (signals, w["total_usd"])

    candidates.sort(key=score, reverse=True)

    print(f"\n  Found {len(candidates)} individual $2M+ whale candidates")
    print(f"  Enriching top 15 with email search...\n")

    enriched = []
    for w in candidates[:15]:
        result = enrich_whale(w)
        enriched.append(result)

    # Save
    out = "whale_enriched.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(enriched, f, indent=2, default=str)

    # Print summary
    print("\n" + "=" * 60)
    print("  📊 ENRICHMENT RESULTS")
    print("=" * 60)

    has_email = [w for w in enriched if w["email"]]
    no_email  = [w for w in enriched if not w["email"]]

    print(f"\n  ✅ With email:   {len(has_email)}")
    print(f"  ✗  No email:    {len(no_email)}")
    print()

    all_sorted = sorted(enriched, key=lambda x: x["balance"], reverse=True)

    for i, w in enumerate(all_sorted, 1):
        channels = [c for c in [w["email"], w["telegram"], w["twitter"],
                                  w["github"], w["instagram"], w["discord"]] if c]
        print(f"\n{'─'*56}")
        print(f"  #{i}  {w['ens'] or w['addr'][:20]}...")
        print(f"       Balance   : ${w['balance']:>16,.0f}")
        print(f"       ETH       : {w['eth']:.2f} ETH")
        print(f"       Age       : {w['age_mo']:.0f} months")
        print(f"       Tokens    : {w['tokens']}")
        print(f"  ── CONTACTS ({len(channels)} channels) ──")
        print(f"  📧 Email      : {w['email'] or '—'}")
        if w["source"]:
            print(f"       (source: {w['source']})")
        print(f"  📱 IntelX Phone: {w['intelx_phones'][0] if w['intelx_phones'] else '—'}")
        print(f"  💬 Telegram   : {w['telegram'] or '—'}")
        print(f"  🐦 Twitter    : {w['twitter'] or '—'}")
        print(f"  🐙 GitHub     : {w['github'] or '—'}")
        print(f"  📸 Instagram  : {w['instagram'] or '—'}")
        if w["intelx_emails"]:
            print(f"  📧 IntelX alts: {', '.join(w['intelx_emails'][:3])}")
        if w["web_mentions"]:
            print(f"  🌐 Web refs   : {w['web_mentions'][0]}")

    print(f"\n\n  Saved to {out}")


if __name__ == "__main__":
    main()
