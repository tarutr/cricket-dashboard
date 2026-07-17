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
import { buildScopeClauses, buildCoreScopeClauses, whereWithPinExemption, gateWithPinExemption } from "./filters.js";
import { activeGroups } from "./advanced.js";
import { escHtml, escAttr } from "./html.js";
import {
  eligibleMetrics,
  positionsFilterActive,
  oppositionFilterActive,
  COLUMN_PRESET_DEFS,
  activePresetKey,
  matchupVsActive,
  effectiveNamespace,
  escSql as esc,
} from "./state.js";

const VIEW_FOR_DISCIPLINE = { batting: "batting", bowling: "bowling" };
const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };
// The opposition column in each innings view (D4 Piece 3): who the player
// batted against / bowled to.
const OPP_COL = { batting: "bowling_team", bowling: "batting_team" };

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

// Escape LIKE wildcards (\ % _) then SQL-quote a name-search term, so a literal
// '%' or '_' typed into the table search matches that character instead of
// acting as a pattern metacharacter. Mirrors playerData.js's searchPlayers;
// pair with ESCAPE '\\' at each use site. A plain-letters term is unaffected.
const escSearch = (s) => esc(s.replace(/([\\%_])/g, "\\$1"));

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
 * how they're rendered — feeds lastQueryStateKey, mountTable's simple "has a
 * result ever been loaded" sentinel (hasResults()), kept in step at every
 * site that produces/reshapes a result set (load(), reorderColumns(), the
 * sort-click handler). F2 retired its other former job — gating enterView()'s
 * cache restore on an exact-match comparison against the live state
 * (decision 44d) — in favour of always restoring the last loaded rows
 * against their OWN snapshot (see lastLoadedState, mountTable's top).
 * Deliberately EXCLUDES `view` itself and includes only the ACTIVE effective
 * namespace's column list (a column edit made in the other discipline/
 * matchup namespace while away doesn't change what's currently on screen).
 * Every field here is either read directly by buildQuery/buildScopeClauses,
 * or governs rendering shape (columns, sort, matchupVs) — the same
 * fields lastLoadedState's snapshot needs to stay correct for.
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
    event: state.event,
    venue: state.venue,
    matchupVs: state.matchupVs,
    pinnedPlayers: state.pinnedPlayers,
    search: state.search,
    // R4 Wave 4a (A1): `sort` is deliberately EXCLUDED. Clicking a column header
    // now re-sorts the loaded rows INSTANTLY (applySortKey below) and must NOT
    // light the Search button — since nothing PENDING ever changes the sort key
    // on its own (a discipline change lights Search via `discipline` here
    // regardless), leaving sort out of the dirty comparison is the whole fix.
    // `columns` STAYS in: the PENDING preset dropdown sets it and must keep
    // lighting Search — the INSTANT Columns picker / drag-reorder instead advance
    // the applied snapshot (onColumnsApplied) so THEY read as not-dirty.
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
  const allMetrics = keyOrder.map((key) => getMetric(key, ns)).filter(Boolean);
  // Composition columns (Coverage-breakdown wave): "Pace BF % / Spin BF % /
  // Uncategorised BF %" (batting) and "RHB % / LHB % / Uncategorised %"
  // (bowling). These are DESCRIPTIVE, UN-FILTERED-BY-BUCKET percentages — each
  // group's UNFILTERED balls ÷ the player's TOTAL balls (the coverage
  // denominator) — so they must NOT flow through the per-bucket FILTER path the
  // regular metrics take below. Split out here and computed via the SAME
  // unfiltered-partial → window-per-player → %-of-total staging the coverage
  // figures already use (see this function's doc comment). Their sqlExpression
  // is a placeholder, never interpolated (kind === "composition", mirroring
  // r_pos's placeholder handling in buildQuery).
  const metrics = allMetrics.filter((m) => m.kind !== "composition");
  const compMetrics = allMetrics.filter((m) => m.kind === "composition");

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
  for (const { metric, alias } of extraAggColumns) {
    aggSelectParts.push(`${appendFilterToAggregates(metric.sqlExpression, bucketClause)} AS ${alias}`);
  }
  // Coverage (SPEC_ADDENDUM D4.3): unfiltered partial sums at THIS query's own
  // (id, name) grain — summed across name variants by the window in step 2.
  aggSelectParts.push(`SUM(${ballsCol}) AS __coverage_total_partial`);
  aggSelectParts.push(
    `SUM(CASE WHEN ${groupCol} <> '(unmapped)' THEN ${ballsCol} ELSE 0 END) AS __coverage_mapped_partial`
  );
  // Composition (Coverage-breakdown wave): one UNFILTERED per-group ball
  // partial per visible composition column, at THIS query's (id, name) grain —
  // summed across name variants by the window in step 2, then divided by
  // __coverage_total in step 3. compositionGroup is a fixed vocabulary literal
  // (a bowling_group / batting_hand value); esc()'d as defense in depth.
  for (const m of compMetrics) {
    aggSelectParts.push(
      `SUM(CASE WHEN ${groupCol} = '${esc(m.compositionGroup)}' THEN ${ballsCol} ELSE 0 END) AS ${m.key}__partial`
    );
  }

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
    state.search && state.search.trim() ? `${nameCol} ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'` : null;

  // C1: WHERE no longer includes the bucket predicate — scope + search only,
  // identical to the old standalone coverageSql's WHERE. The bucket predicate
  // now lives exclusively in the per-column FILTER clauses above.
  const whereClauses = buildScopeClauses(state, scopeOpts);
  if (searchClause) whereClauses.push(searchClause);

  // Pinned players (Wave 4b, decision 47a): additive — a pinned player is scanned
  // as long as they have ANY core-scope row in this view, bypassing every
  // leaderboard-only clause above (team/opposition/position/profile/R.Pos/search),
  // exactly as buildQuery does. The bucket predicate is NOT in this WHERE (it is a
  // per-aggregate FILTER), so pins keep it automatically. With no pins this is
  // byte-identical to the former `whereClauses.join(" AND ")`.
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const coreClauses = buildCoreScopeClauses(state);
  const whereSql = whereWithPinExemption(whereClauses, coreClauses, idCol, pins);

  const aggSql = [
    `SELECT ${aggSelectParts.join(", ")}`,
    `FROM ${view}`,
    `WHERE ${whereSql}`,
    `GROUP BY ${idCol}, ${nameCol}`,
  ].join("\n");

  // Step 2 (`windowed`): pass every agg column through unchanged, plus the
  // cross-name-variant coverage totals.
  const passThroughCols = ["id", "name"];
  for (const m of metrics) {
    passThroughCols.push(m.key);
    if (m.sortExpression) passThroughCols.push(`${m.key}__sort`);
  }
  for (const { alias } of extraAggColumns) passThroughCols.push(alias);
  // Window every coverage/composition partial into its cross-name-variant total
  // for the id (SUM is additive — re-summing the partials reconstructs the
  // id-only totals). The composition partials join the same PARTITION BY id.
  const windowExprs = [
    `SUM(__coverage_total_partial) OVER (PARTITION BY id) AS __coverage_total`,
    `SUM(__coverage_mapped_partial) OVER (PARTITION BY id) AS __coverage_mapped`,
    ...compMetrics.map((m) => `SUM(${m.key}__partial) OVER (PARTITION BY id) AS ${m.key}__total`),
  ];
  const windowedSql = [
    `SELECT ${passThroughCols.join(", ")},`,
    `       ${windowExprs.join(",\n       ")}`,
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
    "__coverage_total",
    "__coverage_mapped",
    // Composition %: each group's windowed unfiltered balls as a share of the
    // player's TOTAL balls (the coverage denominator). NULLIF → NULL (renders
    // "—") only when the player has zero balls in scope; otherwise 0% is real
    // data (zeroIsData:true), so a player who never faced spin reads "0.0%",
    // never hidden. The three per row sum to 100% (they partition the balls).
    ...compMetrics.map((m) => `${m.key}__total * 100.0 / NULLIF(__coverage_total, 0) AS ${m.key}`),
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
  // Pinned players (Wave 4b, decision 47a): exempt from the step-3 gate too, so a
  // pinned player still shows even with 0 innings vs the bucket (the existence
  // gate fails) or failing a stat condition — their row simply reads 0/blank vs
  // the bucket (the "(no innings)" annotation is a later wave). This runs over
  // `windowed`, where the id column is projected as `id` (NOT idCol), so the
  // exemption references `id`. With no pins this is byte-identical to the former
  // `finalWhereParts.join(" AND ")`.
  const finalWhereSql = gateWithPinExemption(finalWhereParts.join(" AND "), "id", pins);

  const sql = [
    `WITH agg AS (`,
    aggSql,
    `),`,
    `windowed AS (`,
    windowedSql,
    `)`,
    `SELECT ${finalSelectParts.join(", ")}`,
    `FROM windowed`,
    `WHERE ${finalWhereSql}`,
  ].join("\n");

  return { sql, matchesSql: null, coverageSql: null };
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
  // R. Pos. (task 5) is NOT usable as a stat condition — its sqlExpression is
  // a non-SQL placeholder (metrics.js), since its real value only exists via
  // buildQuery's own special-cased CTE/JOIN (regularPositionCteSql), not a
  // static per-condition expression. The drawer's stat-condition picker
  // (advanced.js/drawer.js, outside this wave's scope) still lists it as a
  // pickable metric, so this guard is what keeps a user's pick from ever
  // reaching SQL — treated as "doesn't apply here", the same honest
  // degradation an out-of-namespace condition already gets (see
  // conditionApplicability just below, which this stays in step with).
  if (metric.kind === "position") return null;
  // Composition columns (Coverage-breakdown wave) are descriptive display-only
  // percentages with a placeholder sqlExpression (see metrics.js) — never a
  // usable stat condition. advanced.js already excludes them from the picker;
  // this guard is the same belt-and-braces defence r_pos gets just above, so a
  // stray composition-keyed condition can never reach SQL.
  if (metric.kind === "composition") return null;
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
      const m = getMetric(c.metricKey, ns);
      // kind "position" (R. Pos.) and kind "composition" (the descriptive
      // matchup %-mix columns) are never usable conditions — see
      // conditionToHaving's guards just above, which this must stay honest
      // about (never silently count them as "applied").
      if (m && m.kind !== "position" && m.kind !== "composition") applied += 1;
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
 * R. Pos. column support (task 5): a `WITH r_pos_cte AS (...)` fragment (the
 * "WITH " keyword itself is NOT included — the caller prepends it, since this
 * text is also useful standalone in error messages/tests) computing each
 * batter's modal batting_position — ties broken to the LOWEST position — over
 * the CORE scope only (buildCoreScopeClauses: gender/format/date/team_type),
 * reusing the exact rank shape of the existing R. Pos. FILTER
 * (filters.js's regularPositionsFilterActive block: `ROW_NUMBER() OVER
 * (PARTITION BY batter_id ORDER BY COUNT(*) DESC, batting_position ASC)`,
 * grouped by (batter_id, batting_position) first so COUNT(*) is the innings
 * count AT that position) so the column can never disagree with what the
 * filter calls a player's "regular position". The join key is aliased
 * `pos_batter_id` (see buildQuery's fromSql comment for why it must not be
 * named `batter_id`). One CTE, one scan of `batting` regardless of how many
 * output rows the outer query has (a correlated per-row subquery would have
 * been O(players × rows) instead).
 */
function regularPositionCteSql(state) {
  const coreScope = buildCoreScopeClauses(state).join(" AND ");
  return [
    "r_pos_cte AS (",
    "  SELECT pos_batter_id, pos FROM (",
    "    SELECT batter_id AS pos_batter_id, batting_position AS pos,",
    "           ROW_NUMBER() OVER (PARTITION BY batter_id ORDER BY COUNT(*) DESC, batting_position ASC) AS rn",
    "    FROM batting",
    `    WHERE ${coreScope} AND batting_position IS NOT NULL`,
    "    GROUP BY batter_id, batting_position",
    "  ) ranked",
    "  WHERE rn = 1",
    ")",
  ].join("\n");
}

/**
 * Build the main grouped SQL query for the current state + visible columns.
 * Returns { sql, matchesSql } — matchesSql is null unless "matches"
 * is visible AND still answerable from player_matches (see below). While a
 * matchup "Vs" selection is active, delegates to buildMatchupQuery (C1: one
 * merged scan carrying the stat columns, the coverage totals, and the
 * per-group composition %s — see that function's doc comment). __coverage_total
 * is the denominator behind the composition columns (comp_*); the old fixed
 * "Coverage" display column it once fed was replaced by those columns.
 *
 * "Matches" honesty (D4 Piece 3): player_matches has no opposition or
 * batting-position columns, so whenever an innings-level filter is
 * active, "matches" switches to COUNT(DISTINCT match_id) over the filtered
 * innings rows — matches in which the player actually batted/bowled within
 * the slice. Otherwise the player_matches source is kept (it also counts
 * matches where the player didn't bat/bowl).
 */
export function buildQuery(state, visibleColumns) {
  const discipline = state.discipline;

  if (matchupVsActive(state)) {
    return buildMatchupQuery(state, discipline, visibleColumns);
  }

  const view = VIEW_FOR_DISCIPLINE[discipline];
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];

  const inningsMetrics = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter((m) => m && m.source !== "player_matches");

  // R. Pos. column (task 5, B1 Wave 5 polish): batting-only, opts this ONE
  // metric out of the generic "interpolate metric.sqlExpression verbatim"
  // path below. Every other metric's sqlExpression is a static aggregate over
  // THIS query's own already-filtered rows; R. Pos. instead must reproduce the
  // existing R. Pos. FILTER's semantics exactly (filters.js's
  // regularPositionsFilterActive block) — the player's modal batting_position
  // over the CORE scope only (gender/format/date/team_type), regardless of
  // whatever team/opposition/position filter is also narrowing this query —
  // so a player's R. Pos. column value never disagrees with the R. Pos.
  // filter's own definition of "their regular position". That can't be
  // expressed as a fixed sqlExpression string (it needs live `state`), so it's
  // special-cased here: regularPositionCteSql() builds a ONE-PASS CTE (a
  // ROW_NUMBER-over-count rank, tie-broken to the lowest position — the same
  // shape as the filter's own subquery) and wantsRPos wires it into the FROM
  // clause below via a LEFT JOIN, only when the column is actually requested.
  const wantsRPos = discipline === "batting" && inningsMetrics.some((m) => m.key === "r_pos");

  const selectParts = [`${idCol} AS id`, `${nameCol} AS name`];
  for (const m of inningsMetrics) {
    if (m.key === "r_pos") {
      // Constant per (idCol) group (regularPositionCteSql guarantees at most
      // one row per pos_batter_id) — MAX() is just how a non-aggregate,
      // functionally-dependent JOIN column is projected out of a GROUP BY.
      selectParts.push(`MAX(r_pos_cte.pos) AS ${m.key}`);
    } else {
      selectParts.push(`${m.sqlExpression} AS ${m.key}`);
      if (m.sortExpression) selectParts.push(`${m.sortExpression} AS ${m.key}__sort`);
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
    whereClauses.push(`${nameCol} ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`);
  }

  // Pinned players (task 3b, owner decision 46; Wave 4b routed onto the shared
  // helper): additive OR. buildCoreScopeClauses is guaranteed to be the exact
  // prefix `whereClauses` above already starts with (same state, same
  // includeGender default), so the helper slices off precisely the
  // "leaderboard-only" remainder — team/opposition/position/profile/R. Pos./
  // search — without recomputing or duplicating any of that filter logic. A
  // pinned player's CORE scope (gender/format/date window/team type) still
  // applies unconditionally; only the leaderboard-only part is bypassed, for
  // exactly their id. buildMatchupQuery now calls the SAME helper (Wave 4b,
  // decision 47a), so plain and Vs pin-handling can never diverge.
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const whereSql = whereWithPinExemption(whereClauses, buildCoreScopeClauses(state), idCol, pins);

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
  // Pinned players are exempt from every HAVING/stat-condition predicate too
  // (task 3b: "HAVING/stat-condition post-filters must not drop pinned
  // rows") — idCol is the raw GROUP BY column (not the `id` alias), always
  // valid to reference directly in HAVING.
  const havingSql =
    havingParts.length === 0 ? null : gateWithPinExemption(havingParts.join(" AND "), idCol, pins);

  const wantsMatches = visibleColumns.includes("matches");
  const inningsLevel = positionsFilterActive(state) || oppositionFilterActive(state);
  if (wantsMatches && inningsLevel) {
    selectParts.push(`COUNT(DISTINCT match_id) AS matches`);
  }

  const groupBy = [idCol, nameCol];

  // r_pos_cte's join column is deliberately NOT named "batter_id"/"bowler_id"
  // (i.e. not idCol) — this view and the CTE would then both carry a column
  // of that exact name post-JOIN, making every existing bare `${idCol}`
  // reference elsewhere in this SELECT/GROUP BY (batter_id AS id, GROUP BY
  // batter_id, ...) ambiguous. "pos_batter_id" can never collide.
  const fromSql = wantsRPos ? `${view} LEFT JOIN r_pos_cte ON r_pos_cte.pos_batter_id = ${idCol}` : view;

  const sql = [
    ...(wantsRPos ? [`WITH ${regularPositionCteSql(state)}`] : []),
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${fromSql}`,
    `WHERE ${whereSql}`,
    `GROUP BY ${groupBy.join(", ")}`,
    // No base gate anymore (decision 44c) — HAVING is emitted only when the
    // advanced stat-conditions path contributes a predicate.
    ...(havingSql ? [`HAVING ${havingSql}`] : []),
  ].join("\n");

  let matchesSql = null;
  if (wantsMatches && !inningsLevel) {
    const pmFull = buildScopeClauses(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" });
    const pmCoreClauses = buildCoreScopeClauses(state);
    const pmExtra = pmFull.slice(pmCoreClauses.length);
    if (state.search && state.search.trim()) {
      pmExtra.push(`player_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`);
    }
    const pmWhereSql = whereWithPinExemption([...pmCoreClauses, ...pmExtra], pmCoreClauses, "player_id", pins);
    matchesSql = [
      `SELECT player_id AS id, COUNT(DISTINCT match_id) AS matches`,
      `FROM player_matches`,
      `WHERE ${pmWhereSql}`,
      `GROUP BY player_id`,
    ].join("\n");
  }

  return { sql, matchesSql };
}

// ── Dynamic sticky Player column width (task 4, R3 Wave 5 polish) ──────────
// Replaces the old fixed-width-by-breakpoint + JS truncateName() approach: the
// column is now sized, once per render, to the widest name actually on
// screen — so names almost never truncate on desktop — via an offscreen probe
// `<table class="data-table">` that shares the REAL `.data-table`/
// `.data-table__td` classes (so padding/font-weight/font-size are read off
// the genuine cascade, never guessed at in JS), clamped to
// [STICKY_COL_MIN_PX, STICKY_COL_MAX_PX] and written as an inline
// `--sticky-col-w` custom property on `.table-scroll` (mountTable's
// updateStickyColWidth(), called from renderLoaded) — see styles.css's
// ".data-table__th--sticky, .data-table__td--sticky" rule for why this
// specific ancestor/property combination is what makes the mobile breakpoint
// override still win at ≤640px. CSS's own overflow/ellipsis stays as the
// backstop for anything past STICKY_COL_MAX_PX, or before the very first
// measurement.
const STICKY_COL_MIN_PX = 96; // 6rem @ 16px root — same floor the old mobile tier used
const STICKY_COL_MAX_PX = 224; // 14rem @ 16px root (task 4's "sane max")

let measureProbe = null; // { table, td } — built once, reused for every measurement
let measureCanvasCtx = null; // cached 2d context for layout-free text-width ranking

/** A canvas 2d context set to the probe cell's exact computed font, for cheap
 * (no-reflow) width RANKING of candidate names. The winning names are then
 * re-measured against the real DOM probe for the exact box width. */
function nameRankingCtx(td) {
  if (!measureCanvasCtx) measureCanvasCtx = document.createElement("canvas").getContext("2d");
  const cs = getComputedStyle(td);
  measureCanvasCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return measureCanvasCtx;
}

function ensureMeasureProbe() {
  if (measureProbe) return measureProbe;
  const table = document.createElement("table");
  table.className = "data-table";
  table.setAttribute("aria-hidden", "true");
  table.style.position = "absolute";
  table.style.visibility = "hidden";
  table.style.left = "-9999px";
  table.style.top = "0";
  table.style.tableLayout = "auto";
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.className = "data-table__td";
  tr.appendChild(td);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  document.body.appendChild(table);
  measureProbe = { table, td };
  return measureProbe;
}

/** Widest rendered width (px) any of `names` would need in a real
 * `.data-table__td` cell — same classes as a genuine sticky name cell, minus
 * the `--sticky` modifier's own width/overflow rules (which would make every
 * measurement identical to the constrained box instead of the natural one). */
function widestNameColWidthPx(names) {
  const { td } = ensureMeasureProbe();
  if (!names.length) return 0;
  // Rank all candidates by canvas text width (no layout), then DOM-measure only
  // the few widest for the exact box width. A cell's rendered width is monotonic
  // in its text width, so the true widest is always among the top canvas-ranked
  // names — same result as measuring every row, but the reflow-forcing DOM reads
  // are bounded to a constant instead of one per row (which made "Show More",
  // ~2,800 rows, thrash layout).
  const ctx = nameRankingCtx(td);
  const TOP_K = 5;
  const top = []; // { name, w }, kept sorted widest-first, length <= TOP_K
  for (const raw of names) {
    const name = raw || "";
    const w = ctx.measureText(name).width;
    if (top.length < TOP_K) {
      top.push({ name, w });
      top.sort((a, b) => b.w - a.w);
    } else if (w > top[TOP_K - 1].w) {
      top[TOP_K - 1] = { name, w };
      top.sort((a, b) => b.w - a.w);
    }
  }
  let max = 0;
  for (const { name } of top) {
    td.textContent = name;
    const w = td.getBoundingClientRect().width;
    if (w > max) max = w;
  }
  return max;
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

/** Render one metric's `<td>`. Sample-based muting (decision 44c) was removed
 * (Batch B1 Wave 5, owner decision): every value — however thin its backing
 * sample — renders identically, plain and un-greyed. §8.1's hasMetricData
 * still governs "—" for genuine no-data; that's a different, still-live rule. */
function dataCellHTML(metric, row) {
  const value = row[metric.key];
  const text = formatValue(metric, value);
  // data-key (task 9): lets the live drag-reorder preview find "the cell in
  // THIS row belonging to column X" without any index arithmetic — see
  // wireColumnDrag's onMove.
  return `<td class="data-table__td" data-key="${metric.key}">${text}</td>`;
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

/** Pseudo-metric for the Player-name column (task 6). It is NOT a real
 * metrics.js entry (name is a structural column, not a stat), so it never
 * appears in the column picker, presets, or any query — it exists only so the
 * shared sort machinery (applySort / the sort-click handler / load()'s
 * sort-key fallback) can treat "name" like any other sortable key. Sorting is
 * client-side string comparison over row.name (compareRows special-cases it),
 * so no query changes. higherIsBetter:false makes the first click sort A–Z
 * (the sort-click default-direction rule maps higherIsBetter===false to "asc").
 */
const NAME_METRIC = { key: "name", label: "Player", shortLabel: "Player", higherIsBetter: false, format: "str" };

/** Resolve a sort key to a metric definition, including the synthetic
 * NAME_METRIC for the Player column. Every place that used getMetric() purely
 * to validate/resolve the CURRENT SORT key must go through this instead, so
 * sorting by name resolves rather than silently falling back to nothing. */
function resolveSortMetric(key, ns) {
  return key === "name" ? NAME_METRIC : getMetric(key, ns);
}

/** Sort value accessor: uses the __sort shadow column when present; NULL sorts last always. */
function sortValue(row, metric) {
  const raw = metric.sortExpression ? row[`${metric.key}__sort`] : row[metric.key];
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function compareRows(a, b, metric, dir) {
  // Player name (task 6): client-side alphabetical, case/diacritic-insensitive.
  // NULL/blank names sort last regardless of direction (§8.5), same as numerics.
  if (metric.key === "name") {
    const na = a.name == null ? "" : String(a.name);
    const nb = b.name == null ? "" : String(b.name);
    if (na === "" && nb === "") return 0;
    if (na === "") return 1;
    if (nb === "") return -1;
    const cmp = na.localeCompare(nb, undefined, { sensitivity: "base" });
    return dir === "asc" ? cmp : -cmp;
  }
  const va = sortValue(a, metric);
  const vb = sortValue(b, metric);
  // NULLS LAST regardless of direction.
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return dir === "asc" ? va - vb : vb - va;
}

// ── Table controller ─────────────────────────────────────────────────────────

export function mountTable(
  container,
  store,
  { onPlayerClick, onOpenFilters, onClear, onSearch, onDateChange, getAppliedState, onColumnsApplied, onSkeletonReady } = {}
) {
  let lastRows = [];
  let loadToken = 0;
  // Snapshot (serializeQueryState) of the state that produced lastRows, or
  // null before any successful load. Only used as a "has a result ever been
  // loaded" sentinel now (hasResults()) — enterView() used to also compare
  // this against the CURRENT state before restoring lastRows (decision 44d),
  // but F2 changed that: the table now persists across a bare tab switch even
  // when the filters have since moved on unsearched (see lastLoadedState).
  let lastQueryStateKey = null;
  // The full state object that produced lastRows (F2). enterView() renders
  // lastRows against THIS, never the live store.get(), because the live
  // state may have been edited in the still-open Filters popup without
  // hitting Search — rendering against a mismatched discipline/columns/
  // matchupVs would misdraw headers against the old rows' shape. Kept in
  // step with lastQueryStateKey at every site that (re)produces or reshapes
  // the current result set: load(), reorderColumns(), and the sort-click
  // handler — a view-only change (sort/reorder) must still show correctly if
  // the table view is re-entered later, exactly like a real reload would.
  // Reset to null by renderPrompt() (first boot, or Clear) so enterView()
  // correctly falls back to the blank prompt rather than resurrecting
  // whatever was loaded before Clear.
  let lastLoadedState = null;
  // The distinct bowling_type values (matchup mode's fine "Bowling type"
  // optgroup), fetched once from ./db.js and cached — small, format-agnostic
  // lookup that never changes at runtime.
  let bowlingTypesCache = null;
  let lastBowlingTypes = [];
  // The currently-open "Columns" popover, if any (Batch 3 fix 3). Tracked here
  // (not just a local DOM query) so load() can find and refresh it after
  // every reload — see openColumnsPopover()'s doc comment.
  let openColumnsPopoverState = null;
  // In-progress column drag (task 2), or null. Tracked at this scope (not
  // inside wireColumnDrag's own closure) purely so onUp() can read where the
  // pointer last was over — see wireColumnDrag's doc comment.
  let dragState = null;
  // Mobile name-column expansion (task 7 / #11): on ≤640px the Player column is
  // clamped to a narrow fixed width (styles.css), truncating long names.
  // Double-clicking the Player header toggles this flag, which adds
  // `.table-scroll.is-name-expanded` (CSS lets the column grow to full names at
  // that breakpoint only). Lives on scrollEl, which persists across reloads via
  // the skeleton, so an expanded name column survives re-sorts/re-queries;
  // renderPrompt() resets it since a Clear rebuilds the whole skeleton.
  let nameExpanded = false;
  function toggleNameExpand() {
    nameExpanded = !nameExpanded;
    if (scrollEl) scrollEl.classList.toggle("is-name-expanded", nameExpanded);
  }

  // Persistent table-mode skeleton (Batch 1 mechanical fix, decision 42/43):
  // the toolbar and table shell are built ONCE per entry into "table mode"
  // (the first load from the blank prompt, or after an error) and never
  // innerHTML-replaced by container.innerHTML wholesale again — every
  // subsequent render (loading, loaded, re-sort) writes into these nodes'
  // OWN innerHTML in place. This is what keeps the toolbar's controls
  // (Vs / Columns / presets) visible and interactive-looking
  // DURING a re-query instead of vanishing under the user's cursor and the
  // toolbar's geometry jumping. Null whenever we're not in table mode
  // (prompt/error), so ensureSkeleton() knows to rebuild fresh next time.
  let toolbarEl = null;
  let overlayEl = null;
  let scrollEl = null;
  let theadEl = null;
  let tbodyEl = null;
  let showMoreWrapEl = null;
  let showMoreBtnEl = null;
  // R3.2 single-row toolbar: stable control nodes (built once in
  // ensureSkeleton, wired once, kept in step by syncToolbar() rather than an
  // innerHTML rebuild — the "everything waits for Search" model needs the
  // controls to edit PENDING store state without moving the frozen table, and
  // rebuilding them each render would drop focus/selection and the search box's
  // typed text). Null while not in table mode.
  let dateFromEl = null;
  let dateToEl = null;
  let presetSelectEl = null;
  let vsWrapEl = null;
  let vsSelectEl = null;
  let countEl = null;
  let searchBtnEl = null;
  let columnsBtnEl = null;
  let clearBtnEl = null;
  let noteEl = null;
  let bodyHintEl = null;
  // Manifest date bounds (min/max "YYYY-MM-DD"), stashed via setDateBounds so a
  // skeleton rebuild (Clear/error→Search) can re-apply them to the fresh date
  // inputs. The toolbar dates bind the SAME state.dateFrom/dateTo as the popup's.
  let dateBounds = { min: null, max: null };
  // Which discipline the preset <select>'s option list was last built for — the
  // batting/bowling preset vocabularies differ, so syncToolbar rebuilds the
  // options only when the (pending) discipline actually changes.
  let presetOptionsDiscipline = null;
  // Pagination (task 3, B1 Wave 5 polish): how many of the CURRENT lastRows
  // are actually painted into tbody. Reset to PAGE_SIZE on every fresh load()
  // and on every client-side re-sort (both are "a new view of the data, start
  // at the top" per the task) — left untouched by a pure column reorder
  // (task 9) or by enterView()'s tab-switch restore, so paging back into an
  // already-expanded table doesn't collapse it again.
  const PAGE_SIZE = 50;
  let visibleRowCount = PAGE_SIZE;

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

  /** Build the persistent table-mode skeleton (single-row toolbar + loading
   * overlay + table shell) once and cache node references. A no-op if it
   * already exists.
   *
   * R3.2 (owner "everything waits for Search"): the WHOLE toolbar is now a set
   * of STABLE nodes built here once and kept in step by syncToolbar() — never
   * innerHTML-rebuilt — because every control edits PENDING store state and the
   * Search button lights dirty, all without moving the frozen table. Rebuilding
   * on each render would drop focus/selection and the search box's typed text.
   *
   * Single row: LEFT [Filters · search · From–To · preset ▾ · [Vs|val ▾]] /
   * RIGHT [count · SEARCH · Columns · Clear]. The old "Graph" button is gone —
   * the page-header Stats↔Graphs toggle now carries the seed (main.js). The
   * search box + pills host are handed to main.js via onSkeletonReady. */
  function ensureSkeleton() {
    if (toolbarEl) return;
    container.innerHTML = `
      <div class="table-toolbar">
        <div class="table-toolbar__left">
          <button type="button" class="btn btn--ghost table-toolbar__filters-btn" data-role="toolbar-filters-btn">Filters<span class="table-toolbar__filters-badge" data-role="toolbar-filters-count" hidden>0</span></button>
          <div class="table-toolbar__search" data-role="table-search-host">
            <input type="text" class="input" placeholder="Search players…" aria-label="Search players" autocomplete="off" role="combobox" aria-expanded="false" aria-autocomplete="list" data-role="table-search-input" />
            <div class="omnisearch__results" role="listbox" aria-label="Player search results" hidden data-role="table-search-results"></div>
          </div>
          <div class="table-toolbar__dates" data-role="toolbar-dates">
            <input type="date" class="input table-toolbar__date" data-role="toolbar-date-from" aria-label="From date" />
            <span class="table-toolbar__date-sep">–</span>
            <input type="date" class="input table-toolbar__date" data-role="toolbar-date-to" aria-label="To date" />
          </div>
          <select class="select table-toolbar__preset" data-role="preset-select" aria-label="Column preset"></select>
          <div class="table-toolbar__vs" data-role="toolbar-vs">
            <span class="table-toolbar__vs-label" aria-hidden="true">Vs</span>
            <select class="select table-toolbar__vs-select" data-role="matchup-vs" aria-label="Matchup opponent"></select>
          </div>
        </div>
        <div class="table-toolbar__right">
          <div class="table-toolbar__row-count" data-role="row-count"></div>
          <button type="button" class="btn btn--primary table-toolbar__search-btn" data-role="toolbar-search" disabled>Search</button>
          <button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Columns</button>
          <button type="button" class="btn btn--ghost table-toolbar__clear-btn" data-role="toolbar-clear-btn">Clear</button>
        </div>
      </div>
      <div class="table-toolbar__note" data-role="toolbar-note" hidden></div>
      <div class="table-pills-host" data-role="table-pills-host"></div>
      <div class="table-body-wrap" data-role="table-body-wrap">
        <div class="table-loading-overlay" aria-live="polite" hidden>Running query…</div>
        <div class="table-scroll"><table class="data-table"><thead></thead><tbody></tbody></table>
          <p class="table-body-hint" data-role="table-body-hint" hidden>Set your filters, then press Search.</p>
          <div class="table-show-more" data-role="table-show-more" hidden>
            <button type="button" class="btn btn--ghost" data-role="show-more-btn"></button>
          </div>
        </div>
      </div>
    `;
    // .table-toolbar__dynamic no longer exists; toolbarEl points at the whole
    // toolbar (used only as a "skeleton exists" sentinel + a syncToolbar guard).
    toolbarEl = container.querySelector(".table-toolbar");
    overlayEl = container.querySelector(".table-loading-overlay");
    scrollEl = container.querySelector(".table-scroll");
    theadEl = container.querySelector(".data-table thead");
    tbodyEl = container.querySelector(".data-table tbody");
    showMoreWrapEl = container.querySelector('[data-role="table-show-more"]');
    showMoreBtnEl = container.querySelector('[data-role="show-more-btn"]');
    bodyHintEl = container.querySelector('[data-role="table-body-hint"]');
    dateFromEl = container.querySelector('[data-role="toolbar-date-from"]');
    dateToEl = container.querySelector('[data-role="toolbar-date-to"]');
    presetSelectEl = container.querySelector('[data-role="preset-select"]');
    vsWrapEl = container.querySelector('[data-role="toolbar-vs"]');
    vsSelectEl = container.querySelector('[data-role="matchup-vs"]');
    countEl = container.querySelector('[data-role="row-count"]');
    searchBtnEl = container.querySelector('[data-role="toolbar-search"]');
    columnsBtnEl = container.querySelector('[data-role="columns-btn"]');
    clearBtnEl = container.querySelector('[data-role="toolbar-clear-btn"]');
    noteEl = container.querySelector('[data-role="toolbar-note"]');
    presetOptionsDiscipline = null; // force a fresh option build in syncToolbar

    if (showMoreBtnEl) {
      showMoreBtnEl.addEventListener("click", () => {
        // Reveal-all-at-once (task 3: "one click"), not another page. Pure
        // re-render of the already-loaded rows — no requery.
        visibleRowCount = lastRows.length;
        renderLoaded(lastRows, lastLoadedState ?? store.get(), lastBowlingTypes);
      });
    }

    // Filters button: opens the Filters popup. Bound once (its behaviour never
    // changes across reloads).
    if (toolbarEl) {
      const filtersBtn = container.querySelector('[data-role="toolbar-filters-btn"]');
      if (filtersBtn) filtersBtn.addEventListener("click", () => { if (onOpenFilters) onOpenFilters(); });
    }

    // Toolbar date inputs (R3.2): bind the SAME state.dateFrom/dateTo as the
    // popup's — a PENDING edit (never a query). Apply the stashed manifest
    // bounds, then let syncToolbar keep their values in step with the store.
    if (dateFromEl && dateToEl) {
      applyDateBounds();
      const onDate = (el, key) => () => {
        store.set({ [key]: el.value || null });
        // onDateChange lets main.js re-sync the popup's own date inputs +
        // preset label + date-required note; syncToolbar (via the store hook)
        // refreshes this cluster + the Search button.
        if (onDateChange) onDateChange();
        syncToolbar();
      };
      dateFromEl.addEventListener("change", onDate(dateFromEl, "dateFrom"));
      dateToEl.addEventListener("change", onDate(dateToEl, "dateTo"));
    }

    // Preset <select> (R3.2, item 5): the old preset chip row is now a plain
    // native select. Changing it sets the discipline's column list (PENDING) —
    // no query until Search. The option list is (re)built per-discipline by
    // syncToolbar; this handler reads the store live so binding once is safe.
    if (presetSelectEl) {
      presetSelectEl.addEventListener("change", () => {
        const s = store.get();
        const def = COLUMN_PRESET_DEFS[s.discipline].find((d) => d.key === presetSelectEl.value);
        const cols = def ? def.columns(s.formats) : null;
        if (!cols) {
          syncToolbar(); // revert the select to the real current preset/custom
          return;
        }
        store.set({ columns: { ...s.columns, [s.discipline]: cols } });
        syncToolbar();
      });
    }

    // Bonded "Vs" control (R3.2, item 6): a fixed "Vs" prefix + a value select.
    // Changing it sets state.matchupVs (PENDING) — synced with the popup's Vs
    // condition via the shared store. buildMatchupQuery is untouched.
    if (vsSelectEl) {
      vsSelectEl.addEventListener("change", () => {
        const raw = vsSelectEl.value;
        if (!raw) {
          store.set({ matchupVs: null });
        } else {
          const idx = raw.indexOf(":");
          store.set({ matchupVs: { dim: raw.slice(0, idx), value: raw.slice(idx + 1) } });
        }
        syncToolbar();
      });
    }

    if (columnsBtnEl) {
      columnsBtnEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openColumnsPopover(columnsBtnEl);
      });
    }

    // SEARCH button (R3.2): replaces the old toolbar "Graph" button and is the
    // ONE query trigger from the toolbar — main.js's runSearch commits pending
    // → applied and loads. syncToolbar gates its enabled/dirty state.
    if (searchBtnEl) {
      searchBtnEl.addEventListener("click", () => {
        if (searchBtnEl.disabled) return;
        if (onSearch) onSearch();
      });
    }

    if (clearBtnEl) {
      clearBtnEl.addEventListener("click", () => { if (onClear) onClear(); });
    }

    if (onSkeletonReady) {
      const searchHostEl = container.querySelector('[data-role="table-search-host"]');
      onSkeletonReady({
        searchInputEl: searchHostEl.querySelector('[data-role="table-search-input"]'),
        searchResultsEl: searchHostEl.querySelector('[data-role="table-search-results"]'),
        pillsHostEl: container.querySelector('[data-role="table-pills-host"]'),
      });
    }

    syncToolbar();
  }

  /** Apply the stashed manifest date bounds to the toolbar date inputs (called
   * on build and whenever setDateBounds updates them). */
  function applyDateBounds() {
    if (!dateFromEl || !dateToEl) return;
    for (const el of [dateFromEl, dateToEl]) {
      if (dateBounds.min) el.min = dateBounds.min;
      else el.removeAttribute("min");
      if (dateBounds.max) el.max = dateBounds.max;
      else el.removeAttribute("max");
    }
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
    showMoreWrapEl = null;
    showMoreBtnEl = null;
    bodyHintEl = null;
    dateFromEl = null;
    dateToEl = null;
    presetSelectEl = null;
    vsWrapEl = null;
    vsSelectEl = null;
    countEl = null;
    searchBtnEl = null;
    columnsBtnEl = null;
    clearBtnEl = null;
    noteEl = null;
    presetOptionsDiscipline = null;
  }

  /**
   * First-load / empty state (R3.2, item 1): the toolbar is ALWAYS visible —
   * we build the full skeleton and show an EMPTY table body below it, rather
   * than the old "Set your filters → Open filters" prompt card. Shown on first
   * boot (nothing has ever loaded) and by main.js's clearAll() (Clear returns
   * to exactly this state). A plain filter change never reverts here (the
   * no-automated-search rule): the table persists until the next Search
   * replaces it or Clear empties it.
   *
   * The skeleton is torn down and rebuilt fresh here so the search box + pills
   * re-mount empty (Clear must clear the typed search term too) — but it is
   * rebuilt IMMEDIATELY, so the toolbar never disappears; syncToolbar() then
   * applies the first-load gating (only Filters + search + dates active).
   */
  function renderPrompt() {
    // Invalidate any in-flight load: without this, a query started just before
    // the filters changed resolves AFTER the prompt renders and paints a stale
    // (often 0-row) table over it.
    loadToken++;
    closeColumnsPopover();
    teardownSkeleton();
    // enterView() unconditionally trusts lastLoadedState/lastRows whenever
    // they're non-null, so this is the ONE place that must actively forget a
    // previous result set the moment we go back to a genuine "nothing shown"
    // state (first boot, or Clear) — otherwise hasResults() would keep
    // reporting "yes" straight through a Clear.
    lastRows = [];
    lastQueryStateKey = null;
    lastLoadedState = null;
    visibleRowCount = PAGE_SIZE;
    nameExpanded = false; // a Clear rebuilds the skeleton — drop expansion
    ensureSkeleton(); // builds the toolbar + empty body, wires + syncs it
    // Empty body: no rows, and the subtle "Set your filters, then press Search"
    // hint (syncToolbar shows it whenever there are no rows). Clear the thead so
    // the empty table carries no stale headers.
    if (theadEl) theadEl.innerHTML = "";
    if (tbodyEl) tbodyEl.innerHTML = "";
    if (showMoreWrapEl) showMoreWrapEl.hidden = true;
    if (overlayEl) overlayEl.hidden = true;
    syncToolbar();
  }

  /** Called when the table view is (re-)entered — clicking the Stats tab, or
   * the graph's "Back to your table" bridge — as distinct from a filter
   * change while the table is already showing, which never reverts here at
   * all (the no-automated-search rule: onFiltersChanged just refreshes
   * pills/subtitle, and is untouched by this).
   *
   * F2 (owner: the table must persist across a bare tab switch, full stop):
   * restores the last LOADED result set whenever one exists, even if the
   * live filter state has since moved on — e.g. the Filters popup was opened
   * and edited but never Searched. This USED TO compare
   * serializeQueryState(state) against the key captured at load time
   * (decision 44d) and fall back to the blank prompt on ANY mismatch, which
   * lost the table on every bare tab switch after so much as touching a
   * control in the popup. Rendering uses lastLoadedState — the snapshot
   * taken when lastRows was produced, kept in step by every site that
   * changes what's on screen (load(), reorderColumns(), the sort-click
   * handler) — never the live store.get(), so headers/columns/matchup-mode
   * always match the shape of the rows actually on screen instead of
   * whatever the popup currently shows unsearched. A genuinely fresh
   * session, or right after Clear (renderPrompt() resets lastLoadedState to
   * null), still falls through to the blank prompt.
   */
  function enterView() {
    if (lastLoadedState !== null) {
      renderLoaded(lastRows, lastLoadedState, lastBowlingTypes);
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
    // `data-table__th--draggable` (task 2): every metric column can be
    // reordered via drag — see wireColumnDrag. The sticky Player column
    // (rendered elsewhere in renderLoaded, never through this function) never
    // gets this class; the matchup composition columns DO (they're ordinary
    // metric columns, so they drag/sort like any other).
    // `columnTitle` (task 5, R. Pos.): an optional metrics.js field for a
    // header hover title beyond the plain label — most metrics omit it.
    const titleAttr = metric.columnTitle ? ` title="${escAttr(metric.columnTitle)}"` : "";
    return `<th data-key="${metric.key}" class="data-table__th data-table__th--draggable ${isSorted ? "is-sorted" : ""}" scope="col"${titleAttr}>
      <button type="button" class="data-table__sort-btn">${metric.shortLabel}${arrow}</button>
    </th>`;
  }

  /** Sort `rows` by the store's current sort (metric column). */
  function applySort(rows, s) {
    const metric = resolveSortMetric(s.sort.key, effectiveDiscipline(s));
    return metric ? rows.slice().sort((a, b) => compareRows(a, b, metric, s.sort.dir)) : rows;
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

  /** Row-count slot text. `rows === null` means "still loading".
   * Thousands separators throughout (Batch 1 mechanical fix). */
  function rowCountLabel(rows) {
    if (rows === null) return "Loading…";
    return `${rows.length.toLocaleString()} player${rows.length === 1 ? "" : "s"}`;
  }

  // ── Column drag-to-reorder (task 2, owner decision 46) ────────────────────
  // Dragging a metric column header left/right reorders state.columns[ns] —
  // a VIEW change only: it must never trigger a requery (the column picker's
  // checked set is unchanged), so this re-renders the already-cached
  // `lastRows` in place instead of calling load(). The sticky Player column is
  // never wired (see renderLoaded's call site below — only
  // `.data-table__th--draggable` headers).

  /** Reorder `ns`'s column-key array: pull `fromKey` out and reinsert it
   * immediately before/after `overKey` (or at the end when `overKey` is
   * null — dropped past the last draggable column). Pure array surgery over the
   * column order; never changes which columns show or the query result.
   *
   * R4 Wave 4a (A1): reorder is a purely-cosmetic view change of the SAME data,
   * applied immediately (the drag would look broken otherwise) and — like the
   * Columns picker — it must NOT light Search. It updates the FROZEN snapshot's
   * columns ONLY (a shallow clone of lastLoadedState with just its `columns`
   * replaced) — never `lastLoadedState = store.get()`, which would fold every
   * OTHER pending edit into the frozen table and misdraw it — plus the pending
   * store (so a later Search persists the order), plus the APPLIED snapshot via
   * onColumnsApplied so the dirty comparison sees the new order as already
   * applied (no Search light). */
  function reorderColumns(ns, fromKey, overKey, side) {
    const base = lastLoadedState || store.get();
    const cols = (base.columns[ns] || []).slice();
    const fromIdx = cols.indexOf(fromKey);
    if (fromIdx === -1) return;
    cols.splice(fromIdx, 1);
    let toIdx;
    if (overKey == null) {
      toIdx = cols.length;
    } else {
      toIdx = cols.indexOf(overKey);
      if (toIdx === -1) toIdx = cols.length;
      else if (side === "after") toIdx += 1;
    }
    cols.splice(toIdx, 0, fromKey);
    // Advance the APPLIED snapshot FIRST (before store.set fires the toolbar
    // sync) so the Search button never flashes dirty for a reorder.
    if (onColumnsApplied) onColumnsApplied(ns, cols);
    const live = store.get();
    store.set({ columns: { ...live.columns, [ns]: cols } });
    // Frozen snapshot: reorder ONLY its columns for this ns, leaving every
    // other applied field untouched, so the displayed body reorders in place
    // and enterView() keeps showing the reordered columns after a tab switch.
    lastLoadedState = { ...lastLoadedState, columns: { ...lastLoadedState.columns, [ns]: cols } };
    lastQueryStateKey = serializeQueryState(store.get());
  }

  /** R4 Wave 4a (A1): apply a Columns-picker change INSTANTLY. Checking/
   * unchecking a column changes the DISPLAYED (frozen) table now, not at Search,
   * and must NOT light the Search button — the applied snapshot's columns
   * advance in lockstep (onColumnsApplied) so the dirty comparison reads them as
   * unchanged. This is the deliberate split from the PENDING preset dropdown,
   * which also sets state.columns but does NOT call onColumnsApplied.
   *
   * Adding a column needs data the frozen result set doesn't carry (buildQuery
   * only SELECTs the visible columns), so this requeries — but against the
   * FROZEN applied SCOPE (lastLoadedState), never the live/pending store, so an
   * un-searched pending scope edit can't leak in (rows stay frozen).
   *
   * `pickerNs` is the namespace the popover was built for (the live effective
   * discipline). It matches the frozen table's namespace in the common case (no
   * pending discipline/Vs change); when it doesn't, an instant apply to a table
   * showing a different namespace would be incoherent, so we fall back to a
   * PENDING edit (store + syncToolbar → Search lights, applied on the next
   * load). */
  function applyColumnsInstant(pickerNs, cols) {
    const base = lastLoadedState;
    const live = store.get();
    const baseNs = base ? effectiveDiscipline(base) : null;
    if (!base || pickerNs !== baseNs) {
      store.set({ columns: { ...live.columns, [pickerNs]: cols } });
      syncToolbar();
      return;
    }
    if (onColumnsApplied) onColumnsApplied(baseNs, cols);
    store.set({ columns: { ...live.columns, [baseNs]: cols } });
    // Prune to the frozen scope's eligible columns — a phase column only valid
    // under a still-pending format change can't apply to the frozen result set.
    const allowed = new Set(eligibleMetrics(baseNs, base.formats).map((m) => m.key));
    const frozenCols = cols.filter((k) => allowed.has(k));
    const frozen = { ...base, columns: { ...base.columns, [baseNs]: frozenCols } };
    load(frozen);
  }

  /** R4 Wave 4a ADDENDUM (owner ruling 2026-07-17): *picking* a player from the
   * results-toolbar search drops their row into the table INSTANTLY, unlike a
   * FILTER pill AND unlike a pin pill's ×/+ (both still PENDING — a pill's
   * soft-delete/undo only commits on Search). main.js calls this AFTER it has
   * already (a) added the player to state.pinnedPlayers on the live store and
   * (b) advanced its OWN applied snapshot's pinnedPlayers to match, so the
   * Search button's dirty comparison sees no change. This mirrors
   * applyColumnsInstant: it requeries
   * against the FROZEN applied SCOPE (lastLoadedState) with pinnedPlayers
   * swapped in — never the live/pending store's OTHER fields (dates/Vs/
   * filters/etc.), which must stay frozen until Search.
   *
   * Matchup ("Vs") mode: buildMatchupQuery has no pin OR-injection (a later
   * wave) — buildQuery already routes matchup mode there untouched, so this
   * requery naturally produces no extra row while still keeping state/pills
   * honest. No special-casing needed; do not add pin logic to the matchup
   * query here.
   *
   * If nothing has EVER been searched (lastLoadedState null — no table body
   * exists yet), there is no frozen scope to drop a row into: the pin still
   * updates the store/pill (via main.js) and simply applies on the eventual
   * first Search, same as before this addendum. */
  function applyPinnedPlayers() {
    if (!lastLoadedState) {
      syncToolbar();
      return;
    }
    const pins = store.get().pinnedPlayers || [];
    const frozen = { ...lastLoadedState, pinnedPlayers: pins };
    load(frozen);
  }

  function clearDragIndicators() {
    theadEl.querySelectorAll(".data-table__th--drop-before, .data-table__th--drop-after").forEach((el) => {
      el.classList.remove("data-table__th--drop-before", "data-table__th--drop-after");
    });
  }

  /** Wire drag-to-reorder onto one metric column header. Touch policy (task
   * 2, this session's call): MOUSE/PEN ONLY, gated on `event.pointerType` —
   * a touch pointerdown never starts a drag, so horizontal scrolling of
   * `.table-scroll` on mobile is completely untouched, with no long-press
   * escape hatch. Chosen over a long-press timer for simplicity: this table
   * already depends on native horizontal touch-scroll to be usable at
   * ~380px (§8.8), and a long-press-then-drag gesture risks fighting that
   * scroll on exactly the devices §8.8 cares about, for a feature (column
   * reordering) that has no touch-specific ask in the brief. */
  function wireColumnDrag(th, ns) {
    const key = th.dataset.key;
    let startX = null;
    let dragging = false;
    let moved = false;
    // Live preview (task 9): the last (overKey, side) pair actually APPLIED to
    // the DOM, so moveColumnDom only runs when the target genuinely changes,
    // not on every pointermove tick.
    let appliedOverKey;
    let appliedSide;

    /** Actually move `th` — and every currently-rendered row's matching
     * `<td data-key="key">` — to sit before/after the column identified by
     * `overKey`, or to the very end when `overKey` is null (dragged past the
     * last column). Real DOM moves (Element.before()/after() MOVE an
     * already-attached node, they don't clone it) rather than a CSS trick;
     * cheap enough to do on every target change because at most PAGE_SIZE
     * rows are ever rendered (task 3's pagination keeps this bounded
     * regardless of how many players the query returned). Purely a VISUAL
     * preview — the committed column order (state.columns[ns]) only changes
     * on drop, in onUp below, via reorderColumns; a full renderLoaded() after
     * a real drop rebuilds the DOM from that committed order anyway, so
     * there's nothing here that ever needs an explicit "revert". */
    function moveColumnDom(overKey, side) {
      const targetTh = overKey ? theadEl.querySelector(`.data-table__th--draggable[data-key="${overKey}"]`) : null;
      if (targetTh) {
        if (side === "after") targetTh.after(th);
        else targetTh.before(th);
      } else {
        const headerRow = theadEl.querySelector("tr");
        if (headerRow) headerRow.appendChild(th);
      }
      for (const tr of tbodyEl.querySelectorAll("tr")) {
        const draggedTd = tr.querySelector(`td[data-key="${key}"]`);
        if (!draggedTd) continue; // the sticky Player cell never carries data-key
        if (overKey) {
          const targetTd = tr.querySelector(`td[data-key="${overKey}"]`);
          if (!targetTd) continue;
          if (side === "after") targetTd.after(draggedTd);
          else targetTd.before(draggedTd);
        } else {
          tr.appendChild(draggedTd);
        }
      }
    }

    function onMove(e) {
      if (startX === null) return;
      if (!dragging && Math.abs(e.clientX - startX) > 4) {
        dragging = true;
        moved = true;
        th.classList.add("data-table__th--dragging");
      }
      if (!dragging) return;
      clearDragIndicators();
      // Drop-index (task 4 / #10 fix): the OLD logic only recognised a target
      // when the pointer was strictly INSIDE some other header's rect, and
      // fell back to overKey=null (→ moveColumnDom appends to the far right)
      // for every position that wasn't — including, critically, when the
      // pointer sat over the dragged column itself after a live-preview move
      // (that column is excluded from `others`, so nothing was "under" the
      // pointer and the column flung to the end). Replaced with a midpoint
      // scan that ALWAYS resolves to a definite, adjacent insertion point:
      // insert before the first other header whose horizontal midpoint is to
      // the right of the pointer; if none is (pointer past every midpoint),
      // insert after the last one. Because the dragged column always sits
      // between the others whose midpoints straddle the pointer, this lands
      // exactly where released and never spuriously jumps to the far right.
      const others = [...theadEl.querySelectorAll(".data-table__th--draggable")].filter((el) => el !== th);
      let insertBeforeEl = null;
      for (const el of others) {
        const rect = el.getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) {
          insertBeforeEl = el;
          break;
        }
      }
      let overKey = null;
      let effectiveSide = null;
      let indicatorEl = null;
      let indicatorSide = "before";
      if (insertBeforeEl) {
        overKey = insertBeforeEl.dataset.key;
        effectiveSide = "before";
        indicatorEl = insertBeforeEl;
        indicatorSide = "before";
      } else if (others.length) {
        const lastOther = others[others.length - 1];
        overKey = lastOther.dataset.key;
        effectiveSide = "after";
        indicatorEl = lastOther;
        indicatorSide = "after";
      }
      if (indicatorEl) {
        indicatorEl.classList.add(
          indicatorSide === "before" ? "data-table__th--drop-before" : "data-table__th--drop-after"
        );
      }
      dragState = { key, ns, overKey, side: effectiveSide };
      // Only touch the DOM when the drop target actually changed — every
      // other pointermove tick (moving within the same target's bounds) is a
      // no-op here, same as the old indicator-only version was.
      if (overKey !== appliedOverKey || effectiveSide !== appliedSide) {
        moveColumnDom(overKey, effectiveSide);
        appliedOverKey = overKey;
        appliedSide = effectiveSide;
      }
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      clearDragIndicators();
      th.classList.remove("data-table__th--dragging");
      if (dragging && dragState && dragState.key === key) {
        reorderColumns(ns, key, dragState.overKey, dragState.side);
        // Re-render the FROZEN body from lastLoadedState (whose columns
        // reorderColumns just updated) — never store.get(), which carries other
        // pending edits that must not reach the displayed table until Search.
        renderLoaded(lastRows, lastLoadedState ?? store.get(), lastBowlingTypes);
      }
      dragState = null;
      startX = null;
      appliedOverKey = undefined;
      appliedSide = undefined;
      if (moved) {
        // Swallow the click the browser fires right after this pointerup so
        // a real drag never ALSO re-sorts by this column — capturing means
        // this runs before the plain (bubbling) click-to-sort listener bound
        // on the same `th` below.
        const suppressClick = (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          th.removeEventListener("click", suppressClick, true);
        };
        th.addEventListener("click", suppressClick, true);
      }
      dragging = false;
      moved = false;
    }

    th.addEventListener("pointerdown", (e) => {
      // Mouse/pen only (see doc comment above) — a touch pointerdown just
      // falls through to native scrolling.
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      if (e.button !== 0) return;
      startX = e.clientX;
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
  }

  const setNeedsInput = (el, on) => { if (el) el.classList.toggle("needs-input", !!on); };

  /** (Re)build the preset <select>'s option list for a discipline (batting and
   * bowling have different preset vocabularies). A hidden, disabled "Custom"
   * option is included so syncToolbar can display "Custom" whenever the current
   * columns match no preset (or in matchup mode) — a native select must show
   * one of its own options. */
  function buildPresetOptions(discipline) {
    const opts = [`<option value="__custom" hidden disabled>Custom</option>`];
    for (const def of COLUMN_PRESET_DEFS[discipline]) {
      opts.push(`<option value="${def.key}">${escHtml(def.label)}</option>`);
    }
    presetSelectEl.innerHTML = opts.join("");
    presetOptionsDiscipline = discipline;
  }

  /**
   * Keep the single-row toolbar's stable controls in step with state (R3.2).
   * Called from the store-change hook (main.js) on EVERY pending edit and from
   * renderLoaded after a Search resolves — never rebuilds the toolbar DOM, only
   * updates values / enabled / dirty / count in place.
   *
   * The controls (dates, preset, Vs, columns btn, search box) reflect the LIVE
   * (pending) store; the count + honesty note describe the APPLIED (frozen)
   * table; the Search button lights dirty when pending ≠ applied AND the
   * pending state is searchable (both dates set). First-load gating: until a
   * Search has produced results, the preset / Vs / Columns / count are greyed —
   * only Filters, the search box, and the dates are active.
   */
  function syncToolbar() {
    if (!toolbarEl) return;
    const live = store.get();
    const applied = getAppliedState ? getAppliedState() || live : live;
    const results = hasResults();
    const matchupOn = matchupVsActive(live);
    const discipline = live.discipline;

    // Count — from the DISPLAYED (applied) rows; greyed until a search has run.
    if (countEl) {
      countEl.textContent = results ? rowCountLabel(lastRows) : "";
      countEl.classList.toggle("is-disabled", !results);
    }

    // Dates (pending) — mirror the store; needs-input red outline when a player
    // is picked (pin/search) but a date is still missing.
    const playerPicked = (live.pinnedPlayers || []).length > 0 || Boolean(live.search && live.search.trim());
    if (dateFromEl) {
      dateFromEl.value = live.dateFrom || "";
      setNeedsInput(dateFromEl, playerPicked && !live.dateFrom);
    }
    if (dateToEl) {
      dateToEl.value = live.dateTo || "";
      setNeedsInput(dateToEl, playerPicked && !live.dateTo);
    }

    // Preset dropdown (pending) — options per-discipline; Phases disabled when
    // the format selection doesn't permit it; whole control greyed in matchup
    // mode (presets don't apply there) or before the first search.
    if (presetSelectEl) {
      if (presetOptionsDiscipline !== discipline) buildPresetOptions(discipline);
      for (const opt of presetSelectEl.options) {
        if (opt.value === "__custom") continue;
        const def = COLUMN_PRESET_DEFS[discipline].find((d) => d.key === opt.value);
        opt.disabled = def ? def.columns(live.formats) === null : true;
      }
      const key = matchupOn ? null : activePresetKey(discipline, live.formats, live.columns[discipline]);
      presetSelectEl.value = key || "__custom";
      presetSelectEl.disabled = !results || matchupOn;
      presetSelectEl.title = matchupOn ? "Presets don't apply in matchup (Vs) mode — use Columns" : "";
    }

    // Bonded Vs (pending) — Men's view only (matchupVsActive hard-gates on male
    // regardless; the control is simply absent for women, per decision 21).
    if (vsWrapEl && vsSelectEl) {
      if (live.gender === "female") {
        vsWrapEl.hidden = true;
      } else {
        vsWrapEl.hidden = false;
        vsSelectEl.innerHTML = matchupVsOptionsHTML(live, lastBowlingTypes);
        vsSelectEl.disabled = !results;
      }
    }

    if (columnsBtnEl) columnsBtnEl.disabled = !results;

    // Search button — dirty iff pending ≠ applied; enabled iff dirty AND
    // searchable (both dates present). Mirrors the graph's Update-chart button:
    // accent-filled + enabled when there's something to apply, muted+disabled
    // when the displayed table is already up to date.
    if (searchBtnEl) {
      const dirty = serializeQueryState(live) !== serializeQueryState(applied);
      const searchable = Boolean(live.dateFrom && live.dateTo);
      const active = dirty && searchable;
      searchBtnEl.disabled = !active;
      searchBtnEl.classList.toggle("is-dirty", active);
    }

    // Honesty note — describes the DISPLAYED (applied) table: matchup mode +
    // any partial stat-condition applicability (§8.4). Hidden before a search.
    if (noteEl) {
      let noteText = "";
      if (results) {
        const appliedNs = effectiveDiscipline(applied);
        const { total, applied: appliedCount } = conditionApplicability(applied.advanced, appliedNs);
        const condNote = total > 0 && appliedCount < total ? `${appliedCount} of ${total} stat conditions apply here` : "";
        const matchupApplied = matchupVsActive(applied);
        noteText = matchupApplied ? (condNote ? `Matchup mode, ${condNote}` : "Matchup mode") : condNote;
      }
      noteEl.textContent = noteText;
      noteEl.hidden = !noteText;
    }

    // Body hint (empty-state guidance inside the table area).
    if (bodyHintEl) {
      if (!results) {
        bodyHintEl.textContent = "Set your filters, then press Search.";
        bodyHintEl.hidden = false;
      } else if (lastRows.length === 0) {
        bodyHintEl.textContent = "No players match these filters.";
        bodyHintEl.hidden = false;
      } else {
        bodyHintEl.hidden = true;
      }
    }
  }

  /** Mid-query state: the toolbar stays mounted and fully interactive-looking
   * (only its row-count slot reads "Loading…"); the table area shows the
   * existing "Running query…" overlay ON TOP of whatever was already painted
   * in table-scroll (task 6 fix — see .table-body-wrap in styles.css). The
   * PREVIOUS query's rows/thead stay in the DOM, unhidden, underneath the
   * overlay for the duration of the reload: `.table-scroll` never used to be
   * hidden here (Batch 1 mechanical fix's own comment above used to say so —
   * corrected), which is exactly what caused task 6's preset-button page-jump:
   * hiding a tall `.table-scroll` collapsed the container's height to just the
   * overlay's, and restoring it after load() shifted the viewport. Keeping the
   * old table visible (dimmed by the overlay's own backdrop) keeps the height
   * — and the scroll position — stable across the whole reload. */
  function renderLoadingState(state, bowlingTypes = lastBowlingTypes) {
    ensureSkeleton();
    overlayEl.hidden = false;
    // The toolbar controls stay exactly as they are (pending values); only the
    // row-count slot reads "Loading…" for the duration of the query. A full
    // syncToolbar() would still be correct, but a targeted count update avoids
    // any flicker on the other controls mid-query.
    if (countEl) countEl.textContent = "Loading…";
    if (bodyHintEl) bodyHintEl.hidden = true;
  }

  /** Set `--sticky-col-w` (styles.css) from the widest name in `names`, once
   * per render — see the module-level "Dynamic sticky Player column width"
   * comment above widestNameColWidthPx. Set on `.table-scroll` (an ancestor
   * of every th/td in this table), clamped to
   * [STICKY_COL_MIN_PX, STICKY_COL_MAX_PX]. */
  function updateStickyColWidth(names) {
    const measured = names.length ? widestNameColWidthPx(names) : 0;
    const clamped = Math.min(Math.max(measured, STICKY_COL_MIN_PX), STICKY_COL_MAX_PX);
    scrollEl.style.setProperty("--sticky-col-w", `${Math.ceil(clamped)}px`);
  }

  /** Loaded state: fills in the table head/body and the toolbar's final row
   * count, then rebinds the table's own listeners (sort, player links).
   * `rows` must already be the split/matchup-aware, sorted rows for `state`.
   *
   * Pagination (task 3, R3 Wave 5 polish): only the first `visibleRowCount`
   * rows are actually painted into tbody — `rows` itself stays the FULL
   * result set throughout (renderToolbar's row-count slot, and the Show More
   * button's remaining-count label, both read `rows.length`, the TOTAL,
   * exactly as the task requires; only tbody's own contents are sliced). */
  function renderLoaded(rows, state, bowlingTypes = lastBowlingTypes) {
    ensureSkeleton();
    overlayEl.hidden = true;
    // (task 7) Re-apply the mobile name-expansion class on every render — the
    // thead/tbody are rebuilt here, but scrollEl (which carries the class)
    // persists, so keep it honestly in step with the closure flag.
    scrollEl.classList.toggle("is-name-expanded", nameExpanded);

    const ns = effectiveDiscipline(state);
    const colKeys = state.columns[ns];
    const cols = colKeys.map((key) => getMetric(key, ns)).filter(Boolean);

    // Coverage-breakdown wave: the old fixed "Coverage" column is gone —
    // matchup rows now carry the per-group composition %s (comp_*) as ordinary
    // columns within `cols` (default far-right, in the restricted picker), so
    // there is no special-cased header/cell here any more.

    // Rank column (task 1): a display-only countdown index, sticky at the very
    // left (before Player). Its header is a plain "#" — rank is not a sortable
    // column, it always reflects whatever the table is currently sorted by.
    const rankTh = `<th class="data-table__th data-table__th--rank" scope="col" title="Rank in current sort">#</th>`;

    // Player header (task 6): now a sortable column — clicking sorts by name
    // A–Z, then Z–A, with the same caret the metric headers show. Stays sticky
    // and is deliberately NOT draggable (no --draggable class). The sort +
    // mobile double-click-to-expand (task 7) listeners are wired below.
    const nameSorted = state.sort.key === "name";
    const nameArrow = nameSorted ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "";
    const playerTh = `<th data-key="name" class="data-table__th data-table__th--sticky ${nameSorted ? "is-sorted" : ""}" scope="col">
        <button type="button" class="data-table__sort-btn">Player${nameArrow}</button>
      </th>`;

    theadEl.innerHTML = `
      <tr>
        ${rankTh}
        ${playerTh}
        ${cols.map((m) => headerCellHTML(m, state)).join("")}
      </tr>`;

    const pageRows = rows.slice(0, visibleRowCount);
    updateStickyColWidth(pageRows.map((r) => r.name ?? ""));

    tbodyEl.innerHTML = pageRows
      .map((row, i) => {
        // Rank (task 1): the row's position in the CURRENT sorted result set.
        // `i` is the index within pageRows, which is always a prefix of the
        // full sorted `rows`, so numbers run 1, 2, 3 … and continue unbroken
        // across a "Show More" reveal (51, 52, …) — no query, pure display.
        const rankTd = `<td class="data-table__td data-table__td--rank">${(i + 1).toLocaleString()}</td>`;
        const cells = cols.map((m) => dataCellHTML(m, row)).join("");
        // Player names link to the player page (R2, decision 29). The full
        // name is now always the rendered text (task 4 replaced JS
        // pre-truncation with a dynamically-sized column — see
        // widestNameColWidthPx's doc comment); `title` still carries it too,
        // for the rare case a name still overflows (very long outlier name,
        // or the ≤640px mobile tier, task 8) and CSS ellipsis takes over.
        const fullName = row.name ?? "";
        const nameCell = onPlayerClick
          ? `<button type="button" class="player-link" data-player-id="${escAttr(row.id ?? "")}" title="${escAttr(fullName)}">${escHtml(fullName)}</button>`
          : `<span title="${escAttr(fullName)}">${escHtml(fullName)}</span>`;
        return `<tr>${rankTd}<td class="data-table__td data-table__td--sticky">${nameCell}</td>${cells}</tr>`;
      })
      .join("");

    // Show More (task 3): reveals the rest in one click, not another page.
    if (showMoreWrapEl && showMoreBtnEl) {
      const remaining = rows.length - pageRows.length;
      showMoreWrapEl.hidden = remaining <= 0;
      if (remaining > 0) {
        showMoreBtnEl.textContent = `Show More (${remaining.toLocaleString()} player${remaining === 1 ? "" : "s"})`;
      }
    }

    syncToolbar();

    /** R4 Wave 4a (A1): clicking a column header re-sorts the already-loaded
     * rows INSTANTLY — the header arrow moves and the body re-orders NOW, not at
     * Search. Sorting is "how the loaded rows are displayed," not "which rows,"
     * so it's a pure client-side re-sort (no requery — every sortable column's
     * values are already in lastRows) and it must NOT light the Search button
     * (`sort` is excluded from serializeQueryState). The new key/dir is still
     * persisted to the store so a later Search / the graph seed keep it. The
     * frozen SCOPE is untouched: lastLoadedState only has its `sort` replaced,
     * never `= store.get()` (which would fold in un-searched pending edits).
     * Shared by the metric-header clicks and the Player-header sort. */
    function applySortKey(key) {
      const cur = store.get().sort;
      const frozen = lastLoadedState || store.get();
      let sort;
      if (cur.key === key) {
        sort = { key, dir: cur.dir === "asc" ? "desc" : "asc" };
      } else {
        const metric = resolveSortMetric(key, effectiveDiscipline(frozen));
        sort = { key, dir: metric && metric.higherIsBetter === false ? "asc" : "desc" };
      }
      store.set({ sort }); // pending store (excluded from dirty → no Search light)
      if (lastLoadedState) {
        lastLoadedState = { ...lastLoadedState, sort };
        lastQueryStateKey = serializeQueryState(lastLoadedState);
        lastRows = applySort(lastRows, lastLoadedState);
        visibleRowCount = PAGE_SIZE; // a new sort order is "a new view" — page 1
        renderLoaded(lastRows, lastLoadedState, lastBowlingTypes);
      } else {
        syncToolbar();
      }
    }

    // Sorting: click header to set the PENDING sort (applied on Search). The
    // sort-state class (is-sorted / arrow) reflects the FROZEN `state` and is
    // recomputed on every renderLoaded, so it stays on the applied sort until
    // the next Search. The sticky Player header is EXCLUDED here (task 6/7) —
    // it needs its own single-click-sort vs double-click-expand handling.
    theadEl.querySelectorAll(".data-table__th[data-key]:not(.data-table__th--sticky)").forEach((th) => {
      th.addEventListener("click", () => applySortKey(th.dataset.key));
    });

    // Player header (tasks 6 + 7 / #13 + #11): single click sorts by name;
    // on mobile widths a double-click instead toggles the name column's
    // expansion (full names vs the narrow truncated column). The two are
    // disambiguated by a short debounce: on ≤640px the sort is deferred ~250ms
    // so a second click within that window can cancel it and expand instead;
    // on wider viewports (mouse) the sort fires immediately with no delay, and
    // double-click-to-expand is simply not offered (the column is already
    // dynamically full-width there). Single click always = sort (#6);
    // double-click = expand (#11), never a double sort.
    const nameTh = theadEl.querySelector('.data-table__th--sticky[data-key="name"]');
    if (nameTh) {
      let nameClickTimer = null;
      nameTh.addEventListener("click", () => {
        const mobile = window.matchMedia("(max-width: 640px)").matches;
        if (!mobile) {
          applySortKey("name");
          return;
        }
        if (nameClickTimer) {
          clearTimeout(nameClickTimer);
          nameClickTimer = null;
        }
        nameClickTimer = setTimeout(() => {
          nameClickTimer = null;
          applySortKey("name");
        }, 250);
      });
      nameTh.addEventListener("dblclick", () => {
        // Expand is a mobile-only affordance (the column is already full-width
        // on wider viewports); guarding here also prevents a desktop
        // double-click from leaving stray expansion state that would surface
        // if the window were later narrowed.
        if (!window.matchMedia("(max-width: 640px)").matches) return;
        if (nameClickTimer) {
          clearTimeout(nameClickTimer);
          nameClickTimer = null;
        }
        toggleNameExpand();
      });
    }

    if (onPlayerClick) {
      tbodyEl.querySelectorAll(".player-link").forEach((btn) => {
        btn.addEventListener("click", () => {
          onPlayerClick(btn.dataset.playerId, btn.textContent);
        });
      });
    }

    // Column drag-to-reorder (task 2): every metric header (never the
    // sticky Player column — it doesn't get the --draggable class) can be
    // dragged left/right to reorder state.columns[ns]. Rebound on every
    // renderLoaded call, same as the sort click handler just above.
    theadEl.querySelectorAll(".data-table__th--draggable").forEach((th) => {
      wireColumnDrag(th, ns);
    });
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
        // R4 Wave 4a (A1): INSTANT column change — apply to the frozen table
        // now (re-rendering / requerying the same rows) without lighting Search.
        // The checkbox already reflects the pick; the popover (on document.body)
        // survives the requery via refreshOpenColumnsPopover().
        applyColumnsInstant(curNs, cols);
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
        applyColumnsInstant(curNs, cols); // A1: INSTANT, no Search light
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
        applyColumnsInstant(curNs, cols); // A1: INSTANT, no Search light
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

  async function load(scopeState = null) {
    let state;
    if (scopeState) {
      // R4 Wave 4a (A1): the INSTANT Columns picker requeries against the FROZEN
      // applied scope (this argument) rather than the live/pending store, so an
      // un-searched pending filter/date/Vs edit can never leak in and change
      // which rows show (rows stay frozen until Search). The live-store
      // sort-fallback + column prune below belong to the Search path only — they
      // read/mutate the pending store, which this path must not touch.
      state = scopeState;
    } else {
      // Sort-key fallback across mode/namespace transitions (batting/bowling <->
      // matchup_batting/matchup_bowling): the column sets differ (e.g.
      // "balls_faced" vs "balls"; "dismissals" is matchup-only), so a sort key
      // that no longer resolves in the *effective* namespace must not silently
      // sort nothing. Falls back to runs/wickets desc, same defaults main.js
      // uses on a plain discipline switch.
      const preState = store.get();
      if (!resolveSortMetric(preState.sort.key, effectiveDiscipline(preState))) {
        store.set({ sort: { key: preState.discipline === "batting" ? "runs" : "wickets", dir: "desc" } });
      }

      // Restricted picker (D4 R3 follow-up): the matchup namespaces get the same
      // phase-eligibility prune as the plain picker, so this runs unconditionally
      // regardless of mode.
      pruneInvalidColumns();
      state = store.get();
    }
    const ns = effectiveDiscipline(state);
    const cols = state.columns[ns];
    const { sql, matchesSql } = buildQuery(state, cols);
    const token = ++loadToken;
    renderLoadingState(state);
    try {
      const [{ rows }, matchesResult, bowlingTypes] = await Promise.all([
        query(sql),
        matchesSql ? query(matchesSql) : Promise.resolve({ rows: [] }),
        bowlingTypesCache ? Promise.resolve(bowlingTypesCache) : ensureBowlingTypes(),
      ]);
      if (token !== loadToken) return; // a newer load superseded this one
      lastBowlingTypes = bowlingTypes;

      let merged = rows;
      if (matchesSql) {
        const byId = new Map(matchesResult.rows.map((r) => [r.id, r.matches]));
        merged = rows.map((r) => ({ ...r, matches: byId.get(r.id) ?? null }));
      }
      // Coverage-breakdown wave: the fixed "Coverage" column is gone, so its
      // former per-row `coverage` object is no longer built here. The coverage
      // TOTALS (__coverage_total / __coverage_mapped) are still computed inside
      // buildMatchupQuery — __coverage_total is the denominator for the new
      // composition % columns (comp_*), which arrive already-computed on each
      // row like any other column.

      const sorted = applySort(merged, state);

      lastRows = sorted;
      lastQueryStateKey = serializeQueryState(state);
      lastLoadedState = state; // F2: enterView() renders against this snapshot
      // Task 3: every fresh query (a search, a preset, a column/Vs change) is
      // "a new view of the data" — back to page 1, same as a re-sort.
      visibleRowCount = PAGE_SIZE;
      renderLoaded(sorted, state, bowlingTypes);
      // The columns popover (if open) lives outside `container` precisely so
      // this reload never destroys it (Batch 3 fix 3) — re-find its anchor in
      // the freshly-rendered toolbar, reposition, and re-sync checked state.
      refreshOpenColumnsPopover();
      // Pinned players with zero rows in this result set (task 3b): only
      // meaningful in plain mode — matchup mode never applies the pin bypass
      // (buildMatchupQuery is untouched), so every id would spuriously read
      // "missing" there. main.js's pinPlayer() uses this to roll back an
      // optimistic pin that turned out to have no innings in the core scope
      // at all (no bypass could have produced a row for it either).
      const missingPinnedIds = matchupVsActive(state)
        ? []
        : (state.pinnedPlayers || [])
            .filter((p) => p && p.id && !sorted.some((r) => String(r.id) === String(p.id)))
            .map((p) => p.id);
      // Resolved row count (B2R wave 3): the omnisearch "Filter the table"
      // toast (main.js's triggerTableSearch) needs to know whether the query
      // it just triggered came back empty, without table.js exposing any
      // other internal state. Every existing caller of load() (toolbar
      // controls, the columns popover, the prompt/drawer buttons) already
      // ignores the resolved value, so this shape (an object rather than the
      // former bare number) is purely additive for them too.
      return { rowCount: sorted.length, missingPinnedIds };
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
  // regardless of whether the scope has since moved on. False again after
  // Clear (F2: renderPrompt() resets lastQueryStateKey to null there) — the
  // owner's "Clear empties everything" applies to this too, otherwise Graphs
  // would silently seed itself from the just-reset default scope instead of
  // honestly saying "run a search on Stats first." This is what lets the
  // Graphs view decide between that empty-state and seeding its player pool
  // from the current filtered set — see graph.js's onShow()/seedSelection()
  // and main.js's mountGraph() wiring.
  function hasResults() {
    return lastQueryStateKey !== null;
  }

  /** Stash the manifest date bounds ("YYYY-MM-DD") for the toolbar date inputs
   * and apply them to the current inputs (a skeleton rebuild re-applies via
   * ensureSkeleton). Mirrors filters.js's own setDateBounds for the popup
   * inputs — both sets bind the same state.dateFrom/dateTo. */
  function setDateBounds(minD, maxD) {
    dateBounds = { min: minD || null, max: maxD || null };
    applyDateBounds();
    syncToolbar();
  }

  return { load, showPrompt: renderPrompt, enterView, hasResults, syncToolbar, setDateBounds, applyPinnedPlayers };
}
