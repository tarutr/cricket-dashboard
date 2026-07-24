# graphfix-fielding — chart fielding + PoM metrics in the Graph Builder

Branch: `polish-b1-mechanical`. No push/merge. Additive fix; numbers-sacred.

## Bug
Graph Builder's bespoke per-player fetch (`fetchSelectedPlayerMetrics` in
`src/graph/charts.js`, used by bar / scatter / grouped-bars) interpolated each
metric's `sqlExpression` into its own SELECT over the plain batting/bowling view.
Fielding-event metrics (catches/stumpings/run_outs/dismissals_effected) and Impact
(player_of_match) have `sqlExpression = MAX(fielding_cte.…)` / `MAX(pom_cte.…)`,
but the FROM never defined those CTEs → DuckDB binder error whenever any of the 5
was charted in those types.

## Fix (make them chartable, no hiding)
- `src/table.js`: EXTRACTED the fielding_cte and pom_cte construction (was inline
  in `buildQuery`) into two exported helpers `buildFieldingCteSql(state)` /
  `buildPomCteSql(state)`, verbatim (pins read from state — same filter buildQuery
  applies). `buildQuery` now calls them. Also `export`ed the detection predicates
  `isFieldingEventMetric` / `isPomMetric`. Single source of truth → the Stats
  table and the graph can never build a divergent CTE.
- `src/graph/charts.js` `fetchSelectedPlayerMetrics` (PLAIN branch only): detect
  fielding/pom need via the shared predicates, push the shared CTE(s) into a
  `WITH` prefix, and add the matching `LEFT JOIN … ON …fld_player_id/pom_player_id
  = <idCol>` — mirroring buildQuery's FROM assembly. When no fielding/pom metric
  is selected, `cteDefs` is empty, no `WITH`, `fromSql` stays the bare view → SQL
  byte-identical to before.
- The matchup ("Vs") branch is untouched (already routes through buildQuery).
- `fetchWindowMetric` (slope) and benchmark.js's `fetchBenchmarkPool` already use
  buildQuery directly → got the CTEs for free; no change needed. timeseries.js
  excludes fielding via `source !== "innings"` (per wave-fielding-rebuild note) →
  not affected. `players.js` seed uses buildQuery; searchPlayers selects only
  id/name/COUNT(*) → not affected. So `fetchSelectedPlayerMetrics` was the ONLY
  sibling with the broken topology.

## MUST NOT — honored
buildQuery/buildScopeClauses/buildMatchupQuery SEMANTICS unchanged; no metric
formula touched; export_parquet.py + presets untouched. Existing non-fielding
charts stay byte-identical.

## Verified (offline, node harnesses in scratchpad)
- buildQuery emitted SQL BYTE-IDENTICAL before/after extraction across 22 scenarios
  (plain/fielding/pom/pins/search/opposition/teams/slice pos+kind+phase/positions/
  r_pos/matches/event+venue/fielding-condition-no-col/pom-condition/col+condition):
  `diff baseline_before.json baseline_after.json` → no diff.
- charts.js OLD vs NEW algorithm: byte-identical for 9 non-fielding sets (runs bar,
  SR+avg scatter, batting phases, bowling eco, matches, +opp/+teams/+positions/
  +search); fielding/pom sets (6) now emit the correct CTE+JOIN. catches-bar CTE
  body == buildQuery's fielding_cte body (identical string).
- `node --check` src/table.js + src/graph/charts.js OK.

## Browser verification — DONE (localhost:8000; local parquet w/ fielding_events
built via scratchpad DB copy + build_profiles.py → export_parquet.py --out /tmp/gfix;
config.js DATA_BASE_URL temporarily → /gfix_data/, REVERTED after). 0 console
messages (not just 0 errors) throughout.
- Anchors intact: 2,813 players; Karanbir 2,454; SA Yadav 60/1,544/29.13/150.34;
  Waseem 1,978. (query builders unchanged — confirmed on screen.)
- Independent DuckDB recompute over the `fielding` view (hand-written, NOT via
  buildQuery), anchor scope Men/T20/Intl 2023-07-01..2026-07-02: top catchers
  Ahmad Ramdoni 52 / Waseem 51 / Muniandy 47 / Liton Das 40.
- fetchSelectedPlayerMetrics (the fixed fn) for those ids: catches 52/51/47/40 ==
  independent; dismissals_effected 79/56/50/61 == independent; player_of_match
  1/8/0/3 == independent; runs alongside (scatter case) works.
- Stats table Catches column: Waseem 51 (== chart == independent).
- UI: Catches BAR renders (15 most-capped); all 15 plotted values == independent
  recompute by name (JC Buttler 33, Q de Kock 21, GJ Maxwell 20 … V Kohli 2,
  RA Jadeja 1). Player-of-Match BAR renders; all values == independent. Runs×Catches
  SCATTER renders (fielding on Y); 60 pts, maxCatches 40 (Liton Das), maxRuns 1691
  (S Raza). Non-fielding Runs BAR renders; all 15 values == independent recompute.
- node --check src/table.js + src/graph/charts.js OK.

## Status: COMPLETE. Committed wip cf48fff on polish-b1-mechanical. No push/merge.
Sibling fetch paths audited: only fetchSelectedPlayerMetrics had the broken
topology; fetchWindowMetric/benchmark.js/players.js seed all route through
buildQuery (CTEs for free); timeseries excludes fielding (source!="innings");
grouped-bars only offers innings-source phase families so fielding never reaches
it (my change is a no-op there).
