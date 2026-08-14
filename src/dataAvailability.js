// src/dataAvailability.js
//
// Shared DATA-PRESENCE probes + the NUMBERS-PATH availability resolver
// (owner directive 2026-08-06: "there's no reason for this to be men only. It
// needs to be data only"). Group 3 of the gender→data work.
//
// TWO consumers share the ONE copy of the probe SQL that lives here:
//   1. src/filterAvailability.js — the OFFER path (whether a profile/matchup "Vs"
//      filter is SHOWN). It imports probeMatchup / probeProfile from here.
//   2. This module's own resolveDataAvail() — the NUMBERS path. It fills the
//      per-gender bools that state.js's matchupVsActive / profileSemiJoinSql now
//      gate on (in place of the old `gender === "male"` / `gender === "female"`
//      hardcodes). main.js wires resolveDataAvail into boot + gender-switch +
//      the Search commit path (see there).
//
// AXIS = GENDER (all formats). Whether profile/matchup data exists at all is a
// property of gender, not format/date/team-type — men's records carry it across
// every format, women's carry none. So the probes fix formats to ALL buckets and
// vary only gender (identical reasoning to filterAvailability.js's header). Cheap
// EXISTENCE checks (`SELECT 1 … LIMIT 1`), never a full DISTINCT scan.
//
// This module has NO import from state.js beyond the FORMAT_BUCKETS constant and
// NONE from filterAvailability.js, so no import cycle is introduced (state.js does
// not import back here — its gate functions only READ the plain `state.dataAvail`
// field the resolver writes onto the store).

import { query } from "./db.js";
import { buildCoreScopeClauses } from "./filters.js";
import { FORMAT_BUCKETS } from "./state.js";

// All format buckets — the probes restrict by gender only (see AXIS note above).
const ALL_FORMATS = FORMAT_BUCKETS.map((b) => b.key);

// Core scope for the gender (gender + every format). buildCoreScopeClauses reads
// only gender/match_type/date/team_type; here just gender + all formats apply.
const coreFor = (gender) => buildCoreScopeClauses({ gender, formats: ALL_FORMATS }).join(" AND ");

/**
 * A MATCHUP dim exists for the gender iff there is at least one MAPPED (non-
 * '(unmapped)') value in scope. Fast existence check; mirrors the drawer's
 * vs-bowling-type loader's '(unmapped)' exclusion. Women's matchup rows key every
 * bowler/batter to '(unmapped)' (no profiles), so this is false for them today.
 * `source`/`column` are trusted internal literals (never user input).
 */
export async function probeMatchup(source, column, gender) {
  const sql =
    `SELECT 1 FROM ${source} ` +
    `WHERE ${coreFor(gender)} AND ${column} IS NOT NULL AND ${column} <> '(unmapped)' LIMIT 1`;
  const { rows } = await query(sql);
  return rows.length > 0;
}

/**
 * A PROFILE dim exists for the gender iff at least one player who played in the
 * gender's scope has a non-null value. `profiles` carries no gender/scope columns,
 * so it is gender-scoped via a `player_matches` semi-join (player_matches DOES
 * carry gender + the core-scope columns). `column` is a trusted internal literal
 * (never user input). Women have no profile rows today → false; when they do, this
 * returns true → the gate opens with no code change.
 */
export async function probeProfile(column, gender) {
  const sql =
    `SELECT 1 FROM profiles p ` +
    `WHERE p.${column} IS NOT NULL ` +
    `AND p.player_id IN (SELECT DISTINCT player_id FROM player_matches WHERE ${coreFor(gender)}) LIMIT 1`;
  const { rows } = await query(sql);
  return rows.length > 0;
}

/**
 * FIELDING DATA exists for the gender iff there is at least one NON-SUBSTITUTE
 * wicket-credit row in scope — the population the fielding leaderboard (3rd scope)
 * and the sacred fielding CTE rank over (buildFieldingCteSql excludes substitutes).
 * Fast existence check (LIMIT 1), gender-only axis like the matchup/profile probes.
 * Fielding events come from wicket_fielders (fielder_id + kind), which — unlike the
 * men-only PROFILE tables — exist for every match, so this is true for BOTH genders
 * today; the gate is DATA-driven (not gender-hardcoded), so it stays correct if a
 * gender ever has no fielding data.
 */
export async function probeFielding(gender) {
  const sql =
    `SELECT 1 FROM fielding ` +
    `WHERE ${coreFor(gender)} AND substitute IS NOT TRUE LIMIT 1`;
  const { rows } = await query(sql);
  return rows.length > 0;
}

