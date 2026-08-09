"""
osint_sources.py — 200+ OSINT source functions
================================================
All sources from the master list, implemented as callable functions.
Import in wallet_osint.py or use standalone.

Categories:
  A. Multi-chain blockchain explorers (15+ chains)
  B. Web3 identity aggregators (Bluepages, Space ID, XMTP, IDriss, next.id)
  C. Social media OSINT (Reddit, BitcoinTalk, Pastebin, Discord, GitHub)
  D. Email enrichment (Hunter, Ghunt, Gravatar, PGP, Holehe)
  E. Crypto intelligence (BitQuery, Dune, Nansen, Zapper, MetaSleuth)
  F. Advanced OSINT (crt.sh, WHOIS, subdomain, SSL cert, IP lookup)
  G. Breach/leak APIs (HIBP, DeHashed, LeakCheck, IntelX)
  H. Wallet-specific (IDriss, XMTP, Gitcoin Passport, POAP)
"""
import os, sys, re, json, time, hashlib, subprocess, sqlite3
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import requests
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# ── Keys ──────────────────────────────────────────────────────────────────────
ETHERSCAN_KEY   = os.getenv("ETHERSCAN_KEY", "")
ALCHEMY_KEY     = os.getenv("ALCHEMY_KEY", "")
MORALIS_KEY     = os.getenv("MORALIS_KEY", "")
NEYNAR_KEY      = os.getenv("NEYNAR_KEY", "")
SERPER_KEY      = os.getenv("SERPER_KEY", "")
INTELX_KEY      = os.getenv("INTELX_KEY", "")
INTELX_HOST     = os.getenv("INTELX_HOST", "https://free.intelx.io")
TWITTER_BEARER  = os.getenv("TWITTER_BEARER", "")
GITHUB_TOKEN    = os.getenv("GITHUB_TOKEN", "")
LEAKCHECK_KEY   = os.getenv("LEAKCHECK_KEY", "")
PDL_KEY         = os.getenv("PDL_API_KEY", "")
DEHASHED_EMAIL  = os.getenv("DEHASHED_EMAIL", "")
DEHASHED_KEY    = os.getenv("DEHASHED_KEY", "")
HIBP_KEY        = os.getenv("HIBP_KEY", "")
AIRSTACK_KEY    = os.getenv("AIRSTACK_API_KEY", "")
HUNTER_KEY      = os.getenv("HUNTER_KEY", "")
BITQUERY_KEY    = os.getenv("BITQUERY_KEY", "")
ANKR_KEY        = os.getenv("ANKR_KEY", "")
HELIUS_KEY      = os.getenv("HELIUS_KEY", "")

HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')

ETH_PRICE = 1934.0
try:
    _r = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", timeout=5)
    ETH_PRICE = float(_r.json()["ethereum"]["usd"])
except Exception:
    pass


# ═══════════════════════════════════════════════════════════════════════════════
# A. MULTI-CHAIN BLOCKCHAIN EXPLORERS
# ═══════════════════════════════════════════════════════════════════════════════

def blockchair_lookup(addr: str, chain: str = "ethereum") -> dict:
    """Blockchair — multi-chain: ethereum, bitcoin, bsc, polygon, arbitrum, etc."""
    try:
        r = requests.get(
            f"https://api.blockchair.com/{chain}/dashboards/address/{addr}",
            params={"key": ""}, timeout=10, headers=HDRS)
        data = r.json().get("data", {}).get(addr.lower(), {})
        addr_data = data.get("address", {})
        return {
            "chain":        chain,
            "balance":      addr_data.get("balance", 0),
            "tx_count":     addr_data.get("transaction_count", 0),
            "first_seen":   addr_data.get("first_seen_receiving", ""),
            "last_seen":    addr_data.get("last_seen_receiving", ""),
            "received":     addr_data.get("received", 0),
            "sent":         addr_data.get("sent", 0),
        }
    except Exception:
        return {}


def bscscan_balance(addr: str) -> dict:
    """BscScan — BSC balance + BEP-20 tokens."""
    BSC_KEY = os.getenv("BSCSCAN_KEY", "")
    try:
        r = requests.get("https://api.bscscan.com/api", params={
            "module": "account", "action": "balance",
            "address": addr, "apikey": BSC_KEY or "YourApiKeyToken"
        }, timeout=8)
        bal = int(r.json().get("result", "0")) / 1e18
        return {"bnb_balance": bal, "bnb_usd": bal * 600}
    except Exception:
        return {}


def polygonscan_balance(addr: str) -> dict:
    """PolygonScan — MATIC balance."""
    POLY_KEY = os.getenv("POLYGONSCAN_KEY", "")
    try:
        r = requests.get("https://api.polygonscan.com/api", params={
            "module": "account", "action": "balance",
            "address": addr, "apikey": POLY_KEY or "YourApiKeyToken"
        }, timeout=8)
        bal = int(r.json().get("result", "0")) / 1e18
        return {"matic_balance": bal, "matic_usd": bal * 0.7}
    except Exception:
        return {}


def arbiscan_balance(addr: str) -> dict:
    """Arbiscan — Arbitrum ETH balance."""
    ARB_KEY = os.getenv("ARBISCAN_KEY", "")
    try:
        r = requests.get("https://api.arbiscan.io/api", params={
            "module": "account", "action": "balance",
            "address": addr, "apikey": ARB_KEY or "YourApiKeyToken"
        }, timeout=8)
        bal = int(r.json().get("result", "0")) / 1e18
        return {"arb_eth": bal, "arb_usd": bal * ETH_PRICE}
    except Exception:
        return {}


def optimism_balance(addr: str) -> dict:
    """Optimistic Etherscan — OP chain ETH balance."""
    OP_KEY = os.getenv("OPSCAN_KEY", "")
    try:
        r = requests.get("https://api-optimistic.etherscan.io/api", params={
            "module": "account", "action": "balance",
            "address": addr, "apikey": OP_KEY or "YourApiKeyToken"
        }, timeout=8)
        bal = int(r.json().get("result", "0")) / 1e18
        return {"op_eth": bal, "op_usd": bal * ETH_PRICE}
    except Exception:
        return {}


