// src/playerFilters.js
//
// The player popup's OWN "Filters" drawer (B7, decision 44a) — a stats-
// builder for re-scoping one player's sections on top of the page scope
// (Format + Date + Team type, see playerData.js's header). This is a SECOND,
// independent instance of the shared drawer/overlay pattern (src/drawer.js
// is the global "All filters" drawer) — distinct DOM, distinct classnames
// (.player-filters-drawer*, not .filter-drawer*), and it NEVER touches
// src/state.js's global store: the overlay it builds is popup-local, held by
// src/playerPage.js's controller and cleared on close/player switch.
//
// Controls: Date window, Batting position (multi, batting only), Against
// (opposition, single — playerData.js's overlay.opposition is ONE team, not
// a list), Vs (bowling group/type, single, batting only). Vs/Positions are
// hidden entirely outside the Batting tab (task wording: "batting only") —
// PLAYER_SECTION_SUPPORT still lets an already-set value narrow bowling.
// matchups (the STRIKER's position) when the user switches tabs; see
// playerPage.js's report note on this interaction.

import { query, getManifest } from "./db.js";
import { buildScopeClauses } from "./filters.js";
import { escSql as esc } from "./state.js";
import { escHtml, escAttr } from "./html.js";
import { monthOptionsHTML } from "./playerSections.js";

// Same fixed 1-12 vocabulary as the main drawer's Batting position control
// (src/drawerInnings.js's POSITIONS) — batting position is a closed, known
// range, not a query-derived list, so both copies are simple literals kept in
// sync by hand (same precedent as state.js's CONDITION_OP_SYMBOLS comment).
const POSITIONS = Array.from({ length: 12 }, (_, i) => i + 1);

/** Page-scope clauses (Format + Date + Team type only — the player-page scope,
 * see playerData.js's header) plus this player's own id — identical shape to
 * playerData.js's private pageScopeClauses/whereFor, duplicated here because
 * that helper isn't exported (it's file-private) and this module only needs
 * it for two small option-list lookups, not for any stat computation. */
function playerScopeClauses(pageState, idColumn, playerId) {
  const scope = { ...pageState, teams: [], positions: [], opposition: [] };
  return [...buildScopeClauses(scope, { includeGender: false, includeTeams: false }), `${idColumn} = '${esc(playerId)}'`];
}

async function fetchOppositionOptions(playerId, discipline, pageState) {
  const view = discipline; // "batting" | "bowling" — matches db.js's VIEWS keys
  const idCol = discipline === "batting" ? "batter_id" : "bowler_id";
  const teamCol = discipline === "batting" ? "bowling_team" : "batting_team";
  const where = playerScopeClauses(pageState, idCol, playerId).join(" AND ");
  const { rows } = await query(`SELECT DISTINCT ${teamCol} AS team FROM ${view} WHERE ${where} AND ${teamCol} IS NOT NULL ORDER BY team`);
  return rows.map((r) => r.team);
}

/**
 * Specific bowling-type options this player has actually faced. Bare 'Spin'/
 * 'Pace' bowling_type values (decision 24: group known, specific type
 * unknown) are EXCLUDED — playerData.js's overlay.vs is a flat string, and
 * its overlayVsClause always resolves a literal "Spin"/"Pace" to the COARSE
 * GROUP (every spin/pace bowler), never to "the unspecified-type bucket
 * within that group". Offering them again here as a "type" option would look
 * like a narrower pick than it actually is — a collision forced by the flat
 * overlay shape (flagged in the final report, per playerData.js's own note
 * on this ambiguity).
 */
async function fetchVsTypeOptions(playerId, pageState) {
  const where = playerScopeClauses(pageState, "batter_id", playerId).join(" AND ");
  const { rows } = await query(
    `SELECT DISTINCT bowling_type AS t FROM matchup_batting WHERE ${where} AND bowling_type NOT IN ('(unmapped)', 'Spin', 'Pace') ORDER BY t`
  );
  return rows.map((r) => r.t);
}

