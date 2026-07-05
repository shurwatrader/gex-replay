# Enhanced Squeeze Identification Rubric
## For Gemini API (worker.js) — Mirrors PDF Framework

This rubric replaces the generic version in `worker/worker.js` with **operationally specific** guidance aligned to the "High-Conviction Squeeze Identification" PDF framework.

---

## MAPPING: Current → Enhanced

| Current Element | PDF Framework Match | Enhancement |
|---|---|---|
| Negative-GEX nodes are magnets | Section 1: Net Negative GEX Framework | Add **concentration & magnitude thresholds** |
| Lifecycle beats static value | Section 2: Volume Dynamics | Add **specific 800K→-1M growth target** & time windows |
| Fresh/late-day nodes | Section 4: MRVL case study | Add **2:20pm-2:30pm formation windows**, "randomly placed" language |
| Untouched status | Preliminary Criteria | Keep, but add **per-strike/per-expiry** clarity |
| Premium/flow confirmation | Section 3: Call-to-Put Disparity | Replace generic "manual check" with **$6M calls vs $100K puts example** |
| 7-day opex window | Section 5: Execution Timing | Keep, frame as "weekly cycle target" |

---

## ENHANCED RUBRIC (Ready for worker.js)
## For Current Repo — No Flow Data (Manual Verification Step)

```javascript
const RUBRIC = `You are a HIGH-CONVICTION SQUEEZE ANALYST applying the institutional GEX framework. 
You are given a PRE-COMPUTED structural summary of an options GEX heatmap replay window. 
Nodes are scored by STRENGTH (not arbitrary multipliers):
  • Magnitude: How deep is the negative GEX? (-500K vs -1.5M)
  • Trajectory: Is it GROWING toward -1M or DECAYING? Growth = bullish.
  • Acceleration: Did it just cross into negative GEX? Fresh state changes are high conviction.
  • Time-Decay: Late-day emergence (3:00pm-close) > mid-day static nodes.
  • State Change: Node that flipped from positive→negative in this window = institutional move.
  • Distance OTM: How far above spot? $10 OTM vs $30 OTM (deeper = higher bar to prove bullish).

Output a BULL CASE and BEAR/INVALIDATION CASE grounded in THESE METRICS, not guesses.

═══════════════════════════════════════════════════════════════════════════════

CURRENT ALGORITHM ISSUES & FIXES
─────────────────────────────────

Issue 1: ARBITRARY MULTIPLIERS (Current app.js scoring)
────────────────────────────────────────────────────────
Current formula:  _score = |gex| × (aboveSpot ? 2 : 1) × (fresh ? 1.6 : 1) × (untouched ? 1.3 : 1)

Problems:
  ✗ Why 2x for above-spot? Why 1.6x for fresh? Multipliers are ASSUMPTIONS, not evidence.
  ✗ Only top 12 nodes returned — misses macro context (entire structure strengthening/weakening)
  ✗ No trajectory weighting — node growing -400K → -900K scores same as node shrinking -1.2M → -400K
  ✗ No acceleration signal — node that just crossed 0→negative in last 30min (institutional aggression) not flagged
  ✗ No time-decay — 9:30am emergence treated = 3:45pm emergence (late-day is MUCH higher conviction)
  ✗ No state-change detection — flip from +100K → -800K in single window is massive signal

