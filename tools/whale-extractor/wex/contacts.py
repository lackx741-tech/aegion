"""Contact quality model — verified | guess | none (Phase 3)."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Quality = Literal["verified", "guess", "none"]


@dataclass
class ContactField:
    value: str = ""
    quality: Quality = "none"
    source: str = ""

    def to_dict(self) -> dict[str, str]:
        return {"value": self.value, "quality": self.quality, "source": self.source}


@dataclass
class ContactProfile:
    address: str
    ens: ContactField = field(default_factory=ContactField)
    email: ContactField = field(default_factory=ContactField)
    twitter: ContactField = field(default_factory=ContactField)
    telegram: ContactField = field(default_factory=ContactField)
    url: ContactField = field(default_factory=ContactField)
    farcaster: ContactField = field(default_factory=ContactField)
    farcaster_fid: str = ""
    display_name: str = ""
    bio: str = ""
    outreach_message: str = ""
    notes: list[str] = field(default_factory=list)

    def best_channel(self) -> str:
        order = [
            ("email", self.email),
            ("twitter", self.twitter),
            ("farcaster", self.farcaster),
            ("telegram", self.telegram),
            ("url", self.url),
            ("ens", self.ens),
        ]
        for name, field_ in order:
            if field_.value and field_.quality == "verified":
                return name
        for name, field_ in order:
            if field_.value and field_.quality == "guess":
                return name
        return "none"

    def to_dict(self) -> dict[str, Any]:
        return {
            "address": self.address,
            "ens": self.ens.to_dict(),
            "email": self.email.to_dict(),
            "twitter": self.twitter.to_dict(),
            "telegram": self.telegram.to_dict(),
            "url": self.url.to_dict(),
            "farcaster": self.farcaster.to_dict(),
            "farcaster_fid": self.farcaster_fid,
            "display_name": self.display_name,
            "bio": self.bio,
            "best_channel": self.best_channel(),
            "outreach_message": self.outreach_message,
            "notes": self.notes,
        }


def set_verified(field: ContactField, value: str, source: str) -> None:
    v = (value or "").strip()
    if not v:
        return
    field.value = v
    field.quality = "verified"
    field.source = source


def set_guess(field: ContactField, value: str, source: str) -> None:
    v = (value or "").strip()
    if not v or field.quality == "verified":
        return
    field.value = v
    field.quality = "guess"
    field.source = source
