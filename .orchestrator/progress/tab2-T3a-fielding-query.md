# Tab-2 T-3a — Fielding-mode QUERY ENGINE (no UI) — progress

Branch `ball-layer`. data-engineer (Opus). Numbers-critical. NO git (orchestrator commits).

## Scope (owner Option A, decision context in build-plan Wave D / T-3)
Fielding = a THIRD discipline where each row slices the player's FIELDING record
(`fielding_events`, view `fielding`, joined by fielder_id) — independent of batting/
bowling innings. T-3a = the QUERY ENGINE only (buildRowState/fetchRow fielding path +
seeded rows). Discipline control, editors, columns/render = T-3b.

## Key facts established
- `fielding_events.parquet` IS on production R2 (manifest lists 9 files incl. it).
  View `fielding` is registered UNCONDITIONALLY (db.js VIEWS) — NOT ball-engine-gated.
  ⇒ fielding query works flag-OFF against R2; no config.js change, no local snapshot.
- fielding_events cols: match_id, innings_number, over_number, fielder_id, fielder_name,
  match_type, gender, team_type, match_date, venue, city, event_name, fielding_team,
  opposition, kind, out_batter_id, out_batting_position (BIGINT), out_hand, out_role,
  bowler_id, bowler_style, phase, substitute.
- kinds present: caught / run out / caught and bowled / stumped.
- Sacred machinery reused UNCHANGED: table.js `buildFieldingCteSql` (per-fielder CTE:
  catches [incl c&b] / caught_and_bowled / stumpings / run_outs, GROUP BY fielder_id,
  scope+slice+`substitute IS NOT TRUE`), `buildFieldingSliceClauses` (positions/kinds/
  phases), filters.js `buildScopeClausesTagged` + `whereWithPinExemption`.

## Design
- New `buildFieldingRowQuery(state)` in playerFiltersTab.js: `WITH <buildFieldingCteSql>,
  <fld_matches_cte>` then SELECT fld_player_id AS id, catches, caught_and_bowled,
  stumpings, run_outs, (catches+stumpings+run_outs) AS dismissals_effected, matches.
  fetchRow outer-wraps `WHERE id='<player>'` (established idiom).
- fld_matches_cte = COUNT(DISTINCT match_id) GROUP BY fielder_id, WHERE built from the
  SAME exported primitives buildFieldingCteSql uses (identical scope by construction;
  buildFieldingCteSql can't be modified to carry match_id). Coupling documented.
- buildRowState + fetchRow branch on discipline === "fielding".
- Match-CONTEXT scope (Stage/Result/Toss) NOT honored — buildFieldingCteSql doesn't join
  `matches`; mirrors leaderboard fielding column. Flagged for T-3b.

## Files touched (edits on disk; orchestrator commits)
- src/playerFiltersTab.js — ADDITIVE ONLY:
  - imports: buildFieldingCteSql/buildFieldingSliceClauses (table.js) + buildScopeClausesTagged/
    whereWithPinExemption (filters.js).
  - new exports: FIELDING_TALLY_KEYS, buildFieldingRowState, buildFieldingRowQuery,
    fetchFieldingRow, makeFieldingRow, seedFieldingRows.
  - buildRowState + fetchRow: guard `if (discipline === "fielding") …` BEFORE the batting/
    bowling path (batting/bowling untouched; guard never reached by today's UI, which only
    passes batting/bowling — fielding is exercised via the exported builders / T-3b).
- NO other files touched. table.js / filters.js / metrics.js / config.js UNCHANGED. Sacred
  builders (buildQuery / buildMatchupQuery / conditionToHaving / buildFieldingCteSql) UNTOUCHED.

## VERIFICATION — ALL PASS (independent DuckDB over fielding_events + R2 via app)
Test fielder JC Buttler (99b75528), Men/T20/International, 2023-07-01→2026-07-02.
- No-filter row == independent raw count (FILTER-shape, NOT the app's CTE shape):
  catches 33 / c&b 0 / stumpings 10 / run_outs 11 / dis_eff 54 / matches 33. EXACT (local + R2).
- pos {1,2,3} slice == independent: 13 / 0 / 5 / 3 / 21 / matches 18. EXACT.
- kinds {stumped} slice: 0 / 0 / 10 / 0 / 10 / matches 9. Consistent.
- C&B path (F Banunaek 3c8faed4): catches 44 INCL 5 c&b; caught_and_bowled 5. (c&b counts as catch.)
- Rules confirmed: substitute IS NOT TRUE excludes subs (no NULLs in col); run-out = one row per
  fielder credit (multi-fielder run-outs → both counted).
- Cross-ref leaderboard's OWN buildQuery fielding column, JC Buttler: 33/10/11/54 — IDENTICAL to
  the fielding-mode no-filter row (same sacred CTE).
- Leaderboard anchors byte-identical: 2,813 players / Karanbir 2,454. Pop-up batting anchor
  SA Yadav 60·1544·29.13·150.34 (batting path undisturbed).
- node --check clean (playerFiltersTab/table/filters); app boots 0 console errors; config.js clean
  (never touched — fielding_events already on production R2).
- matches-CTE WHERE printed BYTE-IDENTICAL to the sacred fielding_cte WHERE (same primitives).

## Open notes / flags for T-3b (design)
- Match-CONTEXT scope (Stage / Match Result / Toss) NOT honored by the fielding source
  (buildFieldingCteSql doesn't join `matches`) — mirrors the leaderboard fielding column. Offering
  them would require touching the sacred CTE. Owner/design call.
- `phases` is still machinery-valid (buildFieldingSliceClauses emits phase IN (…)); whether to
  OFFER it given the phase-filter retirement is a T-3b question.
- Perf: buildFieldingRowQuery aggregates ALL fielders then the wrap filters one (leaderboard
  pattern). Fine for correctness; a fielder_id push-down is a later optimisation (T-4).
- Display/columns/preset/discipline-control for fielding = T-3b (fielding metrics live in the
  batting/bowling namespaces, not a "fielding" one — T-3b resolves render).

## Status: COMPLETE + VERIFIED
