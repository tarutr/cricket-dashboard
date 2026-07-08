# Cricket Stats Explorer — Build Specification (v1.0)

Owner: tarutr. Owner is a non-coder with deep cricket knowledge; all cricketing-logic
ambiguities must be resolved by asking the owner, never by assumption. This document is
the single source of truth for the build. Where this spec is silent, ask; do not invent.

---

## 1. What this is

A new, standalone static website for exploring cricket statistics across the full
Cricsheet dataset (~21,800 matches, all formats, men's and women's). It is the successor
to the WT20 2026 fan dashboard (`tarutr/wt20-guide`) but a **different site, different
repo, no shared code deployment** — though it deliberately carries over proven design
behaviors from v1 (listed in §8).

Two core features only:
1. **Compare Stats** — a filterable, sortable player-comparison table.
2. **Graph Builder** — build charts (bar, donut, scatter, radar) from the filtered set.

No player profile pages, no team pages, no editorial content in v1 of this site.

## 2. Non-goals (do not build)

- No user accounts, no login.
- No AI/chatbot query interface.
- No ESPN data (Cricsheet only; ESPN integration is a separate future project).
- ~~No player role/type filters~~ **(SUPERSEDED by Phase D4.2, 2026-07-08.)** When v1
  was written no role/type classification existed in the dataset. Phase D4 added the
  `player_profiles` table (from the Cricinfo sheet), and D4.2 shipped profile-powered
  filters — playing-role, batting-hand, bowling-style, teams-played-for — to Compare
  Stats. See `SPEC_ADDENDUM_DATA.md` (D4) and `review/owner_decisions.md` (decisions
  13–15, 21, 25). Profiles are men-only, so these filters are inert on the Women view.
- No WC / "since last WC" style toggles from v1.
- No server, no backend API, no database hosted for queries. Static site only.

## 3. Architecture

```
cricket.duckdb  (Cloudflare R2 bucket `cricket-db`, maintained by the EXISTING
                 ingestion pipeline — do not modify ingest.py or that pipeline)
      │
      ▼  GitHub Actions (this repo, daily cron + manual dispatch)
export_parquet.py  — downloads cricket.duckdb from R2, runs aggregation SQL,
                     writes 4 Parquet files, uploads them to R2 under prefix `explorer/`
      │
      ▼
R2 public objects, CORS-enabled:
   explorer/players.parquet
   explorer/matches.parquet
   explorer/batting_innings.parquet
   explorer/bowling_innings.parquet
   explorer/manifest.json        (build timestamp + row counts + file version hashes)
      │
      ▼  HTTPS range requests
Browser: DuckDB-WASM (@duckdb/duckdb-wasm, vendored locally, NOT hot-loaded from a
   third-party CDN at runtime) registers the Parquet URLs and runs SQL client-side.
      │
      ▼
Static frontend (Vercel): index.html + ES modules. No framework. No build step
   (plain JS modules; if a bundler is truly unavoidable for duckdb-wasm, use the
   simplest possible esbuild one-liner and document it in README).
```

Fallback rule: if a Parquet fetch fails, show a clear human-readable error state with a
retry button — never a blank page or console-only error.

## 4. Data layer

### 4.1 Source-of-truth calculation rules (from the validated database reference — these are ABSOLUTE)

- Base table for all aggregation is `deliveries`. Never aggregate from `innings_batters`,
  `innings_bowlers`, or `bowling_spells`.
- `over_number` is 0-based. Over 1 = over_number 0.
- Legal delivery for BOWLER stats: `wides IS NULL AND noballs IS NULL`.
- Legal delivery for BATTER balls faced: `wides IS NULL` only (no-balls count as faced).
- Batter runs = `runs_batter`. Wides never credit the batter.
- Bowler runs conceded = `SUM(runs_batter + COALESCE(noballs,0) + COALESCE(wides,0))`
  — byes and leg-byes excluded. Never use `runs_total` for bowler stats.
- Bowler-credited wickets: join the `wickets` table; count only kinds in
  {bowled, lbw, caught, caught and bowled, stumped, hit wicket}.
- Batter dismissals (for average): count wickets rows where `player_out_id` = batter,
  any kind except {retired hurt, retired not out} (ask owner to confirm the exact
  not-out treatment of `retired out` before finalizing).
