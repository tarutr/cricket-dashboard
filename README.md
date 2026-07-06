# cricdb

Static cricket statistics explorer over the full Cricsheet dataset — DuckDB-WASM querying Parquet on Cloudflare R2, no backend.

## Architecture

## Data pipeline

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

## Triggering a data refresh

Data refreshes automatically every day at 03:47 UTC via the "Update data" GitHub
Action. To refresh manually: GitHub → Actions → "Update data" → Run workflow.
The pipeline downloads the latest `cricket.duckdb` from R2, rebuilds the four
Parquet exports, runs all validation gates, and uploads to `explorer/` only if
every gate passes. Requires repo secrets `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`.

## Deployment (Vercel)

## Feedback table (Supabase RLS)
