#!/usr/bin/env python3
"""
Whale Intelligence Platform v2 — God-Level Edition
13 On-Chain Layers · 8 Behavioral Layers · 5 Social OSINT Layers · AI Scoring

Usage:
  python whale_extractor.py --test    # 10 addresses, quick test
  python whale_extractor.py --run     # full 1000 addresses
  python whale_extractor.py --resume  # resume from checkpoint
"""

import os, sys, time, json, csv, logging, random, math, argparse, re
import threading as _threading
from datetime import datetime, timedelta
from dataclasses import dataclass, asdict, fields as dc_fields
from typing import Optional, List, Any, Dict, Tuple
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from dotenv import load_dotenv

load_dotenv()

# Windows cp1252 can't encode emoji — force UTF-8 on stdout/stderr
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ─── Config ────────────────────────────────────────────────────────────────
ETHERSCAN_KEY  = os.getenv("ETHERSCAN_KEY", "")
OSINT_KEY      = os.getenv("OSINT_KEY", "")
ALCHEMY_KEY    = os.getenv("ALCHEMY_KEY", "")
# Multi-key rotation: ALCHEMY_KEYS=key1,key2,key3 → 3x throughput
_raw_alchemy   = os.getenv("ALCHEMY_KEYS", "")
_ALCHEMY_KEYS  = [k.strip() for k in _raw_alchemy.split(",") if k.strip()]
if ALCHEMY_KEY and ALCHEMY_KEY not in _ALCHEMY_KEYS:
    _ALCHEMY_KEYS.insert(0, ALCHEMY_KEY)
if not _ALCHEMY_KEYS and ALCHEMY_KEY:
    _ALCHEMY_KEYS = [ALCHEMY_KEY]
_alchemy_idx   = 0
_alchemy_lock  = _threading.Lock()

def _next_alchemy_key() -> str:
    global _alchemy_idx
    if not _ALCHEMY_KEYS:
        return ALCHEMY_KEY
    with _alchemy_lock:
        key = _ALCHEMY_KEYS[_alchemy_idx % len(_ALCHEMY_KEYS)]
        _alchemy_idx += 1
    return key
NEYNAR_KEY       = os.getenv("NEYNAR_KEY", "")
MORALIS_KEY      = os.getenv("MORALIS_KEY", "")
CHAINBASE_KEY    = os.getenv("CHAINBASE_API_KEY", "")
AIRSTACK_KEY     = os.getenv("AIRSTACK_API_KEY", "")
CONSTELLA_KEY    = os.getenv("CONSTELLA_API_KEY", "")
PDL_KEY          = os.getenv("PDL_API_KEY", "")
OPENSEA_KEY      = os.getenv("OPENSEA_API_KEY", "")     # optional — opensea.io/developers (free)
# ── Multi-chain non-EVM keys (all free) ───────────────────────────────────
HELIUS_KEY     = os.getenv("HELIUS_KEY", "")    # Solana: helius.dev (free signup)
TRON_KEY       = os.getenv("TRON_KEY", "")      # TRON: tronscan.org/api (optional, free)
ANKR_KEY       = os.getenv("ANKR_KEY", "")      # EVM extras (fantom/celo/zksync): ankr.com (free)
SUBSCAN_KEY    = os.getenv("SUBSCAN_KEY", "")   # Polkadot: subscan.io (free signup)
BLOCKFROST_KEY = os.getenv("BLOCKFROST_KEY", "") # Cardano: blockfrost.io (free signup)

# ── AI Provider — set ONE of these ────────────────────────────────────────
# AI_PROVIDER options: "openrouter" | "gemini" | "groq" | "claude" | "openai" | "ollama" | "none"
AI_PROVIDER       = os.getenv("AI_PROVIDER", "none").lower()
OPENAI_KEY        = os.getenv("OPENAI_KEY", "")
GEMINI_KEY        = os.getenv("GEMINI_KEY", "")
GROQ_KEY          = os.getenv("GROQ_KEY", "")
ANTHROPIC_KEY     = os.getenv("ANTHROPIC_KEY", "")
OPENROUTER_KEY    = os.getenv("OPENROUTER_KEY", "")   # free: openrouter.ai
OLLAMA_URL        = os.getenv("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL      = os.getenv("OLLAMA_MODEL", "llama3.1")

# OpenRouter free models — Judge Panel ke 3 competitors
OR_MODELS = [
    "nvidia/nemotron-3-ultra-550b-a55b:free",   # 550B — sabse bada, best quality
    "nvidia/nemotron-3-super-120b-a12b:free",    # 120B — fast + smart
    "google/gemma-4-26b-a4b-it:free",            # Google Gemma 4 — 26B backup
]

# ── Judge Panel config ─────────────────────────────────────────────────────
# JUDGE_PROVIDER: which AI judges the panel — "openrouter" | "groq" | "gemini" | "claude" | "openai"
# Leave blank → auto-select best available free provider
JUDGE_PROVIDER = os.getenv("JUDGE_PROVIDER", "").lower()
PANEL_SCORES   = "provider_scores.json"   # win/loss tracking file

# ── Outreach / Messaging Config ────────────────────────────────────────────
PROJECT_NAME    = os.getenv("PROJECT_NAME", "Our Project")
PROJECT_DESC    = os.getenv("PROJECT_DESC", "a next-gen DeFi protocol")
PROJECT_TWITTER = os.getenv("PROJECT_TWITTER", "")        # @yourproject
PROJECT_URL     = os.getenv("PROJECT_URL", "")            # yourproject.xyz
# OUTREACH_TONE: "professional" | "casual" | "crypto_native"
OUTREACH_TONE   = os.getenv("OUTREACH_TONE", "crypto_native")
# OUTREACH_GOAL: "partnership" | "investment" | "community" | "airdrop" | "custom"
OUTREACH_GOAL   = os.getenv("OUTREACH_GOAL", "community")
# Custom pitch line (optional — AI will use this as the core offer)
OUTREACH_PITCH  = os.getenv("OUTREACH_PITCH", "")

CHAIN_ID       = 1
TARGET_COUNT   = 1000
MIN_USD        = 2_000_000
MAX_USD        = 100_000_000
MIN_AGE_DAYS   = 180
MIN_TX_WEEK    = 0.0   # include hodlers too — $2M+ wallets often transact rarely
MAX_TX_WEEK    = 500   # no upper cap

OUTPUT_DIR     = "outputs"
OUTPUT_CSV     = os.path.join(OUTPUT_DIR, "whale_data.csv")
OUTPUT_JSON    = os.path.join(OUTPUT_DIR, "whale_data.json")
OUTPUT_CLUSTERS= os.path.join(OUTPUT_DIR, "whale_clusters.json")
OUTPUT_ALPHA   = os.path.join(OUTPUT_DIR, "alpha_wallets.csv")
OUTPUT_DASH    = os.path.join(OUTPUT_DIR, "dashboard.html")
CHECKPOINT     = "checkpoint.json"
LOG_FILE       = "whale_extractor.log"

os.makedirs(OUTPUT_DIR, exist_ok=True)

TOKENS = {
    "USDC": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "USDT": "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "PEPE": "0x6982508145454ce325ddbe47a25d4ec3d2311933",
    "SHIB": "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce",
    "WBTC": "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
    "LINK": "0x514910771af9ca656af840dff83e8264ecf986ca",
}

EXCLUDED_LABELS = {
    "cex", "dex", "staking", "defi protocol", "bridge",
    "miner", "contract", "exchange", "lending", "dao",
    "nft marketplace", "yield aggregator", "multisig",
}

BRIDGE_CONTRACTS = {
    "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f": "Arbitrum",
    "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1": "Optimism",
    "0x8484ef722627bf18ca5ae6bcf031c23e6e922b30": "Across",
    "0x5a7749f83b81b301cab5f48eb8516b986daef23d": "Stargate",
    "0x3ee18b2214aff97000d974cf647e7c347e8fa585": "Wormhole",
    "0x49048044d57e1c92a77f79988d21fa8faf74e97e": "Base",
}

STAKING_TOKENS  = {"stETH", "wstETH", "rETH", "cbETH", "sETH2", "ankrETH", "frxETH"}
AAVE_A_TOKENS   = {"aUSDC", "aDAI", "aETH", "aUSDT", "aWBTC", "aWETH", "aLINK",
                   "aAAVE", "aUNI", "aMATIC"}
COMPOUND_TOKENS = {"cUSDC", "cDAI", "cETH", "cUSDT", "cWBTC", "cCOMP"}

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
    ],
)
log = logging.getLogger(__name__)


# ─── Data Model (v2 — 46 fields) ───────────────────────────────────────────
@dataclass
class WhaleRecord:
    # Core (original)
    wallet_address:     str   = ""
    usd_balance:        float = 0.0
    eth_balance:        float = 0.0
    top_tokens:         str   = ""
    weekly_tx_count:    float = 0.0
    wallet_age_months:  float = 0.0
    first_tx_date:      str   = ""
    labels:             str   = ""
    entity_name:        str   = ""
    ens_name:           str   = ""
    ens_twitter:        str   = ""
    ens_telegram:       str   = ""
    ens_email:          str   = ""
    twitter_handle:     str   = ""
    telegram_username:  str   = ""
    email:              str   = ""
    recent_transaction: str   = ""
    # On-Chain Intelligence
    pnl_30d:            float = 0.0
    pnl_90d:            float = 0.0
    win_rate:           float = 0.0
    defi_positions:     str   = ""
    defi_usd_value:     float = 0.0
    nft_usd_value:      float = 0.0
    nft_count:          int   = 0
    nft_top_collection: str   = ""
    connected_wallets:  str   = ""
    cluster_balance:    float = 0.0
    mev_victim_count:   int   = 0
    chains_active:      str   = ""
    bridge_volume_90d:  float = 0.0
    governance_votes:   int   = 0
    governance_daos:    str   = ""
    staking_value:      float = 0.0
    avg_gas_gwei:       float = 0.0
    smart_money_label:  str   = ""
    # Behavioral Intelligence
    trading_pattern:    str   = ""
    copyworthy_score:   int   = 0
    influence_score:    float = 0.0
    timezone:           str   = ""
    risk_appetite:      str   = ""
    loyalty_score:      int   = 0
    sentiment:          str   = ""
    # Social OSINT
    lens_handle:        str   = ""
    lens_followers:     int   = 0
    farcaster_user:     str   = ""
    ens_url:            str   = ""
    # AI Layer
    whale_category:     str   = ""
    risk_score:         str   = ""
    ai_summary:         str   = ""
    # Outreach Messages (personalized per channel)
    msg_twitter:        str   = ""   # short DM for Twitter/X
    msg_telegram:       str   = ""   # Telegram message
    msg_email:          str   = ""   # email body
    outreach_channel:   str   = ""   # best available channel: twitter/telegram/email/onchain
    source_chain:       str   = "eth"  # which chain this whale was found on
    cross_chain_wallets: str  = ""     # JSON: {"solana":"abc..","bsc":"0x.."} — same person on other chains
    older_demographic_score: int = 0  # 0-10: likelihood of 45+ age holder (hodler signals)

    # ── Layer 2: Domain-based Identity (Unstoppable Domains) ─────────────────
    ud_domain:          str   = ""   # .crypto / .x domain name
    ud_email:           str   = ""   # email record from UD domain
    ud_phone:           str   = ""   # phone record from UD domain
    ud_twitter:         str   = ""   # Twitter from UD domain
    ud_discord:         str   = ""   # Discord from UD domain

    # ── Layer 3: Off-chain enrichment ─────────────────────────────────────────
    phone:              str   = ""   # best phone (WHOIS/UD/ENS/IntelX/breach)
    linkedin:           str   = ""   # LinkedIn profile URL
    discord:            str   = ""   # Discord handle
    github:             str   = ""   # GitHub profile URL
    social_profiles:    str   = ""   # JSON: all platform URLs found (Sherlock/Maigret)

    # ── Layer 4: On-chain Social Graph (Farcaster verified wallets) ──────────
    farcaster_wallets:  str   = ""   # JSON: {"eth":["0x..."],"sol":["..."]}
    farcaster_name:     str   = ""   # Farcaster display name
    farcaster_bio:      str   = ""   # Farcaster bio text
    airstack_profiles:  str   = ""   # JSON: Lens+Farcaster from Airstack

    # ── Layer 5: Entity/Label enrichment ────────────────────────────────────
    chainbase_label:    str   = ""   # Chainbase entity label (CEX/DeFi/DAO/etc.)
    etherscan_nametag:  str   = ""   # Etherscan public nametag (scraped)
    kyc_name:           str   = ""   # Real name from entity labels / KYC leak

    # ── Layer 6: Breach / Off-chain PII ─────────────────────────────────────
    breach_email:       str   = ""   # email confirmed from breach databases
    breach_phone:       str   = ""   # phone from breach databases
    breach_sources:     str   = ""   # comma-separated breach DB names
    breach_fields:      str   = ""   # field types exposed (dob/address/ssn/etc.)

    # Layer 6b: New social sources — OpenSea, Lens, Snapshot, Mirror, DeBank
    os_username:        str   = ""   # OpenSea profile username
    os_twitter:         str   = ""   # Twitter from OpenSea profile
    lens_handle2:       str   = ""   # Lens Protocol handle (lens_handle already exists)
    lens_email:         str   = ""   # Email from Lens attributes (rare, high value)
    snap_twitter:       str   = ""   # Twitter from Snapshot DAO profile
    snap_github:        str   = ""   # GitHub from Snapshot
    mirror_name:        str   = ""   # Display name from Mirror.xyz
    db_twitter:         str   = ""   # Twitter from DeBank social
    db_discord:         str   = ""   # Discord from DeBank social

    # Layer 7: People Data Labs — actual values from public data sources
    pdl_name:           str   = ""   # full name (from LinkedIn/social profiles)
    pdl_gender:         str   = ""   # male/female
    pdl_birth_year:     str   = ""   # e.g. "1992"
    pdl_phone:          str   = ""   # mobile phone
    pdl_city:           str   = ""   # city
    pdl_state:          str   = ""   # state/region
    pdl_country:        str   = ""   # country
    pdl_postal:         str   = ""   # postal/zip code
    pdl_linkedin:       str   = ""   # LinkedIn URL
    pdl_job:            str   = ""   # job title
    pdl_company:        str   = ""   # employer


FIELDNAMES = [f.name for f in dc_fields(WhaleRecord)]


# ─── Etherscan V2 — Multi-key round-robin ─────────────────────────────────
# Set ETHERSCAN_KEYS=key1,key2,key3 in .env to multiply throughput
# Each key = 5 req/sec → 3 keys = 15 req/sec → 3x faster!
ETHERSCAN_BASE = "https://api.etherscan.io/v2/api"

def _init_es_keys() -> list:
    multi = os.getenv("ETHERSCAN_KEYS", "")
    keys  = [k.strip() for k in multi.split(",") if k.strip()]
    if ETHERSCAN_KEY and ETHERSCAN_KEY not in keys:
        keys.insert(0, ETHERSCAN_KEY)
    return keys or [ETHERSCAN_KEY]

_ES_KEYS      = _init_es_keys()
_es_key_idx   = 0
_es_idx_lock  = _threading.Lock()
_es_timers    = {k: 0.0 for k in _ES_KEYS}  # per-key last-call time
_es_key_locks = {k: _threading.Lock() for k in _ES_KEYS}

def _next_es_key() -> str:
    global _es_key_idx
    with _es_idx_lock:
        key = _ES_KEYS[_es_key_idx % len(_ES_KEYS)]
        _es_key_idx += 1
        return key


def _es(params: dict, retries: int = 4) -> Any:
    params = dict(params)
    params["chainid"] = CHAIN_ID
    for attempt in range(retries):
        key = _next_es_key()
        params["apikey"] = key
        with _es_key_locks[key]:
            gap = time.time() - _es_timers[key]
            if gap < 0.22:
                time.sleep(0.22 - gap)
            _es_timers[key] = time.time()
        try:
            r = requests.get(ETHERSCAN_BASE, params=params, timeout=30)
            r.raise_for_status()
            body = r.json()
            if body.get("status") == "1":
                return body["result"]
            msg = body.get("message", "")
            if "No transactions" in msg or "No records" in msg:
                return []
            if "rate limit" in str(body).lower() or "Max calls" in str(body):
                wait = 2 ** attempt + 1
                log.warning(f"Rate limited (key …{key[-6:]}), sleeping {wait}s")
                time.sleep(wait)
                continue
            log.debug(f"Etherscan non-OK: {body}")
            return []
        except requests.RequestException as e:
            wait = 2 ** attempt
            log.error(f"Etherscan error (attempt {attempt+1}): {e}")
            time.sleep(wait)
    return []


def fetch_eth_price() -> float:
    result = _es({"module": "stats", "action": "ethprice"})
    if isinstance(result, dict):
        return float(result.get("ethusd", 3200))
    return 3200.0


def fetch_chain_prices() -> dict:
    """Fetch live prices for all supported chains from CoinGecko (free, no key)."""
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={
                "ids": "tron,solana,the-open-network,cosmos,aptos,sui,"
                       "polkadot,algorand,cardano,bitcoin",
                "vs_currencies": "usd",
            },
            timeout=15,
        )
        if r.ok:
            return r.json()
    except Exception as e:
        log.debug(f"CoinGecko prices error: {e}")
    return {}


def fetch_token_holders(contract: str, max_pages: int = 10) -> List[str]:
    """Collect candidate whale addresses via recent token transfers (free-tier compatible).
    tokenholderlist requires Etherscan Pro; tokentx is free. Phase-2 balance
    filter discards addresses that don't meet the $100K–$10M threshold."""
    seen: set = set()
    for page in range(1, max_pages + 1):
        result = _es({
            "module": "account", "action": "tokentx",
            "contractaddress": contract,
            "page": page, "offset": 100, "sort": "desc",
        })
        if not result:
            break
        for tx in result:
            f = tx.get("from", "").lower().strip()
            t = tx.get("to", "").lower().strip()
            if f:
                seen.add(f)
            if t:
                seen.add(t)
        if len(result) < 100:
            break
    return list(seen)


def _alchemy_batch_rpc(calls: list) -> list:
    """
    Send multiple JSON-RPC calls in ONE HTTP request to Alchemy.
    calls = [("method", [param1, param2]), ...]
    Returns list of results in the same order.
    Uses round-robin key rotation if ALCHEMY_KEYS is set.
    """
    if not _ALCHEMY_KEYS:
        return [None] * len(calls)
    url  = f"https://eth-mainnet.g.alchemy.com/v2/{_next_alchemy_key()}"
    body = [{"jsonrpc": "2.0", "id": i, "method": m, "params": p}
            for i, (m, p) in enumerate(calls)]
    try:
        r = requests.post(url, json=body, timeout=60)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict):  # error at batch level
            return [None] * len(calls)
        data.sort(key=lambda x: x.get("id", 0))
        return [item.get("result") for item in data]
    except Exception as e:
        log.debug(f"Alchemy batch RPC error: {e}")
        return [None] * len(calls)


def prefilter_candidates(addresses: List[str]) -> List[str]:
    """
    Fast pre-filter using Alchemy batch RPC — ONE HTTP request per 100 addresses.
    Checks nonce (outgoing tx count): whales need ≥15 outgoing txs minimum.
    Also checks ETH balance: skip pure dust wallets (<0.001 ETH).
    Eliminates ~70-80% of candidates in seconds instead of minutes.
    """
    if not ALCHEMY_KEY:
        return addresses  # no key → skip, Phase 2 will filter normally

    BATCH = 80  # 2 calls per address → 160 items per HTTP request
    MIN_NONCE = 15  # < 15 outgoing txs → definitely not an active whale
    passed: List[str] = []

    total = len(addresses)
    for i in range(0, total, BATCH):
        chunk = addresses[i : i + BATCH]
        calls = []
        for addr in chunk:
            calls.append(("eth_getTransactionCount", [addr, "latest"]))
            calls.append(("eth_getBalance", [addr, "latest"]))
        results = _alchemy_batch_rpc(calls)
        for j, addr in enumerate(chunk):
            nonce_hex = results[j * 2]
            bal_hex   = results[j * 2 + 1]
            nonce = int(nonce_hex, 16) if nonce_hex else 0
            bal   = int(bal_hex,   16) if bal_hex   else 0
            if nonce >= MIN_NONCE or bal >= int(0.01 * 1e18):
                # passes: either active sender OR holds ≥0.01 ETH (might have tokens)
                passed.append(addr)

    eliminated = total - len(passed)
    log.info(f"  Batch pre-filter: {total} → {len(passed)} candidates "
             f"({eliminated} eliminated, {len(passed)/max(total,1)*100:.0f}% kept)")
    return passed


def fetch_eth_balance(address: str) -> float:
    # Prefer Alchemy (no rate limit, free) over Etherscan
    if ALCHEMY_KEY:
        results = _alchemy_batch_rpc([("eth_getBalance", [address, "latest"])])
        hex_val = results[0] if results else None
        if hex_val:
            try:
                return int(hex_val, 16) / 1e18
            except (ValueError, TypeError):
                pass
    # Fallback to Etherscan
    result = _es({"module": "account", "action": "balance",
                  "address": address, "tag": "latest"})
    if result:
        try:
            return int(result) / 1e18
        except (ValueError, TypeError):
            pass
    return 0.0


_STABLE_CONTRACTS = {
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ("USDC",  6),
    "0xdac17f958d2ee523a2206206994597c13d831ec7": ("USDT",  6),
    "0x6b175474e89094c44da98b954eedeac495271d0f": ("DAI",  18),
    "0x4fabb145d64652a948d72533023f6e7a623c7c53": ("BUSD", 18),
}


def fetch_token_portfolio(address: str) -> List[dict]:
    """Stablecoin balances via Alchemy (free tier) — tokenportfolio is Etherscan Pro-only."""
    if not ALCHEMY_KEY:
        return []
    result = _alchemy_rpc("alchemy_getTokenBalances",
                          [address, list(_STABLE_CONTRACTS.keys())])
    if not result:
        return []
    portfolio = []
    for tb in result.get("tokenBalances", []):
        contract = (tb.get("contractAddress") or "").lower()
        raw_bal  = tb.get("tokenBalance") or "0x0"
        try:
            bal_int = int(raw_bal, 16)
        except (ValueError, TypeError):
            continue
        if bal_int == 0:
            continue
        if contract in _STABLE_CONTRACTS:
            name, dec = _STABLE_CONTRACTS[contract]
            usd_val = bal_int / (10 ** dec)
            portfolio.append({"tokenSymbol": name, "tokenValue": str(usd_val)})
    return portfolio


MORALIS_BASE = "https://deep-index.moralis.io/api/v2.2"

def _moralis(endpoint: str, params=None) -> dict:
    """Moralis API — no per-second rate limit, 40k compute units/day free.
    params can be a dict or list-of-tuples (for repeated keys like chains[])."""
    if not MORALIS_KEY:
        return {}
    try:
        r = requests.get(
            f"{MORALIS_BASE}/{endpoint.lstrip('/')}",
            headers={"X-API-Key": MORALIS_KEY, "Accept": "application/json"},
            params=params or {},
            timeout=30,
        )
        if not r.ok:
            log.debug(f"Moralis {endpoint} {r.status_code}: {r.text[:120]}")
            return {}
        return r.json()
    except Exception as e:
        log.debug(f"Moralis error {endpoint}: {e}")
        return {}


def _moralis_ts(block_timestamp: str) -> int:
    """Convert Moralis ISO timestamp to unix epoch."""
    try:
        from datetime import timezone
        dt = datetime.fromisoformat(block_timestamp.replace("Z", "+00:00"))
        return int(dt.timestamp())
    except Exception:
        return 0


# Moralis net-worth: all supported EVM chains (13 total, tested 2025-07)
_NETWORTH_CHAINS = [
    "eth", "bsc", "polygon", "arbitrum", "base", "optimism",
    "avalanche", "gnosis", "linea", "cronos", "moonbeam", "ronin",
]
# Minimal fallback set when wallet has too many tokens (skips slow chains)
_NETWORTH_CHAINS_FALLBACK = ["eth", "bsc", "polygon", "arbitrum", "base", "optimism"]
# Extra EVM chains via Ankr (Moralis doesn't support these):
_ANKR_EXTRA_CHAINS = [
    "fantom", "celo", "zksync_era", "scroll", "blast",
    "mantle", "polygon_zkevm", "metis",
]

def fetch_ankr_extra_balance(address: str) -> Tuple[float, List[str]]:
    """Extra EVM chains (fantom/celo/zksync/scroll/blast/mantle) via Ankr free API."""
    if not ANKR_KEY:
        return 0.0, []
    try:
        r = requests.post(
            f"https://rpc.ankr.com/multichain/{ANKR_KEY}",
            json={"id": 1, "jsonrpc": "2.0", "method": "ankr_getAccountBalance",
                  "params": {"blockchain": _ANKR_EXTRA_CHAINS,
                             "walletAddress": address, "onlyWhitelisted": False}},
            timeout=20,
        )
        r.raise_for_status()
        result = r.json().get("result", {})
        total  = float(result.get("totalBalanceUsd", 0) or 0)
        active = list({
            a["blockchain"] for a in result.get("assets", [])
            if float(a.get("balanceUsd", 0) or 0) >= 100
        })
        return round(total, 2), active
    except Exception as e:
        log.debug(f"Ankr extra balance {address}: {e}")
        return 0.0, []

def _moralis_networth_call(address: str, chains: list) -> dict:
    """Single Moralis net-worth call with the given chain list."""
    params = [(("chains[]"), c) for c in chains]
    params += [("exclude_spam", "true"), ("exclude_unverified_contracts", "true")]
    return _moralis(f"/wallets/{address}/net-worth", params)

def fetch_networth_moralis(address: str) -> Tuple[float, str]:
    """Total portfolio across 12 EVM chains — one Moralis call, no rate limit.
    Falls back to 6 core chains if wallet has too many tokens on minor chains.
    Returns (total_usd, comma-separated active chains with >$500 value)."""
    if not MORALIS_KEY:
        return 0.0, ""

    data = _moralis_networth_call(address, _NETWORTH_CHAINS)

    # If full call fails (too many tokens on any chain), retry with core chains only
    if not data:
        log.debug(f"  Moralis net-worth retry (fallback chains) for {address}")
        data = _moralis_networth_call(address, _NETWORTH_CHAINS_FALLBACK)

    if not data:
        return 0.0, ""

    total = float(data.get("total_networth_usd", 0) or 0)
    active = [
        c["chain"] for c in data.get("chains", [])
        if float(c.get("networth_usd", 0) or 0) >= 500
    ]
    return round(total, 2), ", ".join(active) if active else "eth"


# ─── TRON Scanner (free — no key required) ───────────────────────────────
_TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"   # USDT-TRC20 contract
_TRON_USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8"    # USDC-TRC20 contract
_TRX_PRICE  = 0.085   # fallback prices — all overridden at startup from CoinGecko
_SOL_PRICE  = 155.0
_TON_PRICE  = 5.5
_ATOM_PRICE = 8.0
_APT_PRICE  = 8.0
_SUI_PRICE  = 2.5
_DOT_PRICE  = 7.0
_ALGO_PRICE = 0.18
_ADA_PRICE  = 0.45
_BTC_PRICE  = 65000.0

def _tron_headers() -> dict:
    return {"TRON-PRO-API-KEY": TRON_KEY} if TRON_KEY else {}

def fetch_tron_balance(address: str) -> Tuple[float, float]:
    """Returns (total_usd, trx_balance) for a TRON address."""
    try:
        r = requests.get(
            f"https://api.trongrid.io/v1/accounts/{address}",
            headers=_tron_headers(), timeout=20,
        )
        if not r.ok:
            return 0.0, 0.0
        data = r.json().get("data", [{}])[0]
        trx_bal = data.get("balance", 0) / 1e6
        trc20   = data.get("trc20", [])
        usdt_bal = 0.0
        for token_dict in trc20:
            if _TRON_USDT in token_dict:
                usdt_bal += float(token_dict[_TRON_USDT]) / 1e6
            if _TRON_USDC in token_dict:
                usdt_bal += float(token_dict[_TRON_USDC]) / 1e6
        return round(trx_bal * _TRX_PRICE + usdt_bal, 2), round(trx_bal, 4)
    except Exception as e:
        log.debug(f"TRON balance {address}: {e}")
        return 0.0, 0.0