- Super overs (`innings.super_over = TRUE`) are excluded from ALL stats.
- Date filtering uses `matches.match_date_1`, never season columns.
- Boundary detection: a hit boundary is `runs_batter IN (4,6) AND is_not_boundary IS NOT TRUE`.
- Afghanistan does not exist in the data; no special handling needed beyond honest empty results.
- Player names are "initials + surname" (e.g. "RG Sharma"); search must match on substring,
  case-insensitive.
- T20 phases: powerplay overs 1–6 (over_number 0–5), middle 7–15 (6–14), death 16–20 (15–19).
  Phase columns are only meaningful for T20/IT20; they are still *stored* for other formats
  using the same over ranges but the UI must not surface phase metrics unless the format
  filter is exactly T20, IT20, or both.

### 4.2 Parquet schemas (written by export_parquet.py)

All files sorted by `match_date` then `match_id` so DuckDB row-group pruning makes
date-range filters cheap. Row group size ~100k. Compression: zstd.

**players.parquet** — one row per player_id
- player_id, player_name

**matches.parquet** — one row per match
- match_id, match_type (T20|ODI|MDM|ODM|Test|IT20), gender (male|female),
  team_type (international|club), match_date (DATE = match_date_1), year (INT),
  month (INT), venue, city, event_name, team_1, team_2, winner, result_type

**batting_innings.parquet** — one row per (match_id, innings_number, batter_id)
- match_id, innings_number, batter_id, batter_name, batting_team, bowling_team,
  match_type, gender, team_type, match_date, year, month           ← denormalized for filter pushdown
- runs, balls_faced, dots, fours_hit, sixes_hit (hit boundaries only, per §4.1),
  dismissed (0/1), dismissal_kind (nullable),
  batting_position (order of first appearance in `batter` column),
- Phase components (T20 semantics, stored for all formats per §4.1):
  pp_runs, pp_balls, mid_runs, mid_balls, death_runs, death_balls

**bowling_innings.parquet** — one row per (match_id, innings_number, bowler_id)
- match_id, innings_number, bowler_id, bowler_name, bowling_team, batting_team,
  match_type, gender, team_type, match_date, year, month
- balls (legal), runs_conceded (per §4.1), wickets (bowler-credited per §4.1),
  dots, fours_conceded, sixes_conceded (off the bat, hit boundaries), maidens
  (complete 6-legal-ball over, 0 runs off bat+wides+noballs), wides_runs, noball_runs
- Phase components: pp_balls, pp_runs_conceded, pp_wickets, mid_*, death_* (same trio)

Validation gate in export_parquet.py (build FAILS loudly if violated):
- Row counts > 0 for every file.
- Spot-check 3 known career aggregates supplied by the owner at build-review time
  (owner will verify against scorecards) — encode them as assertions once confirmed.
- No duplicate primary keys.

### 4.3 GitHub Actions workflow

