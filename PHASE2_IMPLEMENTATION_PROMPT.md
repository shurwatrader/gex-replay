# Phase 2 Implementation Prompt: Intraday Evolution Analytics & LLM Context Engine

## Your Role

You are an expert Quantitative Engineer and Systems Architect specializing in options analytics (GEX/OI), market microstructure, and TypeScript/Python systems. Your task is to implement Phase 2 of the **gex-replay** application: a comprehensive analytics layer that enriches intraday replay data with derived metrics, evolution statistics, and LLM-ready context payloads.

---

## Repository Context

**gex-replay** is a static web application that replays frame-by-frame snapshots of GEX (Gamma Exposure) and OI (Open Interest) heatmaps captured from a Quantum Terminal trading matrix.

### Data Pipeline

```
browser_extract.js
  ↓ (captures raw snapshots from DOM)
docs/browser_extract.js captures via window.__gexTick()
  ↓
collect.py
  ↓ (organizes snapshots, converts UTC→ET, rolls at 8 PM ET)
docs/collect.py moves/assigns trading day, triggers build
  ↓
build_manifest.py
  ↓ (bundles daily snapshots, generates index)
scripts/build_manifest.py creates data/SPY_GEXOI_700_800/YYYY-MM-DD.json + manifest.json
  ↓
Frontend Viewer & Worker
  ↓
app.js renders interactive replay
worker.js sends summarized payload to Gemini AI
```

### Current Architecture

- **Frontend**: `index.html` (UI shell) + `app.js` (replay logic) load per-day JSON bundles from `data/`
- **Data Schema**: `data/manifest.json` indexes available series/dates; each date loads a bundle like `data/SPY_GEXOI_700_800/2026-07-04.json`
- **LLM Worker**: `worker/worker.js` (Cloudflare Worker) proxies a static snapshot to Google Gemini for market analysis
- **Storage**: Generated bundles live in `data/<slug>/<date>.json`

---

## Current Data Schema (Existing Bundle Structure)

Each per-day bundle (e.g., `data/SPY_GEXOI_700_800/2026-07-04.json`) contains:

```javascript
{
  "slug": "SPY_GEXOI_700_800",
  "date": "2026-07-04",
  "frames": [
    {
      "ts": "22:35:37",                    // Time label (ET)
      "tradingDay": "2026-07-04",          // Trading session date
      "capturedAt": "2026-07-05T02:35:37Z", // UTC timestamp
      "price": 751.25,                     // Spot price
      "netExposureValue": -450000000,      // Parsed numeric net GEX
      "expiries": ["2026-07-10", "2026-07-17", ...],
      "rows": [
        {
          "strike": 800,
          "values": [
            {
              "text": "12.5M",                    // Displayed GEX value
              "color": "rgb(200, 50, 100)",      // Cell color (RGB overlay)
              "wallOI": "850K",                  // Wall OI value
              "wallPct": "45%",                  // Wall concentration pct
              "wallType": "call top volume",    // Wall descriptor (call/put)
              "oiKing": false,                  // Highest OI in row
              "volKing": true                   // Highest volume in row
            },
            // ... one value per expiry
          ]
        },
        // ... rows for all strikes (descending order: 800, 795, 790, ...)
      ]
    },
    // ... more frames chronologically
  ]
}
```

### Key Parsing Notes

- **Numeric Values**: GEX values are stored as strings with K/M/B suffixes (e.g., "12.5M" = 12,500,000). Use regex: `/-?[\d,]*\.?\d+[KMB]?/g` to extract.
- **Wall Type Normalization**: `wallType` contains strings like `"call top volume"` or `"put top volume"`. Normalize to simple `"call"` or `"put"`.
- **Strike Ordering**: Rows are sorted **descending** (highest strike first).
- **Expiry Ordering**: Chronological order by date.
- **Trading Day Roll**: Snapshots from 8:00 PM ET onward belong to the next calendar day's session (already handled by `collect.py`).

---

## Your Objective

Implement a modular analytics layer that enriches each daily bundle **without breaking the existing UI** by:

