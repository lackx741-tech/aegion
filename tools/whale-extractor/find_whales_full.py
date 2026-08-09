"""
find_whales_full.py — God-Level Whale OSINT
============================================
Internet-first whale discovery:
  1. ENS subgraph → wallets with email/telegram/url records
  2. DuckDuckGo internet search for any wallet
  3. Cross-platform username check (1 username → 6 platforms)
  4. WHOIS from personal domain
  5. DeBank, Unstoppable Domains, Arkham, Farcaster, Lens
  6. IntelX, Apify, Sherlock/Maigret (if keys/installed)
  7. Email permutation generator

Result: $1M+ wallets with maximum contact info extracted.

Usage:
    python find_whales_full.py             # Normal mode
    python find_whales_full.py --older     # 45+ demographic filter
    python find_whales_full.py --limit 20  # Find 20 instead of 10
"""
import sys, os, time, json, re, argparse, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Setup path & env ───────────────────────────────────────────────────────
WHALE_DIR = os.path.dirname(os.path.abspath(__file__))
if WHALE_DIR not in sys.path:
    sys.path.insert(0, WHALE_DIR)
os.chdir(WHALE_DIR)

from dotenv import load_dotenv
load_dotenv(".env")

import requests
from whale_extractor import (
    # Candidate discovery
    phase1_candidates,
    # Balance
    fetch_eth_balance, fetch_token_portfolio, _alchemy_batch_rpc, _KNOWN_CEX,
    # ENS
    fetch_ens_name, fetch_ens_records,
    # Social / Web3
    fetch_web3_social, fetch_social, fetch_arkham_identity,
    # OSINT functions
    fetch_debank_public, fetch_debank_profile, fetch_unstoppable_free, fetch_unstoppable_profile,
    fetch_web_osint, fetch_github_mentions,
    fetch_whois_contact, check_username_platforms,
    fetch_fragment_ton_username, run_sherlock, run_maigret,
    fetch_intelx, fetch_apify_wallet_twitter,
    fetch_nitter_search, fetch_leakcheck, fetch_ens_phone, fetch_phone_from_all,
    generate_email_permutations, find_real_emails,
    # NEW — Option 1 sources (all free, no key needed except OpenSea)
    fetch_opensea_profile, fetch_lens_profile,
    fetch_snapshot_profile, fetch_mirror_profile, fetch_debank_social,
    # Free custom scrapers (no API key needed)
    fetch_etherscan_label, fetch_twitter_from_address,
    # Filters
    fetch_wallet_labels,
    # On-chain
    fetch_first_tx_date, fetch_recent_txs,
    # Multi-chain balances (already in whale_extractor, just not called here)
    fetch_networth_moralis, fetch_ankr_extra_balance,
    fetch_solana_balance, fetch_tron_balance, fetch_btc_balance,
    fetch_ton_balance, fetch_ada_balance, fetch_dot_balance,
    # Scoring
    WhaleRecord, score_behavior, score_older_demographic,
    # Farcaster discovery
    fetch_web3_social,
)
from datetime import datetime, timezone

# ── Data-cleaning helpers ───────────────────────────────────────────────────
def _clean_phone(raw: str) -> str:
    """Validate phone: strip non-digits, accept only 7-15 digits."""
    if not raw:
        return ""
    digits = re.sub(r"[^\d]", "", raw)
    if 7 <= len(digits) <= 15:
        return digits
    return ""

def _clean_telegram(raw: str) -> str:
    """Return clean @username or '' — strip URLs and garbage."""
    if not raw:
        return ""
    s = raw.strip()
    # t.me/username → @username
    m = re.search(r"t\.me/([A-Za-z0-9_]{5,32})", s)
    if m:
        return f"@{m.group(1)}"
    # Strip leading @ and check it's not a URL
    handle = s.lstrip("@")
    if handle.lower().startswith("http"):
        return ""
    handle = re.sub(r"[^A-Za-z0-9_]", "", handle)
    if 5 <= len(handle) <= 32:
        return f"@{handle}"
    return ""

# ── Config ─────────────────────────────────────────────────────────────────
def _fetch_eth_price() -> float:
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
            timeout=8,
        )
        return float(r.json()["ethereum"]["usd"])
    except Exception:
        return 3200.0  # fallback

ETH_PRICE   = _fetch_eth_price()
NOW         = datetime.now(timezone.utc)
ENS_GRAPH   = "https://api.thegraph.com/subgraphs/name/ensdomains/ens"
PARSER      = argparse.ArgumentParser()
PARSER.add_argument("--older",   action="store_true", help="45+ demographic filter")
PARSER.add_argument("--limit",   type=int, default=10, help="Number of whales to find")
PARSER.add_argument("--min-usd", type=float, default=1_000_000)
PARSER.add_argument("--max-usd", type=float, default=0, help="Max USD balance (0 = no limit)")
PARSER.add_argument("--out",     type=str, default="whale_results.json", help="Output JSON file")
PARSER.add_argument("--fast",    action="store_true",
                    help="Fast mode: skip Sherlock/IntelX/Nitter, use pre-known identity only")
PARSER.add_argument("--workers", type=int, default=4,
                    help="Parallel OSINT workers (default 4, max 8)")
ARGS        = PARSER.parse_args()

TARGET      = ARGS.limit
MIN_USD     = ARGS.min_usd
FAST_MODE   = ARGS.fast
N_WORKERS   = min(ARGS.workers, 8)
OLDER_MODE  = ARGS.older

