// src/playerData.js
//
// Data layer for the player page (R2, decision 29). Every stat expression
// comes from src/metrics.js (§8.2: metrics are defined ONCE) — this module
// only composes them into player-scoped grouped queries.
//
// Player-page scope = Format + Date range + Team type ONLY. Gender is
// redundant (queries filter by the player's id), and the drawer filters
// (team, min innings, profile, position, opposition, stat conditions) do NOT
// apply here — the page's own honest scope line states exactly this.

import { query } from "./db.js";
import { buildScopeClauses } from "./filters.js";
import { getMetric, DISMISSAL_KINDS, metricsFor } from "./metrics.js";
import { escSql as esc } from "./state.js";

function expr(discipline, key) {
  return getMetric(key, discipline).sqlExpression;
}

/** WHERE clauses for the player-page scope: formats + dates + team type only. */
function pageScopeClauses(state) {
  const scope = {
    gender: state.gender, // unused (includeGender: false), kept for shape
    formats: state.formats,
    dateFrom: state.dateFrom,
    dateTo: state.dateTo,
    teamType: state.teamType,
    teams: [],
    positions: [],
    opposition: [],
  };
  return buildScopeClauses(scope, { includeGender: false, includeTeams: false });
}

function whereFor(state, idColumn, playerId) {
  return [...pageScopeClauses(state), `${idColumn} = '${esc(playerId)}'`].join(" AND ");
}

function selectList(discipline, keys) {
  return keys.map((k) => `${expr(discipline, k)} AS ${k}`).join(", ");
}

// ── Popup overlay re-scoping (B7, decision 44a) ───────────────────────────────
// The player popup gets its own filters drawer (UI lands in a later task) that
// RE-SCOPES every section on top of the page scope (Format + Date + Team type).
// The overlay object it passes is:
//   { dateFrom, dateTo,                // "YYYY-MM" | null — extra date narrowing
//     positions,                       // int[]  — batting positions (batter's own,
//                                       //          or the STRIKER's for bowling matchups)
//     opposition,                      // string | null — a single opponent team
//     vs }                             // string | null — a bowling style/group,
//                                       //          BATTING discipline only
// A dimension is "requested" only when it carries a real value; an absent or
// empty overlay leaves every query BYTE-IDENTICAL to the pre-B7 behaviour (the
// applyOverlay fast-path returns the original WHERE string unchanged).
//
// Honesty rule (decision 44a): a section whose SOURCE table cannot honor a
// requested dimension returns a STRUCTURED REFUSAL ({ unsupported: [...] })
// instead of silently dropping the dimension — the UI greys that section with
// a note. We NEVER apply a partial overlay. The one exception is `vs` on the
// batting core/how-out sections, which switch source to matchup_batting (which
// carries bowling_type/bowling_group) and answer WITH a coverage line, exactly
// as the existing Matchups section already does.
//
// PLAYER_SECTION_SUPPORT is the machine-readable map the drawer reads to grey
// impossible dimension×section combinations UP FRONT. Values: true (honored
// natively), false (refused), "matchup" (honored by switching to the matchup
// source). It is kept in lock-step with what each fetch function enforces at
// query time — the two must never disagree.
export const PLAYER_SECTION_SUPPORT = {
  "batting.core": { date: true, positions: true, opposition: true, vs: "matchup" },
  "batting.positions": { date: true, positions: true, opposition: true, vs: false },
  "batting.opposition": { date: true, positions: true, opposition: true, vs: false },
  "batting.howout": { date: true, positions: true, opposition: true, vs: "matchup" },
  "batting.progression": { date: true, positions: true, opposition: true, vs: false },
  "batting.matchups": { date: true, positions: true, opposition: true, vs: false },
  "bowling.core": { date: true, positions: false, opposition: true, vs: false },
  "bowling.wicketTypes": { date: true, positions: false, opposition: true, vs: false },
  "bowling.opposition": { date: true, positions: false, opposition: true, vs: false },
  "bowling.matchups": { date: true, positions: true, opposition: true, vs: false },
};

