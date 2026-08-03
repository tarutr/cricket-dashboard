// src/opponentFilter.js
//
// Player pop-up "Filters" tab — Wave T-1 (owner decision 70). THE opponent-player
// head-to-head PREDICATE engine: turns "subject X vs opponent Y" into the
// ball-level SQL predicate db.js pushes into the ball-engine reconstruction's base
// ball CTE — composed alongside the delivery-window predicate on the very same
// `windowPredicate` hook (src/deliveryWindow.js / src/ballEngine.js /
// src/ballEngineMatchup.js). NO UI lives here; the drawer picker lives in
// src/drawerInnings.js (mountOpponentPlayer) and the palette leaf in
// src/paletteGroups.js. This module owns ONLY the id→predicate mapping, so a
// validation assertion can test it standalone.
//
// ── What the filter restricts (decision 70) ──────────────────────────────────
// It narrows the counted BALLS to those against ONE specific opponent player Y —
// the OPPOSITE role from the subject:
//   • subject BATTING (batting / matchup_batting): balls Y BOWLED   → `bowler_id = Y`
//   • subject BOWLING (bowling / matchup_bowling): balls Y BATTED   → `batter_id = Y`
// The discipline is supplied by db.js from the engine view a query reads (the same
// way the delivery-window player clock is picked), so ONE opponent spec produces
// the bowler-id predicate for a batting query and the batter-id predicate for a
// bowling query.
//
// Ball-engine ONLY: bowler_id / batter_id are per-delivery source columns, absent
// from the pre-summed innings parquets — so the filter is flag-gated (`?engine=ball`)
// exactly like the delivery-window / Ball Ranges group. It lands in the base ball
// CTE's WHERE and reads only SOURCE columns, so — like the window — it needs no
// entry in the engine's lean projection and column pruning cannot defeat it.
//
// ── The spec (a plain object) ────────────────────────────────────────────────
//   null / undefined / {id: null} ⇒ "" (no predicate). This "" is the no-opponent
//   invariant: db.js AND-composes nothing, so every number is byte-identical to
//   today. Active shape: { id: "<registry id>", name: "<display name>" } — only
//   `id` reaches SQL; `name` is display-only (the pill / scope label).

/** The OPPOSITE-role id column per engine discipline — the column the opponent
 * equality is written against. Note this is the MIRROR of db.js's PLAYER_ID_COL
 * (which pins the SUBJECT): the subject batter faces the opponent BOWLER, the
 * subject bowler is faced by the opponent BATTER. */
export const OPPONENT_ID_COL = {
  batting: "bowler_id",
  matchup_batting: "bowler_id",
  bowling: "batter_id",
  matchup_bowling: "batter_id",
};

/** True when an opponent spec carries no active pick (null/undefined or no id). */
export function isEmptyOpponent(opp) {
  return !opp || opp.id == null || opp.id === "";
}

/**
 * Build the ball-level SQL predicate for an opponent `opp` under `discipline`
 * (which selects the opposite-role id column). Returns "" for an empty spec — the
 * no-opponent invariant, so db.js composes nothing and the reconstruction stays
 * byte-identical.
 *
 * The player id is a Cricsheet registry id sourced from the controlled
 * player-search picker; single quotes are still escaped defensively (a registry
 * id never contains one, but the predicate must never be an injection surface).
 *
 * @param {{id:string,name?:string}|null} opp  the opponent spec — empty ⇒ "".
 * @param {"batting"|"bowling"|"matchup_batting"|"matchup_bowling"} discipline
 * @returns {string} a SQL boolean predicate (e.g. `bowler_id = 'abc123'`), or "".
 */
export function opponentPlayerPredicate(opp, discipline) {
  if (isEmptyOpponent(opp)) return "";
  const col = OPPONENT_ID_COL[discipline];
  if (!col) throw new Error(`opponentFilter: unknown discipline "${discipline}"`);
  const lit = String(opp.id).replace(/'/g, "''");
  return `${col} = '${lit}'`;
}
