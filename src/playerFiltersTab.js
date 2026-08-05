// src/playerFiltersTab.js
//
// Tab-2 "Filters" — the per-player filtered-row table (T-2a: DATA PATH +
// RENDERING core; the INTERACTIVE editor is T-2b). Each ROW is a user-defined
// filtered view of the ONE open player's record — a mini-leaderboard whose
// rows are filters instead of players. This file owns the row model, the
// per-row query, and the table render; T-2b replaces the code-seeded rows +
// the "Add Filter Row" placeholder with the real Add-condition palette editor.
//
// Contract (unchanged from the T-F1 shell):
//   mountPlayerFiltersTab(container, { store, playerId, discipline, pageState })
//     -> { show(playerId, discipline, pageState), destroy() }
//
// ── The per-row query (the crux — numbers sacred, CLAUDE.md Rule 1) ──────────
// Each row reuses the leaderboard's own `buildQuery` (src/table.js), scoped to ONE
// player by the already-precedented OUTER-WRAP idiom (src/graph/charts.js:59,
// src/graph/benchmark.js:166): build a COMPLETE, CLEAN state, seed ONLY the core
// scope (gender / formats / dateFrom / dateTo / teamType) from the pop-up's
// effective scope, override it with the row's own per-row scope + the tab's shared
// discipline, call buildQuery(rowState, cols, { inningsWhere }), then wrap
//   SELECT * FROM (<sql>) t WHERE id = '<playerId>'
// and run via db.query. A NO-FILTER row passes NO inningsWhere, so it is
// byte-identical to that player's leaderboard row — the correctness anchor.
//
// ── The SLICE ENGINE (T-2b-i) ────────────────────────────────────────────────
// The tab's conditions are PER-INNINGS WHERE SLICES, NOT the leaderboard's
// player-level HAVING gate: "Innings Score ≥ 100" computes the player's stats OVER
// ONLY his 100+ innings, not his whole record kept-or-dropped by a gate.
// conditionToInningsWhere maps each ✅-sign-off condition to a pre-aggregate WHERE
// on the innings-grain column(s); conditionsToInningsWhere combines a row's whole
// set (AND/OR groups) into one predicate, injected via buildQuery's optional
// `inningsWhere` (byte-identical for every existing caller when absent). The row's
// `advanced` block therefore stays EMPTY — conditions never reach HAVING here.
//
// WHY a clean state (createInitialState) and NOT a `{...pageState}` clone: a
// header-search-opened pop-up passes a MINIMAL 5-field pageState
// (playerPage.js buildFixedScopeState) that would crash buildQuery (no
// state.advanced / columns / pinnedPlayers / …). And per the signed-off design
// the Filters tab's per-row scope is Format / Team type / Date + conditions
// ONLY — it must NOT inherit the leaderboard's teams / opposition / event /
// pins / search / matchupVs. Seeding a clean state from the core scope gives
// both: a complete state buildQuery is happy with, and no leaderboard-filter
// leak. (Overview stays the always-full-scope base profile; all filtering
// lives here.)
//
// Columns are INDEPENDENT of the leaderboard's (decision 3): the tab keeps its
// own per-discipline column selection, seeded from the discipline default, and
// reuses the SHARED createColumnsPicker (src/columnsPicker.js) + the shared
// COLUMN_PRESET_DEFS presets — so the later columns rejig flows in for free.
//
// ── Per-row opponent-player / delivery-window (T-2b-i) ───────────────────────
// These are ball-engine ball predicates. db.js used to read them from module
// GLOBALS (setOpponentPlayer / setDeliveryWindow), which would collide across
// CONCURRENT per-row queries. They now flow PER-CALL: fetchRow passes the row's
// own {deliveryWindow, opponentPlayer} to query(sql, opts), which resolves + keys
// them per-SQL so different rows can hold different opponents/windows safely.
// Seeded rows here carry none (explicit null), so the tab is also isolated from
// the leaderboard's global window/opponent. The editor UI that sets them per-row
// is T-2b-ii.

import { query } from "./db.js";
import { buildQuery, formatValue } from "./table.js";
import { getMetric, metricDisplayLabel, DISMISSAL_KINDS } from "./metrics.js";
import {
  createInitialState,
  emptyAdvancedBlock,
  defaultColumnsFor,
  COLUMN_PRESET_DEFS,
  activePresetKey,
  escSql as esc,
} from "./state.js";
import { createColumnsPicker } from "./columnsPicker.js";
import { openFilterRowEditor } from "./playerFilterEditor.js";
import { escHtml, escAttr } from "./html.js";

// "slice" is BANNED from user-facing text (owner ruling). Label a row that
// carries no condition yet.
const NO_CONDITION_LABEL = "No conditions";
const OP_SYMBOLS = { gte: "≥", lte: "≤", eq: "=" };

