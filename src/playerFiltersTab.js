// src/playerFiltersTab.js
//
// Tab-2 "Filters" — the per-player filtered-row table (T-2a: DATA PATH +
// RENDERING core; the INTERACTIVE editor is T-2b). Each ROW is a user-defined
// filtered view of the ONE open player's record — a mini-leaderboard whose
// rows are filters instead of players. This file owns the row model, the
// per-row query, and the table render; T-2b replaces the code-seeded rows +
// the "Add Filter Row" placeholder with the real Add-condition palette editor.
//
// Contract (unchanged from the T-F1 shell):
//   mountPlayerFiltersTab(container, { store, playerId, discipline, pageState })
//     -> { show(playerId, discipline, pageState), destroy() }
//
// ── The per-row query (the crux — numbers sacred, CLAUDE.md Rule 1) ──────────
// Each row reuses the leaderboard's own `buildQuery` (src/table.js) UNCHANGED,
// scoped to ONE player by the already-precedented OUTER-WRAP idiom
// (src/graph/charts.js:59, src/graph/benchmark.js:166): build a COMPLETE, CLEAN
// state, seed ONLY the core scope (gender / formats / dateFrom / dateTo /
// teamType) from the pop-up's effective scope, override it with the row's own
// per-row scope + the tab's shared discipline + the row's advanced conditions,
// call buildQuery(rowState, cols), then wrap
//   SELECT * FROM (<sql>) t WHERE id = '<playerId>'
// and run via db.query. A NO-FILTER row is therefore byte-identical to that
// player's leaderboard row — the correctness anchor.
//
// WHY a clean state (createInitialState) and NOT a `{...pageState}` clone: a
// header-search-opened pop-up passes a MINIMAL 5-field pageState
// (playerPage.js buildFixedScopeState) that would crash buildQuery (no
// state.advanced / columns / pinnedPlayers / …). And per the signed-off design
// the Filters tab's per-row scope is Format / Team type / Date + conditions
// ONLY — it must NOT inherit the leaderboard's teams / opposition / event /
// pins / search / matchupVs. Seeding a clean state from the core scope gives
// both: a complete state buildQuery is happy with, and no leaderboard-filter
// leak. (Overview stays the always-full-scope base profile; all filtering
// lives here.)
//
// Columns are INDEPENDENT of the leaderboard's (decision 3): the tab keeps its
// own per-discipline column selection, seeded from the discipline default, and
// reuses the SHARED createColumnsPicker (src/columnsPicker.js) + the shared
// COLUMN_PRESET_DEFS presets — so the later columns rejig flows in for free.
//
// NOTE (per-row opponent-player / delivery-window): those are ball-engine
// module globals (src/db.js setOpponentPlayer / setDeliveryWindow), NOT per-row
// state here — deliberately LEFT for T-2b. See the CONCERNS note in the T-2a
// report: the global-state design will make CONCURRENT per-row queries collide.

import { query } from "./db.js";
import { buildQuery, formatValue } from "./table.js";
import { getMetric, metricDisplayLabel } from "./metrics.js";
import {
  createInitialState,
  emptyAdvancedBlock,
  defaultColumnsFor,
  COLUMN_PRESET_DEFS,
  activePresetKey,
  escSql as esc,
} from "./state.js";
import { activeGroups } from "./advanced.js";
import { createColumnsPicker } from "./columnsPicker.js";
import { escHtml, escAttr } from "./html.js";

// "slice" is BANNED from user-facing text (owner ruling). Label a row that
// carries no condition yet — the "Add Filter Row" placeholder seeds these, and
// a code-seeded no-filter proof row uses it too.
const NO_CONDITION_LABEL = "No conditions";
const OP_SYMBOLS = { gte: "≥", lte: "≤", eq: "=" };

// ── T-2a code-seed (REPLACED by the real editor in T-2b) ─────────────────────
// The task seeds rows in code to PROVE the numbers foundation without the
// interactive editor. Two demonstrative, player-AGNOSTIC rows:
//   1. a NO-FILTER row  — byte-identical to the player's leaderboard/Overview
//      record (SA Yadav → 60 / 1,544 / 29.13 / 150.34 under the T20/Intl anchor);
//   2. an "Innings Score ≥ 100" condition row — a HAVING gate on the
//      innings_score_ge threshold metric (n = 100), independently DuckDB-verified.
// `id`s are stable strings so re-renders keep row identity. T-2b drives this
// array from the real Add-condition flow instead.
let rowSeq = 0;
const nextRowId = () => `row-${++rowSeq}`;

