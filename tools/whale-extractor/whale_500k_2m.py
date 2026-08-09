"""
whale_500k_2m.py
200 individual wallets $500k-$2M, max contact extraction.
Sources: ENS all text records + Farcaster (Neynar) power users
Contact: ENS records, Farcaster bio, Twitter API, IntelX phonebook, Serper web search
"""
import sys, os, json, time, re, requests
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

WHALE_DIR = os.path.dirname(os.path.abspath(__file__))
if WHALE_DIR not in sys.path:
    sys.path.insert(0, WHALE_DIR)
os.chdir(WHALE_DIR)

from dotenv import load_dotenv
load_dotenv(".env")

from whale_extractor import (
    _alchemy_batch_rpc, _ALCHEMY_KEYS,
    fetch_ens_records, fetch_networth_moralis,
    fetch_arkham_identity, fetch_etherscan_label,
    fetch_wallet_labels, fetch_leakcheck, fetch_intelx,
    fetch_debank_public,
)

NEYNAR_KEY     = os.getenv("NEYNAR_KEY", "")
SERPER_KEY     = os.getenv("SERPER_KEY", "")
INTELX_KEY     = os.getenv("INTELX_KEY", "")
INTELX_HOST    = os.getenv("INTELX_HOST", "https://free.intelx.io")
TWITTER_BEARER = os.getenv("TWITTER_BEARER", "")
LEAKCHECK_KEY  = os.getenv("LEAKCHECK_KEY", "")

ETH_PRICE = 3200.0
try:
    r = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", timeout=6)
    ETH_PRICE = float(r.json()["ethereum"]["usd"])
except Exception:
    pass

MIN_USD    = 500_000
MAX_USD    = 2_000_000
TARGET     = 200
OUT_FILE   = "whale_500k_2m_results.json"

ENS_GRAPH = "https://api.thegraph.com/subgraphs/name/ensdomains/ens"
SKIP_ADDRS = {"0x0000000000000000000000000000000000000000"}
CEX_KW = (
    "exchange", "binance", "coinbase", "kraken", "okx", "bybit", "gate.",
    "kucoin", "huobi", "mexc", "bridge", "portal", "router", "vault", "pool",
    "fund", "deployer", "airdrop", "staking", "treasury", "multisig",
    "protocol", "foundation", "gnosis", "contract", "wormhole", "uniswap",
    "sushiswap", "curve", "aave", "compound", "maker", "dydx"
)
_STABLES = [
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6,  "USDC"),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7", 6,  "USDT"),
    ("0x6b175474e89094c44da98b954eedeac495271d0f", 18, "DAI"),
]
_BAL_SIG = "0x70a08231"

EMAIL_RE = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')


# ─── SOURCE 1: ENS ALL TEXT RECORD WALLETS ───────────────────────────────────

def fetch_ens_text_wallets() -> list:
    """All ENS wallets with any social/contact text record."""
    results = []
    seen = set()
    record_types = ["email", "com.twitter", "org.telegram", "com.github",
                    "com.discord", "url", "com.reddit", "org.keybase",
                    "location", "description", "avatar"]

    for rtype in record_types:
        cursor = ""
        page = 0
        batch_count = 0
        sys.stdout.write(f"\n  ENS '{rtype}'")
        sys.stdout.flush()

        while page < 30:
            q = """
            query($c: String!, $rt: String!) {
              resolvers(first: 1000 where: {texts_contains: [$rt], id_gt: $c}
                        orderBy: id orderDirection: asc) {
                id
                addr { id }
                domain { name }
                texts
              }
            }"""
            try:
                resp = requests.post(ENS_GRAPH,
                    json={"query": q, "variables": {"c": cursor, "rt": rtype}},
                    timeout=25)
                batch = resp.json().get("data", {}).get("resolvers", [])
            except Exception:
                break
            if not batch:
                break

            for item in batch:
                addr   = (item.get("addr") or {}).get("id", "")
                domain = (item.get("domain") or {}).get("name", "")
                if not addr or addr.lower() in SKIP_ADDRS:
                    continue
                al = addr.lower()
                if al not in seen:
                    seen.add(al)
                    results.append({
                        "addr": addr, "ens": domain,
                        "texts": item.get("texts", []),
                        "source": "ens", "fc": {}
                    })
                    batch_count += 1

            cursor = batch[-1]["id"]
            page += 1
            if len(batch) < 1000:
                break
            time.sleep(0.08)

        sys.stdout.write(f" +{batch_count} (total {len(results)})")
        sys.stdout.flush()

    print(f"\n  ENS total: {len(results)} unique wallets with text records")
    return results


