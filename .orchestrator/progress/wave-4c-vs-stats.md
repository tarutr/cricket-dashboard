# Wave 4c — four new "Vs" (matchup) stats (decision 47c)

Branch: `polish-b1-mechanical`. Base HEAD: 59e82e5.

## Goal
Add Matches, Runs per Innings, High Score (matchup_batting) and Matches,
Best Bowling (matchup_bowling) as opt-in columns in the leaderboard Vs
restricted picker. App-side query only; no pipeline/DB/parquet change.

## What changed
- `src/metrics.js`: +3 matchup_batting metrics (matches, high_score,
  runs_per_innings), +2 matchup_bowling (matches, best). Peaks (high_score,
  best) carry a two-step recipe (peakInner/peakOuter[/peakOuterSort]) +
  placeholder sqlExpression. All four flagged `vsTableOnly:true`. Documented the
  new fields (vsTableOnly, peakInner/peakOuter/peakOuterSort) in the header.
- `src/table.js` buildMatchupQuery: split peak metrics out of step-1 `metrics`
  (like composition); added a conditional `peak` CTE (per-(id,match,innings)
  pre-agg FILTER'd on the bucket → MAX/arg_max per player) LEFT JOINed on id.
  No peak selected → byte-identical to pre-47c. Guarded matchup peaks out of
  conditionToHaving/conditionApplicability (placeholder SQL; also blocks a plain
  HS/Best condition surviving cross-namespace).
- `src/advanced.js` isMetricRemovedFromFilters: matchup peaks excluded from the
  stat-condition picker.
- `src/playerData.js`: MATCHUP_*_KEYS exclude `vsTableOnly` metrics (popup
  surface stays byte-identical; peaks would emit invalid SQL via selectList).

## Verified (Node, pre-browser)
- Plain query fingerprint: len 1430, djb2 3307620867 — MATCHES anchor.
- Default matchup batting-Vs-Spin query: byte-identical to HEAD 59e82e5
  (len 2500, djb2 3064880972), no peak CTE, no placeholder.
- New-column SQL well-formed; no __PEAK__/__PEAK_SORT__/__COMPOSITION__ leak.

## Verified (browser, localhost:8000, vs R2) — DONE, zero console errors
- SA Yadav vs Spin: independent raw HS=47 (WITH per_innings…MAX), Matches=38,
  Innings=38, Runs=454. App buildMatchupQuery row IDENTICAL: HS 47, Mat 38,
  Runs 454, RPI 11.9, SR 140.99 → anchor 38/454/140.99 HOLDS.
- Bumrah Best Bowling vs RHB: independent raw arg_max = "2-9" (rank 1991); app
  best "2-9", best__sort 1991 — IDENTICAL. Matches 32.
- Anchor Bumrah vs RHB striker pos 1,2 = 27 inns / 177 balls / 9 wkts HOLDS
  (with the new columns selected; best "2-9", Mat 27).
- Composition %s (Pace/Spin/Uncat) still sum to 100.00 (spot-checked 5 rows).
- UI: all 4 metrics appear unchecked in the Vs picker (opt-in), toggle ON,
  render far-right with right formats (Mat/HS int, RPI dec1, BBI "W-R").
  HS sorts descending (86/79/77…); BBI sorts by rank (7-6,7-7,6-2,6-3,6-8…).
- Condition picker: Matches + Runs/Innings ARE offered (real exprs, re-score
  per decision 47b); High Score + Best Bowling are NOT (matchup-peak guard),
  in BOTH batting-Vs and bowling-Vs modes.

STATUS: COMPLETE.