// ── Fielding SCHEMA-column presence (FC-2, Bowler Style composer gate) ────────
// The fielding Bowler Style composer reads fielding.bowling_group / bowling_type,
// which exist ONLY after the data pipeline re-runs + re-uploads the parquet (FC-1b).
// So the UI entry is gated on the COLUMN's presence — hidden now, auto-appears once
// the parquet carries it (data-driven, cross-gender, NO hardcode). This is a SCHEMA
// probe against information_schema — deliberately NOT `WHERE bowling_group IS NOT
// NULL`, which THROWS when the column is absent. `column` is a trusted internal
// literal (never user input). Cached once per session; the SYNC getter defaults
// FALSE (hidden) until the async probe confirms presence.
const _fieldingColPresent = new Map(); // column -> bool (resolved)
const _fieldingColPending = new Map(); // column -> Promise (dedupe in-flight)

export async function probeFieldingColumn(column) {
  const sql =
    `SELECT 1 FROM information_schema.columns ` +
    `WHERE table_name = 'fielding' AND column_name = '${column}' LIMIT 1`;
  const { rows } = await query(sql);
  return rows.length > 0;
}

/** SYNC. Cached presence of fielding.<column>; FALSE until the probe resolves, so a
 * gated UI entry stays hidden until the column is confirmed present. */
export function getFieldingColumnPresent(column) {
  return _fieldingColPresent.get(column) === true;
}

/** ASYNC (idempotent). Probe fielding.<column> once and cache the bool, then call
 * onReady() so a mounted surface can re-render (revealing the entry). A failed probe
 * leaves the column UNresolved (stays hidden) and allows a later retry. */
export function ensureFieldingColumnProbed(column, onReady) {
  if (_fieldingColPresent.has(column)) {
    if (onReady) onReady();
    return;
  }
  if (_fieldingColPending.has(column)) return;
  const p = probeFieldingColumn(column)
    .then((present) => {
      _fieldingColPresent.set(column, present);
      _fieldingColPending.delete(column);
      if (onReady) onReady();
    })
    .catch(() => {
      _fieldingColPending.delete(column);
    });
  _fieldingColPending.set(column, p);
}

// ── Numbers-path resolver ────────────────────────────────────────────────────
// Resolves the five bools state.js's gates key on, per gender, and caches them
// (gender is the only axis). The cache is module-level so BOTH surfaces that need
// it (the leaderboard store + any prewarm) share ONE resolution per gender and
// never re-probe. The keys here (matchupBatting/matchupBowling/…) are the numbers-
// path names; filterAvailability.js maps the SAME probes to its own offer-path
// names (vsBowlingStyle/vsBattingHand/…).

const _cache = new Map(); // gender -> { matchupBatting, matchupBowling, profileRole, profileHand, profileBowling, fielding }
const _pending = new Map(); // gender -> Promise (dedupe in-flight loads)

/** SYNC. The resolved availability object for `gender`, or null if not yet
 * resolved. Lets a caller (main.js's gender-switch sync) read the cache without
 * awaiting, so the store can be updated in the same tick and no reader sees a
 * transient. */
export function getResolvedDataAvail(gender) {
  return _cache.get(gender || "male") || null;
}

/** ASYNC. Resolve (once, then cached) the five data-presence bools for `gender`.
 * Never rejects for the caller's convenience beyond the underlying probe — callers
 * that must not block on a probe failure catch it and fall back to the optimistic
 * default (see state.js dataAvailBool). */
export function resolveDataAvail(gender) {
  const g = gender || "male";
  if (_cache.has(g)) return Promise.resolve(_cache.get(g));
  if (_pending.has(g)) return _pending.get(g);
  const p = Promise.all([
    probeMatchup("matchup_batting", "bowling_type", g),
    probeMatchup("matchup_bowling", "batting_hand", g),
    probeProfile("role_group", g),
    probeProfile("batting_style", g),
    probeProfile("bowling_type", g),
    probeFielding(g),
  ])
    .then(([matchupBatting, matchupBowling, profileRole, profileHand, profileBowling, fielding]) => {
      const avail = { matchupBatting, matchupBowling, profileRole, profileHand, profileBowling, fielding };
      _cache.set(g, avail);
      _pending.delete(g);
      return avail;
    })
    .catch((e) => {
      _pending.delete(g); // allow a later retry
      throw e;
    });
  _pending.set(g, p);
  return p;
}
