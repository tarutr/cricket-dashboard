// src/graph/players.js
//
// Player selection for the Graph Builder (SPEC §6). Batch 8 (decision 44d)
// rebuilds this on v1's two-list model:
//   - candidates: the FULL ordered pool (from seeding + manual adds/search).
//     NEVER truncated by anything except an explicit × removal.
//   - checked:    the SUBSET actually plotted, capped by the active chart
//     type's max, user-controlled via checkboxes in "manual" mode or
//     re-derived by rank in "best"/"worst" mode (see graph.js's
//     deriveChecked() — ranking needs metric VALUES, which requires a DB
//     query, so it lives in graph.js alongside the other chart-domain
//     queries, not here).
// This module owns ONLY the selection list + caps + the seed/search queries;
// it does not know about chart rendering (see charts.js) or the card (card.js).

import { getMetric } from "../metrics.js";
import { query } from "../db.js";
import { buildScopeClauses } from "../filters.js";
import { buildQuery } from "../table.js";
import { escSql as esc } from "../state.js";

// Batch 3 (graphs, part 1): caps became {min, max} per owner ruling
// (decision 43) — below `min` the chart can't be meaningfully drawn (the
// paper card shows a short note instead, see graph.js); `max` is the
// existing per-chart-type ceiling. Consumers that only ever needed the
// ceiling (this module's own createSelection, seeding) read `.max`; the
// export name itself is unchanged (task brief: don't rename it).
export const CHART_CAPS = {
  bar: { min: 2, max: 15 },
  radar: { min: 1, max: 6 },
  scatter: { min: 5, max: 60 },
  // Batch 4 part 1 (decision 43): Phases (grouped bars, one group per player —
  // gets crowded fast, so a tighter ceiling than bar's) and Slope (a
  // two-column line-per-player chart — same "needs at least two to compare"
  // floor as bar, roomier ceiling since each player is just one line).
  phases: { min: 2, max: 8 },
  slope: { min: 2, max: 12 },
  // Batch 4 wave 2: By year (a line per player — min 1 so a single player's
  // career trend is still meaningful on its own, unlike a comparison chart)
  // and Dumbbell (needs at least two players to make "the gap" a comparison
  // at all; roomier ceiling — one connector per player is compact).
  byyear: { min: 1, max: 6 },
  dumbbell: { min: 2, max: 12 },
  // B8b (Benchmark, decision 44e): unlike every OTHER chart type, the
  // checked roster here does NOT bound what gets DRAWN — the chart draws one
  // row per selected METRIC, comparing one ANCHOR player against the best of
  // the WHOLE filtered pool (a separate, unrestricted query — see
  // src/graph/benchmark.js's fetchBenchmarkPool). The roster's only job is to
  // source the anchor's own candidate list (the <select> in
  // graph.js's renderMetricControls' benchmark branch). min:1 so there's
  // always at least one anchor choice; max:15 is simply "roomy enough for a
  // sensible anchor shortlist" — not a chart-drawing ceiling the way every
  // other type's max is.
  benchmark: { min: 1, max: 15 },
};

const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };

/** The value the active sort metric ranks by for one seed row — the `__sort`
 * shadow column when the metric defines one, else the metric's own column.
 * Mirrors table.js's sortValueFor(). NULL/undefined stays null (sorts last). */
function seedSortValue(row, metric, key) {
  const raw = metric.sortExpression ? row[`${key}__sort`] : row[key];
  return raw === null || raw === undefined ? null : Number(raw);
}

/** Client-side comparator matching table.js's compareRows exactly: NULLs sort
 * LAST regardless of direction; equal values break by id ASC for a
 * deterministic pool order. Done in JS (not a SQL ORDER BY) so it works for
 * EVERY metric uniformly — see seedFromFilteredSet's own doc comment on why a
 * SQL ORDER BY cannot be used for the `matches` metric. */
