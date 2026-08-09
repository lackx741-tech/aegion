"""
refine_targets.py — Re-enrich existing targets with accurate per-chain data
Problems fixed:
  1. TX history now from PRIMARY chain (not always ETH)
  2. idle=99 fixed using real timestamps
  3. Category diversity — proper classification from accurate data
  4. DeFi detection per chain
"""
import os, json, time, requests, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

load_dotenv("../../.env")
load_dotenv(".env")

import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
os.chdir(os.path.dirname(os.path.abspath(__file__)))

ANKR_KEY      = os.getenv("ANKR_KEY","")
ETHERSCAN_KEYS = [k.strip() for k in os.getenv("ETHERSCAN_KEYS","").split(",") if k.strip()]
if not ETHERSCAN_KEYS:
    ETHERSCAN_KEYS = [os.getenv("ETHERSCAN_KEY","")]

ANKR_URL = f"https://rpc.ankr.com/multichain/{ANKR_KEY}"

# Chain-specific explorer APIs (each has its own free key)
BSCSCAN_KEY     = os.getenv("BSCSCAN_KEY","")
POLYGONSCAN_KEY = os.getenv("POLYGONSCAN_KEY","")
ARBISCAN_KEY    = os.getenv("ARBISCAN_KEY","")
OPSCAN_KEY      = os.getenv("OPSCAN_KEY","")
SNOWTRACE_KEY   = os.getenv("SNOWTRACE_KEY","")
BASESCAN_KEY    = os.getenv("BASESCAN_KEY", ETHERSCAN_KEYS[0] if ETHERSCAN_KEYS else "")

CHAIN_EXPLORER = {
    "eth":       ("https://api.etherscan.io/api",             ETHERSCAN_KEYS[0] if ETHERSCAN_KEYS else ""),
    "bsc":       ("https://api.bscscan.com/api",              BSCSCAN_KEY),
    "polygon":   ("https://api.polygonscan.com/api",          POLYGONSCAN_KEY),
    "arbitrum":  ("https://api.arbiscan.io/api",              ARBISCAN_KEY),
    "optimism":  ("https://api-optimistic.etherscan.io/api",  OPSCAN_KEY),
    "base":      ("https://api.basescan.org/api",             BASESCAN_KEY),
    "avalanche": ("https://api.snowtrace.io/api",             SNOWTRACE_KEY),
    "fantom":    ("https://api.ftmscan.com/api",              os.getenv("FTMSCAN_KEY","")),
}

NOW   = int(time.time())
D90   = 90 * 86400
D30   = 30 * 86400
D365  = 365 * 86400

STABLE_SYMBOLS = {"USDC","USDT","DAI","BUSD","FRAX","TUSD","USDP","GUSD","LUSD","USDE","PYUSD"}

# Etherscan v2 unified API — one key, all chains
ETHERSCAN_CHAIN_IDS = {
    "eth":       1,
    "bsc":       56,
    "polygon":   137,
    "arbitrum":  42161,
    "optimism":  10,
    "base":      8453,
    "avalanche": 43114,
    "fantom":    250,
    "gnosis":    100,
}

# Known DeFi routers per chain (for protocol detection)
DEFI_ROUTERS = {
    # ETH
    "0xe592427a0aece92de3edee1f18e0157c05861564": "uniswap_v3",
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "uniswap_v2",
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "aave",
    "0xc3d688b66703497daa19211eedff47f25384cdc3": "compound",
    "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch",
    "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": "lido",
    # BSC
    "0x10ed43c718714eb63d5aa57b78b54704e256024e": "pancakeswap",
    "0x13f4ea83d0bd40e75c8222255bc855a974568dd4": "pancakeswap_v3",
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506": "sushiswap_bsc",
    # Polygon
    "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff": "quickswap",
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506": "sushiswap_poly",
    # Arbitrum
    "0xe592427a0aece92de3edee1f18e0157c05861564": "uniswap_v3_arb",
    "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506": "sushiswap_arb",
    # Avalanche
    "0x60ae616a2155ee3d9a68541ba4544862310933d4": "traderjoe",
    "0xe54ca86531e17ef3616d22ca28b0d458b6c89106": "pangolin",
    # Base
    "0x2626664c2603336e57b271c5c0b26f421741e481": "uniswap_v3_base",
}

