#!/usr/bin/env node
/* Backtest / validation harness for the squeeze scoring in ../scoring.js.
 *
 * Runs the SHIPPED scorer over recorded session data and checks three things:
 *   1. CORRECTNESS  — independently re-derive magnitude / growth / flip / freshness
 *                     from the raw JSON (a parser written here, NOT the module's)
 *                     and assert the module agrees. Non-circular.
 *   2. SCALE ROBUSTNESS — show the old absolute -400K floor vs the new relative
 *                     floor on real (huge-magnitude) SPY data.
 *   3. BEHAVIOR     — old flat-multiplier ranking vs new relative ranking, so a
 *                     human can eyeball what changed and why.
 *
 * NOTE ON PREDICTIVE TESTING: a true "did the squeeze pay off" backtest needs
 * multiple sessions with a MOVING spot and known outcomes. The bundled data is a
 * single frozen-price holiday capture, so this harness validates correctness and
 * behavior, not P&L. It is built to accept more days as they are collected.
 *
 * Usage:  node scripts/backtest.js [path/to/day.json ...]
 *         (defaults to every file listed in data/manifest.json)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const GEX = require("../scoring.js");

function readJson(file) {
  const buf = fs.readFileSync(file);
  const text = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  return JSON.parse(text);
}

const ROOT = path.join(__dirname, "..");
const argv = process.argv.slice(2);

function loadDataFiles() {
  if (argv.length) return argv.map((p) => path.resolve(p));
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "manifest.json"), "utf8"));
  const files = [];
  (man.series || []).forEach((s) => (s.dates || []).forEach((d) => files.push(path.join(ROOT, d.file))));
  return files;
}

// ---- independent raw parser (deliberately NOT GEX.parseCellValue) ----
function rawParse(text) {
  if (text == null) return 0;
  const t = String(text).replace(/\$/g, "").replace(/,/g, "").trim();
  const m = /^(-?\d*\.?\d+)\s*([KMB]?)/.exec(t);
  if (!m) return 0;
  const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[m[2]];
  return parseFloat(m[1]) * mult;
}

// rebuild per (strike|expiry) series straight from frames, our own way
function rawSeries(frames) {
  const map = new Map();
  frames.forEach((f) => {
    const exps = f.expiries || [];
    (f.rows || []).forEach((r) =>
      (r.values || []).forEach((cell, c) => {
        const exp = exps[c];
        if (exp == null) return;
        const k = r.strike + "|" + exp;
        if (!map.has(k)) map.set(k, { strike: r.strike, exp, vals: [] });
        map.get(k).vals.push(rawParse(cell.text));
      })
    );
  });
  return map;
}

// per-frame net GEX by strike (summed across expiries) — independent of module
function frameNet(frame) {
  return (frame.rows || []).map((r) => {
    let s = 0;
    (r.values || []).forEach((c) => { s += rawParse(c.text); });
    return { strike: r.strike, net: s };
  });
}
function gammaCenterOf(sn) {
  let n = 0, d = 0;
  sn.forEach(({ strike, net }) => { const w = Math.abs(net); n += strike * w; d += w; });
  return d > 0 ? n / d : null;
}
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([a, b]) => a != null && b != null);
  if (pairs.length < 3) return null;
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  pairs.forEach(([a, b]) => { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; });
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
const fmtc = (v) => (v == null ? "—" : v.toFixed(2));

// SESSION DIAGNOSTICS — the "is it too jumpy / does it track spot?" report.
// Meaningful only on a moving session; on frozen captures it says so.
function sessionDiagnostics(frames) {
  const step = GEX.detectStep(frames.flatMap((f) => (f.rows || []).map((r) => r.strike)));
  const spot = [], proxy = [], center = [];
  frames.forEach((f) => {
    const sn = frameNet(f), s = f.price != null ? Number(f.price) : null;
    spot.push(s); proxy.push(GEX.gexZeroProxy(sn, s, step)); center.push(gammaCenterOf(sn));
  });
  const N = frames.length;
  const cov = proxy.filter((v) => v != null).length;
  const jumps = []; let nullFlips = 0;
  for (let i = 1; i < N; i++) {
    if ((proxy[i - 1] == null) !== (proxy[i] == null)) nullFlips++;
    if (proxy[i - 1] != null && proxy[i] != null) jumps.push(Math.abs(proxy[i] - proxy[i - 1]));
  }
  const meanJump = mean(jumps), maxJump = jumps.length ? Math.max(...jumps) : null;
  const sv = spot.filter((v) => v != null);
  const sRange = sv.length ? Math.max(...sv) - Math.min(...sv) : 0;
  const sNet = sv.length ? sv[sv.length - 1] - sv[0] : 0;
  const frozen = sRange === 0 && jumps.every((j) => j === 0);

  console.log("\n[6] SESSION DIAGNOSTICS — jumpiness + spot tracking");
  console.log(`   spot: ${sv[0]}→${sv[sv.length - 1]}  range=${sRange.toFixed(2)} (${(sRange / step).toFixed(1)} strikes)  net=${sNet.toFixed(2)}`);
  console.log(`   GEX0 proxy: coverage ${cov}/${N}  mean jump=${meanJump == null ? "—" : (meanJump / step).toFixed(2) + " strikes/frame"}  max=${maxJump == null ? "—" : (maxJump / step).toFixed(2) + " strikes"}  null-flips=${nullFlips}`);
  console.log(`   tracking: corr(proxy,spot)=${fmtc(pearson(proxy, spot))}  corr(gammaCenter,spot)=${fmtc(pearson(center, spot))}`);
  if (frozen) {
    console.log("   ⚠ frozen capture (spot + proxy static) — jumpiness/tracking only mean something on a live moving session.");
  } else if (meanJump != null) {
    const jv = meanJump / step;
    const verdict = jv < 0.5 ? "SMOOTH" : jv < 1.5 ? "MODERATE" : "JUMPY";
    console.log(`   jumpiness verdict: ${verdict}  (mean ${jv.toFixed(2)} strikes/frame — rule of thumb: <0.5 smooth, >1.5 jumpy)`);
  }
  check("diag: proxy coverage in range", cov >= 0 && cov <= N);
  check("diag: jump stats finite", meanJump === null || !isNaN(meanJump));
}

let PASS = 0, FAIL = 0;
function check(name, cond, detail) {
  if (cond) { PASS++; }
  else { FAIL++; console.log(`   ✗ FAIL ${name}${detail ? "  — " + detail : ""}`); }
}

function fmtM(v) { return (v / 1e6).toFixed(1) + "M"; }

// old scoring, replicated for the before/after comparison
function oldScore(frames) {
  const NEG = -400000, spot = Number(frames[frames.length - 1].price);
  const halfway = frames.length * 0.5;
  const series = rawSeries(frames);
  const out = [];
  series.forEach((s) => {
    const cur = s.vals[s.vals.length - 1];
    if (cur >= NEG) return;
    const aboveSpot = spot ? s.strike > spot : false;
    let firstSig = null;
    for (let i = 0; i < s.vals.length; i++) if (s.vals[i] < NEG) { firstSig = i; break; }
    const fresh = firstSig != null && firstSig > halfway;
    // untouched approximated as strike outside [low,high]
    let lo = Infinity, hi = -Infinity;
    frames.forEach((f) => { if (f.price != null) { const p = +f.price; if (p < lo) lo = p; if (p > hi) hi = p; } });
    const untouched = !(s.strike >= lo && s.strike <= hi);
    const score = Math.abs(cur) * (aboveSpot ? 2 : 1) * (fresh ? 1.6 : 1) * (untouched ? 1.3 : 1);
    out.push({ strike: s.strike, exp: s.exp, cur, score });
  });
  out.sort((a, b) => b.score - a.score);
  return { nodes: out.slice(0, 12), candidateCount: out.length };
}

function run(file) {
  const rel = path.relative(ROOT, file);
  console.log("\n" + "═".repeat(72));
  console.log("SESSION:", rel);
  console.log("═".repeat(72));

  const data = readJson(file);
  const frames = data.frames;
  const spot = Number(frames[frames.length - 1].price);
  console.log(`frames=${frames.length}  spot=${spot}  priceFrozen=${new Set(frames.map((f) => f.price)).size === 1}`);

  const scored = GEX.buildNodes(frames);
  const raw = rawSeries(frames);

  // ---------- 1. SCALE ROBUSTNESS ----------
  const negNow = [...raw.values()].map((s) => s.vals[s.vals.length - 1]).filter((v) => v < 0);
  const deepest = Math.max(...negNow.map((v) => -v));
  const oldFloorCount = negNow.filter((v) => -v >= 400e3).length;
  console.log("\n[1] SCALE ROBUSTNESS");
  console.log(`   deepest negative node = ${fmtM(-deepest)}  (the old '-1M target' is crossed ${negNow.filter((v) => v <= -1e6).length}x — meaningless here)`);
  console.log(`   old absolute floor (-400K): ${oldFloorCount} candidates`);
  console.log(`   new relative floor (${scored.meta.negFloor}): ${scored.meta.candidateCount} candidates`);
  check("relative floor prunes the noise", scored.meta.candidateCount < oldFloorCount, `${scored.meta.candidateCount} !< ${oldFloorCount}`);
  check("relative floor keeps a workable set (2..40)", scored.meta.candidateCount >= 2 && scored.meta.candidateCount <= 40, `got ${scored.meta.candidateCount}`);

  // ---------- 2. CORRECTNESS (independent re-derivation) ----------
  console.log("\n[2] CORRECTNESS — module vs independent raw re-derivation (top nodes)");
  scored.nodes.forEach((n) => {
    const s = raw.get(n.strike + "|" + n.expiry);
    const start = s.vals[0], cur = s.vals[s.vals.length - 1];
    // magnitude / pctOfDeepest
    check(`${n.strike} ${n.expiry} gexNowNum`, Math.abs(n.gexNowNum - Math.round(cur)) <= 1, `${n.gexNowNum} vs ${Math.round(cur)}`);
    check(`${n.strike} ${n.expiry} pctOfDeepest`, Math.abs(n.pctOfDeepest - Math.abs(cur) / deepest) <= 0.02);
    // trend direction must match sign of (cur-start)
    const grewMoreNeg = cur < start;
    if (n.trend === "growing") check(`${n.strike} trend=growing`, grewMoreNeg, `cur ${fmtM(cur)} not < start ${fmtM(start)}`);
    if (n.trend === "decaying") check(`${n.strike} trend=decaying`, cur > start, `cur ${fmtM(cur)} not > start ${fmtM(start)}`);
    // flip: start >= 0 && cur < 0
    check(`${n.strike} flipped`, n.flipped === (start >= 0 && cur < 0), `start ${fmtM(start)} cur ${fmtM(cur)}`);
    // aboveSpot
    check(`${n.strike} aboveSpot`, n.aboveSpot === (n.strike > spot));
    // emergeFrac in [0,1]
    check(`${n.strike} emergeFrac range`, n.emergeFrac >= 0 && n.emergeFrac <= 1, `${n.emergeFrac}`);
    // score is positive and equals magnitude*(1+Σboost)*otm
    const st = n.strength;
    const expect = Math.abs(cur) * (1 + st.trajBoost + st.accelBoost + st.freshBoost + st.flipBoost) * st.otmModifier;
    check(`${n.strike} score formula`, Math.abs(st.score - Math.round(expect)) <= 2, `${st.score} vs ${Math.round(expect)}`);
  });
  // sort order
  const sorted = scored.nodes.every((n, i) => i === 0 || scored.nodes[i - 1].strength.score >= n.strength.score);
  check("nodes sorted by score desc", sorted);

  // ---------- 3. BEHAVIOR (old vs new ranking) ----------
  const oldR = oldScore(frames);
  console.log("\n[3] BEHAVIOR — ranking change (old flat multipliers → new relative)");
  const nkey = (n) => `${n.strike} ${n.expiry || n.exp}`;
  const oldTop = oldR.nodes.map(nkey);
  const newTop = scored.nodes.map(nkey);
  console.log("   OLD top 8: " + oldTop.slice(0, 8).join(" | "));
  console.log("   NEW top 8: " + newTop.slice(0, 8).join(" | "));
  const moved = newTop.slice(0, 8).filter((k) => oldTop.slice(0, 8).indexOf(k) !== newTop.indexOf(k));
  console.log(`   ${moved.length}/8 of the new top-8 changed rank vs old`);
  // magnitude spread — the point of pctOfDeepest is discrimination, not "all extreme"
  const buckets = { ">=0.5": 0, "0.2-0.5": 0, "<0.2": 0 };
  scored.nodes.forEach((n) => { buckets[n.pctOfDeepest >= 0.5 ? ">=0.5" : n.pctOfDeepest >= 0.2 ? "0.2-0.5" : "<0.2"]++; });
  console.log(`   magnitude spread across nodes (pctOfDeepest): ${JSON.stringify(buckets)}`);
  check("magnitude actually discriminates (not all one bucket)", Object.values(buckets).filter((v) => v > 0).length >= 2);

  // top-node detail
  console.log("\n   TOP NODE DETAIL:");
  scored.nodes.slice(0, 5).forEach((n, i) => {
    console.log(`   ${i + 1}. ${n.strike} ${n.expiry}  ${n.gexNow} (${(n.pctOfDeepest * 100).toFixed(0)}% of deepest)  ${n.aboveSpot ? "ABOVE" : "below"} spot ${n.otmPct}%  trend=${n.trend} accel=${n.accel} emergence=${n.emergence} flip=${n.flipped}  score=${fmtM(n.strength.score)}`);
  });
  if (scored.movers.length) {
    console.log("\n   RECENT MOVERS (macro):");
    scored.movers.forEach((m) => console.log(`   • ${m.strike} ${m.expiry}  ${m.gexNow}  ${m.accel} (${(m.recentChangePct * 100).toFixed(0)}% recent)`));
  }

  // ---------- 5. EVOLUTION (Phase 2, experimental) — smoke check on real data ----------
  const ev = GEX.buildEvolution(frames);
  console.log("\n[5] EVOLUTION (experimental) — real-data smoke");
  const ds = ev.dailySummary;
  console.log(`   proxy open/close=${ds.openingProxy}/${ds.closingProxy} coverage=${ds.proxyCoverage}  gammaCenter ${ds.openingGammaCenter}→${ds.closingGammaCenter}  migrationScore=${ds.migrationScore}`);
  check("evolution: dailySummary present", !!ds);
  check("evolution: migrationScore in [0,1] or null", ds.migrationScore === null || (ds.migrationScore >= 0 && ds.migrationScore <= 1), `${ds.migrationScore}`);
  check("evolution: does not touch squeeze nodes", ev.nodes === undefined);
  check("evolution: frozen session ⇒ score ≈ neutral", ds.migrationScore === null || Math.abs(ds.migrationScore - 0.5) < 0.1, `${ds.migrationScore}`);

  sessionDiagnostics(frames);
}

// ---------- 4. SYNTHETIC SIGNAL COVERAGE ----------
// The recorded data is too static to fire flip / late-emergence / acceleration,
// so we inject a KNOWN pattern and assert the module labels it. This is the only
// place those boost paths get exercised until live moving-price sessions exist.
function frame(tISO, price, cells) {
  // cells: { "strike|exp": number }
  const byStrike = new Map();
  const exps = [];
  Object.entries(cells).forEach(([k, v]) => {
    const [strike, exp] = k.split("|");
    if (!exps.includes(exp)) exps.push(exp);
    if (!byStrike.has(+strike)) byStrike.set(+strike, {});
    byStrike.get(+strike)[exp] = v;
  });
  const rows = [...byStrike.entries()].map(([strike, m]) => ({
    strike,
    values: exps.map((e) => ({ text: m[e] == null ? "0" : String(m[e]) })),
  }));
  return { capturedAt: tISO, price, expiries: exps, rows };
}

function runSynthetic() {
  console.log("\n" + "═".repeat(72));
  console.log("SYNTHETIC SIGNAL COVERAGE (injected patterns)");
  console.log("═".repeat(72));
  const spot = 100;
  // 10 frames, 2-min apart. Strike 110 (above spot): starts +30M, flips negative
  // late and accelerates deeper. Strike 90 (below): a static deep magnet decoy.
  const times = Array.from({ length: 10 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 5, 15, i * 2)).toISOString());
  // 110 path: +30, +20, +10, 5, 0, -20, -80, -180, -320, -500 (M) — flips ~mid, accelerates late
  const path110 = [30, 20, 10, 5, 0, -20, -80, -180, -320, -500];
  const frames = times.map((t, i) =>
    frame(t, spot, {
      "110|01-09-2026": path110[i] + "M",
      "90|01-09-2026": "-450M",          // static below-spot decoy
      "105|01-09-2026": "-40M",          // small above-spot node
    }));

  const { nodes } = GEX.buildNodes(frames, { absFloor: 1e6 });
  const n110 = nodes.find((n) => n.strike === 110);
  const n90 = nodes.find((n) => n.strike === 90);

  console.log(`   injected 110 → labeled: trend=${n110.trend} accel=${n110.accel} emergence=${n110.emergence} flipped=${n110.flipped} aboveSpot=${n110.aboveSpot}`);
  check("110 flip detected", n110.flipped === true);
  check("110 trend=growing", n110.trend === "growing");
  check("110 accel=accelerating", n110.accel === "accelerating");
  check("110 emergence late/mid", n110.emergence === "late" || n110.emergence === "mid", n110.emergence);
  check("110 aboveSpot", n110.aboveSpot === true);
  check("110 otm modifier applied (>10% OTM)", n110.strength.otmModifier === 1.25, `${n110.strength.otmModifier}`);
  console.log(`   static 90  → labeled: trend=${n90.trend} accel=${n90.accel} emergence=${n90.emergence} flipped=${n90.flipped} aboveSpot=${n90.aboveSpot}`);
  check("90 no flip", n90.flipped === false);
  check("90 trend=flat", n90.trend === "flat");
  check("90 accel=steady", n90.accel === "steady");
  check("90 below spot", n90.aboveSpot === false);
}

// ---------- 6. SYNTHETIC EVOLUTION COVERAGE ----------
// Inject a session with a KNOWN pattern: the net-GEX sign-flip walks UP (98→102),
// gamma center rises with it, and net gamma drifts less-negative. Assert the
// evolution engine reports rising migration + a bullish (>0.5) migrationScore.
// Signed Gaussian bump: net crosses zero at `flip` and |net| concentrates near it
// (realistic — real GEX mass sits near ATM, not spread flat across the board).
function synthFrame(tISO, price, flip, nev) {
  const rows = [];
  for (let s = 90; s <= 110; s++) {
    const x = s - flip;
    const net = Math.round(x * Math.exp(-(x * x) / 32) * 1e6); // integer → no sci-notation
    rows.push({ strike: s, values: [{ text: String(net) }] });
  }
  return { capturedAt: tISO, price, netExposureValue: nev, expiries: ["01-09-2026"], rows };
}
function lerp(a, b, i, n) { return a + (b - a) * (i / (n - 1)); }

function runEvolutionSynthetic() {
  console.log("\n" + "═".repeat(72));
  console.log("SYNTHETIC EVOLUTION COVERAGE (injected walking flip + bullish drift)");
  console.log("═".repeat(72));
  const N = 8;
  const times = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2026, 0, 5, 15, i * 2)).toISOString());
  const frames = times.map((t, i) =>
    synthFrame(t, lerp(100, 104, i, N), lerp(98, 102, i, N), lerp(-500e6, -200e6, i, N)));

  const ev = GEX.buildEvolution(frames);
  const ds = ev.dailySummary, mg = ev.migration;
  console.log(`   proxy ${ds.openingProxy}→${ds.closingProxy} (${mg.gexZeroProxy.direction}, v=${mg.gexZeroProxy.velocity}/min)  center ${ds.openingGammaCenter}→${ds.closingGammaCenter} (${mg.gammaCenter.direction})  netDrift=${ds.netGammaDrift}  score=${ds.migrationScore}  coverage=${ds.proxyCoverage}`);
  check("evo synth: proxy resolves (non-null)", ds.openingProxy != null && ds.closingProxy != null);
  check("evo synth: opening proxy ≈ 98", Math.abs(ds.openingProxy - 98) <= 1.5, `${ds.openingProxy}`);
  check("evo synth: closing proxy ≈ 102", Math.abs(ds.closingProxy - 102) <= 1.5, `${ds.closingProxy}`);
  check("evo synth: proxy migration up", mg.gexZeroProxy.direction === "up" && mg.gexZeroProxy.velocity > 0);
  check("evo synth: gamma center migration up", mg.gammaCenter.direction === "up");
  check("evo synth: net gamma drift positive (less negative)", ds.netGammaDrift > 0, `${ds.netGammaDrift}`);
  check("evo synth: migrationScore bullish (>0.5)", ds.migrationScore > 0.5, `${ds.migrationScore}`);
  check("evo synth: migrationScore bounded [0,1]", ds.migrationScore >= 0 && ds.migrationScore <= 1);
  check("evo synth: full proxy coverage", ds.proxyCoverage === `${N}/${N} frames`, ds.proxyCoverage);

  // null-proxy path: a frame with no sign change (all negative) → proxy null
  const flat = [synthFrame(times[0], 100, 200, -300e6), synthFrame(times[1], 100, 200, -300e6)];
  const evNull = GEX.buildEvolution(flat);
  console.log(`   no-crossing frame → proxy=${evNull.dailySummary.openingProxy} (expect null)`);
  check("evo synth: null when no sign change", evNull.dailySummary.openingProxy === null);

  // demonstrate the diagnostics on a MOVING session (frozen real data can't)
  sessionDiagnostics(frames);
  check("evo synth: proxy tracks spot (corr > 0.8)", (() => {
    const step = GEX.detectStep(frames.flatMap((f) => f.rows.map((r) => r.strike)));
    const sp = frames.map((f) => Number(f.price));
    const px = frames.map((f) => GEX.gexZeroProxy(frameNet(f), Number(f.price), step));
    return (pearson(px, sp) || 0) > 0.8;
  })());
}

console.log("GEX squeeze scoring — backtest / validation");
loadDataFiles().forEach(run);
runSynthetic();
runEvolutionSynthetic();
console.log("\n" + "─".repeat(72));
console.log(`RESULT: ${PASS} checks passed, ${FAIL} failed`);
process.exit(FAIL ? 1 : 0);
