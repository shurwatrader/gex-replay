/* GEX Replay — squeeze scoring (shared, browser + Node).
 *
 * Single source of truth for turning loaded frames into scored negative-GEX
 * nodes. app.js uses it in the browser; scripts/backtest.js uses it headless so
 * what we validate is exactly what ships.
 *
 * DESIGN — everything is RELATIVE to the session, never absolute dollars.
 * Per-strike GEX scales with the ticker (SPY nodes run into the hundreds of
 * millions; a small-cap's into the hundreds of thousands). Absolute thresholds
 * like "-1M target" or "-400K floor" only make sense for one ticker, so:
 *   • node floor   = a fraction of the session's DEEPEST negative node
 *   • magnitude    = expressed as % of that deepest node (pctOfDeepest)
 *   • trajectory   = % change vs the node's own size, not a fixed +/-100K
 *   • freshness    = position within the SELECTED window (0..1), not clock time
 *                    (the window is a user replay selection; it can span days)
 * Direction (above/below spot) is a returned FIELD, not a score multiplier —
 * the score measures structural strength; the caller decides bull vs bear.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.GEXScoring = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- parsing / formatting (kept here so the module is self-contained) ----
  const NUM_RE = /-?[\d,]*\.?\d+[KMB]?/g;
  function parseCellValue(text) {
    if (!text) return 0;
    const tokens = String(text).replace(/\$/g, "").match(NUM_RE);
    if (!tokens) return 0;
    const tok = tokens[tokens.length - 1].replace(/,/g, "");
    const m = /(-?[\d.]+)([KMB]?)$/.exec(tok);
    if (!m) return 0;
    const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[m[2]];
    return parseFloat(m[1]) * mult;
  }

  function fmtCompact(v) {
    if (v == null || isNaN(v)) return "—";
    const sign = v < 0 ? "-" : "";
    const a = Math.abs(v);
    if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
    return `${sign}${a.toFixed(0)}`;
  }

  // ET "H:MM AM" — Intl works in modern browsers and Node; callers may inject
  // their own fmtTime (app.js already has a zone helper) to stay consistent.
  let _etFmt = null;
  function defaultFmtTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    try {
      if (!_etFmt) _etFmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
      });
      return _etFmt.format(d);
    } catch (_) { return ""; }
  }

  function downsample(arr, n) {
    if (arr.length <= n) return arr.slice();
    const out = [], step = (arr.length - 1) / (n - 1);
    for (let k = 0; k < n; k++) out.push(arr[Math.round(k * step)]);
    return out;
  }

  // ---- tunable knobs (all relative / unit-free) ----
  const DEFAULTS = {
    relFloorFrac: 0.05,   // node must be >= 5% of the session's deepest neg node
    absFloor: 250e3,      // ...but never smaller than this (kills noise on tiny tickers)
    growPct: 0.08,        // >=8% deeper over the window = "growing"
    accelPct: 0.08,       // >=8% deeper over the recent tail = "accelerating"
    recentMs: 30 * 60 * 1000, // "recent" tail length; snaps to nearest frame
    topNodes: 12,
    topMovers: 4,
    trajPoints: 8,
  };

  // Boost tables — additive inside (1 + Σboosts); kept small and explicit so the
  // final score stays interpretable (no compounding mystery multipliers).
  const B = {
    growing: 0.20, decaying: -0.20,
    accel: 0.25, reversing: -0.15,
    freshLate: 0.40, freshMid: 0.20, freshEarly: 0.0, stale: -0.10,
    flip: 0.30,
  };

  // gex value at (or just before) a target time, by nearest earlier frame.
  function valueAt(vals, targetT) {
    let pick = vals[0];
    for (const v of vals) { if (v.t <= targetT) pick = v; else break; }
    return pick.gex;
  }

  /**
   * buildNodes(frames, opts) -> { nodes, movers, meta }
   * frames: [{ capturedAt, price, expiries:[...], rows:[{strike, values:[{text}...]}] }]
   */
  function buildNodes(frames, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const fmtTime = o.fmtTime || defaultFmtTime;
    if (!frames || !frames.length) {
      return { nodes: [], movers: [], meta: { frames: 0 } };
    }

    const first = frames[0], last = frames[frames.length - 1];
    const spotEnd = last.price != null ? Number(last.price) : null;
    const spotStart = first.price != null ? Number(first.price) : null;
    const spot = spotEnd != null ? spotEnd : spotStart;

    let priceLow = Infinity, priceHigh = -Infinity;
    frames.forEach((f) => {
      if (f.price != null) {
        const p = Number(f.price);
        if (p < priceLow) priceLow = p;
        if (p > priceHigh) priceHigh = p;
      }
    });
    if (!isFinite(priceLow)) { priceLow = null; priceHigh = null; }

    // time series per (strike|expiry)
    const series = new Map();
    frames.forEach((f) => {
      const exps = f.expiries || [];
      (f.rows || []).forEach((row) => {
        (row.values || []).forEach((cell, c) => {
          const exp = exps[c]; if (exp == null) return;
          const key = row.strike + "|" + exp;
          let s = series.get(key);
          if (!s) { s = { strike: row.strike, exp, vals: [] }; series.set(key, s); }
          s.vals.push({ i: s.vals.length, gex: parseCellValue(cell.text), t: +new Date(f.capturedAt) });
        });
      });
    });

    // session-relative node floor, derived from the deepest current negative node
    let deepestNeg = 0;
    series.forEach((s) => {
      const cur = s.vals[s.vals.length - 1].gex;
      if (cur < 0 && -cur > deepestNeg) deepestNeg = -cur;
    });
    const negFloor = Math.max(o.absFloor, o.relFloorFrac * deepestNeg);

    const lastT = +new Date(last.capturedAt);
    const nCross = frames.length; // window length in frames (for emergeFrac)

    const cands = [];
    series.forEach((s) => {
      const vals = s.vals;
      const cur = vals[vals.length - 1].gex;
      if (cur >= 0 || -cur < negFloor) return; // only meaningful negative nodes

      const start = vals[0].gex;
      let minGex = Infinity;
      vals.forEach((v) => { if (v.gex < minGex) minGex = v.gex; });

      const magnitude = -cur;
      const pctOfDeepest = deepestNeg > 0 ? magnitude / deepestNeg : 0;

      // TRAJECTORY — % change over the window vs the node's own scale
      const scaleW = Math.max(Math.abs(start), Math.abs(cur), o.absFloor);
      const windowChangePct = (cur - start) / scaleW; // <0 = grew more negative
      let trend = "flat", trajBoost = 0;
      if (windowChangePct <= -o.growPct) { trend = "growing"; trajBoost = B.growing; }
      else if (windowChangePct >= o.growPct) { trend = "decaying"; trajBoost = B.decaying; }

      // ACCELERATION — same idea over the recent tail (nearest frame to now-recentMs)
      const recentBase = valueAt(vals, lastT - o.recentMs);
      const scaleR = Math.max(Math.abs(recentBase), Math.abs(cur), o.absFloor);
      const recentChangePct = (cur - recentBase) / scaleR;
      let accel = "steady", accelBoost = 0;
      if (recentChangePct <= -o.accelPct) { accel = "accelerating"; accelBoost = B.accel; }
      else if (recentChangePct >= o.accelPct) { accel = "reversing"; accelBoost = B.reversing; }

      // FRESHNESS — where in the SELECTED window did it first cross the floor?
      let firstIdx = null, firstT = null;
      for (const v of vals) { if (v.gex < 0 && -v.gex >= negFloor) { firstIdx = v.i; firstT = v.t; break; } }
      const emergeFrac = firstIdx == null ? 0 : (nCross > 1 ? firstIdx / (nCross - 1) : 0);
      let emergence, freshBoost;
      if (firstIdx === 0) { emergence = "preexisting"; freshBoost = 0; }
      else if (emergeFrac >= 0.66) { emergence = "late"; freshBoost = B.freshLate; }
      else if (emergeFrac >= 0.33) { emergence = "mid"; freshBoost = B.freshMid; }
      else if (emergeFrac > 0) { emergence = "early"; freshBoost = B.freshEarly; }
      else { emergence = "stale"; freshBoost = B.stale; }

      // STATE CHANGE — positive at window start, negative now = dealers flipped short gamma
      const flipped = start >= 0 && cur < 0;
      const flipBoost = flipped ? B.flip : 0;

      // DIRECTION / DISTANCE (fields, not score direction)
      const aboveSpot = spot != null ? s.strike > spot : null;
      const otmPct = (spot != null && spot > 0)
        ? Math.round((s.strike - spot) / spot * 1000) / 10 : null;
      // %-OTM modifier only rewards reach ABOVE spot (the squeeze target)
      let otmModifier = 1.0;
      if (aboveSpot && otmPct != null) {
        if (otmPct >= 3) otmModifier = 1.25;
        else if (otmPct >= 1.5) otmModifier = 1.15;
      }

      const untouched = priceLow != null
        ? !(s.strike >= priceLow && s.strike <= priceHigh) : null;

      const score = magnitude
        * (1 + trajBoost + accelBoost + freshBoost + flipBoost)
        * otmModifier;

      cands.push({
        strike: s.strike, expiry: s.exp,
        aboveSpot, otmPct, untouched,
        gexStart: fmtCompact(start), gexNow: fmtCompact(cur), gexMin: fmtCompact(minGex),
        gexStartNum: Math.round(start), gexNowNum: Math.round(cur),
        pctOfDeepest: Math.round(pctOfDeepest * 100) / 100,
        windowChangePct: Math.round(windowChangePct * 100) / 100, trend,
        recentChangePct: Math.round(recentChangePct * 100) / 100, accel,
        emergeFrac: Math.round(emergeFrac * 100) / 100, emergence,
        firstSeenET: firstT ? fmtTime(new Date(firstT).toISOString()) : null,
        flipped,
        trajectory: downsample(vals, o.trajPoints)
          .map((v) => `${fmtTime(new Date(v.t).toISOString())} ${fmtCompact(v.gex)}`),
        strength: {
          score: Math.round(score),
          trajBoost, accelBoost, freshBoost, flipBoost,
          otmModifier,
        },
      });
    });

    cands.sort((a, b) => b.strength.score - a.strength.score);
    const nodes = cands.slice(0, o.topNodes);

    // MACRO CONTEXT — biggest recent movers (recent change × size), for the model
    // to see where institutions are moving *right now*, independent of rank.
    const movers = cands
      .slice()
      .sort((a, b) => Math.abs(b.recentChangePct * b.strength.score) - Math.abs(a.recentChangePct * a.strength.score))
      .slice(0, o.topMovers)
      .map((n) => ({ strike: n.strike, expiry: n.expiry, gexNow: n.gexNow, accel: n.accel, recentChangePct: n.recentChangePct }));

    return {
      nodes, movers,
      meta: {
        frames: frames.length,
        spot, spotStart, spotEnd, priceLow, priceHigh,
        deepestNeg: fmtCompact(-deepestNeg),
        negFloor: fmtCompact(-negFloor),
        candidateCount: cands.length,
        windowET: `${fmtTime(first.capturedAt)} – ${fmtTime(last.capturedAt)}`,
      },
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * PHASE 2 — SESSION EVOLUTION (EXPERIMENTAL / UNVALIDATED)
   * Completely separate from buildNodes above. Nothing here feeds the squeeze
   * path; the "Evolution" button calls buildEvolution() only. These metrics have
   * NOT been checked against live intraday data — the only bundled session is a
   * frozen-price holiday capture. Validate on a real moving session before trust.
   * See PHASE2_PLAN.md for methodology + rationale.
   * ═══════════════════════════════════════════════════════════════════════ */
  const r2 = (x) => (x == null || isNaN(x) ? null : Math.round(x * 100) / 100);
  const r4 = (x) => (x == null || isNaN(x) ? null : Math.round(x * 1e4) / 1e4);

  function normalizeWallType(s) {
    if (!s) return null;
    const t = String(s).toLowerCase();
    if (t.includes("call")) return "call";
    if (t.includes("put")) return "put";
    return null;
  }

  // auto-detect grid spacing (median gap) — SPY data mixes 1.0 and 0.5 strikes,
  // so any hardcoded step is wrong; this generalizes across tickers too.
  function detectStep(strikes) {
    const xs = [...new Set(strikes)].sort((a, b) => a - b);
    if (xs.length < 2) return 1;
    const gaps = [];
    for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)] || 1;
  }

  // per-strike net GEX for a frame = sum across expiries
  function frameStrikeNet(frame) {
    return (frame.rows || []).map((r) => {
      let s = 0;
      (r.values || []).forEach((c) => { s += parseCellValue(c.text); });
      return { strike: r.strike, net: s };
    });
  }

  function gammaCenter(strikeNet) { // |GEX|-weighted mean strike
    let num = 0, den = 0;
    strikeNet.forEach(({ strike, net }) => { const w = Math.abs(net); num += strike * w; den += w; });
    return den > 0 ? num / den : null;
  }

  function herfindahl(strikeNet) { // concentration of |GEX| (0..1); signed-safe via abs
    let tot = 0;
    strikeNet.forEach(({ net }) => { tot += Math.abs(net); });
    if (tot <= 0) return null;
    let h = 0;
    strikeNet.forEach(({ net }) => { const s = Math.abs(net) / tot; h += s * s; });
    return h;
  }

  function callPutMassRatio(strikeNet) { // Σ+GEX / Σ|−GEX|
    let pos = 0, neg = 0;
    strikeNet.forEach(({ net }) => { if (net > 0) pos += net; else neg += -net; });
    return neg > 0 ? pos / neg : null;
  }

  // gexZeroProxy — HONEST approximation of the strike where net GEX flips sign
  // over the VISIBLE board. NOT the classical gamma flip (that needs the
  // gamma-vs-spot curve and the full chain; we have neither). Method: smooth the
  // per-strike net profile (3-window, to collapse single-strike noise), find sign
  // changes, take the one nearest spot; interpolate for the sub-strike level.
  // Returns null when there's no crossing, or when crossings cluster ambiguously
  // right at spot — better no level than a confidently wrong one.
  function gexZeroProxy(strikeNet, spot, step) {
    const xs = strikeNet.slice().sort((a, b) => a.strike - b.strike);
    if (xs.length < 3) return null;
    const sm = xs.map((p, i) => {
      const a = (xs[i - 1] || p).net, b = p.net, c = (xs[i + 1] || p).net;
      return { strike: p.strike, net: (a + b + c) / 3 };
    });
    const cross = [];
    for (let i = 1; i < sm.length; i++) {
      const a = sm[i - 1], b = sm[i];
      if ((a.net > 0) !== (b.net > 0) && a.net !== b.net) {
        const t = a.net / (a.net - b.net);
        cross.push(a.strike + (b.strike - a.strike) * t);
      }
    }
    if (cross.length === 0) return null;
    if (cross.length === 1) return r2(cross[0]);
    if (spot == null) return null; // multiple crossings, no spot to disambiguate
    cross.sort((p, q) => Math.abs(p - spot) - Math.abs(q - spot));
    // ambiguous if the two nearest both straddle spot within one grid step
    if (Math.abs(cross[0] - spot) <= step && Math.abs(cross[1] - spot) <= step) return null;
    return r2(cross[0]);
  }

  function buildFrameMetrics(frame, step) {
    const sn = frameStrikeNet(frame);
    const spot = frame.price != null ? Number(frame.price) : null;
    let callWall = null, callPct = -Infinity, putWall = null, putPct = -Infinity;
    let oiKingStrike = null, volKingStrike = null;
    (frame.rows || []).forEach((r) => {
      (r.values || []).forEach((c) => {
        const wt = normalizeWallType(c.wallType);
        if (wt) {
          const pct = parseCellValue(c.wallPct);
          if (wt === "call" && pct > callPct) { callPct = pct; callWall = r.strike; }
          if (wt === "put" && pct > putPct) { putPct = pct; putWall = r.strike; }
        }
        if (c.oiKing) oiKingStrike = r.strike;
        if (c.volKing) volKingStrike = r.strike;
      });
    });
    const nev = frame.netExposureValue != null ? Number(frame.netExposureValue) : null;
    const proxy = gexZeroProxy(sn, spot, step);
    return {
      t: +new Date(frame.capturedAt), price: spot,
      netExposureValue: nev, regime: nev == null ? null : (nev > 0 ? "Positive" : "Negative"),
      callWall, putWall, oiKingStrike, volKingStrike,
      gammaCenter: gammaCenter(sn),
      gexZeroProxy: proxy,
      distanceToProxy: (proxy != null && spot != null) ? r2(spot - proxy) : null,
      concentration: herfindahl(sn),
      callPutMassRatio: r2(callPutMassRatio(sn)),
    };
  }

  // direction / velocity(strikes per min) / acceleration for one numeric track
  function migrate(points, step) {
    const pts = points.filter((p) => p.v != null);
    if (pts.length < 2) return { direction: "flat", velocity: null, acceleration: null, samples: pts.length };
    const first = pts[0], last = pts[pts.length - 1];
    const dv = last.v - first.v;
    const dtMin = (last.t - first.t) / 60000;
    const velocity = dtMin ? dv / dtMin : null;
    const direction = Math.abs(dv) < step ? "flat" : (dv > 0 ? "up" : "down");
    const segVel = (a) => { if (a.length < 2) return null; const dt = (a[a.length - 1].t - a[0].t) / 60000; return dt ? (a[a.length - 1].v - a[0].v) / dt : null; };
    const mid = Math.floor(pts.length / 2);
    const v1 = segVel(pts.slice(0, mid + 1)), v2 = segVel(pts.slice(mid));
    const acceleration = (v1 != null && v2 != null) ? v2 - v1 : null;
    return { direction, velocity: r4(velocity), acceleration: r4(acceleration), samples: pts.length, start: r2(first.v), end: r2(last.v), change: r2(dv) };
  }

  // migrationScore ∈ [0,1] (0.5 neutral). Documented, relative, tunable blend —
  // see PHASE2_PLAN.md §5. Frozen session → all components 0 → 0.5 (correct).
  function migrationScore(first, last, step) {
    const squash = Math.tanh;
    const comps = [], weights = [];
    if (first.netExposureValue != null && last.netExposureValue != null) {
      const scale = Math.max(Math.abs(first.netExposureValue), 1);
      comps.push(squash((last.netExposureValue - first.netExposureValue) / scale)); weights.push(0.4);
    }
    if (first.gammaCenter != null && last.gammaCenter != null) {
      comps.push(squash((last.gammaCenter - first.gammaCenter) / step)); weights.push(0.35);
    }
    if (first.gexZeroProxy != null && last.gexZeroProxy != null) {
      comps.push(squash((last.gexZeroProxy - first.gexZeroProxy) / step)); weights.push(0.25);
    }
    if (!comps.length) return null;
    const wsum = weights.reduce((a, b) => a + b, 0);
    const raw = comps.reduce((a, c, i) => a + c * weights[i], 0) / wsum;
    return r2((raw + 1) / 2);
  }

  function buildEvolution(frames, opts) {
    const o = opts || {};
    const fmtTime = o.fmtTime || defaultFmtTime;
    if (!frames || !frames.length) return { meta: { frames: 0 }, dailySummary: null, migration: {}, tracks: {} };

    const allStrikes = [];
    frames.forEach((f) => (f.rows || []).forEach((r) => allStrikes.push(r.strike)));
    const step = detectStep(allStrikes);

    const fm = frames.map((f) => buildFrameMetrics(f, step));
    const first = fm[0], last = fm[fm.length - 1];
    const series = (key) => fm.map((m) => ({ t: m.t, v: m[key] }));

    const migration = {
      callWall: migrate(series("callWall"), step),
      putWall: migrate(series("putWall"), step),
      gammaCenter: migrate(series("gammaCenter"), step),
      gexZeroProxy: migrate(series("gexZeroProxy"), step),
    };

    const wp = fm.filter((m) => m.gexZeroProxy != null && m.price != null);
    const above = wp.filter((m) => m.price > m.gexZeroProxy).length;
    const below = wp.filter((m) => m.price < m.gexZeroProxy).length;
    let crossings = 0;
    for (let i = 1; i < wp.length; i++) {
      if ((wp[i - 1].price > wp[i - 1].gexZeroProxy) !== (wp[i].price > wp[i].gexZeroProxy)) crossings++;
    }
    const dists = wp.map((m) => m.price - m.gexZeroProxy);
    const drift = (a, b) => (a != null && b != null ? r2(b - a) : null);

    const dailySummary = {
      openingNetGamma: first.netExposureValue, closingNetGamma: last.netExposureValue,
      netGammaDrift: drift(first.netExposureValue, last.netExposureValue),
      openingProxy: first.gexZeroProxy, closingProxy: last.gexZeroProxy,
      proxyDrift: drift(first.gexZeroProxy, last.gexZeroProxy),
      openingGammaCenter: r2(first.gammaCenter), closingGammaCenter: r2(last.gammaCenter),
      gammaCenterDrift: drift(first.gammaCenter, last.gammaCenter),
      maxDistanceToProxy: dists.length ? r2(Math.max(...dists)) : null,
      minDistanceToProxy: dists.length ? r2(Math.min(...dists)) : null,
      timeAboveProxyPct: wp.length ? Math.round((above / wp.length) * 1000) / 10 : null,
      timeBelowProxyPct: wp.length ? Math.round((below / wp.length) * 1000) / 10 : null,
      proxyCrossings: crossings,
      migrationScore: migrationScore(first, last, step),
      proxyCoverage: `${wp.length}/${fm.length} frames`,
    };

    const track = (key) => downsample(fm, 8).map((m) =>
      `${fmtTime(new Date(m.t).toISOString())} ${m[key] == null ? "—" : m[key]}`);

    return {
      meta: {
        frames: frames.length, strikeStep: step,
        windowET: `${fmtTime(new Date(first.t).toISOString())} – ${fmtTime(new Date(last.t).toISOString())}`,
        spot: last.price, experimental: true,
      },
      dailySummary,
      migration,
      concentration: { opening: r2(first.concentration), closing: r2(last.concentration) },
      tracks: {
        price: track("price"), gexZeroProxy: track("gexZeroProxy"), gammaCenter: track("gammaCenter"),
        callWall: track("callWall"), putWall: track("putWall"), regime: track("regime"),
      },
    };
  }

  // ---- the prompt (kept beside the scorer so the field names stay in sync) ----
  // worker/worker.js holds a byte-identical copy for standalone deployment.
  const RUBRIC = `You are a GEX (Gamma Exposure) squeeze analyst applying a replay-based framework. You are given a PRE-COMPUTED structural summary of an options GEX heatmap replay window — every number is already calculated in code. Output a concise BULL CASE and BEAR/INVALIDATION case for near-term price.

HOW THE NUMBERS WORK (read this first):
Per-strike GEX scale is RELATIVE to the ticker, so the summary gives you relative measures, not raw dollar thresholds. For each node:
  • pctOfDeepest — this node's size as a fraction (0-1) of the session's DEEPEST negative node. 1.0 = the anchor; 0.3 = a third as deep. Judge magnitude by this, NOT by absolute dollars.
  • trend + windowChangePct — direction over the whole window. "growing" (windowChangePct < 0) = getting more negative = accumulation (bullish). "decaying" = unwinding (bearish). "flat" = stable.
  • accel + recentChangePct — same over the recent tail. "accelerating" = fresh push deeper right now (high conviction). "reversing" = pressure lifting (caution).
  • emergence + emergeFrac + firstSeenET — WHERE in the selected window it first appeared. "late"/"mid" (emergeFrac near 1) = fresh institutional positioning (bullish). "preexisting"/"stale" = old signal. NOTE emergeFrac is window-relative (0=window start, 1=window end), not a clock time — a "late" node emerged late in THIS selection.
  • flipped — true means it went from positive at window start to negative now: dealers just flipped short gamma at this strike. Strong signal.
  • aboveSpot + otmPct — direction & distance. A negative node ABOVE spot is the bullish squeeze target (dealer hedging can pull price UP toward it). A negative node BELOW spot is a downside magnet (bearish).
  • untouched — true means price has not reached/rejected this strike in the window, so the magnet is intact.
  • strength.score — the code's composite rank (magnitude x trajectory/accel/fresh/flip boosts x OTM). Nodes are pre-sorted by it. Use it as the ordering, but explain WHY using the fields above.
  • trajectory — a downsampled time series ("time gex") so you can see the path yourself.
recentMovers lists where GEX shifted most in the recent tail — macro context for institutional moves happening now.

FRAMEWORK — STRUCTURE is the primary signal; premium/flow is CONFIRMATION ONLY:
1. A large negative node ABOVE spot = dealers short gamma; hedging can squeeze price UP toward it. Core bullish setup.
2. Lifecycle beats a static value: favor GROWING + ACCELERATING nodes over big-but-decaying ones.
3. Freshness: a node that emerged late in the window (high emergeFrac), especially well OTM or flipped, is high-conviction.
4. Untouched magnets are intact; touched-and-rejected ones are weakened/invalidated.
5. Premium/flow is NOT in this dataset — DO NOT fabricate premium numbers. Treat it as a manual check the user performs. Always end with the one-line flow-check reminder.
6. Timing: these setups run on a ~7-day window tied to Friday weekly OpEx.

RULES: Use the provided numbers exactly. Do NOT invent fields or values — if a metric isn't in the summary, don't reference it. Only comparison-level arithmetic. If no node qualifies for a bull setup (e.g. all below spot, all decaying), say so plainly rather than forcing one.

OUTPUT — Markdown, ~200-350 words:
## Bull case
Name the qualifying node(s) by strike + expiry. Justify with the fields: pctOfDeepest (magnitude), trend/accel (lifecycle), emergence (freshness), flipped, aboveSpot/otmPct, untouched. Explain the magnet/squeeze logic.
## Bear / invalidation
Downside magnets (aboveSpot=false), decaying/reversing nodes, touched nodes, or spot drifting away. Give concrete invalidation triggers to watch (e.g. "top node's trend turns to decaying", "price rejects the node").
## Conviction & confirmation
One line — structural conviction (Low/Medium/High) with the reason from the fields — then exactly: "Manual flow check: confirm call vs put premium disparity on your flow scanner near the target node before execution."

This is structural analysis, not financial advice.`;

  // ---- evolution prompt (separate path; worker/worker.js holds an identical copy) ----
  const EVOLUTION_RUBRIC = `You are a GEX (Gamma Exposure) dealer-positioning analyst. You are given a PRE-COMPUTED SESSION-EVOLUTION summary of an options GEX replay window — how dealer structure MIGRATED across the session, not a single snapshot. Every number is calculated in code.

⚠️ THIS ANALYSIS MODE IS EXPERIMENTAL AND UNVALIDATED. The metrics have not yet been checked against live intraday behavior. Reason carefully from the numbers, but flag that this is exploratory. Do NOT overstate confidence.

HOW THE NUMBERS WORK (all relative to the ticker/session):
  • dailySummary — session open→close deltas:
     - openingNetGamma / closingNetGamma / netGammaDrift — dealer net gamma and its change. Drift toward less-negative / positive = dealers less short gamma (typically less explosive, more mean-reverting).
     - gexZeroProxy (opening/closing/drift) — an APPROXIMATION of the GEX zero level over the VISIBLE strike board. NOT a true gamma flip (we only see part of the chain). May be null when there's no single clean crossing — treat null as "no reliable level," never invent one.
     - gammaCenter (opening/closing/drift) — |GEX|-weighted average strike. Rising center = gamma migrating UP the board (supportive); falling = migrating down.
     - timeAboveProxyPct / timeBelowProxyPct / proxyCrossings — how price sat relative to the proxy and how often it flipped side.
     - maxDistanceToProxy / minDistanceToProxy — how far price ranged from the proxy.
     - migrationScore ∈ 0..1 (0.5 neutral) — a documented blend of net-gamma drift, gamma-center drift, and proxy drift. >0.6 = bullish migration; <0.4 = defensive; near 0.5 = choppy/flat. It is a heuristic, not ground truth.
     - proxyCoverage — how many frames actually had a proxy (low coverage = weak proxy signal this session).
  • migration{ callWall, putWall, gammaCenter, gexZeroProxy } — each has direction (up/down/flat), velocity (strikes per minute), acceleration (Δvelocity). Positive velocity = level rising through the session.
  • concentration (opening/closing) — Herfindahl of |GEX| across strikes (0..1). Higher = gamma clustered in few strikes (pin risk / sharp structure); lower = dispersed.
  • tracks — downsampled "time value" series for price, gexZeroProxy, gammaCenter, callWall, putWall, regime, so you can see the path yourself.

FRAMEWORK:
1. The STORY is migration: where did dealer gamma move, how fast, and is it still moving (acceleration) at session end?
2. Rising gammaCenter + walls migrating up + netGamma drifting positive = constructive/bullish drift. The opposite = defensive.
3. A proxy the price sat ABOVE most of the session, with few crossings, is a more stable regime than one price whipsawed across.
4. High closing concentration = structure is sharpening around specific strikes (watch those as pins/magnets).
5. Premium/flow is NOT in this dataset — do not fabricate it.

RULES: Use the provided numbers exactly. Do NOT invent fields or values; if a metric is null or absent, say so. Comparison-level arithmetic only.

OUTPUT — Markdown, ~200-350 words:
## Session migration
What moved and how (gammaCenter, walls, proxy: direction/velocity/acceleration). Net gamma drift. Cite the numbers.
## Regime read
Above/below proxy behavior, crossings, concentration change. Is structure sharpening or dispersing, constructive or defensive?
## Outlook & caveats
migrationScore interpretation + a next-session lean. Then a required final line: "Experimental evolution analysis — pending live-data validation; confirm against real intraday behavior and a manual flow check before acting."

This is structural analysis, not financial advice.`;

  return { buildNodes, buildEvolution, gexZeroProxy, detectStep, parseCellValue, fmtCompact, downsample, DEFAULTS, BOOSTS: B, RUBRIC, EVOLUTION_RUBRIC };
});
