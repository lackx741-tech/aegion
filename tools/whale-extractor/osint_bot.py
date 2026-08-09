"""
GOD LEVEL OSINT Bot v2
======================
Commands:
  /wallet 0x...    → full on-chain OSINT (balance, ENS, labels, age, social)
  /ens name.eth    → ENS resolve + records
  /social user     → real name, bios, linked wallets from social profiles
  /check user      → platform presence (9 sites) + breach data
  /deep query      → nuclear OSINT — IntelX + breach + social + crt.sh + WHOIS + phone
  /intel query     → IntelX dark-web / paste-site / Tor search
  /breach email    → full multi-source breach (HIBP + LeakCheck + IntelX + Gravatar + PGP)
  /phone +1234...  → phone carrier, owner name, country, breach hits
  /domain site.com → WHOIS email, crt.sh domains, subdomains, DNS records
  /maigret user    → 2000+ platform username scan
  /email x@y.com   → breach check + web mentions
"""
import os, sys, re, time, json, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
load_dotenv(".env")

import requests
import telebot
from whale_extractor import (
    fetch_ens_name, fetch_ens_records, fetch_eth_balance,
    fetch_networth_moralis, fetch_debank_public,
    fetch_web_osint, fetch_leakcheck, fetch_leakcheck_ratelimited,
    fetch_etherscan_label, fetch_arkham_identity, fetch_web3_social,
    fetch_first_tx_date, fetch_intelx, fetch_intelx_phonebook,
    fetch_leakcheck_by_phone, fetch_leakcheck_by_username,
    fetch_pdl_person, run_sherlock, run_maigret, fetch_whois_contact,
    _KNOWN_CEX, _brave_search, _ddg_search,
)

BOT_TOKEN  = os.getenv("TELEGRAM_BOT_TOKEN", "")
ETH_PRICE  = 3200.0
NEYNAR_KEY = os.getenv("NEYNAR_KEY", "")
HDRS       = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

if not BOT_TOKEN:
    print("ERROR: TELEGRAM_BOT_TOKEN .env mein set karo → @BotFather → /newbot")
    sys.exit(1)

bot = telebot.TeleBot(BOT_TOKEN, parse_mode="HTML")

# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt_usd(n: float) -> str:
    if n >= 1e9: return f"${n/1e9:.2f}B"
    if n >= 1e6: return f"${n/1e6:.2f}M"
    if n >= 1e3: return f"${n/1e3:.0f}K"
    return f"${n:.0f}"

def _clean_tg(raw: str) -> str:
    if not raw: return ""
    m = re.search(r"t\.me/([A-Za-z0-9_]{5,32})", raw)
    if m: return f"@{m.group(1)}"
    h = raw.lstrip("@")
    if h.lower().startswith("http"): return ""
    h = re.sub(r"[^A-Za-z0-9_]", "", h)
    return f"@{h}" if 5 <= len(h) <= 32 else ""

def _send_long(msg, text: str):
    """Send long message split into 4000-char chunks."""
    for i in range(0, len(text), 4000):
        bot.reply_to(msg, text[i:i+4000])
        time.sleep(0.3)


# ════════════════════════════════════════════════════════════════════════════
# NEW FREE OSINT FUNCTIONS
# ════════════════════════════════════════════════════════════════════════════

def check_hibp(email: str) -> dict:
    """HaveIBeenPwned — email → breach list. Free public API."""
    try:
        r = requests.get(
            f"https://haveibeenpwned.com/api/v3/breachedaccount/{email}",
            headers={"hibp-api-key": "", "User-Agent": "osint-research-tool"},
            timeout=8,
        )
        if r.status_code == 200:
            breaches = r.json()
            return {
                "found": True,
                "count": len(breaches),
                "names": [b["Name"] for b in breaches[:10]],
                "data_classes": list({dc for b in breaches for dc in b.get("DataClasses", [])})[:12],
            }
        if r.status_code == 404:
            return {"found": False}
    except: pass
    # Fallback: scrape HIBP public page
    try:
        r = requests.get(
            f"https://haveibeenpwned.com/unifiedsearch/{email}",
            headers=HDRS, timeout=8)
        if r.status_code == 200:
            d = r.json()
            breaches = d.get("Breaches") or []
            return {
                "found": len(breaches) > 0,
                "count": len(breaches),
                "names": [b.get("Name","") for b in breaches[:10]],
                "data_classes": list({dc for b in breaches for dc in b.get("DataClasses", [])})[:12],
            }
    except: pass
    return {}


def check_gravatar(email: str) -> dict:
    """Gravatar — email hash → real name, bio, profile pic URL."""
    try:
        email_hash = hashlib.md5(email.strip().lower().encode()).hexdigest()
        r = requests.get(
            f"https://www.gravatar.com/{email_hash}.json",
            headers=HDRS, timeout=8)
        if r.status_code == 200:
            entry = r.json().get("entry", [{}])[0]
            result = {}
            name_obj = entry.get("name", {})
            if name_obj.get("formatted"):   result["name"] = name_obj["formatted"]
            elif name_obj.get("givenName"): result["name"] = f"{name_obj.get('givenName','')} {name_obj.get('familyName','')}".strip()
            if entry.get("displayName"):  result["display_name"] = entry["displayName"]
            if entry.get("aboutMe"):      result["bio"] = entry["aboutMe"]
            if entry.get("currentLocation"): result["location"] = entry["currentLocation"]
            if entry.get("thumbnailUrl"): result["avatar_url"] = entry["thumbnailUrl"]
            urls = entry.get("urls", [])
            if urls: result["websites"] = [u.get("value","") for u in urls[:4]]
            accounts = entry.get("accounts", [])
            if accounts: result["linked_accounts"] = [f"{a['domain']}: {a.get('username','')}" for a in accounts[:5]]
            emails_g = entry.get("emails", [])
            if emails_g: result["email"] = emails_g[0].get("value","")
            return result
    except: pass
    return {}


def check_crtsh(query: str) -> dict:
    """
    crt.sh — SSL certificate transparency log search.
    Email in cert → real domain owned by person.
    Domain → all SSL certs ever issued → related domains/subdomains.
    """
    try:
        r = requests.get(
            "https://crt.sh/",
            params={"q": query, "output": "json"},
            headers=HDRS, timeout=12)
        if r.status_code == 200:
            records = r.json()
            domains = set()
            issuers = set()
            orgs = set()
            emails_found = set()
            for rec in records:
                cn = rec.get("common_name", "")
                names = rec.get("name_value", "")
                issuer = rec.get("issuer_ca_id", "")
                if cn and not cn.startswith("*"): domains.add(cn)
                for n in names.split("\n"):
                    n = n.strip()
                    if "@" in n: emails_found.add(n)
                    elif n and "." in n and not n.startswith("*"): domains.add(n)
            # Limit
            domains_list = sorted(domains)[:20]
            return {
                "found": len(domains_list) > 0,
                "total_certs": len(records),
                "domains": domains_list,
                "emails_in_certs": list(emails_found)[:5],
            }
    except: pass
    return {}


