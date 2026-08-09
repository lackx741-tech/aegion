"""doctor — verify keys + config for Phase 0–2."""
from __future__ import annotations

from .config import env, load_config, load_env
from .keys import alchemy_keys, ankr_keys, moralis_keys
from .legion import fetch_legion_readiness
from .prices import fetch_prices


def run_doctor() -> int:
    load_env()
    cfg = load_config()
    m_keys = moralis_keys()
    a_keys = ankr_keys()
    al_keys = alchemy_keys()

    checks = [
        ("MORALIS_KEY(S)", len(m_keys) > 0, f"{len(m_keys)} key(s) — EVM net-worth"),
        ("ANKR_KEY(S)", len(a_keys) > 0, f"{len(a_keys)} key(s) — multi-chain portfolio"),
        ("ALCHEMY_KEY(S)", len(al_keys) > 0, f"{len(al_keys)} key(s) — legacy mega_scan"),
        ("ETHERSCAN_KEY", bool(env("ETHERSCAN_KEY")), "Legacy whale_extractor discovery"),
        ("HELIUS_KEY", bool(env("HELIUS_KEY")), "Solana (optional)"),
        ("NEYNAR_KEY", bool(env("NEYNAR_KEY")), "Farcaster discovery (optional)"),
    ]

    print("Whale Extractor v2 — doctor")
    print("=" * 50)
    for name, present, why in checks:
        flag = "OK " if present else "MISS"
        print(f"  [{flag}] {name:<28} {why}")

    prices = fetch_prices(cfg.get("price_ids"))
    print("-" * 50)
    print(
        f"  prices: ETH=${prices.get('ethereum', 0):,.0f}  "
        f"BTC=${prices.get('bitcoin', 0):,.0f}  "
        f"SOL=${prices.get('solana', 0):,.0f}"
    )
    print(
        f"  config: min_usd={cfg.get('min_usd')}  cache_ttl={cfg.get('cache_ttl_sec')}s  "
        f"checkpoint_every={cfg.get('checkpoint_every', 5)}"
    )
    print("-" * 50)
    if not m_keys and not a_keys:
        print("FAIL: set MORALIS_KEY and/or ANKR_KEY (or *_KEYS comma list) in .env")
        return 1

    readiness = fetch_legion_readiness(cfg)
    print("-" * 50)
    if readiness.ok:
        print(f"  legion ready: {', '.join(readiness.ready_families) or '(none)'}")
        print(f"  legion url:   {readiness.url}")
    else:
        print(f"  legion ready: UNAVAILABLE ({readiness.error})")

    print("READY: python -m wex scan|enrich|legion-export")
    return 0
