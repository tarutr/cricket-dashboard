// src/graph/radarGroups.js
//
// Curated radar metric GROUPS for the Graph Builder (SPEC §6). References
// metric KEYS ONLY from src/metrics.js — no new metric vocabulary is defined
// here (§8.2: one metrics module). Each group is scoped to a discipline and,
// where relevant, a specific format bucket (owner direction, Phase 3 brief).
//
// Gating: a group is offered only when every one of its metric keys currently
// resolves via eligibleMetrics(discipline, formats) — i.e. phase groups only
// surface under the exact format scope their phase metrics require
// (phaseMetricAllowed / §8.9), reusing state.js's existing predicate rather
// than re-deriving format logic here.

import { eligibleMetrics } from "../state.js";

/** All curated groups, keyed by discipline. Metric keys must exist in metrics.js. */
const RADAR_GROUPS = {
  batting: [
    {
      id: "batting-reliability",
      label: "Reliability",
      scope: "all", // offered regardless of format, subject to normal eligibility
      metricKeys: ["average", "balls_per_dismissal", "runs_per_innings"],
    },
    {
      id: "batting-scoring-shape",
      label: "Scoring shape",
      scope: "all",
      metricKeys: ["strike_rate", "boundary_pct", "dot_pct"],
    },
    {
      id: "batting-impact-t20",
      label: "Impact",
      scope: "t20", // T20 bucket only (owner direction)
      metricKeys: ["strike_rate", "boundary_pct", "balls_per_boundary"],
    },
    {
      id: "batting-phase-t20",
      label: "Phase mastery",
      scope: "t20",
      metricKeys: ["pp_strike_rate", "mid_strike_rate", "death_strike_rate"],
    },
    {
      id: "batting-phase-odi",
      label: "Phase mastery (ODI)",
      scope: "odi",
      metricKeys: ["odi_pp_strike_rate", "odi_mid_strike_rate", "odi_death_strike_rate"],
    },
  ],
  bowling: [
    {
      id: "bowling-wicket-taking",
      label: "Wicket-taking",
      scope: "all",
      metricKeys: ["wickets_per_innings", "strike_rate", "average"],
    },
    {
      id: "bowling-control",
      label: "Control",
      scope: "all",
      metricKeys: ["economy", "dot_pct", "boundary_pct_conceded"],
    },
    {
      id: "bowling-phase-t20",
      label: "Phase mastery",
      scope: "t20",
      metricKeys: ["pp_economy", "death_economy", "death_wickets"],
    },
    {
      id: "bowling-phase-odi",
      label: "Phase mastery (ODI)",
      scope: "odi",
      metricKeys: ["odi_pp_economy", "odi_death_economy", "odi_death_wickets"],
    },
  ],
};

/**
 * Groups currently eligible for `discipline` under the current `formats`
 * scope. A group is eligible only if EVERY one of its metric keys is
 * currently eligible (phaseMetricAllowed-gated) — this naturally restricts
 * "scope: t20" groups to the T20 bucket and "scope: odi" groups to ODI/ODM,
 * since their phase metric keys fail eligibility otherwise. "scope: all"
 * groups use only non-phase metrics, so they're always eligible.
 */
export function eligibleRadarGroups(discipline, formats) {
  const allowedKeys = new Set(eligibleMetrics(discipline, formats).map((m) => m.key));
  const groups = RADAR_GROUPS[discipline] || [];
  return groups.filter((g) => g.metricKeys.every((k) => allowedKeys.has(k)));
}

/** Look up one group by id within a discipline (or null). */
export function getRadarGroup(discipline, id) {
  const groups = RADAR_GROUPS[discipline] || [];
  return groups.find((g) => g.id === id) ?? null;
}
