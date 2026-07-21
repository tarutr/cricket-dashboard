// src/graph/timeseries.js
//
// Line-chart DATA ENGINE for the Graph Builder (R5-D, decisions 51 + 53).
//
// The Line chart is: ONE Y-metric × ONE X-dimension × up to 6 player lines.
// This module turns an (X-dimension, metric, roster, scope) request into a SQL
// query, runs it, and returns a structured, per-player, per-bucket dataset the
// renderer (timeseriesChart.js) draws. It REPLACES the old year-only
// buildTimeseriesQuery/buildMatchupTimeseriesQuery entirely.
//
// ── RULE 1 (numbers are sacred) — how it is upheld here ──────────────────────
// The per-bucket Y value is ALWAYS metrics.js's own `sqlExpression` for the
// requested metric, interpolated VERBATIM into a query whose ONLY difference
// from src/table.js's buildQuery is the GROUP BY grain: instead of grouping per
// player, we group per (player, <X-bucket>). Totals (SUM) sum per bucket; rates
// recombine per bucket (SR per year = Σ(year runs)/NULLIF(Σ(year balls),0)×100,
// never an average of per-innings rates) because the metric expression is a
// ratio of SUMs and we only change what rows fall in each group. For X=Innings
// each bucket is exactly one innings, so the same expression over a single-row
// group yields that innings' value. No per-bucket math is ever invented here.
// Every SPEC §4.1 rule stays inherited from the pipeline-baked innings views
// (super overs excluded, legal-ball defs, bowler-credited wickets, retired-out
// dismissal set, byes/leg-byes out of runs_conceded, boundary rule, phases).
//
// The WHERE clause is built by the SAME shared helper table.js uses —
// filters.js buildScopeClauses(state, opts) — with the SAME options, so a Line
// always describes the exact slice of cricket the leaderboard describes.
//
// ── Namespace (matchup "Vs") awareness ───────────────────────────────────────
// The engine resolves the effective namespace via state.js's effectiveNamespace:
// when a "Vs" bucket is active (matchupVsActive) it queries the matchup_* view
// with the active bucket predicate in WHERE and the matchup-namespace metric
// expression, so a Vs Line trends the SAME number the Vs table shows for that
// slice (e.g. SA Yadav runs-vs-Spin by year = 141+92+63+158 = 454, the anchor).
// Two X-dimensions are exceptions, documented at their registry entries:
//   • "innings" (index) needs one row per innings, which the multi-row-per-
//     innings matchup grain does not provide → it is offered ONLY in plain mode.
//   • "vs_bowling" IS itself a matchup dimension (it enumerates bowling_group on
//     matchup_batting) → offered ONLY in plain BATTING mode (a fixed Vs bucket
//     would contradict enumerating the buckets).
//
// ── NO DATA-POLICING (decision 49) ───────────────────────────────────────────
// Every point is plotted however thin the sample. There is NO per-bucket sample
// floor — MIN_BALLS_PER_YEAR is gone. `sample` (balls faced/bowled per bucket)
// is still emitted, but purely as informational tooltip text, never a gate.

import { getMetric } from "../metrics.js";
import { buildScopeClauses } from "../filters.js";
import { query } from "../db.js";
import { escSql, matchupVsActive, effectiveNamespace, eligibleMetrics } from "../state.js";