def phase1_tron_candidates(max_addrs: int = 150) -> List[Tuple[str, str]]:
    """TRON whale candidates from TronScan USDT holders + TRX rich list."""
    addresses: set = set()
    # Top USDT-TRC20 holders
    for contract in [_TRON_USDT, _TRON_USDC]:
        try:
            r = requests.get(
                "https://apilist.tronscanapi.com/api/token_trc20/holders",
                params={"contract_address": contract, "limit": 50, "start": 0},
                headers=_tron_headers(), timeout=20,
            )
            if r.ok:
                for h in r.json().get("trc20_tokens", []):
                    a = h.get("address") or h.get("holder_address", "")
                    if a:
                        addresses.add(a)
        except Exception as e:
            log.debug(f"TRON holders error: {e}")
    # TRX rich list
    try:
        r = requests.get(
            "https://apilist.tronscanapi.com/api/account/list",
            params={"sort": "-balance", "limit": 50, "start": 0},
            headers=_tron_headers(), timeout=20,
        )
        if r.ok:
            for acc in r.json().get("data", []):
                if acc.get("address"):
                    addresses.add(acc["address"])
    except Exception as e:
        log.debug(f"TRON richlist error: {e}")
    result = [(a, "tron") for a in list(addresses)[:max_addrs]]
    log.info(f"  TRON candidates  : {len(result)}")
    return result

