# Wave 2s — ball engine SPEED (Layer 1 pruning + Layer 2 lean base & cache)

Branch `ball-layer`. Owner: decision 67, "SPEED PULLED FORWARD" bullet.
Design: `.orchestrator/ball-layer-design.md`; predecessor: `progress/wave2a-ball-engine.md`.
Numbers-sacred: the byte-identical guarantee survived every optimisation (re-proved 3×).

## STATUS: COMPLETE — all acceptance checks green.

## Problem (Wave 2a)
Flag-ON search ≈ 19.8 s warm vs ≈ 0.2 s flag-OFF. Two causes, one known and one found here:
the reconstruction rebuilt ALL 74 batting / 71 bowling innings columns on EVERY query when a
search reads ~8–18 of them and did `SELECT *` over the ball files (known); and it unnested the
`wickets_extra` overflow LIST twice over every ball in scope (found by profiling — see below).

## What shipped

### Layer 1 — query-shaped reconstruction
- NEW `src/ballColumns.js` — the FIXED vocabularies (74 batting / 71 bowling innings columns,
  41 ball columns) + `neededViewColumns(discipline, sql)` (the derivation rule) + the cache-set
  helpers (`coversColumns`, `unionColumns`, `sqlIdentifierTokens`).
- `buildInningsViewSql` gains `columns`: it emits only those output columns and only the CTEs /
  aggregates they need — `tinn` for team_inns_balls/team_rel_*, `disp` (per phase FAMILY) for the
  phase-dismissal columns, `dis` for dismissed/dismissal_kind, `posx` for batting_position, `wkk`
  (per KIND) for the wicket-type splits, `os`+`maid`/`bo` for maidens/team_rel_econ, `sp_agg`+`sp`
  for the spell columns, `tb`/`tw` for the bowling team-relatives, `is_hundred` only when an
  `odi_*` column is asked for. `columns` omitted/null = the FULL export schema (unchanged Wave-2a
  behaviour — the pipeline-oracle path).
- **DERIVATION RULE**: strip string literals, tokenise identifiers, intersect with the fixed
  vocabulary, always add keys+context. Superset-safe by construction: SQL cannot read a column
  without naming it. **FALLBACK**: any star expansion (`SELECT *`, `t.*`), `COLUMNS(...)` or
  `NATURAL JOIN` → the FULL set + a `console.warn` naming the construct (once per reason).
  `src/graph/timeseries.js` genuinely does `SELECT * FROM <ns>` for two Line x-dimensions, and
  the warn fires there exactly as designed.
- **ROW-SET RULE honoured**: pruning removes columns only. Batting's `app`/`crease` union (batter
  + non-striker + player_out + wickets_extra — the ~4,450 zero-ball crease appearances) and
  bowling's `bagg` grain are built identically whatever is pruned, so COUNT(*) innings never moves.

### Layer 2 — lean base projection + materialisation cache
- Base CTE `b` no longer `SELECT *`: it projects exactly the ball columns the emitted SQL
  references, derived by token-scanning the engine's OWN generated SQL against `DELIVERY_COLUMNS`.
  Even the FULL schema now drops 15 of 41 ball columns; a core batting leaderboard drops 20 of 41,
  and bowling drops the `wickets_extra` LIST entirely unless a wicket-type column is asked for.
