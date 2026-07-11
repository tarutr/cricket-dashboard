// src/table.js
//
// Query builder + table renderer for Compare Stats (SPEC §5.3/§5.4). Builds ONE
// grouped query per the metrics.js contract, plus a separate player_matches
// query when the "matches" column is visible, joined in JS by player_id.
//
// hasMetricData (§8.1) is the ONLY no-data predicate — used both to gate
// advanced-filter conditions on rate/ratio metrics and to render "—" for
// no-data cells (NULL already renders "—"; this module never coalesces ratios).

import { getMetric, hasMetricData, matchupBucketLabel, DISMISSAL_KINDS } from "./metrics.js";
import { query } from "./db.js";
import { buildScopeClauses } from "./filters.js";
import { activeGroups } from "./advanced.js";
import { escHtml, escAttr } from "./html.js";
import {
  eligibleMetrics,
  activeSplit,
  positionsFilterActive,
  oppositionFilterActive,
  COLUMN_PRESET_DEFS,
  activePresetKey,
  SPLIT_DIMENSIONS,
  splitAllowed,
  matchupVsActive,
  effectiveNamespace,
  escSql as esc,
} from "./state.js";

export { eligibleMetrics };

const VIEW_FOR_DISCIPLINE = { batting: "batting", bowling: "bowling" };
const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };
// The opposition column in each innings view (D4 Piece 3): who the player
// batted against / bowled to.
const OPP_COL = { batting: "bowling_team", bowling: "batting_team" };

// ── Muted sub-sample values (decision 44c, B2R wave 3) ──────────────────────
// With the min-innings base gate removed, a rate/percent leaderboard column
// can surface a value backed by a tiny sample (e.g. a 100.00 average from one
// dismissal). Rather than hide these rows (they're real data — §8.1 already
// hides genuine no-data via hasMetricData/"—"), mute the cell color and add an
// honest title="Based on N <unit>" so the number is legible but visibly thin.
//
// Per-metric-family floor, below which a value is muted. OWNER REVIEWS THESE
// NUMBERS — only `balls: 30` has an existing precedent (matches the By-year
// chart's MIN_BALLS_PER_YEAR, src/graph/timeseries.js) and `innings`/
// `dismissals` were given as examples in the design brief (decision 44c);
// `wickets` and `boundaries` are this file's own judgment call (no metric in
// metrics.js uses those units for a rate/percent's minSampleComponent except
// bowling average/SR — sample is wicket count — and balls-per-boundary —
// sample is boundary count), sized to the same small-count-denominator
// reasoning as `dismissals` pending owner sign-off.
export const SAMPLE_FLOORS = {
  balls: 30,
  innings: 5,
  dismissals: 3,
  wickets: 3,
  boundaries: 3,
};

/** Classify a metric's minSampleComponent (metrics.js's own aggregate SQL for
 * its sample size — never re-derived here) into one of SAMPLE_FLOORS' units,
 * purely by inspecting the expression text. Order matters: checked from most
 * to least specific so no expression matches the wrong unit (verified against
 * every rate/percent metric in metrics.js at authoring time). Returns null for
 * a metric whose sample can't be classified (never muted, rather than guess). */
function sampleUnitFor(metric) {
  const expr = metric.minSampleComponent || "";
  if (/balls/i.test(expr)) return "balls";
  if (/dismissals|dismissed/i.test(expr)) return "dismissals";
  if (/wickets/i.test(expr)) return "wickets";
  if (/fours_hit|sixes_hit|fours_conceded|sixes_conceded/i.test(expr)) return "boundaries";
  if (/COUNT/i.test(expr)) return "innings";
  return null;
}

/** True for exactly the metrics muting can ever apply to — totals and peaks
 * are raw counts/extremes, never "thin", per the owner's rule that only
 * rate/percent metrics can be built from a tiny sample. */
function isMutableKind(metric) {
  return metric.kind === "rate" || metric.kind === "percent";
}

// Owner ruling (task 2, Batch B1 polish): a dismissals-sampled metric that is
// itself an AVERAGE (kind: "rate" — per the field-reference comment above,
// "rate" IS the average/SR/economy family) must mute below 5 dismissals, not
// the base floor of 3 — batting's `average` and `balls_per_dismissal` (an
// average expressed as balls, not runs, per dismissal) and their
// matchup_batting counterparts (`average`/`balls_per_dismissal` "vs style").
// Every OTHER dismissals-sampled metric — the "Out X %" dismissal-kind
// columns, kind: "percent", a share-of-whole rather than an average — keeps
// the base floor of 3. Deliberately metric-aware (kind + unit), not a blanket
// raise of SAMPLE_FLOORS.dismissals, which would also (wrongly) affect those
// percent columns. Bowling's `average`/economy are wickets-sampled, not
// dismissals-sampled, and are untouched by this either way.
const DISMISSALS_AVERAGE_FLOOR = 5;

/** The sample-size floor below which a metric's value renders muted, given
 * its classified sample unit (sampleUnitFor). Single source of truth for both
 * this file's dataCellHTML and graph/benchmark.js's computeBenchmarkRows
 * (which duplicates the surrounding classifier functions but imports this one
 * — see that file's header comment on why it duplicates rather than reaches
 * into this module's other internals). */
export function sampleFloorFor(metric, unit) {
  if (unit === "dismissals" && metric.kind === "rate") return DISMISSALS_AVERAGE_FLOOR;
  return unit ? SAMPLE_FLOORS[unit] : null;
}

// ── Matchup mode (D4 R3, decision 33) ───────────────────────────────────────
// "Vs" leaderboard comparison: every row recomputes against one bowling-style
// bucket (batting view) or batting-hand bucket (bowling view), over the
// matchup_batting/matchup_bowling views. Fixed column sets — the normal
// column picker/presets don't apply here.
const MATCHUP_VIEW = { batting: "matchup_batting", bowling: "matchup_bowling" };
const MATCHUP_ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const MATCHUP_NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const MATCHUP_TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };
const MATCHUP_OPP_COL = { batting: "bowling_team", bowling: "batting_team" };
const MATCHUP_BALLS_COL = { batting: "balls_faced", bowling: "balls" };
// The column whose '(unmapped)' value drives the coverage denominator split —
// bowling_group for batting (mapped iff the opponent's pace/spin group is
// known at all, regardless of whether the current Vs dim is coarse or fine),
// batting_hand for bowling.
const MATCHUP_GROUP_COL = { batting: "bowling_group", bowling: "batting_hand" };
const MATCHUP_NS = { batting: "matchup_batting", bowling: "matchup_bowling" };

/** Effective metrics namespace for getMetric() lookups — matchup_* while a Vs
 * selection is active and applicable, otherwise the plain discipline. Every
 * render/sort lookup must go through this so matchup columns format/sort
 * correctly (matchup keys don't always match the normal namespace, e.g.
 * "balls" vs "balls_faced"). Delegates to state.js's effectiveNamespace, the
 * single source of truth for this mapping (also used by advanced.js's metric
 * picker so both agree on which vocabulary is "live"). */
function effectiveDiscipline(state) {
  return effectiveNamespace(state);
}

/** Serialize exactly the state fields that determine the query results AND
 * how they're rendered — used by mountTable's enterView() to tell whether a
 * cached last-load result set is still valid when the table view is
 * re-entered (decision 44d: a plain view switch must never wipe results;
 * only an actual change to one of these fields since the last successful
 * query should). Deliberately EXCLUDES `view` itself (switching tabs is
 * exactly the thing that must NOT invalidate the cache) and includes only
 * the ACTIVE effective namespace's column list (a column edit made in the
 * other discipline/matchup namespace while away doesn't change what's
 * currently on screen). Every field here is either read directly by
 * buildQuery/buildScopeClauses, or governs rendering shape (columns, sort,
 * splitBy/matchupVs).
 */
function serializeQueryState(state) {
  const ns = effectiveDiscipline(state);
  return JSON.stringify({
    discipline: state.discipline,
    gender: state.gender,
    formats: state.formats,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    teams: state.teams,
    teamType: state.teamType,
    minInnings: state.minInnings,
    profile: state.profile,
    positions: state.positions,
    regularPositions: state.regularPositions,
    opposition: state.opposition,
    splitBy: state.splitBy,
    matchupVs: state.matchupVs,
    search: state.search,
    sort: state.sort,
    columns: state.columns[ns],
    advanced: state.advanced,
  });
}

/** Preferred display order for the fine "Bowling type" optgroup: named styles
 * in cricket-sensible order, then any unlisted style alphabetically, then the
 * bare pace/spin buckets last (decision 24 — bare-slow bowlers surface here
 * as the group name, labelled "…(unspecified)" via matchupBucketLabel). */
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
 * Append ` FILTER (WHERE <filterSql>)` after EVERY top-level aggregate call
 * in a metrics.js sqlExpression/sortExpression string (C1 single-scan merge).
 * Walks the string char-by-char; whenever it sees a known aggregate head
 * ("SUM(" or "COUNT(" — the only two heads used anywhere in the matchup_*
 * metric catalogue, verified by inspection of MATCHUP_BATTING_METRICS /
 * MATCHUP_BOWLING_METRICS in metrics.js), it paren-balances forward from the
 * matching "(" to find the TRUE matching ")" (so nested parens, e.g.
 * `NULLIF(SUM(balls_faced), 0)` or `COUNT(DISTINCT match_id || ':' ||
 * CAST(innings_number AS VARCHAR))`, are never mistaken for the aggregate's
 * own close-paren) and inserts the FILTER clause right after it. A bare
 * regex substitution would either truncate at the first inner ")" or need a
 * hand-rolled balanced-paren regex anyway — this is that logic, explicit.
 * Throws if parens are unbalanced (a metrics.js authoring bug, not a runtime
 * data issue) rather than silently emitting broken SQL.
 */
