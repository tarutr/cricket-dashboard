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

## STOP-RULE FLAG: bstyle (Bowler Style) dimension NOT built — fielding_events carries RAW
## Cricsheet bowling_style (Right-arm offbreak/Legbreak/Left-arm slow/Right-arm bowler/…),
## NOT the normalised bowling_group/bowling_type the owner's pace/spin/detailed means.
## player_profiles not registered in browser DB. Needs owner ruling. Other 5 dims DONE.
