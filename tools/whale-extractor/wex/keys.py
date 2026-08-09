"""API key rotation — MORALIS_KEYS / ANKR_KEYS / ALCHEMY_KEYS (comma-separated)."""
from __future__ import annotations

import threading
from typing import Dict, List

from .config import env

_lock = threading.Lock()
_idx: Dict[str, int] = {}


def _parse_keys(primary: str, multi: str) -> List[str]:
    keys: List[str] = []
    for chunk in (env(multi), env(primary)):
        if not chunk:
            continue
        for part in chunk.split(","):
            k = part.strip()
            if k and k not in keys:
                keys.append(k)
    # also allow bare multi-only
    return keys


def moralis_keys() -> List[str]:
    return _parse_keys("MORALIS_KEY", "MORALIS_KEYS")


def ankr_keys() -> List[str]:
    return _parse_keys("ANKR_KEY", "ANKR_KEYS")


def alchemy_keys() -> List[str]:
    return _parse_keys("ALCHEMY_KEY", "ALCHEMY_KEYS")


def next_key(pool_name: str, keys: List[str]) -> str | None:
    if not keys:
        return None
    with _lock:
        i = _idx.get(pool_name, 0)
        key = keys[i % len(keys)]
        _idx[pool_name] = i + 1
    return key


def next_moralis() -> str | None:
    return next_key("moralis", moralis_keys())


def next_ankr() -> str | None:
    return next_key("ankr", ankr_keys())


def next_alchemy() -> str | None:
    return next_key("alchemy", alchemy_keys())
