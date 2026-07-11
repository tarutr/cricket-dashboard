// src/graph/timeseries.js
//
// Time-series data layer for the Graph Builder's year-by-year progression line
// chart (decision 43). Produces, per selected player, one (player, year) row
// carrying the chosen metric's value plus a per-year sample size, computed from
// the per-innings parquets (batting_innings.parquet -> `batting` view /
// bowling_innings.parquet -> `bowling` view) that already ship to the browser.
//
// ── Correctness posture (SPEC §8.2 one-metrics-module rule + decision 39) ──────
// The metric VALUE is NEVER re-derived here. buildTimeseriesQuery interpolates
// metrics.js's own `sqlExpression` for the requested metric verbatim into a
// GROUP BY (player_id, year) query — exactly as src/table.js does into its
// GROUP BY (player_id, player_name) query. The only differences from the table
// path are the grouping grain (…, year) and the row scope (restricted to the
// explicitly-selected playerIds instead of a leaderboard search). Every SPEC
// §4.1 cricket rule is therefore inherited unchanged: it's already baked into
// the innings views by the pipeline (super overs excluded, legal-ball defs,
// bowler-credited wickets, retired-out-counts dismissal set, byes/leg-byes out
// of runs_conceded, is_not_boundary boundary rule, phase column families).
//
// ── Filter semantics (mirrored EXACTLY from src/table.js buildQuery) ───────────
// The WHERE clause is built by the SAME shared helper table.js uses —
// filters.js buildScopeClauses(state, opts) — with the SAME options table.js's
// buildQuery passes for the innings views: gender, formats (match_type IN …),
// date range (match_date, inclusive-of-the-to-month), team_type, team, the
// international-only opposition filter, the batting-position filter, and the
// men-only profile semi-join. So a progression line always describes the exact
// same slice of cricket the leaderboard/table describes for that scope.
//
//   • Date range applies at the INNINGS level on match_date (never on a season
//     column, SPEC §4.1) — identical predicate to table.js. `year` is derived
//     from match_date in the pipeline, so grouping by year and filtering by
//     match_date are always consistent (a Jul 2023–Jul 2026 window yields
//     partial-year buckets for 2023 and 2026, which is correct).
//   • Super-over exclusion is already baked into the innings parquet — no
//     super_over predicate is added or needed (same as table.js).
//   • includePositions:true is passed for BOTH disciplines exactly as table.js
//     does; buildScopeClauses only emits the batting_position predicate when
//     positionsFilterActive(state) is true, which is false for plain bowling
//     (bowling_innings has no batting_position column), so this is safe.
//
// table.js's buildQuery differs from this query in exactly one deliberate way:
//   • The name ILIKE search clause — irrelevant here; the graph's roster is an
//     explicit id list, so rows are scoped by `id IN (…)` instead.
// There is no min-innings HAVING to diverge from any more either — decision
// 44c removed the base min-innings gate from buildQuery entirely, so both
// queries are equally gate-free today (a player/year shows up here as long as
// they have at least one qualifying row that year, same "row exists" logic
// buildQuery itself now uses). Per-year honesty was always handled by the
// sample floor below instead (grey out, don't hide, never a leaderboard-style
// exclusion threshold), so no year is ever silently dropped — that was true
// before this removal and remains true after it.

import { getMetric } from "../metrics.js";
import { buildScopeClauses } from "../filters.js";
import { escSql } from "../state.js";

// Local copies of table.js's per-discipline column maps. table.js does not
// export these constants and this module must not modify other files, so they
// are duplicated here (kept byte-identical to table.js's VIEW_FOR_DISCIPLINE /
// ID_COL / NAME_COL / TEAM_COL / OPP_COL). Only the two innings disciplines are
// supported — the progression chart plots plain career progression, not the
// matchup_* namespaces (which have their own coverage semantics and no year
// grain wired for charting).
const VIEW = { batting: "batting", bowling: "bowling" };
const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };
const OPP_COL = { batting: "bowling_team", bowling: "batting_team" };

