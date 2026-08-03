// src/db.js
// The ONLY module that talks to DuckDB-WASM. Everything else (debug page, and
// later Compare Stats / Graph Builder) goes through initDB()/query()/getManifest().
//
// Flow: fetch manifest.json (cache-busted) -> load vendored duckdb-wasm ->
// instantiate AsyncDuckDB -> register each Parquet file's HTTP URL (cache-busted
// with the manifest's per-file content hash) -> create SQL views over them.

import { DATA_BASE_URL, PARQUET_FILES, VENDOR_DUCKDB, ballEngineEnabled } from "./config.js";
import { buildInningsViewSql, DELIVERY_FILES } from "./ballEngine.js";
import { buildMatchupViewSql } from "./ballEngineMatchup.js";
import { neededViewColumns, coversColumns, unionColumns, columnsArePlayerLocal } from "./ballColumns.js";
import { deliveryWindowPredicate } from "./deliveryWindow.js";
import { opponentPlayerPredicate } from "./opponentFilter.js";

// View name -> parquet file name.
const VIEWS = {
  players: "players.parquet",
  matches: "matches.parquet",
  batting: "batting_innings.parquet",
  bowling: "bowling_innings.parquet",
  player_matches: "player_matches.parquet",
  // D4: one row per matched player_id (profile filters); matchup grains for Pieces 4–5.
  profiles: "player_profiles.parquet",
  // Fielding rebuild: event-grain fielding (one row per wicket-credit).
  fielding: "fielding_events.parquet",
  matchup_batting: "matchup_batting.parquet",
  matchup_bowling: "matchup_bowling.parquet",
};

// ── Ball engine (Wave 2a + 2b, owner decision 67) ───────────────────────────
// When ballEngineEnabled() (the ?engine=ball flag) is on, the `batting` /
// `bowling` views are RECONSTRUCTED from the six delivery files by
// src/ballEngine.js (Wave 2a), and — Wave 2b — the `matchup_batting` /
// `matchup_bowling` views are RECONSTRUCTED from the same delivery files joined
// to the `profiles` view by src/ballEngineMatchup.js, instead of reading their
// respective parquets. Every downstream query is byte-identical because each
// reconstruction is proven cell-for-cell identical to its export.
//
// The reconstruction re-aggregates raw balls, so — unlike the pre-aggregated
// parquets — it is only usable when scoped to the gender+format file(s) the
// query actually asks for (measured: all-6 = 21s vs one file = ~3s warm; the
// scope filter does not prune through the ANY_VALUE aggregation). So every
// engine view is (re)created SCOPED — file subset + a pushed-down core-scope
// predicate derived from the query's own literals (scopeForQuery) — lazily, only
// when that scope + column signature changes. The matchup views share the same
// machinery (scopeForQuery lifts the same gender/match_type/team_type/match_date
// literals buildMatchupQuery's WHERE carries, and pruning/caching key on the
// view name as their "discipline").
const engineViews = ["batting", "bowling", "matchup_batting", "matchup_bowling"];
let engineOn = false; // set in registerData from ballEngineEnabled()

// ── Delivery window (Wave 3, owner decision 67) ─────────────────────────────
// The active delivery-window spec (null = no window). db.js is state-free (there
// is no store singleton — main.js and the graph each own a store), so the UI wave
// pushes the store's `state.deliveryWindow` here via setDeliveryWindow() whenever
// it changes; the engine reads it at query time (ensureEngineScope) and pushes the
// generated ball predicate into EVERY engine view a query reads, so pins obey the
// window (WHO-not-WHAT) automatically. null ⇒ deliveryWindowPredicate() returns ""
// ⇒ baseWhere AND-composes nothing ⇒ byte-identical to today (THE invariant).
let activeDeliveryWindow = null;

/** Set (or clear, with null) the active delivery-window spec. The UI wave calls
 * this from a store subscription (`setDeliveryWindow(store.get().deliveryWindow)`);
 * the seam's verification drives it directly. Spec shape: src/deliveryWindow.js.
 * Takes effect on the NEXT query — ensureEngineScope recomputes the per-discipline
 * predicate + cache signature every time, so a window change simply misses the
 * cache (a now-fast recompute), never a wrong answer. */
export function setDeliveryWindow(spec) {
  activeDeliveryWindow = spec || null;
}

// ── Opponent-player head-to-head (pop-up Tab-2 T-1, owner decision 70) ───────
// The active opponent spec ({id, name} or null). Same state-free convention as
// the delivery window: the UI pushes state.opponentPlayer here on Search via
// setOpponentPlayer(), and it is AND-composed into the SAME base-CTE ball
// predicate as the window (windowPredicateFor below), so it rides the existing
// windowPredicate thread (cache signature / materialise / widen / full-rebuild
// all already carry it) with zero new plumbing. null ⇒ predicate "" ⇒ nothing
// composed ⇒ byte-identical to today (THE invariant). Discipline picks the
// opposite-role id column (batter's bowler / bowler's batter — see opponentFilter.js).
let activeOpponentPlayer = null;