// ── The per-innings SLICE ENGINE (T-2b-i — numbers sacred, CLAUDE.md Rule 1) ──
// The Filters tab's conditions are PER-INNINGS WHERE SLICES, not the leaderboard's
// player-level HAVING gate. Each condition maps to a pre-aggregate WHERE predicate
// on the innings-grain view column(s), AND-ed into buildQuery's WHERE via its
// `inningsWhere` injection, so aggregates run over ONLY the sliced innings.
//
// The per-innings EXPRESSIONS are each metric's metrics.js aggregate with SUM()
// stripped — i.e. the single-innings value of that quantity. Rates keep the exact
// NULLIF divide-by-zero guard (→ NULL → excluded from any comparison), but carry
// NO "value <> 0" guard: for a SINGLE innings, 0 IS real data (0 off 5 balls is a
// genuine SR of 0), unlike §8.1's AGGREGATE-level "0 == no data" rule. Only the ✅
// sign-off filter set is mapped; anything absent is "not a filter", never wrong.

/** metricKey → per-innings SQL expression, per discipline (SUM() stripped from
 * the metrics.js aggregate — the value of that quantity for ONE innings row). */
const SLICE_COLUMN_EXPR = {
  batting: {
    // amounts
    runs: "runs",
    balls_faced: "balls_faced",
    fours: "fours_hit",
    sixes: "sixes_hit",
    // threshold — Innings Score ≥/≤/=/between → the innings' runs
    innings_score_ge: "runs",
    // rates / percentages
    strike_rate: "runs * 100.0 / NULLIF(balls_faced, 0)",
    dot_pct: "dots * 100.0 / NULLIF(balls_faced, 0)",
    boundary_pct: "(fours_hit + sixes_hit) * 100.0 / NULLIF(balls_faced, 0)",
    boundary_runs_pct: "(4 * fours_hit + 6 * sixes_hit) * 100.0 / NULLIF(runs, 0)",
    running_sr: "non_boundary_runs * 100.0 / NULLIF(balls_faced - fours_hit - sixes_hit, 0)",
    runs_1s_pct: "(1 * ones) * 100.0 / NULLIF(runs, 0)",
    runs_2s_pct: "(2 * twos) * 100.0 / NULLIF(runs, 0)",
    runs_3s_pct: "(3 * threes) * 100.0 / NULLIF(runs, 0)",
    runs_4s_run_pct: "(4 * nb_fours) * 100.0 / NULLIF(runs, 0)",
    runs_4s_boundary_pct: "(4 * fours_hit) * 100.0 / NULLIF(runs, 0)",
    runs_5s_pct: "(5 * fives) * 100.0 / NULLIF(runs, 0)",
    runs_6s_run_pct: "(6 * nb_sixes) * 100.0 / NULLIF(runs, 0)",
    runs_6s_boundary_pct: "(6 * sixes_hit) * 100.0 / NULLIF(runs, 0)",
    balls_faced_share: "balls_faced * 100.0 / NULLIF(team_inns_balls, 0)",
  },
  bowling: {
    // amounts
    wickets: "wickets",
    runs_conceded: "runs_conceded",
    balls: "balls",
    // `overs` shares the balls column; value must be entered in balls — the O.B→
    // balls conversion for a friendly overs input is a T-2b-ii editor concern.
    overs: "balls",
    maidens: "maidens",
    wkt_bowled: "wickets_bowled",
    wkt_lbw: "wickets_lbw",
    wkt_caught: "wickets_caught",
    wkt_caught_and_bowled: "wickets_caught_and_bowled",
    wkt_stumped: "wickets_stumped",
    wkt_hit_wicket: "wickets_hit_wicket",
    // Fours/Sixes Conceded: valid view columns, but no plain-bowling DISPLAY
    // metric exists yet (only boundary_pct_conceded / boundary_runs_pct do) — the
    // slice works if the editor writes these keys; a display metric is a T-2b-ii /
    // columns-rejig follow-up (flagged in the report).
    fours_conceded: "fours_conceded",
    sixes_conceded: "sixes_conceded",
    extras_wides: "wides_runs",
    extras_noballs: "noball_runs",
    // threshold — Wicket Hauls ≥/≤/=/between → the innings' wickets
    wicket_hauls_ge: "wickets",
    // rates / percentages
    economy: "runs_conceded * 6.0 / NULLIF(balls, 0)",
    strike_rate: "balls * 1.0 / NULLIF(wickets, 0)",
    dot_pct: "dots * 100.0 / NULLIF(balls, 0)",
    boundary_pct_conceded: "(fours_conceded + sixes_conceded) * 100.0 / NULLIF(balls, 0)",
    boundary_runs_pct: "(4 * fours_conceded + 6 * sixes_conceded) * 100.0 / NULLIF(runs_conceded, 0)",
  },
};

