// src/advanced.js
//
// Numeric stat-condition DATA MODEL + helpers (SPEC §5.2). Batch 1B (task 1B-2)
// moved every piece of filter DOM into the condition builder (src/drawer.js);
// this module is now pure, framework-free logic with NO DOM and NO imports of
// any view module, so it can be shared freely by the builder (drawer.js), the
// pills row (pills.js), and the table query (table.js) without import cycles.
//
// state.advanced keeps its original shape — { op, groups: [{ op, conds }] } —
// so table.js's advancedToHaving()/activeGroups() consumers are byte-identical.
// The 1B-2 builder only ever authors ONE AND group (all numeric conditions
// AND-combined; the old AND/OR multi-group UI is retired), which advancedToHaving
// renders as `(c1 AND c2 AND …)` — exactly what a single AND group always meant,
// so no query changes and the baselines are untouched.
//
// A "condition" is { metricKey, operator: "gte"|"lte"|"eq"|"between", v1, v2 }.
// Conditions apply to the COMPUTED metric values (HAVING-level) — table.js turns
// each into a HAVING predicate using the metric's sqlExpression and ANDs in a
// hasMetricData guard for rate/ratio metrics (§8.1) so no-data players can never
// satisfy a condition by accident.

import { metricsFor } from "./metrics.js";

export const OPERATORS = [
  { key: "gte", label: "at least (≥)" },
  { key: "lte", label: "at most (≤)" },
  { key: "eq", label: "equals (=)" },
  { key: "between", label: "between" },
];

export function newCondition(metricKey = "") {
  return { metricKey, operator: "gte", v1: "", v2: "" };
}
export function newGroup() {
  return { op: "AND", conds: [] };
}

/** Ensure state.advanced has at least one group to append conditions to (the
 * 1B-2 builder only ever uses groups[0]). Returns that group. */
export function ensureGroup(store) {
  const state = store.get();
  if (!state.advanced || !state.advanced.groups || state.advanced.groups.length === 0) {
    store.set({ advanced: { op: state.advanced?.op ?? "AND", groups: [newGroup()] } });
  }
  return store.get().advanced.groups[0];
}

/** Conditions that are fully filled in (metric chosen + numeric value(s) valid). */
export function isConditionComplete(cond) {
  if (!cond.metricKey) return false;
  if (cond.v1 === "" || cond.v1 === null || cond.v1 === undefined || Number.isNaN(parseFloat(cond.v1))) return false;
  if (cond.operator === "between") {
    if (cond.v2 === "" || cond.v2 === null || cond.v2 === undefined || Number.isNaN(parseFloat(cond.v2))) return false;
  }
  return true;
}

/** decision 42 validation rule: a metric was picked but the value is missing
 * or invalid. A fully blank row (no metric) is not an error — it's ignored. */
export function conditionHasError(cond) {
  return Boolean(cond.metricKey) && !isConditionComplete(cond);
}

/** Groups (and conditions within) that are actually active, i.e. complete. */
export function activeGroups(advanced) {
  return (advanced.groups || [])
    .map((g) => ({ ...g, conds: g.conds.filter(isConditionComplete) }))
    .filter((g) => g.conds.length > 0);
}

export function activeConditionCount(advanced) {
  return activeGroups(advanced).reduce((n, g) => n + g.conds.length, 0);
}

/**
 * Remove condition `ci` from group `gi`, collapsing the group if it becomes
 * empty. Exported so pills.js's per-condition × removes the exact same way the
 * builder's own remove button does — one shared code path.
 */
export function removeConditionAt(store, gi, ci) {
  const advanced = store.get().advanced;
  const groups = advanced.groups.map((g, i) => (i === gi ? { ...g, conds: [...g.conds] } : g));
  const group = groups[gi];
  if (!group) return;
  group.conds.splice(ci, 1);
  if (group.conds.length === 0 && groups.length > 1) groups.splice(gi, 1);
  store.set({ advanced: { ...advanced, groups } });
}

