# R5-C — graph cleanup (7 items)

Branch: polish-b1-mechanical. Owner files: graph/graph.js, graph/charts.js,
graph/benchmark.js, graph/timeseries.js, metrics.js (RPI del only), advanced.js
(RPI list entry only), pills.js, state.js (#18 only), styles.css (repo root).

## Approach + key risk
Display/picker-layer only, except #20 (delete 2 RPI metric defs = number-adjacent).
Key risk = #20: deleting RPI defs must leave buildQuery byte-identical for the
standard plain state (RPI is not a default column) and not shift any surviving
metric. Do #20 LAST, verify buildQuery byte-identity + re-derive all anchors.

## Status — ALL BUILD ITEMS COMPLETE + verified in-browser
- [x] #23 label routing — commit f9e0efb (picker "Best Bowling" no "(Innings)"; charts.js render clean)
- [x] #22 remove Best Bowling from graph pickers — commit 9a0fcd0 (gone from bar/scatter/radar/benchmark; BBI column + two-box condition stay)
- [x] Scatter X/Y mutual-exclusion — commit 70227e3 (verified both directions)
- [x] #13 reset link rename + grey-when-full + box — commit 5bbc553
- [x] #19 needs-input outline on every empty required control — commit 97346a8
- [~] #18 NO CODE CHANGE — Matchup-mode note already removed by R5-A; NO personal-data
      coverage note exists anywhere in the Stats view → per brief, NOT fabricated. FLAGGED.
- [x] #20 remove Runs per Innings entirely — commit 008545e (byte-identical buildQuery; anchors hold; grep clean)

## Verification summary
- buildQuery standard plain state: len 482 / djb2 2182256011 UNCHANGED before vs after #20.
- Anchors on screen + independent DuckDB: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34;
  SA Yadav vs Spin 38·454·140.99.
- Zero console errors on Stats AND Graphs (heavily exercised graph pickers + a rendered bar chart).
- metrics.js diff = deletion-only (29 lines); table.js/filters.js untouched.

## Findings (investigation)
- graphMetrics(ns,formats) = eligibleMetrics minus composition — THE single picker
  gate for bar/scatter/radar/slope/dumbbell/phases/line-via-graphMetrics.
- benchmark uses benchmarkEligibleMetrics (eligibleMetrics filtered to total/rate/
  percent + higherIsBetter!=null + format!="str") → `best` (kind peak, format str)
  ALREADY excluded. byyear/line uses eligibleMetrics.filter(timeseriesSupported) →
  peak already excluded. So #22 = one filter on graphMetrics covers bar/scatter/radar.
- `best` defs: plain metrics.js:629 (kind peak, higherIsBetter true, format str),
  matchup metrics.js:1366. Stays a table column + two-box condition (do NOT delete).
- RPI defs: plain metrics.js:241-250, matchup metrics.js:923-940 (vsTableOnly). Refs:
  advanced.js:175 ordering list; comments in benchmark.js:96, graph.js:278/284,
  timeseries.js:191.
- searchSelect/multiSelect toggles carry class `.select` + a setInvalid(on) handle
  method that toggles `.needs-input`. Existing CSS `.graph-builder__controls
  .select.needs-input` styles it. #19 can toggle `.needs-input` on `.search-select__
  toggle` inside each host — no new CSS needed for pickers.
- reset link: graph.js:418 `data-role=reset-players`; roster dropdown 408-416; box
  them together. Grey when `!selection.isDirty()` (dirty = roster hand-edited).
- #18: R5-A already removed the "Matchup mode" toolbar note (table.js:2060, "no note
  element remains"). NO personal-data coverage note exists anywhere in the Stats
  view (pills.js renders only filter/pin pills; no coverage % computed for display).
  Part B's 88.6%/71.1% were investigation figures, never rendered. → per brief, do
  NOT fabricate. FLAG for owner.
