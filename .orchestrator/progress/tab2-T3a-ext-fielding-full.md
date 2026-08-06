# Tab-2 T-3a-ext — Fielding-mode QUERY, FULL filter set (no UI) — progress

Branch `ball-layer`. data-engineer (Opus). Numbers-critical. NO git (orchestrator commits).

## Task
Extend the fielding-mode query (built in T-3a) to the FULL fielding filter set as
WHERE dims on the fielding record, player-scoped. + a GENERIC data-driven option
loader `loadDimOptions` (no gender hardcoding). NO UI (that is T-3b).

## Architecture DECISION (numbers sacred)
- Tallies come from `buildFieldingCteSql` reused VERBATIM (unchanged code text). Its
  ONLY additive WHERE hook is `buildFieldingSliceClauses(state)` (it calls it). So
  ALL new dims reach the tallies through an ADDITIVE extension of
  buildFieldingSliceClauses — byte-identical when unset.
- Leaderboard byte-identity: the new dims live on NEW `state.fielding.*` sub-fields
  that the LEADERBOARD NEVER sets (it only ever sets positions/kinds/phases). So the
  extended buildFieldingSliceClauses returns byte-identical output for the leaderboard
  ⇒ buildFieldingCteSql byte-identical ⇒ leaderboard fielding column unchanged (even
  under active top-level Stage/Result/Toss, which the fielding source never read and
  still does not — the fielding match-context is a SEPARATE state.fielding.* namespace).
- Direct columns (plain WHERE on the `fielding` view): out_hand, out_role,
  out_batter_id, bowler_id, bowler_style, over_number (range), innings_number (0-based),
  city. + already-present kind/out_batting_position/phase.
- Match-context (fielding_events carries no match cols → reach `matches`):
  * Stage / Match Result / Toss result / Toss decision → REUSE the leaderboard's
    `buildMatchContextClauses` VERBATIM inside a correlated `EXISTS` on the fielding
    row's own match (`mctx.mctx_match_id = fielding.match_id`), player-relative
    Result/Toss comparing the fielder's own `fielding_team` — exactly like a
    batting/bowling row's team column. The mctx subselect is shared via a new
    `matchContextSubselectSql()` (matchContextJoinSql refactored to reuse it,
    byte-identical) so the column set can't drift.
  * Season → non-correlated `match_id IN (SELECT match_id FROM matches WHERE gender AND
    season IN (...))`, mirroring event/venue semi-joins.
- Scope already honored by buildFieldingCteSql via TOP-LEVEL state (matches leaderboard
  behavior — no change): core (gender/format/date/team_type), Opposition, Event, Venue,
  Team (fielding_team). Threaded in buildFieldingRowState as before. Innings Number is
  the exception (buildScopeClausesTagged skips it for fielding_team, not in
  INNINGS_GRAIN_TEAM_COLS) → routed via state.fielding.inningsNumbers instead, so the
  leaderboard fielding column keeps ignoring innings number (unchanged).

## Files touched (edits on disk; orchestrator commits) — ALL ADDITIVE
- src/filters.js: NEW export `matchContextSubselectSql()`; matchContextJoinSql refactored
  to reuse it (BYTE-IDENTICAL output — verified).
- src/table.js: `buildFieldingSliceClauses` extended to append `buildFieldingExtraSliceClauses(state)`
  (byte-identical when the new sub-fields are unset); NEW export `buildFieldingExtraSliceClauses`.
  Import of matchContextSubselectSql added.
- src/dimOptions.js (NEW): generic reusable `loadDimOptions(source, column, scope)` → distinct
  non-null values within the SAME core scope the queries use (buildCoreScopeClauses). Empty ⇒
  data-driven hide. No gender hardcode.
- src/playerFiltersTab.js: state.fielding passes the new sub-fields through (no logic change to
  buildFieldingRowState); makeFieldingRow/seedFieldingRows carry the new dims; NEW thin
  `loadFieldingDimOptions` convenience re-exporting loadDimOptions; doc/comments updated.
- table.js buildQuery/buildMatchupQuery/conditionToHaving/buildFieldingCteSql UNTOUCHED.

## Data facts established (DuckDB CLI over data/wave1_out — the R2-matching ball snapshot)
- JC Buttler (99b75528) Men/T20/Intl 2023-07-01..2026-07-02 baseline: catches 33 / c&b 0 /
  stumpings 10 / run_outs 11 / matches 33 → dis_eff 54. MATCHES the T-3a anchor exactly.
