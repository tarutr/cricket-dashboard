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
import {
  buildQuery,
  formatValue,
  buildFieldingCteSql,
  buildFieldingSliceClauses,
} from "./table.js";
import { buildScopeClausesTagged, whereWithPinExemption } from "./filters.js";
import { getMetric, metricDisplayLabel, matchupBucketLabel, DISMISSAL_KINDS } from "./metrics.js";
import {
  createInitialState,
  emptyAdvancedBlock,
  defaultColumnsFor,
  COLUMN_PRESET_DEFS,
  activePresetKey,
  escSql as esc,
  FIELDING_PHASE_OPTIONS,
  RESULT_OPTIONS,
  TOSS_RESULT_OPTIONS,
  TOSS_DECISION_OPTIONS,
  inningsNumberLabel,
} from "./state.js";
import { createColumnsPicker } from "./columnsPicker.js";
import { loadDimOptions } from "./dimOptions.js";
import { openFilterRowEditor } from "./playerFilterEditor.js";
import { openFieldingRowEditor } from "./playerFieldingEditor.js";
import { getScopeSingletonsController, describeRowSingletons } from "./playerFilterScope.js";
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

// T-2e: Batting position is a per-innings LIST slice — a batting-only multi-select
// of order positions that compiles to `batting_position IN (…)`. Its own condition
// shape (`{ metricKey:"batting_position", positions:[…] }`), so it needs its own
// completeness / SQL / label handling alongside the numeric + Y/N shapes above.
const BATTING_POSITION_KEY = "batting_position";
/** A LIST condition carries a `positions` array (batting position multi-select). */
function isListCond(cond) {
  return Array.isArray(cond.positions);
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
  // T-2e: Batting position (LIST) — batting-only, complete once ≥1 position ticked.
  if (isListCond(cond)) {
    return cond.metricKey === BATTING_POSITION_KEY && discipline === "batting"
      && (cond.positions || []).some((p) => Number.isInteger(Number(p)));
  }
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
  // T-2e: Batting position (LIST) → `batting_position IN (…)` on the plain batting
  // view. Values coerced to finite integers (no injection surface). Batting-only —
  // guarded by isSliceConditionComplete above.
  if (isListCond(cond)) {
    const nums = [...new Set((cond.positions || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    if (!nums.length) return null;
    return `(batting_position IN (${nums.join(", ")}))`;
  }
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

// ══════════════════════════════════════════════════════════════════════════════
// FIELDING MODE (T-3a — the QUERY ENGINE only; the discipline control, the
// editors and the columns/render are T-3b) ─────────────────────────────────────
//
// A FIELDING row is a slice of the ONE open player's FIELDING record — its OWN
// event-grain source (`fielding_events`, view `fielding`), joined by fielder_id,
// INDEPENDENT of the player's batting/bowling innings. Unlike a batting/bowling
// row (which slices the innings-grain batting/bowling view through buildQuery), a
// fielding row aggregates the fielding EVENTS directly.
//
// NUMBERS SACRED (CLAUDE.md Rule 1): the tallies come from table.js's EXPORTED,
// UNCHANGED buildFieldingCteSql — the exact per-fielder CTE the leaderboard's own
// fielding columns use — so a NO-FILTER fielding row equals that player's
// leaderboard fielding numbers BY CONSTRUCTION. This module only (a) reuses that
// CTE verbatim, (b) reuses buildFieldingSliceClauses for the slice dims, (c)
// reuses buildScopeClausesTagged + whereWithPinExemption for scope, and (d) adds a
// parallel per-fielder COUNT(DISTINCT match_id) "matches" CTE (buildFieldingCteSql
// carries no match_id and must not be modified). buildQuery / buildMatchupQuery /
// conditionToHaving are entirely untouched.
//
// SCOPE COVERAGE (top-level state, via buildFieldingCteSql's buildScopeClausesTagged
// — matches the leaderboard fielding column, so no leaderboard change): core (gender
// / format / date / team type) + team (fielding_team) + OPPOSITION + event + venue.
//
// T-3a-ext FULL FILTER SET: every other fielding dim is a WHERE on the fielding
// record, carried on the `state.fielding` namespace and compiled by table.js's
// buildFieldingSliceClauses (+ its additive buildFieldingExtraSliceClauses) — a
// namespace the LEADERBOARD never sets, so its fielding column stays byte-identical:
//   • DIRECT columns (fielding_events): out_batting_position (positions), kind (kinds),
//     phase (phases) — the original trio — PLUS out_hand (hands), out_role (roles),
//     out_batter_id (outBatters), bowler_id (bowlers), bowler_style (bowlerStyles),
//     city (cities), innings_number (inningsNumbers, 0-based stored), over_number
//     (overFrom / overTo, 0-based range).
//   • MATCH-CONTEXT (via `matches`, which fielding_events lacks): Season (seasons)
//     as a semi-join; Stage (stage), Match Result (result), Toss result (tossResult),
//     Toss decision (tossDecision) via the leaderboard's buildMatchContextClauses
//     reused inside a correlated EXISTS on the fielding row's own match (player-
//     relative Result/Toss compare the fielder's own fielding_team).
// buildFieldingRowState just passes `row.fielding` straight through to
// state.fielding, so wiring a new dim is a T-3b editor concern only — the query
// engine already reads it. Availability of the profile-derived dims (out_hand /
// out_role / bowler_style) is DATA-DRIVEN via loadFieldingDimOptions (no gender
// hardcode): empty options ⇒ T-3b hides the filter.

/** The six fielding tallies a fielding row shows, in display order. Keys match the
 * fielding metrics in metrics.js (source "fielding_events") + the derived "matches".
 * The RENDER/columns treatment is T-3b; T-3a exposes this so a verifier/seed knows
 * the shape fetchFieldingRow returns. */
export const FIELDING_TALLY_KEYS = [
  "catches",
  "caught_and_bowled",
  "stumpings",
  "run_outs",
  "dismissals_effected",
  "matches",
];

// ── Fielding COLUMNS (T-3b) — a FIXED tally set, in the owner's display order ──
// Fielding is not a picker discipline: its columns are the six tallies, always the
// same, so there is no columns picker / preset in fielding mode. metrics.js registers
// these ONLY under the "batting"/"bowling" disciplines (there is no "fielding"
// discipline), so the metric objects are pulled from the "batting" catalogue (they
// are identical under either) — key/label/shortLabel/format all resolve, and the
// keys match the columns fetchFieldingRow returns (catches / stumpings / run_outs /
// caught_and_bowled / dismissals_effected / matches).
const FIELDING_COLUMN_KEYS = ["catches", "stumpings", "run_outs", "caught_and_bowled", "dismissals_effected", "matches"];
let _fieldingColumnMetrics = null;
function fieldingColumnMetrics() {
  if (!_fieldingColumnMetrics) {
    _fieldingColumnMetrics = FIELDING_COLUMN_KEYS.map((k) => getMetric(k, "batting")).filter(Boolean);
  }
  return _fieldingColumnMetrics;
}

// ── Fielding row LABELS (T-3b) — honest tokens for a fielding row's dims (§8.4) ──
// The batting/bowling label path (rowAllLabels) describes per-innings conditions +
// matchup; a fielding row instead carries state.fielding.* dims + the four scope
// singletons. describeFieldingRow lists one token per applied fielding dim; the
// scope singletons reuse describeRowSingletons (Team / Opposition / Event / Venue).
const WICKET_TYPE_LABEL = { caught: "Caught", "caught and bowled": "Caught & bowled", stumped: "Stumped", "run out": "Run out" };
const _optLabelMap = (opts) => Object.fromEntries((opts || []).map((o) => [o.value, o.label]));
const PHASE_LABEL = _optLabelMap(FIELDING_PHASE_OPTIONS);
const RESULT_LABEL = _optLabelMap(RESULT_OPTIONS);
const TOSS_RESULT_LABEL = _optLabelMap(TOSS_RESULT_OPTIONS);
const TOSS_DECISION_LABEL = _optLabelMap(TOSS_DECISION_OPTIONS);

/** Honest, human tokens for a fielding row's state.fielding dims (display-only). */
function describeFieldingRow(f) {
  f = f || {};
  const out = [];
  const list = (vals, prefix, mapLabel) => {
    const arr = (vals || []).filter((v) => v != null && v !== "");
    if (!arr.length) return;
    const labels = mapLabel ? arr.map(mapLabel) : arr.map(String);
    out.push(labels.length <= 3 ? `${prefix}: ${labels.join(", ")}` : `${prefix}: ${labels.length}`);
  };
  list(f.kinds, "Wicket type", (k) => WICKET_TYPE_LABEL[k] || k);
  list(f.positions, "Batting position");
  list(f.hands, "Batting hand");
  list(f.roles, "Role");
  if (Array.isArray(f.outBatters) && f.outBatters.length) out.push(`Batter: ${f.outBatterName || f.outBatters[0]}`);
  list(f.bowlerStyles, "Bowler style");
  if (Array.isArray(f.bowlers) && f.bowlers.length) out.push(`Bowler: ${f.bowlerName || f.bowlers[0]}`);
  list(f.phases, "Phase", (p) => PHASE_LABEL[p] || p);
  if (Number.isFinite(Number(f.overFrom)) || Number.isFinite(Number(f.overTo))) {
    const from = Number.isFinite(Number(f.overFrom)) ? Number(f.overFrom) + 1 : "…";
    const to = Number.isFinite(Number(f.overTo)) ? Number(f.overTo) + 1 : "…";
    out.push(`Overs: ${from}–${to}`);
  }
  list(f.inningsNumbers, "Innings", (n) => inningsNumberLabel(Number(n) + 1)); // stored 0-based → display
  list(f.cities, "City");
  list(f.seasons, "Season");
  list(f.stage, "Stage");
  list(f.result, "Result", (r) => RESULT_LABEL[r] || r);
  list(f.tossResult, "Toss", (r) => TOSS_RESULT_LABEL[r] || r);
  list(f.tossDecision, "Toss", (d) => TOSS_DECISION_LABEL[d] || d);
  return out;
}

/**
 * Build the COMPLETE, CLEAN buildFieldingCteSql state for one fielding row — the
 * fielding analog of buildRowState. A clean createInitialState (no pins / no search /
 * no leaderboard filters) overlaid with ONLY the row's core scope + scope singletons
 * + fielding slice dims, so a no-filter row is byte-identical to the leaderboard's
 * fielding numbers for that player. See the block header for what scope
 * buildFieldingCteSql does (and does NOT) honor.
 */
export function buildFieldingRowState(row, pageState) {
  const base = createInitialState(null);
  const scope = (row && row.scope) || {};
  const singletons = (row && row.singletons) || {};
  const ps = pageState || {};
  return {
    ...base,
    // Honest but inert for the fielding source: the fielding CTE reads scope +
    // state.fielding, not state.discipline. The outer id filter pins the player.
    discipline: "fielding",
    gender: ps.gender ?? base.gender,
    formats: scope.formats ?? ps.formats ?? base.formats,
    dateFrom: scope.dateFrom ?? ps.dateFrom ?? base.dateFrom,
    dateTo: scope.dateTo ?? ps.dateTo ?? base.dateTo,
    teamType: scope.teamType ?? ps.teamType ?? base.teamType,
    // Scope singletons honored by buildFieldingCteSql (buildScopeClausesTagged):
    // Team (fielding_team) / Opposition / Event / Venue / Innings Number. Each
    // defaults to base's empty value, so an unset singleton emits no clause and the
    // row stays byte-identical to the un-scoped case.
    teams: singletons.teams ?? base.teams,
    opposition: singletons.opposition ?? base.opposition,
    event: singletons.event ?? base.event,
    eventSeasons: singletons.eventSeasons ?? base.eventSeasons,
    venue: singletons.venue ?? base.venue,
    inningsNumber: singletons.inningsNumber ?? base.inningsNumber,
    // NOTE: TOP-LEVEL stage / result / tossResult / tossDecision are deliberately NOT
    // copied — the fielding source's match-context lives on the state.fielding
    // namespace instead (see below), so the leaderboard's own top-level match-context
    // never leaks into the fielding column (it keeps ignoring it, unchanged).
    // The fielding SLICE dims — the full T-3a-ext set (positions / kinds / phases +
    // hands / roles / outBatters / bowlers / bowlerStyles / cities / inningsNumbers /
    // overFrom / overTo + seasons / stage / result / tossResult / tossDecision) — ride
    // on `state.fielding`, read by table.js buildFieldingSliceClauses. This passes
    // `row.fielding` straight through: whatever sub-fields the (T-3b) editor set are
    // honored, and a missing list/bound ⇒ no clause ⇒ the full fielding record.
    fielding: (row && row.fielding) || { positions: [], kinds: [], phases: [] },
    advanced: emptyAdvancedBlock(),
  };
}

/**
 * Build ONE fielding row's whole-scope SQL (player-agnostic — fetchFieldingRow outer-
 * wraps `WHERE id = '<player>'`, the established idiom). Returns SQL selecting, per
 * fielder: id, catches, caught_and_bowled, stumpings, run_outs, dismissals_effected
 * (= catches + stumpings + run_outs), matches (COUNT(DISTINCT match_id)).
 *
 * Tallies come from the SACRED buildFieldingCteSql UNCHANGED. The parallel
 * fld_matches_cte's WHERE is rebuilt from the SAME exported primitives
 * buildFieldingCteSql uses internally (buildScopeClausesTagged with the identical
 * opts + whereWithPinExemption + "substitute IS NOT TRUE" + buildFieldingSliceClauses),
 * so it is byte-identical to the sacred CTE's WHERE BY CONSTRUCTION.
 *
 * ⚠ COUPLING: this mirrors buildFieldingCteSql's scope construction (table.js). If
 * that function's scope/slice/substitute construction ever changes, mirror it here —
 * or the "matches" count could diverge from the four tallies. (The four tallies
 * always track it automatically, since they come straight from the sacred CTE.)
 */
export function buildFieldingRowQuery(state) {
  const cte = buildFieldingCteSql(state); // SACRED — unchanged tallies + scope + slice

  const pins = (state.pinnedPlayers || []).filter((p) => p && p.id);
  const fldClauses = buildScopeClausesTagged(state, {
    includeTeams: true,
    teamColumn: "fielding_team",
    idColumn: "fielder_id",
    oppositionColumn: "opposition",
  });
  // The pop-up's clean state carries no search; buildFieldingCteSql's search clause
  // (fielder_name ILIKE …) is therefore never emitted, so it is faithfully omitted
  // here too. (If a future caller ever set state.search, the two WHEREs would need
  // it added in both places — see the coupling note above.)
  const fldScopeSql = whereWithPinExemption(fldClauses, "fielder_id", pins);
  const matchesWhere = [fldScopeSql, "substitute IS NOT TRUE", ...buildFieldingSliceClauses(state)].join(" AND ");
  const matchesCte = [
    "fld_matches_cte AS (",
    "  SELECT fielder_id AS fld_player_id, COUNT(DISTINCT match_id) AS matches",
    "  FROM fielding",
    `  WHERE ${matchesWhere}`,
    "  GROUP BY fielder_id",
    ")",
  ].join("\n");

  return [
    `WITH ${cte},`,
    matchesCte,
    "SELECT fielding_cte.fld_player_id AS id,",
    "       fielding_cte.catches AS catches,",
    "       fielding_cte.caught_and_bowled AS caught_and_bowled,",
    "       fielding_cte.stumpings AS stumpings,",
    "       fielding_cte.run_outs AS run_outs,",
    "       (fielding_cte.catches + fielding_cte.stumpings + fielding_cte.run_outs) AS dismissals_effected,",
    "       fld_matches_cte.matches AS matches",
    "FROM fielding_cte",
    "LEFT JOIN fld_matches_cte ON fld_matches_cte.fld_player_id = fielding_cte.fld_player_id",
  ].join("\n");
}

/**
 * Run ONE fielding row's query for one player. buildFieldingRowState → the whole-
 * scope buildFieldingRowQuery → outer-wrap `WHERE id = '<player>'` → db.query.
 * Returns the single aggregate row object, or null when the player has no fielding
 * events under the row's scope/slice. Fielding is NOT a ball-engine source, so it
 * carries NO delivery-window / opponent-player predicates (those are batting/bowling
 * ball filters); db.query is called plainly.
 */
export async function fetchFieldingRow(row, playerId, pageState) {
  const state = buildFieldingRowState(row, pageState);
  const sql = buildFieldingRowQuery(state);
  const wrapped = `SELECT * FROM (\n${sql}\n) t\nWHERE id = '${esc(playerId)}'`;
  const res = await query(wrapped);
  return res.rows[0] || null;
}

/**
 * DATA-DRIVEN availability probe for a fielding dim (T-3a-ext) — a thin, fielding-
 * scoped wrapper over the generic loadDimOptions. Returns the distinct non-null
 * values of `column` on the `fielding` source within the pop-up's scope. Its FIRST
 * use is the profile-derived dims (out_hand / out_role / bowler_style): a non-empty
 * result means T-3b OFFERS the filter, an empty result means it HIDES it. No gender
 * hardcode — men return values, women return [] (all NULL), and future women's
 * profiles will make the filter auto-appear. `scope` is a pageState-shaped object
 * ({ gender, formats, teamType, dateFrom, dateTo }).
 */
export function loadFieldingDimOptions(column, scope) {
  return loadDimOptions("fielding", column, scope || {});
}

/** Build a fielding row (T-3a seeds these in code; T-3b's editor will build them).
 * `fielding` carries the full T-3a-ext slice set — the original { positions, kinds,
 * phases } trio plus any of { hands, roles, outBatters, bowlers, bowlerStyles,
 * cities, inningsNumbers, overFrom, overTo, seasons, stage, result, tossResult,
 * tossDecision } the editor sets (missing ⇒ unset ⇒ no clause). `scope` / `singletons`
 * as on batting/bowling rows. Carries no conditions / ball predicates / matchupVs — a
 * fielding record is sliced only by its own dims + scope. */
export function makeFieldingRow(fielding, scope, singletons) {
  return {
    id: nextRowId(),
    discipline: "fielding",
    scope: scope || { formats: null, dateFrom: null, dateTo: null, teamType: null },
    fielding: fielding || { positions: [], kinds: [], phases: [] },
    singletons: singletons || {},
    pinned: false,
  };
}

/** Code-seeded fielding rows for verification (T-3b replaces with the editor):
 * a NO-FILTER row (the player's full fielding record — equals the leaderboard
 * fielding row) + a positions {1,2,3} slice, plus T-3a-ext demonstrators of the new
 * dims (a spin bowler-style slice and a Toss-decision match-context slice). `scope`
 * is the pop-up's effective scope so the no-filter row equals the leaderboard row. */
export function seedFieldingRows(scope) {
  return [
    makeFieldingRow({ positions: [], kinds: [], phases: [] }, scope, {}),
    makeFieldingRow({ positions: [1, 2, 3], kinds: [], phases: [] }, scope, {}),
    makeFieldingRow(
      { bowlerStyles: ["Legbreak", "Legbreak googly", "Slow left-arm orthodox", "Right-arm offbreak", "Left-arm wrist-spin", "Left-arm slow"] },
      scope,
      {}
    ),
    makeFieldingRow({ tossDecision: ["bat"] }, scope, {}),
  ];
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

function makeRow(conditions, scope, singletons, deliveryWindow, opponentPlayer, matchupVs) {
  return {
    id: nextRowId(),
    scope: scope || { formats: null, dateFrom: null, dateTo: null, teamType: null },
    conditions: conditions || emptyAdvancedBlock(),
    // T-2c: the row's scope singletons (a partial state — Team / Opposition / Event
    // / Venue / Stage / Match & Toss Result / Innings Number), overlaid onto the
    // clean row state by buildRowState. deliveryWindow / opponentPlayer are the
    // row's ball predicates, threaded per-call to db.query in fetchRow.
    singletons: singletons || {},
    deliveryWindow: deliveryWindow || null,
    opponentPlayer: opponentPlayer || null,
    // T-2e: the matchup-Vs bucket ({dim,value}) or null. When set, buildRowState puts
    // it on the clean row state so buildQuery dispatches to buildMatchupQuery (Option
    // A) — the row IS that player's leaderboard matchup record. Mutually exclusive
    // with conditions / ball predicates (the editor enforces it), so those stay empty.
    matchupVs: matchupVs || null,
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
  if (cond.metricKey === BATTING_POSITION_KEY) return "Batting position";
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
  if (isListCond(cond)) {
    const nums = [...new Set((cond.positions || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
    return `${base}: ${nums.join(", ")}`;
  }
  if (isBooleanCond(cond)) return `${base} = ${cond.yn ? "Yes" : "No"}`;
  if (cond.operator === "between") return `${base} ${cond.v1}–${cond.v2}`;
  return `${base} ${OP_SYMBOLS[cond.operator] ?? cond.operator} ${cond.v1}`;
}

/** Every complete per-innings condition on a row, as literal-form strings. */
function allConditionLabels(conditions, discipline, formats) {
  const out = [];
  for (const g of sliceActiveGroups(conditions || emptyAdvancedBlock(), discipline)) {
    for (const c of g.conds) out.push(conditionLiteralLabel(c, discipline, formats));
  }
  return out;
}

/** T-2e: the honest label for a row's matchup-Vs bucket (Option A). "type" (fine
 * bowling style) reads through matchupBucketLabel so bare Pace/Spin show as
 * "(unspecified)"; "group" (Pace/Spin) and "hand" (Right-/Left-hand bat) read
 * verbatim, matching the leaderboard's own Vs vocabulary. */
function matchupVsLabel(matchupVs) {
  if (!matchupVs || !matchupVs.dim) return null;
  if (matchupVs.dim === "type") return `vs ${matchupBucketLabel(matchupVs.value)}`;
  return `vs ${matchupVs.value}`;
}

/** ALL of a row's filter labels — the matchup-Vs bucket (T-2e) THEN the per-innings
 * conditions THEN the scope singletons (T-2c: Opposition / Event / Stage / window /
 * opponent / …). Combining them keeps the first-cell label + (i) honest (SPEC §8.4):
 * a row filtered ONLY by a scope singleton reads e.g. "vs Australia", a matchup row
 * reads "vs Spin", never the misleading "No conditions". */
function rowAllLabels(row, discipline, formats) {
  // T-3b: a fielding row carries state.fielding.* dims (describeFieldingRow) + the
  // four scope singletons (Team / Opposition / Event / Venue) — no matchup / numeric
  // conditions / ball predicates. Its scope singletons reuse describeRowSingletons.
  if (discipline === "fielding") {
    return [...describeFieldingRow(row.fielding), ...describeRowSingletons(row.singletons, null, null, "fielding")];
  }
  const matchup = matchupVsLabel(row.matchupVs);
  const numeric = allConditionLabels(row.conditions, discipline, formats);
  const scope = describeRowSingletons(row.singletons, row.deliveryWindow, row.opponentPlayer, discipline);
  return [...(matchup ? [matchup] : []), ...numeric, ...scope];
}

function rowLabel(row, discipline, formats) {
  const labels = rowAllLabels(row, discipline, formats);
  return labels.length ? labels[0] : NO_CONDITION_LABEL;
}

// ── Per-row query ────────────────────────────────────────────────────────────

/** Build the COMPLETE, CLEAN buildQuery state for one row (see file header). The
 * row's conditions are NOT put on `state.advanced` — the Filters tab slices
 * per-innings via buildQuery's `inningsWhere` (fetchRow), never HAVING — so the
 * advanced block stays EMPTY here (this keeps buildQuery's HAVING path off). */
function buildRowState(row, pageState, discipline) {
  // T-3a: a fielding row uses its own event-grain state builder (fielding is a
  // separate source, not the batting/bowling innings view). Delegate before the
  // batting/bowling path below.
  if (discipline === "fielding") return buildFieldingRowState(row, pageState);
  const base = createInitialState(null); // complete neutral state; dateTo overridden below
  const scope = row.scope || {};
  const singletons = row.singletons || {};
  const ps = pageState || {};
  return {
    ...base,
    discipline,
    gender: ps.gender ?? base.gender, // inert (id pins gender) but kept honest
    formats: scope.formats ?? ps.formats ?? base.formats,
    dateFrom: scope.dateFrom ?? ps.dateFrom ?? base.dateFrom,
    dateTo: scope.dateTo ?? ps.dateTo ?? base.dateTo,
    teamType: scope.teamType ?? ps.teamType ?? base.teamType,
    // T-2c scope singletons: buildQuery's OWN buildScopeClauses (Team / Opposition /
    // Event / Venue / Innings Number) + buildMatchContextClauses (Match & Toss
    // Result / Stage) apply these as WHERE — buildQuery is UNCHANGED (numbers
    // sacred). Each defaults to base's empty value, so a row with no scope singleton
    // emits no extra clause and stays byte-identical. (deliveryWindow / opponentPlayer
    // are ball predicates — set NOT here but per-call on db.query in fetchRow.)
    teams: singletons.teams ?? base.teams,
    opposition: singletons.opposition ?? base.opposition,
    event: singletons.event ?? base.event,
    eventSeasons: singletons.eventSeasons ?? base.eventSeasons,
    venue: singletons.venue ?? base.venue,
    stage: singletons.stage ?? base.stage,
    result: singletons.result ?? base.result,
    resultCondition: singletons.resultCondition ?? base.resultCondition,
    tossResult: singletons.tossResult ?? base.tossResult,
    tossDecision: singletons.tossDecision ?? base.tossDecision,
    inningsNumber: singletons.inningsNumber ?? base.inningsNumber,
    // T-2e (owner Option A): a matchup-Vs bucket makes matchupVsActive(state) true, so
    // buildQuery dispatches to buildMatchupQuery — the row's numbers become that
    // player's LEADERBOARD-IDENTICAL matchup record vs the bucket. buildMatchupQuery
    // honors the scope singletons above (buildScopeClauses / buildMatchContextClauses)
    // but ignores per-innings slices + ball predicates, which the editor guarantees are
    // empty on a matchup row. null ⇒ the plain path (byte-identical). matchupVsActive
    // also hard-gates on gender === "male", so a women's row (never offered the family)
    // simply falls to the plain path.
    matchupVs: row.matchupVs || null,
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
  // T-3a: a fielding row routes to the fielding source (fielding_events), not
  // buildQuery. It has no per-innings slice / ball predicate / matches-secondary
  // merge — buildFieldingRowQuery folds matches in via its own CTE. `cols` is
  // unused by the fielding path (its output columns are fixed — T-3b picks which
  // to show).
  if (discipline === "fielding") return fetchFieldingRow(row, playerId, pageState);
  const rowState = buildRowState(row, pageState, discipline);
  const inningsWhere = conditionsToInningsWhere(row.conditions, discipline);
  // T-2d: a ball predicate (opponent-player / delivery window) restricts the view
  // rows to the filtered balls but is threaded to db.query AFTER buildQuery, so it
  // never flips buildQuery's innings-level MAT gate — leaving "Matches" on the
  // whole-scope player_matches source (e.g. vs an opponent it would read 64, not the
  // 8 matches actually played vs them). Passing inningsMatches forces MAT to
  // COUNT(DISTINCT match_id) over the ball-restricted view rows. Only set when a
  // ball predicate is present, so a no-filter / scope-only row is byte-identical.
  const inningsMatches = Boolean(row.deliveryWindow || row.opponentPlayer);
  const { sql, matchesSql } = buildQuery(rowState, cols, { inningsWhere, inningsMatches });
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

// T-3b: the Filters tab's OWN discipline set. Fielding is FILTERS-TAB-ONLY (owner:
// no fielding on Overview) — the tab renders its own Batting|Bowling|Fielding control
// (the pop-up header toggle stays Batting|Bowling and drives Overview only).
const TAB_DISCIPLINES = new Set(["batting", "bowling", "fielding"]);
const normDiscipline = (d, fallback = "batting") => (TAB_DISCIPLINES.has(d) ? d : fallback);
const disciplineWord = (d) => (d === "bowling" ? "Bowling" : d === "fielding" ? "Fielding" : "Batting");

export function mountPlayerFiltersTab(container, { store, playerId, discipline, pageState } = {}) {
  void store; // the tab is store-independent (per-row queries are self-contained)
  let curPlayerId = playerId ?? null;
  let curDiscipline = normDiscipline(discipline);
  let curPageState = pageState || null;
  let rows = []; // user-defined via the editor; empty ⇒ "No filtered rows yet"
  let fetchToken = 0;

  // T-2c: the shared scope-singletons controller (Opposition / Event / Stage /
  // window / opponent / … value editors). One instance app-wide (see
  // getScopeSingletonsController) — the editor modal borrows its persistent host.
  const scopeController = getScopeSingletonsController();

  // T-2c UX change 2 (owner 2026-08-03): a discipline switch RESETS the tab's rows
  // (a batting-worded row can't slice bowling) + WARNS. When a switch clears rows,
  // this holds the notice text shown until the user next adds a row.
  let disciplineResetNotice = null;

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
    // Fielding has a FIXED tally set (no picker / preset), so it isn't cached in
    // tabColumns — return the fixed keys directly.
    if (disc === "fielding") return FIELDING_COLUMN_KEYS;
    if (!tabColumns[disc]) tabColumns[disc] = defaultColumnsFor(disc, currentFormats());
    return tabColumns[disc];
  }

  /** Resolve a column key to its metric object for the CURRENT discipline. Fielding
   * columns aren't in metrics.js under a "fielding" discipline, so they come from the
   * fixed fielding metric list; batting/bowling use getMetric. */
  function metricFor(key) {
    if (curDiscipline === "fielding") return fieldingColumnMetrics().find((m) => m.key === key) || null;
    return getMetric(key, curDiscipline);
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
    // Opening the editor clears any lingering discipline-reset notice (the user is
    // now acting on the current discipline's rows).
    if (disciplineResetNotice) {
      disciplineResetNotice = null;
      renderRows();
    }
    const initialScope =
      mode === "edit" ? { ...existingRow.scope } : lastScope ? { ...lastScope } : defaultScope();

    // T-3b: a fielding row uses its own editor (the fielding dims live on a separate
    // source/namespace — see playerFieldingEditor.js). It returns { fielding, scope,
    // singletons }; the tab builds a fielding row via makeFieldingRow.
    if (curDiscipline === "fielding") {
      openFieldingRowEditor(document, {
        mode,
        initialFielding: mode === "edit" ? existingRow.fielding : null,
        initialScope,
        initialSingletons: mode === "edit" ? existingRow.singletons : null,
        gender: curPageState && curPageState.gender,
        formats: currentFormats(),
        scopeController,
        onCommit: ({ fielding, scope, singletons }) => {
          lastScope = { ...scope }; // sticky
          if (mode === "edit") {
            existingRow.fielding = fielding;
            existingRow.scope = scope;
            existingRow.singletons = singletons || {};
            rowData.delete(existingRow.id);
            renderRows();
            queryRow(existingRow);
          } else {
            const row = makeFieldingRow(fielding, scope, singletons);
            rows.push(row);
            rowData.set(row.id, undefined);
            renderRows();
            queryRow(row);
          }
        },
      });
      return;
    }

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
      // T-2c: the shared scope-singletons controller + this row's existing scope
      // singletons / ball predicates (edit pre-fill).
      scopeController,
      initialSingletons: mode === "edit" ? existingRow.singletons : null,
      initialDeliveryWindow: mode === "edit" ? existingRow.deliveryWindow : null,
      initialOpponentPlayer: mode === "edit" ? existingRow.opponentPlayer : null,
      // T-2e: the row's matchup-Vs bucket (edit pre-fill). Batting-only "Batting
      // position" is a LIST condition routed through the editor's own addCondition.
      initialMatchupVs: mode === "edit" ? existingRow.matchupVs : null,
      onCommit: ({ conditions, scope, singletons, deliveryWindow, opponentPlayer, matchupVs }) => {
        lastScope = { ...scope }; // sticky
        if (mode === "edit") {
          existingRow.conditions = conditions;
          existingRow.scope = scope;
          existingRow.singletons = singletons || {};
          existingRow.deliveryWindow = deliveryWindow || null;
          existingRow.opponentPlayer = opponentPlayer || null;
          existingRow.matchupVs = matchupVs || null;
          rowData.delete(existingRow.id);
          renderRows();
          queryRow(existingRow);
        } else {
          const row = makeRow(conditions, scope, singletons, deliveryWindow, opponentPlayer, matchupVs);
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

  /** The tab's OWN discipline control (T-3b) — Batting | Bowling | Fielding. Fielding
   * is offered ONLY here (never on the pop-up header toggle / Overview — owner ruling);
   * a switch RESETS the rows + warns (setDiscipline). Reuses the app's .segmented look. */
  function disciplineToggleHTML() {
    const btn = (v) =>
      `<button type="button" class="segmented__btn${v === curDiscipline ? " is-active" : ""}" data-value="${v}">${disciplineWord(v)}</button>`;
    return `<div class="segmented filters-tab__discipline" data-role="disc-toggle" role="group" aria-label="Discipline">${btn(
      "batting"
    )}${btn("bowling")}${btn("fielding")}</div>`;
  }

  function renderShell() {
    // Fielding has a FIXED column set → no preset / columns picker in fielding mode.
    const columnsControlsHTML =
      curDiscipline === "fielding"
        ? ""
        : `<div class="filters-tab__toolbar-right">
            <select class="select filters-tab__preset" data-role="preset-select" aria-label="Column preset">${presetOptionsHTML()}</select>
            <button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Columns</button>
          </div>`;
    container.innerHTML = `
      <div class="filters-tab">
        <div class="filters-tab__toolbar">
          <div class="filters-tab__toolbar-left">
            <button type="button" class="btn btn--primary filters-tab__add" data-role="add-filter-row">Add Filter Row</button>
            ${disciplineToggleHTML()}
          </div>
          ${columnsControlsHTML}
        </div>
        <p class="filters-tab__reset-notice" data-role="reset-notice" role="status" hidden></p>
        <div class="filters-tab__table-host" data-role="table-host"></div>
      </div>`;

    const addBtn = container.querySelector('[data-role="add-filter-row"]');
    if (addBtn) addBtn.addEventListener("click", () => openEditor("add", null));

    const discToggle = container.querySelector('[data-role="disc-toggle"]');
    if (discToggle) {
      discToggle.addEventListener("click", (e) => {
        const btn = e.target.closest(".segmented__btn");
        if (!btn || btn.dataset.value === curDiscipline) return;
        setDiscipline(btn.dataset.value, { fromUser: true });
      });
    }

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

  /** Switch the tab's discipline (its own control, T-3b). A change RESETS the rows +
   * WARNS (a batting-worded row can't slice bowling/fielding, etc.) — the T-2c reset
   * behavior, generalised to three disciplines. Rebuilds the shell (the toolbar's
   * column controls differ for fielding) and re-queries. `fromUser` is accepted for
   * symmetry/telemetry; the behavior is identical whatever the trigger. */
  function setDiscipline(nextDiscRaw, { fromUser = false } = {}) {
    void fromUser;
    const nextDisc = normDiscipline(nextDiscRaw, curDiscipline);
    if (nextDisc === curDiscipline) return;
    const prev = curDiscipline;
    if (rows.length > 0) {
      rows = [];
      disciplineResetNotice = `Switching to ${disciplineWord(nextDisc)} cleared your filter rows — a ${disciplineWord(
        prev
      ).toLowerCase()} filter can't slice ${disciplineWord(nextDisc).toLowerCase()}.`;
    } else {
      disciplineResetNotice = null;
    }
    curDiscipline = nextDisc;
    rowData.clear();
    renderShell();
    refreshData(true);
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
      const metric = metricFor(sortState.key);
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
    if (curDiscipline === "fielding") return fieldingColumnMetrics();
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
    const all = rowAllLabels(row, curDiscipline, formats);
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
    // T-2c: the discipline-reset warning (owner 2026-08-03), shown until dismissed
    // by the next Add Filter Row.
    const noticeEl = container.querySelector('[data-role="reset-notice"]');
    if (noticeEl) {
      noticeEl.hidden = !disciplineResetNotice;
      noticeEl.textContent = disciplineResetNotice || "";
    }
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
    const playerChanged = nextPlayerId != null && nextPlayerId !== curPlayerId;
    curPlayerId = nextPlayerId ?? curPlayerId;
    curPageState = nextPageState || curPageState;
    // T-3b: the Filters tab OWNS its discipline via its own control now (the pop-up
    // header toggle drives Overview only, and can't represent Fielding). So an
    // EXTERNAL show() passing `null` KEEPS the tab's current discipline; a non-null
    // value (the initial discipline forwarded at mount) routes through setDiscipline,
    // which does the reset+warn ONLY if it actually changes. Its own control's
    // switches call setDiscipline directly.
    const disciplineChanged =
      nextDiscipline != null && normDiscipline(nextDiscipline, curDiscipline) !== curDiscipline;
    if (disciplineChanged) {
      setDiscipline(nextDiscipline); // owns renderShell + rowData.clear + refreshData
      return;
    }
    if (!container.querySelector(".filters-tab")) renderShell();
    if (playerChanged) rowData.clear();
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