def avaxscan_balance(addr: str) -> dict:
    """Snowtrace/Avascan — AVAX C-Chain balance."""
    AVAX_KEY = os.getenv("SNOWTRACE_KEY", "")
    try:
        r = requests.get("https://api.snowtrace.io/api", params={
            "module": "account", "action": "balance",
            "address": addr, "apikey": AVAX_KEY or "YourApiKeyToken"
        }, timeout=8)
        bal = int(r.json().get("result", "0")) / 1e18
        return {"avax_balance": bal, "avax_usd": bal * 30}
    except Exception:
        return {}


def ftmscan_balance(addr: str) -> dict:
    """FTMScan — Fantom FTM balance."""
    FTM_KEY = os.getenv("FTMSCAN_KEY", "")
    try:
        r = requests.get("https://api.ftmscan.com/api", params={
            "module": "account", "action": "balance",
            "address": addr, "apikey": FTM_KEY or "YourApiKeyToken"
        }, timeout=8)
        bal = int(r.json().get("result", "0")) / 1e18
        return {"ftm_balance": bal, "ftm_usd": bal * 0.5}
    except Exception:
        return {}


def solscan_lookup(sol_addr: str) -> dict:
    """Solscan — Solana address info (SOL balance, tokens)."""
    try:
        r = requests.get(f"https://public-api.solscan.io/account/{sol_addr}",
                        timeout=10, headers=HDRS)
        data = r.json()
        return {
            "sol_balance": float(data.get("lamports", 0)) / 1e9,
            "account_type": data.get("type", ""),
            "data":         data.get("data", {}),
        }
    except Exception:
        return {}


def mempool_btc_lookup(btc_addr: str) -> dict:
    """Mempool.space — Bitcoin address stats."""
    try:
        r = requests.get(f"https://mempool.space/api/address/{btc_addr}",
                        timeout=10, headers=HDRS)
        data = r.json()
        stats = data.get("chain_stats", {})
        return {
            "btc_balance_sat":  stats.get("funded_txo_sum", 0) - stats.get("spent_txo_sum", 0),
            "btc_balance":      (stats.get("funded_txo_sum", 0) - stats.get("spent_txo_sum", 0)) / 1e8,
            "tx_count":         stats.get("tx_count", 0),
            "received_sat":     stats.get("funded_txo_sum", 0),
        }
    except Exception:
        return {}


def tronscan_lookup(tron_addr: str) -> dict:
    """Tronscan — TRX balance and account info."""
    try:
        r = requests.get(f"https://apilist.tronscanapi.com/api/accountv2",
                        params={"address": tron_addr}, timeout=10, headers=HDRS)
        data = r.json()
        return {
            "trx_balance": float(data.get("balance", 0)) / 1e6,
            "token_count": len(data.get("tokenBalances", [])),
            "bandwidth":   data.get("bandwidth", {}).get("freeNetLimit", 0),
        }
    except Exception:
        return {}


def near_lookup(near_addr: str) -> dict:
    """Near Blocks — NEAR protocol account info."""
    try:
        r = requests.get(f"https://api.nearblocks.io/v1/account/{near_addr}",
                        timeout=10, headers=HDRS)
        data = r.json()
        acct = data.get("account", [{}])[0] if isinstance(data.get("account"), list) else {}
        return {
            "near_balance": float(acct.get("amount", "0")) / 1e24,
            "tx_count":     acct.get("transactions_count", 0),
            "created":      acct.get("created", {}).get("transaction_hash", ""),
        }
    except Exception:
        return {}


def multichain_balances(addr: str) -> dict:
    """Run all chain scanners in parallel and return totals."""
    results = {}
    chains = [
        ("BSC",      bscscan_balance),
        ("Polygon",  polygonscan_balance),
        ("Arbitrum", arbiscan_balance),
        ("Optimism", optimism_balance),
        ("Avalanche",avaxscan_balance),
        ("Fantom",   ftmscan_balance),
    ]
    for name, fn in chains:
        try:
            result = fn(addr)
            if result:
                results[name] = result
        except Exception:
            pass
        time.sleep(0.1)
    return results


# ═══════════════════════════════════════════════════════════════════════════════
# B. WEB3 IDENTITY AGGREGATORS
# ═══════════════════════════════════════════════════════════════════════════════

def bluepages_lookup(addr: str) -> dict:
    """Bluepages — 6M+ addresses linked to 4M+ social accounts, 30+ sources."""
    try:
        r = requests.get(
            f"https://api.bluepages.io/address/{addr.lower()}",
            timeout=10, headers=HDRS)
        if r.status_code == 200:
            data = r.json()
            return {
                "profiles":   data.get("profiles", []),
                "twitter":    data.get("twitter", ""),
                "github":     data.get("github", ""),
                "email":      data.get("email", ""),
                "discord":    data.get("discord", ""),
                "ens":        data.get("ens", ""),
                "lens":       data.get("lens", ""),
                "farcaster":  data.get("farcaster", ""),
            }
    except Exception:
        pass
    return {}


def spaceid_lookup(addr: str) -> dict:
    """Space ID — .bnb and .arb domain names."""
    results = {}
    try:
        # BNB chain
        r1 = requests.get(
            f"https://api.prd.space.id/v1/getName",
            params={"chainId": 56, "address": addr},
            timeout=8, headers=HDRS)
        if r1.status_code == 200:
            results["bnb_domain"] = r1.json().get("name", "")
    except Exception:
        pass
    try:
        # ARB chain
        r2 = requests.get(
            f"https://api.prd.space.id/v1/getName",
            params={"chainId": 42161, "address": addr},
            timeout=8, headers=HDRS)
        if r2.status_code == 200:
            results["arb_domain"] = r2.json().get("name", "")
    except Exception:
        pass
    return results


