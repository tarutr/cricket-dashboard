// src/splitControls.js
//
// Free-splits filter row (D4 Piece 3): batting-position filter, opposition
// filter, and the table-only "Split by" breakdown selector. Mirrors the
// chip-group / checkbox-dropdown patterns from src/filters.js so the two
// filter rows look and behave identically. Selections that are currently
// inert (position filter while bowling; opposition filter/split outside
// international) are kept in state and their controls greyed out — the query
// layer (src/table.js / buildScopeClauses) already ignores them, so nothing
// here needs to clear them; that avoids surprising the user when they switch
// back (decision-21 treatment, same as the profile filters).
//
// This module renders/wires the DOM and calls store.set(...); it queries the
// database only to populate the opposition option list.

import { SPLIT_DIMENSIONS, splitAllowed } from "./state.js";
import { query } from "./db.js";
import { buildScopeClauses } from "./filters.js";

const POSITIONS = Array.from({ length: 12 }, (_, i) => i + 1);

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Distinct opposition team names under the current scope. The opposition
 * filter never narrows its own option list (buildScopeClauses is called
 * without oppositionColumn here), mirroring fetchTeamOptions in filters.js.
 */
async function fetchOppositionOptions(state) {
  const view = state.discipline === "batting" ? "batting" : "bowling";
  const idCol = state.discipline === "batting" ? "batter_id" : "bowler_id";
  const teamCol = state.discipline === "batting" ? "batting_team" : "bowling_team";
  const oppCol = state.discipline === "batting" ? "bowling_team" : "batting_team";
  const clauses = buildScopeClauses(state, { includeTeams: true, teamColumn: teamCol, idColumn: idCol });
  const where = clauses.length ? clauses.join(" AND ") : "TRUE";
  const sql = `SELECT DISTINCT ${oppCol} AS team FROM ${view} WHERE ${where} AND ${oppCol} IS NOT NULL ORDER BY team`;
  const { rows } = await query(sql);
  return rows.map((r) => r.team);
}

/**
 * Mount the splits filter row into `container`. Calls `onChange()` after any
 * state mutation so the caller (main.js) can re-render the table. Returns
 * `{ sync }` so main.js can re-sync enabled/greyed states and option lists
 * after every filter change elsewhere in the app.
 */
