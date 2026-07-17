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

import { metricsFor, matchupBucketLabel, getMetric } from "./metrics.js";

/**
 * The three format buckets surfaced in the UI, and the match_type values each
 * expands to (R5 Wave 1a, owner-approved). These six match_type values are the
 * COMPLETE set in the live data, so the three buckets cover everything:
 *   Red Ball → Test + MDM (first-class)
 *   50 Over  → ODI + ODM (List-A one-day)
 *   T20      → T20 + IT20
 * This is the single source of truth — expandFormats and every format-keyed
 * consumer derives from it, and the bucket labels are now correct DIRECTLY (no
 * separate display-rename layer). team_type stays a separate scope dimension, so
 * the men's-T20-international baseline (2,813 batting) is unchanged: the T20
 * bucket is still exactly T20 + IT20.
 */
export const FORMAT_BUCKETS = [
  { key: "Red Ball", label: "Red Ball", matchTypes: ["Test", "MDM"] },
  { key: "50 Over", label: "50 Over", matchTypes: ["ODI", "ODM"] },
  { key: "T20", label: "T20", matchTypes: ["T20", "IT20"] },
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

// SQL single-quote escaper (Batch 2 review: the ONE export — every module
// that builds a SQL string literal imports this rather than redefining it).
export function escSql(s) {
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
    // "Historic team" mode (owner decision 46) — mirrors the pill's "Ever played for: …".
    tokens.push(p.teams.length <= 2 ? `Ever played for: ${p.teams.join(", ")}` : `Ever played for: ${p.teams.length} teams`);
  }
  return tokens;
}

// ── Innings-level filters (D4 Piece 3) ───────────────────────────────────────
// Two innings-level filters (batting position, opposition). Opposition is
// INTERNATIONAL cricket only (decision 20 — club team names are unnormalized),
// so the filter applies ONLY while teamType === "international"; the controls
// grey out elsewhere (decision-21 treatment: inert, never silently wrong).
// Positions are a batting concept and apply only in the batting discipline.
//
// The old table-only "Split by" breakdown (SPLIT_DIMENSIONS / splitAllowed /
// activeSplit) was removed in R4 Wave 3: the Group-rows UI had already been
// deleted in R3 and nothing ever set state.splitBy off its initial null, so
// the whole path was dead.

/** True if the MATCHUP-ONLY batting-position filter (`state.positions`) is
 * currently narrowing the set. Owner decision 46 split the old position filter
 * in two: `positions` is now consumed ONLY in matchup mode (both matchup views
 * carry a batting_position column — in matchup_batting the batter's OWN
 * position, in matchup_bowling the position of the STRIKER faced; anchor:
 * Bumrah vs RHB positions 1–2 = 27 inns/177 balls/9 wkts). Plain mode no longer
 * reads it — see regularPositionsFilterActive. Gating on matchupVsActive keeps
 * the query (buildScopeClauses), the matchup position dropdown, the pill, and
 * the honest scope sentence all agreeing automatically. */
export function positionsFilterActive(state) {
  return Array.isArray(state.positions) && state.positions.length > 0 && matchupVsActive(state);
}

/** True if the R. Pos. filter (`state.regularPositions`, owner decision 46) is
 * currently narrowing the set. Applies in PLAIN mode only (both disciplines) —
 * inert in matchup mode, where the striker-position filter uses `positions`
 * instead. The query gate is an additive per-player semi-join derived in
 * buildScopeClauses (a player matches when their most-common batting position
 * within scope is in the selection); this predicate keeps the pill, subtitle,
 * badge count, and drawer control all agreeing on when it is live. */
