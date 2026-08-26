// src/table.js
//
// Query builder + table renderer for Compare Stats (SPEC §5.3/§5.4). Builds ONE
// grouped query per the metrics.js contract, plus a separate player_matches
// query when the "matches" column is visible, joined in JS by player_id.
//
// hasMetricData (§8.1) is the ONLY no-data predicate — used both to gate
// advanced-filter conditions on rate/ratio metrics and to render "—" for
// no-data cells (NULL already renders "—"; this module never coalesces ratios).

import {
  getMetric,
  hasMetricData,
  matchupBucketLabel,
  paramExistenceHaving,
  resolveColumnMetric,
  isParamComposedColumnKey,
  isComposedFieldingColumnKey,
  // Stage-3 Phase 1.4: the cross-discipline columns dropdown's D4 family-collapse can
  // mint a CROSS-wrapped parametric column (x__<other>__isr__… / x__<other>__wh__…) —
  // the structural "keep alive" check its own-discipline sibling already has.
  isCrossParamComposedColumnKey,
  OTHER_DISCIPLINE,
  // City & Season everywhere (2026-08-16): the City / Season which-values column keys
  // — read mctx.city / mctx.season, so their presence must light the mctx join too.
  CITY_SET_KEY,
  SEASON_SET_KEY,
  // Event & Venue which-values column keys (completing City & Season everywhere,
  // 2026-08-16) — read mctx.event_name / mctx.venue, so their presence must light the
  // mctx join too (same gate the event__/venue__ composer columns already use).
  EVENT_SET_KEY,
  VENUE_SET_KEY,
  // Stage-3 Phase 1.1 (2026-08-25): the Stage / Toss-decision / Result-Condition
  // which-values column keys — each reads a DERIVED expression over the same mctx
  // columns (event_stage / toss_decision / method + is_super_over), so their presence
  // must light the same mctx join.
  MATCH_OUTCOME_SET_KEYS,
} from "./metrics.js";
import { query } from "./db.js";
import {
  buildScopeClausesTagged,
  bypassableClause,
  alwaysClause,
  whereWithPinExemption,
  whereWithLanes,
  gateWithPinExemption,
  buildMatchContextClauses,
  matchContextJoinSql,
  matchContextSubselectSql,
} from "./filters.js";
import { activeGroups } from "./advanced.js";
import { escHtml, escAttr } from "./html.js";
import { createColumnsPicker } from "./columnsPicker.js";
import { searchTeams, searchStages, searchEvents, searchVenues, searchCities, searchSeasons } from "./playerData.js";
// Standalone STAGE composer (Step 3, 2026-08-14): the composer's value picker offers
// CLEAN canonical stage names (owner ruling), so loadStageOptions folds searchStages'
// raw event_stage spellings to canonical — the SAME fold drawerInnings.js mountStage does.
// Step 4 (Event/Venue): searchEvents ALREADY returns canonical-folded event options
// (same fold as the Event FILTER's mountEvent) so loadEventOptions needs no extra
// canonical helper; searchVenues returns RAW venue names (venue has no fold anywhere).
import { canonicalStage } from "./canonicalNames.js";
import {
  eligibleColumnKeys,
  positionsFilterActive,
  oppositionFilterActive,
  inningsNumberFilterActive,
  matchContextActive,
  COLUMN_PRESET_DEFS,
  activePresetKey,
  matchupVsActive,
  effectiveNamespace,
  // Chunk 5 Phase 2 Wave B: the profile semi-join, reused VERBATIM as a HAVING/step-3
  // disjunct under player-lane "Match any" (WHERE→HAVING lowering) so the OR form can
  // never drift from the AND (WHERE) form.
  profileSemiJoinSql,
  escSql as esc,
  // E1a column slots: keys ⇄ slots helpers (the store holds Slot[]; the SACRED
  // builders + dirty key see keys; load() dedups to DISTINCT keys).
  slotKeys,
  distinctSlotKeys,
  reconcileSlots,
  // Wave D — D2: Option-B column-model engine (preset-on-pick + manual add/remove).
  applyLeaderboardPresetPatch,
  reconcileManualColumnEdit,
  // The Stage FILTER's "No Stage" sentinel value + its display label — reused (NOT
  // re-derived) so the Stage COMPOSER offers the same event_stage-IS-NULL option.
  STAGE_NONE,
  STAGE_NONE_LABEL,
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

/** The METRICS-catalogue namespace for the current state — used ONLY to RESOLVE a
 * column/sort key to its metric definition (label / format / higherIsBetter /
 * sqlExpression), NOT to key `state.columns[ns]`. Fielding (3rd scope) is the sole
 * divergence: its tallies (catches/stumpings/run_outs/dismissals_effected/matches)
 * are registered under "batting" (there is no "fielding" metrics discipline — see
 * metrics.js FIELDING_METRIC_SPECS), so metric lookups map fielding→"batting" while
 * the column STATE stays under effectiveDiscipline()="fielding" (state.columns.fielding).
 * This mirrors the player pop-up's fielding mode (playerFiltersTab.js: getDiscipline →
 * "batting", column state keyed "fielding"). For every non-fielding state it is exactly
 * effectiveDiscipline(state), so batting/bowling/matchup resolution is byte-identical. */
function metricNsFor(state) {
  return state.discipline === "fielding" ? "batting" : effectiveDiscipline(state);
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
    opposition: state.opposition,
    event: state.event,
    // eventSeasons narrows the event clause (Event → Season picker), so it belongs
    // in this key exactly as `event` does — without it, changing a season left the
    // Search button unlit and the render cache stale (defect found in this pass).
    eventSeasons: state.eventSeasons,
    venue: state.venue,
    // City / Season (City & Season everywhere, 2026-08-16): additive match-level scope
    // filters that change the emitted WHERE, so toggling either alone must re-light
    // Search + bust the render cache, exactly like venue above. Omitted originally (the
    // City/Season wave forgot them here); fixed in Chunk 5 Phase 2 Wave B. Both default
    // to [] so this serialises identically for every existing state.
    city: state.city,
    season: state.season,
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
    // Lane match-mode (Chunk 5 Phase 2 Wave A): filterMatch.scope changes the emitted
    // WHERE (Match all vs Match any across scope filters), so toggling it must re-light
    // Search + bust the render cache, exactly like the scope filters themselves. Default
    // {player:"AND",scope:"AND"} serialises identically for every existing state.
    filterMatch: state.filterMatch,
    // Delivery window (Wave 3): a numbers-defining filter (the ball-engine window) —
    // a change must re-light Search + bust the render cache, exactly like matchupVs.
    // This is change-detection only; buildQuery/buildScopeClauses are untouched.
    deliveryWindow: state.deliveryWindow,
    pinnedPlayers: state.pinnedPlayers,
    search: state.search,
    // R4 Wave 4a (A1): `sort` is deliberately EXCLUDED. Clicking a column header
    // now re-sorts the loaded rows INSTANTLY (sortByColumn) and must NOT
    // light the Search button — since nothing PENDING ever changes the sort key
    // on its own (a discipline change lights Search via `discipline` here
    // regardless), leaving sort out of the dirty comparison is the whole fix.
    // `columns` STAYS in: the PENDING preset dropdown sets it and must keep
    // lighting Search — the INSTANT Columns picker / drag-reorder instead advance
    // the applied snapshot (onColumnsApplied) so THEY read as not-dirty.
    columns: slotKeys(state.columns[ns]), // E1a: serialize the KEY list (identity ids
    // are not a user-visible column choice) → dirty detection stays byte-identical
    // to the key-array era; per-slot mode is captured (the key IS the variant).
    advanced: state.advanced,
  });
}

/** Preferred display order for the fine "Bowling type" optgroup: named styles
 * in cricket-sensible order (pace-first — owner #9), then any unlisted style
 * alphabetically, then the bare pace/spin buckets last (decision 24 —
 * bare-slow bowlers surface here as the group name, labelled "…(unspecified)"
 * via matchupBucketLabel). */
const BOWLING_TYPE_PREFERENCE = [
  "Fast",
  "Fast-medium",
  "Medium-fast",
  "Medium",
  "Slow-medium",
  "Off-spin",
  "Leg-spin",
  "Slow left-arm orthodox",
  "Left-arm wrist-spin",
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

  // E1a (owner-authorized single read-swap): read the KEYS from the column slots.
  // Provably byte-identical — slotKeys yields the same metric keys in the same
  // order, and this function already dedups keys (seenKeys/keyOrder) + preserves
  // order, so the emitted matchup SQL is unchanged. NOTHING else in buildMatchupQuery
  // is touched.
  const ownCols = slotKeys(state.columns[ns] || []);
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
  // is a placeholder, never interpolated (kind === "composition").
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
  // own two player-shortlisting filters (team/profile), and the name
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
    // Chunk 5 Phase 2 Wave A: match-context clauses are lane "scope" (they select
    // WHICH matches are measured, like opposition/event/venue), so they join the
    // scope-OR disjunction under "Match any". Tagging is SQL-invisible (alwaysClause
    // sets bypassable:false, exactly as pushing the bare string did) → byte-identical.
    for (const c of buildMatchContextClauses(state, teamCol)) whereClauses.push(alwaysClause(c, "scope"));
  }
  // The FROM used by both `agg` and the peak CTE: base view + optional mctx join.
  const matchupFrom = wantsMatchContext ? view + matchContextJoinSql(view) : view;

  // Pinned players (Wave 4b, decision 47a): additive — a pinned player is scanned
  // as long as they have a row that passes every ALWAYS-APPLIES clause above
  // (core scope + opposition + striker position + event/venue + match context),
  // bypassing only the player-shortlisting ones (team/profile/search),
  // exactly as buildQuery
  // does. The bucket predicate is NOT in this WHERE (it is a per-aggregate FILTER),
  // so pins keep it automatically. With no pins this is byte-identical to the
  // former `whereClauses.join(" AND ")`.
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  // Chunk 5 Phase 2 Wave A/B — byte-identity guard. When BOTH lanes are "Match all"
  // (the default), run today's EXACT whereWithPinExemption line → byte-identical by
  // construction. A scope-lane "Match any" (Wave A) or a player-lane "Match any"
  // (Wave B) takes the whereWithLanes branch: scope-OR builds the scope disjunction;
  // player-OR DROPS the profile semi-join from the WHERE (it is re-emitted as a step-3
  // disjunct below — WHERE→HAVING lowering). With both AND the branch is unreachable.
  const filterMatch = state.filterMatch || { player: "AND", scope: "AND" };
  const whereSql =
    filterMatch.scope === "AND" && filterMatch.player === "AND"
      ? whereWithPinExemption(whereClauses, idCol, pins)
      : whereWithLanes(whereClauses, {
          idColumn: idCol,
          pins,
          scopeOp: filterMatch.scope,
          playerOp: filterMatch.player,
        });

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
  // Chunk 5 Phase 2 Wave B — player-lane "Match any". Matchup's two player-lane
  // members are the profile semi-join (lowered from the step-1 WHERE above; suppressed
  // there by whereWithLanes' playerOp) and the numeric stat block (`advWhere`); there
  // is no PotM(Y/N) term in matchup mode. Under player-OR they OR together. The
  // semi-join runs over `windowed`, where the id column is projected as `id`, so it
  // references `id` (a legal post-aggregation membership test, all-or-nothing per
  // player). Each block is a disjunct ONLY when active, so a single active block reads
  // exactly like the AND path; the bucket-existence gate (`>= 1`) still ALWAYS applies
  // (it is query-grain, not a player-lane filter). player-AND keeps today's EXACT line
  // → byte-identical.
  if (filterMatch.player === "OR") {
    const disjuncts = [profileSemiJoinSql(state, "id"), advWhere].filter(Boolean).map((s) => `(${s})`);
    // Wrap the WHOLE disjunction in an outer paren before it is AND-ed with the
    // bucket-existence gate (`inningsGateAlias >= 1`): SQL binds AND tighter than
    // OR, so without this the gate would attach to only the FIRST disjunct
    // (`(gate AND profile) OR numeric`) — wrong. With the paren it reads
    // `gate AND (profile OR numeric)`, matching the player-lane "Match any" intent.
    if (disjuncts.length) finalWhereParts.push(`(${disjuncts.join(" OR ")})`);
  } else if (advWhere) {
    finalWhereParts.push(advWhere);
  }
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
  // Composition columns (Coverage-breakdown wave) are descriptive display-only
  // percentages with a placeholder sqlExpression (see metrics.js) — never a
  // usable stat condition. advanced.js already excludes them from the picker;
  // this belt-and-braces guard keeps a stray composition-keyed condition from
  // ever reaching SQL (returns null, so advancedToHaving simply drops it).
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
  // Parametrised threshold metrics (Innings Score / Wicket Hauls) — R2 (2026-08-09):
  // the operator now applies to the PER-INNINGS quantity (runs / wickets), and the
  // filter is an EXISTENCE gate — the player has >= 1 innings whose quantity
  // satisfies operator + value(s) (>= / <= / = / between). paramExistenceHaving
  // compiles `((<count-column SQL for (op, values)>) >= 1)`, reusing the SAME
  // composed-column builder a matching "# innings …" count column uses, so a
  // parametric filter and its auto-added column can never disagree. The operator +
  // value(s) live on the SAME fields every numeric condition uses (cond.operator /
  // cond.v1, + cond.v2 for between); the old separate score-threshold box (cond.n)
  // and count operator/value are retired. These metrics exist only in the plain
  // batting/bowling namespaces (getMetric above returns null in matchup mode), so
  // this branch is plain-path only — resolveComposedParamMetric returns null for any
  // other discipline, degrading to a dropped row rather than a wrong number.
  if (metric.paramTemplate && metric.param) {
    const vals = cond.operator === "between" ? [cond.v1, cond.v2] : [cond.v1];
    return paramExistenceHaving(metric, cond.operator, vals, discipline);
  }
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

/** THE stat-condition group/AND-OR assembly — one copy, shared by the two entry
 * points that compile the advanced ("Catches >= 20 / Average >= 30") conditions:
 * `advancedToHaving` (batting/bowling/matchup HAVING) and `buildFieldingCountGate`
 * (the fielding board's outer WHERE). Both must always render operator / between /
 * AND-OR semantics identically, so the assembly lives here rather than in two
 * hand-synchronised copies.
 *
 * `condToSql(cond)` maps ONE condition to its predicate string, or null to DROP it
 * (an unsupported metric in this namespace, an unknown operator, a display-only
 * column) — so a group whose every condition drops contributes nothing, and an
 * all-dropped set returns null, leaving the caller's query byte-identical.
 * `orAll` forces BOTH joiners — the within-group `g.op` and the across-group
 * `advanced.op` — to OR; it is how the fielding board's degenerate player lane
 * implements "Match any" (see buildFieldingCountGate). Default false keeps the
 * authored joiners verbatim.
 *
 * NULL CONTRACT: this reads `advanced.groups` through activeGroups(), so a null /
 * undefined `advanced` THROWS. That is deliberate — each caller owns its own
 * contract (buildFieldingCountGate guards, advancedToHaving does not, exactly as
 * before). Private: the two named entry points are the only callers. */
