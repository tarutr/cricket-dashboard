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
  // Batch 8 (task 3, decision 44f): widened 10 -> 20 — the donut now plots the
  // top 7 CHECKED players by value plus one aggregated "Other (N players)"
  // slice for the rest, so up to 20 can be checked/compared even though the
  // chart itself never draws more than 8 slices (see charts.js buildDonutChart
  // and CHART_CAPS's own consumers, which only ever read `.max`, so nothing
  // downstream had to change shape for this).
  donut: { min: 2, max: 20 },
  radar: { min: 1, max: 6 },
  scatter: { min: 5, max: 60 },
  // Batch 4 part 1 (decision 43): Phases (grouped bars, one group per player —
  // gets crowded fast, so a tighter ceiling than bar's) and Slope (a
  // two-column line-per-player chart — same "needs at least two to compare"
  // floor as bar/donut, roomier ceiling since each player is just one line).
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

/**
 * Run the SAME query the Compare Stats table would run for the current state
 * (state.js's buildQuery + the currently visible columns' set — but we only
 * need id/name/sort column here), then take the top N by the active sort.
 * Returns [{id, name}].
 *
 * Batch 5b C3: previously this ran buildQuery's SQL with no LIMIT, pulled
 * EVERY qualifying player's row across the wire (Arrow -> JS for the full
 * leaderboard), sorted client-side, then sliced to `cap`. Now the same
 * ranking is expressed in SQL — `ORDER BY <sort col> <dir> NULLS LAST` wrapped
 * around the query builder's own SQL, then `LIMIT cap` — so DuckDB only ever
 * returns the `cap` rows we keep. This reproduces table.js's compareRows
 * exactly: NULLs sort last regardless of direction (`NULLS LAST` after either
 * ASC or DESC). Ties (equal sort values) are broken by `id ASC` for a
 * deterministic cap boundary — the client sort this replaces had no explicit
 * tie-break (Array.sort is stable, so ties just kept the DB's own row order,
 * itself unspecified), so this is a defensible, deterministic choice rather
 * than an exact reproduction of undefined behavior.
 *
 * The seed step never excluded anyone for failing hasMetricData — it only
 * ever ranked by the table's active sort (NULLs last) and sliced to `cap`.
 * That's unchanged: a player with NULL for the sort metric can still be
 * seeded (filling remaining slots after non-NULL rows), same as before. The
 * separate "Excluded (no data)" note the Graph Builder shows (graph/charts.js)
 * operates on the CHARTED metric — which may differ from the table's sort
 * metric — against the already-seeded roster, and is untouched by this change.
 */
export async function seedFromFilteredSet(store, cap) {
  const state = store.get();
  const discipline = state.discipline;
  const cols = state.columns[discipline];
  // Ensure the active sort metric is included so we can rank by it even if
  // it's not a visible column right now.
  const sortKey = state.sort.key;
  const colsForQuery = cols.includes(sortKey) ? cols : [...cols, sortKey];

  const { sql, matchesSql } = buildQuery(state, colsForQuery);

  const sortMetric = getMetric(sortKey, discipline);
  const dir = state.sort.dir === "asc" ? "ASC" : "DESC";
  const orderCol = sortMetric ? (sortMetric.sortExpression ? `${sortKey}__sort` : sortKey) : null;
  const outerSql = orderCol
    ? `SELECT * FROM (\n${sql}\n) seed_q\nORDER BY ${orderCol} ${dir} NULLS LAST, id ASC\nLIMIT ${cap}`
    : `SELECT * FROM (\n${sql}\n) seed_q\nLIMIT ${cap}`;

  const [{ rows }, matchesResult] = await Promise.all([
    query(outerSql),
    matchesSql ? query(matchesSql) : Promise.resolve({ rows: [] }),
  ]);

  let merged = rows;
  if (matchesSql) {
    const byId = new Map(matchesResult.rows.map((r) => [r.id, r.matches]));
    merged = rows.map((r) => ({ ...r, matches: byId.get(r.id) ?? null }));
  }

  return merged.map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Search for players within the current scope (same ILIKE approach as the
 * player-search box), for manual add. Returns [{id, name}], excluding ids
 * already in `excludeIds`.
 */
export async function searchPlayers(store, searchText, excludeIds) {
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
  if (term) whereClauses.push(`${nameCol} ILIKE '%${esc(term)}%'`);

  const sql = [
    `SELECT ${idCol} AS id, ${nameCol} AS name, COUNT(*) AS n`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, ${nameCol}`,
    `ORDER BY n DESC, name ASC`,
    `LIMIT 25`,
  ].join("\n");

  const { rows } = await query(sql);
  const exclude = new Set(excludeIds);
  return rows.filter((r) => !exclude.has(r.id)).map((r) => ({ id: r.id, name: r.name }));
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
 *   - `mode`: "manual" | "best" | "worst" — which UI is driving `checked`
 *     right now. This module does NOT rank anything itself (ranking needs a
 *     metric VALUE per candidate, which needs a DB query — a chart-domain
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
 * HERE, that restoring guarantee only holds for "best"/"worst" mode, because
 * those modes fully RE-DERIVE `checked` from the untouched `candidates` pool
 * on every relevant trigger (graph.js's deriveChecked(), called on type
 * switch/metric change/reseed) — so a cap that grows back always re-ranks
 * fresh from the full pool, same observable effect as before. In "manual"
 * mode there is no such re-derivation (checked is the user's literal, ordered
 * choice), so clampToCap() must genuininely trim it on a shrink, and a later
 * grow does NOT bring the trimmed players back on its own — same principle as
 * a user un-ticking those boxes themselves, and the honest thing given manual
 * mode is a genuinely new, richer capability (arbitrary picks) the old model
 * never had at all. Default mode is "best", which is what most users will be
 * in most of the time, so the legacy guarantee holds for the common path.
 */
export function createSelection({ getCap, onChange, onTruncate }) {
  let candidates = []; // FULL ordered pool — never destructively truncated except by removeCandidate
  let checkedIds = new Set(); // invariant: checkedIds.size <= cap() at every point this module returns control
  let mode = "best"; // "manual" | "best" | "worst"
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