export function regularPositionsFilterActive(state) {
  return (
    !matchupVsActive(state) &&
    Array.isArray(state.regularPositions) &&
    state.regularPositions.length > 0
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

/** Effective metrics namespace for the current state: matchup_batting/
 * matchup_bowling while a "Vs" selection is active and applicable, otherwise
 * the plain discipline. Every lookup that needs to agree on which vocabulary
 * is "live" right now — column rendering/sorting (table.js's
 * effectiveDiscipline delegates here), the advanced-filter metric picker
 * (advanced.js) — must go through this single mapping. */
export function effectiveNamespace(state) {
  if (!matchupVsActive(state)) return state.discipline;
  return state.discipline === "batting" ? "matchup_batting" : "matchup_bowling";
}

/** True if the opposition filter is currently narrowing the innings set. */
export function oppositionFilterActive(state) {
  return state.teamType === "international" && Array.isArray(state.opposition) && state.opposition.length > 0;
}

// ── Match filters: Event / Venue (Batch 1B, task 1B-1) ──────────────────────
// Two additive match-level filters, structurally mirroring oppositionFilterActive
// above but WITHOUT its teamType === "international" gate: event_name and venue
// are meaningful for domestic competitions too (an IPL/county game has both),
// so — unlike opposition, whose club team names are unnormalized (decision 20)
// — there is no reason to restrict these to international scope. The query
// side (filters.js buildScopeClauses) joins state.event/state.venue to
// `matches` gender-scoped; see that module for the exact SQL.

/** True if the Event filter (state.event) is currently narrowing the match set. */
export function eventFilterActive(state) {
  return Array.isArray(state.event) && state.event.length > 0;
}

/** True if the Venue filter (state.venue) is currently narrowing the match set. */
export function venueFilterActive(state) {
  return Array.isArray(state.venue) && state.venue.length > 0;
}

// ── Stat-condition subtitle tokens (B2R wave 2, decision 42) ─────────────────
// describeScope() joins the active advanced conditions into the honest scope
// sentence ("…, Runs ≥ 300") replacing the old "min N innings" phrase (min
// innings is now just an "Innings ≥ N" condition like any other). DUPLICATED
// on purpose from pills.js's near-identical conditionPillLabel/OP_SYMBOLS/
// isConditionComplete — pills.js and advanced.js both import FROM this
// module, so either one importing back here would create a module cycle.
// Keep the two phrasings in sync by hand if either ever changes.
const CONDITION_OP_SYMBOLS = { gte: "≥", lte: "≤", eq: "=" };

function conditionIsComplete(c) {
  if (!c.metricKey) return false;
  if (c.v1 === "" || c.v1 === null || c.v1 === undefined || Number.isNaN(parseFloat(c.v1))) return false;
  if (c.operator === "between") {
    if (c.v2 === "" || c.v2 === null || c.v2 === undefined || Number.isNaN(parseFloat(c.v2))) return false;
  }
  return true;
}

function conditionScopeLabel(c, state) {
  const ns = effectiveNamespace(state);
  const inNs = metricsFor(ns).find((m) => m.key === c.metricKey);
  const metric = inNs || getMetric(c.metricKey);
  const label = metric ? metric.label : c.metricKey;
  if (c.operator === "between") return `${label} ${c.v1}–${c.v2}`;
  return `${label} ${CONDITION_OP_SYMBOLS[c.operator] ?? c.operator} ${c.v1}`;
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

/**
 * Build the initial state. `maxMonth` ("YYYY-MM") comes from the manifest's
 * max match_date once known; until then dateTo is null and the filter bar
 * should treat that as "not yet bounded" (no date predicate). The START date
 * (dateFrom) is ALWAYS blank at init and still REQUIRED — a search with no
 * start date stays blocked (R5 Wave 1a, item 4). Only the END date gains a
 * default, applied in filters.js's setDateBounds from the manifest max-date
 * bound (the same source the presets use) so the pre-fill and the presets
 * agree on one "latest match date".
 */
export function createInitialState(maxMonth) {
  const dateTo = maxMonth ?? null;
  const dateFrom = null;
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
    positions: [], // MATCHUP-ONLY batting positions (ints); [] = no predicate. In matchup mode
                   // this slices batting_position (batter's own position in matchup_batting; the
                   // striker faced in matchup_bowling — decision 33/37). Plain mode NO LONGER reads
                   // this (owner decision 46) — it uses regularPositions instead.
    regularPositions: [], // R. Pos. (owner decision 46): plain-mode filter on a player's MOST COMMON
                   // batting position within the current gender/format/date/team-type scope. [] = no
                   // predicate. Applies in plain mode only (matchup mode keeps its own `positions`).
    opposition: [], // opposition team names; [] = no predicate. International only (decision 20).
    event: [], // event_name values (Batch 1B, task 1B-1); [] = no predicate. NOT gated on teamType
               // (event_name is meaningful for domestic competitions too, unlike opposition) — see
               // eventFilterActive() and filters.js buildScopeClauses' gender-scoped matches join.
    venue: [], // venue values (Batch 1B, task 1B-1); [] = no predicate. See venueFilterActive() and
               // filters.js buildScopeClauses' gender-scoped matches join.
    matchupVs: null, // null | { dim: "group"|"type"|"hand", value } — leaderboard matchup mode (R3, decision 33)
    pinnedPlayers: [], // [{id, name}] — owner decision 46 task 3b: players ADDED to the table's
                   // result set regardless of the other leaderboard-only filters (team/opposition/
                   // position/profile/R. Pos./search/stat conditions). Their CORE scope
                   // (gender/format/date window/team type) still applies — see table.js's
                   // buildQuery for the additive WHERE/HAVING union. Plain mode only: matchup
                   // ("Vs") mode leaves buildMatchupQuery completely untouched (decision 39's
                   // byte-identical-SQL rule) and shows the pin pill greyed/inert instead.
    search: "",
    namePlayers: [], // R2-2b-ii: Advanced-Filters "Name" picker — [{id,name}]; applied as idCol IN (...) by buildScopeClauses.
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
  if (discipline === "batting" && formats.length > 0 && formats.every((f) => f === "Red Ball")) {
    // Owner exception: Red Ball (Test/MDM) batting swaps strike_rate for
    // balls_per_dismissal, and leads with runs, average, balls_per_dismissal.
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
        if (formats.length === 1 && formats[0] === "50 Over")
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
        if (formats.length === 1 && formats[0] === "50 Over")
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
 * bucket); ODI-range phase metrics only when formats is exactly ["50 Over"]
 * (the ODI+ODM bucket). Non-phase metrics are always eligible. Shared by the
 * table's column picker and the advanced-filter metric picker so both stay in
 * sync.
 */
export function phaseMetricAllowed(metric, formats) {
  if (!metric.isPhaseMetric) return true;
  if (metric.isPhaseMetric === "t20") {
    return formats.length === 1 && formats[0] === "T20";
  }
  if (metric.isPhaseMetric === "odi") {
    return formats.length === 1 && formats[0] === "50 Over";
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

  // Advanced-condition pruning uses a WIDER allow-set than columns: the union
  // of eligible keys across both plain namespaces AND both matchup namespaces
  // (D4 R3/R4). A condition authored in matchup mode (e.g. "dis_caught >= 2")
  // must survive leaving matchup mode — and vice versa — so switching
  // discipline/Vs never silently deletes a condition written in the OTHER
  // vocabulary. table.js's conditionToHaving() already re-resolves each
  // condition's metric against the CURRENT effective namespace and skips it
  // (returns null) when the key doesn't exist there — that's the mechanism
  // that keeps a condition from a different namespace inert rather than wrong.
  const advancedAllowed = new Set([
    ...eligibleMetrics("batting", s.formats).map((m) => m.key),
    ...eligibleMetrics("matchup_batting", s.formats).map((m) => m.key),
    ...eligibleMetrics("bowling", s.formats).map((m) => m.key),
    ...eligibleMetrics("matchup_bowling", s.formats).map((m) => m.key),
  ]);

  const groups = (s.advanced.groups || [])
    .map((g) => ({
      ...g,
      // keep incomplete conditions (blank metric) — they're inert edit rows
      conds: g.conds.filter((c) => !c.metricKey || advancedAllowed.has(c.metricKey)),
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
export const TEAM_TYPE_LABELS = { international: "international", club: "domestic", both: null };

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
   *
   * `stateOverride` (R7 Wave 2, item 16): the Graph Builder shares this store
   * but ignores matchup ("Vs") mode for its queries, so it passes a matchupVs-
   * nulled view of the state here to keep its card footer honest — otherwise a
   * "Vs" bucket still set on the shared store would flip the positions token's
   * phrasing (or hide the R. Pos. token) even though the graph query ran plain.
   * Existing callers pass nothing and get the live store state exactly as before.
   */
  function describeScope(stateOverride) {
    const s = stateOverride || state;
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
      // "Current team" mode (owner decision 46) — mirrors the pill's "Team: …".
      parts.push(s.teams.length <= 3 ? `Team: ${s.teams.join(", ")}` : `Team: ${s.teams.length} teams`);
    }

    // Free splits (D4 Piece 3) — only tokens for filters actually applied:
    // positions apply in batting only, opposition in international only.
    if (oppositionFilterActive(s)) {
      parts.push(s.opposition.length <= 3 ? `vs ${s.opposition.join(", ")}` : `vs ${s.opposition.length} opponents`);
    }
    if (positionsFilterActive(s)) {
      const sorted = [...s.positions].sort((a, b) => a - b);
      // Bowling-matchup mode: the position filter narrows the BATTERS faced,
      // not the bowler's own (nonexistent) batting position — say so plainly.
      const bowlingMatchup = s.discipline === "bowling" && matchupVsActive(s);
      parts.push(bowlingMatchup ? `to batters at ${sorted.join(", ")}` : `batting at ${sorted.join(", ")}`);
    }
    // R. Pos. (owner decision 46) — plain-mode only; mirrors the pill's "R. Pos. …".
    if (regularPositionsFilterActive(s)) {
      const sorted = [...s.regularPositions].sort((a, b) => a - b);
      parts.push(`regular position ${sorted.join(", ")}`);
    }
    // Name picker (R2-2b-ii) — mirrors the per-player "Name: …" pills.
    if (Array.isArray(s.namePlayers) && s.namePlayers.length > 0) {
      const names = s.namePlayers.map((p) => p.name);
      parts.push(names.length <= 3 ? `Name: ${names.join(", ")}` : `Name: ${names.length} players`);
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

    // Stat conditions (decision 42): up to two list out in full, symbol-style
    // (matching the pills); beyond that the subtitle collapses to a count
    // ("3 stat conditions") rather than growing unbounded (flagged threshold).
    const activeConds = [];
    for (const g of s.advanced.groups || []) {
      for (const c of g.conds) {
        if (conditionIsComplete(c)) activeConds.push(c);
      }
    }
    if (activeConds.length > 0 && activeConds.length <= 2) {
      for (const c of activeConds) parts.push(conditionScopeLabel(c, s));
    } else if (activeConds.length > 2) {
      parts.push(`${activeConds.length} stat conditions`);
    }

    for (const token of profileScopeTokens(s)) parts.push(token);

    if (s.search && s.search.trim()) {
      parts.push(`matching "${s.search.trim()}"`);
    }

    return parts.filter(Boolean).join(", ");
  }

  return { get, set, subscribe, describeScope };
}
