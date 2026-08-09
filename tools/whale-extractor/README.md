# Whale Extractor v2 (wex)

True portfolio + whale OSINT toolkit for Legion ops.

## Quick start

```bash
cd tools/whale-extractor
pip install -r requirements.txt
copy .env.example .env   # fill MORALIS_KEY and/or ANKR_KEY

python -m wex doctor
python -m wex scan --address 0xYourWallet
python -m wex enrich --address 0xYourWallet
python -m wex legion-export --input out/.../portfolio_*.json --launch-five --live-ready
```

## Commands

| Command | What |
|---------|------|
| `doctor` | Keys + prices + live Legion ready families |
| `scan` | Moralis + Ankr portfolio → `out/YYYYMMDD/` |
| `enrich` | ENS + Farcaster contacts (`verified`/`guess`/`none`) |
| `legion-export` | Export-only Legion lead list (**no drain**) |

### legion-export (Phase 4)

```bash
python -m wex legion-export --input out/20260722/portfolio_HHMMSS.json --launch-five --live-ready
python -m wex legion-export --input portfolio.json --families EVM,SOL --min-usd 50000
```

Output: `address, family, families[], chains[], usd, tags, legion_ready`  
`--live-ready` uses Railway `client-config` and keeps only ready families.

### enrich (Phase 3)

```bash
python -m wex enrich --address 0x...
python -m wex enrich --input whales.json --resume
python -m wex enrich --address 0x... --outreach   # template only, default OFF
```

### scan flags (Phase 2)

`--resume` · `--job-id` · `--no-cache` · `--clear-checkpoint` · `--json-logs`

## Config

`config.yaml` + `.env` (`MORALIS_KEYS`, `ANKR_KEYS`, `LEGION_CLIENT_CONFIG_URL`)

## Tests

```bash
set PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
pytest tests/test_filters.py tests/test_phase2.py tests/test_phase3.py tests/test_phase4.py -q
```

## Phase status

- [x] Phase 0 — CLI, config, doctor
- [x] Phase 1 — true portfolio, filters, export
- [x] Phase 2 — cache, resume, key rotation, logs, ETA
- [x] Phase 3 — verified contacts
- [x] Phase 4 — Legion export filters (export-only)

## Legacy

`whale_extractor.py`, `mega_scan.py`, `find_whales_full.py` still work.
