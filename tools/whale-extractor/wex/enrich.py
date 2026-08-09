"""Enrich orchestrator + optional outreach template (default OFF)."""
from __future__ import annotations

import re
from typing import Any

from .cache import cache_get, cache_key, cache_set
from .config import env
from .contacts import ContactProfile, set_guess, set_verified
from .ens import fetch_ensdata, parse_ens_profile
from .farcaster import fetch_farcaster_by_address

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")


def build_outreach_template(profile: ContactProfile) -> str:
    """Simple template — no AI, no breach data. Only when --outreach."""
    project = env("PROJECT_NAME") or "our project"
    desc = env("PROJECT_DESC") or "a DeFi initiative"
    url = env("PROJECT_URL") or ""
    tone = env("OUTREACH_TONE") or "professional"
    name = profile.display_name or profile.ens.value or profile.farcaster.value or "there"
    channel = profile.best_channel()
    lines = [
        f"Hi {name},",
        "",
        f"Reaching out about {project} — {desc}.",
    ]
    if profile.ens.value:
        lines.append(f"Noticed your ENS ({profile.ens.value}).")
    if profile.farcaster.value:
        lines.append(f"Saw you on Farcaster (@{profile.farcaster.value}).")
    if url:
        lines.append(f"More here: {url}")
    lines.extend(["", f"(channel hint: {channel}, tone: {tone})", "— team"])
    return "\n".join(lines)


def enrich_address(address: str, cfg: dict, *, outreach: bool = False) -> ContactProfile:
    addr = address.lower().strip()
    ck = cache_key("enrich_v1", addr)
    cached = cache_get(cfg, ck)
    if isinstance(cached, dict) and cached.get("address"):
        # rebuild lightly
        p = ContactProfile(address=addr)
        for name in ("ens", "email", "twitter", "telegram", "url", "farcaster"):
            block = cached.get(name) or {}
            field = getattr(p, name)
            field.value = str(block.get("value") or "")
            field.quality = block.get("quality") or "none"  # type: ignore[assignment]
            field.source = str(block.get("source") or "")
        p.farcaster_fid = str(cached.get("farcaster_fid") or "")
        p.display_name = str(cached.get("display_name") or "")
        p.bio = str(cached.get("bio") or "")
        p.notes = list(cached.get("notes") or [])
        if outreach and not p.outreach_message:
            p.outreach_message = build_outreach_template(p)
        elif outreach:
            p.outreach_message = str(cached.get("outreach_message") or build_outreach_template(p))
        return p

    profile = ContactProfile(address=addr)

    # ENS — on-chain / ensdata (verified when present)
    ens_raw = fetch_ensdata(addr, cfg)
    ens = parse_ens_profile(ens_raw)
    if ens.get("ens"):
        set_verified(profile.ens, ens["ens"], "ensdata")
        profile.display_name = profile.display_name or ens["ens"]
    if ens.get("email"):
        set_verified(profile.email, ens["email"], "ens_text")
    if ens.get("twitter"):
        set_verified(profile.twitter, ens["twitter"], "ens_text")
    if ens.get("telegram"):
        set_verified(profile.telegram, ens["telegram"], "ens_text")
    if ens.get("url"):
        set_verified(profile.url, ens["url"], "ens_text")
    if ens.get("description"):
        profile.bio = ens["description"]
        if not profile.email.value:
            m = EMAIL_RE.search(ens["description"])
            if m:
                set_guess(profile.email, m.group(0), "ens_description")

    # Farcaster — verified address link via Neynar
    fc = fetch_farcaster_by_address(addr, cfg)
    if fc.get("username"):
        set_verified(profile.farcaster, fc["username"], "neynar")
        profile.farcaster_fid = str(fc.get("fid") or "")
        if fc.get("display_name"):
            profile.display_name = profile.display_name or fc["display_name"]
        if fc.get("bio"):
            profile.bio = profile.bio or fc["bio"]
        if fc.get("twitter") and profile.twitter.quality != "verified":
            set_verified(profile.twitter, fc["twitter"], "neynar")
        # bio email = guess only
        if fc.get("bio") and not profile.email.value:
            m = EMAIL_RE.search(fc["bio"])
            if m:
                set_guess(profile.email, m.group(0), "farcaster_bio")

    if not profile.ens.value and not profile.farcaster.value:
        profile.notes.append("no_public_ens_or_farcaster")

    if outreach:
        profile.outreach_message = build_outreach_template(profile)

    cache_set(cfg, ck, profile.to_dict())
    return profile


def enrich_many(
    addresses: list[str],
    cfg: dict,
    *,
    outreach: bool = False,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for addr in addresses:
        rows.append(enrich_address(addr, cfg, outreach=outreach).to_dict())
    return rows
