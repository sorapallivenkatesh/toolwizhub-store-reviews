# StoreReviews — App Store & Play Store review triage (ToolWizHub)

Paste your app's App Store or Google Play link (or ID), and StoreReviews pulls the
latest reviews, auto-sorts them into bugs / feature requests / praise, scores each by
urgency, and lets you export a triage report. Reviews come from the stores' public
feeds and are **triaged entirely in your browser** — never stored or profiled.

- **Live**: https://store-reviews.toolwizhub.com
- **App Store** works with no backend (Apple's public RSS is CORS-friendly).
- **Play Store** (and, optionally, the App Store) is served by a small **AWS Lambda**
  (Python, SAM) that fetches, normalizes and caches reviews — Google has no
  CORS-friendly public reviews endpoint, so it must be fetched server-side.

## Layout
```
site/   # static frontend (no build, vanilla ES modules) — deploy to store-reviews.toolwizhub.com
api/    # AWS SAM Lambda (Python 3.12) — App Store + Play Store fetcher
```

## Run locally (no Docker)
```
npm run dev      # API → http://localhost:3001  ·  site → http://localhost:8090
```
`api/dev.py` runs the Lambda handler in-process over plain HTTP — same code path as prod,
no SAM/Docker. `site/config.js` auto-points the frontend at `localhost:3001` in dev and at
`https://api.store-reviews.toolwizhub.com` in prod, so there's nothing to toggle.
The App Store works with the Python stdlib alone; to test **Play** locally,
`pip install google-play-scraper`.

Individual halves: `npm run api` (backend) · `npm run site` (frontend).

## Deploy
See **[DEPLOY.md](DEPLOY.md)** — SAM for the API (`npm run api:deploy`, config in
`api/samconfig.toml`), Cloudflare Pages for `site/`, DNS in Cloudflare.

`GET /reviews?store=appstore|play&id=<id>&country=<cc>&lang=<ll>&limit=<n>`
→ `{ app:{name,icon,version,ratingCount,avgRating}, reviews:[…], throttled, cached }`

## Architecture (keep boundaries)
- `site/js/core/triage.js` — **PURE** logic (sentiment, categorize, priority, cluster, stats); Node-testable
- `site/js/core/apple.js` — build/fetch/parse Apple's RSS reviews JSON (CORS-friendly client-side fallback)
- `site/js/core/api.js` — thin client for the Lambda backend (`API_BASE`, `apiFetch`, `parsePlayId`)
- `site/js/app.js` — the only DOM layer: store toggle, fetch flow, inbox, filters, statuses/notes, exports, localStorage
- `api/reviews.py` — Lambda handler. App Store via stdlib `urllib` (zero-dep); Play Store via `google-play-scraper`. In-memory TTL cache, CORS, normalized output.
