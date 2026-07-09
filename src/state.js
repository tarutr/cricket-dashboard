// src/state.js
//
// Single state store for Compare Stats (SPEC §5, owner adjustments in the
// Phase 2 brief). Plain subscribe/notify — no framework.
//
// Shape:
// {
//   discipline: "batting" | "bowling",
//   gender: "female" | "male",
//   formats: string[]              // subset of FORMAT_BUCKETS keys, expanded to match_type values via FORMAT_MATCH_TYPES
//   dateFrom: "YYYY-MM" | null,
//   dateTo:   "YYYY-MM" | null,
//   teams: string[],                // batting_team/bowling_team values; [] = no team predicate (= all)
//   teamType: "international" | "club" | "both",
//   minInnings: number,
//   search: string,
//   sort: { key: string, dir: "asc" | "desc" },
//   columns: { batting: string[], bowling: string[] },   // visible metric keys, in order, per discipline
//   advanced: { op: "AND"|"OR", groups: [{ op: "AND"|"OR", conds: [{metricKey, operator, v1, v2}] }] },
// }
//
// `formats` stores owner-facing bucket keys (see FORMAT_BUCKETS below), not raw
// match_type values — "T20" here means the T20-bucket (T20 + IT20), matching the
// Phase 2 brief's owner decision that Cricsheet mislabels internationals.

import { metricsFor, matchupBucketLabel } from "./metrics.js";

/** The five format buckets surfaced in the UI, and the match_type values each expands to. */
export const FORMAT_BUCKETS = [
  { key: "T20", label: "T20", matchTypes: ["T20", "IT20"] },
  { key: "ODI", label: "ODI", matchTypes: ["ODI"] },
  { key: "ODM", label: "ODM", matchTypes: ["ODM"] },
  { key: "Test", label: "Test", matchTypes: ["Test"] },
  { key: "MDM", label: "MDM", matchTypes: ["MDM"] },
];

// ── Profile filters (D4.2) ────────────────────────────────────────────────────
// The four profile-powered filters live in a single `profile` state block. They
// filter the Compare Stats table (and everything downstream that shares
// buildScopeClauses) to players whose player_profiles row matches. Profiles are
// men-only by design (the sheet is men-only), so these never apply while
// gender = female — the filter bar greys them out there (owner decision 21).

/** Fresh, all-cleared profile-filter block. */
export function emptyProfile() {
  return { roleGroup: null, roleSub: null, battingHand: null, bowlingType: null, teams: [] };
}

/** True if any profile filter is currently narrowing the set. */
export function hasActiveProfileFilter(profile) {
  if (!profile) return false;
  return Boolean(
    profile.roleGroup || profile.roleSub || profile.battingHand || profile.bowlingType || (profile.teams && profile.teams.length)
  );
}

