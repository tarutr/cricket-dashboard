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
//     // R5-A #7: the CURRENT discipline's numeric stat conditions (shape above).
//   advancedByDiscipline: { batting: {op,groups}, bowling: {op,groups} },
//     // the per-discipline archive; createStore.set swaps `advanced` <-> here on a
//     // discipline change so conditions never leak batting<->bowling.
// }
//
// `formats` stores owner-facing bucket keys (see FORMAT_BUCKETS below), not raw
// match_type values — "T20" here means the T20-bucket (T20 + IT20), matching the
// Phase 2 brief's owner decision that Cricsheet mislabels internationals.

import { metricsFor, matchupBucketLabel, getMetric, metricDisplayLabel, INNINGS_NUMBER_FILTER } from "./metrics.js";
import { deliveryWindowTokens, withDeliveryWindowPiece } from "./deliveryWindow.js";

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

// ── Data-presence gate (Group 3, owner directive 2026-08-06) ─────────────────
// "There's no reason for this to be men only. It needs to be data only." Whether
// the matchup "Vs" mode and the profile-derived filters apply to a query is now
// keyed on whether the underlying DATA exists for the current gender — NOT on a
// `gender === "male"` / `gender === "female"` hardcode. For today's data the two
// are byte-identical (men → data present; women → 0% profile/matchup coverage →
// absent); the gate only diverges when non-male data lands, at which point the
// feature turns on with no code change (the whole point).
//
// `state.dataAvail` is the RESOLVED per-gender existence map
//   { matchupBatting, matchupBowling, profileRole, profileHand, profileBowling }
// that src/dataAvailability.js fills (main.js kicks resolveDataAvail on load +
// gender switch). matchupVsActive / profileSemiJoinSql are PURE SYNC and are read
// by the query builders AND the UI, so correctness rides on WHO reads them when:
//   • The leaderboard's Search commit path AWAITS resolveDataAvail before building
//     any query (main.js runSearch), so a leaderboard/graph query NEVER reads an
//     unresolved value.
//   • The pop-up's per-row builders start from a fresh createInitialState (no live
//     dataAvail — so they hit the optimistic fallback below), but the secondary
//     guards make that correct for today's data: a matchup row is men-only in
//     practice (row.matchupVs is null for women — the offer path never lets a women
//     row set it), and a profile filter is never active on a pop-up row
//     (buildRowState leaves profile empty). So "optimistic present" routes exactly
//     as the old gender gate did.
//   • Other UI reads (pills/palette/toolbar) are display-only — no number rides on
//     them — so an optimistic read is harmless and self-corrects on resolve.
/** Resolved data-availability bool for `key`; TRUE (optimistic) until resolved.
 * See the block above for why optimistic-until-resolved is safe for every reader. */
function dataAvailBool(state, key) {
  const a = state.dataAvail;
  if (a && typeof a[key] === "boolean") return a[key];
  return true; // optimistic until the probe resolves
}

/** True iff PROFILE data (role / batting-hand / bowling-style) exists for the
 * current gender — the data-presence replacement for the old `gender === "female"`
 * guard in profileSemiJoinSql / profileScopeTokens. Optimistic until resolved. */
function profileDataPresent(state) {
  return (
    dataAvailBool(state, "profileRole") ||
    dataAvailBool(state, "profileHand") ||
    dataAvailBool(state, "profileBowling")
  );
}

/**
 * SQL semi-join clause restricting `idColumn` (batter_id / bowler_id / player_id)
 * to the player_ids whose profile matches every active profile filter. Returns
 * null when no profile filter is active OR no profile data exists for the current
 * gender (data-presence gate, owner directive 2026-08-06 — REPLACES the old
 * `gender === "female"` hardcode; never silently empty a view that has no profile
 * data, and the offer path already disables the controls where there's none, so
 * this stays a query-side backstop, now data-driven not gender). Shared by table,
 * graph, and team-option lookups so the honest scope sentence and every query agree.
 */
