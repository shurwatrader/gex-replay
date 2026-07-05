# Phase 2 — Intraday Evolution Analytics: Implementation Plan

**Status:** planned, not built. Build against synthetic frames now; validate on the
first live moving-price session (expected next trading day).

This plan supersedes the un-scoped `PHASE2_IMPLEMENTATION_PROMPT.md` where they
conflict. It is grounded in what the real bundle actually contains (verified
against `data/SPY_GEXOI_700_800/2026-07-04.json`), not the prompt's assumed schema.

---

## 0. Decisions locked (from review)

| Question | Decision | Why |
|---|---|---|
| Language / build | **Extend `scoring.js` (plain UMD JS).** No TypeScript, no Python reimpl. | Zero-build static repo; `scoring.js` already runs in browser + Node. TS adds a toolchain that doesn't exist; a Python copy of the gamma/parse logic guarantees drift. |
| Where metrics compute | **Runtime, on demand, over loaded frames.** Nothing baked into bundle JSON. | Matches the existing Analyze path; no ~3× bundle bloat; single source of truth. Baking is a future option (Node step importing `scoring.js`) only if an external consumer ever needs it. |
| Gamma flip | **`gexZeroProxy`** — documented approximation, null when ambiguous. Never call it "the gamma flip." | Per-strike GEX oscillates (7 sign changes near spot on real data); visible board is a subset (Σcells −0.18B vs field −5.05B). A confident single "flip" would be wrong. |
| `migrationScore` | **Explicit documented formula** (below), tunable, calibrated on live data. | An undefined 0–1 composite is the "arbitrary multiplier" problem Phase 1 removed. |
| Scope | **Trimmed core.** Cut Shannon entropy, skewness, kurtosis, dual-mode worker until justified. | Signed GEX breaks entropy/Herfindahl without a transform; those stats would be plausible-looking noise. |
| Validation | Synthetic unit tests now (extend `scripts/backtest.js`); live checklist tomorrow. | The only real data is a frozen holiday capture — cannot validate evolution on it. |

---

## 1. Data reality (verified, not assumed)

- `price` and `netExposureValue` are **frozen** in the only bundle (holiday). Every
  evolution metric is degenerate on it — expected, not a bug.
- Scale is per-ticker and large: `netExposureValue` = **−5.05B** here (prompt example
  said −450M). Keep everything **relative**, as in Phase 1.
- Walls/kings **are populated**: `wallType` ∈ {"call top volume","put top volume"}
  (215 non-null across 43 frames), exactly one `oiKing` and one `volKing` per frame.
  → `callWall`/`putWall`/`oiKingStrike`/`volKingStrike` are derivable **today**.
- Per-strike net GEX near spot oscillates hard (+391M @750, −600M @745, +32M @744,
  −180M @742). There is **no single clean sign change** → gamma flip must be a proxy.
- Visible cells reconcile to −0.18B vs the terminal's −5.05B ⇒ we see a **subset** of
  the board. Any zero-crossing is over the visible window only; document that.

---

## 2. Compute model (answers "runtime vs all data")

```
app.js loads day/window  ──▶ state.frames
        │
   [hit Analyze]                (or app boot, if we surface metrics in UI later)
        ▼
scoring.js  buildAnalysisSummary(frames)
        ├─ buildNodes(frames)                 ← Phase 1 (unchanged)
        ├─ frames.map(buildFrameMetrics)       ← NEW: frame-local, per loaded frame
        └─ buildSessionEvolution(frames)       ← NEW: over the LOADED window
                 ├─ migration (walls, centers, proxy: dir/velocity/accel)
                 ├─ concentration series (Herfindahl on |GEX|)
                 ├─ rolling slope / persistence
                 └─ dailySummary (opening/closing, drifts, time-at-regime, score)
        ▼
worker.js  ← receives summary (Phase-1 nodes + evolution block), downsampled
```

Nothing is precomputed "against ALL data." Everything is computed over the frames
currently loaded, at prompt time. Tomorrow's live bundle flows through the same path.

