// src/graph/metricGroups.js
//
// Graph Builder metric-picker GROUPING (polish, task "graph-metric-groups").
// The owner wants the graph's metric dropdowns to carry the SAME section
// headings the "+ Add condition" dropdown already uses (src/drawer.js's
// optgroup block): Basic metrics · Advanced metrics · Dismissal type ·
// Fielding · Impact — so this reuses src/advanced.js's partitionFilterMetrics
// (the ONE classification source, via metricFilterGroup) rather than inventing
// a second taxonomy that could drift from the filter dropdown's.
//
// Two families partitionFilterMetrics DROPS (metricFilterGroup returns null
// via isMetricRemovedFromFilters, because they're excluded from the FILTER
// dropdown specifically):
//   • composition metrics (kind "composition": comp_pace/comp_spin/comp_uncat
//     on matchup_batting, comp_rhb/comp_lhb/comp_uncat on matchup_bowling) —
//     these carry a PLACEHOLDER sqlExpression ("__COMPOSITION__") that is
//     NEVER interpolated; only table.js's buildMatchupQuery knows how to
//     compute them (a bespoke windowed per-group ball-partial calculation,
//     not a generic aggregate). Every graph-side eligibility function
//     (graphMetrics/radarEligibleMetrics/benchmarkEligibleMetrics/
//     lineMetricsFor) ALREADY excludes kind "composition" independently, by
//     explicit, documented owner ruling (R5-C #22 / decision 50: "the metrics
//     the graph must never offer... a placeholder sqlExpression, not a
//     standalone chartable stat"). So composition metrics never reach this
//     module's input in the first place — there is nothing to place for that
//     family, and doing so would both reverse a ruled decision and require a
//     real SQL/query change this task's brief itself rules out. See this
//     task's report for the flag raised to the owner.
//   • dismissal PERCENTAGE metrics (section "dismissal", format "pct1", e.g.
//     out_caught_pct → "Caught %") — these DO carry a real sqlExpression and
//     DO already reach the graph's per-type eligible-metrics lists (graph-
//     Metrics only strips kind "composition" and key "best"); they're excluded
//     from the FILTER dropdown for an unrelated reason (owner 1B-2: they're
//     table columns, not filter criteria). So this module puts them back,
//     under "Dismissal type" alongside the dismissal COUNT metrics
//     partitionFilterMetrics already buckets there.
//
// Presentation only: this never changes WHICH metrics a picker offers, only
// how the same set is grouped/ordered.

import { partitionFilterMetrics } from "../advanced.js";

const GROUP_ORDER = ["basic", "advanced", "dismissal", "fielding", "impact"];
export const GROUP_LABELS = {
  basic: "Basic metrics",
  advanced: "Advanced metrics",
  dismissal: "Dismissal type",
  fielding: "Fielding",
  impact: "Impact",
};

/**
 * Partition `metrics` (whatever list a picker already computed — same
 * eligibility, unchanged) into the drawer's 5 named groups, PLUS the
 * dismissal-% metrics partitionFilterMetrics drops (see module doc above).
 * Order within each group is preserved from the input list (partition-
 * FilterMetrics already does this for its 5 groups; the re-merge below keeps
 * dismissal-% metrics in the input list's own relative order too, so counts
 * and percentages interleave exactly as metrics.js defines them).
 *
 * Returns { basic, advanced, dismissal, fielding, impact } — same shape as
 * partitionFilterMetrics, so callers that only need one group can destructure
 * exactly as they would from that function.
 */
export function groupMetricsForGraph(metrics) {
  const { basic, advanced, dismissal, fielding, impact } = partitionFilterMetrics(metrics);
  const dismissalSet = new Set(dismissal);
  const isDismissalPct = (m) => m.section === "dismissal" && m.format === "pct1";
  const dismissalAll = metrics.filter((m) => dismissalSet.has(m) || isDismissalPct(m));
  return { basic, advanced, dismissal: dismissalAll, fielding, impact };
}

/**
 * Turn `metrics` into flat {value,label,group} rows in drawer order (Basic ·
 * Advanced · Dismissal type · Fielding · Impact), ready for mountSearchSelect/
 * mountSearchMultiSelect's opt-in `group` header support. `labelFor(metric)`
 * supplies the display label (callers route through metricDisplayLabel so a
 * format-inappropriate suffix is never shown, exactly as before this change).
 * A group with no members contributes no rows, so no empty heading renders
 * (the widgets only draw a header when a row with that `group` exists).
 */
export function groupedMetricOptions(metrics, labelFor) {
  const groups = groupMetricsForGraph(metrics);
  const out = [];
  for (const g of GROUP_ORDER) {
    for (const m of groups[g]) out.push({ value: m.key, label: labelFor(m), group: GROUP_LABELS[g] });
  }
  return out;
}
