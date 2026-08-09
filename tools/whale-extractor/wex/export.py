"""JSON/CSV export under out/YYYYMMDD/."""
from __future__ import annotations

import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def make_out_dir(root: Path, out_dir_name: str = "out") -> Path:
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    path = root / out_dir_name / day
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_json(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2, default=str)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = [
        "rank",
        "address",
        "total_usd",
        "moralis_usd",
        "ankr_usd",
        "chains_active",
        "top_assets",
        "etherscan",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for i, row in enumerate(rows, 1):
            w.writerow(
                {
                    "rank": i,
                    "address": row.get("address", ""),
                    "total_usd": row.get("total_usd", 0),
                    "moralis_usd": row.get("moralis_usd", 0),
                    "ankr_usd": row.get("ankr_usd", 0),
                    "chains_active": row.get("chains_active", ""),
                    "top_assets": row.get("top_assets", ""),
                    "etherscan": f"https://etherscan.io/address/{row.get('address', '')}",
                }
            )


def _field_val(row: dict[str, Any], key: str) -> str:
    block = row.get(key)
    if isinstance(block, dict):
        return str(block.get("value") or "")
    return ""


def _field_quality(row: dict[str, Any], key: str) -> str:
    block = row.get(key)
    if isinstance(block, dict):
        return str(block.get("quality") or "none")
    return "none"


def write_enrich_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = [
        "rank",
        "address",
        "best_channel",
        "ens",
        "ens_q",
        "email",
        "email_q",
        "twitter",
        "twitter_q",
        "farcaster",
        "farcaster_q",
        "telegram",
        "telegram_q",
        "url",
        "display_name",
        "etherscan",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for i, row in enumerate(rows, 1):
            w.writerow(
                {
                    "rank": i,
                    "address": row.get("address", ""),
                    "best_channel": row.get("best_channel", ""),
                    "ens": _field_val(row, "ens"),
                    "ens_q": _field_quality(row, "ens"),
                    "email": _field_val(row, "email"),
                    "email_q": _field_quality(row, "email"),
                    "twitter": _field_val(row, "twitter"),
                    "twitter_q": _field_quality(row, "twitter"),
                    "farcaster": _field_val(row, "farcaster"),
                    "farcaster_q": _field_quality(row, "farcaster"),
                    "telegram": _field_val(row, "telegram"),
                    "telegram_q": _field_quality(row, "telegram"),
                    "url": _field_val(row, "url"),
                    "display_name": row.get("display_name", ""),
                    "etherscan": f"https://etherscan.io/address/{row.get('address', '')}",
                }
            )

def write_legion_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = [
        "rank",
        "address",
        "family",
        "families",
        "chains",
        "usd",
        "tags",
        "legion_ready",
        "etherscan",
    ]
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for i, row in enumerate(rows, 1):
            w.writerow(
                {
                    "rank": i,
                    "address": row.get("address", ""),
                    "family": row.get("family", ""),
                    "families": ",".join(row.get("families") or []),
                    "chains": ",".join(row.get("chains") or []),
                    "usd": row.get("usd", 0),
                    "tags": ",".join(row.get("tags") or []),
                    "legion_ready": row.get("legion_ready", True),
                    "etherscan": row.get("etherscan", ""),
                }
            )
