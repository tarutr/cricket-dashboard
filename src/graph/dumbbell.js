// src/graph/dumbbell.js
//
// Data layer for the Graph Builder's DUMBBELL chart (Batch 4 wave 2, task 2):
// one rate/percent metric, two matchup "Vs" buckets (Side A / Side B), one
// batter per row. Batting discipline only — matchup_bowling's grain is
// bowler-vs-striker-position, not bowler-vs-batting-hand-with-a-symmetric-
// second-bucket, so there is no analogous "two sides" comparison to chart
// there yet (same reasoning table.js's matchup mode already documents).
//
// ── No new SQL grammar (hard rule) ──────────────────────────────────────────
// fetchDumbbellSide() is the SAME "wrap idiom" src/graph/charts.js's
// fetchWindowMetric() already uses for the Slope chart: clone the live filter
// state, override ONE field (there: dateFrom/dateTo; here: matchupVs), call
// src/table.js's buildQuery() UNCHANGED, then restrict the result to the
// selected roster via an outer `SELECT * FROM (...) WHERE id IN (...)`.
// buildQuery() already dispatches to its internal (unexported) buildMatchupQuery
// whenever matchupVsActive(state) is true (state.js) — exactly what happens
// here once matchupVs is set to a batting-side bucket — so this module never
// needs its own copy of, or handle to, buildMatchupQuery itself.
//
// ── Vs vocabulary duplication (same precedent as timeseries.js) ─────────────
// table.js does not export its BOWLING_TYPE_PREFERENCE ordering, its
// orderBowlingTypes() helper, or its "distinct bowling_type" lookup query, and
// this batch's task brief permits exactly ONE change to table.js (the
// "Turn into graph" button's matchup-mode branch — see task 3), so those three
// pieces are duplicated here byte-for-semantics-identical, the same way
// src/graph/timeseries.js already duplicates table.js's per-discipline column
// maps with an explicit "table.js does not export these" note. The underlying
// SQL (`SELECT DISTINCT bowling_type FROM matchup_batting WHERE bowling_type
// <> '(unmapped)'`) is the exact query table.js's own ensureBowlingTypes()
// already runs — no new shape, just run a second time from this module.
//
// ── "Coverage" wording, disambiguated from table.js's ───────────────────────
// table.js's matchup-mode "Coverage" column means "share of this player's
// balls with a KNOWN bowling style at all" (mapped/total) — a data-completeness
// figure, identical for Side A and Side B since it isn't bucket-filtered. The
// dumbbell's tooltip instead needs "how much of this player's total workload
// was against THIS side's bucket specifically" (e.g. "vs Spin: 913 of 1,027
// balls") — a genuinely different, per-side number. That number is built from
// two columns every matchup query already emits with NO new SQL: each side's
// own FILTER'd "balls" metric (the numerator — balls faced against that side's
// bucket) over the query's unfiltered `__coverage_total` column (the
// denominator — the player's grand total balls across every bucket, mapped or
// not). This is a JUDGMENT CALL flagged for review: it reuses the word
// "coverage" for an adjacent-but-different concept than table.js's Coverage
// column, since no more specific existing term is defined in the codebase.

import { matchupBucketLabel } from "../metrics.js";
import { eligibleMetrics, escSql } from "../state.js";
import { buildQuery } from "../table.js";
import { query } from "../db.js";
import { escHtml, escAttr } from "../html.js";

// ── Duplicated from table.js (not exported there) — see file header. ───────
const BOWLING_TYPE_PREFERENCE = [
  "Off-spin",
  "Leg-spin",
  "Slow left-arm orthodox",
  "Left-arm wrist-spin",
  "Slow-medium",
  "Medium",
  "Medium-fast",
  "Fast-medium",
  "Fast",
];

