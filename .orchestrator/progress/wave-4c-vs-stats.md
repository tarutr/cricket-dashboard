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

## TODO (browser, localhost:8000, vs R2)
- SA Yadav HS vs Spin = 47; his Matches / RPI vs Spin vs a direct query.
- A bowler's Best Bowling vs a hand vs a direct most-wickets-then-fewest-runs query.
- Anchors hold: SA Yadav vs Spin 38/454/140.99; Bumrah vs RHB pos 1,2 27/177/9.
- Composition %s still sum to 100. Toggle/sort/format in the Vs picker.