/**
 * Per-year sample floor for honesty on a yearly point (decision 43; OWNER
 * REVIEWS THIS VALUE).
 *
 * Basis: the number of DELIVERIES the player was involved in that year —
 * balls faced (batting) or legal balls bowled (bowling), see
 * sampleExpression() — NOT the metric's own denominator. It is a single,
 * intuitive "did this player do enough this year for the point to mean
 * something" activity gate, uniform across every supported metric.
 *
 * Value = 30 balls (= 5 overs). Rationale, framed on the hardest case — a
 * yearly T20 strike rate: a full year built on fewer than ~5 overs of batting
 * is one short cameo, and one boundary-laden over can swing that year's SR by
 * 50+ points — noise, not a trend. 30 balls is roughly 1–1.5 T20 innings'
 * worth: enough that a single over no longer dominates the rate, while low
 * enough that genuine part-timers and short seasons still qualify. Because
 * sub-threshold points are GREYED (still drawn, flagged as thin), not hidden,
 * a slightly conservative floor is the safe direction — the datum stays
 * visible, it's just marked "small sample". The chart layer owns the
 * grey-out; this module only supplies the threshold and the `sample` column.
 *
 * Note: this floor is meaningful for rate metrics (SR/average/economy/…). For
 * "total" metrics (runs, wickets) the value itself is exact regardless of
 * sample; the chart layer may choose to apply the grey-out only to rates. The
 * `sample` column is emitted for every query so that choice lives there, not
 * here.
 */
export const MIN_BALLS_PER_YEAR = 30;

/**
 * The SQL aggregate expression for a year's SAMPLE SIZE in the given
 * discipline — balls faced (batting) or legal balls bowled (bowling). Compared
 * by the chart layer against MIN_BALLS_PER_YEAR to decide whether a year's
 * point is trustworthy (>= threshold) or should be greyed as a thin sample.
 * These column names match metrics.js's own sample components for the batting
 * SR (SUM(balls_faced)) and bowling economy (SUM(balls)).
 *
 * @param {"batting"|"bowling"} discipline
 * @returns {string} a SQL aggregate over the innings view's rows
 */
export function sampleExpression(discipline) {
  if (discipline === "batting") return "SUM(balls_faced)";
  if (discipline === "bowling") return "SUM(balls)";
  throw new Error(`sampleExpression: unsupported discipline "${discipline}"`);
}

/**
 * Whitelist predicate: is this metric safe to trend year-by-year?
 *
 * A metric is supported iff its `sqlExpression` recombines cleanly when the
 * same rows are regrouped into (player, year) buckets — i.e. the sum of the
 * per-year numerators/denominators reconstructs the career figure by the same
 * arithmetic. Concretely: kind ∈ {"total", "rate", "percent"} AND
 * source === "innings".
 *
 *  • "total"   — a SUM(...) of an additive per-innings column (runs, wickets,
 *    fours, dismissal-kind counts, phase wickets, …). Summing the yearly sums
 *    gives the career sum exactly. SUPPORTED.
 *  • "rate"    — a ratio of two such SUMs (average = Σruns/Σdismissals, SR,
 *    economy, BPD, BPB, RPI, WPI, phase/faced-ball rates). Per year it is the
 *    ratio of that year's sums; the career figure is the ratio of the summed
 *    numerators over the summed denominators — which is what the anchor
 *    recombination check verifies. SUPPORTED.
 *  • "percent" — WIDENED IN (Batch 8/decision 44f — was excluded under
 *    decision 43, see below). A percent metric (dot%, boundary%, not-out%,
 *    dismissal% …) is, mechanically, exactly the same "ratio of two additive
 *    SUMs ×100" shape as "rate" — it decomposes per (player, year) the same
 *    way and recombines to the career figure the same way. There was never a
 *    mathematical reason to exclude it; decision 43's whitelist held it out as
 *    a product/scope choice pending owner review (see this function's own
 *    prior comment, kept in git history), and decision 44f is that review:
 *    trend it. VERIFIED (not just asserted) against live R2 data for SA
 *    Yadav's batting dot_pct under the app's default scope (male, T20 bucket,
 *    international, rolling 36-month window ending at the manifest's max
 *    match_date) — this module's generated SQL reproduced, digit-for-digit,
 *    an INDEPENDENT SUM(dots)/SUM(balls_faced) query grouped by year run
 *    directly against the same batting_innings.parquet outside the app. See
 *    the batch's task notes for the verbatim comparison.
 *
 * Excluded kinds — justified:
 *  • "peak"    — EXCLUDED. `best` (BBI) is a display STRING (arg_max → "W-R"),
 *    not a numeric value, so it cannot be plotted on a line at all. `high_score`
 *    is MAX(runs): although MAX does group per year, it is NON-additive — the
 *    career figure is a MAX-of-yearly-MAXes, not the sum/ratio recombination
 *    the progression chart, its sample floor, and the anchor check all assume.
 *    A year-over-year line of "best single knock" is an extreme, not the
 *    volume/rate trend the chart is for. Held out to keep every plotted metric
 *    on the one recombination arithmetic.
 *
 * The `source === "innings"` guard additionally drops the one "total" metric
 * that is NOT computable from the innings parquet: "matches" (source
 * "player_matches"). Its sqlExpression COUNT(DISTINCT match_id) would RUN
 * against the innings view, but would silently redefine "matches" as
 * matches-batted/bowled-in that year rather than all appearances — a different
 * stat. Excluding it avoids that dishonest reinterpretation.
 *
 * @param {object} metricDef a metrics.js metric definition (from getMetric)
 * @returns {boolean}
 */
