# Wave A2 — Best Bowling two-box condition (item 2) + High Score Vs condition (item 3)

Branch: polish-b1-mechanical. Owner: data-engineer (Opus). Both items share the
matchup peak-condition wiring machinery.

## Checkpoint 1 (code-complete, node --check green, browser pending)
DONE:
- metrics.js: added `conditionInput: "bowlingFigures"` FLAG to BOTH `best` metrics
  (plain source "innings", matchup source "matchup"). No aggregation string touched.
- advanced.js: `import { getMetric }` + `isBowlingFiguresCondition(cond)`;
  isConditionComplete now requires BOTH v1+v2 for bowlingFigures; removed the
  matchup-peak guard from isMetricRemovedFromFilters (High Score + Best Bowling
  now appear in the Vs picker).
- table.js conditionToHaving: removed matchup-peak refusal; added bowlingFigures
  branch → `(<rank>) >= (W*1000 - R)` where rank = sortExpression (plain) or
  peak.best__sort (matchup). High Score (matchup) falls through to generic path
  with exprFn → peak.high_score.
- table.js conditionApplicability: matchup peaks now count as applied.
- table.js buildMatchupQuery: (a) step-1 alias loop skips peak conditions;
  (b) peakCondMetrics + peakCteMetrics (displayed ∪ condition-only);
  (c) final-WHERE exprFn resolves peak conds to peak.best__sort / peak.high_score;
  (d) peak CTE emitted for peakCteMetrics but peakSelectParts only for DISPLAYED
  peaks → condition-only peak adds NO output column (byte-identical rows w/o cond).
- drawer.js: two-box "≥ [W] wickets for ≤ [R] runs" render + operator select
  suppressed for bowlingFigures; operator event bind guarded (opSel may be null).
- pills.js + state.js: two-box label "Best Bowling ≥2W for ≤9R" (state.js keeps a
  local conditionIsBowlingFigures — can't import advanced.js, cycle).

NEXT: browser verification — anchors byte-identical (2813 / Karanbir 2454 / SA Yadav
60·1544·29.13·150.34 / SA Yadav vs Spin 38·454·140.99 / Bumrah vs RHB pos1,2 27·177·9),
plain fingerprint 3307620867/len1430, then independent-DuckDB checks for items 2+3.

GOTCHAS:
- buildMatchupQuery final WHERE is BUILT (as a string) before the peak CTE, but
  ASSEMBLED after — so referencing peak.* in the WHERE is fine as long as
  peakCteSql is non-null (gated on peakCteMetrics.length, which includes
  condition-only peaks). LEFT JOIN peak is 1:0/1:1 per id — never multiplies rows.
- Plain `best` was BROKEN (string ">= N"); the bowlingFigures branch is the fix.