/** Set (or clear, with null) the active opponent-player spec. main.js calls this
 * at the Search commit (`setOpponentPlayer(appliedState.opponentPlayer)`), beside
 * setDeliveryWindow. Takes effect on the NEXT query. Shape: src/opponentFilter.js. */
export function setOpponentPlayer(opp) {
  activeOpponentPlayer = opp || null;
}

/** The active BALL-level predicate for one engine discipline — the delivery
 * window AND the opponent-player head-to-head, composed. "" when neither is set
 * (byte-identical to today). Discipline selects the window's player clock
 * (bat_ball vs bowl_ball) AND the opponent's opposite-role id column (bowler_id
 * for a batting query, batter_id for a bowling query). When only the window is
 * set the window string is returned VERBATIM (byte-identical to the pre-T-1
 * behaviour); when only the opponent is set, just its clause; both ⇒ AND-composed. */
function windowPredicateFor(discipline) {
  const win = deliveryWindowPredicate(activeDeliveryWindow, discipline);
  const opp = opponentPlayerPredicate(activeOpponentPlayer, discipline);
  if (!opp) return win; // opponent inactive → byte-identical to the window-only path
  if (!win) return opp;
  return `${win} AND (${opp})`;
}

/** Generate the reconstruction SELECT for an engine view, dispatching to the
 * plain (ballEngine.js) or matchup (ballEngineMatchup.js) generator by name. */
function engineViewSql(discipline, opts) {
  if (discipline === "batting" || discipline === "bowling") return buildInningsViewSql(discipline, opts);
  return buildMatchupViewSql(discipline, opts);
}

/** Seed the `batting` / `bowling` views as plain (unmaterialised) reconstruction
 * VIEWs over `files`. Metadata-only — the heavy per-ball aggregation runs when a
 * query executes against the view, not here. Used once at boot so the views
 * EXIST with a correct (if slow) definition; every real query then goes through
 * ensureEngineScope, which materialises a query-shaped table instead. */
async function createEngineViews(connection, files, scopePredicate) {
  for (const discipline of engineViews) {
    try {
      await connection.query(
        `CREATE OR REPLACE VIEW ${discipline} AS ${engineViewSql(discipline, { files, scopePredicate })}`
      );
    } catch (e) {
      throw makeError(
        e,
        `Could not create the ball-engine "${discipline}" view. The delivery Parquet files may be missing/unreadable, or the ballEngine SQL is malformed.`
      );
    }
    viewBackedBy[discipline] = null;
  }
}

// ── Wave 2s Layer 2: scope-keyed materialisation cache ──────────────────────
// Wave 2a re-ran the whole per-ball reconstruction for EVERY query — so a search
// paid it once, then the "Matches" secondary query, each graph fetch, each popup
// section and every column add paid it again. Layer 2 pays it ONCE per
// (discipline, files, scopePredicate, windowPredicate, columnSet) signature:
// the reconstruction is materialised into a small table (the whole innings grain
// is only ~422k rows across ALL genders/formats, and a query-shaped one carries
// ~10–20 columns) and the view is re-pointed at that table. Everything that
// follows under the same scope is a plain table scan.
//
//   REUSE (superset rule): a cached table answers a query whose signature
//   matches AND whose needed columns are a SUBSET of the table's — so sorts,
//   graph fetches and popup sections that add no new column are free. When a
//   query under a known signature needs a column the table lacks, the table is
//   rebuilt for the UNION of the two sets, so alternating between two column
//   sets converges instead of thrashing.
//   INVALIDATION: scope changes produce a different signature, so they simply
//   miss. Tables are capped (MAX_MATERIALIZED, least-recently-used evicted and
//   DROPped) — which bounds memory and lets the common "leaderboard scope ⇄
//   popup scope" alternation stay warm instead of recomputing each way.
//   DEGRADATION: a miss is always a (now-fast) recompute, never a wrong answer —
//   a signature is only ever reused when it matches exactly.
const MAX_MATERIALIZED = 4;
/** signature -> { table, discipline, columns, used } */
const engineCache = new Map();
/** discipline -> the materialised table its view currently reads (null = the
 * unmaterialised boot seed). */
const viewBackedBy = { batting: null, bowling: null, matchup_batting: null, matchup_bowling: null };
let engineTableSeq = 0;
let engineClock = 0;
/** Reasons we have already warned about, so a `SELECT *` graph dimension warns
 * once instead of on every fetch. */
const warnedFullSet = new Set();

function engineSignature(discipline, files, scopePredicate, windowPredicate, playerPredicate) {
  return `${discipline}::${files.join("|")}::${scopePredicate}::${windowPredicate || ""}::${playerPredicate || ""}`;
}

/** Point `discipline`'s view at a materialised table (cheap DDL, skipped when it
 * already reads that table). */
async function pointViewAt(discipline, table) {
  if (viewBackedBy[discipline] === table) return;
  await conn.query(`CREATE OR REPLACE VIEW ${discipline} AS SELECT * FROM ${table}`);
  viewBackedBy[discipline] = table;
}

