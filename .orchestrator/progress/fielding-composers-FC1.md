# FC-1 — fielding composers SQL + key scheme — progress

## Status: CODE COMPLETE, verifying (2026-08-10)

## Key scheme (final)
`fc__<tally>__<dim>__<value>` (+ `_per_match` suffix for the per-match variant).
- tally ∈ {catches, cab, stumpings, runouts, dismissals}
- dim ∈ {phase, over, inns, pos, hand, bstyle}
- value: phase pp/mid/death; over `N`/`N_M` (1-based user overs → 0-based over_number, -1);
  inns `N` (1-based → innings_number N-1); pos `N`/`N_M` (1-based, NO offset);
  hand l/r (→ out_hand Left/Right-hand bat); bstyle detailed tokens (offspin/legspin/
  slaorthodox/lawristspin/slowmedium/medium/mediumfast/fastmedium/fast/unmapped) + groups
  grp_spin/grp_pace (union of fine styles).
- CTE alias = the COUNT key; per-match shares it (numerator), divides by pmatch_cte.

## Files changed
- src/metrics.js: fc__ block (maps, parse/make/build/resolve, isComposedFieldingColumnKey,
  eligibleComposedFieldingKeys); chained resolveComposedFieldingMetric 7th in getMetric.
- src/table.js: buildFieldingCteSql(state, composedFieldingCols=[]) additive injection;
  buildQuery passes fieldingEventCols.filter(isComposedFielding); pruneInvalidColumns +
  isComposedFieldingColumnKey; import added.
- src/state.js: import; eligibleColumnKeys folds eligibleComposedFieldingKeys;
  pruneIneligibleState + isComposedFieldingColumnKey.

## Architecture note
fielding composed columns = FRESH event-grain SUM(CASE …) injected INSIDE fielding_cte;
metric sqlExpression = MAX(fielding_cte.<alias>) — same shape as base tallies. Byte-identical
CTE when no fc__ requested (4 base lines join to former text exactly).

## Data facts confirmed
- fielding.phase = format-aware 'pp'/'mid'/'death' (T20 ranges T20/Hundred; ODI ranges ODI;
  NULL red-ball) — single column, 3 tokens. Matches leaderboard fielding phase slice.
- out_hand ∈ 'Right-hand bat'/'Left-hand bat'. bowler_style = FINE style (no bowling_group on
  fielding view). over_number/innings_number 0-based. out_batting_position 1-based.

## CONCERN to report
pace/spin over fielding view uses fine-style enumeration (fielding_events lacks the profile
`bowling_group`); a bowler with a group but NO fine style has bowler_style NULL → excluded
from both groups. Measure divergence vs profile bowling_group during verify; flag for owner.

## VERIFICATION COMPLETE (2026-08-10, localhost:8000 vs R2)
- node --check metrics.js/table.js/state.js: OK.
- Independent DuckDB (fielder b5f30525 Ahmad Ramdoni, Men/T20/Intl 2023-07-01..2026-07-02):
  resolver-built SQL == hand-written raw event count for ALL 10 cases — phase pp/death,
  over range 1_6 + single 7, pos range 1_2 + single 3, hand r/l, inns 1/2, tallies
  catches/runouts/stumpings/dismissals. Per-match fc__catches__phase__pp_per_match =
  22/71 = 0.3099 (matches). Invariants: phase pp22+mid12+death18=52=catches; hand
  l3+r40+null9=52; inns1 52 + inns2 27 = 79 = dismissals; catches52+st8+ro19=79=dismissals.
- Anchors via REAL buildQuery: batting 2813 players, Karanbir 2454; SA Yadav 60/1544/29.13/
  150.34. Plain batting SQL has NO fielding_cte/fc__ (additive path).
- Byte-identity: buildFieldingCteSql(state) === buildFieldingCteSql(state, []); base 4
  tallies intact with/without fc__; fc__ injects exactly one CASE col (count+per_match dedup
  to 1); pmatch_cte lights up for per_match.
- Resolver/eligibility: getMetric resolves fc__ batting+bowling, null matchup; bstyle
  RESERVED->null; over0/inns0/bad tally/bad dim -> null; eligibleColumnKeys has fixed+per_match
  keys, NOT range keys; isComposedFieldingColumnKey keeps range keys alive.
- App boots + live Search: 0 console errors, leaderboard renders (Karanbir top).

## STOP-RULE FLAG (FC-1): bstyle needed a data source ruling — RESOLVED below.

## FC-1b (owner ruled 2026-08-10: ADD grouping to the fielding data) — DONE + verified
- export_parquet.py sql_fielding_events(): ADDED 2 columns to the projection —
  `COALESCE(wp.bowling_type, wp.bowling_group,'(unmapped)') AS bowling_type` and
  `COALESCE(wp.bowling_group,'(unmapped)') AS bowling_group`, using the SAME `wp`
  (player_profiles-on-bowler) join. IDENTICAL to matchup mb (sql_matchup_batting
  lines 1406-1407, `pp` alias). Additive-only: git diff = ONE hunk, +2 cols + comment;
  no other column/parquet touched. py_compile OK.
- metrics.js bstyle branch LIT UP: pace/spin → bowling_group='Pace'/'Spin'; detailed
  tokens (offspin/legspin/slaorthodox/lawristspin/medium/mediumfast/fastmedium/fast/
  slowmedium) → bowling_type='<value>'. Bare-group 'Pace'/'Spin' bowling_type + '(unmapped)'
  EXCLUDED from detail (covered by groups; mirrors matchup fine picker's <> '(unmapped)';
  keeps detail tokens collision-free with pace/spin group tokens). Folded into
  eligibleComposedFieldingKeys (now 200 finite keys; bstyle = 11 tokens × 5 tallies × 2).
- VERIFIED: node --check metrics.js OK; resolver returns correct SQL for pace/spin/each
  detail + null for unmapped/grp_spin/xyz; getMetric resolves batting+bowling, null matchup;
  eligibleColumnKeys (page-fresh) has pace + offspin_per_match, ranges stay structural;
  anchors byte-identical (2813/Karanbir 2454, SA Yadav 60/1544/29.13/150.34); other 5 dims
  intact; 0 console errors.
- LIVE GAP (expected): bstyle predicates read bowling_group/bowling_type which exist on
  fielding_events ONLY after the pipeline re-runs — so no live bstyle compute yet.
- FC-2 availability signal: offer Bowler Style ONLY when fielding_events has bowling_group
  (column-presence probe: information_schema.columns / DESCRIBE fielding, cached like the
  dataAvailability.js probes). Hidden until pipeline re-run; data-driven, no crash, women-ready.
