# Wave 3 — Fielding + Impact (player_matches columns + buildQuery join + metrics + picker)

Branch: `polish-b1-mechanical`. Additive only. Wave-3 authorizes ONE new query-layer
join (the fielding LEFT JOIN in table.js buildQuery). buildScopeClauses / buildMatchupQuery
semantics for existing columns UNCHANGED.

## Export (export_parquet.py sql_player_matches) — DONE + VERIFIED
Added 4 columns (appended after `month`), re-derived STANDALONE from raw
wickets/wicket_fielders/deliveries/match_player_of_match (source DB has no fielding aggregate):
- `catches`  = 'caught' credited to each listed NON-substitute fielder (5-key wicket_fielders⋈wickets)
  PLUS 'caught and bowled' credited to the delivery's BOWLER (owner: c&b IS the bowler's catch;
  c&b carries NO wicket_fielders row here — verified 0 of 9,920 — so bowler taken from `deliveries`).
- `stumpings` = 'stumped' → listed non-substitute (keeper) fielder.
- `run_outs`  = 'run out' → ALL listed non-substitute fielders (a run-out may list several).
- `player_of_match` = 1 iff (match,player) in match_player_of_match else 0.
Super-over innings excluded (kept_innings join). Substitutes excluded (substitute IS NOT TRUE).
LEFT JOINs (fielding_agg by GROUP BY, pom by DISTINCT) are one-row-per-(match,player) → PK preserved.

New oracle gate in run_gates: independently recomputes grand totals from raw, asserts parquet SUMs match.

### Verify (scratchpad cricket_w2.duckdb → /tmp/export_w3)
- Full export: all structural/cross-check gates + 7 spot checks PASS; fielding oracle gates PASS.
- Byte-identical existing 10 player_matches cols vs HEAD-derived baseline: 0 / 0 (EXCEPT both ways).
- Row count unchanged 490,356 == 490,356 (no orphaned credit, no dup/drop).
- Grand totals parquet==raw: catches 201,520 / stumpings 9,397 / run_outs 26,252 / MoM 16,435.
- Player oracle (raw recompute == parquet SUM):
  MS Dhoni 766 catches / 235 stumpings / 169 run-outs / 40 MoM;
  V Kohli 462 catches / 0 stumpings / 45 run-outs / 91 MoM.
- No negative / null / non-0/1 rows.
- Size: player_matches 2,358,073 → 2,536,589 (+178,516, +7.6%). Other 7 files byte-identical.

## Query layer + metrics + UI — DONE + VERIFIED
- `src/metrics.js`: 5 metrics pushed into BOTH BATTING_METRICS and BOWLING_METRICS —
  catches/stumpings/run_outs/dismissals_effected (section "fielding") + player_of_match
  (section "impact"). source "player_matches", kind:"total", int, additive, higherIsBetter:true.
  sqlExpression = MAX(fielding_cte.<col>) (constant-per-group; same shape as r_pos's MAX).
- `src/table.js` buildQuery: ONE new LEFT JOIN (Wave-3 authorized) to a per-player
  pre-aggregated `fielding_cte` (SUM over player_matches, GROUP BY player_id, ONE row/player —
  never multiplies innings rows). Scope built with the EXACT options matchesSql uses
  (core+team+event/venue+profile+R.Pos, pin-exempt) so fielding & matches never diverge.
  Added when a fielding column is shown OR a fielding stat-condition is active
  (advancedReferencesFielding). Column picker gains Fielding + Impact sections (both views).
  buildScopeClauses / buildMatchupQuery / filters.js UNTOUCHED.
- `src/advanced.js` + `src/drawer.js`: "+ Add condition…" gains Fielding + Impact optgroups
  (structural, section-driven; no key list).

### Byte-identity of existing numbers (the numbers-sacred check)
- SQL-level, anchor scope, plain vs +fielding-join: baseline row count 2813==2813 (no dup/drop);
  existing cols (runs/inns/avg/sr) identical EXCEPT both ways = 0/0; Karanbir 2454; SA Yadav
  60/1544/29.13/150.34. When no fielding column/condition, buildQuery.sql is byte-identical to HEAD.
### Live (localhost:8000, config-override to /tmp/export_w3, zero console errors throughout)
- Anchors on screen: 2,813 players; Karanbir Singh 2,454; SA Yadav 64/60/1,544/29.13/150.34.
- Batting view + Catches/Stumpings/Run-outs/MoM: SA Yadav Ct=24 (== raw recompute).
  Sort by Stumpings surfaces keepers: BKG Mendis 17, Liton Das 10, JC Buttler 10 (33 Ct/11 RO).
- Bowling view (2,049 players baseline intact) + same 4 columns render, keyed by player_id.
- Column picker sections: Basic/Dismissals/Fielding/Impact/Phase (batting), Basic/Fielding/Impact/Phase (bowling).
- Stat-condition path: stumpings>=5 with NO fielding column visible → join+HAVING added,
  SQL executes, 38 players all with >=5 stumpings (condition-only path verified).
- node --check all touched .js OK. config.js/main.js reverted clean.

## Judgement calls (flagged, not silently done)
1. c&b catcher = deliveries.bowler_id (c&b carry 0 wicket_fielders rows here; owner: c&b IS the
   bowler's catch). 2. Fielding scope can't honor opposition/striker-position filters (no
   player_matches column) — degrades to core+team like "matches"; flagged. 3. Fielding metrics
   also flow into the graph pool (donut/radar; excluded from timeseries via source!="innings"),
   matching waves 0-2's accepted pattern — NOT special-cased out.
