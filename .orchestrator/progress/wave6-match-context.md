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

## Status
- (in progress)