# ─── SOURCE 2: FARCASTER USERS ───────────────────────────────────────────────

def fetch_farcaster_wallets() -> list:
    """Farcaster users (power users + crypto channels) with verified ETH addresses."""
    if not NEYNAR_KEY:
        print("  NEYNAR_KEY missing — skipping Farcaster")
        return []

    results = []
    seen = set()
    users = []
    headers = {"api_key": NEYNAR_KEY}

    print("\n  [Farcaster] Power users...", end="", flush=True)
    try:
        r = requests.get("https://api.neynar.com/v2/farcaster/user/power_users",
            params={"limit": 100}, headers=headers, timeout=15)
        batch = r.json().get("users", [])
        users.extend(batch)
        print(f" {len(batch)} users")
    except Exception as e:
        print(f" error: {e}")

    for channel in ["ethereum", "defi", "base", "arbitrum", "crypto", "nft", "trading"]:
        try:
            r2 = requests.get("https://api.neynar.com/v2/farcaster/channel/followers",
                params={"id": channel, "limit": 100},
                headers=headers, timeout=10)
            ch_users = r2.json().get("users", [])
            users.extend(ch_users)
            sys.stdout.write(f"\r  [Farcaster] channel/{channel}: +{len(ch_users)} (total {len(users)})  ")
            sys.stdout.flush()
            time.sleep(0.3)
        except Exception:
            pass

    print(f"\n  [Farcaster] Processing {len(users)} raw users...")

    for u in users:
        eth_addrs = (u.get("verified_addresses") or {}).get("eth_addresses", [])
        for addr_raw in eth_addrs:
            addr = addr_raw if isinstance(addr_raw, str) else (addr_raw or {}).get("address", "")
            if not addr or addr.lower() in SKIP_ADDRS:
                continue
            al = addr.lower()
            if al not in seen:
                seen.add(al)
                twitter = ""
                for acct in (u.get("verified_accounts") or []):
                    if acct.get("platform") == "twitter":
                        twitter = acct.get("username", "")
                        break

                results.append({
                    "addr": addr,
                    "ens":  u.get("username", ""),
                    "texts": [],
                    "source": "farcaster",
                    "fc": {
                        "username":        u.get("username", ""),
                        "display":         u.get("display_name", ""),
                        "bio":             (u.get("profile") or {}).get("bio", {}).get("text", ""),
                        "twitter":         twitter,
                        "follower_count":  u.get("follower_count", 0),
                        "fid":             u.get("fid", 0),
                    }
                })

    print(f"  Farcaster unique ETH addresses: {len(results)}")
    return results


# ─── BALANCE FILTER ─────────────────────────────────────────────────────────