- innings_number 0-based {0,1}; over_number 0-based {0..19} (T20). fielding_events has NO
  season col → Season via matches join. matches has match_winner/toss_winner/toss_decision/
  event_stage/season/is_super_over/method.
- DATA-DRIVEN proof: MEN out_hand → {Right-hand bat, Left-hand bat}, out_role → 9 values,
  bowler_style → 17 values. WOMEN out_hand/out_role/bowler_style → 0 distinct non-null (all
  NULL) ⇒ loadDimOptions returns [] ⇒ T-3b hides those filters. No gender hardcode anywhere.

## VERIFICATION (DuckDB CLI over data/wave1_out) — ALL PASS
Faithful harness: calls the REAL exported builders (table.js buildFieldingCteSql WITH the
extended slice clauses; playerFiltersTab.js buildFieldingRowQuery) and diffs each result
against an INDEPENDENT hand-written FILTER-shape count (different aggregation shape). Player
JC Buttler (99b75528), Men/T20/Intl, 2023-07-01..2026-07-02. Every app==ind (ct/cb/st/ro):
- byte-identity: matchContextJoinSql identical across batting/bowling/matchup/fielding (5/5).
- tallies (buildFieldingCteSql, 18 slices): baseline 33/0/10/11; pos_123 13/0/5/3; hand_left
  11/0/1/4; role_wk 9/0/4/3; bstyle_spin 7/0/10/1; innings_2nd 15/0/2/0; overs_death 11/0/3/8;
  result_won 26/0/6/4; result_lost 7/0/3/5 (won+lost catches = 26+7 = 33 baseline ✓);
  tossresult_won 23/0/6/7; tossdec_bat 7/0/6/4; stage_semi 1/0/1/1; season_2526 6/0/4/3;
  bowler_rashid 3/0/6/0; batter_pandya 2/0/0/1; city_bridge 3/0/1/1; combo_left_death 3/0/0/2.
- end-to-end buildFieldingRowQuery (tallies + fld_matches_cte "matches" + dismissals_effected):
  baseline 33/10/11/54 mt33; bstyle_spin 7/10/1/18 mt15; result_won 26/6/4/36 mt24; season_2526
  6/4/3/13 mt9 — all == independent (the correlated EXISTS + season semi-join resolve in the
  matches CTE's own `FROM fielding` too).
- Leaderboard byte-identity by construction: leaderboard never sets the new state.fielding.*
  sub-fields ⇒ buildFieldingExtraSliceClauses returns [] ⇒ buildFieldingSliceClauses byte-
  identical. (Browser anchor recheck pending.)

## DATA-DRIVEN loader proof (DuckDB CLI) — pending browser confirm of loadDimOptions itself
Distinct NON-NULL values, gender-scoped (what loadDimOptions returns): MEN out_hand →
{Left-hand bat, Right-hand bat} (2), out_role → 9, bowler_style → 17. WOMEN out_hand/out_role/
bowler_style → 0 (all NULL) ⇒ [] ⇒ T-3b hides. No gender hardcode.

## BROWSER VERIFICATION (against production R2, flag-off) — ALL PASS
(NB: a stale ES-module cache first showed the OLD table.js so a match-context slice read as
baseline — resolved by fetch(cache:'reload') + reload, the known CLAUDE.md gotcha, not a defect.)
- fielding view registered on R2 (243,475 rows). Extended fielding-mode query (real
  fetchFieldingRow) vs independent DuckDB, JC Buttler: result=won 26/6/4/36 mt24; bstyle_spin
  7/10/1/18 mt15; out_hand=Left 11/1/4/16 mt14; season=2025/26 6/4/3/13 mt9 — all EXACT.
- loadDimOptions (real helper vs R2): MEN out_hand {Left-hand bat, Right-hand bat}, out_role 11,
  bowler_style 16 → filter SHOWS; WOMEN out_hand/out_role/bowler_style all [] → filter HIDES.
  Data-driven, no gender hardcode.
- Leaderboard anchors byte-identical: buildQuery batting → 2,813 players / Karanbir Singh 2,454.
  Leaderboard FIELDING column (buildQuery, no fielding filter) JC Buttler 33/10/11/54 — unchanged.
- buildFieldingExtraSliceClauses returns [] for every leaderboard-style state (only positions/
  kinds/phases) ⇒ buildFieldingSliceClauses byte-identical ⇒ sacred buildFieldingCteSql unchanged.
- 0 console errors throughout. config.js untouched. node --check clean on all 4 files.

## Status: COMPLETE + VERIFIED (DuckDB CLI local + browser R2)
