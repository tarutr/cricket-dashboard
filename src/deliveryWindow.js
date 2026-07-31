// src/deliveryWindow.js
//
// Ball-grain rebuild — Wave 3 (owner decision 67). THE delivery-window PREDICATE
// engine: turns a window SPEC into the ball-level SQL predicate that db.js pushes
// into the ball-engine reconstruction's base ball CTE — the `windowPredicate`
// hook that src/ballEngine.js and src/ballEngineMatchup.js added present-but-EMPTY
// in Waves 2a/2b. NO UI lives here; the drawer controls (four separate "+ Add
// condition" entries) live in src/drawerInnings.js.
//
// ── What a window is (decision 67) ──────────────────────────────────────────
// A window restricts which BALLS a search counts, so every windowed number is
// computed natively from the in-window balls, and — because the predicate lands
// in the BASE ball CTE, before the crease/aggregation — the reconstruction yields
// exactly the innings with ≥1 in-window ball (decision-67's innings rule). Windows
// DEFINE the numbers, so pins obey them (the WHO-not-WHAT rule) — that is enforced
// by db.js pushing the same predicate into every view a query reads.
//
// ── The spec (a plain object; every piece optional; they COMPOSE with AND) ────
// UI-A REWORK (owner, 2026-07-31): the window is now FOUR independent, freely
// composing pieces rather than a single-mode {team:{mode,…},player}. A Phase|Overs|
// Balls mode-TOGGLE forces one mode and breaks the uniform per-filter pattern —
// replaced with four separate filter entries, each writing/reading its OWN piece:
//   {
//     phase?:  ('pp'|'mid'|'death')[],   // format-native phase (multi-select)
//     overs?:  { from: int>=1, to: int>=from },   // 1-based over numbers
//     balls?:  { from: int>=1, to: int>=from },    // 1-based legal-ball ordinal
//     player?: { edge: 'first'|'last', n: int>=1 }, // first/last N faced|bowled
//   }
// `null` / `undefined` / `{}` (and any spec whose pieces are all absent) ⇒ "" (no
// predicate). This "" is the CRITICAL no-window invariant: db.js AND-composes
// nothing, so the reconstruction — and every number — is byte-identical to today.
//
// The per-piece SQL is UNCHANGED from the signed-off engine wave (the numbers were
// verified against raw balls there); only the spec SHAPE changed, so the four
// pieces can now be picked and combined independently. A contradictory combination
// (e.g. phase=Powerplay AND overs 15–20) yields an honest empty — it is never
// special-cased.
//
// ── TEAM clocks (discipline-INDEPENDENT; same ball columns for batting & bowling)
//   • phase  → the stored `phase` column. VERIFIED format-native (Wave 3, against
//     data/wave1_out): T20 6-ball pp=overs 0–5 / mid=6–14 / death=15–19; ODI
//     pp=overs 0–9 / mid=10–39 / death=40–49; The Hundred (balls_per_over=5)
//     pp=team_ball 1–25 / mid=26–75 / death=76+; RED BALL `phase` IS NULL for every
//     ball (so a phase window matches nothing on red ball — consistent with the
//     UI gating "red ball offers Over range only"); super-over balls also carry
//     NULL phase (and are excluded in the base CTE regardless).
//   • overs  → `over_number BETWEEN from-1 AND to-1` (over 1 = over_number 0;
//     per-innings; the only delivery filter offered in every format incl. red ball).
//   • balls  → `team_ball BETWEEN from AND to` (team_ball = the legal-ball ordinal;
//     wides AND no-balls do NOT advance it — an extra rides into the UPCOMING legal
//     slot, decision 67 — so a boundary-adjacent wide falls in the slot it precedes;
//     The Hundred is handled natively by this ordinal).
//
// ── PLAYER clock (discipline-DEPENDENT; offered in ALL formats) ──────────────
//   batting / matchup_batting → the striker faced-ball ordinal:
//     first N  → `bat_ball BETWEEN 1 AND n`      (wides excluded, no-balls INCLUDED per §4.1)
//     last  N  → `bat_ball_rev BETWEEN 1 AND n`  (rev counts from the batter's LAST faced ball;
//                                                 trailing wides carry rev=0 → correctly excluded)
//   bowling / matchup_bowling → the bowler legal-ball ordinal within the innings:
//     first N  → `bowl_ball BETWEEN 1 AND n`
//     last  N  → `bowl_ball_rev BETWEEN 1 AND n`
//   The discipline is supplied by db.js from the active namespace (the view the
//   query reads), so the same spec produces the batter clock for a batting query
//   and the bowler clock for a bowling query.
//
// ── Valid format × piece combinations (GATING is a UI concern — NOT enforced here)
// The generator faithfully builds whatever spec it is handed. Decision 67's gating
// (enforced by the drawer): Phase + Ball range only for T20 and 50-Over; Over range
// for all formats (and the ONLY delivery filter on red ball); the player clock in
// all formats. Any subset composes. This module documents the rules; it does not
// police them — an out-of-gate piece (e.g. a phase window on red ball) still builds
// a valid predicate (it just matches no red-ball balls, phase being NULL there).