def check_pgp_keyserver(query: str) -> dict:
    """
    PGP keyserver (keys.openpgp.org) — email → real name + key ID.
    If someone uses PGP, their real name is public.
    """
    try:
        r = requests.get(
            f"https://keys.openpgp.org/vks/v1/search?q={query}",
            headers=HDRS, timeout=8)
        if r.status_code == 200:
            keys = r.json().get("keys", [])
            results = []
            for key in keys[:5]:
                for uid in key.get("userids", []):
                    name = uid.get("name", "")
                    email = uid.get("email", "")
                    if name or email:
                        results.append({"name": name, "email": email,
                                        "key_id": key.get("fingerprint","")[-16:]})
            return {"found": len(results) > 0, "keys": results}
    except: pass
    # Fallback: MIT keyserver
    try:
        r = requests.get(
            f"https://pgp.mit.edu/pks/lookup?search={query}&op=index",
            headers=HDRS, timeout=8)
        if r.status_code == 200:
            matches = re.findall(r"<a[^>]*>([^<]{5,80})</a>[^<]*&lt;([^>]+)&gt;", r.text)
            keys = [{"name": m[0].strip(), "email": m[1].strip()} for m in matches[:5]]
            return {"found": len(keys) > 0, "keys": keys}
    except: pass
    return {}


def check_numverify(phone: str) -> dict:
    """
    Phone OSINT — carrier, country, line type from multiple free sources.
    """
    phone_clean = re.sub(r"[^\d+]", "", phone)
    result = {}

    # NumLookup (free, no key)
    try:
        r = requests.get(
            f"https://www.numlookupapi.com/api/info/{phone_clean}",
            headers=HDRS, timeout=8)
        if r.status_code == 200:
            d = r.json()
            if d.get("carrier"): result["carrier"] = d["carrier"]
            if d.get("country_name"): result["country"] = d["country_name"]
            if d.get("line_type"): result["line_type"] = d["line_type"]
            if d.get("country_code"): result["country_code"] = d["country_code"]
    except: pass

    # AbstractAPI Phone (100 free/month)
    try:
        abstract_key = os.getenv("ABSTRACT_KEY", "")
        if abstract_key:
            r = requests.get(
                f"https://phonevalidation.abstractapi.com/v1/?api_key={abstract_key}&phone={phone_clean}",
                timeout=8)
            if r.status_code == 200:
                d = r.json()
                if d.get("carrier"): result["carrier"] = d["carrier"]
                if d.get("country", {}).get("name"): result["country"] = d["country"]["name"]
                if d.get("type"): result["line_type"] = d["type"]
                result["valid"] = d.get("valid", False)
    except: pass

    # Google dork for phone
    try:
        hits = _ddg_search(f'"{phone_clean}"', 5)
        if hits:
            result["web_mentions"] = [h.get("url", "") for h in hits[:3]]
    except: pass

    return result


def check_wayback(username_or_url: str) -> dict:
    """Wayback Machine — check if a profile was ever cached/archived."""
    try:
        query = username_or_url if "." in username_or_url else f"twitter.com/{username_or_url}"
        r = requests.get(
            f"http://archive.org/wayback/available?url={query}",
            headers=HDRS, timeout=8)
        if r.status_code == 200:
            snap = r.json().get("archived_snapshots", {}).get("closest", {})
            if snap.get("available"):
                return {
                    "found": True,
                    "timestamp": snap.get("timestamp",""),
                    "url": snap.get("url",""),
                    "status": snap.get("status",""),
                }
    except: pass
    return {"found": False}


def check_pastebin_dork(query: str) -> list:
    """Google dork Pastebin + GitHub Gist for leaked data."""
    results = []
    dorks = [
        f'site:pastebin.com "{query}"',
        f'site:gist.github.com "{query}"',
        f'site:paste.ee "{query}"',
    ]
    for dork in dorks[:2]:
        hits = _ddg_search(dork, 3)
        for h in hits:
            results.append({"source": "pastebin/gist", "url": h.get("url",""), "title": h.get("title","")})
    return results[:6]


def check_fragment_telegram(username: str) -> dict:
    """
    Fragment.com (TON Telegram username marketplace) — check if username is owned.
    Tells you the current owner price + if username is claimed.
    """
    u = username.lstrip("@").strip().lower()
    try:
        r = requests.get(
            f"https://fragment.com/username/{u}",
            headers=HDRS, timeout=8)
        if r.status_code == 200:
            html = r.text
            owned = "already claimed" in html.lower() or "ton_addr" in html
            price_m = re.search(r"(\d[\d,\.]+)\s*TON", html)
            result = {"username": u, "claimed": owned}
            if price_m: result["price_ton"] = price_m.group(1)
            # Owner address (TON wallet)
            ton_m = re.search(r"EQ[A-Za-z0-9_-]{46}", html)
            if ton_m: result["ton_wallet"] = ton_m.group(0)
            return result
    except: pass
    return {}


def check_discord_lookup(username: str) -> dict:
    """Discord — public invite/server search for username mentions."""
    u = username.lstrip("@").strip()
    try:
        hits = _ddg_search(f'discord "{u}"', 5)
        discord_invites = [h.get("url","") for h in hits if "discord.gg" in h.get("url","") or "discord.com/invite" in h.get("url","")]
        return {"found": len(discord_invites) > 0, "invites": discord_invites[:3]}
    except: pass
    return {}