/** Per-innings BOOLEAN (Y/N) slice predicates: each carries an EXPLICIT yes AND
 * no SQL (hand-built to avoid NULL pitfalls — e.g. "Out Caught = No" must INCLUDE
 * not-out innings, where dismissal_kind IS NULL, so it uses IS DISTINCT FROM).
 * dismissal-type entries derive from DISMISSAL_KINDS so no kind string can drift.
 * PotM (Y/N) is a match-award join, handled specially in conditionToInningsWhere. */
const BOOLEAN_SLICE = { batting: {}, bowling: {} };
BOOLEAN_SLICE.batting.ducks = { yes: "(runs = 0 AND dismissed = 1)", no: "NOT (runs = 0 AND dismissed = 1)" };
BOOLEAN_SLICE.batting.not_outs = { yes: "dismissed = 0", no: "dismissed = 1" };
for (const d of DISMISSAL_KINDS) {
  BOOLEAN_SLICE.batting[d.key] = {
    yes: `dismissal_kind = '${esc(d.kind)}'`,
    no: `dismissal_kind IS DISTINCT FROM '${esc(d.kind)}'`,
  };
}

// PotM (Y/N) — the ONE pop-up filter that isn't an innings column (owner
// 2026-08-03: replaces PotM Count in the pop-up; the leaderboard keeps its own
// PotM Count filter, untouched). It reuses the existing pom_cte's join AT THE
// WHERE LEVEL: a correlated EXISTS on player_matches (player_of_match is the 0/1
// per-match award flag). Composable with Team/date for free — the outer innings
// rows are already team/date-scoped, so restricting to matches the player did/
// didn't win PotM needs no extra scope. "No" = NOT a PotM-winning match (robust
// to a missing player_matches row). Available in BOTH batting and bowling tabs.
const POTM_METRIC_KEY = "potm";
const SLICE_VIEW_NAME = { batting: "batting", bowling: "bowling" };
const SLICE_ID_COL = { batting: "batter_id", bowling: "bowler_id" };
function potmSlice(discipline, yes) {
  const view = SLICE_VIEW_NAME[discipline];
  const idCol = SLICE_ID_COL[discipline];
  const exists =
    `EXISTS (SELECT 1 FROM player_matches pm WHERE pm.match_id = ${view}.match_id` +
    ` AND pm.player_id = ${view}.${idCol} AND pm.player_of_match = 1)`;
  return yes ? exists : `NOT ${exists}`;
}

const SLICE_OP_SQL = { gte: ">=", lte: "<=", eq: "=" };

/** A boolean (Y/N) condition carries a `yn` boolean; a numeric one carries
 * operator + v1(/v2). */
function isBooleanCond(cond) {
  return typeof cond.yn === "boolean";
}

/** True when a metric KEY is a Y/N boolean slice in this discipline (Ducks /
 * Not Outs / a dismissal-type / PotM) rather than a numeric quantity — the editor
 * uses this to route a palette pick to the Y/N control vs the operator+value one. */
export function isBooleanMetric(metricKey, discipline) {
  if (metricKey === POTM_METRIC_KEY) return true;
  const map = BOOLEAN_SLICE[discipline];
  return Boolean(map && map[metricKey]);
}

/** True when a metric KEY is OFFERED as a per-row filter in the pop-up palette:
 * the slice engine can compute it per innings AND the owner offers it as a filter.
 * Bowling Strike Rate is slice-computable but ruled a COLUMN-only stat (owner ✅/❌
 * 2026-08-03), so it is the one engine-sliceable key withheld. paletteGroups.js's
 * "popup" surface consults this (as `metricSliceable`) so the ❌ column-only
 * metrics fall out of the palette with no drift-prone key list. */
export function isPopupFilterMetric(metricKey, discipline) {
  if (discipline === "bowling" && metricKey === "strike_rate") return false;
  const num = SLICE_COLUMN_EXPR[discipline];
  if (num && num[metricKey]) return true;
  return isBooleanMetric(metricKey, discipline);
}

/** True when a condition is complete AND sliceable in this discipline. Boolean →
 * yn set + a predicate exists; numeric → its expr is mapped + v1 finite (+ v2 for
 * "between"). Local to the tab: the slice model differs from advanced.js's
 * numeric-only HAVING completeness (which would drop Y/N conditions). */
function isSliceConditionComplete(cond, discipline) {
  if (!cond || !cond.metricKey) return false;
  if (isBooleanCond(cond)) {
    return cond.metricKey === POTM_METRIC_KEY || Boolean(BOOLEAN_SLICE[discipline] && BOOLEAN_SLICE[discipline][cond.metricKey]);
  }
  const map = SLICE_COLUMN_EXPR[discipline];
  if (!map || !map[cond.metricKey]) return false;
  if (!Number.isFinite(Number(cond.v1))) return false;
  if (cond.operator === "between" && !Number.isFinite(Number(cond.v2))) return false;
  return true;
}