function seedRows() {
  return [
    {
      id: nextRowId(),
      scope: { formats: null, dateFrom: null, dateTo: null, teamType: null }, // inherit pop-up scope
      conditions: emptyAdvancedBlock(),
      pinned: false,
    },
    {
      id: nextRowId(),
      scope: { formats: null, dateFrom: null, dateTo: null, teamType: null },
      conditions: {
        op: "AND",
        groups: [{ op: "AND", conds: [{ metricKey: "innings_score_ge", operator: "gte", v1: "1", n: 100 }] }],
      },
      pinned: false,
    },
  ];
}

// A no-filter row for the "Add Filter Row" placeholder (T-2b replaces this with
// the real editor popup).
function placeholderRow() {
  return {
    id: nextRowId(),
    scope: { formats: null, dateFrom: null, dateTo: null, teamType: null },
    conditions: emptyAdvancedBlock(),
    pinned: false,
  };
}

// ── Row identity label (first condition, LITERAL operator form) ──────────────
// The signed-off design: the first cell = the row's FIRST condition as plain
// text in literal operator form (e.g. "Innings Score ≥ 100" verbatim), like the
// leaderboard's player-name column. Adapted from pills.js's conditionPillLabel
// (kept local — pills.js is store-coupled). >1 condition surfaces the full list
// via an (i) marker (title-attr for T-2a; T-2b builds the hover popover).

function conditionLiteralLabel(cond, discipline, formats) {
  const metric = getMetric(cond.metricKey, discipline) || getMetric(cond.metricKey);
  const baseLabel = metric ? metricDisplayLabel(metric, formats) : cond.metricKey;
  // Parametrised threshold metric (Innings Score ≥ N / Wicket Hauls ≥ N): the
  // user-facing filter IS the THRESHOLD, so render the metric's own "≥ N" label
  // with N filled from cond.n → "Innings Score ≥ 100". (metric.label carries the
  // "≥ N" token; metricDisplayLabel only strips a trailing " (Innings)".)
  if (metric && metric.paramTemplate && metric.param) {
    const n = cond.n ?? metric.param.default;
    return (metric.label || baseLabel).replace(/≥\s*N\b/, `≥ ${n}`);
  }
  if (metric && metric.conditionInput === "bowlingFigures") return `${baseLabel} ≥${cond.v1}W for ≤${cond.v2}R`;
  if (cond.operator === "between") return `${baseLabel} ${cond.v1}–${cond.v2}`;
  return `${baseLabel} ${OP_SYMBOLS[cond.operator] ?? cond.operator} ${cond.v1}`;
}

/** Every complete condition on a row, as literal-form strings (for the (i)). */
function allConditionLabels(conditions, discipline, formats) {
  const out = [];
  for (const g of activeGroups(conditions || emptyAdvancedBlock())) {
    for (const c of g.conds) out.push(conditionLiteralLabel(c, discipline, formats));
  }
  return out;
}

function rowLabel(row, discipline, formats) {
  const labels = allConditionLabels(row.conditions, discipline, formats);
  return labels.length ? labels[0] : NO_CONDITION_LABEL;
}

// ── Per-row query ────────────────────────────────────────────────────────────

/** Build the COMPLETE, CLEAN buildQuery state for one row (see file header). */
function buildRowState(row, pageState, discipline) {
  const base = createInitialState(null); // complete neutral state; dateTo overridden below
  const scope = row.scope || {};
  const ps = pageState || {};
  return {
    ...base,
    discipline,
    gender: ps.gender ?? base.gender, // inert (id pins gender) but kept honest
    formats: scope.formats ?? ps.formats ?? base.formats,
    dateFrom: scope.dateFrom ?? ps.dateFrom ?? base.dateFrom,
    dateTo: scope.dateTo ?? ps.dateTo ?? base.dateTo,
    teamType: scope.teamType ?? ps.teamType ?? base.teamType,
    advanced: row.conditions
      ? { op: row.conditions.op || "AND", groups: row.conditions.groups || [] }
      : emptyAdvancedBlock(),
  };
}

/**
 * Run ONE row's query. buildQuery UNCHANGED → outer-wrap WHERE id = player →
 * db.query. Returns the single aggregate row object, or null when the player
 * has no data under the row's filter (e.g. a HAVING gate excludes them). The
 * "matches" column, when buildQuery routes it through its own player_matches
 * sub-query (matchesSql), is fetched with the same wrap+merge the leaderboard
 * uses (table.js mountTable), so a "matches"-including row is correct too.
 */