/** Drop least-recently-used materialised tables until at most MAX_MATERIALIZED
 * remain. Never evicts a table a view currently reads. */
async function evictMaterialized() {
  while (engineCache.size > MAX_MATERIALIZED) {
    let victimKey = null;
    let victim = null;
    for (const [key, entry] of engineCache) {
      if (viewBackedBy[entry.discipline] === entry.table) continue;
      if (!victim || entry.used < victim.used) {
        victim = entry;
        victimKey = key;
      }
    }
    if (!victim) return;
    engineCache.delete(victimKey);
    try {
      await conn.query(`DROP TABLE IF EXISTS ${victim.table}`);
    } catch {
      /* a failed DROP costs memory, never correctness — keep going */
    }
  }
}

/** Materialise `discipline` for one signature and point its view at the result. */
async function materialize(discipline, key, files, scopePredicate, windowPredicate, playerPredicate, columns) {
  const previous = engineCache.get(key);
  const table = `__ball_${discipline}_${++engineTableSeq}`;
  const sql = engineViewSql(discipline, { files, scopePredicate, windowPredicate, playerPredicate, columns });
  try {
    await conn.query(`CREATE TABLE ${table} AS ${sql}`);
  } catch (e) {
    // DuckDB-WASM has a hard ~3.1 GiB ceiling and no disk to spill to, so a
    // reconstruction over an unscoped ball set (all six files, no date range)
    // runs out of memory. Every real query carries gender + format + a date
    // range, so scopePredicate is never empty in practice — say so plainly if
    // it ever happens rather than surfacing a raw allocator message.
    const outOfMemory = /out of memory/i.test(String(e?.message ?? e));
    throw makeError(
      e,
      outOfMemory
        ? `This scope is too broad for the in-browser database to rebuild from ball-by-ball data (it ran out of memory). Narrow the date range or pick a single format, then search again.`
        : `Could not build the ball-engine "${discipline}" table for this scope. The delivery Parquet files may be missing/unreadable, or the ballEngine SQL is malformed.`
    );
  }
  engineCache.set(key, { table, discipline, columns, used: ++engineClock });
  await pointViewAt(discipline, table);
  if (previous) {
    try {
      await conn.query(`DROP TABLE IF EXISTS ${previous.table}`);
    } catch {
      /* see evictMaterialized */
    }
  }
  await evictMaterialized();
}

/**
 * Derive, from a query's OWN scope literals, (a) which delivery files the
 * ball-engine views should read and (b) the core-scope predicate to push into
 * the base ball CTE. Exported so the offline byte-identical harness scopes the
 * views EXACTLY as the runtime does — the two can never diverge.
 *
 * FILES: UNION semantics over every `gender = '…'` / `match_type IN (…)` literal
 * → always a SUPERSET of the files that can hold in-scope rows (never under-reads);
 * any uncertainty (missing gender, unknown/absent match_type) widens to all files
 * on that axis. Each delivery file is single-gender / single-format-bucket and
 * every match lives entirely in one file, so reading only these files + the
 * query's own WHERE yields exactly the rows reading all six would.
 *
 * SCOPE PREDICATE: the gender / match_type / team_type / match_date clauses lifted
 * VERBATIM from the query (all four are raw ball columns, constant within a
 * (match_id, innings_number)). Pushing them into the base filters balls to only
 * in-scope innings BEFORE aggregation (the memory/speed lever + row-group/file
 * pruning) and is byte-identical: it can only ever drop WHOLE out-of-scope
 * innings, which the caller's outer WHERE discards anyway (see ballEngine
 * baseWhere). Lifting the query's OWN clauses guarantees the base is never
 * narrower than the innings the outer query keeps. Clauses that decide WHICH
 * players/teams (team, opposition, position, event, venue, profile, match
 * context) are deliberately NOT lifted — the view must stay at core-scope grain
 * so an in-query sub-use like the R. Pos. CTE (modal position over the core scope)
 * still sees every core-scope innings.
 */
export function scopeForQuery(sql) {
  // --- files (superset-safe) ---
  const genders = new Set();
  for (const m of sql.matchAll(/gender\s*=\s*'(male|female)'/g)) {
    genders.add(m[1] === "male" ? "m" : "f");
  }
  if (genders.size === 0) {
    genders.add("m");
    genders.add("f");
  }
  const buckets = new Set();
  let sawMatchType = false;
  let sawUnknown = false;
  for (const m of sql.matchAll(/match_type\s+IN\s*\(([^)]*)\)/gi)) {
    sawMatchType = true;
    for (const t of m[1].matchAll(/'([^']*)'/g)) {
      const ty = t[1];
      if (ty === "T20" || ty === "IT20") buckets.add("t20");
      else if (ty === "ODI" || ty === "ODM") buckets.add("odi");
      else if (ty === "Test" || ty === "MDM") buckets.add("red");
      else sawUnknown = true;
    }
  }
  if (!sawMatchType || sawUnknown || buckets.size === 0) {
    buckets.add("t20");
    buckets.add("odi");
    buckets.add("red");
  }
  const files = [];
  for (const g of genders) for (const b of buckets) files.push(`deliveries_${g}_${b}.parquet`);
  files.sort();

  // --- scope predicate (verbatim clauses on raw ball columns) ---
  const parts = [];
  const g = sql.match(/gender\s*=\s*'(?:male|female)'/);
  if (g) parts.push(g[0]);
  const mt = sql.match(/match_type\s+IN\s*\([^)]*\)/i);
  if (mt) parts.push(mt[0]);
  const tt = sql.match(/team_type\s*=\s*'(?:international|club)'/);
  if (tt) parts.push(tt[0]);
  const dlo = sql.match(/match_date\s*>=\s*DATE\s*'[0-9-]+'/i);
  if (dlo) parts.push(dlo[0]);
  const dhi = sql.match(/match_date\s*<\s*DATE\s*'[0-9-]+'/i);
  if (dhi) parts.push(dhi[0]);
  const scopePredicate = parts.join(" AND ");

  return { files, scopePredicate };
}

