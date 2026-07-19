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
import { escSql, matchupVsActive } from "../state.js";

// Local copies of table.js's per-discipline column maps. table.js does not
// export these constants and this module must not modify other files, so they
// are duplicated here (kept byte-identical to table.js's VIEW_FOR_DISCIPLINE /
// ID_COL / NAME_COL / TEAM_COL / OPP_COL).
const VIEW = { batting: "batting", bowling: "bowling" };
const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };
const OPP_COL = { batting: "bowling_team", bowling: "batting_team" };

// Matchup-namespace equivalents (Wave B2). When a "Vs" bucket is active the
// year-by-year line trends the metric over the matchup_* views instead of the
// plain innings views — same duplication rationale as the plain maps above
// (table.js's MATCHUP_* maps are not exported). Both matchup views carry a
// `year` column and the bucket-dimension columns buildMatchupQuery slices on
// (bowling_group / bowling_type on matchup_batting, batting_hand on
// matchup_bowling), plus the per-innings BALLS column used as the yearly
// sample (balls_faced batting / balls bowling) — verified against the live
// parquet schema. Kept byte-identical to table.js's MATCHUP_* maps.
const MATCHUP_VIEW = { batting: "matchup_batting", bowling: "matchup_bowling" };
const MATCHUP_NS = { batting: "matchup_batting", bowling: "matchup_bowling" };
const MATCHUP_ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const MATCHUP_NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const MATCHUP_TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };
const MATCHUP_OPP_COL = { batting: "bowling_team", bowling: "batting_team" };
const MATCHUP_BALLS_COL = { batting: "balls_faced", bowling: "balls" };

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
 * ── Matchup ("Vs") metrics (source "matchup", Wave B2/B3) ───────────────────
 * A Vs by-year line trends a matchup-namespace metric over the matchup_* view
 * (see buildTimeseriesQuery's matchup branch). The SAME recombination rule
 * applies: a total/rate/percent whose sqlExpression is a SUM (or a ratio of
 * SUMs ×100) of additive per-innings columns regroups cleanly into
 * (player, year) buckets and recombines to the career-vs-bucket figure by the
 * same arithmetic the anchor check verifies. So matchup total/rate/percent
 * metrics are trend-able. Wave B3 (owner ruling 2026-07-18) made the four
 * previously-vsTableOnly stats graphable, so there is no longer a vsTableOnly
 * exclusion here — the kind check alone decides:
 *  • Matches (total) now trends by year. (The other non-peak vsTableOnly stat
 *    was removed from the catalogue in R5-C #20.)
 *  • High Score / Best Bowling are kind "peak" (non-additive MAX / arg_max
 *    "W-R" display string) and stay excluded by the kind check, exactly as the
 *    innings path excludes peaks — a year-over-year line of a single-innings
 *    extreme is not the volume/rate trend this chart is for.
 *  • "composition" (descriptive un-bucketed %s) stays excluded by the same
 *    kind check as the innings path.
 *
 * @param {object} metricDef a metrics.js metric definition (from getMetric)
 * @returns {boolean}
 */
export function timeseriesSupported(metricDef) {
  if (!metricDef) return false;
  const trendableKind =
    metricDef.kind === "total" || metricDef.kind === "rate" || metricDef.kind === "percent";
  if (metricDef.source === "matchup") {
    // Wave B3 (owner ruling 2026-07-18): the vsTableOnly stats are now
    // graphable, so the old `if (metricDef.vsTableOnly) return false;` guard is
    // gone. The kind check below is what now decides: Matches (total) and Runs
    // per Innings (rate) become Line-able by year; High Score and Best Bowling
    // (kind "peak") stay excluded exactly as the innings path excludes them
    // (non-additive MAX / a "W-R" display string — not a recombining trend).
    return trendableKind;
  }
  if (metricDef.source !== "innings") return false; // drops "matches" (player_matches-sourced)
  return trendableKind;
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
 * ── Matchup ("Vs") branch (Wave B2) ─────────────────────────────────────────
 * When a Vs bucket is active for the current discipline (matchupVsActive), the
 * PLAIN path below is bypassed for buildMatchupTimeseriesQuery(): the SAME
 * per-year grain, sample floor, roster-id restriction and shared scope builder,
 * but over the matchup_* view with the bucket predicate applied and the
 * metric's matchup-namespace sqlExpression — so a Vs-by-year point equals the
 * table's Vs number for that year (see that function). The plain path is left
 * byte-identical (it simply never runs while Vs is active).
 *
 * @param {object} params
 * @param {"batting"|"bowling"|"matchup_batting"|"matchup_bowling"} params.discipline
 *   The effective namespace (graph.js passes effectiveNamespace(state)); a
 *   matchup namespace only ever accompanies an active Vs bucket, which the
 *   matchup branch detects via matchupVsActive(filters).
 * @param {string} params.metricKey  a metrics.js key in that namespace; must
 *   satisfy timeseriesSupported() or this throws.
 * @param {string[]} params.playerIds  the selected players' ids (batter_id /
 *   bowler_id). Empty array → a query that returns zero rows (never "all").
 * @param {object} params.filters  the app state object (gender, formats,
 *   dateFrom, dateTo, teamType, teams, opposition, positions, profile,
 *   matchupVs, …) — the same shape table.js/players.js read.
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
  // Matchup ("Vs") by-year branch (Wave B2): route to the matchup builder when
  // a Vs bucket is active — mirrors table.js's buildQuery auto-dispatch to
  // buildMatchupQuery on matchupVsActive(state). The PLAIN path below stays
  // byte-identical (never reached while Vs is active).
  if (matchupVsActive(filters)) {
    return buildMatchupTimeseriesQuery({ metricKey, playerIds, filters });
  }

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

/**
 * Matchup ("Vs") by-year query (Wave B2). Same contract and output-row shape as
 * buildTimeseriesQuery's plain path, but over the matchup_* view, sliced to the
 * active Vs bucket, so a Vs-by-year point equals the leaderboard's Vs number
 * for that player-year. Only reached via buildTimeseriesQuery when
 * matchupVsActive(filters) is true.
 *
 * Why this reproduces the table's Vs numbers exactly — and why it can put the
 * bucket predicate in WHERE where table.js's buildMatchupQuery uses a
 * per-aggregate FILTER:
 *   • For any metric, `SUM(x) FILTER (WHERE bucket)` over the scope rows equals
 *     `SUM(x)` over the (scope AND bucket) rows. buildMatchupQuery uses FILTER
 *     ONLY so it can ALSO total un-bucketed balls for its coverage column in
 *     one scan; the by-year line needs no coverage, so the bucket goes straight
 *     into WHERE and the metric's UN-appended sqlExpression is used verbatim —
 *     numerically identical to the FILTER'd form (SPEC §8.2: never re-derived).
 *   • Row set: buildMatchupQuery keeps only (id) groups with ≥1 bucket innings
 *     (its `__innings_gate >= 1`). Bucket-in-WHERE gives exactly the same
 *     grain-appropriate result here — a (player, year) with no bucket innings
 *     produces no row (an honest gap: "didn't face this bucket that year"),
 *     mirroring the plain path's "no innings that year → no row".
 *   • Scope: the SAME shared buildScopeClauses helper with the SAME options
 *     buildMatchupQuery passes (includeTeams / team-opp columns / idColumn /
 *     includePositions:true — both matchup views carry batting_position). The
 *     roster is an explicit id list (as the plain path), so — like the plain
 *     path — no name-search or pin exemption is applied; a Vs by-year line
 *     describes the same slice the Vs table shows for a player in the roster.
 *
 * Name variants: grouping by (id, year) with MAX(name) collapses a player's
 * multiple registry spellings into one point per year — exactly as the plain
 * path does — so summing a player's yearly totals reconstructs their full
 * career-vs-bucket figure (verified: SA Yadav runs-vs-Spin 141+92+63+158 = 454,
 * the standing anchor).
 *
 * @param {object} params
 * @param {string} params.metricKey  a matchup-namespace metric key; must
 *   satisfy timeseriesSupported() or this throws.
 * @param {string[]} params.playerIds  selected roster ids (batter_id/bowler_id).
 * @param {object} params.filters  the app state (must have an active matchupVs).
 * @returns {string} SQL producing the same row shape as buildTimeseriesQuery.
 */
function buildMatchupTimeseriesQuery({ metricKey, playerIds, filters }) {
  const state = filters;
  // matchupVsActive guarantees state.discipline is the base discipline that
  // matches the active bucket dim (batting for group/type, bowling for hand).
  const base = state.discipline;
  const view = MATCHUP_VIEW[base];
  if (!view) throw new Error(`buildMatchupTimeseriesQuery: unsupported discipline "${base}"`);
  const ns = MATCHUP_NS[base];
  const idCol = MATCHUP_ID_COL[base];
  const nameCol = MATCHUP_NAME_COL[base];
  const teamCol = MATCHUP_TEAM_COL[base];
  const oppCol = MATCHUP_OPP_COL[base];
  const ballsCol = MATCHUP_BALLS_COL[base];

  const metric = getMetric(metricKey, ns);
  if (!metric) throw new Error(`buildMatchupTimeseriesQuery: unknown metric "${metricKey}" for ${ns}`);
  if (!timeseriesSupported(metric)) {
    throw new Error(`buildMatchupTimeseriesQuery: metric "${metricKey}" (kind ${metric.kind}) is not trend-able`);
  }

  // Bucket predicate — identical column/value mapping to buildMatchupQuery
  // (hand → batting_hand, type → bowling_type, group → bowling_group).
  const mv = state.matchupVs;
  const bucketCol = mv.dim === "hand" ? "batting_hand" : mv.dim === "type" ? "bowling_type" : "bowling_group";
  const bucketClause = `${bucketCol} = '${escSql(mv.value)}'`;

  // Scope: the SAME options buildMatchupQuery uses for the matchup view.
  const whereClauses = buildScopeClauses(state, {
    includeTeams: true,
    teamColumn: teamCol,
    idColumn: idCol,
    oppositionColumn: oppCol,
    includePositions: true,
  });
  whereClauses.push(bucketClause);

  // Roster restriction (explicit id list, as the plain path). Empty → no rows.
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
    `       SUM(${ballsCol}) AS sample`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, year`,
    `ORDER BY player_id, year`,
  ].join("\n");

  return sql;
}
