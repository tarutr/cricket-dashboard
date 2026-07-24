# Wave 6 (part 1) — match-context data + query + five filters

Branch: polish-b1-mechanical. Owner-approved design: `.orchestrator/wave6-design.md`.

## Verified data facts (source DB, read-only)
- `result_type LIKE 'tie (%)'` → 108 rows (super-over ties). All 108 parse cleanly:
  parsed team ∈ {team_1, team_2}, 0 mismatches.
- plain `'tie'` = 92; `'draw'` = 1017; `'no result'` = 485; `winner` set = 20527.
- `winner` and `result_type` are MUTUALLY EXCLUSIVE (0 rows have both) → match_winner CASE is clean.
- `team_batting_first`: 22228/22229 matches have an innings_number=0 (1 match `1512915`
  is a no-result T20 with no innings 0 → team_batting_first NULL there). 0 dup innings-0.
  No innings_number=0 row is a super_over.
- toss_winner / toss_decision / season: 0 NULLs. event_stage 53 distinct (free text).
- method: D/L 984, VJD 5, Awarded 4, Lost fewer wickets 1, NULL 21235.

## Plan
1. DATA: export_parquet.py sql_matches() — additive columns + derived + gates. [done-marker below]
2. QUERY: table.js buildQuery + buildMatchupQuery — LEFT JOIN matches (collision-safe
   subquery alias `mctx`) when any context filter active; clauses in filters.js.
3. STATE: state.js keys + active helpers + option constants; table.js serializeQueryState.
4. UI: drawerInnings.js editors, drawer.js "Match context" optgroup, pills.js, describeScope.

## Ambiguity flagged (report to owner)
- "Knockout" shortcut = "non-group stages" is under-specified: event_stage is free text with
  53 values incl. round-robin "Super League/Sixes/Eight/Four" and data-error 'T20'/'ODI'.
  Implemented the raw event_stage multi-select (fully correct) + a keyword-based Knockout
  convenience; the exact group/knockout taxonomy needs owner confirmation.

## Status — COMPLETE (committed 293f575, wip)
Files: export_parquet.py (sql_matches + run_gates oracle), src/state.js, src/filters.js,
src/table.js, src/drawer.js, src/drawerInnings.js, src/pills.js. Progress note here.
config.js was TEMPORARILY pointed at local /tmp/export_w6 data for the browser boot test,
then REVERTED to R2 (not committed).

### Verified
- Byte-identical matches.parquet 14 shared cols (EXCEPT both ways = 0, row order preserved);
  new schema = 27 cols. Other 8 parquets byte-identical vs baseline (HEAD) export.
- Emitted buildQuery/buildMatchupQuery SQL byte-identical to HEAD across 8 states when NO
  context filter active (node harness diff = IDENTICAL).
- Data oracle (gates PASS): is_super_over==108; match_winner==winner (regulation),
  ∈teams (super over), NULL (true tie/draw/no-result); team_batting_first==innings-0; season present.
- Per-filter independent DuckDB recompute (batting+bowling+matchup): won/lost/knockout/exclDL/
  toss-won+bat/batted-first/bowled-first/won-or-tied/super-over/matches-col — ALL 15 PASS.
- Anchors reproduce: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34 / Bumrah vs RHB
  pos1-2 27·177·9. Reproduced again LIVE in-browser.
- Browser: 0 console errors; "Match context" group + 6 filters in both Stats & Graph pickers;
  applied Result=Won live -> 1,998 rows, pill shows, SA Yadav -> 48·1277 (won-only). matches.parquet
  269,694 -> 409,732 bytes (+140KB).

### Flag: "Knockout" shortcut taxonomy needs owner confirmation (see report).