# ─────────────────────────────────────────────────────────────────────────────
def ens_candidates_with_contact() -> list:
    """
    ENS Subgraph → wallets that have email/telegram/url records SET.
    Cursor-based pagination (no skip limit).
    """
    seen, candidates = set(), []

    for key in ["email", "org.telegram", "url", "com.twitter", "com.github", "com.discord"]:
        print(f"  Querying ENS for key='{key}'...")
        cursor = ""
        page   = 0

        while page < 20:
            query = """
            query($cursor: String!, $keys: [String!]!) {
              resolvers(
                first: 1000
                where: { texts_contains: $keys, id_gt: $cursor }
                orderBy: id, orderDirection: asc
              ) {
                id
                addr { id }
                domain { name }
                texts
              }
            }
            """
            try:
                r = requests.post(
                    ENS_GRAPH,
                    json={"query": query, "variables": {"cursor": cursor, "keys": [key]}},
                    timeout=25,
                )
                batch = r.json().get("data", {}).get("resolvers", [])
            except Exception:
                batch = []

            if not batch:
                break

            for item in batch:
                addr   = (item.get("addr") or {}).get("id", "")
                domain = (item.get("domain") or {}).get("name", "")
                if not addr or addr == "0x0000000000000000000000000000000000000000":
                    continue
                al = addr.lower()
                if al not in seen:
                    seen.add(al)
                    candidates.append({"addr": addr, "ens": domain, "texts": item.get("texts", [])})

            cursor = batch[-1]["id"]
            page  += 1
            if len(batch) < 1000:
                break
            time.sleep(0.1)

        print(f"    → {len(candidates)} total candidates so far")

    return candidates


