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
// ROUND 3 (task 14/7) restores the multi-group AND/OR UI the 1B-2 builder had
// retired: each group carries its own op ("AND"=All / "OR"=Any) and groups
// combine with AND across the set (advanced.op stays "AND"). advancedToHaving
// already renders exactly this — `(c1 AND c2) AND (c3 OR c4)` — so no query
// changes and the baselines are untouched (a single AND group with one
// condition still renders as just that condition, as before).
//
// A "condition" is { metricKey, operator: "gte"|"lte"|"eq"|"between", v1, v2 }.
// Conditions apply to the COMPUTED metric values (HAVING-level) — table.js turns
// each into a HAVING predicate using the metric's sqlExpression and ANDs in a
// hasMetricData guard for rate/ratio metrics (§8.1) so no-data players can never
// satisfy a condition by accident.

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

/** Append a numeric condition on `metricKey` to group `gi` (ROUND 3, task 7 —
 * the multi-group AND/OR UI adds conditions to a specific group). Ensures at
 * least one group exists, then clamps `gi` into range so a virtual/not-yet-
 * materialised group 0 (the builder renders one even when state.groups is [])
 * always resolves to the real group 0 once it is created here. */
export function addConditionToGroup(store, gi, metricKey) {
  ensureGroup(store);
  const advanced = store.get().advanced;
  const idx = Math.max(0, Math.min(gi, advanced.groups.length - 1));
  const groups = advanced.groups.map((g, i) => (i === idx ? { ...g, conds: [...g.conds, newCondition(metricKey)] } : g));
  store.set({ advanced: { ...advanced, groups } });
}

/** Append a new empty AND group (ROUND 3, task 7 — "+ Add group"). Groups
 * combine with AND across the set (advanced.op stays "AND"), exactly as
 * table.js's advancedToHaving already renders them. */
export function addGroup(store) {
  const advanced = store.get().advanced;
  const groups = [...(advanced.groups || []), newGroup()];
  store.set({ advanced: { ...advanced, groups } });
}

/** Remove group `gi` entirely (ROUND 3, task 7 — per-group "Remove group"). */
export function removeGroup(store, gi) {
  const advanced = store.get().advanced;
  const groups = (advanced.groups || []).filter((_, i) => i !== gi);
  store.set({ advanced: { ...advanced, groups } });
}

/** Set group `gi`'s combine operator (ROUND 3, task 7 — the per-group
 * Match All | Any toggle). `op` is "AND" (All) or "OR" (Any) — UPPERCASE, the
 * exact tokens table.js's advancedToHaving tests with `=== "OR"`; a lowercase
 * value would silently fall back to AND. */
export function setGroupOp(store, gi, op) {
  const advanced = store.get().advanced;
  const groups = (advanced.groups || []).map((g, i) => (i === gi ? { ...g, op } : g));
  store.set({ advanced: { ...advanced, groups } });
}

// ── Metric grouping for the "+ Add condition" dropdown (task 1B-2 / ROUND 3) ──
// UI-ONLY categorisation of the numeric metrics into the "+ Add condition"
// optgroups. This references metric KEYS/flags purely to bucket the dropdown; it
// defines no metric vocabulary or SQL (that stays in metrics.js). Rule:
//   • Dismissal-% metrics (per-kind "% of dismissals": out_caught_pct, …) are
//     REMOVED from the filter options entirely (owner 1B-2 — they are table
//     columns, not filter criteria). Identified structurally as
//     section === "dismissal" && format === "pct1" so no key list can drift.
//     Non-dismissal percentages (Dot %, Boundary %, Not Out %) are kept.
//   • Dismissal-TYPE COUNT metrics (ROUND 3, tasks 3+15) get their OWN
//     "Dismissal type" group, pulled OUT of "Advanced metrics" where they used
//     to sit: batting = the out_* COUNT metrics (Out Caught/Bowled/LBW/Run Out/
//     Stumped/C&B/Hit Wicket + the rare ones), bowling = the wkt_* wicket-type
//     COUNT metrics. Identified structurally by isDismissalTypeMetric() below —
//     a COUNT (kind === "total") that is either section "dismissal" (the batting
//     out_* + matchup wkt_*) or key-prefixed "wkt_" (plain bowling wkt_*, which
//     carry no section field) — so no key list can drift. Same metric objects,
//     same SQL; pure regrouping.
//   • "Basic" = the everyday headline stats one filters on (counts + core
//     rates + peak). Everything else eligible falls to "Advanced" (the
//     non-dismissal percentages, balls-per-boundary, phase splits, progression
//     buckets).
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

/** True if a metric must NOT appear as a filter option: the dismissal-%
 * columns (their count sibling is the filterable one), AND the matchup
 * composition columns (kind "composition" — descriptive style/hand-mix
 * percentages with a placeholder sqlExpression; table.js's conditionToHaving
 * refuses them too, so this keeps them out of the picker in the first place). */
export function isMetricRemovedFromFilters(metric) {
  if (metric.kind === "composition") return true;
  return metric.section === "dismissal" && metric.format === "pct1";
}

/** True if a metric is a dismissal-TYPE COUNT (ROUND 3, tasks 3+15) — the
 * batting out_* per-kind dismissal counts and the bowling/matchup wkt_*
 * wicket-type counts. Structural, not a key list: a COUNT (kind "total") that
 * is either flagged section "dismissal" (batting out_* + matchup_bowling wkt_*)
 * or key-prefixed "wkt_" (plain bowling wkt_*, which have no section field).
 * The out_*_pct percentages are kind "percent" (and section "dismissal"), so
 * they never match here — they're handled by isMetricRemovedFromFilters. */
export function isDismissalTypeMetric(metric) {
  if (metric.kind !== "total") return false;
  if (metric.section === "dismissal") return true;
  if (/^wkt_/.test(metric.key)) return true;
  return false;
}

/** "basic" | "dismissal" | "advanced" | null (null = removed from the dropdown). */
export function metricFilterGroup(metric) {
  if (isMetricRemovedFromFilters(metric)) return null;
  if (isDismissalTypeMetric(metric)) return "dismissal";
  return BASIC_METRIC_KEYS.has(metric.key) ? "basic" : "advanced";
}

/** Partition an eligible-metrics list into { basic, dismissal, advanced },
 * dropping the removed (dismissal-%) ones. Preserves catalogue order within
 * each group. */
export function partitionFilterMetrics(metrics) {
  const basic = [];
  const dismissal = [];
  const advanced = [];
  for (const m of metrics) {
    const g = metricFilterGroup(m);
    if (g === "basic") basic.push(m);
    else if (g === "dismissal") dismissal.push(m);
    else if (g === "advanced") advanced.push(m);
  }
  return { basic, dismissal, advanced };
}