- `update-data.yml`: cron daily (pick a quiet hour UTC) + workflow_dispatch.
  Steps: checkout → pip install (duckdb, boto3) → download cricket.duckdb from R2
  (reuse the pattern from v1's download_db.py) → run export_parquet.py → upload the
  4 Parquet files + manifest.json to R2 `explorer/` prefix.
- Secrets required (already exist in owner's GitHub account for v1; add to this repo):
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT_URL.
- The Parquet files are NEVER committed to git.

### 4.4 R2 serving requirements

- The `explorer/` prefix must be publicly readable via the bucket's public development
  URL or a custom R2.dev/public bucket domain.
- CORS policy on the bucket must allow GET + HEAD + Range headers from the Vercel
  domain and localhost. Document the exact JSON CORS config in README and print it in
  the setup output so the owner can paste it into the Cloudflare dashboard.
- The site reads `manifest.json` first (cache-busted with `?t=Date.now()`) and appends
  the manifest's version hash to each Parquet URL, so browsers cache Parquet aggressively
  but always see fresh data after a pipeline run.

## 5. Frontend — Compare Stats

### 5.1 Filters (the "major filters" bar)

1. **Gender** — Women / Men. Default: **Men** (owner change 2026-07-08; originally
   Women — see `review/owner_decisions.md` #25). Single-select, always active (no "both").
2. **Format** — multi-select over T20, IT20, ODI, ODM, Test, MDM, with two convenience
   groupings surfaced in the UI: "All T20s" (T20+IT20) and "All ODIs" (ODI+ODM).
   Default: All T20s.
3. **Date range** — month/year FROM and month/year TO pickers (no day precision).
   Bounds derived from the data (min/max match_date in manifest). Default: last 3 years.
4. **Team** — multi-select of teams present under current gender+format+date scope
   (batting_team for batting view, bowling_team for bowling view). Default: all.
5. **Team type** — International / Club / Both. Default: International.
6. **Minimum innings** — numeric input, applied to the discipline in view.
   Default: 10. This is a first-class filter, not buried in advanced.

Discipline toggle: **Batting / Bowling** (carried over from v1).

**Player-profile filter row (added D4.2, 2026-07-08):** a second filter row — playing
role (broad Batter/Allrounder/Bowler + cascading detailed sub-role), batting hand,
bowling type (10 types), and teams-played-for (searchable). Each option lists only
values that have matched players; a profile filter restricts the table (and graph seed)
via a `player_id` semi-join, and excludes unmatched players *only* while a profile filter
is active. Profiles are men-only, so the whole row is greyed with an honest note on the
Women view. See `SPEC_ADDENDUM_DATA.md` D4.2.

### 5.2 Advanced filters

The v1 AND/OR condition builder pattern: groups of conditions (metric, operator
[≥, ≤, =, between], value) combinable with AND/OR. Conditions apply to the
computed metric values under the current major-filter scope.

### 5.3 Metric catalogue

All metrics are computed in SQL from innings components — a single shared module
`metrics.js` defines every metric ONCE as {key, label, shortLabel, discipline,
sqlExpression, higherIsBetter, format, isPhaseMetric, minSampleComponent}. Both the
table and the graph import this module. No metric may be defined anywhere else.

Batting: innings, runs, balls faced, high score, average (runs/dismissals),
strike rate (runs/balls*100), balls per dismissal, dot %, boundary % (boundary balls /
balls), balls per boundary, runs per innings, 4s, 6s, not-out %,
PP strike rate, middle-overs SR, death SR (phase metrics; T20-only surfacing per §4.1).
*Added D4.2 (Piece 2):* faced-ball progression strike rates — first-10-ball SR, balls
11–20 SR, 21+ SR (ball-count buckets, all formats, NOT phase-gated).

Bowling: innings, wickets, balls, runs conceded, average (runs/wkts), economy
(runs/balls*6), strike rate (balls/wkts), dot %, boundary % conceded, maidens,
wickets per innings, PP economy, death economy, PP wickets, death wickets.
*Added D4.2 (Piece 2):* wicket-type breakdown counts — bowled, lbw, caught,
caught-&-bowled, stumped, hit-wicket (the six sum to `wickets`).

Division-by-zero rule: any ratio with a zero denominator is NULL, never Infinity,
never 0. NULL sorts last regardless of direction.

### 5.4 Table behavior

- **No automated search (owner change 2026-07-08, `review/owner_decisions.md` #25):** the
  results table is **blank on first load** and shows a **"Show results"** button; runs the query
  only on click and reverts to the blank prompt on any filter change, so it never shows
  numbers for a scope the filters no longer describe. Applies to the table only; the Graph
  Builder still auto-updates.
- Columns = selected metrics (user can add/remove/reorder; sensible defaults per discipline).
- Sortable by any column, direction-aware (economy ascending = best).
- Player search box (substring, case-insensitive, surname-friendly).
- Row count indicator that reflects the FILTERED, data-qualified set honestly.
- Query latency target: < 1.5s on a typical connection after first load; show a subtle
  loading state during queries, never a frozen UI.

## 6. Frontend — Graph Builder

Same page (a view/panel, NOT an iframe — v1's iframe caused caching bugs; explicitly banned).
Chart.js (vendored). Types: bar, donut, scatter, radar. (No "arrow/change" chart —
that was WC-specific.) Features carried from v1, all governed by the shared metrics module:

- Player selection seeded from the current Compare Stats filtered set; manual
  add/remove; sensible caps per type (bar ≤ 15, donut ≤ 10, radar ≤ 6, scatter ≤ 60 —
  confirm caps with owner at review).
- Auto-generated natural-language title/subtitle/footer that HONESTLY describe scope
  ("Women's T20Is, Jan 2023 – Jun 2026, min 10 innings"); manual edits stick until the
  user changes chart parameters again (v1 §25.8 behavior).
- PNG export (html2canvas or Chart.js native toBase64Image) with site watermark.
- Donut restricted to additive totals metrics only (runs, wickets, etc.).
- Radar uses curated metric groups (define 3–4 sensible groups per discipline; owner reviews).
- A "Randomise" button MAY be stubbed (hidden behind a flag) but is NOT in scope for v1
  of this site; do not build the archetype engine.

## 7. Feedback (only Supabase feature)

- Small feedback form (comment, optional name/email) writing to a `feedback` table in a
  NEW Supabase project (or new table set), **with RLS enabled**: anon role may INSERT
  into feedback only; no SELECT/UPDATE/DELETE; no access to any other table. Provide the
  exact RLS policy SQL in README for the owner to run in the Supabase SQL editor.
- The anon key in the frontend is expected to be public; RLS is the security boundary.

## 8. Non-negotiable engineering rules (lessons from v1)

1. **`hasMetricData` global rule**: a metric value of 0 or NULL means "no data" for
   rates/ratios; such players never appear in charts or best/worst rankings for that
   metric. Raw totals (runs, wickets) MAY legitimately be 0 in the table but a player
   with 0 in the *ranked* metric never enters a chart. One shared predicate, used everywhere.
2. **One metrics module** (§5.3). Duplicated metric vocabularies across files (v1's
   fragilest seam) are banned.
3. **Modular code**: ES modules, no file over ~600 lines; suggested layout:
   `src/db.js` (duckdb-wasm setup + query helpers), `src/metrics.js`, `src/filters.js`,
   `src/table.js`, `src/graph/*.js`, `src/state.js`, `styles.css`, `index.html`.
4. **Honest descriptions**: titles/footers may only state filters actually applied.
5. **No secrets in the repo** except the Supabase anon key (public by design).
   R2 keys live only in GitHub Actions secrets.
6. **Screenshot-verifiable increments**: each build phase ends with a deployable,
   visually checkable state; the owner reviews screenshots/preview URLs, not code.
7. Mobile-usable: the table may scroll horizontally, but filters and graphs must work
   on a phone viewport (~380px).
8. Design: distinctive editorial look (v1's north star: Guardian player guides).
   Display font Bricolage Grotesque, body Inter, unless the owner redirects. Dark-on-light,
   generous whitespace, no default-Bootstrap look.

## 9. Build phases & acceptance criteria

**Phase 0 — Skeleton + data pipeline.**
export_parquet.py runs locally against a copy of cricket.duckdb, produces the 4 files,
passes validation gates; GitHub Action green; files visible on R2 with CORS working
(verified by a curl with Origin header). Acceptance: owner sees manifest.json in browser.

**Phase 1 — Data layer in browser.**
DuckDB-WASM loads, registers Parquet, and a debug page can run: "top 10 run scorers,
women's T20, 2024–2026, min 10 innings" in < 1.5s. Acceptance: numbers spot-checked by
owner against known scorecards. DO NOT PROCEED until owner confirms 3 spot-checks.

**Phase 2 — Compare Stats.**
Full filter bar + advanced conditions + metric table. Acceptance: owner screenshot review.

**Phase 3 — Graph builder.**
All 4 chart types + honest auto-descriptions + PNG export. Acceptance: owner review.

**Phase 4 — Polish.**
Mobile pass, loading/error states, feedback form + RLS, performance audit, README
(covering: architecture, how to add a metric, how to trigger a data refresh, all
dashboard-side setup the owner must do).

Deploy to Vercel from Phase 1 onward; every phase reviewed on the preview URL.

## 10. Testing rules

- Every SQL aggregate in export_parquet.py must have at least one assertion against a
  hand-verified value (owner supplies from ESPNcricinfo scorecards at Phase 1 review).
- Frontend: a scripted browser check (Playwright) that loads the site, applies a filter,
  and asserts a non-empty, correctly-sorted table — run before every phase handoff.
- Syntax/lint check all JS before presenting.
- Never mark a phase complete without a screenshot or preview-URL verification.

## 11. Open questions for the owner (ask during Phase 0, do not assume)

1. Exact not-out treatment of rare dismissal kinds (retired out, obstructing the field).
2. Should MDM/Test batting show balls-per-dismissal instead of SR-led defaults?
3. Chart player caps (§6). 4. Radar metric groups. 5. Site name + color palette.