BETTER SCORING FRAMEWORK (Implemented in enhanced app.js):
───────────────────────────────────────────────────────────
Score nodes by QUANTIFIED STRENGTH (not multipliers):

  1. MAGNITUDE (Baseline): Deeper negative = higher conviction
     • -400K to -600K: Low magnitude
     • -800K to -1.0M: Strong magnitude
     • < -1.2M: Extreme magnitude (rare, warrants attention)

  2. TRAJECTORY (Growth/Decay Signal): Is node growing toward -1M or shrinking?
     • BULLISH: Growing (+100K or more in window) → trajectory_boost = +20%
     • NEUTRAL: Stable (±50K swing) → trajectory_boost = 0%
     • BEARISH: Decaying (-100K or more) → trajectory_boost = -20%
     • Rationale: Growing node = continuing institutional accumulation

  3. ACCELERATION (Recent Momentum): How fast did it move in LAST 30 minutes?
     • BULLISH: Large move in final 30min (e.g., -500K → -950K) → acceleration_boost = +25%
     • NEUTRAL: Stable (no major move recent) → acceleration_boost = 0%
     • BEARISH: Slowing down → acceleration_boost = -15%
     • Rationale: Fresh institutional positioning is most predictive

  4. TIME-DECAY (When did it emerge?): Recent emergence >> all-day static
     • 2:00pm - 3:30pm (Final hour+): +40% boost
     • 1:00pm - 2:00pm (Mid-afternoon): +20% boost
     • 9:30am - 1:00pm (Morning/lunch): 0% boost
     • Pre-10:00am or post-close: -10% boost (old signal)
     • Rationale: Late-day nodes = massive same-day capital commitment (MRVL pattern)

  5. STATE-CHANGE (Flip Events): Did node flip in this window?
     • Positive → Negative flip: +30% boost (dealers just became short gamma)
     • Negative → More negative: covered by trajectory
     • No flip: 0% boost
     • Rationale: Institutional positioning change is highest conviction

  6. DISTANCE OTM (How far out?): Deeper OTM = higher bar for bullish case, but fresh deep OTM = extreme conviction
     • $5-10 OTM: Standard, no modifier
     • $10-20 OTM: +15% modifier (harder to reach, but if fresh = mega signal)
     • $20+ OTM: +25% modifier (MRVL-level, only bullish if FRESH + GROWING)
     • Rationale: $20+ OTM requires institutional coordination, not retail

REVISED SCORING FORMULA:
  final_score = magnitude 
    × (1 + trajectory_boost + acceleration_boost + time_decay_boost + state_change_boost)
    × distance_otm_modifier

Return TWO SETS:
  • Top 8 nodes by final_score (high conviction nodes)
  • Top 4 nodes by ACCELERATION × TRAJECTORY (macro context: recent institutional moves)

Node Metadata now includes:
  • trajectory: [ {time, gex}, {time, gex}, ... ]  — full time series for LLM to read
  • acceleration_30min: GEX change in last 30 minutes
  • state_change: { flipped: true/false, from: X, to: Y }
  • time_since_emergence: "15 minutes ago" or "3 hours ago"
  • strength_score: breakdown of all boosts

═══════════════════════════════════════════════════════════════════════════════

HOW THE LLM ANALYZES THESE METRICS
──────────────────────────────────

When you see node metadata with trajectory, acceleration, state_change:

1. READ THE TRAJECTORY ARRAY:
   "Node at 750: [-500K (9:30am), -520K (10:15am), -480K (12:00pm), -900K (2:45pm)]"
   → Analysis: "Strong late-day growth (+420K in final 3 hours = aggressive institutional accumulation)"
   
2. CHECK ACCELERATION:
   "acceleration_30min: -250K" (from -650K to -900K in last 30 min)
   → Analysis: "Recent acceleration bullish; suggests fresh positioning for near-term move"
   
3. EVALUATE STATE-CHANGE:
   "state_change: { flipped: true, from: +40K (open), to: -850K (now) }"
   → Analysis: "Dealers JUST became short gamma at this strike; hedging would be bullish"
   
4. FACTOR TIME-DECAY:
   "time_since_emergence: '40 minutes ago'" + "OTM: $22"
   → Analysis: "Appeared late (2:45pm), $22 OTM = MRVL-pattern institutional signal"
   
5. SYNTHESIZE INTO CONVICTION:
   Magnitude (-900K) + Trajectory (growing) + Acceleration (recent, fast) + Time (late) + StateChange (flip)
   = HIGH CONVICTION (structural evidence, not multiplier game)