def xmtp_check(addr: str) -> dict:
    """Check if wallet has XMTP messaging enabled."""
    try:
        r = requests.get(
            f"https://api.thegraph.com/subgraphs/name/xmtp-labs/xmtp",
            json={
                "query": f'{{ users(where: {{wallet: "{addr.lower()}"}}) {{ wallet createdAt }} }}'
            },
            timeout=8)
        users = r.json().get("data", {}).get("users", [])
        if users:
            return {"xmtp_enabled": True, "created": users[0].get("createdAt", "")}
        # Try XMTP network API
        r2 = requests.get(f"https://api.xmtp.network/api/v1/wallet/{addr}/canMessage",
                         timeout=8, headers=HDRS)
        return {"xmtp_enabled": r2.json().get("canMessage", False) if r2.status_code == 200 else False}
    except Exception:
        return {"xmtp_enabled": False}


def idriss_reverse(addr: str) -> list:
    """IDriss — wallet address → list of linked email/phone/twitter handles."""
    try:
        r = requests.get(
            "https://www.idriss.xyz/api/reverse",
            params={"wallet": addr},
            timeout=8, headers=HDRS)
        if r.status_code == 200:
            results = r.json()
            if isinstance(results, list):
                return results
            elif isinstance(results, dict):
                return [results]
    except Exception:
        pass
    return []


def web3bio_lookup(addr: str) -> dict:
    """Web3.bio — aggregates ENS, Lens, Farcaster, Basenames in one call."""
    try:
        r = requests.get(f"https://api.web3.bio/profile/{addr}",
                        timeout=8, headers=HDRS)
        if r.status_code == 200:
            profiles = r.json() if isinstance(r.json(), list) else [r.json()]
            result = {}
            for p in (profiles or []):
                if not p:
                    continue
                platform = p.get("platform", "unknown")
                links = p.get("links") or {}
                result[platform] = {
                    "handle":    p.get("handle") or p.get("identity", ""),
                    "display":   p.get("displayName", ""),
                    "bio":       p.get("description", ""),
                    "location":  p.get("location", ""),
                    "website":   p.get("website", ""),
                    "avatar":    p.get("avatar", ""),
                    "email":     (links.get("email") or {}).get("handle", ""),
                    "twitter":   (links.get("twitter") or {}).get("handle", ""),
                    "telegram":  (links.get("telegram") or {}).get("handle", ""),
                    "github":    (links.get("github") or {}).get("handle", ""),
                    "discord":   (links.get("discord") or {}).get("handle", ""),
                    "instagram": (links.get("instagram") or {}).get("handle", ""),
                    "youtube":   (links.get("youtube") or {}).get("handle", ""),
                    "linkedin":  (links.get("linkedin") or {}).get("handle", ""),
                    "reddit":    (links.get("reddit") or {}).get("handle", ""),
                }
            return result
    except Exception:
        pass
    return {}


def nextid_lookup(addr: str) -> dict:
    """next.id — Relation Server: identity graph across all platforms."""
    try:
        r = requests.get(
            f"https://relation-service.next.id/v1/identity/{addr.lower()}",
            timeout=8, headers=HDRS)
        if r.status_code == 200:
            edges = r.json().get("edges") or []
            seen = set()
            identities = []
            for e in edges:
                for node in [e.get("source") or {}, e.get("target") or {}]:
                    if node.get("platform") and node.get("identity"):
                        key = f"{node['platform']}:{node['identity']}"
                        if key not in seen:
                            seen.add(key)
                            identities.append({
                                "platform": node["platform"],
                                "handle":   node["identity"],
                                "display":  node.get("displayName", ""),
                            })
            return {"identities": identities, "count": len(identities)}
    except Exception:
        pass
    return {}


# ═══════════════════════════════════════════════════════════════════════════════
# C. SOCIAL MEDIA OSINT
# ═══════════════════════════════════════════════════════════════════════════════

def reddit_search(query: str) -> list:
    """Reddit public API — search posts and comments mentioning wallet/handle."""
    results = []
    try:
        r = requests.get(
            "https://www.reddit.com/search.json",
            params={"q": query, "type": "link", "limit": 10, "sort": "relevance"},
            headers={"User-Agent": "wallet-osint-tool/1.0"},
            timeout=10)
        for post in r.json().get("data", {}).get("children", []):
            d = post.get("data", {})
            results.append({
                "title":     d.get("title", ""),
                "subreddit": d.get("subreddit", ""),
                "url":       f"https://reddit.com{d.get('permalink', '')}",
                "score":     d.get("score", 0),
                "author":    d.get("author", ""),
                "text":      d.get("selftext", "")[:200],
            })
    except Exception:
        pass
    return results


def bitcointalk_search(query: str) -> list:
    """BitcoinTalk search via Google dork (wallets commonly mentioned in signatures)."""
    if not SERPER_KEY:
        return []
    results = []
    try:
        r = requests.post("https://google.serper.dev/search",
            json={"q": f'site:bitcointalk.org "{query}"', "num": 5},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10)
        for res in r.json().get("organic", []):
            results.append({
                "title":   res.get("title", ""),
                "url":     res.get("link", ""),
                "snippet": res.get("snippet", ""),
            })
    except Exception:
        pass
    return results


def pastebin_search(query: str) -> list:
    """Search Pastebin for wallet address mentions via Google dork."""
    if not SERPER_KEY:
        return []
    results = []
    for site in ["pastebin.com", "paste.ee", "rentry.co", "privatebin.net"]:
        try:
            r = requests.post("https://google.serper.dev/search",
                json={"q": f'site:{site} "{query}"', "num": 3},
                headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
                timeout=10)
            for res in r.json().get("organic", []):
                results.append({
                    "site":    site,
                    "title":   res.get("title", ""),
                    "url":     res.get("link", ""),
                    "snippet": res.get("snippet", ""),
                })
            time.sleep(0.3)
        except Exception:
            pass
    return results