export function profileSemiJoinSql(state, idColumn) {
  if (!idColumn) return null;
  if (!profileDataPresent(state)) return null;
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
  // Data-presence gate (owner 2026-08-06) — mirrors profileSemiJoinSql's guard in
  // place of the old `gender === "female"` hardcode. Profile is cleared on gender
  // switch, so a no-profile-data gender yields [] either way; this keeps the
  // subtitle and the query on the ONE guard.
  if (!profileDataPresent(state)) return [];
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
// Two innings-level filters (batting position, opposition). Opposition used to
// be international-cricket-only (decision 20 — club team names are
// unnormalized), gated on teamType === "international". Decision 51 (R5-F #14)
// REVERSES that: opposition now applies for club/domestic scope too, on the
// same raw (un-normalized) team names the Team filter already runs on — team-
// name normalization for both is a deferred post-round to-do.
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
 * currently narrowing the set. R. Pos. is a BATTING concept — a player's own
 * most-common batting position within scope — so it is active in every batting
 * context (plain batting AND batting matchup, Wave 4b / decision 47a: "usual
 * top-order players, full record vs the bucket") and inactive in every bowling
 * context (plain bowling and bowling matchup, where the striker-position filter
 * uses `positions` instead). The query gate is an additive per-player semi-join
 * derived in buildScopeClauses (a player matches when their most-common batting
 * position within scope is in the selection); it applies identically in plain
 * and matchup mode because both go through buildScopeClauses with an idColumn.
 * This predicate keeps the pill, subtitle, badge count, and drawer control all
 * agreeing on when it is live. Gating on discipline (not matchupVsActive) is
 * what opens the Vs gate without touching the striker-position filter. */
export function regularPositionsFilterActive(state) {
  return (
    state.discipline === "batting" &&
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
 *
 * The gate now keys on DATA PRESENCE, not gender (owner directive 2026-08-06 —
 * REPLACES the old `gender !== "male"` hardcode): a batting matchup (dim
 * group/type, keyed on bowling_type) needs matchup_batting rows; a bowling matchup
 * (dim hand, keyed on batting_hand) needs matchup_bowling rows. For today's data
 * that is byte-identical to the gender check (men present / women absent). See the
 * data-presence block above dataAvailBool for why the sync read is always correct.
 */
export function matchupVsActive(state) {
  if (!state.matchupVs) return false;
  const { dim } = state.matchupVs;
  if (dim === "hand") return state.discipline === "bowling" && dataAvailBool(state, "matchupBowling");
  if (dim === "group" || dim === "type") return state.discipline === "batting" && dataAvailBool(state, "matchupBatting");
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

/** True if the opposition filter is currently narrowing the innings set.
 * Decision 51 (R5-F #14) reverses the old international-only gate (decision
 * 20): opposition now works for club/domestic scope too, on the same raw
 * (un-normalized) team names the Team filter already uses. Team-name
 * normalization for both filters is a deferred post-round to-do. */
export function oppositionFilterActive(state) {
  return Array.isArray(state.opposition) && state.opposition.length > 0;
}

/** True if the opponent-player head-to-head filter is currently narrowing the
 * counted balls to one opponent Y (pop-up Tab-2 T-1, owner decision 70). Only
 * ever set while the ball engine is active (the picker renders only then), so no
 * extra flag gate is needed here — the pill / scope token / count all defer to it,
 * mirroring the delivery-window convention. */
export function opponentPlayerActive(state) {
  return Boolean(state.opponentPlayer && state.opponentPlayer.id);
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

// ── Event → Season nested narrowing (Wave 6 pt2, owner-approved design §B) ────
// `state.eventSeasons` maps a chosen event_name → the list of specific seasons
// kept for it (a PROPER-SUBSET narrowing). Absence of a key (or an empty array)
// means "All seasons" for that event — NO narrowing — so with every event on
// All the object is `{}` and the emitted SQL is byte-identical to the pre-pt2
// event-only filter (backward-compatible; anchors safe). The season strings are
// the raw `matches.season` values (e.g. "2024", "2023/24"); the query side lives
// in filters.js buildScopeClauses (per-event OR of event_name[/season IN …]) and
// the picker in drawerInnings.js mountEvent. A key for an event NOT in
// state.event is inert — the query builder only reads keys for the events
// actually selected — but the UI + pill prune such orphans for honesty.

/** The specific seasons chosen for `eventName` (a narrowing), or [] when the
 * event is on "All seasons" (no narrowing). */
export function seasonsForEvent(state, eventName) {
  const arr = (state.eventSeasons || {})[eventName];
  return Array.isArray(arr) ? arr : [];
}

/** True if ANY currently-selected event is narrowed to specific seasons. When
 * false, the event clause is byte-identical to the pre-Wave-6-pt2 event-only
 * filter — this is the single gate filters.js uses to stay backward-compatible. */
export function anyEventSeasonNarrowing(state) {
  if (!eventFilterActive(state)) return false;
  const es = state.eventSeasons || {};
  return state.event.some((e) => Array.isArray(es[e]) && es[e].length > 0);
}

/** True if the Venue filter (state.venue) is currently narrowing the match set. */
export function venueFilterActive(state) {
  return Array.isArray(state.venue) && state.venue.length > 0;
}

// ── Fielding SLICE conditions (fielding rebuild) ────────────────────────────
// The fielding metric's OWN dims (dismissed-batter position / dismissal kind /
// phase), narrowing which wicket-events the Catches/Stumpings/Run-outs/Dismissals
// -Effected totals count. Stored on state.fielding as three multi-select lists.
// Applied inside table.js's fielding_cte (buildFieldingSliceClauses) — a WHERE
// slice, not a HAVING condition. Each list active iff non-empty.

/** True if the fielding dismissed-position slice is narrowing the events. */
export function fieldingPositionActive(state) {
  return Boolean(state.fielding && Array.isArray(state.fielding.positions) && state.fielding.positions.length > 0);
}
/** True if the fielding phase slice is narrowing the events. */
export function fieldingPhaseActive(state) {
  return Boolean(state.fielding && Array.isArray(state.fielding.phases) && state.fielding.phases.length > 0);
}

/** The three fielding phase buckets — the vocabulary the fielding phase SLICE
 * condition picks from. The `value`s are the EXACT literals stored in
 * fielding_events (phase) and filtered by table.js buildFieldingSliceClauses.
 * (The former dismissal-kind slice's FIELDING_KIND_OPTIONS vocabulary was
 * removed with fld_kind, waveR2-cleanup — its "kind" literals still exist on
 * fielding_events and are read by Fielding Wicket Type ▸'s count metrics.) */
export const FIELDING_PHASE_OPTIONS = [
  { value: "pp", label: "Powerplay" },
  { value: "mid", label: "Middle" },
  { value: "death", label: "Death" },
];
/** Dismissed-batter positions offered by the fielding position slice (1–11). */
export const FIELDING_POSITIONS = Array.from({ length: 11 }, (_, i) => i + 1);

// ── Match-context filters (Wave 6, owner-approved design) ───────────────────
// Categorical WHERE filters that narrow the innings set by the MATCH's
// context (result / toss / tournament stage / rain-method) — "who batted
// first" (mc_innings_order) was removed with its replacement, Innings Number ▸
// (waveR2-cleanup) — grouped under "Match context" in the "+ Add condition…"
// picker and available
// in batting, bowling AND matchup views. They are player-RELATIVE where the
// design calls for it: the innings row's OWN team (batting_team for a batting
// row, bowling_team for a bowling row; matchup rows carry both) is compared to
// the match's derived match_winner / toss_winner / team_batting_first — so no
// extra player join is needed. The query side lives in filters.js
// (buildMatchContextClauses / matchContextJoinSql) and is wired into
// table.js's buildQuery / buildMatchupQuery via a LEFT JOIN to `matches`; when
// NONE of these is active the emitted SQL is byte-identical to before.
//
// Each value token below is the EXACT literal the clause builder tests; the
// `value`s for Stage are raw `event_stage` strings supplied at run time.
// Result (FIX A): the outcome facets, LED by an "All" pseudo-option. "All" is
// auto-checked when the Result condition is first added (see drawer.js) and means
// NO outcome narrowing — the clause builder emits nothing for it, so Result = All
// is byte-identical to having no Result condition at all. Picking any specific
// outcome unchecks "All"; unchecking the last specific snaps back to "All". The
// stored array is either [RESULT_ALL] (or empty) for "All", else the specific
// outcome tokens (never mixed — resultFilterActive treats any non-All token as
// narrowing).
//
// "Super Over" was REMOVED from this list (Wave 6 polish item 4): `match_winner`
// already resolves the super-over winner, so those 108 matches ALREADY count as
// Won/Lost here — listing "Super Over" beside the outcomes wrongly implied it was
// a fifth, mutually-exclusive outcome. It is a FACET of a result, so it moved to
// the Result Condition sub-picker below (alongside Normal / D/L / VJD / …). Drawn
// and Tied stay SEPARATE options (owner ruling) — they are different outcomes.
export const RESULT_ALL = "all";
export const RESULT_OPTIONS = [
  { value: "all", label: "All" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "drawn", label: "Drawn" },
  { value: "tied", label: "Tied" },
  { value: "no_result", label: "No result" },
];
export const TOSS_RESULT_OPTIONS = [
  { value: "won", label: "Won toss" },
  { value: "lost", label: "Lost toss" },
];
export const TOSS_DECISION_OPTIONS = [
  { value: "bat", label: "Chose to bat" },
  { value: "field", label: "Chose to field" },
];
// INNINGS_ORDER_OPTIONS (batted first / bowled first) was removed with
// mc_innings_order — the spec's replacement, Innings Number ▸, uses
// inningsNumberOptions() below instead (waveR2-cleanup).

// Result Condition (FIX B; RENAMED from "Result Type", Wave 6 polish item 4): a
// NESTED sub-picker under Result (shown only while the Result condition is active
// — see mountResult / drawer.js), mirroring the Event → Season nesting. It
// narrows by HOW the result came about — the match's `method` plus the super-over
// facet: "All" = no narrowing (clause emits nothing → byte-identical); "Normal" =
// a plain result (no method AND no super over); "Super Over" = the super-over
// facet flag; and one option per real method (D/L / VJD / Awarded / Lost fewer
// wickets). Like Result, "All" leads and is auto-checked as the default; picking a
// specific option unchecks it. The stored array (state.resultCondition) is
// [RESULT_CONDITION_ALL] (or empty) for "All", else the specific tokens below;
// resultConditionMethod maps each method-backed token to its raw `method` string,
// and filters.js buildMatchContextClauses turns the selection into the WHERE
// fragment. Replaces the former standalone "Rain-affected matches" filter
// (state.method), whose method logic now lives here. "Awarded" / "Lost fewer
// wickets" (5 matches total) aren't literally rain but are grouped here for
// completeness.
//
// These are FACETS, not partitions: exactly 1 of the 108 super overs also carries
// a method, so Super Over legitimately overlaps a method option. "Normal"
// excludes both (method IS NULL AND NOT super over) — that is the one option that
// is defined by absence, which is why it needs the super-over term (item 4).
export const RESULT_CONDITION_ALL = "all";
export const RESULT_CONDITION_NORMAL = "normal";
export const RESULT_CONDITION_SUPER_OVER = "super_over";
export const RESULT_CONDITION_OPTIONS = [
  { value: "all", label: "All" },
  { value: "normal", label: "Normal" },
  { value: "super_over", label: "Super Over" },
  { value: "dl", label: "D/L (Rain)", method: "D/L" },
  { value: "vjd", label: "VJD (Rain)", method: "VJD" },
  { value: "awarded", label: "Awarded", method: "Awarded" },
  { value: "fewer", label: "Fewer Wickets", method: "Lost fewer wickets" },
];
const RESULT_CONDITION_METHOD = Object.fromEntries(
  RESULT_CONDITION_OPTIONS.filter((o) => o.method).map((o) => [o.value, o.method])
);
/** The raw `matches.method` string a specific Result-Condition token narrows to
 * (D/L, VJD, Awarded, Lost fewer wickets), or null for "all"/"normal"/"super_over"
 * (which carry no IN(...) method — those three are their own disjuncts). */
export function resultConditionMethod(token) {
  return RESULT_CONDITION_METHOD[token] || null;
}

// Stage (Wave 6 polish item 3): the tournament-round filter gains the SAME
// "All" no-narrowing sentinel Result has, plus a "No Stage" option for the
// 20,689 matches whose `event_stage` IS NULL (98.8% of red-ball domestic — a
// league round with no round name). The remaining values in state.stage are
// CANONICAL stage labels, which filters.js expands to their raw spellings.
// Neither sentinel can collide with a real stage: verified against the live data
// that no `event_stage` equals "all" or "(no stage)".
export const STAGE_ALL = "all";
export const STAGE_NONE = "(no stage)";
export const STAGE_NONE_LABEL = "No Stage";

/** True if the Result filter (state.result) is narrowing the set. "All"
 * (RESULT_ALL) is a no-narrowing sentinel, so a selection of only "All" (or
 * empty) is INACTIVE — this is what keeps Result = All byte-identical to having
 * no Result condition (matchContextActive stays false, so no LEFT JOIN is added). */
export function resultFilterActive(state) {
  return Array.isArray(state.result) && state.result.some((v) => v !== RESULT_ALL);
}
/** True if the Toss result filter (state.tossResult) is narrowing the set. */
export function tossResultFilterActive(state) {
  return Array.isArray(state.tossResult) && state.tossResult.length > 0;
}
/** True if the Toss decision filter (state.tossDecision) is narrowing the set. */
export function tossDecisionFilterActive(state) {
  return Array.isArray(state.tossDecision) && state.tossDecision.length > 0;
}
// ── Innings Number (filter-rejig Wave R2c) ───────────────────────────────────
// The REPLACEMENT for the old batted-first/chased "Innings order": narrows to
// the innings the player batted / bowled in, by its 1-based DISPLAY number
// (INNINGS_NUMBER_FILTER maps display N → the 0-based stored innings_number in
// filters.js). White-ball formats (T20 / 50-over) have TWO innings; a selection
// that includes Red Ball allows up to FOUR (INNINGS_NUMBER_FILTER.whiteBall /
// .redBall). state.inningsNumber holds the DISPLAY ints; the SQL half lives in
// filters.js buildScopeClauses (emitted only for the batting/bowling innings
// views, keyed off their team column — see there). Empty = no predicate =
// query byte-identical.
const INNINGS_ORDINALS = ["", "1st", "2nd", "3rd", "4th"];
/** Human label for a 1-based innings number ("1st innings"). Format-independent
 * (only the OFFERED SET below varies by format). */
export function inningsNumberLabel(n) {
  return `${INNINGS_ORDINALS[n] || `${n}th`} innings`;
}
/** The innings-number DISPLAY values selectable under the current formats, as
 * [{value,label}]. Two for pure white-ball; up to four when Red Ball is in the
 * selection (a Test/MDM can have four innings). */
export function inningsNumberOptions(formats) {
  const maxInn = (formats || []).includes("Red Ball")
    ? INNINGS_NUMBER_FILTER.redBall.length
    : INNINGS_NUMBER_FILTER.whiteBall.length;
  return Array.from({ length: maxInn }, (_, i) => ({ value: i + 1, label: inningsNumberLabel(i + 1) }));
}
/** True if the Innings Number filter (state.inningsNumber) is narrowing the set. */
export function inningsNumberFilterActive(state) {
  return Array.isArray(state.inningsNumber) && state.inningsNumber.length > 0;
}
/** True if the Stage filter (state.stage) is narrowing the set. Like Result,
 * "All" (STAGE_ALL) is the no-narrowing sentinel (Wave 6 polish item 3), so an
 * All-only (or empty) selection is INACTIVE — which is what keeps "Stage
 * condition added, left on All" byte-identical to having no Stage condition. */
export function stageFilterActive(state) {
  return Array.isArray(state.stage) && state.stage.some((v) => v !== STAGE_ALL);
}
/** True if the Result Condition sub-filter (state.resultCondition) is narrowing
 * the set. Like Result, "All" (RESULT_CONDITION_ALL) is the no-narrowing
 * sentinel, so an All-only (or empty) selection is INACTIVE and stays
 * byte-identical. */
export function resultConditionFilterActive(state) {
  return Array.isArray(state.resultCondition) && state.resultCondition.some((v) => v !== RESULT_CONDITION_ALL);
}
/** True if ANY match-context filter is active — the single gate table.js uses
 * to decide whether to LEFT JOIN `matches` and append the context clauses (and
 * whether "matches" must be counted innings-level for honesty). With all five
 * off, the query is byte-identical to before Wave 6. (inningsOrderFilterActive's
 * disjunct was dropped with mc_innings_order, waveR2-cleanup — it was always
 * false, since that filter had been unreachable from the palette since Wave R2c,
 * so this changes nothing this function returns for any state.) */
export function matchContextActive(state) {
  return (
    resultFilterActive(state) ||
    tossResultFilterActive(state) ||
    tossDecisionFilterActive(state) ||
    stageFilterActive(state) ||
    resultConditionFilterActive(state)
  );
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

// Wave A2 item 2: Best Bowling is a two-value ("W" + "R") condition, like
// "between". Detected via the catalogue flag (namespace-agnostic — both `best`
// entries carry it). Kept as a local check because state.js can't import from
// advanced.js (advanced.js imports FROM state.js — a cycle), mirroring the
// hand-duplicated conditionIsComplete twin noted above.
function conditionIsBowlingFigures(c) {
  return getMetric(c.metricKey)?.conditionInput === "bowlingFigures";
}

function conditionIsComplete(c) {
  if (!c.metricKey) return false;
  if (c.v1 === "" || c.v1 === null || c.v1 === undefined || Number.isNaN(parseFloat(c.v1))) return false;
  if (c.operator === "between" || conditionIsBowlingFigures(c)) {
    if (c.v2 === "" || c.v2 === null || c.v2 === undefined || Number.isNaN(parseFloat(c.v2))) return false;
  }
  return true;
}

function conditionScopeLabel(c, state) {
  const ns = effectiveNamespace(state);
  const inNs = metricsFor(ns).find((m) => m.key === c.metricKey);
  const metric = inNs || getMetric(c.metricKey);
  // metricDisplayLabel keeps the "(Innings)" suffix logic in sync with pills.js
  // (this function is the hand-duplicated twin noted above) — Wave A1 item 4.
  const label = metric ? metricDisplayLabel(metric, state.formats) : c.metricKey;
  // Best Bowling (Wave A2 item 2): "Best Bowling ≥2W for ≤9R" — matches pills.js.
  if (conditionIsBowlingFigures(c)) return `${label} ≥${c.v1}W for ≤${c.v2}R`;
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
  // Coverage-breakdown wave: the three composition columns (comp_*) default ON
  // and far-right — a per-group style/hand-mix breakdown replacing the old
  // fixed "Coverage" column (they are ordinary sortable/draggable/toggleable
  // columns; the fixed Coverage cell is gone from table.js).
  matchup_batting: [
    "innings", "balls", "runs", "strike_rate", "average", "dismissals", "dot_pct", "boundary_pct",
    "comp_pace", "comp_spin", "comp_uncat",
  ],
  matchup_bowling: [
    "innings", "balls", "wickets", "runs_conceded", "economy", "average", "strike_rate", "dot_pct",
    "comp_rhb", "comp_lhb", "comp_uncat",
  ],
};

/** A fresh, empty numeric-stat-condition block ({ op, groups }). */
export function emptyAdvancedBlock() {
  return { op: "AND", groups: [] };
}

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
    opposition: [], // opposition team names; [] = no predicate. Was international-only
                   // (decision 20); decision 51 (R5-F #14) enables it for club/domestic
                   // too, on the same raw team names.
    event: [], // CANONICAL event labels (name normalization, backlog #5 — many raw event_name
               // spellings fold to one label; filters.js expands each back to its raw alias set).
               // [] = no predicate. NOT gated on teamType (event_name is meaningful for domestic
               // competitions too, unlike opposition) — see eventFilterActive() and filters.js
               // buildScopeClauses' gender-scoped matches join.
    venue: [], // venue values (Batch 1B, task 1B-1); [] = no predicate. See venueFilterActive() and
               // filters.js buildScopeClauses' gender-scoped matches join.
    eventSeasons: {}, // Event → Season narrowing (Wave 6 pt2): { [canonical event label]: string[] }
               // of the specific seasons kept per chosen event (keyed by the same canonical labels
               // state.event holds — name normalization, backlog #5). {} = every event on "All
               // seasons" = no
               // narrowing = query byte-identical to the event-only filter. See seasonsForEvent()/
               // anyEventSeasonNarrowing() above and filters.js buildScopeClauses. Reset alongside
               // state.event on any scope change (gender/format/team-type/date) in filters.js.
    fielding: { positions: [], phases: [] },
               // Fielding SLICE conditions (fielding rebuild): refine WHAT the
               // Catches/Stumpings/Run-outs/Dismissals-Effected metrics count, by
               // the fielding event's OWN dims — dismissed-batter position
               // (positions[], on out_batting_position) and phase (phases[]).
               // All multi-select lists (mirroring the app's
               // position/opposition pickers). Applied inside table.js
               // buildFieldingSliceClauses -> fielding_cte WHERE. All empty = no
               // predicate (query byte-identical). Only bite when a fielding
               // column/condition is present (nothing to slice otherwise). (The
               // former dismissal-kind slice, `kinds[]`, was removed with fld_kind
               // — waveR2-cleanup; table.js's buildFieldingSliceClauses still
               // guards `Array.isArray(f.kinds)`, which is simply always false now.)
    // Match-context filters (Wave 6). Categorical WHERE filters; all empty =
    // no predicate = query byte-identical to before. See the block above the
    // RESULT_OPTIONS constants and filters.js buildMatchContextClauses.
    result: [],        // Result outcome facets (FIX A): empty when the condition isn't added; on add
                       // it defaults to [RESULT_ALL] ("All", no narrowing), else the specific outcome
                       // tokens (won/lost/drawn/tied/no_result). See RESULT_OPTIONS.
    tossResult: [],    // subset of {"won","lost"} — row team ==/<> toss_winner
    tossDecision: [],  // subset of {"bat","field"} — matches.toss_decision
    // inningsOrder (batted first / bowled first) was removed with mc_innings_order
    // (waveR2-cleanup) — see inningsNumber below, its replacement.
    inningsNumber: [], // Innings Number (filter-rejig Wave R2c): 1-based DISPLAY innings numbers
                       // (1–2 white-ball / 1–4 red-ball) the player batted/bowled in; [] = no
                       // predicate. filters.js buildScopeClauses maps each to the 0-based stored
                       // innings_number and emits it only for the batting/bowling innings views.
                       // Replaces the old "Innings order" as the Innings Number filter.
    stage: [],         // Stage: empty when the condition isn't added; on add it defaults to
                       // [STAGE_ALL] ("All", no narrowing), else CANONICAL stage labels to keep
                       // (name normalization, backlog #5 — filters.js buildMatchContextClauses
                       // expands each to its raw event_stage spelling set) and/or STAGE_NONE
                       // ("No Stage" = event_stage IS NULL).
    resultCondition: [], // Result Condition sub-filter (FIX B, renamed item 4): nested under Result.
                       // Empty until the Result condition is added, then defaults to
                       // [RESULT_CONDITION_ALL]; else the specific tokens (normal/super_over/dl/vjd/
                       // awarded/fewer). See RESULT_CONDITION_OPTIONS + resultConditionMethod.
    deliveryWindow: null, // Delivery-window filter (ball-grain rebuild Wave 3, owner decision 67).
                   // null = no window = every number byte-identical to today (the critical invariant).
                   // When set, a plain-object spec (see src/deliveryWindow.js): a TEAM clock
                   // ({mode:'phase'|'overs'|'balls', …}) and/or a PLAYER clock ({edge:'first'|'last', n}),
                   // composing with AND. db.js reads it via setDeliveryWindow() and pushes the generated
                   // ball predicate into the ball-engine base CTE for ALL four views (windows define the
                   // numbers → pins obey them; innings under a window = innings with ≥1 in-window ball).
                   // The drawer UI that sets this comes in a later wave (engine half only for now).
    opponentPlayer: null, // Opponent-player head-to-head filter (pop-up Tab-2 T-1, owner decision 70).
                   // null = no opponent = every number byte-identical to today (the invariant).
                   // When set: { id, name } — restricts the counted BALLS to those against ONE
                   // opponent Y (subject batting ⇒ bowler_id = Y; subject bowling ⇒ batter_id = Y).
                   // Ball-engine ONLY (per-delivery ids); db.js reads it via setOpponentPlayer() and
                   // folds the ball predicate into the same base-CTE hook as the delivery window (so
                   // pins obey it too). `id` reaches SQL; `name` is display-only (pill/scope label).
                   // See src/opponentFilter.js + opponentPlayerActive() below.
    matchupVs: null, // null | { dim: "group"|"type"|"hand", value } — leaderboard matchup mode (R3, decision 33)
    dataAvail: null, // Data-presence gate (Group 3, owner 2026-08-06): resolved per-gender existence map
                   // { matchupBatting, matchupBowling, profileRole, profileHand, profileBowling } that
                   // matchupVsActive / profileSemiJoinSql key on instead of gender. null = UNRESOLVED;
                   // dataAvailBool then reads optimistic (present). main.js fills it via
                   // src/dataAvailability.js's resolveDataAvail (boot + gender switch), and the Search
                   // commit path AWAITS it so no query is built from an unresolved value. Never part of
                   // the Search-dirty key (serializeQueryState) — it's a deterministic function of gender,
                   // which IS in that key. See the data-presence block near escSql above.
    pinnedPlayers: [], // [{id, name}] — owner decision 46 task 3b: players ADDED to the table's
                   // result set regardless of the PLAYER-SHORTLISTING filters (team/profile/
                   // R. Pos./search/stat conditions). A pin changes WHO is listed, never WHAT
                   // their numbers mean, so their CORE scope (gender/format/date window/team
                   // type) still applies — and so does everything else that selects matches or
                   // balls: opposition, the matchup striker position, event, venue, match
                   // context. Wave 4b (decision 47a):
                   // pins now apply in BOTH plain (buildQuery) and matchup ("Vs", buildMatchupQuery)
                   // mode, through ONE shared exemption helper (filters.js whereWithPinExemption /
                   // gateWithPinExemption) so the two builders can never diverge; the pill is live
                   // (not greyed) in Vs mode too.
    search: "",
    sort: { key: "runs", dir: "desc" },
    keepColumns: false, // "Keep Selected Columns" toggle (4d/A5): OFF (default) lets a
                   // discipline/format change re-sync the visible columns to that scope's
                   // default (main.js's reapplyDefaultColumnsIfUnmodified, unless already
                   // customized); ON skips that resync entirely, so whatever columns +
                   // order are currently showing simply carry into the next Search.
                   // Display-only — never read by any query builder.
    columns: {
      batting: [...DEFAULT_COLUMNS.batting],
      bowling: [...DEFAULT_COLUMNS.bowling],
      matchup_batting: [...DEFAULT_MATCHUP_COLUMNS.matchup_batting],
      matchup_bowling: [...DEFAULT_MATCHUP_COLUMNS.matchup_bowling],
    },
    // Numeric stat conditions (SPEC §5.2). R5-A #7 (decision 50) made them
    // PER-DISCIPLINE: `advanced` always holds the CURRENT discipline's conditions
    // (shape unchanged — { op, groups } — so every reader stays byte-identical:
    // buildQuery/conditionToHaving, the drawer, pills, describeScope, and the
    // graph's metricConditionKeys), while `advancedByDiscipline` archives the
    // other discipline's. createStore.set() swaps them on any discipline change
    // (see swapAdvancedForDiscipline). Identity filters (profile/teams) are NOT
    // here, so they persist across the toggle as the owner ruled (#15/decision 50)
    // — except "batting hand", which swapAdvancedForDiscipline clears on every
    // discipline change (decision 54, Round 6 #2).
    advanced: emptyAdvancedBlock(),
    advancedByDiscipline: { batting: emptyAdvancedBlock(), bowling: emptyAdvancedBlock() },
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

  // Prune one condition block ({ op, groups }) against advancedAllowed.
  const pruneBlock = (block) =>
    (block.groups || [])
      .map((g) => ({
        ...g,
        // keep incomplete conditions (blank metric) — they're inert edit rows
        conds: g.conds.filter((c) => !c.metricKey || advancedAllowed.has(c.metricKey)),
      }))
      .filter((g) => g.conds.length > 0);

  const groups = pruneBlock(s.advanced);
  const condsChanged = JSON.stringify(groups) !== JSON.stringify(s.advanced.groups || []);

  // R5-A #7: also prune the ARCHIVED (inactive-discipline) condition blocks so a
  // now-ineligible condition (e.g. a phase metric after a format change) can't
  // resurface when the user switches back to that discipline. Same wide allow-set.
  const archive = s.advancedByDiscipline || { batting: emptyAdvancedBlock(), bowling: emptyAdvancedBlock() };
  const newArchive = { ...archive };
  let archiveChanged = false;
  for (const d of ["batting", "bowling"]) {
    const block = archive[d] || emptyAdvancedBlock();
    const prunedGroups = pruneBlock(block);
    if (JSON.stringify(prunedGroups) !== JSON.stringify(block.groups || [])) {
      newArchive[d] = { ...block, groups: prunedGroups };
      archiveChanged = true;
    }
  }

  if (!colsChanged && !matchupChanged && !condsChanged && !archiveChanged) return false;
  if (colsChanged) newMatchupColumns[s.discipline] = prunedCols;
  store.set({
    columns: colsChanged || matchupChanged ? newMatchupColumns : s.columns,
    advanced: condsChanged ? { ...s.advanced, groups } : s.advanced,
    ...(archiveChanged ? { advancedByDiscipline: newArchive } : {}),
  });
  return true;
}

/**
 * Delivery-window format gating (ball-grain rebuild, decision 67): the TEAM
 * Phase / Balls clocks are offered only under a SINGLE T20 or SINGLE 50-over
 * bucket; red ball and mixed formats allow Overs only. When the format selection
 * changes so a currently-set Phase/Balls team clause is no longer permitted, drop
 * that team clause (a phase window on red ball matches nothing — `phase IS NULL`
 * there — so it would silently empty the board). The PLAYER clock and the Overs
 * team clock apply in every format and are left untouched. This mirrors
 * pruneIneligibleState's "a filter you can't see must not keep narrowing" honesty.
 * A no-op unless a now-illegal team clause is set (so flag-OFF — where
 * state.deliveryWindow is always null — it never fires). Returns true if it wrote.
 */
export function pruneDeliveryWindowForFormats(store) {
  const s = store.get();
  const w = s.deliveryWindow;
  if (!w) return false;
  const fmts = s.formats || [];
  const phaseBallsAllowed = fmts.length === 1 && (fmts[0] === "T20" || fmts[0] === "50 Over");
  if (phaseBallsAllowed) return false;
  // UI-A REWORK: the window is FOUR independent pieces; drop the now-illegal Phase
  // and/or Ball-range pieces (a phase window on red ball matches nothing — phase IS
  // NULL there), keeping the Over-range and Player-balls pieces untouched. A no-op
  // unless a Phase/Ball-range piece is actually set.
  const hasPhase = Array.isArray(w.phase) && w.phase.length > 0;
  if (!hasPhase && !w.balls) return false;
  const next = withDeliveryWindowPiece(withDeliveryWindowPiece(w, "phase", null), "balls", null);
  store.set({ deliveryWindow: next });
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

/**
 * R5-A #7 (decision 50): per-discipline numeric stat conditions. `state.advanced`
 * always mirrors the CURRENT discipline's conditions; `state.advancedByDiscipline`
 * archives BOTH. On a discipline change (from ANY caller — the leaderboard AND the
 * graph each mount their own discipline <select>, and both go through store.set),
 * stash the outgoing discipline's conditions and restore the incoming one's. This
 * keeps `state.advanced`'s shape ({ op, groups }) unchanged, so every reader
 * (buildQuery/conditionToHaving, drawer, pills, describeScope, graph
 * metricConditionKeys) works untouched — a bowling condition simply isn't in
 * `state.advanced` while batting is active, so it can never leak into the batting
 * query, and switching back restores it. Identity filters (profile/teams) live
 * elsewhere in state, so they persist across the toggle (owner ruling) — WITH
 * ONE CARVE-OUT (decision 54, Round 6 #2): "batting hand" does NOT persist. A
 * player's batting hand isn't their bowling arm, so the owner ruled persisting
 * it into bowling "is more confusing than useful." Every other identity filter
 * (role, bowling style, teams) is untouched and still persists.
 */
function swapAdvancedForDiscipline(prev, next) {
  if (!prev || prev.discipline === next.discipline) return next;
  const archive = { ...(next.advancedByDiscipline || {}) };
  archive[prev.discipline] = prev.advanced || emptyAdvancedBlock();
  const restored = archive[next.discipline] || emptyAdvancedBlock();
  // decision 54: clear ONLY profile.battingHand on a discipline change (either
  // direction) — no other profile field is touched. buildScopeClauses/
  // profileSemiJoinSql are untouched; this just means battingHand is never SET
  // while the bowling discipline is active, so it can't leak into a bowling query.
  const profile =
    next.profile && next.profile.battingHand ? { ...next.profile, battingHand: null } : next.profile;
  return { ...next, advanced: restored, advancedByDiscipline: archive, profile };
}

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    const prev = state;
    const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
    // A caller that explicitly manages the archive (a full reset / clearAll passes
    // advancedByDiscipline in the patch) is honoured verbatim — otherwise a
    // discipline change triggers the per-discipline condition swap.
    const managesArchive =
      patch && typeof patch !== "function" && Object.prototype.hasOwnProperty.call(patch, "advancedByDiscipline");
    state = managesArchive ? next : swapAdvancedForDiscipline(prev, next);
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

    // Delivery window (ball-grain rebuild, decision 67; UI-A REWORK): the "which
    // balls" scope — ONE token per active window piece, labelled from the ONE source
    // (deliveryWindowTokens) so the four pills and this scope sentence always agree.
    // Only ever set when the ball engine is active (the drawer controls render only
    // then), so no extra flag gate is needed.
    for (const tok of deliveryWindowTokens(s.deliveryWindow, effectiveNamespace(s))) {
      parts.push(tok.label);
    }

    // Opponent-player head-to-head (pop-up Tab-2 T-1, decision 70): the "vs whom"
    // scope — one token, matching its pill. Only ever set on the ball engine.
    if (opponentPlayerActive(s)) {
      parts.push(`vs ${s.opponentPlayer.name || s.opponentPlayer.id}`);
    }

    if (s.teams && s.teams.length > 0) {
      // "Current team" mode (owner decision 46) — mirrors the pill's "Team: …".
      parts.push(s.teams.length <= 3 ? `Team: ${s.teams.join(", ")}` : `Team: ${s.teams.length} teams`);
    }

    // Free splits (D4 Piece 3) — only tokens for filters actually applied:
    // positions apply in batting only; opposition applies in any team-type
    // scope since decision 51 (R5-F #14).
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

    // Match-context filters (Wave 6): honest tokens, only when actually applied.
    // Values map to their human labels; multi-selects join with commas (they are
    // OR within a filter). These narrow the leaderboard query (buildQuery /
    // buildMatchupQuery) AND the Graph Builder (FIX 4 wired the context join +
    // clauses into graph/charts.js's fetch).
    const labelsFor = (vals, opts) =>
      (vals || []).map((v) => opts.find((o) => o.value === v)?.label || v);
    // Result: list only the narrowing outcomes (the "All" sentinel is never a
    // narrowing token — resultFilterActive already gates on a non-All value).
    if (resultFilterActive(s)) {
      const outcomes = (s.result || []).filter((v) => v !== RESULT_ALL);
      parts.push(`Result: ${labelsFor(outcomes, RESULT_OPTIONS).join(", ")}`);
    }
    if (tossResultFilterActive(s)) parts.push(labelsFor(s.tossResult, TOSS_RESULT_OPTIONS).join(", "));
    if (tossDecisionFilterActive(s)) parts.push(labelsFor(s.tossDecision, TOSS_DECISION_OPTIONS).join(", "));
    // Innings Number (Wave R2c): the 1-based innings the player batted/bowled in.
    if (inningsNumberFilterActive(s)) {
      const sorted = [...s.inningsNumber].sort((a, b) => a - b);
      parts.push(`Innings: ${sorted.map(inningsNumberLabel).join(", ")}`);
    }
    // Stage: list only the narrowing picks — drop the "All" sentinel and read the
    // "No Stage" sentinel out as its label (item 3).
    if (stageFilterActive(s)) {
      const picks = (s.stage || [])
        .filter((v) => v !== STAGE_ALL)
        .map((v) => (v === STAGE_NONE ? STAGE_NONE_LABEL : v));
      parts.push(picks.length <= 3 ? `Stage: ${picks.join(", ")}` : `Stage: ${picks.length} stages`);
    }
    // Result Condition (FIX B, renamed item 4): the nested how-the-result-came-
    // about sub-filter; list only the narrowing options (drop the "All" sentinel),
    // collapse to a count beyond two.
    if (resultConditionFilterActive(s)) {
      const specifics = (s.resultCondition || []).filter((v) => v !== RESULT_CONDITION_ALL);
      parts.push(
        specifics.length <= 2
          ? `Result condition: ${labelsFor(specifics, RESULT_CONDITION_OPTIONS).join(", ")}`
          : `Result condition: ${specifics.length} conditions`
      );
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