Section 6: OPEX WINDOW & TIMING CONSTRAINTS
─────────────────────────────────────────────
Setups operate on a 7-DAY WINDOW tied to Friday Weekly OpEx.
  • Moves CAN happen same-day or next day (MRVL-style) 
  • OR mature through the weekly cycle (node remains target through Friday)
  • Strategic priority: If volume holds steady at -1M, ticker remains "Top Watch" for duration


═══════════════════════════════════════════════════════════════════════════════

TECHNICAL CHECKLIST (Use Quantified Scoring Metrics)

Before outputting conviction level, verify:
  ☐ Magnitude: How deep is negative GEX? (-400K vs -1.5M?) Scale strength accordingly.
  ☐ Trajectory: Is node GROWING (bullish) or DECAYING (bearish)? Quote the time series data.
  ☐ Acceleration: What changed in the LAST 30 MINUTES? Recent moves = higher conviction.
  ☐ Time-Decay: When did this node emerge? Late-day (2:00pm+) >> morning emergence.
  ☐ State-Change: Did it flip positive→negative? If yes, that's a massive signal.
  ☐ Distance OTM: How far above spot? $5 OTM vs $25 OTM (deeper = institutional conviction required).
  ☐ Untouched: Has price reached/rejected this strike yet? (From payload metadata)
  ☐ Price Delivery: On replay, is price moving TOWARD node or AWAY? (Infer from window context)

═══════════════════════════════════════════════════════════════════════════════

OUTPUT FORMAT — Markdown, ~250–400 words

## Bull Case
Reference SPECIFIC QUALIFYING NODE(S) by strike + expiry.
STRUCTURE: Magnitude | Trajectory | Acceleration | Time | State-Change

Example:
"Strike 750, Apr expiry:
  • Magnitude: -920K (strong, 92% of -1M threshold)
  • Trajectory: Grew +380K (from -540K at 12:00pm → -920K at 2:45pm) = sustained institutional accumulation
  • Acceleration: +250K in final 30 minutes = aggressive recent move
  • Time-Decay: Emerged 45 minutes ago in final-hour window = high conviction
  • State-Change: Flipped positive (+80K at open) → negative (-920K now) = dealers just went short gamma
  • Distance OTM: $21 above spot (institutional-level commitment required for this distance)
Synthesis: Multiple high-conviction signals align. Hedging feedback can drive price up toward 750."


## Delivery vs. Rejection Check
EXPLICIT QUESTION: "Based on the replay window and price path, is price DELIVERING toward top nodes or REJECTING them?"
  • If price moved toward nodes during window: "Price is DELIVERING; bullish setup intact."
  • If price moved away from nodes: "Price REJECTED; setup weakened or invalidated."
  • If mixed (toward some, away from others): "Mixed signals—strongest nodes are those price delivered toward."


## Bear / Invalidation Triggers
List downside magnets (negative nodes BELOW spot), decaying/weakening nodes, touched-and-rejected nodes.
Include QUANTIFIED triggers: 
"Setup invalidated if:
  • Price breaks and holds above [strike + distance], closing the gap to the magnet
  • Top node decay accelerates (e.g., -900K → -600K in final 30 min reverses conviction)
  • Lower negative nodes strengthen, suggesting rotation downward"


## Conviction Level
STATE: Low / Medium / High (backed by scoring evidence)

EXAMPLE Low:
"Low Conviction. Node at 760 is -600K (below strong threshold), emerged mid-afternoon (time-decay penalty), 
no state-change, and price has moved away from it during window. Trajectory flat. Lacks conviction signals."

EXAMPLE Medium:
"Medium Conviction. Strike 755 is -850K (strong magnitude), emerged 90 minutes ago (decent time-decay), 
grew +200K mid-window (positive trajectory), but no state-change flip. Price delivery mixed. 
Requires external confirmation (e.g., Monday gap-up, fresh volume Monday) to elevate."

EXAMPLE High:
"High Conviction. Strike 750 is -920K (extreme magnitude), FLIPPED positive→negative (state-change), 
grew +380K with +250K acceleration in final 30min (fresh institutional move), emerged 45min ago in final hour 
(time-decay bonus), $21 OTM (institutional distance). Multiple aligned signals. Price is delivering toward node 
in replay. This is MRVL-pattern high-conviction squeeze setup."