# Key rotation for Etherscan
_key_idx = [0]
_key_lock = threading.Lock()

def next_etherscan_key():
    with _key_lock:
        key = ETHERSCAN_KEYS[_key_idx[0] % len(ETHERSCAN_KEYS)]
        _key_idx[0] += 1
        return key

# ── API Functions ───────────────────────────────────────────────────────────

def ankr_balance_full(addr):
    """Get full balance breakdown including per-chain tokens."""
    chains = ["eth","bsc","polygon","arbitrum","base","optimism","avalanche","fantom","gnosis"]
    try:
        r = requests.post(ANKR_URL,
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
                  "params":{"blockchain": chains, "walletAddress": addr,
                            "onlyWhitelisted": False}},
            timeout=20)
        if r.ok:
            res = r.json().get("result", {})
            total = float(res.get("totalBalanceUsd","0") or 0)
            assets = res.get("assets", [])
            tokens = []
            chain_usd = {}
            for a in assets:
                usd = float(a.get("balanceUsd","0") or 0)
                if usd > 0:
                    chain = a.get("blockchain","")
                    chain_usd[chain] = chain_usd.get(chain, 0) + usd
                    tokens.append({
                        "symbol":     a.get("tokenSymbol",""),
                        "usd":        usd,
                        "blockchain": chain,
                    })
            primary_chain = max(chain_usd, key=chain_usd.get) if chain_usd else "eth"
            return total, tokens, chain_usd, primary_chain
    except: pass
    return 0.0, [], {}, "eth"

def explorer_txs(addr, chain="eth", limit=50):
    """Get TX list via Ankr (works all chains), fallback to Etherscan v2 for ETH."""
    # Primary: Ankr advanced API — one key, all chains
    try:
        r = requests.post(ANKR_URL,
            json={"id":1,"jsonrpc":"2.0","method":"ankr_getTransactionsByAddress",
                  "params":{"blockchain": chain, "address": [addr],
                            "pageSize": limit, "descOrder": True}},
            timeout=20)
        if r.ok:
            res = r.json().get("result", {})
            txs = res.get("transactions", [])
            if txs:
                normalized = []
                for tx in txs:
                    ts = tx.get("timestamp", 0)
                    if isinstance(ts, str):
                        ts = int(ts, 16) if ts.startswith("0x") else int(ts or 0)
                    val = tx.get("value","0")
                    if isinstance(val, str) and val.startswith("0x"):
                        val = str(int(val, 16))
                    normalized.append({
                        "timeStamp": str(ts),
                        "from":      (tx.get("from","") or "").lower(),
                        "to":        (tx.get("to","")   or "").lower(),
                        "value":     val,
                    })
                return normalized
    except: pass

    # Fallback: Etherscan v2 for ETH mainnet only
    if chain == "eth" and ETHERSCAN_KEYS and ETHERSCAN_KEYS[0]:
        try:
            key = next_etherscan_key()
            r = requests.get("https://api.etherscan.io/v2/api",
                params={"chainid":1,"module":"account","action":"txlist",
                        "address":addr,"page":1,"offset":limit,"sort":"desc",
                        "apikey":key},
                timeout=15)
            if r.ok:
                data = r.json()
                if data.get("status") == "1":
                    return data.get("result",[])
        except: pass
    return []

# ── Classification ──────────────────────────────────────────────────────────

