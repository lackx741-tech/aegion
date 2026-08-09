"""ENS reverse + text records via public ensdata + optional Alchemy."""
from __future__ import annotations

import re
from typing import Any

from .httputil import request_json
from .keys import next_alchemy

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")


def fetch_ensdata(address: str, cfg: dict) -> dict[str, Any]:
    """Public ENS metadata (name + text records). Verified when returned for address."""
    addr = address.lower().strip()
    data = request_json(
        "GET",
        f"https://ensdata.net/{addr}",
        timeout=int(cfg.get("request_timeout_sec", 25)),
        retry_max=2,
        retry_base_ms=int(cfg.get("retry_base_ms", 400)),
    )
    if not isinstance(data, dict):
        return {}
    # ensdata returns ens_primary / address match
    return data


def parse_ens_profile(data: dict[str, Any]) -> dict[str, str]:
    out = {
        "ens": "",
        "email": "",
        "twitter": "",
        "telegram": "",
        "url": "",
        "description": "",
        "avatar": "",
    }
    if not data:
        return out
    out["ens"] = str(data.get("ens") or data.get("ens_primary") or data.get("name") or "").strip()
    records = data.get("records") if isinstance(data.get("records"), dict) else {}
    # flatten common keys
    for src in (data, records):
        if not isinstance(src, dict):
            continue
        if not out["email"]:
            out["email"] = str(src.get("email") or "").strip()
        if not out["twitter"]:
            tw = str(src.get("com.twitter") or src.get("twitter") or "").strip().lstrip("@")
            out["twitter"] = tw
        if not out["telegram"]:
            out["telegram"] = str(src.get("org.telegram") or src.get("telegram") or "").strip().lstrip("@")
        if not out["url"]:
            out["url"] = str(src.get("url") or src.get("website") or "").strip()
        if not out["description"]:
            out["description"] = str(src.get("description") or src.get("bio") or "").strip()
    # email sometimes only in description
    if not out["email"] and out["description"]:
        m = EMAIL_RE.search(out["description"])
        if m:
            out["email"] = m.group(0)
    return out


def alchemy_rpc_ok() -> bool:
    return bool(next_alchemy())