def fetch_social_profile(username: str) -> dict:
    """
    Social media se real name, email, bio, location, linked wallets extract karo.
    Sources: GitHub (free API + commit emails), Reddit, Farcaster via Neynar,
             Twitter/Nitter scrape, TikTok og tags, Instagram og tags.
    """
    u = username.lstrip("@").strip()
    result = {"username": u, "names": [], "emails": [], "bios": [], "locations": [], "links": [], "platforms": {}}

    def add_name(n):
        n = (n or "").strip()
        if n and n not in result["names"]: result["names"].append(n)

    def add_email(e):
        e = (e or "").strip().lower()
        if e and "@" in e and e not in result["emails"]: result["emails"].append(e)

    # ── GitHub profile ────────────────────────────────────────────────────────
    try:
        r = requests.get(f"https://api.github.com/users/{u}",
                         headers={"Accept": "application/vnd.github+json"}, timeout=8)
        if r.status_code == 200:
            d = r.json()
            gh = {}
            if d.get("name"):     gh["name"] = d["name"];      add_name(d["name"])
            if d.get("email"):    gh["email"] = d["email"];     add_email(d["email"])
            if d.get("company"):  gh["company"] = d["company"]
            if d.get("location"): gh["location"] = d["location"]; result["locations"].append(d["location"])
            if d.get("bio"):      gh["bio"] = d["bio"];         result["bios"].append(f"GitHub: {d['bio']}")
            if d.get("blog"):     gh["website"] = d["blog"];    result["links"].append(d["blog"])
            gh["repos"] = d.get("public_repos", 0)
            gh["followers"] = d.get("followers", 0)
            result["platforms"]["github"] = gh
    except: pass

    # ── GitHub commit emails (public events — real email often exposed) ───────
    try:
        r = requests.get(f"https://api.github.com/users/{u}/events/public?per_page=100",
                         headers={"Accept": "application/vnd.github+json"}, timeout=10)
        if r.status_code == 200:
            commit_emails, commit_names = set(), set()
            for ev in r.json():
                if ev.get("type") != "PushEvent": continue
                for c in ev.get("payload", {}).get("commits", []):
                    a = c.get("author", {})
                    e = a.get("email", "")
                    n = a.get("name", "")
                    if e and "noreply" not in e: commit_emails.add(e)
                    if n: commit_names.add(n)
            for e in commit_emails: add_email(e)
            for n in commit_names: add_name(n)
            if commit_emails:
                gh = result["platforms"].get("github", {})
                gh["commit_emails"] = list(commit_emails)
                result["platforms"]["github"] = gh
    except: pass

    # ── Reddit ────────────────────────────────────────────────────────────────
    try:
        r = requests.get(f"https://www.reddit.com/user/{u}/about.json",
                         headers={"User-Agent": "osint-bot/1.0"}, timeout=8)
        if r.status_code == 200:
            d = r.json().get("data", {})
            rd = {"karma": d.get("total_karma", 0), "created_utc": d.get("created_utc", 0)}
            if d.get("subreddit", {}).get("public_description"):
                rd["bio"] = d["subreddit"]["public_description"]
                result["bios"].append(f"Reddit: {rd['bio']}")
            result["platforms"]["reddit"] = rd
    except: pass

    # ── Farcaster via Neynar ─────────────────────────────────────────────────
    try:
        fc = {}
        if NEYNAR_KEY:
            r = requests.get(
                f"https://api.neynar.com/v2/farcaster/user/by_username?username={u}",
                headers={"api_key": NEYNAR_KEY}, timeout=8)
            if r.status_code == 200:
                d = r.json().get("user", {})
                if d.get("display_name"): fc["display_name"] = d["display_name"]; add_name(d["display_name"])
                bio = d.get("profile", {}).get("bio", {}).get("text", "")
                if bio: fc["bio"] = bio; result["bios"].append(f"Farcaster: {bio}")
                loc = d.get("profile", {}).get("location", {}).get("description", "")
                if loc: fc["location"] = loc; result["locations"].append(loc)
                fc["followers"] = d.get("follower_count", 0)
                va = d.get("verified_addresses", {})
                if va.get("eth_addresses"): fc["eth_wallets"] = va["eth_addresses"]
                if va.get("sol_addresses"): fc["sol_wallets"] = va["sol_addresses"]
                if d.get("custody_address"): fc["custody_wallet"] = d["custody_address"]
                for acc in d.get("verified_accounts", []):
                    if acc.get("platform") == "x": fc["twitter"] = f"@{acc['username']}"
        else:
            r = requests.get(f"https://api.warpcast.com/v2/user-by-username?username={u}", timeout=8)
            if r.status_code == 200:
                d = r.json().get("result", {}).get("user", {})
                if d.get("displayName"): fc["display_name"] = d["displayName"]; add_name(d["displayName"])
                bio = d.get("profile", {}).get("bio", {}).get("text", "")
                if bio: fc["bio"] = bio; result["bios"].append(f"Farcaster: {bio}")
                for acc in d.get("connectedAccounts", []):
                    if acc.get("platform") == "x": fc["twitter"] = f"@{acc['username']}"
                fc["followers"] = d.get("followerCount", 0)
                if d.get("profile", {}).get("url"): result["links"].append(d["profile"]["url"])
        if fc: result["platforms"]["farcaster"] = fc
    except: pass

    # ── Twitter via Nitter scrape ─────────────────────────────────────────────
    for nitter in ["https://nitter.net", "https://nitter.privacydev.net"]:
        try:
            r = requests.get(f"{nitter}/{u}", headers=HDRS, timeout=7)
            if r.status_code == 200 and ("profile-card" in r.text or "timeline" in r.text):
                html = r.text
                m = re.search(r'class="profile-card-fullname"[^>]*>([^<]{2,60})', html)
                if m: add_name(m.group(1).strip())
                m = re.search(r'class="profile-bio"[^>]*>\s*<[^>]+>([^<]{5,300})', html)
                if m:
                    bio = re.sub(r"<[^>]+>", "", m.group(1)).strip()
                    if bio: result["bios"].append(f"Twitter: {bio}")
                m = re.search(r'<span class="profile-location"[^>]*>(.*?)</span>', html, re.S)
                if m:
                    loc = re.sub(r"<[^>]+>", "", m.group(1)).strip()
                    if loc: result["locations"].append(loc)
                m = re.search(r'class="profile-website"[^>]*>.*?href="([^"]+)"', html, re.S)
                if m: result["links"].append(m.group(1))
                result["platforms"]["twitter"] = {"found": True}
                break
        except: pass

    # ── TikTok og:title ──────────────────────────────────────────────────────
    try:
        r = requests.get(f"https://www.tiktok.com/@{u}", headers=HDRS, timeout=8)
        if r.status_code == 200:
            m = re.search(r'property="og:title"\s+content="([^"]{2,80})"', r.text)
            if m:
                name = re.sub(r"\s*\(@[^)]+\)\s*", "", m.group(1)).strip()
                if name and name.lower() != u.lower():
                    add_name(name); result["platforms"]["tiktok"] = {"display_name": name}
    except: pass

    # ── Instagram og:title ───────────────────────────────────────────────────
    try:
        r = requests.get(f"https://www.instagram.com/{u}/", headers=HDRS, timeout=8)
        if r.status_code == 200:
            m = re.search(r'property="og:title"\s+content="([^"]{2,80})"', r.text)
            if m:
                name = re.sub(r"\s*\(@[^)]+\)\s*", "", m.group(1)).strip()
                if name and "instagram" not in name.lower() and name.lower() != u.lower():
                    add_name(name); result["platforms"]["instagram"] = {"display_name": name}
    except: pass

    # ── LinkedIn Google dork ──────────────────────────────────────────────────
    try:
        hits = _ddg_search(f'site:linkedin.com/in "{u}"', 3)
        for h in hits:
            if "linkedin.com/in/" in h.get("url", ""):
                result["platforms"]["linkedin"] = {"url": h["url"]}
                result["links"].append(h["url"])
                break
    except: pass

    return result


# ════════════════════════════════════════════════════════════════════════════
# BOT OUTPUT FORMATTERS
# ════════════════════════════════════════════════════════════════════════════