/** Canonical phase order — the ONLY three legal `phase` values, listed so a spec
 * with phases in any order yields a byte-stable predicate (stable cache key). */
const PHASES_CANON = ["pp", "mid", "death"];
const PHASE_SET = new Set(PHASES_CANON);

/** The four independent window pieces, in canonical order (drives token/scope
 * ordering, and the applied-pill order in pills.js). */
export const DELIVERY_WINDOW_KEYS = ["phase", "overs", "balls", "player"];

/** The first/last player-clock ball columns per engine namespace. */
const PLAYER_CLOCK_COLUMNS = {
  batting: { first: "bat_ball", last: "bat_ball_rev" },
  matchup_batting: { first: "bat_ball", last: "bat_ball_rev" },
  bowling: { first: "bowl_ball", last: "bowl_ball_rev" },
  matchup_bowling: { first: "bowl_ball", last: "bowl_ball_rev" },
};

/** Coerce to an integer ≥ `min`, or throw a clear error. Windows are
 * numbers-critical: a malformed active spec is a programming error and must fail
 * LOUD rather than silently emit a wrong-but-valid predicate. */
function intAtLeast(value, min, label) {
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`deliveryWindow: ${label} must be an integer (got ${JSON.stringify(value)})`);
  }
  if (n < min) {
    throw new Error(`deliveryWindow: ${label} must be ≥ ${min} (got ${n})`);
  }
  return n;
}

/** True for an active phase piece (a non-empty array). */
function hasPhase(spec) {
  return Boolean(spec && Array.isArray(spec.phase) && spec.phase.length > 0);
}

/** The phase-clock predicate — `phase IN (…)` over a whitelist of canonical
 * literals (no escaping needed, no injection surface; stable regardless of input
 * order). VERBATIM the SQL the engine wave verified. */
function phasePredicate(phases) {
  if (!Array.isArray(phases) || phases.length === 0) {
    throw new Error("deliveryWindow: phase clock needs a non-empty phase[]");
  }
  const chosen = new Set();
  for (const p of phases) {
    if (!PHASE_SET.has(p)) {
      throw new Error(`deliveryWindow: unknown phase "${p}" (expected pp | mid | death)`);
    }
    chosen.add(p);
  }
  const list = PHASES_CANON.filter((p) => chosen.has(p)).map((p) => `'${p}'`);
  return `phase IN (${list.join(", ")})`;
}

/** The overs-clock predicate — `over_number BETWEEN from-1 AND to-1` (over 1 is
 * stored as over_number 0). VERBATIM the engine-verified SQL. */
function oversPredicate(overs) {
  if (!overs || typeof overs !== "object") {
    throw new Error("deliveryWindow: overs clock must be an object");
  }
  const from = intAtLeast(overs.from, 1, "overs.from");
  const to = intAtLeast(overs.to, 1, "overs.to");
  if (to < from) throw new Error(`deliveryWindow: overs.to (${to}) must be ≥ overs.from (${from})`);
  return `over_number BETWEEN ${from - 1} AND ${to - 1}`;
}

/** The balls-clock predicate — `team_ball BETWEEN from AND to` (legal-ball
 * ordinal). VERBATIM the engine-verified SQL. */
function ballsPredicate(balls) {
  if (!balls || typeof balls !== "object") {
    throw new Error("deliveryWindow: balls clock must be an object");
  }
  const from = intAtLeast(balls.from, 1, "balls.from");
  const to = intAtLeast(balls.to, 1, "balls.to");
  if (to < from) throw new Error(`deliveryWindow: balls.to (${to}) must be ≥ balls.from (${from})`);
  return `team_ball BETWEEN ${from} AND ${to}`;
}

/** The PLAYER-clock predicate for a player piece, using `discipline`'s clock cols. */
function playerPredicate(player, discipline) {
  if (!player || typeof player !== "object") {
    throw new Error("deliveryWindow: player clock must be an object");
  }
  const cols = PLAYER_CLOCK_COLUMNS[discipline];
  if (!cols) {
    throw new Error(`deliveryWindow: unknown discipline "${discipline}"`);
  }
  if (player.edge !== "first" && player.edge !== "last") {
    throw new Error(`deliveryWindow: player.edge must be "first" or "last" (got ${JSON.stringify(player.edge)})`);
  }
  const n = intAtLeast(player.n, 1, "player.n");
  const col = player.edge === "first" ? cols.first : cols.last;
  return `${col} BETWEEN 1 AND ${n}`;
}

