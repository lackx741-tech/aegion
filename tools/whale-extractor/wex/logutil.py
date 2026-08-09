"""Structured logging — human line + optional JSONL."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

from .config import ROOT

_jsonl: Path | None = None
_json_mode = False


def setup_logging(cfg: dict, *, json_logs: bool = False, job_id: str | None = None) -> None:
    global _jsonl, _json_mode
    _json_mode = json_logs
    log_dir = ROOT / str(cfg.get("log_dir") or "logs")
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d")
    name = f"wex_{stamp}_{job_id or 'run'}.jsonl"
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in name)
    _jsonl = log_dir / safe


def log_event(level: str, msg: str, **fields: Any) -> None:
    row = {"ts": time.time(), "level": level, "msg": msg, **fields}
    line = f"[{level}] {msg}"
    if fields:
        extra = " ".join(f"{k}={v}" for k, v in fields.items() if k not in ("msg",))
        if extra:
            line = f"{line} | {extra}"
    print(line, file=sys.stderr if level in ("ERROR", "WARN") else sys.stdout)
    if _jsonl is not None:
        try:
            with _jsonl.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, default=str) + "\n")
        except Exception:
            pass
    if _json_mode and level != "DEBUG":
        # already printed human; JSONL is the structured sink
        pass
