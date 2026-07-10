# cricdb

Static cricket statistics explorer over the full Cricsheet dataset — DuckDB-WASM querying Parquet on Cloudflare R2, no backend.

## Architecture

Static browser-only site. DuckDB-WASM runs on the client and issues HTTPS range requests to Parquet files hosted on Cloudflare R2. The pipeline (GitHub Actions, `.github/workflows/pipeline.yml`) exports Parquet + manifest every 6 hours by running SQL against a local `cricket.duckdb` database (the source of truth) and uploading results to R2. Vercel hosts the static site (index.html + ES modules, no build step). The frontend is vanilla JS modules with no framework — the only bundled dependency is DuckDB-WASM (vendored locally in `vendor/`).

## Data pipeline

`cricket-dashboard` is the primary and only owner of `cricket.duckdb` on Cloudflare
R2. A single GitHub Actions workflow, `.github/workflows/pipeline.yml` ("Data
pipeline"), runs the whole chain every 6 hours (03:47/09:47/15:47/21:47 UTC, and
on manual dispatch),
sequentially:

1. Download `cricket.duckdb` from R2.
2. Ingest new Cricsheet data (incremental — `pipeline/ingest.py` skips files
   already ingested, one transaction per file).
3. *(from Phase D2 onward)* Fetch the Cricinfo player-profiles sheet from Dropbox
   and rebuild the `player_profiles` table.
4. Upload `cricket.duckdb` back to R2 — **gated** behind the repository variable
   `DB_UPLOAD_ENABLED`. See below.
5. Export the Parquet tables + `manifest.json` from the freshly-ingested local DB
   and upload them to R2.

The workflow uses a `concurrency` group (`data-pipeline`) so two runs can never
overlap and clobber each other's DB upload, and every step relies on default
failure behavior — any step failing fails the whole run, and a run that fails
never reaches the upload step, so a partially-built DB is never published.

### The `DB_UPLOAD_ENABLED` latch

This repo used to only export Parquet from a DB owned by the old `wt20-guide`
pipeline. During the migration, `pipeline.yml` downloads and ingests into
`cricket.duckdb` but the "Upload cricket.duckdb to R2" step only runs
`if: vars.DB_UPLOAD_ENABLED == 'true'` — an unset repository variable is falsy, so
uploads are **off by default**. This guarantees the old pipeline keeps owning the
live database until the owner has verified this repo's ingestion end-to-end and
explicitly disabled the old workflow. When skipped, the run logs a loud
`DB upload SKIPPED` message so the gate is never silent. The owner flips it on by
setting the `DB_UPLOAD_ENABLED` repository variable to `true` in
Settings → Secrets and variables → Actions → Variables.

### `pipeline/`

`pipeline/ingest.py`, `pipeline/download_db.py`, and `pipeline/upload_db.py` are
ported from the old wt20-guide project's validated, battle-tested ingestion
scripts (incremental, per-file transactions). Their logic must never be casually
edited — only paths/wiring are modernized for this repo. Any change to ingestion
behavior itself must be flagged to the owner first.

## R2 setup (CORS)

The `explorer/` prefix of the `cricket-db` bucket must be publicly readable and
CORS-enabled so the browser can issue HTTPS range requests against the Parquet files.

One-time setup in the Cloudflare dashboard:

1. **Public access**: R2 → `cricket-db` → Settings → Public Development URL → Enable.
   Note the resulting `https://pub-<hash>.r2.dev` URL — the frontend config needs it.
2. **CORS policy**: R2 → `cricket-db` → Settings → CORS policy → Edit, paste:

```json
[
  {
    "AllowedOrigins": [
      "https://cricdb.vercel.app",
      "http://localhost:8000",
      "http://127.0.0.1:8000"
    ],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

Verify with: `curl -s -I -H "Origin: https://cricdb.vercel.app" https://pub-<hash>.r2.dev/explorer/manifest.json`
— the response must include `access-control-allow-origin`.

## Local development

Serve the repo root with any static server on port 8000 (the port allowed by the
R2 CORS policy): `python3 -m http.server 8000`, then open http://localhost:8000/debug/.

There is **no build step**. The only tooling ever used is a one-time vendoring
command (already run; repeat only when upgrading duckdb-wasm) that inlines its
`apache-arrow` dependency so browsers can import it without a bundler:

```sh
npm install @duckdb/duckdb-wasm@<version> apache-arrow esbuild
npx esbuild node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs \
  --bundle --format=esm --minify --outfile=vendor/duckdb-wasm/duckdb-browser.mjs
# then copy dist/*.worker.js and dist/*.wasm alongside it, update vendor/duckdb-wasm/VERSION
```

## Adding a metric

All metrics live in a single module: `src/metrics.js` (SPEC §8.2 — duplicated metric
vocabularies are banned). Each metric is one object whose important fields are:
- `key`: stable identifier used by the column picker, charts, and queries.
- `label`: the user-visible heading.
- `sqlExpression`: the aggregation SQL. It runs **in the browser** (DuckDB-WASM) against
  the exported Parquet views — the pipeline does not execute these.
- `format`: `"int"`, `"dec1"`, `"dec2"`, or `"pct1"` — how the value renders.
- `kind` (decision 43): `"total"` (countable, e.g. runs), `"rate"` (average, strike rate),
  `"percent"` (dot %, boundary %), or `"peak"` (High Score, BBI). Charts use this to decide
  which metrics they accept (e.g. donuts take totals only).
- plus honesty metadata (`zeroIsData`, `additive`, `higherIsBetter`, `minSampleComponent`,
  `isPhaseMetric`) documented at the top of the file.

**Verification rule (decision 39):** any change to a metric's SQL must be re-verified
against the raw R2 Parquet with an *independently derived* query (its own COUNT DISTINCT
etc.), never by reusing the app's own aggregation shape. The standing anchor values live
in `review/owner_decisions.md`.

## Triggering a data refresh

Data refreshes automatically every 6 hours (03:47/09:47/15:47/21:47 UTC) via the "Data pipeline" GitHub
Action. To refresh manually: GitHub → Actions → "Data pipeline" → Run workflow.
See "Data pipeline" above for the full download → ingest → export chain, the
Parquet export's own validation gates, and the `DB_UPLOAD_ENABLED` latch that
currently keeps DB writes disabled. Requires repo secrets `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`.

## Deployment (Vercel)

The site auto-deploys from the `main` branch — on every push, Vercel builds the static site (no build step; just copying files) and serves it at https://cricdb.vercel.app.

**Important:** R2 CORS allows `http://localhost:8000` (the local review environment) but not Vercel's preview domains, so preview branches show CORS errors when fetching Parquets. Review finished work on localhost before merging to main. To run locally: `python3 -m http.server 8000` in the repo root, then open http://localhost:8000/ (the SQL debug console lives at http://localhost:8000/debug/).

## Feedback table (Supabase RLS)

**Not yet built.** This is a polish-phase feature (decision 43). Plan: an anonymous feedback form storing to a Supabase table with RLS policies that allow anonymous insert only (no select). Frontend form and Supabase table setup are pending owner approval of the full design review.
