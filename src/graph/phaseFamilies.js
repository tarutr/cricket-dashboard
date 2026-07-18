// src/graph/phaseFamilies.js
//
// Curated metric FAMILIES for the Graph Builder's "Phases" chart type (Batch 4
// part 1, decision 43). Each family is a small ordered list of metric KEYS
// from src/metrics.js ONLY — no new metric vocabulary defined here (§8.2).
//
// Gating: a family is offered only
// when EVERY one of its member metric keys currently resolves via
// eligibleMetrics(discipline, formats) — i.e. the T20-range families surface
// only under the exact T20 format scope their phase metrics require
// (phaseMetricAllowed / §8.9), reusing state.js's existing predicate rather
// than re-deriving format logic here.
//
// Bowling note: the task brief that requested this module described a T20
// "Powerplay · Middle · Death" economy family, mirroring the batting phase-SR
// family. metrics.js has no `mid_economy` key for the plain bowling
// discipline (only the matchup_bowling namespace does, and this chart never
// uses matchup namespaces — see charts.js's fetchSelectedPlayerMetrics, which
// always queries the plain batting/bowling views). So the bowling family below
// is genuinely two-phase (Powerplay, Death) rather than three — labelled
// honestly to say so, per the task brief's own fallback instruction ("if there
// is no mid_economy key, use the two that exist and label honestly").

import { eligibleMetrics } from "../state.js";

const PHASE_FAMILIES = {
  batting: [
    {
      id: "batting-phase-sr-t20",
      label: "Phase strike rate (T20: PP · middle · death)",
      members: [
        { key: "pp_strike_rate", phaseLabel: "Powerplay" },
        { key: "mid_strike_rate", phaseLabel: "Middle" },
        { key: "death_strike_rate", phaseLabel: "Death" },
      ],
    },
    {
      id: "batting-buildup-sr",
      label: "Innings build-up SR (balls 1–10 · 11–20 · 21+)",
      members: [
        { key: "sr_first10", phaseLabel: "Balls 1–10" },
        { key: "sr_11_20", phaseLabel: "Balls 11–20" },
        { key: "sr_21plus", phaseLabel: "Balls 21+" },
      ],
    },
  ],
  bowling: [
    {
      // Relabelled 2-phase family — see file header note (no mid_economy key
      // in the plain bowling discipline).
      id: "bowling-phase-economy-t20",
      label: "Phase economy (T20: PP · death)",
      members: [
        { key: "pp_economy", phaseLabel: "Powerplay" },
        { key: "death_economy", phaseLabel: "Death" },
      ],
    },
  ],
};

// Wave B (matchup-aware Graph): the matchup namespaces reuse the plain
// discipline's family definitions — matchup_batting has the same phase-SR keys
// (pp_/mid_/death_strike_rate) as plain batting; matchup_bowling has
// pp_economy/death_economy like plain bowling. A namespace that isn't a key of
// PHASE_FAMILIES (matchup_*) maps to its plain discipline here.
const FAMILY_DISCIPLINE_FOR_NS = { matchup_batting: "batting", matchup_bowling: "bowling" };

/**
 * Families currently eligible for `ns` (a discipline OR a matchup namespace)
 * under the current `formats` scope. A family member is kept only when its
 * metric key resolves via eligibleMetrics(ns, formats) — so the T20 phase
 * families stay restricted to the T20 bucket (their member metrics fail
 * phaseMetricAllowed elsewhere), and a member absent from the namespace (e.g.
 * the "Innings build-up SR" keys, which the matchup namespaces don't define —
 * X-ball SR vs a style was ruled meaningless) is dropped GRACEFULLY rather than
 * crashing; a family that keeps >= 2 phases is offered. For a PLAIN namespace
 * this is byte-identical to the old all-members gate: every plain family's
 * members share the same phase-gating, so they're all eligible together or not
 * at all (never a partial set), and every family has >= 2 members.
 */
export function eligiblePhaseFamilies(ns, formats) {
  const allowedKeys = new Set(eligibleMetrics(ns, formats).map((m) => m.key));
  const families = PHASE_FAMILIES[ns] || PHASE_FAMILIES[FAMILY_DISCIPLINE_FOR_NS[ns]] || [];
  return families
    .map((f) => ({ ...f, members: f.members.filter((mm) => allowedKeys.has(mm.key)) }))
    .filter((f) => f.members.length >= 2);
}

