"""Live USD prices via CoinGecko (with fallbacks)."""
from __future__ import annotations

import time
from typing import Dict

import requests

_CACHE: dict[str, float] = {}
_CACHE_AT = 0.0
_TTL = 600.0

_FALLBACK = {
    "ethereum": 3500.0,
    "bitcoin": 95000.0,
    "solana": 150.0,
    "tron": 0.25,
    "the-open-network": 5.0,
    "cosmos": 8.0,
    "aptos": 8.0,
    "sui": 2.5,
    "polkadot": 7.0,
    "algorand": 0.2,
    "cardano": 0.45,
}

# aliases used in portfolio code
_ALIASES = {
    "eth": "ethereum",
    "btc": "bitcoin",
    "sol": "solana",
    "trx": "tron",
    "ton": "the-open-network",
    "atom": "cosmos",
    "apt": "aptos",
    "sui": "sui",
    "dot": "polkadot",
    "algo": "algorand",
    "ada": "cardano",
}


def fetch_prices(ids: list[str] | None = None, timeout: int = 15) -> Dict[str, float]:
    global _CACHE, _CACHE_AT
    now = time.time()
    if _CACHE and (now - _CACHE_AT) < _TTL:
        return dict(_CACHE)

    want = ids or list(_FALLBACK.keys())
    prices = dict(_FALLBACK)
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": ",".join(want), "vs_currencies": "usd"},
            timeout=timeout,
        )
        if r.ok:
            data = r.json()
            for k, v in data.items():
                usd = float((v or {}).get("usd") or 0)
                if usd > 0:
                    prices[k] = usd
    except Exception:
        pass

    _CACHE = prices
    _CACHE_AT = now
    return dict(prices)


def price(symbol_or_id: str, prices: Dict[str, float] | None = None) -> float:
    table = prices or fetch_prices()
    key = symbol_or_id.lower().strip()
    key = _ALIASES.get(key, key)
    return float(table.get(key) or _FALLBACK.get(key) or 0.0)