function escSql(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * SQL semi-join clause restricting `idColumn` (batter_id / bowler_id / player_id)
 * to the player_ids whose profile matches every active profile filter. Returns
 * null when no profile filter is active OR gender = female (profiles are
 * men-only — never silently empty the women's view; the filter bar disables the
 * controls there per decision 21). Shared by table, graph, and team-option
 * lookups so the honest scope sentence and every query agree.
 */
export function profileSemiJoinSql(state, idColumn) {
  if (!idColumn) return null;
  if (state.gender === "female") return null;
  const p = state.profile;
  if (!hasActiveProfileFilter(p)) return null;

  const preds = [];
  if (p.roleGroup) preds.push(`role_group = '${escSql(p.roleGroup)}'`);
  if (p.roleSub) preds.push(`role_subgroup = '${escSql(p.roleSub)}'`);
  if (p.battingHand) preds.push(`batting_style = '${escSql(p.battingHand)}'`);
  if (p.bowlingType) preds.push(`bowling_type = '${escSql(p.bowlingType)}'`);
  if (p.teams && p.teams.length) {
    const teamPreds = p.teams
      .map((t) => `list_contains(string_split(teams_played_for, '|'), '${escSql(t)}')`)
      .join(" OR ");
    preds.push(`(${teamPreds})`);
  }
  if (preds.length === 0) return null;
  return `${idColumn} IN (SELECT player_id FROM profiles WHERE ${preds.join(" AND ")})`;
}

/** Human tokens for describeScope() — only the profile filters actually applied. */
function profileScopeTokens(state) {
  if (state.gender === "female") return [];
  const p = state.profile;
  const tokens = [];
  if (p.roleGroup) tokens.push(p.roleGroup);
  if (p.roleSub) tokens.push(p.roleSub);
  if (p.battingHand) tokens.push(p.battingHand);
  if (p.bowlingType) tokens.push(p.bowlingType);
  if (p.teams && p.teams.length) {
    tokens.push(p.teams.length <= 2 ? p.teams.join(", ") : `${p.teams.length} teams played for`);
  }
  return tokens;
}

// ── Free splits (D4 Piece 3) ─────────────────────────────────────────────────
// Two innings-level filters (batting position, opposition) plus a table-only
// "Split by" breakdown. Opposition is INTERNATIONAL cricket only (decision 20 —
// club team names are unnormalized), so both the filter and the opposition
// split apply ONLY while teamType === "international"; the controls grey out
// elsewhere (decision-21 treatment: inert, never silently wrong). Positions
// are a batting concept and apply only in the batting discipline.

/** The three split dimensions. sqlExpr must be valid in both the SELECT and GROUP BY of the innings views. */
export const SPLIT_DIMENSIONS = {
  position: {
    key: "position",
    label: "Batting position",
    columnLabel: "Pos",
    disciplines: ["batting"],
    internationalOnly: false,
    numeric: true,
    sqlExpr: () => "batting_position",
  },
  opposition: {
    key: "opposition",
    label: "Opposition",
    columnLabel: "Opposition",
    disciplines: ["batting", "bowling"],
    internationalOnly: true,
    numeric: false,
    sqlExpr: (discipline) => (discipline === "batting" ? "bowling_team" : "batting_team"),
  },
  dismissal: {
    key: "dismissal",
    label: "Dismissal",
    columnLabel: "Dismissal",
    disciplines: ["batting"],
    internationalOnly: false,
    numeric: false,
    // Retired hurt / retired not out are not dismissals — they read "not out",
    // matching the dismissed flag (and the batting-average denominator).
    sqlExpr: () => "CASE WHEN dismissed = 1 THEN dismissal_kind ELSE 'not out' END",
  },
};

/** True if this split dimension may apply under the current discipline + team type. */
export function splitAllowed(state, key) {
  const dim = SPLIT_DIMENSIONS[key];
  if (!dim) return false;
  if (!dim.disciplines.includes(state.discipline)) return false;
  if (dim.internationalOnly && state.teamType !== "international") return false;
  if (matchupVsActive(state)) return false; // no row-grouping in matchup mode (R3)
  return true;
}

/** The active split dimension object, or null if none is set / it isn't allowed right now. */
export function activeSplit(state) {
  if (!state.splitBy) return null;
  return splitAllowed(state, state.splitBy) ? SPLIT_DIMENSIONS[state.splitBy] : null;
}

/** True if the batting-position filter is currently narrowing the innings set. */
export function positionsFilterActive(state) {
  // Matchup views (matchup_batting/matchup_bowling) have no batting_position
  // column, so an active matchup "Vs" selection disables this here — one gate
  // that keeps the query (buildScopeClauses), the drawer's position pill, and
  // the honest scope sentence all agreeing automatically, with no separate
  // matchup-aware checks needed at each call site.
  return (
    state.discipline === "batting" &&
    Array.isArray(state.positions) &&
    state.positions.length > 0 &&
    !matchupVsActive(state)
  );
}

// ── Matchups (D4 R3, decision 33) ───────────────────────────────────────────
// The leaderboard's "Vs" comparison mode: pick a bowling style (batting view)
// or a batting hand (bowling view) and every stat recomputes against that
// bucket, with a coverage figure attached. Men-only in practice — matchup
// coverage for women is ~0% (decision 21).

/**
 * True iff a matchup "Vs" selection is currently active AND applicable to the
 * current discipline. A stale value in the OTHER discipline (e.g. dim "hand"
 * picked while bowling, then the user switches to batting) stays in
 * state.matchupVs but is INERT here — same keep-but-inert precedent as the
 * positions filter — so switching back and forth never loses the pick.
 */
export function matchupVsActive(state) {
  if (!state.matchupVs || state.gender !== "male") return false;
  const { dim } = state.matchupVs;
  if (dim === "hand") return state.discipline === "bowling";
  if (dim === "group" || dim === "type") return state.discipline === "batting";
  return false;
}

/** True if the opposition filter is currently narrowing the innings set. */
export function oppositionFilterActive(state) {
  return state.teamType === "international" && Array.isArray(state.opposition) && state.opposition.length > 0;
}

/** Expand the selected format bucket keys into the raw match_type values for SQL IN (...). */
export function expandFormats(formatKeys) {
  const set = new Set();
  for (const key of formatKeys) {
    const bucket = FORMAT_BUCKETS.find((b) => b.key === key);
    if (bucket) bucket.matchTypes.forEach((mt) => set.add(mt));
  }
  return [...set];
}

const DEFAULT_COLUMNS = {
  batting: ["matches", "innings", "runs", "average", "strike_rate", "high_score", "fours", "sixes"],
  bowling: ["matches", "innings", "wickets", "average", "economy", "strike_rate", "best"],
};

// Matchup-mode default column sets (D4 R3 follow-up, restricted picker): equal
// to the fixed sets matchup mode has always shown. Kept here (not in table.js)
// so state.js owns every column default, matchup namespaces included.
const DEFAULT_MATCHUP_COLUMNS = {
  matchup_batting: ["innings", "balls", "runs", "strike_rate", "average", "dismissals", "dot_pct", "boundary_pct"],
  matchup_bowling: ["innings", "balls", "wickets", "runs_conceded", "economy", "average", "strike_rate", "dot_pct"],
};

function monthsAgo(yyyymm, months) {
  const [y, m] = yyyymm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() - months);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Build the initial state. `maxMonth` ("YYYY-MM") comes from the manifest's
 * max match_date once known; until then dateFrom/dateTo are null and the
 * filter bar should treat that as "not yet bounded" (no date predicate).
 */
export function createInitialState(maxMonth) {
  const dateTo = maxMonth ?? null;
  const dateFrom = maxMonth ? monthsAgo(maxMonth, 36) : null;
  return {
    view: "table", // "table" | "graph" (SPEC §6 Graph Builder)
    discipline: "batting",
    gender: "male", // owner default (overrides SPEC §5.1 "Women"): profile filters live on load
    formats: ["T20"],
    dateFrom,
    dateTo,
    teams: [],
    teamType: "international",
    minInnings: 10,
    profile: emptyProfile(),
    positions: [], // batting positions (ints); [] = no predicate. Applies in batting only.
    opposition: [], // opposition team names; [] = no predicate. International only (decision 20).
    splitBy: null, // null | "position" | "opposition" | "dismissal" — table-only breakdown
    matchupVs: null, // null | { dim: "group"|"type"|"hand", value } — leaderboard matchup mode (R3, decision 33)
    search: "",
    sort: { key: "runs", dir: "desc" },
    columns: {
      batting: [...DEFAULT_COLUMNS.batting],
      bowling: [...DEFAULT_COLUMNS.bowling],
      matchup_batting: [...DEFAULT_MATCHUP_COLUMNS.matchup_batting],
      matchup_bowling: [...DEFAULT_MATCHUP_COLUMNS.matchup_bowling],
    },
    advanced: { op: "AND", groups: [] },
  };
}

export function defaultColumnsFor(discipline, formats) {
  if (discipline === "batting" && formats.length > 0 && formats.every((f) => f === "Test" || f === "MDM")) {
    // Owner exception: Test/MDM batting swaps strike_rate for balls_per_dismissal,
    // and leads with runs, average, balls_per_dismissal.
    return ["matches", "innings", "runs", "average", "balls_per_dismissal", "high_score", "fours", "sixes"];
  }
  return [...DEFAULT_COLUMNS[discipline]];
}

// ── Column presets (R1, decision 29) ─────────────────────────────────────────
// One-click column sets replacing the 45-checkbox picker as the primary way to
// choose columns ("Customise…" still opens the full picker). A preset is a
// FUNCTION of the current formats: Core respects the owner's Test/MDM swap and
// Phases resolves to the T20 or ODI phase family — or null when the current
// formats don't allow phase metrics at all (chip renders disabled).

export const COLUMN_PRESET_DEFS = {
  batting: [
    { key: "core", label: "Core", columns: (formats) => defaultColumnsFor("batting", formats) },
    {
      key: "boundaries",
      label: "Boundaries",
      columns: () => ["innings", "runs", "fours", "sixes", "boundary_pct", "balls_per_boundary", "dot_pct"],
    },
    {
      key: "dismissals",
      label: "Dismissals",
      columns: () => [
        "innings", "runs", "average",
        "out_caught_pct", "out_bowled_pct", "out_lbw_pct", "out_run_out_pct",
        "out_stumped_pct", "out_caught_and_bowled_pct", "out_hit_wicket_pct",
      ],
    },
    {
      key: "phases",
      label: "Phases",
      columns: (formats) => {
        if (formats.length === 1 && formats[0] === "T20")
          return ["innings", "runs", "strike_rate", "pp_strike_rate", "mid_strike_rate", "death_strike_rate"];
        if (formats.length > 0 && formats.every((f) => f === "ODI" || f === "ODM"))
          return ["innings", "runs", "strike_rate", "odi_pp_strike_rate", "odi_mid_strike_rate", "odi_death_strike_rate"];
        return null;
      },
    },
    {
      key: "progression",
      label: "Progression",
      columns: () => ["innings", "runs", "strike_rate", "sr_first10", "sr_11_20", "sr_21plus"],
    },
  ],
  bowling: [
    { key: "core", label: "Core", columns: (formats) => defaultColumnsFor("bowling", formats) },
    {
      key: "control",
      label: "Control",
      columns: () => ["innings", "wickets", "economy", "dot_pct", "boundary_pct_conceded", "maidens"],
    },
    {
      key: "wicket_types",
      label: "Wicket types",
      columns: () => ["innings", "wickets", "wkt_bowled", "wkt_lbw", "wkt_caught", "wkt_caught_and_bowled", "wkt_stumped", "wkt_hit_wicket"],
    },
    {
      key: "phases",
      label: "Phases",
      columns: (formats) => {
        if (formats.length === 1 && formats[0] === "T20")
          return ["innings", "wickets", "pp_economy", "death_economy", "pp_wickets", "death_wickets"];
        if (formats.length > 0 && formats.every((f) => f === "ODI" || f === "ODM"))
          return ["innings", "wickets", "odi_pp_economy", "odi_death_economy", "odi_pp_wickets", "odi_death_wickets"];
        return null;
      },
    },
  ],
};

/** The preset key whose column set equals `columns` exactly (order-sensitive), or null ("custom"). */
export function activePresetKey(discipline, formats, columns) {
  for (const def of COLUMN_PRESET_DEFS[discipline]) {
    const preset = def.columns(formats);
    if (preset && preset.length === columns.length && preset.every((k, i) => k === columns[i])) {
      return def.key;
    }
  }
  return null;
}

/**
 * True if a phase metric is currently eligible to be shown/offered (SPEC §8.9):
 * T20-range phase metrics only when formats is exactly ["T20"] (the T20+IT20
 * bucket); ODI-range phase metrics only when formats is a non-empty subset of
 * {"ODI", "ODM"}. Non-phase metrics are always eligible. Shared by the table's
 * column picker and the advanced-filter metric picker so both stay in sync.
 */
export function phaseMetricAllowed(metric, formats) {
  if (!metric.isPhaseMetric) return true;
  if (metric.isPhaseMetric === "t20") {
    return formats.length === 1 && formats[0] === "T20";
  }
  if (metric.isPhaseMetric === "odi") {
    if (formats.length === 0) return false;
    return formats.every((f) => f === "ODI" || f === "ODM");
  }
  return true;
}

/** All metrics eligible to appear as columns / advanced-filter fields right now. */
export function eligibleMetrics(discipline, formats) {
  return metricsFor(discipline).filter((m) => phaseMetricAllowed(m, formats));
}

/**
 * Remove columns AND advanced-filter conditions whose metric is no longer
 * eligible under the current discipline+formats (phase gating per §8.9, or a
 * discipline switch orphaning e.g. an "economy" condition while batting).
 * Silent-drop for both, so the scope description stays honest (§8.4): a
 * condition that can't be seen must never keep filtering players.
 * Returns true if anything changed.
 */
export function pruneIneligibleState(store) {
  const s = store.get();
  const allowed = new Set(eligibleMetrics(s.discipline, s.formats).map((m) => m.key));

  const cols = s.columns[s.discipline];
  const prunedCols = cols.filter((k) => allowed.has(k));
  const colsChanged = prunedCols.length !== cols.length;

  // Matchup namespaces (D4 R3 follow-up, restricted picker): the same phase
  // gating (§8.9) applies there — a picked pp_/mid_/death_/odi_* column must
  // drop out the moment the format selection no longer permits it, exactly
  // like the plain batting/bowling picker. Prune both namespaces regardless
  // of which discipline is currently active, so a stale pick never resurfaces
  // silently when the user flips back into matchup mode.
  const newMatchupColumns = { ...s.columns };
  let matchupChanged = false;
  for (const ns of ["matchup_batting", "matchup_bowling"]) {
    const nsAllowed = new Set(eligibleMetrics(ns, s.formats).map((m) => m.key));
    const nsCols = s.columns[ns] || [];
    const nsPruned = nsCols.filter((k) => nsAllowed.has(k));
    if (nsPruned.length !== nsCols.length) {
      newMatchupColumns[ns] = nsPruned;
      matchupChanged = true;
    }
  }

  const groups = (s.advanced.groups || [])
    .map((g) => ({
      ...g,
      // keep incomplete conditions (blank metric) — they're inert edit rows
      conds: g.conds.filter((c) => !c.metricKey || allowed.has(c.metricKey)),
    }))
    .filter((g) => g.conds.length > 0);
  const condsChanged = JSON.stringify(groups) !== JSON.stringify(s.advanced.groups || []);

  if (!colsChanged && !matchupChanged && !condsChanged) return false;
  if (colsChanged) newMatchupColumns[s.discipline] = prunedCols;
  store.set({
    columns: colsChanged || matchupChanged ? newMatchupColumns : s.columns,
    advanced: condsChanged ? { ...s.advanced, groups } : s.advanced,
  });
  return true;
}

/** GENDER_LABELS / TEAM_TYPE_LABELS used by describeScope() and the filter bar. */
export const GENDER_LABELS = { female: "Women's", male: "Men's" };
export const TEAM_TYPE_LABELS = { international: "international", club: "club", both: null };

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(yyyymm) {
  if (!yyyymm) return null;
  const [y, m] = yyyymm.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Human label for the active format selection, e.g. "T20", "ODI + ODM", "T20 + Test". */
function formatsLabel(formats) {
  if (!formats || formats.length === 0) return null;
  return formats.join(" + ");
}

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
    notify();
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function notify() {
    for (const fn of listeners) fn(state);
  }

  /**
   * Honest plain-English scope sentence (§8.4) — only mentions filters that are
   * actually applied. e.g. "Women's T20s (international), Jul 2023 – Jul 2026, min 10 innings"
   */
  function describeScope() {
    const s = state;
    const parts = [];

    const genderWord = GENDER_LABELS[s.gender] ?? "";
    const fmtWord = formatsLabel(s.formats);
    let head = genderWord;
    if (fmtWord) head += (head ? " " : "") + fmtWord + "s";
    if (s.teamType !== "both") {
      head += (head ? " " : "") + `(${TEAM_TYPE_LABELS[s.teamType]})`;
    }
    if (head) parts.push(head.trim());

    const fromLbl = monthLabel(s.dateFrom);
    const toLbl = monthLabel(s.dateTo);
    if (fromLbl && toLbl) parts.push(`${fromLbl} – ${toLbl}`);
    else if (toLbl) parts.push(`through ${toLbl}`);
    else if (fromLbl) parts.push(`from ${fromLbl}`);

    if (s.teams && s.teams.length > 0) {
      parts.push(s.teams.length <= 3 ? s.teams.join(", ") : `${s.teams.length} teams`);
    }

    // Free splits (D4 Piece 3) — only tokens for filters actually applied:
    // positions apply in batting only, opposition in international only.
    if (oppositionFilterActive(s)) {
      parts.push(s.opposition.length <= 3 ? `vs ${s.opposition.join(", ")}` : `vs ${s.opposition.length} opponents`);
    }
    if (positionsFilterActive(s)) {
      const sorted = [...s.positions].sort((a, b) => a - b);
      parts.push(`batting at ${sorted.join(", ")}`);
    }

    // Matchup mode (R3, decision 33) — table only, right after the
    // opposition/positions tokens. The "(unspecified)" relabel (decision 24)
    // applies ONLY to the fine bowling_type buckets — coarse "vs Spin" means
    // ALL spin and must read plainly. The hand dim reads as plain English.
    if (s.view === "table" && matchupVsActive(s)) {
      const mv = s.matchupVs;
      if (mv.dim === "hand") {
        parts.push(mv.value === "Left-hand bat" ? "vs left-handers" : "vs right-handers");
      } else if (mv.dim === "type") {
        parts.push(`vs ${matchupBucketLabel(mv.value)}`);
      } else {
        parts.push(`vs ${mv.value}`);
      }
    }

    if (s.minInnings && s.minInnings > 1) {
      parts.push(`min ${s.minInnings} innings`);
    }

    for (const token of profileScopeTokens(s)) parts.push(token);

    if (s.search && s.search.trim()) {
      parts.push(`matching "${s.search.trim()}"`);
    }

    // Row grouping shapes the TABLE only (the graph ignores it), so the token
    // appears only while the table view is active — the graph card's
    // subtitle/footer read describeScope() and must stay honest (§8.4).
    const split = activeSplit(s);
    if (s.view === "table" && split) {
      parts.push(`grouped by ${split.label.toLowerCase()}`);
    }

    return parts.filter(Boolean).join(", ");
  }

  return { get, set, subscribe, describeScope };
}
