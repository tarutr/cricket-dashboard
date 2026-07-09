// src/filters.js
//
// The scope strip (owner decision 29: one slim filter bar + one "All filters"
// drawer, replacing the old three-row layout). This module keeps ONLY the
// filters common to every query — Gender, Format, Date range, Team type —
// plus the button that opens the drawer (src/drawer.js) holding everything
// else: Team, Min innings, Player profile, Innings (position/opposition),
// and Stat conditions (src/advanced.js).
//
// This module only renders/wires the DOM and calls store.set(...); it never
// queries the database directly — src/table.js owns re-querying on state
// change, and src/drawer.js owns the team/opposition option-list lookups.

import {
  FORMAT_BUCKETS,
  expandFormats,
  emptyProfile,
  profileSemiJoinSql,
  oppositionFilterActive,
  positionsFilterActive,
  escSql as esc,
} from "./state.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthOptionsHTML(minMonth, maxMonth, selected) {
  if (!minMonth || !maxMonth) return "";
  const [minY, minM] = minMonth.split("-").map(Number);
  const [maxY, maxM] = maxMonth.split("-").map(Number);
  const opts = [];
  for (let y = maxY; y >= minY; y--) {
    const mFrom = y === maxY ? maxM : 12;
    const mTo = y === minY ? minM : 1;
    for (let m = mFrom; m >= mTo; m--) {
      const val = `${y}-${String(m).padStart(2, "0")}`;
      opts.push(`<option value="${val}" ${val === selected ? "selected" : ""}>${MONTH_NAMES[m - 1]} ${y}</option>`);
    }
  }
  return opts.join("");
}

/** Shared WHERE-clause builder for gender/format/date/team_type/(team) — used by
 * both the drawer's team/opposition-options lookups and src/table.js's main
 * query. Exported so table.js, drawer.js, and graph builders all build an
 * identical scope.
 *
 * D4 Piece 3 opt-ins (both default OFF because some callers query views that
 * lack the columns, e.g. player_matches):
 *   oppositionColumn — the view's opposition column (bowling_team for batting,
 *     batting_team for bowling). The opposition filter applies ONLY while
 *     teamType === "international" (decision 20; the controls grey out
 *     elsewhere, so an inert selection must never filter silently).
 *   includePositions — apply the batting-position filter (batting innings
 *     views only; positions are a batting concept, inert in bowling). */