def osint_wallet(addr: str) -> str:
    lines = ["<b>WALLET OSINT</b>", f"<code>{addr}</code>\n"]
    if addr.lower() in _KNOWN_CEX:
        return "\n".join(lines) + "\nExchange/Contract — skipping"
    label = fetch_etherscan_label(addr)
    if label: lines.append(f"Label: <b>{label}</b>")
    try:
        eth = fetch_eth_balance(addr)
        usd, _ = fetch_networth_moralis(addr)
        total = max(usd, eth * ETH_PRICE)
        lines.append(f"Balance: <b>{_fmt_usd(total)}</b> ({eth:.3f} ETH)")
    except: pass
    ens = fetch_ens_name(addr) or ""
    if ens:
        lines.append(f"ENS: <b>{ens}</b>")
        recs = fetch_ens_records(ens)
        if recs.get("email"):         lines.append(f"Email (ENS): {recs['email']}")
        if recs.get("org.telegram"):  lines.append(f"Telegram (ENS): {_clean_tg(recs['org.telegram'])}")
        if recs.get("com.twitter"):   lines.append(f"Twitter (ENS): {recs['com.twitter']}")
        if recs.get("com.github"):    lines.append(f"GitHub (ENS): {recs['com.github']}")
        if recs.get("com.discord"):   lines.append(f"Discord (ENS): {recs['com.discord']}")
    lines.append("")
    w3s = fetch_web3_social(addr)
    if w3s.get("twitter_handle"): lines.append(f"Twitter: {w3s['twitter_handle']}")
    if w3s.get("farcaster_user"): lines.append(f"Farcaster: {w3s['farcaster_user']}")
    ark = fetch_arkham_identity(addr)
    if ark.get("entity_name"):    lines.append(f"Entity: <b>{ark['entity_name']}</b>")
    if ark.get("twitter_handle"): lines.append(f"Twitter (Arkham): {ark['twitter_handle']}")
    db = fetch_debank_public(addr)
    if db.get("twitter_handle"):  lines.append(f"Twitter (DeBank): {db['twitter_handle']}")
    if db.get("discord"):         lines.append(f"Discord: {db['discord']}")
    web = fetch_web_osint(addr, ens)
    if web.get("email"):    lines.append(f"Email (web): {web['email']}")
    if web.get("telegram"): lines.append(f"Telegram (web): {_clean_tg(web['telegram'])}")
    if web.get("twitter"):  lines.append(f"Twitter (web): {web['twitter']}")
    if web.get("linkedin"): lines.append(f"LinkedIn: {web['linkedin']}")
    try:
        from datetime import datetime, timezone
        first = fetch_first_tx_date(addr)
        if first:
            if first.tzinfo is None: first = first.replace(tzinfo=timezone.utc)
            age_mo = (datetime.now(timezone.utc) - first).days / 30
            lines.append(f"Wallet Age: {age_mo:.0f} months")
    except: pass
    lines.append(f"\netherscan.io/address/{addr}")
    return "\n".join(lines)


def osint_social(username: str) -> str:
    u = username.lstrip("@").strip()
    lines = [f"<b>SOCIAL PROFILE: @{u}</b>\n"]
    data = fetch_social_profile(u)
    pf = data["platforms"]
    if data["names"]:   lines.append(f"Real Name(s): <b>{' / '.join(data['names'])}</b>")
    if data["emails"]:  lines.append(f"Email(s): <b>{', '.join(data['emails'])}</b>")
    if data["locations"]:
        locs = list(dict.fromkeys(data["locations"]))
        lines.append(f"Location: {' / '.join(locs[:3])}")
    lines.append("")
    if "github" in pf:
        gh = pf["github"]
        lines.append("<b>GitHub</b>")
        if gh.get("name"):          lines.append(f"  Name: {gh['name']}")
        if gh.get("email"):         lines.append(f"  Email: {gh['email']}")
        if gh.get("company"):       lines.append(f"  Company: {gh['company']}")
        if gh.get("location"):      lines.append(f"  Location: {gh['location']}")
        if gh.get("commit_emails"): lines.append(f"  Commit emails: {', '.join(gh['commit_emails'])}")
        lines.append(f"  Repos: {gh.get('repos',0)} | Followers: {gh.get('followers',0)}")
        if gh.get("website"):       lines.append(f"  Website: {gh['website']}")
    if "farcaster" in pf:
        fc = pf["farcaster"]
        lines.append("<b>Farcaster</b>")
        if fc.get("display_name"):  lines.append(f"  Name: {fc['display_name']}")
        if fc.get("twitter"):       lines.append(f"  Twitter: {fc['twitter']}")
        if fc.get("location"):      lines.append(f"  Location: {fc['location']}")
        if fc.get("followers"):     lines.append(f"  Followers: {fc['followers']:,}")
        for w in fc.get("eth_wallets", [])[:3]:
            lines.append(f"  ETH: <code>{w}</code>")
        for w in fc.get("sol_wallets", [])[:1]:
            lines.append(f"  SOL: <code>{w}</code>")
    if "reddit" in pf:
        rd = pf["reddit"]
        lines.append(f"<b>Reddit</b> — karma {rd.get('karma',0):,}")
        if rd.get("bio"): lines.append(f"  Bio: {rd['bio'][:100]}")
    if "twitter" in pf:  lines.append(f"<b>Twitter</b>: twitter.com/{u}")
    if "tiktok" in pf:   lines.append(f"<b>TikTok</b>: {pf['tiktok'].get('display_name','')}")
    if "instagram" in pf: lines.append(f"<b>Instagram</b>: {pf['instagram'].get('display_name','')}")
    if "linkedin" in pf:  lines.append(f"<b>LinkedIn</b>: {pf['linkedin'].get('url','')}")
    if data["bios"]:
        lines.append("\nBios:"); [lines.append(f"  {b[:120]}") for b in data["bios"][:4]]
    if not pf: lines.append("No public profiles found")
    return "\n".join(lines)