// Per-namespace column maps. table.js does not export its equivalents and this
// module must not modify other files, so they are duplicated here (kept
// byte-identical to table.js's VIEW/ID_COL/NAME_COL/TEAM_COL/OPP_COL and the
// MATCHUP_* maps). `team` = the player's OWN side; `opp` = the opposition side;
// `ballsExpr` = the per-bucket sample size (balls faced batting / bowled
// bowling), matching metrics.js's own SR/economy denominators.
const NS = {
  batting:         { id: "batter_id", name: "batter_name", team: "batting_team", opp: "bowling_team", ballsExpr: "SUM(balls_faced)" },
  bowling:         { id: "bowler_id", name: "bowler_name", team: "bowling_team", opp: "batting_team", ballsExpr: "SUM(balls)" },
  matchup_batting: { id: "batter_id", name: "batter_name", team: "batting_team", opp: "bowling_team", ballsExpr: "SUM(balls_faced)" },
  matchup_bowling: { id: "bowler_id", name: "bowler_name", team: "bowling_team", opp: "batting_team", ballsExpr: "SUM(balls)" },
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Phase decomposition (X = Phase) ──────────────────────────────────────────
// The Phase dimension is a wide→long PIVOT, not a GROUP BY: cricket stores each
// phase as its own column family, not as rows. So a phase-by-phase Line REUSES
// the EXISTING phase metric DEFINITIONS from metrics.js (pp_/mid_/death_ for
// T20, odi_* for 50-over) — never a hand-written SUM(pp_runs). A base metric is
// "phase-decomposable" only if its phase-member metrics exist AND are eligible
// for the current scope (phaseMetricAllowed gates T20 vs ODI, and plain bowling
// carries only PP+Death while matchup_bowling carries PP+Mid+Death — eligibility
// prunes both correctly, exactly as phaseFamilies.js does). Runs / Balls have NO
// phase metric definition, so — per the brief's "a metric with no phase
// decomposition → not offered" — they are NOT offered under X=Phase (inventing
// SUM(pp_runs) would violate Rule 1). Members are format-mutually-exclusive
// (phaseMetricAllowed), so filtering the flat candidate list by eligibility
// yields exactly one family with no duplicate phase labels.
const PHASE_MEMBERS = {
  strike_rate: [
    { key: "pp_strike_rate", phaseLabel: "Powerplay" },
    { key: "mid_strike_rate", phaseLabel: "Middle" },
    { key: "death_strike_rate", phaseLabel: "Death" },
    { key: "odi_pp_strike_rate", phaseLabel: "Powerplay" },
    { key: "odi_mid_strike_rate", phaseLabel: "Middle" },
    { key: "odi_death_strike_rate", phaseLabel: "Death" },
  ],
  economy: [
    { key: "pp_economy", phaseLabel: "Powerplay" },
    { key: "mid_economy", phaseLabel: "Middle" },
    { key: "death_economy", phaseLabel: "Death" },
    { key: "odi_pp_economy", phaseLabel: "Powerplay" },
    { key: "odi_mid_economy", phaseLabel: "Middle" },
    { key: "odi_death_economy", phaseLabel: "Death" },
  ],
  wickets: [
    { key: "pp_wickets", phaseLabel: "Powerplay" },
    { key: "mid_wickets", phaseLabel: "Middle" },
    { key: "death_wickets", phaseLabel: "Death" },
    { key: "odi_pp_wickets", phaseLabel: "Powerplay" },
    { key: "odi_mid_wickets", phaseLabel: "Middle" },
    { key: "odi_death_wickets", phaseLabel: "Death" },
  ],
};
const PHASE_ORDER = { Powerplay: 0, Middle: 1, Death: 2 };

/** The eligible phase members for a base metric key under the current scope, in
 * chronological phase order. Empty when the metric has no (or <2) usable phase
 * members — i.e. it is not phase-decomposable here. */
function phaseMembersFor(baseKey, ns, formats) {
  const candidates = PHASE_MEMBERS[baseKey];
  if (!candidates) return [];
  const eligible = new Set(eligibleMetrics(ns, formats).map((m) => m.key));
  const members = candidates
    .filter((c) => eligible.has(c.key))
    .sort((a, b) => PHASE_ORDER[a.phaseLabel] - PHASE_ORDER[b.phaseLabel]);
  return members.length >= 2 ? members : [];
}

// ── The X-dimension registry ─────────────────────────────────────────────────
// Each entry declares everything the SQL builder and the renderer need. `kind`
// drives rendering semantics only (sequential = trajectory, categorical =
// profile); both render as one Chart.js line across ordered buckets. `fill`
// (numeric only) makes the axis contiguous so a mid-range gap reads as "didn't
// play that bucket" at the right slot (display-only; never changes a number).
//
// SQL categories:
//   • groupby — GROUP BY ALL on the effective view; bucket = a plain column /
//     arithmetic; ord = the same (numeric) for sequential, or a per-(player,
//     bucket) MIN(date) for chronological categoricals.
//   • join    — a CTE builds the scope on the base view (bare column names, no
//     ambiguity), then JOINs the unique `matches` row for match-level columns
//     (event_name / venue / winner+result_type). Metric aggregates resolve to
//     the base view (matches shares no metric column). matches is 1 row/match_id
//     (verified) so the join never fans out a SUM.
//   • window  — a CTE assigns ROW_NUMBER() per player over their own innings,
//     then GROUP BY (player, index): each bucket is one innings.
//   • phase   — wide→long pivot (own builder), reuses phase metric defs.
//   • matchupdim — vs_bowling: matchup_batting grouped by bowling_group.
const X_DIMS = {
  innings: {
    key: "innings", label: "Innings (career sequence)", kind: "sequential", fill: "int",
    battingOnly: false, category: "window",
    // dates decide the POOL; each player is aligned by their OWN 1,2,3… sequence.
    // Needs one row per innings → PLAIN views only (matchup grain is multi-row).
    matchupOK: false,
    xLabel: (k) => String(k),
  },
  month: {
    key: "month", label: "Date — month", kind: "sequential", fill: "month",
    battingOnly: false, category: "groupby", matchupOK: true,
    bucket: "(year * 100 + month)", ord: "(year * 100 + month)", groupCols: ["year", "month"],
    xLabel: (k) => `${MONTH_NAMES[(k % 100) - 1]} ${Math.floor(k / 100)}`,
  },
  year: {
    key: "year", label: "Date — year", kind: "sequential", fill: "int",
    battingOnly: false, category: "groupby", matchupOK: true,
    bucket: "year", ord: "year", groupCols: ["year"],
    xLabel: (k) => String(k),
  },
  event: {
    key: "event", label: "Date — event / competition", kind: "categorical", fill: null,
    battingOnly: false, category: "join", matchupOK: true,
    matchCol: "event_name",
    xLabel: (k) => String(k),
  },
  phase: {
    key: "phase", label: "Phase (powerplay / middle / death)", kind: "sequential", fill: null,
    battingOnly: false, category: "phase", matchupOK: true,
    xLabel: (k) => String(k),
  },
  position: {
    key: "position", label: "Batting position (1–11)", kind: "sequential", fill: "int",
    battingOnly: true, category: "groupby", matchupOK: true,
    bucket: "batting_position", ord: "batting_position", groupCols: ["batting_position"],
    xLabel: (k) => String(k),
  },
  vs_bowling: {
    key: "vs_bowling", label: "Vs bowling type (pace / spin)", kind: "categorical", fill: null,
    battingOnly: true, category: "matchupdim", matchupOK: false,
    xLabel: (k) => String(k),
  },
  opposition: {
    key: "opposition", label: "Opposition team", kind: "categorical", fill: null,
    battingOnly: false, category: "groupby", matchupOK: true,
    // bucket/ord filled per-namespace at build time (opp column differs).
    xLabel: (k) => String(k),
  },
  venue: {
    key: "venue", label: "Venue (ground)", kind: "categorical", fill: null,
    battingOnly: false, category: "join", matchupOK: true,
    matchCol: "venue",
    xLabel: (k) => String(k),
  },
  innings_of_match: {
    key: "innings_of_match", label: "Innings of match (bat first / chase)", kind: "sequential", fill: "int",
    battingOnly: false, category: "groupby", matchupOK: true,
    bucket: "innings_number", ord: "innings_number", groupCols: ["innings_number"],
    // innings_number is 0-BASED (verified: innings 0 = team_1 = batting first in
    // 100% of rows; innings 1 = chasing). The rare 3rd/4th innings of multi-
    // innings formats read as human-friendly 1-based "Innings 3 / 4".
    xLabel: (k) => (k === 0 ? "Batting first" : k === 1 ? "Chasing" : `Innings ${k + 1}`),
  },
  result: {
    key: "result", label: "Match result (won / lost)", kind: "categorical", fill: null,
    battingOnly: false, category: "join", matchupOK: true,
    // bucket/ord are a CASE over m.winner/m.result_type vs the player's own team,
    // filled per-namespace at build time (team column differs).
    xLabel: (k) => String(k),
  },
};

// Display order of the X-axis dropdown (owner's brief order).
const X_DIM_ORDER = [
  "innings", "month", "year", "event", "phase", "position",
  "vs_bowling", "opposition", "venue", "innings_of_match", "result",
];

/** Is a metric usable as a Line Y-value? Same recombination rule the old
 * timeseriesSupported enforced: kind ∈ {total, rate, percent} (each is a SUM or
 * a ratio of SUMs that regroups cleanly per bucket) AND the value is computable
 * from the innings/matchup views (source ≠ player_matches — that drops the one
 * "matches" total, whose COUNT(DISTINCT match_id) would silently redefine over a
 * bucket). Peaks (high_score MAX / best "W-R" string) are non-additive → out. */
export function lineMetricSupported(metricDef) {
  if (!metricDef) return false;
  const trendable =
    metricDef.kind === "total" || metricDef.kind === "rate" || metricDef.kind === "percent";
  if (!trendable) return false;
  if (metricDef.source === "matchup") return true;
  return metricDef.source === "innings"; // drops player_matches-sourced "matches"
}
// Back-compat alias name kept for any external reference; identical predicate.
export const timeseriesSupported = lineMetricSupported;

/** The metric NAMESPACE the Line Y-metric is resolved in for a given X-dim.
 * vs_bowling is inherently matchup_batting; every other dim follows the
 * effective namespace (matchup_* under an active Vs bucket, else plain). */
export function lineMetricNamespace(xDim, state) {
  if (xDim === "vs_bowling") return "matchup_batting";
  return effectiveNamespace(state);
}

/** Which X-dimensions are offerable right now, in dropdown order. Batting-only
 * dims (position, vs_bowling) drop out of any bowling context; vs_bowling and
 * innings-index drop out under an active Vs bucket (see registry notes). Phase
 * is offered whenever ANY phase-decomposable metric exists for the scope. */
export function lineDimsFor(state) {
  const disciplineIsBatting = state.discipline === "batting";
  const vsActive = matchupVsActive(state);
  const ns = effectiveNamespace(state);
  const out = [];
  for (const key of X_DIM_ORDER) {
    const d = X_DIMS[key];
    if (d.battingOnly && !disciplineIsBatting) continue;
    if (!d.matchupOK && vsActive) continue; // innings-index & vs_bowling
    if (key === "phase") {
      // Offer Phase only if at least one base metric decomposes for this scope.
      const any = Object.keys(PHASE_MEMBERS).some((baseKey) => {
        const base = getMetric(baseKey, ns);
        return base && phaseMembersFor(baseKey, ns, state.formats).length > 0;
      });
      if (!any) continue;
    }
    out.push({ key: d.key, label: d.label });
  }
  return out;
}

/** The eligible Y-metrics for a given X-dim under the current scope. Most dims
 * accept any lineMetricSupported metric in the metric namespace; Phase is
 * restricted to phase-decomposable base metrics (SR; economy/wickets bowling). */
export function lineMetricsFor(xDim, state) {
  const formats = state.formats;
  const ns = lineMetricNamespace(xDim, state);
  const all = eligibleMetrics(ns, formats).filter(
    (m) => m.kind !== "composition" && m.key !== "best" && lineMetricSupported(m)
  );
  if (xDim === "phase") {
    return all.filter((m) => phaseMembersFor(m.key, ns, formats).length > 0);
  }
  return all;
}

// ── SQL construction ─────────────────────────────────────────────────────────

/** The shared scope WHERE clauses for the effective view, mirroring exactly what
 * table.js/charts.js pass (includeTeams, team/opp columns, idColumn, and
 * includePositions everywhere except PLAIN bowling, whose view has no
 * batting_position column). Adds the roster id restriction and, under an active
 * Vs bucket, the bucket predicate. Returns { view, cols, whereClauses }. */
function scopeFor(ns, state, playerIds, { forVsBowling = false } = {}) {
  const cols = NS[ns];
  const whereClauses = buildScopeClauses(state, {
    includeTeams: true,
    teamColumn: cols.team,
    idColumn: cols.id,
    oppositionColumn: cols.opp,
    includePositions: ns !== "bowling",
  });

  // Active Vs bucket predicate (matchup namespaces only, and NOT for the
  // vs_bowling dimension which enumerates the buckets itself). Mirrors
  // buildMatchupQuery's dim→column mapping (hand → batting_hand, type →
  // bowling_type, group → bowling_group). Numerically identical to buildMatchup-
  // Query's per-aggregate FILTER for these no-coverage-column queries.
  if (!forVsBowling && matchupVsActive(state) && (ns === "matchup_batting" || ns === "matchup_bowling")) {
    const mv = state.matchupVs;
    const bucketCol = mv.dim === "hand" ? "batting_hand" : mv.dim === "type" ? "bowling_type" : "bowling_group";
    whereClauses.push(`${bucketCol} = '${escSql(mv.value)}'`);
  }

  const ids = Array.isArray(playerIds) ? playerIds.filter((x) => x != null) : [];
  if (ids.length > 0) {
    whereClauses.push(`${cols.id} IN (${ids.map((id) => `'${escSql(id)}'`).join(", ")})`);
  } else {
    whereClauses.push("FALSE"); // no roster → no rows (never an unbounded scan)
  }
  return { cols, whereClauses };
}

/** Build the SQL for one (xDim, metric) request in namespace `ns`. Returns the
 * SQL string. The metric's sqlExpression is interpolated verbatim (Rule 1). */
function buildLineSql({ xDim, metric, ns, state, playerIds }) {
  const d = X_DIMS[xDim];
  if (!d) throw new Error(`buildLineSql: unknown X-dimension "${xDim}"`);

  // ── vs_bowling: matchup_batting grouped by bowling_group (own scope: no Vs
  //    predicate; excludes the '(unmapped)' bucket, decision 21). ────────────
  if (d.category === "matchupdim") {
    const { cols, whereClauses } = scopeFor("matchup_batting", state, playerIds, { forVsBowling: true });
    whereClauses.push("bowling_group <> '(unmapped)'");
    return [
      `SELECT ${cols.id} AS player_id,`,
      `       MAX(${cols.name}) AS player_name,`,
      `       bowling_group AS bucket,`,
      `       CASE bowling_group WHEN 'Pace' THEN 0 WHEN 'Spin' THEN 1 ELSE 2 END AS bucket_ord,`,
      `       ${metric.sqlExpression} AS value,`,
      `       ${cols.ballsExpr} AS sample`,
      `FROM matchup_batting`,
      `WHERE ${whereClauses.join(" AND ")}`,
      `GROUP BY ALL`,
      `ORDER BY player_id, bucket_ord`,
    ].join("\n");
  }

  const { cols, whereClauses } = scopeFor(ns, state, playerIds);

  // ── window (innings index): PLAIN only. ROW_NUMBER per player over their own
  //    innings; each (player, index) group is exactly one innings. ───────────
  if (d.category === "window") {
    return [
      `WITH base AS (`,
      `  SELECT *, ROW_NUMBER() OVER (PARTITION BY ${cols.id} ORDER BY match_date, innings_number, match_id) AS inns_idx`,
      `  FROM ${ns}`,
      `  WHERE ${whereClauses.join(" AND ")}`,
      `)`,
      `SELECT ${cols.id} AS player_id,`,
      `       MAX(${cols.name}) AS player_name,`,
      `       inns_idx AS bucket,`,
      `       inns_idx AS bucket_ord,`,
      `       ${metric.sqlExpression} AS value,`,
      `       ${cols.ballsExpr} AS sample`,
      `FROM base`,
      `GROUP BY ALL`,
      `ORDER BY player_id, bucket_ord`,
    ].join("\n");
  }

  // ── join (event / venue / result): CTE scopes the base view (bare names), then
  //    JOINs the unique matches row for the match-level column. ───────────────
  if (d.category === "join") {
    let bucketExpr, ordExpr;
    if (xDim === "result") {
      // Player's own team = cols.team (batting_team batting / bowling_team
      // bowling). A decisive match always has a winner (verified: all tie/no-
      // result/draw rows have NULL winner); ties/no-result/draw fall through to
      // result_type. Categorical fixed order: Won, Lost, Tie, No result, Draw.
      bucketExpr =
        `CASE ` +
        `WHEN m.winner IS NOT NULL AND m.winner <> '' AND m.winner = base.${cols.team} THEN 'Won' ` +
        `WHEN m.winner IS NOT NULL AND m.winner <> '' THEN 'Lost' ` +
        `WHEN m.result_type LIKE 'tie%' THEN 'Tie' ` +
        `WHEN m.result_type = 'no result' THEN 'No result' ` +
        `WHEN m.result_type = 'draw' THEN 'Draw' ` +
        `ELSE 'No result' END`;
      ordExpr =
        `CASE ` +
        `WHEN m.winner IS NOT NULL AND m.winner <> '' AND m.winner = base.${cols.team} THEN 0 ` +
        `WHEN m.winner IS NOT NULL AND m.winner <> '' THEN 1 ` +
        `WHEN m.result_type LIKE 'tie%' THEN 2 ` +
        `WHEN m.result_type = 'no result' THEN 3 ` +
        `WHEN m.result_type = 'draw' THEN 4 ` +
        `ELSE 3 END`;
    } else {
      bucketExpr = `m.${d.matchCol}`;
      // chronological categorical: first appearance across the player's rows.
      ordExpr = `MIN(base.match_date) - DATE '1970-01-01'`;
    }
    return [
      `WITH base AS (`,
      `  SELECT * FROM ${ns}`,
      `  WHERE ${whereClauses.join(" AND ")}`,
      `)`,
      `SELECT base.${cols.id} AS player_id,`,
      `       MAX(base.${cols.name}) AS player_name,`,
      `       ${bucketExpr} AS bucket,`,
      `       ${ordExpr} AS bucket_ord,`,
      `       ${metric.sqlExpression} AS value,`,
      `       ${cols.ballsExpr} AS sample`,
      `FROM base JOIN matches m ON base.match_id = m.match_id`,
      // event/venue with a NULL/empty match column are dropped (not a real bucket).
      ...(xDim === "result" ? [] : [`WHERE ${bucketExpr} IS NOT NULL AND ${bucketExpr} <> ''`]),
      `GROUP BY ALL`,
      `ORDER BY player_id, bucket_ord`,
    ].join("\n");
  }

  // ── groupby (year / month / position / innings_of_match / opposition) ──────
  let bucketExpr = d.bucket;
  let ordExpr = d.ord;
  if (xDim === "opposition") {
    bucketExpr = cols.opp; // opposition team = the other side
    ordExpr = `MIN(match_date) - DATE '1970-01-01'`; // chronological first meeting
  }
  return [
    `SELECT ${cols.id} AS player_id,`,
    `       MAX(${cols.name}) AS player_name,`,
    `       ${bucketExpr} AS bucket,`,
    `       ${ordExpr} AS bucket_ord,`,
    `       ${metric.sqlExpression} AS value,`,
    `       ${cols.ballsExpr} AS sample`,
    `FROM ${ns}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ALL`,
    `ORDER BY player_id, bucket_ord`,
  ].join("\n");
}

/** Build the Phase (wide→long) SQL: one row per player, one column per phase
 * member (each an EXISTING phase metric's sqlExpression), plus the phase balls
 * as an informational sample per phase. Pivoted to buckets in fetchLineData. */
function buildPhaseSql({ members, ns, state, playerIds }) {
  const { cols, whereClauses } = scopeFor(ns, state, playerIds);
  const selects = [`${cols.id} AS player_id`, `MAX(${cols.name}) AS player_name`];
  members.forEach((m, i) => {
    const metric = getMetric(m.key, ns);
    if (!metric) throw new Error(`buildPhaseSql: unknown phase member "${m.key}" in ${ns}`);
    selects.push(`${metric.sqlExpression} AS ph_${i}`);
  });
  return [
    `SELECT ${selects.join(",\n       ")}`,
    `FROM ${ns}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${cols.id}`,
    `ORDER BY player_id`,
  ].join("\n");
}

// ── Axis assembly ─────────────────────────────────────────────────────────────

/** Global ordered bucket axis from the raw rows, plus optional contiguous fill
 * of a numeric sequential axis (year / position / innings / innings-of-match)
 * and month. Fill is DISPLAY-ONLY — filled buckets carry no data for anyone, so
 * they render as gaps; they never touch a computed value. */
function assembleBuckets(rows, dim) {
  const byKey = new Map(); // bucketKey -> min ord seen
  for (const r of rows) {
    const key = normaliseKey(r.bucket, dim);
    const ord = Number(r.bucket_ord);
    if (!byKey.has(key) || ord < byKey.get(key)) byKey.set(key, ord);
  }
  let keys = [...byKey.keys()];

  if (dim.fill === "int" && keys.length) {
    const nums = keys.map(Number);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    keys = [];
    for (let v = lo; v <= hi; v++) keys.push(v);
    return keys.map((k) => ({ key: k, label: dim.xLabel(k), ord: k }));
  }
  if (dim.fill === "month" && keys.length) {
    const nums = keys.map(Number);
    const lo = Math.min(...nums), hi = Math.max(...nums);
    let y = Math.floor(lo / 100), mo = lo % 100;
    const outK = [];
    while (y * 100 + mo <= hi) {
      outK.push(y * 100 + mo);
      mo += 1;
      if (mo > 12) { mo = 1; y += 1; }
    }
    return outK.map((k) => ({ key: k, label: dim.xLabel(k), ord: k }));
  }
  // Categorical / no-fill: only buckets present, ordered by min ord then label.
  return keys
    .map((k) => ({ key: k, label: dim.xLabel(k), ord: byKey.get(k) }))
    .sort((a, b) => a.ord - b.ord || String(a.label).localeCompare(String(b.label)));
}

/** Coerce a raw bucket value into a stable JS map key: numbers for numeric
 * dims (so 2024 and "2024" collapse), the string itself for categoricals. */
function normaliseKey(raw, dim) {
  if (dim.fill === "int" || dim.fill === "month") return Number(raw);
  if (dim.key === "innings" || dim.key === "year" || dim.key === "month" ||
      dim.key === "position" || dim.key === "innings_of_match") return Number(raw);
  return raw;
}

// ── Public engine entry ────────────────────────────────────────────────────────

/**
 * Run one Line request and return a structured dataset. This is the importable
 * engine function used both by the renderer and for console verification.
 *
 * @param {object} params
 * @param {string} params.xDim       an X-dimension key (see X_DIMS)
 * @param {string} params.metricKey  a metric key valid in the X-dim's namespace
 *   (see lineMetricNamespace / lineMetricsFor)
 * @param {string[]} params.playerIds the roster ids (batter_id / bowler_id)
 * @param {object} params.filters    the app state (scope, discipline, matchupVs…)
 * @returns {Promise<{
 *   xDim: string, metricKey: string, ns: string, kind: string, sql: string,
 *   buckets: Array<{key:(number|string), label:string, ord:number}>,
 *   byPlayer: Object<string,{ name:string, values: Object<string,{value:number|null, sample:number|null}> }>,
 *   rows: Array<object>
 * }>}
 */
export async function fetchLineData({ xDim, metricKey, playerIds, filters }) {
  const state = filters;
  const d = X_DIMS[xDim];
  if (!d) throw new Error(`fetchLineData: unknown X-dimension "${xDim}"`);
  const ns = lineMetricNamespace(xDim, state);

  // ── Phase branch (wide→long) ──────────────────────────────────────────────
  if (d.category === "phase") {
    const members = phaseMembersFor(metricKey, ns, state.formats);
    if (members.length < 2) {
      throw new Error(`fetchLineData: metric "${metricKey}" is not phase-decomposable in ${ns} for this scope`);
    }
    const sql = buildPhaseSql({ members, ns, state, playerIds });
    const { rows } = await query(sql);
    const buckets = members.map((m, i) => ({ key: m.phaseLabel, label: m.phaseLabel, ord: i, _col: `ph_${i}` }));
    const byPlayer = {};
    for (const r of rows) {
      const values = {};
      buckets.forEach((b) => {
        const raw = r[b._col];
        values[b.key] = { value: raw == null ? null : Number(raw), sample: null };
      });
      byPlayer[r.player_id] = { name: r.player_name, values };
    }
    return { xDim, metricKey, ns, kind: d.kind, sql, buckets: buckets.map(({ _col, ...b }) => b), byPlayer, rows };
  }

  // ── All GROUP-BY-style branches ───────────────────────────────────────────
  const metricNs = ns;
  const metric = getMetric(metricKey, metricNs);
  if (!metric) throw new Error(`fetchLineData: unknown metric "${metricKey}" for ${metricNs}`);
  if (!lineMetricSupported(metric)) {
    throw new Error(`fetchLineData: metric "${metricKey}" (kind ${metric.kind}) is not Line-able`);
  }
  const sql = buildLineSql({ xDim, metric, ns, state, playerIds });
  const { rows } = await query(sql);

  const buckets = assembleBuckets(rows, d);
  const byPlayer = {};
  for (const r of rows) {
    const key = normaliseKey(r.bucket, d);
    if (!byPlayer[r.player_id]) byPlayer[r.player_id] = { name: r.player_name, values: {} };
    byPlayer[r.player_id].values[key] = {
      value: r.value == null ? null : Number(r.value),
      sample: r.sample == null ? null : Number(r.sample),
    };
  }
  return { xDim, metricKey, ns, kind: d.kind, sql, buckets, byPlayer, rows };
}