1. **Adding Frame-Level Derived Metrics** to each snapshot
2. **Computing Session-Level Evolution Statistics** across all frames
3. **Generating a Daily Summary** at the bundle root
4. **Wiring Dual-Mode LLM Context** (static vs. evolution modes) into `worker.js`
5. **Integrating into the Build Pipeline** (`build_manifest.py` enrichment step)

### Architectural Constraints

- ✅ **Preserve Existing JSON Shape**: Append new fields only; do not rewrite or restructure existing schema. The current UI must continue to work unchanged.
- ✅ **Do Not Invent Data**: If a value cannot be confidently derived from available fields, set it to `null` rather than guessing.
- ✅ **Modular Design**: Create reusable, standalone modules (suggested structure below) that can be used in both the build pipeline and worker context.
- ✅ **Lightweight**: No heavy frameworks; keep implementation performant for JSON enrichment and client-side loading.
- ✅ **Well-Documented**: Especially the gamma-flip interpolation methodology.

---

## Requirement 1: Frame-Level Derived Metrics

For every frame in the bundle, append a `derivedMetrics` object containing:

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `gammaFlip` | number \| null | Strike where net gamma transitions from positive to negative (zero-crossing level). Computed via linear interpolation. |
| `distanceToFlip` | number \| null | `price - gammaFlip`. Positive = price above flip; negative = below. |
| `regime` | "Positive" \| "Negative" \| null | Overall regime based on net GEX at this frame. Positive if netExposureValue > 0. |
| `callWall` | number \| null | Strike with highest call-side concentration or explicit `wallType === "call"`. |
| `putWall` | number \| null | Strike with highest put-side concentration or explicit `wallType === "put"`. |
| `oiKingStrike` | number \| null | Strike where `oiKing === true` appears. |
| `volKingStrike` | number \| null | Strike where `volKing === true` appears. |

### Gamma Flip Methodology

**Goal**: Find the strike where net gamma crosses zero (transitions from positive to negative or vice versa).

**Algorithm**:
1. **Parse Numeric GEX Values**: Extract numeric cell values from `values[].text` using regex to strip K/M/B suffixes.
2. **Sum Per-Strike Net Gamma**: For each strike row, sum net gamma across all expiries (averaged or weighted if needed).
3. **Detect Sign Change**: Iterate through strikes (descending order) and identify two consecutive strikes where gamma sign changes.
4. **Linear Interpolation**: If strikes `S_high` (positive) and `S_low` (negative) bracket the zero, interpolate:
   ```
   gammaFlip = S_high + (S_low - S_high) * (gamma_high / (gamma_high - gamma_low))
   ```
5. **Fallback**: If no sign change exists or data is too sparse, return `null`.

### Wall Strike Methodology

- **callWall**: Scan all rows for cells with `wallType.includes("call")` (after normalization) OR take the row with max call-side GEX concentration. Return strike or `null`.
- **putWall**: Scan all rows for cells with `wallType.includes("put")` (after normalization) OR take the row with max put-side GEX concentration. Return strike or `null`.

---

## Requirement 2: Session-Level Evolution Analytics

Process the **chronological sequence of frames** to compute structural evolution metrics:

### 2a. Migration Metrics

For each of the following price levels, track direction, velocity, and acceleration:
- `gammaFlip` (level computed in Requirement 1)
- `callWall` (strike computed above)
- `putWall` (strike computed above)
- `weightedGammaCenter` (weighted average strike of all gamma exposure)
- `weightedOICenter` (weighted average strike of all OI)
- `weightedVolumeCenter` (weighted average strike of all volume)

For each metric:
- **Direction**: "up" (increasing over session), "down" (decreasing), "flat" (minimal change)
- **Velocity**: Rate of change per frame or per minute (choose based on timestamp availability). Units: strikes/frame or strikes/minute.
- **Acceleration**: Second-order rate of change (change in velocity).

### 2b. Distribution Statistics