export function mountSplitControls(container, store, onChange) {
  container.innerHTML = `
    <div class="filter-bar filter-bar--splits">
      <div class="filter-group filter-group--positions" data-role="positions-group">
        <span class="filter-label">Batting position</span>
        <div class="chip-group chip-group--positions" data-role="positions" role="group" aria-label="Batting position">
          ${POSITIONS.map((p) => `<button type="button" class="chip chip--sm" data-value="${p}">${p}</button>`).join("")}
        </div>
        <span class="profile-note" data-role="positions-note" hidden>Batting view only</span>
      </div>

      <div class="filter-group filter-group--opposition" data-role="opposition-group">
        <span class="filter-label">Opposition</span>
        <div class="team-dropdown" data-role="opp-dropdown">
          <button type="button" class="team-dropdown__toggle" data-role="opp-toggle" aria-haspopup="true" aria-expanded="false">
            Any opposition
          </button>
          <div class="team-dropdown__panel" data-role="opp-panel" hidden>
            <input type="text" class="team-dropdown__search" data-role="opp-search" placeholder="Search teams…" />
            <div class="team-dropdown__list" data-role="opp-list"></div>
            <div class="team-dropdown__actions">
              <button type="button" class="link-btn" data-role="opp-clear">Clear</button>
            </div>
          </div>
        </div>
        <span class="profile-note" data-role="opposition-note" hidden>International cricket only for now</span>
      </div>

      <div class="filter-group filter-group--splitby">
        <label class="filter-label" for="split-by-select">Split by</label>
        <select class="select" id="split-by-select" data-role="split-by"></select>
      </div>
    </div>
  `;

  const els = {
    positionsGroup: container.querySelector('[data-role="positions-group"]'),
    positions: container.querySelector('[data-role="positions"]'),
    positionsNote: container.querySelector('[data-role="positions-note"]'),
    oppositionGroup: container.querySelector('[data-role="opposition-group"]'),
    oppToggle: container.querySelector('[data-role="opp-toggle"]'),
    oppPanel: container.querySelector('[data-role="opp-panel"]'),
    oppSearch: container.querySelector('[data-role="opp-search"]'),
    oppList: container.querySelector('[data-role="opp-list"]'),
    oppClear: container.querySelector('[data-role="opp-clear"]'),
    oppositionNote: container.querySelector('[data-role="opposition-note"]'),
    splitBy: container.querySelector('[data-role="split-by"]'),
  };

  let oppOptionsCache = [];
  let lastScopeKey = null;

  function scopeKeyFor(state) {
    return JSON.stringify([state.discipline, state.gender, state.formats, state.dateFrom, state.dateTo, state.teamType, state.teams]);
  }

  // ── Batting position ────────────────────────────────────────────────────
  function syncPositions() {
    const state = store.get();
    const disabled = state.discipline !== "batting";
    els.positionsGroup.classList.toggle("is-disabled", disabled);
    els.positionsNote.hidden = !disabled;
    const selected = new Set(state.positions);
    els.positions.querySelectorAll(".chip").forEach((btn) => {
      btn.disabled = disabled;
      btn.classList.toggle("is-active", selected.has(Number(btn.dataset.value)));
    });
  }

  els.positions.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn || btn.disabled) return;
    const value = Number(btn.dataset.value);
    const current = new Set(store.get().positions);
    if (current.has(value)) current.delete(value);
    else current.add(value);
    store.set({ positions: [...current] });
    syncPositions();
    onChange();
  });

  // ── Opposition ───────────────────────────────────────────────────────────
  function updateOppToggleLabel() {
    const opp = store.get().opposition;
    els.oppToggle.textContent = opp.length === 0 ? "Any opposition" : opp.length === 1 ? opp[0] : `${opp.length} opponents`;
  }

  function renderOppList(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const selected = new Set(store.get().opposition);
    const filtered = oppOptionsCache.filter((t) => t.toLowerCase().includes(q));
    els.oppList.innerHTML =
      filtered
        .map(
          (t) => `<label class="team-dropdown__item">
          <input type="checkbox" data-team="${escAttr(t)}" ${selected.has(t) ? "checked" : ""} />
          <span>${t}</span>
        </label>`
        )
        .join("") || `<p class="team-dropdown__empty">No teams match.</p>`;

    els.oppList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const current = new Set(store.get().opposition);
        if (cb.checked) current.add(cb.dataset.team);
        else current.delete(cb.dataset.team);
        store.set({ opposition: [...current] });
        updateOppToggleLabel();
        onChange();
      });
    });
  }

  /** Refetch the opposition option list only when the scope actually changed, and
   * only while the filter is eligible (international team type). */
  async function refreshOppOptions() {
    const state = store.get();
    if (state.teamType !== "international") return;
    const key = scopeKeyFor(state);
    if (key === lastScopeKey) return;
    lastScopeKey = key;
    try {
      oppOptionsCache = await fetchOppositionOptions(state);
    } catch (e) {
      oppOptionsCache = [];
    }
    const validSet = new Set(oppOptionsCache);
    const stillValid = state.opposition.filter((t) => validSet.has(t));
    const dropped = stillValid.length !== state.opposition.length;
    if (dropped) store.set({ opposition: stillValid });
    renderOppList(els.oppSearch.value);
    updateOppToggleLabel();
    // A dropped selection changes the honest scope sentence (§8.4) — refresh
    // downstream views even though this resolves after sync() already returned.
    if (dropped) onChange();
  }

  function syncOpposition() {
    const state = store.get();
    const disabled = state.teamType !== "international";
    els.oppositionGroup.classList.toggle("is-disabled", disabled);
    els.oppositionNote.hidden = !disabled;
    els.oppToggle.disabled = disabled;
    if (disabled) {
      els.oppPanel.hidden = true;
      els.oppToggle.setAttribute("aria-expanded", "false");
    }
    updateOppToggleLabel();
  }

  els.oppToggle.addEventListener("click", () => {
    if (els.oppToggle.disabled) return;
    const isOpen = !els.oppPanel.hidden;
    els.oppPanel.hidden = isOpen;
    els.oppToggle.setAttribute("aria-expanded", String(!isOpen));
    if (!isOpen) {
      els.oppSearch.value = "";
      renderOppList("");
      els.oppSearch.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) return;
    if (e.target.closest('[data-role="opp-dropdown"]')) return;
    els.oppPanel.hidden = true;
    els.oppToggle.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    if (container.contains(e.target)) return;
    els.oppPanel.hidden = true;
    els.oppToggle.setAttribute("aria-expanded", "false");
  });
  els.oppSearch.addEventListener("input", () => renderOppList(els.oppSearch.value));
  els.oppClear.addEventListener("click", () => {
    store.set({ opposition: [] });
    renderOppList(els.oppSearch.value);
    updateOppToggleLabel();
    onChange();
  });

  // ── Split by ─────────────────────────────────────────────────────────────
  function syncSplitBySelect() {
    const state = store.get();
    const opts = [`<option value="">None</option>`];
    for (const key of Object.keys(SPLIT_DIMENSIONS)) {
      const dim = SPLIT_DIMENSIONS[key];
      const disabled = !splitAllowed(state, key);
      opts.push(`<option value="${escAttr(key)}" ${disabled ? "disabled" : ""}>${escAttr(dim.label)}</option>`);
    }
    els.splitBy.innerHTML = opts.join("");
    els.splitBy.value = state.splitBy ?? "";
  }

  els.splitBy.addEventListener("change", () => {
    store.set({ splitBy: els.splitBy.value || null });
    onChange();
  });

  function sync() {
    syncPositions();
    syncOpposition();
    refreshOppOptions();
    syncSplitBySelect();
  }

  sync();

  return { sync };
}