function orderBowlingTypes(values) {
  const set = new Set(values);
  const known = BOWLING_TYPE_PREFERENCE.filter((v) => set.has(v));
  const knownSet = new Set(known);
  const buckets = ["Pace", "Spin"].filter((v) => set.has(v));
  const bucketSet = new Set(buckets);
  const rest = values.filter((v) => !knownSet.has(v) && !bucketSet.has(v)).sort();
  return [...known, ...rest, ...buckets];
}

/**
 * The distinct fine "Bowling type" values (matchup_batting's bowling_type,
 * excluding '(unmapped)'), ordered the same way table.js's "Vs" dropdown
 * orders them. Small, format-agnostic, rarely-changing lookup — callers
 * should cache the result themselves (graph.js does, mirroring table.js's own
 * bowlingTypesCache) rather than call this on every render.
 */
export async function fetchDumbbellBowlingTypes() {
  try {
    const { rows } = await query(
      `SELECT DISTINCT bowling_type AS v FROM matchup_batting WHERE bowling_type <> '(unmapped)'`
    );
    return orderBowlingTypes(rows.map((r) => r.v));
  } catch (e) {
    return [];
  }
}

/** The "Vs" vocabulary for ONE side select: Pace / Spin (coarse) + every fine
 * bowling type, encoded exactly as table.js encodes them ("group:Pace",
 * "type:Off-spin", …) so decodeVs()/encodeVs() round-trip with table.js's own
 * state.matchupVs shape. Deliberately NO "Everyone" option — a dumbbell side
 * must always be an actual bucket (unlike the table's Vs select, which also
 * offers "no matchup filter at all"). */
export function dumbbellVsOptionsHTML(bowlingTypes, selectedValue) {
  const opt = (value, label) =>
    `<option value="${escAttr(value)}" ${value === selectedValue ? "selected" : ""}>${escHtml(label)}</option>`;
  const typeOpts = bowlingTypes.map((t) => opt(`type:${t}`, matchupBucketLabel(t))).join("");
  return `
    <optgroup label="Pace / spin">
      ${opt("group:Pace", "Pace")}
      ${opt("group:Spin", "Spin")}
    </optgroup>
    <optgroup label="Bowling type">${typeOpts}</optgroup>
  `;
}

/** {dim, value} <-> "dim:value" — the same encoding table.js's own "Vs" select uses. */
export function encodeVs(vs) {
  return `${vs.dim}:${vs.value}`;
}
export function decodeVs(raw) {
  const idx = raw.indexOf(":");
  return { dim: raw.slice(0, idx), value: raw.slice(idx + 1) };
}

/** Human label for a {dim, value} bucket — "Pace", "Spin", or (fine styles)
 * the same "…(unspecified)" relabel matchupBucketLabel applies elsewhere. */
export function vsLabel(vs) {
  if (!vs) return "";
  return vs.dim === "type" ? matchupBucketLabel(vs.value) : vs.value;
}

/** Default Side A / Side B (owner ruling, task brief): Pace vs Spin. */
export function defaultDumbbellSides() {
  return { sideA: { dim: "group", value: "Pace" }, sideB: { dim: "group", value: "Spin" } };
}

// JUDGMENT CALL (task 3's bridge heuristic — flagged for review): classifies a
// FINE bowling_type into a pace/spin "family" purely to pick a sensible
// DEFAULT opposite side when bridging in from the table's matchup "Vs" filter
// (the user can always repick Side A afterward — this never limits what they
// can compare). The two lists are read straight off table.js's own
// BOWLING_TYPE_PREFERENCE ordering, which already groups the four named spin
// styles first, then a pace speed spectrum (slow-medium -> fast) — standard
// cricket terminology, not a new classification invented here.
const SPIN_TYPE_FAMILY = new Set(["Off-spin", "Leg-spin", "Slow left-arm orthodox", "Left-arm wrist-spin"]);
const PACE_TYPE_FAMILY = new Set(["Slow-medium", "Medium", "Medium-fast", "Fast-medium", "Fast"]);