def get_all_contact(addr: str, ens: str) -> dict:
    """
    Run ALL available OSINT sources on one address.
    Returns structured contact dict.
    """
    # 1. ENS records
    recs     = fetch_ens_records(ens) if ens else {}
    email    = recs.get("email", "")
    telegram = _clean_telegram(recs.get("org.telegram", "") or recs.get("telegram", ""))
    twitter  = recs.get("com.twitter", "") or recs.get("twitter", "")
    url      = recs.get("url", "")
    linkedin = url if "linkedin.com" in url.lower() else ""

    # 2. Farcaster → Twitter (verified_accounts)
    w3s = fetch_web3_social(addr)
    if not twitter and w3s.get("twitter_handle"):
        twitter = w3s["twitter_handle"]
    farcaster = w3s.get("farcaster_user", "")
    lens      = w3s.get("lens_handle", "")

    # 3. Arkham entity + Twitter
    arkham = fetch_arkham_identity(addr)
    if not twitter and arkham.get("twitter_handle"):
        twitter = arkham["twitter_handle"]
    entity = arkham.get("entity_name", "")

    # 3b. Etherscan public label (free, no key)
    if not entity:
        entity = fetch_etherscan_label(addr)

    # 3c. Twitter direct address search (free Bearer token)
    if not twitter:
        twitter = fetch_twitter_from_address(addr)

    # 4. DeBank → Twitter/Discord (free public scraper first)
    debank = fetch_debank_public(addr) or fetch_debank_profile(addr)
    if not twitter and debank.get("twitter_handle"):
        twitter = debank["twitter_handle"]
    discord = debank.get("discord", "")

    # 5. Unstoppable Domains (free public API first)
    ud = fetch_unstoppable_free(addr) or fetch_unstoppable_profile(addr)
    ud_domain = ud.get("ud_domain", "")
    if not email    and ud.get("email"):    email    = ud["email"]
    if not telegram and ud.get("telegram"): telegram = _clean_telegram(ud["telegram"])
    if not twitter  and ud.get("twitter_handle"): twitter = ud["twitter_handle"]
    if not linkedin and ud.get("linkedin"): linkedin = ud["linkedin"]

    # 6. DuckDuckGo web OSINT
    web = fetch_web_osint(addr, ens)
    if not email    and web.get("email"):    email    = web["email"]
    if not telegram and web.get("telegram"): telegram = _clean_telegram(web["telegram"])
    if not twitter  and web.get("twitter"):  twitter  = web["twitter"]
    if not linkedin and web.get("linkedin"): linkedin = web["linkedin"]
    web_mentions = web.get("mentions", [])

    # 7. WHOIS from ENS URL
    whois = fetch_whois_contact(url) if url else {}
    if not email and whois.get("email"): email = whois["email"]
    phone = _clean_phone(whois.get("phone", ""))
    whois_name = whois.get("name", "")

    # 8. Fragment TON → Telegram
    frag_tg = fetch_fragment_ton_username(addr)
    if not telegram and frag_tg:
        telegram = _clean_telegram(frag_tg)

    # 9. GitHub code search
    gh = fetch_github_mentions(addr)
    if not email and gh.get("email"): email = gh["email"]
    github_url = gh.get("github_url", "")

    # 10. Cross-platform username check
    best_uname = (
        (twitter or "").lstrip("@")
        or farcaster
        or (ens.split(".")[0] if ens else "")
    )
    cross = check_username_platforms(best_uname) if best_uname else {}
    if not telegram and cross.get("telegram"):
        telegram = _clean_telegram(f"@{best_uname}" if best_uname else cross["telegram"])
    if not github_url and cross.get("github"):
        github_url = cross["github"]
    instagram = cross.get("instagram", "")
    reddit    = cross.get("reddit", "")

    # 11. Sherlock/Maigret (if installed)
    sherlock_platforms = []
    if best_uname:
        s = run_sherlock(best_uname)
        m = run_maigret(best_uname)
        sherlock_platforms = list(dict.fromkeys(
            s.get("found_platforms", []) + m.get("found_platforms", [])
        ))

    # 12. Apify wallet→Twitter scraper
    if not twitter:
        apify_tw = fetch_apify_wallet_twitter(addr)
        if apify_tw:
            twitter = apify_tw

    # 13. IntelX (indexed web/breach)
    intelx_emails, intelx_phones = [], []
    if os.getenv("INTELX_KEY"):
        ix = fetch_intelx(addr, "ethereum")
        intelx_emails = ix.get("emails", [])
        intelx_phones = [_clean_phone(p) for p in ix.get("phones", []) if _clean_phone(p)]
        if not email and intelx_emails:
            email = intelx_emails[0]
        if not phone and intelx_phones:
            phone = intelx_phones[0]

    # 14b. Nitter (free Twitter search — no key)
    nitter = fetch_nitter_search(addr[:10])
    nitter_ens = fetch_nitter_search(ens) if ens else {}
    if not twitter and nitter.get("usernames"):
        twitter = f"@{nitter['usernames'][0]}"
    for e in (nitter.get("emails_found", []) + nitter_ens.get("emails_found", [])):
        if not email and "@" in e:
            email = e

    # 14c. ENS phone text record + phone aggregation
    if not phone:
        phone = _clean_phone(fetch_ens_phone(ens) if ens else "")
    if not phone:
        phone = _clean_phone(fetch_phone_from_all(addr, ens, email, (twitter or "").lstrip("@")))

    # 14d. LeakCheck — free public API (no key needed)
    # Search email OR username. Free tier shows if phone/email data EXISTS in breach DB.
    # Pro tier (LEAKCHECK_KEY) gives actual values.
    breach_sources = []
    lc_phone_hint  = False   # True = phone number exists in breach DB (even if we can't see it)
    search_terms   = [t for t in [email, best_uname, ens.split(".")[0] if ens else ""] if t]
    for term in search_terms[:2]:  # max 2 checks to stay within free rate limit
        lc = fetch_leakcheck(term)
        if lc.get("sources"):
            breach_sources = lc["sources"]
        if lc.get("phones"):          # Pro: actual phone returned
            phone = _clean_phone(lc["phones"][0]) or phone
        if lc.get("emails") and not email:
            email = lc["emails"][0]
        if lc.get("has_phone_data"):  # Free: phone EXISTS in breach (just can't see it)
            lc_phone_hint = True
        if breach_sources:
            break

    # 14e. NEW SOURCES — OpenSea + Lens + Snapshot + Mirror + DeBank (parallel)
    # All run simultaneously, adds ~5-8 sec total per wallet
    import concurrent.futures as _cf
    _src_results: dict = {}
    def _safe(fn, a):
        try: return fn(a)
        except Exception: return {}
    with _cf.ThreadPoolExecutor(max_workers=5) as _ex:
        _futs = {
            _ex.submit(_safe, fetch_opensea_profile, addr): "os",
            _ex.submit(_safe, fetch_lens_profile,    addr): "lens",
            _ex.submit(_safe, fetch_snapshot_profile,addr): "snap",
            _ex.submit(_safe, fetch_mirror_profile,  addr): "mirror",
            _ex.submit(_safe, fetch_debank_social,   addr): "db",
        }
        for _f, _k in _futs.items():
            try: _src_results[_k] = _f.result(timeout=12) or {}
            except Exception: _src_results[_k] = {}

    _os     = _src_results.get("os", {})
    _lens   = _src_results.get("lens", {})
    _snap   = _src_results.get("snap", {})
    _mirror = _src_results.get("mirror", {})
    _db     = _src_results.get("db", {})

    # Fill gaps from new sources
    if not email    and _lens.get("lens_email"):    email    = _lens["lens_email"]
    if not email    and _db.get("db_email"):        email    = _db["db_email"]
    if not twitter  and _os.get("os_twitter"):      twitter  = _os["os_twitter"]
    if not twitter  and _db.get("db_twitter"):      twitter  = _db["db_twitter"]
    if not twitter  and _snap.get("snap_twitter"):  twitter  = _snap["snap_twitter"]
    if not twitter  and _mirror.get("mirror_twitter"): twitter = _mirror["mirror_twitter"]
    if not twitter  and _lens.get("lens_twitter"):  twitter  = _lens["lens_twitter"]
    if not discord  and _db.get("db_discord"):      discord  = _db["db_discord"]
    if not github_url and _snap.get("snap_github"): github_url = _snap["snap_github"]
    if not lens     and _lens.get("lens_handle"):   lens     = _lens["lens_handle"]
    # Website from OpenSea/Lens → WHOIS for email
    _extra_site = _os.get("os_website","") or _lens.get("lens_website","")
    if not email and _extra_site:
        try:
            _dom = re.sub(r"https?://","",_extra_site).split("/")[0]
            if _dom and "." in _dom:
                _wh = fetch_whois_contact(_dom)
                if _wh.get("email"): email = _wh["email"]
        except Exception: pass

    # 14. Email permutations + real-email verification (if name known but no email)
    email_candidates = []
    email_verified   = []
    if not email:
        name_src = whois_name or gh.get("name", "") or _mirror.get("mirror_name","") or _lens.get("lens_name","")
        if name_src:
            ens_domain = url.replace("https://", "").replace("http://", "").split("/")[0]
            extra_dom  = [ens_domain] if ens_domain and "." in ens_domain else []
            candidates = generate_email_permutations(name_src, extra_dom or None)
            if candidates:
                real = find_real_emails(candidates, stop_on_first=True)
                if real:
                    email = real[0]["email"]
                email_verified   = real
                email_candidates = [r["email"] for r in real]

    return {
        "email":              email,
        "telegram":           telegram,
        "twitter":            twitter,
        "farcaster":          farcaster,
        "lens":               lens,
        "linkedin":           linkedin,
        "discord":            discord,
        "github":             github_url,
        "instagram":          instagram,
        "reddit":             reddit,
        "phone":              phone,
        "ud_domain":          ud_domain,
        "whois_name":         whois_name,
        "entity":             entity,
        "web_mentions":       web_mentions,
        "sherlock_platforms": sherlock_platforms,
        "email_candidates":   email_candidates[:5],
        "email_verified":     email_verified,
        "intelx_emails":      intelx_emails,
        "intelx_phones":      intelx_phones,
        "breach_sources":     breach_sources,
        "nitter_mentions":    (nitter.get("tweets", []) + nitter_ens.get("tweets", []))[:3],
        # New sources
        "os_username":        _os.get("os_username",""),
        "os_twitter":         _os.get("os_twitter",""),
        "lens_handle":        _lens.get("lens_handle",""),
        "lens_twitter":       _lens.get("lens_twitter",""),
        "snap_twitter":       _snap.get("snap_twitter",""),
        "snap_github":        _snap.get("snap_github",""),
        "mirror_name":        _mirror.get("mirror_name",""),
        "db_twitter":         _db.get("db_twitter",""),
        "db_discord":         _db.get("db_discord",""),
    }