def _enrich_one_tron(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified TRON whale enrichment."""
    total_usd, trx_bal = fetch_tron_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address  = addr,
        usd_balance     = total_usd,
        source_chain    = "tron",
        chains_active   = "tron",
        top_tokens      = f"TRX ({trx_bal:,.0f}), USDT-TRC20",
        whale_category  = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Solana Scanner (needs HELIUS_KEY — free at helius.dev) ──────────────
_SOL_TOKENS = {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So":  "mSOL",
}

def phase1_solana_candidates(max_addrs: int = 150) -> List[Tuple[str, str]]:
    """Solana top SPL token holders via Helius API (free, helius.dev)."""
    if not HELIUS_KEY:
        log.info("  Solana: HELIUS_KEY not set — free key at helius.dev → add to .env")
        return []
    addresses: set = set()
    base = f"https://mainnet.helius-rpc.com/?api-key={HELIUS_KEY}"
    for mint, sym in _SOL_TOKENS.items():
        try:
            r = requests.post(base,
                json={"jsonrpc":"2.0","id":1,"method":"getTokenLargestAccounts","params":[mint]},
                timeout=20)
            if r.ok:
                for acct in r.json().get("result", {}).get("value", []):
                    # getTokenLargestAccounts returns ATA addresses, need owner
                    ata = acct.get("address", "")
                    if ata:
                        # Resolve ATA → owner wallet
                        r2 = requests.post(base,
                            json={"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
                                  "params":[ata, {"encoding":"jsonParsed"}]},
                            timeout=10)
                        if r2.ok:
                            owner = (r2.json().get("result",{}).get("value",{})
                                     or {}).get("data",{}).get("parsed",{}).get(
                                     "info",{}).get("owner","")
                            if owner:
                                addresses.add(owner)
            log.info(f"    Solana {sym}: {len(addresses)} holders so far")
        except Exception as e:
            log.debug(f"Helius {sym} error: {e}")
    result = [(a, "solana") for a in list(addresses)[:max_addrs]]
    log.info(f"  Solana candidates: {len(result)}")
    return result

def fetch_solana_balance(address: str) -> Tuple[float, str]:
    """SOL + SPL token balance via Moralis Solana API. Returns (usd, chains_str)."""
    if not MORALIS_KEY:
        return 0.0, "solana"
    try:
        r = requests.get(
            f"https://solana-gateway.moralis.io/account/mainnet/{address}/portfolio",
            headers={"X-API-Key": MORALIS_KEY}, timeout=20,
        )
        if not r.ok:
            return 0.0, "solana"
        d = r.json()
        sol_native = float((d.get("nativeBalance") or {}).get("solana", 0) or 0)
        sol_usd    = sol_native * 155.0   # fallback SOL price; TODO: fetch live
        token_usd  = sum(float(t.get("usdValue") or t.get("usd_value") or 0)
                         for t in d.get("tokens", []))
        return round(sol_usd + token_usd, 2), "solana"
    except Exception as e:
        log.debug(f"Moralis Solana balance {address}: {e}")
        return 0.0, "solana"

def _enrich_one_solana(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Solana whale enrichment via Moralis Solana API."""
    total_usd, chains = fetch_solana_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address  = addr,
        usd_balance     = total_usd,
        source_chain    = "solana",
        chains_active   = chains,
        top_tokens      = "SOL, USDC",
        whale_category  = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Bitcoin Scanner (free — Blockstream, no key) ────────────────────────
def fetch_btc_balance(btc_address: str, btc_price: float = 65000.0) -> float:
    """BTC balance in USD via Blockstream.info (free, no key)."""
    try:
        r = requests.get(
            f"https://blockstream.info/api/address/{btc_address}",
            timeout=15,
        )
        if not r.ok:
            return 0.0
        d = r.json()
        funded  = d.get("chain_stats", {}).get("funded_txo_sum", 0)
        spent   = d.get("chain_stats", {}).get("spent_txo_sum", 0)
        sat_bal = funded - spent  # satoshis
        return round(sat_bal / 1e8 * btc_price, 2)
    except Exception as e:
        log.debug(f"BTC balance {btc_address}: {e}")
        return 0.0

def phase1_btc_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """Bitcoin whale candidates — stub (needs Blockchair API or manual rich-list).
    Add BTC addresses to btc_addresses.txt to include them."""
    btc_file = os.path.join(os.path.dirname(__file__), "btc_addresses.txt")
    if os.path.exists(btc_file):
        with open(btc_file, encoding="utf-8") as f:
            addrs = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        log.info(f"  Bitcoin candidates: {len(addrs)} (from btc_addresses.txt)")
        return [(a, "bitcoin") for a in addrs[:max_addrs]]
    log.info("  Bitcoin: create btc_addresses.txt with BTC addresses (one per line)")
    return []

def _enrich_one_btc(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Bitcoin whale enrichment."""
    total_usd = fetch_btc_balance(addr, _BTC_PRICE)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "bitcoin",
        chains_active  = "bitcoin",
        top_tokens     = "BTC",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Extra EVM L2s: Manta, Zora, Mode (public RPC, no key needed) ─────────
_EXTRA_L2_RPCS = {
    "manta": "https://pacific-rpc.manta.network/http",
    "zora":  "https://rpc.zora.energy",
    "mode":  "https://mainnet.mode.network",
}

def fetch_extra_l2_balance(address: str, eth_price: float) -> Tuple[float, List[str]]:
    """Native ETH balance on Manta, Zora, Mode via their public RPCs (no key)."""
    total_usd    = 0.0
    active_chains: List[str] = []
    for chain, rpc in _EXTRA_L2_RPCS.items():
        try:
            r = requests.post(
                rpc,
                json={"jsonrpc": "2.0", "id": 1, "method": "eth_getBalance",
                      "params": [address, "latest"]},
                timeout=8,
            )
            if r.ok:
                hex_bal  = r.json().get("result", "0x0")
                eth_bal  = int(hex_bal, 16) / 1e18
                usd_val  = eth_bal * eth_price
                if usd_val >= 100:
                    total_usd += usd_val
                    active_chains.append(chain)
        except Exception as e:
            log.debug(f"{chain} balance {address}: {e}")
    return round(total_usd, 2), active_chains


# ─── Cross-Chain Wallet Linker (Wormhole — free, no key) ─────────────────
# Wormhole chain ID → readable chain name
_WH_CHAIN_MAP = {
    1:  "solana",    2:  "ethereum",  4:  "bsc",
    5:  "polygon",   6:  "avalanche", 10: "fantom",
    14: "celo",      16: "moonbeam",  21: "sui",
    22: "aptos",     23: "arbitrum",  24: "optimism",
    30: "base",      34: "scroll",    36: "blast",
}
# Wormhole chain IDs for EVM (addresses are 32-byte zero-padded)
_WH_EVM_CHAINS = {2, 4, 5, 6, 10, 14, 16, 23, 24, 30, 34, 36}

def _wh_clean_address(hex_addr: str, chain_id: int) -> str:
    """Convert Wormhole 32-byte hex address to native format."""
    h = hex_addr.replace("0x", "").replace("0X", "").lower()
    if chain_id in _WH_EVM_CHAINS and len(h) == 64:
        return "0x" + h[-40:]      # last 20 bytes = EVM address
    if chain_id == 1 and len(h) == 64:
        # Solana: 32 raw bytes in hex → keep as-is (base58 conversion needs extra lib)
        return h                   # hex representation of Solana pubkey
    return hex_addr

def fetch_wormhole_links(address: str, max_ops: int = 50) -> Dict[str, str]:
    """Find same-user wallets on other chains via Wormhole bridge history.

    Returns dict {chain_name: address} — wallets the same person controls on
    other blockchains (detected via bridge transfers sent OR received).
    Free — no API key needed.
    """
    linked: Dict[str, str] = {}
    addr_lower = address.lower()
    try:
        r = requests.get(
            "https://api.wormholescan.io/api/v1/operations",
            params={"address": address, "page": 0, "pageSize": max_ops},
            timeout=20,
        )
        if not r.ok:
            return {}
        for op in r.json().get("operations", []):
            src = op.get("sourceChain", {})
            tgt = op.get("targetChain", {})
            sp  = op.get("content", {}).get("standarizedProperties", {})

            from_addr  = str(src.get("from", "")).lower()
            to_cid     = sp.get("toChain") or (tgt.get("chainId") if isinstance(tgt, dict) else 0) or 0
            # Prefer targetChain.from (actual settled address) over sp.toAddress
            tgt_addr   = (tgt.get("from", "") if isinstance(tgt, dict) else "") or sp.get("toAddress", "")
            src_cid    = src.get("chainId", 0)

            # ── SENT: this address sent a bridge transfer → dst wallet = their wallet ──
            if from_addr == addr_lower and to_cid and to_cid in _WH_CHAIN_MAP and tgt_addr:
                chain     = _WH_CHAIN_MAP[to_cid]
                dst_clean = _wh_clean_address(tgt_addr, to_cid)
                # Skip if same address (EVM→EVM self-bridge) or zero address
                if (dst_clean.lower() not in (addr_lower, "0x" + "0" * 40)
                        and dst_clean):
                    linked.setdefault(chain, dst_clean)

            # ── RECEIVED: dst address == this address → src wallet = their wallet ───
            tgt_clean = _wh_clean_address(tgt_addr, to_cid) if tgt_addr else ""
            if (tgt_clean.lower() == addr_lower
                    and src.get("from") and src_cid in _WH_CHAIN_MAP):
                chain = _WH_CHAIN_MAP[src_cid]
                if src["from"].lower() != addr_lower:
                    linked.setdefault(chain, src["from"])

    except Exception as e:
        log.debug(f"Wormhole links {address}: {e}")
    linked.pop("ethereum", None)   # remove self-chain reference
    return linked


# ─── TON Scanner (free — tonapi.io, no key) ───────────────────────────────
# USDT-TON jetton contract (largest stablecoin on TON)
_TON_USDT_JETTON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
_TON_USDC_JETTON = "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTbg0cABsBM"

def fetch_ton_balance(address: str) -> float:
    """TON + USDT-TON balance in USD via tonapi.io (free, no key)."""
    try:
        r = requests.get(f"https://tonapi.io/v2/accounts/{address}", timeout=15)
        if not r.ok:
            return 0.0
        data    = r.json()
        nano    = int(data.get("balance", 0))
        ton_usd = (nano / 1e9) * _TON_PRICE
        # Jetton (stablecoin) balance
        jetton_usd = 0.0
        try:
            r2 = requests.get(
                f"https://tonapi.io/v2/accounts/{address}/jettons",
                timeout=10,
            )
            if r2.ok:
                for j in r2.json().get("balances", []):
                    jaddr = j.get("jetton", {}).get("address", "")
                    if _TON_USDT_JETTON in jaddr or _TON_USDC_JETTON in jaddr:
                        jetton_usd += int(j.get("balance", "0") or "0") / 1e6
        except Exception:
            pass
        return round(ton_usd + jetton_usd, 2)
    except Exception as e:
        log.debug(f"TON balance {address}: {e}")
        return 0.0

def phase1_ton_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """TON whale candidates: USDT-TON jetton top holders + ton_addresses.txt."""
    addresses: set = set()
    try:
        r = requests.get(
            f"https://tonapi.io/v2/jettons/{_TON_USDT_JETTON}/holders",
            params={"limit": 100},
            timeout=20,
        )
        if r.ok:
            for h in r.json().get("addresses", []):
                addr = (h.get("address", "")
                        or h.get("owner", {}).get("address", ""))
                if addr:
                    addresses.add(addr)
            log.info(f"    TON USDT holders: {len(addresses)}")
    except Exception as e:
        log.debug(f"TON holders error: {e}")
    ton_file = os.path.join(os.path.dirname(__file__), "ton_addresses.txt")
    if os.path.exists(ton_file):
        with open(ton_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    addresses.add(line)
    result = [(a, "ton") for a in list(addresses)[:max_addrs]]
    log.info(f"  TON candidates   : {len(result)}")
    return result

def _enrich_one_ton(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified TON whale enrichment."""
    total_usd = fetch_ton_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "ton",
        chains_active  = "ton",
        top_tokens     = "TON, USDT-TON",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Cosmos Scanner (free — Cosmos Hub REST, no key) ─────────────────────
_COSMOS_LCD = "https://rest.cosmos.network"

def fetch_cosmos_balance(address: str) -> float:
    """ATOM balance in USD via Cosmos Hub LCD REST (free, no key)."""
    try:
        r = requests.get(
            f"{_COSMOS_LCD}/cosmos/bank/v1beta1/balances/{address}",
            timeout=15,
        )
        if not r.ok:
            return 0.0
        for coin in r.json().get("balances", []):
            if coin.get("denom") == "uatom":
                return round(int(coin.get("amount", 0)) / 1e6 * _ATOM_PRICE, 2)
        return 0.0
    except Exception as e:
        log.debug(f"Cosmos balance {address}: {e}")
        return 0.0

def phase1_cosmos_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """Cosmos whale candidates from cosmos_addresses.txt (manual list)."""
    cosmos_file = os.path.join(os.path.dirname(__file__), "cosmos_addresses.txt")
    if os.path.exists(cosmos_file):
        with open(cosmos_file, encoding="utf-8") as f:
            addrs = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        log.info(f"  Cosmos candidates: {len(addrs)} (from cosmos_addresses.txt)")
        return [(a, "cosmos") for a in addrs[:max_addrs]]
    log.info("  Cosmos: create cosmos_addresses.txt with cosmos1... addresses (one per line)")
    return []

def _enrich_one_cosmos(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Cosmos/ATOM whale enrichment."""
    total_usd = fetch_cosmos_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "cosmos",
        chains_active  = "cosmos",
        top_tokens     = "ATOM",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Aptos Scanner (free — Aptos Labs API, no key) ───────────────────────
def fetch_aptos_balance(address: str) -> float:
    """APT balance in USD via Aptos Labs mainnet fullnode (free, no key)."""
    try:
        r = requests.get(
            f"https://fullnode.mainnet.aptoslabs.com/v1/accounts/{address}/resources",
            timeout=15,
        )
        if not r.ok:
            return 0.0
        for res in r.json():
            if res.get("type") == "0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>":
                octas = int(res.get("data", {}).get("coin", {}).get("value", 0))
                return round(octas / 1e8 * _APT_PRICE, 2)
        return 0.0
    except Exception as e:
        log.debug(f"Aptos balance {address}: {e}")
        return 0.0

def phase1_aptos_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """Aptos whale candidates from aptos_addresses.txt (manual list)."""
    aptos_file = os.path.join(os.path.dirname(__file__), "aptos_addresses.txt")
    if os.path.exists(aptos_file):
        with open(aptos_file, encoding="utf-8") as f:
            addrs = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        log.info(f"  Aptos candidates : {len(addrs)} (from aptos_addresses.txt)")
        return [(a, "aptos") for a in addrs[:max_addrs]]
    log.info("  Aptos: create aptos_addresses.txt with 0x... Aptos addresses (one per line)")
    return []

def _enrich_one_aptos(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Aptos/APT whale enrichment."""
    total_usd = fetch_aptos_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "aptos",
        chains_active  = "aptos",
        top_tokens     = "APT",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Sui Scanner (free — Sui RPC, no key) ────────────────────────────────
def fetch_sui_balance(address: str) -> float:
    """SUI balance in USD via Sui mainnet RPC (free, no key)."""
    try:
        r = requests.post(
            "https://fullnode.mainnet.sui.io/",
            json={"jsonrpc": "2.0", "id": 1,
                  "method": "suix_getBalance",
                  "params": [address, "0x2::sui::SUI"]},
            timeout=15,
        )
        if not r.ok:
            return 0.0
        result   = r.json().get("result", {})
        mist_bal = int(result.get("totalBalance", "0") or "0")
        return round(mist_bal / 1e9 * _SUI_PRICE, 2)
    except Exception as e:
        log.debug(f"Sui balance {address}: {e}")
        return 0.0

def phase1_sui_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """Sui whale candidates from sui_addresses.txt (manual list)."""
    sui_file = os.path.join(os.path.dirname(__file__), "sui_addresses.txt")
    if os.path.exists(sui_file):
        with open(sui_file, encoding="utf-8") as f:
            addrs = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        log.info(f"  Sui candidates   : {len(addrs)} (from sui_addresses.txt)")
        return [(a, "sui") for a in addrs[:max_addrs]]
    log.info("  Sui: create sui_addresses.txt with 0x... Sui addresses (one per line)")
    return []

def _enrich_one_sui(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Sui/SUI whale enrichment."""
    total_usd = fetch_sui_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "sui",
        chains_active  = "sui",
        top_tokens     = "SUI",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Polkadot Scanner (Subscan API — free tier, add SUBSCAN_KEY in .env) ──
def fetch_dot_balance(address: str) -> float:
    """DOT balance in USD via Subscan API (free tier, needs SUBSCAN_KEY)."""
    if not SUBSCAN_KEY:
        return 0.0
    try:
        r = requests.post(
            "https://polkadot.api.subscan.io/api/v2/scan/search",
            headers={"X-API-Key": SUBSCAN_KEY, "Content-Type": "application/json"},
            json={"key": address},
            timeout=15,
        )
        if not r.ok:
            return 0.0
        account = r.json().get("data", {}).get("account", {})
        dot_bal = float(account.get("balance", 0) or 0)
        return round(dot_bal * _DOT_PRICE, 2)
    except Exception as e:
        log.debug(f"DOT balance {address}: {e}")
        return 0.0

def phase1_dot_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """Polkadot whale candidates: Subscan rich list or dot_addresses.txt."""
    addresses: List[str] = []
    if SUBSCAN_KEY:
        try:
            r = requests.post(
                "https://polkadot.api.subscan.io/api/v2/scan/accounts",
                headers={"X-API-Key": SUBSCAN_KEY, "Content-Type": "application/json"},
                json={"order": "desc", "order_field": "balance", "page": 0, "row": 100},
                timeout=20,
            )
            if r.ok:
                for a in r.json().get("data", {}).get("list", []):
                    if a.get("address"):
                        addresses.append(a["address"])
                log.info(f"    DOT Subscan: {len(addresses)} accounts")
        except Exception as e:
            log.debug(f"Subscan accounts error: {e}")
    dot_file = os.path.join(os.path.dirname(__file__), "dot_addresses.txt")
    if os.path.exists(dot_file):
        with open(dot_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and line not in addresses:
                    addresses.append(line)
    if not addresses:
        log.info("  Polkadot: add SUBSCAN_KEY in .env (free: subscan.io) or create dot_addresses.txt")
    result = [(a, "polkadot") for a in addresses[:max_addrs]]
    log.info(f"  DOT candidates   : {len(result)}")
    return result

def _enrich_one_dot(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Polkadot/DOT whale enrichment."""
    total_usd = fetch_dot_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "polkadot",
        chains_active  = "polkadot",
        top_tokens     = "DOT",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Algorand Scanner (free — Algonode.cloud, no key) ────────────────────
def fetch_algo_balance(address: str) -> float:
    """ALGO balance in USD via Algonode.cloud (free, no key)."""
    try:
        r = requests.get(
            f"https://mainnet-api.algonode.cloud/v2/accounts/{address}",
            timeout=15,
        )
        if not r.ok:
            return 0.0
        micro_algos = int(r.json().get("amount", 0))
        return round(micro_algos / 1e6 * _ALGO_PRICE, 2)
    except Exception as e:
        log.debug(f"ALGO balance {address}: {e}")
        return 0.0

def phase1_algo_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """Algorand whale candidates via Algonode indexer (free) + algo_addresses.txt."""
    addresses: set = set()
    try:
        min_micro = int(100_000 / max(_ALGO_PRICE, 0.001) * 1e6)
        r = requests.get(
            "https://mainnet-idx.algonode.cloud/v2/accounts",
            params={"balance-greater-than": min_micro, "limit": 100},
            timeout=20,
        )
        if r.ok:
            for acc in r.json().get("accounts", []):
                if acc.get("address"):
                    addresses.add(acc["address"])
            log.info(f"    ALGO indexer: {len(addresses)} accounts")
    except Exception as e:
        log.debug(f"ALGO indexer error: {e}")
    algo_file = os.path.join(os.path.dirname(__file__), "algo_addresses.txt")
    if os.path.exists(algo_file):
        with open(algo_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    addresses.add(line)
    result = [(a, "algorand") for a in list(addresses)[:max_addrs]]
    log.info(f"  ALGO candidates  : {len(result)}")
    return result

def _enrich_one_algo(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Algorand/ALGO whale enrichment."""
    total_usd = fetch_algo_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "algorand",
        chains_active  = "algorand",
        top_tokens     = "ALGO",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


# ─── Cardano Scanner (Blockfrost free — add BLOCKFROST_KEY in .env) ───────
def fetch_ada_balance(address: str) -> float:
    """ADA balance in USD via Blockfrost (free tier, needs BLOCKFROST_KEY)."""
    if not BLOCKFROST_KEY:
        return 0.0
    try:
        r = requests.get(
            f"https://cardano-mainnet.blockfrost.io/api/v0/addresses/{address}",
            headers={"project_id": BLOCKFROST_KEY},
            timeout=15,
        )
        if not r.ok:
            return 0.0
        for item in r.json().get("amount", []):
            if item.get("unit") == "lovelace":
                return round(int(item.get("quantity", 0)) / 1e6 * _ADA_PRICE, 2)
        return 0.0
    except Exception as e:
        log.debug(f"ADA balance {address}: {e}")
        return 0.0

def phase1_ada_candidates(max_addrs: int = 100) -> List[Tuple[str, str]]:
    """Cardano whale candidates via Blockfrost or ada_addresses.txt."""
    addresses: set = set()
    if not BLOCKFROST_KEY:
        ada_file = os.path.join(os.path.dirname(__file__), "ada_addresses.txt")
        if os.path.exists(ada_file):
            with open(ada_file, encoding="utf-8") as f:
                addrs = [l.strip() for l in f if l.strip() and not l.startswith("#")]
            log.info(f"  ADA candidates   : {len(addrs)} (from ada_addresses.txt)")
            return [(a, "cardano") for a in addrs[:max_addrs]]
        log.info("  Cardano: add BLOCKFROST_KEY in .env (free: blockfrost.io) or create ada_addresses.txt")
        return []
    # Blockfrost: enumerate top UTXO addresses (approximation)
    ada_file = os.path.join(os.path.dirname(__file__), "ada_addresses.txt")
    if os.path.exists(ada_file):
        with open(ada_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    addresses.add(line)
    result = [(a, "cardano") for a in list(addresses)[:max_addrs]]
    log.info(f"  ADA candidates   : {len(result)}")
    return result

def _enrich_one_ada(addr: str) -> Optional[Tuple['WhaleRecord', str]]:
    """Simplified Cardano/ADA whale enrichment."""
    total_usd = fetch_ada_balance(addr)
    if not (MIN_USD <= total_usd <= MAX_USD):
        return None
    rec = WhaleRecord(
        wallet_address = addr,
        usd_balance    = total_usd,
        source_chain   = "cardano",
        chains_active  = "cardano",
        top_tokens     = "ADA",
        whale_category = "High-Value Whale" if total_usd > 500_000 else "Smart Money",
    )
    score_behavior(rec); score_older_demographic(rec)
    rec.ai_summary = _heuristic_summary(rec)
    _heuristic_outreach(rec)
    return (rec, "")


def fetch_recent_txs(address: str, days: int = 90) -> List[dict]:
    since_ts = int((datetime.utcnow() - timedelta(days=days)).timestamp())

    # Moralis: no rate limit, returns 500 txs in one call
    if MORALIS_KEY:
        from_date = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
        data = _moralis(f"/{address}", {
            "chain": "eth", "limit": 100, "order": "DESC", "from_date": from_date,
        })
        txs = data.get("result", [])
        if txs is not None:
            return [
                {
                    "hash":      tx.get("hash", ""),
                    "timeStamp": str(_moralis_ts(tx.get("block_timestamp", ""))),
                    "from":      (tx.get("from_address") or "").lower(),
                    "to":        (tx.get("to_address") or "").lower(),
                    "value":     tx.get("value", "0"),
                }
                for tx in txs
                if _moralis_ts(tx.get("block_timestamp", "")) >= since_ts
            ]

    # Fallback: Etherscan (rate limited)
    result = _es({
        "module": "account", "action": "txlist",
        "address": address, "startblock": 0, "endblock": 99999999,
        "page": 1, "offset": 1000, "sort": "desc",
    })
    if not isinstance(result, list):
        return []
    return [tx for tx in result if int(tx.get("timeStamp", 0)) >= since_ts]


def fetch_first_tx(address: str) -> Optional[dict]:
    # Moralis: sort ASC, limit 1 → cheapest way to get oldest tx
    if MORALIS_KEY:
        data = _moralis(f"/{address}", {
            "chain": "eth", "limit": 1, "order": "ASC",
        })
        txs = data.get("result", [])
        if txs:
            ts = _moralis_ts(txs[0].get("block_timestamp", ""))
            if ts:
                return {"timeStamp": str(ts)}
        # Fall through to Etherscan if Moralis returned empty (token-only wallets)

    # Fallback: Etherscan (handles token-only wallets via token transfer history)
    result = _es({
        "module": "account", "action": "txlist",
        "address": address, "startblock": 0, "endblock": 99999999,
        "page": 1, "offset": 1, "sort": "asc",
    })
    if result and isinstance(result, list) and result[0]:
        return result[0]
    # Last resort: token transfer history (wallets with no native ETH txs)
    tok = _es({
        "module": "account", "action": "tokentx",
        "address": address, "startblock": 0, "endblock": 99999999,
        "page": 1, "offset": 1, "sort": "asc",
    })
    return tok[0] if tok and isinstance(tok, list) else None


def fetch_first_tx_date(address: str) -> Optional[datetime]:
    tx = fetch_first_tx(address)
    if tx:
        ts = int(tx.get("timeStamp", 0))
        if ts:
            return datetime.utcfromtimestamp(ts)
    return None


# ─── ENS ───────────────────────────────────────────────────────────────────
def fetch_ens_name(address: str) -> str:
    try:
        r = requests.get(f"https://api.ensideas.com/ens/resolve/{address}", timeout=8)
        if r.status_code == 200:
            return r.json().get("name", "")
    except Exception:
        pass
    return ""


def fetch_ens_records(ens_name: str) -> dict:
    if not ens_name:
        return {}
    try:
        r = requests.get(f"https://api.ensideas.com/ens/resolve/{ens_name}", timeout=8)
        if r.status_code == 200:
            return r.json().get("records", {})
    except Exception:
        pass
    return {}


# ─── WalletLabels.xyz (free, no key — replaces Chainbase) ─────────────────
# Maps WalletLabels label_type → our EXCLUDED_LABELS categories
_WL_EXCLUDE_MAP = {
    "exchange":         "cex",
    "cex":              "cex",
    "dex":              "dex",
    "defi":             "defi protocol",
    "bridge":           "bridge",
    "miner":            "miner",
    "contract":         "contract",
    "lending":          "lending",
    "staking":          "staking",
    "nft":              "nft marketplace",
    "dao":              "dao",
    "yield":            "yield aggregator",
    "multisig":         "multisig",
    "token":            "contract",
}

# Known CEX hot wallet addresses (hardcoded — always excluded)
_KNOWN_CEX = {
    "0x28c6c06298d514db089934071355e5743bf21d60",  # Binance 14
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549",  # Binance 15
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d",  # Binance 16
    "0x56eddb7aa87536c09ccc2793473599fd21a8b17f",  # Binance 17
    "0x9696f59e4d72e237be84ffd425dcad154bf96976",  # Binance cold
    "0x0681d8db095565fe8a346fa0277bffde9c0edbbf",  # Binance 8
    "0xfe9e8709d3215310075d67e3ed32a380ccf451c8",  # Binance 7
    "0x4e9ce36e442e55ecd9025b9a6e0d88485d628a67",  # Binance 6
    "0x8894e0a0c962cb723c1976a4421c95949be2d4e3",  # Binance 5
    "0xa7efae728d2936e78bda97dc267687568dd593f3",  # Binance cold 2
    "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8",  # Binance cold 1
    "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be",  # Binance 1
    "0xd551234ae421e3bcba99a0da6d736074f22192ff",  # Binance 2
    "0x564286362092d8e7936f0549571a803b203aaced",  # Binance 3
    "0x0681d8db095565fe8a346fa0277bffde9c0edbbf",  # Binance 8
    "0x2b5634c42055806a59e9107ed44d43c426e58258",  # KuCoin 2
    "0x689c56aef474df92d44a1b70850f808488f9769c",  # KuCoin 1
    "0xa1d8d972560c2f8144af871db508f0b0b10a3fbf",  # KuCoin 3
    "0xeb2629a2734e272bcc07bda959863f316f4bd4cf",  # Coinbase 1
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",  # Coinbase 2
    "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43",  # Coinbase 3
    "0x77696bb39917c91a0c3d2f8c0b49d641b8d8b4b9",  # OKX 1
    "0x6cc5f688a315f3dc28a7781717a9a798a59fd9da",  # OKX hot
    "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3",  # Bybit 1
    "0xf89d7b9c864f589bbF53a82105107622B35EaA40",  # Bybit 2
    # ── Known contracts / burn addresses (always skip) ───────────────────────
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",  # WETH contract
    "0x0000000000000000000000000000000000000000",  # Zero address
    "0x000000000000000000000000000000000000dead",  # EVM burn address
    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",  # Dead address variant
    "0xdead000000000000000042069420694206942069",  # Dead address variant 2
    "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",  # stETH (Lido)
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",  # USDC contract
    "0xdac17f958d2ee523a2206206994597c13d831ec7",  # USDT contract
    "0x6b175474e89094c44da98b954eedeac495271d0f",  # DAI contract
    "0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0",  # MATIC contract
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",  # UNI contract
    "0x514910771af9ca656af840dff83e8264ecf986ca",  # LINK contract
}


def fetch_wallet_labels(address: str) -> Tuple[List[str], str]:
    """
    Free wallet labeling — no API key needed.
    Uses WalletLabels.xyz (200M+ addresses) + hardcoded CEX list.
    Returns (labels_list, entity_name).
    """
    # Check hardcoded CEX list first (instant, no API)
    if address.lower() in _KNOWN_CEX:
        return ["cex"], "Known Exchange"

    try:
        r = requests.get(
            "https://api.walletlabels.xyz/wallet",
            params={"address": address},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and data:
                entry      = data[0]
                name       = entry.get("address_name", "")
                label_type = (entry.get("label_type", "") or "").lower()
                label_sub  = (entry.get("label_subtype", "") or "").lower()

                # Map to our exclusion categories
                labels = []
                for key, val in _WL_EXCLUDE_MAP.items():
                    if key in label_type or key in label_sub:
                        labels.append(val)

                return labels, name
    except Exception:
        pass
    return [], ""


def fetch_smart_money_label(address: str) -> str:
    """Get smart money / entity label from WalletLabels (no key needed)."""
    try:
        r = requests.get(
            "https://api.walletlabels.xyz/wallet",
            params={"address": address},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and data:
                entry = data[0]
                parts = [
                    entry.get("label_type", ""),
                    entry.get("label_subtype", ""),
                ]
                return " / ".join(p for p in parts if p) or ""
    except Exception:
        pass
    return ""


# ─── Alchemy (free tier — 300M CU/month) ───────────────────────────────────
def _alchemy_rpc(method: str, params: list, retries: int = 3) -> Any:
    if not _ALCHEMY_KEYS:
        return None
    url     = f"https://eth-mainnet.g.alchemy.com/v2/{_next_alchemy_key()}"
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    for attempt in range(retries):
        try:
            r = requests.post(url, json=payload, timeout=30)
            r.raise_for_status()
            body = r.json()
            if "error" in body:
                log.debug(f"Alchemy RPC error: {body['error']}")
                return None
            return body.get("result")
        except Exception as e:
            time.sleep(2 ** attempt)
    return None


def fetch_alchemy_nfts(address: str) -> dict:
    """NFT holdings via Alchemy NFT API v3."""
    if not ALCHEMY_KEY:
        return {"count": 0, "value": 0.0, "top_collection": ""}
    try:
        url = f"https://eth-mainnet.g.alchemy.com/nft/v3/{ALCHEMY_KEY}/getNFTsForOwner"
        r   = requests.get(url, params={
            "owner": address, "withMetadata": "false", "pageSize": 100,
        }, timeout=25)
        r.raise_for_status()
        data   = r.json()
        nfts   = data.get("ownedNfts", [])
        total  = data.get("totalCount", 0)
        cols   = defaultdict(int)
        for nft in nfts:
            name = nft.get("contract", {}).get("name") or "Unknown"
            cols[name] += 1
        top = max(cols, key=cols.get) if cols else ""
        # Rough value: floor prices unavailable without Reservoir/OpenSea paid API
        # Use $500 per NFT as conservative estimate
        return {"count": total, "value": total * 500.0, "top_collection": top}
    except Exception as e:
        log.debug(f"Alchemy NFT error {address}: {e}")
        return {"count": 0, "value": 0.0, "top_collection": ""}


def fetch_alchemy_transfers_90d(address: str) -> Tuple[List[dict], List[dict]]:
    """Incoming + outgoing ETH/ERC-20 transfers for last ~90 days."""
    if not ALCHEMY_KEY:
        return [], []
    # Block ~90 days ago (assume ~7200 blocks/day on mainnet)
    approx_block = hex(max(0, 21_000_000 - 90 * 7200))
    def _get(direction_key: str, addr_key: str) -> List[dict]:
        result = _alchemy_rpc("alchemy_getAssetTransfers", [{
            "fromBlock": approx_block,
            "toBlock":   "latest",
            addr_key:    address,
            "category":  ["external", "erc20"],
            "withMetadata": False,
            "maxCount":  "0x3e8",
        }])
        return (result or {}).get("transfers", [])
    return _get("incoming", "toAddress"), _get("outgoing", "fromAddress")


# ─── Snapshot.org Governance (free GraphQL) ────────────────────────────────
SNAPSHOT_GQL = "https://hub.snapshot.org/graphql"

def fetch_governance(address: str) -> Tuple[int, List[str]]:
    query = """
    query($voter: String!) {
      votes(where:{voter:$voter}, first:100, orderBy:"created", orderDirection:desc) {
        space { name }
      }
    }
    """
    try:
        r = requests.post(SNAPSHOT_GQL, json={
            "query": query,
            "variables": {"voter": address},
        }, timeout=15)
        r.raise_for_status()
        votes = r.json().get("data", {}).get("votes", [])
        daos  = list(dict.fromkeys(
            v["space"]["name"] for v in votes if v.get("space")
        ))
        return len(votes), daos[:5]
    except Exception as e:
        log.debug(f"Snapshot error {address}: {e}")
        return 0, []


# ─── Lens Protocol (free — no API key needed) ─────────────────────────────
LENS_GQL = "https://api.lens.xyz/graphql"

def fetch_lens_profile(address: str) -> dict:
    """Lens Protocol v3 GraphQL — completely free, no key needed."""
    query = """
    query($addr: EvmAddress!) {
      account(request: { address: $addr }) {
        username { localName }
      }
    }
    """
    try:
        r = requests.post(
            LENS_GQL,
            json={"query": query, "variables": {"addr": address}},
            headers={"Content-Type": "application/json"},
            timeout=12,
        )
        if r.status_code == 200:
            acct = r.json().get("data", {}).get("account") or {}
            handle = (acct.get("username") or {}).get("localName", "")
            if handle:
                # fetch follower count separately
                followers = 0
                try:
                    q2 = """
                    query($addr: EvmAddress!) {
                      accountStats(request: { account: $addr }) {
                        graphFollowerCount
                      }
                    }
                    """
                    r2 = requests.post(
                        LENS_GQL,
                        json={"query": q2, "variables": {"addr": address}},
                        headers={"Content-Type": "application/json"},
                        timeout=8,
                    )
                    if r2.status_code == 200:
                        st = r2.json().get("data", {}).get("accountStats") or {}
                        followers = int(st.get("graphFollowerCount") or 0)
                except Exception:
                    pass
                return {
                    "lens_handle":    f"@{handle}",
                    "lens_followers": followers,
                }
    except Exception as e:
        log.debug(f"Lens error {address}: {e}")
    return {}


# ─── Farcaster via Neynar (free tier) ─────────────────────────────────────
# Get free key: neynar.com → signup → API Keys
NEYNAR_KEY = os.getenv("NEYNAR_KEY", "")

def fetch_farcaster_profile(address: str) -> dict:
    """
    Farcaster username + Twitter/X handle via Neynar.
    Returns {"farcaster_user": "...", "twitter_handle": "@..."}
    Uses bulk-by-address endpoint (v2, current as of 2025).
    """
    if NEYNAR_KEY:
        try:
            r = requests.get(
                "https://api.neynar.com/v2/farcaster/user/bulk-by-address",
                params={"addresses": address.lower()},
                headers={"api_key": NEYNAR_KEY, "accept": "application/json"},
                timeout=12,
            )
            if r.status_code == 200:
                data    = r.json()
                users   = data.get(address.lower(), [])
                if users:
                    u   = users[0]
                    out = {}
                    fc  = u.get("username", "")
                    if fc:
                        out["farcaster_user"] = fc
                    # Extract Twitter/X if the user linked it on Farcaster
                    for va in u.get("verified_accounts", []):
                        if va.get("platform") == "x" and va.get("username"):
                            out["twitter_handle"] = f"@{va['username'].lstrip('@')}"
                            break
                    return out
        except Exception as e:
            log.debug(f"Neynar error {address}: {e}")
    return {}


def fetch_web3_social(address: str) -> dict:
    """Combine Lens + Farcaster data. Both free, no Airstack needed."""
    result = {}
    result.update(fetch_lens_profile(address))
    result.update(fetch_farcaster_profile(address))
    return result


# ─── Social / OSINT ────────────────────────────────────────────────────────
def fetch_social(address: str, ens_name: str) -> dict:
    social = {
        "twitter": "", "telegram": "", "email": "", "url": "",
        "ens_twitter": "", "ens_telegram": "", "ens_email": "",
    }
    records = fetch_ens_records(ens_name)
    if records:
        tw = records.get("com.twitter", "") or records.get("twitter", "")
        tg = records.get("org.telegram", "") or records.get("telegram", "")
        em = records.get("email", "")
        ur = records.get("url", "")
        if tw:
            fmt = f"@{tw.lstrip('@')}"
            social["twitter"]     = fmt
            social["ens_twitter"] = fmt   # ENS-sourced separately
        if tg:
            fmt = f"@{tg.lstrip('@')}"
            social["telegram"]     = fmt
            social["ens_telegram"] = fmt
        if em:
            social["email"]     = em
            social["ens_email"] = em
        if ur:
            social["url"] = ur
    if OSINT_KEY not in ("YOUR_OSINT_KEY", "", None):
        try:
            r = requests.get(
                "https://api.onchainindustries.com/v1/social",
                headers={"Authorization": f"Bearer {OSINT_KEY}"},
                params={"address": address}, timeout=15,
            )
            if r.status_code == 200:
                d = r.json()
                if not social["twitter"]  and d.get("twitter"):
                    social["twitter"]  = f"@{d['twitter'].lstrip('@')}"
                if not social["telegram"] and d.get("telegram"):
                    social["telegram"] = f"@{d['telegram'].lstrip('@')}"
                if not social["email"]    and d.get("email"):
                    social["email"]    = d["email"]
        except Exception:
            pass
    return social


# ─── Arkham Intelligence (free tier — signup at intelligence.arkhamintelligence.com) ──
# Add ARKHAM_KEY to .env after signup. Maps wallets → entity names + Twitter.
ARKHAM_KEY = os.getenv("ARKHAM_KEY", "")

def fetch_arkham_identity(address: str) -> dict:
    """
    Arkham Intelligence entity lookup.
    Returns {"entity_name": "...", "twitter_handle": "@..."}
    Requires free ARKHAM_KEY from intelligence.arkhamintelligence.com.
    """
    if not ARKHAM_KEY:
        return {}
    import time, hmac, hashlib
    try:
        ts      = str(int(time.time() * 1000))
        path    = f"/intelligence/address/{address}"
        message = f"{ts}GET{path}"
        sig     = hmac.new(ARKHAM_KEY.encode(), message.encode(), hashlib.sha256).hexdigest()
        r = requests.get(
            f"https://api.arkhamintelligence.com{path}",
            headers={
                "API-Key":   ARKHAM_KEY,
                "Timestamp": ts,
                "Signature": sig,
            },
            timeout=12,
        )
        if r.status_code == 200:
            d = r.json()
            entity  = d.get("entity") or {}
            out = {}
            name = entity.get("name", "") or d.get("name", "")
            if name:
                out["entity_name"] = name
            # Arkham sometimes includes twitter in entity object
            tw = entity.get("twitter", "") or d.get("twitter", "")
            if tw:
                out["twitter_handle"] = f"@{tw.lstrip('@')}"
            return out
    except Exception as e:
        log.debug(f"Arkham error {address}: {e}")
    return {}


def fetch_etherscan_label(address: str) -> str:
    """
    Scrape Etherscan public page for entity label — 100% free, no key.
    Etherscan shows 'This address is labeled as: Binance 14' etc.
    Returns entity name string or ''.
    """
    try:
        r = requests.get(
            f"https://etherscan.io/address/{address}",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
            timeout=10,
        )
        # Pattern 1: "Public Name Tag" label
        m = re.search(r'Public Name Tag.*?<span[^>]*>(.*?)</span>', r.text, re.S)
        if m:
            label = re.sub(r"<[^>]+>", "", m.group(1)).strip()
            if label:
                return label
        # Pattern 2: address label badge
        m2 = re.search(r'class="badge[^"]*label[^"]*"[^>]*>(.*?)</span>', r.text, re.S)
        if m2:
            label = re.sub(r"<[^>]+>", "", m2.group(1)).strip()
            if label:
                return label
        # Pattern 3: "Address Watch" title tag
        m3 = re.search(r'<title>[^|]+\|\s*([^<|]+?)\s*(?:\||\s*<)', r.text)
        if m3:
            t = m3.group(1).strip()
            if t and "Ethereum" not in t and "Address" not in t:
                return t
    except Exception as e:
        log.debug(f"Etherscan label {address}: {e}")
    return ""


def fetch_twitter_from_address(address: str) -> str:
    """
    Search Twitter/X directly for wallet address mentions — free (Bearer token).
    Returns @handle if found, else ''.
    """
    tw_bearer = os.getenv("TWITTER_BEARER", "")
    if not tw_bearer:
        return ""
    try:
        r = requests.get(
            "https://api.twitter.com/2/tweets/search/recent",
            params={
                "query": f'"{address}" -is:retweet',
                "max_results": 10,
                "tweet.fields": "author_id",
                "expansions": "author_id",
                "user.fields": "username",
            },
            headers={"Authorization": f"Bearer {tw_bearer}"},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            users = {u["id"]: u["username"] for u in d.get("includes", {}).get("users", [])}
            tweets = d.get("data", [])
            if tweets and users:
                return f"@{users.get(tweets[0]['author_id'], '')}"
    except Exception as e:
        log.debug(f"Twitter address search {address}: {e}")
    return ""


# ─── Internet OSINT: contact discovery beyond ENS ──────────────────────────
# New keys (all FREE — add to .env after free signup):
#   DEBANK_KEY    = pro.debank.com → API section  (100 req/day free)
#   GITHUB_TOKEN  = github.com/settings/tokens    (free personal token)
#   UD_KEY        = unstoppabledomains.com/developers (free)
DEBANK_KEY   = os.getenv("DEBANK_KEY", "")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
UD_KEY       = os.getenv("UD_KEY", "")


def fetch_debank_profile(address: str) -> dict:
    """
    DeBank Pro: Twitter + Discord linked to wallet.
    Free API key from pro.debank.com (100 req/day).
    Returns {"twitter_handle": "@...", "discord": "..."}
    """
    if not DEBANK_KEY:
        return {}
    try:
        r = requests.get(
            "https://pro-openapi.debank.com/v1/user/profile",
            params={"id": address.lower()},
            headers={"AccessKey": DEBANK_KEY},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            result = {}
            tw = d.get("twitter_id") or d.get("twitter") or ""
            if tw:
                result["twitter_handle"] = f"@{tw.lstrip('@')}"
            dc = d.get("discord_username") or d.get("discord") or ""
            if dc:
                result["discord"] = dc
            return result
    except Exception as e:
        log.debug(f"DeBank profile {address}: {e}")
    return {}


def fetch_unstoppable_profile(address: str) -> dict:
    """
    Unstoppable Domains: .crypto/.x/.nft domain records.
    Has email, telegram, twitter, linkedin, reddit in records.
    Free API key from unstoppabledomains.com/developers.
    Returns {"ud_domain": "name.crypto", "email": "...", "telegram": "...", ...}
    """
    if not UD_KEY:
        return {}
    try:
        r = requests.get(
            f"https://api.unstoppabledomains.com/resolve/address/{address}",
            headers={"Authorization": f"Bearer {UD_KEY}"},
            timeout=10,
        )
        if r.status_code == 200:
            d    = r.json()
            meta = d.get("meta", {})
            recs = d.get("records", {})
            out  = {}
            domain = meta.get("domain", "")
            if domain:
                out["ud_domain"] = domain
            for key, field in [
                ("whois.email.value",             "email"),
                ("social.twitter.username",        "twitter_handle"),
                ("social.telegram.url",            "telegram"),
                ("social.linkedin.url",            "linkedin"),
                ("social.reddit.username",         "reddit"),
                ("browser.preferred_url.value",    "website"),
            ]:
                val = recs.get(key, "")
                if val:
                    if field == "twitter_handle" and not val.startswith("@"):
                        val = f"@{val}"
                    out[field] = val
            return out
    except Exception as e:
        log.debug(f"Unstoppable {address}: {e}")
    return {}


def fetch_unstoppable_free(address: str) -> dict:
    """
    Unstoppable Domains — FREE, no API key needed.
    Uses the public UD GraphQL API to look up domain + records by wallet address.
    Returns {"ud_domain": "name.crypto", "email": "...", "twitter_handle": "...", ...}
    """
    try:
        # Public UD API endpoint (no auth required for basic lookups)
        r = requests.get(
            f"https://api.unstoppabledomains.com/resolve/address/{address}",
            headers={"User-Agent": "Mozilla/5.0 (compatible; OSINT/1.0)"},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            meta = d.get("meta", {})
            recs = d.get("records", {})
            out: dict = {}
            domain = meta.get("domain", "")
            if domain:
                out["ud_domain"] = domain
            for key, field in [
                ("whois.email.value",          "email"),
                ("social.twitter.username",     "twitter_handle"),
                ("social.telegram.url",         "telegram"),
                ("social.linkedin.url",         "linkedin"),
                ("social.reddit.username",      "reddit"),
                ("social.discord.url",          "discord"),
                ("gundb.username.value",        "gundb"),
                ("browser.preferred_url.value", "website"),
                ("whois.for_sale.value",        "for_sale"),
            ]:
                val = recs.get(key, "")
                if val:
                    if field == "twitter_handle" and not val.startswith("@"):
                        val = f"@{val}"
                    out[field] = val
            return out
    except Exception as e:
        log.debug(f"UD free {address}: {e}")

    # Fallback: UD public resolver via GraphQL
    try:
        q = """query($owner: String!) {
          domains(where: {owner: $owner}, first: 1) {
            name
            records { key value }
          }
        }"""
        r = requests.post(
            "https://api.thegraph.com/subgraphs/name/unstoppable-domains/dot-crypto-registry",
            json={"query": q, "variables": {"owner": address.lower()}},
            timeout=10,
        )
        if r.status_code == 200:
            domains = r.json().get("data", {}).get("domains", [])
            if domains:
                domain_name = domains[0].get("name", "")
                records_list = domains[0].get("records", [])
                out = {"ud_domain": domain_name}
                for rec in records_list:
                    k = rec.get("key", "")
                    v = rec.get("value", "")
                    if not v:
                        continue
                    if "email" in k:
                        out["email"] = v
                    elif "twitter" in k:
                        out["twitter_handle"] = f"@{v.lstrip('@')}"
                    elif "telegram" in k:
                        out["telegram"] = v
                    elif "linkedin" in k:
                        out["linkedin"] = v
                return out
    except Exception as e:
        log.debug(f"UD GraphQL {address}: {e}")
    return {}


# ─── Layer 2: Unstoppable Domains — extended fields ────────────────────────
def _ud_extended(address: str) -> dict:
    """
    Extended Unstoppable Domains fetch — extracts phone, physical address,
    discord, and all social fields in addition to email/twitter.
    Uses free public UD API (no key needed for basic resolution).
    """
    extra_keys = {
        "whois.email.value":              "ud_email",
        "whois.for_sale.value":           "ud_for_sale",
        "social.twitter.username":        "ud_twitter",
        "social.telegram.url":            "ud_telegram",
        "social.discord.url":             "ud_discord",
        "social.linkedin.url":            "ud_linkedin",
        "social.reddit.username":         "ud_reddit",
        "social.github.url":              "ud_github",
        "gundb.username.value":           "ud_gundb",
        "browser.preferred_url.value":    "ud_website",
        # Phone is sometimes stored under whois or custom key
        "whois.phone.value":              "ud_phone",
        "custom.phone":                   "ud_phone",
        # Physical address
        "whois.address.value":            "ud_address",
        "custom.address":                 "ud_address",
    }
    try:
        r = requests.get(
            f"https://api.unstoppabledomains.com/resolve/address/{address}",
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            meta = d.get("meta", {})
            recs = d.get("records", {})
            out: dict = {"ud_domain": meta.get("domain", "")}
            for src_key, dst_key in extra_keys.items():
                v = recs.get(src_key, "")
                if v and not out.get(dst_key):
                    out[dst_key] = v
            return out
    except Exception as e:
        log.debug(f"UD extended {address}: {e}")
    return {}


# ─── Layer 4: Airstack — Lens + Farcaster + ENS + XMTP ───────────────────
def fetch_airstack_socials(address: str) -> dict:
    """
    Airstack Wallet API — all on-chain social profiles in one call.
    Gives: Lens handle + followers, Farcaster username + followers, ENS primary,
           XMTP messaging enabled, all linked wallet addresses.
    Free plan: 1M queries/month — get key at app.airstack.xyz
    Set AIRSTACK_API_KEY in .env
    """
    if not AIRSTACK_KEY:
        return {}
    query = """query WalletSocials($identity: Identity!) {
      Wallet(input: {identity: $identity, blockchain: ethereum}) {
        socials {
          dappName
          profileName
          followerCount
          followingCount
          profileBio
          profileDisplayName
        }
        xmtp { isXMTPEnabled }
        primaryDomain { name }
        domains(input: {filter: {isPrimary: {_eq: true}}, limit: 1}) {
          name
        }
      }
    }"""
    try:
        r = requests.post(
            "https://api.airstack.xyz/gql",
            json={"query": query, "variables": {"identity": address}},
            headers={"Authorization": AIRSTACK_KEY},
            timeout=12,
        )
        if r.status_code == 200:
            wallet = (r.json().get("data") or {}).get("Wallet") or {}
            out = {"socials": [], "xmtp": False, "primary_domain": ""}
            for s in wallet.get("socials") or []:
                plat = s.get("dappName","").lower()
                out["socials"].append({
                    "platform": plat,
                    "username": s.get("profileName",""),
                    "display": s.get("profileDisplayName",""),
                    "bio": s.get("profileBio","")[:120],
                    "followers": s.get("followerCount",0),
                })
                # Surface Lens + Farcaster handles for quick access
                if plat == "lens" and not out.get("lens_handle"):
                    out["lens_handle"] = s.get("profileName","")
                    out["lens_followers"] = s.get("followerCount",0)
                if plat == "farcaster" and not out.get("farcaster_user"):
                    out["farcaster_user"] = s.get("profileName","")
                    out["farcaster_followers"] = s.get("followerCount",0)
                    out["farcaster_bio"] = s.get("profileBio","")
            xmtp = wallet.get("xmtp") or []
            if xmtp:
                out["xmtp"] = xmtp[0].get("isXMTPEnabled", False)
            domains = wallet.get("domains") or []
            if domains:
                out["primary_domain"] = domains[0].get("name","")
            return out
    except Exception as e:
        log.debug(f"Airstack {address}: {e}")
    return {}


# ─── Layer 4: Neynar — Farcaster verified wallets for this address ─────────
def fetch_farcaster_wallets(address: str) -> dict:
    """
    Neynar API: wallet address → Farcaster FID → ALL verified wallets.
    This is the KEY insight: if someone's ETH wallet is on Farcaster,
    you get ALL their other verified ETH + SOL wallets too.
    NEYNAR_KEY required (free plan: 100 req/day).
    """
    if not NEYNAR_KEY:
        return {}
    try:
        r = requests.get(
            f"https://api.neynar.com/v2/farcaster/user/bulk-by-address?addresses={address.lower()}",
            headers={"api_key": NEYNAR_KEY, "accept": "application/json"},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            # Response is {address: [user, ...]}
            users = data.get(address.lower(), []) or data.get(address, [])
            if not users:
                return {}
            user = users[0]
            va = user.get("verified_addresses") or {}
            eth_list = va.get("eth_addresses", [])
            sol_list = va.get("sol_addresses", [])
            twitter_handle = ""
            for acc in user.get("verified_accounts") or []:
                if acc.get("platform") == "x":
                    twitter_handle = f"@{acc['username']}"
                    break
            return {
                "display_name": user.get("display_name",""),
                "username": user.get("username",""),
                "fid": user.get("fid",""),
                "followers": user.get("follower_count",0),
                "bio": (user.get("profile") or {}).get("bio",{}).get("text",""),
                "twitter": twitter_handle,
                "eth_wallets": eth_list,           # all verified ETH addresses
                "sol_wallets": sol_list,           # all verified SOL addresses
                "custody_address": user.get("custody_address",""),
            }
    except Exception as e:
        log.debug(f"Neynar farcaster wallets {address}: {e}")
    return {}


# ─── Layer 5: Chainbase entity label ─────────────────────────────────────
def fetch_chainbase_label(address: str) -> dict:
    """
    Chainbase Labeling API — CEX, DeFi protocol, DAO, whale, smart money labels.
    Free plan: 5000 req/day — get key at chainbase.online
    Set CHAINBASE_API_KEY in .env
    """
    if not CHAINBASE_KEY:
        return {}
    try:
        r = requests.get(
            "https://api.chainbase.online/v1/address-label",
            params={"chain_id": "1", "address": address},
            headers={"x-api-key": CHAINBASE_KEY, "Content-Type": "application/json"},
            timeout=8,
        )
        if r.status_code == 200:
            d = r.json().get("data", {}) or {}
            return {
                "label": d.get("label", ""),
                "name": d.get("name", ""),
                "category": d.get("tag_type_desc", ""),
            }
    except Exception as e:
        log.debug(f"Chainbase label {address}: {e}")
    return {}


# ─── Layer 6: Constella breach / alternative breach enrichment ───────────
def fetch_breach_enrichment(email: str) -> dict:
    """
    Multi-source breach enrichment:
    1. CONSTELLA_API_KEY → Constella Intelligence (paid, very comprehensive)
    2. LEAKCHECK_KEY → LeakCheck Pro (already in fetch_leakcheck)
    3. Free: check breach field types via existing LeakCheck free call.
    Returns {"breach_email": ..., "breach_phone": ..., "kyc_name": ..., "sources": [...]}
    """
    if not email:
        return {}

    # Constella Intelligence (paid — most comprehensive, includes KYC leaks)
    if CONSTELLA_KEY:
        try:
            r = requests.get(
                "https://api.constella.ai/v2/identity/search",
                params={"email": email, "fields": "email,phone,name,dob"},
                headers={"Authorization": f"Bearer {CONSTELLA_KEY}"},
                timeout=12,
            )
            if r.status_code == 200:
                d = r.json()
                return {
                    "breach_email": d.get("email",""),
                    "breach_phone": d.get("phone",""),
                    "kyc_name":     d.get("name",""),
                    "sources":      d.get("sources",[]),
                }
        except Exception as e:
            log.debug(f"Constella {email}: {e}")

    # Fallback: LeakCheck (already called in _enrich_one, reuse result)
    # This function is called with the result of fetch_leakcheck
    return {}


def fetch_debank_public(address: str) -> dict:
    """
    DeBank public scraper — NO API key needed.
    Tries multiple public endpoints to get Twitter/Discord/name.
    """
    addr = address.lower()
    hdrs = {
        "Accept":     "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer":    "https://debank.com/",
        "Origin":     "https://debank.com",
        "source":     "web",
        "account":    addr,
    }

    # Try multiple DeBank public endpoints
    endpoints = [
        f"https://api.debank.com/user/addr?addr={addr}",
        f"https://api.debank.com/user/info?id={addr}",
        f"https://api.debank.com/social_ranking/user_info?id={addr}",
    ]
    for url in endpoints:
        try:
            r = requests.get(url, headers=hdrs, timeout=8)
            if r.status_code == 200:
                d = r.json().get("data", {}) or {}
                if not d:
                    continue
                out: dict = {}
                tw = (d.get("twitter_id") or d.get("twitter_username")
                      or d.get("twitter_name") or "")
                if tw:
                    out["twitter_handle"] = f"@{tw.lstrip('@')}"
                dc = d.get("discord_username") or d.get("discord") or ""
                if dc:
                    out["discord"] = dc
                name = d.get("name") or d.get("nickname") or d.get("desc") or ""
                if name:
                    out["name"] = name
                if out:
                    return out
        except Exception as e:
            log.debug(f"DeBank public {url}: {e}")

    # Scrape public HTML profile page as last resort
    try:
        r = requests.get(
            f"https://debank.com/profile/{addr}",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
            timeout=10,
        )
        out = {}
        m = re.search(r'"twitter[_\w]*"\s*:\s*"(@?[\w]+)"', r.text, re.I)
        if m:
            out["twitter_handle"] = f"@{m.group(1).lstrip('@')}"
        m2 = re.search(r'"discord[_\w]*"\s*:\s*"([\w#]+)"', r.text, re.I)
        if m2:
            out["discord"] = m2.group(1)
        if out:
            return out
    except Exception as e:
        log.debug(f"DeBank HTML {addr}: {e}")

    if DEBANK_KEY:
        return fetch_debank_profile(address)
    return {}


def fetch_ens_phone(ens_name: str) -> str:
    """
    Check ENS text records for phone number.
    Some older hodlers have set 'phone' or 'tel' text records on their ENS.
    Returns phone number string or ''
    """
    if not ens_name:
        return ""
    try:
        r = requests.get(f"https://api.ensideas.com/ens/resolve/{ens_name}", timeout=8)
        if r.status_code == 200:
            records = r.json().get("records", {})
            for key in ("phone", "tel", "mobile", "contact.phone"):
                val = records.get(key, "")
                if val and re.search(r"\d{7,}", val):
                    return val.strip()
    except Exception as e:
        log.debug(f"ENS phone {ens_name}: {e}")
    return ""


TWITTER_BEARER = os.getenv("TWITTER_BEARER", "")


def fetch_twitter_user(username: str) -> dict:
    """
    Twitter API v2 — lookup user profile by username (works on FREE tier).
    Returns {"id": ..., "name": ..., "username": ..., "description": ..., "verified": bool}
    """
    if not TWITTER_BEARER or not username:
        return {}
    handle = username.lstrip("@")
    try:
        r = requests.get(
            f"https://api.twitter.com/2/users/by/username/{handle}",
            params={"user.fields": "name,description,location,entities,verified,created_at"},
            headers={"Authorization": f"Bearer {TWITTER_BEARER}"},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json().get("data", {})
            if d:
                # Extract emails from bio/description
                bio = d.get("description", "")
                emails = re.findall(r"[\w.+-]+@[\w.-]+\.[a-z]{2,6}", bio, re.I)
                urls_in_bio = []
                try:
                    urls_in_bio = [u["expanded_url"] for u in
                                   d.get("entities", {}).get("url", {}).get("urls", [])]
                except Exception:
                    pass
                return {
                    "id":          d.get("id", ""),
                    "name":        d.get("name", ""),
                    "username":    d.get("username", ""),
                    "description": bio,
                    "location":    d.get("location", ""),
                    "created_at":  d.get("created_at", ""),
                    "verified":    d.get("verified", False),
                    "bio_emails":  emails,
                    "bio_urls":    urls_in_bio,
                }
    except Exception as e:
        log.debug(f"Twitter user lookup {handle}: {e}")
    return {}


def fetch_twitter_search(query: str) -> dict:
    """
    Search Twitter/X for wallet address / ENS name mentions.
    Uses Serper web search (Google results for twitter.com) since
    Twitter API v2 free tier does NOT include tweet search.

    Returns {"tweets": [...], "usernames": [...], "emails_found": [...]}
    """
    out: dict = {"tweets": [], "usernames": [], "emails_found": []}

    # Serper: search Google for twitter.com results mentioning the query
    results = _brave_search(f'site:twitter.com OR site:x.com "{query}"', count=10)
    for item in results:
        url  = item.get("url", "").lower()
        desc = item.get("description", "")
        # Extract username from twitter.com/USERNAME
        m = re.search(r"(?:twitter|x)\.com/([A-Za-z0-9_]{2,50})(?:/|$|\?)", url)
        if m:
            uname = m.group(1)
            skip  = {"search", "explore", "home", "i", "intent", "share", "hashtag", "settings"}
            if uname.lower() not in skip and uname not in out["usernames"]:
                out["usernames"].append(uname)
        if desc:
            out["tweets"].append(desc[:200])
            for e in re.findall(r"[\w.+-]+@[\w.-]+\.[a-z]{2,6}", desc, re.I):
                if e not in out["emails_found"]:
                    out["emails_found"].append(e)

    # If username found, verify + get bio via Twitter API (free tier)
    if out["usernames"] and TWITTER_BEARER:
        profile = fetch_twitter_user(out["usernames"][0])
        if profile.get("bio_emails"):
            out["emails_found"].extend(profile["bio_emails"])

    return out


def fetch_twitter_by_email(email: str) -> str:
    """
    Find Twitter/X account linked to an email address.
    Uses Serper (Google search) — searches for email on twitter.com pages.
    Returns "@username" or ""
    """
    if not email:
        return ""
    results = _brave_search(f'"{email}" site:twitter.com OR site:x.com', count=5)
    for item in results:
        url = item.get("url", "").lower()
        m = re.search(r"(?:twitter|x)\.com/([A-Za-z0-9_]{2,50})(?:/|$)", url)
        if m:
            uname = m.group(1)
            skip  = {"search", "explore", "home", "i", "intent", "settings"}
            if uname.lower() not in skip:
                return f"@{uname}"
    return ""


def fetch_nitter_search(query: str) -> dict:
    """Alias for fetch_twitter_search (Nitter mostly blocked now; uses Twitter API v2 + DDG)."""
    return fetch_twitter_search(query)


def fetch_leakcheck(query: str, query_type: str = "auto") -> dict:
    """
    LeakCheck.io breach database.

    FREE public endpoint (no key):
      - Returns: breach source names + which field types exist (email/phone/name etc.)
      - Does NOT return actual PII values
      - Useful for: confirming a username/email is real, knowing if phone data exists

    PAID Pro API (LEAKCHECK_KEY set):
      - Returns: actual emails, phones, names, addresses from breach records
      - $9.99/mo — worth it if you need real contact data

    Strategy (free): search username → if "phone" in fields → phone EXISTS in breach DB
    """
    LEAKCHECK_KEY = os.getenv("LEAKCHECK_KEY", "")

    # Pro API — returns actual data
    if LEAKCHECK_KEY:
        try:
            params = {"limit": 100}
            if query_type != "auto":
                params["type"] = query_type
            r = requests.get(
                f"https://leakcheck.io/api/v2/query/{requests.utils.quote(query)}",
                params=params,
                headers={"X-API-Key": LEAKCHECK_KEY, "User-Agent": "Mozilla/5.0"},
                timeout=12,
            )
            if r.status_code == 200:
                d = r.json()
                results = d.get("result", [])
                phones  = [x["phone"] for x in results if x.get("phone")]
                emails  = [x["email"] for x in results if x.get("email")]
                names   = [f"{x.get('first_name','')} {x.get('last_name','')}".strip()
                           for x in results if x.get("first_name") or x.get("last_name")]
                sources = [x["source"]["name"] for x in results if x.get("source")]
                dobs    = list({x["dob"] for x in results if x.get("dob")})
                addrs   = list({x["address"] for x in results if x.get("address")})
                return {
                    "emails":   list(dict.fromkeys(emails)),
                    "phones":   list(dict.fromkeys(phones)),
                    "names":    list(dict.fromkeys(names)),
                    "dobs":     dobs,
                    "addresses": addrs,
                    "sources":  sources,
                    "found_in": d.get("found", 0),
                }
        except Exception as e:
            log.debug(f"LeakCheck Pro {query}: {e}")

    # Free public endpoint — no key needed, 1 req/sec limit
    try:
        r = requests.get(
            "https://leakcheck.io/api/public",
            params={"check": query},
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("found"):
                fields   = d.get("fields", [])
                sources  = [s.get("name", "") for s in d.get("sources", [])]
                return {
                    "emails":         [],
                    "phones":         [],
                    "names":          [],
                    "sources":        sources,
                    "found_in":       d.get("found", 0),
                    "has_phone_data": "phone" in fields,   # phone EXISTS but can't see value
                    "has_email_data": "email" in fields,   # email EXISTS but can't see value
                    "fields_exposed": fields,
                }
    except Exception as e:
        log.debug(f"LeakCheck public {query}: {e}")
    return {}


def fetch_holonym_lookup(address: str) -> dict:
    """
    Holonym — on-chain KYC/identity attestations.
    If a whale did KYC-gated governance, their govt ID hash may be on-chain.
    This checks if address has any Holonym claims (free, no key).
    Returns {"has_kyc": bool, "country": "...", "phone_verified": bool}
    """
    try:
        r = requests.get(
            f"https://api.holonym.io/sbts/us-phone/is-attested?address={address}",
            timeout=8,
        )
        if r.status_code == 200:
            d = r.json()
            if d.get("result"):
                return {"has_phone_attestation": True}
    except Exception as e:
        log.debug(f"Holonym {address}: {e}")
    return {}


def fetch_phone_from_all(address: str, ens_name: str = "",
                         email: str = "", username: str = "") -> str:
    """
    Aggregate phone number from every available free source:
    1. ENS text records (direct phone field)
    2. WHOIS (already fetched separately)
    3. IntelX search on email/address (if key available)
    4. LeakCheck on email (if email known)
    5. Nitter tweet scrape (rare but possible)

    Returns first phone number found, or ''
    """
    # 1. ENS direct phone record
    phone = fetch_ens_phone(ens_name) if ens_name else ""
    if phone:
        log.debug(f"  Phone via ENS: {phone}")
        return phone

    # 2. IntelX search on the Ethereum address itself
    if INTELX_KEY and not phone:
        ix = fetch_intelx(address, "ethereum")
        phones = ix.get("phones", [])
        if phones:
            log.debug(f"  Phone via IntelX (addr): {phones[0]}")
            return phones[0]

    # 3. IntelX search on the email (if we have one)
    if INTELX_KEY and email and not phone:
        ix = fetch_intelx(email, "email")
        phones = ix.get("phones", [])
        if phones:
            log.debug(f"  Phone via IntelX (email): {phones[0]}")
            return phones[0]

    # 4. LeakCheck on email
    if email and not phone:
        lc = fetch_leakcheck(email, "email")
        # LeakCheck free doesn't return full records (just source names),
        # but paid returns phone — we still log it for context
        if lc.get("found_in", 0) > 0:
            log.debug(f"  Email found in {lc['found_in']} breach(es) — IntelX may have phone")

    return ""


def fetch_github_mentions(address: str) -> dict:
    """
    GitHub code search: find any repo that mentions this wallet address.
    If found, gets the repo owner's public email/name.
    Free GitHub personal token from github.com/settings/tokens.
    Returns {"github_user": "...", "email": "...", "name": "..."}
    """
    if not GITHUB_TOKEN:
        return {}
    try:
        r = requests.get(
            "https://api.github.com/search/code",
            params={"q": address, "per_page": 3},
            headers={
                "Accept":        "application/vnd.github.v3+json",
                "Authorization": f"token {GITHUB_TOKEN}",
                "User-Agent":    "whale-extractor",
            },
            timeout=15,
        )
        if r.status_code == 200:
            items = r.json().get("items", [])
            if items:
                owner_login = items[0]["repository"]["owner"]["login"]
                p = requests.get(
                    f"https://api.github.com/users/{owner_login}",
                    headers={"Authorization": f"token {GITHUB_TOKEN}"},
                    timeout=10,
                ).json()
                out = {"github_user": owner_login, "github_url": p.get("html_url", "")}
                if p.get("email"):
                    out["email"] = p["email"]
                if p.get("name"):
                    out["name"] = p["name"]
                return out
    except Exception as e:
        log.debug(f"GitHub {address}: {e}")
    return {}


BRAVE_SEARCH_KEY = os.getenv("BRAVE_SEARCH_KEY", "")   # optional — api.search.brave.com
SERPER_KEY       = os.getenv("SERPER_KEY", "")          # serper.dev — 2500 free queries


def _brave_search(query: str, count: int = 10) -> list:
    """
    Web search — tries in order:
    1. Serper.dev (2500 free/month, instant signup, no CC needed)
    2. Brave Search API (if BRAVE_SEARCH_KEY set)
    3. Playwright headless browser (fallback — no key needed)
    Returns list of {"url": ..., "description": ...}
    """
    # Method 1: Serper.dev — fastest, free 2500/month
    if SERPER_KEY:
        try:
            r = requests.post(
                "https://google.serper.dev/search",
                json={"q": query, "num": count, "gl": "us", "hl": "en"},
                headers={"X-API-KEY": SERPER_KEY, "Content-Type": "application/json"},
                timeout=10,
            )
            if r.status_code == 200:
                items = r.json().get("organic", [])
                return [{"url": x.get("link", ""), "description": x.get("snippet", "")}
                        for x in items if x.get("link")]
        except Exception as e:
            log.debug(f"Serper search: {e}")

    # Method 2: Brave Search API
    if BRAVE_SEARCH_KEY:
        try:
            r = requests.get(
                "https://api.search.brave.com/res/v1/web/search",
                params={"q": query, "count": count, "safesearch": "off"},
                headers={
                    "Accept":               "application/json",
                    "Accept-Encoding":      "gzip",
                    "X-Subscription-Token": BRAVE_SEARCH_KEY,
                },
                timeout=10,
            )
            if r.status_code == 200:
                items = r.json().get("web", {}).get("results", [])
                return [{"url": x.get("url", ""), "description": x.get("description", "")}
                        for x in items if x.get("url")]
        except Exception as e:
            log.debug(f"Brave search: {e}")

    # Method 3: DuckDuckGo HTML (completely free, no key)
    ddg = _ddg_search(query, count)
    if ddg:
        return ddg

    # Method 4: Bing scraper (free, no key)
    bing = _bing_search(query, count)
    if bing:
        return bing

    # Method 5: Playwright headless browser (no key, slower but works)
    return _playwright_search(query, count)


def _ddg_search(query: str, count: int = 10) -> list:
    """DuckDuckGo HTML scraper — 100% free, no API key, no rate limit."""
    try:
        hdrs = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
        }
        r = requests.post(
            "https://html.duckduckgo.com/html/",
            data={"q": query, "b": "", "kl": "us-en"},
            headers=hdrs, timeout=12,
        )
        results = []
        # DDG HTML: links are in <a class="result__a" href="...">
        for m in re.finditer(
            r'class="result__a"[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>',
            r.text, re.S
        ):
            url = m.group(1)
            title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
            if "duckduckgo.com" not in url:
                results.append({"url": url, "description": title})
                if len(results) >= count:
                    break
        # Fallback: grab any http URL from result blocks
        if not results:
            for m in re.finditer(r'href="(https?://(?!.*duckduckgo)[^"]+)"', r.text):
                url = m.group(1)
                if not any(skip in url for skip in ["duckduckgo", "duck.com"]):
                    results.append({"url": url, "description": ""})
                    if len(results) >= count:
                        break
        return results
    except Exception as e:
        log.debug(f"DDG search: {e}")
        return []


def _bing_search(query: str, count: int = 10) -> list:
    """Bing scraper — free, no API key needed."""
    try:
        hdrs = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml",
        }
        r = requests.get(
            "https://www.bing.com/search",
            params={"q": query, "count": count, "setlang": "en"},
            headers=hdrs, timeout=12,
        )
        results = []
        for m in re.finditer(r'<cite[^>]*>([^<]+)</cite>.*?<p[^>]*>(.*?)</p>', r.text, re.S):
            url_raw, snippet = m.group(1), re.sub(r"<[^>]+>", "", m.group(2))
            url = url_raw.strip()
            if not url.startswith("http"):
                url = "https://" + url
            results.append({"url": url, "description": snippet[:200]})
            if len(results) >= count:
                break
        return results
    except Exception as e:
        log.debug(f"Bing search: {e}")
        return []


def _playwright_search(query: str, count: int = 10) -> list:
    """
    Headless browser search via Playwright — no API key needed.
    Install: pip install playwright && python -m playwright install chromium
    Uses Google (headless Chrome bypasses bot detection better than requests).
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log.debug("Playwright not installed — run: pip install playwright && python -m playwright install chromium")
        return []

    results = []
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                locale="en-US",
            )
            page = ctx.new_page()
            page.goto(f"https://www.google.com/search?q={requests.utils.quote(query)}&num={count}&hl=en", timeout=15000)
            page.wait_for_timeout(2000)

            # Extract result links + snippets
            items = page.query_selector_all("div.g")
            for item in items[:count]:
                try:
                    a = item.query_selector("a")
                    url = a.get_attribute("href") if a else ""
                    snippet_el = item.query_selector("div.VwiC3b, span.aCOpRe, div[data-sncf]")
                    snippet = snippet_el.inner_text() if snippet_el else ""
                    if url and url.startswith("http") and "google.com" not in url:
                        results.append({"url": url, "description": snippet[:300]})
                except Exception:
                    pass
            browser.close()
    except Exception as e:
        log.debug(f"Playwright search: {e}")

    return results


def _parse_search_results(results: list) -> tuple:
    """
    Parse search result list [{url, description}].
    Returns (list_of_urls, list_of_emails).
    """
    urls   = [r["url"] for r in results if r.get("url")]
    emails = []
    _junk  = ("example.", "w3.org", "schema.org", "cloudflare", "microsoft.com",
               "google.com", ".png@", ".jpg@", ".gif@")
    for r in results:
        for e in re.findall(r"[\w.+-]+@[\w.-]+\.[a-z]{2,6}", r.get("description", ""), re.I):
            if not any(j in e.lower() for j in _junk) and e not in emails:
                emails.append(e)
    return urls, emails


def _parse_bing_results(html: str) -> tuple:
    """Stub — Bing is JS-rendered, kept for compatibility. Use _brave_search instead."""
    return [], []


def fetch_web_osint(address: str, ens_name: str = "") -> dict:
    """
    Bing search for wallet address / ENS name.
    Finds social profile links + emails in search results.
    No API key needed — completely free.
    Returns {"twitter": URL, "linkedin": URL, "telegram": "@...", "email": "...", "mentions": [...]}
    """
    import urllib.parse

    found: dict = {
        "twitter": "", "linkedin": "", "telegram": "",
        "github": "", "reddit": "", "email": "", "mentions": [],
    }

    queries = [address]
    if ens_name:
        queries.append(ens_name)

    for query in queries:
        # Brave Search API (free 2000/month) — best option
        results = _brave_search(f'"{query}"')
        if results:
            links, emails = _parse_search_results(results)
        else:
            links, emails = [], []

        for url in links:
            u = url.lower()
            if ("twitter.com/" in u or "x.com/" in u) and not found["twitter"]:
                found["twitter"] = url
            elif "linkedin.com/in/" in u and not found["linkedin"]:
                found["linkedin"] = url
            elif "t.me/" in u and not found["telegram"]:
                handle = re.split(r"[/?#]", url.split("t.me/")[-1])[0]
                found["telegram"] = f"@{handle}" if handle else ""
            elif "github.com/" in u and not found["github"] and "trending" not in u:
                found["github"] = url
            elif "reddit.com/" in u and not found["reddit"]:
                found["reddit"] = url
            _skip = ("brave.com", "etherscan", "blockchain.com",
                     "ethplorer", "blockchair", "debank.com", "zerion.io")
            if not any(s in u for s in _skip):
                found["mentions"].append(url)
        for e in emails:
            if not found["email"]:
                found["email"] = e

    # Deduplicate mentions
    found["mentions"] = list(dict.fromkeys(found["mentions"]))[:5]
    return found


def fetch_whois_contact(url_or_domain: str) -> dict:
    """
    WHOIS lookup on personal website/domain linked in ENS records.
    Extracts registrant email, phone, name/org — often real contact info.
    No API key needed (uses python-whois or free WHOIS API fallback).
    Returns {"email": "...", "phone": "...", "name": "...", "org": "..."}
    """
    if not url_or_domain:
        return {}
    try:
        import urllib.parse
        parsed = urllib.parse.urlparse(
            url_or_domain if "://" in url_or_domain else f"https://{url_or_domain}"
        )
        domain = (parsed.netloc or parsed.path).replace("www.", "").strip("/")
        if not domain or "." not in domain:
            return {}

        # Try python-whois (pip install python-whois)
        try:
            import whois as _whois
            w = _whois.whois(domain)
            out: dict = {}
            emails = w.emails or []
            if isinstance(emails, str):
                emails = [emails]
            _privacy = (
                "privacy", "proxy", "protect", "redact", "domain", "whois",
                "abuse", "namecheap", "godaddy", "cloudflare", "tucows",
                "networksolutions", "enom", "registrar", "contactprivacy",
                "domainsbyproxy", "whoisprivacy", "dnstination", "alias",
                "withheld", "not disclosed", "noreply",
            )
            real = [e for e in emails if not any(p in e.lower() for p in _privacy)]
            if real:
                out["email"] = real[0]
            if getattr(w, "name", None):
                out["name"] = w.name
            if getattr(w, "org", None):
                out["org"] = w.org
            phones = getattr(w, "phone", None)
            if phones:
                out["phone"] = phones if isinstance(phones, str) else phones[0]
            if out:
                out["whois_domain"] = domain
                return out
        except ImportError:
            pass

        # Fallback: free WHOIS API (jsonwhois.com — no key needed for basic)
        r = requests.get(
            f"https://jsonwhois.com/api/v1/whois",
            params={"domain": domain},
            headers={"Accept": "application/json"},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            out = {}
            for contact in d.get("registrant", []):
                if contact.get("email"):
                    out["email"] = contact["email"]
                if contact.get("phone"):
                    out["phone"] = contact["phone"]
                if contact.get("name"):
                    out["name"] = contact["name"]
            if out:
                out["whois_domain"] = domain
            return out
    except Exception as e:
        log.debug(f"WHOIS {url_or_domain}: {e}")
    return {}


def check_username_platforms(username: str) -> dict:
    """
    Cross-platform username existence check.
    If we found Twitter handle / ENS name / Farcaster username,
    check if same username exists on: Telegram, GitHub, Reddit, LinkedIn.
    Returns {"telegram": "t.me/user", "github": "github.com/user", ...}
    """
    if not username or len(username) < 3:
        return {}
    uname = username.lstrip("@").strip().lower()
    found: dict = {}

    checks = [
        # (platform, url, check_type, expected)
        ("telegram",   f"https://t.me/{uname}",                       "status", 200),
        ("github",     f"https://github.com/{uname}",                 "status", 200),
        ("reddit",     f"https://www.reddit.com/user/{uname}/about.json", "status", 200),
        ("medium",     f"https://medium.com/@{uname}",                "status", 200),
        ("instagram",  f"https://www.instagram.com/{uname}/",         "notfound_404", 200),
    ]
    hdrs = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

    for platform, url, check_type, expected in checks:
        try:
            r = requests.get(url, timeout=6, headers=hdrs,
                             allow_redirects=True)
            if r.status_code == expected:
                # Extra validation to avoid false positives
                if platform == "telegram" and "tgme_page_title" not in r.text and "og:title" not in r.text:
                    continue
                if platform == "reddit" and '"error"' in r.text:
                    continue
                if platform == "github" and "Not Found" in r.text:
                    continue
                found[platform] = url
        except Exception:
            pass

    return found


def fetch_fragment_ton_username(eth_address: str) -> str:
    """
    Fragment.com — Telegram usernames are sold as NFTs on TON blockchain.
    If the person has a TON wallet (same ETH key exported to TON format),
    check if they own any Fragment username NFTs.
    Returns Telegram username if found, else "".
    Note: Only works if person uses same key on both ETH and TON.
    """
    # Convert ETH address to raw TON-friendly form for lookup
    # Most people DON'T link ETH→TON, but worth checking Fragment search
    try:
        # Fragment public search (no key needed)
        search_term = eth_address[:10].lower()
        r = requests.get(
            "https://fragment.com/username/search",
            params={"query": search_term, "blockchain": "ton"},
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            timeout=10,
        )
        if r.status_code == 200:
            data = r.json()
            items = data.get("results", []) or data.get("auctions", [])
            for item in items:
                owner = str(item.get("owner", "") or "").lower()
                if eth_address.lower() in owner:
                    name = item.get("name") or item.get("username", "")
                    if name:
                        return f"@{name.lstrip('@')}"
    except Exception as e:
        log.debug(f"Fragment {eth_address}: {e}")
    return ""


def run_sherlock(username: str) -> dict:
    """
    Sherlock OSINT — 300+ platforms username search.
    Install: pip install sherlock-project
    Returns {"found_platforms": [...], "profile_urls": [...]}
    """
    if not username:
        return {}
    uname = username.lstrip("@").strip()
    try:
        import subprocess, json as _json, tempfile, os as _os
        with tempfile.TemporaryDirectory() as tmpdir:
            subprocess.run(
                ["python", "-m", "sherlock", uname, "--json",
                 "--output", _os.path.join(tmpdir, "out.json"), "--timeout", "5"],
                capture_output=True, text=True, timeout=60,
            )
            out_file = _os.path.join(tmpdir, "out.json")
            if _os.path.exists(out_file):
                data = _json.load(open(out_file))
                found  = [p for p, v in data.items() if v.get("status") == "Claimed"]
                urls   = [v.get("url_user", "") for p, v in data.items()
                          if v.get("status") == "Claimed"]
                return {"found_platforms": found, "profile_urls": urls[:10]}
    except FileNotFoundError:
        log.debug("Sherlock not installed. pip install sherlock-project")
    except Exception as e:
        log.debug(f"Sherlock {username}: {e}")
    return {}


def run_maigret(username: str) -> dict:
    """
    Maigret OSINT — 2000+ platforms username search (more than Sherlock).
    Install: pip install maigret
    Returns {"found_platforms": [...], "profile_urls": [...]}
    """
    if not username:
        return {}
    uname = username.lstrip("@").strip()
    try:
        import subprocess, json as _json, tempfile, os as _os
        with tempfile.TemporaryDirectory() as tmpdir:
            out_file = _os.path.join(tmpdir, "report.json")
            subprocess.run(
                ["python", "-m", "maigret", uname,
                 "--json", out_file, "--timeout", "5", "--max-connections", "10"],
                capture_output=True, text=True, timeout=90,
            )
            if _os.path.exists(out_file):
                data = _json.load(open(out_file))
                found, urls = [], []
                for site, info in data.items():
                    if isinstance(info, dict) and info.get("status") in ("Claimed", "Found"):
                        found.append(site)
                        if info.get("url"):
                            urls.append(info["url"])
                return {"found_platforms": found, "profile_urls": urls[:15]}
    except FileNotFoundError:
        log.debug("Maigret not installed. pip install maigret")
    except Exception as e:
        log.debug(f"Maigret {username}: {e}")
    return {}


# IntelX keys config — free.intelx.io (free) or 2.intelx.io (paid)
INTELX_KEY  = os.getenv("INTELX_KEY", "")
INTELX_HOST = os.getenv("INTELX_HOST", "https://2.intelx.io")  # auto-set to free host if free key
# Apify key — apify.com free plan: $5 credit/month
APIFY_KEY  = os.getenv("APIFY_KEY", "")


def fetch_intelx(query: str, query_type: str = "email") -> dict:
    """
    IntelX search — indexed web, breach data, Tor, I2P, paste sites.
    Works for: email, domain, IP, Bitcoin/Ethereum address, phone, username.
    Free plan: 1000 queries/month — intelx.io/signup
    Returns {"records_found": N, "sources": [...], "emails": [...], "phones": [...]}
    """
    if not INTELX_KEY:
        return {}
    try:
        # Step 1: Submit search (free.intelx.io for free plan, 2.intelx.io for paid)
        search_r = requests.post(
            f"{INTELX_HOST}/intelligent/search",
            json={"term": query, "maxresults": 20, "media": 0, "target": 0, "terminate": []},
            headers={"x-key": INTELX_KEY, "Content-Type": "application/json"},
            timeout=15,
        )
        if search_r.status_code != 200:
            return {}
        search_id = search_r.json().get("id", "")
        if not search_id:
            return {}

        # Step 2: Get results (wait briefly)
        time.sleep(2)
        results_r = requests.get(
            f"{INTELX_HOST}/intelligent/search/result",
            params={"id": search_id, "limit": 20},
            headers={"x-key": INTELX_KEY},
            timeout=15,
        )
        if results_r.status_code != 200:
            return {}

        records = results_r.json().get("records", [])
        out: dict = {"records_found": len(records), "sources": [], "emails": [], "phones": []}

        for rec in records:
            src  = rec.get("systemid", "") or rec.get("bucket", "")
            name = rec.get("name", "")
            if src and src not in out["sources"]:
                out["sources"].append(src)
            # Extract emails from name/media type
            emails = re.findall(r"[\w.+-]+@[\w.-]+\.[a-z]{2,6}", name, re.I)
            phones = re.findall(r"[\+]?[1-9]\d{7,14}", name)
            out["emails"].extend(e for e in emails if e not in out["emails"])
            out["phones"].extend(p for p in phones if p not in out["phones"])

        return out
    except Exception as e:
        log.debug(f"IntelX {query}: {e}")
    return {}


def fetch_intelx_phonebook(query: str, target: int = 2, maxresults: int = 100) -> dict:
    """
    IntelX Phonebook search — finds email/phone contacts associated with a domain or name.
    target: 0=mixed, 1=email, 2=domain, 3=URL, 4=email+domain
    Use case:
      - domain → all emails ever seen in leaks for that domain (e.g. "@company.com")
      - full name → email addresses linked to that person in indexed pastes/leaks

    Returns {"emails": [...], "phones": [...], "count": N}
    """
    if not INTELX_KEY:
        return {}
    try:
        search_r = requests.post(
            f"{INTELX_HOST}/phonebook/search",
            json={"term": query, "maxresults": maxresults, "target": target, "terminate": []},
            headers={"x-key": INTELX_KEY, "Content-Type": "application/json"},
            timeout=15,
        )
        if search_r.status_code != 200:
            return {}
        search_id = search_r.json().get("id", "")
        if not search_id:
            return {}

        time.sleep(2)
        results_r = requests.get(
            f"{INTELX_HOST}/phonebook/search/result",
            params={"id": search_id, "limit": maxresults},
            headers={"x-key": INTELX_KEY},
            timeout=15,
        )
        if results_r.status_code != 200:
            return {}

        records = results_r.json().get("selectors", [])
        emails, phones = [], []
        for rec in records:
            val = rec.get("selectorvalue", "")
            if "@" in val:
                if val not in emails:
                    emails.append(val)
            elif re.match(r"[\+]?[1-9]\d{7,14}$", val.replace(" ", "")):
                if val not in phones:
                    phones.append(val)

        return {"emails": emails[:50], "phones": phones[:20], "count": len(records)}
    except Exception as e:
        log.debug(f"IntelX phonebook {query}: {e}")
    return {}


def fetch_leakcheck_by_phone(phone: str) -> dict:
    """
    LeakCheck — lookup by phone number directly.
    Returns names, emails, sources linked to this phone in breach databases.
    Requires LEAKCHECK_KEY (paid).
    """
    return fetch_leakcheck(phone, query_type="phone")


def fetch_leakcheck_by_username(username: str) -> dict:
    """
    LeakCheck — lookup by username.
    Returns emails, phones, names linked to this username across breaches.
    Free tier returns source names; paid returns actual values.
    """
    return fetch_leakcheck(username, query_type="login")


def fetch_pdl_person(email: str = "", phone: str = "", name: str = "", location: str = "") -> dict:
    """
    People Data Labs — person enrichment from PUBLIC sources (LinkedIn, social profiles, etc.)
    NOT breach data. Returns actual values: name, gender, DOB, phone, location, job, social URLs.

    Free: 1000 credits/month — signup at app.peopledatalabs.com (instant, no credit card)
    100-200 whales = 100-200 credits — well within free tier.

    Input priority: email (best) > phone > name+location
    Returns: {name, first_name, last_name, gender, birth_year, phone, city, state, country,
              linkedin_url, twitter_url, github_url, job_title, company, industry}
    """
    if not PDL_KEY:
        return {}
    params: dict = {"pretty": False, "min_likelihood": 4}
    if email:
        params["email"] = email
    elif phone:
        params["phone"] = phone
    elif name:
        params["name"] = name
        if location:
            params["location"] = location
    else:
        return {}

    try:
        r = requests.get(
            "https://api.peopledatalabs.com/v5/person/enrich",
            params=params,
            headers={"X-Api-Key": PDL_KEY, "Content-Type": "application/json"},
            timeout=12,
        )
        if r.status_code == 404:
            return {}          # person not found — not an error
        if r.status_code != 200:
            log.debug(f"PDL {email or phone}: status {r.status_code}")
            return {}

        d = r.json()
        data = d.get("data", {}) or {}
        if not data:
            return {}

        loc = (data.get("location") or {})
        return {
            "pdl_name":       data.get("full_name", ""),
            "pdl_first":      data.get("first_name", ""),
            "pdl_last":       data.get("last_name", ""),
            "pdl_gender":     data.get("gender", ""),
            "pdl_birth_year": str(data.get("birth_year", "") or ""),
            "pdl_phone":      (data.get("mobile_phone") or
                               (data.get("phone_numbers") or [""])[0]),
            "pdl_city":       loc.get("locality", ""),
            "pdl_state":      loc.get("region", ""),
            "pdl_country":    loc.get("country", ""),
            "pdl_postal":     loc.get("postal_code", ""),
            "pdl_linkedin":   data.get("linkedin_url", ""),
            "pdl_twitter":    data.get("twitter_url", ""),
            "pdl_github":     data.get("github_url", ""),
            "pdl_job":        data.get("job_title", ""),
            "pdl_company":    data.get("job_company_name", ""),
            "pdl_industry":   data.get("industry", ""),
        }
    except Exception as e:
        log.debug(f"PDL {email}: {e}")
    return {}


# ══════════════════════════════════════════════════════════════════════════════
# NEW EMAIL SOURCES — Option 1 upgrade
# Hit rate improvement: 10% → 25%+ per 1000 wallets
# All free, no API key required except OpenSea (optional)
# ══════════════════════════════════════════════════════════════════════════════

def fetch_opensea_profile(address: str) -> dict:
    """
    OpenSea — wallet → NFT profile → twitter, instagram, website, bio.
    No key needed for basic. OPENSEA_API_KEY = better rate limits.
    Hit rate: ~15% for NFT-active wallets.
    Returns: {os_username, os_bio, os_website, os_twitter, os_instagram}
    """
    try:
        hdrs: dict = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
        if OPENSEA_KEY:
            hdrs["X-API-KEY"] = OPENSEA_KEY
        r = requests.get(
            f"https://api.opensea.io/api/v2/accounts/{address.lower()}",
            headers=hdrs, timeout=10,
        )
        if r.status_code != 200:
            return {}
        d = r.json()
        return {
            "os_username":  d.get("username", ""),
            "os_bio":       (d.get("bio") or "")[:200],
            "os_website":   d.get("website", ""),
            "os_twitter":   d.get("twitter_username", ""),
            "os_instagram": d.get("instagram_username", ""),
        }
    except Exception as e:
        log.debug(f"OpenSea {address}: {e}")
    return {}


def fetch_lens_profile(address: str) -> dict:
    """
    Lens Protocol — wallet → Lens handle → name, bio, twitter, website.
    Uses Lens v2 API. Free, no key needed.
    Hit rate: ~8% of active DeFi wallets.
    """
    # Lens v2 ownedBy query
    query = """
    query($address: EthereumAddress!) {
      profiles(request: { ownedBy: [$address], limit: One }) {
        items {
          handle { fullHandle }
          metadata {
            displayName
            bio
            attributes { key value }
          }
        }
      }
    }
    """
    for endpoint in [
        "https://api-v2.lens.dev/graphql",
        "https://api.lens.xyz/graphql",
    ]:
        try:
            r = requests.post(
                endpoint,
                json={"query": query, "variables": {"address": address}},
                headers={"Content-Type": "application/json",
                         "Origin": "https://share.lens.xyz"},
                timeout=10,
            )
            if r.status_code != 200 or r.text.strip().startswith("<"):
                continue
            items = ((r.json().get("data") or {})
                     .get("profiles", {}).get("items") or [])
            if not items:
                return {}
            p    = items[0]
            meta = p.get("metadata") or {}
            attrs = {a["key"].lower(): a["value"]
                     for a in (meta.get("attributes") or [])}
            return {
                "lens_handle":  (p.get("handle") or {}).get("fullHandle", ""),
                "lens_name":    meta.get("displayName", ""),
                "lens_bio":     (meta.get("bio") or "")[:200],
                "lens_twitter": attrs.get("twitter","") or attrs.get("x",""),
                "lens_website": attrs.get("website","") or attrs.get("url",""),
                "lens_email":   attrs.get("email",""),
            }
        except Exception as e:
            log.debug(f"Lens {endpoint} {address}: {e}")
    return {}


def fetch_snapshot_profile(address: str) -> dict:
    """
    Snapshot.org — DAO governance voters → name, twitter, github, lens handle.
    Free public GraphQL — no key needed.
    Hit rate: ~8% (DeFi/DAO whales actively vote).
    Returns: {snap_name, snap_twitter, snap_github, snap_lens, snap_about}
    """
    query = """
    query($id: String!) {
      user(id: $id) {
        name
        about
        twitter
        github
        lens
      }
    }
    """
    try:
        r = requests.post(
            "https://hub.snapshot.org/graphql",
            json={"query": query, "variables": {"id": address.lower()}},
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        if r.status_code != 200:
            return {}
        u = (r.json().get("data") or {}).get("user") or {}
        if not any(u.get(k) for k in ["name", "twitter", "github", "lens"]):
            return {}
        return {
            "snap_name":    u.get("name", ""),
            "snap_about":   (u.get("about") or "")[:150],
            "snap_twitter": u.get("twitter", ""),
            "snap_github":  u.get("github", ""),
            "snap_lens":    u.get("lens", ""),
        }
    except Exception as e:
        log.debug(f"Snapshot {address}: {e}")
    return {}


def fetch_mirror_profile(address: str) -> dict:
    """
    Mirror.xyz — Web3 blogging platform, wallet → author profile → name + twitter.
    Free public API — no key needed.
    Hit rate: ~3% (writers/founders).
    Returns: {mirror_name, mirror_twitter, mirror_bio}
    """
    query = """
    query($projectAddress: String!) {
      projectFeed(projectAddress: $projectAddress, limit: 1) {
        project {
          displayName
          description
          twitterUsername
        }
      }
    }
    """
    try:
        r = requests.post(
            "https://mirror.xyz/api/graphql",
            json={"query": query, "variables": {"projectAddress": address}},
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        if r.status_code != 200:
            return {}
        feed = (r.json().get("data") or {}).get("projectFeed") or {}
        proj = feed.get("project") or {}
        if not proj.get("displayName"):
            return {}
        return {
            "mirror_name":    proj.get("displayName", ""),
            "mirror_bio":     (proj.get("description") or "")[:150],
            "mirror_twitter": proj.get("twitterUsername", ""),
        }
    except Exception as e:
        log.debug(f"Mirror {address}: {e}")
    return {}


def fetch_debank_social(address: str) -> dict:
    """
    DeBank public endpoint — wallet → twitter/discord without needing Pro key.
    Free, no key needed. DEBANK_KEY = more data (100 req/day free).
    Hit rate: ~15% (most active DeFi wallets have DeBank profiles).
    Returns: {db_twitter, db_discord, db_name, db_email}
    """
    try:
        # Try Pro API first if key available
        if os.getenv("DEBANK_KEY"):
            r = requests.get(
                f"https://pro-openapi.debank.com/v1/user/addr?id={address.lower()}",
                headers={"AccessKey": os.getenv("DEBANK_KEY","")},
                timeout=10,
            )
            if r.status_code == 200:
                d = (r.json() or {})
                return {
                    "db_twitter":  d.get("twitter_username", ""),
                    "db_discord":  d.get("discord_username", ""),
                    "db_name":     d.get("name", ""),
                    "db_email":    d.get("email", ""),
                }

        # Public fallback
        r = requests.get(
            f"https://api.debank.com/user?id={address.lower()}",
            headers={"source": "web", "User-Agent": "Mozilla/5.0 Chrome/120"},
            timeout=10,
        )
        if r.status_code == 200:
            d = ((r.json() or {}).get("data") or {}).get("user") or {}
            return {
                "db_twitter":  d.get("twitter_username", "") or d.get("twitter_id", ""),
                "db_discord":  d.get("discord_username", ""),
                "db_name":     d.get("name", ""),
                "db_email":    d.get("email", ""),
            }
    except Exception as e:
        log.debug(f"DeBank {address}: {e}")
    return {}


def fetch_all_social_sources(address: str) -> dict:
    """
    Runs all 5 new social sources in parallel and merges results.
    Returns unified dict with best available twitter, email, name, etc.
    """
    import concurrent.futures
    results: dict = {}

    def _run(fn, addr):
        try:
            return fn(addr)
        except Exception:
            return {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        futures = {
            ex.submit(_run, fetch_opensea_profile, address): "os",
            ex.submit(_run, fetch_lens_profile, address):    "lens",
            ex.submit(_run, fetch_snapshot_profile, address):"snap",
            ex.submit(_run, fetch_mirror_profile, address):  "mirror",
            ex.submit(_run, fetch_debank_social, address):   "db",
        }
        for fut, src in futures.items():
            try:
                results[src] = fut.result(timeout=15) or {}
            except Exception:
                results[src] = {}

    os_    = results["os"]
    lens_  = results["lens"]
    snap_  = results["snap"]
    mirror = results["mirror"]
    db_    = results["db"]

    # Merge: priority = Lens email > DeBank email > OS website > Snapshot > Mirror
    merged: dict = {}

    # Email (rarest, highest value)
    merged["extra_email"] = (
        lens_.get("lens_email") or
        db_.get("db_email") or ""
    )

    # Twitter (best available)
    merged["extra_twitter"] = (
        db_.get("db_twitter") or
        os_.get("os_twitter") or
        snap_.get("snap_twitter") or
        mirror.get("mirror_twitter") or
        lens_.get("lens_twitter") or ""
    )

    # Name
    merged["extra_name"] = (
        db_.get("db_name") or
        lens_.get("lens_name") or
        mirror.get("mirror_name") or
        snap_.get("snap_name") or ""
    )

    # Website / URL (good for WHOIS)
    merged["extra_website"] = (
        os_.get("os_website") or
        lens_.get("lens_website") or ""
    )

    # GitHub
    merged["extra_github"] = snap_.get("snap_github") or ""

    # Discord
    merged["extra_discord"] = db_.get("db_discord") or ""

    # Lens handle
    merged["lens_handle_new"] = lens_.get("lens_handle") or ""

    # OpenSea username
    merged["os_username"] = os_.get("os_username") or ""

    # Raw source data for CSV
    merged["_os"]     = os_
    merged["_lens"]   = lens_
    merged["_snap"]   = snap_
    merged["_mirror"] = mirror
    merged["_db"]     = db_

    return merged


_leakcheck_last_call = 0.0

def fetch_leakcheck_ratelimited(query: str, query_type: str = "auto") -> dict:
    """
    Rate-limited wrapper for fetch_leakcheck.
    LeakCheck public = 1 req/sec. This enforces the limit automatically
    so bulk whale enrichment (100-200 wallets) won't get blocked.
    """
    global _leakcheck_last_call
    elapsed = time.time() - _leakcheck_last_call
    if elapsed < 1.05:
        time.sleep(1.05 - elapsed)
    _leakcheck_last_call = time.time()
    return fetch_leakcheck(query, query_type)


def fetch_apify_wallet_twitter(address: str) -> str:
    """
    Apify scraper: Wallet address → Twitter handle.
    Uses 'lukaskrivka/crypto-wallet-twitter-lookup' actor.
    Free plan: $5 credit/month — apify.com/sign-up
    Returns Twitter handle or "".
    """
    if not APIFY_KEY:
        return ""
    try:
        # Run Apify actor
        run_r = requests.post(
            "https://api.apify.com/v2/acts/lukaskrivka~crypto-wallet-twitter-lookup/runs",
            json={"walletAddress": address, "maxResults": 1},
            params={"token": APIFY_KEY},
            timeout=20,
        )
        if run_r.status_code not in (200, 201):
            return ""

        run_id = run_r.json().get("data", {}).get("id", "")
        if not run_id:
            return ""

        # Poll for result (max 30s)
        for _ in range(6):
            time.sleep(5)
            status_r = requests.get(
                f"https://api.apify.com/v2/acts/lukaskrivka~crypto-wallet-twitter-lookup/runs/{run_id}",
                params={"token": APIFY_KEY},
                timeout=10,
            )
            status = status_r.json().get("data", {}).get("status", "")
            if status == "SUCCEEDED":
                dataset_id = status_r.json()["data"]["defaultDatasetId"]
                items_r = requests.get(
                    f"https://api.apify.com/v2/datasets/{dataset_id}/items",
                    params={"token": APIFY_KEY},
                    timeout=10,
                )
                items = items_r.json()
                if items:
                    handle = items[0].get("twitterHandle") or items[0].get("twitter", "")
                    return f"@{handle.lstrip('@')}" if handle else ""
            elif status in ("FAILED", "TIMED-OUT", "ABORTED"):
                break
    except Exception as e:
        log.debug(f"Apify {address}: {e}")
    return ""


# Email verification API keys
ABSTRACT_KEY    = os.getenv("ABSTRACT_KEY", "")      # abstractapi.com/email-validation (100 free/month)
ZEROBOUNCE_KEY  = os.getenv("ZEROBOUNCE_KEY", "")    # zerobounce.net (100 free/month)
HUNTER_KEY      = os.getenv("HUNTER_KEY", "")        # hunter.io (25 find+verify free/month)

# Disposable/throwaway email domains — skip these
_DISPOSABLE_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "tempmail.com", "10minutemail.com",
    "throwaway.email", "yopmail.com", "sharklasers.com", "guerrillamailblock.com",
    "grr.la", "guerrillamail.info", "spam4.me", "trashmail.com", "maildrop.cc",
    "dispostable.com", "fakeinbox.com", "mailnull.com", "spamgourmet.com",
}

# Major providers where SMTP check always returns true (catch-all)
_MAJOR_PROVIDERS = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr",
    "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
    "icloud.com", "me.com", "mac.com", "protonmail.com", "proton.me",
    "aol.com", "zoho.com", "yandex.com", "yandex.ru", "mail.ru",
}


def _check_mx_record(domain: str) -> str:
    """Returns MX hostname if domain has email configured, else ''."""
    try:
        import dns.resolver
        records = dns.resolver.resolve(domain, "MX")
        best = sorted(records, key=lambda r: r.preference)[0]
        return str(best.exchange).rstrip(".")
    except Exception:
        pass
    # Fallback: nslookup via subprocess
    try:
        import subprocess
        out = subprocess.run(
            ["nslookup", "-type=MX", domain],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            if "mail exchanger" in line.lower() or "MX" in line:
                parts = line.strip().split()
                if parts:
                    return parts[-1].rstrip(".")
    except Exception:
        pass
    return ""


def verify_email_smtp(email: str, timeout: int = 8) -> str:
    """
    SMTP verification — no email sent, no API key needed.
    Connects to mail server and checks if address is accepted.
    Returns: 'valid' | 'invalid' | 'unknown'
    NOTE: Major providers (Gmail/Outlook) always return 'unknown'.
    """
    if not re.match(r"^[\w.+\-]+@[\w.\-]+\.[a-z]{2,10}$", email, re.I):
        return "invalid_format"

    domain = email.split("@")[1].lower()

    if domain in _DISPOSABLE_DOMAINS:
        return "disposable"
    if domain in _MAJOR_PROVIDERS:
        return "unknown_major_provider"

    mx_host = _check_mx_record(domain)
    if not mx_host:
        return "no_mx_record"

    try:
        import smtplib
        with smtplib.SMTP(timeout=timeout) as s:
            s.connect(mx_host, 25)
            s.ehlo("verify.local")
            s.mail("noreply@verify.local")
            code, _ = s.rcpt(email)
            if code == 250:
                return "valid"
            elif code in (550, 551, 552, 553, 554):
                return "invalid"
            else:
                return "unknown"
    except smtplib.SMTPConnectError:
        return "unknown_smtp_blocked"
    except Exception as e:
        log.debug(f"SMTP {email}: {e}")
        return "unknown"


def verify_email_abstract(email: str) -> str:
    """
    Abstract API email validation — 100 free requests/month.
    Get key: abstractapi.com/email-validation → Free plan → API Key
    Returns: 'valid' | 'invalid' | 'risky' | 'unknown'
    """
    if not ABSTRACT_KEY:
        return "no_key"
    try:
        r = requests.get(
            "https://emailvalidation.abstractapi.com/v1/",
            params={"api_key": ABSTRACT_KEY, "email": email},
            timeout=10,
        )
        if r.status_code == 200:
            d = r.json()
            deliverability = d.get("deliverability", "").upper()
            is_mx       = d.get("is_mx_found", {}).get("value", False)
            is_smtp     = d.get("is_smtp_valid", {}).get("value", False)
            is_disp     = d.get("is_disposable_email", {}).get("value", False)

            if is_disp:
                return "disposable"
            if deliverability == "DELIVERABLE":
                return "valid"
            elif deliverability == "UNDELIVERABLE":
                return "invalid"
            elif deliverability == "RISKY":
                return "risky"
            return "unknown"
    except Exception as e:
        log.debug(f"Abstract email {email}: {e}")
    return "unknown"


def verify_email_zerobounce(email: str) -> str:
    """
    Zerobounce email validation — 100 free credits/month.
    Get key: zerobounce.net → Sign Up → Dashboard → API Key
    Returns: 'valid' | 'invalid' | 'catch-all' | 'unknown' | 'abuse' | 'do-not-mail'
    """
    if not ZEROBOUNCE_KEY:
        return "no_key"
    try:
        r = requests.get(
            "https://api.zerobounce.net/v2/validate",
            params={"api_key": ZEROBOUNCE_KEY, "email": email},
            timeout=10,
        )
        if r.status_code == 200:
            return r.json().get("status", "unknown").lower()
    except Exception as e:
        log.debug(f"Zerobounce {email}: {e}")
    return "unknown"


def verify_email_hunter(email: str) -> str:
    """
    Hunter.io email verifier — 25 free verifications/month.
    Get key: hunter.io → Sign Up → API → Copy key
    Returns: 'valid' | 'invalid' | 'unknown'
    """
    if not HUNTER_KEY:
        return "no_key"
    try:
        r = requests.get(
            "https://api.hunter.io/v2/email-verifier",
            params={"email": email, "api_key": HUNTER_KEY},
            timeout=10,
        )
        if r.status_code == 200:
            status = r.json().get("data", {}).get("status", "unknown")
            return status  # 'valid', 'invalid', 'accept_all', 'unknown', 'webmail'
    except Exception as e:
        log.debug(f"Hunter {email}: {e}")
    return "unknown"


def verify_email(email: str) -> dict:
    """
    Combined email verification — tries all available methods.
    Priority: Hunter → Zerobounce → Abstract → SMTP → format_only

    Returns:
    {
        "email":   "john@example.com",
        "status":  "valid" | "invalid" | "risky" | "unknown",
        "method":  "hunter" | "zerobounce" | "abstract" | "smtp" | "format",
        "confidence": 0-100
    }
    """
    if not email:
        return {"email": email, "status": "empty", "method": "none", "confidence": 0}

    # Quick format check
    if not re.match(r"^[\w.+\-]+@[\w.\-]+\.[a-z]{2,10}$", email, re.I):
        return {"email": email, "status": "invalid_format", "method": "format", "confidence": 95}

    domain = email.split("@")[1].lower()

    if domain in _DISPOSABLE_DOMAINS:
        return {"email": email, "status": "disposable", "method": "blocklist", "confidence": 99}

    # Try paid APIs first (most accurate)
    for method, fn in [("hunter", verify_email_hunter),
                        ("zerobounce", verify_email_zerobounce),
                        ("abstract", verify_email_abstract)]:
        result = fn(email)
        if result not in ("no_key", "unknown", ""):
            conf = {"valid": 90, "invalid": 95, "risky": 60,
                    "catch-all": 50, "disposable": 99, "abuse": 80}.get(result, 40)
            return {"email": email, "status": result, "method": method, "confidence": conf}

    # Free SMTP check
    smtp_result = verify_email_smtp(email)
    conf_map = {
        "valid": 75, "invalid": 80, "no_mx_record": 90,
        "disposable": 99, "invalid_format": 99,
        "unknown": 20, "unknown_major_provider": 30, "unknown_smtp_blocked": 20,
    }
    return {
        "email": email, "status": smtp_result, "method": "smtp",
        "confidence": conf_map.get(smtp_result, 20),
    }


def find_real_emails(candidates: list, stop_on_first: bool = True) -> list:
    """
    From a list of permuted email candidates, find which ones actually exist.
    Uses verify_email() on each — stops at first 'valid' by default.

    Returns list of dicts: [{"email": ..., "status": ..., "confidence": ...}]
    Only returns emails with status in ('valid', 'risky', 'catch-all', 'accept_all').
    """
    found = []
    ACCEPT = {"valid", "risky", "catch-all", "accept_all", "webmail"}

    for email in candidates:
        result = verify_email(email)
        log.debug(f"  Email check {email} → {result['status']} ({result['method']})")

        if result["status"] in ACCEPT and result["confidence"] >= 40:
            found.append(result)
            if stop_on_first:
                break
        elif result["status"] in ("invalid", "no_mx_record", "disposable", "invalid_format"):
            # Definitive negative — skip rest of same domain
            domain = email.split("@")[1]
            candidates = [e for e in candidates if not e.endswith(f"@{domain}")]

        time.sleep(0.3)  # rate limit

    return found


def generate_email_permutations(name: str, domains: list | None = None) -> list:
    """
    Given a person's name (from WHOIS/GitHub), generate likely email formats.
    e.g., "John Smith" → john.smith@gmail.com, jsmith@gmail.com, johnsmith@proton.me etc.
    Returns list of candidate email addresses.
    """
    if not name or len(name.split()) < 2:
        return []

    parts = [p.lower().strip() for p in name.split() if p.strip()]
    if len(parts) < 2:
        return []

    first, last = parts[0], parts[-1]
    f1 = first[0]  # initial

    patterns = [
        f"{first}.{last}",
        f"{first}{last}",
        f"{f1}{last}",
        f"{first}_{last}",
        f"{last}.{first}",
        f"{first}",
        f"{last}",
    ]

    if domains is None:
        domains = ["gmail.com", "protonmail.com", "yahoo.com", "outlook.com",
                   "hotmail.com", "icloud.com", "me.com"]

    candidates = []
    for pattern in patterns:
        for domain in domains:
            candidates.append(f"{pattern}@{domain}")

    return candidates[:20]  # limit to top 20


# ─── On-Chain Analysis Helpers ─────────────────────────────────────────────
def analyze_defi_from_portfolio(portfolio: List[dict], eth_price: float) -> dict:
    """Extract DeFi positions from token portfolio (no extra API)."""
    aave_val = compound_val = 0.0
    positions = {}
    for t in portfolio:
        sym = (t.get("tokenSymbol") or "").upper()
        val = float(t.get("tokenValue") or 0)
        if sym in AAVE_A_TOKENS:
            aave_val += val
            positions[sym] = round(val, 2)
        elif sym in COMPOUND_TOKENS:
            compound_val += val
            positions[sym] = round(val, 2)
    total = round(aave_val + compound_val, 2)
    return {
        "aave_usd": round(aave_val, 2),
        "compound_usd": round(compound_val, 2),
        "total_usd": total,
        "positions": positions,
    }


def analyze_staking_from_portfolio(portfolio: List[dict]) -> float:
    """Sum staking token values from portfolio."""
    total = 0.0
    for t in portfolio:
        sym = (t.get("tokenSymbol") or "").upper()
        if sym in STAKING_TOKENS:
            try:
                total += float(t.get("tokenValue") or 0)
            except (ValueError, TypeError):
                pass
    return round(total, 2)


def analyze_gas(txs: List[dict]) -> float:
    """Average gas price in Gwei from transactions."""
    prices = []
    for tx in txs:
        gp = tx.get("gasPrice", "0")
        try:
            prices.append(int(gp) / 1e9)
        except (ValueError, TypeError):
            pass
    return round(sum(prices) / len(prices), 1) if prices else 0.0


def detect_mev_victim(txs: List[dict]) -> int:
    """Count failed/reverted txs as proxy for MEV victimization."""
    return sum(
        1 for tx in txs
        if tx.get("isError") == "1" or tx.get("txreceipt_status") == "0"
    )


def detect_cross_chain(txs: List[dict], eth_price: float) -> Tuple[List[str], float]:
    """Detect bridge interactions from tx history."""
    chains = ["Ethereum"]
    volume = 0.0
    for tx in txs:
        to = (tx.get("to") or "").lower()
        if to in BRIDGE_CONTRACTS:
            chain = BRIDGE_CONTRACTS[to]
            if chain not in chains:
                chains.append(chain)
            try:
                volume += int(tx.get("value", 0)) / 1e18 * eth_price
            except (ValueError, TypeError):
                pass
    return chains, round(volume, 2)


def infer_timezone(txs: List[dict]) -> str:
    """Infer timezone from peak tx hours (UTC offset)."""
    if not txs:
        return ""
    hours = defaultdict(int)
    for tx in txs[:200]:
        ts = int(tx.get("timeStamp", 0))
        if ts:
            hours[datetime.utcfromtimestamp(ts).hour] += 1
    if not hours:
        return ""
    peak_hour = max(hours, key=hours.get)
    # Assume active hours are 10:00–22:00 local time
    # peak_hour is UTC → local offset = 16 (midday) - peak_hour
    offset = 16 - peak_hour
    offset = max(-12, min(12, offset))
    return f"UTC{'+' if offset >= 0 else ''}{offset}"


def estimate_pnl(incoming: List[dict], outgoing: List[dict],
                 current_usd: float, eth_price: float) -> Tuple[float, float, float]:
    """Approximate PnL from Alchemy transfer history."""
    if not incoming and not outgoing:
        # Fallback heuristic if Alchemy not available
        return 0.0, 0.0, 0.5

    eth_in  = sum(float(t.get("value") or 0) for t in incoming  if t.get("asset") == "ETH")
    eth_out = sum(float(t.get("value") or 0) for t in outgoing  if t.get("asset") == "ETH")

    # No ETH transfers found — ERC20-only wallet or Alchemy returned empty
    if eth_in == 0 and eth_out == 0:
        return 0.0, 0.0, 0.5

    inflow_usd  = eth_in  * eth_price
    outflow_usd = eth_out * eth_price

    # Net cost = what was actually spent (outflow − inflow received back)
    net_cost = outflow_usd - inflow_usd
    if net_cost <= 0 or eth_out == 0:
        # Wallet is net receiver of ETH — can't compute meaningful PnL from flows
        win_rate = round(min(0.95, eth_in / (eth_in + 0.001)), 3)
        return 0.0, 0.0, win_rate

    pnl_90d = round(current_usd - net_cost, 2)
    pnl_30d = round(pnl_90d * 0.38, 2)  # rough 30d proportion

    win_rate = round(
        min(0.95, max(0.05, inflow_usd / (inflow_usd + outflow_usd + 0.001))),
        3,
    )
    return pnl_30d, pnl_90d, win_rate


def find_first_funder(address: str) -> str:
    """Address that sent the wallet its first ETH (for clustering)."""
    tx = fetch_first_tx(address)
    if tx:
        to_addr   = (tx.get("to") or "").lower()
        from_addr = (tx.get("from") or "").lower()
        if to_addr == address.lower():
            return from_addr
    return ""


# ─── Behavioral Scoring ────────────────────────────────────────────────────
def score_behavior(rec: 'WhaleRecord') -> None:
    """Compute all behavioral scores in-place (pure heuristic, no API)."""
    # Trading pattern
    if rec.defi_usd_value > rec.usd_balance * 0.6:
        rec.trading_pattern = "yield_optimizer"
    elif rec.nft_count > 15:
        rec.trading_pattern = "nft_collector"
    elif rec.wallet_age_months > 36 and rec.weekly_tx_count < 1.5:
        rec.trading_pattern = "long_term_holder"
    elif rec.weekly_tx_count >= 2.5:
        rec.trading_pattern = "active_trader"
    elif rec.weekly_tx_count >= 1.5:
        rec.trading_pattern = "swing_trader"
    else:
        rec.trading_pattern = "moderate_holder"

    # Copy-trade score (0–100)
    score = 45
    if rec.win_rate    > 0.60: score += 10
    if rec.win_rate    > 0.70: score += 10
    if rec.pnl_90d     > 0:    score += 8
    if rec.smart_money_label:  score += 12
    if rec.wallet_age_months > 24: score += 7
    if rec.governance_votes    > 5: score += 5
    if rec.defi_usd_value > 50_000: score += 5
    if rec.weekly_tx_count > 2.5:  score -= 8   # overactive = riskier to copy
    rec.copyworthy_score = min(100, max(0, score))

    # Risk appetite
    defi_ratio = rec.defi_usd_value / max(rec.usd_balance, 1)
    if defi_ratio > 0.65:
        rec.risk_appetite = "High"
    elif defi_ratio > 0.30:
        rec.risk_appetite = "Medium"
    else:
        rec.risk_appetite = "Low"

    # Loyalty score
    loyalty = 40
    if rec.governance_votes > 0:  loyalty += 20
    if rec.staking_value > 0:     loyalty += 15
    if rec.wallet_age_months > 36: loyalty += 15
    if rec.loyalty_score == 0:
        rec.loyalty_score = min(100, loyalty)

    # Sentiment
    if rec.pnl_30d > 5_000:
        rec.sentiment = "bullish"
    elif rec.pnl_30d < -5_000:
        rec.sentiment = "bearish"
    else:
        rec.sentiment = "neutral"

    # Influence score (0–10)
    inf = 0.0
    if rec.lens_followers   > 500:   inf += 2.0
    if rec.lens_followers   > 5_000: inf += 2.0
    if rec.farcaster_user:           inf += 1.0
    if rec.governance_votes > 10:    inf += 2.0
    if rec.smart_money_label:        inf += 2.0
    if rec.twitter_handle:           inf += 1.0
    rec.influence_score = min(10.0, round(inf, 1))

    # Risk score
    risk = 0
    if rec.risk_appetite == "High": risk += 2
    if rec.mev_victim_count > 3:    risk += 1
    if rec.weekly_tx_count  > 2.5:  risk += 1
    if rec.wallet_age_months < 12:  risk += 1
    rec.risk_score = "High" if risk >= 3 else "Medium" if risk >= 2 else "Low"


# ─── Older Demographic Scoring (45+ age signals) ─────────────────────────
_STABLE_SYMS = {"USDT","USDC","DAI","BUSD","TUSD","FRAX","LUSD","GUSD","USDP"}
_BTC_SYMS     = {"WBTC","renBTC","sBTC","hBTC","tBTC","BTC"}

def score_older_demographic(rec: 'WhaleRecord') -> None:
    """
    Score 0-10: how likely the wallet belongs to a 45+ traditional investor.
    Higher = more likely older demographic (hodler, non-DeFi, conservative).
    """
    pts = 0

    # --- Wallet age (biggest signal) ---
    if   rec.wallet_age_months >= 84:  pts += 4   # 7+ years = 2017 or earlier
    elif rec.wallet_age_months >= 60:  pts += 3   # 5+ years = 2019 or earlier
    elif rec.wallet_age_months >= 36:  pts += 1   # 3+ years

    # --- Low activity = hodler, not trader ---
    if   rec.weekly_tx_count < 0.5:   pts += 3   # almost never touches it
    elif rec.weekly_tx_count < 2.0:   pts += 1

    # --- No DeFi = not crypto-native ---
    if rec.defi_usd_value == 0:       pts += 2
    elif rec.defi_usd_value < 5_000:  pts += 1

    # --- Bitcoin exposure = old school ---
    tops = {s.strip().upper() for s in (rec.top_tokens or "").split(",")}
    if tops & _BTC_SYMS:              pts += 2

    # --- Stablecoin heavy = conservative / risk-averse ---
    stable_count = len(tops & _STABLE_SYMS)
    if stable_count >= 2:             pts += 1

    # --- No crypto-native social = not a degen ---
    if not rec.farcaster_user:        pts += 1
    if not rec.lens_handle:           pts += 1

    # --- No NFTs = not in the culture ---
    if rec.nft_count == 0:            pts += 1
    elif rec.nft_count < 5:           pts += 0

    # --- No governance = passive investor ---
    if rec.governance_votes == 0:     pts += 1

    # Deduct for clear younger/degen signals
    if rec.nft_count > 50:            pts -= 2
    if rec.weekly_tx_count > 5:       pts -= 2
    if rec.defi_usd_value > 100_000:  pts -= 2
    if rec.farcaster_user:            pts -= 1

    rec.older_demographic_score = max(0, min(10, pts))


# ─── AI Categorization + Summary ──────────────────────────────────────────
CATEGORIES = [
    ("Yield Optimizer",     lambda r: r.defi_usd_value > r.usd_balance * 0.5),
    ("NFT Collector",       lambda r: r.nft_count > 15),
    ("DeFi Power User",     lambda r: r.defi_usd_value > 50_000 and r.governance_votes > 3),
    ("DAO Participant",     lambda r: r.governance_votes >= 5),
    ("Cross-chain Degen",   lambda r: len((r.chains_active or "").split(",")) > 2),
    ("Smart Money",         lambda r: bool(r.smart_money_label) or r.win_rate > 0.70),
    ("Long-term Holder",    lambda r: r.wallet_age_months > 36 and r.weekly_tx_count < 1.5),
    ("Active Trader",       lambda r: r.weekly_tx_count > 2.3),
    ("High-Value Whale",    lambda r: r.usd_balance > 500_000),
]


def categorize(rec: 'WhaleRecord') -> str:
    for name, cond in CATEGORIES:
        try:
            if cond(rec):
                return name
        except Exception:
            pass
    return "Whale"


def _ai_prompt(rec: 'WhaleRecord') -> str:
    return (
        f"Write exactly 2 sentences about this Ethereum whale. "
        f"Output ONLY the 2 sentences, no reasoning, no explanation.\n\n"
        f"Balance: ${rec.usd_balance:,.0f} | Age: {rec.wallet_age_months:.0f}mo | "
        f"Pattern: {rec.trading_pattern} | PnL 90d: ${rec.pnl_90d:,.0f} | "
        f"Win rate: {rec.win_rate:.1%} | DeFi: ${rec.defi_usd_value:,.0f} | "
        f"NFTs: {rec.nft_count} | Gov votes: {rec.governance_votes} | "
        f"Label: {rec.smart_money_label or 'none'} | ENS: {rec.ens_name or 'none'}\n\n"
        f"Focus: trading style, risk profile, copy-trade potential."
    )


def _heuristic_summary(rec: 'WhaleRecord') -> str:
    """Fallback summary — rich, data-driven, no API needed."""
    # Lead with identity
    ident = rec.ens_name or rec.wallet_address[:8] + "..."
    age_str = (
        f"{rec.wallet_age_months:.0f}-month OG" if rec.wallet_age_months > 36
        else f"{rec.wallet_age_months:.0f}-month veteran" if rec.wallet_age_months > 18
        else "newer wallet"
    )
    line1 = (
        f"{ident} — {rec.whale_category} ({age_str}), "
        f"${rec.usd_balance:,.0f} portfolio, "
        f"{rec.weekly_tx_count:.1f} tx/week."
    )
    # Add 1-2 most interesting data points
    highlights = []
    if rec.smart_money_label:
        highlights.append(f"Tagged as {rec.smart_money_label}")
    if rec.defi_usd_value > 10_000:
        highlights.append(f"${rec.defi_usd_value:,.0f} active in DeFi")
    if rec.pnl_90d and rec.pnl_90d > 0:
        highlights.append(f"+${rec.pnl_90d:,.0f} PnL (90d)")
    if rec.governance_votes > 3:
        highlights.append(f"{rec.governance_votes} DAO votes ({', '.join((rec.governance_daos or '').split(',')[:2]).strip()})")
    if rec.nft_count > 5:
        highlights.append(f"{rec.nft_count} NFTs")
    if rec.copyworthy_score > 70:
        highlights.append(f"copy-score {rec.copyworthy_score}/100")
    line2 = ". ".join(highlights[:3]) + "." if highlights else ""
    return f"{line1} {line2}".strip()


_REASONING_MARKERS = [
    "the user wants", "let me analyze", "let me think", "here is my",
    "i need to", "i will write", "i'll write", "i should", "looking at the",
    "based on the data", "based on this", "let me create", "we need to craft",
    "the wallet shows", "this analysis", "let me review",
]

def _strip_reasoning(text: str, max_sentences: int = 3) -> str:
    """Strip chain-of-thought reasoning that some models prefix to their answers."""
    if not text:
        return text

    # Look for explicit output markers
    for marker in [
        "here is the summary:", "here is the message:", "here's the summary:",
        "here's the message:", "output:", "summary:", "final answer:",
        "final summary:", "the summary:", "2-sentence summary:",
    ]:
        idx = text.lower().find(marker)
        if idx != -1:
            return text[idx + len(marker):].strip()

    # If first line looks like reasoning, use last paragraph as the answer
    lines = [l.strip() for l in text.strip().split('\n') if l.strip()]
    if lines:
        first = lines[0].lower()
        if any(m in first for m in _REASONING_MARKERS):
            paragraphs = [p.strip() for p in text.strip().split('\n\n') if p.strip()]
            if len(paragraphs) > 1:
                # Last paragraph is usually the actual answer
                last = paragraphs[-1].strip()
                # Sanity check — last para shouldn't start with reasoning either
                if not any(m in last.lower()[:60] for m in _REASONING_MARKERS[:8]):
                    return last

    # Truncate to max_sentences if way too long
    import re as _re
    sentences = _re.split(r'(?<=[.!?])\s+', text.strip())
    if len(sentences) > max_sentences:
        return ' '.join(sentences[:max_sentences])

    return text.strip()


def _ai_gemini(prompt: str) -> str:
    """Google Gemini — free tier (1500 req/day)."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_KEY}"
    r = requests.post(url, json={
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"maxOutputTokens": 120, "temperature": 0.3},
    }, timeout=30)
    r.raise_for_status()
    raw = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    return _strip_reasoning(raw)


def _ai_groq(prompt: str) -> str:
    """Groq — completely free (14400 req/day, Llama 3.3 70B)."""
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"},
        json={
            "model": "llama-3.3-70b-versatile",
            "messages": [
                {"role": "system", "content": "You are a concise analyst. Output ONLY the requested content, no reasoning."},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": 150,
            "temperature": 0.3,
        },
        timeout=30,
    )
    r.raise_for_status()
    raw = r.json()["choices"][0]["message"]["content"].strip()
    return _strip_reasoning(raw)


def _ai_claude(prompt: str) -> str:
    """Anthropic Claude — claude-haiku-4-5 (cheapest, ~$0.25/1000 whales)."""
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 120,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["content"][0]["text"].strip()


def _ai_openai(prompt: str) -> str:
    """OpenAI GPT-4o-mini."""
    r = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        json={
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 120,
            "temperature": 0.3,
        },
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def _ai_ollama(prompt: str) -> str:
    """Ollama — 100% free, runs locally (no internet needed)."""
    r = requests.post(
        f"{OLLAMA_URL}/api/generate",
        json={"model": OLLAMA_MODEL, "prompt": prompt, "stream": False},
        timeout=120,
    )
    r.raise_for_status()
    return r.json().get("response", "").strip()


_OR_RATE_LOCK    = _threading.Lock()
_OR_LAST_CALL    = 0.0
_OR_MIN_GAP      = 4.0    # seconds between OR calls (free tier ~15 RPM safe)
_OR_DAILY_LIMIT  = False  # True = daily quota exhausted, skip for rest of run

def _ai_openrouter(prompt: str, model: str = None) -> str:
    """OpenRouter — free models with rate-limit protection (15 RPM safe)."""
    global _OR_LAST_CALL, _OR_DAILY_LIMIT
    if _OR_DAILY_LIMIT:
        raise RuntimeError("OpenRouter daily limit — resets at midnight UTC")
    m = model or OR_MODELS[0]
    with _OR_RATE_LOCK:
        gap = time.time() - _OR_LAST_CALL
        if gap < _OR_MIN_GAP:
            time.sleep(_OR_MIN_GAP - gap)
        _OR_LAST_CALL = time.time()

    for attempt in range(3):
        try:
            r = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_KEY}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://github.com/whale-extractor",
                },
                json={
                    "model": m,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are a concise crypto intelligence analyst. "
                                "Output ONLY the requested content. "
                                "No reasoning, no analysis, no preamble. "
                                "Start directly with the answer."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": 250,
                    "temperature": 0.3,
                },
                timeout=45,
            )
            if r.status_code == 429:
                # Check if daily quota hit — no point retrying until midnight
                try:
                    err_msg = r.json().get("error", {}).get("message", "")
                except Exception:
                    err_msg = ""
                if "per-day" in err_msg or "per_day" in err_msg:
                    _OR_DAILY_LIMIT = True
                    log.warning("OpenRouter daily quota exhausted — resets midnight UTC. Falling back to heuristics.")
                    raise RuntimeError("OpenRouter daily limit exhausted")
                retry_after = int(r.headers.get("Retry-After", 8 * (attempt + 1)))
                log.debug(f"OpenRouter 429 — waiting {retry_after}s (attempt {attempt+1})")
                time.sleep(retry_after)
                continue
            r.raise_for_status()
            raw = r.json()["choices"][0]["message"]["content"].strip()
            return _strip_reasoning(raw)
        except requests.RequestException as e:
            if attempt == 2:
                raise
            time.sleep(5 * (attempt + 1))
    raise RuntimeError("OpenRouter: max retries exceeded")


_AI_PROVIDERS = {
    "gemini":       (_ai_gemini,      lambda: bool(GEMINI_KEY)),
    "groq":         (_ai_groq,        lambda: bool(GROQ_KEY)),
    "claude":       (_ai_claude,      lambda: bool(ANTHROPIC_KEY)),
    "openai":       (_ai_openai,      lambda: bool(OPENAI_KEY)),
    "ollama":       (_ai_ollama,      lambda: True),
    "openrouter":   (_ai_openrouter,  lambda: bool(OPENROUTER_KEY)),
}

# Priority order for auto-selecting the judge (free first)
_JUDGE_PRIORITY = ["openrouter", "groq", "gemini", "claude", "openai", "ollama"]


# ─── Judge Panel System ────────────────────────────────────────────────────

def _load_scores() -> dict:
    """Load provider win/loss stats from disk."""
    if os.path.exists(PANEL_SCORES):
        try:
            with open(PANEL_SCORES, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_scores(scores: dict) -> None:
    with open(PANEL_SCORES, "w", encoding="utf-8") as f:
        json.dump(scores, f, indent=2)


def _update_scores(winner: str, all_providers: List[str], score_map: Dict[str, int]) -> None:
    """Update running win/score stats — this is the 'training' log."""
    scores = _load_scores()
    for provider in all_providers:
        if provider not in scores:
            scores[provider] = {"wins": 0, "attempts": 0, "total_score": 0, "avg_score": 0.0}
        scores[provider]["attempts"] += 1
        scores[provider]["total_score"] += score_map.get(provider, 0)
        if provider == winner:
            scores[provider]["wins"] += 1
        attempts = scores[provider]["attempts"]
        scores[provider]["avg_score"] = round(scores[provider]["total_score"] / attempts, 2)
        scores[provider]["win_rate"]  = round(scores[provider]["wins"] / attempts * 100, 1)
    _save_scores(scores)


def _available_providers() -> List[str]:
    """Return list of all providers that have keys configured.
    When OpenRouter key is present, expose all 3 OR model slots for panel mode."""
    available = []
    for name, (_, has_key) in _AI_PROVIDERS.items():
        if has_key():
            available.append(name)
    # Deduplicate: if openrouter + or_* all present, keep them all for panel
    # but drop plain 'ollama' if real providers exist (ollama is very slow)
    if len(available) > 1 and "ollama" in available:
        available.remove("ollama")
    return available


def _pick_judge(available: List[str]) -> Optional[str]:
    """Auto-select the best available judge provider."""
    explicit = JUDGE_PROVIDER
    if explicit and explicit in available:
        return explicit
    for p in _JUDGE_PRIORITY:
        if p in available:
            return p
    return None


def _run_panel(prompt: str, available: List[str]) -> Dict[str, str]:
    """Run all available providers in parallel, collect their summaries."""
    results: Dict[str, str] = {}

    def _call(name: str) -> Tuple[str, str]:
        fn, _ = _AI_PROVIDERS[name]
        return name, fn(prompt)

    with ThreadPoolExecutor(max_workers=len(available)) as pool:
        futures = {pool.submit(_call, name): name for name in available}
        for future in as_completed(futures):
            name = futures[future]
            try:
                _, text = future.result(timeout=60)
                results[name] = text
            except Exception as e:
                log.debug(f"Panel: {name} failed — {e}")

    return results


def _judge_panel(summaries: Dict[str, str], judge: str, prompt: str) -> Tuple[str, str, Dict[str, int]]:
    """
    Ask the judge to score all summaries and pick the winner.
    Returns (winner_provider, final_summary, score_map).
    """
    numbered = "\n\n".join(
        f"[{i+1}] {name.upper()}: {text}"
        for i, (name, text) in enumerate(summaries.items())
    )
    provider_list = list(summaries.keys())

    judge_prompt = f"""You are an expert intelligence analyst judging AI-generated summaries about an Ethereum whale wallet.

WALLET CONTEXT:
{prompt}

SUMMARIES TO JUDGE:
{numbered}

Score each summary from 1-10 based on:
- Accuracy and specificity (does it reflect the actual wallet data?)
- Actionable insight (is it useful for copy-trading decisions?)
- Clarity and conciseness (is it clear and to the point?)
- Unique observations (does it notice something important?)

Respond ONLY with valid JSON in this exact format:
{{
  "scores": {{{", ".join(f'"{p}": <1-10>' for p in provider_list)}}},
  "winner": "<provider name>",
  "reason": "<1 sentence why this summary is best>",
  "final_summary": "<improved/best version of the winning summary>"
}}"""

    try:
        fn, _ = _AI_PROVIDERS[judge]
        raw   = fn(judge_prompt)
        # Extract JSON from response
        start = raw.find("{")
        end   = raw.rfind("}") + 1
        data  = json.loads(raw[start:end])

        scores     = {k: int(v) for k, v in data.get("scores", {}).items()}
        winner     = data.get("winner", "").lower()
        final_text = data.get("final_summary", summaries.get(winner, ""))

        # Validate winner is one of the competing providers
        if winner not in summaries:
            winner = max(scores, key=scores.get) if scores else provider_list[0]

        log.info(f"  Judge ({judge}) → winner: {winner.upper()} | scores: {scores}")
        return winner, final_text, scores

    except Exception as e:
        log.debug(f"Judge error: {e}")
        # Fallback: pick the longest summary as winner
        winner = max(summaries, key=lambda k: len(summaries[k]))
        return winner, summaries[winner], {}


def build_ai_summary(rec: 'WhaleRecord') -> str:
    """
    Panel mode: all configured providers compete → judge picks best → scores logged.
    Single mode: uses AI_PROVIDER setting.
    Falls back to heuristic if no AI keys set.
    """
    available = _available_providers()

    # No AI keys at all → heuristic
    if not available:
        return _heuristic_summary(rec)

    prompt = _ai_prompt(rec)

    # Single provider mode (only 1 key set, or AI_PROVIDER explicitly set to one)
    if len(available) == 1 or (AI_PROVIDER and AI_PROVIDER != "none" and AI_PROVIDER in available):
        provider = AI_PROVIDER if AI_PROVIDER in available else available[0]
        fn, _    = _AI_PROVIDERS[provider]
        try:
            return _strip_reasoning(fn(prompt))
        except Exception as e:
            log.debug(f"AI error ({provider}): {e}")
            return _heuristic_summary(rec)

    # ── Panel mode: multiple providers available ───────────────────────────
    log.info(f"  AI Panel: {available} competing…")
    summaries = _run_panel(prompt, available)

    if not summaries:
        return _heuristic_summary(rec)

    if len(summaries) == 1:
        return _strip_reasoning(list(summaries.values())[0])

    # Pick judge (not part of competition — it still contributes its own summary)
    judge = _pick_judge(available)
    if not judge:
        return _strip_reasoning(list(summaries.values())[0])

    winner, final_summary, score_map = _judge_panel(summaries, judge, prompt)
    _update_scores(winner, list(summaries.keys()), score_map)

    return _strip_reasoning(final_summary)


# ─── Personalized Outreach Message Generator ──────────────────────────────

def _whale_persona(rec: 'WhaleRecord') -> str:
    """Build a persona summary used as context in the outreach prompt."""
    name = rec.ens_name or rec.wallet_address[:10] + "…"
    traits = []
    if rec.trading_pattern:   traits.append(rec.trading_pattern.replace("_", " "))
    if rec.defi_usd_value > 10_000: traits.append(f"${rec.defi_usd_value:,.0f} in DeFi")
    if rec.nft_count > 0:     traits.append(f"holds {rec.nft_count} NFTs ({rec.nft_top_collection})")
    if rec.governance_votes:  traits.append(f"votes in DAOs ({rec.governance_daos})")
    if rec.staking_value > 0: traits.append(f"staker (${rec.staking_value:,.0f})")
    if rec.lens_handle:       traits.append(f"Lens: {rec.lens_handle}")
    if rec.farcaster_user:    traits.append(f"Farcaster: {rec.farcaster_user}")
    chains = rec.chains_active or "Ethereum"
    return (
        f"Name: {name}\n"
        f"Portfolio: ${rec.usd_balance:,.0f} | Age: {rec.wallet_age_months:.0f} months\n"
        f"Traits: {', '.join(traits) or 'standard whale'}\n"
        f"Active on: {chains}\n"
        f"Alpha score: {rec.copyworthy_score}/100 | Category: {rec.whale_category}"
    )


def _outreach_prompt(rec: 'WhaleRecord', channel: str) -> str:
    """Build the AI prompt for outreach message generation."""
    persona   = _whale_persona(rec)
    name_call = rec.ens_name or "fren"

    tone_guide = {
        "professional":   "formal, respectful, business tone",
        "casual":         "friendly, conversational, approachable",
        "crypto_native":  "Web3 native slang (gm, ngmi, based, anon, fren), concise, no corporate speak",
    }.get(OUTREACH_TONE, "crypto_native")

    goal_guide = {
        "partnership":  "explore a strategic partnership or integration",
        "investment":   "discuss an exclusive early-access investment opportunity",
        "community":    "invite them to join an exclusive whale community",
        "airdrop":      "notify them about an exclusive airdrop they qualify for",
        "custom":       OUTREACH_PITCH or "introduce our project",
    }.get(OUTREACH_GOAL, "community")

    channel_rules = {
        "twitter": (
            "Twitter/X DM format. MAX 280 characters. "
            "No hashtags. Direct, punchy. Must fit in one DM."
        ),
        "telegram": (
            "Telegram message. MAX 500 characters. "
            "Can use 1-2 emojis. Conversational."
        ),
        "email": (
            "Email format. Include Subject line first (prefix with 'Subject: '). "
            "Then body — 3-4 short paragraphs. Professional yet friendly. "
            "Clear CTA at end."
        ),
    }.get(channel, "short message under 300 characters")

    pitch = OUTREACH_PITCH or f"join {PROJECT_NAME} — {PROJECT_DESC}"
    url   = f" {PROJECT_URL}" if PROJECT_URL else ""
    tw    = f" ({PROJECT_TWITTER})" if PROJECT_TWITTER else ""

    return f"""Write a highly personalized outreach message to this Ethereum whale.

WHALE PROFILE:
{persona}

YOUR PROJECT: {PROJECT_NAME}{tw} — {PROJECT_DESC}{url}
GOAL: {goal_guide}
TONE: {tone_guide}
CHANNEL: {channel_rules}

PERSONALIZATION RULES:
- Address them as "{name_call}" (use ENS name if available, else "anon" or "fren")
- Reference 1-2 specific things from their actual wallet data (holdings, pattern, DAOs)
- Make the pitch relevant to their profile (DeFi whale → DeFi angle, NFT holder → NFT angle)
- End with a clear, low-friction call to action
- Do NOT mention their wallet address directly
- Sound like a human, not a bot
- The pitch: {pitch}

OUTPUT: Write ONLY the final message text. No reasoning, no analysis, no explanation. Start directly with the message."""


def generate_outreach_messages(rec: 'WhaleRecord') -> None:
    """Generate personalized outreach messages. Uses single best provider (fast)."""
    # Always start with heuristic templates so all records have something
    _heuristic_outreach(rec)

    available = _available_providers()
    if not available:
        return

    # Use the judged best provider (fastest — 1 API call, not a full panel race)
    provider = _pick_judge(available) or available[0]
    fn, _ = _AI_PROVIDERS[provider]

    channels: Dict[str, str] = {}

    # Determine which channels this whale can be reached on
    targets = []
    if rec.twitter_handle or rec.ens_twitter:   targets.append("twitter")
    if rec.telegram_username or rec.ens_telegram: targets.append("telegram")
    if rec.email or rec.ens_email:               targets.append("email")
    if not targets:
        targets = ["twitter"]   # always generate at least Twitter DM

    for channel in targets:
        prompt = _outreach_prompt(rec, channel)
        try:
            channels[channel] = _strip_reasoning(fn(prompt), max_sentences=5)
        except Exception as e:
            log.debug(f"Outreach msg error ({channel}): {e}")

    # Override heuristic only where AI gave a non-empty result
    if channels.get("twitter"):  rec.msg_twitter  = channels["twitter"]
    if channels.get("telegram"): rec.msg_telegram = channels["telegram"]
    if channels.get("email"):    rec.msg_email    = channels["email"]

    # Best channel = one with actual contact info
    if rec.email or rec.ens_email:
        rec.outreach_channel = "email"
    elif rec.telegram_username or rec.ens_telegram:
        rec.outreach_channel = "telegram"
    elif rec.twitter_handle or rec.ens_twitter:
        rec.outreach_channel = "twitter"
    else:
        rec.outreach_channel = "onchain"


def _heuristic_outreach(rec: 'WhaleRecord') -> None:
    """Template-based fallback — personalized with real on-chain data."""
    name = rec.ens_name or "anon"
    proj = PROJECT_NAME
    url  = f" {PROJECT_URL}" if PROJECT_URL else ""
    bal_str = f"${rec.usd_balance:,.0f}" if rec.usd_balance else ""

    cat     = (rec.whale_category or "").lower()
    pnl_ok  = rec.pnl_90d and rec.pnl_90d > 0 and abs(rec.pnl_90d - rec.usd_balance) > 1000

    # Angle priority: strong label > category-matched hook > generic
    if rec.smart_money_label:
        hook    = f"noticed you're flagged as {rec.smart_money_label}"
        cta     = f"{proj} is building for exactly that tier of trader"
    elif rec.governance_votes > 5:
        daos    = (rec.governance_daos or "").split(",")[0].strip()
        hook    = f"your {rec.governance_votes} DAO votes" + (f" in {daos}" if daos else "") + " show you're a serious on-chain participant"
        cta     = f"{proj} is governed by people like you — would love your input early"
    elif "nft" in cat and rec.nft_count > 5:
        hook    = f"your {rec.nft_count}-NFT collection shows serious taste"
        cta     = f"{proj} has exclusive utility dropping for collectors"
    elif ("trader" in cat or "smart" in cat or "defi" in cat) and pnl_ok:
        hook    = f"+${rec.pnl_90d:,.0f} PnL in 90 days is serious alpha"
        cta     = f"{proj} wants traders with that edge on our side"
    elif "yield" in cat or "defi" in cat or rec.defi_usd_value > 10_000:
        hook    = f"${rec.defi_usd_value:,.0f} deployed in DeFi is rare conviction"
        cta     = f"{proj} was built for high-conviction DeFi players"
    elif rec.wallet_age_months > 36:
        hook    = f"{rec.wallet_age_months:.0f} months on-chain puts you in the 1%"
        cta     = f"{proj} is built by OGs, for OGs — early access available"
    elif pnl_ok:
        hook    = f"+${rec.pnl_90d:,.0f} PnL in 90 days is alpha"
        cta     = f"{proj} wants traders with that edge on our side"
    else:
        hook    = f"a {bal_str} portfolio and {rec.weekly_tx_count:.0f} tx/week tells me you're serious"
        cta     = f"{proj} is looking for early believers with real conviction"

    rec.msg_twitter  = f"gm {name}, {hook}. {cta}.{url} worth 5 mins?"
    rec.msg_telegram = (
        f"gm {name} 👋\n\n"
        f"{hook.capitalize()}.\n\n"
        f"{cta}.\n\n"
        f"Worth a quick chat?{(' ' + url) if url else ''}"
    )
    rec.msg_email = (
        f"Subject: Quick intro — {proj}\n\n"
        f"Hey {name},\n\n"
        f"I {hook}.\n\n"
        f"{cta}. We're building {PROJECT_DESC} and think you'd be a great fit "
        f"as an early community member / advisor.\n\n"
        f"5 mins to chat?{(' ' + url) if url else ''}\n\nBest"
    )
    if rec.email or rec.ens_email:
        rec.outreach_channel = "email"
    elif rec.telegram_username or rec.ens_telegram:
        rec.outreach_channel = "telegram"
    else:
        rec.outreach_channel = "twitter"


# ─── Wallet Clustering ─────────────────────────────────────────────────────
def build_clusters(funders: Dict[str, str]) -> Dict[str, List[str]]:
    """Group whale addresses that share a common first funder."""
    groups: Dict[str, List[str]] = defaultdict(list)
    for addr, funder in funders.items():
        if funder:
            groups[funder].append(addr)
    return {k: v for k, v in groups.items() if len(v) >= 2}


# ─── Checkpoint / Output ───────────────────────────────────────────────────
def load_checkpoint() -> Tuple[set, list]:
    if os.path.exists(CHECKPOINT):
        with open(CHECKPOINT, encoding="utf-8") as f:
            c = json.load(f)
        return set(c.get("done", [])), c.get("results", [])
    return set(), []


def save_checkpoint(done: set, results: list):
    with open(CHECKPOINT, "w", encoding="utf-8") as f:
        json.dump({"done": list(done), "results": results}, f)


def write_outputs(records: List['WhaleRecord'], funders: Dict[str, str] = None):
    if not records:
        return
    # whale_data.csv
    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(asdict(r) for r in records)
    # whale_data.json
    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump([asdict(r) for r in records], f, indent=2, ensure_ascii=False)
    # whale_clusters.json
    if funders:
        clusters = build_clusters(funders)
        with open(OUTPUT_CLUSTERS, "w", encoding="utf-8") as f:
            json.dump(clusters, f, indent=2)
    # alpha_wallets.csv (top 100 by copyworthy_score)
    alpha = sorted(records, key=lambda r: r.copyworthy_score, reverse=True)[:100]
    alpha_fields = ["wallet_address", "usd_balance", "copyworthy_score",
                    "whale_category", "ens_name", "twitter_handle",
                    "win_rate", "pnl_90d", "trading_pattern", "risk_score", "ai_summary"]
    with open(OUTPUT_ALPHA, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=alpha_fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(asdict(r) for r in alpha)
    # dashboard.html
    html = build_dashboard(records)
    with open(OUTPUT_DASH, "w", encoding="utf-8") as f:
        f.write(html)
    log.info(f"  Saved {len(records)} records → {OUTPUT_DIR}/")


# ─── Dashboard HTML ────────────────────────────────────────────────────────
def build_dashboard(records: List['WhaleRecord']) -> str:
    total    = len(records)
    avg_bal  = sum(r.usd_balance for r in records) / max(total, 1)
    avg_age  = sum(r.wallet_age_months for r in records) / max(total, 1)
    with_ens = sum(1 for r in records if r.ens_name)
    with_tw  = sum(1 for r in records if r.twitter_handle)
    with_defi= sum(1 for r in records if r.defi_usd_value > 0)
    top10    = sorted(records, key=lambda r: r.copyworthy_score, reverse=True)[:10]

    cats: Dict[str, int] = defaultdict(int)
    for r in records:
        cats[r.whale_category or "Unknown"] += 1

    cat_labels = json.dumps(list(cats.keys()))
    cat_values = json.dumps(list(cats.values()))

    rows = ""
    for i, r in enumerate(top10, 1):
        badge_cls = "green" if r.copyworthy_score > 70 else "yellow"
        addr_short = r.wallet_address[:8] + "…" + r.wallet_address[-4:]
        rows += f"""
        <tr>
          <td>{i}</td>
          <td><code title="{r.wallet_address}">{addr_short}</code></td>
          <td>${r.usd_balance:,.0f}</td>
          <td>{r.ens_name or "—"}</td>
          <td>{r.twitter_handle or "—"}</td>
          <td>{r.whale_category}</td>
          <td>{r.trading_pattern}</td>
          <td><span class="badge {badge_cls}">{r.copyworthy_score}/100</span></td>
          <td class="risk-{r.risk_score.lower()}">{r.risk_score}</td>
        </tr>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🐋 Whale Intelligence Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  :root {{
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #c9d1d9; --muted: #8b949e;
    --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
    --accent: #1f6feb;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 24px; }}
  h1 {{ font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; color: #fff; }}
  .subtitle {{ color: var(--muted); font-size: 0.85rem; margin-bottom: 28px; }}
  .stats {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }}
  .stat-card {{ background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }}
  .stat-val {{ font-size: 1.5rem; font-weight: 700; color: #fff; }}
  .stat-label {{ font-size: 0.78rem; color: var(--muted); margin-top: 4px; }}
  .charts {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 28px; }}
  .chart-box {{ background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }}
  .chart-box h3 {{ font-size: 0.9rem; color: var(--muted); margin-bottom: 12px; }}
  .section {{ background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }}
  .section h2 {{ font-size: 1rem; font-weight: 600; color: #fff; margin-bottom: 14px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.82rem; }}
  th {{ text-align: left; padding: 8px 10px; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); white-space: nowrap; }}
  td {{ padding: 8px 10px; border-bottom: 1px solid #21262d; }}
  tr:last-child td {{ border-bottom: none; }}
  code {{ font-family: "SF Mono", Consolas, monospace; font-size: 0.8rem; background: #0d1117; padding: 2px 6px; border-radius: 4px; }}
  .badge {{ display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; }}
  .badge.green {{ background: #0a3d20; color: var(--green); }}
  .badge.yellow {{ background: #2d2208; color: var(--yellow); }}
  .risk-low {{ color: var(--green); }}
  .risk-medium {{ color: var(--yellow); }}
  .risk-high {{ color: var(--red); }}
  @media (max-width: 768px) {{ .charts {{ grid-template-columns: 1fr; }} }}
</style>
</head>
<body>
<h1>🐋 Whale Intelligence Dashboard</h1>
<div class="subtitle">Generated {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")} · {total} whale addresses · God-Level Edition v2</div>

<div class="stats">
  <div class="stat-card">
    <div class="stat-val">{total}</div>
    <div class="stat-label">Whale Addresses</div>
  </div>
  <div class="stat-card">
    <div class="stat-val">${avg_bal:,.0f}</div>
    <div class="stat-label">Avg Portfolio</div>
  </div>
  <div class="stat-card">
    <div class="stat-val">{avg_age:.0f} mo</div>
    <div class="stat-label">Avg Wallet Age</div>
  </div>
  <div class="stat-card">
    <div class="stat-val">{with_ens}</div>
    <div class="stat-label">With ENS Name</div>
  </div>
  <div class="stat-card">
    <div class="stat-val">{with_tw}</div>
    <div class="stat-label">With Twitter</div>
  </div>
  <div class="stat-card">
    <div class="stat-val">{with_defi}</div>
    <div class="stat-label">Active in DeFi</div>
  </div>
</div>

<div class="charts">
  <div class="chart-box">
    <h3>Whale Categories</h3>
    <canvas id="catChart" height="200"></canvas>
  </div>
  <div class="chart-box">
    <h3>Copy-Trade Score Distribution</h3>
    <canvas id="scoreChart" height="200"></canvas>
  </div>
</div>

<div class="section">
  <h2>Top 10 Alpha Wallets (by Copy-Trade Score)</h2>
  <div style="overflow-x:auto">
  <table>
    <thead>
      <tr>
        <th>#</th><th>Address</th><th>Balance</th><th>ENS</th>
        <th>Twitter</th><th>Category</th><th>Pattern</th>
        <th>Alpha Score</th><th>Risk</th>
      </tr>
    </thead>
    <tbody>{rows}</tbody>
  </table>
  </div>
</div>

<script>
const catLabels = {cat_labels};
const catValues = {cat_values};
const palette   = ['#1f6feb','#3fb950','#d29922','#f85149','#8b949e',
                   '#58a6ff','#a371f7','#ffa657','#2ea043','#f0883e'];
new Chart(document.getElementById('catChart'), {{
  type: 'doughnut',
  data: {{ labels: catLabels, datasets: [{{ data: catValues, backgroundColor: palette }}] }},
  options: {{ plugins: {{ legend: {{ labels: {{ color: '#8b949e', font: {{ size: 11 }} }} }} }}, cutout: '60%' }}
}});
// Score distribution histogram
const records = {json.dumps([{'score': r.copyworthy_score, 'bal': r.usd_balance} for r in records])};
const buckets = Array(10).fill(0);
records.forEach(r => {{ buckets[Math.min(9, Math.floor(r.score / 10))]++; }});
new Chart(document.getElementById('scoreChart'), {{
  type: 'bar',
  data: {{
    labels: ['0-9','10-19','20-29','30-39','40-49','50-59','60-69','70-79','80-89','90-100'],
    datasets: [{{ label: 'Wallets', data: buckets,
      backgroundColor: '#1f6feb', borderRadius: 4 }}]
  }},
  options: {{
    plugins: {{ legend: {{ display: false }} }},
    scales: {{
      x: {{ ticks: {{ color: '#8b949e' }}, grid: {{ color: '#21262d' }} }},
      y: {{ ticks: {{ color: '#8b949e' }}, grid: {{ color: '#21262d' }} }},
    }}
  }}
}});
</script>
</body>
</html>"""


# ─── Phase 1: Collect Candidates ──────────────────────────────────────────
def phase1_candidates(test_mode: bool = False) -> List[str]:
    log.info("━" * 60)
    log.info("PHASE 1: Collecting candidate addresses")
    log.info("━" * 60)
    seen: set = set()
    max_pages = 2 if test_mode else 5
    for name, addr in TOKENS.items():
        log.info(f"  Fetching {name} holders…")
        holders = fetch_token_holders(addr, max_pages=max_pages)
        before  = len(seen)
        seen.update(holders)
        log.info(f"    +{len(seen)-before} new  (total {len(seen)})")
    candidates = list(seen)
    random.shuffle(candidates)
    log.info(f"Phase 1 raw → {len(candidates)} unique candidates")

    # ── Alchemy batch pre-filter: eliminate dust wallets + inactive addresses ──
    # ONE HTTP request per 80 addresses — makes Phase 2 dramatically faster
    if ALCHEMY_KEY:
        candidates = prefilter_candidates(candidates)

    log.info(f"Phase 1 done → {len(candidates)} candidates queued for Phase 2")
    return candidates


# ─── Phase 2: Enrich + Filter + Deep Intel ────────────────────────────────
def _enrich_one(addr: str, eth_price: float, now: datetime) -> Optional[Tuple[WhaleRecord, str]]:
    """Process a single address — returns (record, funder) or None if filtered out."""
    try:
        eth_bal = fetch_eth_balance(addr)
        eth_usd = eth_bal * eth_price

        # ── Multi-chain net-worth: Moralis (10 EVM) + Ankr (8 extra EVM) ─────
        if MORALIS_KEY:
            total_usd, chains_str = fetch_networth_moralis(addr)
            if total_usd == 0:
                portfolio  = fetch_token_portfolio(addr)
                token_usd  = sum(float(t.get("tokenValue") or 0) for t in portfolio)
                total_usd  = eth_usd + token_usd
                chains_str = "eth"
                # Moralis daily limit exhausted — use Ankr for main EVM chains
                if ANKR_KEY:
                    try:
                        _ankr_r = requests.post(
                            f"https://rpc.ankr.com/multichain/{ANKR_KEY}",
                            json={"id":1,"jsonrpc":"2.0","method":"ankr_getAccountBalance",
                                  "params":{"blockchain":["bsc","polygon","arbitrum","base",
                                            "optimism","avalanche","gnosis"],
                                            "walletAddress":addr,"onlyWhitelisted":False}},
                            timeout=20)
                        if _ankr_r.ok:
                            _ankr_res = _ankr_r.json().get("result",{})
                            _mc_usd = float(_ankr_res.get("totalBalanceUsd","0") or 0)
                            _mc_chains = [a["blockchain"] for a in _ankr_res.get("assets",[])
                                          if float(a.get("balanceUsd","0") or 0) >= 100]
                            total_usd += _mc_usd
                            chains_str = ", ".join(sorted({"eth"} | set(_mc_chains)))
                    except Exception:
                        pass
            else:
                portfolio = fetch_token_portfolio(addr)
            # Add Ankr extra chains on top of Moralis
            if ANKR_KEY:
                ankr_usd, ankr_chains = fetch_ankr_extra_balance(addr)
                if ankr_usd > 0:
                    total_usd += ankr_usd
                    existing   = {c.strip() for c in chains_str.split(",")}
                    chains_str = ", ".join(sorted(existing | set(ankr_chains)))
            # Manta, Zora, Mode (public RPCs — no key needed)
            l2_usd, l2_chains = fetch_extra_l2_balance(addr, eth_price)
            if l2_usd > 0:
                total_usd += l2_usd
                existing   = {c.strip() for c in chains_str.split(",")}
                chains_str = ", ".join(sorted(existing | set(l2_chains)))
        else:
            portfolio  = fetch_token_portfolio(addr)
            token_usd  = sum(float(t.get("tokenValue") or 0) for t in portfolio)
            total_usd  = eth_usd + token_usd
            chains_str = "eth"

        if not (MIN_USD <= total_usd <= MAX_USD):
            log.debug(f"  SKIP balance ${total_usd:,.0f}")
            return None

        recent_txs = fetch_recent_txs(addr, days=90)
        _ts_30 = int((now - timedelta(days=30)).timestamp())
        # Only count OUTGOING txs for tx/week — ignores incoming spam/dust/airdrops
        recent_30  = [tx for tx in recent_txs
                      if int(tx.get("timeStamp", 0)) >= _ts_30
                      and tx.get("from", "").lower() == addr.lower()]
        weekly_tx  = len(recent_30) / 4.33
        if not (MIN_TX_WEEK <= weekly_tx <= MAX_TX_WEEK):
            log.debug(f"  SKIP {weekly_tx:.1f} tx/week")
            return None

        first_dt = fetch_first_tx_date(addr)
        if not first_dt:
            return None
        age_months = (now - first_dt).days / 30.44
        if age_months < MIN_AGE_DAYS / 30.44:
            log.debug(f"  SKIP age {age_months:.1f}mo")
            return None

        wl_labels, wl_entity = fetch_wallet_labels(addr)
        if any(excl in wl_labels for excl in EXCLUDED_LABELS):
            log.debug(f"  SKIP excluded label {wl_labels}")
            return None

        # ── Deep enrichment ───────────────────────────────────────────
        inc, out_t  = fetch_alchemy_transfers_90d(addr)
        pnl_30d, pnl_90d, win_rate = estimate_pnl(inc, out_t, total_usd, eth_price)
        defi        = analyze_defi_from_portfolio(portfolio, eth_price)
        nft_data    = fetch_alchemy_nfts(addr)
        funder      = find_first_funder(addr)
        mev_count   = detect_mev_victim(recent_txs)
        bridge_chains, bridge_vol = detect_cross_chain(recent_txs, eth_price)
        # Prefer Moralis net-worth chains (accurate) over bridge-detection heuristic
        chains = chains_str if chains_str else ", ".join(bridge_chains)
        gov_votes, gov_daos = fetch_governance(addr)
        staking_val = analyze_staking_from_portfolio(portfolio)
        avg_gas     = analyze_gas(recent_txs)
        smart_label = fetch_smart_money_label(addr)
        tz          = infer_timezone(recent_txs)
        ens_name    = fetch_ens_name(addr)
        social      = fetch_social(addr, ens_name)
        airstack    = fetch_web3_social(addr)
        arkham      = fetch_arkham_identity(addr)

        # ── Extended OSINT: internet-wide contact discovery ──────────────
        # DeBank: use public scraper first (free), fall back to Pro API
        debank      = fetch_debank_public(addr)           # Twitter/Discord (no key needed)
        # Unstoppable Domains: extended (email, phone, address, discord, linkedin)
        ud          = {**(_ud_extended(addr) or {}), **(fetch_unstoppable_free(addr) or {}), **(fetch_unstoppable_profile(addr) or {})}
        # Layer 4: Farcaster verified wallets via Neynar (all linked wallets!)
        fc_wallets  = fetch_farcaster_wallets(addr)
        # Layer 4: Airstack — Lens + Farcaster + ENS in one call
        airstack_full = fetch_airstack_socials(addr)
        # Layer 4b: NEW — OpenSea + Lens + Snapshot + Mirror + DeBank (parallel, free)
        extra_social = fetch_all_social_sources(addr)
        # Layer 5: Chainbase entity label
        cb_label    = fetch_chainbase_label(addr)
        web_osint   = fetch_web_osint(addr, ens_name)     # DuckDuckGo search (free)
        gh          = fetch_github_mentions(addr)         # GitHub code search

        # WHOIS from ENS website/URL record → real registrant email/phone
        ens_url     = social.get("url", "")
        whois_data  = fetch_whois_contact(ens_url) if ens_url else {}

        # Fragment TON: Telegram username from TON NFT
        fragment_tg = fetch_fragment_ton_username(addr)

        # Cross-platform username check (uses best username we have so far)
        best_username = (
            social.get("twitter", "").lstrip("@")
            or airstack.get("farcaster_user", "")
            or (ens_name.split(".")[0] if ens_name else "")
        )
        cross_plat  = check_username_platforms(best_username) if best_username else {}

        # Sherlock (runs if installed: pip install sherlock-project)
        sherlock    = run_sherlock(best_username) if best_username else {}
        # Maigret (runs if installed: pip install maigret) — 2000+ platforms
        maigret     = run_maigret(best_username) if best_username else {}
        # Apify: wallet → Twitter handle (needs APIFY_KEY)
        apify_tw    = fetch_apify_wallet_twitter(addr)
        # IntelX: search by wallet address (needs INTELX_KEY)
        intelx_addr = fetch_intelx(addr, "ethereum") if INTELX_KEY else {}
        # IntelX: search by email (if already found)
        intelx_email: dict = {}
        # Nitter: free Twitter/X search for wallet address + ENS mentions (no key)
        nitter_addr = fetch_nitter_search(addr[:10])    # first 10 chars to avoid false positives
        nitter_ens  = fetch_nitter_search(ens_name) if ens_name else {"tweets": [], "usernames": [], "emails_found": []}
        # LeakCheck: breach search on email (free 5/day, no key)
        leakcheck   = {}

        # ── Multi-source merge: email ─────────────────────────────────────
        for src in [ud, web_osint, gh, whois_data]:
            if not social["email"] and src.get("email"):
                social["email"] = src["email"]
        # IntelX emails from address search
        for e in intelx_addr.get("emails", []):
            if not social["email"]:
                social["email"] = e
        # Emails found in nitter tweet content
        for e in (nitter_addr.get("emails_found", []) + nitter_ens.get("emails_found", [])):
            if not social["email"] and "@" in e:
                social["email"] = e

        # ── Merge extra_social into social dict ──────────────────────────────
        # Fill gaps: email, twitter, name, website, github, discord from new sources
        if not social["email"] and extra_social.get("extra_email"):
            social["email"] = extra_social["extra_email"]
        if not social["twitter"] and extra_social.get("extra_twitter"):
            social["twitter"] = extra_social["extra_twitter"]
        if not social.get("github") and extra_social.get("extra_github"):
            social["github"] = extra_social["extra_github"]
        if not social.get("discord") and extra_social.get("extra_discord"):
            social["discord"] = extra_social["extra_discord"]
        if not social.get("lens_handle") and extra_social.get("lens_handle_new"):
            social["lens_handle"] = extra_social["lens_handle_new"]
        # Website found → try WHOIS for contact email
        extra_website = extra_social.get("extra_website", "")
        if not social["email"] and extra_website:
            try:
                domain = re.sub(r"https?://", "", extra_website).split("/")[0]
                whois_c = fetch_whois_contact(domain)
                if whois_c.get("email"):
                    social["email"] = whois_c["email"]
            except Exception:
                pass

        # If we have an email now → run IntelX + LeakCheck + Constella on it
        if social["email"] and INTELX_KEY:
            intelx_email = fetch_intelx(social["email"], "email")
        if social["email"]:
            leakcheck = fetch_leakcheck_ratelimited(social["email"], "email")
        # Layer 6a: PDL enrichment — public data (name, gender, DOB, phone, location, job)
        pdl = fetch_pdl_person(email=social.get("email",""), phone=social.get("phone",""))
        # Layer 6b: Constella / breach enrichment
        constella = fetch_breach_enrichment(social["email"]) if social.get("email") else {}

        # ── Multi-source merge: phone ─────────────────────────────────────
        phones_found = (
            whois_data.get("phone")
            or next(iter(intelx_addr.get("phones", [])), "")
            or next(iter(intelx_email.get("phones", [])), "")
            # ENS phone text record (direct on-chain)
            or fetch_ens_phone(ens_name)
        )
        social["phone"] = phones_found or ""

        # LeakCheck context: if phone found in a breach, note the sources
        if leakcheck.get("found_in", 0) > 0:
            social["breach_sources"] = leakcheck.get("sources", [])
        else:
            social["breach_sources"] = []

        # ── Multi-source merge: telegram ──────────────────────────────────
        if not social["telegram"] and fragment_tg:
            social["telegram"] = fragment_tg
        for src in [ud, web_osint, cross_plat]:
            if not social["telegram"] and src.get("telegram"):
                tg = src["telegram"]
                social["telegram"] = tg if tg.startswith("@") else f"@{tg}"

        # ── Multi-source merge: twitter ───────────────────────────────────
        if apify_tw and not social["twitter"]:
            social["twitter"] = apify_tw
        for src in [airstack, arkham, debank, ud, web_osint]:
            if not social["twitter"]:
                tw = src.get("twitter_handle") or src.get("twitter") or ""
                if tw:
                    social["twitter"] = tw if tw.startswith("@") else f"@{tw}"
        # Nitter/Twitter search: first @username found
        if not social["twitter"]:
            nitter_users = nitter_addr.get("usernames", []) + nitter_ens.get("usernames", [])
            if nitter_users:
                social["twitter"] = f"@{nitter_users[0]}"
                social["twitter_source"] = "tweet_search"

        # Email → Twitter reverse lookup (X "find by email" feature)
        if not social["twitter"] and social["email"] and TWITTER_BEARER:
            tw_from_email = fetch_twitter_by_email(social["email"])
            if tw_from_email:
                social["twitter"] = tw_from_email
                social["twitter_source"] = "email_reverse_lookup"

        # ── New fields: linkedin, github, discord, ud_domain, phone ──────
        social["linkedin"]     = (ud.get("linkedin") or ud.get("ud_linkedin") or web_osint.get("linkedin") or "")
        social["discord"]      = (debank.get("discord") or ud.get("ud_discord") or ud.get("discord") or "")
        social["github"]       = (
            gh.get("github_url")
            or cross_plat.get("github")
            or ud.get("ud_github")
            or web_osint.get("github") or ""
        )
        # ── UD extended fields ────────────────────────────────────────────
        social["ud_domain"]    = ud.get("ud_domain", "")
        social["ud_email"]     = ud.get("ud_email", "")
        social["ud_phone"]     = ud.get("ud_phone", "")
        social["ud_twitter"]   = ud.get("ud_twitter", "")
        social["ud_discord"]   = ud.get("ud_discord", "")
        # If UD has email but we don't yet, use it
        if social["ud_email"] and not social["email"]:
            social["email"] = social["ud_email"]
        # ── Farcaster verified wallets (cross-wallet linking) ─────────────
        if fc_wallets:
            social["farcaster_wallets"] = json.dumps({
                "eth": fc_wallets.get("eth_wallets", []),
                "sol": fc_wallets.get("sol_wallets", []),
            })
            if fc_wallets.get("display_name") and not social.get("farcaster_name"):
                social["farcaster_name"] = fc_wallets["display_name"]
            if fc_wallets.get("bio"):
                social["farcaster_bio"] = fc_wallets["bio"]
            # If Farcaster linked Twitter and we don't have it
            if fc_wallets.get("twitter") and not social["twitter"]:
                social["twitter"] = fc_wallets["twitter"]
        else:
            social["farcaster_wallets"] = ""
            social["farcaster_name"]    = airstack_full.get("farcaster_user", "")
            social["farcaster_bio"]     = airstack_full.get("farcaster_bio", "")
        # ── Airstack Lens/Farcaster profiles JSON ─────────────────────────
        if airstack_full.get("socials"):
            social["airstack_profiles"] = json.dumps(airstack_full["socials"])
            # Also fill lens/farcaster handles from Airstack if not already set
            if not social.get("lens_handle"):
                social["lens_handle"]    = airstack_full.get("lens_handle","")
                social["lens_followers"] = airstack_full.get("lens_followers",0)
            if not social.get("farcaster_user"):
                social["farcaster_user"] = airstack_full.get("farcaster_user","")
        else:
            social["airstack_profiles"] = ""
        # ── Chainbase entity label ─────────────────────────────────────────
        social["chainbase_label"] = (
            cb_label.get("name") or cb_label.get("label") or cb_label.get("category") or ""
        )
        # ── Breach / Constella data ───────────────────────────────────────
        if constella:
            social["breach_email"] = constella.get("breach_email","")
            social["breach_phone"] = constella.get("breach_phone","")
            social["kyc_name"]     = constella.get("kyc_name","")
        else:
            social["breach_email"] = ""
            social["breach_phone"] = ""
            social["kyc_name"]     = ""
        # Merge breach phone if we don't have a phone yet
        if social["breach_phone"] and not phones_found:
            social["phone"] = social["breach_phone"]
        # phone already merged above via multi-source; keep whois as fallback
        if not social.get("phone"):
            social["phone"] = whois_data.get("phone", "")
        # Nitter context: tweets where this wallet was mentioned
        social["nitter_mentions"] = (
            nitter_addr.get("tweets", []) + nitter_ens.get("tweets", [])
        )[:5]
        social["ud_domain"]    = ud.get("ud_domain", "")
        social["web_mentions"] = web_osint.get("mentions", [])
        # Sherlock + Maigret combined platform list
        all_platforms = list(dict.fromkeys(
            sherlock.get("found_platforms", []) + maigret.get("found_platforms", [])
        ))
        social["sherlock_found"]   = all_platforms
        social["sherlock_urls"]    = list(dict.fromkeys(
            sherlock.get("profile_urls", []) + maigret.get("profile_urls", [])
        ))[:15]
        # Email permutations + verification (if we have a name but no confirmed email)
        if not social["email"]:
            who_name = whois_data.get("name") or gh.get("name") or ""
            ens_domain = (social.get("url", "") or "").replace("https://", "").replace("http://", "").split("/")[0]
            extra_domains = [ens_domain] if ens_domain and "." in ens_domain else []
            candidates = generate_email_permutations(who_name, extra_domains or None)
            if candidates:
                log.info(f"  Verifying {len(candidates)} email permutations for {who_name!r}...")
                real = find_real_emails(candidates, stop_on_first=True)
                if real:
                    # Use the best verified email as the main email
                    social["email"] = real[0]["email"]
                    log.info(f"    ✓ Verified email: {real[0]['email']} ({real[0]['method']}, conf={real[0]['confidence']})")
                social["email_candidates"] = [r["email"] for r in real]
                social["email_verification"] = real  # full verification details
            else:
                social["email_candidates"] = []
                social["email_verification"] = []
        else:
            social["email_candidates"] = []
            social["email_verification"] = []
        # IntelX sources found
        social["intelx_sources"] = intelx_addr.get("sources", [])

        # Entity name: walletlabels wins, Arkham fills gap
        final_entity = wl_entity or arkham.get("entity_name", "")

        top_tokens_list = [
            t.get("tokenSymbol", "?")
            for t in sorted(portfolio,
                            key=lambda x: float(x.get("tokenValue") or 0),
                            reverse=True)[:5]
        ]
        recent_hash = recent_30[0].get("hash", "") if recent_30 else ""

        # ── Cross-chain identity linking (Wormhole bridge history) ───────
        wh_links = fetch_wormhole_links(addr)
        cross_chain_str = json.dumps(wh_links) if wh_links else ""
        if wh_links:
            log.debug(f"  WH links: {wh_links}")

        rec = WhaleRecord(
            wallet_address     = addr,
            usd_balance        = round(total_usd, 2),
            eth_balance        = round(eth_bal, 6),
            top_tokens         = ", ".join(top_tokens_list),
            weekly_tx_count    = round(weekly_tx, 2),
            wallet_age_months  = round(age_months, 1),
            first_tx_date      = first_dt.strftime("%Y-%m-%d"),
            labels             = ", ".join(wl_labels),
            entity_name        = final_entity,
            ens_name           = ens_name,
            ens_twitter        = social["ens_twitter"],
            ens_telegram       = social["ens_telegram"],
            ens_email          = social["ens_email"],
            twitter_handle     = social["twitter"],
            telegram_username  = social["telegram"],
            email              = social["email"],
            recent_transaction = recent_hash,
            pnl_30d            = pnl_30d,
            pnl_90d            = pnl_90d,
            win_rate           = win_rate,
            defi_positions     = json.dumps(defi["positions"]),
            defi_usd_value     = defi["total_usd"],
            nft_usd_value      = nft_data["value"],
            nft_count          = nft_data["count"],
            nft_top_collection = nft_data["top_collection"],
            connected_wallets   = "",
            cluster_balance     = 0.0,
            cross_chain_wallets = cross_chain_str,
            mev_victim_count    = mev_count,
            chains_active      = chains if isinstance(chains, str) else ", ".join(chains),
            bridge_volume_90d  = bridge_vol,
            governance_votes   = gov_votes,
            governance_daos    = ", ".join(gov_daos),
            staking_value      = staking_val,
            avg_gas_gwei       = avg_gas,
            smart_money_label  = smart_label,
            timezone           = tz,
            lens_handle        = social.get("lens_handle") or airstack.get("lens_handle", ""),
            lens_followers     = social.get("lens_followers") or airstack.get("lens_followers", 0),
            farcaster_user     = social.get("farcaster_user") or airstack.get("farcaster_user", ""),
            ens_url            = social.get("url", ""),
            # ── Layer 2: Unstoppable Domains ─────────────────────────────
            ud_domain          = social.get("ud_domain",""),
            ud_email           = social.get("ud_email",""),
            ud_phone           = social.get("ud_phone",""),
            ud_twitter         = social.get("ud_twitter",""),
            ud_discord         = social.get("ud_discord",""),
            # ── Layer 3: Off-chain contact ───────────────────────────────
            phone              = social.get("phone",""),
            linkedin           = social.get("linkedin",""),
            discord            = social.get("discord",""),
            github             = social.get("github",""),
            social_profiles    = json.dumps(social.get("sherlock_found",[]))[:500],
            # ── Layer 4: Farcaster wallets + Airstack ────────────────────
            farcaster_wallets  = social.get("farcaster_wallets",""),
            farcaster_name     = social.get("farcaster_name",""),
            farcaster_bio      = social.get("farcaster_bio","")[:200],
            airstack_profiles  = social.get("airstack_profiles",""),
            # ── Layer 5: Entity labels ────────────────────────────────────
            chainbase_label    = social.get("chainbase_label",""),
            etherscan_nametag  = (fetch_etherscan_label(addr) if not final_entity else ""),
            kyc_name           = social.get("kyc_name",""),
            # ── Layer 6b: New social sources ─────────────────────────────
            os_username        = extra_social.get("os_username",""),
            os_twitter         = (extra_social.get("_os") or {}).get("os_twitter",""),
            lens_handle2       = extra_social.get("lens_handle_new",""),
            lens_email         = (extra_social.get("_lens") or {}).get("lens_email",""),
            snap_twitter       = (extra_social.get("_snap") or {}).get("snap_twitter",""),
            snap_github        = (extra_social.get("_snap") or {}).get("snap_github",""),
            mirror_name        = (extra_social.get("_mirror") or {}).get("mirror_name",""),
            db_twitter         = (extra_social.get("_db") or {}).get("db_twitter",""),
            db_discord         = (extra_social.get("_db") or {}).get("db_discord",""),
            # ── Layer 6: Breach PII (LeakCheck) ──────────────────────────
            breach_email       = (leakcheck.get("emails") or [""])[0] or social.get("breach_email",""),
            breach_phone       = (leakcheck.get("phones") or [""])[0] or social.get("breach_phone",""),
            breach_sources     = ", ".join(leakcheck.get("sources",[])[:5]),
            breach_fields      = ", ".join(leakcheck.get("fields_exposed",[])[:8]),
            # ── Layer 7: PDL — public data enrichment ────────────────────
            pdl_name           = pdl.get("pdl_name",""),
            pdl_gender         = pdl.get("pdl_gender",""),
            pdl_birth_year     = pdl.get("pdl_birth_year",""),
            pdl_phone          = pdl.get("pdl_phone",""),
            pdl_city           = pdl.get("pdl_city",""),
            pdl_state          = pdl.get("pdl_state",""),
            pdl_country        = pdl.get("pdl_country",""),
            pdl_postal         = pdl.get("pdl_postal",""),
            pdl_linkedin       = pdl.get("pdl_linkedin",""),
            pdl_job            = pdl.get("pdl_job",""),
            pdl_company        = pdl.get("pdl_company",""),
        )

        score_behavior(rec)
        score_older_demographic(rec)
        rec.whale_category = categorize(rec)
        rec.ai_summary     = build_ai_summary(rec)
        generate_outreach_messages(rec)

        log.info(
            f"  [+] ADDED  ${total_usd:,.0f}  age={age_months:.0f}mo  "
            f"tx/wk={weekly_tx:.1f}  alpha={rec.copyworthy_score}  "
            f"cat={rec.whale_category}  ENS={ens_name or '-'}"
        )
        return rec, funder

    except Exception as e:
        log.error(f"  ERROR processing {addr}: {e}")
        return None


def phase2_enrich(candidates: List[str], eth_price: float,
                  done: set, prev_results: list,
                  target: int = TARGET_COUNT,
                  older_mode: bool = False) -> Tuple[List['WhaleRecord'], Dict[str, str]]:
    import threading
    log.info("━" * 60)
    log.info("PHASE 2: Enriching + filtering (5 parallel workers)")
    log.info("━" * 60)

    records: List[WhaleRecord] = [WhaleRecord(**r) for r in prev_results]
    funders: Dict[str, str]   = {}
    now     = datetime.utcnow()
    lock    = threading.Lock()
    stop    = threading.Event()

    pending = [(i, a) for i, a in enumerate(candidates) if a not in done]

    def _worker(i_addr):
        i, addr = i_addr
        if stop.is_set():
            return
        log.info(f"[{i+1}/{len(candidates)}] {addr[:10]}…  found={len(records)}/{target}")
        result = _enrich_one(addr, eth_price, now)
        with lock:
            done.add(addr)
            if result is None:
                return
            rec, funder = result
            # In older-mode, drop wallets that don't score as likely 45+ demographic
            if older_mode and rec.older_demographic_score < 5:
                log.debug(f"  SKIP older_score={rec.older_demographic_score} (< 5)")
                return
            if len(records) >= target:
                stop.set()
                return
            records.append(rec)
            funders[addr] = funder
            if len(records) >= target:
                stop.set()
                log.info(f"  Target {target} reached!")
            if len(records) % 10 == 0:
                save_checkpoint(done, [asdict(r) for r in records])
                write_outputs(records, funders)

    try:
        with ThreadPoolExecutor(max_workers=5) as pool:
            pool.map(_worker, pending)
    except KeyboardInterrupt:
        log.info("Interrupted — saving checkpoint…")
        save_checkpoint(done, [asdict(r) for r in records])
        write_outputs(records, funders)

    return records, funders


# ─── Phase 3: Cluster backfill ────────────────────────────────────────────
def phase3_cluster_backfill(records: List['WhaleRecord'],
                             funders: Dict[str, str]) -> None:
    """Backfill connected_wallets + cluster_balance into each record."""
    clusters = build_clusters(funders)
    # Reverse map: address → cluster members
    addr_to_cluster: Dict[str, List[str]] = {}
    for funder, members in clusters.items():
        for m in members:
            addr_to_cluster[m] = [x for x in members if x != m]

    addr_to_balance = {r.wallet_address: r.usd_balance for r in records}

    for rec in records:
        peers = addr_to_cluster.get(rec.wallet_address, [])
        if peers:
            rec.connected_wallets = json.dumps(peers)
            rec.cluster_balance   = round(
                rec.usd_balance + sum(addr_to_balance.get(p, 0) for p in peers), 2
            )


# ─── Main ─────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Whale Intelligence Platform v2")
    parser.add_argument("--test",        action="store_true", help="Quick test (10 addresses)")
    parser.add_argument("--run",         action="store_true", help="Full run (1000 addresses)")
    parser.add_argument("--resume",      action="store_true", help="Resume from checkpoint")
    parser.add_argument("--older-mode",  action="store_true",
                        help="Target 45+ demographic: $1M+ hodlers, old wallets, no DeFi/NFTs")
    args = parser.parse_args()

    if not ETHERSCAN_KEY:
        log.error("ETHERSCAN_KEY not set. Add it to .env or environment.")
        sys.exit(1)

    # ── Older-demographic mode: override global filters ──────────────────────
    older_mode = args.older_mode
    if older_mode:
        global MIN_USD, MAX_USD, MIN_AGE_DAYS, MIN_TX_WEEK, MAX_TX_WEEK
        MIN_USD      = 1_000_000    # $1M minimum
        MAX_USD      = 500_000_000  # up to $500M
        MIN_AGE_DAYS = 365 * 3      # wallet must be 3+ years old
        MIN_TX_WEEK  = 0.0          # hodlers barely transact — no minimum
        MAX_TX_WEEK  = 4.0          # not active traders
        log.info("★  OLDER-DEMOGRAPHIC MODE  (45+ signals, $1M+, hodlers only)  ★")

    test_mode   = args.test
    target      = 10 if test_mode else TARGET_COUNT

    log.info("🐋  Whale Intelligence Platform v2  🐋")
    log.info(f"   Target  : {target} addresses")
    log.info(f"   Balance : ${MIN_USD:,} – ${MAX_USD:,} USD")
    log.info(f"   Age     : {MIN_AGE_DAYS}+ days  |  Tx/wk: {MIN_TX_WEEK}–{MAX_TX_WEEK}")
    es_key_count = len(_ES_KEYS)
    log.info(f"   Etherscan: {es_key_count} key(s) → {es_key_count * 5} req/sec"
             f"  {'[TURBO]' if es_key_count > 1 else '[normal]'}")
    log.info(f"   Alchemy : {'[OK]' if ALCHEMY_KEY else '[--]'}")
    log.info(f"   Moralis : {'[OK] 10 EVM chains!' if MORALIS_KEY else '[--]'}")
    log.info(f"   Neynar  : {'[OK]' if NEYNAR_KEY else '[--]'}")
    log.info(f"   TRON    : [OK] free (TronGrid/TronScan)")
    log.info(f"   Solana  : {'[OK]' if HELIUS_KEY else '[--] add HELIUS_KEY in .env (free: helius.dev)'}")
    log.info(f"   Bitcoin : [OK] free (Blockstream)  — add btc_addresses.txt for candidates")
    log.info(f"   TON     : [OK] free (tonapi.io)  — add ton_addresses.txt for more candidates")
    log.info(f"   Cosmos  : [OK] free (Cosmos LCD)  — add cosmos_addresses.txt for candidates")
    log.info(f"   Aptos   : [OK] free (Aptos Labs)  — add aptos_addresses.txt for candidates")
    log.info(f"   Sui     : [OK] free (Sui RPC)     — add sui_addresses.txt for candidates")
    log.info(f"   Polkadot: {'[OK]' if SUBSCAN_KEY else '[--] add SUBSCAN_KEY in .env (free: subscan.io) or dot_addresses.txt'}")
    log.info(f"   Algorand: [OK] free (Algonode indexer)")
    log.info(f"   Cardano : {'[OK]' if BLOCKFROST_KEY else '[--] add BLOCKFROST_KEY in .env (free: blockfrost.io) or ada_addresses.txt'}")
    log.info(f"   Manta/Zora/Mode: [OK] free (public RPCs — native ETH balance)")
    evm_count = 10 + (len(_ANKR_EXTRA_CHAINS) if ANKR_KEY else 0) + len(_EXTRA_L2_RPCS)
    log.info(f"   EVM     : {evm_count} chains {'(Moralis + Ankr + L2 RPCs)' if ANKR_KEY else '(Moralis + L2 RPCs)'}")
    # AI Panel status
    available_ai = _available_providers()
    if len(available_ai) >= 2:
        judge = _pick_judge(available_ai)
        log.info(f"   AI Panel: {available_ai} → judge: {judge.upper()}")
    elif len(available_ai) == 1:
        log.info(f"   AI      : {available_ai[0]} (single provider)")
    else:
        log.info(f"   AI      : heuristic (no AI keys set)")
    # Show accumulated scores from previous runs
    prev_scores = _load_scores()
    if prev_scores:
        log.info("   Provider win rates (accumulated):")
        for p, s in sorted(prev_scores.items(), key=lambda x: x[1].get("wins", 0), reverse=True):
            log.info(f"     {p:10s} wins={s['wins']}  attempts={s['attempts']}  "
                     f"win_rate={s.get('win_rate', 0)}%  avg_score={s.get('avg_score', 0)}")

    # Load checkpoint if resuming
    done, prev_results = load_checkpoint() if args.resume else (set(), [])
    if prev_results:
        log.info(f"Checkpoint: {len(done)} processed, {len(prev_results)} qualified")

    eth_price = fetch_eth_price()
    log.info(f"ETH price : ${eth_price:,.2f}")

    # ── Live chain prices from CoinGecko ─────────────────────────────────
    global _TRX_PRICE, _SOL_PRICE, _TON_PRICE, _ATOM_PRICE, _APT_PRICE
    global _SUI_PRICE, _DOT_PRICE, _ALGO_PRICE, _ADA_PRICE, _BTC_PRICE
    _cg = fetch_chain_prices()
    if _cg:
        _TRX_PRICE  = _cg.get("tron",             {}).get("usd", _TRX_PRICE)
        _SOL_PRICE  = _cg.get("solana",            {}).get("usd", _SOL_PRICE)
        _TON_PRICE  = _cg.get("the-open-network",  {}).get("usd", _TON_PRICE)
        _ATOM_PRICE = _cg.get("cosmos",            {}).get("usd", _ATOM_PRICE)
        _APT_PRICE  = _cg.get("aptos",             {}).get("usd", _APT_PRICE)
        _SUI_PRICE  = _cg.get("sui",               {}).get("usd", _SUI_PRICE)
        _DOT_PRICE  = _cg.get("polkadot",          {}).get("usd", _DOT_PRICE)
        _ALGO_PRICE = _cg.get("algorand",          {}).get("usd", _ALGO_PRICE)
        _ADA_PRICE  = _cg.get("cardano",           {}).get("usd", _ADA_PRICE)
        _BTC_PRICE  = _cg.get("bitcoin",           {}).get("usd", _BTC_PRICE)
        log.info(f"Prices    : TRX=${_TRX_PRICE:.3f}  SOL=${_SOL_PRICE:.2f}  TON=${_TON_PRICE:.2f}  ATOM=${_ATOM_PRICE:.2f}")
        log.info(f"           APT=${_APT_PRICE:.2f}  SUI=${_SUI_PRICE:.2f}  DOT=${_DOT_PRICE:.2f}  ALGO=${_ALGO_PRICE:.3f}")
        log.info(f"           ADA=${_ADA_PRICE:.3f}  BTC=${_BTC_PRICE:,.0f}")

    # ── Phase 1: Collect candidates from ALL chains ──────────────────────
    eth_candidates   = phase1_candidates(test_mode=test_mode)
    tron_candidates  = phase1_tron_candidates(50 if test_mode else 150)
    sol_candidates   = phase1_solana_candidates(50 if test_mode else 150)
    btc_candidates   = phase1_btc_candidates(20 if test_mode else 100)
    ton_candidates   = phase1_ton_candidates(20 if test_mode else 100)
    cosmos_candidates= phase1_cosmos_candidates(20 if test_mode else 100)
    aptos_candidates = phase1_aptos_candidates(20 if test_mode else 100)
    sui_candidates   = phase1_sui_candidates(20 if test_mode else 100)
    dot_candidates   = phase1_dot_candidates(20 if test_mode else 100)
    algo_candidates  = phase1_algo_candidates(20 if test_mode else 100)
    ada_candidates   = phase1_ada_candidates(20 if test_mode else 100)

    # ETH candidates go through full EVM enrichment
    records, funders = phase2_enrich(eth_candidates, eth_price, done, prev_results, target, older_mode)

    # Non-EVM chains: simplified enrichment
    remaining = target - len(records)
    if remaining > 0 and tron_candidates:
        log.info(f"  Processing {len(tron_candidates)} TRON candidates...")
        for addr, chain in tron_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_tron(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [TRON] ADDED  ${result[0].usd_balance:,.0f}")

    if remaining > 0 and sol_candidates:
        log.info(f"  Processing {len(sol_candidates)} Solana candidates...")
        for addr, chain in sol_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_solana(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [SOL] ADDED  ${result[0].usd_balance:,.0f}")

    # BTC
    remaining = target - len(records)
    if remaining > 0 and btc_candidates:
        log.info(f"  Processing {len(btc_candidates)} Bitcoin candidates...")
        for addr, chain in btc_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_btc(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [BTC] ADDED  ${result[0].usd_balance:,.0f}")

    # TON
    remaining = target - len(records)
    if remaining > 0 and ton_candidates:
        log.info(f"  Processing {len(ton_candidates)} TON candidates...")
        for addr, chain in ton_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_ton(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [TON] ADDED  ${result[0].usd_balance:,.0f}")

    # Cosmos
    remaining = target - len(records)
    if remaining > 0 and cosmos_candidates:
        log.info(f"  Processing {len(cosmos_candidates)} Cosmos candidates...")
        for addr, chain in cosmos_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_cosmos(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [ATOM] ADDED  ${result[0].usd_balance:,.0f}")

    # Aptos
    remaining = target - len(records)
    if remaining > 0 and aptos_candidates:
        log.info(f"  Processing {len(aptos_candidates)} Aptos candidates...")
        for addr, chain in aptos_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_aptos(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [APT] ADDED  ${result[0].usd_balance:,.0f}")

    # Sui
    remaining = target - len(records)
    if remaining > 0 and sui_candidates:
        log.info(f"  Processing {len(sui_candidates)} Sui candidates...")
        for addr, chain in sui_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_sui(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [SUI] ADDED  ${result[0].usd_balance:,.0f}")

    # Polkadot
    remaining = target - len(records)
    if remaining > 0 and dot_candidates:
        log.info(f"  Processing {len(dot_candidates)} Polkadot candidates...")
        for addr, chain in dot_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_dot(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [DOT] ADDED  ${result[0].usd_balance:,.0f}")

    # Algorand
    remaining = target - len(records)
    if remaining > 0 and algo_candidates:
        log.info(f"  Processing {len(algo_candidates)} Algorand candidates...")
        for addr, chain in algo_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_algo(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [ALGO] ADDED  ${result[0].usd_balance:,.0f}")

    # Cardano
    remaining = target - len(records)
    if remaining > 0 and ada_candidates:
        log.info(f"  Processing {len(ada_candidates)} Cardano candidates...")
        for addr, chain in ada_candidates:
            if len(records) >= target:
                break
            if addr in done:
                continue
            result = _enrich_one_ada(addr)
            done.add(addr)
            if result:
                records.append(result[0])
                log.info(f"  [ADA] ADDED  ${result[0].usd_balance:,.0f}")

    log.info("━" * 60)
    log.info("PHASE 3: Wallet cluster backfill")
    log.info("━" * 60)
    phase3_cluster_backfill(records, funders)

    write_outputs(records, funders)

    log.info("━" * 60)
    log.info(f"✅  Complete!  {len(records)} whale records extracted")
    log.info(f"   With ENS       : {sum(1 for r in records if r.ens_name)}")
    log.info(f"   With Twitter   : {sum(1 for r in records if r.twitter_handle)}")
    log.info(f"   With Lens      : {sum(1 for r in records if r.lens_handle)}")
    log.info(f"   With DeFi      : {sum(1 for r in records if r.defi_usd_value > 0)}")
    log.info(f"   With NFTs      : {sum(1 for r in records if r.nft_count > 0)}")
    log.info(f"   Gov voters     : {sum(1 for r in records if r.governance_votes > 0)}")
    log.info(f"   Clustered      : {sum(1 for r in records if r.connected_wallets)}")
    log.info(f"   Cross-chain ID : {sum(1 for r in records if r.cross_chain_wallets)} (Wormhole bridge links)")
    log.info(f"   Avg alpha score: {sum(r.copyworthy_score for r in records)//max(len(records),1)}/100")
    log.info(f"   Output dir     : {OUTPUT_DIR}/")
    # Print final panel leaderboard
    final_scores = _load_scores()
    if final_scores:
        log.info("━" * 60)
        log.info("🏆  AI Panel Leaderboard (this session + all previous runs)")
        for rank, (p, s) in enumerate(
            sorted(final_scores.items(), key=lambda x: x[1].get("wins", 0), reverse=True), 1
        ):
            log.info(f"   #{rank} {p.upper():10s}  wins={s['wins']}  "
                     f"win_rate={s.get('win_rate', 0)}%  avg_score={s.get('avg_score', 0)}/10")
    log.info("━" * 60)


if __name__ == "__main__":
    main()
