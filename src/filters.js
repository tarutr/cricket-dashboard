// src/filters.js
//
// The scope strip (owner decision 29: one slim filter bar + one "All filters"
// drawer, replacing the old three-row layout). This module keeps ONLY the
// filters common to every query — Gender, Format, Date range, Team type —
// plus the button that opens the drawer (src/drawer.js) holding everything
// else: Team, Min innings, Player profile, Innings (position/opposition),
// and Stat conditions (src/advanced.js).
//
// This module only renders/wires the DOM and calls store.set(...); it never
// queries the database directly — src/table.js owns re-querying on state
// change, and src/drawer.js owns the team/opposition option-list lookups.

import {
  FORMAT_BUCKETS,
  expandFormats,
  emptyProfile,
  profileSemiJoinSql,
  oppositionFilterActive,
  positionsFilterActive,
  eventFilterActive,
  anyEventSeasonNarrowing,
  venueFilterActive,
  cityFilterActive,
  seasonFilterActive,
  RESULT_ALL,
  RESULT_CONDITION_ALL,
  RESULT_CONDITION_NORMAL,
  RESULT_CONDITION_SUPER_OVER,
  resultConditionMethod,
  STAGE_ALL,
  STAGE_NONE,
  inningsNumberFilterActive,
  escSql as esc,
} from "./state.js";
import { INNINGS_NUMBER_FILTER } from "./metrics.js";
import { eventAliases, stageAliases } from "./canonicalNames.js";

// ── Day-level date helpers (Batch 1B, task 1B-2) ─────────────────────────────
// Native <input type="date"> yields "YYYY-MM-DD" (which buildScopeClauses
// accepts); presets compute off the DATA's max match date (via setDateBounds),
// not the wall clock — all UTC arithmetic (no DST drift), like state.js/monthsAgo.
// The team columns of the batting/bowling INNINGS-GRAIN views (plain + matchup +
// graph). Only these views carry a per-innings `innings_number` column, so the
// Innings Number predicate (buildScopeClausesTagged) is emitted only when a caller's
// own team column is one of these — never for the pom_cte (team) or fielding_cte
// (fielding_team) queries, whose sources have no such column.
const INNINGS_GRAIN_TEAM_COLS = new Set(["batting_team", "bowling_team"]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/** Coerce a stored date into a valid <input type="date"> value ("" if unset;
 * a legacy month-shaped "YYYY-MM" pads to the 1st so it still displays). */
function toInputValue(v) {
  if (!v) return "";
  if (DAY_RE.test(v)) return v;
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;
  return "";
}
/** N months before "YYYY-MM-DD", day-of-month clamped to the target month. */
function subMonths(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 - n, 1));
  const ty = t.getUTCFullYear();
  const tm = t.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return ymd(ty, tm, Math.min(d, lastDay));
}
/** Clamp "YYYY-MM-DD" into [lo, hi] (either bound may be null). */
function clampDate(dateStr, lo, hi) {
  let s = dateStr;
  if (lo && s < lo) s = lo;
  if (hi && s > hi) s = hi;
  return s;
}

// ── Day-level dates (Batch 1B, task 1B-1) ───────────────────────────────────
// dateFrom/dateTo now accept EITHER the original "YYYY-MM" (month granularity)
// or a new "YYYY-MM-DD" (day granularity). isDayDate distinguishes the two by
// shape alone (both are produced by trusted internal code — the date pickers
// — never typed freely by a user into SQL, but esc() still runs on every
// interpolated value below as defense in depth, matching every other clause
// in this file). nextCalendarDay computes an exclusive upper bound one day
// past a given "YYYY-MM-DD", the day-granularity analogue of the month branch's
// existing "first day of the following month" trick — done via UTC Date
// arithmetic (never local time) so it can never drift a day from DST, mirroring
// state.js's monthsAgo helper.
const DAY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDayDate(value) {
  return DAY_DATE_RE.test(value);
}

function nextCalendarDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(dt.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

/** The four filters that make up EVERY query's inescapable "core scope" —
 * gender / format / date window / team type — factored out of
 * buildScopeClauses (owner decision 46, task 3) so callers that need "the scope
 * dims alone" (e.g. dimOptions / dataAvailability probes) can compute it
 * without duplicating this logic. buildScopeClauses below ALWAYS starts its
 * clause list with exactly this function's output (same options, same order).
 *
 * NOTE: this is NO LONGER the pinned-player boundary. Pins used to bypass
 * "everything after the core scope", by POSITION — see the clause-tagging block
 * further down (buildScopeClausesTagged / whereWithPinExemption) for the explicit
 * bypass set that replaced it. */
export function buildCoreScopeClauses(state, { includeGender = true } = {}) {
  const clauses = [];
  // Player-page queries (R2) filter by a specific player_id, so gender is
  // redundant there — every other caller keeps the gender clause.
  if (includeGender) clauses.push(`gender = '${esc(state.gender)}'`);

  const matchTypes = expandFormats(state.formats);
  if (matchTypes.length === 0) {
    clauses.push("FALSE"); // no format selected -> no rows, never "all"
  } else {
    clauses.push(`match_type IN (${matchTypes.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  // Day-level dates (Batch 1B): a "YYYY-MM-DD" dateFrom/dateTo takes a new
  // branch each; the ORIGINAL "YYYY-MM" branch below is untouched byte-for-byte,
  // so with no dates set, or dates in the original month format, this emits the
  // exact same clauses as before (baselines 2,813/2,049 unaffected).
  if (state.dateFrom) {
    if (isDayDate(state.dateFrom)) {
      // Day-level lower bound: the day itself, used directly (inclusive).
      clauses.push(`match_date >= DATE '${esc(state.dateFrom)}'`);
    } else {
      clauses.push(`match_date >= DATE '${esc(state.dateFrom)}-01'`);
    }
  }
  if (state.dateTo) {
    if (isDayDate(state.dateTo)) {
      // Day-level upper bound: inclusive of the whole day, via the FOLLOWING
      // calendar day as an exclusive bound — same trick as the month branch,
      // one granularity level down.
      clauses.push(`match_date < DATE '${esc(nextCalendarDay(state.dateTo))}'`);
    } else {
      // Inclusive of the whole "to" month: use the first day of the FOLLOWING month.
      const [y, m] = state.dateTo.split("-").map(Number);
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      clauses.push(`match_date < DATE '${nextY}-${String(nextM).padStart(2, "0")}-01'`);
    }
  }

  if (state.teamType === "international") clauses.push(`team_type = 'international'`);
  else if (state.teamType === "club") clauses.push(`team_type = 'club'`);
  // "both" -> no predicate
  return clauses;
}

// ── Shared `matches`-row predicate fragments (cascading option lists) ─────────
// Five WHERE fragments over columns that live on `matches` — event_name/season,
// venue, event_stage, method/is_super_over, toss_decision. Each is defined ONCE
// here and consumed by BOTH:
//   • the number-critical query path — buildScopeClauses' event/venue semi-joins
//     and buildMatchContextClauses' Stage / Result Condition / Toss-decision
//     clauses (where every one of these semantics was born), and
//   • the drawer's OPTION-LIST loaders (playerData.js matchOptionScope), where a
//     picked filter must narrow every OTHER picker's option vocabulary.
// Sharing is the whole point: an option list that re-implemented "Normal = no
// method AND not a super over" could drift from what the query actually counts,
// and the picker would then offer choices that return nothing (or hide choices
// that do return rows). Each function returns a SQL string, or null when the
// selection narrows nothing (empty, or sentinel-only).
//
// `alias` qualifies the column reference: the live query reads these columns off
// the LEFT-JOINed sub-select aliased `mctx`, while an option list scans `matches`
// itself and wants a bare column name. Default "" = bare; the live-query callers
// pass "mctx" explicitly.

/** `alias.col`, or a bare `col` when there is no alias. */
function matchCol(alias, col) {
  return alias ? `${alias}.${col}` : col;
}

/** OR-join disjuncts the way every match-context clause does: one part stands
 * alone, several are parenthesised. Returns null for an empty list. */
function orJoin(parts) {
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`;
}

/** The Event predicate, INCLUDING each event's per-season narrowing (state.event
 * + state.eventSeasons). Emitted against `matches` columns (event_name/season),
 * so it is used both inside buildScopeClauses' match_id semi-join and by the
 * option loaders that scan `matches` directly. Two shapes, exactly as before:
 * with no event narrowed to specific seasons, ONE deduped alias IN-list; with any
 * narrowing, a per-event OR of `(event_name IN (aliases) AND season IN (…))` /
 * `event_name IN (aliases)`. state.event holds CANONICAL labels (name
 * normalization, backlog #5) — each expands to its raw alias set. */
export function eventPredicateSql(state) {
  if (!eventFilterActive(state)) return null;
  if (!anyEventSeasonNarrowing(state)) {
    const aliases = [...new Set(state.event.flatMap((e) => eventAliases(e)))];
    return `event_name IN (${aliases.map((a) => `'${esc(a)}'`).join(", ")})`;
  }
  const es = state.eventSeasons || {};
  const terms = state.event.map((e) => {
    const aliasIn = eventAliases(e).map((a) => `'${esc(a)}'`).join(", ");
    const seasons = Array.isArray(es[e]) ? es[e] : [];
    if (seasons.length > 0) {
      return `(event_name IN (${aliasIn}) AND season IN (${seasons.map((sn) => `'${esc(sn)}'`).join(", ")}))`;
    }
    return `event_name IN (${aliasIn})`;
  });
  return `(${terms.join(" OR ")})`;
}

/** The Venue predicate (`venue IN (…)`) — raw venue strings, as stored. */
export function venuePredicateSql(state) {
  if (!venueFilterActive(state)) return null;
  return `venue IN (${state.venue.map((v) => `'${esc(v)}'`).join(", ")})`;
}

/** The City predicate (`city IN (…)`) — raw city strings, as stored. Venue-shape
 * (no canonical fold anywhere; `matches.city` is a plain optional VARCHAR). Rows
 * with a NULL city are excluded by the IN-list, exactly like Venue. */
export function cityPredicateSql(state) {
  if (!cityFilterActive(state)) return null;
  return `city IN (${state.city.map((v) => `'${esc(v)}'`).join(", ")})`;
}

/** The Season predicate (`season IN (…)`) — raw season strings, as stored
 * ("YYYY" | "YYYY/YY"). Venue-shape (no fold). This is a STANDALONE top-level
 * season filter, independent of the Event → per-event Season narrowing
 * (state.eventSeasons) — the two ARE ANDed if both are set, exactly like any two
 * match-level filters. */
export function seasonPredicateSql(state) {
  if (!seasonFilterActive(state)) return null;
  return `season IN (${state.season.map((v) => `'${esc(v)}'`).join(", ")})`;
}

/** The Stage predicate. `stages` is state.stage: CANONICAL labels expanded to
 * their raw `event_stage` spellings, plus two sentinels — STAGE_ALL contributes
 * nothing (no narrowing) and STAGE_NONE is `event_stage IS NULL` (a league
 * fixture with no round name). Named stages and the No-Stage disjunct OR
 * together. */
export function stagePredicateSql(stages, alias = "") {
  const st = stages || [];
  if (st.length === 0) return null;
  const named = st.filter((s) => s !== STAGE_ALL && s !== STAGE_NONE);
  const parts = [];
  if (named.length) {
    const stageRaws = [...new Set(named.flatMap((s) => stageAliases(s)))];
    parts.push(`${matchCol(alias, "event_stage")} IN (${stageRaws.map((s) => `'${esc(s)}'`).join(", ")})`);
  }
  if (st.includes(STAGE_NONE)) parts.push(`${matchCol(alias, "event_stage")} IS NULL`);
  return orJoin(parts);
}

/** The Result Condition predicate. `conditions` is state.resultCondition:
 * RESULT_CONDITION_ALL contributes nothing; specific methods collect into ONE
 * `method IN (…)`; "Normal" is `method IS NULL AND NOT COALESCE(is_super_over,
 * false)`; "Super Over" is that same COALESCE'd flag. The COALESCE is REQUIRED,
 * not cosmetic — is_super_over is NULL (not false) for every ordinary win, so a
 * bare negation would silently drop them. The three groups are facets, not a
 * partition, so they OR together. */
export function resultConditionPredicateSql(conditions, alias = "") {
  const tokens = conditions || [];
  if (tokens.length === 0) return null;
  const superOverSql = `COALESCE(${matchCol(alias, "is_super_over")}, false)`;
  const reals = [];
  let wantsNormal = false;
  let wantsSuperOver = false;
  for (const t of tokens) {
    if (t === RESULT_CONDITION_ALL) continue;
    else if (t === RESULT_CONDITION_NORMAL) wantsNormal = true;
    else if (t === RESULT_CONDITION_SUPER_OVER) wantsSuperOver = true;
    else {
      const mth = resultConditionMethod(t);
      if (mth) reals.push(mth);
    }
  }
  const parts = [];
  if (reals.length) parts.push(`${matchCol(alias, "method")} IN (${reals.map((m) => `'${esc(m)}'`).join(", ")})`);
  if (wantsNormal) parts.push(`(${matchCol(alias, "method")} IS NULL AND NOT ${superOverSql})`);
  if (wantsSuperOver) parts.push(superOverSql);
  return orJoin(parts);
}

/** The Toss-decision predicate (`toss_decision IN (…)`). Anything other than the
 * two known tokens is dropped, so only fixed literals ever reach the SQL. */
export function tossDecisionPredicateSql(tossDecision, alias = "") {
  const td = (tossDecision || []).filter((v) => v === "bat" || v === "field");
  if (td.length === 0) return null;
  return `${matchCol(alias, "toss_decision")} IN (${td.map((v) => `'${v}'`).join(", ")})`;
}

// ── Clause tagging: which clauses a PINNED player is allowed to bypass ───────
// THE PRINCIPLE (owner's words): **a pin changes WHO is listed, never WHAT their
// numbers mean.** So the test for every clause is simply: does it describe the
// PLAYER, or does it describe the MATCHES / BALLS being measured?
//   • Describes the PLAYER ("who counts as a candidate") → pin-bypassable. The
//     pin is the user overriding the shortlist; the player is added in spite of
//     not qualifying, and their numbers are unaffected either way.
//   • Describes the MATCHES or the BALLS ("which innings/deliveries am I
//     measuring") → ALWAYS applies. Bypassing one of these would make the pinned
//     row answer a DIFFERENT QUESTION from every other row in the same table —
//     which is not a comparison, it is a mislabelled number.
//
// Every clause the scope builder emits is a `{ sql, bypassable }` record, and
// **the default is `bypassable: false`**. Exactly four things opt in, by being
// wrapped in bypassableClause() (or, for the last one, its own gate helper):
//
//     1. team              — "plays for India"        (player attribute)
//     2. player profile    — role / hand / bowl style (player attribute)
//     3. the name search   — a shortlisting device, not a measurement
//     4. the numeric stat conditions — the separate post-aggregation gate,
//        gateWithPinExemption (a threshold on the player's own numbers)
//
// Everything else ALWAYS applies to a pin: the core scope (gender / format /
// date window / team type), OPPOSITION ("innings against Australia" selects
// matches), the matchup STRIKER POSITION (`state.positions` selects balls),
// event (+ its per-event season narrowing), venue, and the whole Wave-6
// match-context family (result, result condition, stage, toss result, toss
// decision).
//
// WHY THIS EXISTS (the defect it fixes): whereWithPinExemption used to split the
// clause list POSITIONALLY — `core AND (everything-after-core OR id IN pins)` via
// `fullClauses.slice(coreClauses.length)`. So every filter added to the builder
// after the pin exemption was written silently joined the bypass list just by
// being appended later — event, venue and all five match-context filters, none of
// which the owner ever ruled bypassable. The visible damage: a pinned SA Yadav
// under Result Condition = D/L reported his whole-scope 60 innings / 1,544 runs
// instead of the 2 / 82 in that filter, and a pinned fielder in an event+venue
// chart plotted his whole-scope 24 catches against everyone else's ≤2 — one chart
// mixing two different scopes. Opposition and striker position were the same
// defect class surviving the first fix: pinned SA Yadav under Opposition =
// Australia reported 60 / 1,544 (his career total) where the honest answer for
// that filter is 10 / 259.
//
// RULE FOR ANY FUTURE FILTER: push a bare string (or alwaysClause()) and it
// applies to pins too. Making a filter pin-bypassable now takes a deliberate
// bypassableClause() call, so it can never happen by accident again.

/** A clause a pinned player must still obey (the default for a bare string).
 * `category` (Chunk 5 Phase 2 Wave A) is an OPTIONAL additive lane tag —
 * "core" | "scope" — read ONLY by the new whereWithLanes compiler. It is
 * invisible to every existing consumer (buildScopeClauses joins only `.sql`,
 * whereWithPinExemption reads only `.sql`/`.bypassable`), so tagging a clause
 * changes NO emitted SQL — same idiom as the existing `bypassable` tag. Omitted
 * ⇒ no `category` key at all, so untagged records stay byte-identical objects. */
export function alwaysClause(sql, category) {
  return category ? { sql, bypassable: false, category } : { sql, bypassable: false };
}
/** A leaderboard-only clause a pinned player is exempt from. Deliberate opt-in.
 * `category` is the same optional additive lane tag as alwaysClause (SQL-unchanged). */
export function bypassableClause(sql, category) {
  return category ? { sql, bypassable: true, category } : { sql, bypassable: true };
}
/** Normalise a mixed list of bare strings / tagged records. A bare string is
 * ALWAYS-APPLIES — the safe default, so an untagged clause can never leak into
 * the bypass set. */
export function asTaggedClauses(clauses) {
  return (clauses || []).map((c) => (typeof c === "string" ? { sql: c, bypassable: false } : c));
}
/** Just the SQL, in the order the clauses were built. */
export function clauseSqlList(clauses) {
  return asTaggedClauses(clauses).map((c) => c.sql);
}

/** Shared WHERE-clause builder for gender/format/date/team_type/(team) — used by
 * both the drawer's team/opposition-options lookups and src/table.js's main
 * query. Exported so table.js, drawer.js, and graph builders all build an
 * identical scope.
 *
 * D4 Piece 3 opt-ins (both default OFF because some callers query views that
 * lack the columns, e.g. player_matches):
 *   oppositionColumn — the view's opposition column (bowling_team for batting,
 *     batting_team for bowling). Decision 51 (R5-F #14) reversed the old
 *     international-only gate (decision 20): the opposition filter now applies
 *     whenever state.opposition is non-empty, for club/domestic scope too, on
 *     the same raw team names the Team filter uses (see oppositionFilterActive
 *     in state.js).
 *   includePositions — apply the batting-position filter (batting innings
 *     views only; positions are a batting concept, inert in bowling).
 *
 * Event / Venue (Batch 1B, task 1B-1) are NOT opt-in like the two above — they
 * always apply when state.event/state.venue are non-empty, for every caller,
 * via a match_id semi-join against `matches` (no column-name parameter needed;
 * see the inline comment at the clause itself). */
export function buildScopeClauses(state, opts) {
  return clauseSqlList(buildScopeClausesTagged(state, opts));
}

/** buildScopeClauses' clause list WITH the pin-bypass tag on each entry (see the
 * clause-tagging block above). Same clauses, same order — buildScopeClauses is
 * literally this function's `sql` fields joined, so every existing caller and
 * every emitted query string is unchanged. table.js hands this straight to
 * whereWithPinExemption, which no longer needs to know the clause ORDER at all. */
export function buildScopeClausesTagged(
  state,
  { includeTeams = true, teamColumn, idColumn, oppositionColumn, includePositions = false, includeGender = true } = {}
) {
  // Bare strings are always-applies (see asTaggedClauses) — only the two
  // player-shortlisting filters below (team, profile) wrap themselves in
  // bypassableClause(). The other two bypassables live outside this function: the
  // name search (tagged at each table.js call site) and the numeric stat
  // conditions (gateWithPinExemption, post-aggregation).
  // Chunk 5 Phase 2 Wave A: each clause carries a lane `category` — "core" for the
  // always-inescapable gender/format/date/team-type scope, "scope" for the
  // optional narrowing filters (team/opposition/innings-number/positions/event/
  // venue/city/season). The profile semi-join stays UNTAGGED (it is player-lane,
  // Wave B). The tag is invisible to buildScopeClauses/whereWithPinExemption
  // (they read only sql/bypassable), so the emitted SQL is byte-identical — it
  // only lets whereWithLanes split the tree when the scope lane is "Match any".
  const clauses = buildCoreScopeClauses(state, { includeGender }).map((s) => alwaysClause(s, "core"));

  if (includeTeams && state.teams && state.teams.length > 0 && teamColumn) {
    clauses.push(bypassableClause(`${teamColumn} IN (${state.teams.map((t) => `'${esc(t)}'`).join(", ")})`, "scope"));
  }

  // Opposition is ALWAYS-APPLIES, pins included (untagged = alwaysClause).
  // "Innings against Australia" selects MATCHES, not players — it is the same
  // kind of question the core scope and Event/Venue ask, so a pinned player
  // measured over their whole career while every other row shows only their
  // innings against Australia is not a comparison. (Before this change a pinned
  // SA Yadav under Opposition = Australia read 60 inns / 1,544 runs — his career
  // total — instead of the 10 / 259 he actually made against them.)
  if (oppositionColumn && oppositionFilterActive(state)) {
    clauses.push(alwaysClause(`${oppositionColumn} IN (${state.opposition.map((t) => `'${esc(t)}'`).join(", ")})`, "scope"));
  }

  // Innings Number (filter-rejig Wave R2c): narrow to the innings the player
  // batted / bowled in. `innings_number` is a column on the batting/bowling
  // innings views (0-BASED: display "1st innings" = stored 0 — INNINGS_NUMBER_FILTER
  // owns that mapping), so this is a direct WHERE predicate, NOT a match-context
  // join like Result / Toss decision. It is discipline-aware by construction (on the batting
  // view it is the innings the batter batted in; on the bowling view the innings the
  // bowler bowled in). EMITTED ONLY for the innings-grain callers — those whose own
  // team column is `batting_team`/`bowling_team` (plain buildQuery, buildMatchupQuery
  // and the graph fetch, all four of whose views carry innings_number). The pom_cte
  // (player_matches, teamColumn "team") and fielding_cte (fielding, "fielding_team")
  // have no innings_number column, so keying off the team column keeps the clause off
  // those queries. ALWAYS-APPLIES
  // (it selects WHICH innings are measured, like opposition), so a
  // pinned player obeys it. Empty selection ⇒ no clause ⇒ byte-identical.
  if (INNINGS_GRAIN_TEAM_COLS.has(teamColumn) && inningsNumberFilterActive(state)) {
    const stored = [...new Set(state.inningsNumber.map((n) => INNINGS_NUMBER_FILTER.toStored(n)))].filter(
      (n) => Number.isInteger(n) && n >= 0
    );
    if (stored.length > 0) {
      clauses.push(alwaysClause(`${INNINGS_NUMBER_FILTER.column} IN (${stored.join(", ")})`, "scope"));
    }
  }

  // Event / Venue (Batch 1B, task 1B-1): additive match-level filters via a
  // semi-join to `matches`, gender-scoped (not the caller's other scope dims —
  // `matches` is queried standalone here, so its own gender predicate is
  // spelled out fresh rather than reusing buildCoreScopeClauses). A plain,
  // NON-correlated IN-subquery: it only requires the CALLER's own FROM table to
  // carry a `match_id` column, which batting_innings, bowling_innings,
  // matchup_batting, and matchup_bowling — every view this function is ever
  // called against — all do (verified against the live schema). No column-name
  // option is needed (unlike teamColumn/oppositionColumn) because event_name
  // and venue live on ONE table (`matches`) regardless of caller. Both are OFF
  // by default (state.event / state.venue start as [] — see state.js), so this
  // is a no-op addition until a picker UI (1B-2) sets either array.
  // The event/season and venue predicates themselves come from the SHARED
  // fragment builders above (eventPredicateSql / venuePredicateSql) — the same
  // ones the drawer's option-list loaders use for cross-filtering, so the
  // vocabulary a picker offers can never drift from what the query counts. The
  // emitted SQL is unchanged: eventPredicateSql returns either ONE deduped
  // alias IN-list (no event narrowed to specific seasons) or the parenthesised
  // per-event OR of `(event_name IN (aliases) AND season IN (…))` terms, exactly
  // as this block spelled out inline before.
  //
  // Event and Venue are ALWAYS-APPLIES, pins included (untagged = alwaysClause):
  // "which matches am I looking at" is the same question the core scope asks, so a
  // pinned player measured over a DIFFERENT set of matches than every other row is
  // not a comparison. They only ever bypassed these because the old positional
  // split swept up whatever was appended after the core scope.
  if (eventFilterActive(state)) {
    const g = esc(state.gender);
    clauses.push(
      alwaysClause(`match_id IN (SELECT match_id FROM matches WHERE gender = '${g}' AND ${eventPredicateSql(state)})`, "scope")
    );
  }
  if (venueFilterActive(state)) {
    clauses.push(
      alwaysClause(
        `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND ${venuePredicateSql(state)})`,
        "scope"
      )
    );
  }
  // City / Season (City & Season everywhere, 2026-08-16): additive match-level
  // filters via the SAME `match_id IN (SELECT … FROM matches …)` semi-join Event /
  // Venue use — city and season live on `matches`, gender-scoped standalone here.
  // ALWAYS-APPLIES, pins included (untagged = alwaysClause): "which matches am I
  // looking at" is the same question the core scope asks. Predicates come from the
  // SHARED cityPredicateSql / seasonPredicateSql fragments (also used by the
  // option-list loaders' cross-filter), so the offered vocabulary can never drift
  // from what the query counts. Both OFF by default (state.city / state.season
  // start as [] — see state.js), so this is a no-op until a picker sets either.
  if (cityFilterActive(state)) {
    clauses.push(
      alwaysClause(
        `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND ${cityPredicateSql(state)})`,
        "scope"
      )
    );
  }
  if (seasonFilterActive(state)) {
    clauses.push(
      alwaysClause(
        `match_id IN (SELECT match_id FROM matches WHERE gender = '${esc(state.gender)}' AND ${seasonPredicateSql(state)})`,
        "scope"
      )
    );
  }

  // The "Batting position" filter (`state.positions`) is ALWAYS-APPLIES, pins
  // included (untagged = alwaysClause). It selects BALLS/innings by
  // batting_position: in plain batting / matchup_batting the batter's own
  // position, in matchup_bowling the position of the striker faced. Live in
  // plain batting AND any matchup (position rework 2026-08-14 —
  // positionsFilterActive), inert in plain bowling (no such column).
  // "Bumrah vs right-handers at positions 1–2" is a description of the
  // deliveries being counted, so a pinned Bumrah must be counted over the same
  // deliveries as everyone else or his row means something different.
  if (includePositions && positionsFilterActive(state)) {
    // Positions are user-picked ints; coerce + drop anything non-integral so
    // nothing unsanitized reaches the SQL.
    const nums = state.positions.map(Number).filter(Number.isInteger);
    if (nums.length > 0) clauses.push(alwaysClause(`batting_position IN (${nums.join(", ")})`, "scope"));
  }

  // Profile-powered filters (D4.2): semi-join to matched player_ids. Only added
  // when an idColumn is supplied by the caller (the player_matches/innings views
  // and matchup views all have a join key; some scoped lookups don't) and a
  // profile filter is active. profileSemiJoinSql itself no-ops for women.
  // Chunk 5 Phase 2 Wave B: tag it lane "player" — it is the ONLY player-lane
  // member that lives in the WHERE (the PotM / numeric conditions are HAVING). The
  // tag is SQL-invisible (buildScopeClauses joins only `.sql`, whereWithPinExemption
  // reads only `.sql`/`.bypassable`), so the emitted SQL stays byte-identical — it
  // only lets whereWithLanes DROP the profile clause from the WHERE when the player
  // lane is "Match any" (the table.js caller then re-emits it as a HAVING disjunct;
  // profile membership depends only on the GROUP-BY key so it is a legal
  // post-aggregation predicate, and it is all-or-nothing per player so lowering it
  // changes no surviving player's aggregates). It stays bypassable (pins bypass the
  // profile filter exactly as before).
  if (idColumn) {
    const profileClause = profileSemiJoinSql(state, idColumn);
    if (profileClause) clauses.push(bypassableClause(profileClause, "player"));
  }

  return clauses;
}

// ── Match-context filters (Wave 6) ──────────────────────────────────────────
// Five categorical WHERE filters keyed off the MATCH's context. Unlike Event /
// Venue (a non-correlated `match_id IN (SELECT … FROM matches …)` semi-join),
// several of these are PLAYER-RELATIVE — "did the row's own team win / win the
// toss / bat first" — so they compare the innings row's own team column
// (`batting_team` for a batting row, `bowling_team` for a bowling row; matchup
// rows carry both) to the joined match fields. The owner-approved approach is a
// LEFT JOIN of `matches` by match_id; buildQuery / buildMatchupQuery add that
// join (matchContextJoinSql) and append these clauses ONLY when a context filter
// is active, so with none active the query is byte-identical to before.
//
// The join is a SUB-SELECT aliased `mctx` that RENAMES match_id -> mctx_match_id
// (the same collision-safe-join-key technique fielding_cte / pom_cte
// use), so every bare `match_id` reference already in the query — the event/venue
// semi-join, COUNT(DISTINCT match_id), the matchup peak CTE's GROUP BY — stays
// unambiguous after the join. None of the mctx columns (match_winner /
// result_type / is_super_over / toss_winner / toss_decision / team_batting_first
// / event_stage / method) shares a name with any base-view column, so no other
// ambiguity is introduced.

/** The `matches` sub-select (aliased `mctx`) carrying the match-context columns —
 * shared by BOTH matchContextJoinSql (the leaderboard's LEFT JOIN) and the fielding
 * mode's correlated EXISTS (playerFiltersTab.js, via table.js), so the projected
 * column set can never drift between the two. match_id is projected as
 * `mctx_match_id` to avoid clashing with a base view's own `match_id`. */
export function matchContextSubselectSql() {
  // Step 4 (2026-08-14): event_name + venue are projected here too so the standalone
  // EVENT / VENUE composers (metrics.js event__/venue__) can aggregate over
  // `mctx.event_name` / `mctx.venue` off this SAME 1:1 LEFT JOIN — no redundant
  // second per-player `matches` join. ADDITIVE projection: every existing consumer
  // (the leaderboard's match-context clauses, the fielding-mode EXISTS) references
  // specific columns, never `*`, so the two extra columns change nothing they read;
  // and NO base view (batting / bowling / matchup_*) carries an `event_name` or
  // `venue` column (verified via DESCRIBE), so the join stays unambiguous. The join
  // is 1:1 on match_id, so no aggregate moves — anchors byte-identical.
  // City & Season everywhere (2026-08-16): city + season are projected here too so the
  // standalone CITY / SEASON composers (metrics.js city__/season__) and the City/Season
  // which-values columns can aggregate over `mctx.city` / `mctx.season` off this SAME
  // 1:1 LEFT JOIN — no redundant second matches join, mirroring the Step-4
  // event_name/venue projection. ADDITIVE (every consumer names specific columns; no
  // base view carries city/season — verified in reference/db_reference.md), 1:1 on
  // match_id → anchors byte-identical. (Season sorts chronologically off the raw string:
  // every season starts with its 4-digit start year, so no season_year_start needed.)
  return (
    `(SELECT match_id AS mctx_match_id, match_winner, result_type, ` +
    `is_super_over, toss_winner, toss_decision, team_batting_first, event_stage, method, ` +
    `event_name, venue, city, season ` +
    `FROM matches) mctx`
  );
}

/** LEFT-JOIN clause bringing the match-context columns onto each innings row of
 * `viewAlias` (the base view/table name — `batting`, `bowling`, `matchup_batting`,
 * `matchup_bowling`). match_id is projected as `mctx_match_id` to avoid clashing
 * with the base view's own `match_id`. The sub-select is the SHARED
 * matchContextSubselectSql (emitted SQL is byte-identical to the previous inline
 * form). */
export function matchContextJoinSql(viewAlias) {
  return ` LEFT JOIN ${matchContextSubselectSql()} ON mctx.mctx_match_id = ${viewAlias}.match_id`;
}

/** WHERE-clause fragments for the active match-context filters, comparing the
 * row's own team column (`rowTeamCol` = batting_team | bowling_team) to the
 * joined `mctx` fields. Each active filter contributes ONE clause; multi-selects
 * are OR within their own clause (the filters AND together, and AND with the
 * rest of the scope). Returns [] when nothing is active. */
export function buildMatchContextClauses(state, rowTeamCol) {
  const A = "mctx";
  const clauses = [];

  // 1. Result (multi, OR) — the OUTCOME only. Won/Lost use the derived
  //    match_winner, which already resolves a super-over winner, so a super-over
  //    win counts as a Win and a super-over loss as a Loss. That is exactly why
  //    "Super Over" is NOT an outcome here anymore (Wave 6 polish item 4): it is a
  //    FACET of how the result came about, so it lives in the Result Condition
  //    sub-filter (block 5b) instead. The leading "All" token (RESULT_ALL, FIX A)
  //    is the no-narrowing sentinel — it contributes no disjunct, so Result = All
  //    emits nothing (byte-identical).
  const res = state.result || [];
  if (res.length) {
    const parts = [];
    for (const r of res) {
      if (r === RESULT_ALL) continue;
      else if (r === "won") parts.push(`${rowTeamCol} = ${A}.match_winner`);
      else if (r === "lost") parts.push(`(${A}.match_winner IS NOT NULL AND ${A}.match_winner <> ${rowTeamCol})`);
      else if (r === "drawn") parts.push(`${A}.result_type = 'draw'`);
      else if (r === "no_result") parts.push(`${A}.result_type = 'no result'`);
      else if (r === "tied") parts.push(`${A}.result_type = 'tie'`);
    }
    if (parts.length) clauses.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }

  // 2. Toss result (row team ==/<> toss_winner). A NULL toss_winner (none in the
  //    data) would drop the row either way — honest (unknown -> excluded).
  const tr = state.tossResult || [];
  if (tr.length) {
    const parts = [];
    if (tr.includes("won")) parts.push(`${rowTeamCol} = ${A}.toss_winner`);
    if (tr.includes("lost")) parts.push(`${rowTeamCol} <> ${A}.toss_winner`);
    if (parts.length) clauses.push(parts.length === 1 ? parts[0] : `(${parts.join(" OR ")})`);
  }

  // 3. Toss decision (matches.toss_decision IN …) — shared fragment builder.
  const tossDecisionSql = tossDecisionPredicateSql(state.tossDecision, A);
  if (tossDecisionSql) clauses.push(tossDecisionSql);

  // (Innings order — row team ==/<> team_batting_first — was removed with
  // mc_innings_order; its replacement, Innings Number, is a scope filter
  // handled by buildScopeClauses instead. waveR2-cleanup.)

  // 5a. Stage. state.stage holds CANONICAL stage labels (name normalization,
  //     backlog #5) — expand each to its raw event_stage spelling set so
  //     picking "Semi-Final" matches "Semi Final" / "Semi-Final" / "Semi-final"
  //     alike. An identity (unlisted) stage expands to just itself. Dedup for a
  //     tidy IN-list. Empty selection contributes nothing (byte-identical).
  //
  //     Wave 6 polish item 3 adds two sentinels, mirroring Result's:
  //       • STAGE_ALL ("All") narrows nothing — no disjunct, so "Stage condition
  //         added and left on All" emits NOTHING and stays byte-identical.
  //       • STAGE_NONE ("No Stage") is `event_stage IS NULL` — the 20,689 matches
  //         with no round name (a league fixture). It is a real choice, not an
  //         absence of one, so it gets its own disjunct and OR's with any named
  //         stages picked alongside it.
  //
  //     The predicate itself comes from the SHARED stagePredicateSql fragment
  //     (see above) — the same builder the drawer's option lists cross-filter
  //     with, so a stage the picker offers is always a stage the query can find.
  const stageSql = stagePredicateSql(state.stage, A);
  if (stageSql) clauses.push(stageSql);

  // 5b. Result Condition (FIX B; renamed from "Result Type", Wave 6 polish item
  //     4): the nested "how did this result come about" sub-filter under Result.
  //     Tokens map to `matches.method` plus the super-over facet flag:
  //       • "All" (RESULT_CONDITION_ALL) narrows nothing (no disjunct →
  //         byte-identical).
  //       • "Normal" (RESULT_CONDITION_NORMAL) → a PLAIN result: no method AND no
  //         super over. The super-over term is item 4's redefinition — before, a
  //         super over with no method counted as "Normal", which it plainly isn't.
  //       • "Super Over" (RESULT_CONDITION_SUPER_OVER) → the facet flag, moved here
  //         from the Result outcome list.
  //       • every other token is a specific method (D/L / VJD / Awarded / Lost
  //         fewer wickets) collected into ONE IN(...) list via
  //         resultConditionMethod.
  //     Each present group contributes one disjunct, OR'd together (they are
  //     facets, not a partition — 1 match is both a super over AND has a method).
  //     Empty / All-only contributes nothing.
  //
  //     COALESCE on is_super_over is REQUIRED, not cosmetic (item 1): the exported
  //     column is NULL — not false — for every match whose result_type is NULL,
  //     i.e. every ordinary win (20,527 of 22,229 rows). A bare `NOT
  //     mctx.is_super_over` would evaluate to NULL there and silently drop all of
  //     them from "Normal". COALESCE(..., false) makes the three-valued column
  //     behave as the boolean it is meant to be. The pipeline's own derivation is
  //     fixed too (export_parquet.py sql_matches), so this is belt-and-braces once
  //     a fresh export lands — and correct against BOTH old and new exports.
  //
  //     The predicate itself comes from the SHARED resultConditionPredicateSql
  //     fragment (see above), which the drawer's option lists also use — so
  //     "Result Condition = D/L" narrows every other picker's vocabulary by the
  //     exact same definition the query counts by.
  const resultConditionSql = resultConditionPredicateSql(state.resultCondition, A);
  if (resultConditionSql) clauses.push(resultConditionSql);

  return clauses;
}

// ── Pinned-player exemption (owner decision 46 task 3b; Wave 4b, decision 47a) ──
// A pin changes WHO is listed, never WHAT their numbers mean. Pins are the players
// ADDED to the result set regardless of the four PLAYER-SHORTLISTING filters —
// team / player profile / name search / numeric stat conditions — and
// nothing else. Everything that decides WHICH MATCHES OR BALLS are being measured
// still applies to them: the core scope (gender / format / date window / team
// type), opposition, the matchup striker position, event (+ seasons), venue, and
// the match-context filters (result, result condition, stage, toss result, toss
// decision).
//
// The bypass set is declared per-clause at the point each clause is BUILT (see the
// clause-tagging block above buildScopeClausesTagged) — never inferred from clause
// position here, which is the bug this replaced. Wave 4b (decision 47a) put pins on
// the SAME shared path buildScopeClauses is on, so the plain query (table.js
// buildQuery) and the Vs query (buildMatchupQuery) exempt pins through ONE
// mechanism and can never diverge. With no pins, every helper below returns exactly
// what the un-pinned query produced, so the number-critical normal query stays
// byte-identical.

/** The pinned-player id set as a SQL literal list (`'id1', 'id2'`), or null when
 * there are no pins. `pins` is [{id, name}]; entries without an id are dropped
 * (callers may already have filtered — this is idempotent). */
export function pinnedIdSetSql(pins) {
  const ids = (pins || []).filter((p) => p && p.id).map((p) => `'${esc(p.id)}'`);
  return ids.length ? ids.join(", ") : null;
}

/** Wrap a WHERE-clause list so pinned players bypass the LEADERBOARD-ONLY clauses
 * while still obeying every always-applies clause. `clauses` is a mixed list of
 * bare strings (always-applies) and tagged records from bypassableClause() /
 * alwaysClause() — see asTaggedClauses. Emits
 * `always AND (bypassable OR idColumn IN (pins))`, with the bypassable group
 * collapsing to TRUE when the caller has nothing pin-bypassable active.
 *
 * There is deliberately NO clause-position argument any more: the old
 * `coreClauses` parameter made the split positional, so every clause appended
 * after the core scope became pin-bypassable by accident (event, venue, and all
 * five match-context filters). Classification now travels WITH each clause, and
 * the default is always-applies. With no pins this returns exactly
 * `clauses.join(" AND ")` — byte-identical to the un-pinned query. */
export function whereWithPinExemption(clauses, idColumn, pins) {
  const tagged = asTaggedClauses(clauses);
  const idSet = pinnedIdSetSql(pins);
  if (!idSet) return tagged.map((c) => c.sql).join(" AND ");
  const always = tagged.filter((c) => !c.bypassable).map((c) => c.sql);
  const bypassable = tagged.filter((c) => c.bypassable).map((c) => c.sql);
  const bypassPart = bypassable.length ? `(${bypassable.join(" AND ")})` : "TRUE";
  const pinPart = `(${bypassPart} OR ${idColumn} IN (${idSet}))`;
  // `always` is never empty in practice (the core scope always contributes at
  // least gender + match_type), but guard so we can't emit a leading " AND ".
  return always.length ? `${always.join(" AND ")} AND ${pinPart}` : pinPart;
}

// ── Lane-aware WHERE compiler (Chunk 5 Phase 2 Wave A — the scope-lane OR engine) ──
// The Scope Filters dropdown gains a "Match any" mode: OR across DIFFERENT scope
// filter types (e.g. "Opposition = Australia OR Venue = Lord's"). This compiler is
// the ENGINE a later wave's toggle drives; nothing sets scopeOp = "OR" yet.
//
// It takes the SAME mixed clause list whereWithPinExemption does — the clauses now
// carry a lane `category` ("core" | "scope" | untagged) added at build time in
// buildScopeClausesTagged (and, for the match-context clauses, at the table.js push
// site). Crucially it re-uses the EXACT predicate strings the AND path builds; an OR
// predicate is only the same fragment re-joined with OR, so it can never drift from
// its AND form.
//
//   • scopeOp !== "OR"  → delegate to whereWithPinExemption VERBATIM. byte-identical.
//     (table.js's byte-identity guard already gates on this, so this branch is
//     belt-and-braces — calling whereWithLanes with scopeOp "AND" is a no-op wrapper.)
//   • scopeOp === "OR"  → emit
//        core-clauses (AND)
//        AND ( scope-clauses OR-joined )
//        AND player/pin-wrap over every remaining (untagged) clause
//     The scope-OR disjunction ALWAYS applies, pins included — it defines WHICH
//     matches/balls are measured, so "a pin is measured over the union it defines"
//     (owner-adopted default: Team folds into this disjunction too; name search stays
//     always-AND / bypassable and is NOT an OR participant → it lands in the untagged
//     remainder). The remainder keeps the identical pin-exemption shape
//     whereWithPinExemption gives it (always-applies AND'd, bypassable in the pin-OR
//     wrap), so pins behave identically for the non-scope clauses.
//
// Wave A threaded scopeOp through the MAIN WHERE of buildQuery / buildMatchupQuery.
// Chunk 5 Phase 2 Wave B adds `playerOp`: the ONLY player-lane member in the WHERE is
// the profile semi-join (tagged category "player" in buildScopeClausesTagged). Under
// player-OR it is LOWERED to a HAVING/step-3 disjunct by the table.js caller (a legal
// post-aggregation predicate on the GROUP-BY key, all-or-nothing per player), so this
// compiler DROPS it from the WHERE. Everything else about the WHERE is driven by
// scopeOp, so player-OR + scope-AND reduces to "whereWithPinExemption over the
// profile-suppressed list" (byte-identical to today minus the lowered profile clause).
// Fielding OR is Wave C.
export function whereWithLanes(clauses, { idColumn, pins, scopeOp, playerOp } = {}) {
  // Fully "Match all" (both lanes AND) → delegate VERBATIM. table.js's guard already
  // gates on this, so this branch is a belt-and-braces no-op wrapper.
  if (scopeOp !== "OR" && playerOp !== "OR") return whereWithPinExemption(clauses, idColumn, pins);

  // Player-OR: drop the "player"-category clause (the profile semi-join) from the
  // WHERE — the caller re-emits it as a HAVING disjunct (WHERE→HAVING lowering).
  const tagged =
    playerOp === "OR" ? asTaggedClauses(clauses).filter((c) => c.category !== "player") : asTaggedClauses(clauses);

  // Scope lane still "Match all": every surviving clause is AND-ed exactly as
  // whereWithPinExemption does — so the only change from today is the dropped profile
  // clause. No scope disjunction is built.
  if (scopeOp !== "OR") return whereWithPinExemption(tagged, idColumn, pins);

  // Scope lane "Match any" (Wave A): core AND (scope OR …) AND [pin-wrapped remainder].
  const core = tagged.filter((c) => c.category === "core").map((c) => c.sql);
  const scope = tagged.filter((c) => c.category === "scope").map((c) => c.sql);
  const others = tagged.filter((c) => c.category !== "core" && c.category !== "scope");

  const parts = [...core];
  const scopeDisjunction = orJoin(scope); // 1 clause → bare; ≥2 → parenthesised OR
  if (scopeDisjunction) parts.push(scopeDisjunction);

  // The non-scope remainder (profile semi-join / name search — both player-lane,
  // always-AND) keeps the EXACT pin-exemption split whereWithPinExemption applies,
  // re-used here rather than re-derived so it cannot diverge from the AND path.
  const idSet = pinnedIdSetSql(pins);
  if (!idSet) {
    parts.push(...others.map((c) => c.sql));
  } else {
    const always = others.filter((c) => !c.bypassable).map((c) => c.sql);
    const bypassable = others.filter((c) => c.bypassable).map((c) => c.sql);
    parts.push(...always);
    const bypassPart = bypassable.length ? `(${bypassable.join(" AND ")})` : "TRUE";
    parts.push(`(${bypassPart} OR ${idColumn} IN (${idSet}))`);
  }
  return parts.join(" AND ");
}

/** Wrap a post-aggregation gate (buildQuery's HAVING, or buildMatchupQuery's
 * step-3 existence/stat-condition gate) so pinned players are exempt from it:
 * `(gateSql) OR idColumn IN (pins)`. Returns `gateSql` unchanged when there are
 * no pins (or no gate). NOTE the caller supplies the id column valid at that
 * stage — buildQuery's HAVING uses the raw GROUP BY column, buildMatchupQuery's
 * step-3 runs over a subquery where it is projected as `id`. */
export function gateWithPinExemption(gateSql, idColumn, pins) {
  const idSet = pinnedIdSetSql(pins);
  if (!idSet || !gateSql) return gateSql;
  return `(${gateSql}) OR ${idColumn} IN (${idSet})`;
}

// Team type checkbox dropdown (decision 44b): the state value is still the
// single 'international' | 'club' | 'both' string (untouched) — these two
// checkboxes are just a different INPUT SHAPE over the same value. 'club' is
// relabeled "Domestic" for display only; the state/SQL value stays 'club'
// (buildScopeClauses, describeScope's TEAM_TYPE_LABELS key, everything else
// keeps reading 'club' — only this dropdown's visible text changes).
const TEAM_TYPE_OPTIONS = [
  { key: "international", label: "International" },
  { key: "club", label: "Domestic" },
];

/** Which of the two checkboxes are checked for a given teamType value. */
function teamTypeChecked(teamType) {
  return {
    international: teamType === "international" || teamType === "both",
    club: teamType === "club" || teamType === "both",
  };
}

/** Live summary label for the Team type dropdown button. */
function teamTypeSummaryLabel(teamType) {
  if (teamType === "both") return "International + Domestic";
  if (teamType === "international") return "International";
  return "Domestic"; // 'club'
}

/**
 * Live summary label for the Format dropdown button. Rule chosen (flagged
 * per task): "first selected + N more" rather than a full comma-join once
 * more than one bucket is selected — the comma-join reads cleaner at exactly
 * two ("T20, 50 Over") but grows unbounded at three, which defeats the point
 * of a compact strip on mobile. "+N" stays a fixed short width regardless of
 * how many buckets are picked, so it's used uniformly for every "more than
 * one" case. R5 Wave 1a: the three buckets (Red Ball / 50 Over / T20) now
 * carry their display labels DIRECTLY on FORMAT_BUCKETS, in display order, so
 * the old display-rename/reorder layer is gone — this reads FORMAT_BUCKETS.
 */
function formatSummaryLabel(formats) {
  const ordered = FORMAT_BUCKETS.filter((b) => formats.includes(b.key));
  if (ordered.length === 0) return "None"; // guarded against below — should not be reachable
  if (ordered.length === FORMAT_BUCKETS.length) return "All formats";
  if (ordered.length === 1) return ordered[0].label;
  return `${ordered[0].label} +${ordered.length - 1}`;
}

/**
 * Portal-aware dropdown wiring (F1b, team_dropdown.png fix). Shared by every
 * dropdown opened INSIDE the Filters popup body — Format + Team type here,
 * Current/Historic team (drawer.js), Batting position + Against
 * opposition (drawerInnings.js). The popup body scrolls (overflow:auto), which
 * CLIPS any absolutely-positioned panel opened within it; this helper moves the
 * panel to <body> with position:fixed while open so it escapes that clipping
 * ancestor, positions it under `toggleEl`, and repositions on popup-body scroll
 * + window resize. Mirrors the technique table.js uses for its columns popover
 * (getBoundingClientRect placement + a CAPTURING scroll listener so it also
 * catches scrolls on nested scrollable ancestors like the popup body) but is a
 * self-contained local helper — table.js is untouched.
 *
 * Open/close semantics (toggle click, outside-click, Escape, aria-expanded, the
 * `hidden` attribute) are handled here so every in-popup dropdown behaves
 * identically. `onOpen`/`onClose` run after the panel is shown/hidden (e.g. the
 * team dropdowns reset+focus their search box on open). Exported so drawer.js
 * and drawerInnings.js reuse the one implementation. Returns
 * `{ open, close, isOpen, reposition }`.
 */
export function wirePortalDropdown(toggleEl, panelEl, { onOpen, onClose } = {}) {
  // Remember the panel's original slot so close() can restore it in place —
  // then its closed-state CSS (position:absolute inside .dropdown/.team-dropdown)
  // and any parent-relative logic keep holding while it's not floating.
  const home = { parent: panelEl.parentNode, next: panelEl.nextSibling };
  let opened = false;

  function position() {
    const r = toggleEl.getBoundingClientRect();
    const margin = 8;
    panelEl.style.position = "fixed";
    panelEl.style.zIndex = "1000"; // above the modal panel (.filters-popup is z-index:100)
    // Override .dropdown__panel's min-width:100% — on <body> that resolves to
    // the viewport width. Pin it to the toggle's width instead.
    panelEl.style.minWidth = `${Math.round(r.width)}px`;
    panelEl.style.top = `${Math.round(r.bottom + 6)}px`;
    const width = panelEl.offsetWidth || Math.round(r.width);
    let left = Math.min(r.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    panelEl.style.left = `${Math.round(left)}px`;
    panelEl.style.right = "auto";
    // Never taller than the space below the toggle — a long list scrolls within.
    const maxH = Math.max(140, Math.round(window.innerHeight - (r.bottom + 6) - margin));
    panelEl.style.maxHeight = `${maxH}px`;
    panelEl.style.overflowY = "auto";
  }

  const onScroll = () => {
    if (opened) position();
  };
  const onResize = () => {
    if (opened) position();
  };

  function open() {
    if (opened || toggleEl.disabled) return;
    opened = true;
    panelEl.hidden = false;
    document.body.appendChild(panelEl);
    position();
    toggleEl.setAttribute("aria-expanded", "true");
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    if (onOpen) onOpen();
  }

  function close() {
    if (!opened) return;
    opened = false;
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    panelEl.hidden = true;
    // Clear the inline portal styles so the CSS layout resumes when restored.
    for (const p of ["position", "zIndex", "minWidth", "top", "left", "right", "maxHeight", "overflowY"]) {
      panelEl.style[p] = "";
    }
    if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(panelEl, home.next);
    else home.parent.appendChild(panelEl);
    toggleEl.setAttribute("aria-expanded", "false");
    if (onClose) onClose();
  }

  toggleEl.addEventListener("click", () => {
    if (opened) close();
    else open();
  });
  // Capture-phase so it also fires for clicks on nested scroll ancestors and
  // runs before the toggle's own listener (which then toggles): on the opening
  // click `opened` is still false here, so this no-ops and the toggle opens.
  document.addEventListener(
    "click",
    (e) => {
      if (!opened) return;
      if (panelEl.contains(e.target) || toggleEl === e.target || toggleEl.contains(e.target)) return;
      close();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && opened) {
        close();
        e.stopPropagation(); // don't also close the Filters popup on the same Escape
      }
    },
    true
  );

  return { open, close, isOpen: () => opened, reposition: position };
}

/**
 * Mount the "Conditions" controls (Gender, Discipline, Format, Team type,
 * Date range) into `container` — the Filters popup's Conditions section body
 * (F1a). Calls `onChange()` after any state mutation so main.js can update the
 * pills/subtitle/badge (it no longer blanks the table — only the popup's
 * "Search" button re-queries). Store keys/values are unchanged.
 */
export function mountFilters(container, store, onChange, onFormatsChanged, onDisciplineChanged) {
  container.innerHTML = `
    <div class="filter-group filter-group--gender">
      <span class="filter-label">Gender</span>
      <select class="select" data-role="gender" aria-label="Gender">
        <option value="male">Men</option>
        <option value="female">Women</option>
      </select>
    </div>

    <div class="filter-group filter-group--discipline">
      <span class="filter-label">Discipline</span>
      <select class="select" data-role="discipline" aria-label="Discipline">
        <option value="batting">Batting</option>
        <option value="bowling">Bowling</option>
        <option value="fielding">Fielding</option>
      </select>
    </div>

    <div class="filter-group filter-group--format">
      <span class="filter-label">Format</span>
      <div class="dropdown" data-role="format-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="format-toggle" aria-haspopup="true" aria-expanded="false"></button>
        <div class="dropdown__panel" data-role="format-panel" hidden>
          <div class="dropdown__list" data-role="format-list">
            ${FORMAT_BUCKETS.map(
              (b) => `<label class="dropdown__item">
                <input type="checkbox" data-format="${b.key}" />
                <span>${b.label}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
    </div>

    <div class="filter-group filter-group--teamtype">
      <span class="filter-label">Team type</span>
      <div class="dropdown" data-role="teamtype-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="teamtype-toggle" aria-haspopup="true" aria-expanded="false"></button>
        <div class="dropdown__panel" data-role="teamtype-panel" hidden>
          <div class="dropdown__list" data-role="teamtype-list">
            ${TEAM_TYPE_OPTIONS.map(
              (o) => `<label class="dropdown__item">
                <input type="checkbox" data-teamtype="${o.key}" />
                <span>${o.label}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
    </div>

    <div class="filter-group filter-group--dates">
      <span class="filter-label">Date range</span>
      <!-- R7 Wave B (item 1): From · To · Preset now live on ONE row inside
           .date-range (the preset select used to sit stacked below in its own
           .date-presets wrapper). The data-role="date-presets" hook is
           unchanged, so the lookup + wiring below are unaffected by the move. -->
      <div class="date-range">
        <input type="date" class="input date-range__input" data-role="dateFrom" aria-label="From date" />
        <span class="date-range__sep">–</span>
        <input type="date" class="input date-range__input" data-role="dateTo" aria-label="To date" />
        <select class="select date-preset-select" data-role="date-presets" aria-label="Date preset">
          <option value="">Preset…</option>
          <option value="last-month">Last month</option>
          <option value="last-12">Last 12 months</option>
          <option value="ytd">Year to date</option>
          <option value="last-year">Last calendar year</option>
          <option value="since-2020">Since 2020</option>
        </select>
      </div>
      <p class="profile-note date-required-note" data-role="date-required" hidden>Choose a start and end date to search.</p>
    </div>
  `;

  // R3 harmonisation sweep (owner ruling): Gender and Discipline are PLAIN
  // native <select>s again — the Wave F2 segmented toggles were reverted here
  // because a 2-way exclusive choice is what a native <select> is for; the
  // owner ruled the searchable panel (mountSearchSelect) is overkill for a
  // binary choice too. Same store keys (gender/discipline), same values
  // ("male"/"female", "batting"/"bowling"), same downstream onChange/
  // onDisciplineChanged/onFormatsChanged calls as the segmented toggles they
  // replace — this is a markup + wiring swap only, nothing about WHAT gets
  // written to state changed.
  const els = {
    gender: container.querySelector('[data-role="gender"]'),
    discipline: container.querySelector('[data-role="discipline"]'),
    dateFrom: container.querySelector('[data-role="dateFrom"]'),
    dateTo: container.querySelector('[data-role="dateTo"]'),
    datePresets: container.querySelector('[data-role="date-presets"]'), // the <select> itself
    dateRequired: container.querySelector('[data-role="date-required"]'),
    formatToggle: container.querySelector('[data-role="format-toggle"]'),
    formatPanel: container.querySelector('[data-role="format-panel"]'),
    formatList: container.querySelector('[data-role="format-list"]'),
    teamtypeToggle: container.querySelector('[data-role="teamtype-toggle"]'),
    teamtypePanel: container.querySelector('[data-role="teamtype-panel"]'),
    teamtypeList: container.querySelector('[data-role="teamtype-list"]'),
  };

  // Data date bounds (from the manifest, via setDateBounds) used for the input
  // min/max and the preset math. maxDate = the reference "now" for presets.
  let minDate = null;
  let maxDate = null;

  function syncDateInputs() {
    const state = store.get();
    els.dateFrom.value = toInputValue(state.dateFrom);
    els.dateTo.value = toInputValue(state.dateTo);
  }

  // ---- Format dropdown (multi-select, apply-live, min-one guard) ----
  function syncFormatDropdown() {
    const state = store.get();
    els.formatToggle.textContent = formatSummaryLabel(state.formats);
    els.formatList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const checked = state.formats.includes(cb.dataset.format);
      cb.checked = checked;
      // Guard against zero formats (the old chip row had no such guard — it
      // could reach zero and silently return no rows; this dropdown adds the
      // safety the task calls for): the sole remaining checked box is
      // disabled so it can't be the click that empties the selection.
      const sole = checked && state.formats.length === 1;
      cb.disabled = sole;
      cb.closest(".dropdown__item").classList.toggle("is-disabled", sole);
      cb.title = sole ? "At least one format must stay selected" : "";
    });
  }

  els.formatList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const state = store.get();
      const set = new Set(state.formats);
      const key = cb.dataset.format;
      if (cb.checked) {
        set.add(key);
      } else if (set.size <= 1) {
        cb.checked = true; // defensive: the disabled attribute should already prevent this
        return;
      } else {
        set.delete(key);
      }
      // Format is a scope dimension like gender/team-type (owner decision
      // 2026-07-18: the clearing logic must be consistent across ALL scope
      // dimensions, not special-cased). A format switch re-scopes the
      // Team/Event/Venue/opposition vocabularies (playerData.js loaders +
      // the A9 full-scope option lists), so clear those picks — a stale
      // selection must not silently survive into a scope where it no longer
      // occurs. Profile filters are format-independent, so (like team-type)
      // they are intentionally kept.
      // Wave 6 close-out (FIX 2): the Stage option list is scope-specific too, so
      // a format switch clears state.stage alongside event/eventSeasons — a stale
      // stage selection makes no sense in a scope where it may not occur. Only
      // `stage` among the match-context filters is scope-dependent; result/toss/
      // innings/method are not, so they are left untouched.
      store.set({ formats: [...set], teams: [], event: [], venue: [], city: [], season: [], opposition: [], eventSeasons: {}, stage: [] });
      syncFormatDropdown();
      if (onFormatsChanged) onFormatsChanged();
      onChange();
    });
  });
  wirePortalDropdown(els.formatToggle, els.formatPanel);

  // ---- Team type dropdown (exactly two checkboxes, min-one guard) ----
  function syncTeamTypeDropdown() {
    const state = store.get();
    els.teamtypeToggle.textContent = teamTypeSummaryLabel(state.teamType);
    const checked = teamTypeChecked(state.teamType);
    const totalChecked = Number(checked.international) + Number(checked.club);
    els.teamtypeList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      const key = cb.dataset.teamtype;
      const isChecked = checked[key];
      cb.checked = isChecked;
      const sole = isChecked && totalChecked === 1;
      cb.disabled = sole;
      cb.closest(".dropdown__item").classList.toggle("is-disabled", sole);
      cb.title = sole ? "At least one team type must stay selected" : "";
    });
  }

  els.teamtypeList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const state = store.get();
      const current = teamTypeChecked(state.teamType);
      const key = cb.dataset.teamtype;
      const next = { ...current, [key]: cb.checked };
      if (!next.international && !next.club) {
        cb.checked = true; // defensive: the disabled attribute should already prevent this
        return;
      }
      const teamType = next.international && next.club ? "both" : next.international ? "international" : "club";
      // ROUND 3 (task 9): a team-type switch re-scopes the Team/Event/Venue/
      // opposition vocabularies (see playerData.js's teamTypeMatchClause and
      // buildScopeClauses' opposition gate), so clear those selections — a
      // selected IPL event must not silently survive a switch to International.
      // Profile filters are team-type-independent, so they're intentionally kept.
      store.set({ teamType, teams: [], event: [], venue: [], city: [], season: [], opposition: [], eventSeasons: {}, stage: [] });
      syncTeamTypeDropdown();
      onChange();
    });
  });
  wirePortalDropdown(els.teamtypeToggle, els.teamtypePanel);

  // The Fielding discipline option (3rd scope) is DATA-DRIVEN, never gender-hardcoded:
  // it is OFFERED only where fielding data exists for the current gender (dataAvail.fielding,
  // resolved by dataAvailability.js's probeFielding). Captured once so it can be detached /
  // re-attached (removal, not the `hidden` attribute, for cross-browser reliability) as the
  // availability map resolves. Fielding events exist for BOTH genders today, so this shows
  // in both; the gate only hides it if a gender ever has no fielding data.
  const fieldingDisciplineOpt = els.discipline.querySelector('option[value="fielding"]');

  function syncDisciplineOptions() {
    if (!fieldingDisciplineOpt) return;
    const av = store.get().dataAvail;
    // Optimistic-show until the per-gender map resolves (matchupVsActive-style default,
    // display-only): show unless the map is present AND explicitly reports no fielding data.
    const show = !av || typeof av.fielding !== "boolean" || av.fielding;
    const attached = fieldingDisciplineOpt.parentNode === els.discipline;
    if (show && !attached) els.discipline.appendChild(fieldingDisciplineOpt);
    else if (!show && attached) els.discipline.removeChild(fieldingDisciplineOpt);
  }

  function render() {
    const state = store.get();
    els.gender.value = state.gender;
    syncDisciplineOptions();
    els.discipline.value = state.discipline;
    syncFormatDropdown();
    syncTeamTypeDropdown();
    syncDateInputs();
    // R7 Wave B (item 14 — "Clear must reset the preset label"): a preset label
    // only means anything while a full date window is set. "Clear all filters"
    // nulls both dates (clearAll → render() runs with dateFrom = dateTo = null,
    // BEFORE setDateBounds re-applies the default end date), so reset the preset
    // dropdown to its "Preset…" placeholder instead of leaving a stale label
    // (e.g. "Year to date"). Guarded to the both-null case so a plain re-render
    // (e.g. a gender switch, which keeps the dates) never wipes a live preset.
    if (!state.dateFrom && !state.dateTo) els.datePresets.value = "";
  }

  /** Date is REQUIRED (owner 1B-2 — the data isn't all-time, so an unbounded
   * search would be dishonest). Search is blocked until BOTH a start and end
   * date are set; every preset sets both at once. Shows/hides the inline
   * note and returns whether the date is valid. */
  function validateDate() {
    const s = store.get();
    const ok = Boolean(s.dateFrom) && Boolean(s.dateTo);
    els.dateRequired.hidden = ok;
    return ok;
  }

  function applyPreset(preset) {
    if (!maxDate) return; // no data date known yet — presets inert
    const [maxY] = maxDate.split("-").map(Number);
    let from;
    let to;
    if (preset === "last-month") {
      from = subMonths(maxDate, 1);
      to = maxDate;
    } else if (preset === "last-12") {
      from = subMonths(maxDate, 12);
      to = maxDate;
    } else if (preset === "ytd") {
      from = ymd(maxY, 1, 1);
      to = maxDate;
    } else if (preset === "last-year") {
      from = ymd(maxY - 1, 1, 1);
      to = ymd(maxY - 1, 12, 31);
    } else if (preset === "since-2020") {
      // "Since 2020" -> today (R4 Wave 1a): same "today" reference as every
      // other preset here — the data's own max match date (maxDate), not the
      // wall clock, so it never reaches past the loaded snapshot.
      from = "2020-01-01";
      to = maxDate;
    } else {
      return;
    }
    // Never let a preset stray outside the data's own [min, max] window.
    from = clampDate(from, minDate, maxDate);
    to = clampDate(to, minDate, maxDate);
    if (from > to) from = to;
    // A preset changes the date window → same scope-change vocab clear as a
    // manual date edit (see the From/To handlers, owner decision 2026-07-18).
    store.set({ dateFrom: from, dateTo: to, teams: [], event: [], venue: [], city: [], season: [], opposition: [], eventSeasons: {}, stage: [] });
    syncDateInputs();
    validateDate();
    onChange();
  }

  // ---- wire remaining events ----
  // Gender + Discipline (R3 harmonisation): plain native <select>s again — same
  // store keys/values, same clearing logic, as the segmented toggles they
  // replaced. A native <select>'s "change" event doesn't fire when the same
  // option is re-picked, so the explicit value-unchanged guard below is
  // belt-and-braces (kept from the segmented-toggle version) rather than load-
  // bearing.
  els.gender.addEventListener("change", () => {
    const value = els.gender.value;
    if (value === store.get().gender) return;
    // Switching gender clears the gender-specific selections: teams differ by
    // gender; profile + matchupVs depend on profile/matchup data that (today)
    // exists only for men, so a stale pick would apply the wrong gender's data on
    // the other view; Team/Event/Venue/opposition are gender-scoped vocabularies,
    // so a stale pick would silently match nothing — clear them so the option
    // lists (which re-scope by gender) and any selection stay honest.
    // matchupVs MUST be cleared here (Group 3): matchupVsActive now keys on the
    // data-presence gate, not `gender`, and the GRAPH reads it WITHOUT awaiting the
    // availability probe — so a men's Vs bucket left on the store could route a
    // women's chart to the matchup namespace during/after an unresolved probe.
    // Clearing it makes matchupVsActive's own `!state.matchupVs` guard hold for
    // women unconditionally, exactly as the old gender hard-gate did.
    store.set({
      gender: value,
      teams: [],
      profile: emptyProfile(),
      matchupVs: null,
      event: [],
      venue: [],
      city: [], // City & Season everywhere: scope-dependent match filters → drop stale picks on any scope change
      season: [],
      opposition: [],
      eventSeasons: {}, // Wave 6 pt2: drop any season narrowing with the cleared event picks
      stage: [], // Stage options are scope-dependent (all 4 dims, FIX C) → drop stale picks on any scope change (gender/format/team-type/date all clear stage)
    });
    render();
    onChange();
  });

  // Discipline: same store key as before. onDisciplineChanged (main.js)
  // re-applies the default column set + falls back the sort key when it no
  // longer resolves in the new discipline.
  els.discipline.addEventListener("change", () => {
    const value = els.discipline.value;
    if (value === store.get().discipline) return;
    store.set({ discipline: value });
    els.discipline.value = value;
    if (onDisciplineChanged) onDisciplineChanged();
    onChange();
  });

  els.dateFrom.addEventListener("change", () => {
    // Date is a scope dimension too (owner decision 2026-07-18) — clear the
    // Team/Event/Venue/opposition vocab picks on a window change, exactly as
    // gender/team-type/format do, so the full-scope (A9) option lists and any
    // selection stay consistent. Profile filters are date-independent, kept.
    store.set({ dateFrom: els.dateFrom.value || null, teams: [], event: [], venue: [], city: [], season: [], opposition: [], eventSeasons: {}, stage: [] });
    els.datePresets.value = ""; // a manual edit no longer matches any preset — reset the label
    validateDate();
    onChange();
  });
  els.dateTo.addEventListener("change", () => {
    store.set({ dateTo: els.dateTo.value || null, teams: [], event: [], venue: [], city: [], season: [], opposition: [], eventSeasons: {}, stage: [] }); // scope-change vocab clear (see dateFrom)
    els.datePresets.value = ""; // a manual edit no longer matches any preset — reset the label
    validateDate();
    onChange();
  });
  // Preset dropdown (R4 Wave 1a — replaces the old 4 preset buttons): choosing
  // an option fills From/To (pending state, same as typing them — Search is
  // still the only query trigger). R5 Wave 1a (item 5): the chosen preset's
  // NAME now PERSISTS in the closed dropdown (no reset to "Preset…"), so the
  // control shows which window is active. A subsequent manual date edit clears
  // it back to the placeholder (see the From/To change handlers above).
  els.datePresets.addEventListener("change", () => {
    const preset = els.datePresets.value;
    if (preset) applyPreset(preset);
  });

  render();

  return {
    render,
    validateDate,
    setDateBounds(minD, maxD) {
      // Full "YYYY-MM-DD" data bounds from the manifest. Set the input min/max
      // and stash them for the preset math; then re-sync the inputs from state.
      minDate = minD || null;
      maxDate = maxD || null;
      if (minDate) {
        els.dateFrom.min = minDate;
        els.dateTo.min = minDate;
      }
      if (maxDate) {
        els.dateFrom.max = maxDate;
        els.dateTo.max = maxDate;
      }
      els.datePresets.disabled = !maxDate;
      // R5 Wave 1a (item 4): the END date defaults to the latest match date in
      // the dataset (the SAME max-date bound the presets use) whenever it is
      // still unset — at boot and after "Clear all filters". The START date is
      // left blank on purpose and stays REQUIRED (validateDate blocks Search
      // until the user picks one), so an unbounded search is still impossible.
      if (maxDate && !store.get().dateTo) {
        store.set({ dateTo: maxDate });
      }
      syncDateInputs();
    },
  };
}
