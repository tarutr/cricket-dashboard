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
// The probe SQL itself now lives in src/dataAvailability.js (ONE copy), shared with
// the NUMBERS-path resolver (Group 3): the same existence check decides both whether
// a filter is OFFERED (here) and — once resolved — how the query gates
// (matchupVsActive / profileSemiJoinSql) route. This module keeps only the
// offer-path caching/optimistic-getter that the palette + singleton-presence checks
// read; it maps the shared probes to its own offer-path key names.
//
// MECHANISM mirrors the existing getVsBowlingTypes / ensureVsBowlingTypesLoaded
// pattern: an async load fills a per-gender cache; a SYNCHRONOUS getter the (sync)
// palette builder + singleton-presence check read. Each surface (the leaderboard
// drawer + the player pop-up editor) creates ONE instance and wires its two hooks
// into createPaletteGroupsBuilder.

import { probeMatchup, probeProfile } from "./dataAvailability.js";

// The availability keys the palette leaves + singleton rows consult.
// profileBowlingArm (owner #8, columns rejig wave C): the "Bowling hand"
// filter, mirroring profileBowling's own probe/offer wiring exactly.
export const AVAIL_KEYS = ["vsBowlingStyle", "vsBattingHand", "profileRole", "profileHand", "profileBowling", "profileBowlingArm"];

// Cache/probe signature: gender is the only axis (formats fixed to ALL_FORMATS).
const genderSig = (s) => (s && s.gender) || "male";

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
      probeProfile("bowling_arm", g),
    ])
      .then(([vsB, vsH, pR, pH, pBowl, pBowlArm]) => {
        if (loadingSig !== g) return; // a newer load (gender switched) owns the cache
        sig = g;
        avail = { vsBowlingStyle: vsB, vsBattingHand: vsH, profileRole: pR, profileHand: pH, profileBowling: pBowl, profileBowlingArm: pBowlArm };
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
