// src/table.js
//
// Query builder + table renderer for Compare Stats (SPEC §5.3/§5.4). Builds ONE
// grouped query per the metrics.js contract, plus a separate player_matches
// query when the "matches" column is visible, joined in JS by player_id.
//
// hasMetricData (§8.1) is the ONLY no-data predicate — used both to gate
// advanced-filter conditions on rate/ratio metrics and to render "—" for
// no-data cells (NULL already renders "—"; this module never coalesces ratios).

import { getMetric, hasMetricData } from "./metrics.js";
import { query } from "./db.js";
import { buildScopeClauses } from "./filters.js";
import { activeGroups } from "./advanced.js";
import { eligibleMetrics } from "./state.js";

export { eligibleMetrics };

function esc(s) {
  return String(s).replace(/'/g, "''");
}

const VIEW_FOR_DISCIPLINE = { batting: "batting", bowling: "bowling" };
const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };

/** Build a HAVING predicate for one advanced condition, honoring §8.1 no-data semantics. */
function conditionToHaving(cond, discipline) {
  const metric = getMetric(cond.metricKey, discipline);
  if (!metric) return null;
  const expr = metric.sqlExpression;
  // §8.1: rate/ratio metrics (zeroIsData:false) treat 0 as "no data" too, so a
  // condition on them must also exclude value = 0 even though the numeric
  // comparison might otherwise pass (e.g. "average <= 5" should not match a
  // player with a NULL/0 average — no data at all, not a low average).
  const guard = metric.zeroIsData ? "" : ` AND (${expr}) <> 0`;
  const v1 = parseFloat(cond.v1);
  switch (cond.operator) {
    case "gte":
      return `((${expr}) >= ${v1}${guard})`;
    case "lte":
      return `((${expr}) <= ${v1}${guard})`;
    case "eq":
      return `((${expr}) = ${v1}${guard})`;
    case "between": {
      const v2 = parseFloat(cond.v2);
      const lo = Math.min(v1, v2);
      const hi = Math.max(v1, v2);
      return `((${expr}) BETWEEN ${lo} AND ${hi}${guard})`;
    }
    default:
      return null;
  }
}

function advancedToHaving(advanced, discipline) {
  const groups = activeGroups(advanced);
  if (groups.length === 0) return null;
  const parts = groups
    .map((g) => {
      const condSql = g.conds.map((c) => conditionToHaving(c, discipline)).filter(Boolean);
      if (condSql.length === 0) return null;
      const joiner = g.op === "OR" ? " OR " : " AND ";
      return condSql.length > 1 ? `(${condSql.join(joiner)})` : condSql[0];
    })
    .filter(Boolean);
  if (parts.length === 0) return null;
  const topJoiner = advanced.op === "OR" ? " OR " : " AND ";
  return parts.length > 1 ? `(${parts.join(topJoiner)})` : parts[0];
}

/**
 * Build the main grouped SQL query for the current state + visible columns.
 * Returns { sql, matchesSql } — matchesSql is null unless "matches" is visible.
 */
export function buildQuery(state, visibleColumns) {
  const discipline = state.discipline;
  const view = VIEW_FOR_DISCIPLINE[discipline];
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];

  const inningsMetrics = visibleColumns
    .map((key) => getMetric(key, discipline))
    .filter((m) => m && m.source !== "player_matches");

  const selectParts = [`${idCol} AS id`, `${nameCol} AS name`];
  for (const m of inningsMetrics) {
    selectParts.push(`${m.sqlExpression} AS ${m.key}`);
    if (m.sortExpression) selectParts.push(`${m.sortExpression} AS ${m.key}__sort`);
  }

  const whereClauses = buildScopeClauses(state, { includeTeams: true, teamColumn: teamCol, idColumn: idCol });
  if (state.search && state.search.trim()) {
    whereClauses.push(`${nameCol} ILIKE '%${esc(state.search.trim())}%'`);
  }

  const havingParts = [`COUNT(*) >= ${Math.max(1, Number(state.minInnings) || 1)}`];
  const advHaving = advancedToHaving(state.advanced, discipline);
  if (advHaving) havingParts.push(advHaving);

  const sql = [
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, ${nameCol}`,
    `HAVING ${havingParts.join(" AND ")}`,
  ].join("\n");

  const wantsMatches = visibleColumns.includes("matches");
  let matchesSql = null;
  if (wantsMatches) {
    const pmWhere = buildScopeClauses(state, { includeTeams: true, teamColumn: "team", idColumn: "player_id" }).join(" AND ");
    const pmNameFilter =
      state.search && state.search.trim() ? ` AND player_name ILIKE '%${esc(state.search.trim())}%'` : "";
    matchesSql = [
      `SELECT player_id AS id, COUNT(DISTINCT match_id) AS matches`,
      `FROM player_matches`,
      `WHERE ${pmWhere}${pmNameFilter}`,
      `GROUP BY player_id`,
    ].join("\n");
  }

  return { sql, matchesSql };
}

function formatValue(metric, value) {
  if (!hasMetricData(metric, value)) return "—"; // em dash
  if (metric.format === "str") return String(value);
  const n = Number(value);
  switch (metric.format) {
    case "int":
      return Math.round(n).toLocaleString();
    case "dec1":
      return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case "dec2":
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "pct1":
      return `${n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    default:
      return String(value);
  }
}