---

## 3. Module design

Extend `scoring.js` (single file, single source of truth). New pure functions:

**Frame-local (`buildFrameMetrics(frame)` → `derivedMetrics`)**
- `parseNumericCellValue` — reuse existing `parseCellValue` (already in module).
- `normalizeWallType(s)` — `"call top volume"` → `"call"`, `"put top volume"` → `"put"`.
- `callWall(frame)` / `putWall(frame)` — strike of the cell whose normalized
  `wallType` is call/put with the max `wallPct` (tie-break max |GEX|). null if none.
- `oiKingStrike(frame)` / `volKingStrike(frame)` — strike where `oiKing`/`volKing` true.
- `regime(frame)` — `"Positive" | "Negative"` from sign of `netExposureValue`; null if missing.
- `gammaCenter(frame)` — |GEX|-weighted mean strike (Σ strike·|gex| / Σ|gex|). Always defined.
- `gexZeroProxy(frame)` + `distanceToProxy` — see §4. null when ambiguous.

**Session (`buildSessionEvolution(frames)` → evolution block + `dailySummary`)**
- `migration(series)` for each of {callWall, putWall, gammaCenter, gexZeroProxy}:
  - `direction` "up"/"down"/"flat" (flat = |net move| < 1 strike or < ε),
  - `velocity` = strikes per **minute** (use `capturedAt`; fall back to per-frame),
  - `acceleration` = Δvelocity over the window.
- `concentration(frame)` — Herfindahl on **|GEX|** shares: Σ(|gex_i| / Σ|gex|)². Report
  opening/closing/trend. (Documented as *magnitude* concentration — |GEX|, not signed.)
- `callPutMassSplit(frame)` — Σ positive GEX vs Σ negative GEX, as a ratio. Replaces
  the entropy/skew/kurtosis grab-bag with one interpretable signed-structure number.
- `rollingSlope(values, N)` / `trendPersistence(values, N)` on netExposureValue and
  gammaCenter (linear-regression slope; persistence = k consecutive same-sign steps).
- `dailySummary` (over loaded window; see §5).

**No new files.** `scripts/backtest.js` gains a Phase-2 synthetic section.

---

## 4. `gexZeroProxy` methodology (the honest version)

Goal: a *stable, documented* approximation of the GEX zero level over the visible
board — **not** the classical gamma flip.

1. Build per-strike net GEX = Σ over expiries (reuse parse).
2. Sort ascending by strike; form the **cumulative** profile from the low end up.
3. Smooth with a small centered moving average (window 3) to damp per-strike noise.
4. Find zero-crossings of the smoothed cumulative profile.
   - **0 crossings** → `null`.
   - **1 crossing** → linear-interpolate the strike, return it.
   - **>1 crossing** → pick the crossing **nearest spot**; if two are within ε of
     spot, return `null` (ambiguous — better no number than a wrong one).
5. `distanceToProxy = price − gexZeroProxy` (null-safe).

Documented caveat in code + payload: *approximation over the captured strike window
only; the visible board is a subset of the full chain.* The LLM rubric must call it a
"GEX zero proxy," never a gamma flip, and treat `null` as "no clean level."

**Tomorrow's live test:** does `gexZeroProxy` move smoothly frame-to-frame, or jump
randomly? Smooth+meaningful → keep. Jumpy → demote to null-heavy or drop. Decide on
evidence, not vibes.

---

## 5. `dailySummary` + `migrationScore` formula

Fields (over the loaded window): `openingNetGamma`, `closingNetGamma`,
`netGammaDrift`, `openingProxy`, `closingProxy`, `proxyDrift`, `maxDistanceToProxy`,
`minDistanceToProxy`, `timeAboveProxyPct`, `timeBelowProxyPct`, `proxyCrossings`
(count of price crossing the proxy), `migrationScore`.

**`migrationScore` ∈ [0,1], 0.5 = neutral.** Blend of three bounded, *relative*
components (weights tunable, to be calibrated on live data):

