"""CLI: doctor | scan | enrich (Phase 2–3)."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

from . import __version__
from .checkpoint import clear_checkpoint, load_checkpoint, save_checkpoint
from .config import ROOT, load_config, load_env
from .doctor import run_doctor
from .enrich import enrich_address
from .export import make_out_dir, write_csv, write_enrich_csv, write_json, write_legion_csv
from .filters import dedupe_addresses, is_skipped_address
from .legion import (
    LAUNCH_FAMILIES,
    fetch_legion_readiness,
    filter_legion_rows,
    parse_family_filter,
)
from .logutil import log_event, setup_logging
from .portfolio import true_portfolio
from .progress import Progress


def _job_id_for(addrs: list[str], args: argparse.Namespace, prefix: str = "scan") -> str:
    if getattr(args, "job_id", None):
        return args.job_id
    raw = "|".join(addrs[:50]) + f"|{getattr(args, 'min_usd', '')}|{getattr(args, 'input', '')}|{getattr(args, 'address', '')}"
    return f"{prefix}_" + hashlib.sha256(raw.encode()).hexdigest()[:12]


def _read_addresses(args: argparse.Namespace) -> list[str]:
    raw: list[str] = []
    if args.address:
        raw.append(args.address)
    if getattr(args, "input", None):
        path = Path(args.input)
        text = path.read_text(encoding="utf-8")
        if path.suffix.lower() == ".json":
            data = json.loads(text)
            if isinstance(data, list):
                for row in data:
                    if isinstance(row, str):
                        raw.append(row)
                    elif isinstance(row, dict):
                        raw.append(str(row.get("addr") or row.get("address") or ""))
        else:
            for line in text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                raw.append(line.split(",")[0].strip().strip('"'))
    return dedupe_addresses(raw)


def cmd_scan(args: argparse.Namespace) -> int:
    load_env()
    cfg = load_config()
    if args.min_usd is not None:
        cfg["min_usd"] = float(args.min_usd)
    if args.no_cache:
        cfg["cache_disabled"] = True

    addrs = _read_addresses(args)
    if not addrs:
        print("No addresses. Use --address 0x... or --input file.json|txt|csv")
        return 1

    job_id = _job_id_for(addrs, args, "scan")
    setup_logging(cfg, json_logs=args.json_logs, job_id=job_id)

    done: dict = {}
    rows: list = []
    if args.resume:
        cp = load_checkpoint(job_id, cfg)
        if cp and cp.get("addresses") == addrs:
            done = dict(cp.get("done") or {})
            rows = list(cp.get("rows") or [])
            log_event("INFO", "resume_loaded", job_id=job_id, done=len(done), rows=len(rows))
        else:
            log_event("WARN", "resume_miss_or_mismatch", job_id=job_id)

    log_event(
        "INFO",
        "scan_start",
        job_id=job_id,
        total=len(addrs),
        min_usd=cfg.get("min_usd"),
        cache=not cfg.get("cache_disabled"),
    )

    progress = Progress(len(addrs), label="scan")
    min_usd = float(cfg.get("min_usd", 0))

    for i, addr in enumerate(addrs, 1):
        if addr in done:
            progress.tick()
            continue

        if is_skipped_address(addr):
            done[addr] = {"status": "skip", "reason": "cex_or_contract"}
            log_event("INFO", "skip", address=addr[:12], reason="cex_or_contract")
            progress.tick()
            if i % int(cfg.get("checkpoint_every") or 5) == 0:
                save_checkpoint(job_id, cfg, addresses=addrs, done=done, rows=rows)
            continue

        t0 = time.time()
        result = true_portfolio(addr, cfg)
        d = result.to_dict()
        elapsed = time.time() - t0
        flag = "OK" if result.total_usd >= min_usd else "LOW"
        bar = progress.tick()
        print(
            f"[{i}/{len(addrs)}] {flag} ${result.total_usd:>12,.0f}  "
            f"moralis=${result.moralis_usd:,.0f} ankr=${result.ankr_usd:,.0f}  "
            f"{d.get('chains_active','')}  {addr[:10]}…  ({elapsed:.1f}s)  {bar}"
        )
        log_event(
            "INFO",
            "wallet_scanned",
            address=addr,
            total_usd=result.total_usd,
            elapsed_s=round(elapsed, 2),
        )
        if result.errors:
            print(f"         errors: {', '.join(result.errors)}")

        done[addr] = {"status": flag, "total_usd": result.total_usd}
        if result.total_usd >= min_usd or args.keep_all:
            rows.append(d)

        every = int(cfg.get("checkpoint_every") or 5)
        if i % every == 0 or i == len(addrs):
            save_checkpoint(job_id, cfg, addresses=addrs, done=done, rows=rows)

        if args.sleep > 0 and i < len(addrs):
            time.sleep(args.sleep)

    rows.sort(key=lambda r: float(r.get("total_usd") or 0), reverse=True)
    out = make_out_dir(ROOT, str(cfg.get("out_dir") or "out"))
    stamp = time.strftime("%H%M%S")
    json_path = out / f"portfolio_{stamp}.json"
    csv_path = out / f"portfolio_{stamp}.csv"
    write_json(json_path, rows)
    write_csv(csv_path, rows)

    if args.clear_checkpoint:
        clear_checkpoint(job_id, cfg)
    else:
        save_checkpoint(
            job_id,
            cfg,
            addresses=addrs,
            done=done,
            rows=rows,
            meta={"json": str(json_path), "csv": str(csv_path)},
        )

    print("-" * 50)
    print(f"job_id={job_id}")
    print(f"Wrote {len(rows)} rows")
    print(f"  {json_path}")
    print(f"  {csv_path}")
    log_event("INFO", "scan_done", job_id=job_id, rows=len(rows), done=len(done))
    return 0


def cmd_enrich(args: argparse.Namespace) -> int:
    load_env()
    cfg = load_config()
    if args.no_cache:
        cfg["cache_disabled"] = True

    addrs = _read_addresses(args)
    if not addrs:
        print("No addresses. Use --address 0x... or --input file.json|txt|csv")
        return 1

    job_id = _job_id_for(addrs, args, "enrich")
    setup_logging(cfg, json_logs=args.json_logs, job_id=job_id)
    outreach = bool(args.outreach)
    log_event("INFO", "enrich_start", job_id=job_id, total=len(addrs), outreach=outreach)

    done: dict = {}
    rows: list = []
    if args.resume:
        cp = load_checkpoint(job_id, cfg)
        if cp and cp.get("addresses") == addrs:
            done = dict(cp.get("done") or {})
            rows = list(cp.get("rows") or [])
            log_event("INFO", "resume_loaded", job_id=job_id, done=len(done))

    progress = Progress(len(addrs), label="enrich")
    for i, addr in enumerate(addrs, 1):
        if addr in done:
            progress.tick()
            continue
        if is_skipped_address(addr):
            done[addr] = {"status": "skip"}
            progress.tick()
            continue

        profile = enrich_address(addr, cfg, outreach=outreach)
        d = profile.to_dict()
        bar = progress.tick()
        print(
            f"[{i}/{len(addrs)}] {addr[:10]}…  ens={d['ens']['value'] or '-'}({d['ens']['quality']})  "
            f"fc=@{d['farcaster']['value'] or '-'}({d['farcaster']['quality']})  "
            f"email={d['email']['value'] or '-'}({d['email']['quality']})  "
            f"best={d['best_channel']}  {bar}"
        )
        log_event(
            "INFO",
            "wallet_enriched",
            address=addr,
            best_channel=d["best_channel"],
            ens_q=d["ens"]["quality"],
            farcaster_q=d["farcaster"]["quality"],
            email_q=d["email"]["quality"],
        )
        done[addr] = {"status": "ok", "best_channel": d["best_channel"]}
        rows.append(d)

        every = int(cfg.get("checkpoint_every") or 5)
        if i % every == 0 or i == len(addrs):
            save_checkpoint(job_id, cfg, addresses=addrs, done=done, rows=rows)
        if args.sleep > 0 and i < len(addrs):
            time.sleep(args.sleep)

    out = make_out_dir(ROOT, str(cfg.get("out_dir") or "out"))
    stamp = time.strftime("%H%M%S")
    json_path = out / f"enrich_{stamp}.json"
    csv_path = out / f"enrich_{stamp}.csv"
    write_json(json_path, rows)
    write_enrich_csv(csv_path, rows)

    if args.clear_checkpoint:
        clear_checkpoint(job_id, cfg)
    else:
        save_checkpoint(job_id, cfg, addresses=addrs, done=done, rows=rows)

    verified_email = sum(1 for r in rows if (r.get("email") or {}).get("quality") == "verified")
    verified_fc = sum(1 for r in rows if (r.get("farcaster") or {}).get("quality") == "verified")
    print("-" * 50)
    print(f"job_id={job_id}")
    print(f"Wrote {len(rows)} rows | verified email={verified_email} farcaster={verified_fc}")
    print(f"  {json_path}")
    print(f"  {csv_path}")
    if outreach:
        print("  outreach templates included (AI off — template only)")
    log_event("INFO", "enrich_done", job_id=job_id, rows=len(rows))
    return 0


def _load_rows_file(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        data = json.loads(text)
        if isinstance(data, list):
            return [r for r in data if isinstance(r, dict)]
        if isinstance(data, dict) and isinstance(data.get("rows"), list):
            return [r for r in data["rows"] if isinstance(r, dict)]
        return []
    # csv — minimal: address + total_usd columns
    import csv as _csv
    from io import StringIO

    reader = _csv.DictReader(StringIO(text))
    rows = []
    for r in reader:
        addr = (r.get("address") or r.get("addr") or "").strip()
        if not addr:
            continue
        usd = r.get("total_usd") or r.get("usd") or r.get("True_USD") or "0"
        try:
            usd_f = float(str(usd).replace("$", "").replace(",", ""))
        except ValueError:
            usd_f = 0.0
        rows.append(
            {
                "address": addr,
                "total_usd": usd_f,
                "chains_active": r.get("chains_active") or r.get("chains") or "eth",
            }
        )
    return rows


def cmd_legion_export(args: argparse.Namespace) -> int:
    load_env()
    cfg = load_config()
    setup_logging(cfg, json_logs=args.json_logs, job_id="legion_export")

    if not args.input:
        print("Need --input portfolio/enrich JSON (from scan or enrich)")
        return 1

    path = Path(args.input)
    if not path.exists():
        print(f"File not found: {path}")
        return 1

    rows = _load_rows_file(path)
    if not rows:
        print("No rows in input")
        return 1

    min_usd = float(args.min_usd) if args.min_usd is not None else float(cfg.get("min_usd") or 0)
    families = parse_family_filter(args.families)
    if args.launch_five:
        families = list(LAUNCH_FAMILIES)

    ready_families: list[str] = []
    readiness = None
    if args.live_ready or args.show_ready:
        readiness = fetch_legion_readiness(cfg)
        if not readiness.ok:
            print(f"WARN: client-config failed: {readiness.error} ({readiness.url})")
        else:
            ready_families = readiness.ready_families
            print(f"Legion ready families: {', '.join(ready_families) or '(none)'}")
            print(f"  url={readiness.url}")
        if args.show_ready and not args.input:
            return 0 if readiness and readiness.ok else 1

    export_rows = filter_legion_rows(
        rows,
        min_usd=min_usd,
        families=families,
        ready_families=ready_families,
        live_ready_only=bool(args.live_ready),
    )

    out = make_out_dir(ROOT, str(cfg.get("out_dir") or "out"))
    stamp = time.strftime("%H%M%S")
    json_path = out / f"legion_{stamp}.json"
    csv_path = out / f"legion_{stamp}.csv"
    meta = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "min_usd": min_usd,
        "families_filter": families,
        "live_ready": bool(args.live_ready),
        "ready_families": ready_families,
        "source": str(path),
        "count": len(export_rows),
        "note": "export-only — does not trigger Legion drain",
    }
    write_json(json_path, {"meta": meta, "rows": export_rows})
    write_legion_csv(csv_path, export_rows)

    print("-" * 50)
    print(f"Legion export: {len(export_rows)} / {len(rows)} rows (min_usd={min_usd})")
    if families:
        print(f"  families filter: {', '.join(families)}")
    print(f"  {json_path}")
    print(f"  {csv_path}")
    log_event("INFO", "legion_export_done", count=len(export_rows), min_usd=min_usd)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="wex",
        description=f"Whale Extractor v{__version__} — doctor | scan | enrich | legion-export",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="Check API keys + live prices")

    scan = sub.add_parser("scan", help="True portfolio scan (Moralis + Ankr)")
    scan.add_argument("--address", help="Single EVM address")
    scan.add_argument("--input", help="JSON/CSV/TXT of addresses")
    scan.add_argument("--min-usd", type=float, default=None, help="Override config min_usd")
    scan.add_argument("--keep-all", action="store_true", help="Keep rows below min_usd")
    scan.add_argument("--sleep", type=float, default=0.25, help="Delay between wallets")
    scan.add_argument("--resume", action="store_true", help="Resume from checkpoint")
    scan.add_argument("--job-id", help="Checkpoint job id (default: hash of inputs)")
    scan.add_argument("--no-cache", action="store_true", help="Disable file portfolio cache")
    scan.add_argument("--clear-checkpoint", action="store_true", help="Delete checkpoint after success")
    scan.add_argument("--json-logs", action="store_true", help="Also write JSONL under logs/")

    enrich = sub.add_parser("enrich", help="Verified contacts (ENS + Farcaster)")
    enrich.add_argument("--address", help="Single EVM address")
    enrich.add_argument("--input", help="JSON/CSV/TXT of addresses")
    enrich.add_argument("--sleep", type=float, default=0.3, help="Delay between wallets")
    enrich.add_argument("--resume", action="store_true", help="Resume from checkpoint")
    enrich.add_argument("--job-id", help="Checkpoint job id")
    enrich.add_argument("--no-cache", action="store_true", help="Disable enrich cache")
    enrich.add_argument("--clear-checkpoint", action="store_true")
    enrich.add_argument("--json-logs", action="store_true")
    enrich.add_argument(
        "--outreach",
        action="store_true",
        help="Include template outreach message (default OFF, no AI/breach APIs)",
    )

    lex = sub.add_parser(
        "legion-export",
        help="Export-only Legion lead list (no drain). Filters by family / live ready",
    )
    lex.add_argument("--input", required=True, help="portfolio_*.json or enrich_*.json from scan/enrich")
    lex.add_argument("--min-usd", type=float, default=None, help="USD floor (default config min_usd)")
    lex.add_argument(
        "--families",
        help="Comma list e.g. EVM,SOL,BTC,TRON,TON",
    )
    lex.add_argument(
        "--launch-five",
        action="store_true",
        help="Shorthand: families=EVM,SOL,BTC,TRON,TON",
    )
    lex.add_argument(
        "--live-ready",
        action="store_true",
        help="Keep only families ready on live client-config",
    )
    lex.add_argument(
        "--show-ready",
        action="store_true",
        help="Print live ready families (still needs --input for export)",
    )
    lex.add_argument("--json-logs", action="store_true")

    return p


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "doctor":
        return run_doctor()
    if args.cmd == "scan":
        return cmd_scan(args)
    if args.cmd == "enrich":
        return cmd_enrich(args)
    if args.cmd == "legion-export":
        return cmd_legion_export(args)
    parser.print_help()
    return 1