function compareSeedRows(a, b, metric, key, dir) {
  const va = seedSortValue(a, metric, key);
  const vb = seedSortValue(b, metric, key);
  if (va === null && vb === null) return String(a.id).localeCompare(String(b.id));
  if (va === null) return 1; // a's value missing -> a after b
  if (vb === null) return -1; // b's value missing -> b after a
  if (va !== vb) return dir === "asc" ? va - vb : vb - va;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Seed the candidate pool from the current filtered Stats result set, ordered
 * by the table's active sort. Returns [{id, name}] for the ENTIRE filtered set
 * (owner point 13 — the pool is no longer force-capped to 15; the roster
 * dropdown filters/renders a slice, and each chart type caps only what's
 * CHECKED, never the pool itself).
 *
 * OWNER POINT 9 (binder-error fix): this used to wrap buildQuery's `sql` in an
 * outer `SELECT * ... ORDER BY <sortKey> ... LIMIT cap`. That crashed
 * ("Binder Error: Referenced column \"matches\" not found in FROM clause")
 * whenever the active sort key was `matches`: buildQuery routes the
 * `source: "player_matches"` metric (only `matches`) to a SEPARATE `matchesSql`
 * query merged in JS, so `matches` is NOT a column in `sql` — ordering `sql` by
 * it references a column that isn't there. The failing seed threw, was caught
 * by graph.js's seedSelection(), and left the pool EMPTY (the "pool comes over
 * empty" symptom) while "Reset to filtered set" surfaced the raw binder text.
 *
 * Fix: rank CLIENT-SIDE, exactly as table.js itself does (it never SQL-orders
 * either — see its applySort/compareRows). We fetch `sql` (+ `matchesSql` when
 * present), merge `matches` in JS, then sort with compareSeedRows(). This is
 * metric-agnostic, so `matches` — or any future player_matches-sourced metric —
 * ranks correctly instead of crashing. The projection stays lean: only the
 * active sort metric's column(s) are requested (id/name come for free from
 * buildQuery), so the full-set fetch is light over the wire even at ~2,800
 * players.
 *
 * hasMetricData is NOT applied here (unchanged): a player with a NULL sort value
 * still seeds (sorted last). The "Excluded (no data)" note the Graph Builder
 * shows operates on the CHARTED metric against the already-seeded roster and is
 * untouched.
 */