```
squash(x) = tanh(x)                      // → [-1, 1]
netComp    = squash( netGammaDrift / max(|openingNetGamma|, ε) )   // exposure less negative = bullish
centerComp = squash( (closeGammaCenter - openGammaCenter) / spotStrikeStep )  // center up = bullish
proxyComp  = squash( proxyDrift / spotStrikeStep )                 // proxy up = bullish
raw = 0.4*netComp + 0.35*centerComp + 0.25*proxyComp               // → [-1, 1]
migrationScore = (raw + 1) / 2                                     // → [0, 1]
```

Every input is unit-normalized and relative, so it generalizes across tickers/scale.
`null` proxy → drop `proxyComp` and renormalize the remaining weights. Documented in
`scoring.js` beside the Phase-1 boost table.

---

## 6. Worker / LLM integration

- **No separate "Mode 2."** The Phase-1 summary gains an `evolution` block
  (`dailySummary` + downsampled migration/concentration series + `sessionLength`).
  One payload shape, backward compatible; the rubric gets a short "how to read
  evolution" section (mirrors the Phase-1 field guide).
- **Downsample, don't dump.** Never send `derivedMetrics` for all frames. Send
  `dailySummary` + a `downsample(series, 8)` of the key tracks. Keeps token cost flat
  regardless of session length (a full RTH day ≈ 195 frames).
- Keep `scoring.js`'s `RUBRIC` and the byte-identical `worker/worker.js` copy in sync.

---

## 7. Validation

**Now (synthetic, in `scripts/backtest.js`):**
- Inject frames with a known walking `gexZeroProxy` (linear ramp) → assert `direction`,
  `velocity` sign, `acceleration` ≈ 0; ramp with curvature → assert accel sign.
- Inject a clean single cumulative crossing → assert interpolated proxy within ε;
  inject a multi-crossing mess → assert `null`.
- Inject net-gamma drift + center drift → assert `migrationScore` > / < 0.5 correctly;
  assert bounds [0,1].
- Concentration: one dominant strike → Herfindahl ≈ 1; uniform → ≈ 1/n.
- Re-run Phase-1 checks (must stay green).

**Tomorrow (live session):**
- Point `backtest.js` at the real bundle: `node scripts/backtest.js data/<slug>/<date>.json`.
- Eyeball: is `gexZeroProxy` stable across frames? Does `gammaCenter` migrate with price?
  Does `migrationScore` match the day's discretionary read?
- Load in the browser; confirm Phase-1 UI unchanged (acceptance criterion).

---

## 8. Cut list (deferred, with reason)

- **Shannon entropy / skewness / kurtosis** — require non-negative weights or a
  precise transform GEX doesn't provide as-is; would be noise. Revisit only with a
  concrete question they answer.
- **Baked-into-JSON enrichment / Python analytics** — drift risk + bloat, no consumer.
- **Dual-mode worker** — collapsed into one evolution-aware payload.
- **UI gamma-flip glyph / distance chip** — optional; revisit after `gexZeroProxy`
  proves useful on live data.

---

## 9. Build order (when we execute)

1. `scoring.js`: `normalizeWallType`, `buildFrameMetrics` (walls/kings/regime/center). 
2. `scoring.js`: `gexZeroProxy` (+ synthetic tests).
3. `scoring.js`: `buildSessionEvolution` (migration/concentration/rolling) + `dailySummary` + `migrationScore` (+ synthetic tests).
4. Wire `evolution` block into `buildAnalysisSummary`; downsample.
5. Update `RUBRIC` (both copies) with the evolution field guide.
6. Green synthetic backtest → commit.
7. Next live session: validate, tune weights, decide `gexZeroProxy`'s fate.
```
```

*Open items needing your input before build:* (a) confirm strike step for SPY is 1.0
(affects velocity/score normalization — data shows 0.5 strikes too, e.g. 752.5/747.5);
(b) whether `callWall`/`putWall` should be single strikes (current plan) or per-expiry.