def osint_breach_full(email: str) -> str:
    """Multi-source breach check: HIBP + LeakCheck + IntelX + Gravatar + PGP keyserver."""
    lines = [f"<b>BREACH CHECK: {email}</b>\n"]

    # 1. HaveIBeenPwned
    hibp = check_hibp(email)
    if hibp.get("found"):
        lines.append(f"<b>HIBP: {hibp['count']} breaches</b>")
        lines.append("Sites: " + ", ".join(hibp.get("names", [])[:8]))
        if hibp.get("data_classes"):
            lines.append("Data types: " + ", ".join(hibp["data_classes"][:8]))
    elif hibp:
        lines.append("HIBP: Clean (not found)")

    lines.append("")

    # 2. LeakCheck
    lc = fetch_leakcheck(email, "email")
    if lc.get("found_in", 0) > 0:
        lines.append(f"<b>🔴 LeakCheck: {lc['found_in']} breach records</b>")
        if lc.get("names"):    lines.append(f"👤 Name: <b>{lc['names'][0]}</b>")
        if lc.get("phones"):   lines.append(f"📞 Phone: <b>{lc['phones'][0]}</b>")
        if lc.get("dobs"):     lines.append(f"🎂 DOB: <b>{lc['dobs'][0]}</b>")
        if lc.get("emails") and len(lc["emails"]) > 1:
            lines.append(f"📩 Alt emails: {', '.join(lc['emails'][1:4])}")
        lines.append(f"Sources ({len(lc.get('sources',[]))}):")
        for s in lc.get("sources", [])[:8]: lines.append(f"  • {s}")
        if lc.get("has_phone_data"): lines.append("📞 Phone: found in breach (LEAKCHECK_KEY=paid to see value)")
        if lc.get("has_email_data"): lines.append("📩 Alt emails: in breach (LEAKCHECK_KEY=paid to see values)")
    else:
        lines.append("LeakCheck: Not found")

    lines.append("")

    # 3. IntelX (dark web, paste sites, Tor)
    ix = fetch_intelx(email)
    if ix.get("records_found", 0) > 0:
        lines.append(f"<b>IntelX (dark web): {ix['records_found']} records</b>")
        if ix.get("sources"): lines.append("Sources: " + ", ".join(ix["sources"][:5]))
        if ix.get("emails"):  lines.append("Related emails: " + ", ".join(ix["emails"][:3]))
        if ix.get("phones"):  lines.append(f"Phone (IntelX): <b>{ix['phones'][0]}</b>")
    else:
        lines.append("IntelX: No dark web records")

    lines.append("")

    # 4. Gravatar (email → real identity)
    grav = check_gravatar(email)
    if grav.get("name"):
        lines.append(f"<b>Gravatar profile:</b>")
        lines.append(f"  Real name: <b>{grav['name']}</b>")
        if grav.get("bio"):       lines.append(f"  Bio: {grav['bio'][:100]}")
        if grav.get("location"):  lines.append(f"  Location: {grav['location']}")
        if grav.get("websites"):  lines.append(f"  Websites: {', '.join(grav['websites'][:3])}")
        if grav.get("linked_accounts"): lines.append(f"  Accounts: {', '.join(grav['linked_accounts'][:4])}")

    # 5. PGP keyserver (email → full name)
    pgp = check_pgp_keyserver(email)
    if pgp.get("found"):
        lines.append(f"\n<b>PGP keys:</b>")
        for k in pgp.get("keys", [])[:3]:
            lines.append(f"  Name: {k.get('name','')} | Email: {k.get('email','')} | Key: {k.get('key_id','')}")

    # 6. crt.sh — domains owned by this email
    crt = check_crtsh(email)
    if crt.get("domains"):
        lines.append(f"\n<b>SSL Certs (crt.sh):</b> {crt['total_certs']} certs found")
        lines.append("Domains: " + ", ".join(crt["domains"][:8]))

    # 7. Paste sites (Google dork)
    pastes = check_pastebin_dork(email)
    if pastes:
        lines.append("\n<b>Paste sites:</b>")
        for p in pastes[:3]: lines.append(f"  {p['url']}")

    return "\n".join(lines)


def osint_intel(query: str) -> str:
    """IntelX deep search — dark web, paste sites, Tor, breaches."""
    lines = [f"<b>INTELX DEEP SEARCH</b>", f"Query: <code>{query}</code>\n"]

    ix = fetch_intelx(query)
    if not ix:
        lines.append("IntelX: No key configured or no results")
        lines.append("Check INTELX_KEY in .env")
        return "\n".join(lines)

    count = ix.get("records_found", 0)
    if count == 0:
        lines.append("No records found in dark web / paste sites")
        return "\n".join(lines)

    lines.append(f"<b>Records found: {count}</b>")
    if ix.get("sources"):
        lines.append("\nSources (where found):")
        for s in ix["sources"]: lines.append(f"  {s}")
    if ix.get("emails"):
        lines.append(f"\nRelated emails: <b>{', '.join(ix['emails'][:5])}</b>")
    if ix.get("phones"):
        lines.append(f"Related phones: <b>{', '.join(ix['phones'][:3])}</b>")

    # Second pass: search by username
    ix2 = fetch_intelx(query, "username") if "@" not in query else {}
    if ix2.get("records_found", 0) > 0 and ix2 != ix:
        lines.append(f"\nUsername search: {ix2['records_found']} more records")
        if ix2.get("emails"): lines.append(f"Emails: {', '.join(ix2['emails'][:3])}")

    return "\n".join(lines)


def osint_phone(phone: str) -> str:
    """Phone OSINT — carrier, country, breach data, web mentions."""
    clean = re.sub(r"[^\d+]", "", phone)
    lines = [f"<b>PHONE OSINT: {clean}</b>\n"]

    info = check_numverify(clean)
    if info.get("carrier"): lines.append(f"Carrier: <b>{info['carrier']}</b>")
    if info.get("country"): lines.append(f"Country: <b>{info['country']}</b>")
    if info.get("line_type"): lines.append(f"Type: {info['line_type']}")
    if info.get("valid") is not None: lines.append(f"Valid: {'Yes' if info['valid'] else 'No'}")

    lines.append("")

    # Breach search
    lc = fetch_leakcheck(clean, "phone")
    if lc.get("found_in", 0) > 0:
        lines.append(f"<b>LeakCheck: {lc['found_in']} breach records</b>")
        for s in lc.get("sources", [])[:5]: lines.append(f"  {s}")
        if lc.get("emails"): lines.append(f"Email: <b>{lc['emails'][0]}</b>")
        if lc.get("names"):  lines.append(f"Name: <b>{lc['names'][0]}</b>")

    # IntelX phone search
    ix = fetch_intelx(clean, "phone")
    if ix.get("records_found", 0) > 0:
        lines.append(f"\n<b>IntelX: {ix['records_found']} dark web records</b>")
        if ix.get("emails"): lines.append(f"Emails found: {', '.join(ix['emails'][:3])}")

    # Web mentions
    if info.get("web_mentions"):
        lines.append("\nWeb mentions:")
        for url in info["web_mentions"][:3]: lines.append(f"  {url}")

    # Google dork
    hits = _ddg_search(f'"{clean}" (telegram OR signal OR whatsapp OR email)', 4)
    if hits:
        lines.append("\nSearch results:")
        for h in hits[:3]: lines.append(f"  {h.get('title','')[:60]} — {h.get('url','')}")

    return "\n".join(lines)


