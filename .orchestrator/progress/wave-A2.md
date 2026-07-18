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
- buildMatchupQuery is NOT exported; verified matchup byte-identity + condition SQL
  via throwaway src copies with a temporary export (scratchpad only).

## Checkpoint 2 — FULLY VERIFIED (2026-07-18, localhost:8000, R2 data, 0 console errors)
BYTE-IDENTITY (before=HEAD~1 vs after, same harness):
- 5 plain no-condition queries IDENTICAL (default batting/bowling + full-filters
  batting-8col/irs + full bowling). Standard all-filters plain state reproduces
  EXACTLY len 1430 / djb2 3307620867 (cols innings,runs,strike_rate +
  teams+opp+event+venue+profileHand+rpos+pin).
- 5 matchup no-condition queries IDENTICAL incl. with HS / best columns DISPLAYED.
ANCHORS on-screen: 2,813 players; Karanbir 2,454; SA Yadav 60/1544/29.13/150.34;
  SA Yadav vs Spin 38/454/140.99; Bumrah vs RHB pos1,2 27/177/9 (all reproduced).
INDEPENDENT DuckDB == app-generated SQL == on-screen count:
- Item 3 (Vs=Spin): HS>=47 -> 83 rows (SA Yadav IN); HS>=48 -> 73 (SA Yadav OUT).
  SA Yadav Spin HS independently = 47.
- Item 2 Vs (Vs=RHB): best>=2W/<=9R -> 800 (Bumrah IN, best 2-9 rank 1991);
  >=2W/<=8R -> 781 (Bumrah OUT). rank=1991=2*1000-9.
- Item 2 plain (bowling): best>=5W/<=20R -> 72; best>=4W/<=15R -> 213.
  Boundary: N Thushara best 5-20 (rank 4980) IN at >=4980, OUT at >=4981.
UI: two-box "Best Bowling >= [W] wickets for <= [R] runs" renders w/ NO operator
  select; pills "Best Bowling >=5W for <=20R" / "High Score >= 47"; High Score +
  Best Bowling now in the Vs condition picker. VS-filter parity guard PASSES.
STATUS: COMPLETE, awaiting orchestrator gate.

## ORCHESTRATOR INDEPENDENT VERIFICATION (2026-07-18) — PASS
Read full diff (ba673fa..HEAD): NO aggregation string (sqlExpression/sortExpression/
peakInner/peakOuter/peakOuterSort) added or removed anywhere; filters.js UNTOUCHED;
the byte-identity guarantee is architecturally sound (condition-only peaks materialize
in the peak CTE but are EXCLUDED from peakSelectParts, so no-condition output rows are
byte-identical while the filter references peak.<col> in the final WHERE). node --check
all 6 touched files PASS. describeScope IS live in the Graph (graph.js:320, :2351) — so
item-4's conditionScopeLabel format-aware fix + A2's two-box label there have a real surface.
IN-BROWSER (orchestrator, localhost:8000, modules cache-reloaded), against MY OWN pre-build
independent DuckDB targets (scratchpad/waveA_verification_targets.md):
- Anchor after A2, NO condition: 2,813 / Karanbir 2,454 / SA Yadav 60/1,544/29.13/150.34 on screen.
- SA Yadav vs Spin displayed 38/322/454/140.99 (unchanged) inside the HS>=47 result.
- Item 3: Vs=Spin, HS>=47 -> 83 players, SA Yadav present (row 17); HS>=48 -> 73, SA Yadav gone.
- Item 2 Vs: Vs=Right-handers, >=2W for <=9R -> 800; <=8R -> 781 (Bumrah 2-9 drops at the boundary).
- Item 2 plain: bowling, Vs=Everyone, >=5W for <=20R -> 72 (BBI column shows real figures;
  R Shepherd 5-20 = rank 4980 exactly, correctly INCLUDED at the boundary).
- Two-box control renders "Best Bowling >= [W] wickets for <= [R] runs" (no operator select);
  High Score single box; pills exact. Zero console errors throughout.
ALL counts EXACTLY match the independently-derived targets. WAVE A COMPLETE + orchestrator-verified.
FLAG for owner at gate: (a) toolbar hardcoded "Vs" label unchanged — rename to "Matchup (Vs)"?
(b) A2 consistency note — a plain-authored HS/Best-Bowling condition now re-scores vs the bucket
in Vs mode (consistent with decision 47b re-score model; surfaced for transparency).