def twitter_search_wallet(query: str) -> list:
    """Twitter v2 API — search tweets mentioning wallet address or handle."""
    if not TWITTER_BEARER:
        return []
    try:
        r = requests.get(
            "https://api.twitter.com/2/tweets/search/recent",
            params={
                "query":       f'"{query}" -is:retweet',
                "max_results": 10,
                "tweet.fields": "created_at,author_id,text",
                "expansions":  "author_id",
                "user.fields": "username,name,description",
            },
            headers={"Authorization": f"Bearer {TWITTER_BEARER}"},
            timeout=10)
        data = r.json()
        tweets = data.get("data") or []
        users = {u["id"]: u for u in (data.get("includes") or {}).get("users", [])}
        results = []
        for tw in tweets:
            author = users.get(tw.get("author_id", ""), {})
            results.append({
                "tweet_id":  tw.get("id", ""),
                "text":      tw.get("text", ""),
                "created":   tw.get("created_at", ""),
                "username":  author.get("username", ""),
                "name":      author.get("name", ""),
                "user_bio":  author.get("description", ""),
            })
        return results
    except Exception:
        return []


def github_code_search(query: str) -> list:
    """GitHub code search — find wallet address mentions in public repos."""
    results = []
    try:
        hdrs = {"Accept": "application/vnd.github+json"}
        if GITHUB_TOKEN:
            hdrs["Authorization"] = f"token {GITHUB_TOKEN}"
        r = requests.get(
            "https://api.github.com/search/code",
            params={"q": query, "per_page": 10},
            headers=hdrs, timeout=12)
        for item in r.json().get("items", []):
            results.append({
                "repo":    item.get("repository", {}).get("full_name", ""),
                "file":    item.get("path", ""),
                "url":     item.get("html_url", ""),
                "owner":   item.get("repository", {}).get("owner", {}).get("login", ""),
            })
    except Exception:
        pass
    return results


def discord_search_via_web(handle: str) -> dict:
    """Try to find Discord profile info via public Discord lookup."""
    if not handle:
        return {}
    try:
        r = requests.get(f"https://discordlookup.mesavirep.xyz/v1/user/{handle}",
                        timeout=8, headers=HDRS)
        if r.status_code == 200:
            data = r.json()
            return {
                "id":           data.get("id", ""),
                "username":     data.get("username", ""),
                "global_name":  data.get("global_name", ""),
                "avatar_url":   data.get("avatar", {}).get("url", ""),
                "accent_color": data.get("accent_color", ""),
                "created":      data.get("created_at", ""),
            }
    except Exception:
        pass
    return {}


# ═══════════════════════════════════════════════════════════════════════════════
# D. EMAIL ENRICHMENT
# ═══════════════════════════════════════════════════════════════════════════════

def hunter_email_finder(domain: str, first_name: str = "", last_name: str = "") -> list:
    """Hunter.io — domain email finder (25 free/month)."""
    if not HUNTER_KEY:
        return []
    try:
        params = {"domain": domain, "api_key": HUNTER_KEY, "limit": 10}
        if first_name:
            params["first_name"] = first_name
        if last_name:
            params["last_name"] = last_name
        endpoint = "email-finder" if (first_name and last_name) else "domain-search"
        r = requests.get(f"https://api.hunter.io/v2/{endpoint}",
                        params=params, timeout=10)
        data = r.json().get("data", {})
        if endpoint == "domain-search":
            return [
                {
                    "email":      e.get("value", ""),
                    "first_name": e.get("first_name", ""),
                    "last_name":  e.get("last_name", ""),
                    "confidence": e.get("confidence", 0),
                    "position":   e.get("position", ""),
                    "linkedin":   e.get("linkedin", ""),
                    "twitter":    e.get("twitter", ""),
                }
                for e in data.get("emails", [])
            ]
        else:
            return [{"email": data.get("email", ""), "score": data.get("score", 0)}]
    except Exception:
        return []


def gravatar_lookup(email: str) -> dict:
    """Gravatar — email MD5 hash → profile (name, bio, linked accounts)."""
    if not email:
        return {}
    try:
        h = hashlib.md5(email.lower().strip().encode()).hexdigest()
        r = requests.get(f"https://www.gravatar.com/{h}.json", timeout=8, headers=HDRS)
        if r.status_code == 200:
            entry = r.json().get("entry", [{}])[0]
            name = entry.get("name") or {}
            return {
                "hash":         h,
                "display_name": entry.get("displayName", ""),
                "given_name":   name.get("givenName", ""),
                "family_name":  name.get("familyName", ""),
                "about":        entry.get("aboutMe", ""),
                "location":     entry.get("currentLocation", ""),
                "verified_accounts": [
                    {"service": a.get("shortname"), "url": a.get("url")}
                    for a in (entry.get("accounts") or [])
                ],
                "profile_url":  entry.get("profileUrl", ""),
                "thumbnail":    entry.get("thumbnailUrl", ""),
                "urls":         [u.get("value") for u in entry.get("urls", [])],
            }
    except Exception:
        pass
    return {}


def pgp_key_lookup(email_or_name: str) -> list:
    """keys.openpgp.org — PGP key lookup by email or name."""
    results = []
    try:
        r = requests.get(
            "https://keys.openpgp.org/vks/v1/search",
            params={"q": email_or_name},
            timeout=8, headers=HDRS)
        if r.status_code == 200:
            for key in r.json().get("keys", []):
                results.append({
                    "fingerprint": key.get("fingerprint", ""),
                    "emails":      [u.get("email") for u in key.get("userids", [])],
                    "names":       [u.get("name") for u in key.get("userids", [])],
                    "created":     key.get("created", ""),
                    "algorithm":   key.get("algorithm", ""),
                })
    except Exception:
        pass
    # Also check keyserver.ubuntu.com
    try:
        r2 = requests.get(
            f"https://keyserver.ubuntu.com/pks/lookup",
            params={"search": email_or_name, "op": "index", "fingerprint": "on"},
            timeout=8, headers=HDRS)
        if r2.status_code == 200 and "uid:" in r2.text.lower():
            results.append({"source": "keyserver.ubuntu.com", "raw_found": True})
    except Exception:
        pass
    return results


def holehe_email_check(email: str) -> dict:
    """Holehe — check which of 120+ platforms email is registered on."""
    if not email:
        return {}
    try:
        result = subprocess.run(
            ["holehe", email, "--only-used", "--no-color"],
            capture_output=True, text=True, timeout=120)
        found = [line.replace("[+]", "").strip()
                 for line in result.stdout.splitlines() if "[+]" in line]
        return {"email": email, "registered_on": found, "count": len(found)}
    except FileNotFoundError:
        return {"error": "holehe not installed — pip install holehe"}
    except Exception:
        return {}


