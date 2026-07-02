"""
Build step for the GEX Replay site.

Scans the local gex_snapshots collection, bundles every day's JSON snapshots
into one file per (series, date), copies the matching rendered PNG frames into
the site, and writes a manifest the web app reads to discover what's available.

Re-run this whenever you want to publish new snapshots, then commit + push.

Usage:
    python scripts/build_manifest.py
    python scripts/build_manifest.py --source "C:/Users/jalee/gex_snapshots" --copy-frames
"""
import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path

# Directory names under the source root that are NOT snapshot series.
IGNORE_DIRS = {"scripts", "replays", "__pycache__"}

_num_re = re.compile(r"-?[\d,]*\.?\d+[KMB]?")


def parse_money(text):
    """'-$5.05B' -> -5.05e9 ; returns None when unparseable."""
    if not text:
        return None
    tokens = _num_re.findall(text.replace("$", ""))
    if not tokens:
        return None
    tok = tokens[-1].replace(",", "")
    m = re.match(r"(-?[\d.]+)([KMB]?)$", tok)
    if not m:
        return None
    mult = {"": 1, "K": 1e3, "M": 1e6, "B": 1e9}[m.group(2)]
    return float(m.group(1)) * mult


def title_from_slug(slug):
    """'SPY_GEXOI_700_800' -> 'SPY — GEX OI (700-800)' (best effort)."""
    parts = slug.split("_")
    symbol = parts[0] if parts else slug
    rest = parts[1:]
    label = " ".join(rest)
    label = label.replace("GEXOI", "GEX OI")
    # pull a trailing numeric range like 700 800 -> (700-800)
    m = re.search(r"(\d+)\D+(\d+)$", slug)
    rng = f" ({m.group(1)}-{m.group(2)})" if m else ""
    label = re.sub(r"\d+\D+\d+$", "", label).strip()
    return f"{symbol} — {label}{rng}".replace("  ", " ").strip(" —")


def ts_label(stem):
    """'SPY_2026-07-02_172513' -> '17:25:13'."""
    hhmmss = stem.split("_")[-1]
    if len(hhmmss) == 6 and hhmmss.isdigit():
        return f"{hhmmss[:2]}:{hhmmss[2:4]}:{hhmmss[4:6]}"
    return hhmmss


def build_frame(json_path, frame_rel):
    with open(json_path, encoding="utf-8") as f:
        d = json.load(f)
    price = d.get("price")
    try:
        price = float(price)
    except (TypeError, ValueError):
        price = None
    return {
        "ts": ts_label(json_path.stem),
        "capturedAt": d.get("capturedAt"),
        "price": price,
        "netExposure": d.get("netExposure"),
        "netExposureValue": parse_money(d.get("netExposure")),
        "expiries": d.get("expiries", []),
        "rows": d.get("rows", []),
        "frame": frame_rel,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=r"C:/Users/jalee/gex_snapshots",
                    help="Root of the gex_snapshots collection.")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent),
                    help="Site root to write data/ into (defaults to repo root).")
    ap.add_argument("--copy-frames", action="store_true",
                    help="Also copy the rendered PNG frames into the site.")
    args = ap.parse_args()

    source = Path(args.source)
    out = Path(args.out)
    data_out = out / "data"
    data_out.mkdir(parents=True, exist_ok=True)

    if not source.exists():
        raise SystemExit(f"Source not found: {source}")

    series_list = []
    for series_dir in sorted(p for p in source.iterdir() if p.is_dir()):
        if series_dir.name in IGNORE_DIRS:
            continue
        data_dir = series_dir / "data"
        if not data_dir.exists():
            continue

        slug = series_dir.name
        symbol = slug.split("_")[0]
        frames_root = series_dir / "frames"
        series_data_out = data_out / slug
        series_data_out.mkdir(parents=True, exist_ok=True)

        dates = []
        for date_dir in sorted(p for p in data_dir.iterdir() if p.is_dir()):
            date = date_dir.name
            json_files = sorted(date_dir.glob(f"{symbol}_{date}_*.json"))
            if not json_files:
                continue

            frames = []
            for jf in json_files:
                frame_rel = None
                png = frames_root / date / (jf.stem + ".png")
                if png.exists():
                    frame_rel = f"frames/{slug}/{date}/{png.name}"
                    if args.copy_frames:
                        dst = out / frame_rel
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(png, dst)
                frames.append(build_frame(jf, frame_rel))

            bundle_rel = f"data/{slug}/{date}.json"
            with open(out / bundle_rel, "w", encoding="utf-8") as f:
                json.dump({"slug": slug, "date": date, "frames": frames}, f)

            dates.append({"date": date, "frames": len(frames), "file": bundle_rel})
            print(f"  {slug} {date}: {len(frames)} frames")

        if dates:
            series_list.append({
                "slug": slug,
                "symbol": symbol,
                "title": title_from_slug(slug),
                "dates": dates,
            })

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "series": series_list,
    }
    with open(out / "data" / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    total = sum(len(s["dates"]) for s in series_list)
    print(f"\nWrote manifest: {len(series_list)} series, {total} day-bundles.")


if __name__ == "__main__":
    main()
