# graph-metric-groups — progress note

Branch: polish-b1-mechanical. Commit: e3724f0 "wip: group Graph Builder metric
pickers with drawer's section headings".

## What changed
- NEW `src/graph/metricGroups.js`: `groupMetricsForGraph(metrics)` and
  `groupedMetricOptions(metrics, labelFor)`. Reuses `src/advanced.js`'s
  `partitionFilterMetrics` (the drawer's one classification source) and
  re-injects dismissal-percentage metrics (section "dismissal", format
  "pct1" — e.g. "Caught %") into the "Dismissal type" group, since the
  filter dropdown structurally drops that family (isMetricRemovedFromFilters)
  but the graph already offers it flat.
- `src/graph/graph.js`: `metricSelectOptions()` (the ONE options-builder every
  single-metric searchSelect picker shares — pretype-metric, bar-metric,
  scatter-x, scatter-y, slope-metric, dumbbell-metric, byyear-metric) now
  routes through `groupedMetricOptions`. Presentation only: same metric SET,
  now grouped/ordered as Basic metrics · Advanced metrics · Dismissal type ·
  Fielding · Impact (drawer.js's exact order).

## Skipped (with reasons)
- Radar metrics, Benchmark metrics (both `mountSearchMultiSelect`): the
  widget's multi-select `renderList` (src/searchSelect.js ~line 738) does NOT
  check an option's `group` field — only the single-select `renderList`
  (~line 224) does. Group headers are NOT implemented for multi-select despite
  the task brief's claim both widgets support it. searchSelect.js is a
  forbidden file this task — could not add it. Flagged in report.
- phase-family, line-xdim (Line's X-axis), benchmark-anchor: not metric
  pickers (phase families / dimensions / players), grouping doesn't apply.

## NOT built — flagged to owner, needs a decision
Composition metrics (comp_pace/comp_spin/comp_uncat, comp_rhb/comp_lhb/
comp_uncat — 6 total) were NOT added to any graph picker. The task brief said
the graph "must still show" them under "Advanced metrics", but graph.js's own
`graphMetrics()` (and `radarEligibleMetrics`/`benchmarkEligibleMetrics`/
`lineMetricsFor`) explicitly and independently exclude `kind === "composition"`
today, citing an existing owner ruling (R5-C #22 / decision 50: "the metrics
the graph must never offer... a placeholder sqlExpression, not a standalone
chartable stat"). Their `sqlExpression` is the literal string
`"__COMPOSITION__"`, never interpolated outside table.js's buildMatchupQuery's
bespoke per-column table-render path — there is no generic aggregate the
graph's chart-data fetchers could use to draw them. Implementing the brief's
instruction would reverse a documented ruling AND require new SQL/query logic,
both against this task's own hard invariants. Did not implement; needs an
owner decision before any follow-up attempts it.

## Verification
- node --check on both touched files: clean.
- Node-level set-equality check (script: scratchpad/verify_groups.mjs) across
  batting/T20, bowling/ODI, matchup_batting/T20, matchup_bowling/ODI: same
  metric-key set before/after in all 4 cases (62/26/30/19 metrics respectively).
- Live app (localhost:8000): 0 console errors on boot; Stats anchors
  reproduced (2,813 players, Karanbir Singh 2,454 runs, SA Yadav
  64 mat/60 inns/1,544 runs/29.13 avg/150.34 SR). Graph Builder pre-type
  Metric picker confirmed showing "BASIC METRICS" heading over
  Matches/Innings/Runs/Balls Faced, and "DISMISSAL TYPE" heading over
  "Out Caught %" (confirms the re-injected family renders correctly).
- Could not get a clean screenshot of every heading / a rendered chart: the
  browser tab is shared with a concurrent agent session (also mid-edit on
  drawer.js/main.js/searchSelect.js/styles.css/table.js/index.html) that kept
  reopening its own Filters dialog with a "Venue" condition mid-test,
  interleaving with my clicks. Stopped interactive testing once this was
  confirmed, to avoid corrupting their in-flight state — relied on the
  node-level exhaustive check instead, which is deterministic and already
  covers every group/metric combination the screenshots would have shown.
