# Wave 2a — engine v2 behind a flag (Stats leaderboard from balls)

Branch `ball-layer`. Owner: decision 67 / `.orchestrator/ball-layer-design.md`.
Numbers-sacred: with the flag ON, every Stats number must be byte-identical to the
flag-OFF (innings-parquet) path; anchors must reproduce FROM BALLS.

## Approach (decided)
Approach B: reconstruct the innings-grain `batting`/`bowling` VIEWS from the 6 ball
files; leave `metrics.js`, `table.js` buildQuery, `filters.js` byte-identical. The
swap lives ONLY in the view definition, behind a flag.

- `src/ballEngine.js` (NEW) — `buildInningsViewSql(discipline, {files, windowPredicate})`
  generates the reconstruction SELECT. Faithful port of `export_parquet.py`
  `run_ball_layer_gates()` orx_bat/orx_bowl (the pipeline oracle, proven 0-mismatch),
  PLUS two additions needed to make the VIEW byte-identical to the EXPORT (not just
  gate-passing): `dismissal_kind` (deterministic MIN tie-break; measured 0 ambiguous
  groups) and odi_* NULL-for-Hundred wrapping. Emits the FULL 74-col batting / 71-col
  bowling schema (names + order + types) so it is a drop-in for the export parquet.
  `windowPredicate` is the Wave-3 hook — EMPTY/unused in 2a.
- Flag = `?engine=ball` URL param, read by `config.js ballEngineEnabled()`.
- `config.js` — added the 6 `deliveries_*` files to PARQUET_FILES (registered either
  way); `ballEngineEnabled()` helper.
- `db.js` — when the flag is ON: `batting`/`bowling` views come from ballEngine;
  `matchup_batting`/`matchup_bowling` STAY on the innings parquet (Wave 2b). Flag OFF
  = today's behaviour, zero change.

## Perf decision — SCOPED files (measured, native DuckDB)
Static view over all 6 ball files re-aggregates 11.3M balls per query and the scope
filter does NOT prune through the ANY_VALUE aggregation → **21-23s warm** (unusable).
Reading only the in-scope gender+format file(s) → **~3s warm** (7x), identical result
(2,813 / Karanbir 2,454). So the ball-engine views are (re)created SCOPED to the
gender+format the query actually asks for. Implemented self-contained in db.js:
`scopeFilesFromSql()` derives the file subset from the query's own `gender='…'` +
`match_type IN (…)` literals (UNION semantics → never under-reads; any parse
uncertainty → all 6 files = correct, just slower). A `batting`/`bowling` query
recreates those two views (cheap DDL) for its scope only when the file set changes.
Fine-grained load tuning stays backlog #14.

## Perf follow-up — SCOPE PUSHED INTO BASE (required)
File scoping alone still OOM'd DuckDB-WASM (~3.1 GiB ceiling, no disk spill): the
reconstruction over a whole file's history is too heavy. FIX: db.js also pushes the
query's CORE-SCOPE predicate (gender / match_type / team_type / match_date, lifted
VERBATIM from the query's WHERE) into the base ball CTE via a new `scopePredicate`
param on buildInningsViewSql. Byte-identical (those cols are per-innings-constant, so
it only drops WHOLE out-of-scope innings the outer WHERE discards anyway) and it is
the memory + row-group/file pruning lever (design doc's #1 lever). `scopeForQuery(sql)`
in db.js (exported, pure, harness-reused) derives {files, scopePredicate}; MATERIALIZED
CTE hint tested — no effect (cost is the aggregation/joins in WASM, not the base scan).

## Verification — COMPLETE, byte-identical
- VIEW-LEVEL (native DuckDB, `data/wave1_out`): the reconstruction VIEW (the REAL
  ballEngine.js output) == shipped export parquet CELL-BY-CELL — batting 421,955 rows /
  74 cols / 0 mismatches; bowling 291,001 / 71 / 0 (incl. dismissal_kind + odi-NULL).
- buildQuery-LEVEL harness (offline, REAL buildQuery + REAL scopeForQuery scoping):
  **45 scenarios, 0 mismatched cells/rows** — both genders; T20/50-over/Red-ball + mixes
  (real ODI data exercised); 3 date windows; intl/club/both; profile/position/opposition/
  team/search/pin/match-context filters; stat conditions; sort variants; the matches
  secondary query; every column family (core/compo/prog/phaseT20/phaseODI/dismissals/
  milestones/r_pos/fielding/wkt-types/bowling-phases).
- Flag OFF: boots clean, anchors on screen (2,813 / Karanbir 2,454 / SA Yadav
  60·1,544·29.13·150.34), 0 console errors.
- Flag ON: anchors reproduce ON SCREEN from balls (identical leaderboard), 0 console
  errors; independent in-browser DuckDB aggregation from balls = 2,813 / Karanbir 2,454 /
  SKY 60·1,544·29.13·150.34.
- Empirical facts: dismissal_kind 0 ambiguous groups; odi-NULL rows = Hundred rows
  exactly (bat 4,909 / bowl 3,863); scope cols constant per innings.

## PERF (measured, DuckDB-WASM, warm) — the key open risk
Anchor leaderboard (Men/T20/Intl/2023+) flag-ON ≈ **~19 s warm** vs flag-OFF ≈ **~0.2 s**.
Compute-bound (WASM ~6× native; the reconstruction re-aggregates ~1M balls with the
crease UNION + UNNEST + 7 GROUP BYs + 6 joins). Usable-but-slow; load-speed is backlog
#14 and MUST land before Wave-4 cutover (pre-aggregate caches, a lighter reconstruction,
or a WASM memory/threads tune). Flag is OFF by default → production unaffected.

## Graphs / popup boot (flag ON)
Player popup opens + header/profile/scope line render, 0 console errors (body loads
slowly per the perf note). Graphs tab: <pending final screenshot>.

## LEFT TO DO before hand-off
1. Confirm Graphs tab boots (flag ON) with 0 errors.
2. REVERT the temp DATA_BASE_URL override in config.js back to
   "https://data.the-cordon.com/explorer/"; remove the throwaway ./explorer symlink.
3. `node --check` (done: ballEngine/db/config OK); commit wip on ball-layer staging
   ONLY src/ballEngine.js src/db.js src/config.js + this note by explicit path.

## Gotchas for successors
- 208 super-over balls sit in the anchor scope — base CTE MUST `NOT is_super_over`.
- The ~4,450 zero-ball crease rows come from the non_striker/player_out/wickets_extra
  union; without it the leaderboard count is 3,012 not 2,813.
- CAST reverse clocks before `rev-1` (Wave 3; not used in 2a).
- Do NOT push or run the pipeline. Ball files aren't deployed; production stays flag-OFF.