/** Groups (and conditions within) that are complete + sliceable — the slice
 * analog of advanced.js's activeGroups (which drops Y/N conditions). Keeps each
 * group's op for AND/OR composition. */
function sliceActiveGroups(conditions, discipline) {
  return ((conditions && conditions.groups) || [])
    .map((g) => ({ ...g, conds: (g.conds || []).filter((c) => isSliceConditionComplete(c, discipline)) }))
    .filter((g) => g.conds.length > 0);
}

/**
 * Map ONE condition to its per-innings WHERE SQL, or null if not sliceable — the
 * numbers crux of T-2b-i. Numeric: `(<expr>) <op> <value>` (value coerced to a
 * finite number — no injection surface). Boolean: the metric's yes/no predicate.
 * PotM: the correlated award EXISTS. Restricted to the ✅ sign-off set.
 */
function conditionToInningsWhere(cond, discipline) {
  if (!isSliceConditionComplete(cond, discipline)) return null;
  if (isBooleanCond(cond)) {
    if (cond.metricKey === POTM_METRIC_KEY) return potmSlice(discipline, cond.yn);
    const b = BOOLEAN_SLICE[discipline][cond.metricKey];
    return `(${cond.yn ? b.yes : b.no})`;
  }
  const expr = SLICE_COLUMN_EXPR[discipline][cond.metricKey];
  const v1 = Number(cond.v1);
  if (cond.operator === "between") {
    const v2 = Number(cond.v2);
    const lo = Math.min(v1, v2);
    const hi = Math.max(v1, v2);
    return `((${expr}) BETWEEN ${lo} AND ${hi})`;
  }
  const op = SLICE_OP_SQL[cond.operator];
  if (!op) return null;
  return `((${expr}) ${op} ${v1})`;
}

/** Combine a row's whole condition set into ONE per-innings WHERE (or null when
 * nothing is set → a no-filter row, byte-identical to the leaderboard). Mirrors
 * table.js's advancedToHaving AND/OR group composition exactly. */