def batch_balance_filter(cands: list) -> list:
    """Batch ETH+stable check, keep $500k-$2M range only."""
    rich = []
    total = len(cands)
    done = 0
    batch_size = 20
    batches = [cands[i:i+batch_size] for i in range(0, total, batch_size)]
    t0 = time.time()

    for batch in batches:
        calls = []
        for c in batch:
            addr = c["addr"]
            calls.append(("eth_getBalance", [addr, "latest"]))
            padded = addr[2:].lower().zfill(64)
            for contract, _, _ in _STABLES:
                calls.append(("eth_call", [{"to": contract, "data": _BAL_SIG + padded}, "latest"]))
        try:
            raw = _alchemy_batch_rpc(calls)
        except Exception:
            raw = [None] * len(calls)

        n_calls = 1 + len(_STABLES)
        for wi, c in enumerate(batch):
            base = wi * n_calls
            try:
                eth = int(raw[base], 16) / 1e18 if raw[base] and raw[base] != "0x" else 0.0
            except Exception:
                eth = 0.0
            stable_usd = 0.0
            for si, (_, decimals, _) in enumerate(_STABLES):
                try:
                    hx = raw[base + 1 + si]
                    if hx and hx != "0x":
                        stable_usd += int(hx, 16) / (10 ** decimals)
                except Exception:
                    pass
            total_usd = eth * ETH_PRICE + stable_usd
            if MIN_USD <= total_usd < MAX_USD:
                c["pre_usd"] = total_usd
                c["pre_eth"] = eth
                rich.append(c)

        done += len(batch)
        elapsed = time.time() - t0
        speed = done / elapsed if elapsed > 1 else 0
        eta = (total - done) / speed if speed > 0 else 9999
        sys.stdout.write(f"\r  [{done}/{total}] In $500k-$2M: {len(rich)}  |  {speed:.0f} w/s  |  ETA ~{eta:.0f}s  ")
        sys.stdout.flush()

    print(f"\n  Balance filter done: {len(rich)}/{total} in ${MIN_USD/1e6:.1f}M-${MAX_USD/1e6:.1f}M range")
    return rich


# ─── CONTACT ENRICHMENT ─────────────────────────────────────────────────────

def twitter_bio_email(username: str) -> tuple:
    """Twitter API v2 — get bio text (might contain email)."""
    if not TWITTER_BEARER or not username:
        return "", ""
    clean = username.lstrip("@").split("/")[-1].strip()
    if not clean:
        return "", ""
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{clean}",
            params={"user.fields": "description,url,entities,location"},
            headers={"Authorization": f"Bearer {TWITTER_BEARER}"},
            timeout=8)
        data = r.json().get("data", {})
        desc = data.get("description", "")
        m = EMAIL_RE.search(desc)
        email = m.group(0) if m else ""
        return desc, email
    except Exception:
        return "", ""


def intelx_search(query: str) -> dict:
    """IntelX phonebook — free tier."""
    if not INTELX_KEY or not query or len(query) < 3:
        return {"emails": [], "phones": []}
    try:
        r = requests.post(f"{INTELX_HOST}/phonebook/search",
            json={"term": query, "target": 2, "maxresults": 10, "terminate": []},
            headers={"x-key": INTELX_KEY}, timeout=10)
        sid = r.json().get("id", "")
        if not sid:
            return {"emails": [], "phones": []}
        time.sleep(2)
        r2 = requests.get(f"{INTELX_HOST}/phonebook/search/result",
            params={"id": sid, "limit": 10, "offset": 0},
            headers={"x-key": INTELX_KEY}, timeout=10)
        sels = r2.json().get("selectors", [])
        emails, phones = [], []
        for s in sels:
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


def serper_search_email(query: str) -> str:
    """Serper Google search — extract email from snippets."""
    if not SERPER_KEY or not query:
        return ""
    try:
        r = requests.post("https://google.serper.dev/search",
            json={"q": f'"{query}" email contact', "num": 5},
            headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
            timeout=10)
        for res in r.json().get("organic", []):
            text = res.get("title", "") + " " + res.get("snippet", "")
            for e in EMAIL_RE.findall(text):
                if "noreply" not in e and "example" not in e and "placeholder" not in e:
                    return e
    except Exception:
        pass
    return ""


