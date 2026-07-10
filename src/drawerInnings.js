// src/drawerInnings.js
//
// Two independent innings-level filter controls, each mounted into its own
// host element by drawer.js:
//   mountBattingPosition — the "Innings" section's Batting position filter.
//   mountOpposition      — the "Advanced" section's "Against (opposition)"
//                          filter (B2R wave 2, decision 42: relocated out of
//                          Innings and renamed exactly as specified).
//
// This is the position/opposition half of the old src/splitControls.js,
// carried forward through the D4-era src/drawerInnings.js; the "Split by"
// select from that module is NOT here — it lives in the table toolbar
// (src/table.js owns it now). Selections that are currently inert (position
// filter while bowling; opposition filter outside international) are kept in
// state and their controls greyed out — the query layer (buildScopeClauses)
// already ignores them (decision-21 treatment, same as the profile filters).
//
// B2R wave 2 (decision 44b/42): Batting position is now a MULTI-SELECT
// DROPDOWN (the owner rejected the old 1-12 chip row) built on the same
// shared .dropdown checkbox-panel component filters.js introduced for the
// Format/Team-type scope-strip dropdowns — no search box, no clear button,
// over a short fixed vocabulary, exactly like those two.
//
// These modules render/wire the DOM and call store.set(...); mountOpposition
// queries the database to populate its option list (mountBattingPosition
// queries nothing — its vocabulary is the fixed 1-12).

import { query } from "./db.js";
import { buildScopeClauses } from "./filters.js";
import { matchupVsActive } from "./state.js";
import { escHtml, escAttr } from "./html.js";

const POSITIONS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * Live summary label for the position dropdown's toggle button. Up to three
 * picked positions list out in full ("1, 2, 3"); four or more collapse to a
 * count ("4 selected") so the toggle never grows past a short phrase — same
 * "+N" instinct as filters.js's format-dropdown summary label, just with a
 * literal count since there's no natural "lead" position to keep. Threshold
 * (3 vs 4+) is a flagged choice, matching the worked examples in the brief.
 */
function positionsSummaryLabel(positions) {
  if (!positions || positions.length === 0) return "Any position";
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted.length <= 3) return sorted.join(", ");
  return `${sorted.length} selected`;
}

/**
 * Mount the Batting position multi-select dropdown into `container` (the
 * "Innings" section's body). Calls `onChange()` after any state mutation.
 * Returns `{ sync }` so drawer.js can re-sync its enabled/greyed state and
 * label after every filter change elsewhere in the app.
 */
export function mountBattingPosition(container, store, onChange) {
  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="positions-group">
      <span class="filter-label">Batting position</span>
      <div class="dropdown" data-role="positions-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="positions-toggle" aria-haspopup="true" aria-expanded="false">Any position</button>
        <div class="dropdown__panel" data-role="positions-panel" hidden>
          <div class="dropdown__list" data-role="positions-list">
            ${POSITIONS.map(
              (p) => `<label class="dropdown__item">
                <input type="checkbox" data-position="${p}" />
                <span>${p}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
      <span class="profile-note" data-role="positions-note" hidden>Batting view only</span>
      <span class="profile-note" data-role="positions-hint" hidden>Filters the position of the batters faced</span>
    </div>
  `;

  const els = {
    group: container.querySelector('[data-role="positions-group"]'),
    toggle: container.querySelector('[data-role="positions-toggle"]'),
    panel: container.querySelector('[data-role="positions-panel"]'),
    list: container.querySelector('[data-role="positions-list"]'),
    note: container.querySelector('[data-role="positions-note"]'),
    hint: container.querySelector('[data-role="positions-hint"]'),
  };

  function updateToggleLabel() {
    els.toggle.textContent = positionsSummaryLabel(store.get().positions);
  }

  function closePanel() {
    els.panel.hidden = true;
    els.toggle.setAttribute("aria-expanded", "false");
  }

  els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = Number(cb.dataset.position);
      const current = new Set(store.get().positions);
      if (cb.checked) current.add(value);
      else current.delete(value);
      store.set({ positions: [...current] });
      updateToggleLabel();
      onChange();
    });
  });

  els.toggle.addEventListener("click", () => {
    if (els.toggle.disabled) return;
    const isOpen = !els.panel.hidden;
    if (isOpen) closePanel();
    else {
      els.panel.hidden = false;
      els.toggle.setAttribute("aria-expanded", "true");
    }
  });
  document.addEventListener("click", (e) => {
    if (els.panel.hidden) return;
    if (container.contains(e.target) && e.target.closest('[data-role="positions-dropdown"]')) return;
    closePanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.panel.hidden) closePanel();
  });

  /** True if the batting-position filter has anything to apply to right now
   * (D4-R4: both matchup views carry batting_position, so the filter is live
   * whenever batting is in play — plain batting, matchup batting, AND
   * bowling WITH an active Vs selection; plain bowling with no Vs is the only
   * case left with no position concept). */
  function sync() {
    const state = store.get();
    const matchupOn = matchupVsActive(state);
    const enabled = state.discipline === "batting" || (state.discipline === "bowling" && matchupOn);
    const disabled = !enabled;
    els.group.classList.toggle("is-disabled", disabled);
    els.note.hidden = !disabled;
    els.note.textContent = "Batting view only — or use Vs in the bowling view";
    els.toggle.disabled = disabled;
    if (disabled) closePanel();
    updateToggleLabel();
    const selected = new Set(state.positions);
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(Number(cb.dataset.position));
    });

    // Bowling-matchup hint: this filter narrows the BATTERS faced, not the
    // bowler's own (nonexistent) position — say so plainly so it doesn't read
    // as "position bowled from".
    const bowlingMatchupHint = state.discipline === "bowling" && matchupOn;
    els.hint.hidden = !bowlingMatchupHint;
  }

  sync();
  return { sync };
}

