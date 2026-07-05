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
- **Walls** — derived Call/Put wall rows, badged **CW / PW** in the gutter (full
  name on hover) with a dashed line (below the call wall, above the put wall).
- **King stars** — green ★ for the GEX-OI king cell, red ★ for the Vol king.
- **Spot** — a cyan chip marks the strike nearest the underlying price.
- **GEX0 (Γ · beta)** — a purple **Γ** badge marks the strike nearest the net-GEX
  zero level across all expiries; the exact (fractional) value + distance-to-price
  shows in the header chip. It's an *approximation over the visible board — not a
  true gamma flip* — and only appears when there's a clean crossing.
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

## AI analysis — the two buttons

Both buttons send a **code-computed structural summary** of the selected window
(never raw frames) to a Cloudflare Worker, which prepends a rubric, calls **Google
Gemini `gemini-2.5-flash`**, and returns a markdown read. All scoring math lives in
`scoring.js`, shared verbatim between the app and the offline backtest so what ships
is what's validated.

- **🧠 Analyze (squeeze — stable).** Ranks negative-GEX nodes as squeeze
  candidates using *relative*, session-normalized strength (magnitude vs the
  session's deepest node, trajectory, acceleration, window-relative freshness,
  positive→negative flips, %-OTM). Returns a bull / bear / conviction read. Nothing
  uses absolute dollar thresholds, so it generalizes across tickers.
- **📈 Evolution (session migration — experimental / unvalidated).** A fully
  separate path (`buildEvolution`, never touches the squeeze scorer). Tracks how
  dealer structure *migrated* across the session — wall/gamma-center/GEX0 direction,
  velocity, acceleration — plus a documented `migrationScore` (0–1) and the GEX0
  proxy. **Marked untested in the UI**; pending validation against live intraday
  data. See [`PHASE2_PLAN.md`](PHASE2_PLAN.md) for the methodology.

Setup (API key, secrets, one-time URL/token) is in
[`worker/README.md`](worker/README.md). Changing a rubric or the model requires a
`wrangler deploy` — the Worker is deployed separately from the static site.

## Validation — the backtest

`scoring.js` is exercised headless by a Node harness — no browser, no network:

```bash
node scripts/backtest.js                       # runs against data/manifest.json
node scripts/backtest.js data/<slug>/<date>.json   # or a specific bundle
```

It (1) independently re-derives the key fields from raw JSON and asserts the module
agrees (non-circular), (2) checks scale-robustness (relative floor vs the old
absolute one), (3) shows old-vs-new ranking, and (4) exercises every dynamic signal
— squeeze *and* evolution — on injected synthetic patterns, since the frozen sample
data can't. A run prints `RESULT: N checks passed`.

## Series / tickers

The **Series** dropdown selects which ticker/board to replay (SPY today; more being
added). Each series is a folder under `data/<slug>/` indexed by `data/manifest.json`.

## Where the data comes from

High level: there's **no API**. Every ~2 minutes a snapshot is scraped directly
from the Quantum Terminal's DOM, bucketed by **Eastern-Time trading day**,
bundled into `data/`, and published to GitHub Pages. The viewer rebuilds the
heatmap live from that JSON.

**For the full detail** — the scraper, the exact DOM selectors, the snapshot JSON
schema, and reference copies of the capture scripts — see
**[`docs/DATA_PIPELINE.md`](docs/DATA_PIPELINE.md)**. That doc also notes a
possible future enhancement: capturing the terminal's richer **per-strike flow
detail** (call/put volume, premium, IV, GEX/VEX splits) that today only surfaces
in a click-to-open popup.

### How a trading day is counted

Everything is in **Eastern Time (ET)**, and a "trading day" is **not** a midnight
calendar day. It runs on a rolling 24-hour cycle that **rolls at 8:00 PM ET** —
the moment the overnight/futures session begins — so a full session's data
(overnight through the next afternoon) is grouped together:

> **A trading day covers 8:00 PM ET the evening before → 7:59 PM ET that day.**
> Any snapshot taken at **8:00 PM ET or later is counted as the _next_ day.**

**Example — Monday 7/6's data set:**

| Snapshot taken at (ET)     | Trading Day |
|----------------------------|-------------|
| Sunday **7/5, 8:00 PM**    | **7/6** ← session opens; counts as Monday |
| Sunday 7/5, 11:30 PM       | 7/6         |
| Monday 7/6, 9:30 AM (open) | 7/6         |
| Monday 7/6, 3:00 PM        | 7/6         |
| Monday **7/6, 8:00 PM**    | **7/7** ← next session begins            |

Because a single trading day spans two calendar dates, the UI always shows the
two together so overnight data is never ambiguous:

- **Trading Day:** 7/6
- **Snapshot (ET):** 7/5, 8:00 PM

The **date picker filters by trading day**, and snapshots inside a day are ordered
by true capture time (not by clock time, which wraps past midnight within the day).

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

NFA