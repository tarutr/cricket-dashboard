// src/deliveryWindow.js
//
// Ball-grain rebuild — Wave 3 (owner decision 67). THE delivery-window PREDICATE
// engine: turns a window SPEC into the ball-level SQL predicate that db.js pushes
// into the ball-engine reconstruction's base ball CTE — the `windowPredicate`
// hook that src/ballEngine.js and src/ballEngineMatchup.js added present-but-EMPTY
// in Waves 2a/2b. NO UI lives here; the drawer control comes in a later wave after
// an owner design sign-off.
//
// ── What a window is (decision 67) ──────────────────────────────────────────
// A window restricts which BALLS a search counts, so every windowed number is
// computed natively from the in-window balls, and — because the predicate lands
// in the BASE ball CTE, before the crease/aggregation — the reconstruction yields
// exactly the innings with ≥1 in-window ball (decision-67's innings rule). Windows
// DEFINE the numbers, so pins obey them (the WHO-not-WHAT rule) — that is enforced
// by db.js pushing the same predicate into every view a query reads.
//
// ── The spec (a plain object; both parts optional; they COMPOSE with AND) ─────
//   {
//     team?:   { mode: 'phase', phases: ('pp'|'mid'|'death')[] }   // format-native phase
//            | { mode: 'overs', from: int>=1, to: int>=from }       // 1-based over numbers
//            | { mode: 'balls', from: int>=1, to: int>=from },      // 1-based legal-ball ordinal
//     player?: { edge: 'first'|'last', n: int>=1 },                 // first/last N faced|bowled
//   }
// `null` / `undefined` / `{}` ⇒ "" (no predicate). This "" is the CRITICAL
// no-window invariant: db.js AND-composes nothing, so the reconstruction — and
// every number — is byte-identical to today.
//
// ── TEAM clock (discipline-INDEPENDENT; same ball columns for batting & bowling)
//   • phase  → the stored `phase` column. VERIFIED format-native (Wave 3, against
//     data/wave1_out): T20 6-ball pp=overs 0–5 / mid=6–14 / death=15–19; ODI
//     pp=overs 0–9 / mid=10–39 / death=40–49; The Hundred (balls_per_over=5)
//     pp=team_ball 1–25 / mid=26–75 / death=76+; RED BALL `phase` IS NULL for every
//     ball (so a phase window matches nothing on red ball — consistent with the
//     UI gating "red ball shows Overs only"); super-over balls also carry NULL
//     phase (and are excluded in the base CTE regardless).
//   • overs  → `over_number BETWEEN from-1 AND to-1` (over 1 = over_number 0;
//     per-innings; the only team mode offered for red ball).
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
// ── Valid format × mode combinations (GATING is a UI concern — NOT enforced here)
// The generator faithfully builds whatever spec it is handed. Decision 67's gating
// (for the UI wave to enforce): TEAM Phase + Balls only for T20 and 50-Over; TEAM
// Overs for all formats (and the ONLY team mode on red ball); PLAYER clock in all
// formats. Team + player compose. This module documents the rules; it does not
// police them — an out-of-gate spec (e.g. a phase window on red ball) still builds
// a valid predicate (it just matches no red-ball balls, phase being NULL there).

/** Canonical phase order — the ONLY three legal `phase` values, listed so a spec
 * with phases in any order yields a byte-stable predicate (stable cache key). */
const PHASES_CANON = ["pp", "mid", "death"];
const PHASE_SET = new Set(PHASES_CANON);

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