For each frame, compute strike-distribution statistics across the rows:
- **Concentration**: Herfindahl Index or similar (measure of dominance by few strikes)
- **Dispersion**: Variance or standard deviation of gamma/OI across strikes
- **Entropy**: Shannon entropy of normalized gamma/OI distribution
- **Skewness**: Distribution skew (gamma clustered above or below spot?)
- **Kurtosis**: Tail risk (sharp spikes or flat distribution?)

### 2c. Time-Series Features

Compute rolling/trending features:
- **Rolling Slope**: Linear regression slope of Δ Net Gamma over past N frames
- **Rolling Average**: N-frame moving average of key metrics (gammaFlip, net exposure)
- **Trend Persistence**: Flag indicating whether a metric is trending consistently (e.g., gammaFlip moving up for 5+ consecutive frames)

---

## Requirement 3: Daily Summary Engine

At the **final frame** of the session, compute and attach a `dailySummary` object **at the root of the bundle** (same level as `slug`, `date`, `frames`):

```javascript
{
  "slug": "SPY_GEXOI_700_800",
  "date": "2026-07-04",
  "dailySummary": {
    // Opening/closing values
    "openingNetGamma": -450000000,          // netExposureValue at first frame
    "closingNetGamma": -250000000,          // netExposureValue at last frame
    "openingGammaFlip": 745.50,             // gammaFlip at first frame
    "closingGammaFlip": 748.75,             // gammaFlip at last frame
    
    // Drift metrics
    "gammaFlipDrift": 3.25,                 // Absolute movement (750 - 746.75)
    "netGammaFlipDrift": -200000000,        // Net change in exposure (-250M - (-450M))
    
    // Peak boundaries
    "maxDistanceToFlip": 5.50,              // Max (price - gammaFlip) during session
    "minDistanceToFlip": -4.25,             // Min (price - gammaFlip) during session
    
    // Time-at-regime
    "timeAboveFlipPercent": 65.5,           // % of frames where price > gammaFlip
    "timeBelowFlipPercent": 34.5,           // % of frames where price < gammaFlip
    
    // Regime changes
    "totalRegimeChanges": 3,                // Count of times price crossed gammaFlip
    
    // Positioning summary
    "migrationScore": 0.72                  // Numeric summary: 0 (defensive) to 1 (bullish migration)
  },
  "frames": [ ... ]
}
```

### Field Definitions

- **openingNetGamma / closingNetGamma**: Net gamma exposure at start and end of session.
- **openingGammaFlip / closingGammaFlip**: Gamma flip level at start and end.
- **gammaFlipDrift**: Absolute change (closing - opening).
- **netGammaFlipDrift**: Change in net exposure (closing - opening).
- **maxDistanceToFlip / minDistanceToFlip**: Peak boundaries of (price - gammaFlip) throughout the session.
- **timeAboveFlipPercent / timeBelowFlipPercent**: Percentage of frames where price traded above/below the gamma flip level.
- **totalRegimeChanges**: Count of times the price crossed the gammaFlip level (regime flips).
- **migrationScore**: Numeric 0.0–1.0 summary:
  - 0.0 = Defensive (gamma moving lower, exposure becoming negative, price compressed)
  - 0.5 = Neutral/Choppy
  - 1.0 = Bullish migration (gamma moving higher, exposure becoming positive, price extended)

---

## Requirement 4: Dual-Mode LLM Context Engine

Modify `worker/worker.js` to support two input modes for Gemini analysis:

### Mode 1: Static Snapshot (Existing)
```javascript
{
  "mode": "static",
  "snapshot": {
    "price": 751.25,
    "netExposure": -450000000,
    "gammaFlip": 745.50,
    "callWall": 755,
    "putWall": 740,
    "regime": "Negative"
  }
}
```
**Purpose**: Quick next-day outlook based on current positioning.

### Mode 2: Evolution (New)
```javascript
{
  "mode": "evolution",
  "dailySummary": { ... },                    // Full dailySummary object from Requirement 3
  "derivedMetricsTimeSeries": [ ... ],        // Array of derivedMetrics from all frames
  "migrationMetrics": { ... },                // Migration metrics (velocity, acceleration, direction)
  "distributionStats": { ... },               // Distribution statistics summary
  "sessionLength": 390                        // Number of frames captured
}
```
**Purpose**: Deep session-wide dealer positioning analysis.

