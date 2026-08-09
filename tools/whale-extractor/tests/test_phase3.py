"""Phase 3 tests — contacts quality + enrich helpers."""
from wex.contacts import ContactField, ContactProfile, set_guess, set_verified
from wex.enrich import build_outreach_template
from wex.ens import parse_ens_profile


def test_quality_precedence():
    f = ContactField()
    set_guess(f, "a@b.com", "bio")
    assert f.quality == "guess"
    set_verified(f, "real@ens.eth", "ens_text")
    assert f.quality == "verified"
    assert f.value == "real@ens.eth"
    set_guess(f, "other@x.com", "bio")
    assert f.value == "real@ens.eth"


def test_best_channel():
    p = ContactProfile(address="0xabc")
    set_guess(p.email, "x@y.com", "bio")
    set_verified(p.farcaster, "vitalik", "neynar")
    # verified preferred over guess
    assert p.best_channel() == "farcaster"
    set_verified(p.email, "v@example.com", "ens_text")
    assert p.best_channel() == "email"


def test_parse_ens_profile():
    data = {
        "ens": "vitalik.eth",
        "records": {"email": "v@example.com", "com.twitter": "VitalikButerin", "url": "https://vitalik.ca"},
    }
    out = parse_ens_profile(data)
    assert out["ens"] == "vitalik.eth"
    assert out["email"] == "v@example.com"
    assert out["twitter"] == "VitalikButerin"


def test_outreach_template(monkeypatch):
    monkeypatch.setenv("PROJECT_NAME", "TestProj")
    p = ContactProfile(address="0xabc")
    set_verified(p.ens, "alice.eth", "ensdata")
    msg = build_outreach_template(p)
    assert "TestProj" in msg
    assert "alice.eth" in msg