function dateBounds() {
  const m = getManifest();
  const maxMonth = m?.data?.max_match_date ? m.data.max_match_date.slice(0, 7) : null;
  const minMonth = m?.data?.min_match_date ? m.data.min_match_date.slice(0, 7) : null;
  return { minMonth, maxMonth };
}

/**
 * Mount the drawer (hidden) into `hostEl`. `onApply(overlay)` fires with the
 * built overlay object (or `null` when every control is back to its default —
 * see the fast-path comment in playerData.js: an empty overlay must leave
 * every query byte-identical) whenever the primary button is clicked.
 * Returns `{ open({playerId, discipline, pageState, overlay}), close() }`.
 */
export function mountPlayerFilters(hostEl, { onApply }) {
  hostEl.innerHTML = `
    <div class="player-filters-drawer" data-role="pf-drawer" hidden>
      <div class="player-filters-drawer__backdrop" data-role="pf-backdrop"></div>
      <div class="player-filters-drawer__panel" role="dialog" aria-modal="true" aria-label="Player filters" tabindex="-1" data-role="pf-panel">
        <div class="player-filters-drawer__header">
          <h3 class="player-filters-drawer__title">Filters</h3>
          <button type="button" class="drawer__close" data-role="pf-close" aria-label="Close">&times;</button>
        </div>
        <div class="player-filters-drawer__body">
          <section class="player-filters-drawer__section">
            <h4 class="player-filters-drawer__section-title">Date window</h4>
            <div class="date-range">
              <select class="select" data-role="pf-dateFrom" aria-label="From"></select>
              <span class="date-range__sep">–</span>
              <select class="select" data-role="pf-dateTo" aria-label="To"></select>
            </div>
          </section>

          <section class="player-filters-drawer__section" data-role="pf-section-positions">
            <h4 class="player-filters-drawer__section-title">Batting position</h4>
            <div class="dropdown" data-role="pf-pos-dropdown">
              <button type="button" class="select dropdown__toggle" data-role="pf-pos-toggle" aria-haspopup="true" aria-expanded="false">Any position</button>
              <div class="dropdown__panel" data-role="pf-pos-panel" hidden>
                <div class="dropdown__list" data-role="pf-pos-list">
                  ${POSITIONS.map(
                    (p) => `<label class="dropdown__item"><input type="checkbox" data-position="${p}" /><span>${p}</span></label>`
                  ).join("")}
                </div>
              </div>
            </div>
          </section>

          <section class="player-filters-drawer__section">
            <h4 class="player-filters-drawer__section-title">Against (opposition)</h4>
            <select class="select" data-role="pf-opposition" aria-label="Opposition"></select>
            <p class="player-page__footnote" data-role="pf-opp-note" hidden>International cricket only for now.</p>
          </section>

          <section class="player-filters-drawer__section" data-role="pf-section-vs">
            <h4 class="player-filters-drawer__section-title">Vs</h4>
            <select class="select" data-role="pf-vs" aria-label="Vs bowling style"></select>
          </section>
        </div>
        <div class="filter-drawer__footer">
          <button type="button" class="btn btn--ghost" data-role="pf-clear">Clear</button>
          <button type="button" class="btn btn--primary" data-role="pf-apply">Apply</button>
        </div>
      </div>
    </div>
  `;

  const els = {
    drawer: hostEl.querySelector('[data-role="pf-drawer"]'),
    backdrop: hostEl.querySelector('[data-role="pf-backdrop"]'),
    panel: hostEl.querySelector('[data-role="pf-panel"]'),
    closeBtn: hostEl.querySelector('[data-role="pf-close"]'),
    dateFrom: hostEl.querySelector('[data-role="pf-dateFrom"]'),
    dateTo: hostEl.querySelector('[data-role="pf-dateTo"]'),
    posSection: hostEl.querySelector('[data-role="pf-section-positions"]'),
    posToggle: hostEl.querySelector('[data-role="pf-pos-toggle"]'),
    posPanel: hostEl.querySelector('[data-role="pf-pos-panel"]'),
    posList: hostEl.querySelector('[data-role="pf-pos-list"]'),
    opposition: hostEl.querySelector('[data-role="pf-opposition"]'),
    oppNote: hostEl.querySelector('[data-role="pf-opp-note"]'),
    vsSection: hostEl.querySelector('[data-role="pf-section-vs"]'),
    vs: hostEl.querySelector('[data-role="pf-vs"]'),
    clearBtn: hostEl.querySelector('[data-role="pf-clear"]'),
    applyBtn: hostEl.querySelector('[data-role="pf-apply"]'),
  };

  // Draft state, live only while the drawer is open — never touched by
  // anything outside this module until Apply commits it via onApply().
  let pending = { dateFrom: null, dateTo: null, positions: [], opposition: null, vs: null };
  let ctx = null; // { playerId, discipline, pageState }

  function closePosPanel() {
    els.posPanel.hidden = true;
    els.posToggle.setAttribute("aria-expanded", "false");
  }

  function positionsSummaryLabel(positions) {
    if (!positions || positions.length === 0) return "Any position";
    const sorted = [...positions].sort((a, b) => a - b);
    return sorted.length <= 3 ? sorted.join(", ") : `${sorted.length} selected`;
  }

  function renderPositions() {
    els.posToggle.textContent = positionsSummaryLabel(pending.positions);
    const selected = new Set(pending.positions);
    els.posList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(Number(cb.dataset.position));
    });
  }

  els.posList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = Number(cb.dataset.position);
      const set = new Set(pending.positions);
      if (cb.checked) set.add(value);
      else set.delete(value);
      pending = { ...pending, positions: [...set] };
      renderPositions();
    });
  });
  els.posToggle.addEventListener("click", () => {
    const isOpen = !els.posPanel.hidden;
    if (isOpen) closePosPanel();
    else {
      els.posPanel.hidden = false;
      els.posToggle.setAttribute("aria-expanded", "true");
    }
  });
  document.addEventListener("click", (e) => {
    if (els.posPanel.hidden) return;
    if (hostEl.contains(e.target) && e.target.closest('[data-role="pf-pos-dropdown"]')) return;
    closePosPanel();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.posPanel.hidden) closePosPanel();
  });

  function optionsHTML(values, selected, anyLabel) {
    const opts = [`<option value="">${anyLabel}</option>`];
    for (const v of values) {
      opts.push(`<option value="${escAttr(v)}" ${v === selected ? "selected" : ""}>${escHtml(v)}</option>`);
    }
    // Never silently drop a value that isn't in the freshly fetched list (a
    // stale pick from before a discipline switch, say) — keep it selectable
    // rather than resetting it out from under the user.
    if (selected && !values.includes(selected)) {
      opts.push(`<option value="${escAttr(selected)}" selected>${escHtml(selected)}</option>`);
    }
    return opts.join("");
  }

  els.dateFrom.addEventListener("change", () => {
    pending = { ...pending, dateFrom: els.dateFrom.value || null };
  });
  els.dateTo.addEventListener("change", () => {
    pending = { ...pending, dateTo: els.dateTo.value || null };
  });
  els.opposition.addEventListener("change", () => {
    pending = { ...pending, opposition: els.opposition.value || null };
  });
  els.vs.addEventListener("change", () => {
    pending = { ...pending, vs: els.vs.value || null };
  });

  els.clearBtn.addEventListener("click", () => {
    pending = { dateFrom: null, dateTo: null, positions: [], opposition: null, vs: null };
    renderAll();
  });

  els.applyBtn.addEventListener("click", () => {
    // dateFrom/dateTo only count as an overlay narrowing when they DIFFER from
    // the page's own global scope — the drawer pre-fills them with that same
    // value (task wording), so leaving them untouched must stay the
    // byte-identical fast path (playerData.js's requestedDims), not a
    // redundant "narrower to the exact same window" clause.
    const dateFrom = pending.dateFrom && pending.dateFrom !== ctx.pageState.dateFrom ? pending.dateFrom : null;
    const dateTo = pending.dateTo && pending.dateTo !== ctx.pageState.dateTo ? pending.dateTo : null;
    const overlay = { dateFrom, dateTo, positions: [...pending.positions], opposition: pending.opposition, vs: pending.vs };
    const isEmpty = !overlay.dateFrom && !overlay.dateTo && overlay.positions.length === 0 && !overlay.opposition && !overlay.vs;
    onApply(isEmpty ? null : overlay);
    close();
  });

  function renderAll() {
    const { minMonth, maxMonth } = dateBounds();
    els.dateFrom.innerHTML = monthOptionsHTML(minMonth, maxMonth, pending.dateFrom ?? ctx.pageState.dateFrom);
    els.dateTo.innerHTML = monthOptionsHTML(minMonth, maxMonth, pending.dateTo ?? ctx.pageState.dateTo);
    renderPositions();
    els.opposition.disabled = ctx.pageState.teamType !== "international";
    els.oppNote.hidden = ctx.pageState.teamType === "international";
  }

  els.closeBtn.addEventListener("click", close);
  els.backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.drawer.hidden) close();
  });

  function close() {
    els.drawer.hidden = true;
  }

  /** `overlay` is the popup's CURRENT overlay (null if none) — the drawer
   * seeds its controls from it so reopening shows exactly what's applied. */
  async function open({ playerId, discipline, pageState, overlay }) {
    ctx = { playerId, discipline, pageState };
    const o = overlay || {};
    pending = {
      dateFrom: o.dateFrom ?? null,
      dateTo: o.dateTo ?? null,
      positions: Array.isArray(o.positions) ? [...o.positions] : [],
      opposition: o.opposition ?? null,
      vs: o.vs ?? null,
    };

    // Vs/Positions are batting-only controls (task wording) — hidden outright
    // on the Bowling tab. A value set earlier from the Batting tab is left
    // untouched in `pending` (and therefore in the overlay Apply builds) even
    // while hidden; it still narrows whatever section can honor it (e.g.
    // bowling.matchups' striker position), matching PLAYER_SECTION_SUPPORT.
    const showBattingOnly = discipline === "batting";
    els.posSection.hidden = !showBattingOnly;
    els.vsSection.hidden = !showBattingOnly;

    els.drawer.hidden = false;
    els.panel.focus();
    renderAll();

    try {
      const oppOptions = await fetchOppositionOptions(playerId, discipline, pageState);
      if (ctx.playerId !== playerId || els.drawer.hidden) return; // superseded or closed meanwhile
      els.opposition.innerHTML = optionsHTML(oppOptions, pending.opposition, "Any opposition");
    } catch {
      els.opposition.innerHTML = `<option value="">Couldn't load teams — reopen to retry</option>`;
    }

    if (showBattingOnly) {
      try {
        const vsTypes = await fetchVsTypeOptions(playerId, pageState);
        if (ctx.playerId !== playerId || els.drawer.hidden) return;
        const current = pending.vs;
        const opts = [`<option value="">Everyone</option>`];
        opts.push(`<optgroup label="Pace / spin">`);
        opts.push(`<option value="Pace" ${current === "Pace" ? "selected" : ""}>Pace</option>`);
        opts.push(`<option value="Spin" ${current === "Spin" ? "selected" : ""}>Spin</option>`);
        opts.push(`</optgroup>`);
        opts.push(`<optgroup label="Bowling type">`);
        for (const t of vsTypes) {
          opts.push(`<option value="${escAttr(t)}" ${t === current ? "selected" : ""}>${escHtml(t)}</option>`);
        }
        opts.push(`</optgroup>`);
        els.vs.innerHTML = opts.join("");
      } catch {
        els.vs.innerHTML = `<option value="">Couldn't load bowling types — reopen to retry</option>`;
      }
    }
  }

  return { open, close };
}