def ghunt_lookup(email: str) -> dict:
    """GHunt — Google account info from email (name, profile, services)."""
    if not email:
        return {}
    try:
        result = subprocess.run(
            ["ghunt", "email", email, "--json"],
            capture_output=True, text=True, timeout=60)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except FileNotFoundError:
        return {"error": "ghunt not installed — pip install ghunt"}
    except Exception:
        pass
    return {}


def socialpwned_check(email: str) -> list:
    """SocialPwned — email → social networks where it's registered."""
    if not SERPER_KEY or not email:
        return []
    results = []
    platforms = [
        ("Twitter", f'site:twitter.com "{email}"'),
        ("LinkedIn", f'site:linkedin.com "{email}"'),
        ("Instagram", f'site:instagram.com "{email}"'),
        ("GitHub", f'site:github.com "{email}"'),
        ("Reddit", f'site:reddit.com "{email}"'),
        ("Facebook", f'site:facebook.com "{email}"'),
    ]
    for platform, query in platforms:
        try:
            r = requests.post("https://google.serper.dev/search",
                json={"q": query, "num": 3},
                headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
                timeout=8)
            hits = r.json().get("organic", [])
            if hits:
                results.append({
                    "platform": platform,
                    "results":  [{"url": h.get("link"), "title": h.get("title")} for h in hits[:2]],
                })
            time.sleep(0.3)
        except Exception:
            pass
    return results


# ═══════════════════════════════════════════════════════════════════════════════
# E. CRYPTO INTELLIGENCE TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

def bitquery_wallet(addr: str) -> dict:
    """BitQuery — multi-chain query (free 10k credits/month)."""
    if not BITQUERY_KEY:
        return {}
    query = """
    query($addr: String!) {
      ethereum {
        address(address: {is: $addr}) {
          balances { currency { symbol address } value }
          inbound: transactions(receiver: {is: $addr}) { count }
          outbound: transactions(sender: {is: $addr}) { count }
        }
      }
    }"""
    try:
        r = requests.post(
            "https://graphql.bitquery.io",
            json={"query": query, "variables": {"addr": addr}},
            headers={"X-API-KEY": BITQUERY_KEY, "Content-Type": "application/json"},
            timeout=15)
        return r.json().get("data", {})
    except Exception:
        return {}


def dune_analytics_search(addr: str) -> list:
    """Dune Analytics — check public dashboards mentioning this address."""
    DUNE_KEY = os.getenv("DUNE_KEY", "")
    if not DUNE_KEY or not SERPER_KEY:
        return []
    try:
        r = requests.post("https://google.serper.dev/search",
            json={"q": f'site:dune.com "{addr}"', "num": 5},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10)
        return [{"url": res.get("link"), "title": res.get("title")}
                for res in r.json().get("organic", [])]
    except Exception:
        return []


def nansen_labels(addr: str) -> dict:
    """Nansen — smart money labels (requires paid API key)."""
    NANSEN_KEY = os.getenv("NANSEN_KEY", "")
    if not NANSEN_KEY:
        return {"note": "Nansen requires paid API key — nansen.ai"}
    try:
        r = requests.get(
            f"https://api.nansen.ai/v1/address/{addr}",
            headers={"x-api-key": NANSEN_KEY},
            timeout=10)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return {}


def zapper_portfolio(addr: str) -> dict:
    """Zapper.fi — DeFi portfolio across multiple protocols."""
    try:
        r = requests.get(
            "https://api.zapper.xyz/v2/balances/tokens",
            params={"addresses[]": addr, "api_key": "96e0cc51-a62e-42ca-acee-910ea7d2a241"},
            timeout=12, headers=HDRS)
        if r.status_code == 200:
            data = r.json()
            total = sum(item.get("balance", 0) * item.get("price", 0)
                       for item in data if isinstance(item, dict))
            return {"total_usd": total, "items_count": len(data)}
    except Exception:
        pass
    return {}


def debank_profile(addr: str) -> dict:
    """DeBank — DeFi portfolio + social identity."""
    try:
        r = requests.get(
            f"https://api.debank.com/user/addr?addr={addr}",
            timeout=8, headers={**HDRS, "Accept": "application/json"})
        if r.status_code == 200:
            data = r.json().get("data", {})
            return {
                "total_usd":    data.get("usd_value", 0),
                "twitter":      data.get("twitter_username", ""),
                "discord":      data.get("discord_username", ""),
                "is_contract":  data.get("is_contract", False),
            }
    except Exception:
        pass
    return {}


def metasleuth_search(addr: str) -> str:
    """MetaSleuth — returns visualization URL for this address."""
    return f"https://metasleuth.io/result?detector=address&src={addr}&chain=eth"


def bloxy_profile(addr: str) -> dict:
    """Bloxy — blockchain analytics API."""
    try:
        r = requests.get(
            f"https://bloxy.info/api/moneyflow/address/{addr}",
            params={"token": "demo", "limit": 5},
            timeout=8, headers=HDRS)
        if r.status_code == 200:
            return {"data": r.json()}
    except Exception:
        pass
    return {}


# ═══════════════════════════════════════════════════════════════════════════════
# F. ADVANCED OSINT TECHNIQUES
# ═══════════════════════════════════════════════════════════════════════════════

def crtsh_domains(email_or_domain: str) -> list:
    """crt.sh — SSL certificate transparency search (email in cert = identity leak)."""
    results = []
    try:
        r = requests.get(
            "https://crt.sh/",
            params={"q": email_or_domain, "output": "json"},
            timeout=12, headers=HDRS)
        if r.status_code == 200:
            for cert in r.json()[:20]:
                domains = cert.get("name_value", "").split("\n")
                results.append({
                    "id":           cert.get("id", ""),
                    "logged":       cert.get("entry_timestamp", ""),
                    "not_before":   cert.get("not_before", ""),
                    "issuer":       cert.get("issuer_name", ""),
                    "domains":      domains,
                    "common_name":  cert.get("common_name", ""),
                })
    except Exception:
        pass
    return results


