"""File-backed JSON cache with TTL (Phase 2)."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from .config import ROOT


def _cache_dir(cfg: dict) -> Path:
    name = str(cfg.get("cache_dir") or ".asset-cache")
    path = ROOT / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_key(*parts: str) -> str:
    raw = "|".join(str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def cache_get(cfg: dict, key: str) -> Any | None:
    if cfg.get("cache_disabled"):
        return None
    ttl = float(cfg.get("cache_ttl_sec") or 600)
    path = _cache_dir(cfg) / f"{key}.json"
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        ts = float(payload.get("ts") or 0)
        if time.time() - ts > ttl:
            return None
        return payload.get("data")
    except Exception:
        return None


def cache_set(cfg: dict, key: str, data: Any) -> None:
    if cfg.get("cache_disabled"):
        return
    path = _cache_dir(cfg) / f"{key}.json"
    try:
        path.write_text(
            json.dumps({"ts": time.time(), "data": data}, default=str),
            encoding="utf-8",
        )
    except Exception:
        pass