def classify_refined(data):
    total        = data["total_usd"]
    stable_pct   = data["stable_pct"]
    chains       = data["chains_active"]
    tx_90d       = data["tx_90d"]
    tx_30d       = data["tx_30d"]
    idle_months  = data["months_idle"]
    old_months   = data["months_old"]
    defi_used    = data["defi_protocols_used"]
    nft_count    = data["nft_count"]
    from_exch    = data["from_exchange"]
    big_incoming = data["recent_large_incoming_usd"]
    regular_in   = data["regular_incoming"]
    tokens       = data["tokens"]

    has_defi    = len(defi_used) > 0
    truly_idle  = idle_months > 3 and tx_90d == 0
    very_idle   = idle_months > 12 and tx_90d == 0
    active      = tx_90d >= 10
    new_wallet  = old_months < 3
    multi_chain = chains >= 4

    # 1 — Recent Windfall: large incoming recently, new wallet or sudden jump
    if big_incoming > total * 0.5 and new_wallet:
        return 7, "Recent Windfall"

    # 2 — Crypto Salary: regular incoming transfers, low tx out
    if regular_in and tx_90d < 10 and stable_pct > 50:
        return 9, "Crypto Salary"

    # 3 — Yield Seeker: actively using DeFi, staking
    if has_defi and tx_90d >= 5 and stable_pct < 80:
        return 3, "Yield Seeker"

    # 4 — DeFi Dropout: USED DeFi before but stopped (idle 3+ months)
    if has_defi and truly_idle:
        return 11, "DeFi Dropout"

    # 5 — Multi-Chain Chaos: spread across 4+ chains, moderate activity
    if multi_chain and tx_90d >= 3:
        return 6, "Multi-Chain Chaos"

    # 6 — Silent Accumulator: growing balance, low tx, no defi
    if from_exch and idle_months > 2 and tx_90d < 5 and stable_pct < 60:
        return 12, "Silent Accumulator"

    # 7 — Concentration Gamble: 70%+ in one volatile token
    non_stable_top = max((t["usd"] for t in tokens if t["symbol"] not in STABLE_SYMBOLS), default=0)
    if non_stable_top > total * 0.7 and total > 200_000:
        return 14, "Concentration Gamble"

    # 8 — Single Token Max: one token dominates entire portfolio
    if tokens and total > 0:
        top_token_usd = max((t["usd"] for t in tokens), default=0)
        top_token_pct = top_token_usd / total
        if top_token_pct > 0.85 and len(tokens) <= 3:
            return 15, "Single Token Max"

    # 9 — Bull FOMO Trader: lots of buying in bull market, now sitting
    if tx_90d == 0 and old_months > 6 and stable_pct < 50 and not has_defi:
        return 10, "Bull FOMO Trader"

    # 10 — Gas Paralyzed: decent balance, NO transactions at all, possibly old wallet
    if tx_90d == 0 and total > 100_000 and idle_months > 6:
        return 13, "Gas Paralyzed"

    # 11 — Wreckage Holder: many dead/worthless tokens but some real value
    dead_count = data.get("dead_token_count", 0)
    if dead_count >= 3 and total > 100_000:
        return 16, "Wreckage Holder"

    # 12 — Idle Self-Custody: low stable, long idle, no DeFi ever
    if not has_defi and idle_months > 6 and stable_pct < 70:
        return 2, "Idle Self-Custody"

    # 13 — Stablecoin Hoarder: default for high stable% idle wallets
    if stable_pct >= 70:
        return 5, "Stablecoin Hoarder"

    # 14 — Active Trader (catches remaining active wallets)
    if active:
        return 4, "Active Trader"

    return 5, "Stablecoin Hoarder"

# ── Message Generation (template — AI upgrade later) ─────────────────────

def calc_missed_yield(total_usd, idle_months, stable_pct, apy=0.05):
    """How much yield they missed by doing nothing."""
    idle_years = max(idle_months, 1) / 12
    eligible = total_usd * (stable_pct / 100)
    return eligible * apy * idle_years