def get_contact_fast(w: dict) -> dict:
    """
    Fast contact extraction using pre-loaded identity (Farcaster/Lens/ENS).
    Skips: Sherlock, Maigret, IntelX, Nitter, Apify.
    ~3-6 sec per wallet vs 30-60 sec in full mode.
    """
    addr = w["addr"]
    ens  = w.get("ens", "") or ""

    # Pre-populated from Farcaster/Lens scan
    farcaster = w.get("_farcaster", "")
    twitter   = w.get("_fc_twitter", "") or w.get("_bio_twitter", "")
    telegram  = _clean_telegram(w.get("_bio_telegram", ""))
    lens      = w.get("_lens", "") or w.get("_bio_handle", "") if "lens" in (w.get("_bio_platform","")) else w.get("_lens","")
    email     = w.get("_bio_email", "")
    github    = w.get("_bio_github", "")

    # ENS records (fast — single call)
    if ens:
        try:
            recs     = fetch_ens_records(ens) or {}
            email    = email    or recs.get("email", "")
            telegram = telegram or _clean_telegram(recs.get("org.telegram","") or recs.get("telegram",""))
            twitter  = twitter  or recs.get("com.twitter","") or recs.get("twitter","")
            github   = github   or recs.get("com.github","")
        except Exception:
            pass

    # Farcaster (if not pre-loaded)
    if not farcaster:
        try:
            w3s       = fetch_web3_social(addr)
            farcaster = farcaster or w3s.get("farcaster_user","")
            twitter   = twitter   or w3s.get("twitter_handle","")
            lens      = lens      or w3s.get("lens_handle","")
        except Exception:
            pass

    # Arkham entity label
    entity = ""
    try:
        ark    = fetch_arkham_identity(addr)
        entity = ark.get("entity_name","")
        twitter = twitter or ark.get("twitter_handle","")
    except Exception:
        pass
    if not entity:
        try:
            entity = fetch_etherscan_label(addr) or ""
        except Exception:
            pass

    # Unstoppable Domains
    ud_domain = ""
    try:
        ud = fetch_unstoppable_free(addr) or {}
        ud_domain = ud.get("ud_domain","")
        email    = email    or ud.get("email","")
        telegram = telegram or _clean_telegram(ud.get("telegram",""))
        twitter  = twitter  or ud.get("twitter_handle","")
    except Exception:
        pass

    # Web OSINT (Serper) — fast, 1 call
    web_mentions = []
    try:
        web = fetch_web_osint(addr, ens)
        web_mentions = web.get("mentions",[])[:5]
        email    = email    or web.get("email","")
        telegram = telegram or _clean_telegram(web.get("telegram",""))
        twitter  = twitter  or web.get("twitter","")
    except Exception:
        pass

    # ENS phone
    phone = ""
    try:
        phone = _clean_phone(fetch_ens_phone(ens)) if ens else ""
    except Exception:
        pass

    # LeakCheck by email (fast, 1 req)
    breach_sources = []
    if email:
        try:
            lc = fetch_leakcheck(email)
            breach_sources = lc.get("sources",[])
            phone = phone or _clean_phone(lc.get("phones",[""])[0] if lc.get("phones") else "")
        except Exception:
            pass

    has_contact = any([email, telegram, twitter, farcaster, lens, github, phone,
                       ud_domain, len(web_mentions) >= 3])

    return {
        "email": email, "telegram": telegram, "twitter": twitter,
        "farcaster": farcaster, "lens": lens, "linkedin": "",
        "discord": "", "github": github, "instagram": "", "reddit": "",
        "phone": phone, "ud_domain": ud_domain, "whois_name": "",
        "entity": entity, "web_mentions": web_mentions,
        "sherlock_platforms": [], "email_candidates": [], "email_verified": [],
        "intelx_emails": [], "intelx_phones": [], "breach_sources": breach_sources,
        "nitter_mentions": [],
        "os_username": "", "os_twitter": twitter, "lens_handle": lens,
        "lens_twitter": "", "snap_twitter": "", "snap_github": github,
        "mirror_name": "", "db_twitter": twitter, "db_discord": "",
        "_has_contact": has_contact,
    }


def check_balance(addr: str) -> tuple:
    """Returns (total_usd, eth, portfolio) across ALL chains.
    Priority: Moralis (12 EVM chains) → Ankr extras → TRON → Solana.
    """
    try:
        eth  = fetch_eth_balance(addr)
        port = fetch_token_portfolio(addr)
        eth_tok = sum(float(t.get("tokenValue") or 0) for t in port)
        eth_usd = eth * ETH_PRICE + eth_tok

        # Moralis: 12 EVM chains in 1 call (ETH + BSC + Polygon + Arbitrum + etc.)
        moralis_usd, moralis_chains = fetch_networth_moralis(addr)
        # Use the higher of Moralis vs raw ETH (Moralis includes ETH too)
        multi_usd = max(moralis_usd, eth_usd)

        # Ankr: extra EVM chains not in Moralis (Fantom, Celo, zkSync, Scroll, etc.)
        ankr_usd, _ = fetch_ankr_extra_balance(addr)
        multi_usd += ankr_usd

        # TRON (different address space — skip silently if not a TRON addr)
        # tron_usd, _ = fetch_tron_balance(addr)  # only for TRON addresses

        return multi_usd, eth, port
    except Exception:
        try:
            eth = fetch_eth_balance(addr)
            return eth * ETH_PRICE, eth, []
        except Exception:
            return 0.0, 0.0, []


