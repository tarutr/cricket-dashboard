// src/db.js
// The ONLY module that talks to DuckDB-WASM. Everything else (debug page, and
// later Compare Stats / Graph Builder) goes through initDB()/query()/getManifest().
//
// Flow, flag OFF (old engine — unchanged): fetch manifest.json (cache-busted) ->
// load vendored duckdb-wasm -> instantiate AsyncDuckDB -> register each Parquet
// file's HTTP URL (cache-busted with the manifest's per-file content hash) ->
// create SQL views over them (DuckDB then reads them with ranged HTTP requests).
//
// Flow, ball engine ON (Speed build W2, owner rulings 2026-09-28): fetch
// manifest_v2.json + options_v2.json and load duckdb-wasm TOGETHER -> the page is
// usable at once -> src/dataLoader.js keeps every tier file on the member's
// device (downloaded whole, in the background, in the owner's order) and hands
// each one to DuckDB; a view is created once all of its table's tier files are in.
// Every query first waits for exactly the files it reads (query() below) — DuckDB
// never reads over the network in this mode.

import {
  DATA_BASE_URL,
  PARQUET_FILES,
  VENDOR_DUCKDB,
  ballEngineEnabled,
  dataBaseUrlV2,
  isLocalDataMode,
  devIoMode,
  devForceMobileData,
} from "./config.js";
import { buildInningsViewSql, DELIVERY_FILES } from "./ballEngine.js";
import { createDataLoader, sha256Hex12 } from "./dataLoader.js";
import { buildMatchupViewSql } from "./ballEngineMatchup.js";
import { neededViewColumns, coversColumns, unionColumns, columnsArePlayerLocal } from "./ballColumns.js";
import { deliveryWindowPredicate } from "./deliveryWindow.js";
import { opponentPlayerPredicate, opponentPlayerValues } from "./opponentFilter.js";

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

// Ball engine ON (Speed build W2): the plain views and the manifest_v2 TABLE each
// reads (as the union of its tier files, history → year → recent). batting /
// bowling / matchup_* are ball-engine reconstructions; `players` is not created
// (no query reads it — W0; its file is not in manifest_v2).
const TIERED_VIEWS = {
  matches: "matches",
  player_matches: "player_matches",
  fielding: "fielding_events",
  profiles: "player_profiles",
};
const VIEW_FOR_TABLE = Object.fromEntries(Object.entries(TIERED_VIEWS).map(([v, t]) => [t, v]));
const VIEW_TOKEN_RES = Object.entries(TIERED_VIEWS).map(([view, table]) => [new RegExp(`\\b${view}\\b`), table]);

/** The manifest_v2 table behind a LOGICAL delivery file name
 * ("deliveries_m_t20.parquet" → "deliveries_m_t20"). */
function bucketTable(file) {
  return file.replace(/\.parquet$/, "");
}

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
// (The four engine views: batting, bowling, matchup_batting, matchup_bowling —
// see enginePlanDisciplines / viewBackedBy below.)
let engineOn = false; // set by doInit (false) / doInitTiered (true) from ballEngineEnabled()

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

// ── Per-CALL window/opponent (pop-up Tab-2 T-2b-i) ───────────────────────────
// The module globals above are correct for the leaderboard (one active window/
// opponent at a time, set on Search). But the Filters tab fires MANY per-row
// queries where DIFFERENT rows may hold DIFFERENT opponents/windows concurrently
// — a global would let one row's opponent leak into another's numbers. So query()
// takes an OPTIONAL per-call spec that OVERRIDES the globals for THAT query only,
// stored per (SQL + spec signature) below so every in-flight query resolves its
// OWN predicate — a slot keyed by SQL text ALONE would let two in-flight queries
// with IDENTICAL SQL but DIFFERENT specs (e.g. a different opponent/window)
// collide, and the burst-fold look-ahead (widenForPendingQueries) could then read
// the wrong sibling's spec.
// A spec key that is `undefined` falls back to the global (existing callers pass
// no opts ⇒ spec === globals ⇒ byte-identical); an EXPLICIT value (incl. null)
// wins, so a Tab-2 row can force "no opponent/window" independent of the
// leaderboard's global state.
/** (SQL + spec signature) -> { sql, spec } for the in-flight engine queries.
 * Keyed by BOTH the SQL and a signature of the per-call spec so identical-SQL /
 * different-spec siblings never share a slot; the value carries the SQL back so
 * the fold look-ahead can iterate (sql, spec) pairs. Look-ahead bookkeeping ONLY
 * — the key never enters a query and each query still closure-captures its own
 * spec for execution, so no number can move. */