// ── Wave 2s2 FIX 1: popup single-player base scoping ─────────────────────────
// The player popup fires a battery of queries each shaped `… FROM batting WHERE
// <scope> AND batter_id = 'X' …` (playerData.js) — one player. Wave 2s rebuilt
// EVERY player's innings for the scope, then the outer WHERE threw all but X's
// away (~5 s). Here db.js detects that single-player equality and pushes a
// player-involvement predicate into the reconstruction's BASE ball set, so it
// rebuilds ONLY X's innings.
//
// SAFETY: this is byte-identical ONLY for player-LOCAL columns (ballColumns.js:
// the per-player CTEs still see every one of X's own balls, so their aggregates
// are complete; the team-total CTEs would see a fraction of the innings). We
// gate on columnsArePlayerLocal, so a query that needs team_inns_balls / any
// team_rel_* falls back to the whole-scope reconstruction. The base predicate
// keeps every ball where X is the striker OR non-striker OR the dismissed batter
// (flat player_out OR a wickets_extra overflow entry), so X's own view row is
// COMPLETE; the base may still emit partial rows for OTHER players (as X's
// non-strikers etc.), which the caller's own `batter_id = 'X'` discards.
const PLAYER_ID_COL = {
  batting: "batter_id",
  bowling: "bowler_id",
  // Matchup popup sections (playerData.js) filter matchup_batting by the STRIKER
  // (batter_id = 'X') and matchup_bowling by the BOWLER (bowler_id = 'X').
  matchup_batting: "batter_id",
  matchup_bowling: "bowler_id",
};

/** The single player id a query is scoped to (a bare `<idCol> = 'X'` equality on
 * the discipline's id column), or null. Requires EXACTLY ONE distinct id value:
 * the leaderboard's pin exemption uses `<idCol> IN (…)` (never `=`) and the
 * R.Pos join uses `pos_batter_id = <col>` (a column, not a literal), so neither
 * is matched. A star-safe literal capture keeps embedded quotes intact. */
function singlePlayerId(discipline, sql) {
  const idCol = PLAYER_ID_COL[discipline];
  const re = new RegExp(`\\b${idCol}\\s*=\\s*'((?:[^']|'')*)'`, "g");
  const ids = new Set();
  for (const m of sql.matchAll(re)) ids.add(m[1]);
  return ids.size === 1 ? [...ids][0] : null;
}

/** The base-ball WHERE predicate restricting the reconstruction to one player's
 * innings. `idLiteral` is the already-SQL-escaped literal BODY captured from the
 * query, re-wrapped verbatim (never re-escaped). Batting keeps every ball where
 * the player is on strike, at the non-striker's end, the flat dismissed batter,
 * or a 2nd-and-later dismissal in the wickets_extra overflow. */
function playerBasePredicate(discipline, idLiteral) {
  const lit = `'${idLiteral}'`;
  // Bowling (plain + matchup): the bowler's own deliveries.
  if (discipline === "bowling" || discipline === "matchup_bowling") return `bowler_id = ${lit}`;
  // Matchup batting: only the STRIKER's faced balls create a matchup_batting row
  // (no zero-ball crease recovery at the matchup grain), so the striker equality
  // alone captures every one of X's matchup rows.
  if (discipline === "matchup_batting") return `batter_id = ${lit}`;
  // Plain batting: striker OR non-striker OR the flat/overflow dismissed batter
  // (recovers the zero-ball crease appearances).
  return (
    `(batter_id = ${lit} OR non_striker_id = ${lit} OR player_out_id = ${lit}` +
    ` OR len(list_filter(wickets_extra, w -> w.player_out_id = ${lit})) > 0)`
  );
}

/** The player predicate for a query, or "" when it must NOT be player-scoped
 * (no single-id equality, or a column needs the whole innings' balls). `need` is
 * this query's neededViewColumns result. */
function playerScopeFor(discipline, sql, need) {
  if (!columnsArePlayerLocal(discipline, need)) return "";
  const id = singlePlayerId(discipline, sql);
  return id == null ? "" : playerBasePredicate(discipline, id);
}

