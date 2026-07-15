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

/**
 * Families currently eligible for `discipline` under the current `formats`
 * scope — an all-members-must-be-eligible gate. "Innings build-up SR" uses
 * non-phase metric keys, so
 * it's always eligible; the T20 phase families are restricted to the T20
 * bucket because their member metrics fail phaseMetricAllowed elsewhere.
 */
export function eligiblePhaseFamilies(discipline, formats) {
  const allowedKeys = new Set(eligibleMetrics(discipline, formats).map((m) => m.key));
  const families = PHASE_FAMILIES[discipline] || [];
  return families.filter((f) => f.members.every((mm) => allowedKeys.has(mm.key)));
}

/** Look up one family by id within a discipline (or null). */
export function getPhaseFamily(discipline, id) {
  const families = PHASE_FAMILIES[discipline] || [];
  return families.find((f) => f.id === id) ?? null;
}
