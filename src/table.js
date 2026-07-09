// src/table.js
//
// Query builder + table renderer for Compare Stats (SPEC §5.3/§5.4). Builds ONE
// grouped query per the metrics.js contract, plus a separate player_matches
// query when the "matches" column is visible, joined in JS by player_id.
//
// hasMetricData (§8.1) is the ONLY no-data predicate — used both to gate
// advanced-filter conditions on rate/ratio metrics and to render "—" for
// no-data cells (NULL already renders "—"; this module never coalesces ratios).

import { getMetric, hasMetricData, matchupBucketLabel } from "./metrics.js";
import { query } from "./db.js";
import { buildScopeClauses } from "./filters.js";
import { activeGroups } from "./advanced.js";
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
} from "./state.js";

export { eligibleMetrics };

function esc(s) {
  return String(s).replace(/'/g, "''");
}

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

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
 * Build the matchup-mode query pair: the main grouped stat query (columns
 * picked from the restricted matchup picker, `state.columns[ns]`; HAVING only
 * the min-innings gate) and a coverage query — same scope minus the bucket
 * predicate (search stays) — grouped by id, giving {total, mapped} balls per
 * player. No coverage figure, no stat (SPEC_ADDENDUM D4.3): src/table.js's
 * renderer must show both together.
 */
function buildMatchupQuery(state, discipline) {
  const view = MATCHUP_VIEW[discipline];
  const ns = MATCHUP_NS[discipline];
  const idCol = MATCHUP_ID_COL[discipline];
  const nameCol = MATCHUP_NAME_COL[discipline];
  const teamCol = MATCHUP_TEAM_COL[discipline];
  const oppCol = MATCHUP_OPP_COL[discipline];
  const ballsCol = MATCHUP_BALLS_COL[discipline];
  const groupCol = MATCHUP_GROUP_COL[discipline];

  const metrics = (state.columns[ns] || []).map((key) => getMetric(key, ns)).filter(Boolean);
  const selectParts = [`${idCol} AS id`, `${nameCol} AS name`];
  for (const m of metrics) {
    selectParts.push(`${m.sqlExpression} AS ${m.key}`);
    if (m.sortExpression) selectParts.push(`${m.sortExpression} AS ${m.key}__sort`);
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

  const mv = state.matchupVs;
  const bucketCol = mv.dim === "hand" ? "batting_hand" : mv.dim === "type" ? "bowling_type" : "bowling_group";
  const bucketClause = `${bucketCol} = '${esc(mv.value)}'`;
  const searchClause =
    state.search && state.search.trim() ? `${nameCol} ILIKE '%${esc(state.search.trim())}%'` : null;

  const whereClauses = buildScopeClauses(state, scopeOpts);
  whereClauses.push(bucketClause);
  if (searchClause) whereClauses.push(searchClause);

  // Min-innings gate: use the namespace's OWN "innings" metric expression, not
  // a bare COUNT(*) — matchup_bowling's grain (D4-R4) now spans multiple rows
  // per (match, innings) once batting_position is in the primary key, so
  // COUNT(*) would overcount innings by the number of position buckets faced.
  const inningsMetric = getMetric("innings", ns);
  const havingParts = [`(${inningsMetric.sqlExpression}) >= ${Math.max(1, Number(state.minInnings) || 1)}`];
  const advHaving = advancedToHaving(state.advanced, ns);
  if (advHaving) havingParts.push(advHaving);

  const sql = [
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, ${nameCol}`,
    `HAVING ${havingParts.join(" AND ")}`,
  ].join("\n");

  // Coverage: identical scope minus ONLY the bucket predicate (search kept).
  const coverageWhere = buildScopeClauses(state, scopeOpts);
  if (searchClause) coverageWhere.push(searchClause);
  const coverageSql = [
    `SELECT ${idCol} AS id,`,
    `       SUM(${ballsCol}) AS total,`,
    `       SUM(CASE WHEN ${groupCol} <> '(unmapped)' THEN ${ballsCol} ELSE 0 END) AS mapped`,
    `FROM ${view}`,
    `WHERE ${coverageWhere.join(" AND ")}`,
    `GROUP BY ${idCol}`,
  ].join("\n");

  return { sql, matchesSql: null, splitDim: null, coverageSql };
}

/** Build a HAVING predicate for one advanced condition, honoring §8.1 no-data semantics. */
function conditionToHaving(cond, discipline) {
  const metric = getMetric(cond.metricKey, discipline);
  if (!metric) return null;
  const expr = metric.sqlExpression;
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

function advancedToHaving(advanced, discipline) {
  const groups = activeGroups(advanced);
  if (groups.length === 0) return null;
  const parts = groups
    .map((g) => {
      const condSql = g.conds.map((c) => conditionToHaving(c, discipline)).filter(Boolean);
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
 * is visible AND still answerable from player_matches (see below).
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
    return buildMatchupQuery(state, discipline);
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

  const havingParts = [`COUNT(*) >= ${Math.max(1, Number(state.minInnings) || 1)}`];
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
    `HAVING ${havingParts.join(" AND ")}`,
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

  return { sql, matchesSql, splitDim, coverageSql: null };
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

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Table controller ─────────────────────────────────────────────────────────

export function mountTable(container, store, { onPlayerClick } = {}) {
  let lastRows = [];
  let loadToken = 0;
  // The split dimension the CURRENT lastRows were queried with (null = no
  // split). Rendering and split-column sorting must use this, not live state —
  // the state may have moved on while the table still shows the old result.
  let lastSplitDim = null;
  // The distinct bowling_type values (matchup mode's fine "Bowling type"
  // optgroup), fetched once from ./db.js and cached — small, format-agnostic
  // lookup that never changes at runtime.
  let bowlingTypesCache = null;
  let lastBowlingTypes = [];

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
    } catch (e) {
      bowlingTypesCache = [];
    }
    return bowlingTypesCache;
  }

  function renderLoading() {
    container.innerHTML = `
      <div class="table-toolbar">
        <div class="table-toolbar__row-count">Loading…</div>
      </div>
      <div class="table-loading-overlay" aria-live="polite">Running query…</div>
      <div class="table-scroll"><table class="data-table"><tbody></tbody></table></div>
    `;
  }

  /**
   * Blank/prompt state (owner: no automated search — the table stays empty until
   * "Show results" is clicked, and reverts here whenever the filters change so it
   * never shows numbers for a scope the filters no longer describe, §8.4).
   */
  function renderPrompt() {
    container.innerHTML = `
      <div class="table-prompt">
        <p class="table-prompt__text">Choose your filters, then show the results.</p>
        <button type="button" class="btn btn--primary" data-role="show-results">Show results</button>
      </div>
    `;
    const btn = container.querySelector('[data-role="show-results"]');
    if (btn) btn.addEventListener("click", () => load());
  }

  function renderError(err, retryFn) {
    container.innerHTML = `
      <div class="error-box">
        <p>${(err && (err.userMessage || err.message)) || "Something went wrong running the query."}</p>
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

  function renderTable(rows, state, bowlingTypes = lastBowlingTypes) {
    const matchupOn = matchupVsActive(state);
    const ns = effectiveDiscipline(state);
    const splitDim = matchupOn ? null : lastSplitDim;
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

    const theadHTML = `
      <tr>
        <th class="data-table__th data-table__th--sticky" scope="col">Player</th>
        ${coverageTh}
        ${splitTh}
        ${cols.map((m) => headerCellHTML(m, state)).join("")}
      </tr>`;

    const tbodyHTML = rows
      .map((row) => {
        const coverageTd = matchupOn
          ? `<td class="data-table__td data-table__td--coverage">${coverageLabel(row.coverage)}</td>`
          : "";
        const splitTd = splitDim
          ? `<td class="data-table__td data-table__td--split">${row.split_value == null ? "—" : escHtml(row.split_value)}</td>`
          : "";
        const cells = cols
          .map((m) => `<td class="data-table__td">${formatValue(m, row[m.key])}</td>`)
          .join("");
        // Player names link to the player page (R2, decision 29).
        const nameCell = onPlayerClick
          ? `<button type="button" class="player-link" data-player-id="${escHtml(row.id ?? "")}">${escHtml(row.name ?? "")}</button>`
          : escHtml(row.name ?? "");
        return `<tr><td class="data-table__td data-table__td--sticky">${nameCell}</td>${coverageTd}${splitTd}${cells}</tr>`;
      })
      .join("");

    // Split rows are (player × split value), so "players" would be dishonest.
    const countLabel = splitDim
      ? `${rows.length} row${rows.length === 1 ? "" : "s"} (${splitDim.label.toLowerCase()} split)`
      : `${rows.length} player${rows.length === 1 ? "" : "s"} match`;

    // Column presets (R1) and "Group rows" don't apply in matchup mode — no
    // row-grouping there — a muted toolbar note replaces them instead. The
    // column SET is still pickable via "Customise…" (restricted picker, D4 R3
    // follow-up: the matchup vocabulary, not the fixed set it used to be).
    // Position filters DO apply in both modes now (D4-R4) — only the honest
    // stat-condition applicability note remains conditional.
    const { total: condTotal, applied: condApplied } = conditionApplicability(state.advanced, ns);
    const conditionNoteText =
      condTotal > 0 && condApplied < condTotal ? `${condApplied} of ${condTotal} stat conditions apply here` : "";

    let presetsOrNoteHTML = "";
    let groupRowsHTML = "";
    let columnsBtnHTML = "";
    if (matchupOn) {
      const matchupNote = conditionNoteText ? `Matchup mode, ${conditionNoteText}` : "Matchup mode";
      presetsOrNoteHTML = `<div class="table-toolbar__matchup-note">${matchupNote}</div>`;
      columnsBtnHTML = `<button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Customise…</button>`;
    } else {
      // Column presets (R1): one-click sets; the active chip is the preset whose
      // columns exactly match the current selection (none = "Customise" territory).
      const currentPreset = activePresetKey(state.discipline, state.formats, visibleColumns());
      const presetChipsHTML = COLUMN_PRESET_DEFS[state.discipline]
        .map((def) => {
          const available = def.columns(state.formats) !== null;
          return `<button type="button" class="chip chip--preset ${def.key === currentPreset ? "is-active" : ""}"
            data-preset="${def.key}" ${available ? "" : `disabled title="Pick a single phase family (T20, or ODI/ODM) to use phase columns"`}>${def.label}</button>`;
        })
        .join("");
      const normalConditionNoteHTML = conditionNoteText
        ? `<div class="table-toolbar__matchup-note">${conditionNoteText}</div>`
        : "";
      presetsOrNoteHTML = `<div class="table-toolbar__presets" role="group" aria-label="Column presets">${presetChipsHTML}</div>${normalConditionNoteHTML}`;

      // "Group rows" (decision 29: row-splitting kept, tucked in the toolbar).
      // A presentation control like the column picker, so changes reload directly
      // (no Show-results round trip — the scope hasn't changed, only its layout).
      const groupOptionsHTML = ["", ...Object.keys(SPLIT_DIMENSIONS)]
        .map((key) => {
          if (key === "") return `<option value="">No grouping</option>`;
          const dim = SPLIT_DIMENSIONS[key];
          const allowed = splitAllowed(state, key);
          return `<option value="${key}" ${allowed ? "" : "disabled"} ${state.splitBy === key ? "selected" : ""}>${dim.label}</option>`;
        })
        .join("");
      groupRowsHTML = `<label class="table-toolbar__group-label">Group rows
        <select class="select select--compact" data-role="group-rows" aria-label="Group rows">${groupOptionsHTML}</select>
      </label>`;
      columnsBtnHTML = `<button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Customise…</button>`;
    }

    // "Vs" matchup select (D4 R3, decision 33): ALWAYS rendered, both modes —
    // greyed for women (no style data yet, decision 21), presentation-mode
    // control like Group rows (changes reload directly).
    const vsDisabled = state.gender === "female";
    const vsTitle = vsDisabled ? ` title="No style data for women's cricket yet"` : "";
    const vsSelectHTML = `<label class="table-toolbar__group-label">Vs
      <select class="select select--compact" data-role="matchup-vs" aria-label="Matchup opponent" ${vsDisabled ? "disabled" : ""}${vsTitle}>${matchupVsOptionsHTML(state, bowlingTypes)}</select>
    </label>`;

    container.innerHTML = `
      <div class="table-toolbar">
        <div class="table-toolbar__row-count">${countLabel}</div>
        ${presetsOrNoteHTML}
        <div class="table-toolbar__actions">
          ${vsSelectHTML}
          ${groupRowsHTML}
          ${columnsBtnHTML}
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>${theadHTML}</thead>
          <tbody>${tbodyHTML}</tbody>
        </table>
      </div>
    `;

    container.querySelectorAll(".chip--preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const def = COLUMN_PRESET_DEFS[state.discipline].find((d) => d.key === btn.dataset.preset);
        const cols = def ? def.columns(store.get().formats) : null;
        if (!cols) return;
        const s = store.get();
        store.set({ columns: { ...s.columns, [s.discipline]: cols } });
        load();
      });
    });

    const groupSelect = container.querySelector('[data-role="group-rows"]');
    if (groupSelect) {
      groupSelect.addEventListener("change", () => {
        store.set({ splitBy: groupSelect.value || null });
        load();
      });
    }

    const vsSelect = container.querySelector('[data-role="matchup-vs"]');
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

    // Sorting: click header to sort/flip. Re-sorts the cached rows client-side
    // (no requery needed — the result set is unchanged, only its order).
    container.querySelectorAll(".data-table__th[data-key]").forEach((th) => {
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
        renderTable(lastRows, next, bowlingTypes);
      });
    });

    if (onPlayerClick) {
      container.querySelectorAll(".player-link").forEach((btn) => {
        btn.addEventListener("click", () => {
          onPlayerClick(btn.dataset.playerId, btn.textContent);
        });
      });
    }

    const columnsBtn = container.querySelector('[data-role="columns-btn"]');
    if (columnsBtn) {
      columnsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openColumnsPopover(columnsBtn);
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
   */
  function openColumnsPopover(anchor) {
    document.querySelectorAll(".columns-popover").forEach((el) => el.remove());
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
    popover.innerHTML = section("Basic", basic) + section("Dismissals", dismissal) + section("Phase", phase);
    anchor.parentElement.appendChild(popover);

    popover.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
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
        load();
      });
    });

    setTimeout(() => {
      document.addEventListener(
        "click",
        function handler(e) {
          if (e.target.closest(".columns-popover") || e.target === anchor) {
            document.addEventListener("click", handler, { once: true });
            return;
          }
          popover.remove();
        },
        { once: true }
      );
    }, 0);
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
    const { sql, matchesSql, splitDim, coverageSql } = buildQuery(state, cols, { split: true });
    const token = ++loadToken;
    renderLoading();
    try {
      const [{ rows }, matchesResult, coverageResult, bowlingTypes] = await Promise.all([
        query(sql),
        matchesSql ? query(matchesSql) : Promise.resolve({ rows: [] }),
        coverageSql ? query(coverageSql) : Promise.resolve({ rows: [] }),
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
      if (coverageSql) {
        const covById = new Map(coverageResult.rows.map((r) => [r.id, { mapped: r.mapped ?? 0, total: r.total ?? 0 }]));
        merged = merged.map((r) => ({ ...r, coverage: covById.get(r.id) ?? { mapped: 0, total: 0 } }));
      }

      // A stale "__split" sort (split since turned off) falls back to unsorted;
      // applySort handles both metric and split-column sorts.
      const sorted = applySort(merged, state);

      lastRows = sorted;
      renderTable(sorted, state, bowlingTypes);
    } catch (err) {
      if (token !== loadToken) return;
      renderError(err, load);
    }
  }

  return { load, showPrompt: renderPrompt };
}