def print_whale(i: int, w: dict) -> None:
    c = w["contact"]
    channels = [f for f in [c["email"], c["telegram"], c["twitter"],
                             c["linkedin"], c["discord"], c["phone"],
                             c["farcaster"], c["lens"]] if f]
    n_channels = len(channels)

    print(f"\n{'─'*60}")
    print(f"  #{i}  {w['ens'] or 'ANON'}  [{w['addr']}]")
    if c["entity"]:
        print(f"       Entity     : {c['entity']}")
    if c["ud_domain"]:
        print(f"       UD Domain  : {c['ud_domain']}")
    print(f"       USD Total  : ${w['total_usd']:>14,.0f}")
    print(f"       ETH        : {w['eth']:.3f}")
    print(f"       Wallet Age : {w['age_mo']:.0f} months")
    print(f"       Older Score: {w['older_score']}/10")
    print()
    print(f"  ── CONTACT ({n_channels} channels found) ──")
    print(f"  📧 Email      : {c['email']      or '—'}")
    print(f"  📱 Phone      : {c['phone']      or '—'}")
    print(f"  💬 Telegram   : {c['telegram']   or '—'}")
    print(f"  🐦 Twitter/X  : {c['twitter']    or '—'}")
    print(f"  👔 LinkedIn   : {c['linkedin']   or '—'}")
    print(f"  💻 Farcaster  : {c['farcaster']  or '—'}")
    print(f"  🌿 Lens       : {c['lens']       or '—'}")
    print(f"  🎮 Discord    : {c['discord']    or '—'}")
    print(f"  🐙 GitHub     : {c['github']     or '—'}")
    print(f"  📸 Instagram  : {c['instagram']  or '—'}")
    if c.get("email_verified"):
        print(f"  📧 Email verified: {c['email_verified'][0]['email']} ({c['email_verified'][0]['method']}, conf={c['email_verified'][0]['confidence']}%)")
    elif c["email_candidates"]:
        print(f"  📧 Email guesses (unverified): {', '.join(c['email_candidates'][:3])}")
    if c["sherlock_platforms"]:
        print(f"  🔍 Sherlock/Maigret: {', '.join(c['sherlock_platforms'][:8])}")
    if c.get("breach_sources"):
        print(f"  ⚠️  Breach data: found in {', '.join(c['breach_sources'][:3])}")
    if c.get("nitter_mentions"):
        print(f"  🐦 Nitter tweets: {len(c['nitter_mentions'])} mentions found")
    if c["web_mentions"]:
        print(f"  🌐 Web mentions: {len(c['web_mentions'])} found")
        for m in c["web_mentions"][:2]:
            print(f"     • {m[:80]}")
    print(f"  ⛓  On-chain   : ALWAYS ✓  tx → {w['addr']}")


_STABLES = [
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6,  "USDC"),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7", 6,  "USDT"),
    ("0x6b175474e89094c44da98b954eedeac495271d0f", 18, "DAI"),
    ("0x4fabb145d64652a948d72533023f6e7a623c7c53", 18, "BUSD"),
]
_BAL_SIG = "0x70a08231"  # ERC20 balanceOf(address) selector


def _batch_balance_filter(cands: list, batch_size: int = 20, prefilter_usd: float = None) -> list:
    """
    Phase-1: ETH + top stablecoin balance check via Alchemy batch RPC.
    Each wallet = 1 eth_getBalance + 4 eth_call (USDC/USDT/DAI/BUSD) = 5 calls.
    batch_size=20 → 100 calls per HTTP request (safe Alchemy limit).
    Uses parallel workers = number of Alchemy keys for max speed.
    """
    from whale_extractor import _ALCHEMY_KEYS as _AK
    n_workers = max(len(_AK), 1)

    rich   = []
    total  = len(cands)
    t0     = time.time()
    done   = 0
    lock   = __import__("threading").Lock()

    # N_CALLS per wallet = 1 ETH + len(stables)
    N_CALLS = 1 + len(_STABLES)
    batches = [cands[i : i + batch_size] for i in range(0, total, batch_size)]

    def _process_batch(batch):
        # Build batch: for each wallet → eth_getBalance + 4 × eth_call
        calls = []
        for c in batch:
            addr = c["addr"]
            calls.append(("eth_getBalance", [addr, "latest"]))
            padded = addr[2:].lower().zfill(64)
            for contract, _, _ in _STABLES:
                calls.append(("eth_call", [{"to": contract, "data": _BAL_SIG + padded}, "latest"]))

        try:
            results_raw = _alchemy_batch_rpc(calls)
        except Exception:
            results_raw = [None] * len(calls)

        out = []
        for idx, c in enumerate(batch):
            if c["addr"].lower() in _KNOWN_CEX:
                continue
            base = idx * N_CALLS
            try:
                eth_hex = results_raw[base]
                eth = int(eth_hex, 16) / 1e18 if eth_hex else 0.0
            except Exception:
                eth = 0.0

            stable_usd = 0.0
            for si, (_, dec, _) in enumerate(_STABLES):
                try:
                    raw = results_raw[base + 1 + si]
                    stable_usd += int(raw, 16) / (10 ** dec) if raw and raw != "0x" else 0.0
                except Exception:
                    pass
            # carry all _farcaster/_lens/_bio metadata from candidate
            _meta = {k: v for k, v in c.items() if k.startswith("_")}

            total_usd = eth * ETH_PRICE + stable_usd
            _thresh = prefilter_usd if prefilter_usd is not None else MIN_USD
            if total_usd >= _thresh:
                entry = {
                    "addr":       c["addr"],
                    "ens":        c.get("ens", "") or "",
                    "total_usd":  total_usd,
                    "eth":        eth,
                    "port":       [],
                    "entity_lbl": "",
                }
                entry.update(_meta)   # carry _farcaster, _lens, _bio_* etc.
                out.append(entry)
        return out, len(batch)

    with ThreadPoolExecutor(max_workers=n_workers) as ex:
        futs = [ex.submit(_process_batch, b) for b in batches]
        for idx, fut in enumerate(as_completed(futs)):
            batch_rich, batch_len = fut.result()
            with lock:
                rich.extend(batch_rich)
                done += batch_len
            if idx % 20 == 0 or done >= total:
                elapsed = time.time() - t0
                rate    = done / max(elapsed, 1)
                eta_s   = int((total - done) / max(rate, 0.1))
                sys.stdout.write(
                    f"\r  [{done}/{total}] Qualified: {len(rich)}"
                    f"  |  {rate:.0f} w/s  |  ETA ~{eta_s}s      "
                )
                sys.stdout.flush()

    return rich