/** Sort value accessor: uses the __sort shadow column when present; NULL sorts last always. */
function sortValue(row, metric) {
  const raw = metric.sortExpression ? row[`${metric.key}__sort`] : row[metric.key];
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function compareRows(a, b, metric, dir) {
  const va = metric.key === "name" ? null : sortValue(a, metric);
  const vb = metric.key === "name" ? null : sortValue(b, metric);
  // NULLS LAST regardless of direction.
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  return dir === "asc" ? va - vb : vb - va;
}

// ── Table controller ─────────────────────────────────────────────────────────

export function mountTable(container, store, { getManifestDates } = {}) {
  let lastRows = [];
  let loadToken = 0;

  function visibleColumns() {
    const state = store.get();
    return state.columns[state.discipline];
  }

  /** Drop any visible phase column that's no longer valid for the current scope (silent). */
  function pruneInvalidColumns() {
    const state = store.get();
    const formats = state.formats;
    const cols = state.columns[state.discipline];
    const allowedKeys = new Set(eligibleMetrics(state.discipline, formats).map((m) => m.key));
    const pruned = cols.filter((k) => allowedKeys.has(k));
    if (pruned.length !== cols.length) {
      store.set({ columns: { ...state.columns, [state.discipline]: pruned } });
    }
  }

  function renderLoading() {
    container.innerHTML = `
      <div class="table-toolbar">
        <div class="table-toolbar__row-count">Loading…</div>
      </div>
      <div class="table-loading-overlay" aria-live="polite">Running query…</div>
      <div class="table-scroll"><table class="data-table"><tbody></tbody></table></div>
    `;
  }

  /**
   * Blank/prompt state (owner: no automated search — the table stays empty until
   * "Show results" is clicked, and reverts here whenever the filters change so it
   * never shows numbers for a scope the filters no longer describe, §8.4).
   */
  function renderPrompt() {
    container.innerHTML = `
      <div class="table-prompt">
        <p class="table-prompt__text">Choose your filters, then show the results.</p>
        <button type="button" class="btn btn--primary" data-role="show-results">Show results</button>
      </div>
    `;
    const btn = container.querySelector('[data-role="show-results"]');
    if (btn) btn.addEventListener("click", () => load());
  }

  function renderError(err, retryFn) {
    container.innerHTML = `
      <div class="error-box">
        <p>${(err && (err.userMessage || err.message)) || "Something went wrong running the query."}</p>
        <button type="button" class="btn btn--primary" data-role="retry">Retry</button>
      </div>
    `;
    const btn = container.querySelector('[data-role="retry"]');
    if (btn) btn.addEventListener("click", retryFn);
  }

  function headerCellHTML(metric, state) {
    const isSorted = state.sort.key === metric.key;
    const dir = isSorted ? state.sort.dir : null;
    const arrow = isSorted ? (dir === "asc" ? " ▲" : " ▼") : "";
    return `<th data-key="${metric.key}" class="data-table__th ${isSorted ? "is-sorted" : ""}" scope="col">
      <button type="button" class="data-table__sort-btn">${metric.shortLabel}${arrow}</button>
    </th>`;
  }

  function renderTable(rows, state) {
    const cols = visibleColumns()
      .map((key) => getMetric(key, state.discipline))
      .filter(Boolean);

    const theadHTML = `
      <tr>
        <th class="data-table__th data-table__th--sticky" scope="col">Player</th>
        ${cols.map((m) => headerCellHTML(m, state)).join("")}
      </tr>`;

    const tbodyHTML = rows
      .map((row) => {
        const cells = cols
          .map((m) => `<td class="data-table__td">${formatValue(m, row[m.key])}</td>`)
          .join("");
        return `<tr><td class="data-table__td data-table__td--sticky">${row.name ?? ""}</td>${cells}</tr>`;
      })
      .join("");

    container.innerHTML = `
      <div class="table-toolbar">
        <div class="table-toolbar__row-count">${rows.length} player${rows.length === 1 ? "" : "s"} match</div>
        <div class="table-toolbar__actions">
          <button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Columns</button>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>${theadHTML}</thead>
          <tbody>${tbodyHTML}</tbody>
        </table>
      </div>
    `;

    // Sorting: click header to sort/flip. Re-sorts the cached rows client-side
    // (no requery needed — the result set is unchanged, only its order).
    container.querySelectorAll(".data-table__th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        const metric = getMetric(key, state.discipline);
        const s = store.get();
        if (s.sort.key === key) {
          store.set({ sort: { key, dir: s.sort.dir === "asc" ? "desc" : "asc" } });
        } else {
          const defaultDir = metric.higherIsBetter === false ? "asc" : "desc";
          store.set({ sort: { key, dir: defaultDir } });
        }
        const next = store.get();
        const sortMetric = getMetric(next.sort.key, next.discipline);
        if (sortMetric) {
          lastRows = lastRows.slice().sort((a, b) => compareRows(a, b, sortMetric, next.sort.dir));
        }
        renderTable(lastRows, next);
      });
    });

    const columnsBtn = container.querySelector('[data-role="columns-btn"]');
    if (columnsBtn) {
      columnsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        openColumnsPopover(columnsBtn);
      });
    }
  }

  function openColumnsPopover(anchor) {
    document.querySelectorAll(".columns-popover").forEach((el) => el.remove());
    const state = store.get();
    const all = eligibleMetrics(state.discipline, state.formats);
    const basic = all.filter((m) => !m.isPhaseMetric);
    const phase = all.filter((m) => m.isPhaseMetric);
    const visible = new Set(visibleColumns());

    const popover = document.createElement("div");
    popover.className = "columns-popover";
    const section = (label, metrics) =>
      metrics.length
        ? `<div class="columns-popover__section-label">${label}</div>
           <div class="columns-popover__list">
             ${metrics
               .map(
                 (m) => `<label class="columns-popover__item">
                   <input type="checkbox" data-key="${m.key}" ${visible.has(m.key) ? "checked" : ""} />
                   <span>${m.label}</span>
                 </label>`
               )
               .join("")}
           </div>`
        : "";
    popover.innerHTML = section("Basic", basic) + section("Phase", phase);
    anchor.parentElement.appendChild(popover);

    popover.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const s = store.get();
        const cols = s.columns[s.discipline].slice();
        if (cb.checked) {
          if (!cols.includes(cb.dataset.key)) cols.push(cb.dataset.key);
        } else {
          const idx = cols.indexOf(cb.dataset.key);
          if (idx >= 0) cols.splice(idx, 1);
        }
        store.set({ columns: { ...s.columns, [s.discipline]: cols } });
        load();
      });
    });

    setTimeout(() => {
      document.addEventListener(
        "click",
        function handler(e) {
          if (e.target.closest(".columns-popover") || e.target === anchor) {
            document.addEventListener("click", handler, { once: true });
            return;
          }
          popover.remove();
        },
        { once: true }
      );
    }, 0);
  }

  async function load() {
    pruneInvalidColumns();
    const state = store.get();
    const cols = visibleColumns();
    const { sql, matchesSql } = buildQuery(state, cols);
    const token = ++loadToken;
    renderLoading();
    try {
      const [{ rows }, matchesResult] = await Promise.all([
        query(sql),
        matchesSql ? query(matchesSql) : Promise.resolve({ rows: [] }),
      ]);
      if (token !== loadToken) return; // a newer load superseded this one

      let merged = rows;
      if (matchesSql) {
        const byId = new Map(matchesResult.rows.map((r) => [r.id, r.matches]));
        merged = rows.map((r) => ({ ...r, matches: byId.get(r.id) ?? null }));
      }

      const metric = getMetric(state.sort.key, state.discipline);
      const sorted = metric ? merged.slice().sort((a, b) => compareRows(a, b, metric, state.sort.dir)) : merged;

      lastRows = sorted;
      renderTable(sorted, state);
    } catch (err) {
      if (token !== loadToken) return;
      renderError(err, load);
    }
  }

  return { load, showPrompt: renderPrompt };
}