function appendFilterToAggregates(expr, filterSql) {
  const heads = ["SUM(", "COUNT("];
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const head = heads.find((h) => expr.startsWith(h, i));
    if (head) {
      let depth = 1;
      let j = i + head.length;
      while (j < expr.length && depth > 0) {
        if (expr[j] === "(") depth++;
        else if (expr[j] === ")") depth--;
        j++;
      }
      if (depth !== 0) {
        throw new Error(`appendFilterToAggregates: unbalanced parens in "${expr}"`);
      }
      out += `${expr.slice(i, j)} FILTER (WHERE ${filterSql})`;
      i = j;
    } else {
      out += expr[i];
      i += 1;
    }
  }
  return out;
}

/**
 * Build the matchup-mode query: ONE scan of matchup_batting/matchup_bowling
 * (C1 efficiency fix) that computes both the in-bucket stat columns AND the
 * coverage {total, mapped} balls per player, instead of the former two full
 * scans (main grouped query + a near-identical standalone coverageSql).
 *
 * Mechanics: the bucket predicate (e.g. `bowling_group = 'Spin'`) is dropped
 * from WHERE and instead appended as a `FILTER (WHERE ...)` to every
 * aggregate call in every metric expression (via appendFilterToAggregates).
 * That alone would be enough for the stat columns and the min-innings gate,
 * but coverage needs care: it must total balls across EVERY bucket for a
 * player, grouped by id ALONE — while the stat columns (unchanged from
 * before) are grouped by (id, name), and a handful of real ids carry more
 * than one name spelling (verified on live data: batter_id 922e3dcc appears
 * as both "Kamran Khan" and "Kamran Khan (2)"). So this is built as THREE
 * layered SELECTs, all operating on ONE underlying scan of `view`:
 *
 *   1. `agg` — GROUP BY (id, name), WHERE scope only (bucket predicate
 *      excluded, no HAVING at all): every FILTER'd stat/condition/existence-gate
 *      column, PLUS unfiltered per-(id,name) coverage PARTIAL sums. Keeping
 *      every (id, name) sub-group here — even ones that will later fail the
 *      bucket-existence gate — is the crux of the fix below.
 *   2. `windowed` — SUM(...) OVER (PARTITION BY id) turns each row's coverage
 *      partial into the full cross-name-variant total for that id (SUM is
 *      additive, so re-summing the partials reconstructs exactly what the
 *      old id-only GROUP BY coverageSql produced).
 *   3. final SELECT — filters `windowed` by the bucket-existence gate and any
 *      stat conditions, using the aliases already computed in step 1.
 *
 * Window functions run AFTER WHERE/GROUP BY/HAVING in standard SQL, so the
 * existence/condition filter MUST live in step 3, strictly outside the
 * window computed in step 2 — putting it any earlier (e.g. as a HAVING on
 * `agg` itself) would silently drop a filtered-out name-variant's rows
 * before the window could sum them, undercounting coverage for exactly the
 * ids this fix targets (verified against R2: without this staging, coverage
 * for 922e3dcc came out 67 instead of the correct 80). Everything past step
 * 1 operates on `agg`'s small in-memory result, not the base table, so this
 * is still ONE physical scan of `view`.
 *
 * Row-membership argument (this MUST reproduce the exact bucket-membership row
 * set): the existence filter in step 3 is unconditional (always present) and
 * its threshold is a hard-coded `>= 1` (decision 44c removed the base
 * minimum-innings gate — a player appears if they have any qualifying innings
 * vs this bucket; state.minInnings is no longer consulted here). The
 * `__innings_gate` column it tests —
 * `COUNT(DISTINCT match_id || ':' || innings_number)` FILTERed on the bucket
 * predicate — is >= 1 if and only if at least one pre-grouping row satisfied
 * the bucket predicate for that (id, name) group. That is exactly the
 * row-existence test the old query got for free from
 * `WHERE ... AND bucketClause` before GROUP BY. So dropping the bucket
 * predicate from WHERE and relying on this always-on, floor-1 filter
 * reproduces the correct row set — no separate "bucket-filtered
 * balls > 0" predicate is needed (and using balls specifically would in fact
 * be WRONG: a row can satisfy the bucket predicate with balls_faced = 0, e.g.
 * a batter's only delivery in that bucket was a wide off which they were
 * stumped — that row exists and must count).
 *
 * `visibleColumns` contract: the restricted picker's own selection
 * (`state.columns[ns]`) is always the base column list. Anything in the
 * `visibleColumns` argument is layered on top but only takes effect for keys
 * that resolve via getMetric(key, ns) — this matters because
 * graph/players.js's seedFromFilteredSet builds ITS column list from
 * state.columns[state.discipline] (the PLAIN batting/bowling vocabulary,
 * wrong namespace here), so most of what it passes is silently ignored
 * rather than corrupting the matchup SELECT. Regardless of either list, the
 * ACTIVE SORT metric (state.sort.key) is always force-included — every
 * caller ranks rows by it (the table's own click-to-sort AND the graph's
 * "top N by sort" auto-seed), and a metric missing from SELECT sorts as NULL
 * for every row, which was the graph auto-seed roster bug this also fixes.
 */