- `db.js` materialises the reconstruction per signature
  `(discipline, files, scopePredicate, windowPredicate, columnSet)` into `__ball_<disc>_<n>` and
  points the view at it.
  - **REUSE**: same signature AND cached columns ⊇ needed → plain table scan (sorts, graph
    fetches, popup sections, no-new-column adds are then ~15–170 ms).
  - **MISS ON COLUMNS**: rebuild for the UNION of cached + needed, so alternating column sets
    converge instead of thrashing.
  - **INVALIDATION**: a scope change is a different signature and simply misses → a (now-fast)
    recompute, never a wrong answer. LRU cap 4; evicted tables DROPped; never the table a view
    currently reads.
  - **QUEUE-AWARE WIDENING**: bursts (a popup's section battery) fold in the column needs of the
    other queries already in the queue with the same scope → one build, not one per member.
- Flag-ON queries are serialised (the views are re-pointed per query, so two in flight would race
  the definition). Flag OFF is byte-untouched: no queue, no engine, straight to the connection.

### THE BIG FIND — `UNNEST(wickets_extra)` cost 6.0 s per use
Profiling CTE-by-CTE in DuckDB-WASM: a bare `FROM b, UNNEST(b.wickets_extra)` over the 385k-ball
anchor scope takes **~6.0 s**, and Wave 2a did it twice (`app` + `dis`) — ~12 s of a ~12.4 s
reconstruction, to produce FOUR rows. New shared `wx` CTE unnests **once**, and only over rows
that actually carry an overflow list (`wickets_extra IS NOT NULL AND len(...) > 0`) — UNNEST of an
empty/NULL list yields no rows, so this is exactly value-preserving. Anchor-scope lean batting
reconstruction **12.4 s → 1.11 s**; whole-file native rebuild 21.3 s → 5.5 s.

### Safety nets
- A missed column can only surface as a DuckDB **Binder error**. `runQuery` catches it, warns
  loudly with the original message, rebuilds the planned views with EVERY column, retries once.
  Never silent, never a wrong number.
- A too-broad scope that exhausts the WASM 3.1 GiB ceiling now gets a plain-English message
  ("narrow the date range or pick a single format") instead of a raw allocator error.
- `windowPredicate` (Wave-3 hook) untouched; it lands in the base WHERE and needs no projection
  entry, so column pruning cannot interfere with it.

## VERIFICATION — byte-identical, 3 independent proofs
1. **Whole-file cell-by-cell** (native DuckDB over `data/wave1_out`): the FULL reconstruction ==
   the shipped export parquet — batting **421,955 rows / 74 cols / 0 bad cells**; bowling
   **291,001 / 71 / 0**; identical column names AND order; row keys EXCEPT both ways = 0.
2. **45-scenario buildQuery harness** (REAL `buildQuery` + REAL `scopeForQuery` + REAL
   `neededViewColumns`, flag-ON view vs flag-OFF parquet, cell-by-cell): **45 scenarios, 0
   mismatched cells/rows**, exercising 12 distinct pruned column-set shapes — both genders,
   T20/50-over/Red-ball + mixes, 3 date windows, intl/club/both, profile/position/opposition/
   team/search/pin/match-context filters, stat conditions, sort variants, the `matchesSql`
   secondary query, and every column family.
3. **PHASE 2 — the cache's superset-reuse rule**: all 45 re-run against per-scope UNION column
   sets (13 distinct scopes) — **0 mismatches**, i.e. extra materialised columns never change a
   value.

## ANCHORS — flag-ON, on screen (localhost:8000, 1280×800)
2,813 players · Karanbir Singh 2,454 runs · SA Yadav 64 mat / **60 inns / 1,544 runs / 29.13 avg /
150.34 SR**. Popup renders in full (by position, wicket types, progression, vs opposition).

**Independent hand-written DuckDB check** (decision-39 — my own SQL shape, straight off the
delivery parquet, never touching the batting/bowling views; a priority-CASE single GROUP BY
instead of the engine's 6 LEFT JOINs): players **2,813** (raw distinct ids **2,810** — the known
+3 name-variant quirk), Karanbir **2,454**, SA Yadav **60 inns / 1,544 runs / 1,027 balls / 53
dismissals → 29.13 avg / 150.34 SR**.

## TIMINGS (DuckDB-WASM, localhost:8000, Men/T20/International, 1280×800)
Wave 2a baseline for reference: **~19,800 ms per flag-ON search**.

| Action | flag ON | flag OFF |
|---|---|---|
| **UI cold FIRST search** (fresh page: network + compute + render) | **3,027 ms** | 1,020 ms |
| **Core leaderboard, anchor 3-yr, WARM** (query) | **136–169 ms** | 184–188 ms |
| Core leaderboard, 3-month window — first (new scope) | 213–236 ms | 108 ms |
| Core leaderboard, 3-month window — warm | 42–46 ms | 85 ms |
| Phases preset on the anchor scope — first (column widening → rebuild) | 1,522–1,561 ms | 196 ms |
| Phases preset — warm | 122–124 ms | 189 ms |
| Back to Core after Phases (hit on the widened table) | 160–162 ms | 230 ms |
| Stat condition (Innings ≥ 20) | 81–108 ms | 145–150 ms |
| Graph **Bar** fetch (2 players × 3 metrics) | **15–17 ms** | 62–73 ms |
| Graph Line update, x = innings sequence (`SELECT *` → full-set table), warm | 267 ms | — |
| Graph Line update, x = event / batting position, warm | 1,030–1,062 ms | — |
| Player popup battery (4 sections, its own no-gender scope) — first | 2,942 ms | 727 ms |
| Player popup battery — warm | 463 ms | 577 ms |
| **UI popup open** (full render) — cold, first ever for that scope | 4,975 ms | 981 ms |
| UI popup open (full render) — warm, 2nd player | 1,000 ms | 1,003 ms |
| Back to the leaderboard scope after the popup (LRU hit) | 115–140 ms | 177 ms |

**Target ≤1 s for the default Core leaderboard: MET (136–169 ms warm).** Warm flag-ON is now
FASTER than flag-OFF on most actions — the materialised table carries ~17 lean columns where
`batting_innings.parquet` carries 74.

Cost breakdown measured in isolation (anchor scope = 384,871 balls, `deliveries_m_t20.parquet`):
pure scoped scan 225–300 ms · lean batting reconstruction **1,110 ms** (was 12,390) · FULL
74-column batting reconstruction 1,967 ms · lean bowling 678 ms · bowling wicket-kind splits
(`list_filter` × 6) 954 ms. `WITH b AS MATERIALIZED` and an explicit base temp table both make
**no** difference (1,119 vs 1,091 ms) — the remaining cost is single-threaded WASM aggregation,
not I/O. The crease union alone is ~0.89 s of the 1.11 s.

## MEMORY — no OOM
`deliveries_m_red.parquet` = **5,420,064 balls** (the largest file). A BROAD scope (men,
Test+MDM, whole file, no date narrowing) completes: batting FULL columns **20.6 s**, bowling FULL
**20.7 s**, batting LEAN **9.4 s** — 108,126 batting / 61,391 bowling innings rows, **no OOM**.
JS heap stays ~6 MB (the WASM heap is not observable from JS).
The ONLY OOM found is all six files with NO scope predicate at all (3.1 GiB ceiling) — unreachable
from the app (a search always carries gender + format + the REQUIRED date range, so
`scopePredicate` is never empty), and now reported in plain English if it ever happens.

## CONSOLE — clean
Flag ON: 0 errors across Stats (search, sort, presets, stat conditions), Graphs (Bar + Line ×3
x-dimensions) and the player popup. The only engine output is one `info` at boot and the designed
`warn` for the `SELECT *` Line dimensions. Flag OFF: boots clean, anchors on screen, 0 errors.
`node --check` clean on `ballColumns.js`, `ballEngine.js`, `db.js`, `config.js`.

## Gotchas for successors
- Wave 2a's gotchas all still apply (super overs excluded in the base, the ~4,450 zero-ball crease
  rows, CAST reverse clocks before `rev-1`).
