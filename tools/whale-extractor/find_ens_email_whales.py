"""
find_ens_email_whales.py — ENS wallets with ACTUAL email records, $2M+ balance
Most targeted approach: ENS -> email -> balance filter -> contact info
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
    fetch_eth_balance, fetch_token_portfolio,
    fetch_arkham_identity, fetch_etherscan_label,
    fetch_wallet_labels, fetch_leakcheck, fetch_intelx,
    fetch_web_osint, fetch_debank_public,
)

ETH_PRICE = 3200.0
try:
    r = requests.get("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", timeout=6)
    ETH_PRICE = float(r.json()["ethereum"]["usd"])
except Exception:
    pass

ENS_GRAPH = "https://api.thegraph.com/subgraphs/name/ensdomains/ens"

_SKIP_ADDRS = {
    "0x00000000000000000000000000000000000000000",
    "0x0000000000000000000000000000000000000000",
}

def fetch_ens_email_wallets(limit_pages: int = 50) -> list:
    """ENS subgraph — wallets with 'email' text record, return addr+domain+email."""
    results = []
    seen = set()
    cursor = ""
    page = 0

    print("Querying ENS subgraph for email records...")

    while page < limit_pages:
        query = """
        query($cursor: String!) {
          resolvers(
            first: 1000
            where: { texts_contains: ["email"], id_gt: $cursor }
            orderBy: id
            orderDirection: asc
          ) {
            id
            addr { id }
            domain { name }
            texts
          }
        }
        """
        try:
            resp = requests.post(
                ENS_GRAPH,
                json={"query": query, "variables": {"cursor": cursor}},
                timeout=25,
            )
            batch = resp.json().get("data", {}).get("resolvers", [])
        except Exception as e:
            print(f"  ENS query error: {e}")
            break

        if not batch:
            break

        for item in batch:
            addr   = (item.get("addr") or {}).get("id", "")
            domain = (item.get("domain") or {}).get("name", "")
            if not addr or addr.lower() in _SKIP_ADDRS:
                continue
            al = addr.lower()
            if al not in seen:
                seen.add(al)
                results.append({"addr": addr, "ens": domain, "texts": item.get("texts", [])})

        cursor = batch[-1]["id"]
        page += 1
        sys.stdout.write(f"\r  Page {page}: {len(results)} ENS wallets with email")
        sys.stdout.flush()

        if len(batch) < 1000:
            break
        time.sleep(0.1)

    print(f"\n  Total ENS-email wallets: {len(results)}")
    return results


_STABLES = [
    ("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 6,  "USDC"),
    ("0xdac17f958d2ee523a2206206994597c13d831ec7", 6,  "USDT"),
    ("0x6b175474e89094c44da98b954eedeac495271d0f", 18, "DAI"),
]
_BAL_SIG = "0x70a08231"


def batch_balance_filter(cands: list, min_usd: float = 2_000_000, batch_size: int = 20) -> list:
    """Batch ETH+stable balance check. Returns candidates with total >= min_usd."""
    rich = []
    total = len(cands)
    done = 0
    n_workers = max(len(_ALCHEMY_KEYS), 1)

    batches = [cands[i:i+batch_size] for i in range(0, total, batch_size)]
    t0 = time.time()

    for batch_i, batch in enumerate(batches):
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
                eth_raw = raw[base]
                eth = int(eth_raw, 16) / 1e18 if eth_raw and eth_raw != "0x" else 0.0
            except Exception:
                eth = 0.0

            stable_usd = 0.0
            for si, (_, decimals, _) in enumerate(_STABLES):
                try:
                    hexval = raw[base + 1 + si]
                    if hexval and hexval != "0x":
                        stable_usd += int(hexval, 16) / (10 ** decimals)
                except Exception:
                    pass

            total_usd = eth * ETH_PRICE + stable_usd
            if total_usd >= min_usd:
                c["pre_usd"] = total_usd
                c["pre_eth"] = eth
                rich.append(c)

        done += len(batch)
        elapsed = time.time() - t0
        speed = done / elapsed if elapsed > 1 else 0
        eta = (total - done) / speed if speed > 0 else 9999
        sys.stdout.write(
            f"\r  [{done}/{total}] Found: {len(rich)}  |  {speed:.0f} w/s  |  ETA ~{eta:.0f}s  "
        )
        sys.stdout.flush()

    print(f"\n  Pre-filter done: {len(rich)}/{total} pass ${min_usd/1e6:.0f}M ETH+stable bar")
    return rich


def full_balance(addr: str) -> tuple:
    """Full multi-chain balance (Moralis + Ankr)."""
    try:
        eth = fetch_eth_balance(addr)
        port = fetch_token_portfolio(addr)
        eth_tok = sum(float(t.get("tokenValue") or 0) for t in port)
        eth_usd = eth * ETH_PRICE + eth_tok
        moralis_usd, _ = fetch_networth_moralis(addr)
        return max(moralis_usd, eth_usd), eth, port
    except Exception:
        eth = fetch_eth_balance(addr)
        return eth * ETH_PRICE, eth, []


def main():
    MIN_USD = 2_000_000
    TARGET  = 10

    print("=" * 60)
    print("  ENS EMAIL WHALE FINDER")
    print(f"  Target: {TARGET} whales with email + ${MIN_USD/1e6:.0f}M+")
    print("=" * 60)
    print()

    # Step 1: ENS wallets with email records
    ens_cands = fetch_ens_email_wallets()
    print()

    # Step 2: Balance pre-filter
    print("Step 2: Balance pre-filter ($2M+ ETH+stables)...")
    rich = batch_balance_filter(ens_cands, min_usd=MIN_USD)
    print()

    if not rich:
        print("No wallets passed $2M filter. Lowering bar to $500k...")
        rich = batch_balance_filter(ens_cands, min_usd=500_000)
        print()

    # Sort richest first
    rich.sort(key=lambda x: x.get("pre_usd", 0), reverse=True)

    # Step 3: Full OSINT on each
    print(f"Step 3: Full OSINT on {min(len(rich), 30)} wallets...")
    results = []
    skip_cex = 0

    for c in rich[:30]:
        if len(results) >= TARGET:
            break

        addr = c["addr"]
        ens  = c["ens"]
        pre  = c.get("pre_usd", 0)
        sys.stdout.write(f"\r  [{len(results)}/{TARGET}] Enriching {ens or addr[:16]}...  (pre=${pre:,.0f})  ")
        sys.stdout.flush()

        # Skip CEX/bridge
        es_label = fetch_etherscan_label(addr)
        _CEX_KW  = ("exchange", "binance", "coinbase", "kraken", "okx", "bybit",
                     "gate.", "kucoin", "huobi", "mexc", "bridge", "portal",
                     "router", "vault", "pool", "fund", "contract", "deployer")
        if es_label and any(k in es_label.lower() for k in _CEX_KW):
            skip_cex += 1
            continue

        labels, _ = fetch_wallet_labels(addr)
        if any(l in labels for l in ("cex", "contract")):
            skip_cex += 1
            continue

        # Full multi-chain balance
        total_usd, eth, port = full_balance(addr)
        if total_usd < MIN_USD:
            continue

        # Get email from ENS records
        recs  = fetch_ens_records(ens) if ens else {}
        email = recs.get("email", "")
        if not email:
            continue  # strict: skip if no ENS email

        twitter  = recs.get("com.twitter", "") or recs.get("twitter", "")
        telegram = recs.get("org.telegram", "") or recs.get("telegram", "")
        url      = recs.get("url", "")
        github   = recs.get("com.github", "") or recs.get("github", "")
        discord  = recs.get("com.discord", "") or recs.get("discord", "")

        # Arkham entity
        arkham = fetch_arkham_identity(addr)
        entity = arkham.get("entity_name", "") or es_label or ""
        if arkham.get("twitter_handle") and not twitter:
            twitter = arkham["twitter_handle"]

        # DeBank social
        db = fetch_debank_public(addr)
        if db and not twitter and db.get("twitter_handle"):
            twitter = db["twitter_handle"]

        # LeakCheck on email
        breach_names, breach_phones = [], []
        if email:
            lc = fetch_leakcheck(email)
            breach_names  = lc.get("names", [])
            breach_phones = lc.get("phones", [])

        # IntelX search by email
        intelx_result = {}
        if email:
            intelx_result = fetch_intelx(email, target=1, maxresults=10)

        top5 = sorted(port, key=lambda x: float(x.get("tokenValue") or 0), reverse=True)[:5]
        tokens = ", ".join(t.get("tokenSymbol", "?") for t in top5)

        # Web mentions
        web_data = fetch_web_osint(addr)
        web_mentions = web_data.get("web_mentions", [])

        results.append({
            "addr":     addr,
            "ens":      ens,
            "balance":  total_usd,
            "eth":      eth,
            "tokens":   tokens,
            "email":    email,
            "telegram": telegram,
            "twitter":  twitter,
            "url":      url,
            "github":   github,
            "discord":  discord,
            "entity":   entity,
            "breach_names":  breach_names,
            "breach_phones": breach_phones,
            "intelx_emails": intelx_result.get("emails", []),
            "intelx_phones": intelx_result.get("phones", []),
            "web_mentions":  web_mentions[:5],
        })

    print(f"\n\n  Done. Skipped CEX/contract: {skip_cex}. Found: {len(results)} with email + $2M+.")

    # Save
    out = "ens_email_whales.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, default=str)

    # Print
    print("\n" + "=" * 60)
    print(f"  RESULTS — {len(results)} WHALES WITH EMAIL + $2M+")
    print("=" * 60)

    for i, w in enumerate(results, 1):
        print(f"\n{'─'*56}")
        print(f"  #{i}  {w['ens'] or w['addr']}")
        if w["entity"]:
            print(f"       Entity    : {w['entity']}")
        print(f"       Balance   : ${w['balance']:>14,.0f}")
        print(f"       ETH       : {w['eth']:.2f} ETH")
        print(f"       Tokens    : {w['tokens']}")
        print()
        print(f"  ── CONTACTS ──────────────")
        print(f"  Email     : {w['email']}")
        print(f"  Telegram  : {w['telegram'] or '—'}")
        print(f"  Twitter   : {w['twitter'] or '—'}")
        print(f"  GitHub    : {w['github'] or '—'}")
        print(f"  Discord   : {w['discord'] or '—'}")
        print(f"  Website   : {w['url'] or '—'}")
        if w["breach_names"]:
            print(f"  Name (breach): {w['breach_names'][0]}")
        if w["breach_phones"]:
            print(f"  Phone (breach): {w['breach_phones'][0]}")
        if w["intelx_emails"]:
            print(f"  IntelX emails : {', '.join(w['intelx_emails'][:3])}")
        if w["web_mentions"]:
            print(f"  Web refs  : {w['web_mentions'][0]}")
        print(f"  On-chain  : https://etherscan.io/address/{w['addr']}")

    print(f"\n\n  Results saved -> {out}")


if __name__ == "__main__":
    main()