function assembleConditionGroups(advanced, condToSql, { orAll = false } = {}) {
  const groups = activeGroups(advanced);
  if (groups.length === 0) return null;
  const parts = groups
    .map((g) => {
      const condSql = g.conds.map((c) => condToSql(c)).filter(Boolean);
      if (condSql.length === 0) return null;
      const joiner = orAll || g.op === "OR" ? " OR " : " AND ";
      return condSql.length > 1 ? `(${condSql.join(joiner)})` : condSql[0];
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  const topJoiner = orAll || advanced.op === "OR" ? " OR " : " AND ";
  return parts.length > 1 ? `(${parts.join(topJoiner)})` : parts[0];
}

function advancedToHaving(advanced, discipline, exprFn) {
  return assembleConditionGroups(advanced, (c) => conditionToHaving(c, discipline, exprFn));
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
/** Result-family metric(s) (Matches Won/Lost/Tied/No-result/Toss Won, source
 * "result", columns content rework Wave B) — surfaced via the per-player
 * `result_cte` join. Exported so the Graph Builder's per-player fetch
 * (graph/charts.js) attaches the IDENTICAL join with the SAME predicate. */
export const isResultMetric = (m) => m && m.source === "result";
/** Per-match fielding metric(s) (catches_per_match, …, columns content rework Wave
 * C) — a fielding COUNT ÷ Player Matches, so its sqlExpression references BOTH
 * fielding_cte (source "fielding_events", so isFieldingEventMetric already lights up
 * the fielding join) AND the per-player match-count `pmatch_cte`. This predicate
 * gates the ADDITIONAL pmatch_cte build+join. Exported so the Graph Builder's
 * per-player fetch attaches the IDENTICAL join with the SAME predicate. */
export const isPerMatchMetric = (m) => m && m.perMatch === true;
/** Player-profile ATTRIBUTE metric(s) (Playing role / Detailed role / Batting hand
 * / Bowling style / Bowling hand, source "profiles", Wave D — D1) — surfaced via
 * the per-player `profile_cte` join, the SAME per-player LEFT-JOIN + MAX() shape as
 * pom_cte/result_cte. They are player-level CONSTANTS (text), never innings
 * aggregates, so they are EXCLUDED from inningsMetrics and projected alongside the
 * fielding/pom/result columns. Exported for the same graph-fetch reuse posture. */
export const isProfileMetric = (m) => m && m.source === "profiles";

/** SQL WHERE predicates for the fielding SLICE conditions (fielding rebuild) —
 * the fielding metric's OWN dims, applied inside `fielding_cte` so the
 * Catches/Stumpings/Run-outs/Dismissals-Effected totals count only the sliced
 * events. Reads `state.fielding`: the original trio { positions, kinds, phases }
 * (multi-select lists, mirroring the app's existing position/opposition pickers)
 * PLUS the T-3a-ext full filter set appended by buildFieldingExtraSliceClauses
 * (out_hand/out_batter_id/bowler_id/bowler_style/city/innings_number/
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
 * DIRECT columns on the `fielding` view (fielding_events): out_hand,
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
 * Cleanup Item E — the ONE fielding scope-lane WHERE assembly, shared by the fielding
 * TALLIES (buildFieldingCteSql) and their per-match DENOMINATOR
 * (buildFldMatchesCteSql). Until this merge the two were separate verbatim copies of
 * these same two branches, agreeing only by hand; they MUST always agree or a per-match
 * fielding rate divides by a differently-scoped count. Verified character-identical
 * across all 32 states before merging ({scope Match all, Match any} × {no slice,
 * position slice, kind+phase slice, the full T-3a-ext slice set incl. the correlated
 * match-context EXISTS} × {no pins, 2 pins} × {no name search, name search}).
 *
 * Chunk 5 Phase 2 Wave C — Part 2 (fielding SCOPE-lane OR). The fielding scope has
 * three sources: the tagged core/scope clauses from buildScopeClausesTagged
 * (opposition/event/venue/team + core gender/format/date/team-type), the fielding
 * SLICE dims (buildFieldingSliceClauses — dismissal kind/phase/position + the T-3a-ext
 * dims incl. the correlated match-context EXISTS), and the always-applies "substitute
 * IS NOT TRUE" eligibility guard.
 *
 *   • scope "Match all" (default) → today's EXACT assembly, BYTE-IDENTICAL. "substitute
 *     IS NOT TRUE" and the slice conditions are AND'd **OUTSIDE the pin exemption** —
 *     they define WHAT is counted (like a phase column), so they apply to every fielder
 *     including pins; pins only bypass the who/which-match scope above. That ordering is
 *     deliberate: "tidying" it by folding the slices into the pin wrap changes numbers.
 *   • scope "Match any" → the fielding dims join the SAME scope-OR disjunction the
 *     batting/bowling boards use (Wave A whereWithLanes): every scope filter ORs, the
 *     union is measured over pins too, and "substitute IS NOT TRUE" stays a "core"
 *     always-AND guard — never an OR participant, because it defines eligibility, not
 *     scope. The OR path reuses the EXACT predicate strings the AND path builds, so an
 *     OR clause can never drift from its AND form.
 *
 * `playerOp` is hardcoded "AND" (NOT read from state.filterMatch.player): the profile
 * semi-join (category "player") is never lowered here, because the fielding player lane
 * is the OUTER count gate (Wave C Part 1), so profile stays a player-shortlisting AND in
 * the pin-exempt remainder. There is no HAVING on either of these CTEs to re-emit a
 * lowered profile clause into.
 */
function fieldingScopeWhere(state, { fldClauses, sliceClauses, pins }) {
  const filterMatch = state.filterMatch || { player: "AND", scope: "AND" };
  if (filterMatch.scope !== "OR") {
    const fldScopeSql = whereWithPinExemption(fldClauses, "fielder_id", pins);
    return [fldScopeSql, "substitute IS NOT TRUE", ...sliceClauses].join(" AND ");
  }
  const combined = [
    ...fldClauses,
    ...sliceClauses.map((c) => alwaysClause(c, "scope")),
    alwaysClause("substitute IS NOT TRUE", "core"),
  ];
  return whereWithLanes(combined, { idColumn: "fielder_id", pins, scopeOp: "OR", playerOp: "AND" });
}

/**
 * Build the `fielding_cte` definition (the CTE body WITHOUT the leading
 * "WITH " — the caller prepends/comma-joins it, like the other per-player CTEs).
 * One row per fielder over the EVENT-GRAIN `fielding` view, honoring the FULL
 * leaderboard scope — core (gender/format/date/team-type) + team (fielding_team)
 * + OPPOSITION + event/venue + profile, pin-exempt — PLUS the fielding SLICE
 * conditions (dismissed-batter position / dismissal kind / phase), substitutes
 * excluded. Pins are read from state (the same filter buildQuery applies) so a
 * pinned player keeps their fielding numbers under the player-shortlisting
 * filters (team / profile / search) while still obeying opposition,
 * event, venue and match context like every other row.
 *
 * Extracted verbatim from buildQuery (was inline) so the Graph Builder's
 * per-player fetch (graph/charts.js) can attach the IDENTICAL join when a
 * fielding-event metric is charted — the CTE can never diverge between the Stats
 * table and the graph. buildQuery's emitted SQL is byte-identical to before the
 * extraction (verified by a node harness diff across every scenario).
 */
export function buildFieldingCteSql(state, composedFieldingCols = [], opts = {}) {
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
  // Chunk 5 Phase 2 Wave C — Part 2 (fielding SCOPE-lane OR), assembled by the SHARED
  // fieldingScopeWhere (cleanup Item E) so these tallies and the per-match denominator
  // underneath them (buildFldMatchesCteSql) can never be scoped differently. See that
  // helper for the two branches, the deliberate slices-outside-the-pin-wrap ordering, and
  // why playerOp is pinned "AND" here.
  const whereSql = fieldingScopeWhere(state, {
    fldClauses,
    sliceClauses: fieldingSliceClauses,
    pins,
  });
  // Base per-fielder tally columns (SACRED — byte-identical output). The four
  // lines carry NO trailing comma; the array is comma-joined below so appending
  // composed columns needs no edit to these lines.
  const selectCols = [
    "         SUM(CASE WHEN kind IN ('caught','caught and bowled') THEN 1 ELSE 0 END) AS catches",
    // Distinct caught-&-bowled count (Wave R2d): the c&b subset of `catches` above
    // (which deliberately still folds c&b in — unchanged). Lets "Fielding Wicket
    // Type ▸ Caught & bowled" filter on c&b alone. Purely additive: existing
    // catches/stumpings/run_outs outputs are byte-identical.
    "         SUM(CASE WHEN kind = 'caught and bowled' THEN 1 ELSE 0 END) AS caught_and_bowled",
    "         SUM(CASE WHEN kind = 'stumped' THEN 1 ELSE 0 END) AS stumpings",
    "         SUM(CASE WHEN kind = 'run out' THEN 1 ELSE 0 END) AS run_outs",
  ];
  // Fielding composers (FC-1): inject one SUM(CASE …) column per REQUESTED fc__
  // column, so the composed column's `MAX(fielding_cte.<alias>)` projection has a
  // real CTE column. Each metric carries fieldingCteAlias + fieldingCteCaseSql
  // (metrics.js buildComposedFieldingMetric); the count and per-match variants of
  // one composer share an alias, so we dedup. ADDITIVE + sacred-safe: with no fc__
  // column requested this loop adds nothing, so `selectCols` — and the whole
  // emitted CTE string — is BYTE-IDENTICAL to before this wave (the four base
  // lines join to the exact former text). The composed CASE inherits the CTE's
  // scope/slice WHERE automatically (it lives in the same aggregation).
  const seenAlias = new Set();
  for (const m of composedFieldingCols || []) {
    if (!m || !m.fieldingCteAlias || !m.fieldingCteCaseSql || seenAlias.has(m.fieldingCteAlias)) continue;
    seenAlias.add(m.fieldingCteAlias);
    selectCols.push(`         ${m.fieldingCteCaseSql} AS ${m.fieldingCteAlias}`);
  }
  // Fielding-as-3rd-scope (opts.includeName): project the fielder's NAME so the CTE can
  // stand alone as a BASE table (the leaderboard's fielding ranking selects it directly
  // — buildFieldingLeaderboardQuery — rather than reading it off a joined batting/bowling
  // view). MAX() keeps GROUP BY at `fielder_id` alone, so the per-fielder tallies are
  // BYTE-IDENTICAL (an extra aggregate projection over the same groups changes no group
  // and no other aggregate). DEFAULT-OFF: with includeName falsy this line is never added,
  // so the emitted CTE string is byte-identical for the three existing callers (buildQuery
  // bolt-on, graph/charts.js, the pop-up's buildFieldingRowQuery — all call with ≤2 args).
  if (opts && opts.includeName) {
    selectCols.push("         MAX(fielder_name) AS fielder_name");
  }
  // Fielding cols Wave 2b (Group B): a list column over a MATCH-LEVEL value absent from
  // the fielding view (Season, Stage, Match/Toss result, Toss decision) needs the match
  // row. Bring it in with a 1:1 LEFT JOIN on match_id — unique in `matches`, so NO row
  // fan-out: `GROUP BY fielder_id` still aggregates the EXACT same fielding rows and
  // every SUM(CASE) tally (+ MAX(fielder_name)) is BYTE-IDENTICAL. The sub-select renames
  // match_id → mctx_match_id (so the CTE's bare `match_id` refs — e.g. the Season SLICE
  // semi-join — stay unambiguous) and projects ONLY match-level columns (season /
  // event_stage / toss_decision / match_winner / result_type / toss_winner), NONE of
  // which is a fielding-view column or a bare ref in this CTE body → zero ambiguity, even
  // alongside the Group-A list columns (which read other bare fielding columns) and the
  // player-relative result/toss list columns (which compare the bare `fielding_team`).
  // Added ONLY when a Group-B list column is requested, so the default board / fc__-only /
  // Group-A-only CTE is byte-identical, as are the ≤2-arg callers (graph, pop-up: no
  // needsFieldingMctx col).
  const needMctxJoin = (composedFieldingCols || []).some((m) => m && m.needsFieldingMctx);
  const fromLines = ["  FROM fielding"];
  if (needMctxJoin) {
    fromLines.push(
      "  LEFT JOIN (SELECT match_id AS mctx_match_id, season, event_stage, toss_decision," +
        " match_winner, result_type, toss_winner FROM matches) fld_mctx" +
        " ON fld_mctx.mctx_match_id = fielding.match_id"
    );
  }
  return [
    "fielding_cte AS (",
    "  SELECT fielder_id AS fld_player_id,\n" + selectCols.join(",\n"),
    ...fromLines,
    `  WHERE ${whereSql}`,
    "  GROUP BY fielder_id",
    ")",
  ].join("\n");
}

/**
 * ⚠ RETIRED as of Stage-3 Phase 2.2 (owner ruling 2, 2026-08-24) — NO RUNTIME CONSUMERS.
 * The former fielding "Matches" honesty switch (un-narrowed → pmatch appearances;
 * narrowed → matches-with-a-credit fld_matches_cte). Owner ruling 2 supersedes decision
 * 73: the Matches column now ALWAYS shows ALL matches played in the filtered set (the
 * Phase-2.1 filtered pmatch_cte), so both call sites (buildFieldingLeaderboardQuery, the
 * pop-up's buildFieldingRowQuery) dropped this switch and buildFldMatchesCteSql below.
 * KEPT undeleted pending the orchestrator's disposition call (see the Phase-2.2 report's
 * fld_matches_cte consumer trace). Safe to remove together with buildFldMatchesCteSql.
 */
export function fieldingMatchesNarrowed(state) {
  return oppositionFilterActive(state) || buildFieldingSliceClauses(state).length > 0;
}

/**
 * ⚠ RETIRED as of Stage-3 Phase 2.2 — NO RUNTIME CONSUMERS (see fieldingMatchesNarrowed
 * above). The `fld_matches_cte` body: COUNT(DISTINCT match_id) over the FILTERED
 * `fielding` rows (matches with ≥1 credit in scope) — the "matches-with-a-credit"
 * denominator the narrowed switch used before owner ruling 2 made the Matches column
 * "all matches played". KEPT undeleted pending the orchestrator's disposition call.
 */
export function buildFldMatchesCteSql(state) {
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const fldClauses = buildScopeClausesTagged(state, {
    includeTeams: true,
    teamColumn: "fielding_team",
    idColumn: "fielder_id",
    oppositionColumn: "opposition",
  });
  if (state.search && state.search.trim()) {
    fldClauses.push(bypassableClause(`fielder_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }
  // Chunk 5 Phase 2 Wave E / cleanup Item E — this denominator's scope is now the SAME
  // FUNCTION buildFieldingCteSql's tallies use (fieldingScopeWhere), not a hand-kept
  // mirror of it, so the count can never be scoped differently from the tallies it sits
  // beside. Note it is NOT a blind whereWithLanes swap: "substitute IS NOT TRUE" and the
  // fielding SLICE clauses sit OUTSIDE the pin wrap — see the helper.
  const matchesWhere = fieldingScopeWhere(state, {
    fldClauses,
    sliceClauses: buildFieldingSliceClauses(state),
    pins,
  });
  return [
    "fld_matches_cte AS (",
    "  SELECT fielder_id AS fld_player_id, COUNT(DISTINCT match_id) AS matches",
    "  FROM fielding",
    `  WHERE ${matchesWhere}`,
    "  GROUP BY fielder_id",
    ")",
  ].join("\n");
}

/**
 * Chunk 5 Phase 2 Wave E / cleanup Item D — shared lane-scope compiler for the five
 * secondary-CTE / secondary-query sites that must track the MAIN query's Match
 * all/any union (pom_cte, result_cte, pmatch_cte, xdisc_cte, and buildQuery's
 * "matches" secondary query). Computes pins from state.pinnedPlayers and reads
 * state.filterMatch (defaulting to {player:"AND", scope:"AND"}), then delegates to
 * whereWithLanes: All-AND (default) delegates VERBATIM to whereWithPinExemption →
 * byte-identical; scope-OR ORs the tagged scope clauses; player-OR drops the
 * profile ("player") clause from the WHERE (the caller re-emits it elsewhere as a
 * HAVING disjunct, so the caller's count/lookup is supplied over the same union of
 * surviving players as the main stats). `playerOp` lets a caller override the
 * player lane — used only by buildPmatchCteSql's fielding-board callers, which pass
 * "AND" deliberately (Wave C) to keep the per-match denominator's profile clause an
 * always-AND shortlister, matching the tallies it divides regardless of the user's
 * player lane. NOT used by the two guarded main-WHERE ternaries (buildMatchupQuery /
 * buildQuery) or the fielding two-branch scope-OR assemblies — those stay verbatim.
 */
function laneScope(clauses, state, { idColumn, playerOp } = {}) {
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const filterMatch = state.filterMatch || { player: "AND", scope: "AND" };
  return whereWithLanes(clauses, {
    idColumn,
    pins,
    scopeOp: filterMatch.scope,
    playerOp: playerOp || filterMatch.player,
  });
}

// ── Stage-3 Phase 4 — Match-any pill lane classification (display-only, decision
// 77.3) ───────────────────────────────────────────────────────────────────────
// When a lane's "Match any" toggle is on, pills.js's applied-pill row must show
// which pills are actually being OR'd together and which ALWAYS apply regardless
// (owner-approved mock, Option C, condensed to one line). This function is the
// single read-only mapping from a pill's KEY (pills.js's own vocabulary) onto the
// SAME "scope"/"player" category tags whereWithLanes/laneScope already compile
// into SQL above — it duplicates no query logic, builds no SQL, and is never
// called by any query path; pills.js calls it purely to choose which pills to
// visually group.
//
//   "scope"  — folds into the scope-lane OR when filterMatch.scope === "OR":
//              Team / Opposition / Innings Number / Event / Venue / City /
//              Season / Batting position (all tagged category "scope" in
//              buildScopeClausesTagged, filters.js) + Result / Toss result /
//              Toss decision / Stage / Result condition (each its own
//              alwaysClause(…, "scope") at the buildMatchContextClauses call
//              sites above) + every fielding-dim pill (fieldingScopeWhere above
//              tags the fielding slice clauses "scope" the same way).
//   "player" — folds into the player-lane OR when filterMatch.player === "OR":
//              the player-profile pills (role / batting hand / bowling style /
//              bowling arm — the ONE profile semi-join, tagged category "player"
//              in buildScopeClausesTagged), lowered to a HAVING disjunct by the
//              table.js callers under player-OR.
//   null     — NEVER folds into either lane's OR, regardless of filterMatch:
//              the delivery-window pills (Phase / Over range / Ball range /
//              Player balls) and the opponent-player "vs {name}" matchup pill
//              are baked into the ball VIEW itself before any WHERE is built
//              (db.js/deliveryWindow.js, db.js/opponentFilter.js) — decision
//              77.3's two named "always applies" exceptions (Ball Ranges +
//              matchup Vs). The free-text name search, the PotM Y/N gate, and
//              the numeric stat-condition pills are untagged/HAVING-gated and
//              also never fold into either lane's OR, so they classify here too.
export function pillMatchAnyLane(key) {
  if (
    key.startsWith("team:") ||
    key === "opposition" ||
    key === "inn_num" ||
    key.startsWith("event:") ||
    key.startsWith("venue:") ||
    key.startsWith("city:") ||
    key.startsWith("season:") ||
    key === "positions" ||
    key === "mc_result" ||
    key === "mc_toss_result" ||
    key === "mc_toss_decision" ||
    key === "mc_stage" ||
    key === "mc_result_condition" ||
    key.startsWith("fld_")
  ) {
    return "scope";
  }
  if (key.startsWith("profile:")) return "player";
  return null;
}

/**
 * Build the `pom_cte` definition (Player-of-the-Match, source player_matches) —
 * same "CTE body without leading WITH" convention as buildFieldingCteSql. A
 * whole-match award, so it stays on player_matches (which has no opposition/
 * position column): scope is core + team + event/venue + profile,
 * pin-exempt — the SAME options the "matches" secondary query uses, so PoM and
 * matches never diverge on scope. Extracted verbatim from buildQuery; buildQuery
 * output stays byte-identical (verified).
 */
export function buildPomCteSql(state) {
  const pomClauses = buildScopeClausesTagged(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" });
  // Stage-3 Phase 2.3 (owner-ruled, audit7 ruling 3): the ADDITIVE match-selecting
  // clauses so the PotM count OBEYS the board's OWN top-level filters (opposition +
  // stage/result/toss/result-condition) — the same set buildQuery narrows the main
  // numbers by. Tagged "scope" so laneScope's OR path picks them up; empty when no
  // match-selecting filter is active → byte-identical. Pushed before the name search
  // (mirrors buildResultCteSql / buildPmatchCteSql). EXISTS shape (not a mctx LEFT JOIN)
  // so pom_cte, which carries no mctx join, matches result_cte's scope predicate exactly.
  for (const c of buildBoardDivisorMatchClauses(state)) pomClauses.push(c);
  if (state.search && state.search.trim()) {
    pomClauses.push(bypassableClause(`player_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }
  // Chunk 5 Phase 2 Wave E — lane-consistent scope (see laneScope): this PotM count
  // tracks the MAIN query's Match all/any union, consistent with the main stats.
  const pomWhereSql = laneScope(pomClauses, state, { idColumn: "player_id" });
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
 * Build the `profile_cte` definition (Wave D — D1) — a per-player lookup of the
 * five PLAYER-PROFILE attributes (Playing role / Detailed role / Batting hand /
 * Bowling style / Bowling hand) from the `profiles` view, LEFT-JOINed by player id
 * into the batting/bowling GROUP BY and projected as MAX(profile_cte.pr_<field>).
 *
 * Unlike pom_cte / result_cte, it carries NO scope WHERE: `profiles` is a static
 * one-row-per-player ATTRIBUTE table (verified: 7,220 rows = 7,220 distinct
 * player_ids — no fan-out), with no gender/format/date/team columns to scope by.
 * A player's role/hand/style is a constant of who they are, so the outer query's
 * own WHERE (which players survive) is the only restriction needed; the 1:1 join
 * never multiplies innings rows, so every existing aggregate stays byte-identical.
 * Each field is aliased `pr_<field>` (the collision-safe prefix xdisc_cte's xd_ /
 * fielding_cte's fld_ use) so an unqualified scope-clause column can never bind to it,
 * and the join key `player_id` is aliased `profile_player_id` (never batter_id/
 * bowler_id). Built + joined ONLY when ≥1 profile column is visible (buildQuery's
 * wantsProfile gate); with none, buildQuery emits byte-identical SQL. There is no
 * advanced-condition leg — profile attributes are COLUMNS, never filter conditions.
 */
export function buildProfileCteSql() {
  return [
    "profile_cte AS (",
    "  SELECT player_id AS profile_player_id,",
    "         role_group AS pr_role_group,",
    "         role_subgroup AS pr_role_subgroup,",
    "         batting_style AS pr_batting_style,",
    "         bowling_type AS pr_bowling_type,",
    "         bowling_arm AS pr_bowling_arm",
    "  FROM profiles",
    ")",
  ].join("\n");
}

/**
 * Build the `result_cte` definition (columns content rework Wave B) — per-player
 * counts of MATCH OUTCOMES relative to the player's own team (Matches Won / Lost /
 * Tied / No-result / Toss Won). Same "CTE body without leading WITH" convention as
 * buildPomCteSql. A whole-MATCH fact, so it sits on `player_matches` (one row per
 * match the player played, carrying their own `team`) with the SAME scope options
 * pom_cte / the "matches" query use — core (gender/format/date/team-type) + team +
 * event/venue + profile, pin-exempt, plus the name search — so Result
 * columns partition Player Matches and never diverge from PoM/matches on scope.
 *
 * The outcome fields come from a 1:1 LEFT JOIN of the SHARED matchContextSubselectSql()
 * (aliased `mctx`, with match_id RENAMED → mctx_match_id — the same collision-safe
 * key fielding_cte/pom_cte use). NONE of mctx's projected columns
 * (match_winner/result_type/toss_winner/…) shares a name with any player_matches
 * column, and match_id is renamed, so every unqualified scope-clause column
 * (player_id/team/gender/match_type/match_date/match_id) resolves unambiguously to
 * player_matches. The join is 1 match per match_id, so it never multiplies rows.
 *
 * The five CASE predicates are byte-for-byte the "Match Result" / "Toss Result"
 * FILTER comparisons (filters.js buildMatchContextClauses, comparing the row's own
 * team to the match fields), so a Result column and its filter reconcile by
 * construction. Built ONLY when a Result column/condition is present (buildQuery's
 * wantsResult gate); with none, buildQuery emits byte-identical SQL.
 */
export function buildResultCteSql(state) {
  const resClauses = buildScopeClausesTagged(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" });
  // Stage-3 Phase 2.3 (owner-ruled, audit7 ruling 3): the ADDITIVE match-selecting
  // clauses so the Won/Lost/Tied/No-result/Toss-Won counts OBEY the board's OWN
  // top-level filters (opposition + stage/result/toss/result-condition) — the same set
  // buildQuery narrows the main numbers by. Tagged "scope" so laneScope's OR path picks
  // them up; empty when no match-selecting filter is active → byte-identical. Pushed with
  // the scope lane, before the name search (mirrors buildPmatchCteSql).
  for (const c of buildBoardDivisorMatchClauses(state)) resClauses.push(c);
  if (state.search && state.search.trim()) {
    resClauses.push(bypassableClause(`player_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }
  // Chunk 5 Phase 2 Wave E — lane-consistent scope (see laneScope, same rationale as
  // buildPomCteSql): these Match-Result counts track the same union of surviving
  // players as the main stats.
  const resWhereSql = laneScope(resClauses, state, { idColumn: "player_id" });
  return [
    "result_cte AS (",
    "  SELECT player_id AS res_player_id,",
    // `total` (Wave C): the player's TOTAL matches in scope — the DENOMINATOR of
    // the Result % metrics (res_*_pct = MAX(result_cte.<outcome>)*100/NULLIF(MAX(
    // result_cte.total),0)). COUNT(DISTINCT match_id) over player_matches = the same
    // Player Matches count the outcome counts partition, so a Result % reconciles
    // with its count column and with the Matches column by construction. Additive:
    // an unused column when only count Result columns are shown, and result_cte is
    // still built ONLY under wantsResult, so no-Result queries stay byte-identical.
    "         COUNT(DISTINCT match_id) AS total,",
    "         SUM(CASE WHEN team = mctx.match_winner THEN 1 ELSE 0 END) AS won,",
    "         SUM(CASE WHEN mctx.match_winner IS NOT NULL AND mctx.match_winner <> team THEN 1 ELSE 0 END) AS lost,",
    "         SUM(CASE WHEN mctx.result_type = 'tie' THEN 1 ELSE 0 END) AS tied,",
    "         SUM(CASE WHEN mctx.result_type = 'no result' THEN 1 ELSE 0 END) AS no_result,",
    "         SUM(CASE WHEN team = mctx.toss_winner THEN 1 ELSE 0 END) AS toss_won",
    "  FROM player_matches",
    `  LEFT JOIN ${matchContextSubselectSql()} ON mctx.mctx_match_id = player_matches.match_id`,
    `  WHERE ${resWhereSql}`,
    "  GROUP BY player_id",
    ")",
  ].join("\n");
}

/**
 * Stage-3 Phase 2.1 (owner-ruled 2026-08-24, audit7) — the ADDITIVE MATCH-SELECTING
 * clauses a per-player fielding DENOMINATOR must honour so the divisor counts the
 * matches the player PLAYED that the board's MATCH-SELECTING filters keep — matches
 * WITHOUT a fielding credit INCLUDED (owner ruling 1: "valid catches ÷ ALL matches the
 * player PLAYED in the filtered set", never "matches where a catch happened"). Reused
 * by the per-match rate divisor (buildPmatchCteSql, 2.1) and — Phase 2.3, same helper
 * verbatim — the Won/Lost/PotM divisors (buildResultCteSql / buildPomCteSql).
 *
 * CREDIT-DEFINING fielding filters (wicket type / dismissed-batter attrs / bowler /
 * phase / over / innings-number) are DELIBERATELY ABSENT: they select WHICH credits the
 * numerator counts, never which matches were PLAYED (a match played is a match played
 * regardless of what was caught in it). So a credit-defining-only filter leaves this
 * divisor UNMOVED — exactly audit7's BKG Mendis "Stumped-only 17/50 divisor unmoved"
 * control.
 *
 * Every clause reads state EXACTLY as the fielding NUMERATOR does, so the divisor can
 * never honour a different match set than the tallies it divides:
 *   • Opposition — top-level state.opposition (the SAME array the fielding_cte's
 *     oppositionColumn="opposition" narrows by). player_matches has no opposition column,
 *     so the opponent is derived from the match's own two sides (matches.team_1/team_2)
 *     via a correlated EXISTS on a LOCAL `matches` alias — do NOT extend
 *     matchContextSubselectSql (audit7). Total by construction: audit7 verified 0
 *     player_matches rows with team ∉ {team_1,team_2}.
 *   • Season / City — state.fielding.seasons / state.fielding.cities (the fielding
 *     NAMESPACE pair, the SAME fields buildFieldingExtraSliceClauses reads). Both emit
 *     the SAME gender-scoped `match_id IN (SELECT … FROM matches …)` semi-join the
 *     numerator's Season slice uses (fielding.city ≡ matches.city, audit7). This also
 *     makes the top-level and fielding-namespace city/season pairs SYMMETRIC on the
 *     divisor (the top-level pair already reaches it via buildScopeClausesTagged).
 *   • Stage / Match Result / Toss result / Toss decision — buildMatchContextClauses
 *     reused VERBATIM (no drift), comparing the player's own `player_matches.team`,
 *     inside the correlated matchContextSubselectSql EXISTS (the result_cte pattern).
 *     Reads the fielding-namespace facets (f.result/tossResult/tossDecision/stage);
 *     resultCondition stays [] so the reused builder emits nothing for it.
 *
 * The base is `player_matches` for every caller (pmatch_cte / result_cte / pom_cte), so
 * the correlation columns are FIXED (player_matches.match_id / player_matches.team).
 * Each clause is tagged alwaysClause(…, "scope") so the lane-OR path (laneScope →
 * whereWithLanes) folds it into a "Match any" disjunction. Every clause emits NOTHING
 * when its filter is unset, so with no match-selecting filter active this returns [] and
 * every caller is BYTE-IDENTICAL to before (anchors safe by construction).
 */
export function buildFieldingDivisorMatchClauses(state) {
  const f = state.fielding || {};
  const clauses = [];

  // 1. Opposition (top-level) — derived opponent IN the picked teams, via a correlated
  //    EXISTS on the match's own two sides (LOCAL `matches` alias `fdiv_opp`).
  if (oppositionFilterActive(state)) {
    const opp = state.opposition.map((t) => `'${esc(t)}'`).join(", ");
    clauses.push(
      alwaysClause(
        `EXISTS (SELECT 1 FROM matches fdiv_opp WHERE fdiv_opp.match_id = player_matches.match_id ` +
          `AND (CASE WHEN player_matches.team = fdiv_opp.team_1 THEN fdiv_opp.team_2 ELSE fdiv_opp.team_1 END) ` +
          `IN (${opp}))`,
        "scope"
      )
    );
  }

  // 2. Fielding-namespace Season — the SAME gender-scoped semi-join the numerator emits.
  const seasons = [...new Set((f.seasons || []).filter((s) => s != null && s !== ""))];
  if (seasons.length) {
    clauses.push(
      alwaysClause(
        `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND season IN (${seasons
          .map((s) => `'${esc(s)}'`)
          .join(", ")}))`,
        "scope"
      )
    );
  }

  // 3. Fielding-namespace City — same shape on matches.city (fielding.city ≡ matches.city).
  const cities = [...new Set((f.cities || []).filter((c) => c != null && c !== ""))];
  if (cities.length) {
    clauses.push(
      alwaysClause(
        `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND city IN (${cities
          .map((c) => `'${esc(c)}'`)
          .join(", ")}))`,
        "scope"
      )
    );
  }

  // 4. Stage / Match Result / Toss result / Toss decision — buildMatchContextClauses
  //    VERBATIM (comparing player_matches.team) inside the shared mctx EXISTS.
  const mctxAdapter = {
    result: f.result || [],
    tossResult: f.tossResult || [],
    tossDecision: f.tossDecision || [],
    stage: f.stage || [],
    resultCondition: [],
  };
  const mctxClauses = buildMatchContextClauses(mctxAdapter, "player_matches.team");
  if (mctxClauses.length) {
    const inner = ["mctx.mctx_match_id = player_matches.match_id", ...mctxClauses].join(" AND ");
    clauses.push(alwaysClause(`EXISTS (SELECT 1 FROM ${matchContextSubselectSql()} WHERE ${inner})`, "scope"));
  }

  return clauses;
}

/**
 * Stage-3 Phase 2.3 (owner-ruled 2026-08-24, audit7 ruling 3) — the ADDITIVE
 * MATCH-SELECTING clauses the per-player Won/Lost/PotM DENOMINATORS must honour so
 * those columns "obey the board's filters": they count over the matches the player
 * PLAYED that the batting/bowling board's OWN TOP-LEVEL match-selecting filters keep,
 * exactly the same set buildQuery narrows the board's main numbers by.
 *
 * This is the SIBLING of buildFieldingDivisorMatchClauses, split out deliberately:
 * that helper is for the FIELDING surfaces, where season/city/stage/result/toss live in
 * the fielding NAMESPACE (state.fielding.*). result_cte / pom_cte are batting/bowling-
 * board columns, whose match-selecting filters live at TOP LEVEL — and state.fielding.*
 * is reset to {} off the fielding board, so the fielding helper would read empty fields
 * here and silently leave the board's Stage/Result/Toss filters unhonoured. So this
 * helper reads TOP-LEVEL state, mirroring buildQuery's own main-WHERE scope:
 *   • Opposition — TOP-LEVEL state.opposition. player_matches has no opposition column,
 *     so the opponent is derived from the match's own two sides (matches.team_1/team_2)
 *     via a correlated EXISTS on a LOCAL `matches` alias — identical shape to the
 *     fielding helper's opposition clause, only the SOURCE is top-level (which, for
 *     Opposition, the fielding helper already used too). Total by construction (audit7:
 *     0 player_matches rows with team ∉ {team_1,team_2}).
 *   • Stage / Result / Toss result / Toss decision / Result Condition —
 *     buildMatchContextClauses(state, "player_matches.team") reused VERBATIM (no drift)
 *     reading TOP-LEVEL `state` — the SAME call buildQuery makes at its main WHERE
 *     (buildMatchContextClauses(state, teamCol)), only comparing the player's own
 *     player_matches.team — inside a correlated EXISTS on the shared
 *     matchContextSubselectSql (the result_cte pattern). An EXISTS (not the outer mctx
 *     LEFT JOIN result_cte already carries) so pom_cte — which has NO mctx join — uses
 *     the IDENTICAL shape and the scope-lane tag threads cleanly through both. The inner
 *     `mctx` alias is scoped to the subquery, so it never collides with result_cte's own
 *     outer mctx join.
 *
 * City / Season / Event / Venue are DELIBERATELY ABSENT: buildScopeClausesTagged already
 * emits their TOP-LEVEL semi-joins inside both CTEs (player_matches carries match_id), so
 * they are already honoured and already consistent with the board — adding them here would
 * duplicate. (The fielding helper adds the fielding-NAMESPACE city/season for symmetry on
 * the fielding board; that concern does not exist here.)
 *
 * The base is `player_matches` for both callers (result_cte / pom_cte), so the correlation
 * columns are FIXED (player_matches.match_id / player_matches.team). Each clause is tagged
 * alwaysClause(…, "scope") so the lane-OR path (laneScope → whereWithLanes) folds it into a
 * "Match any" disjunction, exactly as buildQuery tags its main-WHERE match-context clauses.
 * Every clause emits NOTHING when its filter is unset, so with no match-selecting filter
 * active this returns [] and both callers are BYTE-IDENTICAL to before (anchors safe by
 * construction).
 */
export function buildBoardDivisorMatchClauses(state) {
  const clauses = [];

  // (a) Opposition (top-level) — derived opponent IN the picked teams, via a correlated
  //     EXISTS on the match's own two sides (LOCAL `matches` alias `bdiv_opp`).
  if (oppositionFilterActive(state)) {
    const opp = state.opposition.map((t) => `'${esc(t)}'`).join(", ");
    clauses.push(
      alwaysClause(
        `EXISTS (SELECT 1 FROM matches bdiv_opp WHERE bdiv_opp.match_id = player_matches.match_id ` +
          `AND (CASE WHEN player_matches.team = bdiv_opp.team_1 THEN bdiv_opp.team_2 ELSE bdiv_opp.team_1 END) ` +
          `IN (${opp}))`,
        "scope"
      )
    );
  }

  // (b) Stage / Result / Toss result / Toss decision / Result Condition — the SAME
  //     TOP-LEVEL match-context filters buildQuery applies to the board's main numbers,
  //     comparing the player's own player_matches.team, inside the shared mctx EXISTS.
  const mctxClauses = buildMatchContextClauses(state, "player_matches.team");
  if (mctxClauses.length) {
    const inner = ["mctx.mctx_match_id = player_matches.match_id", ...mctxClauses].join(" AND ");
    clauses.push(alwaysClause(`EXISTS (SELECT 1 FROM ${matchContextSubselectSql()} WHERE ${inner})`, "scope"));
  }

  return clauses;
}

/**
 * Build the `pmatch_cte` definition (columns content rework Wave C; Stage-3 Phase 2.1) —
 * a per-player COUNT of matches (Player Matches), the DENOMINATOR of the per-match
 * fielding metrics (catches_per_match, …) AND — since Stage-3 Phase 2.2 (owner ruling 2)
 * — the source of the fielding Matches COLUMN itself. Same "CTE body without leading
 * WITH" convention + the SAME scope options as buildPomCteSql / the "matches" secondary
 * query (core gender/format/date/team-type + team + event/venue + profile, pin-exempt,
 * plus name search), PLUS — Phase 2.1 — the ADDITIVE match-selecting clauses
 * (buildFieldingDivisorMatchClauses: opposition + fielding-namespace season/city/stage/
 * result/toss) so a fielder's per-match value divides by the matches they PLAYED that
 * the board's match-selecting filters keep. CREDIT-DEFINING fielding filters leave it
 * alone (see the helper). The single column `match_count` is projected out of the
 * batting/bowling GROUP BY with MAX() (a per-player constant, the same
 * functionally-dependent-join shape pom_cte/result_cte use). Built + joined ONLY when a
 * per-match fielding column/condition is present (wantsPmatch) or (fielding board/popup)
 * as the Matches source; with no match-selecting filter active the emitted SQL is
 * BYTE-IDENTICAL to before Phase 2 (the helper returns []).
 */
export function buildPmatchCteSql(state, { playerOp } = {}) {
  const pmClauses = buildScopeClausesTagged(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" });
  // Phase 2.1 (owner-ruled): the ADDITIVE match-selecting clauses. Tagged "scope" so
  // laneScope's OR path picks them up; empty when no match-selecting filter is active
  // → byte-identical. Pushed with the rest of the scope lane, before the name search.
  for (const c of buildFieldingDivisorMatchClauses(state)) pmClauses.push(c);
  if (state.search && state.search.trim()) {
    pmClauses.push(bypassableClause(`player_name ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }
  // Chunk 5 Phase 2 Wave E — lane-consistent scope (see laneScope). scopeOp always tracks
  // filterMatch.scope; playerOp DEFAULTS to filterMatch.player: the batting/bowling board
  // (buildQuery) lowers profile into its HAVING under player-OR, so dropping profile here
  // keeps this per-match denominator over the same union as the main stats. The FIELDING
  // board callers pass playerOp:"AND" — that board keeps profile an always-AND shortlister
  // in fielding_cte (Wave C; its player-OR is the outer count gate, not a profile disjunct),
  // so its Matches denominator must keep profile AND to match the tallies it divides.
  const pmWhereSql = laneScope(pmClauses, state, { idColumn: "player_id", playerOp });
  return [
    "pmatch_cte AS (",
    "  SELECT player_id AS pm_player_id, COUNT(DISTINCT match_id) AS match_count",
    "  FROM player_matches",
    `  WHERE ${pmWhereSql}`,
    "  GROUP BY player_id",
    ")",
  ].join("\n");
}

/**
 * Build the `xdisc_cte` definition (columns-rejig W3 — cross-discipline columns,
 * OQ1) — same "CTE body without leading WITH" convention as buildFieldingCteSql /
 * buildPomCteSql. ONE row per player over the OTHER discipline's innings-grain
 * view (bowling when the table is batting, and vice versa), computing each
 * requested other-discipline metric's OWN aggregate inside the GROUP BY, so a
 * Bowling-SR column can bolt onto a batting table (the all-rounder view).
 *
 * SCOPE: mirrors buildScopeClausesTagged retargeted to the OTHER discipline's
 * columns — the SAME core scope the fielding CTE honors (gender / format / date
 * window / team-type + team + OPPOSITION + event/venue + profile,
 * pin-exempt) plus the name search, computed against the other discipline's
 * teamColumn / OPP_COL / idColumn / view. It does NOT honor the current
 * discipline's per-innings slices or stat-conditions (there is no cross condition
 * to honor — cross columns can't be filtered on). Because the other discipline's
 * team column is innings-grain, buildScopeClausesTagged ALSO applies an active
 * Innings Number filter here (the fielding CTE can't, only because fielding_team
 * is not innings-grain) — i.e. a cross column reflects the player's other-discipline
 * record over the SAME match/innings scope the table covers.
 *
 * The join key `bowler_id`/`batter_id` (aliased `xd_player_id`) is the SAME unified
 * player id the fielding_cte (fielder_id) and pom_cte (player_id) already join on,
 * so `xdisc_cte.xd_player_id = <currentIdCol>` matches a player to their own other-
 * discipline row. Each metric is aliased `xd_<baseKey>` inside the CTE (prefixed so
 * it can never collide with a source column of the same name); a metric carrying a
 * sortExpression also emits `xd_<baseKey>__sort`. buildQuery projects each as
 * `MAX(xdisc_cte.xd_<baseKey>) AS <crossKey>` — exactly the fielding MAX pattern.
 * Built ONLY when a cross-discipline column is requested, so with none the emitted
 * SQL is byte-identical to today (the identical inert-guarantee fielding/PoM carry).
 */
export function buildCrossDisciplineCteSql(state, discipline, crossCols) {
  const other = OTHER_DISCIPLINE[discipline];
  const otherView = VIEW_FOR_DISCIPLINE[other];
  const otherIdCol = ID_COL[other];
  const otherNameCol = NAME_COL[other];
  const otherTeamCol = TEAM_COL[other];
  const otherOppCol = OPP_COL[other];
  const clauses = buildScopeClausesTagged(state, {
    includeTeams: true,
    teamColumn: otherTeamCol,
    idColumn: otherIdCol,
    oppositionColumn: otherOppCol,
  });
  if (state.search && state.search.trim()) {
    clauses.push(bypassableClause(`${otherNameCol} ILIKE '%${escSearch(state.search.trim())}%' ESCAPE '\\'`));
  }
  // Chunk 5 Phase 2 Wave E — lane-consistent scope (see laneScope, same rationale as
  // buildPomCteSql), keyed to the OTHER discipline's id column (otherIdCol) so a
  // cross-discipline column tracks the same Match all/any union as the main table,
  // over the OTHER discipline's own rows.
  const scopeSql = laneScope(clauses, state, { idColumn: otherIdCol });
  const selectCols = [`${otherIdCol} AS xd_player_id`];
  for (const m of crossCols) {
    selectCols.push(`${m.sqlExpression} AS xd_${m.baseKey}`);
    if (m.sortExpression) selectCols.push(`${m.sortExpression} AS xd_${m.baseKey}__sort`);
  }
  return [
    "xdisc_cte AS (",
    `  SELECT ${selectCols.join(", ")}`,
    `  FROM ${otherView}`,
    `  WHERE ${scopeSql}`,
    `  GROUP BY ${otherIdCol}`,
    ")",
  ].join("\n");
}

/**
 * Build the FIELDING leaderboard query (3rd scope) — a ranked list of FIELDERS with
 * the fixed default columns Matches · Catches · Stumpings · Run-outs · Total
 * dismissals. Returns { sql, matchesSql:null }.
 *
 * SHAPE (mirrors the pop-up's buildFieldingRowQuery, MINUS its single-player
 * `WHERE id='<player>'` wrap — this returns ALL fielders):
 *   WITH fielding_cte AS (…SACRED per-fielder tallies + fielder_name…),
 *        pmatch_cte   AS (…per-player match COUNT over player_matches…)
 *   SELECT fielding_cte.fld_player_id AS id,
 *          fielding_cte.fielder_name  AS name,
 *          COALESCE(pmatch_cte.match_count, 0) AS matches,
 *          fielding_cte.catches AS catches,
 *          fielding_cte.stumpings AS stumpings,
 *          fielding_cte.run_outs AS run_outs,
 *          (fielding_cte.catches + fielding_cte.stumpings + fielding_cte.run_outs)
 *            AS dismissals_effected
 *   FROM fielding_cte
 *   LEFT JOIN pmatch_cte ON pmatch_cte.pm_player_id = fielding_cte.fld_player_id
 *
 * BASE = the SACRED buildFieldingCteSql (one row per fielder over the EVENT-GRAIN
 * `fielding` view), UNCHANGED except the additive opts.includeName projection. It
 * already threads the FULL leaderboard scope — core (gender/format/date/team-type)
 * + team (fielding_team) + OPPOSITION + event/venue + profile, pin-exempt — plus the
 * name search, and excludes substitutes; with NO fielding filters this step, its slice
 * clauses are empty, so the tallies equal the pop-up's un-sliced fielding numbers.
 *
 * MATCHES — Stage-3 Phase 2.2 (owner ruling 2, 2026-08-24): ALWAYS pmatch_cte.match_count
 * = ALL matches the fielder PLAYED in the filtered set (matches WITHOUT a credit included),
 * the SAME source the player pop-up uses (they can never disagree). buildPmatchCteSql
 * (playerOp "AND" here — the fielding board keeps profile an always-AND shortlister) now
 * honours the MATCH-SELECTING filters additively (opposition + fielding season/city/stage/
 * result/toss — Phase 2.1); CREDIT-DEFINING fielding slices (wicket type / dismissed-batter
 * attrs / bowler / phase / over / innings) leave the count alone (a match played is a match
 * played regardless of what was caught). This SUPERSEDES decision 73's narrowed→credited-
 * matches (fld_matches_cte) switch. With no match-selecting filter active it is byte-
 * identical to this board's pre-Phase-2 un-narrowed appearance count. The per-match rate
 * denominator reads the SAME pmatch_cte, so Matches and the rates always reconcile.
 * A fielder in fielding_cte is a non-substitute playing member with ≥1 credit in scope, so
 * they always have the matching pmatch row; COALESCE(...,0) is a defensive floor. Ranking is
 * over ALL fielders with ≥1 credit in scope (fielding_cte is the base). Client-side sort
 * (applySort) defaults to Matches-desc (state.js defaultLeaderboardSort → the first column
 * when there is no "innings" column).
 */

/** Count-threshold gate for the fielding board — the fielding analogue of the
 * batting/bowling HAVING path (advancedToHaving/conditionToHaving), reusing the
 * SAME stat-condition machinery so operator / between / AND-OR semantics stay
 * byte-identical across boards.
 *
 * KEY DIFFERENCE from batting/bowling: the fielding board is a BASE table (one row
 * per fielder, tallies projected directly in buildFieldingLeaderboardQuery), NOT a
 * GROUP BY over an innings view. So a "Catches ≥ N" gate is a plain predicate on the
 * PROJECTED column — we map each supported condition metricKey → the fielding query's
 * own output alias and feed that as the exprFn into conditionToHaving, NOT the
 * catalogued metric's bolt-on `MAX(fielding_cte.…)` sqlExpression (which only exists
 * for the batting/bowling JOIN-column form and would be wrong / unresolvable here).
 * `matches` maps to the projected `matches` alias, i.e. whatever the shared
 * fieldingMatchesNarrowed switch resolved it to (appearances vs matches-with-a-credit).
 *
 * Metrics resolve under namespace "batting" (metricNsFor(fielding) === "batting"), the
 * same namespace the fielding board uses for columns/sort — so getMetric inside
 * conditionToHaving finds them (they're registered under batting/bowling in metrics.js).
 *
 * DEFENSIVE: the membership check on FIELDING_CONDITION_COLUMNS happens FIRST, before
 * conditionToHaving runs, so ANY non-fielding metricKey (a stray batting condition,
 * including a parametric Innings-Score/Wicket-Haul one whose own branch bypasses exprFn)
 * is dropped — a batting condition can never leak a predicate onto the fielding board. */
const FIELDING_CONDITION_COLUMNS = {
  catches: "catches",
  // Caught & bowled (3.2c): its OWN count filter, a distinct subset of Catches
  // (which still includes c&b — unchanged). Maps to the additively-projected
  // `caught_and_bowled` alias above, so "Caught & bowled ≥ N" predicates on it.
  caught_and_bowled: "caught_and_bowled",
  stumpings: "stumpings",
  run_outs: "run_outs",
  dismissals_effected: "dismissals_effected",
  matches: "matches",
};
function conditionToFieldingWhere(cond) {
  const col = FIELDING_CONDITION_COLUMNS[cond && cond.metricKey];
  if (!col) return null; // not a supported fielding tally → dropped (never leaks)
  return conditionToHaving(cond, "batting", () => col);
}
/** Shares advancedToHaving's group/AND-OR assembly (the one assembleConditionGroups
 * core — cleanup item A), routing each condition
 * through conditionToFieldingWhere (membership-gated, base-column expr). Returns the
 * combined predicate string, or null when no supported fielding count condition is
 * active (so the board query stays byte-identical).
 *
 * Chunk 5 Phase 2 Wave C — Part 1 (fielding PLAYER-lane OR). Unlike the batting/
 * bowling board — whose player lane has THREE blocks (profile / PotM / numeric),
 * OR'd at the block boundary in buildQuery while each block keeps its internal
 * structure — the fielding board's player lane is DEGENERATE: this count gate is
 * its ONLY player-lane member (there is no profile/PotM disjunct on the fielding
 * board). So the player-lane "Match any" toggle drives THIS gate directly: under
 * playerOp === "OR" every count predicate OR-joins (both the within-group joiner
 * and the across-group joiner flip to OR), so "Catches ≥ 20 OR Stumpings ≥ 5"
 * counts a fielder passing EITHER threshold — the plain-English meaning of
 * "Match any" for the fielding count filters. This is the count-gate-only clean
 * case the Wave C plan calls out: it is a single OUTER WHERE over the base-table
 * aliases (no WHERE/HAVING lowering), all count predicates, so nothing else moves.
 * playerOp === "AND" (the default) keeps the authored g.op / advanced.op joiners
 * verbatim → BYTE-IDENTICAL to the pre-Wave-C board.
 *
 * NOTE (flagged for Wave E / owner): the fielding CTE's profile semi-join
 * (buildScopeClausesTagged "player" tag) stays AND-scoped in the CTE WHERE even
 * under player-OR — it is a player-SHORTLISTING predicate, not one of these count
 * filters, so it is NOT lowered/OR'd the way batting/bowling lower profile into
 * their HAVING disjunction. If the owner ever wants profile to OR with the fielding
 * counts, that is a follow-up (there is no HAVING on this base-table board to
 * re-emit it into). */
function buildFieldingCountGate(advanced, playerOp = "AND") {
  if (!advanced) return null;
  return assembleConditionGroups(advanced, conditionToFieldingWhere, { orAll: playerOp === "OR" });
}

/** Base-table SELECT expression for each fielding COUNT column, keyed by metric key —
 * the fielding_cte column reference, NOT the catalogued metric's `MAX(fielding_cte.…)`
 * sqlExpression. That sqlExpression is the batting/bowling GROUP-BY join form; the
 * fielding board is a BASE table (one row per fielder), so a MAX() here would collapse
 * the whole board to a single row. These are the EXACT strings the fixed selectCols
 * below have always emitted, so the default board stays byte-identical. */
const FIELDING_BASE_CTE_EXPR = {
  catches: "fielding_cte.catches",
  caught_and_bowled: "fielding_cte.caught_and_bowled",
  stumpings: "fielding_cte.stumpings",
  run_outs: "fielding_cte.run_outs",
  dismissals_effected: "(fielding_cte.catches + fielding_cte.stumpings + fielding_cte.run_outs)",
};
const _FLD_PER_MATCH_SUFFIX = "_per_match";
/** The base-table SELECT expression (no outer MAX — the board is one row per fielder)
 * for a resolved fielding column metric, or null when it isn't a projectable fielding
 * column. Covers the five counts, their per-match rate variants, and the composed fc__
 * columns (count + per-match). Per-match denominators divide by the player's appearance
 * count (pmatch_cte.match_count) — the metric's own definition — so the caller must
 * ensure pmatch_cte is joined whenever a per-match column is present. */
function fieldingBoardColExpr(m) {
  if (!m) return null;
  // Fielding list column (Wave 2b): the injected fielding_cte alias IS the list — read
  // it straight off the base table (no per-match / rate variant). Group-A lists are an
  // aggregate over the fielding view; the Group-B (Season) list rides fielding_cte's
  // conditional fld_mctx join — either way the alias is on fielding_cte.
  if (m.isFieldingSet && m.fieldingCteAlias) {
    return `fielding_cte.${m.fieldingCteAlias}`;
  }
  // Composed fc__ column: the injected fielding_cte alias is the count; the per-match
  // variant divides that count by the appearance count.
  if (m.isComposedFielding && m.fieldingCteAlias) {
    const count = `fielding_cte.${m.fieldingCteAlias}`;
    return m.perMatch ? `(${count}) * 1.0 / NULLIF(pmatch_cte.match_count, 0)` : count;
  }
  // Enumerated count column.
  if (Object.prototype.hasOwnProperty.call(FIELDING_BASE_CTE_EXPR, m.key)) {
    return FIELDING_BASE_CTE_EXPR[m.key];
  }
  // Enumerated per-match rate column (`<count>_per_match`): its count sibling's base
  // expression ÷ the appearance count.
  if (m.perMatch && typeof m.key === "string" && m.key.endsWith(_FLD_PER_MATCH_SUFFIX)) {
    const countExpr = FIELDING_BASE_CTE_EXPR[m.key.slice(0, -_FLD_PER_MATCH_SUFFIX.length)];
    if (countExpr) return `(${countExpr}) * 1.0 / NULLIF(pmatch_cte.match_count, 0)`;
  }
  return null;
}

export function buildFieldingLeaderboardQuery(state, visibleColumns = []) {
  // Lane match-mode (Chunk 5 Phase 2). Wave C drives the fielding board's OR from
  // the SAME state.filterMatch the batting/bowling boards read: filterMatch.player
  // → the count-gate joiner (Part 1); filterMatch.scope → the fielding CTE scope
  // disjunction (Part 2). Both default to "AND", so an all-AND state is byte-identical.
  const filterMatch = state.filterMatch || { player: "AND", scope: "AND" };
  // The board ALWAYS projects the fixed base — id / name / matches + the five tallies
  // (+ caught_and_bowled, kept for the count gate). "extras" are the columns the user
  // added BEYOND that base: the per-match rate variants and the composed fc__ columns.
  // Resolve each under "batting" (the fielding metrics catalogue — metricNsFor(fielding)
  // === "batting") and keep only real fielding columns, so a stray key can never emit an
  // unprojectable batting-view expression. With visibleColumns == the default five,
  // extras is empty and the emitted SQL is BYTE-IDENTICAL to the fixed board.
  const BASE_KEYS = new Set([
    "matches", "catches", "caught_and_bowled", "stumpings", "run_outs", "dismissals_effected",
  ]);
  const extras = [];
  const seenExtra = new Set();
  for (const key of visibleColumns || []) {
    if (BASE_KEYS.has(key) || seenExtra.has(key)) continue;
    const m = getMetric(key, "batting");
    if (!m || !(m.isComposedFielding || m.section === "fielding")) continue;
    const expr = fieldingBoardColExpr(m);
    if (!expr) continue;
    seenExtra.add(key);
    extras.push({ key, expr, metric: m });
  }
  // Columns injected into the fielding CTE: the fc__ composer columns AND the Wave-2b
  // list columns (fld_*_set) — both carry fieldingCteAlias + fieldingCteCaseSql, so
  // buildFieldingCteSql's generic injection loop emits `<expr> AS <alias>` for each over
  // the SAME `GROUP BY fielder_id` (tallies byte-identical). A Group-B list column
  // (needsFieldingMctx) additionally lights the CTE's 1:1 matches join.
  const cteInjectCols = extras
    .filter((e) => e.metric.isComposedFielding || e.metric.isFieldingSet)
    .map((e) => e.metric);
  // SACRED CTE as a BASE table, with the fielder name projected (opts.includeName) plus
  // any requested fc__ composer / list columns injected (byte-identical CTE when none).
  const cte = buildFieldingCteSql(state, cteInjectCols, { includeName: true });
  // Matches source — Stage-3 Phase 2.2 (owner ruling 2, 2026-08-24): the Matches COLUMN
  // shows ALL matches the player PLAYED in the filtered set (matches WITHOUT a credit
  // included), which is exactly the Phase-2.1 filtered pmatch_cte (appearances honouring
  // the match-selecting filters). This SUPERSEDES decision 73's narrowed→credited-matches
  // (fld_matches_cte) switch: the Matches source is now ALWAYS pmatch_cte, so it agrees
  // with the per-match rate denominator (same CTE) AND with the player pop-up (which makes
  // the identical swap). With no match-selecting filter active pmatch_cte is byte-identical
  // to the pre-Phase-2 un-narrowed board (its Matches was already pmatch appearances).
  // playerOp:"AND" (Wave C/E): the fielding board keeps profile an always-AND shortlister,
  // so its Matches denominator never drops profile under player-OR.
  const matchesCte = buildPmatchCteSql(state, { playerOp: "AND" });
  const matchesExpr = "COALESCE(pmatch_cte.match_count, 0) AS matches";
  const joinSql = "LEFT JOIN pmatch_cte ON pmatch_cte.pm_player_id = fielding_cte.fld_player_id";
  const selectCols = [
    "fielding_cte.fld_player_id AS id",
    "fielding_cte.fielder_name AS name",
    matchesExpr,
    "fielding_cte.catches AS catches",
    // Caught & bowled (3.2c): projected additively so the Wicket Types "Caught &
    // bowled ≥ N" count gate can predicate on it. It renders only when the user has
    // added it as a column; with no c&b column/filter the board is byte-identical
    // (Catches still folds c&b in, unchanged).
    "fielding_cte.caught_and_bowled AS caught_and_bowled",
    "fielding_cte.stumpings AS stumpings",
    "fielding_cte.run_outs AS run_outs",
    "(fielding_cte.catches + fielding_cte.stumpings + fielding_cte.run_outs) AS dismissals_effected",
  ];
  // Extra visible columns (per-match rates + composed fc__): one independent SELECT
  // expression each, AFTER the fixed base. Display ORDER follows the picker's column
  // list (renderTable iterates visibleColumns), not this projection order, so a fixed-
  // base-first projection is display-agnostic. With no extras this loop adds nothing.
  for (const e of extras) {
    selectCols.push(`${e.expr} AS ${e.key}`);
  }
  // Per-match rate denominators read pmatch_cte.match_count — the SAME CTE that is now
  // always the Matches source (Phase 2.2), so it is already in the WITH + joined; no
  // separate rate-only pmatch build is needed (the former narrowed-board extra CTE).
  const fromSql = "FROM fielding_cte\n" + joinSql;
  const baseSelect = [
    "SELECT " + selectCols.join(",\n       "),
    fromSql,
  ].join("\n");
  // Count-threshold gate (reuses the batting/bowling condition machinery). Applied as
  // an OUTER WHERE over the projected columns (the board is a base table with no GROUP
  // BY, so the gate is a plain predicate on the aliases, not a HAVING). Absent ⇒ no
  // wrap ⇒ byte-identical to the un-gated board.
  const countGate = buildFieldingCountGate(state.advanced, filterMatch.player);
  const body = countGate
    ? `SELECT * FROM (\n${baseSelect}\n) AS fld_board\nWHERE ${countGate}`
    : baseSelect;
  const sql = ["WITH " + [cte, matchesCte].join(",\n"), body].join("\n");
  return { sql, matchesSql: null };
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

  // Fielding (3rd leaderboard scope): a ranked list of FIELDERS, not batters/bowlers.
  // It is a fully separate, self-contained query off the SACRED fielding CTE as a base
  // table (see buildFieldingLeaderboardQuery) — none of the batting/bowling innings-view
  // logic below applies (fielding has no innings grain). matchupVsActive is already false
  // for fielding (its dim gates require batting/bowling), so this branch is the only
  // fielding path. visibleColumns now drives the board's projection (the fixed five stay
  // byte-identical; per-match rate + composed fc__ columns are projected additively).
  if (discipline === "fielding") {
    return buildFieldingLeaderboardQuery(state, visibleColumns);
  }

  if (matchupVsActive(state)) {
    return buildMatchupQuery(state, discipline, visibleColumns);
  }

  const view = VIEW_FOR_DISCIPLINE[discipline];
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];

  const inningsMetrics = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter(
      (m) =>
        m &&
        m.source !== "player_matches" &&
        m.source !== "fielding_events" &&
        m.source !== "result" &&
        // Wave D — D1: profile attribute columns are player-level constants surfaced
        // via profile_cte (like fielding/pom/result), NOT innings aggregates.
        m.source !== "profiles"
    );

  const selectParts = [`${idCol} AS id`, `${nameCol} AS name`];
  for (const m of inningsMetrics) {
    selectParts.push(`${m.sqlExpression} AS ${m.key}`);
    if (m.sortExpression) selectParts.push(`${m.sortExpression} AS ${m.key}__sort`);
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
  // like the profile_cte join's MAX. The joins never multiply innings rows, so every
  // existing aggregate above stays byte-identical. `wants*` also lights up for a
  // matching STAT CONDITION with no visible column, so a HAVING referencing the
  // CTE always has its CTE joined.
  const fieldingEventCols = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter(isFieldingEventMetric);
  const pomCols = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter(isPomMetric);
  // Result-family (Wave B): Matches Won/Lost/Tied/No-result/Toss Won — a per-player
  // whole-match count surfaced via `result_cte` (source "result"), the same
  // per-player LEFT-JOIN + MAX() projection shape as pom_cte/fielding_cte. Excluded
  // from inningsMetrics above (not innings columns).
  const resultCols = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter(isResultMetric);
  // Wave D — D1: player-profile attribute columns (source "profiles") — surfaced via
  // the per-player `profile_cte` LEFT JOIN, projected as MAX(profile_cte.pr_<field>)
  // exactly like the pom/result columns. There is no advanced-condition leg (profile
  // attributes are COLUMNS, never filter conditions), so wantsProfile is column-only.
  const profileCols = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter(isProfileMetric);
  for (const m of [...fieldingEventCols, ...pomCols, ...resultCols, ...profileCols]) {
    selectParts.push(`${m.sqlExpression} AS ${m.key}`);
  }
  // Columns whose sqlExpression READS the shared match-context LEFT JOIN, and so must
  // light it up (see the join gate below). Five families, plus their which-values twins:
  //   • the STAGE composer (Step 3, 2026-08-14) — stage__<hex>__<base> → mctx.event_stage
  //   • the EVENT / VENUE composers (Step 4, 2026-08-14) — mctx.event_name / mctx.venue —
  //     and the event_set / venue_set which-values columns, which read the SAME two
  //     (Event & Venue which-values, completing City & Season everywhere, 2026-08-16)
  //   • the CITY / SEASON composers AND the city_set / season_set which-values columns
  //     (City & Season everywhere, 2026-08-16) — mctx.city / mctx.season
  // NOT here, deliberately: the Team / Opposition composers and team_set / opp_set read
  // the discipline's OWN innings columns (batting_team / bowling_team / opposition), so
  // they need no join.
  // All of these are source "innings" (a composed column inherits its base metric's
  // source), so they are ALREADY projected via inningsMetrics above — this scan exists
  // ONLY to light the join. Column-presence gate, exactly like wantsProfile: with none
  // present it is false and the emitted SQL is byte-identical. It deliberately does NOT
  // feed wantsMatchContext (the WHERE gate) or inningsLevel (the "matches" gate), because
  // such a COLUMN narrows nothing — see the join gate below.
  // ONE scan for all five families (cleanup follow-on 3): the five per-family collections
  // this replaced were each used ONLY in that join gate, OR-ed on `.length > 0`, so the
  // union predicate lights the join for exactly the same column sets.
  const wantsMctxColumn = visibleColumns
    .map((key) => getMetric(key, discipline))
    .some(
      (m) =>
        m &&
        (m.isComposedStage ||
          m.isComposedEvent ||
          m.isComposedVenue ||
          m.isComposedCity ||
          m.isComposedSeason ||
          m.key === EVENT_SET_KEY ||
          m.key === VENUE_SET_KEY ||
          m.key === CITY_SET_KEY ||
          m.key === SEASON_SET_KEY ||
          // Stage-3 Phase 1.1 (2026-08-25): stage_set / toss_decision_set /
          // result_condition_set. Same JOIN-PRESENCE-ONLY contract as the four above —
          // each is a DERIVED read of mctx.event_stage / mctx.toss_decision /
          // mctx.method+is_super_over, adds no WHERE clause and (the join being 1:1 on
          // match_id) moves no aggregate. Deliberately NOT fed into wantsMatchContext or
          // inningsLevel: such a COLUMN narrows nothing.
          MATCH_OUTCOME_SET_KEYS.includes(m.key))
    );
  // Wave D — TASK B: PotM (Y/N) leaderboard filter (state.potmYN, subset of
  // {"yes","no"}). A HAVING-style gate on the SAME per-player PotM award count the
  // PotM Count column/filter use (pom_cte.player_of_match = SUM of the 0/1 flag).
  // Yes = won ≥1 PotM in scope; No = 0 (COALESCE the LEFT-JOIN NULL — no pom row —
  // to 0). A binary partition, so Yes⊕No: exactly ONE selected narrows; both or
  // neither is a no-op (byte-identical). Forces pom_cte to be built + joined (see
  // wantsPom) so the HAVING can reference it. Not wired to the PotM Count column
  // (a later stage). Computed here so wantsPom below can see potmYNActive.
  const potmYNSel = Array.isArray(state.potmYN) ? state.potmYN : [];
  const potmYes = potmYNSel.includes("yes");
  const potmNo = potmYNSel.includes("no");
  const potmYNActive = potmYes !== potmNo; // XOR — exactly one chosen
  const potmYNHaving = !potmYNActive
    ? null
    : potmYes
    ? "COALESCE(MAX(pom_cte.player_of_match), 0) >= 1"
    : "COALESCE(MAX(pom_cte.player_of_match), 0) = 0";

  const wantsFielding =
    fieldingEventCols.length > 0 ||
    advancedReferencesMetric(state.advanced, discipline, isFieldingEventMetric);
  const wantsPom =
    pomCols.length > 0 ||
    advancedReferencesMetric(state.advanced, discipline, isPomMetric) ||
    // Wave D — TASK B: an active PotM (Y/N) gate references pom_cte in HAVING, so the
    // CTE must be built + joined even with no PotM column/condition visible.
    potmYNActive;
  // Gated exactly like wantsPom: a Result COLUMN visible OR a Result STAT CONDITION
  // active. With neither, result_cte is never built/joined → SQL byte-identical.
  const wantsResult =
    resultCols.length > 0 ||
    advancedReferencesMetric(state.advanced, discipline, isResultMetric);
  // Per-match fielding (Wave C): a fielding COUNT ÷ Player Matches. Its metric is a
  // fielding-event metric too (source "fielding_events"), so it is already in
  // fieldingEventCols above (projected + fielding_cte joined); wantsPmatch just
  // additionally lights up the per-player match-count `pmatch_cte` its denominator
  // needs. Gated exactly like wantsResult (a per-match COLUMN visible OR a per-match
  // STAT CONDITION active); with neither, pmatch_cte is never built/joined → SQL
  // byte-identical.
  const wantsPmatch =
    fieldingEventCols.some(isPerMatchMetric) ||
    advancedReferencesMetric(state.advanced, discipline, isPerMatchMetric);
  // Wave D — D1: the profile_cte is wanted iff a profile attribute COLUMN is visible
  // (no condition leg — profile attributes are never filter conditions). With none,
  // wantsProfile is false and the emitted SQL is byte-identical to today.
  const wantsProfile = profileCols.length > 0;

  // Cross-discipline columns (columns-rejig W3, OQ1 — the all-rounder view): a
  // column keyed to the OTHER discipline (e.g. `x__bowling__strike_rate` on a
  // batting table). resolveColumnMetric returns a VIRTUAL metric (isCrossDiscipline,
  // baseKey, xDiscipline) for such keys and null for anything not valid in THIS
  // plain namespace; plain keys were already handled above (getMetric returns null
  // for a cross key, so they never entered inningsMetrics/fielding/pom). Each is
  // computed per-player inside xdisc_cte over the other discipline's view and
  // projected here as MAX(xdisc_cte.xd_<base>) — exactly the fielding MAX pattern.
  // Cross STAT CONDITIONS are not creatable, so — unlike wantsFielding/wantsPom —
  // there is no advancedReferencesMetric leg: the CTE is wanted iff a cross COLUMN
  // is visible. With none, wantsCross is false and the emitted SQL is byte-identical
  // to today.
  const crossCols = visibleColumns
    .map((key) => resolveColumnMetric(key, discipline))
    .filter((m) => m && m.isCrossDiscipline && m.xDiscipline === OTHER_DISCIPLINE[discipline]);
  for (const m of crossCols) {
    selectParts.push(`MAX(xdisc_cte.xd_${m.baseKey}) AS ${m.key}`);
    if (m.sortExpression) selectParts.push(`MAX(xdisc_cte.xd_${m.baseKey}__sort) AS ${m.key}__sort`);
  }
  const wantsCross = crossCols.length > 0;

  // Clauses arrive TAGGED for the pin exemption (filters.js
  // buildScopeClausesTagged): the builder marks its own two player-shortlisting
  // filters (team / profile) bypassable, everything else
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
    // Chunk 5 Phase 2 Wave A: match-context clauses are lane "scope" (they select
    // WHICH matches are measured), so they join the scope-OR disjunction under
    // "Match any". Tagging is SQL-invisible (alwaysClause sets bypassable:false,
    // exactly as pushing the bare string did) → byte-identical on the AND path.
    for (const c of buildMatchContextClauses(state, teamCol)) whereClauses.push(alwaysClause(c, "scope"));
  }

  // Pinned players (task 3b, owner decision 46; Wave 4b routed onto the shared
  // helper): additive OR. The helper reads each clause's OWN bypass tag, so it
  // never has to know the clause order — a pinned player bypasses exactly
  // team/profile/search, and still obeys the core scope (gender/format/
  // date window/team type) plus opposition, the matchup striker position, and
  // event/venue/match context.
  // buildMatchupQuery calls the SAME helper (Wave 4b, decision 47a), so plain and
  // Vs pin-handling can never diverge.
  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  // Chunk 5 Phase 2 Wave A/B — byte-identity guard. When BOTH lanes are "Match all"
  // (the default), run today's EXACT whereWithPinExemption line → byte-identical by
  // construction. A scope-lane "Match any" (Wave A) or a player-lane "Match any"
  // (Wave B) takes the whereWithLanes branch: scope-OR builds the scope disjunction;
  // player-OR DROPS the profile semi-join from the WHERE (it is re-emitted as a HAVING
  // disjunct below — WHERE→HAVING lowering). With both AND the branch is unreachable.
  const filterMatch = state.filterMatch || { player: "AND", scope: "AND" };
  const whereSql =
    filterMatch.scope === "AND" && filterMatch.player === "AND"
      ? whereWithPinExemption(whereClauses, idCol, pins)
      : whereWithLanes(whereClauses, {
          idColumn: idCol,
          pins,
          scopeOp: filterMatch.scope,
          playerOp: filterMatch.player,
        });
  // T-2b-i: AND the per-innings slice predicate in. It defines WHAT is counted
  // (like a phase/fielding slice), NOT which players are shortlisted, so it
  // ALWAYS-APPLIES — sits OUTSIDE the pin exemption (a pinned player is still
  // measured over their sliced innings). Byte-identical when inningsWhere is null.
  const finalWhereSql = inningsWhere ? `(${whereSql}) AND (${inningsWhere})` : whereSql;

  // Fielding subquery (fielding rebuild): pre-aggregate the EVENT-GRAIN `fielding`
  // view to ONE row per fielder, honoring the FULL leaderboard scope — core
  // (gender/format/date/team-type) + team (fielding_team) + OPPOSITION + event/
  // venue + profile, pin-exempt — PLUS the fielding SLICE conditions
  // (dismissed-batter position / dismissal kind / phase). Substitutes are
  // excluded by default; the slice clauses (metric-definition refinements, not
  // "who to include") always apply, even to pins. Only built when a fielding
  // column is shown or a fielding stat condition is active; with neither, `sql`
  // is byte-identical to before this wave. The CTE body is built by the shared
  // buildFieldingCteSql() helper (extracted so graph/charts.js attaches the
  // identical join) — same output as the former inline construction.
  let fieldingCteSql = null;
  if (wantsFielding) {
    // Fielding composers (FC-1): the requested fc__ columns (source
    // "fielding_events", so already in fieldingEventCols) need their SUM(CASE …)
    // aggregation injected into fielding_cte. Pass them down; with none requested
    // this is [] and buildFieldingCteSql emits a byte-identical CTE.
    // Stage-3 Phase 1.1 (2026-08-25): a fielding LIST column (isFieldingSet) needs the
    // same treatment — buildFieldingCteSql's generic injection loop reads
    // fieldingCteAlias + fieldingCteCaseSql off either kind, so one predicate covers
    // both. On these boards that is exactly one column, Dismissed batter's position
    // (fld_out_position_set), whose list reads the fielding view's own
    // out_batting_position — Group A, so it lights NO extra join. ADDITIVE: with no such
    // column shown this filter yields the same array as before and the emitted CTE is
    // byte-identical.
    const composedFieldingCols = fieldingEventCols.filter((m) => m && (m.isComposedFielding || m.isFieldingSet));
    fieldingCteSql = buildFieldingCteSql(state, composedFieldingCols);
  }

  // Impact subquery (player_of_match): a whole-match award, so it stays on
  // player_matches (which has no opposition/position column). Same scope options
  // the "matches" secondary query uses below (core + team + event/venue + profile,
  // pin-exempt), so PoM and matches never diverge on scope. Built by
  // the shared buildPomCteSql() helper (same output as the former inline block).
  let pomCteSql = null;
  if (wantsPom) pomCteSql = buildPomCteSql(state);

  // Result subquery (Wave B): per-player match-outcome counts over player_matches +
  // a 1:1 matches join, built by buildResultCteSql (same scope options + inert
  // guarantee as pom_cte). Only built when a Result column/condition is present.
  let resultCteSql = null;
  if (wantsResult) resultCteSql = buildResultCteSql(state);

  // Per-match denominator subquery (Wave C): per-player match count over
  // player_matches, built by buildPmatchCteSql (same scope options + inert
  // guarantee as pom_cte). Only built when a per-match fielding column/condition is
  // present.
  let pmatchCteSql = null;
  if (wantsPmatch) pmatchCteSql = buildPmatchCteSql(state);

  // Profile attribute subquery (Wave D — D1): a per-player attribute lookup over
  // `profiles` (built by buildProfileCteSql, no scope — see its doc). Only built
  // when a profile attribute column is visible; with none, `sql` is byte-identical.
  let profileCteSql = null;
  if (wantsProfile) profileCteSql = buildProfileCteSql();

  // Cross-discipline subquery (columns-rejig W3): pre-aggregate the OTHER
  // discipline's view to ONE row per player, honoring the same core scope the
  // fielding CTE honors (retargeted to that discipline's columns — see
  // buildCrossDisciplineCteSql). Only built when a cross-discipline column is
  // visible; with none, `sql` is byte-identical to before this wave.
  let crossCteSql = null;
  if (wantsCross) crossCteSql = buildCrossDisciplineCteSql(state, discipline, crossCols);

  // decision 44c: the BASE query applies NO minimum-innings gate — a player
  // appears if they have any qualifying innings row (equivalent to min 1). The
  // old `COUNT(*) >= Math.max(1, minInnings)` HAVING was already a no-op at its
  // floor (every GROUP BY group has COUNT(*) >= 1 by construction) and only
  // ever excluded anyone when the user raised min innings, which is exactly the
  // gate being removed. state.minInnings is retained in the state shape for
  // compatibility until the drawer UI removal lands; the query builder now
  // ignores it entirely. An "Innings ≥ N" requirement remains fully expressible
  // via the advanced stat-conditions path (the "innings" metric → advancedToHaving).
  const advHaving = advancedToHaving(state.advanced, discipline);
  // Pinned players are exempt from every HAVING/stat-condition predicate too
  // (task 3b: "HAVING/stat-condition post-filters must not drop pinned
  // rows") — idCol is the raw GROUP BY column (not the `id` alias), always
  // valid to reference directly in HAVING.
  let havingSql;
  if (filterMatch.player === "OR") {
    // Chunk 5 Phase 2 Wave B — player-lane "Match any". The three player-lane BLOCKS
    // OR together: the profile semi-join (LOWERED from the WHERE — suppressed there by
    // whereWithLanes' playerOp, re-emitted here referencing idCol, a GROUP-BY key so
    // legal in HAVING, reused VERBATIM so it can't drift from its WHERE form), the
    // PotM(Y/N) gate, and the numeric stat block (`advHaving`, used AS-IS — it keeps
    // its own internal +Add-group / per-group AND-OR structure, owner ruling Q1). Each
    // block is a disjunct ONLY when active (null blocks dropped), so a single active
    // block reads exactly like the AND path. Pin-exempt exactly like the AND HAVING.
    const disjuncts = [profileSemiJoinSql(state, idCol), potmYNHaving, advHaving]
      .filter(Boolean)
      .map((s) => `(${s})`);
    havingSql = disjuncts.length === 0 ? null : gateWithPinExemption(disjuncts.join(" OR "), idCol, pins);
  } else {
    // Player-lane "Match all" (default) — today's EXACT HAVING: numeric block AND
    // PotM(Y/N), pin-exempt. Byte-identical by construction. (Under player-AND the
    // profile filter stays a WHERE semi-join — it is NOT part of the HAVING here.)
    const havingParts = [];
    if (advHaving) havingParts.push(advHaving);
    // Wave D — TASK B: the PotM (Y/N) gate is a HAVING predicate over pom_cte (built
    // above via wantsPom). null when the filter is inactive (both/neither chosen), so
    // no HAVING is contributed and the query stays byte-identical.
    if (potmYNHaving) havingParts.push(potmYNHaving);
    havingSql =
      havingParts.length === 0 ? null : gateWithPinExemption(havingParts.join(" AND "), idCol, pins);
  }

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

  // fielding_cte / pom_cte are each one row per player and LEFT JOINed on the id
  // column, so none multiplies the innings rows the aggregates run over. Each
  // uses a collision-safe join key (fld_player_id / pom_player_id) — NOT
  // "batter_id"/"bowler_id" (i.e. not idCol) — so no bare `${idCol}` reference
  // elsewhere in this SELECT/GROUP BY (batter_id AS id, GROUP BY batter_id, ...)
  // becomes ambiguous post-JOIN.
  const cteDefs = [];
  if (wantsFielding) cteDefs.push(fieldingCteSql);
  if (wantsPom) cteDefs.push(pomCteSql);
  if (wantsResult) cteDefs.push(resultCteSql);
  if (wantsPmatch) cteDefs.push(pmatchCteSql);
  if (wantsProfile) cteDefs.push(profileCteSql);
  if (wantsCross) cteDefs.push(crossCteSql);

  let fromSql = view;
  // Match-context (Wave 6): 1:1 LEFT JOIN by match_id (see matchContextJoinSql).
  // Added first so the mctx alias exists for the WHERE clauses; it never
  // multiplies innings rows (one match per match_id), so every aggregate stays
  // byte-identical. Present when a match-context FILTER is active OR — Step 3
  // (2026-08-14) — a stage composer COLUMN is shown (its sqlExpression reads
  // mctx.event_stage). The stage-COLUMN case is JOIN-PRESENCE ONLY: it deliberately
  // does NOT feed wantsMatchContext (the WHERE gate above) or inningsLevel (the
  // "matches" gate above), because a stage COLUMN narrows NOTHING — the join adds no
  // WHERE clause and, being 1:1, changes no aggregate, so every existing column
  // (incl. "matches", which stays on its whole-scope player_matches source) is
  // byte-identical; only mctx.event_stage becomes referenceable for the new column.
  // Step 4 (2026-08-14): event / venue composer COLUMNS light the SAME mctx join
  // (their sqlExpression reads mctx.event_name / mctx.venue). JOIN-PRESENCE ONLY, like
  // the stage-COLUMN case above: they narrow nothing (no WHERE, 1:1 join), so every
  // existing aggregate is byte-identical; only the extra mctx columns become
  // referenceable. Event & Venue which-values columns (completing City & Season
  // everywhere, 2026-08-16) read the SAME mctx.event_name / mctx.venue, and the
  // city/season composer + which-values columns read mctx.city / mctx.season — all fold
  // into wantsMctxColumn above and light this same gate, JOIN-PRESENCE ONLY (1:1, no
  // WHERE) exactly like the stage case.
  if (wantsMatchContext || wantsMctxColumn) fromSql += matchContextJoinSql(view);
  if (wantsFielding) fromSql += ` LEFT JOIN fielding_cte ON fielding_cte.fld_player_id = ${idCol}`;
  if (wantsPom) fromSql += ` LEFT JOIN pom_cte ON pom_cte.pom_player_id = ${idCol}`;
  // Result (Wave B): 1:1 LEFT JOIN by the unified player id — res_player_id is the
  // same id space pom_cte joins on, so it never multiplies innings rows.
  if (wantsResult) fromSql += ` LEFT JOIN result_cte ON result_cte.res_player_id = ${idCol}`;
  // Per-match denominator (Wave C): 1:1 LEFT JOIN by the unified player id —
  // pm_player_id is the same id space pom_cte/result_cte join on, so it never
  // multiplies innings rows.
  if (wantsPmatch) fromSql += ` LEFT JOIN pmatch_cte ON pmatch_cte.pm_player_id = ${idCol}`;
  // Profile attributes (Wave D — D1): 1:1 LEFT JOIN by the unified player id —
  // profile_player_id is the same id space pom_cte/result_cte join on (profiles is
  // one row per player_id), so it never multiplies innings rows.
  if (wantsProfile) fromSql += ` LEFT JOIN profile_cte ON profile_cte.profile_player_id = ${idCol}`;
  // Cross-discipline (columns-rejig W3): 1:1 LEFT JOIN by the unified player id —
  // xd_player_id is the other discipline's batter_id/bowler_id, the same id space
  // fielding_cte/pom_cte join on, so it never multiplies innings rows.
  if (wantsCross) fromSql += ` LEFT JOIN xdisc_cte ON xdisc_cte.xd_player_id = ${idCol}`;

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
    // Chunk 5 Phase 2 Wave E — lane-consistent scope (see laneScope, same rationale as
    // buildPomCteSql): the secondary "matches" query shares the main query's Match
    // all/any union (lowered into the HAVING disjunct above under player-OR).
    const pmWhereSql = laneScope(pmClauses, state, { idColumn: "player_id" });
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
  // Chunk 1B: "list" columns (B. Pos.) render the flattened JS array (db.js
  // normalizeValue) comma-joined, e.g. [3,4,5] → "3, 4, 5".
  if (metric.format === "list") return Array.isArray(value) ? value.join(", ") : String(value);
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

/** Stage 3 (draggable column resize / decision 77.5): per-column width
 * overrides set by dragging a header's resize handle. Keyed by the column's
 * SLOT id — the same per-copy identity sort/drag/highlight already key by
 * (E1b/E2 multi-instance), so two copies of one stat resize independently; a
 * bare metric key is the fallback for a slot-less caller. MODULE-level and
 * display-only: headerCellHTML/dataCellHTML below read it to bake a fixed
 * pixel width straight into the rendered `<th>`/`<td>` markup, so ANY
 * re-render — a re-sort, a highlight toggle, add/remove column, a fresh
 * Search — reproduces whatever width the user set, for the lifetime of this
 * module (one mountTable instance = one page session; NOT persisted across a
 * reload, which the brief doesn't require). Never read by any query path —
 * pure presentation state, like highlightedColumns/nameExpanded nearby. */
const columnWidths = new Map();
const MIN_COL_WIDTH_PX = 48;

/** Render one metric's `<td>`. Sample-based muting (decision 44c) was removed
 * (Batch B1 Wave 5, owner decision): every value — however thin its backing
 * sample — renders identically, plain and un-greyed. §8.1's hasMetricData
 * still governs "—" for genuine no-data; that's a different, still-live rule. */
function dataCellHTML(metric, row, isHighlighted = false, slotId = null) {
  const value = row[metric.key];
  // Wave D — D1: TEXT columns (format "str": the profile attributes) render the raw
  // string, HTML-ESCAPED (arbitrary profile text must never inject markup). Numeric
  // formats produce digit/symbol strings with no HTML-special chars, so escaping
  // them is a harmless no-op — but scoping the escape to str keeps this byte-safe.
  const text = metric.format === "str" || metric.format === "list" ? escHtml(formatValue(metric, value)) : formatValue(metric, value);
  // data-key (task 9): lets the live drag-reorder preview find "the cell in
  // THIS row belonging to column X" without any index arithmetic — see
  // wireColumnDrag's onMove.
  // E2: data-slot-id mirrors the header's, so the drag preview moves the RIGHT
  // copy's cell even when two columns share a key (E1b multi-instance). data-key
  // stays for callers/tests that still key by it; slot id is the precise handle.
  // W2: `is-highlighted` gives the cell the soft accent wash when its column's
  // 🖍️ toggle is on — display-only (highlightedColumns), never a query change.
  const hlClass = isHighlighted ? " is-highlighted" : "";
  const slotAttr = slotId != null ? ` data-slot-id="${escAttr(slotId)}"` : "";
  // Stage 3 resize: mirror whatever width the header carries for this same
  // slot — an auto-layout table's column width is the max across ALL its
  // cells, so a td left at its natural content width would silently force
  // the column back wide even after the user narrowed the header. --resized
  // (styles.css) clips overflow with an ellipsis instead of re-widening.
  const widthKey = slotId != null ? slotId : metric.key;
  const storedWidth = columnWidths.get(widthKey);
  const widthStyle = storedWidth
    ? ` style="width:${storedWidth}px;min-width:${storedWidth}px;max-width:${storedWidth}px;"`
    : "";
  const resizedClass = storedWidth ? " data-table__td--resized" : "";
  return `<td class="data-table__td${hlClass}${resizedClass}" data-key="${metric.key}"${slotAttr}${widthStyle}>${text}</td>`;
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
  // resolveColumnMetric handles both plain keys (byte-identical to getMetric) and
  // cross-discipline column keys (a virtual metric whose key/__sort alias match the
  // projected columns), so sorting by an added Bowling-SR column resolves correctly.
  return key === "name" ? NAME_METRIC : resolveColumnMetric(key, ns);
}

/** Sort value accessor: uses the __sort shadow column when present; NULL sorts last always. */
function sortValue(row, metric) {
  const raw = metric.sortExpression ? row[`${metric.key}__sort`] : row[metric.key];
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function compareRows(a, b, metric, dir) {
  // Player name (task 6) AND Wave D — D1 profile attribute columns (format "str"):
  // client-side alphabetical, case/diacritic-insensitive. NULL/blank sorts last
  // regardless of direction (§8.5), same as numerics. `higherIsBetter:false` on
  // these makes the first sort click asc (A→Z). The accessor is `row.name` for the
  // structural Player column, `row[metric.key]` for a str metric column.
  if (metric.key === "name" || metric.format === "str") {
    const accessor = metric.key === "name" ? "name" : metric.key;
    const na = a[accessor] == null ? "" : String(a[accessor]);
    const nb = b[accessor] == null ? "" : String(b[accessor]);
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
  // sort/preserve sites in load() and true in sortByColumn(); a pure column
  // drag-reorder, a tab switch, and Show More re-render without touching it (they
  // don't change row order), so the flag survives them. A pin float/reset does
  // NOT flip it either (pins float on top AFTER ordering — the non-pinned rows
  // stay in whatever order applies), which is why the pin requery preserves it.
  let orderIsActiveSort = true;
  // R1 (2026-08-09): a PICKER-ONLY flag — true while the popup has a STAGED sort
  // (stageSort) not yet applied to the table. It flows into getSort().active so the
  // picker lights the staged column's arrow, but the TABLE reads `orderIsActiveSort`
  // directly (renderLoaded / headerCellHTML), so a staged sort never draws an arrow
  // on the frozen table. Reset the moment the sort is actually applied (load) or a
  // table-header sort takes over (sortByColumn).
  let stagedSortPending = false;
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
  // namespace (matchup vocab while a Vs selection is active) and — R1 (2026-08-09) —
  // STAGES a column change into the pending store via stageColumns/stageColumnSlots,
  // applying it on the next Search (it no longer requeries the table instantly). The
  // popover lives on document.body so a reload never destroys it; load()/enterView()
  // call columnsPicker.refresh(...) after every re-render to re-anchor + re-sync it.
  const columnsPicker = createColumnsPicker({
    // metricNsFor (not effectiveDiscipline): the picker RESOLVES metrics under this
    // namespace, so on the fielding board it maps fielding→"batting" (the fielding
    // tallies + the fixed columns all resolve there — an empty "fielding" namespace
    // would break the inline picker). The column STATE the picker reads/writes stays
    // effectiveDiscipline-keyed (getColumns/getSlots/setColumns below → state.columns.
    // fielding), exactly the pop-up's fielding-mode split. Byte-identical for batting/
    // bowling/matchup (metricNsFor === effectiveDiscipline there).
    getDiscipline: () => metricNsFor(store.get()),
    getFormats: () => store.get().formats,
    // Fielding board (3rd scope): getFieldingMode carries the fielding-only UI intent
    // the "batting" metrics ns can't express — it restricts the Add-columns bar to the
    // Match + Fielding dropdowns and drops Impact/PoM from Match (the fielding query
    // builds no pom_cte, only pmatch_cte). Mirrors the pop-up's fielding mode.
    // Returns false for batting/bowling, so their four-dropdown bar is byte-identical.
    getFieldingMode: () => store.get().discipline === "fielding",
    // New Team composer (Step 1, 2026-08-14): the composer's searchable value picker
    // sources its team list here — a leaderboard-only host callback the picker gates
    // the Team composer on (the picker can't read the store). Scoped to gender/format/
    // date/team-type; NO sibling cascade — the composer is INDEPENDENT of the Team
    // filter (owner ruling), so it is NOT narrowed by an active team/opposition filter.
    loadTeamOptions: () => {
      const s = store.get();
      return searchTeams("", s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo);
    },
    // Standalone STAGE composer (Step 3, 2026-08-14): the composer's value picker
    // sources its stage list here — its OWN loader (Stage isn't a team, so it can't
    // reuse loadTeamOptions). Scoped to gender/format/date/team-type via searchStages,
    // the SAME scope the Stage FILTER's mountStage uses; NO sibling cascade (no `sel`
    // arg) — the composer is INDEPENDENT of the Stage filter (owner ruling). The raw
    // event_stage spellings are folded to CLEAN canonical labels (owner ruling) +
    // deduped + sorted, EXACTLY like mountStage (drawerInnings.js), so the value the
    // composer stores is the canonical name metrics.js stageAliases expands back to
    // its raw spelling set. The No-Stage (event_stage IS NULL) sentinel is appended
    // iff the scope actually holds unnamed-round matches (res.hasNoStage), MIRRORING
    // the Stage FILTER's mountStage — its value/label are the filter's own STAGE_NONE /
    // STAGE_NONE_LABEL (reused, not re-derived), and the Stage composer family's
    // membershipFor (metrics.js) recognises that sentinel and emits
    // `mctx.event_stage IS NULL` instead of an
    // IN(<raw spellings>) list. Leaderboard-only, like loadTeamOptions; the pop-up
    // passes neither.
    loadStageOptions: () => {
      const s = store.get();
      return searchStages(s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo).then((res) => {
        const named = [...new Set((res.stages || []).map((r) => canonicalStage(r)))]
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
          .map((name) => ({ value: name, label: name }));
        return res.hasNoStage ? [...named, { value: STAGE_NONE, label: STAGE_NONE_LABEL }] : named;
      });
    },
    // Standalone EVENT composer (Step 4, 2026-08-14): its OWN value loader. searchEvents
    // ALREADY returns CANONICAL-folded {value,label} options (the SAME fold the Event
    // FILTER's mountEvent uses), so the composer stores canonical event names that
    // metrics.js eventAliases expands back to their raw event_name spelling set — no
    // extra fold needed here. Scoped to gender/format/date/team-type; NO sibling cascade
    // (no `sel` arg) — the composer is INDEPENDENT of the Event filter (owner ruling).
    // Leaderboard-only, like loadTeamOptions/loadStageOptions; the pop-up passes none.
    loadEventOptions: () => {
      const s = store.get();
      return searchEvents("", s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo).then((rows) =>
        (rows || []).map((r) => ({ value: r.value, label: r.label }))
      );
    },
    // Standalone VENUE composer (Step 4, 2026-08-14): its OWN value loader. Venue has NO
    // canonical fold anywhere (the Venue FILTER matches RAW `venue IN (…)`), so
    // searchVenues returns RAW venue names and the composer stores + matches them
    // verbatim (the Venue composer family's "equality" mechanic in metrics.js →
    // `mctx.venue = '<raw>'`). Same
    // scope + no-cascade + leaderboard-only rules as the Event/Stage loaders above.
    loadVenueOptions: () => {
      const s = store.get();
      return searchVenues("", s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo).then((rows) =>
        (rows || []).map((r) => ({ value: r.value, label: r.label }))
      );
    },
    // Standalone CITY + SEASON composers (City & Season everywhere, 2026-08-16): their
    // OWN value loaders. Venue-shape — RAW city / season names (no fold), stored + matched
    // verbatim (metrics.js City/Season composer families via makeComposerFamily →
    // `mctx.city|season = '<raw>'`). searchSeasons returns seasons NEWEST-first (season-order ruling d1eba79).
    // Same scope + no-cascade + leaderboard-only rules as the Event/Venue loaders above.
    loadCityOptions: () => {
      const s = store.get();
      return searchCities("", s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo).then((rows) =>
        (rows || []).map((r) => ({ value: r.value, label: r.label }))
      );
    },
    loadSeasonOptions: () => {
      const s = store.get();
      return searchSeasons("", s.gender, s.teamType, s.formats, s.dateFrom, s.dateTo).then((rows) =>
        (rows || []).map((r) => ({ value: r.value, label: r.label }))
      );
    },
    // E1a: the picker speaks KEYS (a string[] — same contract the player pop-up
    // uses, so that surface is byte-identical). getColumns projects the store's
    // Slot[] to its key list; setColumns' key array is reconciled back into slots
    // by stageColumns (surviving keys keep their slot id).
    getColumns: () => {
      const s = store.get();
      return slotKeys(s.columns[effectiveDiscipline(s)]);
    },
    setColumns: (cols) => stageColumns(effectiveDiscipline(store.get()), cols),
    // Columns-rejig W2 (2026-08-07): the leaderboard's inline picker also drives
    // the per-column Sort-by + Highlight controls. Presence of this quartet is
    // what makes the picker RENDER those controls — the player pop-up's popover
    // (playerFiltersTab.js) passes none, so it stays byte-identical (no controls).
    //   • getSort → the pending (live-store) sort state; the picker's arrow reflects
    //     the STAGED choice. The table header reads the FROZEN applied sort, so before
    //     Search the picker can show a staged sort the table hasn't applied yet.
    //   • setSort → R1 (2026-08-09, reverses 47g for the popup): routes through
    //     stageSort — the popup Sort button STAGES a sort into the pending store and
    //     applies it on Search, it no longer re-sorts the table instantly. The
    //     table-header ▲/▼ still re-sorts instantly (sortByColumn), a separate path.
    //   • getHighlights/setHighlights → the display-only highlightedColumns set for
    //     the effective namespace; R1: setHighlights STAGES (stageHighlights) — the
    //     picker reflects it, the table applies it on Search. Never touches the query.
    // E1b: getSort also reports the active-sort SLOT id, so the picker's per-copy
    // Sort-by control lights the arrow on the exact copy that is ordering the rows
    // (not every copy of that stat). setSort gains an optional slotId — a per-copy
    // Sort-by click passes it; a table-header click (E2's job later) still passes
    // key only, and sortByColumn resolves the first slot as before.
    getSort: () => {
      const s = store.get();
      // R1: `active` for the PICKER also lights on a staged-but-unsearched sort
      // (stagedSortPending); the table itself reads the raw orderIsActiveSort, so a
      // staged sort shows in the popup without drawing an arrow on the frozen table.
      return { key: s.sort.key, dir: s.sort.dir, active: orderIsActiveSort || stagedSortPending, slotId: s.sort.slotId };
    },
    setSort: (key, slotId) => stageSort(key, slotId),
    // E1a: highlight is stored per-SLOT (slot ids). The picker works in key space,
    // so getHighlights maps the highlighted slot ids → their keys, and setHighlights
    // maps the picker's key set → the slot ids currently showing those keys
    // (stageHighlights). With today's unique-key columns this is a lossless
    // key⇄id bijection, so the highlight behaviour is byte-identical.
    getHighlights: () => {
      const s = store.get();
      const ns = effectiveDiscipline(s);
      const slots = (s.columns && s.columns[ns]) || [];
      const hlIds = new Set((s.highlightedColumns && s.highlightedColumns[ns]) || []);
      return slots.filter((sl) => hlIds.has(sl.id)).map((sl) => sl.key);
    },
    setHighlights: (keys) => stageHighlights(effectiveDiscipline(store.get()), keys),
    // ── E1b multi-instance contract (leaderboard only) ─────────────────────────
    // The presence of getSlots + applySlots is what turns the picker's inline
    // leaderboard rendering into the per-copy "instance" layout (a stat shown twice
    // lists as two rows, each add/remove/sort/highlight/count-%-independent). The
    // player pop-up popover passes NEITHER, so it keeps its byte-identical key-based
    // flat list. Everything here is DISPLAY-only — the sacred query builders never
    // see slot objects (load() dedups slots → distinct keys; buildMatchupQuery dedups
    // internally), so two copies of a stat still compute it exactly once.
    //   • getSlots  → the ordered Slot[] ({id,key}) for the effective namespace — the
    //     picker reads each slot's id (per-copy sort/highlight) + key (its count/%
    //     variant) straight from the store.
    //   • applySlots → R1 (2026-08-09): STAGE a freshly-built Slot[] into the pending
    //     store (add / remove / duplicate / pick / composer / parametric / count-%);
    //     the table applies it on Search, the slot-native twin of setColumns/stageColumns.
    //   • getHighlightIds / setHighlightIds → the per-copy highlight set as SLOT IDS
    //     (highlightedColumns already stores ids), so a highlight lands on one copy.
    //     R1: setHighlightIds STAGES (stageHighlightIds); the table-header highlight
    //     click stays instant (toggleHeaderHighlight → applyHighlightIdsInstant).
    getSlots: () => {
      const s = store.get();
      return (s.columns && s.columns[effectiveDiscipline(s)]) || [];
    },
    applySlots: (slots) => stageColumnSlots(effectiveDiscipline(store.get()), slots),
    getHighlightIds: () => {
      const s = store.get();
      const ns = effectiveDiscipline(s);
      return ((s.highlightedColumns && s.highlightedColumns[ns]) || []).slice();
    },
    setHighlightIds: (ids) => stageHighlightIds(effectiveDiscipline(store.get()), ids),
    // W3: expose the OTHER discipline's columns as an interim cross-discipline
    // group (the all-rounder view) — leaderboard only; the pop-up leaves it off.
    crossDiscipline: true,
    // Wave D — D1: offer the five player-profile ATTRIBUTE columns (Playing role /
    // Detailed role / Batting hand / Bowling style / Bowling hand) in a "Player
    // Profile" section of the current discipline's Add-columns dropdown. Leaderboard
    // only — the pop-up leaves it off, so its picker stays byte-identical (profile
    // columns in the pop-up are a later stage).
    profileColumns: true,
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
  // E2: timestamp of the last drag-END (drop). onUp rebuilds the thead (renderLoaded),
  // which re-binds fresh header click handlers, so the old capture-phase "swallow the
  // trailing click" trick can't reliably reach whatever element the post-drop click
  // lands on. Instead the header sort-arrow / highlight click handlers ignore any click
  // that arrives within a short window of a drop — so a drag never ALSO sorts or
  // highlights, deterministically. A normal click (no drag) leaves this untouched.
  let lastHeaderDragEndTs = 0;
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
    // Fielding (3rd scope): now a real column board — eligibleColumnKeys("fielding")
    // returns the fielding column set (Matches + the five tallies + per-match rates +
    // enumerable fc__ keys), so this prune drops a stray non-fielding column while
    // keeping every valid one. The value-dynamic fc__ over/pos RANGE keys resolve only
    // under "batting"/"bowling" (resolveComposedFieldingMetric rejects "fielding"), so
    // the structural check below uses metricNsFor (fielding→"batting") — byte-identical
    // for batting/bowling, where metricNsFor === ns.
    const ns = effectiveDiscipline(state);
    const mns = metricNsFor(state); // fielding→"batting"; else === ns
    const formats = state.formats;
    const cols = state.columns[ns];
    // W3: allow cross-discipline column keys too (eligibleColumnKeys = plain ∪
    // cross). Byte-identical when no cross column is present. eligibleColumnKeys
    // returns only the plain keys for matchup namespaces, so matchup pruning is
    // unchanged.
    const allowedKeys = eligibleColumnKeys(ns, formats);
    // D4: parametric composed columns (isr__/wh__) are value-dynamic — not enumerable
    // into `allowedKeys` — so keep them via a structural check. E1a: `cols` is Slot[]
    // — filter by each slot's key (survivors keep their id → highlight/sort follow).
    // FC-1: value-dynamic fielding composers (fc__…__over/pos__<range>) are an
    // infinite value space too — keep them via the same structural check (mns).
    const pruned = cols.filter(
      (sl) =>
        allowedKeys.has(sl.key) ||
        isParamComposedColumnKey(sl.key, ns) ||
        isComposedFieldingColumnKey(sl.key, mns) ||
        isCrossParamComposedColumnKey(sl.key, ns)
    );
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
        // Defensive: fielding (3rd scope) has no presets and its select is hidden, so this
        // never fires there — but guard the indexing so a stray event can't throw.
        const defs = COLUMN_PRESET_DEFS[s.discipline];
        if (!defs) return;
        const def = defs.find((d) => d.key === presetSelectEl.value);
        const cols = def ? def.columns(s.formats) : null;
        if (!cols) {
          syncToolbar(); // revert the select to the real current preset/custom
          return;
        }
        // Wave D — D2 (Q2a): a preset PICK swaps the OLD preset's columns for the new
        // ones (tagged "preset", moved to the front) and KEEPS filter + manual columns
        // — an explicit user action that applies even under "Keep Selected Columns".
        // Staged into the pending store like before; applied on Search.
        const patch = applyLeaderboardPresetPatch(s, cols);
        store.set(patch || { columns: { ...s.columns, [s.discipline]: reconcileSlots(cols, s.columns[s.discipline]) } });
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

  function headerCellHTML(metric, state, isHighlighted = false, slotId = null) {
    // R5-B #0: the arrow + is-sorted styling show ONLY when the displayed order
    // is an active column sort (orderIsActiveSort) AND this is the sort column.
    // After an order-preserving toolbar-only commit, orderIsActiveSort is false,
    // so no column shows an arrow even though state.sort.key still names one.
    // E1a: attribute the arrow to the specific SLOT (slotId === sort.slotId) so a
    // future duplicate copy carries the arrow on the right one; fall back to a
    // by-key match when either id is absent (with unique keys the two agree, so
    // this is byte-identical to today).
    const isSorted =
      orderIsActiveSort &&
      (slotId != null && state.sort.slotId != null
        ? state.sort.slotId === slotId
        : state.sort.key === metric.key);
    const dir = isSorted ? state.sort.dir : null;
    // E2 (owner 2026-08-08): the sort control is now a PERSISTENT small arrow on
    // every metric header — "↕" idle (click it to sort by this column), "▲"/"▼"
    // when this column IS the active sort. Clicking the ARROW sorts (toggles
    // asc/desc); clicking ANYWHERE ELSE on the header toggles this column's
    // highlight. This splits the former whole-header-click-sorts into the two
    // gestures the owner approved (arrow = sort, rest = highlight); drag still
    // reorders. R1 (2026-08-09): these TABLE-HEADER gestures stay INSTANT
    // (sortByColumn / applyHighlightIdsInstant); the popup row's Sort-by / Highlight
    // controls now STAGE (stageSort / stageHighlightIds) and apply on Search.
    const sortGlyph = isSorted ? (dir === "asc" ? "▲" : "▼") : "↕";
    // `data-table__th--draggable` (task 2): every metric column can be
    // reordered via drag — see wireColumnDrag. The sticky Player column
    // (rendered elsewhere in renderLoaded, never through this function) never
    // gets this class; the matchup composition columns DO (they're ordinary
    // metric columns, so they drag/sort like any other).
    // `columnTitle`: an optional metrics.js field for a header hover title
    // beyond the plain label (cross-discipline / profile columns) — most omit it.
    const titleAttr = metric.columnTitle ? ` title="${escAttr(metric.columnTitle)}"` : "";
    // W2: `is-highlighted` paints this column's header with the soft accent wash
    // when its 🖍️ toggle is on (display-only — highlightedColumns, not a query).
    const hlClass = isHighlighted ? " is-highlighted" : "";
    // E2: attribute the header (and, via dataCellHTML, its body cells) to a SPECIFIC
    // copy so sort / highlight / drag act per-instance (E1b multi-instance) rather
    // than on "the first column with this key". Metric columns always carry a slot;
    // the by-key fallback only matters for pre-slot callers.
    const slotAttr = slotId != null ? ` data-slot-id="${escAttr(slotId)}"` : "";
    const sortLabel = escAttr(`Sort by ${metric.label || metric.shortLabel}`);
    // Stage 3 (draggable column resize / decision 77.5): a narrow hit-zone
    // (`.data-table__th-resizer`, styles.css) sits at the header's right-hand
    // divider — wireColumnResize (below) wires it. Bake in whatever width the
    // user already dragged this slot to, from the module-level columnWidths
    // store, so it survives this render (and every future one) unchanged.
    const widthKey = slotId != null ? slotId : metric.key;
    const storedWidth = columnWidths.get(widthKey);
    const widthStyle = storedWidth
      ? ` style="width:${storedWidth}px;min-width:${storedWidth}px;max-width:${storedWidth}px;"`
      : "";
    const resizedClass = storedWidth ? " data-table__th--resized" : "";
    return `<th data-key="${metric.key}"${slotAttr} class="data-table__th data-table__th--draggable ${isSorted ? "is-sorted" : ""}${hlClass}${resizedClass}" scope="col"${titleAttr}${widthStyle}>
      <span class="data-table__th-label">${metric.shortLabel}</span><button type="button" class="data-table__sort-arrow" title="${sortLabel}" aria-label="${sortLabel}">${sortGlyph}</button><span class="data-table__th-resizer" data-resize-key="${escAttr(widthKey)}" aria-hidden="true"></span>
    </th>`;
  }

  /** Sort `rows` by the store's current sort (metric column). */
  function applySort(rows, s) {
    // metricNsFor (not effectiveDiscipline): a fielding sort key resolves under the
    // "batting" catalogue (fielding tallies are registered there). Byte-identical for
    // batting/bowling/matchup (metricNsFor === effectiveDiscipline there).
    const metric = resolveSortMetric(s.sort.key, metricNsFor(s));
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
      ${opt("hand:Right-hand bat", "Right-hand batter")}
      ${opt("hand:Left-hand bat", "Left-hand batter")}
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

  /** Reorder `ns`'s column SLOT[] : pull the slot with id `fromId` out and reinsert
   * it immediately before/after the slot with id `overId` (or at the end when
   * `overId` is null — dropped past the last draggable column). Pure array surgery
   * over the column order; never changes which columns show or the query result.
   *
   * E2: keyed by SLOT ID (not the metric key) so two copies of the same stat (E1b
   * multi-instance) each move independently — moving one copy never disturbs the
   * other. Each slot keeps its id, so its highlight / active-sort attribution stays
   * attached through the move.
   *
   * R4 Wave 4a (A1): a TABLE-HEADER drag is a purely-cosmetic view change of the
   * SAME data, applied immediately (the drag would look broken otherwise) and — a
   * direct manipulation of the shown table — it must NOT light Search. It updates
   * the FROZEN snapshot's columns ONLY (a shallow clone of lastLoadedState with just
   * its `columns` replaced) — never `lastLoadedState = store.get()`, which would fold
   * every OTHER pending edit into the frozen table and misdraw it — plus the pending
   * store (so a later Search persists the order), plus the APPLIED snapshot via
   * onColumnsApplied so the dirty comparison sees the new order as already applied
   * (no Search light).
   *
   * R1 (2026-08-09): with the Columns PANEL now staging (add/remove/etc. wait for
   * Search), the pending store can hold STAGED columns that aren't on the frozen
   * table. The splice therefore runs over the PENDING (full) list so staged columns
   * ride along and are never dropped, while the APPLIED snapshot is set to only the
   * DISPLAYED slots in their new relative order — so a header drag never leaks a
   * staged (unsearched) column onto the frozen table, and never loses one either. */
  function reorderColumns(ns, fromId, overId, side) {
    const live = store.get();
    const cols = (live.columns[ns] || []).slice(); // pending (full) list, incl. staged
    const fromIdx = cols.findIndex((s) => s.id === fromId);
    if (fromIdx === -1) return;
    const [moved] = cols.splice(fromIdx, 1);
    let toIdx;
    if (overId == null) {
      toIdx = cols.length;
    } else {
      toIdx = cols.findIndex((s) => s.id === overId);
      if (toIdx === -1) toIdx = cols.length;
      else if (side === "after") toIdx += 1;
    }
    cols.splice(toIdx, 0, moved);
    // The DISPLAYED (applied) columns in their new relative order — the frozen table
    // and the applied snapshot must carry ONLY these, never a staged extra. When
    // nothing is staged this equals `cols` (byte-identical to the pre-R1 behaviour).
    const shownIds = new Set(((lastLoadedState && lastLoadedState.columns[ns]) || []).map((s) => s.id));
    const shownCols = lastLoadedState ? cols.filter((s) => shownIds.has(s.id)) : cols;
    // Advance the APPLIED snapshot FIRST (before store.set fires the toolbar
    // sync) so the Search button never flashes dirty for a reorder.
    if (onColumnsApplied) onColumnsApplied(ns, shownCols);
    // Pending store keeps the FULL reordered list (staged columns preserved).
    store.set({ columns: { ...live.columns, [ns]: cols } });
    // Frozen snapshot: reorder ONLY its DISPLAYED columns for this ns, leaving every
    // other applied field untouched, so the displayed body reorders in place and
    // enterView() keeps showing the reordered columns after a tab switch.
    if (lastLoadedState) {
      lastLoadedState = { ...lastLoadedState, columns: { ...lastLoadedState.columns, [ns]: shownCols } };
    }
    lastQueryStateKey = serializeQueryState(store.get());
  }

  /** R1 (2026-08-09, reverses decision 47g for the Columns panel): STAGE a Columns-
   * picker key-list change into the pending store. Checking / unchecking / picking a
   * column no longer changes the DISPLAYED table — it edits the PENDING column set
   * (exactly like a filter edit) and applies on the next Search. `columns` IS part of
   * serializeQueryState, so this lights the toolbar Search button; the popup's own
   * Search commits it too (runSearch → snapshotAppliedState → load reads store.columns).
   *
   * `pickerNs` is the effective discipline the picker was built for (the live pending
   * namespace); the staged set is written to store.columns[pickerNs]. */
  function stageColumns(pickerNs, cols) {
    const live = store.get();
    // E1a: the picker hands a KEY array; reconcile it into Slot[] against the live
    // slots so surviving keys keep their slot id (highlight/sort follow), and only
    // a genuinely new key mints a fresh slot.
    const newSlots = reconcileSlots(cols, live.columns[pickerNs]);
    stageColumnSlotsCore(pickerNs, newSlots);
  }

  /** E1b + R1: STAGE a freshly-built Slot[] — the slot-native entry point the multi-
   * instance picker calls (add / remove / duplicate a copy, swap a copy's count/%
   * variant, composer / parametric edits). The picker already carries slot identity,
   * so this skips the key→slot reconcile stageColumns does and hands the slots to the
   * shared core. Numbers-safe by construction: two slots of the same stat dedup in
   * load()/buildMatchupQuery, so the SQL + values are unchanged. */
  function stageColumnSlots(pickerNs, slots) {
    stageColumnSlotsCore(pickerNs, slots);
  }

  /** R1: shared column-STAGING core (E1a/E1b). Writes `newSlots` to the PENDING store
   * for `pickerNs` and re-syncs the toolbar/picker — it does NOT touch the frozen
   * table or requery. The table's shown columns change only on the next Search
   * (runSearch → load reads store.columns → buildQuery), so the leaderboard stays put
   * until the user searches. Split out so the KEY path (stageColumns → reconcile) and
   * the SLOT path (stageColumnSlots) share one implementation. */
  function stageColumnSlotsCore(pickerNs, newSlots) {
    const live = store.get();
    // Wave D — D2: route the picker's manual edit through the origin/prune reconciler
    // — a genuine add stamps "manual" (+ clears that key's prune), a ✕ prunes the key,
    // and the sort resets to the default if its column was removed (fixing the stale-
    // NULL-sort gap). A count/% swap or composer edit is a no-op for bookkeeping (both
    // preserve the slot id). Matchup namespaces write columns only (no bookkeeping).
    store.set(reconcileManualColumnEdit(live, pickerNs, newSlots));
    syncToolbar();
  }

  /** Columns-rejig W2 / R1: re-sort the loaded rows by `key` INSTANTLY — the TABLE-
   * HEADER ▲/▼ sort path (a direct manipulation of the shown table). R1 (2026-08-09)
   * split the former two-way binding: the Columns PANEL's per-copy Sort-by control now
   * STAGES (stageSort) and waits for Search, while this header path stays instant.
   * Hoisted to mountTable scope (it used to be nested in renderLoaded as `applySortKey`).
   *
   * Sorting is "how the loaded rows are displayed," not "which rows" — a pure
   * client-side re-sort (no requery; every sortable column's values are already
   * in lastRows) that must NOT light Search (`sort` is excluded from
   * serializeQueryState). Same key ⇒ flip direction; a new key ⇒ that metric's
   * default direction (higherIsBetter===false ⇒ asc, e.g. economy). The frozen
   * SCOPE is untouched: lastLoadedState only has its `sort` replaced. */
  function sortByColumn(key, slotId) {
    const cur = store.get().sort;
    const frozen = lastLoadedState || store.get();
    const nsF = effectiveDiscipline(frozen);
    // E1a: the active sort references a SPECIFIC slot — stash its id alongside the
    // (query-critical) metric key. E1b: a per-copy Sort-by click passes the exact
    // slot id (so a duplicated stat's arrow lands on the copy you clicked, not the
    // first one); a table-header click passes key only, so — as before — resolve the
    // FIRST slot showing `key`. The "name" pseudo-column has no slot → slotId null
    // (its header matches by key).
    let sid = slotId != null ? slotId : null;
    if (sid == null) {
      const slot = (frozen.columns[nsF] || []).find((s) => s.key === key) || null;
      sid = slot ? slot.id : null;
    }
    // "Same sort" = the SAME copy re-clicked (flip direction). Comparing slot ids
    // (when both are known) is what lets two copies of one stat sort independently;
    // fall back to the by-key comparison when either id is absent (byte-identical for
    // today's unique-key columns, and for the header / "name" paths).
    const sameAsActive =
      sid != null && cur.slotId != null ? cur.slotId === sid : cur.key === key;
    let sort;
    if (sameAsActive) {
      sort = { key, dir: cur.dir === "asc" ? "desc" : "asc", slotId: sid };
    } else {
      // metricNsFor (not nsF): a fielding column's default sort direction reads its
      // metric under "batting". Byte-identical for batting/bowling/matchup.
      const metric = resolveSortMetric(key, metricNsFor(frozen));
      sort = { key, dir: metric && metric.higherIsBetter === false ? "asc" : "desc", slotId: sid };
    }
    store.set({ sort }); // pending store (excluded from dirty → no Search light)
    // R5-B #0: a sort IS an active column sort — the arrow shows on this column
    // and the rows re-order by it (in the table AND the picker).
    orderIsActiveSort = true;
    // R1: a header sort is now the applied order — clear any picker-only staged-sort
    // flag so the picker's arrow tracks this real sort, not a superseded staged one.
    stagedSortPending = false;
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

  /** R1 (2026-08-09, reverses decision 47g for the Columns panel): STAGE a sort from
   * the Columns panel's per-copy Sort-by control. Unlike the table-header ▲/▼
   * (sortByColumn, instant), this only writes the PENDING store.sort and lights a
   * PICKER-ONLY indicator (stagedSortPending → getSort().active) — it does NOT re-sort
   * or re-render the frozen table. The staged sort applies on the next Search: the
   * popup's Search (runSearch, resort:true) runs applySort over store.sort. The
   * flip/default-direction rule mirrors sortByColumn, but reads the PENDING namespace
   * and PENDING sort so repeated popup clicks toggle the staged choice. */
  function stageSort(key, slotId) {
    const live = store.get();
    const cur = live.sort;
    const nsL = effectiveDiscipline(live);
    // Same slot-resolution rule as sortByColumn: a per-copy click passes the slot id;
    // otherwise resolve the first slot showing `key` in the pending namespace.
    let sid = slotId != null ? slotId : null;
    if (sid == null) {
      const slot = (live.columns[nsL] || []).find((s) => s.key === key) || null;
      sid = slot ? slot.id : null;
    }
    const sameAsActive =
      sid != null && cur.slotId != null ? cur.slotId === sid : cur.key === key;
    let sort;
    if (sameAsActive) {
      sort = { key, dir: cur.dir === "asc" ? "desc" : "asc", slotId: sid };
    } else {
      const metric = resolveSortMetric(key, metricNsFor(live)); // fielding→"batting"; else === nsL
      sort = { key, dir: metric && metric.higherIsBetter === false ? "asc" : "desc", slotId: sid };
    }
    store.set({ sort }); // PENDING only — no lastLoadedState change, no re-sort, no re-render
    stagedSortPending = true; // picker lights the staged arrow; the frozen table does not
    syncToolbar();
  }

  /** Columns-rejig W2: toggle the soft-accent highlight on a set of columns,
   * INSTANTLY and DISPLAY-ONLY. Highlight is a CSS class on the column's cells
   * (see headerCellHTML / dataCellHTML) — it never enters a query, never changes
   * which rows or numbers show, and never lights Search (highlightedColumns is
   * absent from serializeQueryState).
   *
   * R1 (2026-08-09, reverses decision 47g for the Columns panel): STAGE — the
   * Columns panel's Highlight controls now write only the PENDING store's display
   * field (highlightedColumns) and re-sync the picker; they do NOT repaint the frozen
   * table. renderLoaded reads the highlight set from the FROZEN state (see there), so
   * a staged highlight can't tint the table until the next Search applies it (load →
   * lastLoadedState = the committed store). `ns` is the effective (pending) namespace
   * the picker built its rows for. */
  function stageHighlights(ns, keys) {
    const live = store.get();
    // E1a: highlight is stored per-SLOT. Map the picker's key set → the slot ids
    // currently showing those keys (one slot consumed per key occurrence, so a
    // duplicated key highlights distinct copies in E1b; today it's an exact
    // key→id map). A key with no current slot is dropped (highlight is only
    // enabled for shown columns). Never a query change.
    const pools = new Map();
    for (const s of live.columns[ns] || []) {
      if (!pools.has(s.key)) pools.set(s.key, []);
      pools.get(s.key).push(s.id);
    }
    const ids = [];
    for (const k of keys) {
      const q = pools.get(k);
      if (q && q.length) ids.push(q.shift());
    }
    store.set({ highlightedColumns: { ...live.highlightedColumns, [ns]: ids } });
    syncToolbar(); // staged: the picker reflects it; the table waits for Search
  }

  /** R1: STAGE a per-copy highlight set given as SLOT IDS directly (the slot-native
   * twin of stageHighlights) — the multi-instance Columns panel's Highlight toggle.
   * Writes only the PENDING store + re-syncs the picker; never repaints the frozen
   * table (renderLoaded reads highlight from the frozen state), never a query change,
   * never lights Search. Applies on the next Search. */
  function stageHighlightIds(ns, ids) {
    const live = store.get();
    store.set({ highlightedColumns: { ...live.highlightedColumns, [ns]: (ids || []).slice() } });
    syncToolbar();
  }

  /** E2: apply a per-copy highlight set as SLOT IDS to the DISPLAYED table INSTANTLY —
   * the TABLE-HEADER highlight path (toggleHeaderHighlight). R1: because renderLoaded
   * now reads the highlight set from the FROZEN state, this mirrors the change onto
   * lastLoadedState (the applied/on-screen set) AND the pending store (so the picker
   * two-way binding still tracks a header highlight), then repaints in place. A staged
   * POPUP highlight (stageHighlightIds) deliberately does NOT touch lastLoadedState, so
   * it can never leak onto the frozen table via this path. Never a query change. */
  function applyHighlightIdsInstant(ns, ids) {
    const next = (ids || []).slice();
    const live = store.get();
    store.set({ highlightedColumns: { ...live.highlightedColumns, [ns]: next } });
    if (lastLoadedState) {
      lastLoadedState = {
        ...lastLoadedState,
        highlightedColumns: { ...lastLoadedState.highlightedColumns, [ns]: next },
      };
      renderLoaded(lastRows, lastLoadedState, lastBowlingTypes);
    } else {
      syncToolbar();
    }
  }

  /** E2: toggle the display-only highlight on ONE column copy from its TABLE HEADER
   * (a click anywhere on the header except the ▲/▼ sort arrow). Commits via
   * applyHighlightIdsInstant (instant, on the shown table). R1: the toggle is computed
   * against the APPLIED highlight set (lastLoadedState), NOT the pending store — so a
   * header highlight never accidentally commits a still-staged POPUP highlight that is
   * waiting for Search. `ns` is the RENDERED table's namespace. Never a query change. */
  function toggleHeaderHighlight(ns, slotId) {
    if (!slotId) return;
    const applied = lastLoadedState || store.get();
    const cur = ((applied.highlightedColumns && applied.highlightedColumns[ns]) || []).slice();
    const i = cur.indexOf(slotId);
    if (i >= 0) cur.splice(i, 1);
    else cur.push(slotId);
    applyHighlightIdsInstant(ns, cur);
  }

  /** R4 Wave 4a ADDENDUM (owner ruling 2026-07-17): *picking* a player from the
   * results-toolbar search drops their row into the table INSTANTLY, unlike a
   * FILTER pill AND unlike a pin pill's ×/+ (both still PENDING — a pill's
   * soft-delete/undo only commits on Search). main.js calls this AFTER it has
   * already (a) added the player to state.pinnedPlayers on the live store and
   * (b) advanced its OWN applied snapshot's pinnedPlayers to match, so the
   * Search button's dirty comparison sees no change. It requeries
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
    // E2: the drag is keyed by SLOT ID so two copies of one stat (E1b multi-instance)
    // move INDEPENDENTLY — the header and every body cell carry data-slot-id, and both
    // the live preview and the commit target by it. `draggedSel` is the CSS selector
    // for this copy's cells (slot id preferred; a by-key fallback only matters for a
    // hypothetical slot-less column, which metric headers never are).
    const slotId = th.dataset.slotId || null;
    const draggedSel = slotId ? `[data-slot-id="${slotId}"]` : `[data-key="${key}"]`;
    let startX = null;
    let dragging = false;
    let moved = false;
    // Live preview (task 9): the last (overId, side) pair actually APPLIED to
    // the DOM, so moveColumnDom only runs when the target genuinely changes,
    // not on every pointermove tick.
    let appliedOverId;
    let appliedSide;

    /** Actually move `th` — and every currently-rendered row's matching data cell —
     * to sit before/after the column whose SLOT is `overId`, or to the very end when
     * `overId` is null (dragged past the last column). Real DOM moves
     * (Element.before()/after() MOVE an already-attached node, they don't clone it)
     * rather than a CSS trick; cheap enough to do on every target change because at
     * most PAGE_SIZE rows are ever rendered (task 3's pagination keeps this bounded
     * regardless of how many players the query returned). Purely a VISUAL preview —
     * the committed column order (state.columns[ns]) only changes on drop, in onUp
     * below, via reorderColumns; a full renderLoaded() after a real drop rebuilds the
     * DOM from that committed order anyway, so there's nothing here that ever needs an
     * explicit "revert". */
    function moveColumnDom(overId, side) {
      const targetTh = overId ? theadEl.querySelector(`.data-table__th--draggable[data-slot-id="${overId}"]`) : null;
      if (targetTh) {
        if (side === "after") targetTh.after(th);
        else targetTh.before(th);
      } else {
        const headerRow = theadEl.querySelector("tr");
        if (headerRow) headerRow.appendChild(th);
      }
      for (const tr of tbodyEl.querySelectorAll("tr")) {
        const draggedTd = tr.querySelector(`td${draggedSel}`);
        if (!draggedTd) continue; // the sticky Player cell carries no slot id
        if (overId) {
          const targetTd = tr.querySelector(`td[data-slot-id="${overId}"]`);
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
      // fell back to overId=null (→ moveColumnDom appends to the far right)
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
      let overId = null;
      let effectiveSide = null;
      let indicatorEl = null;
      let indicatorSide = "before";
      if (insertBeforeEl) {
        overId = insertBeforeEl.dataset.slotId || null;
        effectiveSide = "before";
        indicatorEl = insertBeforeEl;
        indicatorSide = "before";
      } else if (others.length) {
        const lastOther = others[others.length - 1];
        overId = lastOther.dataset.slotId || null;
        effectiveSide = "after";
        indicatorEl = lastOther;
        indicatorSide = "after";
      }
      if (indicatorEl) {
        indicatorEl.classList.add(
          indicatorSide === "before" ? "data-table__th--drop-before" : "data-table__th--drop-after"
        );
      }
      dragState = { id: slotId, ns, overId, side: effectiveSide };
      // Only touch the DOM when the drop target actually changed — every
      // other pointermove tick (moving within the same target's bounds) is a
      // no-op here, same as the old indicator-only version was.
      if (overId !== appliedOverId || effectiveSide !== appliedSide) {
        moveColumnDom(overId, effectiveSide);
        appliedOverId = overId;
        appliedSide = effectiveSide;
      }
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      clearDragIndicators();
      th.classList.remove("data-table__th--dragging");
      if (dragging && dragState && dragState.id === slotId) {
        reorderColumns(ns, slotId, dragState.overId, dragState.side);
        // Re-render the FROZEN body from lastLoadedState (whose columns
        // reorderColumns just updated) — never store.get(), which carries other
        // pending edits that must not reach the displayed table until Search.
        renderLoaded(lastRows, lastLoadedState ?? store.get(), lastBowlingTypes);
      }
      dragState = null;
      startX = null;
      appliedOverId = undefined;
      appliedSide = undefined;
      if (moved) {
        // E2: mark the drop time. renderLoaded above re-bound fresh header click
        // handlers (arrow-sort + click-highlight); both ignore any click within
        // 250ms of this, so the trailing click the browser fires right after a drag
        // never ALSO sorts or highlights. (Replaces the former capture-phase
        // "swallow the click" trick, which targeted the pre-rebuild `th` and so
        // couldn't reliably reach the post-drop click's real target.)
        lastHeaderDragEndTs = Date.now();
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

  /** Wire the drag-to-resize handle on one metric header (Stage 3 / decision
   * 77.5: cursor-only affordance — NO glow/highlight/grip-dots; hovering the
   * handle just swaps the cursor to col-resize via CSS, spreadsheet-standard).
   * Mouse/pen only, same touch policy as wireColumnDrag (a touch pointerdown
   * falls through to native horizontal scroll — no long-press escape hatch).
   *
   * Two separate guards keep a resize from ALSO sorting/highlighting/
   * reordering, matching the two ways a trailing click can land after a real
   * mouse drag: (1) the handle's own pointerdown/click stopPropagation() so a
   * click that lands back on the handle itself never reaches th's drag-reorder
   * pointerdown or highlight-toggle click listener; (2) `lastHeaderDragEndTs`
   * (the SAME gate wireColumnDrag's onUp sets) for the case a fast mouse-up
   * lands the click on the th body instead — the header's own click handler
   * (renderLoaded, below) already ignores anything within 250ms of that.
   *
   * Writes straight into the module-level `columnWidths` on every pointermove
   * for live feedback and restyles both the header cell and every currently-
   * rendered `<td>` in the column (only ~PAGE_SIZE rows are ever mounted, so
   * this is cheap) — there is nothing further to "commit" on drop, since
   * headerCellHTML/dataCellHTML always read the width straight out of that
   * same map on every render. */
  function wireColumnResize(handle, th) {
    const slotId = th.dataset.slotId || null;
    const key = th.dataset.key;
    const widthKey = slotId != null ? slotId : key;
    const cellSel = slotId ? `[data-slot-id="${slotId}"]` : `[data-key="${key}"]`;
    let startX = null;
    let startWidth = null;
    let resizing = false;

    function applyWidth(px) {
      const w = Math.max(MIN_COL_WIDTH_PX, Math.round(px));
      columnWidths.set(widthKey, w);
      th.style.width = `${w}px`;
      th.style.minWidth = `${w}px`;
      th.style.maxWidth = `${w}px`;
      th.classList.add("data-table__th--resized");
      tbodyEl.querySelectorAll(`td${cellSel}`).forEach((td) => {
        td.style.width = `${w}px`;
        td.style.minWidth = `${w}px`;
        td.style.maxWidth = `${w}px`;
        td.classList.add("data-table__td--resized");
      });
    }

    function onMove(e) {
      if (startX === null) return;
      resizing = true;
      applyWidth(startWidth + (e.clientX - startX));
    }

    function onUp() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-col-resizing");
      if (resizing) {
        // See doc comment above: reuse wireColumnDrag's trailing-click guard
        // so a resize's post-drop click never also sorts/highlights.
        lastHeaderDragEndTs = Date.now();
      }
      startX = null;
      startWidth = null;
      resizing = false;
    }

    handle.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
      if (e.button !== 0) return;
      e.stopPropagation(); // never let this reach th's own drag-reorder pointerdown
      e.preventDefault();
      startX = e.clientX;
      startWidth = th.getBoundingClientRect().width;
      document.body.classList.add("is-col-resizing");
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });
    // A plain click on the handle (no drag at all) must not bubble to th's
    // highlight-toggle listener either — belt-and-braces alongside the
    // lastHeaderDragEndTs gate above, which only covers an ACTUAL drag.
    handle.addEventListener("click", (e) => { e.stopPropagation(); });
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
      // Fielding (3rd scope): a FIXED tally set with NO presets (COLUMN_PRESET_DEFS has
      // no "fielding" entry) — hide the control (presets stay HIDDEN for fielding, like
      // the pop-up). Guarded FIRST so the COLUMN_PRESET_DEFS[discipline] indexing below
      // never runs for fielding (it would throw). Auto-column management + a fielding
      // picker are the NEXT step.
      if (discipline === "fielding") {
        presetSelectEl.hidden = true;
      } else {
        presetSelectEl.hidden = false;
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
      // reports the discipline's matchup data absent for this gender. Fielding (3rd
      // scope) has no matchup (matchupVsActive is false there), so hide it outright —
      // otherwise matchupVsOptionsHTML's non-batting branch would show batter-hand options.
      const showVs = discipline !== "fielding" && (!av || typeof av[availKey] !== "boolean" || av[availKey]);
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
    // Fielding (3rd scope) now has a real column board (Matches + the five tallies +
    // per-match rates + fc__ composers), so the Columns button shows there too — the
    // picker restricts its Add-columns bar to Match + Fielding via getFieldingMode.
    if (columnsBtnEl) {
      columnsBtnEl.hidden = false;
      columnsBtnEl.disabled = false;
    }

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
    // metricNsFor: the column-STATE key is `ns` (state.columns[ns] — "fielding" for the
    // fielding board), but each key RESOLVES to its metric under metricNsFor (fielding→
    // "batting"). For batting/bowling/matchup metricNsFor === ns, so this is byte-identical.
    const mns = metricNsFor(state);
    // E1a: render one column PER SLOT. Each entry keeps the slot's id (for per-slot
    // highlight/sort attribution) alongside its resolved metric. Two slots sharing a
    // key resolve to the same metric and read the SAME row value (row[key]) — the
    // dedup foundation (buildQuery computed that stat once). resolveColumnMetric
    // handles plain keys (like getMetric) AND cross-discipline keys (W3).
    const slots = state.columns[ns] || [];
    const cols = slots
      .map((sl) => ({ slotId: sl.id, m: resolveColumnMetric(sl.key, mns) }))
      .filter((c) => c.m);

    // W2/E1a highlight set: the display-only SLOT IDS the user has 🖍️-toggled.
    // R1 (2026-08-09): read from the FROZEN `state` (the applied snapshot), NOT the
    // live store. The Columns panel's Highlight controls now STAGE into the pending
    // store (stageHighlights / stageHighlightIds) and must not tint the table until
    // Search; the table-header path (applyHighlightIdsInstant) mirrors its change onto
    // this frozen `state`, so a header highlight still shows instantly. Keyed by the
    // rendered columns' own `ns`. Never enters buildQuery — numbers untouched.
    const highlightSet = new Set(
      (state.highlightedColumns && state.highlightedColumns[ns]) || []
    );

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
        ${cols.map((c) => headerCellHTML(c.m, state, highlightSet.has(c.slotId), c.slotId)).join("")}
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
        const cells = cols.map((c) => dataCellHTML(c.m, row, highlightSet.has(c.slotId), c.slotId)).join("");
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

    // E2 (owner 2026-08-08): the metric header is split into two click gestures,
    // both re-bound on every renderLoaded (like the drag handler below):
    //   • the ▲/▼ SORT ARROW re-sorts by that column INSTANTLY via sortByColumn —
    //     the SAME path the Columns section's per-copy Sort-by control uses (so the
    //     two are two-way bound), now passed THIS copy's slot id so a duplicated
    //     stat sorts by the exact copy clicked;
    //   • a click ANYWHERE ELSE on the header toggles that copy's HIGHLIGHT
    //     (toggleHeaderHighlight → the same per-slot highlightedColumns set + repaint
    //     the popup's Highlight control reads/writes — two-way bound too).
    // The sort-state class (is-sorted / arrow direction) reflects the FROZEN `state`
    // and is recomputed on every renderLoaded, so it stays on the applied sort until
    // the next re-sort. A drop (drag end) sets lastHeaderDragEndTs; a trailing click
    // within that window is ignored so a drag never ALSO sorts/highlights. The sticky
    // Player header is EXCLUDED here (task 6/7) — it keeps its own single-click-sort
    // vs double-click-expand handling.
    theadEl.querySelectorAll(".data-table__th[data-key]:not(.data-table__th--sticky)").forEach((th) => {
      const key = th.dataset.key;
      const slotId = th.dataset.slotId || null;
      const sortArrow = th.querySelector(".data-table__sort-arrow");
      if (sortArrow) {
        sortArrow.addEventListener("click", (e) => {
          e.stopPropagation(); // the arrow sorts; don't also toggle the header's highlight
          if (Date.now() - lastHeaderDragEndTs < 250) return; // ignore a drop's trailing click
          sortByColumn(key, slotId);
        });
      }
      th.addEventListener("click", (e) => {
        if (e.target.closest(".data-table__sort-arrow")) return; // arrow handled above
        if (Date.now() - lastHeaderDragEndTs < 250) return; // ignore a drop's trailing click
        toggleHeaderHighlight(ns, slotId);
      });
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
          sortByColumn("name");
          return;
        }
        if (nameClickTimer) {
          clearTimeout(nameClickTimer);
          nameClickTimer = null;
        }
        nameClickTimer = setTimeout(() => {
          nameClickTimer = null;
          sortByColumn("name");
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
    // Column drag-to-RESIZE (Stage 3 / decision 77.5) rides the same
    // --draggable set — every metric header, same scope as reorder; not the
    // sticky Player column (it auto-sizes to its content — widestNameColWidthPx
    // — and not the pin/rank control columns, which are fixed-width icons).
    theadEl.querySelectorAll(".data-table__th--draggable").forEach((th) => {
      wireColumnDrag(th, ns);
      const handle = th.querySelector(".data-table__th-resizer");
      if (handle) wireColumnResize(handle, th);
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
      // metricNsFor: a fielding sort key resolves under "batting", so the fielding
      // board's Matches/Catches sort never wrongly trips this fallback. Byte-identical
      // for batting/bowling/matchup (metricNsFor === effectiveDiscipline there).
      if (!resolveSortMetric(preState.sort.key, metricNsFor(preState))) {
        // E1a: attach the fallback sort to its slot (the slot showing the fallback key
        // in the effective namespace), so the arrow lands on the right column. Fielding
        // falls back to Matches (its first/left-most column); batting→runs, bowling→wickets.
        const fbNs = effectiveDiscipline(preState);
        const fbKey =
          preState.discipline === "batting"
            ? "runs"
            : preState.discipline === "fielding"
            ? "matches"
            : "wickets";
        const fbSlot = (preState.columns[fbNs] || []).find((s) => s.key === fbKey) || null;
        store.set({ sort: { key: fbKey, dir: "desc", slotId: fbSlot ? fbSlot.id : null } });
      }

      // Restricted picker (D4 R3 follow-up): the matchup namespaces get the same
      // phase-eligibility prune as the plain picker, so this runs unconditionally
      // regardless of mode.
      pruneInvalidColumns();
      state = store.get();
    }
    const ns = effectiveDiscipline(state);
    // E1a Step 2: hand buildQuery the DISTINCT metric keys across the slots so each
    // stat's SQL is emitted exactly once (two slots showing the same stat → one
    // SELECT, no double-count). With today's unique-key columns this equals the old
    // key array, so the emitted SQL is byte-identical.
    const cols = distinctSlotKeys(state.columns[ns]);
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
      // reorderPreservingPrevious. Column-header clicks (and the Columns
      // section's Sort-by control) re-sort client-side elsewhere (sortByColumn),
      // untouched by this.
      const doSort = resort || !prevRows || prevRows.length === 0;
      const sorted = doSort ? applySort(merged, state) : reorderPreservingPrevious(merged, prevRows, state);

      // R5-B #0: a genuine sort (doSort) makes the displayed order an active
      // column sort → the arrow shows; an order-preserving commit clears it.
      // A pin requery passes preserveSortFlag so pinning never flips the arrow
      // (the pin only floats a row on top; the non-pinned order is unchanged).
      if (!preserveSortFlag) orderIsActiveSort = doSort;
      // R1: this load settles the displayed order, so any picker-only staged-sort
      // indicator is now applied (or superseded) — clear it so the picker tracks the
      // real applied sort, not a leftover staged flag.
      stagedSortPending = false;

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