def osint_domain(domain: str) -> str:
    """Domain OSINT — WHOIS, crt.sh, DNS, subdomains."""
    d = re.sub(r"https?://", "", domain).split("/")[0].strip()
    lines = [f"<b>DOMAIN OSINT: {d}</b>\n"]

    # WHOIS
    whois = fetch_whois_contact(d)
    if whois.get("registrant_email"):  lines.append(f"Registrant email: <b>{whois['registrant_email']}</b>")
    if whois.get("registrant_name"):   lines.append(f"Registrant name: <b>{whois['registrant_name']}</b>")
    if whois.get("registrant_phone"):  lines.append(f"Registrant phone: {whois['registrant_phone']}")
    if whois.get("registrar"):         lines.append(f"Registrar: {whois['registrar']}")
    if whois.get("creation_date"):     lines.append(f"Created: {whois['creation_date']}")
    if whois.get("expiry_date"):       lines.append(f"Expires: {whois['expiry_date']}")

    lines.append("")

    # crt.sh SSL certs
    crt = check_crtsh(d)
    if crt.get("found"):
        lines.append(f"<b>SSL Certs (crt.sh): {crt['total_certs']} certificates</b>")
        sub_short = [x for x in crt.get("domains", []) if d in x][:12]
        if sub_short: lines.append("Subdomains: " + ", ".join(sub_short))
        if crt.get("emails_in_certs"):
            lines.append("Emails in certs: " + ", ".join(crt["emails_in_certs"]))

    lines.append("")

    # DNS TXT records (SPF/DMARC reveal mail provider, sometimes email)
    try:
        import socket
        ip = socket.gethostbyname(d)
        lines.append(f"IP: {ip}")
    except: pass

    # Google dork for email on this domain
    hits = _ddg_search(f'site:{d} email OR contact', 3)
    if hits:
        lines.append("\nContact pages:")
        for h in hits[:3]: lines.append(f"  {h.get('url','')}")

    # IntelX domain search
    ix = fetch_intelx(d, "domain")
    if ix.get("records_found", 0) > 0:
        lines.append(f"\n<b>IntelX: {ix['records_found']} records</b>")
        if ix.get("emails"): lines.append(f"Emails found: {', '.join(ix['emails'][:5])}")

    return "\n".join(lines)


def osint_deep(query: str) -> list:
    """
    Nuclear OSINT — runs EVERYTHING on a query.
    Detects type (email/username/wallet/domain/phone) and runs all relevant checks.
    Returns list of message parts (may be multiple messages).
    """
    parts = []
    header = f"<b>DEEP OSINT: {query}</b>\n\nRunning all sources...\n"

    # Detect query type
    is_email   = bool(re.match(r"[\w.+-]+@[\w.-]+\.\w{2,}", query))
    is_wallet  = bool(re.match(r"^0x[0-9a-fA-F]{40}$", query))
    is_domain  = bool(re.match(r"^[\w.-]+\.[a-z]{2,}$", query) and "@" not in query and "0x" not in query)
    is_phone   = bool(re.match(r"^\+?\d{8,15}$", query))
    is_eth_ens = bool(re.match(r"^[\w-]+\.eth$", query, re.I))
    is_user    = not (is_email or is_wallet or is_domain or is_phone or is_eth_ens)

    report = [header]

    if is_wallet:
        report.append(osint_wallet(query))
        parts.append("\n".join(report))
        return parts

    if is_eth_ens:
        report.append(f"ENS detected — resolving wallet...\n")
        try:
            r = requests.get(f"https://api.ensideas.com/ens/resolve/{query}", timeout=8)
            if r.status_code == 200:
                addr = r.json().get("address", "")
                if addr:
                    report.append(osint_wallet(addr))
        except: pass
        parts.append("\n".join(report))
        return parts

    if is_email:
        report.append(f"Type: Email address\n")
        # Breach check
        report.append(osint_breach_full(query))
        parts.append("\n".join(report))

        # Try to find username from email
        username_guess = query.split("@")[0]
        domain_guess = query.split("@")[1] if "@" in query else ""
        report2 = [f"<b>Username scan for: {username_guess}</b>\n"]
        report2.append(osint_social(username_guess))
        # IntelX
        report2.append("\n" + osint_intel(query))
        # crt.sh on domain
        if domain_guess:
            crt = check_crtsh(domain_guess)
            if crt.get("domains"):
                report2.append(f"\n<b>Domain {domain_guess} SSL certs:</b>")
                report2.append(", ".join(crt["domains"][:10]))
        parts.append("\n".join(report2))
        return parts

    if is_phone:
        report.append(osint_phone(query))
        parts.append("\n".join(report))
        return parts

    if is_domain:
        report.append(osint_domain(query))
        parts.append("\n".join(report))
        return parts

    # Username — run social + breach + IntelX + platform scan + fragment check
    if is_user:
        u = query.lstrip("@").strip()
        report.append(f"Type: Username — running all sources\n")

        # Social profiles
        report.append(osint_social(u))
        parts.append("\n".join(report))

        # Breach + IntelX
        report2 = [f"<b>BREACH / DARK WEB: @{u}</b>\n"]
        lc = fetch_leakcheck(u)
        if lc.get("found_in", 0) > 0:
            report2.append(f"LeakCheck: <b>{lc['found_in']} records</b>")
            report2.append("Sources: " + ", ".join(lc.get("sources", [])[:6]))
            if lc.get("has_email_data"): report2.append("Email in breach (need Pro key)")
            if lc.get("has_phone_data"): report2.append("Phone in breach (need Pro key)")
            if lc.get("emails"): report2.append(f"Email: <b>{lc['emails'][0]}</b>")
            if lc.get("phones"): report2.append(f"Phone: <b>{lc['phones'][0]}</b>")
        else:
            report2.append("LeakCheck: No records")

        ix = fetch_intelx(u)
        if ix.get("records_found", 0) > 0:
            report2.append(f"\nIntelX: <b>{ix['records_found']} dark web records</b>")
            if ix.get("sources"): report2.append("Indexed in: " + ", ".join(ix["sources"][:4]))
            if ix.get("emails"):  report2.append(f"Emails: {', '.join(ix['emails'][:3])}")

        # Telegram Fragment check
        frag = check_fragment_telegram(u)
        if frag.get("claimed"):
            report2.append(f"\n<b>Telegram @{u}:</b>")
            report2.append(f"  Claimed on Fragment.com")
            if frag.get("ton_wallet"): report2.append(f"  TON Wallet: <code>{frag['ton_wallet']}</code>")

        # Wayback Machine
        wb = check_wayback(u)
        if wb.get("found"):
            report2.append(f"\nWayback Machine: archived {wb.get('timestamp','')}")
            report2.append(f"  {wb.get('url','')}")

        # Pastebin dork
        pastes = check_pastebin_dork(u)
        if pastes:
            report2.append(f"\nPaste sites ({len(pastes)} hits):")
            for p in pastes[:3]: report2.append(f"  {p['url']}")

        parts.append("\n".join(report2))

        # Sherlock / Maigret (if installed)
        report3 = [f"<b>PLATFORM SCAN: @{u}</b>\n"]
        sh = run_sherlock(u)
        if sh.get("found_platforms"):
            report3.append(f"Sherlock: <b>{len(sh['found_platforms'])} platforms</b>")
            report3.append(", ".join(sh["found_platforms"][:20]))
        else:
            mg = run_maigret(u)
            if mg.get("found_platforms"):
                report3.append(f"Maigret: <b>{len(mg['found_platforms'])} platforms</b>")
                report3.append(", ".join(mg["found_platforms"][:20]))
            else:
                report3.append("Sherlock/Maigret not installed")
                report3.append("Install: pip install sherlock-project maigret")

        parts.append("\n".join(report3))

    return parts