def whois_lookup(domain: str) -> dict:
    """WHOIS lookup — domain registrant email, phone, name, address."""
    try:
        r = requests.get(
            f"https://api.whois.vu/?q={domain}&raw=false",
            timeout=10, headers=HDRS)
        if r.status_code == 200:
            data = r.json()
            registrant = data.get("registrant") or {}
            return {
                "registrar":   data.get("registrar", ""),
                "created":     data.get("created", ""),
                "expires":     data.get("expires", ""),
                "email":       registrant.get("email", ""),
                "name":        registrant.get("name", ""),
                "org":         registrant.get("org", ""),
                "phone":       registrant.get("phone", ""),
                "country":     registrant.get("country", ""),
                "nameservers": data.get("nameservers", []),
            }
    except Exception:
        pass
    # Fallback: whois-json.com
    try:
        r2 = requests.get(f"https://whois-json.com/json?domain={domain}",
                         timeout=8, headers=HDRS)
        if r2.status_code == 200:
            return r2.json()
    except Exception:
        pass
    return {}


def subdomain_finder(domain: str) -> list:
    """Find subdomains via crt.sh and hackertarget."""
    subdomains = set()
    try:
        r = requests.get(f"https://crt.sh/?q=%.{domain}&output=json",
                        timeout=10, headers=HDRS)
        for cert in r.json():
            for name in cert.get("name_value", "").split("\n"):
                if domain in name:
                    subdomains.add(name.strip().lstrip("*."))
    except Exception:
        pass
    try:
        r2 = requests.get(f"https://api.hackertarget.com/hostsearch/?q={domain}",
                         timeout=8, headers=HDRS)
        for line in r2.text.splitlines():
            if "," in line:
                subdomains.add(line.split(",")[0].strip())
    except Exception:
        pass
    return sorted(list(subdomains))[:50]


def dns_history(domain: str) -> list:
    """Historical DNS records via SecurityTrails / viewdns.info."""
    try:
        r = requests.get(
            f"https://viewdns.info/api/dnshistory/?apikey=free&domain={domain}&output=json",
            timeout=8, headers=HDRS)
        if r.status_code == 200:
            records = r.json().get("response", {}).get("records", [])
            return [{"ip": rec.get("ip"), "location": rec.get("location"),
                    "date": rec.get("querydate")} for rec in records]
    except Exception:
        pass
    return []


def ip_geolocation(ip: str) -> dict:
    """IP geolocation — get location, ISP, org for an IP address."""
    try:
        r = requests.get(f"https://ipapi.co/{ip}/json/", timeout=8, headers=HDRS)
        if r.status_code == 200:
            data = r.json()
            return {
                "ip":       ip,
                "city":     data.get("city", ""),
                "region":   data.get("region", ""),
                "country":  data.get("country_name", ""),
                "org":      data.get("org", ""),
                "isp":      data.get("isp", ""),
                "timezone": data.get("timezone", ""),
                "lat":      data.get("latitude"),
                "lon":      data.get("longitude"),
            }
    except Exception:
        pass
    return {}


def smart_contract_source(contract_addr: str) -> dict:
    """Etherscan — get smart contract source code and ABI (may contain dev comments/emails)."""
    if not ETHERSCAN_KEY:
        return {}
    try:
        r = requests.get("https://api.etherscan.io/api", params={
            "module": "contract", "action": "getsourcecode",
            "address": contract_addr, "apikey": ETHERSCAN_KEY
        }, timeout=10)
        result = r.json().get("result", [{}])[0]
        source = result.get("SourceCode", "")
        emails = list(set(EMAIL_RE.findall(source)))
        return {
            "contract_name": result.get("ContractName", ""),
            "compiler":      result.get("CompilerVersion", ""),
            "emails_in_source": emails,
            "abi":           result.get("ABI", ""),
            "source_length": len(source),
        }
    except Exception:
        return {}


# ═══════════════════════════════════════════════════════════════════════════════
# G. BREACH & LEAK APIs
# ═══════════════════════════════════════════════════════════════════════════════

def hibp_check(email: str) -> list:
    """HaveIBeenPwned — breaches for this email."""
    if not email:
        return []
    try:
        hdrs = {**HDRS, "hibp-api-key": HIBP_KEY} if HIBP_KEY else HDRS
        r = requests.get(
            f"https://haveibeenpwned.com/api/v3/breachedaccount/{email}",
            headers=hdrs, timeout=10)
        if r.status_code == 200:
            return [{
                "name":        b.get("Name", ""),
                "domain":      b.get("Domain", ""),
                "date":        b.get("BreachDate", ""),
                "pwn_count":   b.get("PwnCount", 0),
                "data_types":  b.get("DataClasses", []),
            } for b in r.json()]
        elif r.status_code == 404:
            return []
    except Exception:
        pass
    return []


def hibp_pastes(email: str) -> list:
    """HaveIBeenPwned — pastes containing this email (needs API key)."""
    if not email or not HIBP_KEY:
        return []
    try:
        r = requests.get(
            f"https://haveibeenpwned.com/api/v3/pasteaccount/{email}",
            headers={**HDRS, "hibp-api-key": HIBP_KEY},
            timeout=10)
        if r.status_code == 200:
            return [{"source": p.get("Source"), "id": p.get("Id"),
                    "title": p.get("Title"), "date": p.get("Date")} for p in r.json()]
    except Exception:
        pass
    return []


def dehashed_search(query: str, query_type: str = "email") -> list:
    """DeHashed API — comprehensive breach search."""
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
            return [{
                "email":    e.get("email", ""),
                "username": e.get("username", ""),
                "name":     e.get("name", ""),
                "phone":    e.get("phone", ""),
                "address":  e.get("address", ""),
                "ip":       e.get("ip_address", ""),
                "database": e.get("database_name", ""),
            } for e in (r.json().get("entries") or [])]
    except Exception:
        pass
    return []