def leakcheck_check(query: str) -> dict:
    """LeakCheck free: tells us if email/phone EXIST in breaches (no values)."""
    if not LEAKCHECK_KEY or not query:
        return {"found": 0, "has_email": False, "has_phone": False}
    try:
        r = requests.get("https://leakcheck.io/api/v2/query",
            params={"key": LEAKCHECK_KEY, "check": query, "type": "auto"},
            timeout=10)
        data = r.json()
        fields_seen = set()
        for entry in (data.get("result") or []):
            for f in (entry.get("fields") or []):
                fields_seen.add(f.lower())
        return {
            "found": data.get("found", 0),
            "has_email": "email" in fields_seen,
            "has_phone": any(x in fields_seen for x in ["phone", "telephone", "mobile"]),
        }
    except Exception:
        return {"found": 0, "has_email": False, "has_phone": False}


def enrich_one(c: dict) -> dict:
    """Full contact enrichment for one wallet."""
    addr       = c["addr"]
    ens        = c.get("ens", "")
    fc         = c.get("fc", {})
    fc_user    = fc.get("username", "")
    fc_bio     = fc.get("bio", "") or ""
    source     = c.get("source", "")

    # ENS text records
    recs = {}
    if ens and "." in ens:
        try:
            recs = fetch_ens_records(ens) or {}
        except Exception:
            pass

    ens_email   = recs.get("email", "")
    twitter     = recs.get("com.twitter", "") or recs.get("twitter", "") or fc.get("twitter", "")
    telegram    = recs.get("org.telegram", "") or recs.get("telegram", "")
    github      = recs.get("com.github", "") or recs.get("github", "")
    discord     = recs.get("com.discord", "") or recs.get("discord", "")
    url         = recs.get("url", "")
    location    = recs.get("location", "")

    # Arkham identity (entity labels + twitter)
    entity = ""
    try:
        arkham = fetch_arkham_identity(addr)
        entity = arkham.get("entity_name", "")
        if not twitter and arkham.get("twitter_handle"):
            twitter = arkham["twitter_handle"]
    except Exception:
        pass

    # DeBank social
    try:
        db = fetch_debank_public(addr)
        if db and not twitter and db.get("twitter_handle"):
            twitter = db["twitter_handle"]
    except Exception:
        pass

    # Twitter bio → email
    tw_bio, tw_email = "", ""
    if twitter:
        tw_bio, tw_email = twitter_bio_email(twitter)
        time.sleep(0.3)

    # Extract email from Farcaster bio
    fc_email = ""
    if fc_bio:
        m = EMAIL_RE.search(fc_bio)
        if m:
            fc_email = m.group(0)

    # Best email so far
    email = ens_email or fc_email or tw_email

    # IntelX phonebook search (by handles)
    intelx_emails, intelx_phones = [], []
    if not email:
        for q in [fc_user, twitter.lstrip("@") if twitter else "", ens.replace(".eth", "") if ens else ""]:
            if q and len(q) > 2 and not q.startswith("0x"):
                ix = intelx_search(q)
                if ix["emails"]:
                    intelx_emails = ix["emails"]
                    email = ix["emails"][0]
                    break
                intelx_phones.extend(ix.get("phones", []))
                time.sleep(2.5)

    # Serper web search for email
    if not email:
        for q in [fc_user, twitter.lstrip("@") if twitter else "", ens]:
            if q and len(q) > 2 and not q.startswith("0x"):
                found = serper_search_email(q)
                if found:
                    email = found
                    break
                time.sleep(0.5)

    # LeakCheck: does breach data exist for this handle?
    lc = {}
    check_q = email or fc_user or twitter.lstrip("@") if twitter else ""
    if check_q and len(check_q) > 2:
        lc = leakcheck_check(check_q)

    return {
        "addr":              addr,
        "ens":               ens,
        "farcaster":         fc_user,
        "farcaster_display": fc.get("display", ""),
        "fc_followers":      fc.get("follower_count", 0),
        "balance_usd":       c.get("pre_usd", 0),
        "eth":               c.get("pre_eth", 0),
        "entity":            entity,
        "location":          location,
        # Contact fields
        "email":             email,
        "email_source":      ("ENS" if ens_email else
                              "Farcaster bio" if fc_email else
                              "Twitter bio" if tw_email else
                              "IntelX" if intelx_emails else ""),
        "telegram":          telegram,
        "twitter":           twitter,
        "twitter_bio":       tw_bio[:150] if tw_bio else "",
        "github":            github,
        "discord":           discord,
        "url":               url,
        "intelx_emails":     intelx_emails[:3],
        "intelx_phones":     intelx_phones[:3],
        # LeakCheck signal (free tier = field existence, no actual values)
        "lc_breach_count":   lc.get("found", 0),
        "lc_has_email":      lc.get("has_email", False),
        "lc_has_phone":      lc.get("has_phone", False),
        "etherscan":         f"https://etherscan.io/address/{addr}",
    }


