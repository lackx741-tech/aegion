"""Phase 2 unit tests — cache, keys, checkpoint, progress."""
import os
import time

from wex.cache import cache_get, cache_key, cache_set
from wex.checkpoint import clear_checkpoint, load_checkpoint, save_checkpoint
from wex.keys import next_key
from wex.progress import Progress


def test_cache_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr("wex.cache.ROOT", tmp_path)
    cfg = {"cache_ttl_sec": 60, "cache_dir": "cache"}
    key = cache_key("t", "addr1")
    assert cache_get(cfg, key) is None
    cache_set(cfg, key, {"total_usd": 123})
    assert cache_get(cfg, key)["total_usd"] == 123


def test_cache_expiry(tmp_path, monkeypatch):
    monkeypatch.setattr("wex.cache.ROOT", tmp_path)
    cfg = {"cache_ttl_sec": 0.01, "cache_dir": "cache"}
    key = cache_key("t", "addr2")
    cache_set(cfg, key, {"ok": True})
    time.sleep(0.02)
    assert cache_get(cfg, key) is None


def test_key_rotation():
    keys = ["a", "b", "c"]
    assert next_key("testpool", keys) == "a"
    assert next_key("testpool", keys) == "b"
    assert next_key("testpool", keys) == "c"
    assert next_key("testpool", keys) == "a"


def test_checkpoint(tmp_path, monkeypatch):
    monkeypatch.setattr("wex.checkpoint.ROOT", tmp_path)
    cfg = {"checkpoint_dir": "cp"}
    job = "job_test"
    save_checkpoint(job, cfg, addresses=["0x1"], done={"0x1": {"status": "OK"}}, rows=[{"address": "0x1"}])
    cp = load_checkpoint(job, cfg)
    assert cp is not None
    assert cp["done"]["0x1"]["status"] == "OK"
    clear_checkpoint(job, cfg)
    assert load_checkpoint(job, cfg) is None


def test_progress_eta():
    p = Progress(10)
    s = p.tick(3)
    assert "3/10" in s
    assert "eta=" in s