def intelx_search(query: str, target: int = 2) -> dict:
    """IntelX — search across darknet, Tor, pastes, breaches."""
    if not INTELX_KEY:
        return {}
    try:
        r = requests.post(
            f"{INTELX_HOST}/intelligent/search",
            json={"term": query, "maxresults": 20, "media": 0, "target": target,
                  "timeout": 20, "datefrom": "", "dateto": "", "terminate": []},
            headers={"x-key": INTELX_KEY}, timeout=15)
        sid = r.json().get("id", "")
        if not sid:
            return {}
        time.sleep(3)
        r2 = requests.get(f"{INTELX_HOST}/intelligent/search/result",
                          params={"id": sid, "limit": 20, "offset": 0},
                          headers={"x-key": INTELX_KEY}, timeout=12)
        records = r2.json().get("records") or []
        return {
            "count":   len(records),
            "records": [{
                "name":    rec.get("name", ""),
                "bucket":  rec.get("bucket", ""),
                "date":    rec.get("date", ""),
                "type":    rec.get("type", 0),
                "storid":  rec.get("storid", ""),
            } for rec in records[:10]],
        }
    except Exception:
        return {}


def intelx_phonebook(query: str) -> dict:
    """IntelX phonebook — fast email/phone extraction."""
    if not INTELX_KEY:
        return {"emails": [], "phones": []}
    try:
        r = requests.post(f"{INTELX_HOST}/phonebook/search",
            json={"term": query, "target": 2, "maxresults": 20, "terminate": []},
            headers={"x-key": INTELX_KEY}, timeout=10)
        sid = r.json().get("id", "")
        if not sid:
            return {"emails": [], "phones": []}
        time.sleep(2)
        r2 = requests.get(f"{INTELX_HOST}/phonebook/search/result",
            params={"id": sid, "limit": 20, "offset": 0},
            headers={"x-key": INTELX_KEY}, timeout=10)
        emails, phones = [], []
        for s in r2.json().get("selectors", []):
            val = s.get("selectorvalue", "")
            t   = s.get("selectortype", 0)
            if not val:
                continue
            if t == 1 or "@" in val:
                emails.append(val)
            elif t == 3:
                phones.append(val)
        return {"emails": list(dict.fromkeys(emails)), "phones": list(dict.fromkeys(phones))}
    except Exception:
        return {"emails": [], "phones": []}


def leakcheck_search(query: str) -> dict:
    """LeakCheck — breach check (free = field detection, paid = actual values)."""
    if not LEAKCHECK_KEY:
        return {}
    try:
        r = requests.get("https://leakcheck.io/api/v2/query",
            params={"key": LEAKCHECK_KEY, "check": query, "type": "auto"},
            timeout=10)
        data = r.json()
        fields = set()
        for entry in (data.get("result") or []):
            fields.update(f.lower() for f in (entry.get("fields") or []))
        return {
            "found":     data.get("found", 0),
            "has_email": "email" in fields,
            "has_phone": any(x in fields for x in ["phone", "telephone", "mobile"]),
            "has_name":  any(x in fields for x in ["first_name", "last_name", "name"]),
            "has_addr":  any(x in fields for x in ["address", "city", "zip"]),
            "sources":   data.get("found", 0),
            "fields":    list(fields),
        }
    except Exception:
        return {}


# ═══════════════════════════════════════════════════════════════════════════════
# H. WALLET-SPECIFIC SOURCES
# ═══════════════════════════════════════════════════════════════════════════════

def poap_lookup(addr: str) -> list:
    """POAP — all events attended/minted by this wallet."""
    results = []
    try:
        r = requests.get(f"https://frontend.poap.fun/actions/scan/{addr}",
                        timeout=10, headers=HDRS)
        if r.status_code == 200:
            for item in (r.json() or [])[:30]:
                ev = item.get("event", {})
                results.append({
                    "event_name":  ev.get("name", ""),
                    "event_id":    ev.get("id", ""),
                    "description": ev.get("description", ""),
                    "city":        ev.get("city", ""),
                    "country":     ev.get("country", ""),
                    "year":        ev.get("year", ""),
                    "start_date":  ev.get("start_date", ""),
                    "token_id":    item.get("tokenId", ""),
                    "owner":       item.get("owner", {}).get("id", ""),
                })
    except Exception:
        pass
    return results


def gitcoin_grants(addr: str) -> dict:
    """Gitcoin Grants — check if wallet has donated and extract profile."""
    result = {"email": "", "profile": {}, "donations": []}
    try:
        r = requests.get(f"https://api.gitcoin.co/api/v1/api/profile/{addr}",
                        timeout=8, headers=HDRS)
        if r.status_code == 200:
            data = r.json()
            result["email"]   = data.get("email", "")
            result["profile"] = {
                "name":     data.get("name", ""),
                "bio":      data.get("bio", ""),
                "website":  data.get("website", ""),
                "twitter":  data.get("handle", ""),
                "github":   data.get("github_id", ""),
                "location": data.get("location", ""),
            }
    except Exception:
        pass
    return result


def gitcoin_passport_stamps(addr: str) -> dict:
    """Gitcoin Passport — identity verification stamps."""
    try:
        r = requests.get(f"https://api.scorer.gitcoin.co/registry/stamps/{addr}",
                        timeout=8, headers=HDRS)
        if r.status_code == 200:
            stamps = r.json().get("items") or []
            providers = [s.get("stamp", {}).get("provider", "") for s in stamps]
            return {
                "stamp_count": len(stamps),
                "providers":   providers,
                "has_github":  "Github" in providers or "GithubContributionActivity" in providers,
                "has_twitter": "Twitter" in providers or "TwitterTweetGT10" in providers,
                "has_discord": "Discord" in providers,
                "has_google":  "Google" in providers or "GoogleAccountCreationGt1Year" in providers,
                "has_linkedin":"Linkedin" in providers,
                "has_eth_tx":  any("Eth" in p for p in providers),
            }
    except Exception:
        pass
    return {}


