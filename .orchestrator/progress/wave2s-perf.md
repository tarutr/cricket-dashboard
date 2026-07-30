# Wave 2s — ball engine SPEED (Layer 1 pruning + Layer 2 lean base & cache)

Branch `ball-layer`. Owner: decision 67, "SPEED PULLED FORWARD" bullet.
Design: `.orchestrator/ball-layer-design.md`; predecessor: `progress/wave2a-ball-engine.md`.
Numbers-sacred: the byte-identical guarantee must survive every optimisation.

## Problem (Wave 2a)
Flag-ON search ≈ 19.8 s warm vs ≈ 0.2 s flag-OFF. Cause: the reconstruction rebuilt
ALL 74 batting / 71 bowling innings columns on EVERY query (search, the Matches
secondary query, each graph fetch, each popup section, every column add) when a
search reads ~8–18 of them, and the base CTE did `SELECT *` over the ball files.

## What shipped

### Layer 1 — query-shaped reconstruction
- NEW `src/ballColumns.js` — the FIXED vocabulary (74 batting / 71 bowling innings
  column names, 41 ball columns) + `neededViewColumns(discipline, sql)`, the
  derivation rule, + the cache-set helpers (`coversColumns`, `unionColumns`).
- `buildInningsViewSql` gains `columns`. It emits ONLY the requested output columns
  and ONLY the CTEs/aggregates they need: `tinn` for team_inns_balls/team_rel_*,
  `disp` (per phase FAMILY) for the phase-dismissal columns, `dis` for
  dismissed/dismissal_kind, `posx` for batting_position, `wkk` (per KIND) for the
  wicket-type splits, `os`+`maid`/`bo` for maidens/team_rel_econ, `sp_agg`+`sp` for
  the spell columns, `tb`/`tw` for the bowling team-relatives, `is_hundred` only when
  an `odi_*` column is asked for. `columns` omitted/null = the FULL export schema
  (unchanged Wave-2a behaviour; the pipeline oracle path).
- ROW-SET RULE honoured: pruning removes columns only. Batting's `app`/`crease` union
  (batter + non-striker + player_out + wickets_extra — the ~4,450 zero-ball crease
  appearances) and bowling's `bagg` grain are built identically whatever is pruned,
  so COUNT(*) innings never moves.

### Layer 2 — lean base projection + materialisation cache
- Base CTE `b` no longer `SELECT *`: it projects exactly the ball columns the emitted
  SQL references, derived by token-scanning the engine's OWN generated SQL against
  `DELIVERY_COLUMNS`. Over-inclusion is harmless; under-inclusion impossible (SQL
  must name a column to read it, and none of the generated SQL uses a star).
  Even the FULL schema now drops 15 of 41 ball columns (is_super_over, ball_index,
  byes/legbyes/penalty, phase, bowler_credited, the rev clocks, …); a core batting
  leaderboard drops 20 of 41, and bowling drops the `wickets_extra` LIST entirely
  unless a wicket-type column is asked for.
- `db.js` materialises the reconstruction per signature
  `(discipline, files, scopePredicate, windowPredicate, columnSet)` into
  `__ball_<disc>_<n>` and points the view at it. Reuse = same signature AND cached
  columns ⊇ needed (so sorts, graph fetches, popup sections and no-new-column adds
  are plain table scans); a needed column the table lacks rebuilds for the UNION of
  the two sets (converges instead of thrashing). LRU cap 4, evicted tables DROPped,
  never the one a view currently reads. A miss is always a (now-fast) recompute,
  never a wrong answer.
- Flag-ON queries are serialised (`serializeEngineQuery`) because the views are
  re-pointed per query — concurrent callers would otherwise race the view definition.
  Flag OFF is byte-untouched: no queue, no engine, straight to the connection.

### Safety nets
- Derivation falls back to the FULL column set with a named `console.warn` on any
  star expansion / `COLUMNS(...)` / `NATURAL JOIN` — `src/graph/timeseries.js`
  genuinely does `SELECT * FROM <ns>` for two Line x-dimensions.
- A missed column can only surface as a DuckDB Binder error. `runQuery` catches it,
  warns loudly with the original message, rebuilds the planned views with EVERY
  column, and retries once. Never silent.
- `windowPredicate` (Wave-3 hook) untouched; it lands in the base WHERE and so needs
  no projection entry.

## STATUS
- [x] Layer 1 + Layer 2 implemented; `node --check` clean on all touched files.
- [x] Full-schema reconstruction still CELL-FOR-CELL identical to the shipped
      parquet with the lean projection: batting 421,955 rows / 74 cols / 0 bad
      cells; bowling 291,001 / 71 / 0 (native DuckDB, `data/wave1_out`).
- [x] 45-scenario harness re-run WITH pruning active — 0 mismatched cells/rows
      (12 distinct column-set shapes exercised); PHASE 2 re-runs all 45 against
      per-scope UNION column sets (the cache's superset-reuse rule) — also 0.
- [ ] Browser: anchors flag-ON, timing table, memory, zero console errors.

## Gotchas
- Wave 2a's gotchas all still apply (super overs, the zero-ball crease rows, CAST
  before `rev-1`).
- `wickets_extra` CANNOT be pruned from the BATTING base projection — the crease
  union reads it, and dropping it would change the ROW SET (3,012 not 2,813). It is
  prunable for bowling (only `wkk` reads it there).
- Harness lives in the session scratchpad: `gen_scenarios.mjs` (REAL buildQuery +
  REAL scopeForQuery + REAL neededViewColumns) → `scenarios.json` → `run_harness.py`
  (phase 1 pruned, phase 2 union/superset), plus `dump_sql.mjs` +
  `verify_engine_sql.py` for the whole-file cell-by-cell proof.