NEYNAR_KEY = os.getenv("NEYNAR_KEY", "")
NEYNAR_HDR = {"api_key": NEYNAR_KEY, "accept": "application/json"}

# Crypto channels to pull Farcaster users from
FC_CHANNELS = ["ethereum", "base", "defi", "crypto", "nft", "bitcoin",
               "web3", "solana", "stablecoin", "uniswap", "aave"]


def farcaster_identity_candidates() -> list:
    """
    Farcaster channels → users with verified ETH addresses.
    Uses Neynar API — already have key.
    Returns candidates with farcaster handle already populated.
    """
    if not NEYNAR_KEY:
        print("  [Farcaster] No NEYNAR_KEY — skipping")
        return []

    seen      = set()
    candidates = []

    for channel in FC_CHANNELS:
        cursor = ""
        pages  = 0
        print(f"  [Farcaster] #{channel} channel followers...", end="", flush=True)

        while pages < 5:  # max 5 pages × 1000 = 5000 per channel
            params = {"id": channel, "limit": 1000}
            if cursor:
                params["cursor"] = cursor
            try:
                r = requests.get(
                    "https://api.neynar.com/v2/farcaster/channel/followers",
                    params=params, headers=NEYNAR_HDR, timeout=15)
                data = r.json()
                users = data.get("users") or []
            except Exception:
                break

            if not users:
                break

            for u in users:
                eth_addrs = (u.get("verified_addresses") or {}).get("eth_addresses") or []
                if not eth_addrs:
                    continue
                for addr in eth_addrs:
                    al = addr.lower()
                    if al not in seen:
                        seen.add(al)
                        candidates.append({
                            "addr":      addr,
                            "ens":       "",
                            "texts":     ["com.twitter", "farcaster"],  # mark as identity-rich
                            "_farcaster": u.get("username", ""),
                            "_fc_display": u.get("display_name", ""),
                            "_fc_bio":   (u.get("profile") or {}).get("bio", {}).get("text", ""),
                            "_fc_followers": u.get("follower_count", 0),
                            "_fc_twitter": next(
                                (a.get("username","") for a in (u.get("verified_accounts") or [])
                                 if a.get("platform") == "twitter"), ""),
                        })

            cursor = (data.get("next") or {}).get("cursor", "")
            pages += 1
            if not cursor:
                break
            time.sleep(0.2)

        print(f" {len(candidates)} total")

    return candidates


def lens_identity_candidates() -> list:
    """
    Lens Protocol profiles → wallet addresses with social identity.
    GraphQL API — no key needed, free public endpoint.
    """
    candidates = []
    seen       = set()
    cursor     = None

    print("  [Lens] Fetching profiles...", end="", flush=True)

    for _ in range(10):  # max 10 pages × 50 = 500 profiles
        variables = {"limit": "Fifty"}
        if cursor:
            variables["cursor"] = cursor

        query = """
        query Profiles($limit: LimitType!, $cursor: Cursor) {
          profiles(request: { limit: $limit, cursor: $cursor }) {
            items {
              id
              handle { fullHandle }
              ownedBy { address }
              metadata { bio displayName }
              stats { followers following }
            }
            pageInfo { next }
          }
        }"""
        try:
            r = requests.post(
                "https://api.lens.dev/graphql",
                json={"query": query, "variables": variables},
                timeout=12)
            data  = r.json().get("data", {}).get("profiles", {})
            items = data.get("items", [])
            cursor = data.get("pageInfo", {}).get("next")
        except Exception:
            break

        for item in items:
            addr = (item.get("ownedBy") or {}).get("address", "")
            if not addr:
                continue
            al = addr.lower()
            if al in seen:
                continue
            seen.add(al)
            handle  = (item.get("handle") or {}).get("fullHandle", "")
            meta    = item.get("metadata") or {}
            stats   = item.get("stats") or {}
            candidates.append({
                "addr":    addr,
                "ens":     "",
                "texts":   ["lens"],
                "_lens":   handle,
                "_lens_bio": meta.get("bio", ""),
                "_lens_display": meta.get("displayName", ""),
                "_lens_followers": stats.get("followers", 0),
            })

        if not cursor:
            break
        time.sleep(0.15)

    print(f" {len(candidates)} profiles")
    return candidates


