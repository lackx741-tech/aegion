"""True multi-source portfolio (Moralis + Ankr + optional non-EVM)."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

from .cache import cache_get, cache_key, cache_set
from .httputil import request_json
from .keys import next_ankr, next_moralis
from .prices import fetch_prices

MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2"


@dataclass
class ChainSlice:
    chain: str
    usd: float
    source: str


@dataclass
class PortfolioResult:
    address: str
    total_usd: float
    moralis_usd: float = 0.0
    ankr_usd: float = 0.0
    non_evm_usd: float = 0.0
    chains: list[ChainSlice] = field(default_factory=list)
    top_assets: str = ""
    skipped: bool = False
    skip_reason: str = ""
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["chains_active"] = ",".join(
            sorted({c.chain for c in self.chains if c.usd > 0})
        )
        d["chains"] = [asdict(c) for c in self.chains]
        return d


def _moralis_networth(address: str, chains: list[str], cfg: dict) -> tuple[float, list[ChainSlice]]:
    key = next_moralis()
    if not key:
        return 0.0, []
    params = [("chains[]", c) for c in chains]
    params += [("exclude_spam", "true"), ("exclude_unverified_contracts", "true")]
    data = request_json(
        "GET",
        f"{MORALIS_BASE}/wallets/{address}/net-worth",
        headers={"X-API-Key": key, "Accept": "application/json"},
        params=params,
        timeout=int(cfg.get("request_timeout_sec", 25)),
        retry_max=int(cfg.get("retry_max", 3)),
        retry_base_ms=int(cfg.get("retry_base_ms", 400)),
    )
    if not isinstance(data, dict) or not data:
        return 0.0, []
    total = float(data.get("total_networth_usd") or 0)
    min_active = float(cfg.get("active_chain_min_usd", 100))
    slices: list[ChainSlice] = []
    for row in data.get("chains") or []:
        usd = float(row.get("networth_usd") or 0)
        if usd < min_active:
            continue
        slices.append(ChainSlice(chain=str(row.get("chain") or "eth"), usd=round(usd, 2), source="moralis"))
    return round(total, 2), slices


def _ankr_balance(address: str, chains: list[str], cfg: dict) -> tuple[float, list[ChainSlice], str]:
    key = next_ankr()
    if not key or not chains:
        return 0.0, [], ""

    # Try full list, then chunk if Ankr rejects a chain name
    chunks: list[list[str]] = [chains]
    if len(chains) > 8:
        chunks = [chains[i : i + 8] for i in range(0, len(chains), 8)]

    by_chain: dict[str, float] = {}
    top_assets: list[dict] = []
    min_active = float(cfg.get("active_chain_min_usd", 100))

    for chunk in chunks:
        data = request_json(
            "POST",
            f"https://rpc.ankr.com/multichain/{key}",
            json_body={
                "id": 1,
                "jsonrpc": "2.0",
                "method": "ankr_getAccountBalance",
                "params": {
                    "blockchain": chunk,
                    "walletAddress": address,
                    "onlyWhitelisted": False,
                },
            },
            timeout=int(cfg.get("request_timeout_sec", 25)),
            retry_max=int(cfg.get("retry_max", 3)),
            retry_base_ms=int(cfg.get("retry_base_ms", 400)),
        )
        if not isinstance(data, dict):
            # single-chain fallback for this chunk
            for c in chunk:
                data = request_json(
                    "POST",
                    f"https://rpc.ankr.com/multichain/{key}",
                    json_body={
                        "id": 1,
                        "jsonrpc": "2.0",
                        "method": "ankr_getAccountBalance",
                        "params": {
                            "blockchain": [c],
                            "walletAddress": address,
                            "onlyWhitelisted": False,
                        },
                    },
                    timeout=int(cfg.get("request_timeout_sec", 25)),
                    retry_max=2,
                    retry_base_ms=int(cfg.get("retry_base_ms", 400)),
                )
                if not isinstance(data, dict):
                    continue
                result = data.get("result") or {}
                for a in result.get("assets") or []:
                    usd = float(a.get("balanceUsd") or 0)
                    if usd <= 0:
                        continue
                    chain = str(a.get("blockchain") or c)
                    by_chain[chain] = by_chain.get(chain, 0.0) + usd
                    top_assets.append(a)
            continue

        result = data.get("result") or {}
        for a in result.get("assets") or []:
            usd = float(a.get("balanceUsd") or 0)
            if usd <= 0:
                continue
            chain = str(a.get("blockchain") or "eth")
            by_chain[chain] = by_chain.get(chain, 0.0) + usd
            top_assets.append(a)

    total = round(sum(by_chain.values()), 2)
    slices = [
        ChainSlice(chain=c, usd=round(u, 2), source="ankr")
        for c, u in by_chain.items()
        if u >= min_active
    ]
    top = sorted(top_assets, key=lambda x: float(x.get("balanceUsd") or 0), reverse=True)[:5]
    top_str = ", ".join(
        f"{a.get('tokenSymbol')}(${float(a.get('balanceUsd') or 0):,.0f})"
        for a in top
        if float(a.get("balanceUsd") or 0) > 0
    )
    return total, slices, top_str


def _sol_usd(address: str, cfg: dict, prices: dict) -> float:
    """Optional: if address looks like base58 Solana and HELIUS set — skip for EVM-only scans."""
    _ = (address, cfg, prices)
    return 0.0


def _merge_chains(*groups: list[ChainSlice]) -> list[ChainSlice]:
    best: dict[str, ChainSlice] = {}
    for group in groups:
        for s in group:
            prev = best.get(s.chain)
            if not prev or s.usd > prev.usd:
                best[s.chain] = s
    return sorted(best.values(), key=lambda x: x.usd, reverse=True)


def true_portfolio(address: str, cfg: dict) -> PortfolioResult:
    addr = address.lower().strip()
    ck = cache_key("portfolio_v1", addr, str(cfg.get("min_usd")), ",".join(cfg.get("ankr_chains") or []))
    cached = cache_get(cfg, ck)
    if isinstance(cached, dict) and "total_usd" in cached:
        chains = [
            ChainSlice(**c) if isinstance(c, dict) else c
            for c in (cached.get("chains") or [])
        ]
        return PortfolioResult(
            address=cached.get("address", addr),
            total_usd=float(cached.get("total_usd") or 0),
            moralis_usd=float(cached.get("moralis_usd") or 0),
            ankr_usd=float(cached.get("ankr_usd") or 0),
            non_evm_usd=float(cached.get("non_evm_usd") or 0),
            chains=chains,
            top_assets=str(cached.get("top_assets") or ""),
            errors=list(cached.get("errors") or []),
        )

    prices = fetch_prices(cfg.get("price_ids"), timeout=int(cfg.get("request_timeout_sec", 25)))
    _ = prices

    errors: list[str] = []
    moralis_usd, moralis_chains = 0.0, []
    try:
        moralis_usd, moralis_chains = _moralis_networth(addr, list(cfg.get("moralis_chains") or []), cfg)
        if moralis_usd <= 0:
            moralis_usd, moralis_chains = _moralis_networth(
                addr, list(cfg.get("moralis_fallback_chains") or []), cfg
            )
    except Exception as e:
        errors.append(f"moralis:{e}")

    ankr_usd, ankr_chains, top = 0.0, [], ""
    try:
        ankr_list = list(cfg.get("ankr_chains") or []) + list(cfg.get("ankr_extra_chains") or [])
        seen = set()
        ankr_list = [c for c in ankr_list if not (c in seen or seen.add(c))]
        ankr_usd, ankr_chains, top = _ankr_balance(addr, ankr_list, cfg)
    except Exception as e:
        errors.append(f"ankr:{e}")

    total = max(moralis_usd, ankr_usd)
    chains = _merge_chains(moralis_chains, ankr_chains)
    if chains and total <= 0:
        total = round(sum(c.usd for c in chains), 2)

    result = PortfolioResult(
        address=addr,
        total_usd=round(total, 2),
        moralis_usd=moralis_usd,
        ankr_usd=ankr_usd,
        non_evm_usd=0.0,
        chains=chains,
        top_assets=top,
        errors=errors,
    )
    cache_set(cfg, ck, result.to_dict())
    return result