/**
 * Distinct opposition team names under the current scope. The opposition
 * filter never narrows its own option list (buildScopeClauses is called
 * without oppositionColumn here), mirroring fetchTeamOptions in drawer.js.
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
 * Mount the "Against (opposition)" team-multi-select into `container` (the
 * "Advanced" section's body, B2R wave 2 relocation — was "Opposition" in the
 * old "Innings" section). Calls `onChange()` after any state mutation.
 * Returns `{ sync }` so drawer.js can re-sync the enabled/greyed state and the
 * option list after every filter change elsewhere in the app.
 */
export function mountOpposition(container, store, onChange) {
  container.innerHTML = `
    <div class="filter-group filter-group--opposition" data-role="opposition-group">
      <span class="filter-label">Against (opposition)</span>
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
  `;

  const els = {
    group: container.querySelector('[data-role="opposition-group"]'),
    toggle: container.querySelector('[data-role="opp-toggle"]'),
    panel: container.querySelector('[data-role="opp-panel"]'),
    search: container.querySelector('[data-role="opp-search"]'),
    list: container.querySelector('[data-role="opp-list"]'),
    clear: container.querySelector('[data-role="opp-clear"]'),
    note: container.querySelector('[data-role="opposition-note"]'),
  };

  let oppOptionsCache = [];
  let lastScopeKey = null;
  let oppOptionsLoadToken = 0;
  let oppOptionsErrored = false;

  function scopeKeyFor(state) {
    return JSON.stringify([state.discipline, state.gender, state.formats, state.dateFrom, state.dateTo, state.teamType, state.teams]);
  }

  function updateToggleLabel() {
    const opp = store.get().opposition;
    els.toggle.textContent = opp.length === 0 ? "Any opposition" : opp.length === 1 ? opp[0] : `${opp.length} opponents`;
  }

  function renderList(filterText) {
    if (oppOptionsErrored) {
      els.list.innerHTML = `<p class="team-dropdown__empty">Couldn't load teams — reopen the drawer to retry.</p>`;
      return;
    }
    const q = (filterText || "").trim().toLowerCase();
    const selected = new Set(store.get().opposition);
    const filtered = oppOptionsCache.filter((t) => t.toLowerCase().includes(q));
    els.list.innerHTML =
      filtered
        .map(
          (t) => `<label class="team-dropdown__item">
          <input type="checkbox" data-team="${escAttr(t)}" ${selected.has(t) ? "checked" : ""} />
          <span>${escHtml(t)}</span>
        </label>`
        )
        .join("") || `<p class="team-dropdown__empty">No teams match.</p>`;

    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const current = new Set(store.get().opposition);
        if (cb.checked) current.add(cb.dataset.team);
        else current.delete(cb.dataset.team);
        store.set({ opposition: [...current] });
        updateToggleLabel();
        onChange();
      });
    });
  }

  /** Refetch the opposition option list only when the scope actually changed, and
   * only while the filter is eligible (international team type). */
  async function refreshOptions() {
    const state = store.get();
    if (state.teamType !== "international") return;
    const key = scopeKeyFor(state);
    if (key === lastScopeKey) return;
    const token = ++oppOptionsLoadToken;
    try {
      const fetched = await fetchOppositionOptions(state);
      if (token !== oppOptionsLoadToken) return; // a newer request superseded this one
      oppOptionsCache = fetched;
      oppOptionsErrored = false;
      lastScopeKey = key;
    } catch (e) {
      if (token !== oppOptionsLoadToken) return;
      // Don't set lastScopeKey on failure — it stays stale so the next sync()
      // (drawer reopen / filter change) retries instead of silently sticking
      // with a dishonest "No teams match." empty state.
      oppOptionsErrored = true;
      renderList(els.search.value);
      updateToggleLabel();
      return;
    }
    const validSet = new Set(oppOptionsCache);
    const stillValid = state.opposition.filter((t) => validSet.has(t));
    const dropped = stillValid.length !== state.opposition.length;
    if (dropped) store.set({ opposition: stillValid });
    renderList(els.search.value);
    updateToggleLabel();
    // A dropped selection changes the honest scope sentence (§8.4) — refresh
    // downstream views even though this resolves after sync() already returned.
    if (dropped) onChange();
  }

  function sync() {
    const state = store.get();
    const disabled = state.teamType !== "international";
    els.group.classList.toggle("is-disabled", disabled);
    els.note.hidden = !disabled;
    els.toggle.disabled = disabled;
    if (disabled) {
      els.panel.hidden = true;
      els.toggle.setAttribute("aria-expanded", "false");
    }
    updateToggleLabel();
    refreshOptions();
  }

  els.toggle.addEventListener("click", () => {
    if (els.toggle.disabled) return;
    const isOpen = !els.panel.hidden;
    els.panel.hidden = isOpen;
    els.toggle.setAttribute("aria-expanded", String(!isOpen));
    if (!isOpen) {
      els.search.value = "";
      renderList("");
      els.search.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) return;
    if (e.target.closest('[data-role="opp-dropdown"]')) return;
    els.panel.hidden = true;
    els.toggle.setAttribute("aria-expanded", "false");
  });
  document.addEventListener("click", (e) => {
    if (container.contains(e.target)) return;
    els.panel.hidden = true;
    els.toggle.setAttribute("aria-expanded", "false");
  });
  els.search.addEventListener("input", () => renderList(els.search.value));
  els.clear.addEventListener("click", () => {
    store.set({ opposition: [] });
    renderList(els.search.value);
    updateToggleLabel();
    onChange();
  });

  sync();
  return { sync };
}
