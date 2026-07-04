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

const MODEL = "gemini-2.0-flash"; // free tier; swap to gemini-2.5-flash etc. if you like

const RUBRIC = `You are a GEX (Gamma Exposure) squeeze analyst applying a specific replay-based framework. You are given a PRE-COMPUTED structural summary of an options GEX heatmap replay window (all numbers already calculated in code). Output a concise BULL CASE and BEAR/INVALIDATION CASE for near-term price.

FRAMEWORK — the STRUCTURE is the primary signal; premium/flow is CONFIRMATION ONLY:
1. Negative-GEX nodes ("purple nodes") are liquidity magnets. A large NEGATIVE-GEX node sitting ABOVE spot means dealers are short gamma and hedging can drive price UP toward it (squeeze / gap-up). This is the core bullish setup.
2. Lifecycle beats a static value. Favor nodes whose negative GEX is GROWING through the session toward roughly -1,000,000 (e.g. -800K -> -1.0M). A ~+200K afternoon growth is a strong trigger. Read the provided trajectory.
3. "Fresh"/late-day nodes: a large negative node that appears or grows rapidly late in the session (e.g. ~2:20pm), especially well OTM (e.g. $20+ above spot), is high-conviction institutional positioning for a near-term move.
4. "Untouched": if price has NOT reached/rejected the node this session, the magnet is intact (bullish). If price already touched and rejected it, the setup is weakened/invalidated.
5. Premium/flow is NOT in this dataset — DO NOT fabricate premium numbers. Treat flow as a manual check the user performs (qualitative "massive disparity", e.g. millions in call premium vs thousands in puts = extra conviction). Always end with a one-line manual-flow-check reminder.
6. Timing: these setups run on a ~7-day window tied to Friday weekly OpEx.

RULES: Use the provided numbers exactly. Do NOT do your own arithmetic beyond simple comparison. Never invent values. If no node qualifies for a bull setup, say so plainly rather than forcing one.

OUTPUT — Markdown, ~200-350 words, this structure:
## Bull case
Reference the specific qualifying node(s) by strike + expiry with their numbers (start->now GEX, OTM distance, fresh?, untouched?, crossed -1M?). Explain the magnet/squeeze logic.
## Bear / invalidation
Downside magnets (negative nodes below spot), decaying nodes, touched/rejected nodes, or spot drifting away. State concrete invalidation triggers to watch.
## Conviction & confirmation
One line — structural conviction (Low/Medium/High) with the reason — then exactly: "Manual flow check: confirm call vs put premium disparity on your flow scanner near the target node before execution."

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

    const userText =
      "Here is the computed structural summary of the selected replay window. " +
      "All numbers are pre-calculated — use them as-is and do not invent values.\n\n" +
      "```json\n" + JSON.stringify(body.summary, null, 2) + "\n```\n\n" +
      "Produce the analysis per the framework.";

    const gReq = {
      systemInstruction: { parts: [{ text: RUBRIC }] },
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