/** SQL strings currently queued or executing under the engine's serialiser —
 * the look-ahead widening below reads it. */
const pendingEngineSqls = new Set();

/**
 * Widen `need` with the column needs of the other queries already sitting in
 * the queue, when they resolve to the SAME (files, scopePredicate, player scope)
 * signature. Pure look-ahead — it changes only how many columns get
 * materialised. The player-predicate must also match, so a popup battery's
 * same-player sections fold into ONE player-scoped table while a whole-scope
 * query is never mixed into a player-scoped one (or vice versa).
 */
function widenForPendingQueries(need, discipline, sql, files, scopePredicate, windowPredicate, playerPredicate) {
  if (pendingEngineSqls.size < 2) return need;
  // The window is global + discipline-fixed (same activeDeliveryWindow for every
  // query in flight), so including it in the signature never changes fold
  // behaviour — but it keeps this signature in lock-step with the cache key.
  const signature = `${files.join("|")}::${scopePredicate}::${windowPredicate}::${playerPredicate}`;
  let columns = need.columns;
  let full = need.full;
  let reason = need.reason;
  for (const other of pendingEngineSqls) {
    if (other === sql || full) continue;
    if (!enginePlanDisciplines(other).includes(discipline)) continue;
    const otherScope = scopeForQuery(other);
    const otherNeed = neededViewColumns(discipline, other);
    const otherPlayer = playerScopeFor(discipline, other, otherNeed);
    if (`${otherScope.files.join("|")}::${otherScope.scopePredicate}::${windowPredicate}::${otherPlayer}` !== signature) continue;
    if (otherNeed.full) {
      full = true;
      columns = null;
      reason = otherNeed.reason;
    } else {
      columns = unionColumns(columns, otherNeed.columns);
    }
  }
  return { columns, full, reason };
}

/** Which engine views a query actually reads. `\bbatting\b` / `\bbowling\b`
 * deliberately does NOT match batting_team / bowling_group / matchup_batting,
 * where the token is glued to a word char (the leading `matchup_` / trailing
 * `_team` kills the word boundary) — so the matchup views need their own tokens.
 * A query only ever touches ONE family (buildQuery scans the plain views,
 * buildMatchupQuery the matchup views), but all four are checked for safety. */
function enginePlanDisciplines(sql) {
  const out = [];
  if (/\bmatchup_batting\b/.test(sql)) out.push("matchup_batting");
  if (/\bmatchup_bowling\b/.test(sql)) out.push("matchup_bowling");
  if (/\bbatting\b/.test(sql)) out.push("batting");
  if (/\bbowling\b/.test(sql)) out.push("bowling");
  return out;
}

/**
 * Before a ball-engine query runs, make sure each engine view it reads is backed
 * by a materialised table built for THIS query's scope and column needs. No-op
 * unless the flag is on and the SQL touches `batting`/`bowling`.
 *
 * Column derivation (Layer 1) is `neededViewColumns` in src/ballColumns.js:
 * token-scan the SQL against the fixed innings-column vocabulary; a star
 * expansion (or any other construct that can read an unnamed column) falls back
 * to the FULL set with a console.warn naming it. Over-inclusion costs a little
 * speed; under-inclusion is caught by runWithColumnRetry below, never silently.
 *
 * @returns {{discipline: string, key: string, files: string[], scopePredicate: string, pruned: boolean}[]}
 *   the plan, so a binder error can rebuild exactly these views with everything.
 */
async function ensureEngineScope(sql) {
  if (!engineOn) return [];
  const disciplines = enginePlanDisciplines(sql);
  if (disciplines.length === 0) return [];
  const { files, scopePredicate } = scopeForQuery(sql);
  const plan = [];
  for (const discipline of disciplines) {
    const ownNeed = neededViewColumns(discipline, sql);
    // FIX 1: a single-player popup query rebuilds only that player's innings —
    // but only when every column it needs is player-local (else team totals go
    // wrong). Derived from this query's OWN needs, so it is stable per-SQL and
    // never flips as widening folds in same-player siblings.
    const playerPredicate = playerScopeFor(discipline, sql, ownNeed);
    // Wave 3: the active delivery-window predicate for THIS discipline (bat vs
    // bowl clock). "" when no window is set ⇒ everything below is byte-identical
    // to today (the key gains "", the SQL adds nothing). When set it AND-composes
    // into the base ball CTE, changing the row set to the in-window balls (and so
    // the innings to those with ≥1 in-window ball — decision 67).
    const windowPredicate = windowPredicateFor(discipline);
    // Queue-aware widening: the app fires bursts (a popup's section battery, a
    // graph's parallel fetches) whose members read the same scope but slightly
    // different columns. Serialised, that would materialise once per member.
    // So fold in what the OTHER queries already waiting in the queue need, if
    // they resolve to this same signature — one build instead of N. Widening
    // only ever adds columns, never rows, so it cannot change a number.
    let need = widenForPendingQueries(ownNeed, discipline, sql, files, scopePredicate, windowPredicate, playerPredicate);
    if (need.full) {
      const tag = `${discipline}:${need.reason}`;
      if (!warnedFullSet.has(tag)) {
        warnedFullSet.add(tag);
        // eslint-disable-next-line no-console
        console.warn(
          `[cricdb] ball engine: cannot prune the "${discipline}" reconstruction for this query — ${need.reason}. ` +
            `Rebuilding all columns (slower, still correct).`
        );
      }
    }
    const key = engineSignature(discipline, files, scopePredicate, windowPredicate, playerPredicate);
    plan.push({ discipline, key, files, scopePredicate, windowPredicate, playerPredicate, pruned: !need.full });
    const entry = engineCache.get(key);
    if (entry && coversColumns(entry.columns, need.columns)) {
      entry.used = ++engineClock;
      await pointViewAt(discipline, entry.table);
      continue;
    }
    const columns = entry ? unionColumns(entry.columns, need.columns) : need.columns;
    await materialize(discipline, key, files, scopePredicate, windowPredicate, playerPredicate, columns);
  }
  return plan;
}

