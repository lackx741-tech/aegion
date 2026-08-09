"""Unit tests for Phase 0+1 filters / dedupe."""
from wex.filters import dedupe_addresses, is_skipped_address, normalize_evm


def test_normalize_evm():
    assert normalize_evm("0x28C6C06298D514Db089934071355E5743Bf21d60") == (
        "0x28c6c06298d514db089934071355e5743bf21d60"
    )
    assert normalize_evm("not-an-address") is None


def test_skip_cex():
    assert is_skipped_address("0x28c6c06298d514db089934071355e5743bf21d60") is True


def test_dedupe():
    a = "0x1111111111111111111111111111111111111111"
    b = "0x2222222222222222222222222222222222222222"
    out = dedupe_addresses([a, a.upper(), b, "bad", a])
    assert out == [a, b]