### Implementation Notes

- Share foundational code (e.g., parsing, normalization) between modes.
- Avoid duplicating gamma-flip logic or numeric extraction.
- The worker should accept both payloads and format them appropriately for Gemini.
- Maintain backward compatibility with Mode 1.

---

## Requirement 5: UI Viewer Enhancements (Optional)

The existing `app.js` heatmap viewer is excellent. Consider enhancing it with gamma flip visualization:

**Suggested enhancements** (use your visual judgment—implement only if they improve clarity):

1. **Gamma Flip Symbol**: Display a symbol (e.g., `Γ`, `↕`, or custom icon) marking the gamma flip strike on the heatmap. Place it prominently in the row corresponding to the computed `gammaFlip` level.
2. **Distance to Flip Label**: Show the distance in strikes next to the spot price chip (e.g., `Price: 751.25 | +5.5Δ` where Δ represents distance in strikes).
3. **Optional Concentration Indicator**: A small badge or gauge in the header showing concentration level (high = gamma clustered, low = dispersed). Useful for structural risk at a glance.

**Design Philosophy**: You know the viewer. These are suggestions, not requirements. If they clutter the interface or don't add clarity, skip them. The enriched JSON data (`derivedMetrics`, `dailySummary`) is always available for future UI iterations, so no visual feature is required to pass acceptance.

---

## Language & Architecture Flexibility

**Choose the language and approach that is most efficient for this implementation.** The codebase contains both Python (`build_manifest.py`, `collect.py`) and JavaScript (`app.js`, `worker.js`), so consider:

- **Python approach**: Create analytics modules in `analytics/` directory that integrate directly into the Python build pipeline. Easier if enrichment happens at build-time only.
- **JavaScript/TypeScript approach**: Create analytics modules in `analytics/` directory for use in both `worker.js` and build pipeline (called via Node.js subprocess or imported logic).
- **Hybrid approach**: Split analytics between Python (for build-time enrichment) and JavaScript (for worker context formatting), sharing common logic where practical.

**You decide** what makes sense given the requirements. The prompt suggestions below use function/method names; translate to your chosen language naturally.

---

## Suggested Module Structure

Create the following modules in an `analytics/` directory (Python, JavaScript, TypeScript, or hybrid—your choice):

### 1. Types & Interfaces Module
Define or document all types needed:
- `CellValue`, `StrikeRow`, `FrameSnapshot` (existing schema types)
- `DerivedMetrics`, `MigrationMetrics`, `DistributionStats`, `RollingFeature`
- `SessionEvolution`, `DailySummary`

### 2. Core Gamma-Flip & Frame Enrichment Module
Core parsing and frame enrichment logic:
- `parseNumericCellValue(text)` — Extract numeric value from "12.5M" format
- `normalizeWallType(wallType)` — Normalize "call top volume" → "call"
- `computeGammaFlip(frame)` — Compute gamma flip via interpolation
- `computeWallStrike(frame, wallKind)` — Find wall strike
- `findKingStrike(frame, kingKind)` — Find king strike
- `enrichFrameWithDerivedMetrics(frame)` — Add derivedMetrics to frame

### 3. Distribution Statistics Module
Distribution analysis functions:
- `computeConcentration(values)` — Herfindahl or similar
- `computeDispersion(values)` — Variance / std dev
- `computeEntropy(values)` — Shannon entropy
- `computeSkewness(values)` — Skewness
- `computeKurtosis(values)` — Kurtosis

### 4. Migration & Evolution Tracking Module
Session-wide evolution analysis:
- `trackMigrationMetrics(frames)` — Analyze all frames for movement patterns
- `computeVelocity(positions)` — Rate of change per frame/minute
- `computeAcceleration(velocities)` — Second-order rate
- `computeRollingSlope(values, windowSize)` — Rolling regression
- `computeRollingAverage(values, windowSize)` — Moving average
- `detectTrendPersistence(values, threshold)` — Trend flag

