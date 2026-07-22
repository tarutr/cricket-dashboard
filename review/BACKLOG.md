# cricdb — deferred backlog (owner-parked; NOT built)

Living list of work consciously deferred. Contract/anchors: see `CLAUDE.md`. Decisions: `review/owner_decisions.md`.

## Load speed — Tier 1 DONE (on branch); Tier 2–4 TO DO
**Context (measured 2026-07-22):** a cold load pulls **~37 MB** of parquet from R2; the two matchup files
(`matchup_batting` ~10 MB, `matchup_bowling` ~12 MB) are ~23 MB of that. Files are served from the raw
`pub-*.r2.dev` dev URL, which Cloudflare does not edge-cache.

**Tier 1 — DONE (commit 7b11d6e, on `polish-b1-mechanical`):** serve data via a Cloudflare **custom domain**
`data.the-cordon.com` (CDN edge caching) + `Cache-Control: immutable` on the versioned data files and
`no-cache` on the `manifest.json` pointer (set in `export_parquet.py` upload; full effect on the next
pipeline publish). Verified: app loads the 2,813 baseline from the new domain on localhost; CORS OK for both
localhost and `cricdb.vercel.app`; batting file ~517 ms vs ~2,550 ms before.

Remaining, in bang-for-buck order:

- **Tier 2 — shrink the bytes (pipeline-only; `export_parquet.py`). NUMBER-SAFE only: compression / row-order
  / column-pruning — NEVER touch aggregation.**
  - **ZSTD compression** on the parquet writes (~20–40 % smaller, free).
  - **Sort rows to match the default query** (gender → format → team_type → date) so DuckDB-WASM's HTTP
    range reads fetch a small slice for the default view instead of scanning the whole file — the biggest win,
    especially for the 23 MB matchup pair.
  - **Column pruning** — drop any exported columns the browser never reads (needs a read audit).
  - VERIFY: anchors must stay EXACT (compression/sort/prune must not move any value); independent DuckDB per file.
  - *Orchestrator can build + measure this locally against `data/cricket.duckdb` without publishing.*

- **Tier 3 — smarter loading (app-side, moderate):**
  - Background-warm the batting file while the user is picking filters, so the first Search feels instant
    (no query runs early — respects the no-auto-search rule).
  - Persist downloaded parquets in the browser's on-disk store (IndexedDB/OPFS), re-fetching only files whose
    hash changed → near-instant repeat visits even without the CDN.

- **Tier 4 — restructure the data (bigger surgery; only if 1–3 aren't enough):**
  - Split parquets by gender/format so the default view loads a small file and the rest lazy-loads.
  - A tiny precomputed "default leaderboard" file — **NOTE:** precomputing changes *where numbers come from*,
    which collides with the numbers-sacred rule → last resort, heavy anchor verification.

## Per-over — Round 5 wave R5-E (owner: "put per-over on the backburner", 2026-07-22)
- Add per-over aggregates in `export_parquet.py` (source `deliveries` has `over_number`; 11.3 M ball rows),
  then expose **per-over** as a Line X-axis (over 1→20, Y aggregated per over).
- **SIZE CONCERN:** a full per-over parquet is ~**8× batting** (3.4 M rows) / ~**6× bowling** (1.9 M rows) and
  feeds only the one Line axis → must be built **lean** (only Line-needed fields, sorted by player) and loaded
  **only when the per-over axis is picked**, never in the standard load. Owner leaned "measure the real size
  before committing."
- Publish path: the CI pipeline republishes parquets to R2 (cron, from `main`); per-over is visible only after
  that. Test-first/gated/additive pattern (like the decision-36 phase/matchup extension).

## Other Round-5 items parked for the final review
- **#18 personal-data coverage note** — no such note exists today; owner to decide at final review whether to
  build a NEW one (needs wording + a live per-scope figure). Decision 53.
- **#19 fresh-load red outline** on the graph chart-type box — built per spec; owner may prefer holding it
  until the first "Update chart". One-line change.
- **Line polish** — X=Phase offers only metrics with a real phase definition (Strike Rate / Economy / Wickets);
  gaps span the line (`spanGaps:true`) vs a literal break; the chart title names the metric but not the X-axis.

## Older standing deferrals
- **Team-name normalization** (Team + Opposition alias map) — the FIRST post-round data to-do (decision 51).
- ~375 px mobile one-screen fit; export-while-dirty.

## R6 #8 outcome + the per-over / fine-slice DATA-LAYER PROJECT (owner-approved direction 2026-07-22)
**Done now (no data change):** Line X=Phase broadened to the base metrics whose per-phase components already
live in the parquets — batting Runs/Balls/SR; bowling Runs-conceded/Balls/Wickets/Economy/Bowling-SR/Average.

**Line Y — permanently NOT plottable** (for the record): High Score, Best Bowling (single peak figures),
Matches (a scope count, wrong source), R.Pos/Batting position (filters, not values). Everything else
(total/rate/percent) already IS available as Y for the normal X-axes.

**The project to schedule (rolls the rest of phase INTO the per-over extension — one data-layer job):**
- STRATEGY (owner endorsed): from the ball-by-ball `deliveries` source, emit the raw **components** per slice
  — runs, balls, dots, fours, sixes, wickets, dismissals — **per phase AND per over**, NOT pre-computed
  per-metric values. The app then derives EVERY rate/percent/total metric per bucket via the existing
  sqlExpression pattern (SR=runs÷balls, dot%=dots÷balls, average=runs÷dismissals…). One compact component set
  unlocks all slice-able metrics for both phase and per-over.
- Unlocks (currently blocked by missing per-slice columns): by-PHASE **Dot% / Boundary% / Fours / Sixes /
  Batting Average / dismissal-types** (need pp_dots/pp_fours/pp_sixes/pp_dismissals on the innings parquet —
  ~a few columns, small size bump, loads with everything); and **per-over** (over 1→20) for all those metrics.
- LOAD STRATEGY (ties to the Tier-1..4 speed work): phase components → add the few columns to the EXISTING
  innings parquet. Per-over → a SEPARATE parquet (~8× the innings file) **loaded lazily, only when the per-over
  X-axis is actually picked** (never in the normal load), sorted by player so DuckDB-WASM range-reads fetch
  just the charted players. Test-first / gated / additive pipeline pattern (decision-36 style); publishes to
  R2 via CI → needs owner's explicit go for the pipeline run (as with per-over generally).
