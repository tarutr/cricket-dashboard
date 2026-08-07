// src/table.js
//
// Query builder + table renderer for Compare Stats (SPEC §5.3/§5.4). Builds ONE
// grouped query per the metrics.js contract, plus a separate player_matches
// query when the "matches" column is visible, joined in JS by player_id.
//
// hasMetricData (§8.1) is the ONLY no-data predicate — used both to gate
// advanced-filter conditions on rate/ratio metrics and to render "—" for
// no-data cells (NULL already renders "—"; this module never coalesces ratios).

import { getMetric, hasMetricData, matchupBucketLabel, paramSqlExpression } from "./metrics.js";
import { query } from "./db.js";
import {
  buildScopeClausesTagged,
  buildCoreScopeClauses,
  bypassableClause,
  whereWithPinExemption,
  gateWithPinExemption,
  buildMatchContextClauses,
  matchContextJoinSql,
  matchContextSubselectSql,
} from "./filters.js";
import { activeGroups } from "./advanced.js";
import { escHtml, escAttr } from "./html.js";
import { createColumnsPicker } from "./columnsPicker.js";
import {
  eligibleMetrics,
  positionsFilterActive,
  oppositionFilterActive,
  inningsNumberFilterActive,
  matchContextActive,
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
    // eventSeasons narrows the event clause (Event → Season picker), so it belongs
    // in this key exactly as `event` does — without it, changing a season left the
    // Search button unlit and the render cache stale (defect found in this pass).
    eventSeasons: state.eventSeasons,
    venue: state.venue,
    // Match-context filters (Wave 6): part of the query result + honest-scope
    // key, so a change re-lights Search and busts the render cache.
    result: state.result,
    tossResult: state.tossResult,
    tossDecision: state.tossDecision,
    inningsOrder: state.inningsOrder,
    // Innings Number (filter-rejig Wave R2c): a scope filter on the batting/bowling
    // innings views — a change re-lights Search + busts the render cache, exactly
    // like the other scope filters. buildScopeClauses reads it directly.
    inningsNumber: state.inningsNumber,
    stage: state.stage,
    resultCondition: state.resultCondition,
    matchupVs: state.matchupVs,
    // Delivery window (Wave 3): a numbers-defining filter (the ball-engine window) —
    // a change must re-light Search + bust the render cache, exactly like matchupVs.
    // This is change-detection only; buildQuery/buildScopeClauses are untouched.
    deliveryWindow: state.deliveryWindow,
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

export function orderBowlingTypes(values) {
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
  const metrics = allMetrics.filter((m) => m.kind !== "composition" && m.kind !== "peak");
  const compMetrics = allMetrics.filter((m) => m.kind === "composition");
  // Peak metrics (decision 47c): High Score (matchup_batting) / Best Bowling
  // (matchup_bowling) are per-INNINGS peaks. Step 1's GROUP BY (id, name) has
  // already collapsed innings, so — like composition columns — they must NOT
  // flow through the per-bucket FILTER path the regular metrics take below.
  // They're computed from a per-(id, match, innings) pre-aggregation
  // (bucket-FILTER'd via WHERE) reduced to one value per player, LEFT JOINed on
  // id (see the peak CTE further down). Their sqlExpression is a placeholder,
  // never interpolated. At most one per discipline today, but handled
  // generically off each metric's peakInner/peakOuter/peakOuterSort recipe.
  const peakMetrics = allMetrics.filter((m) => m.kind === "peak");

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
      if (!m) continue; // not applicable in this namespace — advancedToHaving drops it (returns null)
      // Peak conditions (Wave A2: High Score / Best Bowling) are NOT step-1
      // aggregates — their placeholder sqlExpression ("__PEAK__") must never
      // enter the `agg` SELECT. They are materialized in the peak CTE and
      // referenced as `peak.<col>` in the final WHERE (peakCondMetrics below).
      if (m.source === "matchup" && m.kind === "peak") continue;
      let alias = aliasByKey.get(m.key);
      if (!alias) {
        alias = `__cond_${condIdx++}`;
        aliasByKey.set(m.key, alias);
        extraAggColumns.push({ metric: m, alias });
      }
      condAliasMap.set(c, alias);
    }
  }

  // Peak metrics needed ONLY as a stat condition (Wave A2): a High Score / Best
  // Bowling condition can be active without that column being visible, so the
  // peak CTE must still materialize its value to filter on. Union'd with the
  // displayed peak metrics below (deduped by key); peakSelectParts stays limited
  // to DISPLAYED peaks so a condition-only peak adds NO output column (rows with
  // no peak condition remain byte-identical).
  const peakKeysSeen = new Set(peakMetrics.map((m) => m.key));
  const peakCondMetrics = [];
  for (const g of activeGroups(state.advanced)) {
    for (const c of g.conds) {
      const m = getMetric(c.metricKey, ns);
      if (m && m.source === "matchup" && m.kind === "peak" && !peakKeysSeen.has(m.key)) {
        peakKeysSeen.add(m.key);
        peakCondMetrics.push(m);
      }
    }
  }
  const peakCteMetrics = [...peakMetrics, ...peakCondMetrics];

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
  // Clauses are TAGGED for the pin exemption (filters.js): the builder tags its
  // own three player-shortlisting filters (team/profile/R. Pos.), and the name
  // search is tagged here.
  const whereClauses = buildScopeClausesTagged(state, scopeOpts);
  if (searchClause) whereClauses.push(bypassableClause(searchClause));

  // Match-context filters (Wave 6): identical treatment to plain buildQuery —
  // append the context clauses (comparing the matchup row's own team, teamCol =
  // batting_team | bowling_team, to the joined match fields), and LEFT JOIN
  // `matches` on the view below (both the `agg` scan and the peak CTE's scan).
  // Pushed UNTAGGED = always-applies, so a pin is measured over the same matches
  // as every other row. No context filter => byte-identical.
  const wantsMatchContext = matchContextActive(state);
  if (wantsMatchContext) {
    for (const c of buildMatchContextClauses(state, teamCol)) whereClauses.push(c);
  }
  // The FROM used by both `agg` and the peak CTE: base view + optional mctx join.
  const matchupFrom = wantsMatchContext ? view + matchContextJoinSql(view) : view;

  // Pinned players (Wave 4b, decision 47a): additive — a pinned player is scanned
  // as long as they have a row that passes every ALWAYS-APPLIES clause above
  // (core scope + opposition + striker position + event/venue + match context),
  // bypassing only the player-shortlisting ones (team/profile/R. Pos./search),
  // exactly as buildQuery
  // does. The bucket predicate is NOT in this WHERE (it is a per-aggregate FILTER),
  // so pins keep it automatically. With no pins this is byte-identical to the
  // former `whereClauses.join(" AND ")`.
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const whereSql = whereWithPinExemption(whereClauses, idCol, pins);

  const aggSql = [
    `SELECT ${aggSelectParts.join(", ")}`,
    `FROM ${matchupFrom}`,
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
  // exprFn resolves each condition's LHS. Non-peak conditions reuse their
  // step-1 alias (a `windowed` column). Peak conditions (Wave A2) reference the
  // joined peak CTE instead: Best Bowling filters on the numeric rank column
  // `peak.best__sort`; High Score on `peak.high_score` (the same values shown in
  // those Vs columns). conditionToHaving assembles the actual comparison.
  const advWhere = advancedToHaving(state.advanced, ns, (cond, metric) => {
    if (metric && metric.source === "matchup" && metric.kind === "peak") {
      return metric.conditionInput === "bowlingFigures" ? `peak.${metric.key}__sort` : `peak.${metric.key}`;
    }
    return condAliasMap.get(cond);
  });
  if (advWhere) finalWhereParts.push(advWhere);
  // Pinned players (Wave 4b, decision 47a): exempt from the step-3 gate too, so a
  // pinned player still shows even with 0 innings vs the bucket (the existence
  // gate fails) or failing a stat condition — their row simply reads 0/blank vs
  // the bucket (the "(no innings)" annotation is a later wave). This runs over
  // `windowed`, where the id column is projected as `id` (NOT idCol), so the
  // exemption references `id`. With no pins this is byte-identical to the former
  // `finalWhereParts.join(" AND ")`.
  const finalWhereSql = gateWithPinExemption(finalWhereParts.join(" AND "), "id", pins);

  // Peak CTE (decision 47c; Wave A2): emitted when a peak (High Score / Best
  // Bowling) is DISPLAYED or filtered on. With neither, `peakCteSql` stays null
  // and the final query below is BYTE-IDENTICAL to the pre-47c matchup query.
  // The pre-aggregation groups by (id, match, innings) with the bucket in WHERE
  // (the proven live method: WITH per_innings ... GROUP BY match, innings),
  // reusing the SAME scope/search/pin WHERE (`whereSql`) as `agg` so pins keep
  // their exemption and the bucket is applied consistently. It is a second scan
  // of `view` (a different GROUP BY grain than `agg`, so it can't share the one
  // scan), which is exactly why peaks need their own CTE. Any peak metrics for a
  // single discipline share ONE inner pre-aggregation (their inner columns just
  // concatenate). A missing player (no bucket innings — only pins, via the
  // step-3 exemption) LEFT-JOINs to NULL and renders "—".
  // Wave A2: the CTE materializes peakCteMetrics (displayed ∪ condition-only),
  // so a condition-only peak still yields `peak.<col>` for the final WHERE — but
  // peakSelectParts (the DISPLAY columns appended to the final SELECT) covers
  // ONLY the displayed `peakMetrics`, so a condition-only peak adds no output
  // column and rows without a peak condition stay byte-identical.
  let peakCteSql = null;
  const peakSelectParts = [];
  if (peakCteMetrics.length) {
    const peakWhere = `(${whereSql}) AND (${bucketClause})`;
    const innerParts = [];
    const outerParts = [];
    for (const m of peakCteMetrics) {
      innerParts.push(m.peakInner);
      outerParts.push(`${m.peakOuter} AS ${m.key}`);
      if (m.peakOuterSort) {
        outerParts.push(`${m.peakOuterSort} AS ${m.key}__sort`);
      }
    }
    for (const m of peakMetrics) {
      peakSelectParts.push(`peak.${m.key} AS ${m.key}`);
      if (m.peakOuterSort) {
        peakSelectParts.push(`peak.${m.key}__sort AS ${m.key}__sort`);
      }
    }
    peakCteSql = [
      `peak AS (`,
      `SELECT ${idCol} AS peak_id, ${outerParts.join(", ")}`,
      `FROM (`,
      `SELECT ${idCol}, ${innerParts.join(", ")}`,
      `FROM ${matchupFrom}`,
      `WHERE ${peakWhere}`,
      `GROUP BY ${idCol}, match_id, innings_number`,
      `) t`,
      `GROUP BY ${idCol}`,
      `)`,
    ].join("\n");
  }

  const sql = [
    `WITH agg AS (`,
    aggSql,
    `),`,
    `windowed AS (`,
    windowedSql,
    peakCteSql ? `),\n${peakCteSql}` : `)`,
    `SELECT ${[...finalSelectParts, ...peakSelectParts].join(", ")}`,
    peakCteSql ? `FROM windowed LEFT JOIN peak ON windowed.id = peak.peak_id` : `FROM windowed`,
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
  // degradation an out-of-namespace condition already gets (returns null, so
  // advancedToHaving simply drops it).
  if (metric.kind === "position") return null;
  // Composition columns (Coverage-breakdown wave) are descriptive display-only
  // percentages with a placeholder sqlExpression (see metrics.js) — never a
  // usable stat condition. advanced.js already excludes them from the picker;
  // this guard is the same belt-and-braces defence r_pos gets just above, so a
  // stray composition-keyed condition can never reach SQL.
  if (metric.kind === "composition") return null;
  // Best Bowling TWO-box condition (Wave A2 item 2, conditionInput
  // "bowlingFigures"): "≥ W wickets for ≤ R runs" compiles to ONE numeric
  // comparison against the metric's PEAK RANK — wickets*1000 - runs (more
  // wickets always ranks above fewer; fewer runs breaks ties) — NOT its "W-R"
  // display string. LHS rank:
  //   plain best  → metric.sortExpression   (MAX(wickets*1000 - runs_conceded))
  //   matchup best→ exprFn returns peak.best__sort (MAX(__pk_w*1000 - __pk_r))
  // RHS = W*1000 - R. Comparison is implicit >= (the drawer suppresses the
  // operator select), so operator/v-guard handling below is bypassed.
  if (metric.conditionInput === "bowlingFigures") {
    const rankExpr = exprFn ? exprFn(cond, metric) : metric.sortExpression;
    if (!rankExpr) return null;
    const w = parseInt(cond.v1, 10);
    const r = parseInt(cond.v2, 10);
    if (!Number.isFinite(w) || !Number.isFinite(r)) return null;
    return `((${rankExpr}) >= ${w * 1000 - r})`;
  }
  // Matchup peaks that ARE simple single-box numerics (Wave A2 item 3: High
  // Score = MAX per-innings runs vs the bucket) fall through to the generic
  // path below; in matchup mode exprFn resolves them to the joined peak CTE
  // column `peak.<key>` (materialized in buildMatchupQuery). Plain peaks
  // (source "innings") evaluate their real sqlExpression directly, unchanged.
  //
  // Parametrised threshold metrics (R2b Phase 2: Innings Score ≥ N / Wicket Hauls
  // ≥ N) carry a `paramTemplate`; the plain (non-matchup) path compiles the
  // aggregate at the user's per-condition threshold via paramSqlExpression(metric,
  // cond.n). ADDITIVE: paramSqlExpression returns the metric's DEFAULT sqlExpression
  // whenever cond.n is absent/invalid, so a condition without an N is byte-identical
  // to before. (These metrics live in the plain batting/bowling namespaces only, so
  // the matchup exprFn branch never sees them.)
  const expr = exprFn
    ? exprFn(cond, metric)
    : metric.paramTemplate
      ? paramSqlExpression(metric, cond.n)
      : metric.sqlExpression;
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

/** True if any ACTIVE advanced condition targets a metric matching `pred`.
 * Fielding/Impact metrics only exist in the query through their LEFT-JOINed CTE
 * (`fielding_cte` / `pom_cte`), and their sqlExpression is MAX(<cte>.<col>) — so
 * buildQuery must add that join whenever a condition references one, even with
 * no fielding COLUMN visible, or the emitted HAVING would reference an unjoined
 * CTE and the query would fail. */
function advancedReferencesMetric(advanced, discipline, pred) {
  return activeGroups(advanced).some((g) =>
    g.conds.some((c) => {
      const m = getMetric(c.metricKey, discipline);
      return m && pred(m);
    })
  );
}
/** Metrics sourced from the event-grain `fielding` view (catches/stumpings/
 * run_outs/dismissals_effected) — surfaced via the `fielding_cte` join.
 * Exported so the Graph Builder's per-player fetch (graph/charts.js) detects
 * the need for the fielding join with the IDENTICAL predicate buildQuery uses. */
export const isFieldingEventMetric = (m) => m && m.source === "fielding_events";
/** Impact metric(s) sourced from `player_matches` (player_of_match, NOT the
 * JS-merged `matches`) — surfaced via the parallel `pom_cte` join. Exported
 * for the same graph-fetch reuse as isFieldingEventMetric. */
export const isPomMetric = (m) => m && m.source === "player_matches" && m.key !== "matches";

/** SQL WHERE predicates for the fielding SLICE conditions (fielding rebuild) —
 * the fielding metric's OWN dims, applied inside `fielding_cte` so the
 * Catches/Stumpings/Run-outs/Dismissals-Effected totals count only the sliced
 * events. Reads `state.fielding`: the original trio { positions, kinds, phases }
 * (multi-select lists, mirroring the app's existing position/opposition pickers)
 * PLUS the T-3a-ext full filter set appended by buildFieldingExtraSliceClauses
 * (out_hand/out_role/out_batter_id/bowler_id/bowler_style/city/innings_number/
 * over range + Season/Stage/Result/Toss via `matches`). Returns [] when nothing is
 * set, so the fielding_cte (and the whole query) stays byte-identical to the
 * un-sliced case — the leaderboard only ever sets positions/kinds/phases, so its
 * fielding column is unchanged. Columns referenced (out_batting_position, kind,
 * phase, and the extras) all live on the fielding_events view. */
export function buildFieldingSliceClauses(state) {
  const f = state.fielding || {};
  const clauses = [];
  if (Array.isArray(f.positions) && f.positions.length > 0) {
    // user-picked ints; coerce + drop non-integral before it reaches SQL.
    const nums = f.positions.map(Number).filter(Number.isInteger);
    if (nums.length > 0) clauses.push(`out_batting_position IN (${nums.join(", ")})`);
  }
  if (Array.isArray(f.kinds) && f.kinds.length > 0) {
    clauses.push(`kind IN (${f.kinds.map((k) => `'${esc(k)}'`).join(", ")})`);
  }
  if (Array.isArray(f.phases) && f.phases.length > 0) {
    clauses.push(`phase IN (${f.phases.map((p) => `'${esc(p)}'`).join(", ")})`);
  }
  // T-3a-ext (ADDITIVE — numbers sacred): the FULL fielding filter set beyond the
  // original position/kind/phase trio. Reads FURTHER state.fielding.* sub-fields and
  // emits NOTHING when they are unset, so buildFieldingCteSql (and thus the
  // leaderboard's fielding column, which only ever sets positions/kinds/phases) is
  // byte-identical. Kept in a separate exported function so the byte-identity is
  // obvious and the extra dims are testable in isolation.
  for (const c of buildFieldingExtraSliceClauses(state)) clauses.push(c);
  return clauses;
}

/**
 * The ADDITIVE fielding SLICE clauses (T-3a-ext) beyond position/kind/phase — the
 * full fielding filter set for the player pop-up's Fielding discipline. All read
 * FURTHER sub-fields on `state.fielding`; each contributes nothing when unset, so
 * this returns [] for the leaderboard (which sets only positions/kinds/phases),
 * keeping buildFieldingSliceClauses — and the sacred buildFieldingCteSql that calls
 * it — byte-identical.
 *
 * DIRECT columns on the `fielding` view (fielding_events): out_hand, out_role,
 * out_batter_id, bowler_id, bowler_style, city (string IN-lists); innings_number
 * (0-BASED stored ints — T-3b's editor owns the display mapping); over_number (a
 * 0-based range, over 1 = over_number 0, either bound optional). All player-scoped
 * by construction (the CTE groups by fielder_id and the outer wrap pins the player).
 *
 * MATCH-CONTEXT (fielding_events carries no match-context columns → reach `matches`):
 *  • Season — a non-correlated `match_id IN (SELECT … FROM matches …)` semi-join,
 *    mirroring the Event/Venue semi-joins in buildScopeClausesTagged.
 *  • Stage / Match Result / Toss result / Toss decision — the leaderboard's
 *    buildMatchContextClauses reused VERBATIM (no drift) inside a CORRELATED EXISTS
 *    on the fielding row's own match. Player-relative Result/Toss compare the
 *    fielder's own `fielding_team` to the match fields, exactly like a batting row's
 *    `batting_team`. The mctx sub-select is the SHARED matchContextSubselectSql (same
 *    projection the leaderboard's LEFT JOIN uses). `fielding` is the correlation name
 *    (buildFieldingCteSql and the fld_matches_cte both do a bare `FROM fielding`).
 *
 * These match-context sub-fields live under state.fielding (NOT top-level
 * state.stage/result/…) precisely so the leaderboard's own top-level match-context
 * never leaks into the fielding source — the fielding column keeps ignoring it,
 * unchanged. Values are coerced/escaped at the point of use (no injection surface).
 */
export function buildFieldingExtraSliceClauses(state) {
  const f = state.fielding || {};
  const clauses = [];
  const pushInList = (col, vals) => {
    const lits = [...new Set((vals || []).filter((v) => v != null && v !== ""))].map((v) => `'${esc(v)}'`);
    if (lits.length) clauses.push(`${col} IN (${lits.join(", ")})`);
  };
  const pushIntList = (col, vals) => {
    const nums = [...new Set((vals || []).map(Number).filter(Number.isInteger))];
    if (nums.length) clauses.push(`${col} IN (${nums.join(", ")})`);
  };

  // Dismissed-batter profile dims (availability is DATA-DRIVEN — see loadDimOptions).
  pushInList("out_hand", f.hands);
  pushInList("out_role", f.roles);
  pushInList("out_batter_id", f.outBatters);
  // Bowler dims.
  pushInList("bowler_id", f.bowlers);
  pushInList("bowler_style", f.bowlerStyles);
  // Location + innings.
  pushInList("city", f.cities);
  pushIntList("innings_number", f.inningsNumbers); // 0-based stored (T-3b maps display)

  // Over range (0-based over_number; over 1 = over_number 0). Either bound optional.
  const from = Number(f.overFrom);
  if (Number.isFinite(from)) clauses.push(`over_number >= ${Math.trunc(from)}`);
  const to = Number(f.overTo);
  if (Number.isFinite(to)) clauses.push(`over_number <= ${Math.trunc(to)}`);

  // Season — a match-level attribute on `matches` (fielding_events has none):
  // a non-correlated semi-join, gender-scoped exactly like Event/Venue.
  const seasons = [...new Set((f.seasons || []).filter((s) => s != null && s !== ""))];
  if (seasons.length) {
    clauses.push(
      `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND season IN (${seasons
        .map((s) => `'${esc(s)}'`)
        .join(", ")}))`
    );
  }

  // Match context (Stage / Match Result / Toss result / Toss decision): reuse the
  // leaderboard's buildMatchContextClauses VERBATIM inside a correlated EXISTS on the
  // fielding row's own match, comparing the fielder's `fielding_team` for the
  // player-relative Result/Toss terms. Only the four task-scoped facets are wired;
  // resultCondition stays [] so the reused builder emits nothing for it.
  const mctxAdapter = {
    result: f.result || [],
    tossResult: f.tossResult || [],
    tossDecision: f.tossDecision || [],
    stage: f.stage || [],
    resultCondition: [],
  };
  const mctxClauses = buildMatchContextClauses(mctxAdapter, "fielding.fielding_team");
  if (mctxClauses.length) {
    const inner = ["mctx.mctx_match_id = fielding.match_id", ...mctxClauses].join(" AND ");
    clauses.push(`EXISTS (SELECT 1 FROM ${matchContextSubselectSql()} WHERE ${inner})`);
  }

  return clauses;
}

/**
 * Build the `fielding_cte` definition (the CTE body WITHOUT the leading
 * "WITH " — the caller prepends/comma-joins it, exactly like regularPositionCteSql).
 * One row per fielder over the EVENT-GRAIN `fielding` view, honoring the FULL
 * leaderboard scope — core (gender/format/date/team-type) + team (fielding_team)
 * + OPPOSITION + event/venue + profile, pin-exempt — PLUS the fielding SLICE
 * conditions (dismissed-batter position / dismissal kind / phase), substitutes
 * excluded. Pins are read from state (the same filter buildQuery applies) so a
 * pinned player keeps their fielding numbers under the player-shortlisting
 * filters (team / profile / R. Pos. / search) while still obeying opposition,
 * event, venue and match context like every other row.
 *
 * Extracted verbatim from buildQuery (was inline) so the Graph Builder's
 * per-player fetch (graph/charts.js) can attach the IDENTICAL join when a
 * fielding-event metric is charted — the CTE can never diverge between the Stats
 * table and the graph. buildQuery's emitted SQL is byte-identical to before the
 * extraction (verified by a node harness diff across every scenario).
 */
export function buildFieldingCteSql(state) {
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const fieldingSliceClauses = buildFieldingSliceClauses(state);
  const fldClauses = buildScopeClausesTagged(state, {
    includeTeams: true,
    teamColumn: "fielding_team",
    idColumn: "fielder_id",
    oppositionColumn: "opposition",
  });
  if (state.search && state.search.trim()) {
    fldClauses.push(bypassableClause(`fielder_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }
  const fldScopeSql = whereWithPinExemption(fldClauses, "fielder_id", pins);
  // substitute exclusion + slice conditions are AND'd OUTSIDE the pin
  // exemption: they define WHAT is counted (like a phase column), so they apply
  // to every fielder including pins — pins only bypass the "who/which match"
  // scope above.
  const fldTail = ["substitute IS NOT TRUE", ...fieldingSliceClauses];
  return [
    "fielding_cte AS (",
    "  SELECT fielder_id AS fld_player_id,",
    "         SUM(CASE WHEN kind IN ('caught','caught and bowled') THEN 1 ELSE 0 END) AS catches,",
    // Distinct caught-&-bowled count (Wave R2d): the c&b subset of `catches` above
    // (which deliberately still folds c&b in — unchanged). Lets "Fielding Wicket
    // Type ▸ Caught & bowled" filter on c&b alone. Purely additive: existing
    // catches/stumpings/run_outs outputs are byte-identical.
    "         SUM(CASE WHEN kind = 'caught and bowled' THEN 1 ELSE 0 END) AS caught_and_bowled,",
    "         SUM(CASE WHEN kind = 'stumped' THEN 1 ELSE 0 END) AS stumpings,",
    "         SUM(CASE WHEN kind = 'run out' THEN 1 ELSE 0 END) AS run_outs",
    "  FROM fielding",
    `  WHERE ${[fldScopeSql, ...fldTail].join(" AND ")}`,
    "  GROUP BY fielder_id",
    ")",
  ].join("\n");
}

/**
 * Build the `pom_cte` definition (Player-of-the-Match, source player_matches) —
 * same "CTE body without leading WITH" convention as buildFieldingCteSql. A
 * whole-match award, so it stays on player_matches (which has no opposition/
 * position column): scope is core + team + event/venue + profile + R. Pos.,
 * pin-exempt — the SAME options the "matches" secondary query uses, so PoM and
 * matches never diverge on scope. Extracted verbatim from buildQuery; buildQuery
 * output stays byte-identical (verified).
 */
export function buildPomCteSql(state) {
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const pomClauses = buildScopeClausesTagged(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" });
  if (state.search && state.search.trim()) {
    pomClauses.push(bypassableClause(`player_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }
  const pomWhereSql = whereWithPinExemption(pomClauses, "player_id", pins);
  return [
    "pom_cte AS (",
    "  SELECT player_id AS pom_player_id, SUM(player_of_match) AS player_of_match",
    "  FROM player_matches",
    `  WHERE ${pomWhereSql}`,
    "  GROUP BY player_id",
    ")",
  ].join("\n");
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
export function buildQuery(state, visibleColumns, opts = {}) {
  const discipline = state.discipline;

  // Tab-2 per-innings SLICE injection (T-2b-i): an OPTIONAL pre-aggregate WHERE
  // predicate on the innings-grain view columns (runs / sixes_hit / wickets / …),
  // AND-ed into this query's WHERE below so every aggregate runs over ONLY the
  // sliced innings instead of the whole record. This is the numbers-correct way to
  // make the pop-up Filters tab's conditions per-INNINGS slices rather than the
  // leaderboard's player-level HAVING gate. The caller (playerFiltersTab.js) owns
  // the metric→column mapping (conditionToInningsWhere); this stays a generic,
  // taxonomy-agnostic string injection so the numbers path can never diverge.
  // Absent/empty ⇒ finalWhereSql === whereSql AND inningsLevel unchanged ⇒ every
  // existing 2-arg caller is BYTE-IDENTICAL by construction. Only the plain
  // (non-matchup) path honours it — the Filters tab never combines a per-innings
  // slice with a "Vs" matchup selection in this wave.
  const inningsWhere = opts && opts.inningsWhere ? String(opts.inningsWhere) : null;

  // Tab-2 MAT-over-filtered-balls signal (T-2d): an OPTIONAL boolean the pop-up's
  // per-row query passes ONLY when a BALL predicate (opponent-player / delivery
  // window) is active. Those predicates are threaded to db.query AFTER buildQuery
  // (they restrict the ball-engine view reconstruction), so buildQuery can't see
  // them and would otherwise leave "matches" on the whole-scope player_matches
  // source. This flag forces the innings-level MAT path below — COUNT(DISTINCT
  // match_id) over the (ball-restricted) view rows — so MAT counts the matches the
  // player actually played WITHIN the ball filter. Absent/false ⇒ inningsLevel is
  // unchanged ⇒ every existing 2-arg caller (leaderboard, graph) is BYTE-IDENTICAL.
  const inningsMatches = Boolean(opts && opts.inningsMatches);

  if (matchupVsActive(state)) {
    return buildMatchupQuery(state, discipline, visibleColumns);
  }

  const view = VIEW_FOR_DISCIPLINE[discipline];
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];

  const inningsMetrics = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter((m) => m && m.source !== "player_matches" && m.source !== "fielding_events");

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

  // Fielding (source "fielding_events") + Impact (player_of_match, source
  // "player_matches") columns: EXCLUDED from inningsMetrics above (not in the
  // batting/bowling views). Surfaced via two parallel per-player CTEs LEFT-JOINed
  // into the FROM below —
  //   fielding_cte : catches/stumpings/run_outs over the EVENT-GRAIN `fielding`
  //                  view, honoring the FULL scope incl. OPPOSITION + venue/event
  //                  + profile, substitutes excluded, plus the fielding SLICE
  //                  conditions (dismissed-batter position / dismissal kind /
  //                  phase — the metric's own dims).
  //   pom_cte      : player_of_match over player_matches (which has no opposition
  //                  column — a whole-match award, so opposition is not applied).
  // Each sqlExpression is MAX(<cte>.<col>) — a constant across a player's group
  // (each CTE is one row per player), so MAX just projects that constant, exactly
  // like the R. Pos. join's MAX. The joins never multiply innings rows, so every
  // existing aggregate above stays byte-identical. `wants*` also lights up for a
  // matching STAT CONDITION with no visible column, so a HAVING referencing the
  // CTE always has its CTE joined.
  const fieldingEventCols = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter(isFieldingEventMetric);
  const pomCols = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter(isPomMetric);
  for (const m of [...fieldingEventCols, ...pomCols]) {
    selectParts.push(`${m.sqlExpression} AS ${m.key}`);
  }
  const wantsFielding =
    fieldingEventCols.length > 0 ||
    advancedReferencesMetric(state.advanced, discipline, isFieldingEventMetric);
  const wantsPom =
    pomCols.length > 0 ||
    advancedReferencesMetric(state.advanced, discipline, isPomMetric);

  // Clauses arrive TAGGED for the pin exemption (filters.js
  // buildScopeClausesTagged): the builder marks its own three player-shortlisting
  // filters (team / profile / R. Pos.) bypassable, everything else
  // always-applies. The name search is a shortlisting device too, so it is tagged
  // here.
  const whereClauses = buildScopeClausesTagged(state, {
    includeTeams: true,
    teamColumn: teamCol,
    idColumn: idCol,
    oppositionColumn: OPP_COL[discipline],
    includePositions: true,
  });
  if (state.search && state.search.trim()) {
    whereClauses.push(bypassableClause(`${nameCol} ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }

  // Match-context filters (Wave 6): additive. When ANY context filter is active
  // we LEFT JOIN `matches` (see fromSql below) and compare the row's own team
  // (teamCol = batting_team | bowling_team) to the joined match fields. Pushed
  // UNTAGGED, i.e. ALWAYS-APPLIES: a pin obeys result / result condition / stage /
  // toss / innings order just like every other row, so the pinned row is measured
  // over the same matches the rest of the table is. (They used to be swept into
  // the pin-bypassed remainder purely because they were appended last — that is
  // the defect the explicit tagging fixes.) With no context filter active this
  // pushes nothing and the emitted SQL is byte-identical to before.
  const wantsMatchContext = matchContextActive(state);
  if (wantsMatchContext) {
    for (const c of buildMatchContextClauses(state, teamCol)) whereClauses.push(c);
  }

  // Pinned players (task 3b, owner decision 46; Wave 4b routed onto the shared
  // helper): additive OR. The helper reads each clause's OWN bypass tag, so it
  // never has to know the clause order — a pinned player bypasses exactly
  // team/profile/R. Pos./search, and still obeys the core scope (gender/format/
  // date window/team type) plus opposition, the matchup striker position, and
  // event/venue/match context.
  // buildMatchupQuery calls the SAME helper (Wave 4b, decision 47a), so plain and
  // Vs pin-handling can never diverge.
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const whereSql = whereWithPinExemption(whereClauses, idCol, pins);
  // T-2b-i: AND the per-innings slice predicate in. It defines WHAT is counted
  // (like a phase/fielding slice), NOT which players are shortlisted, so it
  // ALWAYS-APPLIES — sits OUTSIDE the pin exemption (a pinned player is still
  // measured over their sliced innings). Byte-identical when inningsWhere is null.
  const finalWhereSql = inningsWhere ? `(${whereSql}) AND (${inningsWhere})` : whereSql;

  // Fielding subquery (fielding rebuild): pre-aggregate the EVENT-GRAIN `fielding`
  // view to ONE row per fielder, honoring the FULL leaderboard scope — core
  // (gender/format/date/team-type) + team (fielding_team) + OPPOSITION + event/
  // venue + profile + R. Pos., pin-exempt — PLUS the fielding SLICE conditions
  // (dismissed-batter position / dismissal kind / phase). Substitutes are
  // excluded by default; the slice clauses (metric-definition refinements, not
  // "who to include") always apply, even to pins. Only built when a fielding
  // column is shown or a fielding stat condition is active; with neither, `sql`
  // is byte-identical to before this wave. The CTE body is built by the shared
  // buildFieldingCteSql() helper (extracted so graph/charts.js attaches the
  // identical join) — same output as the former inline construction.
  let fieldingCteSql = null;
  if (wantsFielding) fieldingCteSql = buildFieldingCteSql(state);

  // Impact subquery (player_of_match): a whole-match award, so it stays on
  // player_matches (which has no opposition/position column). Same scope options
  // the "matches" secondary query uses below (core + team + event/venue + profile
  // + R. Pos., pin-exempt), so PoM and matches never diverge on scope. Built by
  // the shared buildPomCteSql() helper (same output as the former inline block).
  let pomCteSql = null;
  if (wantsPom) pomCteSql = buildPomCteSql(state);

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
  // "Matches" honesty (D4 Piece 3, extended for Wave 6): when an innings-level OR
  // match-context filter narrows the set, "matches" must be COUNT(DISTINCT
  // match_id) over the FILTERED innings rows (which carry the match-context join +
  // WHERE) — not the player_matches source, which knows nothing about result/toss/
  // stage/etc. and would over-count. match_id stays unambiguous (the mctx join
  // renames its own key to mctx_match_id).
  // Innings Number (Wave R2d): like positions/opposition, this narrows to an
  // innings SUBSET (WHERE innings_number IN (…) on the batting/bowling view), so
  // "matches" must be COUNT(DISTINCT match_id) over the FILTERED innings rows —
  // matches in which the player actually batted/bowled in the selected innings —
  // not the whole-scope player_matches count (which knows nothing about which
  // innings the player appeared in and would over-count). Mirrors the old
  // "Innings order" filter, which was innings-level for the same reason. Additive:
  // with no Innings Number set, inningsNumberFilterActive() is false → the gate is
  // unchanged and every anchor stays byte-identical.
  const inningsLevel =
    positionsFilterActive(state) ||
    oppositionFilterActive(state) ||
    inningsNumberFilterActive(state) ||
    wantsMatchContext ||
    // T-2b-i: a per-innings slice narrows to an innings SUBSET exactly like the
    // filters above, so a visible "matches" column must count DISTINCT match_id
    // over the SLICED innings (not the whole-scope player_matches count, which
    // ignores the slice). Additive: null slice leaves inningsLevel unchanged.
    Boolean(inningsWhere) ||
    // T-2d: a ball predicate (opponent-player / delivery window) restricts the
    // view rows to the filtered balls but is invisible to buildQuery (threaded to
    // db.query), so MAT must likewise count DISTINCT match_id over those rows
    // rather than the whole-scope player_matches source. Additive: false leaves
    // inningsLevel unchanged (every existing caller passes no opts).
    inningsMatches;
  if (wantsMatches && inningsLevel) {
    selectParts.push(`COUNT(DISTINCT match_id) AS matches`);
  }

  const groupBy = [idCol, nameCol];

  // r_pos_cte's join column is deliberately NOT named "batter_id"/"bowler_id"
  // (i.e. not idCol) — this view and the CTE would then both carry a column
  // of that exact name post-JOIN, making every existing bare `${idCol}`
  // reference elsewhere in this SELECT/GROUP BY (batter_id AS id, GROUP BY
  // batter_id, ...) ambiguous. "pos_batter_id" can never collide.
  // r_pos_cte / fielding_cte / pom_cte are each one row per player and LEFT
  // JOINed on the id column, so none multiplies the innings rows the aggregates
  // run over. Each uses a collision-safe join key (pos_batter_id / fld_player_id
  // / pom_player_id) so no bare `${idCol}` reference in this SELECT/GROUP BY
  // becomes ambiguous.
  const cteDefs = [];
  if (wantsRPos) cteDefs.push(regularPositionCteSql(state));
  if (wantsFielding) cteDefs.push(fieldingCteSql);
  if (wantsPom) cteDefs.push(pomCteSql);

  let fromSql = view;
  // Match-context (Wave 6): 1:1 LEFT JOIN by match_id (see matchContextJoinSql).
  // Added first so the mctx alias exists for the WHERE clauses; it never
  // multiplies innings rows (one match per match_id), so every aggregate stays
  // byte-identical. Only present when a context filter is active.
  if (wantsMatchContext) fromSql += matchContextJoinSql(view);
  if (wantsRPos) fromSql += ` LEFT JOIN r_pos_cte ON r_pos_cte.pos_batter_id = ${idCol}`;
  if (wantsFielding) fromSql += ` LEFT JOIN fielding_cte ON fielding_cte.fld_player_id = ${idCol}`;
  if (wantsPom) fromSql += ` LEFT JOIN pom_cte ON pom_cte.pom_player_id = ${idCol}`;

  const sql = [
    ...(cteDefs.length ? [`WITH ${cteDefs.join(",\n")}`] : []),
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${fromSql}`,
    `WHERE ${finalWhereSql}`,
    `GROUP BY ${groupBy.join(", ")}`,
    // No base gate anymore (decision 44c) — HAVING is emitted only when the
    // advanced stat-conditions path contributes a predicate.
    ...(havingSql ? [`HAVING ${havingSql}`] : []),
  ].join("\n");

  let matchesSql = null;
  if (wantsMatches && !inningsLevel) {
    const pmClauses = buildScopeClausesTagged(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" });
    if (state.search && state.search.trim()) {
      pmClauses.push(bypassableClause(`player_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
    }
    const pmWhereSql = whereWithPinExemption(pmClauses, "player_id", pins);
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
    case "overs": {
      // Cricket O.B notation for a legal-ball total — DISPLAY ONLY (never a
      // number we do arithmetic on). floor(balls/6) whole overs, then the
      // ball-in-over remainder 0–5 after the dot. e.g. 120 → "20.0", 125 → "20.5".
      const balls = Math.round(n);
      return `${Math.floor(balls / 6).toLocaleString()}.${balls % 6}`;
    }
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

// The Columns picker's dismissal-% / rare-dismissals grouping + rendering
// (RARE_DISMISSAL_KINDS, dismissalRowHTML, computeInitialShowPct) moved to
// src/columnsPicker.js with the rest of the picker popover (Tab-2 wave T-F2).

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

// ── Pin float (R5-B #2/#3/#11/#12) ───────────────────────────────────────────
// A classic pushpin icon (Material "push_pin"), filled via currentColor so CSS
// alone distinguishes pinned (accent) from unpinned (muted) — see .pin-toggle in
// styles.css. Inline (no external asset) to satisfy the app's no-network-per-icon
// convention.
const PIN_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

/**
 * Float pinned players to the TOP of the displayed rows (owner decision 50, #3;
 * #2 folds in because a searched-in player IS a pin — main.js pinPlayer). `rows`
 * is the BASE ordered array (sorted or order-preserved, NOT yet floated) — the
 * float is a pure render-time transform so unpinning returns a player to their
 * true ranked slot and reorderPreservingPrevious preserves the un-floated order.
 *
 * Pinned players present in `rows` keep their relative (base) order and are
 * lifted above the non-pinned rows. A pinned player with NO row in `rows`
 * (genuinely no innings in the CORE scope even after the pin-exemption query —
 * #11's honest empty case) gets a synthetic `__noData` placeholder so they still
 * appear at the top, rendering "—" in every metric cell (formatValue returns "—"
 * for the absent values). Returns a NEW array; never mutates `rows`. With no pins
 * it returns `rows` unchanged, so the un-pinned table (and every anchor) is
 * byte-identical in what it paints.
 */
function floatPinsToTop(rows, state) {
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  if (pins.length === 0) return rows;
  const pinIds = new Set(pins.map((p) => String(p.id)));
  const present = new Set();
  const pinned = [];
  const rest = [];
  for (const r of rows) {
    if (pinIds.has(String(r.id))) {
      pinned.push(r);
      present.add(String(r.id));
    } else {
      rest.push(r);
    }
  }
  // Synthetic no-data rows for pins with no row in the result set, in pin-add
  // order. __noData is informational only — the "—" cells fall out of the values
  // simply being absent; the null rank cell falls out of them not being in `rows`.
  const synthetic = [];
  for (const p of pins) {
    if (!present.has(String(p.id))) synthetic.push({ id: p.id, name: p.name, __noData: true });
  }
  return [...pinned, ...synthetic, ...rest];
}

// ── Table controller ─────────────────────────────────────────────────────────

export function mountTable(
  container,
  store,
  { onPlayerClick, onOpenFilters, onOpenColumns, onClear, onSearch, onDateChange, getAppliedState, onColumnsApplied, onSkeletonReady, onTogglePin } = {}
) {
  let lastRows = [];
  let loadToken = 0;
  // R5-B #0 (owner ruling 2026-07-19): whether the CURRENT displayed row order
  // is an ACTIVE column sort — true only when the last render ordered `lastRows`
  // via applySort (a fresh/popup Search that ranks, or a column-header click),
  // false after an order-PRESERVING toolbar-only commit (reorderPreservingPrevious).
  // The sort ▲/▼ arrow + `is-sorted` styling appear ONLY when this is true AND
  // state.sort.key matches the column (see headerCellHTML + the Player header),
  // so a column that isn't actually sorting the rows carries no arrow. Set at the
  // sort/preserve sites in load() and true in applySortKey(); a pure column
  // drag-reorder, a tab switch, and Show More re-render without touching it (they
  // don't change row order), so the flag survives them. A pin float/reset does
  // NOT flip it either (pins float on top AFTER ordering — the non-pinned rows
  // stay in whatever order applies), which is why the pin requery preserves it.
  let orderIsActiveSort = true;
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
  // The shared Columns picker (extracted to src/columnsPicker.js, Tab-2 wave
  // T-F2). The leaderboard's contract: it lists metrics for the EFFECTIVE
  // namespace (matchup vocab while a Vs selection is active) and applies a
  // column change INSTANTLY via applyColumnsInstant — a frozen-scope requery
  // that never lights Search. The popover lives on document.body so a reload
  // never destroys it; load()/enterView() call columnsPicker.refresh(...) after
  // every re-render to re-anchor + re-sync it. Same behaviour as the former
  // in-closure openColumnsPopover; only the UI moved behind this contract.
  const columnsPicker = createColumnsPicker({
    getDiscipline: () => effectiveDiscipline(store.get()),
    getFormats: () => store.get().formats,
    getColumns: () => {
      const s = store.get();
      return s.columns[effectiveDiscipline(s)];
    },
    setColumns: (cols) => applyColumnsInstant(effectiveDiscipline(store.get()), cols),
  });
  // Columns-rejig W1: the leaderboard's picker now lives INLINE inside the
  // leaderboard popup's "Columns" section (index.html #fpop-columns-host), not as
  // a floating popover off the toolbar button. Mounted ONCE here — the host is a
  // static element in index.html, present from load and persistent across every
  // table-skeleton rebuild (so it never needs re-mounting). syncToolbar() +
  // load()/enterView() call columnsPicker.refresh() to keep it in step with the
  // (possibly pending) store; the toolbar "Columns" button is now a SHORTCUT that
  // opens the popup to this section (onOpenColumns, wired in ensureSkeleton).
  const columnsHostEl = document.getElementById("fpop-columns-host");
  if (columnsHostEl) columnsPicker.mountInline(columnsHostEl);
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
  let showTop50BtnEl = null;
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
  let bodyHintEl = null;
  let blockedNoteEl = null;
  // Owner-approved, display-only (polish-b1-mechanical, item 2): tracks the
  // false→true transition of "a player is picked but a date is missing" so
  // the ONE-TIME date-field pulse (item 2a) fires exactly on that edge, never
  // on every syncToolbar pass (which runs on every store change). Separately,
  // `blockedHintVisible` (item 2b) is set true by a click on the greyed
  // Search button and cleared the moment the block resolves (both dates set,
  // or the player pick is cleared) — recomputed fresh in syncToolbar.
  let prevDatesNeedInput = false;
  let blockedHintVisible = false;
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
          <button type="button" class="btn btn--primary table-toolbar__search-btn is-blocked" data-role="toolbar-search" aria-disabled="true">Search</button>
          <button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Columns</button>
          <button type="button" class="btn btn--ghost table-toolbar__clear-btn" data-role="toolbar-clear-btn">Clear</button>
        </div>
      </div>
      <p class="table-toolbar__blocked-note" data-role="toolbar-blocked-note" hidden></p>
      <div class="table-pills-host" data-role="table-pills-host"></div>
      <div class="table-body-wrap" data-role="table-body-wrap">
        <div class="table-loading-overlay" aria-live="polite" hidden>Running query…</div>
        <div class="table-scroll"><table class="data-table"><thead></thead><tbody></tbody></table>
          <p class="table-body-hint" data-role="table-body-hint" hidden>Set your filters, then press Search.</p>
          <div class="table-show-more" data-role="table-show-more" hidden>
            <button type="button" class="btn btn--ghost" data-role="show-more-btn"></button>
            <button type="button" class="btn btn--ghost" data-role="show-top50-btn" hidden>Show top 50</button>
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
    showTop50BtnEl = container.querySelector('[data-role="show-top50-btn"]');
    bodyHintEl = container.querySelector('[data-role="table-body-hint"]');
    blockedNoteEl = container.querySelector('[data-role="toolbar-blocked-note"]');
    dateFromEl = container.querySelector('[data-role="toolbar-date-from"]');
    dateToEl = container.querySelector('[data-role="toolbar-date-to"]');
    presetSelectEl = container.querySelector('[data-role="preset-select"]');
    vsWrapEl = container.querySelector('[data-role="toolbar-vs"]');
    vsSelectEl = container.querySelector('[data-role="matchup-vs"]');
    countEl = container.querySelector('[data-role="row-count"]');
    searchBtnEl = container.querySelector('[data-role="toolbar-search"]');
    columnsBtnEl = container.querySelector('[data-role="columns-btn"]');
    clearBtnEl = container.querySelector('[data-role="toolbar-clear-btn"]');
    presetOptionsDiscipline = null; // force a fresh option build in syncToolbar

    if (showMoreBtnEl) {
      showMoreBtnEl.addEventListener("click", () => {
        // Reveal-all-at-once (task 3: "one click"), not another page. Pure
        // re-render of the already-loaded rows — no requery. MAX_SAFE_INTEGER
        // (not lastRows.length) so floated synthetic no-data pin rows (R5-B #3,
        // which make the DISPLAYED count exceed lastRows.length) are revealed too.
        visibleRowCount = Number.MAX_SAFE_INTEGER;
        renderLoaded(lastRows, lastLoadedState ?? store.get(), lastBowlingTypes);
      });
    }

    // "Show top 50" (Round-6 item #12): the paired collapse for the button
    // above — appears once the table has actually been expanded past the
    // initial cap (renderLoaded's own hidden/visible logic below), and takes
    // it right back to PAGE_SIZE. Same "pure re-render of already-loaded
    // rows, no requery" shape as Show More.
    if (showTop50BtnEl) {
      showTop50BtnEl.addEventListener("click", () => {
        visibleRowCount = PAGE_SIZE;
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

    // Columns-rejig W1: the "Columns" toolbar button is now a SHORTCUT — it opens
    // the leaderboard popup with the Columns section expanded (main.js's
    // onOpenColumns), where the picker lives inline (mounted once above). It no
    // longer opens a floating popover. A fresh button is made on each skeleton
    // rebuild, so binding here (not once) is correct and never double-binds.
    if (columnsBtnEl && onOpenColumns) columnsBtnEl.addEventListener("click", () => onOpenColumns());

    // SEARCH button (R3.2): replaces the old toolbar "Graph" button and is the
    // ONE query trigger from the toolbar — main.js's runSearch commits pending
    // → applied and loads. syncToolbar gates its enabled/blocked state.
    //
    // Owner-approved, display-only (polish-b1-mechanical, item 2b): the button
    // is no longer natively `disabled` while blocked (aria-disabled="true" +
    // the .is-blocked look instead — see syncToolbar) specifically so THIS
    // click still fires when blocked: a natively-disabled button emits no
    // click event at all, which would make the red hint below undetectable.
    if (searchBtnEl) {
      searchBtnEl.addEventListener("click", () => {
        if (searchBtnEl.getAttribute("aria-disabled") === "true") {
          // Blocked. Two distinct reasons share this same look:
          //   • dates missing — Search literally cannot run yet. This is the
          //     "you must pick a date" block item 2b targets: show the red
          //     hint + one pulse, honest in every case since the dates truly
          //     are missing regardless of anything else.
          //   • dates are fine but nothing has changed since the last Search
          //     ("up to date" — no player/filter edit pending). Silently a
          //     no-op, exactly like the native `disabled` button did before
          //     this change — showing a "pick a date" hint here would be
          //     false (the dates ARE set).
          const live = store.get();
          const searchable = Boolean(live.dateFrom && live.dateTo);
          if (!searchable) {
            blockedHintVisible = true;
            syncToolbar();
            pulseDateFields();
          }
          return;
        }
        // Active: behaves exactly as before.
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
    showTop50BtnEl = null;
    bodyHintEl = null;
    blockedNoteEl = null;
    dateFromEl = null;
    dateToEl = null;
    presetSelectEl = null;
    vsWrapEl = null;
    vsSelectEl = null;
    countEl = null;
    searchBtnEl = null;
    columnsBtnEl = null;
    clearBtnEl = null;
    presetOptionsDiscipline = null;
    // A fresh skeleton starts with no pulse/blocked-hint history — the next
    // syncToolbar() pass re-derives both from the live store from scratch.
    prevDatesNeedInput = false;
    blockedHintVisible = false;
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
    columnsPicker.close();
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
      columnsPicker.refresh(container.querySelector('[data-role="columns-btn"]'));
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
    // R5-B #0: the arrow + is-sorted styling show ONLY when the displayed order
    // is an active column sort (orderIsActiveSort) AND this is the sort column.
    // After an order-preserving toolbar-only commit, orderIsActiveSort is false,
    // so no column shows an arrow even though state.sort.key still names one.
    const isSorted = orderIsActiveSort && state.sort.key === metric.key;
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

  /** R5-A #4: reorder a freshly-loaded row set to PRESERVE the previous visual
   * order — players keep their positions and their values simply swap in place;
   * rows that no longer qualify drop out; NEW qualifiers append at the BOTTOM (in
   * fresh-sort order among themselves). Used on a toolbar-only commit (Vs / preset
   * / a column toggle) so those never reshuffle the leaderboard — only a
   * column-header click or a popup Search triggers a true re-sort (applySort). */
  function reorderPreservingPrevious(newRows, prevRows, s) {
    const prevIndex = new Map();
    prevRows.forEach((r, i) => prevIndex.set(String(r.id), i));
    const kept = [];
    const appended = [];
    for (const r of newRows) {
      if (prevIndex.has(String(r.id))) kept.push(r);
      else appended.push(r);
    }
    kept.sort((a, b) => prevIndex.get(String(a.id)) - prevIndex.get(String(b.id)));
    return [...kept, ...applySort(appended, s)];
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
    // R5-A #4: toggling a column is a toolbar-only change — preserve the current
    // row order (values swap in place; a dropped sort-column doesn't reshuffle).
    load(frozen, { resort: false });
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
   * Matchup ("Vs") mode: buildMatchupQuery now routes pins through the same
   * whereWithPinExemption/gateWithPinExemption helper buildQuery uses (Wave
   * 4b, decision 47a) — this requery picks up a matchup row for the pin
   * exactly like the plain-mode path, no special-casing needed here.
   *
   * If nothing has EVER been searched (lastLoadedState null — no table body
   * exists yet), there is no frozen scope to drop a row into: the pin still
   * updates the store/pill (via main.js) and simply applies on the eventual
   * first Search, same as before this addendum. Returns load()'s promise (or
   * a resolved null in the no-op case) so callers (main.js's onPinsChanged,
   * 4d/A6) can read the resolved `missingPinnedIds` for the "(no innings)"
   * pill annotation + toast. */
  function applyPinnedPlayers() {
    if (!lastLoadedState) {
      syncToolbar();
      return Promise.resolve(null);
    }
    const pins = store.get().pinnedPlayers || [];
    const frozen = { ...lastLoadedState, pinnedPlayers: pins };
    // R5-B #2/#3/#0: a pin add/remove must NOT reshuffle the non-pinned rows or
    // flip the sort arrow — the pin only floats a row on top (or drops it back to
    // its ranked slot). resort:false preserves the base order; preserveSortFlag
    // keeps orderIsActiveSort as-is (a float doesn't make the order a sort, nor
    // undo one). The float itself is applied at render time (floatPinsToTop).
    return load(frozen, { resort: false, preserveSortFlag: true });
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

  /** Owner-approved, display-only (polish-b1-mechanical, item 2a/2b): fire the
   * ONE red pulse (styles.css's .date-pulse / toolbar-date-pulse keyframe) on
   * whichever date field(s) currently carry the static .needs-input outline
   * (i.e., are actually empty while a player is picked) — never a field that's
   * already filled in. Removing then re-adding the class (with a forced
   * reflow in between) restarts the animation on every call, including a
   * second call before the first pulse has finished. `prefers-reduced-motion`
   * is handled entirely in CSS (the animation is simply suppressed there; the
   * static outline is untouched either way). */
  function pulseDateFields() {
    for (const el of [dateFromEl, dateToEl]) {
      if (!el || !el.classList.contains("needs-input")) continue;
      el.classList.remove("date-pulse");
      void el.offsetWidth; // eslint-disable-line no-void -- force reflow to restart the animation
      el.classList.add("date-pulse");
    }
  }

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
    // Owner-approved, display-only (item 2a): ONE red pulse, fired only on the
    // false→true EDGE into "a player is picked but a date is missing" — this
    // function runs on every store change (main.js's subscribe hook), so a
    // plain "pulse whenever the condition is true" would spam the animation on
    // every keystroke. Tracking the previous value and pulsing only on the
    // transition keeps it to exactly one pop, then rest as the static outline.
    const datesNeedInput = playerPicked && (!live.dateFrom || !live.dateTo);
    if (datesNeedInput && !prevDatesNeedInput) pulseDateFields();
    prevDatesNeedInput = datesNeedInput;

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

    // Bonded Vs (pending) — visibility is DATA-DRIVEN (Group 3 sweep, owner
    // 2026-08-07), no longer a gender hardcode: show iff the discipline-
    // appropriate matchup data exists for the current gender. Mirrors the
    // drawer's Vs-family gate (drawer.js singletonDataAvailable →
    // availability.isAvailable "vsBowlingStyle"/"vsBattingHand"). table.js has no
    // availability instance, so it reads the resolved per-gender map Group 3 put
    // on the store (live.dataAvail = {matchupBatting, matchupBowling, …}).
    // Optimistically SHOW while that map is null/unresolved — matchupVsActive is
    // the number-critical gate and keys on the SAME map, so this control's
    // visibility is display-only; a brief show that then hides can't move a
    // number (mirrors the offer path's optimistic default in state.js
    // dataAvailBool).
    if (vsWrapEl && vsSelectEl) {
      const availKey = discipline === "batting" ? "matchupBatting" : "matchupBowling";
      const av = live.dataAvail;
      // Optimistic until resolved: show unless the map is present AND explicitly
      // reports the discipline's matchup data absent for this gender.
      const showVs = !av || typeof av[availKey] !== "boolean" || av[availKey];
      if (!showVs) {
        vsWrapEl.hidden = true;
      } else {
        vsWrapEl.hidden = false;
        vsSelectEl.innerHTML = matchupVsOptionsHTML(live, lastBowlingTypes);
        vsSelectEl.disabled = !results;
      }
    }

    // Columns button (owner, W1 fix 2): always enabled — it's a shortcut into
    // the popup's Columns section, configurable before the first search runs.
    // Every OTHER toolbar control's enabled/disabled logic is untouched.
    if (columnsBtnEl) columnsBtnEl.disabled = false;

    // Search button — dirty iff pending ≠ applied; enabled iff dirty AND
    // searchable (both dates present). Mirrors the graph's Update-chart button:
    // accent-filled + enabled when there's something to apply, muted+"blocked"
    // when the displayed table is already up to date or a date is missing.
    //
    // Owner-approved, display-only (item 2b): blocked is no longer the native
    // `disabled` attribute — a natively-disabled button emits no click event,
    // so the blocked-click hint below could never detect the click. It's now
    // `aria-disabled="true"` + the `.is-blocked` class (styles.css reproduces
    // the exact same muted look `.btn:disabled` gives every other disabled
    // button). The enabled path (active === true) is byte-for-byte unchanged.
    let searchable = false;
    if (searchBtnEl) {
      const dirty = serializeQueryState(live) !== serializeQueryState(applied);
      searchable = Boolean(live.dateFrom && live.dateTo);
      const active = dirty && searchable;
      searchBtnEl.classList.toggle("is-dirty", active);
      searchBtnEl.classList.toggle("is-blocked", !active);
      searchBtnEl.setAttribute("aria-disabled", active ? "false" : "true");
    } else {
      searchable = Boolean(live.dateFrom && live.dateTo);
    }

    // R5-A #1: the toolbar honesty note ("Matchup mode" / "N of M stat conditions
    // apply here") was REMOVED — the toolbar already carries the scope (dates/Vs/
    // preset) and, with conditions now per-discipline (#7), nothing is ever inert,
    // so the "N of M" note is moot. No note element remains.

    // Owner-approved, display-only (item 2b): a click on the blocked Search
    // button (see the click handler above) sets blockedHintVisible = true.
    // It's cleared the moment the block actually resolves — both dates set,
    // or the player pick that made the date matter is gone — recomputed
    // fresh here on every pass so a fix anywhere clears the hint as soon as
    // it takes effect (it never has to be dismissed by hand).
    if (blockedHintVisible && (searchable || !playerPicked)) blockedHintVisible = false;

    // Body hint (empty-state guidance inside the table area). A zero-row search is
    // now a legitimate outcome — a pick the rest of the filters have made
    // impossible is kept and greyed rather than reset (owner ruling) — so the
    // empty case explains itself here rather than leaving a blank table. Owner
    // ruling: TEXT where the table would be, never a popup, for this case.
    //
    // Item 2b adds ONE more case, layered on top without changing the others:
    // while blockedHintVisible and no table is displayed yet (!results), this
    // SAME element carries the red "pick a date" hint instead of the usual
    // prompt — never a second element, never overwriting a displayed table.
    if (bodyHintEl) {
      if (blockedHintVisible && !results) {
        bodyHintEl.textContent = "Pick a start and end date to search.";
        bodyHintEl.classList.add("table-body-hint--blocked");
        bodyHintEl.hidden = false;
      } else if (!results) {
        bodyHintEl.textContent = "Set your filters, then press Search.";
        bodyHintEl.classList.remove("table-body-hint--blocked");
        bodyHintEl.hidden = false;
      } else if (lastRows.length === 0) {
        bodyHintEl.textContent =
          "No players match these filters. Nothing in the data meets all of your filters and conditions at the same time — open Filters and remove or loosen one, or widen the date range.";
        bodyHintEl.classList.remove("table-body-hint--blocked");
        bodyHintEl.hidden = false;
      } else {
        bodyHintEl.classList.remove("table-body-hint--blocked");
        bodyHintEl.hidden = true;
      }
    }

    // Item 2b's rare "a table is already displayed" case (dirty + date
    // cleared): the table itself is never touched — this separate line under
    // the toolbar carries the red hint instead, non-destructively.
    if (blockedNoteEl) {
      const showNote = blockedHintVisible && results;
      blockedNoteEl.hidden = !showNote;
      blockedNoteEl.textContent = showNote ? "Pick a start and end date to search." : "";
    }

    // Columns-rejig W1: the Columns picker now lives INLINE in the leaderboard
    // popup, so — like every other toolbar control here — it must track the
    // (possibly pending) store: a pending discipline/Vs/format change swaps its
    // metric vocabulary, a preset/column edit changes which boxes are ticked.
    // refresh() re-renders on a namespace/format change, else just re-syncs
    // checked state (cheap, no-op when nothing moved). The anchor arg is unused
    // in inline mode. Numbers untouched — this only redraws checkboxes.
    columnsPicker.refresh();
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

    // Pin column (R5-B #3/#12): a control column IMMEDIATELY LEFT of "#". Each
    // row's cell toggles that player's pin; pinned players float to the top and
    // are marked with an active (accent) pin so an out-of-filter added player can
    // never be mistaken for a filter "leak". Not sortable, not draggable, sticky
    // at the far left (see .data-table__th--pin in styles.css). The header shows a
    // faint static pin as a legend.
    const pinTh = `<th class="data-table__th data-table__th--pin" scope="col" aria-label="Pin" title="Pin players to the top"><span class="pin-header-glyph" aria-hidden="true">${PIN_GLYPH}</span></th>`;

    // Rank column (task 1): a display-only index sticky at the very left (after
    // the pin column). Its header is a plain "#". R5-B #3: the rank now reflects a
    // row's TRUE position in the base (un-floated) order, so a pinned player lifted
    // to the top still shows their real leaderboard rank; a no-data pin shows "—".
    const rankTh = `<th class="data-table__th data-table__th--rank" scope="col" title="Rank in current sort">#</th>`;

    // Player header (task 6): now a sortable column — clicking sorts by name
    // A–Z, then Z–A, with the same caret the metric headers show. Stays sticky
    // and is deliberately NOT draggable (no --draggable class). The sort +
    // mobile double-click-to-expand (task 7) listeners are wired below.
    const nameSorted = orderIsActiveSort && state.sort.key === "name";
    const nameArrow = nameSorted ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "";
    const playerTh = `<th data-key="name" class="data-table__th data-table__th--sticky ${nameSorted ? "is-sorted" : ""}" scope="col">
        <button type="button" class="data-table__sort-btn">Player${nameArrow}</button>
      </th>`;

    theadEl.innerHTML = `
      <tr>
        ${pinTh}
        ${rankTh}
        ${playerTh}
        ${cols.map((m) => headerCellHTML(m, state)).join("")}
      </tr>`;

    // R5-B #3: float pinned players to the top for DISPLAY only; `rows` (lastRows)
    // stays the base order. True leaderboard rank comes from the base order, so a
    // pinned player lifted to the top keeps their real rank (a no-data pin has none).
    const pinIds = new Set((state.pinnedPlayers || []).filter((p) => p && p.id).map((p) => String(p.id)));
    const rankById = new Map();
    rows.forEach((r, i) => rankById.set(String(r.id), i + 1));
    const displayRows = floatPinsToTop(rows, state);
    const pageRows = displayRows.slice(0, visibleRowCount);
    updateStickyColWidth(pageRows.map((r) => r.name ?? ""));

    tbodyEl.innerHTML = pageRows
      .map((row) => {
        const isPinned = pinIds.has(String(row.id));
        // Pin cell (R5-B #3/#12): toggles this player's pin; active/filled when pinned.
        const pinLabel = isPinned ? "Unpin player" : "Pin player to top";
        const pinTd = `<td class="data-table__td data-table__td--pin"><button type="button" class="pin-toggle${isPinned ? " is-pinned" : ""}" data-pin-id="${escAttr(row.id ?? "")}" data-pin-name="${escAttr(row.name ?? "")}" aria-pressed="${isPinned ? "true" : "false"}" title="${pinLabel}" aria-label="${pinLabel}">${PIN_GLYPH}</button></td>`;
        // Rank (task 1; R5-B #3): the row's TRUE position in the base order — a
        // floated pin keeps its real leaderboard rank; a synthetic no-data pin
        // (absent from the base order) shows "—". Continues unbroken across a
        // "Show More" reveal — no query, pure display.
        const rk = rankById.get(String(row.id));
        const rankTd = `<td class="data-table__td data-table__td--rank">${rk != null ? rk.toLocaleString() : "—"}</td>`;
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
        return `<tr>${pinTd}${rankTd}<td class="data-table__td data-table__td--sticky">${nameCell}</td>${cells}</tr>`;
      })
      .join("");

    // Show More (task 3): reveals the rest in one click, not another page.
    // Show top 50 (Round-6 item #12): the paired collapse, visible only once
    // the table has actually been expanded past PAGE_SIZE (visibleRowCount >
    // PAGE_SIZE — set by the Show More click above, and reset to PAGE_SIZE by
    // every fresh load()/re-sort per this file's own PAGE_SIZE comment), so
    // it never appears on a table that was never expanded in the first place.
    // The two buttons are mutually exclusive; the wrap itself only hides when
    // NEITHER applies (table fits within PAGE_SIZE outright).
    if (showMoreWrapEl && showMoreBtnEl) {
      const remaining = displayRows.length - pageRows.length;
      const isExpanded = visibleRowCount > PAGE_SIZE;
      showMoreWrapEl.hidden = remaining <= 0 && !isExpanded;
      showMoreBtnEl.hidden = remaining <= 0;
      if (remaining > 0) {
        showMoreBtnEl.textContent = `Show More (${remaining.toLocaleString()} player${remaining === 1 ? "" : "s"})`;
      }
      if (showTop50BtnEl) {
        showTop50BtnEl.hidden = !(remaining <= 0 && isExpanded);
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
      // R5-B #0: a column-header click IS a sort — the arrow shows on the clicked
      // column and the rows re-order by it.
      orderIsActiveSort = true;
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

    // Pin toggle (R5-B #3): clicking a row's pin cell pins/unpins that player —
    // an INSTANT toggle both ways (main.js pins via the same pinPlayer path the
    // results-search uses, unpins via unpinPlayer), so the row floats to the top
    // or drops back to its ranked slot immediately. stopPropagation keeps the
    // click off any surrounding row handler.
    if (onTogglePin) {
      tbodyEl.querySelectorAll(".pin-toggle").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          onTogglePin(btn.dataset.pinId, btn.dataset.pinName);
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

  async function load(scopeState = null, { resort = true, preserveSortFlag = false } = {}) {
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
    // R5-A #4: capture the currently-displayed row order BEFORE this load replaces
    // it, so a toolbar-only commit (resort:false) can preserve it.
    const prevRows = lastRows;
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

      // R5-A #4: a fresh re-sort (popup Search, or a first load with no prior
      // rows) uses applySort; a toolbar-only commit (resort:false — a Vs / preset
      // / column change) preserves the prior visual order via
      // reorderPreservingPrevious. Column-header clicks re-sort client-side
      // elsewhere (applySortKey), untouched by this.
      const doSort = resort || !prevRows || prevRows.length === 0;
      const sorted = doSort ? applySort(merged, state) : reorderPreservingPrevious(merged, prevRows, state);

      // R5-B #0: a genuine sort (doSort) makes the displayed order an active
      // column sort → the arrow shows; an order-preserving commit clears it.
      // A pin requery passes preserveSortFlag so pinning never flips the arrow
      // (the pin only floats a row on top; the non-pinned order is unchanged).
      if (!preserveSortFlag) orderIsActiveSort = doSort;

      // R5-B #3: `lastRows` is the BASE ordered array (NOT pin-floated) — the
      // pin float is applied at RENDER time (renderLoaded → floatPinsToTop), so
      // unpinning returns a player to their true ranked slot and reorderPreserving-
      // Previous preserves the un-floated order across a toolbar-only commit.
      lastRows = sorted;
      lastQueryStateKey = serializeQueryState(state);
      lastLoadedState = state; // F2: enterView() renders against this snapshot
      // Task 3: every fresh query (a search, a preset, a column/Vs change) is
      // "a new view of the data" — back to page 1.
      visibleRowCount = PAGE_SIZE;
      renderLoaded(sorted, state, bowlingTypes);
      // The columns popover (if open) lives outside `container` precisely so
      // this reload never destroys it (Batch 3 fix 3) — re-find its anchor in
      // the freshly-rendered toolbar, reposition, and re-sync checked state.
      columnsPicker.refresh(container.querySelector('[data-role="columns-btn"]'));
      // Pinned players with zero rows in this result set (task 3b, extended
      // 4d/A6): computed in BOTH plain and matchup mode — Wave 4b/decision 47a
      // routed buildMatchupQuery onto the same whereWithPinExemption/
      // gateWithPinExemption helper buildQuery uses, so a pinned id is exempt
      // from leaderboard-only filters in Vs mode too and can legitimately
      // still be "missing" only when it has no innings at all in the CORE
      // scope (gender/format/date/team-type) — an honest signal either way.
      // (This used to force `[]` for matchup mode, from before that Wave 4b
      // extension landed — stale now that the bypass applies there too.)
      // main.js's pinPlayer()/onPinsChanged() use this to annotate a no-data
      // pin's pill "(no innings)" and toast once per Search/pin-add.
      const missingPinnedIds = (state.pinnedPlayers || [])
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
      // a popover floating over an error box with no anchor (refresh() closes
      // when its anchor argument is null).
      columnsPicker.refresh(container.querySelector('[data-role="columns-btn"]'));
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