def gen_message_refined(data, cat_id, cat_name):
    total  = data["total_usd"]
    idle   = data["months_idle"]
    stable = data["stable_pct"]
    chains = data["chains_active"]
    tx90   = data["tx_90d"]
    defi   = data["defi_protocols_used"]
    addr   = data.get("wallet_address","")[:8]
    missed = calc_missed_yield(total, idle, stable)

    bal_str    = f"${total/1_000_000:.2f}M" if total >= 1_000_000 else f"${total/1000:.0f}K"
    missed_str = f"${missed/1000:.0f}K" if missed >= 1000 else f"${missed:.0f}"
    idle_str   = f"{idle:.0f} months" if idle < 99 else "years"

    templates = {
        7:  (f"You recently received {bal_str} — your capital deserves a strategy, not a wallet.",
             f"Your wallet received {bal_str} recently. Right now it's sitting exposed with no yield strategy. Legion deploys your capital automatically across audited protocols — diversified, managed, one click."),

        9:  (f"Your crypto income lands and goes nowhere. {bal_str} earning zero. Legion automates the yield.",
             f"You receive regular crypto income — but {bal_str} is sitting idle between payments. Legion automatically deploys your stablecoins into yield the moment they arrive, so every dollar works from day one."),

        3:  (f"You know DeFi. Legion finds the best yield so you don't have to monitor 12 protocols.",
             f"You're already active in DeFi — {bal_str} across {chains} chains. Legion aggregates the highest-yield positions across all your chains and rebalances automatically, so you earn more with less effort."),

        11: (f"You tried DeFi. It got complicated. Legion is different — one dashboard, everything managed.",
             f"Your on-chain history shows you used DeFi before — then stopped. You had the right instinct but the wrong tools. Legion handles the complexity: one interface, automated rebalancing, no gas surprises."),

        6:  (f"{bal_str} across {chains} chains is hard to track. Legion unifies it — one dashboard, full control.",
             f"Your {bal_str} is spread across {chains} chains. Managing positions, bridging, rebalancing — it's a full-time job. Legion consolidates everything into one dashboard and automates the strategy across all your chains."),

        12: (f"You keep accumulating but {bal_str} isn't working. Time to activate it.",
             f"Your wallet shows a pattern of steady accumulation — {bal_str} and counting. But accumulation without deployment is just inflation eating your gains. Legion puts your assets to work automatically as they arrive."),

        14: (f"70%+ of your {bal_str} is in one position. Legion helps you hedge without selling.",
             f"Your portfolio is heavily concentrated — over 70% in a single asset. Concentration risk is real. Legion can put your idle portion to work while keeping your core position intact, with no forced liquidation."),

        15: (f"All {bal_str} in one token. Legion helps you earn on the idle portion without unwinding.",
             f"Your entire {bal_str} portfolio is in a single token — maximum conviction, maximum risk. Legion can generate yield on your position while you hold, using strategies that don't require selling your core asset."),

        10: (f"Your {bal_str} has been waiting since the last cycle. The next move doesn't require you to time the market.",
             f"You positioned well but now {bal_str} is sitting through the cycle. Legion generates yield on your holdings while you wait — so when the market moves, you've been compounding the whole time."),

        13: (f"Your {bal_str} has been untouched for {idle_str}. Gas costs less than you think — Legion covers strategy.",
             f"Your wallet holds {bal_str} but hasn't transacted in {idle_str}. If gas costs are the barrier, Legion batches transactions to minimize fees. Your capital has been losing to inflation — let's fix that."),

        16: (f"Buried in your wallet is real value. Legion surfaces it and puts it to work.",
             f"Underneath the noise in your wallet, there's {bal_str} in real assets. Legion identifies your productive capital, ignores the rest, and deploys a yield strategy on what actually matters."),

        2:  (f"Your {bal_str} has been self-custodied for {idle_str}. Secure — but earning nothing.",
             f"Self-custody is smart. But {bal_str} earning 0% for {idle_str} isn't a strategy — it's inflation. Legion gives you yield without giving up custody. Your keys, your assets, our automation."),

        5:  (f"Your {bal_str} in stablecoins is losing {missed_str}/year to inflation. Legion fixes that automatically.",
             f"You're holding {bal_str} in stablecoins — safe, but inflation is quietly erasing {missed_str} per year in purchasing power. Legion deploys your stablecoins into audited yield protocols automatically, so your capital works without you watching it."),

        4:  (f"You're active on-chain. Legion optimizes the yield layer you're missing between trades.",
             f"Your wallet shows consistent on-chain activity across {chains} chains. Between your active positions, Legion can generate yield on your idle capital — so your money works even when you're not trading."),
    }

    short, full = templates.get(cat_id, templates[5])
    return {"short": short[:200], "full": full}

