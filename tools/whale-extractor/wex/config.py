"""Load config.yaml + .env for wex."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config.yaml"


def load_env() -> None:
    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT / ".env.local", override=True)


def load_config(path: Path | None = None) -> dict[str, Any]:
    cfg_path = path or DEFAULT_CONFIG
    if not cfg_path.exists():
        return {
            "min_usd": 10_000,
            "active_chain_min_usd": 100,
            "moralis_chains": ["eth", "bsc", "polygon", "arbitrum", "base", "optimism"],
            "moralis_fallback_chains": ["eth", "bsc", "polygon", "arbitrum", "base", "optimism"],
            "ankr_chains": ["eth", "bsc", "polygon", "arbitrum", "base", "optimism", "avalanche", "fantom"],
            "request_timeout_sec": 25,
            "retry_max": 3,
            "out_dir": "out",
        }
    with cfg_path.open(encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return data


def env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()