function conditionsToInningsWhere(conditions, discipline) {
  const groups = sliceActiveGroups(conditions, discipline);
  if (groups.length === 0) return null;
  const parts = groups
    .map((g) => {
      const condSql = g.conds.map((c) => conditionToInningsWhere(c, discipline)).filter(Boolean);
      if (condSql.length === 0) return null;
      const joiner = g.op === "OR" ? " OR " : " AND ";
      return condSql.length > 1 ? `(${condSql.join(joiner)})` : condSql[0];
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  const topJoiner = conditions && conditions.op === "OR" ? " OR " : " AND ";
  return parts.length > 1 ? `(${parts.join(topJoiner)})` : parts[0];
}

// ── Row model (T-2b-ii — rows are USER-DEFINED via the editor) ───────────────
// The T-2a/T-2b-i code-seeded proof rows are gone; every row now comes from the
// "Add Filter Row" editor (playerFilterEditor.js). A row carries its own per-row
// `scope` (Format / Team type / Date) + the local `conditions` block the editor
// built. Per-row ball predicates (opponent / delivery window) stay null in this
// wave — their editors land next; the T-2b-i query threading is already in place.
// `id`s are stable strings so re-renders keep row identity (sort / pin / edit).
let rowSeq = 0;
const nextRowId = () => `row-${++rowSeq}`;

function makeRow(conditions, scope) {
  return {
    id: nextRowId(),
    scope: scope || { formats: null, dateFrom: null, dateTo: null, teamType: null },
    conditions: conditions || emptyAdvancedBlock(),
    deliveryWindow: null,
    opponentPlayer: null,
    pinned: false,
  };
}

// Inline SVG icons (no per-icon network; PIN reuses the leaderboard's pushpin so
// a pinned row reads identically. PENCIL = Material "edit").
const PIN_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';
const PENCIL_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';

// ── Row identity label (first condition, LITERAL operator form) ──────────────
// The signed-off design: the first cell = the row's FIRST condition as plain text
// in literal operator form (e.g. "Innings Score ≥ 100" verbatim), like the
// leaderboard's player-name column. >1 condition surfaces the full list via an (i)
// marker (title-attr for now; T-2b-ii builds the hover popover).

/** Friendly, operator-token-stripped base name for a condition's metric. */
function conditionBaseName(cond, discipline, formats) {
  if (cond.metricKey === POTM_METRIC_KEY) return "PotM";
  const metric = getMetric(cond.metricKey, discipline) || getMetric(cond.metricKey);
  if (!metric) return cond.metricKey;
  // Threshold metrics carry a "≥ N" token in their label — strip it so a slice
  // reads "Innings Score ≥ 100" (the user's own operator + value), not "≥ N".
  if (metric.paramTemplate) return (metric.label || cond.metricKey).replace(/\s*[≥≤=]\s*N\b.*$/, "").trim();
  // Drop the leading "Out " on the batting dismissal-type booleans so a row reads
  // "Caught = Yes" (matching the palette's stripped labels); a no-op for others.
  return (metricDisplayLabel(metric, formats) || metric.label || cond.metricKey).replace(/^Out\s+/, "");
}

function conditionLiteralLabel(cond, discipline, formats) {
  const base = conditionBaseName(cond, discipline, formats);
  if (isBooleanCond(cond)) return `${base} = ${cond.yn ? "Yes" : "No"}`;
  if (cond.operator === "between") return `${base} ${cond.v1}–${cond.v2}`;
  return `${base} ${OP_SYMBOLS[cond.operator] ?? cond.operator} ${cond.v1}`;
}

/** Every complete condition on a row, as literal-form strings (for the (i)). */
function allConditionLabels(conditions, discipline, formats) {
  const out = [];
  for (const g of sliceActiveGroups(conditions || emptyAdvancedBlock(), discipline)) {
    for (const c of g.conds) out.push(conditionLiteralLabel(c, discipline, formats));
  }
  return out;
}

function rowLabel(row, discipline, formats) {
  const labels = allConditionLabels(row.conditions, discipline, formats);
  return labels.length ? labels[0] : NO_CONDITION_LABEL;
}

// ── Per-row query ────────────────────────────────────────────────────────────

/** Build the COMPLETE, CLEAN buildQuery state for one row (see file header). The
 * row's conditions are NOT put on `state.advanced` — the Filters tab slices
 * per-innings via buildQuery's `inningsWhere` (fetchRow), never HAVING — so the
 * advanced block stays EMPTY here (this keeps buildQuery's HAVING path off). */
function buildRowState(row, pageState, discipline) {
  const base = createInitialState(null); // complete neutral state; dateTo overridden below
  const scope = row.scope || {};
  const ps = pageState || {};
  return {
    ...base,
    discipline,
    gender: ps.gender ?? base.gender, // inert (id pins gender) but kept honest
    formats: scope.formats ?? ps.formats ?? base.formats,
    dateFrom: scope.dateFrom ?? ps.dateFrom ?? base.dateFrom,
    dateTo: scope.dateTo ?? ps.dateTo ?? base.dateTo,
    teamType: scope.teamType ?? ps.teamType ?? base.teamType,
    advanced: emptyAdvancedBlock(),
  };
}

/**
 * Run ONE row's query. buildRowState (clean, conditions off HAVING) → the row's
 * per-innings SLICE compiled by conditionsToInningsWhere → buildQuery(state, cols,
 * { inningsWhere }) → outer-wrap WHERE id = player → db.query. Returns the single
 * aggregate row object, or null when the player has no innings under the row's
 * slice (→ every cell "—"). The row's own opponent/window flow PER-CALL to
 * query() (T-2b-i threading), so concurrent rows never cross ball predicates and
 * the tab is isolated from the leaderboard's globals. The "matches" secondary
 * query (matchesSql, present only for a NO-slice row — a slice makes matches
 * innings-level inside the main sql) is fetched with the same wrap+merge + the
 * same per-call opts.
 */
async function fetchRow(row, playerId, pageState, discipline, cols) {
  const rowState = buildRowState(row, pageState, discipline);
  const inningsWhere = conditionsToInningsWhere(row.conditions, discipline);
  const { sql, matchesSql } = buildQuery(rowState, cols, { inningsWhere });
  const wrapped = `SELECT * FROM (\n${sql}\n) t\nWHERE id = '${esc(playerId)}'`;
  const qOpts = { deliveryWindow: row.deliveryWindow ?? null, opponentPlayer: row.opponentPlayer ?? null };
  const tasks = [query(wrapped, qOpts)];
  if (matchesSql) tasks.push(query(`SELECT * FROM (\n${matchesSql}\n) mt\nWHERE id = '${esc(playerId)}'`, qOpts));
  const [mainRes, matchesRes] = await Promise.all(tasks);
  let out = mainRes.rows[0] || null;
  if (matchesSql && out) {
    const m = matchesRes.rows[0];
    out = { ...out, matches: m ? m.matches : null };
  }
  return out;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function mountPlayerFiltersTab(container, { store, playerId, discipline, pageState } = {}) {
  void store; // the tab is store-independent (per-row queries are self-contained)
  let curPlayerId = playerId ?? null;
  let curDiscipline = discipline === "bowling" ? "bowling" : "batting";
  let curPageState = pageState || null;
  let rows = []; // user-defined via the editor; empty ⇒ "No filtered rows yet"
  let fetchToken = 0;

  // Per-row query results, keyed by row id: `undefined` = loading, `null` = the
  // player has no innings under the row, `{__error:true}` = query failed, else the
  // aggregate row. Cached so sort / pin re-order WITHOUT re-querying.
  const rowData = new Map();

  // Sticky per-row scope: a new "Add Filter Row" pre-fills Format / Team type /
  // Date from the LAST committed row (owner 2026-08-03); null ⇒ the pop-up scope.
  let lastScope = null;

  // Display sort. `key` = a metric column key, "__label" for the Filter column,
  // or null for add-order. Pinned rows always float to the top (like the
  // leaderboard); NO Best/Worst, NO baseline row.
  const sortState = { key: null, dir: "desc" };

  // Tab-INDEPENDENT column selection (decision 3), lazily seeded per discipline
  // from the discipline default.
  const tabColumns = { batting: null, bowling: null };

  function currentFormats() {
    return (curPageState && curPageState.formats) || ["T20"];
  }

  /** The pop-up's effective scope, as the editor's default for a FIRST row (so a
   * no-condition row with this scope == the player's leaderboard row). */
  function defaultScope() {
    const ps = curPageState || {};
    return {
      formats: [...currentFormats()],
      dateFrom: ps.dateFrom ?? null,
      dateTo: ps.dateTo ?? null,
      teamType: ps.teamType ?? "international",
    };
  }

  function columnsFor(disc) {
    if (!tabColumns[disc]) tabColumns[disc] = defaultColumnsFor(disc, currentFormats());
    return tabColumns[disc];
  }

  // ONE shared columns picker instance (reused across refreshes; its popover
  // lives on document.body so a table re-render never destroys it).
  const columnsPicker = createColumnsPicker({
    getColumns: () => columnsFor(curDiscipline),
    setColumns: (cols) => {
      tabColumns[curDiscipline] = cols;
      syncPresetSelect();
      refreshData(true); // the SELECT list changed → re-query every row
    },
    getDiscipline: () => curDiscipline,
    getFormats: () => currentFormats(),
  });

  // ---------- the editor ----------

  function openEditor(mode, existingRow) {
    const initialScope =
      mode === "edit" ? { ...existingRow.scope } : lastScope ? { ...lastScope } : defaultScope();
    openFilterRowEditor(document, {
      mode,
      initialConditions: mode === "edit" ? existingRow.conditions : emptyAdvancedBlock(),
      initialScope,
      discipline: curDiscipline,
      gender: curPageState && curPageState.gender,
      formats: currentFormats(),
      isBooleanMetric,
      isPopupFilterMetric,
      conditionBaseName,
      onCommit: ({ conditions, scope }) => {
        lastScope = { ...scope }; // sticky
        if (mode === "edit") {
          existingRow.conditions = conditions;
          existingRow.scope = scope;
          rowData.delete(existingRow.id);
          renderRows();
          queryRow(existingRow);
        } else {
          const row = makeRow(conditions, scope);
          rows.push(row);
          rowData.set(row.id, undefined);
          renderRows();
          queryRow(row);
        }
      },
    });
  }

  // ---------- shell (toolbar + table host), rendered once per discipline ----------

  function presetOptionsHTML() {
    const cols = columnsFor(curDiscipline);
    const active = activePresetKey(curDiscipline, currentFormats(), cols);
    const opts = COLUMN_PRESET_DEFS[curDiscipline]
      .map((def) => {
        const disabled = def.columns(currentFormats()) == null; // phases off under this format
        return `<option value="${escAttr(def.key)}" ${active === def.key ? "selected" : ""} ${
          disabled ? "disabled" : ""
        }>${escHtml(def.label)}</option>`;
      })
      .join("");
    // A "Custom" sentinel for a column set that matches no preset.
    const customSel = active == null ? "selected" : "";
    return `<option value="__custom" ${customSel} disabled hidden>Custom</option>${opts}`;
  }

  function renderShell() {
    container.innerHTML = `
      <div class="filters-tab">
        <div class="filters-tab__toolbar">
          <button type="button" class="btn btn--primary filters-tab__add" data-role="add-filter-row">Add Filter Row</button>
          <div class="filters-tab__toolbar-right">
            <select class="select filters-tab__preset" data-role="preset-select" aria-label="Column preset">${presetOptionsHTML()}</select>
            <button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Columns</button>
          </div>
        </div>
        <div class="filters-tab__table-host" data-role="table-host"></div>
      </div>`;

    const addBtn = container.querySelector('[data-role="add-filter-row"]');
    if (addBtn) addBtn.addEventListener("click", () => openEditor("add", null));

    const presetSel = container.querySelector('[data-role="preset-select"]');
    if (presetSel) {
      presetSel.addEventListener("change", () => {
        const def = COLUMN_PRESET_DEFS[curDiscipline].find((d) => d.key === presetSel.value);
        const cols = def && def.columns(currentFormats());
        if (cols) {
          tabColumns[curDiscipline] = cols;
          refreshData(true);
        }
      });
    }

    const columnsBtn = container.querySelector('[data-role="columns-btn"]');
    if (columnsBtn) columnsPicker.mount(columnsBtn);

    // ONE delegated click handler on the persistent table host: sort headers +
    // per-row pin / edit / delete. Survives every innerHTML re-render of the host.
    const host = container.querySelector('[data-role="table-host"]');
    if (host) host.addEventListener("click", onHostClick);
  }

  function onHostClick(e) {
    const sortBtn = e.target.closest(".data-table__sort-btn");
    if (sortBtn) {
      const th = sortBtn.closest("[data-sort-key]");
      if (th) toggleSort(th.dataset.sortKey);
      return;
    }
    const actBtn = e.target.closest("[data-act]");
    if (!actBtn) return;
    const tr = actBtn.closest("tr[data-row-id]");
    if (!tr) return;
    const row = rows.find((r) => r.id === tr.dataset.rowId);
    if (!row) return;
    if (actBtn.dataset.act === "pin") {
      row.pinned = !row.pinned;
      renderRows();
    } else if (actBtn.dataset.act === "edit") {
      openEditor("edit", row);
    } else if (actBtn.dataset.act === "del") {
      rows = rows.filter((r) => r.id !== row.id);
      rowData.delete(row.id);
      renderRows();
    }
  }

  function toggleSort(key) {
    if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    else {
      sortState.key = key;
      sortState.dir = key === "__label" ? "asc" : "desc";
    }
    renderRows();
  }

  function syncPresetSelect() {
    const presetSel = container.querySelector('[data-role="preset-select"]');
    if (!presetSel) return;
    const active = activePresetKey(curDiscipline, currentFormats(), columnsFor(curDiscipline));
    presetSel.value = active ?? "__custom";
  }

  // ---------- ordering ----------

  function valForSort(data, metric) {
    if (!data || data.__error || !metric) return null;
    const v = data[metric.key];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Order rows for display: pinned first (SPEC pin-to-top), then the active
   * column sort (NULL/loading last regardless of direction — SPEC §8.5), else
   * add-order. Reads only the rowData cache, so it never re-queries. */
  function orderedRows() {
    const pinned = rows.filter((r) => r.pinned);
    const rest = rows.filter((r) => !r.pinned);
    if (!sortState.key) return [...pinned, ...rest];
    let cmp;
    if (sortState.key === "__label") {
      cmp = (a, b) => {
        const la = rowLabel(a, curDiscipline, a.scope.formats || currentFormats());
        const lb = rowLabel(b, curDiscipline, b.scope.formats || currentFormats());
        return sortState.dir === "asc" ? la.localeCompare(lb) : lb.localeCompare(la);
      };
    } else {
      const metric = getMetric(sortState.key, curDiscipline);
      cmp = (a, b) => {
        const va = valForSort(rowData.get(a.id), metric);
        const vb = valForSort(rowData.get(b.id), metric);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return sortState.dir === "asc" ? va - vb : vb - va;
      };
    }
    return [...pinned.slice().sort(cmp), ...rest.slice().sort(cmp)];
  }

  // ---------- table render (cache-only; no queries fired here) ----------

  function metricColumns() {
    return columnsFor(curDiscipline)
      .map((key) => getMetric(key, curDiscipline))
      .filter(Boolean);
  }

  function sortArrow(key) {
    return sortState.key === key ? (sortState.dir === "asc" ? " ▲" : " ▼") : "";
  }

  function headerHTML(metrics) {
    const labelSorted = sortState.key === "__label" ? " is-sorted" : "";
    const metricThs = metrics
      .map((m) => {
        const sorted = sortState.key === m.key ? " is-sorted" : "";
        return `<th data-sort-key="${escAttr(m.key)}" class="data-table__th${sorted}" scope="col"><button type="button" class="data-table__sort-btn">${escHtml(
          m.shortLabel || m.label || m.key
        )}${sortArrow(m.key)}</button></th>`;
      })
      .join("");
    return `<thead><tr>
        <th data-sort-key="__label" class="data-table__th data-table__th--sticky${labelSorted}" scope="col"><button type="button" class="data-table__sort-btn">Filter${sortArrow(
          "__label"
        )}</button></th>
        ${metricThs}
      </tr></thead>`;
  }

  function labelCellHTML(row) {
    const formats = row.scope.formats || currentFormats();
    const label = rowLabel(row, curDiscipline, formats);
    const all = allConditionLabels(row.conditions, curDiscipline, formats);
    const info =
      all.length > 1
        ? ` <span class="filters-tab__info" tabindex="0" role="note" title="${escAttr(
            all.join("\n")
          )}" aria-label="Full filter list: ${escAttr(all.join(", "))}">(i)</span>`
        : "";
    const pinLabel = row.pinned ? "Unpin row" : "Pin row to top";
    return `<td class="data-table__td data-table__td--sticky">
      <div class="filters-tab__rowhead">
        <button type="button" class="pin-toggle filters-tab__pin${
          row.pinned ? " is-pinned" : ""
        }" data-act="pin" aria-pressed="${row.pinned ? "true" : "false"}" title="${pinLabel}" aria-label="${pinLabel}">${PIN_GLYPH}</button>
        <span class="filters-tab__rowlabel">${escHtml(label)}</span>${info}
        <button type="button" class="icon-btn filters-tab__edit" data-act="edit" title="Edit filter row" aria-label="Edit filter row">${PENCIL_GLYPH}</button>
        <button type="button" class="icon-btn filters-tab__del" data-act="del" title="Delete filter row" aria-label="Delete filter row">&times;</button>
      </div>
    </td>`;
  }

  /** A row's data cells from the cache: loading "…", error banner, or values. */
  function dataCellsHTML(row, metrics) {
    const data = rowData.get(row.id);
    if (data === undefined) return metrics.map(() => `<td class="data-table__td filters-tab__cell--loading">…</td>`).join("");
    if (data && data.__error) {
      const span = metrics.length || 1;
      return `<td class="data-table__td filters-tab__cell--error" colspan="${span}">Couldn't load this row.</td>`;
    }
    return metrics
      .map((m) => `<td class="data-table__td" data-key="${escAttr(m.key)}">${escHtml(formatValue(m, data ? data[m.key] : null))}</td>`)
      .join("");
  }

  function rowCellsHTML(row, metrics) {
    return labelCellHTML(row) + dataCellsHTML(row, metrics);
  }

  function renderRows() {
    const host = container.querySelector('[data-role="table-host"]');
    if (!host) return;
    syncPresetSelect();
    if (rows.length === 0) {
      host.innerHTML = `<p class="player-page__note player-page__note--muted">No filtered rows yet</p>`;
      columnsPicker.refresh(container.querySelector('[data-role="columns-btn"]'));
      return;
    }
    const metrics = metricColumns();
    const body = orderedRows()
      .map((row) => `<tr data-row-id="${escAttr(row.id)}">${rowCellsHTML(row, metrics)}</tr>`)
      .join("");
    host.innerHTML = `<div class="table-scroll"><table class="data-table">${headerHTML(metrics)}<tbody>${body}</tbody></table></div>`;
    columnsPicker.refresh(container.querySelector('[data-role="columns-btn"]'));
  }

  /** Patch ONE resolved row's cells in place (used when add-order is stable, so
   * no re-order is needed); a full renderRows() is used when a sort is active. */
  function updateRowCells(row) {
    const host = container.querySelector('[data-role="table-host"]');
    if (!host) return;
    const tr = host.querySelector(`tr[data-row-id="${CSS.escape(row.id)}"]`);
    if (tr) tr.innerHTML = rowCellsHTML(row, metricColumns());
  }

  // ---------- data (queries) ----------

  function queryRow(row) {
    const token = fetchToken;
    const player = curPlayerId;
    const ps = curPageState;
    const disc = curDiscipline;
    const cols = columnsFor(curDiscipline);
    fetchRow(row, player, ps, disc, cols)
      .then((data) => {
        if (token !== fetchToken) return;
        rowData.set(row.id, data ?? null);
        if (sortState.key) renderRows();
        else updateRowCells(row);
      })
      .catch((err) => {
        if (token !== fetchToken) return;
        rowData.set(row.id, { __error: true });
        if (sortState.key) renderRows();
        else updateRowCells(row);
        console.error("[cricdb] Filters tab row query failed:", err);
      });
  }

  /** Re-render + (re)query. `forceAll` re-queries every row (player / discipline /
   * column change); otherwise only rows missing a cached result are queried. */
  function refreshData(forceAll) {
    fetchToken++;
    for (const row of rows) {
      if (forceAll || !rowData.has(row.id)) rowData.set(row.id, undefined);
    }
    renderRows();
    for (const row of rows) {
      if (rowData.get(row.id) === undefined) queryRow(row);
    }
  }

  // ---------- public API ----------

  function show(nextPlayerId, nextDiscipline, nextPageState) {
    const nextDisc = nextDiscipline === "bowling" ? "bowling" : "batting";
    const disciplineChanged = nextDisc !== curDiscipline;
    const playerChanged = nextPlayerId != null && nextPlayerId !== curPlayerId;
    curPlayerId = nextPlayerId ?? curPlayerId;
    curDiscipline = nextDisc;
    curPageState = nextPageState || curPageState;
    // A discipline change swaps the column namespace + preset vocabulary, so the
    // toolbar shell is rebuilt. A player OR discipline change invalidates every
    // cached value (they're player/discipline-specific).
    if (disciplineChanged || !container.querySelector(".filters-tab")) renderShell();
    if (disciplineChanged || playerChanged) rowData.clear();
    refreshData(true);
  }

  function destroy() {
    columnsPicker.close();
    container.innerHTML = "";
  }

  // Initial mount render.
  renderShell();
  refreshData(true);

  return { show, destroy };
}