const pendingEngineSpecs = new Map();

/** Discipline-independent signature of a per-call spec ({deliveryWindow,
 * opponentPlayer}), capturing every field that changes the ball predicate in a
 * fixed key order. Used ONLY to key pendingEngineSpecs (collision avoidance): an
 * over-split (two equal specs → two slots) at worst misses a fold — a perf cost,
 * never a wrong number. */
function specSignature(spec) {
  const w = (spec && spec.deliveryWindow) || null;
  // Multi-select (decision 88): fold EVERY opponent id — sorted + joined — into the
  // signature, so two DIFFERENT opponent sets never collide the burst-fold slot.
  // null when no opponent (byte-identical key to the pre-multi single-id path for a
  // lone opponent). Look-ahead bookkeeping only — never enters a query.
  const oppIds = opponentPlayerValues(spec && spec.opponentPlayer).map((p) => p.id).sort();
  const oppId = oppIds.length ? oppIds.join(",") : null;
  return JSON.stringify({
    phase: (w && w.phase) || null,
    overs: (w && w.overs) || null,
    balls: (w && w.balls) || null,
    player: (w && w.player) || null,
    opp: oppId,
  });
}

/** The composite pendingEngineSpecs key for a query — the spec signature and
 * the SQL wrapped in a JSON array, so the two parts are unambiguously delimited
 * (the SQL is JSON-escaped and can never run into the signature). */
function pendingSpecKey(sql, spec) {
  return JSON.stringify([specSignature(spec), sql]);
}

/** Resolve a query's effective window/opponent spec: per-call opts where the key
 * is present, otherwise the module global. */
function effectiveSpec(opts) {
  return {
    deliveryWindow: opts && opts.deliveryWindow !== undefined ? opts.deliveryWindow : activeDeliveryWindow,
    opponentPlayer: opts && opts.opponentPlayer !== undefined ? opts.opponentPlayer : activeOpponentPlayer,
  };
}

/** The active BALL-level predicate for one engine discipline — the delivery
 * window AND the opponent-player head-to-head, composed, for a given `spec`
 * (`{deliveryWindow, opponentPlayer}`; falls back to the module globals when a
 * spec is not supplied — keeping legacy internal call shapes byte-identical).
 * "" when neither is set (byte-identical to today). Discipline selects the
 * window's player clock (bat_ball vs bowl_ball) AND the opponent's opposite-role
 * id column (bowler_id for a batting query, batter_id for a bowling query). When
 * only the window is set the window string is returned VERBATIM (byte-identical to
 * the pre-T-1 behaviour); when only the opponent is set, just its clause; both ⇒
 * AND-composed. */
function windowPredicateFor(discipline, spec) {
  const s = spec || { deliveryWindow: activeDeliveryWindow, opponentPlayer: activeOpponentPlayer };
  const win = deliveryWindowPredicate(s.deliveryWindow, discipline);
  const opp = opponentPlayerPredicate(s.opponentPlayer, discipline);
  if (!opp) return win; // opponent inactive → byte-identical to the window-only path
  if (!win) return opp;
  return `${win} AND (${opp})`;
}

/** Generate the reconstruction SELECT for an engine view, dispatching to the
 * plain (ballEngine.js) or matchup (ballEngineMatchup.js) generator by name.
 *
 * Speed build W2 — the ONE place logical file names become physical ones: every
 * other part of the engine (scopeForQuery, the cache signature, the fold
 * look-ahead) keeps keying on the six LOGICAL bucket names
 * ("deliveries_m_t20.parquet"); here each is expanded to that bucket's tier files
 * from manifest_v2, in chronological order (history, year, recent). W2 proved
 * read_parquet([history, year, recent]) is row-for-row identical, in order, to the
 * single bucket file, so the generated SQL (untouched) returns the same numbers. */