# ─── MAIN ────────────────────────────────────────────────────────────────────

def main():
    print("=" * 65)
    print("  WHALE FINDER: $500K - $2M INDIVIDUAL WALLETS")
    print(f"  Target: {TARGET} wallets | ETH: ${ETH_PRICE:,.0f}")
    print(f"  Sources: ENS text records + Farcaster (Neynar)")
    print("=" * 65)

    # Step 1: Gather candidates from all sources
    print("\n[STEP 1] Gathering candidates...")
    ens_cands = fetch_ens_text_wallets()

    print()
    fc_cands = fetch_farcaster_wallets()

    # Merge + deduplicate
    seen = set()
    all_cands = []
    for c in ens_cands + fc_cands:
        al = c["addr"].lower()
        if al not in seen:
            seen.add(al)
            all_cands.append(c)

    print(f"\n  Total unique candidates: {len(all_cands)}")

    # Step 2: Balance filter
    print(f"\n[STEP 2] Balance filter (${MIN_USD/1e6:.1f}M - ${MAX_USD/1e6:.1f}M)...")
    rich = batch_balance_filter(all_cands)

    if not rich:
        print("  ERROR: 0 wallets passed balance filter. Check Alchemy keys.")
        return

    # Sort: more social signals first, then by balance
    def score(c):
        texts = c.get("texts", [])
        fc    = c.get("fc", {})
        return (
            len(texts) +
            (4 if fc.get("username") else 0) +
            (2 if fc.get("twitter") else 0),
            c.get("pre_usd", 0)
        )
    rich.sort(key=score, reverse=True)

    # Step 3: Filter CEX/protocol/contract
    print(f"\n[STEP 3] Filtering exchanges/protocols from {len(rich)} wallets...")
    personal = []
    skip_count = 0

    for c in rich:
        if len(personal) >= TARGET:
            break
        addr = c["addr"]
        try:
            es_label = fetch_etherscan_label(addr)
            if es_label and any(k in es_label.lower() for k in CEX_KW):
                skip_count += 1
                continue
            labels, _ = fetch_wallet_labels(addr)
            if any(l in labels for l in ("cex", "contract", "exchange")):
                skip_count += 1
                continue
        except Exception:
            pass
        personal.append(c)

    print(f"  Personal wallets: {len(personal)} (skipped {skip_count} CEX/contracts)")

    if not personal:
        print("  ERROR: All wallets were filtered as CEX/contract!")
        return

    # Step 4: Contact enrichment
    n_enrich = min(len(personal), TARGET)
    print(f"\n[STEP 4] Contact enrichment for {n_enrich} wallets...")
    print("  (ENS records + Twitter bio + IntelX + Serper)")
    results = []

    for i, c in enumerate(personal[:n_enrich]):
        ens    = c.get("ens", "")
        fc_u   = c.get("fc", {}).get("username", "")
        pre    = c.get("pre_usd", 0)
        label  = ens or fc_u or c["addr"][:16]

        sys.stdout.write(f"\r  [{i+1}/{n_enrich}] {label}... (${pre:,.0f})  ")
        sys.stdout.flush()

        enriched = enrich_one(c)
        results.append(enriched)

        if len(results) % 10 == 0:
            with open(OUT_FILE, "w", encoding="utf-8") as f:
                json.dump(results, f, indent=2, default=str)

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, default=str)

    # ─── SUMMARY ─────────────────────────────────────────────────────────────
    print(f"\n\n{'='*65}")
    print(f"  RESULTS: {len(results)} WALLETS $500K-$2M")
    print(f"{'='*65}")

    with_email     = [w for w in results if w["email"]]
    with_telegram  = [w for w in results if w["telegram"]]
    with_twitter   = [w for w in results if w["twitter"]]
    with_farcaster = [w for w in results if w["farcaster"]]
    with_phone     = [w for w in results if w["intelx_phones"]]
    lc_email       = [w for w in results if w.get("lc_has_email")]
    lc_phone       = [w for w in results if w.get("lc_has_phone")]

    print(f"\n  Contact Stats:")
    print(f"  Email (found)       : {len(with_email):>4} / {len(results)}")
    print(f"  Email (LeakCheck*)  : {len(lc_email):>4} / {len(results)}  (* paid key unlocks actual values)")
    print(f"  Telegram            : {len(with_telegram):>4} / {len(results)}")
    print(f"  Twitter             : {len(with_twitter):>4} / {len(results)}")
    print(f"  Farcaster           : {len(with_farcaster):>4} / {len(results)}")
    print(f"  Phone (IntelX free) : {len(with_phone):>4} / {len(results)}")
    print(f"  Phone (LeakCheck*)  : {len(lc_phone):>4} / {len(results)}")

    # Sort by contact richness
    def contact_score(w):
        return (
            bool(w["email"]) * 5 +
            bool(w["telegram"]) * 3 +
            bool(w["twitter"]) * 2 +
            bool(w["farcaster"]) * 2 +
            bool(w["intelx_phones"]) * 2 +
            w.get("lc_has_email", False) * 1 +
            w.get("lc_has_phone", False) * 1,
            w["balance_usd"]
        )

    results_sorted = sorted(results, key=contact_score, reverse=True)

    print(f"\n  TOP 30 by contact richness:")
    print(f"  {'─'*61}")

    for i, w in enumerate(results_sorted[:30], 1):
        print(f"\n  #{i}  {w['ens'] or w['farcaster'] or w['addr'][:20]}...")
        if w["entity"]:          print(f"       Entity    : {w['entity']}")
        if w["farcaster_display"]: print(f"       FC Name   : {w['farcaster_display']}")
        print(f"       Balance   : ${w['balance_usd']:>12,.0f}  |  ETH: {w['eth']:.2f}")
        if w["location"]:        print(f"       Location  : {w['location']}")
        print(f"  ── CONTACTS ──")
        print(f"  Email     : {w['email'] or '—'}  {('('+w['email_source']+')') if w['email_source'] else ''}")
        print(f"  Telegram  : {w['telegram'] or '—'}")
        print(f"  Twitter   : {('@'+w['twitter'].lstrip('@')) if w['twitter'] else '—'}")
        if w["farcaster"]:       print(f"  Farcaster : @{w['farcaster']} ({w['fc_followers']} followers)")
        if w["github"]:          print(f"  GitHub    : {w['github']}")
        if w["discord"]:         print(f"  Discord   : {w['discord']}")
        if w["url"]:             print(f"  Website   : {w['url']}")
        if w["intelx_phones"]:   print(f"  Phone     : {w['intelx_phones'][0]}")
        if w.get("lc_breach_count", 0) > 0:
            lc_fields = []
            if w["lc_has_email"]: lc_fields.append("email")
            if w["lc_has_phone"]: lc_fields.append("phone")
            print(f"  LeakCheck : {w['lc_breach_count']} breaches found | Fields: {', '.join(lc_fields) or 'none'} (paid key = actual values)")
        if w["twitter_bio"]:     print(f"  TW Bio    : {w['twitter_bio'][:80]}...")
        print(f"  EtherScan : {w['etherscan']}")

    print(f"\n\n  Full data saved to {OUT_FILE}")
    print(f"  Total: {len(results)} wallets | {len(with_email)} with email | {len(with_farcaster)} with Farcaster")


if __name__ == "__main__":
    main()
