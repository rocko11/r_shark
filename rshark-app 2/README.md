# NYC Development Diligence — Netlify build

Address in, developer underwriting picture out, five boroughs. One Netlify
deploy from a GitHub repo: static frontend + TypeScript serverless functions.
No server to run, no second host, scales to zero.

## Why this shape

Netlify Functions run Node, not Python — so the FastAPI version can't run here.
This is a faithful TypeScript port of the same logic. The FAR/UAP engine and the
red-flag engine produce identical numbers (verified against the Python: 15,110 /
16,315 / 18,132 sf on the reference lot). If you ever want a persistent server
instead, the Python version still exists and belongs on Render or Railway.

## Layout

```
public/index.html              the whole frontend — vanilla JS, no build step
netlify/functions/
  report.mts        GET /api/report?address=… | ?bbl=…
  autocomplete.mts  GET /api/autocomplete?q=…
  canary.mts        GET /api/canary   — schema-drift check
  demo.mts          GET /api/demo     — fixture, works with no API keys
netlify/lib/                    shared logic, bundled into each function
  datasets.ts   socrata.ts   geocode.ts   derive.ts   report.ts
netlify.toml   package.json   .env.example
```

Each function declares its own `/api/*` route via `export const config`, so
there are no redirect rules to maintain for the API.

## Get it live (about 10 minutes)

You do these steps — they need your accounts and your keys, which only you
should ever enter.

**1. Get the two free API keys first.** Without them the site loads and `/api/demo`
works, but real lookups fail.
- Socrata token: data.cityofnewyork.us → sign in → Developer Settings → app token
- Geoclient v2: NYC API Developers Portal → Products → "Geoclient User" →
  subscribe to **Geoclient - v2** (v1 is deprecated)

**2. Put this folder on GitHub.**
```bash
git init && git add . && git commit -m "NYC diligence app"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

**3. Connect it to Netlify.**
- app.netlify.com → Add new site → Import an existing project → pick the repo
- Build settings are read from `netlify.toml` — leave them as detected
- Deploy

**4. Add the keys in Netlify.** Site configuration → Environment variables →
add `SOCRATA_APP_TOKEN` and `GEOCLIENT_SUBSCRIPTION_KEY` → then Deploys →
Trigger deploy (env vars only take effect on the next build).

You'll get a `https://<your-site>.netlify.app` link. That's the one you share.

## Run it locally first (optional)

```bash
npm install
npm i -g netlify-cli
cp .env.example .env          # fill in your keys
netlify dev                   # serves the site + functions on localhost:8888
```

## After it's live

- Hit `/api/canary` and check `ok: true`. Two dataset IDs (`tesw-yqqr`,
  `7isb-wh4c`) are unverified and low-stakes; the canary confirms them. Schedule
  it (Netlify scheduled functions) and alert on failures — Socrata IDs drift
  with no notice.
- The 10-second function timeout is the real constraint. Live fan-out across ~11
  datasets plus the ACRIS join usually fits, but a lot with a huge ACRIS history
  can run long. When that starts happening, the fix is a database mirror
  (`nycdb`), and `socrata.query()` is the seam to swap.

## What's deliberately not built

Same cuts as before, all honest gaps rather than hidden ones: split-lot FAR
(flagged, not computed), the full zoning envelope (height/setback/yard), real
rent-stabilization data (currently a labelled pre-1974/6-unit heuristic),
Staten Island ACRIS (surfaced as an explicit gap), and assemblage/comps/alerts.
The rent-stabilization module is the highest-value next piece.

## Design

The report is a drawing **title block**; palette is drafting linen and Sanborn
atlas minerals, where colour carries meaning — iron red is existing masonry and
critical risk, slate is available as-of-right, ochre is conditional. The
signature is the **FAR section diagram**: existing area hatched (the drafting
convention for solid material), available area open with a dimension arrow, UAP
scenarios dashed because they're conditional on providing affordable housing.
On a built-out lot all three bars look alike — that's the honest picture.
