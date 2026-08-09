"""Phase 4 tests — Legion export filters."""
from wex.legion import (
    family_for_chain,
    filter_legion_rows,
    parse_family_filter,
    to_legion_row,
)


def test_family_for_chain():
    assert family_for_chain("eth") == "EVM"
    assert family_for_chain("solana") == "SOL"
    assert family_for_chain("bitcoin") == "BTC"


def test_parse_family_filter():
    assert parse_family_filter("evm,sol") == ["EVM", "SOL"]
    assert parse_family_filter(None) is None


def test_to_legion_row():
    row = {
        "address": "0xABC",
        "total_usd": 50000,
        "chains_active": "eth,base,arbitrum",
    }
    out = to_legion_row(row)
    assert out["address"] == "0xabc"
    assert out["family"] == "EVM"
    assert "eth" in out["chains"]
    assert out["usd"] == 50000


def test_filter_min_usd_and_families():
    rows = [
        {"address": "0x1", "total_usd": 5000, "chains_active": "eth"},
        {"address": "0x2", "total_usd": 50000, "chains_active": "eth,base"},
    ]
    out = filter_legion_rows(rows, min_usd=10000, families=["EVM"])
    assert len(out) == 1
    assert out[0]["address"] == "0x2"


def test_live_ready_only():
    rows = [
        {"address": "0x1", "total_usd": 50000, "chains_active": "eth"},
    ]
    out = filter_legion_rows(
        rows,
        min_usd=1,
        ready_families=["SOL"],  # EVM not ready
        live_ready_only=True,
    )
    assert out == []
    out2 = filter_legion_rows(
        rows,
        min_usd=1,
        ready_families=["EVM", "SOL"],
        live_ready_only=True,
    )
    assert len(out2) == 1
    assert out2[0]["legion_ready"] is True