async function fetchRow(row, playerId, pageState, discipline, cols) {
  const rowState = buildRowState(row, pageState, discipline);
  const { sql, matchesSql } = buildQuery(rowState, cols);
  const wrapped = `SELECT * FROM (\n${sql}\n) t\nWHERE id = '${esc(playerId)}'`;
  const tasks = [query(wrapped)];
  if (matchesSql) tasks.push(query(`SELECT * FROM (\n${matchesSql}\n) mt\nWHERE id = '${esc(playerId)}'`));
  const [mainRes, matchesRes] = await Promise.all(tasks);
  let out = mainRes.rows[0] || null;
  if (matchesSql && out) {
    const m = matchesRes.rows[0];
    out = { ...out, matches: m ? m.matches : null };
  }
  return out;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function mountPlayerFiltersTab(container, { store, playerId, discipline, pageState } = {}) {
  let curPlayerId = playerId ?? null;
  let curDiscipline = discipline === "bowling" ? "bowling" : "batting";
  let curPageState = pageState || null;
  let rows = seedRows(); // T-2a code-seed; T-2b drives this from the editor
  let refreshToken = 0;

  // Tab-INDEPENDENT column selection (decision 3), lazily seeded per discipline
  // from the discipline default. Keyed by plain discipline (no matchup vocab in
  // the tab — matchupVs is per-row and lands in T-2b).
  const tabColumns = { batting: null, bowling: null };

  function currentFormats() {
    return (curPageState && curPageState.formats) || ["T20"];
  }

  function columnsFor(disc) {
    if (!tabColumns[disc]) tabColumns[disc] = defaultColumnsFor(disc, currentFormats());
    return tabColumns[disc];
  }

  // ONE shared columns picker instance (reused across refreshes; its popover
  // lives on document.body so a table re-render never destroys it).
  const columnsPicker = createColumnsPicker({
    getColumns: () => columnsFor(curDiscipline),
    setColumns: (cols) => {
      tabColumns[curDiscipline] = cols;
      syncPresetSelect();
      refreshTable(); // re-query with the new SELECT list; picker survives on body
    },
    getDiscipline: () => curDiscipline,
    getFormats: () => currentFormats(),
  });

  // ---------- shell (toolbar + table host), rendered once per discipline ----------

  function presetOptionsHTML() {
    const cols = columnsFor(curDiscipline);
    const active = activePresetKey(curDiscipline, currentFormats(), cols);
    const opts = COLUMN_PRESET_DEFS[curDiscipline]
      .map((def) => {
        const disabled = def.columns(currentFormats()) == null; // phases off under this format
        return `<option value="${escAttr(def.key)}" ${active === def.key ? "selected" : ""} ${
          disabled ? "disabled" : ""
        }>${escHtml(def.label)}</option>`;
      })
      .join("");
    // A "Custom" sentinel for a column set that matches no preset.
    const customSel = active == null ? "selected" : "";
    return `<option value="__custom" ${customSel} disabled hidden>Custom</option>${opts}`;
  }

  function renderShell() {
    container.innerHTML = `
      <div class="filters-tab">
        <div class="filters-tab__toolbar">
          <button type="button" class="btn btn--primary filters-tab__add" data-role="add-filter-row">Add Filter Row</button>
          <div class="filters-tab__toolbar-right">
            <select class="select filters-tab__preset" data-role="preset-select" aria-label="Column preset">${presetOptionsHTML()}</select>
            <button type="button" class="btn btn--ghost" data-role="columns-btn" aria-haspopup="true" aria-expanded="false">Columns</button>
          </div>
        </div>
        <div class="filters-tab__table-host" data-role="table-host"></div>
      </div>`;

    const addBtn = container.querySelector('[data-role="add-filter-row"]');
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        // PLACEHOLDER (T-2a): adds a no-filter row. T-2b opens the real
        // Add-condition palette editor here.
        rows.push(placeholderRow());
        refreshTable();
      });
    }

    const presetSel = container.querySelector('[data-role="preset-select"]');
    if (presetSel) {
      presetSel.addEventListener("change", () => {
        const def = COLUMN_PRESET_DEFS[curDiscipline].find((d) => d.key === presetSel.value);
        const cols = def && def.columns(currentFormats());
        if (cols) {
          tabColumns[curDiscipline] = cols;
          refreshTable();
        }
      });
    }

    const columnsBtn = container.querySelector('[data-role="columns-btn"]');
    if (columnsBtn) columnsPicker.mount(columnsBtn);
  }

  function syncPresetSelect() {
    const presetSel = container.querySelector('[data-role="preset-select"]');
    if (!presetSel) return;
    const active = activePresetKey(curDiscipline, currentFormats(), columnsFor(curDiscipline));
    presetSel.value = active ?? "__custom";
  }

  // ---------- table host (re-rendered on any data / column / row change) ----------

  function metricColumns() {
    return columnsFor(curDiscipline)
      .map((key) => getMetric(key, curDiscipline))
      .filter(Boolean);
  }

  function headerHTML(metrics) {
    const metricThs = metrics
      .map((m) => `<th class="data-table__th" scope="col">${escHtml(m.shortLabel || m.label || m.key)}</th>`)
      .join("");
    return `<thead><tr>
        <th class="data-table__th data-table__th--sticky" scope="col">Filter</th>
        ${metricThs}
      </tr></thead>`;
  }

  function labelCellHTML(row) {
    const formats = currentFormats();
    const label = rowLabel(row, curDiscipline, formats);
    const all = allConditionLabels(row.conditions, curDiscipline, formats);
    const info =
      all.length > 1
        ? ` <span class="filters-tab__info" title="${escAttr(all.join("\n"))}" aria-label="Full filter list">(i)</span>`
        : "";
    return `<td class="data-table__td data-table__td--sticky">${escHtml(label)}${info}</td>`;
  }

  /** A body row's data cells (called after the query resolves; `data` may be
   * null when the player has no rows under this filter → every cell "—"). */
  function dataCellsHTML(metrics, data) {
    return metrics
      .map((m) => {
        const value = data ? data[m.key] : null;
        return `<td class="data-table__td" data-key="${escAttr(m.key)}">${escHtml(formatValue(m, value))}</td>`;
      })
      .join("");
  }

  function loadingCellsHTML(metrics) {
    return metrics.map(() => `<td class="data-table__td filters-tab__cell--loading">…</td>`).join("");
  }

  function errorCellsHTML(metrics) {
    const span = metrics.length || 1;
    return `<td class="data-table__td filters-tab__cell--error" colspan="${span}">Couldn't load this row.</td>`;
  }

  function refreshTable() {
    const host = container.querySelector('[data-role="table-host"]');
    if (!host) return;
    syncPresetSelect();

    if (rows.length === 0) {
      host.innerHTML = `<p class="player-page__note player-page__note--muted">No filtered rows yet</p>`;
      columnsPicker.refresh(container.querySelector('[data-role="columns-btn"]'));
      return;
    }

    const metrics = metricColumns();
    const cols = columnsFor(curDiscipline);
    const bodyRows = rows
      .map(
        (row) =>
          `<tr data-row-id="${escAttr(row.id)}">${labelCellHTML(row)}${loadingCellsHTML(metrics)}</tr>`
      )
      .join("");
    host.innerHTML = `<div class="table-scroll"><table class="data-table">${headerHTML(metrics)}<tbody>${bodyRows}</tbody></table></div>`;
    columnsPicker.refresh(container.querySelector('[data-role="columns-btn"]'));

    // Fire per-row queries; fill each row's cells as it resolves. A token guards
    // against a newer refresh (player switch / discipline / column change)
    // overwriting a stale row.
    const token = ++refreshToken;
    const player = curPlayerId;
    const ps = curPageState;
    const disc = curDiscipline;
    for (const row of rows) {
      fetchRow(row, player, ps, disc, cols)
        .then((data) => {
          if (token !== refreshToken) return;
          const tr = host.querySelector(`tr[data-row-id="${CSS.escape(row.id)}"]`);
          if (!tr) return;
          tr.innerHTML = labelCellHTML(row) + dataCellsHTML(metrics, data);
        })
        .catch((err) => {
          if (token !== refreshToken) return;
          const tr = host.querySelector(`tr[data-row-id="${CSS.escape(row.id)}"]`);
          if (tr) tr.innerHTML = labelCellHTML(row) + errorCellsHTML(metrics);
          console.error("[cricdb] Filters tab row query failed:", err);
        });
    }
  }

  // ---------- public API ----------

  function show(nextPlayerId, nextDiscipline, nextPageState) {
    const nextDisc = nextDiscipline === "bowling" ? "bowling" : "batting";
    const disciplineChanged = nextDisc !== curDiscipline;
    curPlayerId = nextPlayerId ?? curPlayerId;
    curDiscipline = nextDisc;
    curPageState = nextPageState || curPageState;
    // A discipline change swaps the column namespace + preset vocabulary, so the
    // toolbar shell is rebuilt; otherwise only the data re-runs.
    if (disciplineChanged || !container.querySelector(".filters-tab")) {
      renderShell();
    }
    refreshTable();
  }

  function destroy() {
    columnsPicker.close();
    container.innerHTML = "";
  }

  // Initial mount render.
  renderShell();
  refreshTable();

  return { show, destroy };
}