- **`wickets_extra` CANNOT be pruned from the BATTING base projection** — the crease union reads
  it, and dropping it would change the ROW SET (3,012 not 2,813). Prunable for bowling (only `wkk`
  reads it there).
- **Never reintroduce a bare `FROM b, UNNEST(...)`** — pre-filter to rows that have a list, and
  share one `wx` CTE. It is a 6 s/use trap in WASM.
- `src/graph/timeseries.js` `SELECT * FROM <ns>` (Line x = innings-sequence, and the event /
  venue / result "join" dims) forces the full-column rebuild. Rewriting those two builders to name
  their columns explicitly would make those charts as fast as the rest — outside this task's file
  ownership, so it is a suggestion, not a change.
- Harness lives in the session scratchpad: `gen_scenarios.mjs` (REAL buildQuery + scopeForQuery +
  neededViewColumns) → `scenarios.json` → `run_harness.py` (phase 1 pruned, phase 2 union), plus
  `dump_sql.mjs` + `verify_engine_sql.py` for the whole-file cell-by-cell proof, and
  `gen_union.mjs` for phase 2. Local flag-ON testing needs an `./explorer` symlink to
  `data/wave1_out` + a TEMP `DATA_BASE_URL` override in config.js (BOTH reverted/removed here —
  config.js is back on the R2 URL and the tree is clean).