export function timeseriesSupported(metricDef) {
  if (!metricDef) return false;
  if (metricDef.source !== "innings") return false; // drops "matches" (player_matches-sourced)
  return metricDef.kind === "total" || metricDef.kind === "rate" || metricDef.kind === "percent";
}

/**
 * Build the per-player, per-year progression query for one metric.
 *
 * Groups the discipline's innings view by (player_id, year) over the SAME
 * filter semantics as src/table.js's buildQuery (see the file header), scoped
 * to the given playerIds. The metric value is metrics.js's own sqlExpression
 * for `metricKey` (SPEC §8.2 — never an independent formula here); the sample
 * is sampleExpression(discipline).
 *
 * @param {object} params
 * @param {"batting"|"bowling"} params.discipline
 * @param {string} params.metricKey  a metrics.js key in that discipline; must
 *   satisfy timeseriesSupported() or this throws.
 * @param {string[]} params.playerIds  the selected players' ids (batter_id /
 *   bowler_id). Empty array → a query that returns zero rows (never "all").
 * @param {object} params.filters  the app state object (gender, formats,
 *   dateFrom, dateTo, teamType, teams, opposition, positions, profile, …) —
 *   the same shape table.js/players.js read.
 * @returns {string} a SQL string. Executed, it yields rows of shape:
 *   {
 *     player_id:   string,        // batter_id / bowler_id
 *     player_name: string,        // a stable spelling for the id (MAX over variants)
 *     year:        number,        // calendar year (integer) from the innings view
 *     value:       number|null,   // the metric this year; NULL for a rate with a
 *                                 //   zero denominator (SPEC §4.1 div-by-zero → NULL)
 *     sample:      number         // balls faced (batting) / balls bowled (bowling)
 *                                 //   this year — compare to MIN_BALLS_PER_YEAR
 *   }
 *   ordered by (player_id, year). One row per (player_id, year); a player-year
 *   with no qualifying innings simply has no row (the chart shows a gap, not a
 *   zero — honest about "didn't play" vs "played and scored 0").
 */
export function buildTimeseriesQuery({ discipline, metricKey, playerIds, filters }) {
  const view = VIEW[discipline];
  if (!view) throw new Error(`buildTimeseriesQuery: unsupported discipline "${discipline}"`);

  const metric = getMetric(metricKey, discipline);
  if (!metric) throw new Error(`buildTimeseriesQuery: unknown metric "${metricKey}" for ${discipline}`);
  if (!timeseriesSupported(metric)) {
    throw new Error(`buildTimeseriesQuery: metric "${metricKey}" (kind ${metric.kind}) is not trend-able`);
  }

  const state = filters;
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];
  const oppCol = OPP_COL[discipline];

  // WHERE: identical to table.js buildQuery's innings-view scope (see header).
  // includePositions only for batting — plain bowling_innings has no
  // batting_position column and the striker-position filter is matchup-only;
  // see charts.js's fetchSelectedPlayerMetrics for the full reasoning.
  const whereClauses = buildScopeClauses(state, {
    includeTeams: true,
    teamColumn: teamCol,
    idColumn: idCol,
    oppositionColumn: oppCol,
    includePositions: discipline === "batting",
  });

  // Restrict to the explicitly-selected roster (the graph's player list). Empty
  // selection → FALSE (no rows) rather than an unbounded scan of everyone.
  const ids = Array.isArray(playerIds) ? playerIds.filter((x) => x != null) : [];
  if (ids.length > 0) {
    whereClauses.push(`${idCol} IN (${ids.map((id) => `'${escSql(id)}'`).join(", ")})`);
  } else {
    whereClauses.push("FALSE");
  }

  const sql = [
    `SELECT ${idCol} AS player_id,`,
    `       MAX(${nameCol}) AS player_name,`,
    `       year,`,
    `       ${metric.sqlExpression} AS value,`,
    `       ${sampleExpression(discipline)} AS sample`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, year`,
    `ORDER BY player_id, year`,
  ].join("\n");

  return sql;
}