// A pruned reconstruction that is missing a column the query reads produces a
// DuckDB *Binder* error ("column X not found"), never a wrong number — SQL
// cannot read a column it did not name. This is the loud auto-recovery: rebuild
// the planned views with EVERY column, warn with the failing message, retry once.
const BINDER_ERROR_RE = /binder error|catalog error|not found in from clause|referenced column|does not have a column/i;

async function rebuildEngineFull(plan) {
  for (const step of plan) {
    if (!step.pruned) continue;
    // Drop BOTH the column pruning AND any player scoping — the whole-scope full
    // reconstruction is the proven byte-identical fallback (a player-scoped full
    // set would carry non-player-local team_rel columns). The delivery WINDOW is
    // KEPT (step.windowPredicate): unlike pruning/player-scoping it DEFINES the
    // numbers, so the fallback must reconstruct the same in-window row set.
    await materialize(step.discipline, step.key, step.files, step.scopePredicate, step.windowPredicate, "", null);
  }
}

let initPromise = null;
let manifest = null;
let db = null; // AsyncDuckDB instance
let conn = null; // shared AsyncDuckDBConnection

function makeError(rawError, userMessage) {
  const err = rawError instanceof Error ? rawError : new Error(String(rawError));
  err.userMessage = userMessage;
  return err;
}

/**
 * Fetch and parse manifest.json from the data bucket. Cache-busted on every
 * call so we always see the latest pipeline run.
 */
async function fetchManifest() {
  const url = `${DATA_BASE_URL}manifest.json?t=${Date.now()}`;
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    throw makeError(
      e,
      `Could not reach the data server to fetch manifest.json. Check your internet connection, or the R2 bucket may be down/misconfigured (CORS?). (${url})`
    );
  }
  if (!res.ok) {
    throw makeError(
      new Error(`manifest.json HTTP ${res.status}`),
      `manifest.json responded with HTTP ${res.status}. The data bucket may be misconfigured or the file is missing. (${url})`
    );
  }
  try {
    return await res.json();
  } catch (e) {
    throw makeError(e, `manifest.json was not valid JSON. The pipeline may have written a corrupt file. (${url})`);
  }
}

/**
 * Load the vendored duckdb-wasm ES module, pick the best bundle (mvp vs eh),
 * spin up its worker, and instantiate an AsyncDuckDB instance.
 */
async function loadDuckDB(onProgress) {
  let duckdb;
  try {
    duckdb = await import(/* @vite-ignore */ `${VENDOR_DUCKDB}duckdb-browser.mjs`);
  } catch (e) {
    const isBareSpecifier = /resolve module specifier/i.test(e.message ?? "");
    const hint = isBareSpecifier
      ? ` duckdb-browser.mjs imports "apache-arrow" (which itself imports "tslib" and "flatbuffers") as bare specifiers — these need a browser <script type="importmap"> entry (or vendored alongside duckdb-wasm) since there is no bundler here.`
      : ` The vendored duckdb-wasm files are probably missing or the path is wrong — check vendor/duckdb-wasm/.`;
    throw makeError(e, `Could not load duckdb-browser.mjs from ${VENDOR_DUCKDB}.${hint}`);
  }

  const bundles = {
    mvp: {
      mainModule: `${VENDOR_DUCKDB}duckdb-mvp.wasm`,
      mainWorker: `${VENDOR_DUCKDB}duckdb-browser-mvp.worker.js`,
    },
    eh: {
      mainModule: `${VENDOR_DUCKDB}duckdb-eh.wasm`,
      mainWorker: `${VENDOR_DUCKDB}duckdb-browser-eh.worker.js`,
    },
  };

  let bundle;
  try {
    bundle = await duckdb.selectBundle(bundles);
  } catch (e) {
    throw makeError(
      e,
      `duckdb-wasm could not select a WASM bundle (mvp/eh) for this browser. This browser may be unsupported, or the vendored .wasm files are missing.`
    );
  }

  let worker;
  let instance;
  try {
    // Same-origin vendored worker: construct directly. (duckdb.createWorker's
    // blob-URL wrapper is for cross-origin CDNs and hangs in this setup.)
    worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel ? duckdb.LogLevel.WARNING : undefined);
    instance = new duckdb.AsyncDuckDB(logger, worker);
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker, (progress) => {
      if (onProgress) onProgress({ stage: "instantiate", progress });
    });
  } catch (e) {
    throw makeError(
      e,
      `Failed to instantiate DuckDB-WASM (worker: ${bundle.mainWorker}, module: ${bundle.mainModule}). The .wasm/.worker.js files may be missing, corrupt, or blocked by the browser's security policy.`
    );
  }

  return { duckdb, db: instance };
}

