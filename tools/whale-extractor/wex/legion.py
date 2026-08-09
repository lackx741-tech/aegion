"""Legion bridge — export-only filters against live client-config (Phase 4).

Does NOT trigger drain/scout. Produces engine-ready lead lists only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .config import env
from .httputil import request_json

DEFAULT_CLIENT_CONFIG_URL = (
    "https://sadrailala-production.up.railway.app/api/v1/client-config"
)

# Aggregator chain labels → Legion family
CHAIN_TO_FAMILY: dict[str, str] = {
    "eth": "EVM",
    "ethereum": "EVM",
    "bsc": "EVM",
    "polygon": "EVM",
    "arbitrum": "EVM",
    "base": "EVM",
    "optimism": "EVM",
    "avalanche": "EVM",
    "fantom": "EVM",
    "gnosis": "EVM",
    "linea": "EVM",
    "cronos": "EVM",
    "scroll": "EVM",
    "blast": "EVM",
    "mantle": "EVM",
    "polygon_zkevm": "EVM",
    "zksync_era": "EVM",
    "zksync": "EVM",
    "metis": "EVM",
    "moonbeam": "EVM",
    "celo": "EVM",
    "sol": "SOL",
    "solana": "SOL",
    "btc": "BTC",
    "bitcoin": "BTC",
    "tron": "TRON",
    "trx": "TRON",
    "ton": "TON",
    "cosmos": "COSMOS",
    "aptos": "APTOS",
    "sui": "SUI",
    "polkadot": "POLKADOT",
    "dot": "POLKADOT",
    "algorand": "ALGORAND",
    "algo": "ALGORAND",
    "cardano": "CARDANO",
    "ada": "CARDANO",
}

LAUNCH_FAMILIES = ("EVM", "SOL", "BTC", "TRON", "TON")


@dataclass
class LegionReadiness:
    ok: bool
    url: str
    capabilities: dict[str, str] = field(default_factory=dict)
    drain_readiness: dict[str, dict[str, Any]] = field(default_factory=dict)
    ready_families: list[str] = field(default_factory=list)
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "url": self.url,
            "capabilities": self.capabilities,
            "drain_readiness": self.drain_readiness,
            "ready_families": self.ready_families,
            "error": self.error,
        }


def client_config_url(cfg: dict | None = None) -> str:
    cfg = cfg or {}
    return (
        env("LEGION_CLIENT_CONFIG_URL")
        or env("LEGION_API_URL")
        or str(cfg.get("legion_client_config_url") or "")
        or DEFAULT_CLIENT_CONFIG_URL
    )


def fetch_legion_readiness(cfg: dict | None = None) -> LegionReadiness:
    url = client_config_url(cfg)
    data = request_json(
        "GET",
        url,
        timeout=int((cfg or {}).get("request_timeout_sec", 25)),
        retry_max=2,
        retry_base_ms=int((cfg or {}).get("retry_base_ms", 400)),
    )
    if not isinstance(data, dict):
        return LegionReadiness(ok=False, url=url, error="client-config fetch failed")

    payload = data.get("data") if isinstance(data.get("data"), dict) else data
    caps = payload.get("chain_capabilities") if isinstance(payload.get("chain_capabilities"), dict) else {}
    drain = payload.get("drain_readiness") if isinstance(payload.get("drain_readiness"), dict) else {}

    ready: list[str] = []
    for fam, row in drain.items():
        if isinstance(row, dict) and row.get("ready") is True:
            ready.append(str(fam).upper())
        elif caps.get(fam) == "full" or caps.get(str(fam).upper()) == "full":
            # fallback if drain_readiness missing but capability full
            if str(fam).upper() not in ready:
                ready.append(str(fam).upper())

    # normalize capability keys
    caps_norm = {str(k).upper(): str(v) for k, v in caps.items()}
    drain_norm = {str(k).upper(): v for k, v in drain.items()}

    return LegionReadiness(
        ok=True,
        url=url,
        capabilities=caps_norm,
        drain_readiness=drain_norm,
        ready_families=sorted(set(ready)),
    )


def family_for_chain(chain: str) -> str:
    return CHAIN_TO_FAMILY.get(str(chain).lower().strip(), "EVM")


def chains_from_row(row: dict[str, Any]) -> list[str]:
    chains: list[str] = []
    active = row.get("chains_active") or ""
    if isinstance(active, str) and active.strip():
        chains.extend([c.strip() for c in active.split(",") if c.strip()])
    raw_chains = row.get("chains")
    if isinstance(raw_chains, list):
        for c in raw_chains:
            if isinstance(c, dict) and c.get("chain"):
                chains.append(str(c["chain"]))
            elif isinstance(c, str):
                chains.append(c)
    # unique preserve order
    seen = set()
    out = []
    for c in chains:
        k = c.lower()
        if k not in seen:
            seen.add(k)
            out.append(k)
    if not out:
        out = ["eth"]  # portfolio rows are EVM-first by default
    return out


def families_from_chains(chains: list[str]) -> list[str]:
    fams: list[str] = []
    seen = set()
    for c in chains:
        f = family_for_chain(c)
        if f not in seen:
            seen.add(f)
            fams.append(f)
    return fams or ["EVM"]


def parse_family_filter(raw: str | None) -> list[str] | None:
    if not raw:
        return None
    parts = [p.strip().upper() for p in raw.split(",") if p.strip()]
    return parts or None


def to_legion_row(
    row: dict[str, Any],
    *,
    ready_families: list[str] | None = None,
    tags: list[str] | None = None,
) -> dict[str, Any]:
    addr = str(row.get("address") or row.get("addr") or "").lower()
    chains = chains_from_row(row)
    families = families_from_chains(chains)
    usd = float(row.get("total_usd") or row.get("true_usd") or row.get("usd") or 0)
    ready = ready_families or []
    matched = [f for f in families if not ready or f in ready]
    tag_list = list(tags or [])
    if row.get("best_channel"):
        tag_list.append(f"contact:{row['best_channel']}")
    ens = row.get("ens")
    if isinstance(ens, dict) and ens.get("value"):
        tag_list.append(f"ens:{ens['value']}")
    elif isinstance(ens, str) and ens:
        tag_list.append(f"ens:{ens}")

    return {
        "address": addr,
        "family": matched[0] if matched else (families[0] if families else "EVM"),
        "families": matched or families,
        "chains": chains,
        "usd": round(usd, 2),
        "tags": tag_list,
        "legion_ready": bool(matched) if ready else True,
        "etherscan": f"https://etherscan.io/address/{addr}" if addr.startswith("0x") else "",
    }


def filter_legion_rows(
    rows: list[dict[str, Any]],
    *,
    min_usd: float = 0,
    families: list[str] | None = None,
    ready_families: list[str] | None = None,
    live_ready_only: bool = False,
) -> list[dict[str, Any]]:
    """Build Legion export rows. live_ready_only drops families not ready on backend."""
    effective_ready = list(ready_families or []) if live_ready_only else []
    want = [f.upper() for f in families] if families else None

    out: list[dict[str, Any]] = []
    for row in rows:
        usd = float(row.get("total_usd") or row.get("true_usd") or row.get("usd") or 0)
        if usd < min_usd:
            continue
        legion = to_legion_row(row, ready_families=effective_ready if live_ready_only else None)
        if live_ready_only and not legion["legion_ready"]:
            continue
        if want is not None:
            if not any(f in want for f in legion["families"]):
                continue
            # narrow families list to requested
            legion["families"] = [f for f in legion["families"] if f in want]
            if not legion["families"]:
                continue
            legion["family"] = legion["families"][0]
        out.append(legion)

    out.sort(key=lambda r: float(r.get("usd") or 0), reverse=True)
    return out