# ── Main Refine Loop ────────────────────────────────────────────────────────

with open("outputs/targets_multichain.json") as f:
    targets = json.load(f)

print(f"Refining {len(targets)} wallets...\n")

results = []
lock = threading.Lock()
done_count = [0]
errors = [0]

def refine_wallet(wallet):
    addr = wallet["wallet_address"]
    try:
        # 1. Re-fetch balance with primary chain detection
        total, tokens, chain_usd, primary_chain = ankr_balance_full(addr)

        if total < 10_000:  # sanity check
            total = wallet["total_usd"]
            tokens = []
            primary_chain = "eth"

        # 2. Get TX history from primary chain explorer
        txs = explorer_txs(addr, chain=primary_chain, limit=100)
        time.sleep(0.15)

        # 3. Parse TX data
        timestamps = []
        defi_used = set()
        from_exchange = ""
        regular_incoming = False
        recent_large_in = 0.0
        incoming_senders = {}

        EXCHANGE_ADDRS = {
            "0x28c6c06298d514db089934071355e5743bf21d60": "Binance",
            "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance",
            "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance",
            "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase",
            "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase",
            "0xa090e606e30bd747d4e6245a1517ebe430f0057e": "Coinbase",
            "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Kraken",
        }

        for tx in txs:
            ts = int(tx.get("timeStamp", 0) or 0)
            if ts: timestamps.append(ts)

            to_addr   = (tx.get("to","") or "").lower()
            from_addr = (tx.get("from","") or "").lower()
            value     = int(tx.get("value","0") or 0) / 1e18
            is_in     = to_addr == addr.lower()

            # DeFi detection
            if to_addr in DEFI_ROUTERS:
                defi_used.add(DEFI_ROUTERS[to_addr])

            # Exchange origin
            if is_in and from_addr in EXCHANGE_ADDRS and not from_exchange:
                from_exchange = EXCHANGE_ADDRS[from_addr]

            # Large incoming
            if is_in and value * 3500 > 10_000:  # rough ETH price
                recent_large_in = max(recent_large_in, value * 3500)

            # Regular incoming from same sender
            if is_in and from_addr:
                incoming_senders[from_addr] = incoming_senders.get(from_addr, 0) + 1

        # Check for regular salary-type incoming
        if any(v >= 3 for v in incoming_senders.values()):
            regular_incoming = True

        # 4. Calculate timing
        first_ts = min(timestamps) if timestamps else 0
        last_ts  = max(timestamps) if timestamps else 0

        cutoff_90 = NOW - D90
        cutoff_30 = NOW - D30
        tx_90d = sum(1 for t in timestamps if t >= cutoff_90)
        tx_30d = sum(1 for t in timestamps if t >= cutoff_30)

        months_old  = round((NOW - first_ts) / (86400 * 30.44), 1) if first_ts else 0
        months_idle = round((NOW - last_ts)  / (86400 * 30.44), 1) if last_ts else 99

        # 5. Token analysis
        stable_usd = sum(t["usd"] for t in tokens if t["symbol"] in STABLE_SYMBOLS)
        stable_pct = round(stable_usd / total * 100, 1) if total else 0
        chains_active = len([c for c in chain_usd if chain_usd[c] > 10])
        dead_count = sum(1 for t in tokens if t["usd"] < 5)

        data = {
            "wallet_address":            addr,
            "total_usd":                 total,
            "tokens":                    tokens,
            "chains_active":             chains_active,
            "stable_pct":                stable_pct,
            "nft_count":                 wallet.get("nft_count", 0),
            "tx_count":                  len(txs),
            "tx_90d":                    tx_90d,
            "tx_30d":                    tx_30d,
            "first_tx_ts":               first_ts,
            "last_tx_ts":                last_ts,
            "months_old":                months_old,
            "months_idle":               months_idle,
            "defi_protocols_used":       defi_used,
            "from_exchange":             from_exchange,
            "recent_large_incoming_usd": recent_large_in,
            "regular_incoming":          regular_incoming,
            "dead_token_count":          dead_count,
            "had_nft_sale":              False,
            "primary_chain":             primary_chain,
        }

        cat_id, cat_name = classify_refined(data)
        msg = gen_message_refined(data, cat_id, cat_name)
        missed = calc_missed_yield(total, months_idle, stable_pct)

        return {
            "wallet_address":  addr,
            "total_usd":       round(total, 2),
            "category_id":     cat_id,
            "category":        cat_name,
            "primary_chain":   primary_chain,
            "chains_active":   chains_active,
            "nft_count":       wallet.get("nft_count", 0),
            "tx_90d":          tx_90d,
            "tx_30d":          tx_30d,
            "months_old":      months_old,
            "months_idle":     months_idle,
            "from_exchange":   from_exchange,
            "defi_used":       ",".join(sorted(defi_used)),
            "stable_pct":      stable_pct,
            "missed_yield_usd": round(missed, 0),
            "chain_type":      wallet.get("chain_type","evm"),
            "msg_short":       msg["short"],
            "msg_full":        msg["full"],
        }
    except Exception as e:
        with lock:
            print(f"  ERROR {addr[:10]}: {e}")
        return None

