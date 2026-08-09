#!/usr/bin/env python3
"""
wallet_osint.py — Unified Wallet-to-Identity OSINT Tool  v2.0
==============================================================
Takes ONE wallet address → outputs complete identity profile JSON

Phases:
  1. On-Chain Identity  (ENS, Lens, Farcaster, Txs, Tokens, NFTs)
  2. Email Discovery    (ENS, Gitcoin, POAP, bios, Web3.bio, IDriss, Gravatar)
  3. Local Breach DB    (SQLite: us_leak.db, ledger_leak.db, coinbase_leak.db)
                        + DeHashed API + HIBP + LeakCheck
  4. OSINT Enrichment   (Twitter, GitHub, IntelX, PDL, next.id, Holehe,
                         Bluepages, Sherlock, Maigret, username enum)

Sources (250+ techniques integrated):
  Web3 Identity : ENS, Lens, Farcaster, Web3.bio, IDriss, next.id, Unstoppable
  Social OSINT  : Twitter API, GitHub, Reddit, Discord (via web)
  Breach DBs    : DeHashed, HIBP, LeakCheck, IntelX, local SQLite
  Enrichment    : PDL, Arkham, Gravatar, Gitcoin Passport, POAP
  Username scan : Sherlock (400+), Maigret (2000+), Holehe (120+)

Usage:
  python wallet_osint.py 0x742d35Cc6634C0532925a3b844Bc454e4438f44e
  python wallet_osint.py 0x... --out profile.json
  python wallet_osint.py 0x... --deep        # Sherlock + Maigret + Holehe
  python wallet_osint.py 0x... --min-balance 500000
  python wallet_osint.py 0x... --no-breach   # skip local SQLite DB
"""
import sys, os, json, time, re, argparse, sqlite3, hashlib, textwrap
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ── Path setup ────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
os.chdir(SCRIPT_DIR)

from dotenv import load_dotenv
load_dotenv(os.path.join(SCRIPT_DIR, ".env"))

import requests

# ── Import 200+ new OSINT source functions ───────────────────────────────────
from osint_sources import (
    # Multi-chain explorers
    blockchair_lookup, bscscan_balance, polygonscan_balance, arbiscan_balance,
    optimism_balance, avaxscan_balance, ftmscan_balance, solscan_lookup,
    mempool_btc_lookup, tronscan_lookup, near_lookup, multichain_balances,
    # Web3 identity
    bluepages_lookup, spaceid_lookup, xmtp_check, idriss_reverse, web3bio_lookup,
    nextid_lookup as nextid_all,
    # Social OSINT
    reddit_search, bitcointalk_search, pastebin_search,
    twitter_search_wallet, github_code_search, discord_search_via_web,
    # Email enrichment
    hunter_email_finder, gravatar_lookup as gravatar_all,
    pgp_key_lookup, holehe_email_check, ghunt_lookup, socialpwned_check,
    # Crypto intelligence
    bitquery_wallet, dune_analytics_search, nansen_labels,
    zapper_portfolio, debank_profile as debank_pro, metasleuth_search, bloxy_profile,
    # Advanced OSINT
    crtsh_domains, whois_lookup as whois_all, subdomain_finder, dns_history,
    ip_geolocation, smart_contract_source,
    # Breach APIs
    hibp_check, hibp_pastes, dehashed_search, intelx_search, intelx_phonebook,
    leakcheck_search,
    # Wallet-specific
    poap_lookup, gitcoin_grants, gitcoin_passport_stamps, snapshot_governance,
    mirror_profile as mirror_all,
)

# ── Import all whale_extractor functions ─────────────────────────────────────
from whale_extractor import (
    # Balance
    fetch_eth_balance, fetch_token_portfolio,
    fetch_networth_moralis, fetch_ankr_extra_balance,
    _alchemy_batch_rpc, _ALCHEMY_KEYS,
    # ENS
    fetch_ens_name, fetch_ens_records,
    # Social / Web3
    fetch_web3_social, fetch_arkham_identity,
    fetch_etherscan_label, fetch_wallet_labels,
    # Profiles
    fetch_debank_public, fetch_debank_profile,
    fetch_debank_social, fetch_unstoppable_free,
    fetch_lens_profile, fetch_snapshot_profile,
    fetch_mirror_profile, fetch_opensea_profile,
    # Transactions
    fetch_first_tx_date, fetch_recent_txs,
    # OSINT
    fetch_web_osint, fetch_github_mentions,
    fetch_whois_contact, check_username_platforms,
    fetch_leakcheck, fetch_leakcheck_by_username,
    fetch_leakcheck_by_phone, fetch_leakcheck_ratelimited,
    fetch_intelx, fetch_intelx_phonebook,
    fetch_pdl_person, fetch_apify_wallet_twitter,
    run_sherlock, run_maigret,
    # Email
    generate_email_permutations, find_real_emails,
    # Multi-chain
    fetch_solana_balance, fetch_tron_balance,
    fetch_btc_balance, fetch_ton_balance,
    # Phone
    fetch_ens_phone, fetch_phone_from_all,
)

# ── Keys ──────────────────────────────────────────────────────────────────────
ALCHEMY_KEY     = os.getenv("ALCHEMY_KEY", "")
ETHERSCAN_KEY   = os.getenv("ETHERSCAN_KEY", "")
MORALIS_KEY     = os.getenv("MORALIS_KEY", "")
NEYNAR_KEY      = os.getenv("NEYNAR_KEY", "")
SERPER_KEY      = os.getenv("SERPER_KEY", "")
INTELX_KEY      = os.getenv("INTELX_KEY", "")
INTELX_HOST     = os.getenv("INTELX_HOST", "https://free.intelx.io")
TWITTER_BEARER  = os.getenv("TWITTER_BEARER", "")
GITHUB_TOKEN    = os.getenv("GITHUB_TOKEN", "")
LEAKCHECK_KEY   = os.getenv("LEAKCHECK_KEY", "")
PDL_KEY         = os.getenv("PDL_API_KEY", "")
ANKR_KEY        = os.getenv("ANKR_KEY", "")
HELIUS_KEY      = os.getenv("HELIUS_KEY", "")
DEHASHED_EMAIL  = os.getenv("DEHASHED_EMAIL", "")
DEHASHED_KEY    = os.getenv("DEHASHED_KEY", "")
HIBP_KEY        = os.getenv("HIBP_KEY", "")
AIRSTACK_KEY    = os.getenv("AIRSTACK_API_KEY", "")

ETH_PRICE = 1934.0
try:
    r = requests.get(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
        timeout=6)
    ETH_PRICE = float(r.json()["ethereum"]["usd"])
except Exception:
    pass

EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
PHONE_RE = re.compile(r'\+?[\d\s\-\(\)]{7,20}')

# ── CLI args ──────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="Wallet OSINT — Unified Identity Extractor")
parser.add_argument("address",       help="Wallet address (0x...)")
parser.add_argument("--out",         default="",      help="Output JSON file (default: <address>.json)")
parser.add_argument("--deep",        action="store_true", help="Run Sherlock + Maigret (slow, 2000+ platforms)")
parser.add_argument("--min-balance", type=float, default=0, help="Minimum USD balance to continue (default: 0)")
parser.add_argument("--no-breach",   action="store_true", help="Skip local breach DB lookup")
parser.add_argument("--quiet",       action="store_true", help="No console output, just JSON file")
ARGS = parser.parse_args()

ADDR      = ARGS.address.strip()
OUT_FILE  = ARGS.out or f"{ADDR[:10]}_osint.json"
DEEP_MODE = ARGS.deep


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def log(msg: str):
    if not ARGS.quiet:
        print(msg)

def section(title: str):
    if not ARGS.quiet:
        print(f"\n{'─'*60}")
        print(f"  {title}")
        print(f"{'─'*60}")

def save(profile: dict):
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2, default=str)

# ─────────────────────────────────────────────────────────────────────────────
# NEW SOURCE FUNCTIONS (v2.0 additions from 250-technique list)
# ─────────────────────────────────────────────────────────────────────────────