export function buildScopeClauses(
  state,
  { includeTeams = true, teamColumn, idColumn, oppositionColumn, includePositions = false, includeGender = true } = {}
) {
  const clauses = [];
  // Player-page queries (R2) filter by a specific player_id, so gender is
  // redundant there — every other caller keeps the gender clause.
  if (includeGender) clauses.push(`gender = '${esc(state.gender)}'`);

  const matchTypes = expandFormats(state.formats);
  if (matchTypes.length === 0) {
    clauses.push("FALSE"); // no format selected -> no rows, never "all"
  } else {
    clauses.push(`match_type IN (${matchTypes.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  if (state.dateFrom) clauses.push(`match_date >= DATE '${esc(state.dateFrom)}-01'`);
  if (state.dateTo) {
    // Inclusive of the whole "to" month: use the first day of the FOLLOWING month.
    const [y, m] = state.dateTo.split("-").map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    clauses.push(`match_date < DATE '${nextY}-${String(nextM).padStart(2, "0")}-01'`);
  }

  if (state.teamType === "international") clauses.push(`team_type = 'international'`);
  else if (state.teamType === "club") clauses.push(`team_type = 'club'`);
  // "both" -> no predicate

  if (includeTeams && state.teams && state.teams.length > 0 && teamColumn) {
    clauses.push(`${teamColumn} IN (${state.teams.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  if (oppositionColumn && oppositionFilterActive(state)) {
    clauses.push(`${oppositionColumn} IN (${state.opposition.map((t) => `'${esc(t)}'`).join(", ")})`);
  }

  if (includePositions && positionsFilterActive(state)) {
    // Positions are user-picked ints; coerce + drop anything non-integral so
    // nothing unsanitized reaches the SQL.
    const nums = state.positions.map(Number).filter(Number.isInteger);
    if (nums.length > 0) clauses.push(`batting_position IN (${nums.join(", ")})`);
  }

  // Profile-powered filters (D4.2): semi-join to matched player_ids. Only added
  // when an idColumn is supplied by the caller (the player_matches/innings views
  // and matchup views all have a join key; some scoped lookups don't) and a
  // profile filter is active. profileSemiJoinSql itself no-ops for women.
  if (idColumn) {
    const profileClause = profileSemiJoinSql(state, idColumn);
    if (profileClause) clauses.push(profileClause);
  }

  return clauses;
}

/**
 * Mount the scope strip into `container`. Calls `onChange()` after any state
 * mutation so the caller (main.js) can re-render the table. The "All filters"
 * button itself (open-drawer) is rendered here but left unwired — main.js
 * owns opening src/drawer.js and keeping its count badge in sync.
 */
export function mountFilters(container, store, onChange, onFormatsChanged) {
  container.innerHTML = `
    <div class="filter-bar">
      <div class="filter-group filter-group--gender">
        <span class="filter-label">Gender</span>
        <div class="segmented" data-role="gender" role="group" aria-label="Gender">
          <button type="button" class="segmented__btn" data-value="female">Women</button>
          <button type="button" class="segmented__btn" data-value="male">Men</button>
        </div>
      </div>

      <div class="filter-group filter-group--format">
        <span class="filter-label">Format</span>
        <div class="chip-group" data-role="formats" role="group" aria-label="Format">
          ${FORMAT_BUCKETS.map(
            (b) => `<button type="button" class="chip" data-value="${b.key}">${b.label}</button>`
          ).join("")}
        </div>
      </div>

      <div class="filter-group filter-group--dates">
        <span class="filter-label">Date range</span>
        <div class="date-range">
          <select class="select" data-role="dateFrom" aria-label="From"></select>
          <span class="date-range__sep">–</span>
          <select class="select" data-role="dateTo" aria-label="To"></select>
        </div>
      </div>

      <div class="filter-group filter-group--teamtype">
        <span class="filter-label">Team type</span>
        <div class="segmented" data-role="teamType" role="group" aria-label="Team type">
          <button type="button" class="segmented__btn" data-value="international">International</button>
          <button type="button" class="segmented__btn" data-value="club">Club</button>
          <button type="button" class="segmented__btn" data-value="both">Both</button>
        </div>
      </div>

      <button type="button" class="btn btn--ghost filter-open-btn" data-role="open-drawer" aria-haspopup="dialog">
        All filters <span class="filter-open-btn__count" data-role="open-drawer-count" hidden></span>
      </button>
    </div>
  `;

  const els = {
    gender: container.querySelector('[data-role="gender"]'),
    formats: container.querySelector('[data-role="formats"]'),
    dateFrom: container.querySelector('[data-role="dateFrom"]'),
    dateTo: container.querySelector('[data-role="dateTo"]'),
    teamType: container.querySelector('[data-role="teamType"]'),
  };

  function syncSegmented(el, value) {
    el.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === value);
    });
  }

  function syncChips(el, values) {
    el.querySelectorAll(".chip").forEach((btn) => {
      btn.classList.toggle("is-active", values.includes(btn.dataset.value));
    });
  }

  function syncDateOptions(minMonth, maxMonth, state) {
    els.dateFrom.innerHTML = monthOptionsHTML(minMonth, maxMonth, state.dateFrom);
    els.dateTo.innerHTML = monthOptionsHTML(minMonth, maxMonth, state.dateTo);
  }

  function render() {
    const state = store.get();
    syncSegmented(els.gender, state.gender);
    syncChips(els.formats, state.formats);
    syncSegmented(els.teamType, state.teamType);
  }

  // ---- wire events ----
  els.gender.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    // Switching gender clears team + profile filters: teams differ by gender, and
    // profile filters are men-only (cleared so the women's view is never silently
    // empty — the drawer's profile controls also grey out, decision 21).
    store.set({ gender: btn.dataset.value, teams: [], profile: emptyProfile() });
    render();
    onChange();
  });

  els.formats.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    const state = store.get();
    const value = btn.dataset.value;
    const set = new Set(state.formats);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    store.set({ formats: [...set], teams: [] });
    render();
    if (onFormatsChanged) onFormatsChanged();
    onChange();
  });

  els.dateFrom.addEventListener("change", () => {
    store.set({ dateFrom: els.dateFrom.value });
    onChange();
  });
  els.dateTo.addEventListener("change", () => {
    store.set({ dateTo: els.dateTo.value });
    onChange();
  });

  els.teamType.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    store.set({ teamType: btn.dataset.value, teams: [] });
    render();
    onChange();
  });

  render();

  return {
    render,
    setDateBounds(minMonth, maxMonth) {
      syncDateOptions(minMonth, maxMonth, store.get());
    },
  };
}