/** Append a numeric condition on `metricKey` to the (single) numeric group. */
export function addCondition(store, metricKey) {
  ensureGroup(store);
  const advanced = store.get().advanced;
  const groups = advanced.groups.map((g, i) => (i === 0 ? { ...g, conds: [...g.conds, newCondition(metricKey)] } : g));
  store.set({ advanced: { ...advanced, groups } });
}

function opWord(op) {
  return { gte: "at least", lte: "at most", eq: "equal to", between: "between" }[op] ?? op;
}

function condPhrase(cond, discipline) {
  const metric = metricsFor(discipline).find((m) => m.key === cond.metricKey);
  const label = metric ? metric.label : cond.metricKey;
  if (cond.operator === "between") return `${label} between ${cond.v1} and ${cond.v2}`;
  return `${label} ${opWord(cond.operator)} ${cond.v1}`;
}

/** Plain-English clause for the advanced filters, honest about what's active. */
export function describeAdvanced(state) {
  const groups = activeGroups(state.advanced);
  if (groups.length === 0) return "";
  const multi = groups.length > 1;
  const parts = groups.map((g) => {
    const joiner = g.op === "OR" ? " or " : " and ";
    const inner = g.conds.map((c) => condPhrase(c, state.discipline)).join(joiner);
    return multi && g.conds.length > 1 ? `(${inner})` : inner;
  });
  return parts.join(state.advanced.op === "OR" ? " or " : " and ");
}

// ── Metric grouping for the "+ Add condition" dropdown (task 1B-2) ────────────
// UI-ONLY categorisation of the numeric metrics into the two "+ Add condition"
// optgroups. This references metric KEYS purely to bucket the dropdown; it
// defines no metric vocabulary or SQL (that stays in metrics.js). Rule:
//   • Dismissal-% metrics (per-kind "% of dismissals": out_caught_pct, …) are
//     REMOVED from the filter options entirely (owner 1B-2 — they are table
//     columns, not filter criteria). Identified structurally as
//     section === "dismissal" && format === "pct1" so no key list can drift.
//     Non-dismissal percentages (Dot %, Boundary %, Not Out %) are kept.
//   • "Basic" = the everyday headline stats one filters on (counts + core
//     rates + peak). Everything else eligible falls to "Advanced" (the
//     percentages, balls-per-boundary, phase splits, progression buckets, and
//     the dismissal / wicket-type COUNT breakdowns).
const BASIC_METRIC_KEYS = new Set([
  "matches", "innings",
  // batting core
  "runs", "balls_faced", "high_score", "average", "strike_rate",
  "balls_per_dismissal", "runs_per_innings", "fours", "sixes",
  // bowling core
  "wickets", "balls", "runs_conceded", "maidens", "economy", "best", "wickets_per_innings",
  // matchup-only extras
  "dismissals", "fours_conceded", "sixes_conceded",
]);

/** True if a metric must NOT appear as a filter option (dismissal-% only). */
export function isMetricRemovedFromFilters(metric) {
  return metric.section === "dismissal" && metric.format === "pct1";
}

/** "basic" | "advanced" | null (null = removed from the filter dropdown). */
export function metricFilterGroup(metric) {
  if (isMetricRemovedFromFilters(metric)) return null;
  return BASIC_METRIC_KEYS.has(metric.key) ? "basic" : "advanced";
}

/** Partition an eligible-metrics list into { basic, advanced }, dropping the
 * removed (dismissal-%) ones. Preserves catalogue order within each group. */
export function partitionFilterMetrics(metrics) {
  const basic = [];
  const advanced = [];
  for (const m of metrics) {
    const g = metricFilterGroup(m);
    if (g === "basic") basic.push(m);
    else if (g === "advanced") advanced.push(m);
  }
  return { basic, advanced };
}