/**
 * Register the Parquet files (HTTP protocol, cache-busted with the manifest's
 * content hash) and create the four SQL views the rest of the app queries.
 */
async function registerData(duckdbMod, dbInstance, connection, manifestData, onProgress) {
  // Batch 5b C5b: registerFileURL calls are independent (each just tells the
  // WASM runtime a virtual filename maps to an HTTP URL — no shared state
  // between files), so run all 7 in parallel instead of one-at-a-time.
  // Per-file try/catch is kept so a failure still names the specific file
  // and URL in the human-readable error (same makeError path as before);
  // Promise.all rejects with the first one, same net effect as the old
  // sequential loop's first-failure-wins behavior.
  if (onProgress) onProgress({ stage: "register" });
  await Promise.all(
    PARQUET_FILES.map(async (name) => {
      const fileInfo = manifestData?.files?.[name];
      const version = fileInfo?.sha256_12 ?? Date.now();
      const url = `${DATA_BASE_URL}${name}?v=${version}`;
      try {
        await dbInstance.registerFileURL(name, url, duckdbMod.DuckDBDataProtocol.HTTP, false);
      } catch (e) {
        throw makeError(
          e,
          `Could not register ${name} for querying. The file may be missing from the data bucket, or CORS is not configured to allow this site's origin. (${url})`
        );
      }
    })
  );

  // CREATE VIEW statements only depend on their OWN file already being
  // registered (done above) — not on each other — and this duckdb-wasm setup
  // handles concurrent queries on one connection fine (verified: concurrent
  // CREATE VIEW calls against the shared connection all completed correctly
  // during manual testing), so these also run in parallel.
  //
  // Ball engine (Wave 2a): when the flag is on, `batting`/`bowling` are created
  // separately by createEngineViews (from the delivery files) — skip them here.
  // matchup_batting / matchup_bowling and every other view are unchanged.
  engineOn = ballEngineEnabled();
  await Promise.all(
    Object.entries(VIEWS).map(async ([viewName, fileName]) => {
      if (engineOn && engineViews.includes(viewName)) return; // ball engine owns these
      try {
        await connection.query(
          `CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet('${fileName}')`
        );
      } catch (e) {
        throw makeError(
          e,
          `Could not create the "${viewName}" view from ${fileName}. The Parquet file may be corrupt or unreadable by DuckDB-WASM.`
        );
      }
    })
  );

  // Seed the ball-engine views over ALL six files, unscoped (a correct default so
  // the views EXIST). Metadata-only; ensureEngineScope narrows BOTH the file set
  // and the pushed-down scope predicate before any heavy aggregation runs, so the
  // unscoped all-six definition is never actually executed.
  if (engineOn) {
    // eslint-disable-next-line no-console
    console.info("[cricdb] ball engine ON (?engine=ball) — batting/bowling views reconstructed from delivery files");
    await createEngineViews(connection, DELIVERY_FILES.slice(), "");
  }
}

async function doInit(onProgress) {
  if (onProgress) onProgress({ stage: "manifest" });
  manifest = await fetchManifest();

  if (onProgress) onProgress({ stage: "loading-duckdb" });
  const { duckdb, db: dbInstance } = await loadDuckDB(onProgress);
  db = dbInstance;

  if (onProgress) onProgress({ stage: "connecting" });
  try {
    conn = await db.connect();
  } catch (e) {
    throw makeError(e, "Could not open a connection to the in-browser DuckDB instance.");
  }

  if (onProgress) onProgress({ stage: "registering-data" });
  await registerData(duckdb, db, conn, manifest, onProgress);

  if (onProgress) onProgress({ stage: "ready" });
  return { manifest };
}

/**
 * Idempotent initializer. Safe to call multiple times/concurrently — every
 * caller gets the same promise/result. If init fails, the failed promise is
 * cleared so a subsequent call (e.g. after the user clicks Retry) starts over.
 */
export async function initDB(onProgress) {
  if (!initPromise) {
    initPromise = doInit(onProgress).catch((e) => {
      initPromise = null; // allow retry
      throw e;
    });
  }
  return initPromise;
}

/**
 * Run a SQL query against the shared connection. Returns plain JS objects
 * (Arrow -> JSON, with safely-integral BigInts coerced to Number) plus wall
 * clock timing in milliseconds.
 */