### 5. LLM Context Formatting Module
Payload preparation for Gemini:
- `formatMode1Context(snapshot)` — Static payload
- `formatMode2Context(bundle)` — Evolution payload
- `computeMigrationScore(dailySummary)` — Positioning summary

---

## Implementation Plan (7 Steps)

### Step 1: Create TypeScript Types Module
- **File**: `analytics/types.ts`
- **Task**: Define all interfaces (DerivedMetrics, SessionEvolution, DailySummary, etc.)
- **Acceptance**: TypeScript compiles; all required types present

### Step 2: Implement Gamma-Flip Logic
- **File**: `analytics/gammaFlip.ts`
- **Task**: Implement parseNumericCellValue(), normalizeWallType(), computeGammaFlip(), computeWallStrike(), findKingStrike(), enrichFrameWithDerivedMetrics()
- **Acceptance**: Gamma flip correctly computed on sample data; fallback to null when no sign change

### Step 3: Implement Distribution Statistics
- **File**: `analytics/distribution.ts`
- **Task**: Implement concentration, dispersion, entropy, skewness, kurtosis
- **Acceptance**: All functions return valid numeric values; handle edge cases (empty arrays, single values)

### Step 4: Implement Migration Tracking
- **File**: `analytics/migration.ts`
- **Task**: Implement trackMigrationMetrics(), velocity/acceleration computations, rolling features
- **Acceptance**: Metrics computed across full frame sequence; direction/velocity/acceleration all populated

### Step 5: Implement Daily Summary Engine
- **Inline in Step 4 or separate**: Compute openingNetGamma, closingNetGamma, drift, time-at-regime, regime changes, migrationScore
- **Acceptance**: dailySummary object present at bundle root; all fields populated

### Step 6: Implement LLM Context Formatting
- **File**: `analytics/llmContext.ts`
- **Task**: formatMode1Context(), formatMode2Context(), computeMigrationScore()
- **Acceptance**: Both payloads structurally sound; ready for worker.js integration

### Step 7: Integrate into Build Pipeline & Worker
- **Tasks**:
  - Modify `scripts/build_manifest.py` to call enrichment step (or create `build_analytics.py`)
  - Update `worker/worker.js` to accept and route Mode 1 / Mode 2 payloads
- **Acceptance**: Existing replay UI loads unchanged; new analytics fields present in bundles; worker accepts both payload types

---

## Acceptance Criteria

✅ **The existing `app.js` replay viewer loads and renders without errors.** New fields must not break the current UI.

✅ **Generated bundles contain `derivedMetrics` for each frame.** Verify by inspecting `data/SPY_GEXOI_700_800/2026-07-04.json`.

✅ **Bundles contain `dailySummary` at the root level.** All fields (openingNetGamma, closingNetGamma, etc.) populated.

✅ **Analytics pipeline runs successfully on existing sample data** without throwing errors.

✅ **Worker accepts both Mode 1 (static) and Mode 2 (evolution) payloads** and structures them correctly for Gemini.

✅ **Code is well-documented**, especially the gamma-flip interpolation methodology.

---

## Implementation Notes

- **Language Flexibility**: Choose Python, JavaScript/TypeScript, or a hybrid approach. Prioritize what integrates most naturally with the existing build pipeline and worker logic.
- **Clarity Over Performance**: Prioritize readable, well-commented code over micro-optimizations.
- **Error Handling**: Return null for ambiguous/missing data rather than throwing or inventing values.
- **Testing**: Validate each module against existing sample data (data/SPY_GEXOI_700_800/2026-07-04.json) before integrating into the build pipeline or worker.
- **Documentation**: Especially clarify the gamma-flip interpolation methodology and any edge-case handling.

---

## What to Do Now

**Please provide a detailed planning message** that covers:

1. **Your understanding** of the requirements and data schema
2. **The logical sequence** you'll follow to implement each module
3. **Key dependencies** between modules and decision points
4. **Potential challenges** (e.g., interpolation edge cases, null handling)
5. **Your validation strategy** to ensure each component works before moving to the next
6. **Any clarifications** you need before beginning