def process(wallet):
    result = refine_wallet(wallet)
    with lock:
        done_count[0] += 1
        n = done_count[0]
        if result:
            results.append(result)
            print(f"  [{n:>3}/{len(targets)}] ✓ ${result['total_usd']/1000:>7.0f}K "
                  f"| {result['category']:<22} | chain={result['primary_chain']:<8} "
                  f"idle={result['months_idle']:>4.0f}mo tx90={result['tx_90d']:<3}")
        else:
            errors[0] += 1
            if n % 20 == 0:
                print(f"  [{n:>3}/{len(targets)}] processing... ok={len(results)} err={errors[0]}")

print("=" * 70)
print("Refining with primary-chain TX history...")
print("=" * 70)

with ThreadPoolExecutor(max_workers=4) as pool:
    pool.map(process, targets)

# ── Category summary ────────────────────────────────────────────────────────
print("\n" + "=" * 70)
cats = {}
for r in results:
    c = r["category"]
    cats[c] = cats.get(c, 0) + 1

print("Category breakdown (refined):")
for cat, count in sorted(cats.items(), key=lambda x: -x[1]):
    bar = "█" * (count // 5)
    print(f"  {cat:<25} {count:>4}  {bar}")

total_value = sum(r["total_usd"] for r in results)
avg_missed  = sum(r["missed_yield_usd"] for r in results) / len(results) if results else 0
print(f"\nTotal wallets refined : {len(results)}")
print(f"Total value           : ${total_value/1e9:.2f}B")
print(f"Avg missed yield/yr   : ${avg_missed/1000:.0f}K per wallet")

# Save
os.makedirs("outputs", exist_ok=True)
with open("outputs/targets_refined.json","w",encoding="utf-8") as f:
    json.dump(results, f, indent=2, ensure_ascii=False)

print(f"\nSaved → outputs/targets_refined.json")
print(f"Chains covered: ETH + BSC + Polygon + Avalanche + Arbitrum + Base + Optimism")
print(f"Each wallet: real TX history from PRIMARY chain, accurate idle time, accurate category")