/** The overlay dimensions carrying a real (narrowing) value. */
function requestedDims(overlay) {
  if (!overlay) return [];
  const req = [];
  if (overlay.dateFrom || overlay.dateTo) req.push("date");
  if (Array.isArray(overlay.positions) && overlay.positions.length > 0) req.push("positions");
  if (overlay.opposition) req.push("opposition");
  if (overlay.vs) req.push("vs");
  return req;
}

/** Date narrowing — identical month semantics to filters.js buildScopeClauses
 * (inclusive of the whole "to" month via first-day-of-next-month). */
function overlayDateClauses(overlay) {
  const c = [];
  if (overlay.dateFrom) c.push(`match_date >= DATE '${esc(overlay.dateFrom)}-01'`);
  if (overlay.dateTo) {
    const [y, m] = overlay.dateTo.split("-").map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    c.push(`match_date < DATE '${nextY}-${String(nextM).padStart(2, "0")}-01'`);
  }
  return c;
}

/** `vs` bucket predicate (matchup_batting only). 'Spin'/'Pace' are the two
 * bowling_GROUP values (coarse — ALL spin / ALL pace, matching the leaderboard
 * "vs Spin" semantics and the standing anchor); any other value is a specific
 * bowling_TYPE. This group-vs-type disambiguation is a JUDGMENT CALL forced by
 * the flat `vs` overlay value (see final report). */
function overlayVsClause(overlay) {
  const v = overlay.vs;
  if (v === "Spin" || v === "Pace") return [`bowling_group = '${esc(v)}'`];
  return [`bowling_type = '${esc(v)}'`];
}

/**
 * Fold the overlay's date/positions/opposition narrowing onto a base WHERE
 * string for a plain (non-vs) section. `caps` names the source's columns:
 *   positionCol   — batting_position, or null if the source lacks it
 *   oppositionCol — the opponent column (bowling_team for batting sources,
 *                   batting_team for bowling sources)
 * `vs` is handled by callers, never here: plain sources cannot honor it, so a
 * requested `vs` is always a refusal (returned in `unsupported`). Returns
 * `{ where }` (all requested dims honored — and, crucially, the UNCHANGED base
 * string when nothing was requested → byte-identical) or `{ unsupported: [...] }`
 * (one or more requested dims can't be honored — NEVER a partial where). */
function applyOverlay(baseWhere, overlay, caps) {
  const req = requestedDims(overlay);
  if (req.length === 0) return { where: baseWhere };
  const unsupported = [];
  const extra = [];
  for (const dim of req) {
    if (dim === "date") {
      extra.push(...overlayDateClauses(overlay));
    } else if (dim === "positions") {
      if (!caps.positionCol) {
        unsupported.push("positions");
      } else {
        // User-picked ints; coerce + drop anything non-integral (same guard as
        // filters.js) so nothing unsanitized reaches the SQL.
        const nums = overlay.positions.map(Number).filter(Number.isInteger);
        if (nums.length > 0) extra.push(`${caps.positionCol} IN (${nums.join(", ")})`);
      }
    } else if (dim === "opposition") {
      if (!caps.oppositionCol) unsupported.push("opposition");
      else extra.push(`${caps.oppositionCol} = '${esc(overlay.opposition)}'`);
    } else if (dim === "vs") {
      unsupported.push("vs"); // plain sources can't; batting core switches upstream
    }
  }
  if (unsupported.length > 0) return { unsupported };
  return { where: [baseWhere, ...extra].join(" AND ") };
}