# ════════════════════════════════════════════════════════════════════════════
# BOT HANDLERS
# ════════════════════════════════════════════════════════════════════════════

@bot.message_handler(commands=["start", "help"])
def cmd_help(msg):
    bot.reply_to(msg, (
        "<b>GOD LEVEL OSINT BOT</b>\n\n"
        "<b>Basic:</b>\n"
        "/wallet <code>0x...</code>   — On-chain + social OSINT\n"
        "/ens <code>name.eth</code>   — ENS resolve + records\n"
        "/social <code>user</code>    — Real name, linked wallets from profiles\n"
        "/check <code>user</code>     — 9 platform check + breach data\n"
        "/email <code>x@y.com</code>  — Email breach + web mentions\n\n"
        "<b>God Level:</b>\n"
        "/deep <code>query</code>     — Nuclear: ALL sources combined\n"
        "/breach <code>email</code>   — HIBP + LeakCheck + IntelX + Gravatar + PGP\n"
        "/intel <code>query</code>    — IntelX dark web / Tor / paste sites\n"
        "/phone <code>+123...</code>  — Carrier + breach + web mentions\n"
        "/domain <code>site.com</code>— WHOIS + crt.sh + DNS + subdomains\n"
        "/maigret <code>user</code>   — 2000+ platform username scan\n\n"
        "<i>Kuch bhi bhejo — auto-detect karta hai</i>"
    ))


@bot.message_handler(commands=["wallet"])
def cmd_wallet(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /wallet 0x..."); return
    addr = parts[1].strip()
    if not re.match(r"^0x[0-9a-fA-F]{40}$", addr):
        bot.reply_to(msg, "Invalid wallet address"); return
    bot.reply_to(msg, "Scanning wallet...")
    try: _send_long(msg, osint_wallet(addr))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["ens"])
def cmd_ens(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /ens name.eth"); return
    bot.reply_to(msg, "Resolving ENS...")
    ens = parts[1].strip()
    try:
        r = requests.get(f"https://api.ensideas.com/ens/resolve/{ens}", timeout=8)
        if r.status_code == 200:
            addr = r.json().get("address","")
            if addr: _send_long(msg, osint_wallet(addr))
            else: bot.reply_to(msg, "ENS not resolved")
        else:
            bot.reply_to(msg, f"ENS lookup failed ({r.status_code})")
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["social"])
def cmd_social(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /social username"); return
    u = parts[1].strip().lstrip("@")
    bot.reply_to(msg, f"Scanning social profiles for @{u}...")
    try: _send_long(msg, osint_social(u))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["check"])
def cmd_check(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /check username"); return
    u = parts[1].strip().lstrip("@")
    bot.reply_to(msg, "Checking platforms...")
    try:
        lines = [f"<b>PLATFORM CHECK: @{u}</b>\n"]
        platforms = [
            ("Telegram",  f"https://t.me/{u}",                   "tgme_page"),
            ("GitHub",    f"https://github.com/{u}",             "200"),
            ("Instagram", f"https://www.instagram.com/{u}/",     "200"),
            ("Twitter/X", f"https://twitter.com/{u}",            "200"),
            ("TikTok",    f"https://www.tiktok.com/@{u}",        "200"),
            ("YouTube",   f"https://www.youtube.com/@{u}",       "200"),
            ("Reddit",    f"https://reddit.com/user/{u}",        "200"),
            ("Medium",    f"https://medium.com/@{u}",            "200"),
            ("Warpcast",  f"https://warpcast.com/{u}",           "200"),
            ("LinkedIn",  f"https://linkedin.com/in/{u}",        "200"),
        ]
        found = []
        for name, url, check in platforms:
            try:
                r = requests.get(url, headers=HDRS, timeout=5, allow_redirects=True)
                if r.status_code == 200:
                    if check != "200" and check not in r.text: continue
                    found.append(f"✅ <a href='{url}'>{name}</a>")
            except: pass
        lines.extend(found or ["No platforms found"])
        lines.append("")
        lc = fetch_leakcheck(u)
        if lc.get("found_in", 0) > 0:
            lines.append(f"<b>Breach: {lc['found_in']} records</b>")
            lines.append(", ".join(lc.get("sources", [])[:5]))
            if lc.get("has_email_data"): lines.append("Email in breach")
            if lc.get("has_phone_data"): lines.append("Phone in breach")
        else:
            lines.append("Breach: not found")
        _send_long(msg, "\n".join(lines))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["email"])
def cmd_email(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /email user@example.com"); return
    email = parts[1].strip()
    bot.reply_to(msg, "Checking breaches...")
    try: _send_long(msg, osint_breach_full(email))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["breach"])
def cmd_breach(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /breach email@example.com"); return
    email = parts[1].strip()
    bot.reply_to(msg, "Running full breach check (HIBP + LeakCheck + IntelX + Gravatar + PGP)...")
    try: _send_long(msg, osint_breach_full(email))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["intel"])
def cmd_intel(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /intel email@example.com OR username OR wallet"); return
    query = parts[1].strip()
    bot.reply_to(msg, f"Searching IntelX dark web for: {query}...")
    try: _send_long(msg, osint_intel(query))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["phone"])
def cmd_phone(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /phone +14155551234"); return
    phone = parts[1].strip()
    bot.reply_to(msg, "Phone OSINT scanning...")
    try: _send_long(msg, osint_phone(phone))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["domain"])
def cmd_domain(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /domain example.com"); return
    domain = parts[1].strip()
    bot.reply_to(msg, "Domain OSINT scanning...")
    try: _send_long(msg, osint_domain(domain))
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["maigret"])
def cmd_maigret(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2: bot.reply_to(msg, "Usage: /maigret username"); return
    u = parts[1].strip().lstrip("@")
    bot.reply_to(msg, f"Maigret scanning 2000+ platforms for @{u} (takes ~60s)...")
    try:
        mg = run_maigret(u)
        if mg.get("found_platforms"):
            lines = [f"<b>Maigret: {len(mg['found_platforms'])} platforms found</b>\n"]
            for i, (plat, url) in enumerate(zip(mg["found_platforms"], mg.get("profile_urls", []))):
                if url: lines.append(f"{i+1}. <a href='{url}'>{plat}</a>")
                else:   lines.append(f"{i+1}. {plat}")
            _send_long(msg, "\n".join(lines))
        else:
            bot.reply_to(msg, "Maigret not installed\nRun: pip install maigret")
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["phonebook"])
def cmd_phonebook(msg):
    """IntelX phonebook — domain ya naam se sabhi linked emails/phones nikalo."""
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2:
        bot.reply_to(msg, "Usage:\n/phonebook example.com  → sabhi emails from that domain\n/phonebook John Smith   → emails linked to that name")
        return
    query = parts[1].strip()
    bot.reply_to(msg, f"IntelX Phonebook scanning: {query}...")
    try:
        pb = fetch_intelx_phonebook(query)
        if not pb or pb.get("count", 0) == 0:
            bot.reply_to(msg, "No phonebook entries found (IntelX free plan mein limited hai).")
            return
        lines = [f"<b>PHONEBOOK: {query}</b>", f"Total entries: {pb['count']}\n"]
        if pb.get("emails"):
            lines.append(f"<b>Emails ({len(pb['emails'])}):</b>")
            for e in pb["emails"][:20]: lines.append(f"  📩 {e}")
        if pb.get("phones"):
            lines.append(f"\n<b>Phones ({len(pb['phones'])}):</b>")
            for p in pb["phones"][:10]: lines.append(f"  📞 {p}")
        _send_long(msg, "\n".join(lines))
    except Exception as e:
        bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["lookup"])
