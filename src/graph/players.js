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

export const CHART_CAPS = {
  bar: 15,
  donut: 10,
  radar: 6,
  scatter: 60,
};

const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };

function esc(s) {
  return String(s).replace(/'/g, "''");
}

/** Sort comparator matching table.js's compareRows semantics: NULLs last always. */
function sortValueForMetric(row, metric) {
  const raw = metric.sortExpression ? row[`${metric.key}__sort`] : row[metric.key];
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function compareBySort(a, b, metric, dir) {
  const va = sortValueForMetric(a, metric);
  const vb = sortValueForMetric(b, metric);
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return dir === "asc" ? va - vb : vb - va;
}

/**
 * Run the SAME query the Compare Stats table would run for the current state
 * (state.js's buildQuery + the currently visible columns' set — but we only
 * need id/name/sort column here), then take the top N by the active sort.
 * Returns [{id, name}].
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
  const [{ rows }, matchesResult] = await Promise.all([
    query(sql),
    matchesSql ? query(matchesSql) : Promise.resolve({ rows: [] }),
  ]);

  let merged = rows;
  if (matchesSql) {
    const byId = new Map(matchesResult.rows.map((r) => [r.id, r.matches]));
    merged = rows.map((r) => ({ ...r, matches: byId.get(r.id) ?? null }));
  }

  const sortMetric = getMetric(sortKey, discipline);
  const sorted = sortMetric ? merged.slice().sort((a, b) => compareBySort(a, b, sortMetric, state.sort.dir)) : merged;

  return sorted.slice(0, cap).map((r) => ({ id: r.id, name: r.name }));
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

  const whereClauses = buildScopeClauses(state, { includeTeams: true, teamColumn: teamCol, idColumn: idCol });
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
 * chart type. `getCap()` returns the current cap (caller wires this to the
 * active chart type); truncation always calls `onTruncate(note)` so the UI
 * can show a visible note — never a silent drop.
 */
export function createSelection({ getCap, onChange, onTruncate }) {
  let players = []; // [{id, name}]

  function cap() {
    return getCap();
  }

  function truncateIfNeeded(reasonLabel) {
    const c = cap();
    if (players.length > c) {
      const dropped = players.length - c;
      players = players.slice(0, c);
      if (onTruncate) {
        onTruncate(
          `${reasonLabel} caps this chart at ${c} players — ${dropped} player${dropped === 1 ? "" : "s"} removed from the end of the selection.`
        );
      }
    }
  }

  function get() {
    return players.slice();
  }

  function has(id) {
    return players.some((p) => p.id === id);
  }

  function setAll(newPlayers) {
    players = newPlayers.slice();
    truncateIfNeeded("The seeded set");
    if (onChange) onChange();
  }

  function add(player) {
    if (has(player.id)) return { ok: false, reason: "already-selected" };
    if (players.length >= cap()) {
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

  /** Re-apply the cap for a NEW chart type (called on type switch). */
  function applyCapForNewType() {
    truncateIfNeeded("This chart type");
  }

  return { get, has, setAll, add, remove, applyCapForNewType };
}
