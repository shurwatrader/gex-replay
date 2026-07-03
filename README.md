# GEX Replay

Interactive, frame-by-frame replay of GEX (gamma-exposure) heatmap snapshots,
rebuilt live in the browser from the captured JSON. Play / pause, scrub, step
frame-by-frame, change speed, and highlight the biggest movers between frames.

Hosted on GitHub Pages — no build tooling, just static files.

## How it works

- `scripts/build_manifest.py` scans your local `gex_snapshots` collection,
  bundles each day's JSON snapshots into `data/<series>/<date>.json`, and writes
  `data/manifest.json` describing what's available.
- `index.html` + `app.js` load the manifest, then rebuild the heatmap grid from
  each snapshot's per-cell `text` + `color`. The colors come straight from the
  captured data, so the replay matches the source terminal.

## Publishing new snapshots

```bash
# from the repo root
python scripts/build_manifest.py            # rebuild data/ + manifest.json
git add -A && git commit -m "Update snapshots"
git push
```

By default the build reads from `C:/Users/username/gex_snapshots`; override with
`--source <path>`. Note: in normal use `collect.py` runs this automatically
after each capture, so you rarely run it by hand.

## Running locally

Browsers block `fetch()` from `file://`, so serve the folder over http:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## Controls

- **Space** — play / pause
- **← / →** — previous / next frame
- **Home / End** — first / last frame
- Scrubber, speed selector, and a Movers toggle (yellow outline on the cells
  that changed most since the previous frame).
