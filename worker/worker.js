// Cloudflare Worker — GEX Replay "Analyze range" proxy.
//
// The webapp POSTs a pre-computed structural summary of the selected replay
// window; this Worker prepends the squeeze-strategy rubric, calls Google
// Gemini (free tier), and returns a bull/bear markdown read. The API key lives
// here as a secret — never in the browser.
//
// One-time setup (see README.md):
//   npx wrangler secret put GEMINI_API_KEY   # from https://aistudio.google.com/apikey
//   npx wrangler secret put SHARED_TOKEN      # any random string; the app sends it back
//   npx wrangler deploy

const MODEL = "gemini-2.5-flash"; // mid-size model; both Analyze + Evolution use it

// NOTE: keep byte-identical to GEXScoring.RUBRIC in ../scoring.js. The Worker is
// deployed standalone (no bundler), so the prompt is duplicated here on purpose.
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

// NOTE: keep byte-identical to GEXScoring.EVOLUTION_RUBRIC in ../scoring.js.
// Used only when the request carries mode:"evolution" (the Evolution button).
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

    if (!env.SHARED_TOKEN || body.token !== env.SHARED_TOKEN) return json({ error: "unauthorized" }, 401);
    if (!body.summary) return json({ error: "missing summary" }, 400);
    if (!env.GEMINI_API_KEY) return json({ error: "server missing GEMINI_API_KEY" }, 500);

    // Route by mode: "evolution" → session-evolution rubric; default → squeeze.
    const isEvolution = body.mode === "evolution";
    const rubric = isEvolution ? EVOLUTION_RUBRIC : RUBRIC;

    const userText =
      (isEvolution
        ? "Here is the computed SESSION-EVOLUTION summary of the selected replay window. "
        : "Here is the computed structural summary of the selected replay window. ") +
      "All numbers are pre-calculated — use them as-is and do not invent values.\n\n" +
      "```json\n" + JSON.stringify(body.summary, null, 2) + "\n```\n\n" +
      "Produce the analysis per the framework.";

    const gReq = {
      systemInstruction: { parts: [{ text: rubric }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1400 },
    };

    let g;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(gReq) }
      );
      g = await res.json();
      if (!res.ok) return json({ error: "model error", detail: g }, 502);
    } catch (e) {
      return json({ error: "model fetch failed", detail: String(e) }, 502);
    }

    const md = (g?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim()
      || "_No content returned by the model._";
    return json({ markdown: md, model: MODEL });
  },
};