## No Manual Flow Check (Data Not Available in Replay)
Flow confirmation (call vs put premium disparity) is NOT available in this dataset. 
That is a separate, manual verification step on Atlas flow scanner. This analysis is STRUCTURAL only.

═══════════════════════════════════════════════════════════════════════════════

KEY PRINCIPLES
──────────────
1. Use provided numbers exactly. Do NOT invent arithmetic beyond comparison.
2. Reference the PDF framework checklist in your reasoning.
3. Be explicit about DELIVERY vs REJECTION (price action matters).
4. When flow data is unavailable (not in this summary), remind user to verify on Atlas.
5. Favor FRESHNESS + GROWTH over stale, static nodes.
6. If no node qualifies (e.g., all below spot, all decaying), say so plainly.
7. This is STRUCTURAL analysis. Premium/flow is confirmation, not the primary signal.

This is structural analysis, not financial advice.`;
```

---

## IMPLEMENTATION GUIDE FOR DEV

### Enhanced Node Selection Algorithm (for app.js)

**Goal**: Replace arbitrary multipliers with quantified scoring metrics.

```javascript
function computeNodeStrength(node, sessionData) {
  // MAGNITUDE: How deep is the GEX?
  let magnitude_score = Math.abs(node.gexNow);  // -900K scores higher than -500K
  
  // TRAJECTORY: Is node growing or decaying?
  let trajectory_boost = 0;
  let gex_change = node.gexNow - node.gexStart;
  if (gex_change < -100000) trajectory_boost = 0.20;      // Growing (becoming more negative)
  else if (Math.abs(gex_change) <= 50000) trajectory_boost = 0;  // Stable
  else if (gex_change > 100000) trajectory_boost = -0.20;  // Decaying
  
  // ACCELERATION: How much changed in last 30 minutes?
  let acceleration_boost = 0;
  if (node.acceleration_30min && Math.abs(node.acceleration_30min) > 150000) {
    acceleration_boost = 0.25;  // Recent sharp move
  }
  
  // TIME-DECAY: When did this emerge?
  let time_decay_boost = 0;
  let minutes_ago = node.minutesSinceEmergence;
  if (minutes_ago < 30) time_decay_boost = 0.40;      // Final 30 min
  else if (minutes_ago < 120) time_decay_boost = 0.20; // Final 2 hours
  else if (minutes_ago < 300) time_decay_boost = 0;    // Morning/lunch
  else time_decay_boost = -0.10;                       // Very old signal
  
  // STATE-CHANGE: Did it flip positive → negative?
  let state_change_boost = 0;
  if (node.state_change && node.state_change.flipped) {
    state_change_boost = 0.30;  // Massive signal
  }
  
  // DISTANCE OTM: How far above spot?
  let otm_modifier = 1.0;
  if (node.otmDollars >= 20) otm_modifier = 1.25;      // Extreme OTM
  else if (node.otmDollars >= 10) otm_modifier = 1.15; // Deep OTM
  // else otm_modifier = 1.0 (standard)
  
  // FINAL SCORE
  let final_score = magnitude_score 
    * (1 + trajectory_boost + acceleration_boost + time_decay_boost + state_change_boost)
    * otm_modifier;
  
  return {
    score: final_score,
    magnitude_score,
    trajectory_boost,
    acceleration_boost,
    time_decay_boost,
    state_change_boost,
    otm_modifier
  };
}
```

**Return Strategy**:
- Top 8 nodes by `final_score` (high conviction)
- Top 4 nodes by `acceleration_boost × trajectory_boost` (macro context, recent institutional moves)

### Node Metadata Structure (for worker.js to analyze)

Each node in the summary should now include:

```javascript
{
  strike,
  expiry,
  gexStart,              // GEX at beginning of window
  gexNow,                // GEX at end of window
  gexMin,                // Lowest GEX during window
  trajectory,            // [ {time: "ET time", gex: -500000}, ... ] — full time series for LLM
  acceleration_30min,    // GEX change in last 30 minutes (e.g., -250000 = grew 250K)
  state_change: {        // If node flipped positive → negative
    flipped: true,
    gex_at_open: 50000,
    gex_now: -920000
  },
  minutesSinceEmergence, // "15" means emerged 15 min ago (late-day = bullish)
  untouched,             // Boolean: price never reached this strike?
  aboveSpot,             // Boolean: strike > current spot?
  otmDollars,            // e.g., 21 (for "strike is $21 above spot")
  
  // Scoring breakdown (for transparency):
  strength: {
    score: 85000,
    magnitude_score: 920000,
    trajectory_boost: 0.20,
    acceleration_boost: 0.25,
    time_decay_boost: 0.40,
    state_change_boost: 0.30,
    otm_modifier: 1.25
  }
}
```

---

## PROMPT USAGE

Replace the current `RUBRIC` constant in [worker/worker.js](worker/worker.js#L13) with the enhanced version above.

**No changes needed to:**
- Gemini model (gemini-2.0-flash is fine)
- Temperature (0.4 is appropriate for structured output)
- Token limit (1400 is adequate)
- POST payload structure (summary JSON format stays the same)

**Testing:**
1. Send a replay range with a clear late-day fresh node (e.g., MRVL 2:20–2:30pm window from the PDF)
2. Verify output explicitly calls out the **formation window**, **volume delta**, and **delivery vs rejection**
3. Confirm the flow reminder includes the 4:1 call:put disparity language

---

## SUMMARY: Current Repo (gex-replay) Enhancement

**Context**: This prompt fixes problems in current `app.js` node selection algorithm by replacing **arbitrary multipliers** with **quantified scoring metrics**.

**Problems Being Fixed**:
1. ✗ Why 2x for above-spot? → ✓ Quantified by: magnitude + trajectory + acceleration + time + state-change
2. ✗ Top 12 nodes only → ✓ Return top 8 + top 4 (high conviction + macro context)
3. ✗ No trajectory weighting → ✓ Growing nodes get +20%, decaying nodes get -20%
4. ✗ No acceleration signal → ✓ Recent 30-min moves flagged separately
5. ✗ No time-decay → ✓ Late-day (2:00pm+) gets +40% boost, early morning gets 0%
6. ✗ No state-change detection → ✓ Positive→negative flip gets +30% boost

**Data Flow**:
1. `app.js` computes better-scored nodes with trajectory, acceleration, state_change metadata
2. `buildAnalysisSummary()` returns nodes with richer data (not just score)
3. `worker.js` receives node metadata
4. Gemini analyzes using the **quantified metrics** (not arbitrary multipliers)
5. Output references STRENGTH SCORES from the algorithm, not guesses

**No Flow Confirmation** (Manual Step):
- Call:put premium disparity is NOT in this dataset
- User performs that check separately on Atlas/flow tool
- This analysis is STRUCTURAL only

| Aspect | Current Issue | This Fix | Impact |
|---|---|---|---|
| Scoring | Arbitrary 2x/1.6x multipliers | Magnitude + Trajectory + Accel + Time + StateChange | Evidence-based conviction |
| Node Count | Top 12 only (misses macro) | Top 8 high-conv + 4 macro context | Avoid tunnel vision |
| Trajectory | Not weighted | Growing → +20%, Decaying → -20% | Directional bias matters |
| Acceleration | Ignored | Recent 30-min moves detected | Fresh institutional moves visible |
| Time-Decay | All nodes equal | Late-day +40%, early -0% | MRVL pattern captured |
| State-Change | Not flagged | Positive→negative flip +30% | Massive institutional signal |
| LLM Analysis | Analyzes arbitrary scores | Analyzes quantified metrics | Better interpretability |
| Flow Confirmation | Expected in prompt | Removed (data not available) | Realistic for current repo |