export async function seedFromFilteredSet(store) {
  const state = store.get();
  const discipline = state.discipline;
  const sortKey = state.sort.key;
  const sortMetric = getMetric(sortKey, discipline);

  // Lean projection: only the active sort metric's column(s). Requesting the
  // sort key (even `matches`) makes buildQuery emit the right source query
  // (and matchesSql when the metric lives in player_matches); id/name are
  // always projected by buildQuery regardless.
  const seedCols = sortMetric ? [sortKey] : [];
  const { sql, matchesSql } = buildQuery(state, seedCols);

  const [{ rows }, matchesResult] = await Promise.all([
    query(sql),
    matchesSql ? query(matchesSql) : Promise.resolve({ rows: [] }),
  ]);

  let merged = rows;
  if (matchesSql) {
    const byId = new Map(matchesResult.rows.map((r) => [r.id, r.matches]));
    merged = rows.map((r) => ({ ...r, matches: byId.get(r.id) ?? null }));
  }

  if (sortMetric) {
    merged = merged.slice().sort((a, b) => compareSeedRows(a, b, sortMetric, sortKey, state.sort.dir));
  }

  return merged.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Search for players within the current scope (same ILIKE approach as the
 * player-search box), for manual add. Returns [{id, name}].
 *
 * OWNER POINT 9 (dead-search fix): this used to DROP any match already in the
 * candidate pool (`excludeIds`). Since the pool is now the ENTIRE filtered set
 * (owner point 13), every in-scope player is already a candidate, so that
 * exclusion made the search return "No matches" for literally everyone (the
 * "Kohli finds nothing" symptom). It now returns all matches; graph.js's result
 * list marks the ones already in the roster and, on click, simply (re)checks
 * them instead of erroring — so a searched name always comes back.
 */
export async function searchPlayers(store, searchText) {
  const state = store.get();
  const discipline = state.discipline;
  const view = discipline; // "batting" | "bowling" view names match discipline
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];

  const whereClauses = buildScopeClauses(state, {
    includeTeams: true,
    teamColumn: teamCol,
    idColumn: idCol,
    oppositionColumn: discipline === "batting" ? "bowling_team" : "batting_team",
    // Plain bowling view has no batting_position column; the striker-position
    // filter is matchup-only — see charts.js's fetchSelectedPlayerMetrics.
    includePositions: discipline === "batting",
  });
  const term = (searchText || "").trim();
  // Escape LIKE wildcards (\ % _) so a literal '%'/'_' in the roster name search
  // matches that character, not a pattern (mirrors playerData.js searchPlayers).
  if (term) whereClauses.push(`${nameCol} ILIKE '%${esc(term.replace(/([\\%_])/g, "\\$1"))}%' ESCAPE '\\'`);

  const sql = [
    `SELECT ${idCol} AS id, ${nameCol} AS name, COUNT(*) AS n`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, ${nameCol}`,
    `ORDER BY n DESC, name ASC`,
    `LIMIT 25`,
  ].join("\n");

  const { rows } = await query(sql);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Whole-database career games per player — the SAME "appearances" measure the
 * omnisearch player search ranks by (playerData.js's searchPlayers:
 * COUNT(DISTINCT match_id) over ALL player_matches rows for a player_id, every
 * gender/format/date, NOT the current leaderboard scope). This is what the
 * Graph Builder's auto-selection ranks candidates by so the biggest names are
 * always the ones plotted when a chart has to choose which of many candidates
 * to draw (R6, owner fix 2 — "we want the biggest names selected always").
 *
 * NOTE (numbers rule): this measures WHICH players get auto-selected, never
 * what any metric computes for a player. It is deliberately scope-INDEPENDENT
 * (whole-DB games, not filtered-scope games, not the charted metric) exactly
 * as the owner specified and as the search ranking already works.
 *
 * The whole map is fetched ONCE per session and cached: it's a single small
 * GROUP BY over player_matches (one row per player, a few thousand rows), and
 * it never changes within a session (the Parquet is static), so every
 * subsequent auto-pick is a pure in-memory lookup with no query latency.
 * Returns a Map(player_id -> games:number); ids absent from the map (no
 * player_matches rows at all — shouldn't happen for a real candidate) read as
 * 0 at the call sites, sorting them last among candidates.
 */
let careerGamesCache = null;
export async function fetchCareerGames() {
  if (careerGamesCache) return careerGamesCache;
  const sql = [
    "SELECT player_id AS id, COUNT(DISTINCT match_id) AS n",
    "FROM player_matches",
    "GROUP BY player_id",
  ].join("\n");
  const { rows } = await query(sql);
  const m = new Map();
  for (const r of rows) m.set(r.id, Number(r.n) || 0);
  careerGamesCache = m;
  return m;
}

/**
 * Selection controller (Batch 8 rebuild, decision 44d — v1's two-list model):
 *
 *   - `candidates`: the FULL ordered pool ({id, name}). NEVER truncated by
 *     anything except an explicit removeCandidate() (the roster picker's ×).
 *     This is exactly the old single-list `players` array, renamed for what
 *     it now represents alongside `checked` — the "cap-switch memory" it
 *     already had (never spliced on a type switch) is preserved unchanged.
 *   - `checked`: a Set of ids — the CHECKED/plotted subset, held to the
 *     invariant `checked.size <= cap()` at every mutation point in this
 *     module (never allowed to grow past cap; see toggleChecked/addCandidate).
 *     `get()` derives the rendered/queried list from it, in candidate order.
 *   - `mode`: "topnames" | "best" | "worst" | "manual" — which UI is driving
 *     `checked` right now. "topnames" (DEFAULT) auto-picks the biggest names by
 *     whole-DB career games; "best"/"worst" rank by the chart's active metric.
 *     This module does NOT rank anything itself (ranking needs a metric VALUE
 *     per candidate or a career-games fetch, both DB queries — a chart-domain
 *     concern owned by graph.js's deriveChecked()); it just stores the mode
 *     and lets the caller push a freshly computed checked-set via
 *     setChecked(). "manual" means checked only moves via toggleChecked/
 *     addCandidate/removeCandidate — nothing here ever silently recomputes it.
 *
 * `getCap()` returns the current cap's MAX (caller wires this to the active
 * chart type's CHART_CAPS[...].max). Cap-shrink truncation is never silent —
 * see clampToCap()'s onTruncate note — but note the asymmetry with the old
 * single-list model: THERE, any cap-grow-back-later always "restored" hidden
 * players, because the one list was never touched by a shrink, just re-sliced.
 * HERE, that restoring guarantee only holds for the auto modes ("topnames"/
 * "best"/"worst"), because those fully RE-DERIVE `checked` from the untouched
 * `candidates` pool on every relevant trigger (graph.js's deriveChecked(),
 * called on type switch/metric change/reseed) — so a cap that grows back always
 * re-ranks fresh from the full pool, same observable effect as before. In
 * "manual" mode there is no such re-derivation (checked is the user's literal,
 * ordered choice), so clampToCap() must genuininely trim it on a shrink, and a
 * later grow does NOT bring the trimmed players back on its own — same principle
 * as a user un-ticking those boxes themselves, and the honest thing given manual
 * mode is a genuinely new, richer capability (arbitrary picks) the old model
 * never had at all. Default mode is "topnames", so the legacy guarantee holds
 * for the common path.
 */
export function createSelection({ getCap, onChange, onTruncate }) {
  let candidates = []; // FULL ordered pool — never destructively truncated except by removeCandidate
  let checkedIds = new Set(); // invariant: checkedIds.size <= cap() at every point this module returns control
  // "topnames" (DEFAULT) | "best" | "worst" | "manual". "topnames" is the
  // biggest-names-by-career-games auto-select (R6b); "best"/"worst" rank by the
  // chart's active metric; "manual" is hand-picked. This module stores the mode
  // only — graph.js's deriveChecked() computes the checked set per mode.
  let mode = "topnames";
  // Batch 3 part 2 (honest titles, decision 43), redefined for the two-list
  // model (decision 44d): "dirty" now means the CHECKED set was shaped by a
  // manual tick/untick/add/remove since the last fresh seed or the last
  // clean Best/Worst re-derivation — NOT whether the candidate pool itself
  // was hand-edited. A Best-mode auto-recompute after a manual candidate add
  // is clean again ("top N"); a single manual checkbox toggle makes it dirty
  // ("N players") even though the candidate pool hasn't changed at all.
  let dirty = false;

  function cap() {
    return getCap();
  }

  /** The ACTIVE/plotted set, in candidate order — what's rendered, queried,
   * and counted everywhere else in the Graph Builder. Always size <= cap(). */
  function get() {
    return candidates.filter((p) => checkedIds.has(p.id));
  }

  /** The FULL candidate pool, in order — used by search/dropdown rendering
   * and by graph.js's ranking to keep add/search from re-adding a candidate
   * already in the pool (checked or not). */
  function getFull() {
    return candidates.slice();
  }

  function has(id) {
    return candidates.some((p) => p.id === id);
  }

  function isChecked(id) {
    return checkedIds.has(id);
  }

  function checkedCount() {
    return checkedIds.size;
  }

  function candidateCount() {
    return candidates.length;
  }

  function getMode() {
    return mode;
  }

  /** True iff `checked` was shaped by a manual edit since the last clean
   * derivation — see the class doc comment above. */
  function isDirty() {
    return dirty;
  }

  /** Replace the full candidate pool (a fresh seed, forced or scope-
   * triggered). Does NOT decide the new checked set on its own — the caller
   * (graph.js's seedSelection, right after this) always follows with a
   * setChecked() call derived per the CURRENT mode (default "best"), so a
   * fresh seed's checked set is never left stale against the new pool. */
  function setCandidates(newCandidates) {
    candidates = newCandidates.slice();
  }

  /** Replace the mode flag only. The caller is responsible for actually
   * re-deriving `checked` afterward (graph.js's deriveChecked()) — this
   * module has no DB access to rank by a metric value itself. */
  function setMode(newMode) {
    mode = newMode;
  }

  /** Replace the checked set outright — used by graph.js's Best/Worst
   * re-derivation and by the follow-up call after setCandidates(). `ids` is
   * clamped to ids that actually exist in `candidates` and to cap() (a
   * defensive backstop; callers should already respect the cap themselves).
   * `dirty` is the caller's call: Best/Worst derivations and fresh-seed
   * derivations pass false ("top N" is an honest claim); nothing else calls
   * this with true today, but the option exists for symmetry. */
  function setChecked(ids, { dirty: nextDirty = false } = {}) {
    const candidateIds = new Set(candidates.map((p) => p.id));
    const kept = ids.filter((id) => candidateIds.has(id)).slice(0, cap());
    checkedIds = new Set(kept);
    dirty = nextDirty;
    if (onChange) onChange();
  }

  /** Manual checkbox toggle (roster-picker dropdown row). Always marks dirty
   * — a human just picked this individually. Ticking while already at cap is
   * refused ({ok:false, reason:"cap"}) — the checkbox itself is disabled in
   * the UI for exactly this reason (see graph.js's renderPlayerList()); this
   * is just the defensive backstop, same idiom the old add() used. */
  function toggleChecked(id) {
    if (!has(id)) return { ok: false, reason: "unknown-candidate" };
    if (checkedIds.has(id)) {
      checkedIds.delete(id);
      dirty = true;
      if (onChange) onChange();
      return { ok: true };
    }
    if (checkedIds.size >= cap()) return { ok: false, reason: "cap", cap: cap() };
    checkedIds.add(id);
    dirty = true;
    if (onChange) onChange();
    return { ok: true };
  }

  /** Add a brand-new candidate to the pool (manual search-add, or an outside
   * "Graph this player" jump) — the pool itself is NEVER capped (task brief).
   * `autoCheck` (default true, mirrors the old add()'s "always selected on
   * add" behavior) also ticks it, but only if there's room under cap; if not,
   * the candidate still joins the pool (unticked) rather than being silently
   * dropped, since the pool is never truncated. Always a manual edit (dirty)
   * — this needs no mode branch: a search-add is a deliberate human pick
   * regardless of whether Best/Worst happens to be the active mode. */
  function addCandidate(player, { autoCheck = true } = {}) {
    if (has(player.id)) return { ok: false, reason: "already-selected" };
    candidates.push(player);
    let checked = false;
    if (autoCheck && checkedIds.size < cap()) {
      checkedIds.add(player.id);
      checked = true;
    }
    dirty = true;
    if (onChange) onChange();
    return { ok: true, checked };
  }

  /** Remove a candidate from the pool entirely (the roster picker's ×) — also
   * unticks it if it was checked. Always a manual edit (dirty). */
  function removeCandidate(id) {
    const before = candidates.length;
    candidates = candidates.filter((p) => p.id !== id);
    checkedIds.delete(id);
    if (candidates.length !== before) {
      dirty = true;
      if (onChange) onChange();
    }
  }

  /** Called on a chart-type switch (cap may have shrunk). Only ever TRIMS
   * (never grows) `checked` down to the new cap, in candidate order, noting
   * the truncation exactly like the old model's onTruncate did.
   *
   * `silent` (graph.js passes true for "best"/"worst" mode): the invariant
   * `checked.size <= cap()` must hold SYNCHRONOUSLY the instant the cap
   * changes — get() has no clamp of its own, it trusts this invariant — but
   * the real best/worst re-derivation is an ASYNC metric fetch
   * (graph.js's deriveChecked()). So graph.js calls this first, silently, as
   * an immediate provisional trim (plain candidate order — "first N", no
   * ranking yet) to keep every reader consistent for that brief window,
   * then deriveChecked() replaces it moments later with the real ranked set
   * via setChecked(); the user only ever sees a truncation NOTE in "manual"
   * mode, where no re-derivation follows to quietly fix things up. */
  function clampToCap({ silent = false } = {}) {
    const c = cap();
    if (checkedIds.size <= c) return;
    const kept = candidates.filter((p) => checkedIds.has(p.id)).slice(0, c);
    const hidden = checkedIds.size - kept.length;
    checkedIds = new Set(kept.map((p) => p.id));
    if (!silent && onTruncate && hidden > 0) {
      onTruncate(
        `This chart type caps this chart at ${c} players — ${hidden} player${hidden === 1 ? "" : "s"} unchecked. Tick them again if you switch back to a larger chart type.`
      );
    }
    if (onChange) onChange();
  }

  return {
    get,
    getFull,
    has,
    isChecked,
    checkedCount,
    candidateCount,
    getMode,
    setMode,
    isDirty,
    setCandidates,
    setChecked,
    toggleChecked,
    addCandidate,
    removeCandidate,
    clampToCap,
  };
}