/** The TEAM-clock predicate for a team spec (discipline-independent). */
function teamPredicate(team) {
  if (!team || typeof team !== "object") {
    throw new Error("deliveryWindow: team clock must be an object");
  }
  if (team.mode === "phase") {
    if (!Array.isArray(team.phases) || team.phases.length === 0) {
      throw new Error("deliveryWindow: phase clock needs a non-empty phases[]");
    }
    const chosen = new Set();
    for (const p of team.phases) {
      if (!PHASE_SET.has(p)) {
        throw new Error(`deliveryWindow: unknown phase "${p}" (expected pp | mid | death)`);
      }
      chosen.add(p);
    }
    // Canonical order → literals come from a fixed whitelist (no escaping needed,
    // no injection surface) and the predicate is stable regardless of input order.
    const list = PHASES_CANON.filter((p) => chosen.has(p)).map((p) => `'${p}'`);
    return `phase IN (${list.join(", ")})`;
  }
  if (team.mode === "overs") {
    const from = intAtLeast(team.from, 1, "overs.from");
    const to = intAtLeast(team.to, 1, "overs.to");
    if (to < from) throw new Error(`deliveryWindow: overs.to (${to}) must be ≥ overs.from (${from})`);
    // Over 1 is stored as over_number 0 (0-based), so shift by one.
    return `over_number BETWEEN ${from - 1} AND ${to - 1}`;
  }
  if (team.mode === "balls") {
    const from = intAtLeast(team.from, 1, "balls.from");
    const to = intAtLeast(team.to, 1, "balls.to");
    if (to < from) throw new Error(`deliveryWindow: balls.to (${to}) must be ≥ balls.from (${from})`);
    return `team_ball BETWEEN ${from} AND ${to}`;
  }
  throw new Error(`deliveryWindow: unknown team clock mode "${team && team.mode}"`);
}

/** The PLAYER-clock predicate for a player spec, using `discipline`'s clock cols. */
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

/** True when a spec carries no active clock (null/undefined/{} or all-empty). */
export function isEmptyDeliveryWindow(spec) {
  return !spec || (!spec.team && !spec.player);
}

/**
 * Build the ball-level SQL predicate for a delivery-window `spec` under
 * `discipline` (which selects the player-clock columns). Team + player clocks
 * AND together. Returns "" for a null/empty spec — the no-window invariant, so
 * db.js composes nothing and the reconstruction stays byte-identical.
 *
 * The returned predicate reads ONLY raw ball (source) columns (phase /
 * over_number / team_ball / bat_ball[_rev] / bowl_ball[_rev]), so — like the
 * scope predicate — it needs no entry in the engine's lean base projection: it is
 * evaluated in the base CTE's WHERE against the parquet source before projection.
 *
 * @param {object|null} spec  the window spec (see the header) — null/empty ⇒ "".
 * @param {"batting"|"bowling"|"matchup_batting"|"matchup_bowling"} discipline
 * @returns {string} a SQL boolean predicate, or "" for no window.
 */
export function deliveryWindowPredicate(spec, discipline) {
  if (isEmptyDeliveryWindow(spec)) return "";
  const parts = [];
  if (spec.team) parts.push(teamPredicate(spec.team));
  if (spec.player) parts.push(playerPredicate(spec.player, discipline));
  const active = parts.filter((p) => p && p.trim());
  if (active.length === 0) return "";
  // Wrap each clause so the composed predicate is unambiguous wherever db.js
  // AND-embeds it (baseWhere already wraps the whole thing once more).
  return active.map((p) => `(${p})`).join(" AND ");
}

/** Human-readable label for a window spec (for the future UI wave's scope line /
 * pill; pure, no DOM). "" for an empty spec. Kept here so the eventual drawer and
 * any honest scope sentence read the window from ONE place. */
export function describeDeliveryWindow(spec, discipline = "batting") {
  if (isEmptyDeliveryWindow(spec)) return "";
  const bits = [];
  if (spec.team) {
    const t = spec.team;
    if (t.mode === "phase") {
      const names = { pp: "Powerplay", mid: "Middle", death: "Death" };
      const chosen = PHASES_CANON.filter((p) => (t.phases || []).includes(p)).map((p) => names[p]);
      if (chosen.length) bits.push(chosen.join(" + ") + (chosen.length > 1 ? " overs" : " overs"));
    } else if (t.mode === "overs") {
      bits.push(`overs ${t.from}–${t.to}`);
    } else if (t.mode === "balls") {
      bits.push(`balls ${t.from}–${t.to}`);
    }
  }
  if (spec.player) {
    const p = spec.player;
    const verb = discipline === "bowling" || discipline === "matchup_bowling" ? "bowled" : "faced";
    bits.push(`${p.edge === "last" ? "last" : "first"} ${p.n} ${verb}`);
  }
  return bits.join(", ");
}