function buildMatchupQuery(state, discipline, visibleColumns) {
  const view = MATCHUP_VIEW[discipline];
  const ns = MATCHUP_NS[discipline];
  const idCol = MATCHUP_ID_COL[discipline];
  const nameCol = MATCHUP_NAME_COL[discipline];
  const teamCol = MATCHUP_TEAM_COL[discipline];
  const oppCol = MATCHUP_OPP_COL[discipline];
  const ballsCol = MATCHUP_BALLS_COL[discipline];
  const groupCol = MATCHUP_GROUP_COL[discipline];

  const ownCols = state.columns[ns] || [];
  const seenKeys = new Set();
  const keyOrder = [];
  for (const k of [...ownCols, ...(visibleColumns || []), state.sort.key]) {
    if (k && !seenKeys.has(k)) {
      seenKeys.add(k);
      keyOrder.push(k);
    }
  }
  const metrics = keyOrder.map((key) => getMetric(key, ns)).filter(Boolean);

  const mv = state.matchupVs;
  const bucketCol = mv.dim === "hand" ? "batting_hand" : mv.dim === "type" ? "bowling_type" : "bowling_group";
  const bucketClause = `${bucketCol} = '${esc(mv.value)}'`;

  // Column alias registry for step 1 (`agg`): every ticked/extra metric key
  // gets its own alias (m.key). The min-innings gate and any active stat
  // condition reuse an existing metric's alias when their key is already
  // present, otherwise get one dedicated extra column (__innings_gate,
  // __cond_N) — computed ONCE in step 1 and simply referenced by name in
  // step 3, rather than recomputed against the base table.
  const aliasByKey = new Map(metrics.map((m) => [m.key, m.key]));
  const extraAggColumns = []; // [{ metric, alias }] beyond the visible `metrics`

  const inningsMetric = getMetric("innings", ns);
  let inningsGateAlias = aliasByKey.get(inningsMetric.key);
  if (!inningsGateAlias) {
    inningsGateAlias = "__innings_gate";
    aliasByKey.set(inningsMetric.key, inningsGateAlias);
    extraAggColumns.push({ metric: inningsMetric, alias: inningsGateAlias });
  }

  const condAliasMap = new Map(); // cond object -> alias (step 3 references this)
  let condIdx = 0;
  for (const g of activeGroups(state.advanced)) {
    for (const c of g.conds) {
      const m = getMetric(c.metricKey, ns);
      if (!m) continue; // not applicable in this namespace — conditionApplicability() already notes this
      let alias = aliasByKey.get(m.key);
      if (!alias) {
        alias = `__cond_${condIdx++}`;
        aliasByKey.set(m.key, alias);
        extraAggColumns.push({ metric: m, alias });
      }
      condAliasMap.set(c, alias);
    }
  }

  // Step 1 (`agg`): FILTER'd stat columns, FILTER'd extra columns (innings
  // gate / condition-only metrics), and unfiltered per-(id,name) coverage
  // partials — one GROUP BY (id, name), no HAVING.
  const aggSelectParts = [`${idCol} AS id`, `${nameCol} AS name`];
  for (const m of metrics) {
    aggSelectParts.push(`${appendFilterToAggregates(m.sqlExpression, bucketClause)} AS ${m.key}`);
    if (m.sortExpression) {
      aggSelectParts.push(`${appendFilterToAggregates(m.sortExpression, bucketClause)} AS ${m.key}__sort`);
    }
  }
  // Additive display-only sample-size columns (decision 44c, muted sub-sample
  // values — same reasoning as buildQuery's plain path above): FILTER'd by the
  // same bucketClause as the metric itself, so the sample honestly reflects
  // this bucket, not the player's whole career. Every select item above this
  // is untouched; this only appends new aliases.
  for (const m of metrics) {
    if (isMutableKind(m) && m.minSampleComponent) {
      aggSelectParts.push(`${appendFilterToAggregates(m.minSampleComponent, bucketClause)} AS ${m.key}__sample`);
    }
  }
  for (const { metric, alias } of extraAggColumns) {
    aggSelectParts.push(`${appendFilterToAggregates(metric.sqlExpression, bucketClause)} AS ${alias}`);
  }
  // Coverage (SPEC_ADDENDUM D4.3): unfiltered partial sums at THIS query's own
  // (id, name) grain — summed across name variants by the window in step 2.
  aggSelectParts.push(`SUM(${ballsCol}) AS __coverage_total_partial`);
  aggSelectParts.push(
    `SUM(CASE WHEN ${groupCol} <> '(unmapped)' THEN ${ballsCol} ELSE 0 END) AS __coverage_mapped_partial`
  );

  const scopeOpts = {
    includeTeams: true,
    teamColumn: teamCol,
    idColumn: idCol,
    oppositionColumn: oppCol,
    // D4-R4: both matchup views now carry batting_position, so the position
    // filter genuinely applies here (batting side: the batter's own position;
    // bowling side: the position of the striker faced) — positionsFilterActive
    // gates it on, not off, while a Vs selection is active.
    includePositions: true,
  };

  const searchClause =
    state.search && state.search.trim() ? `${nameCol} ILIKE '%${esc(state.search.trim())}%'` : null;

  // C1: WHERE no longer includes the bucket predicate — scope + search only,
  // identical to the old standalone coverageSql's WHERE. The bucket predicate
  // now lives exclusively in the per-column FILTER clauses above.
  const whereClauses = buildScopeClauses(state, scopeOpts);
  if (searchClause) whereClauses.push(searchClause);

  const aggSql = [
    `SELECT ${aggSelectParts.join(", ")}`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, ${nameCol}`,
  ].join("\n");

  // Step 2 (`windowed`): pass every agg column through unchanged, plus the
  // cross-name-variant coverage totals.
  const passThroughCols = ["id", "name"];
  for (const m of metrics) {
    passThroughCols.push(m.key);
    if (m.sortExpression) passThroughCols.push(`${m.key}__sort`);
  }
  for (const m of metrics) {
    if (isMutableKind(m) && m.minSampleComponent) passThroughCols.push(`${m.key}__sample`);
  }
  for (const { alias } of extraAggColumns) passThroughCols.push(alias);
  const windowedSql = [
    `SELECT ${passThroughCols.join(", ")},`,
    `       SUM(__coverage_total_partial) OVER (PARTITION BY id) AS __coverage_total,`,
    `       SUM(__coverage_mapped_partial) OVER (PARTITION BY id) AS __coverage_mapped`,
    `FROM agg`,
  ].join("\n");

  // Step 3 (final): the bucket-membership existence test + stat conditions,
  // evaluated against the already-FILTER'd alias columns from step 1 (no
  // base-table access, no window interference — see the row-membership argument
  // in this function's doc comment).
  const finalSelectParts = [
    "id",
    "name",
    ...metrics.flatMap((m) => (m.sortExpression ? [m.key, `${m.key}__sort`] : [m.key])),
    ...metrics.filter((m) => isMutableKind(m) && m.minSampleComponent).map((m) => `${m.key}__sample`),
    "__coverage_total",
    "__coverage_mapped",
  ];
  // decision 44c: NO minimum-innings gate. This `>= 1` is NOT a min-innings
  // filter — it is the bucket-existence test that reproduces the correct row
  // set (a player appears iff they have >= 1 qualifying innings vs this bucket;
  // see this function's doc comment for why `>= 1` here, not a balls test). It
  // is now a hard-coded 1 rather than Math.max(1, state.minInnings) so the
  // (now UI-removed) min-innings field no longer gates rows out here either.
  // The coverage-preservation staging is unaffected: name-variants with 0
  // bucket innings but non-zero balls elsewhere still contribute to the
  // windowed coverage totals in step 2 before being dropped by this gate.
  const finalWhereParts = [`${inningsGateAlias} >= 1`];
  const advWhere = advancedToHaving(state.advanced, ns, (cond) => condAliasMap.get(cond));
  if (advWhere) finalWhereParts.push(advWhere);

  const sql = [
    `WITH agg AS (`,
    aggSql,
    `),`,
    `windowed AS (`,
    windowedSql,
    `)`,
    `SELECT ${finalSelectParts.join(", ")}`,
    `FROM windowed`,
    `WHERE ${finalWhereParts.join(" AND ")}`,
  ].join("\n");

  return { sql, matchesSql: null, splitDim: null, coverageSql: null };
}

/** Build a HAVING/WHERE predicate for one advanced condition, honoring §8.1
 * no-data semantics. `exprFn(cond, metric)`, when given, returns the exact
 * SQL to compare instead of `metric.sqlExpression` — matchup mode's
 * buildMatchupQuery passes a lookup into its per-condition alias map
 * (`__cond_N` / an already-selected metric's own alias), since by the time
 * this runs (its step 3) the FILTER'd aggregate is already computed and
 * named in an earlier step — recomputing it here (or re-running FILTER
 * against the base table) would be both redundant and, if done via a plain
 * HAVING/GROUP BY at the wrong stage, wrong (see that function's doc
 * comment on window-vs-filter ordering). The plain (non-matchup) buildQuery
 * path omits exprFn and keeps today's behavior: evaluate metric.sqlExpression
 * directly in HAVING. */
function conditionToHaving(cond, discipline, exprFn) {
  const metric = getMetric(cond.metricKey, discipline);
  if (!metric) return null;
  const expr = exprFn ? exprFn(cond, metric) : metric.sqlExpression;
  if (!expr) return null;
  // §8.1: rate/ratio metrics (zeroIsData:false) treat 0 as "no data" too, so a
  // condition on them must also exclude value = 0 even though the numeric
  // comparison might otherwise pass (e.g. "average <= 5" should not match a
  // player with a NULL/0 average — no data at all, not a low average).
  const guard = metric.zeroIsData ? "" : ` AND (${expr}) <> 0`;
  const v1 = parseFloat(cond.v1);
  switch (cond.operator) {
    case "gte":
      return `((${expr}) >= ${v1}${guard})`;
    case "lte":
      return `((${expr}) <= ${v1}${guard})`;
    case "eq":
      return `((${expr}) = ${v1}${guard})`;
    case "between": {
      const v2 = parseFloat(cond.v2);
      const lo = Math.min(v1, v2);
      const hi = Math.max(v1, v2);
      return `((${expr}) BETWEEN ${lo} AND ${hi}${guard})`;
    }
    default:
      return null;
  }
}

/**
 * Honest applicability count for the active stat conditions against a given
 * namespace (§8.4): total = every active (complete) condition, regardless of
 * which vocabulary it was authored in; applied = the subset whose metricKey
 * resolves in `ns`. The rest are silently skipped by conditionToHaving /
 * advancedToHaving (a condition authored in the OTHER mode, e.g. a
 * matchup-only "dis_caught" condition while viewing the plain table, or a
 * plain-only condition while in matchup mode) — so the toolbar must say so
 * out loud rather than let the mismatch pass silently.
 */
function conditionApplicability(advanced, ns) {
  const groups = activeGroups(advanced);
  let total = 0;
  let applied = 0;
  for (const g of groups) {
    for (const c of g.conds) {
      total += 1;
      if (getMetric(c.metricKey, ns)) applied += 1;
    }
  }
  return { total, applied };
}

function advancedToHaving(advanced, discipline, exprFn) {
  const groups = activeGroups(advanced);
  if (groups.length === 0) return null;
  const parts = groups
    .map((g) => {
      const condSql = g.conds.map((c) => conditionToHaving(c, discipline, exprFn)).filter(Boolean);
      if (condSql.length === 0) return null;
      const joiner = g.op === "OR" ? " OR " : " AND ";
      return condSql.length > 1 ? `(${condSql.join(joiner)})` : condSql[0];
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  const topJoiner = advanced.op === "OR" ? " OR " : " AND ";
  return parts.length > 1 ? `(${parts.join(topJoiner)})` : parts[0];
}

/**
 * Build the main grouped SQL query for the current state + visible columns.
 * Returns { sql, matchesSql, splitDim } — matchesSql is null unless "matches"
 * is visible AND still answerable from player_matches (see below). While a
 * matchup "Vs" selection is active, delegates to buildMatchupQuery (C1: one
 * merged scan carrying both the stat columns and the coverage N-of-M
 * denominator — see that function's doc comment); its `sql` result also
 * carries `__coverage_total`/`__coverage_mapped` columns that mountTable's
 * load() turns into each row's `coverage` object, in place of the second
 * query this used to require.
 *
 * `split: true` (the table) additionally groups by the active split dimension,
 * adding a `split_value` column — one row per (player, split value). Callers
 * that need per-player totals (the graph seed) leave it off.
 *
 * "Matches" honesty (D4 Piece 3): player_matches has no opposition or
 * batting-position columns, so whenever an innings-level filter or a split is
 * active, "matches" switches to COUNT(DISTINCT match_id) over the filtered
 * innings rows — matches in which the player actually batted/bowled within
 * the slice. Otherwise the player_matches source is kept (it also counts
 * matches where the player didn't bat/bowl).
 */
export function buildQuery(state, visibleColumns, { split = false } = {}) {
  const discipline = state.discipline;

  if (matchupVsActive(state)) {
    return buildMatchupQuery(state, discipline, visibleColumns);
  }

  const view = VIEW_FOR_DISCIPLINE[discipline];
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];

  const splitDim = split ? activeSplit(state) : null;
  const splitExpr = splitDim ? splitDim.sqlExpr(discipline) : null;

  const inningsMetrics = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter((m) => m && m.source !== "player_matches");

  const selectParts = [`${idCol} AS id`, `${nameCol} AS name`];
  if (splitExpr) selectParts.push(`${splitExpr} AS split_value`);
  for (const m of inningsMetrics) {
    selectParts.push(`${m.sqlExpression} AS ${m.key}`);
    if (m.sortExpression) selectParts.push(`${m.sortExpression} AS ${m.key}__sort`);
  }
  // Additive display-only sample-size columns (decision 44c, muted sub-sample
  // values): for rate/percent columns only, also SELECT the aggregate backing
  // their sample size — metrics.js's own minSampleComponent, verbatim, never
  // re-derived — so the renderer can mute thin-sample cells. Every select item
  // above this is untouched; this only appends new aliases.
  for (const m of inningsMetrics) {
    if (isMutableKind(m) && m.minSampleComponent) {
      selectParts.push(`${m.minSampleComponent} AS ${m.key}__sample`);
    }
  }

  const whereClauses = buildScopeClauses(state, {
    includeTeams: true,
    teamColumn: teamCol,
    idColumn: idCol,
    oppositionColumn: OPP_COL[discipline],
    includePositions: true,
  });
  if (state.search && state.search.trim()) {
    whereClauses.push(`${nameCol} ILIKE '%${esc(state.search.trim())}%'`);
  }

  // decision 44c: the BASE query applies NO minimum-innings gate — a player
  // appears if they have any qualifying innings row (equivalent to min 1). The
  // old `COUNT(*) >= Math.max(1, minInnings)` HAVING was already a no-op at its
  // floor (every GROUP BY group has COUNT(*) >= 1 by construction) and only
  // ever excluded anyone when the user raised min innings, which is exactly the
  // gate being removed. state.minInnings is retained in the state shape for
  // compatibility until the drawer UI removal lands; the query builder now
  // ignores it entirely. An "Innings ≥ N" requirement remains fully expressible
  // via the advanced stat-conditions path (the "innings" metric → advancedToHaving).
  const havingParts = [];
  const advHaving = advancedToHaving(state.advanced, discipline);
  if (advHaving) havingParts.push(advHaving);

  const wantsMatches = visibleColumns.includes("matches");
  const inningsLevel = positionsFilterActive(state) || oppositionFilterActive(state) || Boolean(splitDim);
  if (wantsMatches && inningsLevel) {
    selectParts.push(`COUNT(DISTINCT match_id) AS matches`);
  }

  const groupBy = [idCol, nameCol];
  if (splitExpr) groupBy.push(splitExpr);

  const sql = [
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${groupBy.join(", ")}`,
    // No base gate anymore (decision 44c) — HAVING is emitted only when the
    // advanced stat-conditions path contributes a predicate.
    ...(havingParts.length ? [`HAVING ${havingParts.join(" AND ")}`] : []),
  ].join("\n");

  let matchesSql = null;
  if (wantsMatches && !inningsLevel) {
    const pmWhere = buildScopeClauses(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" }).join(" AND ");
    const pmNameFilter =
      state.search && state.search.trim() ? ` AND player_name ILIKE '%${esc(state.search.trim())}%'` : "";
    matchesSql = [
      `SELECT player_id AS id, COUNT(DISTINCT match_id) AS matches`,
      `FROM player_matches`,
      `WHERE ${pmWhere}${pmNameFilter}`,
      `GROUP BY player_id`,
    ].join("\n");
  }

  return { sql, matchesSql, splitDim };
}

/** Shared display formatter for metric values ("—" for no-data per §8.1). Also used by the player page. */
export function formatValue(metric, value) {
  if (!hasMetricData(metric, value)) return "—"; // em dash
  if (metric.format === "str") return String(value);
  const n = Number(value);
  switch (metric.format) {
    case "int":
      return Math.round(n).toLocaleString();
    case "dec1":
      return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case "dec2":
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "pct1":
      return `${n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    default:
      return String(value);
  }
}

/** Render one metric's `<td>`, muting the value (decision 44c) when it's a
 * rate/percent column whose backing sample (the `${key}__sample` column added
 * by buildQuery/buildMatchupQuery) is below that unit's floor (sampleFloorFor
 * — SAMPLE_FLOORS' entry, except dismissals-sampled averages, see that
 * function's doc comment). No-data cells ("—") are never muted — hasMetricData
 * already governs that, this is strictly a further honesty layer on real
 * values. Totals/peaks never carry a `${key}__sample` column at all
 * (isMutableKind gates that at query time), so they always take the plain
 * branch. */
function dataCellHTML(metric, row) {
  const value = row[metric.key];
  const text = formatValue(metric, value);
  if (isMutableKind(metric) && hasMetricData(metric, value)) {
    const unit = sampleUnitFor(metric);
    const floor = sampleFloorFor(metric, unit);
    // Number() coercion matters: DuckDB-WASM returns integer SUMs (e.g. a
    // dismissals sample) as BigInt, which would silently fail a typeof
    // "number" check and leave thin integer-sampled rates unmuted.
    const sample = Number(row[`${metric.key}__sample`]);
    if (floor != null && Number.isFinite(sample) && sample < floor) {
      const title = `Based on ${sample.toLocaleString()} ${sample === 1 ? unit.replace(/s$/, "") : unit}`;
      return `<td class="data-table__td data-table__td--thin-sample" title="${escAttr(title)}">${text}</td>`;
    }
  }
  return `<td class="data-table__td">${text}</td>`;
}

// ── Dismissals column-picker pruning (decision 44/42, B2R wave 3) ───────────
// The plain "batting" namespace is the ONLY one where metrics.js's dismissal
// taxonomy produces a count+% pair per kind (12 kinds x 2 = 24 checkboxes,
// see DISMISSAL_KINDS/`section: "dismissal"` in metrics.js) — bowling's wkt_*
// metrics carry no `section` at all (so they render under Basic, unaffected
// by any of this) and both matchup namespaces' dismissal metrics are
// count-only (6 items each, no % sibling), so they're already a plain list
// and keep the old rendering below untouched. This block is therefore scoped
// to ns === "batting" only.
//
// Grouping metadata lives HERE, not in metrics.js — this file owns rendering
// only, metrics.js owns the metric catalogue, and "which 6 kinds are common
// vs rare" is a picker-layout judgment call, not a metric definition. Kind
// strings match DISMISSAL_KINDS' own `kind` field exactly.
const RARE_DISMISSAL_KINDS = new Set([
  "hit wicket",
  "retired out",
  "obstructing the field",
  "handled the ball",
  "timed out",
  "hit the ball twice",
]);

// Display labels for the picker rows — shorter than metrics.js's own `label`
// (which is prefixed "Out …" for the count metric's own column header, not
// needed again here since the section header already reads "Dismissals").
const DISMISSAL_ROW_LABEL = {
  out_caught: "Caught",
  out_bowled: "Bowled",
  out_lbw: "LBW",
  out_run_out: "Run out",
  out_stumped: "Stumped",
  out_caught_and_bowled: "Caught & Bowled",
  out_hit_wicket: "Hit wicket",
  out_retired_out: "Retired out",
  out_obstructing_the_field: "Obstructing the field",
  out_handled_the_ball: "Handled the ball",
  out_timed_out: "Timed out",
  out_hit_the_ball_twice: "Hit the ball twice",
};

/** One dismissal-kind row: a single checkbox standing for EITHER the count or
 * the % column (metrics.js's `${key}` / `${key}_pct`), whichever the
 * section's "Show as %" toggle currently selects — checked iff either
 * variant is present in `visible` (mixed/legacy state is read honestly here;
 * see computeInitialShowPct's doc comment for when it gets normalised). */
function dismissalRowHTML(d, visible) {
  const countKey = d.key;
  const pctKey = `${d.key}_pct`;
  const checked = visible.has(countKey) || visible.has(pctKey);
  const label = DISMISSAL_ROW_LABEL[countKey] ?? d.label;
  return `<label class="columns-popover__item">
    <input type="checkbox" data-count-key="${countKey}" data-pct-key="${pctKey}" ${checked ? "checked" : ""} />
    <span>${escHtml(label)}</span>
  </label>`;
}

/** Initial "Show as %" state for a freshly-opened popover, derived from the
 * CURRENT column list rather than any stored preference (there isn't one —
 * this is a transient picker-open computation, same lifetime as the popover
 * itself). Majority rule across the 12 kinds' checked rows: more % columns
 * checked than count columns -> starts on %; a tie (including "none checked
 * at all") starts on counts, the pre-existing convention. A mixed save from
 * before this redesign (e.g. 2 count + 1 %) is NOT silently rewritten by this
 * computation alone — it only decides which way the toggle SHOWS initially;
 * the actual column-list normalisation (collapsing every checked row onto one
 * variant) happens the first time the user flips the toggle or checks/
 * unchecks a row (see the toggle's own change handler below), never merely by
 * opening the popover. */
function computeInitialShowPct(cols) {
  const visible = new Set(cols);
  let pctCount = 0;
  let countCount = 0;
  for (const d of DISMISSAL_KINDS) {
    if (visible.has(`${d.key}_pct`)) pctCount += 1;
    else if (visible.has(d.key)) countCount += 1;
  }
  return pctCount > countCount;
}

/** Sort value accessor: uses the __sort shadow column when present; NULL sorts last always. */
function sortValue(row, metric) {
  const raw = metric.sortExpression ? row[`${metric.key}__sort`] : row[metric.key];
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function compareRows(a, b, metric, dir) {
  const va = metric.key === "name" ? null : sortValue(a, metric);
  const vb = metric.key === "name" ? null : sortValue(b, metric);
  // NULLS LAST regardless of direction.
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return dir === "asc" ? va - vb : vb - va;
}

/** Sort comparator for the split_value column (numeric for position, string otherwise). NULLS LAST. */
function compareSplitRows(a, b, splitDim, dir) {
  const va = a.split_value;
  const vb = b.split_value;
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  const d = splitDim.numeric ? Number(va) - Number(vb) : String(va).localeCompare(String(vb));
  return dir === "asc" ? d : -d;
}

// ── Table controller ─────────────────────────────────────────────────────────

export function mountTable(container, store, { onPlayerClick, onTurnIntoGraph } = {}) {
  let lastRows = [];
  let loadToken = 0;
  // Snapshot (serializeQueryState) of the state that produced lastRows, or
  // null before any successful load. enterView() (decision 44d) compares this
  // against the CURRENT state to decide whether re-entering the table view
  // can restore lastRows instantly instead of showing the blank prompt.
  let lastQueryStateKey = null;
  // The split dimension the CURRENT lastRows were queried with (null = no
  // split). Rendering and split-column sorting must use this, not live state —
  // the state may have moved on while the table still shows the old result.
  let lastSplitDim = null;
  // The distinct bowling_type values (matchup mode's fine "Bowling type"
  // optgroup), fetched once from ./db.js and cached — small, format-agnostic
  // lookup that never changes at runtime.
  let bowlingTypesCache = null;
  let lastBowlingTypes = [];
  // The currently-open "Columns" popover, if any (Batch 3 fix 3). Tracked here
  // (not just a local DOM query) so load() can find and refresh it after
  // every reload — see openColumnsPopover()'s doc comment.
  let openColumnsPopoverState = null;

  // Persistent table-mode skeleton (Batch 1 mechanical fix, decision 42/43):
  // the toolbar and table shell are built ONCE per entry into "table mode"
  // (the first load from the blank prompt, or after an error) and never
  // innerHTML-replaced by container.innerHTML wholesale again — every
  // subsequent render (loading, loaded, re-sort) writes into these nodes'
  // OWN innerHTML in place. This is what keeps the toolbar's controls
  // (Vs / Group rows / Columns / presets) visible and interactive-looking
  // DURING a re-query instead of vanishing under the user's cursor and the
  // toolbar's geometry jumping. Null whenever we're not in table mode
  // (prompt/error), so ensureSkeleton() knows to rebuild fresh next time.
  let toolbarEl = null;
  let overlayEl = null;
  let scrollEl = null;
  let theadEl = null;
  let tbodyEl = null;

  function visibleColumns() {
    const state = store.get();
    return state.columns[state.discipline];
  }

  /** Drop any visible phase column that's no longer valid for the current scope
   * (silent). Operates on the CURRENT effective namespace — the matchup_batting/
   * matchup_bowling column list while a "Vs" selection is active, so a phase
   * column picked under one format selection is dropped the moment formats
   * change to something that doesn't permit it, in matchup mode same as plain. */
  function pruneInvalidColumns() {
    const state = store.get();
    const ns = effectiveDiscipline(state);
    const formats = state.formats;
    const cols = state.columns[ns];
    const allowedKeys = new Set(eligibleMetrics(ns, formats).map((m) => m.key));
    const pruned = cols.filter((k) => allowedKeys.has(k));
    if (pruned.length !== cols.length) {
      store.set({ columns: { ...state.columns, [ns]: pruned } });
    }
  }

  async function ensureBowlingTypes() {
    if (bowlingTypesCache) return bowlingTypesCache;
    try {
      const { rows } = await query(
        `SELECT DISTINCT bowling_type AS v FROM matchup_batting WHERE bowling_type <> '(unmapped)'`
      );
      bowlingTypesCache = orderBowlingTypes(rows.map((r) => r.v));
      return bowlingTypesCache;
    } catch (e) {
      // Don't cache the failure — leave bowlingTypesCache null so the next
      // load() call retries instead of permanently emptying the "Vs" fine
      // bowling-type optgroup.
      return [];
    }
  }

  /** Build the persistent table-mode skeleton (toolbar + loading overlay +
   * table shell) once and cache node references. A no-op if it already
   * exists — repeated calls across a query cycle must never rebuild it,
   * that's the whole point of this fix. */
  function ensureSkeleton() {
    if (toolbarEl) return;
    container.innerHTML = `
      <div class="table-toolbar"></div>
      <div class="table-loading-overlay" aria-live="polite" hidden>Running query…</div>
      <div class="table-scroll"><table class="data-table"><thead></thead><tbody></tbody></table></div>
    `;
    toolbarEl = container.querySelector(".table-toolbar");
    overlayEl = container.querySelector(".table-loading-overlay");
    scrollEl = container.querySelector(".table-scroll");
    theadEl = container.querySelector(".data-table thead");
    tbodyEl = container.querySelector(".data-table tbody");
  }

  /** Forget the skeleton node references — called whenever container.innerHTML
   * is about to be replaced wholesale by a non-table-mode render (prompt or
   * error), so a later return to table mode rebuilds fresh via ensureSkeleton()
   * instead of writing into now-detached nodes. */
  function teardownSkeleton() {
    toolbarEl = null;
    overlayEl = null;
    scrollEl = null;
    theadEl = null;
    tbodyEl = null;
  }

  /**
   * Blank/prompt state (owner: no automated search — the table stays empty until
   * "Show results" is clicked, and reverts here whenever the filters change so it
   * never shows numbers for a scope the filters no longer describe, §8.4).
   */
  function renderPrompt() {
    closeColumnsPopover(); // no columns-btn here either — same reasoning.
    teardownSkeleton();
    container.innerHTML = `
      <div class="table-prompt">
        <p class="table-prompt__text">Choose your filters, then show the results.</p>
        <button type="button" class="btn btn--primary" data-role="show-results">Show results</button>
      </div>
    `;
    const btn = container.querySelector('[data-role="show-results"]');
    if (btn) btn.addEventListener("click", () => load());
  }

  /** Called when the table view is (re-)entered — clicking the Stats tab, or
   * the graph's "Back to your table" bridge (decision 44d) — as distinct from
   * a filter change while the table is already showing, which always calls
   * showPrompt() directly via main.js's onFiltersChanged (the no-automated-
   * search rule is about filter changes, not tab switches, and is untouched
   * by this). If the state that produced the last successful result set is
   * IDENTICAL (per serializeQueryState — matchup mode, grouping, sort, and
   * column choices all included) to the current state, that result set still
   * describes exactly what the filters/pills currently show — re-render it
   * from the in-memory cache instantly, no requery. Otherwise the scope moved
   * on while the table was out of view; fall back to the blank prompt exactly
   * as a filter change would.
   */
  function enterView() {
    const state = store.get();
    if (lastQueryStateKey !== null && serializeQueryState(state) === lastQueryStateKey) {
      renderLoaded(lastRows, state, lastBowlingTypes);
      refreshOpenColumnsPopover();
      return;
    }
    renderPrompt();
  }

  function renderError(err, retryFn) {
    teardownSkeleton();
    container.innerHTML = `
      <div class="error-box">
        <p>${escHtml((err && (err.userMessage || err.message)) || "Something went wrong running the query.")}</p>
        <button type="button" class="btn btn--primary" data-role="retry">Retry</button>
      </div>
    `;
    const btn = container.querySelector('[data-role="retry"]');
    if (btn) btn.addEventListener("click", retryFn);
  }

  function headerCellHTML(metric, state) {
    const isSorted = state.sort.key === metric.key;
    const dir = isSorted ? state.sort.dir : null;
    const arrow = isSorted ? (dir === "asc" ? " ▲" : " ▼") : "";
    return `<th data-key="${metric.key}" class="data-table__th ${isSorted ? "is-sorted" : ""}" scope="col">
      <button type="button" class="data-table__sort-btn">${metric.shortLabel}${arrow}</button>
    </th>`;
  }

  /** Sort `rows` by the store's current sort (metric or the "__split" column). */
  function applySort(rows, s) {
    if (s.sort.key === "__split" && lastSplitDim) {
      return rows.slice().sort((a, b) => compareSplitRows(a, b, lastSplitDim, s.sort.dir));
    }
    const metric = getMetric(s.sort.key, effectiveDiscipline(s));
    return metric ? rows.slice().sort((a, b) => compareRows(a, b, metric, s.sort.dir)) : rows;
  }

  /** Coverage cell text: "N of M (P%)" — one decimal on P, thousands separators on N/M.
   * No coverage figure, no stat (SPEC_ADDENDUM D4.3) — every matchup row carries this. */
  function coverageLabel(coverage) {
    if (!coverage || !coverage.total) return "—";
    const pct = (coverage.mapped / coverage.total) * 100;
    return `${coverage.mapped.toLocaleString()} of ${coverage.total.toLocaleString()} (${pct.toLocaleString(undefined, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%)`;
  }

  /** The "Vs" select's <option> markup for the current discipline. Value encodes
   * "dim:value" (e.g. "type:Off-spin"); "" means Everyone (no matchup filter). */
  function matchupVsOptionsHTML(state, bowlingTypes) {
    const current = matchupVsActive(state) ? `${state.matchupVs.dim}:${state.matchupVs.value}` : "";
    const opt = (value, label) =>
      `<option value="${escAttr(value)}" ${value === current ? "selected" : ""}>${escHtml(label)}</option>`;

    if (state.discipline === "batting") {
      const typeOpts = bowlingTypes.map((t) => opt(`type:${t}`, matchupBucketLabel(t))).join("");
      return `
        ${opt("", "Everyone")}
        <optgroup label="Pace / spin">
          ${opt("group:Pace", "Pace")}
          ${opt("group:Spin", "Spin")}
        </optgroup>
        <optgroup label="Bowling type">${typeOpts}</optgroup>
      `;
    }
    return `
      ${opt("", "Everyone")}
      ${opt("hand:Right-hand bat", "Right-handers")}
      ${opt("hand:Left-hand bat", "Left-handers")}
    `;
  }

  /** The split dimension actually in effect for rendering — null in matchup
   * mode (no row-grouping there) regardless of a leftover state.splitBy. */
  function effectiveSplitDim(state) {
    return matchupVsActive(state) ? null : lastSplitDim;
  }

  /** Row-count slot text. `rows === null` means "still loading". Split rows
   * are (player × split value), so "players" would be dishonest there.
   * Thousands separators throughout (Batch 1 mechanical fix). */
  function rowCountLabel(rows, splitDim) {
    if (rows === null) return "Loading…";
    return splitDim
      ? `${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"} (split by ${splitDim.label.toLowerCase()})`
      : `${rows.length.toLocaleString()} player${rows.length === 1 ? "" : "s"}`;
  }

  /**
   * Render the persistent toolbar's contents in place (row count, preset
   * chips, "Vs" / Group rows / Columns actions) and rebind its listeners.
   * Called both mid-query (`rows: null` → "Loading…" row count, everything
   * else still fully interactive-looking) and after a load resolves (`rows`:
   * the result set) — same markup shape either way, so no control ever
   * vanishes or changes position between the two states (Batch 1 mechanical
   * fix: previously the whole toolbar was replaced by a bare "Loading…" div
   * on every re-query).
   *
   * Column presets and "Group rows" don't apply in matchup mode (no row
   * grouping/preset vocabulary there — only the restricted column picker
   * applies), but they stay in their normal toolbar slot, just greyed out
   * (disabled + title) instead of being removed — removing them (the old
   * behavior) is what let the "Vs" control and the Columns button drift to
   * different positions between modes, since removing an earlier sibling
   * reflows everything after it.
   */
  function renderToolbar(state, rows, bowlingTypes) {
    const matchupOn = matchupVsActive(state);
    const ns = effectiveDiscipline(state);
    const splitDim = effectiveSplitDim(state);

    // Position filters DO apply in both modes now (D4-R4) — only the honest
    // stat-condition applicability note remains conditional.
    const { total: condTotal, applied: condApplied } = conditionApplicability(state.advanced, ns);
    const conditionNoteText =
      condTotal > 0 && condApplied < condTotal ? `${condApplied} of ${condTotal} stat conditions apply here` : "";

    // Column presets (R1): one-click sets; the active chip is the preset whose
    // columns exactly match the current selection (none = no-preset/custom
    // territory). Always rendered — greyed out in matchup mode rather than
    // swapped for a note, so the toolbar's shape never changes between modes.
    const currentPreset = matchupOn ? null : activePresetKey(state.discipline, state.formats, visibleColumns());
    const presetChipsHTML = COLUMN_PRESET_DEFS[state.discipline]
      .map((def) => {
        const phaseAvailable = def.columns(state.formats) !== null;
        const disabled = matchupOn || !phaseAvailable;
        const title = matchupOn
          ? ` title="Presets don't apply in matchup mode — column picker only"`
          : phaseAvailable
            ? ""
            : ` title="Pick a single phase family (T20, or ODI/ODM) to use phase columns"`;
        const active = !matchupOn && def.key === currentPreset;
        return `<button type="button" class="chip chip--preset ${active ? "is-active" : ""}"
          data-preset="${def.key}" ${disabled ? "disabled" : ""}${title}>${def.label}</button>`;
      })
      .join("");
    const noteText = matchupOn
      ? conditionNoteText
        ? `Matchup mode, ${conditionNoteText}`
        : "Matchup mode"
      : conditionNoteText;
    const noteHTML = noteText ? `<div class="table-toolbar__matchup-note">${noteText}</div>` : "";
    const presetsBlockHTML = `<div class="table-toolbar__presets" role="group" aria-label="Column presets">${presetChipsHTML}</div>${noteHTML}`;

    // "Group rows" (decision 29: row-splitting kept, tucked in the toolbar).
    // A presentation control like the column picker, so changes reload directly
    // (no Show-results round trip — the scope hasn't changed, only its layout).
    // Always rendered, greyed out in matchup mode (same reasoning as presets).
    const groupOptionsHTML = ["", ...Object.keys(SPLIT_DIMENSIONS)]
      .map((key) => {
        if (key === "") return `<option value="">No grouping</option>`;
        const dim = SPLIT_DIMENSIONS[key];
        const allowed = splitAllowed(state, key);
        return `<option value="${key}" ${allowed ? "" : "disabled"} ${state.splitBy === key ? "selected" : ""}>${dim.label}</option>`;
      })
      .join("");
    const groupDisabledAttr = matchupOn ? ` disabled title="Row grouping isn't available in matchup mode"` : "";
    const groupRowsHTML = `<label class="table-toolbar__group-label">Group rows
      <select class="select select--compact" data-role="group-rows" aria-label="Group rows"${groupDisabledAttr}>${groupOptionsHTML}</select>
    </label>`;

    const columnsBtnHTML = `<button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Columns</button>`;

    // "Graph" bridge button (Batch 3 part 2, decision 43; matchup mode enabled
    // Batch 4 wave 2; relabeled "Turn into graph" -> "Graph" and grouped with
    // Columns as the toolbar's right-most cluster, decision 44d; decision 46f:
    // no longer force-renders anything — just navigates to Graphs, seeding its
    // player pool from this exact table's current filters/sort/top-15, or —
    // in matchup mode only — landing directly on the Dumbbell chart with the
    // table's own Vs bucket as one side) — see graph.js's enterFromBridge().
    // An unqueried/empty table has nothing to seed from, so that's the only
    // state that still disables the button, with an honest title rather than
    // removing it (same reasoning as the presets/Group-rows greying above —
    // the toolbar's shape never changes between modes).
    const noResultsForGraph = !rows || rows.length === 0;
    const graphBtnDisabled = noResultsForGraph;
    const graphBtnTitle = noResultsForGraph
      ? "Show results first"
      : matchupOn
        ? "Seed the Graph Builder's Dumbbell chart from this Vs comparison"
        : "Seed the Graph Builder from this table";
    const turnIntoGraphBtnHTML = `<button type="button" class="btn btn--ghost" data-role="turn-into-graph" ${graphBtnDisabled ? "disabled" : ""} title="${escAttr(graphBtnTitle)}">Graph</button>`;

    // "Vs" matchup select (D4 R3, decision 33): ALWAYS rendered, both modes —
    // greyed for women (no style data yet, decision 21), presentation-mode
    // control like Group rows (changes reload directly).
    const vsDisabled = state.gender === "female";
    const vsTitle = vsDisabled ? ` title="No style data for women's cricket yet"` : "";
    const vsSelectHTML = `<label class="table-toolbar__group-label">Vs
      <select class="select select--compact" data-role="matchup-vs" aria-label="Matchup opponent" ${vsDisabled ? "disabled" : ""}${vsTitle}>${matchupVsOptionsHTML(state, bowlingTypes)}</select>
    </label>`;

    // Right-most cluster (decision 44d): Graph + Columns grouped together and
    // pushed flush to the card's right edge via .table-toolbar__graph-columns
    // (margin-left: auto in styles.css), Graph immediately left of Columns.
    // Vs / Group rows keep their own left-packed cluster so the two groups
    // can wrap independently on narrow (~380px) viewports without losing the
    // "flush right" placement of Graph/Columns.
    toolbarEl.innerHTML = `
      <div class="table-toolbar__row-count">${rowCountLabel(rows, splitDim)}</div>
      ${presetsBlockHTML}
      <div class="table-toolbar__actions">
        <div class="table-toolbar__controls">
          ${vsSelectHTML}
          ${groupRowsHTML}
        </div>
        <div class="table-toolbar__graph-columns">
          ${turnIntoGraphBtnHTML}
          ${columnsBtnHTML}
        </div>
      </div>
    `;

    toolbarEl.querySelectorAll(".chip--preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const def = COLUMN_PRESET_DEFS[state.discipline].find((d) => d.key === btn.dataset.preset);
        const cols = def ? def.columns(store.get().formats) : null;
        if (!cols) return;
        const s = store.get();
        store.set({ columns: { ...s.columns, [s.discipline]: cols } });
        load();
      });
    });

    const groupSelect = toolbarEl.querySelector('[data-role="group-rows"]');
    if (groupSelect) {
      groupSelect.addEventListener("change", () => {
        store.set({ splitBy: groupSelect.value || null });
        load();
      });
    }

    const vsSelect = toolbarEl.querySelector('[data-role="matchup-vs"]');
    if (vsSelect) {
      vsSelect.addEventListener("change", () => {
        const raw = vsSelect.value;
        if (!raw) {
          store.set({ matchupVs: null });
        } else {
          const idx = raw.indexOf(":");
          store.set({ matchupVs: { dim: raw.slice(0, idx), value: raw.slice(idx + 1) } });
        }
        load();
      });
    }

    const columnsBtn = toolbarEl.querySelector('[data-role="columns-btn"]');
    if (columnsBtn) {
      columnsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openColumnsPopover(columnsBtn);
      });
    }

    const turnIntoGraphBtn = toolbarEl.querySelector('[data-role="turn-into-graph"]');
    if (turnIntoGraphBtn) {
      turnIntoGraphBtn.addEventListener("click", () => {
        if (turnIntoGraphBtn.disabled) return;
        if (onTurnIntoGraph) onTurnIntoGraph();
      });
    }
  }

  /** Mid-query state: the toolbar stays mounted and fully interactive-looking
   * (only its row-count slot reads "Loading…"); the table area shows the
   * existing "Running query…" overlay in place of the table-scroll, which is
   * hidden rather than emptied (Batch 1 mechanical fix — see mountTable's
   * skeleton doc comment). */
  function renderLoadingState(state, bowlingTypes = lastBowlingTypes) {
    ensureSkeleton();
    overlayEl.hidden = false;
    scrollEl.hidden = true;
    renderToolbar(state, null, bowlingTypes);
  }

  /** Loaded state: fills in the table head/body and the toolbar's final row
   * count, then rebinds the table's own listeners (sort, player links).
   * `rows` must already be the split/matchup-aware, sorted rows for `state`. */
  function renderLoaded(rows, state, bowlingTypes = lastBowlingTypes) {
    ensureSkeleton();
    overlayEl.hidden = true;
    scrollEl.hidden = false;

    const matchupOn = matchupVsActive(state);
    const ns = effectiveDiscipline(state);
    const splitDim = effectiveSplitDim(state);
    const colKeys = state.columns[ns];
    const cols = colKeys.map((key) => getMetric(key, ns)).filter(Boolean);

    const splitSorted = state.sort.key === "__split";
    const splitTh = splitDim
      ? `<th data-key="__split" class="data-table__th data-table__th--split ${splitSorted ? "is-sorted" : ""}" scope="col">
          <button type="button" class="data-table__sort-btn">${escHtml(splitDim.columnLabel)}${splitSorted ? (state.sort.dir === "asc" ? " ▲" : " ▼") : ""}</button>
        </th>`
      : "";
    const coverageTh = matchupOn
      ? `<th class="data-table__th data-table__th--coverage" scope="col">Coverage</th>`
      : "";

    theadEl.innerHTML = `
      <tr>
        <th class="data-table__th data-table__th--sticky" scope="col">Player</th>
        ${coverageTh}
        ${splitTh}
        ${cols.map((m) => headerCellHTML(m, state)).join("")}
      </tr>`;

    tbodyEl.innerHTML = rows
      .map((row) => {
        const coverageTd = matchupOn
          ? `<td class="data-table__td data-table__td--coverage">${coverageLabel(row.coverage)}</td>`
          : "";
        const splitTd = splitDim
          ? `<td class="data-table__td data-table__td--split">${row.split_value == null ? "—" : escHtml(row.split_value)}</td>`
          : "";
        const cells = cols.map((m) => dataCellHTML(m, row)).join("");
        // Player names link to the player page (R2, decision 29).
        const nameCell = onPlayerClick
          ? `<button type="button" class="player-link" data-player-id="${escAttr(row.id ?? "")}">${escHtml(row.name ?? "")}</button>`
          : escHtml(row.name ?? "");
        return `<tr><td class="data-table__td data-table__td--sticky">${nameCell}</td>${coverageTd}${splitTd}${cells}</tr>`;
      })
      .join("");

    renderToolbar(state, rows, bowlingTypes);

    // Sorting: click header to sort/flip. Re-sorts the cached rows client-side
    // (no requery needed — the result set is unchanged, only its order). The
    // sort-state class (is-sorted / arrow) is recomputed from `state` on every
    // renderLoaded call, so it survives this persistent-skeleton refactor the
    // same way it always did — headerCellHTML just reads state.sort fresh.
    theadEl.querySelectorAll(".data-table__th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        const s = store.get();
        if (s.sort.key === key) {
          store.set({ sort: { key, dir: s.sort.dir === "asc" ? "desc" : "asc" } });
        } else if (key === "__split") {
          // Position/opposition/dismissal read most naturally ascending.
          store.set({ sort: { key, dir: "asc" } });
        } else {
          const metric = getMetric(key, effectiveDiscipline(s));
          const defaultDir = metric.higherIsBetter === false ? "asc" : "desc";
          store.set({ sort: { key, dir: defaultDir } });
        }
        const next = store.get();
        lastRows = applySort(lastRows, next);
        renderLoaded(lastRows, next, bowlingTypes);
      });
    });

    if (onPlayerClick) {
      tbodyEl.querySelectorAll(".player-link").forEach((btn) => {
        btn.addEventListener("click", () => {
          onPlayerClick(btn.dataset.playerId, btn.textContent);
        });
      });
    }
  }

  /**
   * The column picker (§ restricted picker, D4 R3 follow-up): lists every
   * eligible metric in the CURRENT effective namespace — the plain
   * batting/bowling vocabulary normally, or the matchup_batting/matchup_bowling
   * vocabulary while a "Vs" selection is active — in the same three sections
   * (Basic / Dismissals / Phase) either way. Mutates state.columns[ns], so a
   * pick made in matchup mode never leaks into the plain picker's list or
   * vice versa (they're different namespaces/keys).
   *
   * Batch 3 fix 3: hosted on document.body, NOT inside `container`. Every
   * checkbox change calls load(), which (pre-Batch-1) reassigned
   * container.innerHTML wholesale (renderLoading() then renderTable()) — a
   * popover living inside that subtree was destroyed the instant the first
   * checkbox fired, so only one column could be ticked per open (the owner's
   * known complaint). Batch 1's persistent-toolbar refactor (renderLoadingState()
   * / renderLoaded(), see above) no longer nukes `container` wholesale either,
   * but this popover still lives on document.body regardless — it must survive
   * even a full prompt/error transition, which DOES still replace `container`.
   * Living on body lets it survive reloads for free; positionColumnsPopover()
   * places it from the anchor button's getBoundingClientRect(), and
   * refreshOpenColumnsPopover() (called from load(), see below) re-finds the
   * anchor and re-syncs checked state + position after every reload while
   * it's open.
   */
  function positionColumnsPopover(popover, anchor) {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    popover.style.position = "fixed";
    popover.style.top = `${Math.round(rect.bottom + 6)}px`;
    // Right-align to the anchor (matches the old right:0-in-parent look),
    // clamped so it never runs off either edge on a narrow (~380px) viewport.
    const width = popover.offsetWidth || 240;
    let left = rect.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.right = "auto";
  }

  function closeColumnsPopover() {
    if (!openColumnsPopoverState) return;
    const { el, onDocClick, onKeydown, onScroll, onResize } = openColumnsPopoverState;
    el.remove();
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    openColumnsPopoverState = null;
  }

  /** Called from load() after every reload while the popover is open:
   * re-finds the (possibly recreated) anchor button, repositions, and
   * re-syncs checkbox checked state from the store — pruneInvalidColumns()
   * may have silently dropped a phase column out from under it, and the
   * checkboxes must stay honest about what's actually visible. Closes if the
   * anchor no longer exists (e.g. the toolbar mode changed under it). */
  function refreshOpenColumnsPopover() {
    if (!openColumnsPopoverState) return;
    const anchor = container.querySelector('[data-role="columns-btn"]');
    if (!anchor) {
      closeColumnsPopover();
      return;
    }
    openColumnsPopoverState.anchor = anchor;
    const state = store.get();
    const ns = effectiveDiscipline(state);
    const visible = new Set(state.columns[ns]);
    openColumnsPopoverState.el.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      // Two shapes of checkbox share this popover: the plain data-key ones
      // (Basic/Phase, and Dismissals in every namespace except batting) and
      // the batting Dismissals section's dual-key rows (data-count-key/
      // data-pct-key — see dismissalRowHTML), checked iff EITHER of their two
      // underlying columns is visible. The "Show as %" toggle itself has
      // neither dataset key and is skipped here — its own checked state is
      // plain UI state (not derived from `visible`) and untouched by reloads.
      if (cb.dataset.key) {
        cb.checked = visible.has(cb.dataset.key);
      } else if (cb.dataset.countKey) {
        cb.checked = visible.has(cb.dataset.countKey) || visible.has(cb.dataset.pctKey);
      }
    });
    positionColumnsPopover(openColumnsPopoverState.el, anchor);
  }

  function openColumnsPopover(anchor) {
    closeColumnsPopover();
    const state = store.get();
    const ns = effectiveDiscipline(state);
    const all = eligibleMetrics(ns, state.formats);
    const basic = all.filter((m) => !m.isPhaseMetric && m.section !== "dismissal");
    const dismissal = all.filter((m) => m.section === "dismissal");
    const phase = all.filter((m) => m.isPhaseMetric);
    const visible = new Set(state.columns[ns]);

    const popover = document.createElement("div");
    popover.className = "columns-popover";
    const section = (label, metrics) =>
      metrics.length
        ? `<div class="columns-popover__section-label">${label}</div>
           <div class="columns-popover__list">
             ${metrics
               .map(
                 (m) => `<label class="columns-popover__item">
                   <input type="checkbox" data-key="${m.key}" ${visible.has(m.key) ? "checked" : ""} />
                   <span>${m.label}</span>
                 </label>`
               )
               .join("")}
           </div>`
        : "";

    // Dismissals: the pruned real/rare + "Show as %" layout, batting ONLY
    // (see the RARE_DISMISSAL_KINDS doc comment for why every other namespace
    // keeps the plain `section()` list above — they never had the 24-checkbox
    // problem this solves).
    let dismissalHTML;
    if (ns === "batting") {
      const showPct = computeInitialShowPct(state.columns[ns]);
      const realKinds = DISMISSAL_KINDS.filter((d) => !RARE_DISMISSAL_KINDS.has(d.kind));
      const rareKinds = DISMISSAL_KINDS.filter((d) => RARE_DISMISSAL_KINDS.has(d.kind));
      dismissalHTML = `
        <div class="columns-popover__section-label">Dismissals</div>
        <label class="columns-popover__pct-toggle">
          <input type="checkbox" data-role="dismissal-pct-toggle" ${showPct ? "checked" : ""} />
          <span>Show as %</span>
        </label>
        <div class="columns-popover__list">
          ${realKinds.map((d) => dismissalRowHTML(d, visible)).join("")}
        </div>
        <details class="columns-popover__disclosure">
          <summary><span class="columns-popover__disclosure-arrow">▸</span> Rare dismissals</summary>
          <div class="columns-popover__list">
            ${rareKinds.map((d) => dismissalRowHTML(d, visible)).join("")}
          </div>
        </details>`;
    } else {
      dismissalHTML = section("Dismissals", dismissal);
    }

    popover.innerHTML = section("Basic", basic) + dismissalHTML + section("Phase", phase);
    document.body.appendChild(popover);
    positionColumnsPopover(popover, anchor);

    // Plain data-key checkboxes: Basic, Phase, and (outside batting)
    // Dismissals — unchanged mechanics from before this redesign.
    popover.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const s = store.get();
        const curNs = effectiveDiscipline(s);
        const cols = s.columns[curNs].slice();
        if (cb.checked) {
          if (!cols.includes(cb.dataset.key)) cols.push(cb.dataset.key);
        } else {
          const idx = cols.indexOf(cb.dataset.key);
          if (idx >= 0) cols.splice(idx, 1);
        }
        store.set({ columns: { ...s.columns, [curNs]: cols } });
        // Reloads the table; refreshOpenColumnsPopover() (called at the end
        // of load(), once the new container DOM exists) keeps THIS popover
        // alive, repositioned, and re-synced instead of it vanishing with
        // the old container.innerHTML.
        load();
      });
    });

    // Batting Dismissals rows: each checkbox stands for whichever variant
    // (count vs %) the toggle currently selects. Ticking a previously-unchecked
    // row adds THAT variant; unticking removes BOTH (defensive against a
    // legacy mixed-state save carrying the "wrong" one — see
    // computeInitialShowPct's doc comment).
    const toggleEl = popover.querySelector('[data-role="dismissal-pct-toggle"]');
    popover.querySelectorAll('input[type="checkbox"][data-count-key]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const s = store.get();
        const curNs = effectiveDiscipline(s); // always "batting" — this section only renders when ns === "batting"
        const cols = s.columns[curNs].slice();
        const countKey = cb.dataset.countKey;
        const pctKey = cb.dataset.pctKey;
        if (cb.checked) {
          const activeKey = toggleEl.checked ? pctKey : countKey;
          if (!cols.includes(activeKey)) cols.push(activeKey);
        } else {
          [countKey, pctKey].forEach((k) => {
            const idx = cols.indexOf(k);
            if (idx >= 0) cols.splice(idx, 1);
          });
        }
        store.set({ columns: { ...s.columns, [curNs]: cols } });
        load();
      });
    });

    // Section-level "Show as %" toggle: on every flip, normalise EVERY
    // currently-checked dismissal row onto the new variant (drop whichever
    // key is present, push the toggle's own key) — this is the "normalise on
    // first interaction" rule (decision 44c): opening the popover never
    // rewrites a legacy mixed-state column list by itself, only an actual
    // toggle flip (or a row check/uncheck, handled above) does.
    if (toggleEl) {
      toggleEl.addEventListener("change", () => {
        const s = store.get();
        const curNs = effectiveDiscipline(s);
        const cols = s.columns[curNs].slice();
        const showPct = toggleEl.checked;
        for (const d of DISMISSAL_KINDS) {
          const countKey = d.key;
          const pctKey = `${d.key}_pct`;
          const wasChecked = cols.includes(countKey) || cols.includes(pctKey);
          if (!wasChecked) continue;
          [countKey, pctKey].forEach((k) => {
            const idx = cols.indexOf(k);
            if (idx >= 0) cols.splice(idx, 1);
          });
          cols.push(showPct ? pctKey : countKey);
        }
        store.set({ columns: { ...s.columns, [curNs]: cols } });
        load();
      });
    }

    const onDocClick = (e) => {
      if (popover.contains(e.target) || e.target === anchor || anchor.contains?.(e.target)) return;
      closeColumnsPopover();
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") closeColumnsPopover();
    };
    const onScroll = () => {
      if (!openColumnsPopoverState) return;
      const a = openColumnsPopoverState.anchor;
      if (!document.body.contains(a)) {
        closeColumnsPopover();
        return;
      }
      positionColumnsPopover(openColumnsPopoverState.el, a);
    };
    const onResize = () => closeColumnsPopover();

    // Deferred so the very click that opened the popover doesn't immediately
    // close it again via onDocClick.
    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
    document.addEventListener("keydown", onKeydown, true);
    // Capture:true — scroll doesn't bubble, but a capturing listener on
    // window still sees scrolls on nested scrollable ancestors (e.g.
    // .table-scroll's horizontal scrollbar).
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    openColumnsPopoverState = { el: popover, anchor, onDocClick, onKeydown, onScroll, onResize };
  }

  async function load() {
    // Sort-key fallback across mode/namespace transitions (batting/bowling <->
    // matchup_batting/matchup_bowling): the column sets differ (e.g.
    // "balls_faced" vs "balls"; "dismissals" is matchup-only), so a sort key
    // that no longer resolves in the *effective* namespace must not silently
    // sort nothing. Falls back to runs/wickets desc, same defaults main.js
    // uses on a plain discipline switch.
    const preState = store.get();
    if (!getMetric(preState.sort.key, effectiveDiscipline(preState))) {
      store.set({ sort: { key: preState.discipline === "batting" ? "runs" : "wickets", dir: "desc" } });
    }

    // Restricted picker (D4 R3 follow-up): the matchup namespaces get the same
    // phase-eligibility prune as the plain picker, so this runs unconditionally
    // regardless of mode.
    pruneInvalidColumns();
    const state = store.get();
    const ns = effectiveDiscipline(state);
    const cols = state.columns[ns];
    const { sql, matchesSql, splitDim } = buildQuery(state, cols, { split: true });
    const token = ++loadToken;
    renderLoadingState(state);
    try {
      const [{ rows }, matchesResult, bowlingTypes] = await Promise.all([
        query(sql),
        matchesSql ? query(matchesSql) : Promise.resolve({ rows: [] }),
        bowlingTypesCache ? Promise.resolve(bowlingTypesCache) : ensureBowlingTypes(),
      ]);
      if (token !== loadToken) return; // a newer load superseded this one
      lastSplitDim = splitDim ?? null;
      lastBowlingTypes = bowlingTypes;

      let merged = rows;
      if (matchesSql) {
        const byId = new Map(matchesResult.rows.map((r) => [r.id, r.matches]));
        merged = rows.map((r) => ({ ...r, matches: byId.get(r.id) ?? null }));
      }
      // C1: coverage is now carried inline on every row by buildMatchupQuery
      // (__coverage_total / __coverage_mapped, one merged scan) instead of a
      // second standalone query — read straight off the row.
      if (matchupVsActive(state)) {
        merged = merged.map((r) => ({
          ...r,
          coverage: { mapped: r.__coverage_mapped ?? 0, total: r.__coverage_total ?? 0 },
        }));
      }

      // A stale "__split" sort (split since turned off) falls back to unsorted;
      // applySort handles both metric and split-column sorts.
      const sorted = applySort(merged, state);

      lastRows = sorted;
      lastQueryStateKey = serializeQueryState(state);
      renderLoaded(sorted, state, bowlingTypes);
      // The columns popover (if open) lives outside `container` precisely so
      // this reload never destroys it (Batch 3 fix 3) — re-find its anchor in
      // the freshly-rendered toolbar, reposition, and re-sync checked state.
      refreshOpenColumnsPopover();
      // Resolved row count (B2R wave 3): the omnisearch "Filter the table"
      // toast (main.js's triggerTableSearch) needs to know whether the query
      // it just triggered came back empty, without table.js exposing any
      // other internal state. Every existing caller of load() (toolbar
      // controls, the columns popover, the prompt/drawer buttons) already
      // ignores the resolved value, so this is purely additive.
      return sorted.length;
    } catch (err) {
      if (token !== loadToken) return null;
      renderError(err, load);
      // No columns-btn in the error state — close honestly rather than leave
      // a popover floating over an error box with no anchor.
      refreshOpenColumnsPopover();
      return null;
    }
  }

  // Graph-button/bridge handler (decision 46f): "has the Stats tab been
  // searched at least once, ever" — true the instant load() first succeeds,
  // regardless of whether the scope has since moved on (unlike enterView()'s
  // own exact-state-match cache check above). This is what lets the Graphs
  // view decide between its empty-state ("run a search on Stats first") and
  // seeding its player pool from the current filtered set — see graph.js's
  // onShow()/seedSelection() and main.js's mountGraph() wiring.
  function hasResults() {
    return lastQueryStateKey !== null;
  }

  return { load, showPrompt: renderPrompt, enterView, hasResults };
}