/**
 * Substring player search across ALL players (both genders), profile-enriched.
 * Names come from player_matches, not the players registry: a player can
 * appear under several names over time (e.g. NR Sciver → NR Sciver-Brunt, and
 * players.parquet keeps only the oldest). We match against EVERY name the
 * player has appeared under and display the most recent one, so both the
 * maiden and current names find the same person. player_matches also covers
 * players who were selected but never batted or bowled (decision 9).
 *
 * Relevance ranking (R3 Wave 6, owner-decided leftover): tiered so a famous
 * player surfaces above obscure namesakes —
 *   1. exact name match (case-insensitive, any of the player's name-history
 *      rows equals the search term exactly)
 *   2. prefix match (a name-history row STARTS WITH the term)
 *   3. everything else (the existing plain substring match)
 * — and, WITHIN each tier, by the player's whole-database career
 * appearances (COUNT(DISTINCT match_id) over ALL player_matches rows for
 * that player_id — every gender/format/date, not the current leaderboard
 * scope; same aggregate SPEC's canonical "Matches" metric uses) descending,
 * so e.g. "kohli" surfaces V Kohli above any lesser-known Kohli even though
 * neither is an exact/prefix hit on "kohli" (both land in tier 3, where
 * appearances desc breaks the tie). Ties within a tier+appearances bucket
 * fall back to name asc for determinism. This is the ONE suggestion query
 * — both the header search and the table search (omnisearch.js, mounted
 * twice) call it, so the ranking applies identically to both.
 */
