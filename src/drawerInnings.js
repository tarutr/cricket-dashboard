// src/drawerInnings.js
//
// The "Innings" section of the All-filters drawer (owner decision 29):
// batting-position filter + opposition filter. Extracted out of drawer.js to
// keep that module under the ~600-line ceiling — drawer.js already absorbs
// the Team/Min-innings and Player-profile blocks from the old filters.js.
//
// This is the position/opposition half of the old src/splitControls.js,
// moved verbatim; the "Split by" select from that module is NOT here — it
// has been relocated to the table toolbar (src/table.js owns it now).
// Selections that are currently inert (position filter while bowling;
// opposition filter outside international) are kept in state and their
// controls greyed out — the query layer (buildScopeClauses) already ignores
// them (decision-21 treatment, same as the profile filters).
//
// This module renders/wires the DOM and calls store.set(...); it queries the
// database only to populate the opposition option list.

import { query } from "./db.js";
import { buildScopeClauses } from "./filters.js";
import { matchupVsActive } from "./state.js";
import { escHtml, escAttr } from "./html.js";

const POSITIONS = Array.from({ length: 12 }, (_, i) => i + 1);

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
 * Mount the Innings controls into `container` (a section body inside the
 * drawer). Calls `onChange()` after any state mutation. Returns `{ sync }` so
 * drawer.js can re-sync enabled/greyed states and the opposition option list
 * after every filter change elsewhere in the app.
 */
export function mountDrawerInnings(container, store, onChange) {
  container.innerHTML = `
    <div class="filter-bar filter-bar--splits">
      <div class="filter-group filter-group--positions" data-role="positions-group">
        <span class="filter-label">Batting position</span>
        <div class="chip-group chip-group--positions" data-role="positions" role="group" aria-label="Batting position">
          ${POSITIONS.map((p) => `<button type="button" class="chip chip--sm" data-value="${p}">${p}</button>`).join("")}
        </div>
        <span class="profile-note" data-role="positions-note" hidden>Batting view only</span>
        <span class="profile-note" data-role="positions-hint" hidden>Filters the position of the batters faced</span>
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
    </div>
  `;

  const els = {
    positionsGroup: container.querySelector('[data-role="positions-group"]'),
    positions: container.querySelector('[data-role="positions"]'),
    positionsNote: container.querySelector('[data-role="positions-note"]'),
    positionsHint: container.querySelector('[data-role="positions-hint"]'),
    oppositionGroup: container.querySelector('[data-role="opposition-group"]'),
    oppToggle: container.querySelector('[data-role="opp-toggle"]'),
    oppPanel: container.querySelector('[data-role="opp-panel"]'),
    oppSearch: container.querySelector('[data-role="opp-search"]'),
    oppList: container.querySelector('[data-role="opp-list"]'),
    oppClear: container.querySelector('[data-role="opp-clear"]'),
    oppositionNote: container.querySelector('[data-role="opposition-note"]'),
  };

  let oppOptionsCache = [];
  let lastScopeKey = null;
  let oppOptionsLoadToken = 0;
  let oppOptionsErrored = false;

  function scopeKeyFor(state) {
    return JSON.stringify([state.discipline, state.gender, state.formats, state.dateFrom, state.dateTo, state.teamType, state.teams]);
  }

  // ── Batting position ────────────────────────────────────────────────────
  function syncPositions() {
    const state = store.get();
    // D4-R4: both matchup views now carry batting_position (batting side: the
    // batter's own position; bowling side: the position of the striker
    // faced), so the filter is enabled whenever batting is in play — plain
    // batting, matchup batting, AND bowling WITH an active Vs selection.
    // Plain bowling (no Vs) is the only case left with no position concept.
    const matchupOn = matchupVsActive(state);
    const enabled = state.discipline === "batting" || (state.discipline === "bowling" && matchupOn);
    const disabled = !enabled;
    els.positionsGroup.classList.toggle("is-disabled", disabled);
    els.positionsNote.hidden = !disabled;
    els.positionsNote.textContent = "Batting view only — or use Vs in the bowling view";
    const selected = new Set(state.positions);
    els.positions.querySelectorAll(".chip").forEach((btn) => {
      btn.disabled = disabled;
      btn.classList.toggle("is-active", selected.has(Number(btn.dataset.value)));
    });

    // Bowling-matchup hint: this filter narrows the BATTERS faced, not the
    // bowler's own (nonexistent) position — say so plainly so it doesn't read
    // as "position bowled from".
    const bowlingMatchupHint = state.discipline === "bowling" && matchupOn;
    els.positionsHint.hidden = !bowlingMatchupHint;
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
    if (oppOptionsErrored) {
      els.oppList.innerHTML = `<p class="team-dropdown__empty">Couldn't load teams — reopen the drawer to retry.</p>`;
      return;
    }
    const q = (filterText || "").trim().toLowerCase();
    const selected = new Set(store.get().opposition);
    const filtered = oppOptionsCache.filter((t) => t.toLowerCase().includes(q));
    els.oppList.innerHTML =
      filtered
        .map(
          (t) => `<label class="team-dropdown__item">
          <input type="checkbox" data-team="${escAttr(t)}" ${selected.has(t) ? "checked" : ""} />
          <span>${escHtml(t)}</span>
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
      renderOppList(els.oppSearch.value);
      updateOppToggleLabel();
      return;
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

  function sync() {
    syncPositions();
    syncOpposition();
    refreshOppOptions();
  }

  sync();

  return { sync };
}