/** True when a spec carries no active piece (null/undefined/{} or all-absent). */
export function isEmptyDeliveryWindow(spec) {
  if (!spec) return true;
  return !hasPhase(spec) && !spec.overs && !spec.balls && !spec.player;
}

/**
 * Build the ball-level SQL predicate for a delivery-window `spec` under
 * `discipline` (which selects the player-clock columns). The active pieces AND
 * together. Returns "" for a null/empty spec — the no-window invariant, so db.js
 * composes nothing and the reconstruction stays byte-identical.
 *
 * The returned predicate reads ONLY raw ball (source) columns (phase /
 * over_number / team_ball / bat_ball[_rev] / bowl_ball[_rev]), so — like the
 * scope predicate — it needs no entry in the engine's lean base projection: it is
 * evaluated in the base CTE's WHERE against the parquet source before projection.
 *
 * A single-piece spec emits exactly the clause the signed-off engine wave verified
 * (e.g. `(phase IN ('death'))`); a multi-piece spec ANDs those verbatim clauses in
 * canonical order — so every equivalent window reproduces the verified numbers.
 *
 * @param {object|null} spec  the window spec (see the header) — null/empty ⇒ "".
 * @param {"batting"|"bowling"|"matchup_batting"|"matchup_bowling"} discipline
 * @returns {string} a SQL boolean predicate, or "" for no window.
 */
export function deliveryWindowPredicate(spec, discipline) {
  if (isEmptyDeliveryWindow(spec)) return "";
  const parts = [];
  if (hasPhase(spec)) parts.push(phasePredicate(spec.phase));
  if (spec.overs) parts.push(oversPredicate(spec.overs));
  if (spec.balls) parts.push(ballsPredicate(spec.balls));
  if (spec.player) parts.push(playerPredicate(spec.player, discipline));
  const active = parts.filter((p) => p && p.trim());
  if (active.length === 0) return "";
  // Wrap each clause so the composed predicate is unambiguous wherever db.js
  // AND-embeds it (baseWhere already wraps the whole thing once more).
  return active.map((p) => `(${p})`).join(" AND ");
}

/** Immutably set (or clear) ONE piece of a window spec, returning the new spec —
 * or `null` when the result carries no active piece (the no-window invariant, so
 * the store falls back to byte-identical). Passing `null`/`undefined`/an empty
 * array as the value CLEARS that piece. Used by every one of the four drawer
 * editors, their pills, clearSingleton, and the format prune, so the piece-merge
 * logic lives in ONE place. */
export function withDeliveryWindowPiece(spec, key, value) {
  const next = { ...(spec || {}) };
  const cleared = value == null || (Array.isArray(value) && value.length === 0);
  if (cleared) delete next[key];
  else next[key] = value;
  return isEmptyDeliveryWindow(next) ? null : next;
}

/** Human-readable label for ONE piece (pure, no DOM). Kept here so every surface —
 * the four pills, the honest scope sentence — reads each window piece from ONE
 * place. `discipline` only affects the player piece's verb (faced / bowled). */
function pieceLabel(key, spec, discipline) {
  if (key === "phase") {
    const names = { pp: "Powerplay", mid: "Middle", death: "Death" };
    const chosen = PHASES_CANON.filter((p) => (spec.phase || []).includes(p)).map((p) => names[p]);
    return chosen.length ? `${chosen.join(" + ")} overs` : "";
  }
  if (key === "overs") return `overs ${spec.overs.from}–${spec.overs.to}`;
  if (key === "balls") return `balls ${spec.balls.from}–${spec.balls.to}`;
  if (key === "player") {
    const p = spec.player;
    const verb = discipline === "bowling" || discipline === "matchup_bowling" ? "bowled" : "faced";
    return `${p.edge === "last" ? "last" : "first"} ${p.n} ${verb}`;
  }
  return "";
}

/**
 * The active pieces of a window spec as `[{ key, label }]`, in canonical order —
 * ONE per active piece, so pills.js renders one removable pill each and
 * describeScope() lists one scope token each. "" for an empty spec ⇒ []. Pure,
 * no DOM.
 */
export function deliveryWindowTokens(spec, discipline = "batting") {
  if (isEmptyDeliveryWindow(spec)) return [];
  const tokens = [];
  for (const key of DELIVERY_WINDOW_KEYS) {
    const present = key === "phase" ? hasPhase(spec) : Boolean(spec[key]);
    if (!present) continue;
    const label = pieceLabel(key, spec, discipline);
    if (label) tokens.push({ key, label });
  }
  return tokens;
}

/** Joined human label for a whole window spec (each active piece, comma-joined) —
 * a thin convenience over deliveryWindowTokens for any single-string caller. "" for
 * an empty spec. */
export function describeDeliveryWindow(spec, discipline = "batting") {
  return deliveryWindowTokens(spec, discipline)
    .map((t) => t.label)
    .join(", ");
}