def fetch_web3bio(addr: str) -> dict:
    """Web3.bio — aggregates ENS, Lens, Farcaster, Basenames, SNS in one call."""
    try:
        r = requests.get(f"https://api.web3.bio/profile/{addr}",
                         timeout=8, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code == 200:
            profiles = r.json() if isinstance(r.json(), list) else [r.json()]
            result = {}
            for p in (profiles or []):
                platform = p.get("platform", "")
                result[platform] = {
                    "handle":      p.get("handle") or p.get("identity", ""),
                    "display":     p.get("displayName", ""),
                    "bio":         p.get("description", ""),
                    "avatar":      p.get("avatar", ""),
                    "email":       (p.get("links") or {}).get("email", {}).get("handle", ""),
                    "twitter":     (p.get("links") or {}).get("twitter", {}).get("handle", ""),
                    "telegram":    (p.get("links") or {}).get("telegram", {}).get("handle", ""),
                    "github":      (p.get("links") or {}).get("github", {}).get("handle", ""),
                    "discord":     (p.get("links") or {}).get("discord", {}).get("handle", ""),
                    "instagram":   (p.get("links") or {}).get("instagram", {}).get("handle", ""),
                    "youtube":     (p.get("links") or {}).get("youtube", {}).get("handle", ""),
                    "location":    p.get("location", ""),
                    "website":     p.get("website", ""),
                }
            return result
    except Exception:
        pass
    return {}


def fetch_idriss(email_or_phone_or_twitter: str) -> dict:
    """IDriss — email/phone/Twitter handle → wallet address (reverse also works)."""
    if not email_or_phone_or_twitter:
        return {}
    try:
        r = requests.get(
            "https://www.idriss.xyz/api/lookup",
            params={"query": email_or_phone_or_twitter},
            timeout=8)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {}


def fetch_nextid(addr: str) -> dict:
    """next.id — Relation Server: identity links across platforms."""
    try:
        r = requests.get(
            f"https://relation-service.next.id/v1/identity/{addr.lower()}",
            timeout=8)
        if r.status_code == 200:
            data = r.json()
            edges = data.get("edges") or []
            identities = []
            for e in edges:
                src = e.get("source") or {}
                dst = e.get("target") or {}
                for node in [src, dst]:
                    if node.get("platform") and node.get("identity"):
                        identities.append({
                            "platform": node["platform"],
                            "handle":   node["identity"],
                            "display":  node.get("displayName", ""),
                        })
            # Deduplicate
            seen = set()
            unique = []
            for item in identities:
                key = f"{item['platform']}:{item['handle']}"
                if key not in seen:
                    seen.add(key)
                    unique.append(item)
            return {"identities": unique, "count": len(unique)}
    except Exception:
        pass
    return {}


def fetch_gitcoin_passport(addr: str) -> dict:
    """Gitcoin Passport — stamps/verifications for this wallet."""
    try:
        r = requests.get(
            f"https://api.scorer.gitcoin.co/registry/stamps/{addr}",
            timeout=8, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code == 200:
            data = r.json()
            stamps = data.get("items") or []
            return {
                "stamp_count": len(stamps),
                "stamps": [
                    {
                        "provider":    s.get("stamp", {}).get("provider", ""),
                        "credential":  s.get("stamp", {}).get("credential", {}).get("type", []),
                        "issued":      s.get("stamp", {}).get("credential", {}).get("issuanceDate", ""),
                    }
                    for s in stamps[:20]
                ],
                # If any stamp contains email
                "email_stamps": [s for s in stamps if "email" in str(s).lower()],
            }
    except Exception:
        pass
    return {}


def fetch_gravatar(email: str) -> dict:
    """Gravatar — email hash → profile (name, bio, accounts)."""
    if not email:
        return {}
    try:
        import hashlib
        email_hash = hashlib.md5(email.lower().strip().encode()).hexdigest()
        r = requests.get(
            f"https://www.gravatar.com/{email_hash}.json",
            timeout=8)
        if r.status_code == 200:
            entry = r.json().get("entry", [{}])[0]
            accounts = []
            for acc in (entry.get("accounts") or []):
                accounts.append({
                    "name": acc.get("name", ""),
                    "url":  acc.get("url", ""),
                    "display": acc.get("display", ""),
                })
            return {
                "display_name": entry.get("displayName", ""),
                "real_name":    " ".join([
                    (entry.get("name") or {}).get("givenName", ""),
                    (entry.get("name") or {}).get("familyName", ""),
                ]).strip(),
                "about_me":     entry.get("aboutMe", ""),
                "location":     entry.get("currentLocation", ""),
                "website":      entry.get("urls", [{}])[0].get("value", "") if entry.get("urls") else "",
                "accounts":     accounts,
                "profile_url":  entry.get("profileUrl", ""),
            }
    except Exception:
        pass
    return {}


def fetch_dehashed(query: str, query_type: str = "email") -> list:
    """DeHashed API — breach search by email/username/phone/name/address."""
    if not DEHASHED_EMAIL or not DEHASHED_KEY:
        return []
    try:
        r = requests.get(
            "https://api.dehashed.com/search",
            params={"query": f"{query_type}:{query}", "size": 20},
            auth=(DEHASHED_EMAIL, DEHASHED_KEY),
            headers={"Accept": "application/json"},
            timeout=12)
        if r.status_code == 200:
            entries = r.json().get("entries") or []
            return [
                {
                    "email":    e.get("email", ""),
                    "username": e.get("username", ""),
                    "name":     e.get("name", ""),
                    "phone":    e.get("phone", ""),
                    "address":  e.get("address", ""),
                    "database": e.get("database_name", ""),
                    "hashed_pw": bool(e.get("hashed_password")),
                }
                for e in entries
            ]
    except Exception:
        pass
    return []


def fetch_hibp(email: str) -> list:
    """HaveIBeenPwned — breach list for email (free if no key, key needed for paste search)."""
    if not email:
        return []
    try:
        hdrs = {"hibp-api-key": HIBP_KEY} if HIBP_KEY else {}
        hdrs["user-agent"] = "wallet-osint-tool"
        r = requests.get(
            f"https://haveibeenpwned.com/api/v3/breachedaccount/{email}",
            headers=hdrs, timeout=10)
        if r.status_code == 200:
            breaches = r.json()
            return [
                {
                    "name":         b.get("Name", ""),
                    "domain":       b.get("Domain", ""),
                    "breach_date":  b.get("BreachDate", ""),
                    "pwn_count":    b.get("PwnCount", 0),
                    "data_classes": b.get("DataClasses", []),
                }
                for b in breaches
            ]
        elif r.status_code == 404:
            return []  # not found in any breach
    except Exception:
        pass
    return []


def fetch_holehe_check(email: str) -> dict:
    """
    Holehe — check which sites email is registered on (120+ platforms).
    Requires holehe installed: pip install holehe
    Falls back to subprocess call.
    """
    if not email:
        return {}
    try:
        import subprocess
        result = subprocess.run(
            ["holehe", email, "--only-used", "--no-color"],
            capture_output=True, text=True, timeout=60
        )
        output = result.stdout
        found = []
        for line in output.splitlines():
            if "[+]" in line:
                site = line.replace("[+]", "").strip()
                found.append(site)
        return {"email": email, "registered_on": found, "count": len(found)}
    except Exception:
        return {}


def fetch_airstack_identity(addr: str) -> dict:
    """Airstack — ENS, Lens, Farcaster, POAP, NFTs in single GraphQL call."""
    if not AIRSTACK_KEY:
        return {}
    query = """
    query Identity($addr: Identity!) {
      Wallet(input: {identity: $addr, blockchain: ethereum}) {
        addresses
        primaryDomain { name resolvedAddress }
        domains(input: {limit: 5}) { edges { node { name isPrimary } } }
        socials { dappName profileName profileDisplayName bio followerCount followingCount }
        poaps(input: {limit: 10}) { edges { node { eventId event { eventName city country startDate } } } }
        xmtp { isXMTPEnabled }
      }
    }"""
    try:
        r = requests.post(
            "https://api.airstack.xyz/gql",
            json={"query": query, "variables": {"addr": addr}},
            headers={"Authorization": AIRSTACK_KEY, "Content-Type": "application/json"},
            timeout=12)
        data = r.json().get("data", {}).get("Wallet", {})
        socials = data.get("socials") or []
        parsed_socials = {}
        for s in socials:
            platform = s.get("dappName", "")
            parsed_socials[platform] = {
                "handle":   s.get("profileName", ""),
                "display":  s.get("profileDisplayName", ""),
                "bio":      s.get("bio", ""),
                "followers": s.get("followerCount", 0),
            }
        poaps = []
        for e in (data.get("poaps") or {}).get("edges", []):
            node = e.get("node", {})
            ev = node.get("event", {})
            poaps.append({
                "event_id":   node.get("eventId", ""),
                "event_name": ev.get("eventName", ""),
                "city":       ev.get("city", ""),
                "country":    ev.get("country", ""),
                "date":       ev.get("startDate", ""),
            })
        domains = []
        for e in (data.get("domains") or {}).get("edges", []):
            domains.append(e.get("node", {}).get("name", ""))
        return {
            "addresses":  data.get("addresses", []),
            "primary_ens": (data.get("primaryDomain") or {}).get("name", ""),
            "domains":    domains,
            "socials":    parsed_socials,
            "poaps":      poaps,
            "xmtp":       bool((data.get("xmtp") or {}).get("isXMTPEnabled")),
        }
    except Exception:
        return {}


def serper_dork_search(wallet: str, ens: str = "", name: str = "") -> list:
    """
    Google dork searches: wallet address, ENS name, and personal name
    Returns list of web results with snippet + URL.
    """
    if not SERPER_KEY:
        return []
    queries = [f'"{wallet}"']
    if ens:      queries.append(f'"{ens}" email OR phone OR contact')
    if name:     queries.append(f'"{name}" crypto wallet email')
    queries.append(f'"{wallet}" site:twitter.com OR site:reddit.com OR site:github.com')

    results = []
    for q in queries[:4]:
        try:
            r = requests.post("https://google.serper.dev/search",
                json={"q": q, "num": 5},
                headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
                timeout=10)
            for res in r.json().get("organic", []):
                results.append({
                    "query":   q,
                    "title":   res.get("title", ""),
                    "url":     res.get("link", ""),
                    "snippet": res.get("snippet", ""),
                })
            time.sleep(0.4)
        except Exception:
            pass
    return results


# ─────────────────────────────────────────────────────────────────────────────
# END NEW SOURCE FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

def _extract_emails_from_text(text: str) -> list:
    found = EMAIL_RE.findall(text or "")
    return [e for e in found if "noreply" not in e and "example" not in e]

def _clean_handle(raw: str) -> str:
    if not raw:
        return ""
    raw = raw.strip().lstrip("@")
    raw = re.sub(r'https?://[^\s]+/([\w]+).*', r'\1', raw)
    return raw.split("/")[-1].split("?")[0].strip()


# ─────────────────────────────────────────────────────────────────────────────
# PHASE 1: ON-CHAIN IDENTITY
# ─────────────────────────────────────────────────────────────────────────────

def phase1_onchain(addr: str) -> dict:
    section("PHASE 1: ON-CHAIN IDENTITY")
    result = {
        "ens_name": "", "ens_records": {},
        "lens": {}, "farcaster": {}, "unstoppable": {},
        "eth_balance": 0.0, "usd_balance": 0.0,
        "tokens": [], "nfts": [],
        "transactions": [], "first_tx": "", "wallet_age_months": 0,
        "multichain": {}, "entity": "", "labels": [],
    }

    # ENS reverse lookup
    log("  [ENS] Reverse lookup...")
    ens = fetch_ens_name(addr)
    result["ens_name"] = ens or ""
    if ens:
        log(f"  ENS: {ens}")
        recs = fetch_ens_records(ens) or {}
        result["ens_records"] = recs
        log(f"  ENS records: {list(recs.keys())}")

    # Entity labels (Arkham + Etherscan)
    log("  [Labels] Fetching entity labels...")
    try:
        arkham = fetch_arkham_identity(addr)
        result["entity"] = arkham.get("entity_name", "")
        if arkham.get("twitter_handle"):
            result["arkham_twitter"] = arkham["twitter_handle"]
    except Exception:
        pass
    try:
        es_label = fetch_etherscan_label(addr)
        if es_label:
            result["etherscan_label"] = es_label
    except Exception:
        pass
    try:
        labels, _ = fetch_wallet_labels(addr)
        result["labels"] = list(labels)
    except Exception:
        pass

    # ETH Balance
    log("  [Balance] ETH + tokens...")
    try:
        eth = fetch_eth_balance(addr)
        result["eth_balance"] = eth
        result["usd_balance"] = eth * ETH_PRICE
        log(f"  ETH: {eth:.4f} (${eth*ETH_PRICE:,.0f})")
    except Exception:
        pass

    # Moralis net worth (multi-chain)
    try:
        moralis_usd, _ = fetch_networth_moralis(addr)
        if moralis_usd > result["usd_balance"]:
            result["usd_balance"] = moralis_usd
        result["moralis_networth"] = moralis_usd
    except Exception:
        pass

    # Token portfolio (top 20)
    log("  [Tokens] Top 20 holdings...")
    try:
        port = fetch_token_portfolio(addr)
        top20 = sorted(port, key=lambda x: float(x.get("tokenValue") or 0), reverse=True)[:20]
        result["tokens"] = [
            {
                "symbol":  t.get("tokenSymbol", "?"),
                "name":    t.get("tokenName", ""),
                "balance": float(t.get("balance") or 0),
                "usd":     float(t.get("tokenValue") or 0),
                "contract": t.get("tokenAddress", ""),
            }
            for t in top20
        ]
        log(f"  Tokens: {', '.join(t['symbol'] for t in result['tokens'][:5])}")
    except Exception:
        pass

    # NFTs
    log("  [NFTs] Fetching NFT holdings...")
    result["nfts"] = _fetch_nfts(addr)
    if result["nfts"]:
        log(f"  NFTs: {len(result['nfts'])} items")

    # Transaction history (last 100)
    log("  [Txs] Last 100 transactions...")
    try:
        txs = fetch_recent_txs(addr)
        result["transactions"] = txs[:100] if txs else []
        result["tx_count"] = len(result["transactions"])
    except Exception:
        pass
    try:
        first_tx, age_months = fetch_first_tx_date(addr)
        result["first_tx"] = first_tx
        result["wallet_age_months"] = age_months
        log(f"  First tx: {first_tx}  Age: {age_months:.0f} months")
    except Exception:
        pass

    # Lens profile
    log("  [Lens] Profile lookup...")
    try:
        lens = fetch_lens_profile(addr)
        if lens:
            result["lens"] = lens
            log(f"  Lens: {lens.get('handle', '')}")
    except Exception:
        pass

    # Farcaster (Neynar)
    log("  [Farcaster] Profile lookup...")
    result["farcaster"] = _fetch_farcaster(addr)
    if result["farcaster"]:
        log(f"  Farcaster: @{result['farcaster'].get('username','')}")

    # Unstoppable Domains
    try:
        ud = fetch_unstoppable_free(addr)
        if ud:
            result["unstoppable"] = ud
    except Exception:
        pass

    # DeBank social
    try:
        db = fetch_debank_public(addr)
        if db:
            result["debank"] = db
    except Exception:
        pass

    # Web3.bio — aggregates ENS, Lens, Farcaster, Basenames in one call
    log("  [Web3.bio] Aggregated identity lookup...")
    result["web3bio"] = fetch_web3bio(addr)
    if result["web3bio"]:
        platforms = list(result["web3bio"].keys())
        log(f"  Web3.bio: found on {platforms}")

    # next.id — cross-platform identity graph
    log("  [next.id] Identity graph lookup...")
    result["nextid"] = fetch_nextid(addr)
    if result["nextid"].get("count"):
        log(f"  next.id: {result['nextid']['count']} linked identities")

    # Airstack — ENS + Lens + Farcaster + POAP in one GraphQL call
    if AIRSTACK_KEY:
        log("  [Airstack] Multi-protocol lookup...")
        result["airstack"] = fetch_airstack_identity(addr)
        if result["airstack"].get("socials"):
            log(f"  Airstack socials: {list(result['airstack']['socials'].keys())}")

    # Gitcoin Passport stamps
    log("  [Gitcoin Passport] Stamps lookup...")
    result["gitcoin_passport"] = fetch_gitcoin_passport(addr)

    # OpenSea profile
    try:
        os_prof = fetch_opensea_profile(addr)
        if os_prof:
            result["opensea"] = os_prof
    except Exception:
        pass

    # Mirror.xyz
    try:
        mir = fetch_mirror_profile(addr)
        if mir:
            result["mirror"] = mir
    except Exception:
        pass

    # Snapshot governance
    try:
        snap = fetch_snapshot_profile(addr)
        if snap:
            result["snapshot"] = snap
    except Exception:
        pass

    # Multi-chain extras (native whale_extractor chains)
    log("  [Multi-chain] Extra chains...")
    mc = {}
    try: mc["solana_sol"] = fetch_solana_balance(addr)
    except Exception: pass
    try: mc["tron_trx"]   = fetch_tron_balance(addr)
    except Exception: pass
    try: mc["ton_ton"]    = fetch_ton_balance(addr)
    except Exception: pass

    # NEW: EVM sidechains via osint_sources
    log("  [Multi-chain] BSC, Polygon, Arbitrum, Optimism, Avax, Fantom...")
    evm_extras = multichain_balances(addr)
    mc.update(evm_extras)
    bc = blockchair_lookup(addr)
    if bc:
        mc["blockchair_eth"] = bc

    if mc:
        result["multichain"] = mc

    # NEW: Bluepages — 6M+ addresses linked to social accounts
    log("  [Bluepages] Identity lookup...")
    result["bluepages"] = bluepages_lookup(addr)
    if result["bluepages"]:
        log(f"  Bluepages: {list(result['bluepages'].keys())}")

    # NEW: Space ID — .bnb and .arb domains
    log("  [Space ID] BNB/ARB domain lookup...")
    result["spaceid"] = spaceid_lookup(addr)

    # NEW: XMTP — messaging enabled?
    log("  [XMTP] Messaging check...")
    result["xmtp"] = xmtp_check(addr)

    # NEW: IDriss reverse — wallet → email/phone/twitter
    log("  [IDriss] Reverse lookup...")
    result["idriss_reverse"] = idriss_reverse(addr)

    # NEW: Zapper — DeFi portfolio
    log("  [Zapper] DeFi portfolio...")
    zap = zapper_portfolio(addr)
    if zap.get("total_usd"):
        result["zapper_usd"] = zap["total_usd"]
        mc["zapper_defi"] = zap

    # NEW: Nansen — smart money labels
    result["nansen"] = nansen_labels(addr)

    # NEW: Snapshot governance (more reliable version)
    log("  [Snapshot] Governance votes...")
    try:
        snap_gov = snapshot_governance(addr)
        if snap_gov.get("vote_count"):
            result["snapshot_gov"] = snap_gov
            log(f"  Snapshot: {snap_gov['vote_count']} votes in {len(snap_gov.get('spaces',[]))} spaces")
    except Exception:
        pass

    # NEW: Mirror.xyz posts
    try:
        mir = mirror_all(addr)
        if mir:
            result["mirror_posts"] = mir
    except Exception:
        pass

    log(f"\n  Phase 1 done. Balance: ${result['usd_balance']:,.0f}")
    return result


def _fetch_nfts(addr: str) -> list:
    """Fetch NFT holdings via Alchemy NFT API."""
    nfts = []
    if not _ALCHEMY_KEYS:
        return nfts
    key = _ALCHEMY_KEYS[0]
    try:
        url = f"https://eth-mainnet.g.alchemy.com/nft/v3/{key}/getNFTsForOwner"
        r = requests.get(url, params={"owner": addr, "withMetadata": "true", "pageSize": 50},
                        timeout=12)
        data = r.json()
        for item in (data.get("ownedNfts") or [])[:50]:
            meta  = item.get("contract", {})
            image = (item.get("image") or {}).get("cachedUrl", "")
            nfts.append({
                "name":       item.get("name") or meta.get("name", ""),
                "collection": meta.get("name", ""),
                "contract":   meta.get("address", ""),
                "token_id":   item.get("tokenId", ""),
                "floor_usd":  float((meta.get("openSeaMetadata") or {}).get("floorPrice") or 0) * ETH_PRICE,
                "image":      image,
            })
    except Exception:
        pass
    return nfts


def _fetch_farcaster(addr: str) -> dict:
    """Fetch Farcaster user by verified ETH address (Neynar API)."""
    if not NEYNAR_KEY:
        return {}
    try:
        r = requests.get(
            "https://api.neynar.com/v2/farcaster/user/bulk-by-address",
            params={"addresses": addr},
            headers={"api_key": NEYNAR_KEY},
            timeout=10)
        data = r.json()
        users = data.get(addr.lower(), data.get(addr, []))
        if not users:
            # try all values
            for v in data.values():
                if isinstance(v, list) and v:
                    users = v
                    break
        if not users:
            return {}
        u = users[0] if isinstance(users, list) else users
        twitter = ""
        for acct in (u.get("verified_accounts") or []):
            if acct.get("platform") == "twitter":
                twitter = acct.get("username", "")
                break
        return {
            "username":       u.get("username", ""),
            "display_name":   u.get("display_name", ""),
            "bio":            (u.get("profile") or {}).get("bio", {}).get("text", ""),
            "fid":            u.get("fid", 0),
            "follower_count": u.get("follower_count", 0),
            "twitter":        twitter,
            "pfp_url":        (u.get("pfp") or {}).get("url", ""),
        }
    except Exception:
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# PHASE 2: EMAIL DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────

def phase2_email(addr: str, p1: dict) -> dict:
    section("PHASE 2: EMAIL DISCOVERY")
    emails   = []
    sources  = {}

    ens_recs  = p1.get("ens_records", {})
    ens_name  = p1.get("ens_name", "")
    fc        = p1.get("farcaster", {})
    lens      = p1.get("lens", {})

    # 1. ENS text record email
    ens_email = ens_recs.get("email", "")
    if ens_email:
        emails.append(ens_email)
        sources[ens_email] = "ENS text record"
        log(f"  [ENS] email: {ens_email}")

    # 2. Farcaster bio
    fc_bio = fc.get("bio", "")
    for e in _extract_emails_from_text(fc_bio):
        if e not in emails:
            emails.append(e)
            sources[e] = "Farcaster bio"
            log(f"  [Farcaster bio] email: {e}")

    # 3. Lens bio
    lens_bio = (lens.get("bio") or lens.get("description") or "")
    for e in _extract_emails_from_text(lens_bio):
        if e not in emails:
            emails.append(e)
            sources[e] = "Lens bio"
            log(f"  [Lens bio] email: {e}")

    # 4. Twitter bio (via Twitter API)
    twitter_handle = (
        ens_recs.get("com.twitter") or ens_recs.get("twitter") or
        fc.get("twitter") or
        p1.get("arkham_twitter") or
        (p1.get("debank") or {}).get("twitter_handle") or ""
    )
    if twitter_handle and TWITTER_BEARER:
        log(f"  [Twitter] Checking bio of @{twitter_handle}...")
        tw_email = _twitter_bio_email(twitter_handle)
        if tw_email and tw_email not in emails:
            emails.append(tw_email)
            sources[tw_email] = "Twitter bio"
            log(f"  [Twitter bio] email: {tw_email}")

    # 5. Web3.bio emails (from social links)
    web3bio = p1.get("web3bio", {})
    for platform, pdata in web3bio.items():
        bio_email = pdata.get("email", "")
        if bio_email and bio_email not in emails:
            emails.append(bio_email)
            sources[bio_email] = f"Web3.bio ({platform})"
            log(f"  [Web3.bio/{platform}] email: {bio_email}")
        # Also check bios for email
        for bio_text in [pdata.get("bio", "")]:
            for e in _extract_emails_from_text(bio_text):
                if e not in emails:
                    emails.append(e)
                    sources[e] = f"Web3.bio/{platform} bio"

    # 6. next.id linked identities → more handles to search
    nextid_handles = []
    for identity in (p1.get("nextid", {}).get("identities") or []):
        if identity.get("platform") in ("twitter", "github", "instagram", "reddit"):
            nextid_handles.append(identity.get("handle", ""))

    # 7. Gitcoin Grants
    log("  [Gitcoin] Checking donation history...")
    gitcoin_email = _fetch_gitcoin_email(addr)
    if gitcoin_email and gitcoin_email not in emails:
        emails.append(gitcoin_email)
        sources[gitcoin_email] = "Gitcoin Grants profile"
        log(f"  [Gitcoin] email: {gitcoin_email}")

    # 6. POAP
    log("  [POAP] Checking POAP mints...")
    poap_data = _fetch_poap(addr)
    if poap_data:
        log(f"  [POAP] {len(poap_data)} POAPs found")

    # 8. Gravatar check for each found email
    for e in list(emails):
        grav = fetch_gravatar(e)
        if grav.get("real_name") or grav.get("accounts"):
            log(f"  [Gravatar] Found profile for {e}: {grav.get('display_name','')}")
            p1["gravatar"] = p1.get("gravatar", {})
            p1["gravatar"][e] = grav

    # 9. Google dork search (Serper)
    all_handles = list(set([
        fc.get("username", ""),
        _clean_handle(twitter_handle),
        ens_name.replace(".eth", "") if ens_name else "",
        *nextid_handles,
    ]))
    if SERPER_KEY:
        for h in [h for h in all_handles if h and len(h) > 2][:3]:
            log(f"  [Serper] Searching email for '{h}'...")
            found = _serper_email_search(h)
            for e in found:
                if e not in emails:
                    emails.append(e)
                    sources[e] = f"Google search ({h})"
                    log(f"  [Serper] email: {e}")
            time.sleep(0.5)

    # 8. ENS phone
    log("  [ENS phone] Checking phone records...")
    try:
        phone_result = fetch_ens_phone(ens_name) if ens_name else {}
        if phone_result and phone_result.get("phone"):
            log(f"  [ENS phone] {phone_result['phone']}")
    except Exception:
        phone_result = {}

    # NEW: IDriss reverse — direct wallet → email/phone/twitter
    idriss_data = p1.get("idriss_reverse", [])
    for item in idriss_data:
        val = item.get("value", "") or item.get("handle", "") or item.get("email", "")
        if val and "@" in val and val not in emails:
            emails.append(val)
            sources[val] = "IDriss reverse lookup"
            log(f"  [IDriss] email: {val}")
        phone = item.get("phone", "")
        if phone:
            log(f"  [IDriss] phone: {phone}")

    # NEW: Bluepages emails
    bp = p1.get("bluepages", {})
    if bp.get("email") and bp["email"] not in emails:
        emails.append(bp["email"])
        sources[bp["email"]] = "Bluepages"
        log(f"  [Bluepages] email: {bp['email']}")

    # NEW: PGP key lookup for found emails
    pgp_results = {}
    for e in list(emails)[:2]:
        pgp = pgp_key_lookup(e)
        if pgp:
            pgp_results[e] = pgp
            log(f"  [PGP] Found {len(pgp)} key(s) for {e}")
    if pgp_results:
        p1["pgp_keys"] = pgp_results

    # NEW: crt.sh certificate search for emails/domains
    crt_results = {}
    for e in list(emails)[:1]:
        crt = crtsh_domains(e)
        if crt:
            crt_results[e] = crt
            log(f"  [crt.sh] Found {len(crt)} SSL certs for {e}")
    if ens_name and ".eth" in ens_name:
        base_domain = ens_name.replace(".eth", ".xyz")
        crt_domain = crtsh_domains(base_domain)
        if crt_domain:
            crt_results[base_domain] = crt_domain
    if crt_results:
        p1["crt_certs"] = crt_results

    # NEW: Hunter.io email finder (if domain known)
    url_domain = ens_recs.get("url", "")
    if url_domain:
        url_domain = re.sub(r'https?://', '', url_domain).split('/')[0].strip()
        if url_domain:
            log(f"  [Hunter.io] Email finder for {url_domain}...")
            hunter_emails = hunter_email_finder(url_domain)
            for he in hunter_emails[:5]:
                e = he.get("email", "")
                if e and e not in emails:
                    emails.append(e)
                    sources[e] = f"Hunter.io ({url_domain})"
                    log(f"  [Hunter.io] email: {e}")

    # NEW: SocialPwned — email → which social networks it's registered on
    social_pwned_results = {}
    for e in list(emails)[:2]:
        sp = socialpwned_check(e)
        if sp:
            social_pwned_results[e] = sp
            log(f"  [SocialPwned] {e} found on {[s['platform'] for s in sp]}")
    if social_pwned_results:
        p1["social_pwned"] = social_pwned_results

    log(f"\n  Phase 2 done. Emails found: {len(emails)}")
    return {
        "emails":        emails,
        "email_sources": sources,
        "poap":          poap_data,
        "phone_from_ens": (phone_result or {}).get("phone", ""),
        "twitter_handle": twitter_handle,
    }


def _twitter_bio_email(username: str) -> str:
    clean = _clean_handle(username)
    if not clean:
        return ""
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{clean}",
            params={"user.fields": "description,url"},
            headers={"Authorization": f"Bearer {TWITTER_BEARER}"},
            timeout=8)
        data = r.json().get("data", {})
        desc = data.get("description", "") + " " + data.get("url", "")
        m = EMAIL_RE.search(desc)
        return m.group(0) if m else ""
    except Exception:
        return ""


def _fetch_gitcoin_email(addr: str) -> str:
    """Gitcoin Grants — check if wallet has donated and has email in profile."""
    try:
        # Gitcoin v1 profile API
        r = requests.get(
            f"https://api.gitcoin.co/api/v1/api/profile/{addr}",
            timeout=8, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code == 200:
            data = r.json()
            email = data.get("email") or data.get("contact_email") or ""
            if email:
                return email
            # Check bio/description
            bio = data.get("bio", "")
            m = EMAIL_RE.search(bio)
            if m:
                return m.group(0)
    except Exception:
        pass
    # Grants roundup scan — check allo.gitcoin.co
    try:
        r2 = requests.get(
            f"https://grants-stack-indexer.gitcoin.co/api/v1/contributors/{addr}",
            timeout=8)
        if r2.status_code == 200:
            data2 = r2.json()
            email = data2.get("email", "")
            if email:
                return email
    except Exception:
        pass
    return ""


def _fetch_poap(addr: str) -> list:
    """POAP — get list of POAPs owned by this address."""
    try:
        r = requests.get(
            f"https://frontend.poap.fun/actions/scan/{addr}",
            timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code == 200:
            items = r.json()
            return [
                {
                    "event_name": item.get("event", {}).get("name", ""),
                    "event_id":   item.get("event", {}).get("id", ""),
                    "city":       item.get("event", {}).get("city", ""),
                    "year":       item.get("event", {}).get("year", ""),
                    "token_id":   item.get("tokenId", ""),
                }
                for item in (items or [])[:20]
            ]
    except Exception:
        pass
    return []


def _serper_email_search(query: str) -> list:
    try:
        r = requests.post(
            "https://google.serper.dev/search",
            json={"q": f'"{query}" email contact', "num": 5},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10)
        emails = []
        for res in r.json().get("organic", []):
            text = res.get("title", "") + " " + res.get("snippet", "")
            for e in _extract_emails_from_text(text):
                if e not in emails:
                    emails.append(e)
        return emails[:3]
    except Exception:
        return []


# ─────────────────────────────────────────────────────────────────────────────
# PHASE 3: LOCAL BREACH DATABASE
# ─────────────────────────────────────────────────────────────────────────────

def phase3_breach(emails: list, addr: str) -> dict:
    section("PHASE 3: LOCAL BREACH DATABASE")
    result = {
        "us_leak":        [],
        "ledger_leak":    [],
        "coinbase_leak":  [],
        "leakcheck_api":  [],
        "summary": {
            "full_name": "", "phone": "", "dob": "",
            "address": "", "city": "", "state": "", "zip": "",
            "income": "", "credit_limit": "",
        }
    }

    if ARGS.no_breach:
        log("  [Breach] Skipped (--no-breach)")
        return result

    # ── Local SQLite databases ────────────────────────────────────────────────
    DB_FILES = {
        "us_leak":       os.path.join(SCRIPT_DIR, "us_leak.db"),
        "ledger_leak":   os.path.join(SCRIPT_DIR, "ledger_leak.db"),
        "coinbase_leak": os.path.join(SCRIPT_DIR, "coinbase_leak.db"),
    }

    for db_key, db_path in DB_FILES.items():
        if not os.path.exists(db_path):
            log(f"  [{db_key}] Not found at {db_path} — skipping")
            continue

        log(f"  [{db_key}] Searching {len(emails)} email(s)...")
        hits = _sqlite_search(db_path, emails, addr)
        result[db_key] = hits
        if hits:
            log(f"  [{db_key}] {len(hits)} records found!")
            # Merge best data into summary
            for h in hits:
                s = result["summary"]
                s["full_name"]    = s["full_name"]    or h.get("name", "")    or h.get("full_name", "")
                s["phone"]        = s["phone"]        or h.get("phone", "")   or h.get("telephone", "")
                s["dob"]          = s["dob"]          or h.get("dob", "")     or h.get("date_of_birth", "")
                s["address"]      = s["address"]      or h.get("address", "")
                s["city"]         = s["city"]         or h.get("city", "")
                s["state"]        = s["state"]        or h.get("state", "")
                s["zip"]          = s["zip"]          or h.get("zip", "")     or h.get("zipcode", "")
                s["income"]       = s["income"]       or h.get("income", "")  or h.get("annual_income", "")
                s["credit_limit"] = s["credit_limit"] or h.get("credit_limit", "") or h.get("credit_card_limit", "")

    # ── LeakCheck API (if key available) ─────────────────────────────────────
    for email in emails[:3]:
        log(f"  [LeakCheck API] Checking {email}...")
        try:
            lc = fetch_leakcheck(email)
            if lc.get("found"):
                log(f"  [LeakCheck] Found in {lc.get('found')} breaches")
                result["leakcheck_api"].append({
                    "query":  email,
                    "found":  lc.get("found", 0),
                    "names":  lc.get("names", []),
                    "phones": lc.get("phones", []),
                })
                if lc.get("names") and not result["summary"]["full_name"]:
                    result["summary"]["full_name"] = lc["names"][0]
                if lc.get("phones") and not result["summary"]["phone"]:
                    result["summary"]["phone"] = lc["phones"][0]
        except Exception:
            pass
        time.sleep(1.5)

    # ── HaveIBeenPwned ────────────────────────────────────────────────────────
    result["hibp"] = []
    for email in emails[:3]:
        log(f"  [HIBP] Checking {email}...")
        breaches = fetch_hibp(email)
        if breaches:
            log(f"  [HIBP] Found in {len(breaches)} breaches")
            result["hibp"].append({
                "email":    email,
                "breaches": breaches,
                "count":    len(breaches),
                "data_classes": list(set(dc for b in breaches for dc in b.get("data_classes", []))),
            })
        time.sleep(1.6)  # HIBP rate limit: 1 req/1.5s

    # ── DeHashed API (paid — adds email/phone/address from breach entries) ────
    result["dehashed"] = []
    if DEHASHED_EMAIL and DEHASHED_KEY:
        for email in emails[:2]:
            log(f"  [DeHashed] Searching {email}...")
            hits = fetch_dehashed(email, "email")
            if hits:
                log(f"  [DeHashed] {len(hits)} records found!")
                result["dehashed"].extend(hits)
                for h in hits:
                    s = result["summary"]
                    s["full_name"] = s["full_name"] or h.get("name", "")
                    s["phone"]     = s["phone"]     or h.get("phone", "")
                    s["address"]   = s["address"]   or h.get("address", "")
            time.sleep(1)
        # Also search by wallet address
        hits_w = fetch_dehashed(addr, "address")
        if hits_w:
            result["dehashed"].extend(hits_w)
    elif not (DEHASHED_EMAIL and DEHASHED_KEY):
        log("  [DeHashed] No key — add DEHASHED_EMAIL + DEHASHED_KEY to .env")

    log(f"\n  Phase 3 done. Summary: {result['summary']}")
    return result


def _sqlite_search(db_path: str, emails: list, addr: str) -> list:
    """
    Generic SQLite search — works with any schema.
    Tries common column names for email/wallet fields.
    """
    results = []
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # Get all table names
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = [row[0] for row in cur.fetchall()]

        for table in tables:
            # Get column names
            cur.execute(f"PRAGMA table_info({table})")
            cols = [row[1].lower() for row in cur.fetchall()]

            # Find email-like column
            email_col = next((c for c in cols if "email" in c), None)
            wallet_col = next((c for c in cols if "wallet" in c or "address" in c), None)

            queries_run = []

            if email_col:
                for email in emails:
                    sql = f"SELECT * FROM {table} WHERE {email_col} = ? LIMIT 20"
                    try:
                        cur.execute(sql, (email,))
                        rows = cur.fetchall()
                        for row in rows:
                            results.append(dict(row))
                        queries_run.append(f"email={email}")
                    except Exception:
                        pass

            if wallet_col:
                sql = f"SELECT * FROM {table} WHERE {wallet_col} = ? LIMIT 20"
                try:
                    cur.execute(sql, (addr.lower(),))
                    rows = cur.fetchall()
                    for row in rows:
                        results.append(dict(row))
                    queries_run.append(f"wallet={addr[:10]}")
                except Exception:
                    pass

        conn.close()
    except Exception as e:
        log(f"    SQLite error ({db_path}): {e}")

    # Deduplicate
    seen = set()
    deduped = []
    for r in results:
        key = json.dumps(r, sort_keys=True, default=str)
        h = hashlib.md5(key.encode()).hexdigest()
        if h not in seen:
            seen.add(h)
            deduped.append(r)
    return deduped


# ─────────────────────────────────────────────────────────────────────────────
# PHASE 4: OSINT ENRICHMENT
# ─────────────────────────────────────────────────────────────────────────────

def phase4_osint(addr: str, p1: dict, p2: dict, p3: dict) -> dict:
    section("PHASE 4: OSINT ENRICHMENT")
    result = {
        "web_mentions":        [],
        "twitter_search":      [],
        "github_email":        "",
        "github_profile":      {},
        "intelx_emails":       [],
        "intelx_phones":       [],
        "platform_presence":   {},
        "sherlock":            [],
        "maigret":             [],
        "email_permutations":  [],
        "phone_numbers":       [],
        "whois":               {},
    }

    ens_name       = p1.get("ens_name", "")
    ens_recs       = p1.get("ens_records", {})
    fc             = p1.get("farcaster", {})
    fc_user        = fc.get("username", "")
    twitter_handle = p2.get("twitter_handle", "")
    emails         = p2.get("emails", [])
    github_handle  = _clean_handle(ens_recs.get("com.github") or ens_recs.get("github") or "")

    # Build list of known handles for OSINT
    known_handles = [h for h in [
        _clean_handle(twitter_handle),
        fc_user,
        github_handle,
        ens_name.replace(".eth", "") if ens_name else "",
    ] if h and len(h) > 2]

    # 1. Web mentions (Serper Google search)
    log("  [Web] Google search for wallet address...")
    try:
        web_data = fetch_web_osint(addr)
        result["web_mentions"] = web_data.get("web_mentions", [])[:10]
        log(f"  Web mentions: {len(result['web_mentions'])}")
    except Exception:
        pass

    # 2. Twitter/X search for wallet mentions
    if twitter_handle and TWITTER_BEARER:
        log(f"  [Twitter] Searching @{_clean_handle(twitter_handle)} profile details...")
        try:
            tw = _twitter_full_profile(_clean_handle(twitter_handle))
            result["twitter_search"] = [tw] if tw else []
        except Exception:
            pass

    # 3. GitHub email from commits
    if github_handle:
        log(f"  [GitHub] Checking commits for {github_handle}...")
        gh_email = _github_commit_email(github_handle)
        if gh_email and gh_email not in emails:
            result["github_email"] = gh_email
            emails.append(gh_email)
            p2["emails"] = emails
            p2["email_sources"][gh_email] = "GitHub commits"
            log(f"  [GitHub] email: {gh_email}")
        # GitHub profile
        result["github_profile"] = _github_profile(github_handle)

    # 4. IntelX phonebook search (by handles + emails)
    if INTELX_KEY:
        searches = [*emails[:2], *known_handles[:2]]
        for q in searches[:4]:
            log(f"  [IntelX] Phonebook: {q}")
            try:
                ix = fetch_intelx_phonebook(q)
                if ix.get("emails"):
                    for e in ix["emails"]:
                        if e not in emails:
                            result["intelx_emails"].append(e)
                if ix.get("phones"):
                    result["intelx_phones"].extend(ix["phones"])
                log(f"    → {len(ix.get('emails',[]))} emails, {len(ix.get('phones',[]))} phones")
            except Exception:
                pass
            time.sleep(2)

    # 5. LeakCheck by username
    if LEAKCHECK_KEY and known_handles:
        for handle in known_handles[:2]:
            log(f"  [LeakCheck] By username: {handle}")
            try:
                lc = fetch_leakcheck_by_username(handle)
                if lc.get("found"):
                    log(f"    → {lc['found']} breaches | has_email={lc.get('has_email')} has_phone={lc.get('has_phone')}")
                    result.setdefault("leakcheck_username", []).append({
                        "handle":    handle,
                        "found":     lc["found"],
                        "has_email": lc.get("has_email", False),
                        "has_phone": lc.get("has_phone", False),
                    })
            except Exception:
                pass
            time.sleep(1)

    # 6. People Data Labs (if key)
    if PDL_KEY and known_handles:
        log(f"  [PDL] Person search for {known_handles[0]}...")
        try:
            pdl = fetch_pdl_person(
                twitter=_clean_handle(twitter_handle) if twitter_handle else None,
                github=github_handle or None,
            )
            if pdl:
                result["pdl"] = pdl
                log(f"  [PDL] Found: {pdl.get('full_name','')}")
                if pdl.get("emails"):
                    for e in pdl["emails"]:
                        if e not in emails:
                            emails.append(e)
                            p2["email_sources"][e] = "PDL"
        except Exception:
            pass

    # 7. Cross-platform presence check
    if known_handles:
        log(f"  [Platform check] {known_handles[0]} across platforms...")
        try:
            platforms = check_username_platforms(known_handles[0])
            result["platform_presence"] = platforms
        except Exception:
            pass

    # 8. GitHub mentions of wallet address
    log(f"  [GitHub] Wallet address mentions in public repos...")
    try:
        gh_mentions = fetch_github_mentions(addr, GITHUB_TOKEN)
        if gh_mentions:
            result["github_wallet_mentions"] = gh_mentions[:5]
            log(f"  [GitHub] {len(gh_mentions)} mentions")
    except Exception:
        pass

    # 9. WHOIS (if URL/domain in ENS records)
    domain = ens_recs.get("url", "")
    if domain:
        domain = re.sub(r'https?://', '', domain).split('/')[0].strip()
        if domain:
            log(f"  [WHOIS] {domain}...")
            try:
                whois = fetch_whois_contact(domain)
                result["whois"] = whois
                if whois.get("email") and whois["email"] not in emails:
                    emails.append(whois["email"])
                    p2["email_sources"][whois["email"]] = f"WHOIS ({domain})"
                    log(f"  [WHOIS] email: {whois['email']}")
            except Exception:
                pass

    # 10. Email permutation generator (if we have a name)
    full_name = p3.get("summary", {}).get("full_name", "")
    if full_name and domain:
        log(f"  [Email perms] Generating permutations for {full_name}@{domain}...")
        try:
            perms = generate_email_permutations(full_name, domain)
            result["email_permutations"] = perms[:10]
        except Exception:
            pass

    # 11. Phone numbers aggregation
    phones = set()
    phones.update(result.get("intelx_phones", []))
    if p3.get("summary", {}).get("phone"):
        phones.add(p3["summary"]["phone"])
    if p2.get("phone_from_ens"):
        phones.add(p2["phone_from_ens"])
    result["phone_numbers"] = list(phones)

    # 12. DeHashed by username (paid — finds email/name/phone)
    if DEHASHED_EMAIL and DEHASHED_KEY and known_handles:
        for handle in known_handles[:2]:
            log(f"  [DeHashed] By username: {handle}")
            hits = fetch_dehashed(handle, "username")
            if hits:
                log(f"  [DeHashed] {len(hits)} records for @{handle}")
                result.setdefault("dehashed_username", []).extend(hits)
                for h in hits:
                    if h.get("email") and h["email"] not in emails:
                        emails.append(h["email"])
                        p2["emails"] = emails
                        p2["email_sources"][h["email"]] = f"DeHashed (username:{handle})"
            time.sleep(1)

    # 13. Holehe — email registered on which platforms (--deep only)
    if DEEP_MODE and emails:
        for email in emails[:2]:
            log(f"  [Holehe] Platform check for {email}...")
            holehe = fetch_holehe_check(email)
            if holehe.get("registered_on"):
                log(f"  [Holehe] Registered on: {holehe['registered_on']}")
                result.setdefault("holehe", []).append(holehe)

    # 14. Sherlock / Maigret (if --deep)
    if DEEP_MODE and known_handles:
        log(f"  [Sherlock] 400+ platform scan for {known_handles[0]}...")
        try:
            sh = run_sherlock(known_handles[0])
            result["sherlock"] = sh
            log(f"  [Sherlock] {len(sh)} platforms found")
        except Exception:
            pass
        log(f"  [Maigret] 2000+ platform scan for {known_handles[0]}...")
        try:
            mg = run_maigret(known_handles[0])
            result["maigret"] = mg
            log(f"  [Maigret] {len(mg)} platforms found")
        except Exception:
            pass

    # 15. Google dork searches (comprehensive)
    log("  [Dorks] Google dork searches...")
    full_name = p3.get("summary", {}).get("full_name", "")
    dorks = serper_dork_search(addr,
                               ens=p1.get("ens_name", ""),
                               name=full_name)
    result["google_dorks"] = dorks
    for d in dorks:
        for e in _extract_emails_from_text(d.get("snippet", "")):
            if e not in emails:
                emails.append(e)
                p2["emails"] = emails
                p2["email_sources"][e] = f"Google dork: {d['query'][:50]}"

    # ── NEW SOURCES (osint_sources.py) ────────────────────────────────────────

    # 16. Reddit mentions
    log(f"  [Reddit] Searching wallet address mentions...")
    result["reddit"] = reddit_search(addr)
    if ens_name:
        ens_reddit = reddit_search(ens_name)
        result["reddit"] = (result["reddit"] + ens_reddit)[:15]
    if result["reddit"]:
        log(f"  [Reddit] {len(result['reddit'])} posts found")

    # 17. Pastebin / paste site search
    log(f"  [Pastebin] Searching paste sites...")
    result["pastebin"] = pastebin_search(addr)
    if result["pastebin"]:
        log(f"  [Pastebin] {len(result['pastebin'])} paste results found")
        for p in result["pastebin"]:
            for e in _extract_emails_from_text(p.get("snippet", "")):
                if e not in emails:
                    emails.append(e)
                    p2["emails"] = emails
                    p2["email_sources"][e] = f"Pastebin ({p.get('site','')})"

    # 18. BitcoinTalk search
    if ens_name:
        log(f"  [BitcoinTalk] Searching for {ens_name}...")
        result["bitcointalk"] = bitcointalk_search(ens_name)
    if known_handles:
        bt_handle = bitcointalk_search(known_handles[0])
        result.setdefault("bitcointalk", []).extend(bt_handle)

    # 19. Twitter search — tweets mentioning this wallet
    log(f"  [Twitter search] Wallet address mentions in tweets...")
    result["twitter_wallet_tweets"] = twitter_search_wallet(addr)
    if result["twitter_wallet_tweets"]:
        log(f"  [Twitter] {len(result['twitter_wallet_tweets'])} tweets found")

    # 20. GitHub code search — wallet address in public repos
    log(f"  [GitHub code] Wallet in public repos...")
    result["github_code_search"] = github_code_search(addr)
    if result["github_code_search"]:
        log(f"  [GitHub] Found in {len(result['github_code_search'])} repos")
        for item in result["github_code_search"]:
            owner = item.get("owner", "")
            if owner and owner not in known_handles:
                known_handles.append(owner)

    # 21. Discord lookup (if handle known)
    discord_handle = (p1.get("ens_records", {}).get("com.discord") or "")
    if discord_handle:
        log(f"  [Discord] Lookup for {discord_handle}...")
        result["discord_profile"] = discord_search_via_web(discord_handle)

    # 22. BitQuery — multi-chain wallet data
    if os.getenv("BITQUERY_KEY"):
        log(f"  [BitQuery] Multi-chain query...")
        result["bitquery"] = bitquery_wallet(addr)

    # 23. Dune Analytics dashboards mentioning this wallet
    log(f"  [Dune] Dashboard search...")
    result["dune_dashboards"] = dune_analytics_search(addr)

    # 24. Zapper / Bloxy
    log(f"  [Bloxy] Blockchain analytics...")
    result["bloxy"] = bloxy_profile(addr)
    result["metasleuth_url"] = metasleuth_search(addr)

    # 25. DeBank extended profile (osint_sources version)
    log(f"  [DeBank pro] Portfolio...")
    result["debank_pro"] = debank_pro(addr)

    # 26. WHOIS + subdomain finder for known domains
    ens_name_ = p1.get("ens_name", "")
    ens_recs_ = p1.get("ens_records", {})
    url_domain = re.sub(r'https?://', '', ens_recs_.get("url", "")).split('/')[0].strip()
    for domain in [url_domain, result.get("whois", {}).get("domain", "")]:
        if domain and len(domain) > 3 and "." in domain:
            log(f"  [Subdomain] Finding subdomains of {domain}...")
            result.setdefault("subdomains", {})[domain] = subdomain_finder(domain)
            result.setdefault("dns_history", {})[domain] = dns_history(domain)
            whois_full = whois_all(domain)
            if whois_full.get("email") and whois_full["email"] not in emails:
                emails.append(whois_full["email"])
                p2["emails"] = emails
                p2["email_sources"][whois_full["email"]] = f"WHOIS ({domain})"
            result["whois_full"] = whois_full
            break

    # 27. Smart contract source code scan (for devs who deployed contracts)
    log(f"  [Contract] Source code email scan...")
    result["contract_source"] = smart_contract_source(addr)
    if result["contract_source"].get("emails_in_source"):
        for e in result["contract_source"]["emails_in_source"]:
            if e not in emails:
                emails.append(e)
                p2["emails"] = emails
                p2["email_sources"][e] = "Smart contract source code"
                log(f"  [Contract] email in source: {e}")

    # 28. GHunt (Google account) for found emails
    if DEEP_MODE:
        for e in emails[:1]:
            log(f"  [GHunt] Google account check for {e}...")
            result.setdefault("ghunt", {})[e] = ghunt_lookup(e)

    # 29. POAP lookup (events attended = location + social context)
    log(f"  [POAP] Events attended...")
    result["poap_events"] = poap_lookup(addr)
    if result["poap_events"]:
        log(f"  [POAP] {len(result['poap_events'])} events")
        cities = [p.get("city") for p in result["poap_events"] if p.get("city")]
        if cities:
            log(f"  [POAP] Cities visited: {', '.join(set(cities))}")

    # 30. Gitcoin Grants profile (sometimes has email)
    log(f"  [Gitcoin Grants] Profile lookup...")
    gc = gitcoin_grants(addr)
    result["gitcoin_grants"] = gc
    if gc.get("email") and gc["email"] not in emails:
        emails.append(gc["email"])
        p2["emails"] = emails
        p2["email_sources"][gc["email"]] = "Gitcoin Grants profile"
        log(f"  [Gitcoin] email: {gc['email']}")

    # 31. HIBP pastes (additional to base breach check)
    result["hibp_pastes"] = {}
    for e in emails[:3]:
        pastes = hibp_pastes(e)
        if pastes:
            result["hibp_pastes"][e] = pastes
            log(f"  [HIBP pastes] {len(pastes)} pastes for {e}")
        time.sleep(1.5)

    # 32. DeHashed — search by name if we have one
    full_name_found = p3.get("summary", {}).get("full_name", "")
    if full_name_found and DEHASHED_EMAIL and DEHASHED_KEY:
        log(f"  [DeHashed] Name search: {full_name_found}")
        hits = dehashed_search(full_name_found, "name")
        if hits:
            result.setdefault("dehashed_name", []).extend(hits)
            log(f"  [DeHashed] {len(hits)} records by name")

    log(f"\n  Phase 4 done.")
    return result


def _twitter_full_profile(username: str) -> dict:
    if not TWITTER_BEARER or not username:
        return {}
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{username}",
            params={"user.fields": "description,url,location,public_metrics,entities,created_at"},
            headers={"Authorization": f"Bearer {TWITTER_BEARER}"},
            timeout=8)
        data = r.json().get("data", {})
        return {
            "username":    data.get("username", ""),
            "name":        data.get("name", ""),
            "bio":         data.get("description", ""),
            "location":    data.get("location", ""),
            "url":         data.get("url", ""),
            "followers":   (data.get("public_metrics") or {}).get("followers_count", 0),
            "following":   (data.get("public_metrics") or {}).get("following_count", 0),
            "tweets":      (data.get("public_metrics") or {}).get("tweet_count", 0),
            "created":     data.get("created_at", ""),
        }
    except Exception:
        return {}


def _github_commit_email(username: str) -> str:
    if not username:
        return ""
    try:
        hdrs = {}
        if GITHUB_TOKEN:
            hdrs["Authorization"] = f"token {GITHUB_TOKEN}"
        r = requests.get(f"https://api.github.com/users/{username}/events/public?per_page=30",
                        headers=hdrs, timeout=10)
        for ev in (r.json() if isinstance(r.json(), list) else []):
            if ev.get("type") == "PushEvent":
                for c in (ev.get("payload") or {}).get("commits", []):
                    email = (c.get("author") or {}).get("email", "")
                    if email and "noreply" not in email and "@" in email:
                        return email
    except Exception:
        pass
    return ""


def _github_profile(username: str) -> dict:
    if not username:
        return {}
    try:
        hdrs = {}
        if GITHUB_TOKEN:
            hdrs["Authorization"] = f"token {GITHUB_TOKEN}"
        r = requests.get(f"https://api.github.com/users/{username}", headers=hdrs, timeout=8)
        d = r.json()
        return {
            "login":      d.get("login", ""),
            "name":       d.get("name", ""),
            "email":      d.get("email", ""),
            "bio":        d.get("bio", ""),
            "company":    d.get("company", ""),
            "location":   d.get("location", ""),
            "blog":       d.get("blog", ""),
            "followers":  d.get("followers", 0),
            "repos":      d.get("public_repos", 0),
            "created":    d.get("created_at", ""),
        }
    except Exception:
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# FINAL PROFILE BUILDER
# ─────────────────────────────────────────────────────────────────────────────

def build_profile(addr: str, p1: dict, p2: dict, p3: dict, p4: dict) -> dict:
    """Merge all phase results into clean output JSON."""

    ens_recs  = p1.get("ens_records", {})
    fc        = p1.get("farcaster", {})
    breach    = p3.get("summary", {})
    lens      = p1.get("lens", {})

    twitter = (
        ens_recs.get("com.twitter") or ens_recs.get("twitter") or
        fc.get("twitter") or p2.get("twitter_handle") or
        p1.get("arkham_twitter") or ""
    )
    telegram = (
        ens_recs.get("org.telegram") or ens_recs.get("telegram") or ""
    )
    github = (
        ens_recs.get("com.github") or ens_recs.get("github") or
        p4.get("github_profile", {}).get("login") or ""
    )
    discord = ens_recs.get("com.discord") or ens_recs.get("discord") or ""
    reddit  = ens_recs.get("com.reddit") or ""

    # Aggregate all emails
    all_emails = list(dict.fromkeys(
        p2.get("emails", []) +
        p4.get("intelx_emails", []) +
        [p4.get("github_email", "")] +
        [p4.get("github_profile", {}).get("email", "")]
    ))
    all_emails = [e for e in all_emails if e]

    # Aggregate all phones
    all_phones = list(dict.fromkeys(
        p4.get("phone_numbers", []) +
        [breach.get("phone", "")] +
        [p2.get("phone_from_ens", "")]
    ))
    all_phones = [p for p in all_phones if p]

    # Transaction summary
    txs = p1.get("transactions", [])
    tx_summary = {
        "total":       len(txs),
        "first_date":  p1.get("first_tx", ""),
        "wallet_age":  f"{p1.get('wallet_age_months', 0):.0f} months",
        "recent":      txs[:5] if txs else [],
    }

    profile = {
        # ── Identifiers ──
        "wallet_address": addr,
        "ens_name":       p1.get("ens_name", ""),
        "entity":         p1.get("entity", ""),
        "etherscan_label": p1.get("etherscan_label", ""),
        "labels":          p1.get("labels", []),

        # ── Social handles ──
        "social_handles": {
            "twitter":    _clean_handle(twitter) if twitter else "",
            "telegram":   telegram,
            "farcaster":  fc.get("username", ""),
            "lens":       lens.get("handle", ""),
            "github":     _clean_handle(github) if github else "",
            "discord":    discord,
            "reddit":     reddit,
            "instagram":  ens_recs.get("com.instagram") or "",
            "tiktok":     ens_recs.get("com.tiktok") or "",
            "website":    ens_recs.get("url", ""),
        },

        # ── Contact ──
        "emails":         all_emails,
        "email_sources":  p2.get("email_sources", {}),
        "phone_numbers":  all_phones,

        # ── Personal (from breach / OSINT) ──
        "full_name":      (
            breach.get("full_name") or
            p4.get("pdl", {}).get("full_name") or
            p4.get("github_profile", {}).get("name") or
            fc.get("display_name") or ""
        ),
        "date_of_birth":  breach.get("dob", ""),
        "physical_address": {
            "street": breach.get("address", ""),
            "city":   breach.get("city", ""),
            "state":  breach.get("state", ""),
            "zip":    breach.get("zip", ""),
        },
        "income":          breach.get("income", ""),
        "credit_limit":    breach.get("credit_limit", ""),
        "location":        (
            ens_recs.get("location") or
            p4.get("twitter_search", [{}])[0].get("location") if p4.get("twitter_search") else "" or
            p4.get("github_profile", {}).get("location") or ""
        ),

        # ── Financial ──
        "balance": {
            "eth":      p1.get("eth_balance", 0),
            "usd":      p1.get("usd_balance", 0),
            "moralis":  p1.get("moralis_networth", 0),
        },
        "tokens":   p1.get("tokens", []),
        "nfts":     p1.get("nfts", []),
        "multichain": p1.get("multichain", {}),

        # ── Activity ──
        "transaction_summary": tx_summary,
        "snapshot":   p1.get("snapshot", {}),
        "mirror":     p1.get("mirror", {}),
        "poap":       p2.get("poap", []),

        # ── Breach ──
        "breach_databases": {
            "us_leak":       len(p3.get("us_leak", [])),
            "ledger_leak":   len(p3.get("ledger_leak", [])),
            "coinbase_leak": len(p3.get("coinbase_leak", [])),
            "leakcheck_api": p3.get("leakcheck_api", []),
        },
        "breach_records_raw": {
            "us_leak":       p3.get("us_leak", []),
            "ledger_leak":   p3.get("ledger_leak", []),
            "coinbase_leak": p3.get("coinbase_leak", []),
        },

        # ── Extended identity ──
        "web3bio":           p1.get("web3bio", {}),
        "nextid":            p1.get("nextid", {}),
        "airstack":          p1.get("airstack", {}),
        "gitcoin_passport":  p1.get("gitcoin_passport", {}),
        "gravatar":          p1.get("gravatar", {}),

        # ── Breach (extended) ──
        "hibp":              p3.get("hibp", []),
        "dehashed":          p3.get("dehashed", []),
        "holehe":            p4.get("holehe", []),

        # ── OSINT ──
        "web_mentions":      p4.get("web_mentions", []),
        "twitter_profile":   p4.get("twitter_search", [{}])[0] if p4.get("twitter_search") else {},
        "github_profile":    p4.get("github_profile", {}),
        "platform_presence": p4.get("platform_presence", {}),
        "sherlock":          p4.get("sherlock", []),
        "maigret":           p4.get("maigret", []),
        "whois":             p4.get("whois", {}),
        "intelx": {
            "emails": p4.get("intelx_emails", []),
            "phones": p4.get("intelx_phones", []),
        },
        "pdl":               p4.get("pdl", {}),

        # ── Etherscan ──
        "etherscan_url": f"https://etherscan.io/address/{addr}",

        # ── Extended identity (new sources) ──
        "bluepages":         p1.get("bluepages", {}),
        "spaceid":           p1.get("spaceid", {}),
        "xmtp":              p1.get("xmtp", {}),
        "idriss_reverse":    p1.get("idriss_reverse", []),
        "nansen":            p1.get("nansen", {}),
        "zapper_usd":        p1.get("zapper_usd", 0),
        "snapshot_gov":      p1.get("snapshot_gov", {}),
        "mirror_posts":      p1.get("mirror_posts", []),
        "pgp_keys":          p1.get("pgp_keys", {}),
        "crt_certs":         p1.get("crt_certs", {}),
        "social_pwned":      p1.get("social_pwned", {}),

        # ── Social media OSINT (new) ──
        "reddit_mentions":        p4.get("reddit", []),
        "pastebin_mentions":      p4.get("pastebin", []),
        "bitcointalk_mentions":   p4.get("bitcointalk", []),
        "twitter_wallet_tweets":  p4.get("twitter_wallet_tweets", []),
        "github_code_search":     p4.get("github_code_search", []),
        "discord_profile":        p4.get("discord_profile", {}),

        # ── Crypto intelligence (new) ──
        "bitquery":         p4.get("bitquery", {}),
        "dune_dashboards":  p4.get("dune_dashboards", []),
        "bloxy":            p4.get("bloxy", {}),
        "debank_pro":       p4.get("debank_pro", {}),
        "metasleuth_url":   p4.get("metasleuth_url", ""),

        # ── Advanced OSINT (new) ──
        "subdomains":      p4.get("subdomains", {}),
        "dns_history":     p4.get("dns_history", {}),
        "whois_full":      p4.get("whois_full", {}),
        "contract_source": p4.get("contract_source", {}),

        # ── Extra breach (new) ──
        "hibp_pastes":     p4.get("hibp_pastes", {}),
        "dehashed_name":   p4.get("dehashed_name", []),

        # ── Wallet-specific events (new) ──
        "poap_events":          p4.get("poap_events", []),
        "gitcoin_grants":       p4.get("gitcoin_grants", {}),
        "ghunt":                p4.get("ghunt", {}),
    }

    return profile


# ─────────────────────────────────────────────────────────────────────────────
# PRETTY PRINT
# ─────────────────────────────────────────────────────────────────────────────

def print_profile(profile: dict):
    print("\n" + "=" * 65)
    print("  WALLET OSINT REPORT")
    print("=" * 65)

    print(f"\n  Address  : {profile['wallet_address']}")
    if profile["ens_name"]:    print(f"  ENS      : {profile['ens_name']}")
    if profile["entity"]:      print(f"  Entity   : {profile['entity']}")
    if profile["labels"]:      print(f"  Labels   : {', '.join(profile['labels'][:4])}")

    bal = profile["balance"]
    print(f"\n  Balance  : ${bal['usd']:>14,.0f}  ({bal['eth']:.4f} ETH)")
    if profile["tokens"]:
        top = ", ".join(f"{t['symbol']}(${t['usd']:,.0f})" for t in profile["tokens"][:5])
        print(f"  Tokens   : {top}")
    if profile["nfts"]:
        print(f"  NFTs     : {len(profile['nfts'])} items")

    tx = profile["transaction_summary"]
    print(f"\n  Wallet age  : {tx['wallet_age']}  |  First tx: {tx['first_date']}")

    print(f"\n  ── SOCIAL HANDLES ──────────────────────────────────────")
    handles = profile["social_handles"]
    for k, v in handles.items():
        if v:
            print(f"  {k:<12}: {v}")

    print(f"\n  ── CONTACT ─────────────────────────────────────────────")
    if profile["emails"]:
        for e in profile["emails"]:
            src = profile["email_sources"].get(e, "")
            print(f"  Email      : {e}  [{src}]")
    else:
        print("  Email      : —")
    if profile["phone_numbers"]:
        for p in profile["phone_numbers"]:
            print(f"  Phone      : {p}")
    else:
        print("  Phone      : —")

    print(f"\n  ── PERSONAL (from breach/OSINT) ─────────────────────────")
    if profile["full_name"]:   print(f"  Name       : {profile['full_name']}")
    if profile["date_of_birth"]: print(f"  DOB        : {profile['date_of_birth']}")
    addr_ = profile["physical_address"]
    if any(addr_.values()):
        print(f"  Address    : {addr_.get('street','')} {addr_.get('city','')} {addr_.get('state','')} {addr_.get('zip','')}")
    if profile["income"]:      print(f"  Income     : {profile['income']}")
    if profile["credit_limit"]: print(f"  Credit Lim : {profile['credit_limit']}")
    if profile["location"]:    print(f"  Location   : {profile['location']}")

    print(f"\n  ── BREACH DATABASES ────────────────────────────────────")
    bd = profile["breach_databases"]
    print(f"  US Leak    : {bd['us_leak']} records")
    print(f"  Ledger Leak: {bd['ledger_leak']} records")
    print(f"  Coinbase   : {bd['coinbase_leak']} records")
    for lc in bd.get("leakcheck_api", []):
        print(f"  LeakCheck  : {lc['found']} breaches for {lc['query']}")

    if profile["web_mentions"]:
        print(f"\n  ── WEB MENTIONS ────────────────────────────────────────")
        for m in profile["web_mentions"][:3]:
            print(f"  {m}")

    if profile["platform_presence"]:
        present = [k for k, v in profile["platform_presence"].items() if v]
        if present:
            print(f"\n  ── PLATFORMS FOUND ─────────────────────────────────────")
            print(f"  {', '.join(present)}")

    print(f"\n  ── INTELX ──────────────────────────────────────────────")
    ix = profile["intelx"]
    print(f"  Emails : {', '.join(ix['emails']) or '—'}")
    print(f"  Phones : {', '.join(ix['phones']) or '—'}")

    if profile.get("pdl"):
        print(f"\n  ── PDL ────────────────────────────────────────────────")
        pdl = profile["pdl"]
        print(f"  Name   : {pdl.get('full_name','')}")
        print(f"  Job    : {pdl.get('job_title','')} @ {pdl.get('company','')}")

    print(f"\n  EtherScan: {profile['etherscan_url']}")
    print(f"\n  JSON saved: {OUT_FILE}\n")


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main():
    log("=" * 65)
    log(f"  WALLET OSINT TOOL")
    log(f"  Target  : {ADDR}")
    log(f"  Deep    : {DEEP_MODE}")
    log(f"  ETH $   : ${ETH_PRICE:,.0f}")
    log("=" * 65)

    # Validate address
    if not re.match(r'^0x[0-9a-fA-F]{40}$', ADDR):
        print(f"ERROR: Invalid Ethereum address: {ADDR}")
        sys.exit(1)

    # Run all phases
    p1 = phase1_onchain(ADDR)

    # Balance check (optional gate)
    if ARGS.min_balance > 0 and p1.get("usd_balance", 0) < ARGS.min_balance:
        log(f"\n  Balance ${p1['usd_balance']:,.0f} < min ${ARGS.min_balance:,.0f} — stopping")
        sys.exit(0)

    p2 = phase2_email(ADDR, p1)
    p3 = phase3_breach(p2.get("emails", []), ADDR)
    p4 = phase4_osint(ADDR, p1, p2, p3)

    # Build final profile
    profile = build_profile(ADDR, p1, p2, p3, p4)

    # Save JSON
    save(profile)

    # Print report
    if not ARGS.quiet:
        print_profile(profile)


if __name__ == "__main__":
    main()