function engineViewSql(discipline, opts) {
  const o = loader ? { ...opts, files: opts.files.flatMap((f) => loader.filesForTable(bucketTable(f))) } : opts;
  if (discipline === "batting" || discipline === "bowling") return buildInningsViewSql(discipline, o);
  return buildMatchupViewSql(discipline, o);
}
// (Speed build W2: the old boot-time "seed" — unmaterialised engine views over
// all six delivery files — is gone. Creating it needs every delivery file on
// hand (85 MB), and it was never executed: every query goes through
// ensureEngineScope, whose materialize() → pointViewAt() creates the view.)

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
  // Speed build W2: the generated SQL reads this bucket set's tier files and (the
  // matchup views) the `profiles` / `player_matches` views — make sure they are
  // all in first. Normally instant: query() already waited for this query's own
  // needs; this covers columns folded in from a queued sibling (e.g. vs_potm →
  // player_matches) so DuckDB never meets a file or view that is not there yet.
  const dataWait = loader ? loader.ensureTables([...files.map(bucketTable), ...baseTablesForSql(sql)]) : null;
  if (dataWait) await dataWait;
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
 * so an in-query per-player sub-use (e.g. profile_cte / fielding_cte, each
 * computed over the core scope) still sees every core-scope innings.
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

/**
 * Widen `need` with the column needs of the other queries already sitting in
 * the queue, when they resolve to the SAME (files, scopePredicate, player scope)
 * signature. Pure look-ahead — it changes only how many columns get
 * materialised. The player-predicate must also match, so a popup battery's
 * same-player sections fold into ONE player-scoped table while a whole-scope
 * query is never mixed into a player-scoped one (or vice versa).
 */
