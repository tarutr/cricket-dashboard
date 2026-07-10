// src/graph/players.js
//
// Player selection for the Graph Builder (SPEC §6). Selection is a simple
// ordered list of {id, name} seeded from the CURRENT filtered Compare Stats
// result (same buildQuery as the table, same active sort), capped per the
// active chart type. Manual add (search within current scope) / remove /
// "Reset to filtered set" are supported. Caps are enforced on both add and
// chart-type switch, truncating with a visible note (never silently) per the
// task brief.
//
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
  donut: { min: 2, max: 10 },
  radar: { min: 1, max: 6 },
  scatter: { min: 5, max: 60 },
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
    includePositions: true,
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
 * Selection controller: an ordered list of {id, name}, capped per active
 * chart type. `getCap()` returns the current cap's MAX (caller wires this to
 * the active chart type's CHART_CAPS[...].max); truncation is never
 * destructive — see below — and always calls `onTruncate(note)` when players
 * are hidden by a smaller cap, so the UI can show a visible note.
 *
 * Batch 3 (graphs, part 1) fix — cap-switch memory: `players` is the FULL
 * ordered selection and is never sliced/discarded on a chart-type switch.
 * `get()` (used for rendering/querying/the sidebar list) derives the ACTIVE
 * set as the first `cap()` entries; switching to a chart type whose cap is
 * >= the full list's length brings every hidden player back automatically,
 * with no re-seed or re-add needed. Previously `setAll`/`applyCapForNewType`
 * both spliced `players` itself, so e.g. bar (15) -> donut (10) -> bar left
 * only 10 — the other 5 were gone for good.
 */
export function createSelection({ getCap, onChange, onTruncate }) {
  let players = []; // FULL ordered list — never destructively truncated

  function cap() {
    return getCap();
  }

  function activeCount() {
    return Math.min(players.length, cap());
  }

  function maybeNoteTruncation(reasonLabel) {
    const c = cap();
    if (players.length > c) {
      const hidden = players.length - c;
      if (onTruncate) {
        onTruncate(
          `${reasonLabel} caps this chart at ${c} players — ${hidden} player${hidden === 1 ? "" : "s"} not shown here — they'll come back when you switch to a larger chart type.`
        );
      }
    }
  }

  /** The ACTIVE set: the first `cap()` entries of the full selection. This is
   * what gets rendered, queried, and shown in the sidebar list. */
  function get() {
    return players.slice(0, cap());
  }

  /** The FULL selection, including any players currently hidden by a smaller
   * cap — used to keep manual add/search from re-adding a hidden player. */
  function getFull() {
    return players.slice();
  }

  function has(id) {
    return players.some((p) => p.id === id);
  }

  function setAll(newPlayers) {
    players = newPlayers.slice();
    maybeNoteTruncation("The seeded set");
    if (onChange) onChange();
  }

  function add(player) {
    if (has(player.id)) return { ok: false, reason: "already-selected" };
    if (activeCount() >= cap()) {
      return { ok: false, reason: "cap", cap: cap() };
    }
    players.push(player);
    if (onChange) onChange();
    return { ok: true };
  }

  function remove(id) {
    const before = players.length;
    players = players.filter((p) => p.id !== id);
    if (players.length !== before && onChange) onChange();
  }

  /** Re-evaluate the cap note for a NEW chart type (called on type switch).
   * No longer mutates `players` — the full selection is preserved and the
   * active set is simply re-derived by `get()` against the new cap. */
  function applyCapForNewType() {
    maybeNoteTruncation("This chart type");
  }

  return { get, getFull, has, setAll, add, remove, applyCapForNewType };
}
