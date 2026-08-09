"""Scan checkpoint — crash-safe resume (Phase 2)."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .config import ROOT


def checkpoint_path(job_id: str, cfg: dict) -> Path:
    folder = ROOT / str(cfg.get("checkpoint_dir") or ".checkpoints")
    folder.mkdir(parents=True, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in job_id)[:80]
    return folder / f"{safe}.json"


def load_checkpoint(job_id: str, cfg: dict) -> dict[str, Any] | None:
    path = checkpoint_path(job_id, cfg)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_checkpoint(
    job_id: str,
    cfg: dict,
    *,
    addresses: list[str],
    done: dict[str, Any],
    rows: list[dict[str, Any]],
    meta: dict[str, Any] | None = None,
) -> Path:
    path = checkpoint_path(job_id, cfg)
    payload = {
        "job_id": job_id,
        "updated_at": time.time(),
        "addresses": addresses,
        "done": done,
        "rows": rows,
        "meta": meta or {},
    }
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return path


def clear_checkpoint(job_id: str, cfg: dict) -> None:
    path = checkpoint_path(job_id, cfg)
    if path.exists():
        path.unlink()