def web3bio_bulk_candidates(handles: list) -> list:
    """
    Web3.bio bulk lookup — resolve any ENS/Farcaster/Lens handle to wallet+identity.
    """
    candidates = []
    seen       = set()
    for handle in handles[:500]:
        try:
            r = requests.get(f"https://api.web3.bio/profile/{handle}", timeout=6)
            if r.status_code != 200:
                continue
            profiles = r.json() if isinstance(r.json(), list) else [r.json()]
            for p in (profiles or []):
                if not p:
                    continue
                addr = p.get("address", "")
                if not addr or addr.lower() in seen:
                    continue
                seen.add(addr.lower())
                links = p.get("links") or {}
                candidates.append({
                    "addr":  addr,
                    "ens":   p.get("identity", "") if p.get("platform") == "ens" else "",
                    "texts": [k for k, v in links.items() if v],
                    "_bio_platform": p.get("platform", ""),
                    "_bio_handle":   p.get("handle", ""),
                    "_bio_twitter":  (links.get("twitter") or {}).get("handle", ""),
                    "_bio_telegram": (links.get("telegram") or {}).get("handle", ""),
                    "_bio_email":    (links.get("email") or {}).get("handle", ""),
                    "_bio_github":   (links.get("github") or {}).get("handle", ""),
                })
            time.sleep(0.05)
        except Exception:
            pass
    return candidates


