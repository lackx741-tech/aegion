"""Farcaster / Neynar — verified address → profile link."""
from __future__ import annotations

from typing import Any

from .config import env
from .httputil import request_json


def fetch_farcaster_by_address(address: str, cfg: dict) -> dict[str, Any]:
    """Neynar bulk-by-address. Profile is verified only if API returns user for this addr."""
    key = env("NEYNAR_KEY")
    if not key:
        return {}
    addr = address.lower().strip()
    data = request_json(
        "GET",
        "https://api.neynar.com/v2/farcaster/user/bulk-by-address",
        headers={"api_key": key, "accept": "application/json"},
        params={"addresses": addr},
        timeout=int(cfg.get("request_timeout_sec", 25)),
        retry_max=2,
        retry_base_ms=int(cfg.get("retry_base_ms", 400)),
    )
    if not isinstance(data, dict):
        return {}
    # shape: { "0x...": [ {user...} ] } or { "users": ... }
    users = data.get(addr) or data.get(addr.lower())
    if not users:
        # sometimes keys checksummed
        for k, v in data.items():
            if isinstance(k, str) and k.lower() == addr and isinstance(v, list):
                users = v
                break
    if not isinstance(users, list) or not users:
        return {}
    u = users[0] if isinstance(users[0], dict) else {}
    # nested user object
    user = u.get("user") if isinstance(u.get("user"), dict) else u
    username = str(user.get("username") or "").strip()
    fid = str(user.get("fid") or "")
    display = str(user.get("display_name") or user.get("displayName") or "").strip()
    profile = user.get("profile") if isinstance(user.get("profile"), dict) else {}
    bio = ""
    if isinstance(profile.get("bio"), dict):
        bio = str(profile["bio"].get("text") or "").strip()
    elif isinstance(profile.get("bio"), str):
        bio = profile["bio"].strip()
    twitter = ""
    verified = user.get("verified_addresses") if isinstance(user.get("verified_addresses"), dict) else {}
    # experimental twitter in user object
    for key_name in ("twitter", "x", "twitter_username"):
        if user.get(key_name):
            twitter = str(user[key_name]).lstrip("@")
            break
    return {
        "username": username,
        "fid": fid,
        "display_name": display,
        "bio": bio,
        "twitter": twitter,
        "verified_eth": verified.get("eth_addresses") or verified.get("ethAddresses") or [],
    }
