# GEX Analyze Worker

A tiny Cloudflare Worker that powers the webapp's **🧠 Analyze** button. It holds
the API key (never in the browser), prepends the squeeze-strategy rubric, calls
**Google Gemini (free tier)**, and returns a bull/bear markdown read.

## What you need (both free)
1. A **Google Gemini API key** — https://aistudio.google.com/apikey
2. A **Cloudflare account** — https://dash.cloudflare.com/sign-up

## Deploy (5 minutes)
From this `worker/` folder:

```bash
npm install -g wrangler        # or: npx wrangler ...
wrangler login                 # opens a browser to authorize Cloudflare

# set the two secrets (you'll be prompted to paste each value)
wrangler secret put GEMINI_API_KEY     # paste your Gemini key
wrangler secret put SHARED_TOKEN       # make up any random string, e.g. a UUID

wrangler deploy
```

`wrangler deploy` prints your Worker URL, e.g.
`https://gex-analyze.<your-subdomain>.workers.dev`.

## Wire it into the app
Open the site, click **🧠 Analyze** once. It will prompt you (one-time, stored in
your browser's localStorage) for:
- **Worker URL** — the `…workers.dev` URL from above
- **Shared token** — the same string you set as `SHARED_TOKEN`

That's it. Every Analyze click sends the current date range's structural summary
to the Worker and renders the read.

## Notes
- **Free tiers:** Cloudflare Workers = 100k requests/day; Gemini Flash ≈ 1,500
  requests/day. Way more than a manual beta needs.
- **Quota guard:** the `SHARED_TOKEN` check stops randoms who find the URL from
  draining your Gemini quota.
- **Swap models:** change `MODEL` at the top of `worker.js` (e.g. to a newer
  Gemini Flash), or point it at Anthropic/Groq if you prefer — only the
  `fetch(...)` block changes.
- **No premium data:** the read is a *structural* thesis; it always ends with a
  manual flow-check reminder, since call/put premium isn't in the scraped data.