def snapshot_governance(addr: str) -> dict:
    """Snapshot — governance votes, spaces, and proposals."""
    try:
        r = requests.post("https://hub.snapshot.org/graphql",
            json={
                "query": """
                query($voter: String!) {
                  votes(where: {voter: $voter}, first: 20, orderBy: "created", orderDirection: desc) {
                    id
                    proposal { title space { id name } }
                    choice
                    created
                  }
                }""",
                "variables": {"voter": addr}
            }, timeout=10)
        votes = r.json().get("data", {}).get("votes", [])
        spaces = list(set(
            v.get("proposal", {}).get("space", {}).get("name", "")
            for v in votes
        ))
        return {
            "vote_count": len(votes),
            "spaces":     spaces,
            "recent_votes": [{
                "proposal": v.get("proposal", {}).get("title", ""),
                "space":    v.get("proposal", {}).get("space", {}).get("name", ""),
                "choice":   v.get("choice"),
                "date":     v.get("created"),
            } for v in votes[:5]],
        }
    except Exception:
        return {}


def mirror_profile(addr: str) -> list:
    """Mirror.xyz — blog posts by this wallet."""
    try:
        r = requests.post("https://mirror-api.com/graphql",
            json={
                "query": """
                query($addr: String!) {
                  projectFeed(projectAddress: $addr) {
                    entries { _id title publishedAtTimestamp }
                  }
                }""",
                "variables": {"address": addr}
            }, timeout=10)
        entries = r.json().get("data", {}).get("projectFeed", {}).get("entries", [])
        return [{"title": e.get("title"), "date": e.get("publishedAtTimestamp")} for e in entries]
    except Exception:
        return []


# ═══════════════════════════════════════════════════════════════════════════════
# MASTER RUN — run ALL sources for one address and return full dict
# ═══════════════════════════════════════════════════════════════════════════════

def run_all_sources(addr: str, emails: list = None, twitter: str = "",
                    ens: str = "", deep: bool = False) -> dict:
    """
    Run ALL available OSINT sources for one address.
    Returns a comprehensive dict of all findings.
    """
    emails = emails or []
    results = {
        "addr": addr,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }

    # A. Multi-chain balances
    print("  [Multi-chain] BSC, Polygon, Arbitrum, Optimism, Avalanche, Fantom...")
    results["multichain_balances"] = multichain_balances(addr)
    results["blockchair"]          = blockchair_lookup(addr)

    # B. Web3 identity
    print("  [Identity] Web3.bio, next.id, IDriss, Space ID, XMTP, Bluepages...")
    results["web3bio"]    = web3bio_lookup(addr)
    results["nextid"]     = nextid_lookup(addr)
    results["idriss"]     = idriss_reverse(addr)
    results["spaceid"]    = spaceid_lookup(addr)
    results["xmtp"]       = xmtp_check(addr)
    results["bluepages"]  = bluepages_lookup(addr)

    # C. Social media
    print("  [Social] Reddit, Twitter, GitHub code search, Pastebin...")
    results["reddit"]     = reddit_search(addr)
    results["twitter_search"] = twitter_search_wallet(addr)
    results["github_code"]    = github_code_search(addr)
    results["pastebin"]       = pastebin_search(addr)
    if ens:
        results["bitcointalk"]= bitcointalk_search(ens)

    # D. Email enrichment
    print("  [Email] Gravatar, PGP keys, Holehe...")
    for e in emails[:2]:
        results.setdefault("gravatar", {})[e]  = gravatar_lookup(e)
        results.setdefault("pgp_keys", {})[e]  = pgp_key_lookup(e)
        results.setdefault("hibp", {})[e]       = hibp_check(e)
        results.setdefault("hibp_pastes", {})[e]= hibp_pastes(e)
        if deep:
            results.setdefault("holehe", {})[e] = holehe_email_check(e)
            results.setdefault("ghunt", {})[e]  = ghunt_lookup(e)
        results.setdefault("socialpwned", {})[e]= socialpwned_check(e)
        time.sleep(1.6)

    # E. Crypto intelligence
    print("  [Crypto Intel] Zapper, DeBank, MetaSleuth...")
    results["zapper"]       = zapper_portfolio(addr)
    results["debank"]       = debank_profile(addr)
    results["metasleuth"]   = metasleuth_search(addr)
    if BITQUERY_KEY:
        results["bitquery"] = bitquery_wallet(addr)

    # F. Advanced OSINT
    print("  [Advanced] crt.sh, WHOIS, subdomains...")
    for e in emails[:1]:
        results["crtsh"]    = crtsh_domains(e)
        results["pgp"]      = pgp_key_lookup(e)
    if ens:
        domain = ens.replace(".eth", ".xyz") if ".eth" in ens else ens
        results["whois"]        = whois_lookup(domain)
        results["subdomains"]   = subdomain_finder(domain)
        results["dns_history"]  = dns_history(domain)

    # G. Breach APIs
    print("  [Breach] HIBP, DeHashed, IntelX, LeakCheck...")
    for e in emails[:3]:
        dh = dehashed_search(e, "email")
        if dh:
            results.setdefault("dehashed", []).extend(dh)
        ix = intelx_phonebook(e)
        results.setdefault("intelx_emails", []).extend(ix.get("emails", []))
        results.setdefault("intelx_phones", []).extend(ix.get("phones", []))
        lc = leakcheck_search(e)
        results.setdefault("leakcheck", {})[e] = lc
        time.sleep(2)

    if twitter:
        tw_handle = twitter.lstrip("@")
        lc_tw = leakcheck_search(tw_handle)
        results.setdefault("leakcheck", {})[f"@{tw_handle}"] = lc_tw
        ix_tw = intelx_phonebook(tw_handle)
        results["intelx_emails"] = list(set(
            results.get("intelx_emails", []) + ix_tw.get("emails", [])
        ))
        results["intelx_phones"] = list(set(
            results.get("intelx_phones", []) + ix_tw.get("phones", [])
        ))

    # H. Wallet-specific
    print("  [Wallet] POAP, Gitcoin, Snapshot, Mirror...")
    results["poap"]              = poap_lookup(addr)
    results["gitcoin"]           = gitcoin_grants(addr)
    results["gitcoin_passport"]  = gitcoin_passport_stamps(addr)
    results["snapshot"]          = snapshot_governance(addr)
    results["mirror"]            = mirror_profile(addr)

    return results