export async function searchPlayers(term) {
  const t = (term || "").trim();
  if (t.length < 2) return [];
  // Escape LIKE wildcards (\, %, _) so a literal '%' or '_' typed into the
  // search box matches that character rather than acting as a pattern
  // metacharacter; then SQL-quote-escape. Every ILIKE below pairs this with
  // ESCAPE '\'. A plain-letters term has no wildcards, so this is a no-op for
  // normal searches (the `%`/`%…%` positional wildcards are still added
  // OUTSIDE `et`, so prefix/substring matching is unchanged).
  const et = esc(t.replace(/([\\%_])/g, "\\$1"));
  const sql = [
    `WITH latest AS (`,
    `  SELECT player_id AS id, arg_max(player_name, match_date) AS name`,
    `  FROM player_matches GROUP BY player_id`,
    `), hits AS (`,
    `  SELECT player_id AS id,`,
    `    MIN(CASE`,
    `      WHEN player_name ILIKE '${et}' ESCAPE '\\' THEN 0`,
    `      WHEN player_name ILIKE '${et}%' ESCAPE '\\' THEN 1`,
    `      ELSE 2`,
    `    END) AS tier`,
    `  FROM player_matches`,
    `  WHERE player_name ILIKE '%${et}%' ESCAPE '\\'`,
    `  GROUP BY player_id`,
    // appearances is restricted to the players `hits` actually matched, so the
    // COUNT(DISTINCT match_id) runs over a handful of ids per keystroke instead
    // of the whole player_matches table. The final result only ever reads a.n
    // for hit ids (FROM hits ... LEFT JOIN appearances), so the ranking —
    // tier ASC, appearances DESC, name ASC — is byte-identical to computing it
    // over all players.
    `), appearances AS (`,
    `  SELECT player_id AS id, COUNT(DISTINCT match_id) AS n`,
    `  FROM player_matches`,
    `  WHERE player_id IN (SELECT id FROM hits)`,
    `  GROUP BY player_id`,
    `)`,
    `SELECT l.id, l.name, pr.country AS country, pr.playing_role AS playing_role`,
    `FROM hits h`,
    `JOIN latest l ON l.id = h.id`,
    `LEFT JOIN appearances a ON a.id = h.id`,
    `LEFT JOIN profiles pr ON pr.player_id = l.id`,
    `ORDER BY h.tier ASC, COALESCE(a.n, 0) DESC, l.name ASC`,
    `LIMIT 25`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

// ── Match-level option loaders (Batch 1B, task 1B-1) ─────────────────────────
// Gender- + team-type-scoped relevance lists for the Team/Event/Venue picker
// UIs (1B-2 builds the pickers; this module only supplies their data). Unlike
// the rest of this file (player-page queries scoped to one player_id), these
// three query `matches` directly and are scoped by GENDER and TEAM TYPE only —
// no format/date narrowing — per the Batch 1B design (a picker's option list
// should reflect "everything that exists for this gender + team type," not
// shrink as format/date filters are set). ROUND 3 (bug 7a) added the team-type
// dimension: on International, the Event picker must NOT list domestic-only
// competitions (e.g. the IPL, which has 0 international matches); on Domestic it
// must. See teamTypeMatchClause above. With teamType 'both' the constraint is
// dropped, so the counts are byte-identical to the pre-ROUND-3 gender-only
// lists (regression guard: "India 1,013 games" is unchanged under 'both').
//
// Relevance ordering (flagged judgment call — see final report): rows whose
// name contains the search term (case-insensitive substring, matching this
// file's existing searchPlayers precedent above) sort before non-matching
// rows; ties within/across that tier break by total games played descending,
// and — for events only — a further tiebreak by recency (latest match_date)
// descending, per the plan's "event: text→games→recency" ordering. An empty
// term makes the text-match tier a no-op (every row ties on it, since the
// CASE's condition can never be true), so the ordering collapses to games desc
// (events: games desc, then recency desc) — this is what makes the empty-term
// case "the full gender-scoped list ordered by games desc."
//
// No LIMIT on any of the three: the option counts are small (verified against
// live data: ≤356 teams / ≤754 events / ≤742 venues per gender), matching the
// existing (also unlimited) team option lookup in drawer.js's fetchTeamOptions.

/** Shared ORDER BY prefix: a text-match tier (only emitted when `term` is
 * non-blank — an empty term collapses to just `secondary`), then `secondary`
 * (a raw ORDER BY fragment, e.g. "games DESC, label ASC"). */
function relevanceOrderBy(col, term, secondary) {
  const t = (term || "").trim();
  const tier = t ? `CASE WHEN ${col} ILIKE '%${esc(t)}%' THEN 0 ELSE 1 END, ` : "";
  return `ORDER BY ${tier}${secondary}`;
}

/** Team-type scoping fragment (ROUND 3, bug 7a): a SQL predicate restricting a
 * `matches`-based option list to matches of the given team type, so an entity
 * (team/event/venue) only appears — and its `games` count only tallies matches —
 * of that type. 'international' → only international matches; 'club' → only club
 * (domestic) matches; 'both'/anything else → no constraint (returns ""). The
 * value is a trusted state enum, but it's matched against known strings and only
 * fixed literals are emitted, so nothing unsanitised reaches the SQL. RESULT:
 * on team type = International the Event picker drops IPL (0 international
 * matches); switch to Domestic and it reappears. */
function teamTypeMatchClause(teamType) {
  if (teamType === "international") return " AND team_type = 'international'";
  if (teamType === "club") return " AND team_type = 'club'";
  return "";
}

/**
 * Distinct teams appearing in `matches` for `gender` (UNION ALL of team_1 and
 * team_2 — a team never occupies both sides of the same match, so summing
 * appearances across the two slots is exactly "number of matches this team
 * appears in"). Feeds the new single Team picker (1B-2); state.teams itself
 * and its query-side handling are untouched by this task.
 */
export async function searchTeams(term, gender, teamType = "both") {
  const orderBy = relevanceOrderBy("team", term, "games DESC, team ASC");
  const tt = teamTypeMatchClause(teamType);
  const sql = [
    `WITH sides AS (`,
    `  SELECT team_1 AS team FROM matches WHERE gender = '${esc(gender)}'${tt}`,
    `  UNION ALL`,
    `  SELECT team_2 AS team FROM matches WHERE gender = '${esc(gender)}'${tt}`,
    `)`,
    `SELECT team AS value, team AS label, COUNT(*) AS games`,
    `FROM sides`,
    `WHERE team IS NOT NULL`,
    `GROUP BY team`,
    orderBy,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

/**
 * Distinct event_name values in `matches` for `gender`. games = match count;
 * latestDate = MAX(match_date). event_name is one label per tournament SERIES,
 * not per edition/year (verified against live data — e.g. "ICC Men's T20 World
 * Cup" spans matches dated 2014 through 2026 under the one name), so `games`
 * here is the event's full multi-year total, matching what the picker's
 * "games" column should mean for a series name.
 */
export async function searchEvents(term, gender, teamType = "both") {
  const orderBy = relevanceOrderBy("event_name", term, "games DESC, latestDate DESC, event_name ASC");
  const sql = [
    `SELECT event_name AS value, event_name AS label, COUNT(*) AS games, MAX(match_date) AS latestDate`,
    `FROM matches`,
    `WHERE gender = '${esc(gender)}' AND event_name IS NOT NULL${teamTypeMatchClause(teamType)}`,
    `GROUP BY event_name`,
    orderBy,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

/** Distinct venue values in `matches` for `gender`. games = match count. */
export async function searchVenues(term, gender, teamType = "both") {
  const orderBy = relevanceOrderBy("venue", term, "games DESC, venue ASC");
  const sql = [
    `SELECT venue AS value, venue AS label, COUNT(*) AS games`,
    `FROM matches`,
    `WHERE gender = '${esc(gender)}' AND venue IS NOT NULL${teamTypeMatchClause(teamType)}`,
    `GROUP BY venue`,
    orderBy,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

/** The player's profile row (null for the ~unmatched; profiles are men-only). */
export async function fetchProfile(playerId) {
  const { rows } = await query(`SELECT * FROM profiles WHERE player_id = '${esc(playerId)}'`);
  return rows[0] ?? null;
}

/**
 * A player's gender ('male' | 'female'), or null if the id has no rows at
 * all. Player-page/popup scope building (R4 Wave 2, header-search entry —
 * see playerPage.js's buildFixedScopeState) needs the SEARCHED PLAYER'S own
 * gender, never the table's current gender setting, so a women's player
 * found from a men's-view table still resolves correctly. One row is enough:
 * a player_id never appears under both genders (a player plays either men's
 * or women's cricket, never both, in this dataset), so any row's `gender`
 * column is authoritative — no GROUP BY/aggregation needed.
 *
 * Note this is currently a defensive/future-proofing value, not one that
 * changes any number rendered today: every player-page/popup query filters
 * by this exact player_id already (whereFor() below), so the gender column
 * is redundant to the result set regardless — see pageScopeClauses' own
 * `includeGender: false` a few lines up, which has always been true for
 * every entry path, not just the new header-search one.
 */
export async function fetchPlayerGender(playerId) {
  const { rows } = await query(`SELECT gender FROM player_matches WHERE player_id = '${esc(playerId)}' LIMIT 1`);
  return rows[0]?.gender ?? null;
}

const BATTING_SUMMARY_KEYS = ["innings", "runs", "average", "strike_rate", "balls_per_dismissal", "high_score"];
const BOWLING_SUMMARY_KEYS = ["innings", "wickets", "average", "economy", "strike_rate", "best"];
const SPLIT_BATTING_KEYS = ["innings", "runs", "average", "strike_rate"];
const SPLIT_BOWLING_KEYS = ["innings", "wickets", "average", "economy"];

const PROGRESSION_KEYS = ["sr_first10", "sr_11_20", "sr_21plus"];

/**
 * Batting summary + dismissal fingerprint + scoring progression, in ONE query
 * (Batch 5b C2): all three shared the exact same `FROM batting WHERE …`
 * aggregate with no GROUP BY, so they're one row of ~22 columns instead of
 * three round trips. The single returned row carries every field each of the
 * three render call-sites needs (innings/runs/average/… for the summary
 * cards, dismissals + each out_* kind for the fingerprint, sr_first10/11_20/
 * 21plus for the progression cards) — callers index it by name, so one
 * shared object serves all three call sites unchanged.
 */
export async function fetchBattingCore(playerId, state, overlay = null) {
  // `vs` cannot be answered from batting_innings (no bowling-type dimension):
  // switch the core-tile + how-out sections to matchup_batting. The progression
  // section has no matchup equivalent (matchup_batting carries no faced-ball
  // fb*_runs/balls columns), so it comes back refused inside the composite.
  if (requestedDims(overlay).includes("vs")) {
    return fetchBattingCoreVs(playerId, state, overlay);
  }
  const base = whereFor(state, "batter_id", playerId);
  // batting.core / .howout / .progression all live on batting_innings, which
  // carries batting_position + bowling_team + match_date → every non-vs dim is
  // honored; applyOverlay never refuses here.
  const ov = applyOverlay(base, overlay, { positionCol: "batting_position", oppositionCol: "bowling_team" });
  const kindSelects = DISMISSAL_KINDS.map((d) => `${expr("batting", d.key)} AS ${d.key}`).join(", ");
  const sql = [
    `SELECT ${selectList("batting", BATTING_SUMMARY_KEYS)}, SUM(dismissed) AS dismissals, ${kindSelects},`,
    `       ${selectList("batting", PROGRESSION_KEYS)}`,
    `FROM batting WHERE ${ov.where}`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows[0] ?? null;
}

// Core-tile + how-out keys recomputed from matchup_batting when a `vs` bucket is
// active. One no-GROUP-BY row serves both the tiles (summary) and the dismissal
// fingerprint (howout) — same shared-row pattern as the plain fetchBattingCore.
const VS_CORE_KEYS = [
  "innings", "balls", "runs", "strike_rate", "average", "dismissals", "dot_pct", "boundary_pct",
  "dis_bowled", "dis_lbw", "dis_caught", "dis_caught_and_bowled", "dis_stumped", "dis_hit_wicket",
];

/**
 * `vs`-scoped batting core: composed ENTIRELY from the matchup_batting
 * fragments already used by fetchBattingMatchups (coverage line + the
 * matchup_batting metric expressions) — no new aggregation shapes. Returns a
 * composite the popup UI reads section-by-section:
 *   { vs, source, coverage:{mapped,total}, summary, howout,
 *     progression:{ unsupported:["vs"] } }
 * `summary` and `howout` are the SAME single row (tiles read innings/balls/
 * runs/strike_rate/average/…, how-out reads dismissals + the dis_* kinds).
 * `coverage` is the overall style-data coverage across ALL balls in the
 * (date/positions/opposition-narrowed) scope — NOT the vs bucket — so the UI
 * shows "based on N of M balls faced" exactly like the Matchups section.
 */
async function fetchBattingCoreVs(playerId, state, overlay) {
  const base = whereFor(state, "batter_id", playerId);
  // date/positions/opposition narrowing on matchup_batting (which carries all
  // three columns). Strip vs here — it's applied only to the tiles/how-out row.
  const narrow = applyOverlay(base, { ...overlay, vs: null }, {
    positionCol: "batting_position",
    oppositionCol: "bowling_team",
  });
  const scopeWhere = narrow.where; // never refuses (all three columns present)
  const vsWhere = [scopeWhere, ...overlayVsClause(overlay)].join(" AND ");

  const coverageSql = [
    `SELECT SUM(balls_faced) AS total,`,
    `       SUM(balls_faced) FILTER (bowling_group <> '(unmapped)') AS mapped`,
    `FROM matchup_batting WHERE ${scopeWhere}`,
  ].join("\n");
  const coreSql = [
    `SELECT ${selectList("matchup_batting", VS_CORE_KEYS)}`,
    `FROM matchup_batting WHERE ${vsWhere}`,
  ].join("\n");

  const [covRes, coreRes] = await Promise.all([query(coverageSql), query(coreSql)]);
  const covRow = covRes.rows[0] ?? { mapped: 0, total: 0 };
  const row = coreRes.rows[0] ?? null;
  return {
    vs: overlay.vs,
    source: "matchup_batting",
    coverage: { mapped: covRow.mapped ?? 0, total: covRow.total ?? 0 },
    summary: row,
    howout: row,
    progression: { unsupported: ["vs"] },
  };
}

export async function fetchBattingPositions(playerId, state, overlay = null) {
  const base = whereFor(state, "batter_id", playerId);
  const ov = applyOverlay(base, overlay, { positionCol: "batting_position", oppositionCol: "bowling_team" });
  if (ov.unsupported) return { unsupported: ov.unsupported };
  const sql = [
    `SELECT batting_position AS position, ${selectList("batting", SPLIT_BATTING_KEYS)}`,
    `FROM batting WHERE ${ov.where}`,
    `GROUP BY batting_position ORDER BY batting_position`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

/** Every team type (owner task #20 — was international-only, decision 20;
 * that gate lived in the CALLER, playerPage.js's fetchDisciplineData, and has
 * been removed there, not here — this query itself never cared about team
 * type: `pageScopeClauses`/`whereFor` already apply whatever teamType the
 * page scope carries, same as every other player-page query). */
export async function fetchBattingOpposition(playerId, state, overlay = null) {
  const base = whereFor(state, "batter_id", playerId);
  const ov = applyOverlay(base, overlay, { positionCol: "batting_position", oppositionCol: "bowling_team" });
  if (ov.unsupported) return { unsupported: ov.unsupported };
  const sql = [
    `SELECT bowling_team AS team, ${selectList("batting", SPLIT_BATTING_KEYS)}`,
    `FROM batting WHERE ${ov.where}`,
    `GROUP BY bowling_team ORDER BY runs DESC, team`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

const WICKET_TYPE_KEYS = ["wkt_bowled", "wkt_lbw", "wkt_caught", "wkt_caught_and_bowled", "wkt_stumped", "wkt_hit_wicket"];

/**
 * Bowling summary + wicket-type breakdown in ONE query (Batch 5b C2): same
 * `FROM bowling WHERE …` aggregate with no GROUP BY, differing only in SELECT
 * list, so one row (12 columns) replaces two round trips. `wickets` is
 * selected once and read by both the summary cards and the wicket-types bars.
 */
export async function fetchBowlingCore(playerId, state, overlay = null) {
  const base = whereFor(state, "bowler_id", playerId);
  // bowling_innings has NO batting_position (a bowler has no batting position;
  // striker position lives only on matchup_bowling) → `positions` is refused
  // here. `vs` (a batting-discipline dim) is refused too. Opponent = batting_team.
  const ov = applyOverlay(base, overlay, { positionCol: null, oppositionCol: "batting_team" });
  if (ov.unsupported) return { unsupported: ov.unsupported };
  const sql = [
    `SELECT ${selectList("bowling", BOWLING_SUMMARY_KEYS)}, ${selectList("bowling", WICKET_TYPE_KEYS)}`,
    `FROM bowling WHERE ${ov.where}`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows[0] ?? null;
}

/** Every team type (owner task #20 — was international-only, decision 20;
 * see fetchBattingOpposition's comment above — same story, this query
 * already scopes by whatever teamType the page carries). */
export async function fetchBowlingOpposition(playerId, state, overlay = null) {
  const base = whereFor(state, "bowler_id", playerId);
  const ov = applyOverlay(base, overlay, { positionCol: null, oppositionCol: "batting_team" });
  if (ov.unsupported) return { unsupported: ov.unsupported };
  const sql = [
    `SELECT batting_team AS team, ${selectList("bowling", SPLIT_BOWLING_KEYS)}`,
    `FROM bowling WHERE ${ov.where}`,
    `GROUP BY batting_team ORDER BY wickets DESC, team`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

// ── Matchups (D4 R3) ─────────────────────────────────────────────────────────
// matchup_batting / matchup_bowling have the same scope columns as the plain
// innings views (they're built from `deliveries` with the same match-level
// filters), so pageScopeClauses(state) + an id-column filter applies as-is.
// The '(unmapped)' bucket exists on purpose for coverage (SPEC_ADDENDUM D4.3,
// decision 21): every stat must ship with "based on N of M balls" alongside
// it, so callers get `coverage` back and MUST render it next to the buckets —
// never show a matchup number without its coverage line.
const MATCHUP_BATTING_KEYS = metricsFor("matchup_batting").map((m) => m.key);
const MATCHUP_BOWLING_KEYS = metricsFor("matchup_bowling").map((m) => m.key);

/**
 * Batter vs bowling-style matchups. `coverage` = {mapped: N, total: M} balls
 * faced (M = all buckets, N = buckets with a mapped style — bowling_group <>
 * '(unmapped)'). `coarse` groups by bowling_group ('Pace'/'Spin' only, the
 * '(unmapped)' rows dropped); `fine` groups by the specific bowling_type
 * (also dropping '(unmapped)'; bare-slow bowlers surface as the group name
 * 'Pace'/'Spin' there per decision 24 — label via matchupBucketLabel()).
 */
export async function fetchBattingMatchups(playerId, state, overlay = null) {
  // matchup_batting carries batting_position + bowling_team + match_date, so
  // date/positions/opposition all narrow it. `vs` is REFUSED here on purpose:
  // this section IS the by-bowling-type breakdown, so pre-filtering it to a
  // single style would collapse the very thing it shows (the UI greys it with
  // "already viewing vs X above"). Matches PLAYER_SECTION_SUPPORT["batting.matchups"].
  const ov = applyOverlay(whereFor(state, "batter_id", playerId), overlay, {
    positionCol: "batting_position",
    oppositionCol: "bowling_team",
  });
  if (ov.unsupported) return { unsupported: ov.unsupported };
  const where = ov.where;
  const metricSelects = selectList("matchup_batting", MATCHUP_BATTING_KEYS);

  const coverageSql = [
    `SELECT SUM(balls_faced) AS total,`,
    `       SUM(balls_faced) FILTER (bowling_group <> '(unmapped)') AS mapped`,
    `FROM matchup_batting WHERE ${where}`,
  ].join("\n");
  const coarseSql = [
    `SELECT bowling_group AS bucket, ${metricSelects}`,
    `FROM matchup_batting WHERE ${where} AND bowling_group <> '(unmapped)'`,
    `GROUP BY bowling_group ORDER BY balls DESC`,
  ].join("\n");
  const fineSql = [
    `SELECT bowling_type AS bucket, ${metricSelects}`,
    `FROM matchup_batting WHERE ${where} AND bowling_type <> '(unmapped)'`,
    `GROUP BY bowling_type ORDER BY balls DESC`,
  ].join("\n");

  const [coverageRes, coarseRes, fineRes] = await Promise.all([
    query(coverageSql),
    query(coarseSql),
    query(fineSql),
  ]);
  const covRow = coverageRes.rows[0] ?? { mapped: 0, total: 0 };
  return {
    coverage: { mapped: covRow.mapped ?? 0, total: covRow.total ?? 0 },
    coarse: coarseRes.rows,
    fine: fineRes.rows,
  };
}

/**
 * Bowler vs batting-hand matchups. `coverage` = {mapped: N, total: M} balls
 * bowled (M = all buckets, N = buckets with a mapped hand — batting_hand <>
 * '(unmapped)'). `hands` groups by batting_hand, '(unmapped)' dropped.
 */
export async function fetchBowlingMatchups(playerId, state, overlay = null) {
  // matchup_bowling carries batting_position (the STRIKER's position faced) +
  // batting_team + match_date, so date/positions/opposition all narrow it
  // (positions = "vs batters at position N", decision 37). `vs` is a
  // batting-discipline dimension and never applies to a bowling section →
  // refused. Matches PLAYER_SECTION_SUPPORT["bowling.matchups"].
  const ov = applyOverlay(whereFor(state, "bowler_id", playerId), overlay, {
    positionCol: "batting_position",
    oppositionCol: "batting_team",
  });
  if (ov.unsupported) return { unsupported: ov.unsupported };
  const where = ov.where;
  const metricSelects = selectList("matchup_bowling", MATCHUP_BOWLING_KEYS);

  const coverageSql = [
    `SELECT SUM(balls) AS total,`,
    `       SUM(balls) FILTER (batting_hand <> '(unmapped)') AS mapped`,
    `FROM matchup_bowling WHERE ${where}`,
  ].join("\n");
  const handsSql = [
    `SELECT batting_hand AS bucket, ${metricSelects}`,
    `FROM matchup_bowling WHERE ${where} AND batting_hand <> '(unmapped)'`,
    `GROUP BY batting_hand ORDER BY balls DESC`,
  ].join("\n");

  const [coverageRes, handsRes] = await Promise.all([query(coverageSql), query(handsSql)]);
  const covRow = coverageRes.rows[0] ?? { mapped: 0, total: 0 };
  return {
    coverage: { mapped: covRow.mapped ?? 0, total: covRow.total ?? 0 },
    hands: handsRes.rows,
  };
}