def cmd_lookup(msg):
    """Multi-source lookup: email/phone/username → name, DOB, breach data."""
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2:
        bot.reply_to(msg, "Usage:\n/lookup email@x.com\n/lookup +14155551234\n/lookup username123")
        return
    query = parts[1].strip()
    bot.reply_to(msg, f"Multi-source lookup: {query}...")
    try:
        lines = [f"<b>LOOKUP: <code>{query}</code></b>\n"]

        # Detect type and run LeakCheck
        if re.match(r"[\w.+-]+@[\w.-]+\.\w{2,}", query):
            lc = fetch_leakcheck(query, "email")
        elif re.match(r"^\+?\d{8,15}$", query):
            lc = fetch_leakcheck_by_phone(query)
        else:
            lc = fetch_leakcheck_by_username(query)

        if lc.get("found_in", 0) > 0:
            lines.append(f"<b>LeakCheck: {lc['found_in']} records found</b>")
            if lc.get("names"):    lines.append(f"👤 Name:  <b>{', '.join(lc['names'][:3])}</b>")
            if lc.get("emails"):   lines.append(f"📩 Email: <b>{', '.join(lc['emails'][:3])}</b>")
            if lc.get("phones"):   lines.append(f"📞 Phone: <b>{', '.join(lc['phones'][:3])}</b>")
            if lc.get("dobs"):     lines.append(f"🎂 DOB:   <b>{', '.join(lc['dobs'][:2])}</b>")
            if lc.get("addresses"):lines.append(f"🏠 Addr:  {lc['addresses'][0][:80]}")
            lines.append(f"\n<b>Breach sources:</b>")
            for s in lc.get("sources", [])[:10]: lines.append(f"  • {s}")
            if lc.get("has_phone_data") and not lc.get("phones"):
                lines.append("\n⚠️ Phone found in breach but hidden — upgrade LEAKCHECK_KEY to paid")
            if lc.get("has_email_data") and not lc.get("emails"):
                lines.append("⚠️ Email found in breach but hidden — upgrade LEAKCHECK_KEY to paid")
        else:
            lines.append("LeakCheck: No breach records found")

        # PDL — public data enrichment (name, gender, DOB, location, job)
        pdl_input_email = query if "@" in query else ""
        pdl_input_phone = query if re.match(r"^\+?\d{8,15}$", query) else ""
        pdl = fetch_pdl_person(email=pdl_input_email, phone=pdl_input_phone)
        if pdl:
            lines.append(f"\n<b>People Data Labs (public records)</b>")
            if pdl.get("pdl_name"):       lines.append(f"👤 Name:       <b>{pdl['pdl_name']}</b>")
            if pdl.get("pdl_gender"):     lines.append(f"🚻 Gender:     {pdl['pdl_gender']}")
            if pdl.get("pdl_birth_year"): lines.append(f"🎂 Birth year: {pdl['pdl_birth_year']}")
            if pdl.get("pdl_phone"):      lines.append(f"📞 Phone:      <b>{pdl['pdl_phone']}</b>")
            loc = ", ".join(filter(None, [pdl.get("pdl_city",""), pdl.get("pdl_state",""), pdl.get("pdl_country","")]))
            if loc:                        lines.append(f"🌍 Location:   {loc}")
            if pdl.get("pdl_postal"):     lines.append(f"📮 Postal:     {pdl['pdl_postal']}")
            if pdl.get("pdl_job"):        lines.append(f"💼 Job:        {pdl['pdl_job']} @ {pdl.get('pdl_company','')}")
            if pdl.get("pdl_linkedin"):   lines.append(f"🔗 LinkedIn:   {pdl['pdl_linkedin']}")
        else:
            lines.append("\nPDL: Not found (set PDL_API_KEY for public data enrichment)")

        # IntelX dark web
        ix = fetch_intelx(query)
        if ix.get("records_found", 0) > 0:
            lines.append(f"\n<b>IntelX dark web: {ix['records_found']} documents</b>")
            if ix.get("emails"):  lines.append(f"Related emails: {', '.join(ix['emails'][:3])}")
            if ix.get("phones"):  lines.append(f"Related phones: {', '.join(ix['phones'][:3])}")

        _send_long(msg, "\n".join(lines))
    except Exception as e:
        bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(commands=["deep"])
def cmd_deep(msg):
    parts = msg.text.split(maxsplit=1)
    if len(parts) < 2:
        bot.reply_to(msg, "Usage: /deep <email OR username OR wallet OR domain OR phone>"); return
    query = parts[1].strip()
    bot.reply_to(msg, f"NUCLEAR SCAN starting for: {query}\nThis will take 30-60s...")
    try:
        results = osint_deep(query)
        for part in results:
            _send_long(msg, part)
    except Exception as e: bot.reply_to(msg, f"Error: {e}")


@bot.message_handler(func=lambda m: True)
def auto_detect(msg):
    """Auto-detect query type and route to correct handler."""
    text = msg.text.strip()
    if text.startswith("/"): return
    bot.reply_to(msg, "Auto-detecting and scanning...")
    try:
        if re.match(r"^0x[0-9a-fA-F]{40}$", text):
            _send_long(msg, osint_wallet(text))
        elif re.match(r"^[\w.-]+\.eth$", text, re.I):
            r = requests.get(f"https://api.ensideas.com/ens/resolve/{text}", timeout=8)
            addr = r.json().get("address","") if r.status_code == 200 else ""
            _send_long(msg, osint_wallet(addr) if addr else "ENS not resolved")
        elif re.match(r"[\w.+-]+@[\w.-]+\.\w{2,}", text):
            _send_long(msg, osint_breach_full(text))
        elif re.match(r"^\+?\d{8,15}$", text):
            _send_long(msg, osint_phone(text))
        elif re.match(r"^[\w.-]+\.[a-z]{2,}$", text) and "." in text:
            _send_long(msg, osint_domain(text))
        else:
            _send_long(msg, osint_social(text))
    except Exception as e:
        bot.reply_to(msg, f"Error: {e}")


if __name__ == "__main__":
    me = bot.get_me()
    print(f"[GOD LEVEL OSINT BOT] Starting as @{me.username}")
    print("Commands: /lookup /phonebook /breach /intel /phone /domain /maigret /social /wallet /ens /check /email /deep")
    print("Ctrl+C to stop")
    bot.infinity_polling(timeout=30)
