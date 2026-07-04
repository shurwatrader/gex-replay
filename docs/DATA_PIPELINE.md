# How the data is scraped & published

This site is just a viewer. The heatmap data comes from a four-stage pipeline
that runs on the capture machine. This folder documents that pipeline and keeps
**reference copies** of the two capture scripts ([`browser_extract.js`](browser_extract.js),
[`collect.py`](collect.py)) so the whole flow is reproducible.

> The canonical copies live on the capture host at
> `…/gex_snapshots/scripts/`. The copies here are for reference — if you change
> the pipeline, update both.

```
 ┌──────────────────────┐   ┌───────────────┐   ┌───────────────────┐   ┌──────────┐
 │ 1. browser_extract.js│──▶│ 2. collect.py │──▶│3. build_manifest.py│──▶│ 4. app.js│
 │   (in the browser)   │   │  (ET buckets) │   │  (site bundles)   │   │ (viewer) │
 └──────────────────────┘   └───────────────┘   └───────────────────┘   └──────────┘
   gex_snapshot.json          data/<day>/*.json     data/**/<day>.json     the replay
   (Downloads)                                       + manifest.json
```

## 1. Scrape — `browser_extract.js`

There is **no API**. The data is read straight from the [Quantum Terminal](https://app.quantumterminal.io)
GEX matrix DOM by a script injected into the open terminal tab. It installs one
function, `window.__gexTick()`, which per call:

1. Clicks the "king strike" (ATM) button to center the matrix.
2. Reads the matrix table at three scroll positions (top / middle / bottom) via
   direct `scrollTop` manipulation — no screenshots, no mouse-wheel simulation.
3. Merges the three reads and filters to the configured strike range (700–800).
4. Triggers a browser download of `gex_snapshot.json`.

**Live re-render guard.** The terminal streams updates, so during a re-render
the `<thead>` can gain an expiry column a beat before the body cells for it
populate. Reading in that gap would silently drop the newest expiration. The
extractor tracks header/body **alignment** and retries until every row's cell
count matches the header, then does a final completeness check before
downloading — so a snapshot is never published with a missing column. This is
also what makes "pull all visible expirations on load" reliable.

### Per-cell selectors (coupled to the terminal's markup)

| Field       | Source in the DOM |
|-------------|-------------------|
| `text`      | `div.font-mono.tabular-nums` — the clean GEX value (e.g. `-560.16M`) |
| `color`     | the cell overlay's `background-color` (unused by the viewer; it recolors by value) |
| `wallOI` / `wallPct` | the two `<span>`s inside `span.rounded-full` — the top-volume badge |
| `wallType`  | that badge's `title` attribute — `"call top volume"` / `"put top volume"` |
| `oiKing` / `volKing` | `svg.lucide-star` color: green channel dominant → OI king, red → Vol king |

### Snapshot JSON shape

```jsonc
{
  "expiries": ["07-06-2026", "07-07-2026", "07-08-2026", "07-09-2026", "07-10-2026"],
  "rows": [
    { "strike": 750,
      "values": [
        { "text": "159.28M", "color": "rgb(...)",
          "wallOI": "126K", "wallPct": "0.00%", "wallType": "call top volume",
          "oiKing": false, "volKing": true },
        // …one entry per expiry, in header order
      ] }
    // …one row per strike, high → low
  ],
  "capturedAt": "2026-07-03T21:54:06.409Z",   // UTC ISO — the single source of truth for time
  "netExposure": "-$5.05B",
  "price": "744.50"
}
```

## 2. Bucket — `collect.py`

Runs after each capture. It moves `gex_snapshot.json` out of Downloads into a
date-partitioned folder and then mirrors/publishes the site.

**Everything is Eastern Time.** `capturedAt` is UTC; `collect.py` converts to ET
and assigns a **trading day** on a rolling 24h cycle that rolls at **8:00 PM ET**:

- Snapshots from **8:00 PM ET onward** belong to the **next** calendar day's
  trading day (the overnight/futures session leads into it).
- Example: a snapshot at Sunday 8:00 PM ET is filed under **Monday's** trading day.

Files land at `gex_snapshots/<series>/data/<trading-day>/SPY_<trading-day>_<HHMMSS ET>.json`.
Because the ET `HHMMSS` wraps past midnight inside one trading day, chronological
order is **not** filename order — it is restored downstream by sorting on
`capturedAt`.

`collect.py` then runs stage 3 and, at most once per hour, commits and pushes the
repo so GitHub Pages redeploys (a throttle that stays under Pages' build limit).

## 3. Bundle — `scripts/build_manifest.py`

Scans `gex_snapshots`, and for each `(series, trading-day)`:

- Bundles that day's snapshots into `data/<series>/<trading-day>.json`, sorted by
  `capturedAt`, stamping each frame with its `tradingDay` and a compact `ts`.
- Writes `data/manifest.json` listing every series and the trading days available.

The viewer only ever reads `data/manifest.json` and the per-day bundles.

## 4. View — `index.html` + `app.js`

Loads the manifest, then rebuilds the heatmap **live from the JSON**:

- Colors each cell by value on a signed square-root diverging scale (purple =
  negative, teal→green→yellow = positive), anchored to each frame's own min/max.
- Derives Call/Put walls (largest positive / most-negative total GEX across
  expiries), renders the OI/Vol king stars, and the per-frame movers (biggest
  change vs the previous frame) as green ▲ / red ▼ delta chips.
- Shows **Trading Day** and the exact **Snapshot (ET)** time side by side, so
  overnight data is unambiguous (e.g. Trading Day 7/6 · Snapshot 7/5 8:00 PM ET).

## Reproducing the capture loop

1. Open the Quantum Terminal on **SPY**, **GEX OI** view.
2. Inject [`browser_extract.js`](browser_extract.js) into that tab once
   (installs `window.__gexTick`).
3. Call `await window.__gexTick()` to capture (it downloads `gex_snapshot.json`).
4. Run `python collect.py` to file it and publish.
5. Repeat on whatever cadence you want (the working setup ticks every 2 minutes).

Requirements: Python 3.9+ with `tzdata` installed (`pip install tzdata` — Windows
Python ships no IANA time zone database, which the ET logic needs).

## Not captured yet: per-strike flow detail (possible future enhancement)

The Matrix cells we scrape carry only the single aggregate value (GEX / OI /
Volume). The terminal *does* hold much richer **per-strike flow detail**, but it
isn't part of the scraped payload today. Documenting it here in case it's worth
capturing later.

**What's available.** Clicking any matrix cell opens a **"STRIKE DETAIL"** popup
(e.g. `SPY $745 · 07-06`) with, for that strike + expiry:

- Today's flow **volume** and **call % / put %** split
- **Call volume** / **put volume**
- **Total premium** (single figure — *not* split call vs put) + average price
- Open interest (total / call / put), **% of OI traded**
- Implied vol (call IV / put IV)
- Net **GEX (OI)**, **GEX (Vol)**, and **VEX** — each with a dollar **call / put
  split** (e.g. Net GEX-Vol `+1.72B · call +3.96B / put −2.24B`)

**How it loads.** The popup is *not* fetched on click — the cell's handler is a
pure state update (`D({strike, exp, rect})`). The data is already in memory,
having been loaded from the terminal's private JSON API
(`/api/v1/gex-all/SPY?expiries=5`, `/api/v1/matrix/SPY?version=2`, …).

**Why "natural" (no-click) scraping is non-trivial.** The flow fields are **not**
in the visible matrix DOM — they're only written into the DOM when the popup
opens. So getting them without a click requires one of:

1. **Click each target cell**, read the popup, close it — DOM-only, no auth, but
   one click per strike (≈5 for all 745 expiries).
2. **Read the app's in-memory React state** — no click, but brittle (breaks on
   any terminal front-end update).
3. **Call the private API directly** (`/api/v1/gex-all/SPY`) — returns every
   strike/expiry's flow in one shot, no clicks or DOM. Requires the app's
   **Bearer auth token**, so it means handling session credentials.

**What it can't do.** There's no individual transaction tape (no per-trade
timestamps or "bought-at-ask" flags), and premium isn't split call-vs-put — so an
exact per-trade premium analysis isn't possible from this source. The usable
directional-disparity signals are the **call/put volume split** and the
dollar-denominated **Net GEX (Vol) call/put split**.
