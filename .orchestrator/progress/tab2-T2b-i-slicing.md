# T-2b-i — per-innings SLICING ENGINE (progress)

Branch `ball-layer`, main working tree. NO git (orchestrator commits).
Numbers-critical (CLAUDE.md Rule 1). Flag-OFF proofs vs R2; flag-ON via local ball snapshot only.

## Goal (from brief)
Make the Filters-tab conditions apply as PER-INNINGS WHERE SLICES (not the leaderboard's
player-level HAVING gate) for the ✅ filter set. Build PotM (Y/N). Thread per-row
opponent/window off the module globals. buildQuery UNCHANGED for existing callers.

## Design decisions (grounded in code)
- **Injection mechanism:** `buildQuery(state, cols, { inningsWhere })` — a 3rd optional opts
  arg. `inningsWhere` is a raw SQL predicate AND-ed into the plain-path WHERE
  (`(whereSql) AND (inningsWhere)`), and it flips `inningsLevel` true so a visible "matches"
  column switches to COUNT(DISTINCT match_id) over the sliced innings (honest). Absent/empty
  ⇒ finalWhereSql === whereSql, inningsLevel unchanged ⇒ BYTE-IDENTICAL for every existing
  caller (all pass 2 args; verified: buildQuery callers at table.js:2746, graph/*, players.js
  all 2-arg). Matchup path (buildMatchupQuery) does NOT take inningsWhere (the tab never
  combines a per-innings slice with a Vs in this wave).
- **conditionToInningsWhere (playerFiltersTab.js):** per-discipline map metricKey → per-innings
  SQL expr (the metric's aggregate with SUM() stripped, mirroring metrics.js exactly), then
  `(<expr>) <op> <value>`. Rates use NULLIF (div-by-0 → NULL → excluded) with NO `<>0` guard —
  per-innings 0 IS real data (unlike §8.1's aggregate rule). Booleans (Ducks/Not Outs/
  dismissal-type/PotM) carry an explicit yes/no predicate each (no NULL pitfalls).
- **Condition shape (canonical for T-2b-ii):** numeric `{metricKey,operator,v1,v2}`
  (operator gte/lte/eq/between); boolean `{metricKey, yn:true|false}`. Thresholds
  (innings_score_ge→runs, wicket_hauls_ge→wickets) use the SAME numeric shape (v1=threshold),
  NOT the leaderboard's n+count shape. The tab NEVER routes conditions through HAVING
  (rowState.advanced stays empty).
- **PotM (Y/N):** reuses the pom_cte join AT THE WHERE LEVEL — a correlated EXISTS on
  player_matches: `EXISTS(SELECT 1 FROM player_matches pm WHERE pm.match_id=<view>.match_id
  AND pm.player_id=<view>.<idcol> AND pm.player_of_match=1)` (Yes) / NOT EXISTS(…=1) (No).
  Composable with Team/date automatically (outer innings already scoped). Pop-up ONLY;
  leaderboard PotM Count untouched.
- **Per-row opponent/window (db.js):** `query(sql, { deliveryWindow, opponentPlayer })` — a 2nd
  optional opts arg. Effective spec = opts (if key present) else module global; stored per-SQL
  in `pendingEngineSpecs` so `windowPredicateFor(discipline, spec)` and widenForPendingQueries
  compute each in-flight query's OWN predicate. Existing callers pass no opts ⇒ spec = globals
  for all ⇒ byte-identical. Tab-2 rows pass explicit {null,null} (or their own spec) so they
  never inherit the leaderboard's global window/opponent.

## Status — CODE DONE; flag-off VERIFIED EXACT; flag-on threading pending
- [x] table.js buildQuery inningsWhere injection (additive)
- [x] playerFiltersTab.js conditionToInningsWhere + re-seed + wire
- [x] db.js per-call opponent/window threading (additive)
- [x] node --check all touched files (all OK)
- [x] flag-off R2: leaderboard anchors 2,813 / Karanbir 2,454 ✓ (on screen)
- [x] flag-off R2: no-filter row == leaderboard (SKY 64·60·1,544·29.13·150.34·HS100·142·80) ✓
- [x] flag-off R2: Innings Score ≥100 → 1·1·100·100.00·178.57·100·7·8 == independent DuckDB ✓
      (his ONE century innings, NOT the full record — THE KEY NEW PROOF)
- [x] flag-off R2: Innings Score ≥50 → 12·12·849·106.13·178.74·100·82·48 == independent DuckDB ✓
- [x] flag-off R2: PotM=Yes → 5·5·405·101.25·186.64·100·44·22 == independent DuckDB (SKY 5 PotM) ✓
- [x] 0 console errors across boot + search + pop-up + Filters tab
- [ ] flag-on local snapshot: opponent threading; REVERT config.js

Independent GT (raw batting-view queries, NOT buildQuery shape), SKY 271f83cd, T20/Intl,
2023-07-01..2026-07-02: nofilter 60/1544; ge100 1/100 (avg100, SR178.57); ge50 12/849
(avg106.125, SR178.74); PotM-yes 5/405 (avg101.25, SR186.64); PotM count=5, appeared in 64 matches.
The tab's MAT for sliced rows = COUNT(DISTINCT match_id) over sliced innings (1/12/5) —
inningsLevel switch confirmed; no-filter MAT=64 stays player_matches-sourced.