def main():
    print("=" * 60)
    print("  WHALE OSINT FINDER — Identity-First Flow")
    print("=" * 60)
    if OLDER_MODE:
        print("  Mode: 45+ demographic (old wallets, no DeFi/NFTs)")
    print(f"  Target: {TARGET} whales  |  Min: ${MIN_USD:,.0f}")
    print()

    # ── STEP 1: ENS-first candidates (already have contact info) ──────────
    print("STEP 1: ENS Subgraph — wallets with email/twitter/telegram records")
    all_cands = ens_candidates_with_contact()
    print(f"  ENS candidates: {len(all_cands)}")
    seen_addrs = {c["addr"].lower() for c in all_cands}
    print()

    # ── STEP 2: Identity-rich sources (Farcaster + Lens) ──────────────────
    # These wallets ALREADY have social identity — skip anonymous rich-list.
    print("STEP 2: Identity sources — Farcaster channels + Lens Protocol")

    fc_cands = farcaster_identity_candidates()
    added_fc = 0
    for c in fc_cands:
        if c["addr"].lower() not in seen_addrs:
            all_cands.append(c)
            seen_addrs.add(c["addr"].lower())
            added_fc += 1
    print(f"  +{added_fc} Farcaster wallets")

    lens_cands = lens_identity_candidates()
    added_lens = 0
    for c in lens_cands:
        if c["addr"].lower() not in seen_addrs:
            all_cands.append(c)
            seen_addrs.add(c["addr"].lower())
            added_lens += 1
    print(f"  +{added_lens} Lens wallets")

    # Identity-only filter: skip wallets with NO identity markers
    # (no ENS texts, no _farcaster, no _lens, no _bio_handle)
    identity_cands = [
        c for c in all_cands
        if c.get("texts") or c.get("ens") or
           c.get("_farcaster") or c.get("_lens") or c.get("_bio_handle")
    ]
    print(f"\n  Total identity-rich candidates: {len(identity_cands)}")
    print(f"  (Skipping {len(all_cands) - len(identity_cands)} anonymous wallets)")
    print()

    # ── STEP 3a: Batch ETH pre-filter (identity-rich pool only) ──────────────
    print("STEP 3a: Batch balance pre-filter on identity-rich pool …")
    t0   = time.time()
    rich = _batch_balance_filter(identity_cands, batch_size=20, prefilter_usd=5_000)

    elapsed = time.time() - t0
    print(f"\n  Phase 1 done in {elapsed:.0f}s — "
          f"{len(rich)}/{len(identity_cands)} candidates pass $50k ETH pre-filter")
    print()

    # ── STEP 3b: OSINT on qualified wallets (parallel workers) ───────────────
    mode_label = "FAST (identity-first)" if FAST_MODE else "FULL OSINT"
    print(f"STEP 3b: {mode_label} — {N_WORKERS} parallel workers …")
    results  = []
    no_cntct = 0
    no_bal   = 0
    lock     = __import__("threading").Lock()
    rich_sorted = sorted(rich, key=lambda x: x["total_usd"], reverse=True)

    _CEX_KEYWORDS = ("exchange", "binance", "coinbase", "kraken", "okx",
                     "bybit", "gate.", "kucoin", "huobi", "mexc", "bitget",
                     "bridge", "portal", "router", "vault", "protocol",
                     "pool", "fund", "foundation", "contract", "deployer",
                     "mev bot", "flashbot")

    def _process_one(w: dict) -> dict | None:
        addr       = w["addr"]
        ens        = w.get("ens", "") or ""
        total_usd  = w["total_usd"]
        eth        = w["eth"]
        entity_lbl = w.get("entity_lbl", "")

        try:
            # CEX/contract filter
            es_label = fetch_etherscan_label(addr)
            if es_label and any(k in es_label.lower() for k in _CEX_KEYWORDS):
                return None
            if es_label and not entity_lbl:
                entity_lbl = es_label
            try:
                labels, lbl2 = fetch_wallet_labels(addr)
                if any(l in labels for l in ("cex", "contract")):
                    return None
                entity_lbl = entity_lbl or lbl2
            except Exception:
                pass

            # Full multi-chain balance — Moralis 12-chain + Ankr
            total_usd, eth, port = check_balance(addr)
            max_usd = ARGS.max_usd
            if total_usd < MIN_USD:
                return None
            if max_usd > 0 and total_usd > max_usd:
                return None

            # ENS name
            if not ens:
                ens = fetch_ens_name(addr) or ""

            # OSINT — fast or full
            if FAST_MODE:
                w["ens"] = ens
                contact = get_contact_fast(w)
                has_contact = contact.pop("_has_contact", False)
            else:
                contact = get_all_contact(addr, ens)
                # Patch pre-populated identity
                if w.get("_farcaster") and not contact["farcaster"]:
                    contact["farcaster"] = w["_farcaster"]
                if w.get("_fc_twitter") and not contact["twitter"]:
                    contact["twitter"] = w["_fc_twitter"]
                if w.get("_lens") and not contact["lens"]:
                    contact["lens"] = w["_lens"]
                if w.get("_bio_email") and not contact["email"]:
                    contact["email"] = w["_bio_email"]
                if w.get("_bio_telegram") and not contact["telegram"]:
                    contact["telegram"] = w["_bio_telegram"]
                if w.get("_bio_github") and not contact["github"]:
                    contact["github"] = w["_bio_github"]
                has_contact = any([
                    contact["email"], contact["telegram"], contact["twitter"],
                    contact["farcaster"], contact["phone"], contact["github"],
                    contact["instagram"], contact["reddit"],
                    len(contact.get("web_mentions", [])) >= 3,
                ])

            if entity_lbl and not contact.get("entity"):
                contact["entity"] = entity_lbl

            if not has_contact:
                return None

            # Full token portfolio (sorted by value)
            top_tokens_full = sorted(
                port, key=lambda x: float(x.get("tokenValue") or 0), reverse=True
            )[:30]
            portfolio = [
                {
                    "symbol":   t.get("tokenSymbol","?"),
                    "name":     t.get("tokenName",""),
                    "balance":  float(t.get("balance") or 0),
                    "usd":      float(t.get("tokenValue") or 0),
                    "contract": t.get("tokenAddress",""),
                }
                for t in top_tokens_full
            ]

            # Wallet age
            try:
                first = fetch_first_tx_date(addr)
                if first:
                    if first.tzinfo is None:
                        from datetime import timezone as tz
                        first = first.replace(tzinfo=tz.utc)
                    age_mo = (NOW - first).days / 30
                else:
                    age_mo = 0
            except Exception:
                age_mo = 0

            # Weekly activity
            try:
                txs    = fetch_recent_txs(addr, days=90)
                weekly = len(txs) / (90 / 7)
            except Exception:
                weekly = 0.0

            # Demographic score
            top5 = top_tokens_full[:5]
            rec  = WhaleRecord(
                wallet_address=addr, usd_balance=total_usd,
                top_tokens=", ".join(t.get("tokenSymbol","?") for t in top5),
                weekly_tx_count=weekly, wallet_age_months=age_mo,
                defi_usd_value=0, nft_count=0,
                farcaster_user=contact["farcaster"],
                lens_handle=contact["lens"],
                ens_name=ens, governance_votes=0,
            )
            score_behavior(rec)
            score_older_demographic(rec)

            if OLDER_MODE and rec.older_demographic_score < 5:
                return None

            return {
                "addr":        addr,
                "ens":         ens,
                "total_usd":   total_usd,
                "eth":         eth,
                "age_mo":      age_mo,
                "weekly":      weekly,
                "older_score": rec.older_demographic_score,
                "top_tokens":  rec.top_tokens,
                "portfolio":   portfolio,
                "contact":     contact,
                "etherscan":   f"https://etherscan.io/address/{addr}",
            }
        except Exception:
            return None

    done_count = [0]

    def _worker(w):
        res = _process_one(w)
        with lock:
            done_count[0] += 1
            total_done = done_count[0]
            found = len(results)
            sys.stdout.write(
                f"\r  [{total_done}/{len(rich_sorted)}] "
                f"Found:{found}  NoContact:{no_cntct}  NoBal:{no_bal}   "
            )
            sys.stdout.flush()
        return res

    with ThreadPoolExecutor(max_workers=N_WORKERS) as ex:
        futs = []
        for w in rich_sorted:
            if len(results) >= TARGET:
                break
            futs.append(ex.submit(_worker, w))

        for fut in as_completed(futs):
            if len(results) >= TARGET:
                break
            res = fut.result()
            if res is None:
                with lock:
                    no_cntct += 1
                continue
            with lock:
                results.append(res)

            # Incremental save every 5 whales
            if len(results) % 5 == 0:
                out_file = ARGS.out if ARGS.out else os.path.join(WHALE_DIR, "whale_results.json")
                with open(out_file, "w", encoding="utf-8") as f:
                    json.dump(results, f, indent=2, default=str)
                sys.stdout.write(f"\r  [SAVED {len(results)} to {out_file}]      \n")
                sys.stdout.flush()

    print(f"\n  Done. Pre-filtered: {len(rich)}, no-balance: {no_bal}, with contact: {len(results)}.\n")

    # ── STEP 4: Print results ──────────────────────────────────────────────
    print("=" * 60)
    print(f"  RESULTS — {len(results)} WHALES WITH CONTACT INFO")
    print("=" * 60)

    for i, w in enumerate(results, 1):
        print_whale(i, w)

    # Save JSON
    out_file = ARGS.out if ARGS.out else os.path.join(WHALE_DIR, "whale_results.json")
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\n\n  Results saved → {out_file}")

    # Summary
    print("\n  ── CONTACT SUMMARY ──")
    has_email = sum(1 for w in results if w["contact"]["email"])
    has_tg    = sum(1 for w in results if w["contact"]["telegram"])
    has_tw    = sum(1 for w in results if w["contact"]["twitter"])
    has_li    = sum(1 for w in results if w["contact"]["linkedin"])
    has_phone = sum(1 for w in results if w["contact"]["phone"])
    print(f"  Email     : {has_email}/{len(results)}")
    print(f"  Telegram  : {has_tg}/{len(results)}")
    print(f"  Twitter   : {has_tw}/{len(results)}")
    print(f"  LinkedIn  : {has_li}/{len(results)}")
    print(f"  Phone     : {has_phone}/{len(results)}")
    print()

    if len(results) < TARGET:
        print(f"  NOTE: Only {len(results)}/{TARGET} found.")
        print("  Add API keys to .env for more coverage:")
        print("  DEBANK_KEY / UD_KEY / GITHUB_TOKEN / INTELX_KEY / APIFY_KEY / ARKHAM_KEY")


if __name__ == "__main__":
    main()
