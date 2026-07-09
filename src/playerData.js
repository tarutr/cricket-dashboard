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

/**
 * Substring player search across ALL players (both genders), profile-enriched.
 * Names come from player_matches, not the players registry: a player can
 * appear under several names over time (e.g. NR Sciver → NR Sciver-Brunt, and
 * players.parquet keeps only the oldest). We match against EVERY name the
 * player has appeared under and display the most recent one, so both the
 * maiden and current names find the same person. player_matches also covers
 * players who were selected but never batted or bowled (decision 9).
 */
export async function searchPlayers(term) {
  const t = (term || "").trim();
  if (t.length < 2) return [];
  const sql = [
    `WITH latest AS (`,
    `  SELECT player_id AS id, arg_max(player_name, match_date) AS name`,
    `  FROM player_matches GROUP BY player_id`,
    `), hits AS (`,
    `  SELECT DISTINCT player_id AS id FROM player_matches WHERE player_name ILIKE '%${esc(t)}%'`,
    `)`,
    `SELECT l.id, l.name, pr.country AS country, pr.playing_role AS playing_role`,
    `FROM hits h JOIN latest l ON l.id = h.id`,
    `LEFT JOIN profiles pr ON pr.player_id = l.id`,
    `ORDER BY l.name`,
    `LIMIT 25`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

/** The player's profile row (null for the ~unmatched; profiles are men-only). */
export async function fetchProfile(playerId) {
  const { rows } = await query(`SELECT * FROM profiles WHERE player_id = '${esc(playerId)}'`);
  return rows[0] ?? null;
}

const BATTING_SUMMARY_KEYS = ["innings", "runs", "average", "strike_rate", "balls_per_dismissal", "high_score"];
const BOWLING_SUMMARY_KEYS = ["innings", "wickets", "average", "economy", "strike_rate", "best"];
const SPLIT_BATTING_KEYS = ["innings", "runs", "average", "strike_rate"];
const SPLIT_BOWLING_KEYS = ["innings", "wickets", "average", "economy"];

/** One row of batting totals in scope; `innings` = 0 means no batting here. */
export async function fetchBattingSummary(playerId, state) {
  const sql = `SELECT ${selectList("batting", BATTING_SUMMARY_KEYS)} FROM batting WHERE ${whereFor(state, "batter_id", playerId)}`;
  const { rows } = await query(sql);
  return rows[0] ?? null;
}

export async function fetchBattingPositions(playerId, state) {
  const sql = [
    `SELECT batting_position AS position, ${selectList("batting", SPLIT_BATTING_KEYS)}`,
    `FROM batting WHERE ${whereFor(state, "batter_id", playerId)}`,
    `GROUP BY batting_position ORDER BY batting_position`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

/** International only (decision 20) — callers gate on teamType and grey otherwise. */
export async function fetchBattingOpposition(playerId, state) {
  const sql = [
    `SELECT bowling_team AS team, ${selectList("batting", SPLIT_BATTING_KEYS)}`,
    `FROM batting WHERE ${whereFor(state, "batter_id", playerId)}`,
    `GROUP BY bowling_team ORDER BY runs DESC, team`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows;
}

/**
 * Dismissal fingerprint: innings, total dismissals, and one count per kind
 * (keys from metrics.js's DISMISSAL_KINDS — the 12 kinds partition
 * SUM(dismissed) exactly; not-outs = innings − dismissals).
 */
export async function fetchBattingDismissals(playerId, state) {
  const kindSelects = DISMISSAL_KINDS.map((d) => `${expr("batting", d.key)} AS ${d.key}`).join(", ");
  const sql = [
    `SELECT COUNT(*) AS innings, SUM(dismissed) AS dismissals, ${kindSelects}`,
    `FROM batting WHERE ${whereFor(state, "batter_id", playerId)}`,
  ].join("\n");
  const { rows } = await query(sql);
  return rows[0] ?? null;
}

export async function fetchBattingProgression(playerId, state) {
  const keys = ["sr_first10", "sr_11_20", "sr_21plus"];
  const sql = `SELECT ${selectList("batting", keys)} FROM batting WHERE ${whereFor(state, "batter_id", playerId)}`;
  const { rows } = await query(sql);
  return rows[0] ?? null;
}

/** One row of bowling totals in scope; `innings` = 0 means no bowling here. */
export async function fetchBowlingSummary(playerId, state) {
  const sql = `SELECT ${selectList("bowling", BOWLING_SUMMARY_KEYS)} FROM bowling WHERE ${whereFor(state, "bowler_id", playerId)}`;
  const { rows } = await query(sql);
  return rows[0] ?? null;
}

export async function fetchBowlingWicketTypes(playerId, state) {
  const keys = ["wickets", "wkt_bowled", "wkt_lbw", "wkt_caught", "wkt_caught_and_bowled", "wkt_stumped", "wkt_hit_wicket"];
  const sql = `SELECT ${selectList("bowling", keys)} FROM bowling WHERE ${whereFor(state, "bowler_id", playerId)}`;
  const { rows } = await query(sql);
  return rows[0] ?? null;
}

/** International only (decision 20) — callers gate on teamType and grey otherwise. */
export async function fetchBowlingOpposition(playerId, state) {
  const sql = [
    `SELECT batting_team AS team, ${selectList("bowling", SPLIT_BOWLING_KEYS)}`,
    `FROM bowling WHERE ${whereFor(state, "bowler_id", playerId)}`,
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
export async function fetchBattingMatchups(playerId, state) {
  const where = whereFor(state, "batter_id", playerId);
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
export async function fetchBowlingMatchups(playerId, state) {
  const where = whereFor(state, "bowler_id", playerId);
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