function widenForPendingQueries(need, discipline, sql, files, scopePredicate, windowPredicate, playerPredicate) {
  if (pendingEngineSpecs.size < 2) return need;
  // The window/opponent is now PER-CALL (T-2b-i): each in-flight query carries its
  // OWN spec, so a folded sibling must match on ITS OWN window predicate, not this
  // query's. pendingEngineSpecs is keyed by SQL + spec signature and its value
  // carries the SQL back, so we iterate (sql, spec) PAIRS here — a sibling with
  // IDENTICAL SQL but a different spec no longer overwrites the slot, so the fold
  // reads each sibling's OWN spec. When every query shares the global spec (the
  // leaderboard case), each otherWindow equals windowPredicate exactly, so fold
  // behaviour is byte-identical to before; a Tab-2 row with a different
  // opponent/window simply gets a different signature and is never folded in
  // (safe: folding only ever adds columns, but a mismatched window must not fold).
  const signature = `${files.join("|")}::${scopePredicate}::${windowPredicate}::${playerPredicate}`;
  let columns = need.columns;
  let full = need.full;
  let reason = need.reason;
  for (const { sql: other, spec: otherSpec } of pendingEngineSpecs.values()) {
    if (other === sql || full) continue;
    if (!enginePlanDisciplines(other).includes(discipline)) continue;
    const otherScope = scopeForQuery(other);
    const otherNeed = neededViewColumns(discipline, other);
    const otherPlayer = playerScopeFor(discipline, other, otherNeed);
    const otherWindow = windowPredicateFor(discipline, otherSpec);
    if (`${otherScope.files.join("|")}::${otherScope.scopePredicate}::${otherWindow}::${otherPlayer}` !== signature) continue;
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
async function ensureEngineScope(sql, spec) {
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
    // the innings to those with ≥1 in-window ball — decision 67). Uses THIS
    // query's per-call spec (T-2b-i) — the module globals when no spec was passed.
    const windowPredicate = windowPredicateFor(discipline, spec);
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
let manifest = null; // manifest.json (flag off) or manifest_v2.json (ball engine on)
let db = null; // AsyncDuckDB instance
let conn = null; // shared AsyncDuckDBConnection

// ── Speed build W2 state (ball engine on only; all null/empty flag-off) ───────
let loader = null; // src/dataLoader.js instance
let duckdbModule = null; // the duckdb-wasm module (DuckDBDataProtocol)
let optionsV2 = null; // parsed options_v2.json, or null ⇒ callers keep their SQL path
let askBeforeBackground = false; // Android mobile data: ask before downloading everything
let pendingPriority = null; // a setDownloadPriority() that arrived before the loader existed
const progressSubscribers = new Set();

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

  try {
    // Perf switch (owner decision, 2026-09-28): without this, duckdb-wasm fetches
    // each remote Parquet file WHOLE (measured: a footer-only COUNT(*) on a 15.5 MB
    // file took 15.0s; boot ~50s). These flags force genuine HTTP range requests
    // (2.2s / ~9.5s, anchors identical). `query`, `path` and `accessMode` are left
    // out on purpose: this is the only open() call, so omitted fields keep
    // duckdb-wasm's compiled defaults — SUMs still arrive as BigInt (normalizeValue).
    await instance.open({
      filesystem: {
        reliableHeadRequests: true,
        allowFullHTTPReads: false,
        forceFullHTTPReads: false,
      },
    });
  } catch (e) {
    throw makeError(
      e,
      `Failed to configure DuckDB-WASM's filesystem (ranged HTTP reads). The vendored duckdb-wasm build may not support this option.`
    );
  }

  return { duckdb, db: instance };
}

// A file missing its manifest entry (sha256_12) gets a timestamp version, cached
// per file so repeated calls build the SAME URL.
const fallbackParquetVersions = new Map();

/** The versioned R2 URL for a Parquet file, from the loaded manifest's content
 * hash (or a cached fallback timestamp — see fallbackParquetVersions above).
 * Flag-off (old engine) only: registerData's registerFileURL. */
function parquetFileUrl(name, manifestData) {
  const fileInfo = manifestData?.files?.[name];
  let version = fileInfo?.sha256_12;
  if (version == null) {
    if (!fallbackParquetVersions.has(name)) fallbackParquetVersions.set(name, Date.now());
    version = fallbackParquetVersions.get(name);
  }
  return `${DATA_BASE_URL}${name}?v=${version}`;
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
      const url = parquetFileUrl(name, manifestData);
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
  // Flag-off only (Speed build W2): with the ball engine on, doInitTiered runs
  // instead and this function is never called — so every view here is the plain
  // pre-aggregated parquet, exactly as before the engine existed.
  await Promise.all(
    Object.entries(VIEWS).map(async ([viewName, fileName]) => {
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
}

async function doInit(onProgress) {
  // Ball engine on → the device-kept tier-file loader (Speed build W2).
  if (ballEngineEnabled()) return doInitTiered(onProgress);
  engineOn = false; // flag off: the old engine, byte-untouched below
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

// ── Speed build W2: ball-engine boot (manifest_v2 + device-kept tier files) ───

/** Fetch a small JSON file past every cache; returns { json, bytes }. */
async function fetchJsonNoStore(url, label) {
  let res;
  try {
    res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  } catch (e) {
    throw makeError(
      e,
      `Could not reach the data server to fetch ${label}. Check your internet connection, or the data bucket may be down/misconfigured (CORS?). (${url})`
    );
  }
  if (!res.ok) {
    throw makeError(
      new Error(`${label} HTTP ${res.status}`),
      `${label} responded with HTTP ${res.status}. The data bucket may be misconfigured, or the data pipeline has not published it yet. (${url})`
    );
  }
  try {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { json: JSON.parse(new TextDecoder().decode(bytes)), bytes };
  } catch (e) {
    throw makeError(e, `${label} was not valid JSON. The pipeline may have written a corrupt file. (${url})`);
  }
}

/**
 * Ball-engine boot. The page is usable as soon as DuckDB, manifest_v2.json and
 * options_v2.json are in — no data file is awaited here. The loader then keeps
 * the tier files on the device in the background; each query waits for exactly
 * the files it reads (query()).
 */
async function doInitTiered(onProgress) {
  engineOn = true;
  const base = dataBaseUrlV2();
  if (onProgress) onProgress({ stage: "manifest" });
  // The catalogue, the dropdown lists and DuckDB itself are independent —
  // fetch all three at once.
  const manifestP = fetchJsonNoStore(`${base}manifest_v2.json`, "manifest_v2.json");
  const optionsP = fetchJsonNoStore(`${base}options_v2.json`, "options_v2.json").catch((e) => {
    // eslint-disable-next-line no-console
    console.warn("[cricdb] options_v2.json unavailable — dropdown lists fall back to live queries.", e && e.message);
    return null;
  });
  const duckP = loadDuckDB(onProgress);
  duckP.catch(() => {}); // awaited below; never an unhandled rejection meanwhile

  let m2;
  try {
    m2 = (await manifestP).json;
    if (!m2 || typeof m2.files !== "object" || !m2.files) {
      throw makeError(new Error("manifest_v2.json has no files"), "manifest_v2.json is missing its file list. The pipeline may have written a corrupt catalogue.");
    }
  } catch (e) {
    duckP.then(({ db: d }) => d.terminate()).catch(() => {}); // don't leak the worker on Retry
    throw e;
  }

  if (onProgress) onProgress({ stage: "loading-duckdb" });
  const { duckdb, db: dbInstance } = await duckP;
  duckdbModule = duckdb;
  db = dbInstance;

  if (onProgress) onProgress({ stage: "connecting" });
  try {
    conn = await db.connect();
  } catch (e) {
    throw makeError(e, "Could not open a connection to the in-browser DuckDB instance.");
  }

  optionsV2 = await verifiedOptions(await optionsP, m2);
  manifest = m2;
  startLoader(base, m2);
  // eslint-disable-next-line no-console
  console.info(
    `[cricdb] ball engine ON (?engine=ball) — data from ${base}manifest_v2.json, kept on this device ` +
      `(${devIoMode()} reads)${isLocalDataMode() ? " [DEV: ?data=local]" : ""}`
  );

  if (onProgress) onProgress({ stage: "ready" });
  return { manifest };
}

/** options_v2.json is only trusted when it is the one manifest_v2 lists (same
 * pipeline run): a mismatch means null, and every caller then keeps its live SQL
 * path — always correct, just slower. */
async function verifiedOptions(fetched, m2) {
  if (!fetched) return null;
  const want = m2 && m2.options && m2.options.sha256_12;
  if (want) {
    const got = await sha256Hex12(fetched.bytes);
    if (got != null && got !== want) {
      // eslint-disable-next-line no-console
      console.warn("[cricdb] options_v2.json is from a different data run than manifest_v2.json — using live queries instead.");
      return null;
    }
  }
  return fetched.json;
}

function startLoader(base, m2) {
  const io = devIoMode();
  const dirName = isLocalDataMode() ? "cricdb-data-local" : "cricdb-data";
  loader = createDataLoader({
    baseUrl: base,
    fetchImpl: (url, init) => fetch(url, init),
    openDirectory: () => (io === "memory" ? Promise.resolve(null) : openDataDirectory(dirName)),
    locks: typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null,
    register: registerDataFile,
    onTableReady: createTableView,
    syncWrite: (deviceName, bytes) => syncWriteViaWorker(dirName, deviceName, bytes),
    ioMode: io,
    emit: (snap) => {
      for (const cb of progressSubscribers) {
        try {
          cb(snap);
        } catch {
          /* a subscriber's bug must not stop the downloads */
        }
      }
    },
    // eslint-disable-next-line no-console
    log: (...args) => console.info("[cricdb] data:", ...args),
  });
  // Owner ruling: on Android mobile data, ASK before downloading everything;
  // until the member answers, only what each search needs is downloaded.
  askBeforeBackground = onMobileData();
  loader.setBackground(askBeforeBackground ? "hold" : "on");
  if (pendingPriority) loader.setPriority(pendingPriority);
  loader.start(m2);
  // eslint-disable-next-line no-console
  for (const f of DELIVERY_FILES) if (!loader.hasTable(bucketTable(f))) console.warn(`[cricdb] manifest_v2.json lists no ${f} tier files.`);
}

/** "On Android mobile data" per the owner's ruling: the Network Information API
 * reports a cellular connection or Data Saver. (iPhone / most desktops have no
 * such API → download everything without asking.) DEV: ?net=cellular. */
function onMobileData() {
  if (devForceMobileData()) return true;
  try {
    const c = typeof navigator !== "undefined" ? navigator.connection : null;
    return !!(c && (c.type === "cellular" || c.saveData === true));
  } catch {
    return false;
  }
}

/** The device-storage folder for the data (OPFS), or null when this browser /
 * window cannot keep files (private windows, old browsers) — the loader then
 * keeps everything in memory for the visit. Never throws, never hangs boot. */
async function openDataDirectory(name) {
  try {
    if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.getDirectory !== "function") {
      return null;
    }
    const root = await Promise.race([
      navigator.storage.getDirectory(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("device storage did not open in 5 s")), 5000)),
    ]);
    return await root.getDirectoryHandle(name, { create: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.info("[cricdb] device storage unavailable — this visit keeps the data in memory only.", e && e.message);
    return null;
  }
}

/** Hand one file to DuckDB. A File from device storage is read in place
 * (BROWSER_FILEREADER — range reads straight from disk, nothing held in memory);
 * FSACCESS is the opt-in alternative (?io=fsaccess); a buffer is the in-memory
 * fallback. `name` is the manifest file name the views / engine SQL use. */
async function registerDataFile(name, source) {
  const P = duckdbModule.DuckDBDataProtocol;
  if (source.kind === "handle") {
    await db.registerFileHandle(name, source.handle, P.BROWSER_FSACCESS, true);
    return "device (fsaccess)";
  }
  if (source.kind === "file") {
    await db.registerFileHandle(name, source.file, P.BROWSER_FILEREADER, true);
    return "device (filereader)";
  }
  await db.registerFileBuffer(name, source.bytes);
  return "memory";
}

/** Create a plain view over the union of its table's tier files, in tier order
 * (history, year, recent) — row-for-row identical to the old single file. */
async function createTableView(table, fileNames) {
  const view = VIEW_FOR_TABLE[table];
  if (!view) return; // delivery tables: read directly by the ball engine (engineViewSql)
  const list = fileNames.map((f) => `'${f}'`).join(", ");
  try {
    await conn.query(`CREATE OR REPLACE VIEW ${view} AS SELECT * FROM read_parquet([${list}])`);
  } catch (e) {
    throw makeError(
      e,
      `Could not create the "${view}" view from its data files. The files may be corrupt or unreadable by DuckDB-WASM.`
    );
  }
}

// Older Safari has device storage but no FileSystemFileHandle.createWritable, so
// a file can only be written from a worker via a sync access handle. This tiny
// inline worker does exactly that (the `await`s also cover Safari 15.2–16's
// promise-returning variant of the same API). The bytes are COPIED to it, not
// transferred, so the loader keeps them for the in-memory fallback.
const SYNC_WRITER_SRC = `self.onmessage = async (e) => {
  const { id, dir, name, bytes } = e.data;
  let h = null;
  try {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir, { create: true });
    const fh = await d.getFileHandle(name, { create: true });
    h = await fh.createSyncAccessHandle();
    await h.truncate(0);
    let off = 0;
    while (off < bytes.byteLength) {
      const n = await h.write(bytes.subarray(off), { at: off });
      if (!n) throw new Error("write stalled");
      off += n;
    }
    await h.flush();
    await h.close();
    h = null;
    self.postMessage({ id, ok: true });
  } catch (err) {
    try { if (h) await h.close(); } catch (_) {}
    self.postMessage({ id, ok: false, name: (err && err.name) || "Error", message: String((err && err.message) || err) });
  }
};`;
let syncWriter = null;
let syncWriterSeq = 0;
const syncWriterPending = new Map();

function syncWriteViaWorker(dirName, deviceName, bytes) {
  return new Promise((resolve, reject) => {
    try {
      if (!syncWriter) {
        const url = URL.createObjectURL(new Blob([SYNC_WRITER_SRC], { type: "text/javascript" }));
        syncWriter = new Worker(url);
        syncWriter.onmessage = (e) => {
          const p = syncWriterPending.get(e.data.id);
          if (!p) return;
          syncWriterPending.delete(e.data.id);
          if (e.data.ok) p.resolve();
          else p.reject(Object.assign(new Error(e.data.message), { name: e.data.name }));
        };
        syncWriter.onerror = (ev) => {
          for (const p of syncWriterPending.values()) p.reject(new Error(`device-storage writer failed: ${ev && ev.message}`));
          syncWriterPending.clear();
        };
      }
      const id = ++syncWriterSeq;
      syncWriterPending.set(id, { resolve, reject });
      syncWriter.postMessage({ id, dir: dirName, name: deviceName, bytes });
    } catch (e) {
      reject(e);
    }
  });
}

/** The manifest_v2 tables a query's SQL reads, derived from the views / engine
 * buckets it touches:
 *   • each plain view named in it (matches / player_matches / fielding / profiles
 *     — a name inside a string literal counts too, which keeps the
 *     information_schema probe correct; over-inclusion only waits for a small
 *     shared file);
 *   • for a ball-engine query, the delivery bucket(s) scopeForQuery picks (the
 *     same superset-safe rule the engine itself uses), plus — for the matchup
 *     views — `profiles`, and `player_matches` when the vs-PotM axis is named.
 * Exported (like scopeForQuery) so the offline harness derives a query's needs
 * EXACTLY as the runtime does. Returns a Set of manifest_v2 table names. */
export function tablesForSql(sql) {
  const need = baseTablesForSql(sql);
  const disciplines = enginePlanDisciplines(sql);
  if (disciplines.length) {
    for (const f of scopeForQuery(sql).files) need.add(bucketTable(f));
    if (disciplines.some((d) => d.startsWith("matchup_"))) {
      need.add(TIERED_VIEWS.profiles);
      if (/\bvs_potm\b/.test(sql)) need.add(TIERED_VIEWS.player_matches);
    }
  }
  return need;
}

function baseTablesForSql(sql) {
  const need = new Set();
  for (const [re, table] of VIEW_TOKEN_RES) if (re.test(sql)) need.add(table);
  return need;
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
export async function query(sql, opts) {
  if (!conn) {
    throw makeError(
      new Error("query() called before initDB() completed"),
      "The database is not ready yet. Please wait for initialization to finish and try again."
    );
  }
  // Flag OFF: byte-untouched — straight to the connection, no queue, no engine.
  // The per-call spec is a ball-engine concept (it feeds the reconstruction's base
  // predicate), so flag-off it is irrelevant and ignored — the pop-up's per-innings
  // slices reach flag-off via buildQuery's inningsWhere, not this path.
  if (!engineOn) return runQuery(sql);
  // Flag ON: the batting/bowling VIEWS are re-pointed per query (at that query's
  // scope + column set), so two queries must never be in flight at once — the
  // second would run against the first's view definition. One shared connection
  // is serialised by the DuckDB worker anyway, so this costs nothing and it also
  // means concurrent same-scope callers (the popup's section battery, a graph's
  // parallel fetches) collapse onto ONE materialisation — see
  // widenForPendingQueries, which reads this queue to build for all of them at
  // once instead of once per member.
  // T-2b-i: resolve THIS query's effective window/opponent spec (per-call opts
  // overriding the module globals) and record it under a (SQL + spec signature)
  // key so the serialised execution + the look-ahead widening both read the right
  // one — an identical-SQL sibling with a different spec now gets its own slot
  // instead of overwriting this one. Resolved BEFORE the data wait below, so a
  // Search committed while this query waits can never lend it a different window.
  const spec = effectiveSpec(opts);
  // Speed build W2: wait for exactly the files this query reads (bumping them to
  // the front of the download queue). Instant once they are on the device. It
  // joins the serialised engine queue only afterwards, so a query whose data is
  // already in never waits behind another query's download. (No `await` at all
  // when the data is in, so a burst of queries still registers in
  // pendingEngineSpecs synchronously — the fold look-ahead sees them all.)
  const dataWait = loader ? loader.ensureTables(tablesForSql(sql)) : null;
  if (dataWait) await dataWait;
  const pendingKey = pendingSpecKey(sql, spec);
  pendingEngineSpecs.set(pendingKey, { sql, spec });
  return serializeEngineQuery(() => runQuery(sql, spec)).finally(() => {
    pendingEngineSpecs.delete(pendingKey);
  });
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

async function runQuery(sql, spec) {
  const start = performance.now();
  // Ball engine: point the batting/bowling views at a table materialised for
  // this query's scope AND column needs before it runs. No-op when the flag is
  // off or the query does not touch those views. Inside the timer on purpose —
  // with the flag on, the reconstruction IS the query's cost. `spec` is this
  // query's per-call window/opponent (T-2b-i); undefined on the flag-off path
  // (ensureEngineScope returns [] there anyway) and for legacy internal callers.
  const plan = await ensureEngineScope(sql, spec);
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

/** Returns the parsed manifest (or null if init hasn't completed yet):
 * manifest.json flag-off, manifest_v2.json with the ball engine on. Callers read
 * only `generated_at` and `data.{min,max}_match_date` / `data.match_count`,
 * which both carry in the same shape. */
export function getManifest() {
  return manifest;
}

// ── Speed build W2: public loader API (all no-ops / null with the flag off) ───
// (FIX 3's prewarmBallEngine — a background fetch of deliveries_m_t20 into the
// HTTP cache — is gone: the loader's background queue downloads that bucket
// early anyway, and keeps it on the device.)

/** The parsed options_v2.json (boot dropdown lists / availability booleans),
 * or null — flag off, not published, or from a different data run than
 * manifest_v2.json. null ⇒ callers keep today's SQL path. */
export function getOptionsV2() {
  return optionsV2;
}

/** Scope keys (state.js FORMAT_BUCKETS) → the delivery bucket each reads —
 * the same bucket scopeForQuery derives from those keys' match types. */
const FORMAT_KEY_BUCKET = { T20: "t20", "50 Over": "odi", "Red Ball": "red" };

/** {gender, formats} (store shape) → the loader's {gender: "m"|"f"|null, buckets}.
 * Exported for the offline harness (checked against state.js FORMAT_BUCKETS). */
export function scopeToPriority(scope) {
  const gender = scope && scope.gender === "female" ? "f" : scope && scope.gender === "male" ? "m" : null;
  const buckets = ((scope && scope.formats) || []).map((k) => FORMAT_KEY_BUCKET[k]).filter(Boolean);
  return { gender, buckets };
}

/** Owner ruling: the background queue favours the member's CURRENT gender/format
 * (after the shared files), live as they change the Filters popup. main.js calls
 * this on every store change; cheap and idempotent. `scope` = {gender, formats}. */
export function setDownloadPriority(scope) {
  const p = scopeToPriority(scope);
  if (!loader) {
    pendingPriority = p;
    return;
  }
  loader.setPriority(p);
}

/**
 * Make sure the data files a query (or a scope) needs are on hand, jumping them
 * to the front of the queue. `target` = one SQL string, an array of them, or a
 * scope {gender, formats}. Returns null when everything is already in (flag off:
 * always null), else a Promise that resolves once DuckDB can read all of them.
 * `onProgress({loadedBytes, totalBytes, files, readyFiles})` fires while some
 * still have to download — the Search's "Downloading the data for this search"
 * line. query() waits on its own anyway; this exists for the progress line.
 */
export function ensureFilesForQuery(target, onProgress) {
  if (!loader) return null;
  const tables = new Set();
  const add = (t) => {
    if (typeof t === "string") {
      for (const x of tablesForSql(t)) tables.add(x);
    } else if (t && typeof t === "object") {
      for (const x of Object.values(TIERED_VIEWS)) tables.add(x);
      const { gender, buckets } = scopeToPriority(t);
      const genders = gender ? [gender] : ["m", "f"];
      const bs = buckets.length ? buckets : ["t20", "odi", "red"];
      for (const g of genders) for (const b of bs) tables.add(`deliveries_${g}_${b}`);
    }
  };
  if (Array.isArray(target)) target.forEach(add);
  else add(target);
  return loader.ensureTables([...tables], onProgress);
}

/** Subscribe to whole-site download progress (a snapshot of every file:
 * state, bytes, loaded; plus storage "device"|"memory" and the background mode).
 * Fires on change (throttled) and once at once if the loader exists.
 * Returns an unsubscribe function. */
export function onDownloadProgress(cb) {
  if (typeof cb !== "function") return () => {};
  progressSubscribers.add(cb);
  if (loader) {
    try {
      cb(loader.snapshot());
    } catch {
      /* subscriber bug — ignore */
    }
  }
  return () => progressSubscribers.delete(cb);
}

/** Owner ruling (Android mobile data): resolves to {bytes} — how much is still
 * to download — when the member should be ASKED before everything downloads in
 * the background; null otherwise (flag off, not on mobile data, or nothing left
 * to download). Background downloads stay held until setBackgroundDownloads(). */
export async function getMobileDataPrompt() {
  if (!loader || !askBeforeBackground) return null;
  await loader.whenScanned();
  const bytes = loader.remainingBytes();
  return bytes > 0 ? { bytes } : null;
}

/** The member's answer: true → download everything in the background; false →
 * download only what each search needs. No-op flag off. */
export function setBackgroundDownloads(enabled) {
  if (loader) loader.setBackground(enabled ? "on" : "off");
}
