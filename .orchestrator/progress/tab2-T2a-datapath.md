# T-2a — Filters tab DATA PATH + RENDERING (progress)

Branch `ball-layer`, main working tree. NO git (orchestrator commits). Flag-OFF proofs vs R2.

## Approach (stated for the record)
- Row model: `{ id, scope:{formats,dateFrom,dateTo,teamType}, conditions:{op,groups}, pinned }`.
  Per-row opponent/window (ball-engine module globals) DELIBERATELY absent — T-2b.
- Per-row query: build a COMPLETE CLEAN state from `createInitialState()` (not a `{...pageState}`
  clone — header-search pop-ups pass a MINIMAL 5-field pageState that would crash buildQuery),
  seed ONLY the core scope (gender/formats/dateFrom/dateTo/teamType) from pageState, override with
  the row's per-row scope + tab discipline + row `advanced`. Then `buildQuery(rowState, cols)`
  UNCHANGED → outer-wrap `SELECT * FROM (${sql}) t WHERE id='X'` (charts.js:59 / benchmark.js:166
  idiom) → db.query. matchesSql handled with the same wrap+merge the leaderboard uses.
- Columns: tab-INDEPENDENT state (decision 3), seeded from `defaultColumnsFor(discipline,formats)`;
  `createColumnsPicker` reused + a small instant preset select (COLUMN_PRESET_DEFS/activePresetKey).
- Row label = first condition in LITERAL operator form (adapted from pills.js conditionPillLabel).

## KEY RISK / doubt (flagging per brief)
- buildQuery's advanced conditions compile to **HAVING** (a player-level GATE), not a per-innings
  WHERE. So a condition row like "Innings Score >= 100" GATES the player (keep his FULL aggregate,
  or drop to "—"); it does NOT slice to his 100+ innings. The design's headline reading
  ("SR when scoring 100+ vs SR when <=120 as two rows") needs a per-INNINGS WHERE slice, which
  buildQuery-unchanged cannot produce. Genuine per-innings slicing under T-2a is only the per-row
  scope override (format/date/team-type = WHERE). Needs an owner/orchestrator decision for T-2b.

## Status — COMPLETE + VERIFIED (flag-off vs R2)
- [x] module written (src/playerFiltersTab.js, 413 lines; styles.css +57)
- [x] node --check OK; only playerFiltersTab.js + styles.css + this note changed
      (config.js / table.js / columnsPicker.js / playerPage.js UNTOUCHED)
- [x] no-filter byte-identity: SA Yadav Filters-tab Row 1 = 64/60/1,544/29.13/150.34/100/142/80
      == his leaderboard row (rank 11) == independent raw (inns 60, runs 1,544). EXACT.
- [x] filtered-row independent DuckDB check (COUNT FILTER, not the app's SUM CASE):
      SA Yadav runs>=100 innings = 1 (HS 100). HAVING gate via buildQuery UNCHANGED:
      "Innings Score>=100" count>=1 -> KEPT (full 60/1,544); count>=2 -> DROPPED. Matches C=1.
- [x] bowling no-filter row byte-identical to raw (1 inns / 2 wkts / 2.50 / 5.00 / SR 3.00 / 2-5)
- [x] Add Filter Row placeholder adds a "No conditions" row; preset select + Columns picker
      reused (independent column state; leaderboard columns unaffected); per-discipline column memory
- [x] 0 console errors across boot + all interactions