export async function query(sql) {
  if (!conn) {
    throw makeError(
      new Error("query() called before initDB() completed"),
      "The database is not ready yet. Please wait for initialization to finish and try again."
    );
  }
  // Flag OFF: byte-untouched — straight to the connection, no queue, no engine.
  if (!engineOn) return runQuery(sql);
  // Flag ON: the batting/bowling VIEWS are re-pointed per query (at that query's
  // scope + column set), so two queries must never be in flight at once — the
  // second would run against the first's view definition. One shared connection
  // is serialised by the DuckDB worker anyway, so this costs nothing and it also
  // means concurrent same-scope callers (the popup's section battery, a graph's
  // parallel fetches) collapse onto ONE materialisation — see
  // widenForPendingQueries, which reads this queue to build for all of them at
  // once instead of once per member.
  pendingEngineSqls.add(sql);
  return serializeEngineQuery(() => runQuery(sql)).finally(() => pendingEngineSqls.delete(sql));
}

let engineChain = Promise.resolve();

function serializeEngineQuery(fn) {
  const run = engineChain.then(fn, fn);
  engineChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function runQuery(sql) {
  const start = performance.now();
  // Ball engine: point the batting/bowling views at a table materialised for
  // this query's scope AND column needs before it runs. No-op when the flag is
  // off or the query does not touch those views. Inside the timer on purpose —
  // with the flag on, the reconstruction IS the query's cost.
  const plan = await ensureEngineScope(sql);
  let table;
  try {
    table = await conn.query(sql);
  } catch (e) {
    const message = String(e?.message ?? e);
    if (plan.some((p) => p.pruned) && BINDER_ERROR_RE.test(message)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cricdb] ball engine: the query-shaped reconstruction was missing a column this query needs — ` +
          `rebuilding every column and retrying once. Original error: ${message}`
      );
      await rebuildEngineFull(plan);
      try {
        table = await conn.query(sql);
      } catch (e2) {
        throw makeError(e2, `Query failed: ${e2.message ?? "unknown error"}`);
      }
    } else {
      throw makeError(e, `Query failed: ${e.message ?? "unknown error"}`);
    }
  }
  const ms = performance.now() - start;

  const rows = table.toArray().map((row) => {
    const obj = row.toJSON ? row.toJSON() : { ...row };
    for (const key of Object.keys(obj)) {
      obj[key] = normalizeValue(obj[key]);
    }
    return obj;
  });

  return { rows, ms };
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function normalizeValue(value) {
  if (typeof value === "bigint") {
    if (value >= -BigInt(MAX_SAFE) && value <= BigInt(MAX_SAFE)) {
      return Number(value);
    }
    return value.toString();
  }
  // DuckDB LIST/ARRAY columns arrive as Arrow Vectors (iterable, but missing
  // plain-array methods like .filter/.map/.slice) — used by C4's merged
  // profile-options query (list(DISTINCT …)). Flatten to a real array so
  // callers can treat it like any other JS array.
  if (value !== null && typeof value === "object" && typeof value.toArray === "function") {
    return Array.from(value.toArray(), normalizeValue);
  }
  return value;
}

/** Returns the parsed manifest.json (or null if init hasn't completed yet). */
export function getManifest() {
  return manifest;
}

let prewarmed = false;

/**
 * FIX 3 (Wave 2s2): after boot, pre-pay the NETWORK download of the default
 * Men/T20 delivery file so the user's FIRST search doesn't also wait on the
 * ~20 MB fetch (the dominant cold-search cost over R2). FLAG-ON ONLY — flag-OFF
 * never reads the delivery files, so it stays byte-untouched with no eager fetch.
 *
 * HOW: a plain background `fetch()` of the SAME versioned URL db.js registered
 * for deliveries_m_t20.parquet (the default gender+format bucket). This warms the
 * browser HTTP cache / TCP+TLS path so DuckDB's later ranged reads for that file
 * come off already-fetched bytes. Deliberately NOT a DuckDB query: it must not
 * enter the serialised engine queue, or the user's first search would wait behind
 * it (a pure-network prefetch has zero query-engine contention — the search still
 * runs the instant it's issued, just off warm bytes). Non-blocking (not awaited)
 * and best-effort: any failure (offline, file missing, engine off) is swallowed
 * and the first search just fetches the file itself, exactly as before. Warming
 * ONE file (the default) is the conservative choice; downloading it eagerly is
 * the accepted flag-ON trade (owner decision 67, "SPEED PULLED FORWARD").
 */
export function prewarmBallEngine() {
  if (!engineOn || prewarmed) return;
  prewarmed = true;
  const name = "deliveries_m_t20.parquet";
  const version = manifest?.files?.[name]?.sha256_12 ?? "";
  const url = `${DATA_BASE_URL}${name}${version ? `?v=${version}` : ""}`;
  try {
    // Fire-and-forget; drain the body so the whole file lands in the HTTP cache
    // under the same URL DuckDB's ranged reads will use.
    fetch(url)
      .then((res) => (res.ok ? res.arrayBuffer() : null))
      .catch(() => {
        /* best-effort: the first search pays the fetch itself, as before */
      });
  } catch {
    /* fetch unavailable / bad URL — ignore, first search fetches normally */
  }
}