/** "pace" | "spin" family for a {dim, value} bucket. dim "group" is exact;
 * dim "type" (a fine style) uses the family lists above; an unrecognised fine
 * style (shouldn't occur — the vocabulary is fixed — but handled defensively)
 * falls back to "spin" so the opposite-side default lands on "Pace". */
export function classifyBowlingFamily(vs) {
  if (!vs) return "spin";
  if (vs.dim === "group") return vs.value === "Pace" ? "pace" : "spin";
  if (vs.dim === "type") return PACE_TYPE_FAMILY.has(vs.value) ? "pace" : "spin";
  return "spin";
}

/** The task-3 bridge default for the side NOT supplied by the table: Pace if
 * `vs` is spin-family, Spin if `vs` is pace-family. */
export function oppositeDefaultSide(vs) {
  return classifyBowlingFamily(vs) === "pace" ? { dim: "group", value: "Spin" } : { dim: "group", value: "Pace" };
}

/** Metrics eligible for the dumbbell's metric select: the matchup_batting
 * namespace's rate/percent metrics (average, strike rate, dot%, boundary%,
 * balls-per-boundary/dismissal, phase rates, …), phase-gated by the current
 * format selection exactly like every other picker (state.js's
 * eligibleMetrics — the SAME resolution the restricted column picker and the
 * advanced-filter metric picker already use for this namespace). "total"/
 * "peak" kinds are excluded — a dumbbell's whole point is comparing a RATE
 * across two buckets; a raw ball/run/wicket total would just reflect how much
 * more a player faced one bucket than the other, not a performance gap. */
export function dumbbellEligibleMetrics(formats) {
  return eligibleMetrics("matchup_batting", formats).filter((m) => m.kind === "rate" || m.kind === "percent");
}

/**
 * Run ONE side of the dumbbell comparison: the SAME buildQuery() the table
 * itself would run in matchup mode, parameterised by `vs` instead of the live
 * state's own matchupVs, restricted to the selected roster ids — the exact
 * wrap idiom fetchWindowMetric() (charts.js) uses for the Slope chart's two
 * date windows, just overriding a different single field. Every other filter
 * (gender/formats/dates/teams/team type/opposition/positions/min-innings/
 * profile) comes from `state` unchanged, so a dumbbell side describes the
 * exact same scope the live filter bar describes, just against one bucket.
 *
 * The min-innings gate is evaluated INDEPENDENTLY per side (buildMatchupQuery's
 * own `__innings_gate`, FILTER'd by that side's own bucket) — same reasoning
 * as the Slope chart's per-window gate: a player can genuinely have enough
 * innings against Pace but not against Spin, and that's a real "no data for
 * this side" case, not a bug.
 *
 * Also requests the "balls" metric on every call (in addition to the charted
 * metric) — the numerator for the per-side "N of M balls" tooltip figure (see
 * file header's "Coverage wording" note). `__coverage_total`/
 * `__coverage_mapped` ride along automatically (buildMatchupQuery always emits
 * them) with no extra ask.
 *
 * @param {object} state the live filter state (must have discipline: "batting")
 * @param {{dim: "group"|"type", value: string}} vs this side's bucket
 * @param {string[]} playerIds
 * @param {object} metric a metrics.js metric (matchup_batting namespace)
 * @returns {Promise<Map<string, object>>} id -> row (id, name, [metric.key],
 *   balls, __coverage_total, __coverage_mapped)
 */
export async function fetchDumbbellSide(state, vs, playerIds, metric) {
  if (!Array.isArray(playerIds) || playerIds.length === 0) return new Map();
  const sideState = { ...state, matchupVs: vs };
  const { sql } = buildQuery(sideState, [metric.key, "balls"]);
  const idsSql = playerIds.map((id) => `'${escSql(id)}'`).join(", ");
  const outerSql = `SELECT * FROM (\n${sql}\n) dumbbell_q\nWHERE id IN (${idsSql})`;
  const { rows } = await query(outerSql);
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}
