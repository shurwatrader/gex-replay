# GEX Replay

Interactive, frame-by-frame replay of **GEX (gamma-exposure) heatmap snapshots**
from the Quantum Terminal, rebuilt live in the browser from captured JSON.

**Live:** https://shurwatrader.github.io/gex-replay/

Hosted on GitHub Pages — no build tooling, just static files (`index.html`,
`app.js`, `styles.css`) reading JSON out of `data/`.

## What it shows

- A strike × expiration heatmap for each 2-minute snapshot, colored by value on
  a diverging scale (purple = negative GEX, teal → green → yellow = positive),
  anchored to each frame's own min/max.
- **Movers** — the biggest changes vs the previous frame, ringed and labeled with
  a green ▲ / red ▼ delta chip.
- **Walls** — derived Call/Put wall rows, badged in the gutter (CW/PW on mobile)
  with a dashed line (below the call wall, above the put wall).
- **King stars** — green ★ for the GEX-OI king cell, red ★ for the Vol king.
- **Spot** — a cyan chip marks the strike nearest the underlying price.
- **Trading Day + Snapshot (ET)** shown together, so overnight data is
  unambiguous (Trading Day 7/6 · Snapshot 7/5 8:00 PM ET).

## Controls

- **Space** — play / pause · **← / →** — step · **Home / End** — first / last
- **Date picker** — pick a trading day, or a range to play multiple days as one timeline
- **Step** — time-step per jump: 2m (+1 frame) · 10m (+5) · 30m (+15) · 1h (+30)
- **Speed** — 0.5× (default) up to 2×
- **Movers** — toggle the change highlights
- Scrubber — drag to any frame

Desktop uses fixed-size cells (no judder as values change); mobile lets columns
size to content and scroll so nothing overlaps.

## Where the data comes from

There's no API — every snapshot is scraped from the terminal's DOM, bucketed by
**Eastern-Time trading day** (rolling at 8 PM ET), bundled, and published.

**See [`docs/DATA_PIPELINE.md`](docs/DATA_PIPELINE.md)** for the full flow, the
snapshot JSON schema, and reference copies of the two capture scripts
(`browser_extract.js`, `collect.py`).

## Publishing new snapshots

In normal use the capture script runs the build and pushes automatically. To do
it by hand from the repo root:

```bash
python scripts/build_manifest.py            # rebuild data/ + manifest.json
git add -A && git commit -m "Update snapshots"
git push                                     # GitHub Pages redeploys
```

`build_manifest.py` reads from `…/gex_snapshots` by default; override with
`--source <path>`.

## Running locally

Browsers block `fetch()` from `file://`, so serve the folder over http:

```bash
python -m http.server 8000
# open http://localhost:8000
```
