// src/filterAvailability.js
//
// DATA-DRIVEN filter availability (owner ruling 2026-08-03, "remove the hardcode
// everywhere"). Whether a PROFILE-derived filter (Playing role / Batting hand /
// Bowling style) or a MATCHUP "Vs" filter (vs bowling style / vs batting hand) is
// OFFERED is decided by whether its underlying DATA exists for the current scope —
// NEVER a `if (gender === "female")` hardcode. Men have profile + matchup data →
// the filters are offered; women (today) have none → the filters are absent
// (identical to today's behaviour); when women's profile data lands the SAME probe
// returns "present" → every affected filter auto-appears with NO code change.
//
// DISPLAY / OFFER-LOGIC ONLY — numbers are sacred (CLAUDE.md Rule 1). Nothing here
// touches buildQuery / buildMatchupQuery / buildScopeClauses / conditionToHaving /
// profileSemiJoinSql / matchupVsActive; these probes only decide WHETHER a filter
// is shown, never WHAT a query counts.
//
// AXIS = GENDER (all formats). The dimension that decides whether profile/matchup
// data exists at all is gender, not format/date/team-type — men's records carry it
// across every format, women's carry none. So the probes fix formats to ALL buckets
// and vary only gender: this reproduces today's behaviour for EVERY scope (men
// always offered / women never) and never hides a filter for a men scope that a
// narrow date/format window happens to be sparse in. Data-driven, not hardcoded.
//
// The probes are cheap EXISTENCE checks (`SELECT 1 … LIMIT 1`) — NOT the full
// DISTINCT-values load loadDimOptions does — because the offered set must settle
// fast enough that the palette opens already-correct (a full DISTINCT scan of the
// ~900k-row matchup table took ~2s and lost the race). They mirror loadDimOptions'
// scope handling (buildCoreScopeClauses) and its '(unmapped)' exclusion; the
// distinct-values loaders that POPULATE the vs-style variants stay as they are.
//
// MECHANISM mirrors the existing getVsBowlingTypes / ensureVsBowlingTypesLoaded
// pattern: an async load fills a per-gender cache; a SYNCHRONOUS getter the (sync)
// palette builder + singleton-presence check read. Each surface (the leaderboard
// drawer + the player pop-up editor) creates ONE instance and wires its two hooks
// into createPaletteGroupsBuilder.

import { query } from "./db.js";
import { buildCoreScopeClauses } from "./filters.js";
import { FORMAT_BUCKETS } from "./state.js";

// The five availability keys the palette leaves + singleton rows consult.
export const AVAIL_KEYS = ["vsBowlingStyle", "vsBattingHand", "profileRole", "profileHand", "profileBowling"];

// All format buckets — the probes restrict by gender only (see AXIS note above).
const ALL_FORMATS = FORMAT_BUCKETS.map((b) => b.key);

// Cache/probe signature: gender is the only axis (formats fixed to ALL_FORMATS).
const genderSig = (s) => (s && s.gender) || "male";

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
async function probeMatchup(source, column, gender) {
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
 * returns true → the filter auto-appears.
 */
async function probeProfile(column, gender) {
  const sql =
    `SELECT 1 FROM profiles p ` +
    `WHERE p.${column} IS NOT NULL ` +
    `AND p.player_id IN (SELECT DISTINCT player_id FROM player_matches WHERE ${coreFor(gender)}) LIMIT 1`;
  const { rows } = await query(sql);
  return rows.length > 0;
}

/**
 * One availability instance per surface. Returns:
 *   isAvailable(key, s)      — SYNC. The cached bool for s's gender; OPTIMISTICALLY
 *                              true before the async load resolves (so men never
 *                              flicker, and women's rows stay hidden anyway — their
 *                              state carries no profile/matchup value and the palette
 *                              rebuilds the instant availability resolves). No gender ref.
 *   ensureLoaded(s, onReady) — kicks off (idempotently) the async load for s's
 *                              gender; on resolve for the CURRENT gender it caches
 *                              the five bools and calls onReady() so the surface
 *                              re-renders its palette + singleton rows.
 */
export function createFilterAvailability() {
  let sig = null; // gender the cache reflects
  let avail = null; // { key: bool } once loaded for `sig`
  let loadingSig = null; // gender of an in-flight load (dedupe)

  function isAvailable(key, s) {
    if (avail && sig === genderSig(s)) return Boolean(avail[key]);
    return true; // optimistic until loaded — see doc above
  }

  function ensureLoaded(s, onReady) {
    const g = genderSig(s);
    if (sig === g && avail) return; // already loaded for this gender
    if (loadingSig === g) return; // load in flight for this gender
    loadingSig = g;
    Promise.all([
      probeMatchup("matchup_batting", "bowling_type", g),
      probeMatchup("matchup_bowling", "batting_hand", g),
      probeProfile("role_group", g),
      probeProfile("batting_style", g),
      probeProfile("bowling_type", g),
    ])
      .then(([vsB, vsH, pR, pH, pBowl]) => {
        if (loadingSig !== g) return; // a newer load (gender switched) owns the cache
        sig = g;
        avail = { vsBowlingStyle: vsB, vsBattingHand: vsH, profileRole: pR, profileHand: pH, profileBowling: pBowl };
        loadingSig = null;
        if (onReady) onReady();
      })
      .catch(() => {
        // Leave the cache optimistic (true) so a later ensureLoaded retries; a
        // failed probe must never hard-hide a filter that should be offered.
        if (loadingSig === g) loadingSig = null;
      });
  }

  return { isAvailable, ensureLoaded };
}
