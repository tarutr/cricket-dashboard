// src/drawerInnings.js
//
// The individual filter-editor controls mounted into the condition builder's
// rows (src/drawer.js). Each is a self-contained `{ sync }` controller that
// renders/wires its own DOM and calls store.set(...); drawer.js mounts them
// once and just shows/hides their row by presence, so they survive the numeric
// builder's rebuilds (their option caches + portal wiring never get torn down).
//
//   mountBattingPosition  — MATCHUP-ONLY striker/own batting-position filter
//                           (state.positions); self-hides outside matchup mode.
//   mountRegularPositions — "R. Pos." (state.regularPositions, decision 46):
//                           plain-mode filter on a player's most common batting
//                           position within scope (modal semi-join lives in
//                           filters.js). Both disciplines + both genders.
//   mountOpposition       — "Against opposition" (state.opposition); INTERNATIONAL
//                           only (decision 20), so it greys out otherwise.
//   mountTeam             — "Played for" (state.teams); single gender-scoped team
//                           picker (owner 1B-2 removed the Current/Historic split).
//   mountEvent            — "Event" (state.event, Batch 1B); gender-scoped.
//   mountVenue            — "Venue" (state.venue, Batch 1B); gender-scoped.
//
// Team/Event/Venue share mountSearchMultiselect(): a relevance-ranked,
// gender- + team-type-scoped multiselect backed by playerData.js's searchTeams/
// searchEvents/searchVenues loaders. Those loaders are called ONCE per
// gender+teamType with term="" (the full scoped list, ordered games-desc —
// events also recency-desc); the search box then filters that cached list
// client-side, so within any typed substring the games-desc order is preserved
// (typing "India" surfaces the full national team — most games — first).
// Re-fetches when the gender OR the team type changes (ROUND 3 task 8 — on
// International the Event list must drop domestic-only competitions like IPL).
// On reopen with an empty term, currently-selected options float to the top
// (task 5). Each row is labelled "<name>  N games" (task 4).

import { query } from "./db.js";
import { buildScopeClauses, wirePortalDropdown } from "./filters.js";
import { matchupVsActive } from "./state.js";
import { searchTeams, searchEvents, searchVenues } from "./playerData.js";
import { escHtml, escAttr } from "./html.js";

const POSITIONS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * Live summary label for a position dropdown's toggle button. Up to three
 * picked positions list out in full ("1, 2, 3"); four or more collapse to a
 * count ("4 selected") so the toggle never grows past a short phrase.
 */
function positionsSummaryLabel(positions) {
  if (!positions || positions.length === 0) return "Any position";
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted.length <= 3) return sorted.join(", ");
  return `${sorted.length} selected`;
}

/**
 * Mount the MATCHUP-ONLY Batting position multi-select. `embedded` suppresses
 * the outer filter-label (the condition row already names it). Returns `{ sync }`.
 */
export function mountBattingPosition(container, store, onChange, { embedded = false } = {}) {
  container.innerHTML = `
    <div class="filter-group filter-group--positions" data-role="positions-group">
      ${embedded ? "" : `<span class="filter-label">Batting position</span>`}
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
      <span class="profile-note" data-role="positions-hint" hidden>Filters the position of the batters faced</span>
    </div>
  `;

  const els = {
    group: container.querySelector('[data-role="positions-group"]'),
    toggle: container.querySelector('[data-role="positions-toggle"]'),
    panel: container.querySelector('[data-role="positions-panel"]'),
    list: container.querySelector('[data-role="positions-list"]'),
    hint: container.querySelector('[data-role="positions-hint"]'),
  };

  function updateToggleLabel() {
    els.toggle.textContent = positionsSummaryLabel(store.get().positions);
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel);

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

  /** MATCHUP-ONLY (decision 46): live only while a matchup "Vs" selection is
   * active — in matchup_batting it's the batter's own position, in
   * matchup_bowling the position of the striker faced. Plain mode uses R. Pos.
   * instead, so this hides entirely outside matchup mode. */
  function sync() {
    const state = store.get();
    const matchupOn = matchupVsActive(state);
    els.group.hidden = !matchupOn;
    if (!matchupOn) {
      dropdown.close();
      return;
    }
    els.toggle.disabled = false;
    updateToggleLabel();
    const selected = new Set(state.positions);
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(Number(cb.dataset.position));
    });
    // Bowling-matchup hint: this filter narrows the BATTERS faced, not the
    // bowler's own (nonexistent) position — say so plainly.
    els.hint.hidden = !(state.discipline === "bowling" && matchupOn);
  }

  sync();
  return { sync };
}

const REGULAR_POSITIONS = Array.from({ length: 11 }, (_, i) => i + 1);

/**
 * Mount the "R. Pos." (regular position) multi-select (decision 46). Binds to
 * `state.regularPositions` — a player matches when their MOST COMMON batting
 * position within scope is in the selection (the semi-join lives in filters.js).
 * PLAIN-MODE only (hides in matchup mode). Both disciplines + both genders.
 * `embedded` suppresses the outer filter-label. Returns `{ sync }`.
 */
export function mountRegularPositions(container, store, onChange, { embedded = false } = {}) {
  const DESC = "Regular position — where this player most often bats";
  container.innerHTML = `
    <div class="filter-group filter-group--rpos" data-role="rpos-group">
      ${embedded ? "" : `<span class="filter-label" title="${escAttr(DESC)}">R. Pos.</span>`}
      <div class="dropdown" data-role="rpos-dropdown">
        <button type="button" class="select dropdown__toggle" data-role="rpos-toggle" aria-haspopup="true" aria-expanded="false" title="${escAttr(DESC)}">Any position</button>
        <div class="dropdown__panel" data-role="rpos-panel" hidden>
          <div class="dropdown__list" data-role="rpos-list">
            ${REGULAR_POSITIONS.map(
              (p) => `<label class="dropdown__item">
                <input type="checkbox" data-position="${p}" />
                <span>${p}</span>
              </label>`
            ).join("")}
          </div>
        </div>
      </div>
    </div>
  `;

  const els = {
    group: container.querySelector('[data-role="rpos-group"]'),
    toggle: container.querySelector('[data-role="rpos-toggle"]'),
    panel: container.querySelector('[data-role="rpos-panel"]'),
    list: container.querySelector('[data-role="rpos-list"]'),
  };

  function updateToggleLabel() {
    els.toggle.textContent = positionsSummaryLabel(store.get().regularPositions);
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel);

  els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const value = Number(cb.dataset.position);
      const current = new Set(store.get().regularPositions);
      if (cb.checked) current.add(value);
      else current.delete(value);
      store.set({ regularPositions: [...current] });
      updateToggleLabel();
      onChange();
    });
  });

  function sync() {
    const state = store.get();
    els.group.hidden = matchupVsActive(state); // plain-mode only
    if (matchupVsActive(state)) {
      dropdown.close();
      return;
    }
    updateToggleLabel();
    const selected = new Set(state.regularPositions);
    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = selected.has(Number(cb.dataset.position));
    });
  }

  sync();
  return { sync };
}

/**
 * Distinct opposition team names under the current scope. The opposition filter
 * never narrows its own option list (buildScopeClauses called without
 * oppositionColumn here).
 *
 * R7 owner correction (item 5): the opposition picker is the EXACT SAME
 * mechanism as the "Played for" Team picker — searchTeams() counts each team's
 * TOTAL matches from the matches table (scoped by gender + team type only, NOT
 * date/format), games-desc. So the big cricketing nations (India, Pakistan,
 * England…) lead, identical to the Team dropdown, rather than an in-scope count
 * (which put associate nations on top in short windows). Shows every team (the
 * search box narrows); changes ORDER/membership of the OPTION list only — no
 * leaderboard/table query is touched (baseline unaffected).
 */
async function fetchOppositionOptions(state) {
  const rows = await searchTeams("", state.gender, state.teamType);
  return rows.map((r) => r.value);
}

/**
 * Mount the "Against opposition" team-multiselect (state.opposition). Embedded
 * inside a condition row (the row's type label names it), so its own label is
 * suppressed. INTERNATIONAL-only (decision 20): greys + closes otherwise, and
 * oppositionFilterActive() keeps the pill/subtitle honest. Returns `{ sync }`.
 */
export function mountOpposition(container, store, onChange, { embedded = false } = {}) {
  container.innerHTML = `
    <div class="filter-group filter-group--opposition ${embedded ? "filter-group--opp-embedded" : ""}" data-role="opposition-group">
      ${embedded ? "" : `<span class="filter-label">Against (opposition)</span>`}
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
      els.list.innerHTML = `<p class="team-dropdown__empty">Couldn't load teams — reopen the filters to retry.</p>`;
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

  async function refreshOptions() {
    const state = store.get();
    if (state.teamType !== "international") return;
    const key = scopeKeyFor(state);
    if (key === lastScopeKey) return;
    const token = ++oppOptionsLoadToken;
    try {
      const fetched = await fetchOppositionOptions(state);
      if (token !== oppOptionsLoadToken) return;
      oppOptionsCache = fetched;
      oppOptionsErrored = false;
      lastScopeKey = key;
    } catch (e) {
      if (token !== oppOptionsLoadToken) return;
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
    if (dropped) onChange();
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel, {
    onOpen: () => {
      els.search.value = "";
      renderList("");
      els.search.focus();
    },
  });

  function sync() {
    const state = store.get();
    const disabled = state.teamType !== "international";
    els.group.classList.toggle("is-disabled", disabled);
    els.note.hidden = !disabled;
    els.toggle.disabled = disabled;
    if (disabled) dropdown.close();
    updateToggleLabel();
    refreshOptions();
  }

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

/**
 * Shared gender-scoped, relevance-ranked multiselect for Team / Event / Venue
 * (task 1B-2). `config`:
 *   { get(state)->string[], set(store,arr), loader(gender)->Promise<opts>,
 *     emptyLabel, countLabel(n)->string, searchPlaceholder, itemMeta(opt)->string }
 * Options are loaded once per gender (loader gets the full gender-scoped list);
 * the search box filters that cache client-side. Returns `{ sync }`.
 */
function mountSearchMultiselect(container, store, onChange, config) {
  container.innerHTML = `
    <div class="filter-group filter-group--opp-embedded" data-role="ms-group">
      <div class="team-dropdown" data-role="ms-dropdown">
        <button type="button" class="team-dropdown__toggle" data-role="ms-toggle" aria-haspopup="true" aria-expanded="false">
          ${escHtml(config.emptyLabel)}
        </button>
        <div class="team-dropdown__panel" data-role="ms-panel" hidden>
          <input type="text" class="team-dropdown__search" data-role="ms-search" placeholder="${escAttr(config.searchPlaceholder)}" />
          <div class="team-dropdown__list" data-role="ms-list"></div>
          <div class="team-dropdown__actions">
            <button type="button" class="link-btn" data-role="ms-clear">Clear</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const els = {
    toggle: container.querySelector('[data-role="ms-toggle"]'),
    panel: container.querySelector('[data-role="ms-panel"]'),
    search: container.querySelector('[data-role="ms-search"]'),
    list: container.querySelector('[data-role="ms-list"]'),
    clear: container.querySelector('[data-role="ms-clear"]'),
  };

  let optionsCache = []; // [{value,label,games,...}] for loadedKey
  let loadedKey = null; // "gender|teamType" the cache was loaded for
  let loadToken = 0;
  let loading = false;
  let errored = false;

  // Cache key (ROUND 3, task 8): options are gender- AND team-type-scoped, so
  // the cache must invalidate when EITHER changes (e.g. switching to
  // International must re-fetch so IPL drops out of the Event list).
  function cacheKey() {
    const s = store.get();
    return `${s.gender}|${s.teamType}`;
  }

  function selected() {
    return new Set(config.get(store.get()));
  }

  function updateToggleLabel() {
    const arr = config.get(store.get());
    els.toggle.textContent = arr.length === 0 ? config.emptyLabel : arr.length === 1 ? arr[0] : config.countLabel(arr.length);
  }

  function renderList(filterText) {
    if (loading) {
      els.list.innerHTML = `<p class="team-dropdown__empty">Loading…</p>`;
      return;
    }
    if (errored) {
      els.list.innerHTML = `<p class="team-dropdown__empty">Couldn't load options — reopen the filters to retry.</p>`;
      return;
    }
    const q = (filterText || "").trim().toLowerCase();
    const sel = selected();
    let filtered = optionsCache.filter((o) => o.label.toLowerCase().includes(q));
    // Selected-first on reopen (ROUND 3, task 5): when the panel opens with an
    // empty search term, float the currently-selected options to the TOP (in
    // their existing relevance order), the rest below in the usual order. Only
    // for the empty-term case — while the user is actively typing a filter, the
    // list stays in pure relevance order so matches don't jump around.
    if (q === "") {
      const chosen = filtered.filter((o) => sel.has(o.value));
      const rest = filtered.filter((o) => !sel.has(o.value));
      filtered = [...chosen, ...rest];
    }
    els.list.innerHTML =
      filtered
        .map((o) => {
          const meta = config.itemMeta ? config.itemMeta(o) : "";
          return `<label class="team-dropdown__item">
            <input type="checkbox" data-value="${escAttr(o.value)}" ${sel.has(o.value) ? "checked" : ""} />
            <span>${escHtml(o.label)}${meta ? ` <span class="team-dropdown__meta">${escHtml(meta)}</span>` : ""}</span>
          </label>`;
        })
        .join("") || `<p class="team-dropdown__empty">No matches.</p>`;

    els.list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cur = new Set(config.get(store.get()));
        if (cb.checked) cur.add(cb.dataset.value);
        else cur.delete(cb.dataset.value);
        config.set(store, [...cur]);
        updateToggleLabel();
        onChange();
      });
    });
  }

  async function ensureLoaded() {
    const key = cacheKey();
    if (loadedKey === key && !errored) {
      renderList(els.search.value); // already cached for this gender+teamType — show it
      return;
    }
    loading = true;
    errored = false;
    renderList(els.search.value); // "Loading…"
    const token = ++loadToken;
    const s = store.get();
    try {
      const rows = await config.loader(s.gender, s.teamType);
      if (token !== loadToken) return;
      optionsCache = rows || [];
      loadedKey = key;
      loading = false;
    } catch (e) {
      if (token !== loadToken) return;
      loading = false;
      errored = true;
      renderList(els.search.value);
      return;
    }
    renderList(els.search.value);
  }

  const dropdown = wirePortalDropdown(els.toggle, els.panel, {
    onOpen: () => {
      els.search.value = "";
      els.search.focus();
      ensureLoaded();
    },
  });

  els.search.addEventListener("input", () => renderList(els.search.value));
  els.clear.addEventListener("click", () => {
    config.set(store, []);
    renderList(els.search.value);
    updateToggleLabel();
    onChange();
  });

  function sync() {
    // Gender OR team type changed since the cache loaded → drop it so the next
    // open reloads for the new scope (selections are cleared by the gender /
    // team-type handlers in filters.js — ROUND 3 task 9).
    if (loadedKey !== null && loadedKey !== cacheKey()) {
      loadedKey = null;
      optionsCache = [];
      dropdown.close();
    }
    updateToggleLabel();
  }

  sync();
  return { sync };
}

// Game-count meta label (ROUND 3, task 4): "1,013 games" — localized thousands
// separator, the word "games" spelled out. Shared by Team/Event/Venue rows.
// (The Opposition picker keeps its own plain list — no meta — see mountOpposition.)
function gamesMeta(o) {
  return o.games != null ? `${Number(o.games).toLocaleString()} games` : "";
}

/** "Played for" — single gender + team-type-scoped team picker (state.teams). */
export function mountTeam(container, store, onChange) {
  return mountSearchMultiselect(container, store, onChange, {
    get: (s) => s.teams || [],
    set: (st, arr) => st.set({ teams: arr }),
    loader: (gender, teamType) => searchTeams("", gender, teamType),
    emptyLabel: "All teams",
    countLabel: (n) => `${n} teams`,
    searchPlaceholder: "Search teams…",
    itemMeta: gamesMeta,
  });
}

/** "Event" — gender + team-type-scoped competition/series picker (state.event). */
export function mountEvent(container, store, onChange) {
  return mountSearchMultiselect(container, store, onChange, {
    get: (s) => s.event || [],
    set: (st, arr) => st.set({ event: arr }),
    loader: (gender, teamType) => searchEvents("", gender, teamType),
    emptyLabel: "Any event",
    countLabel: (n) => `${n} events`,
    searchPlaceholder: "Search events…",
    itemMeta: gamesMeta,
  });
}

/** "Venue" — gender + team-type-scoped ground picker (state.venue). */
export function mountVenue(container, store, onChange) {
  return mountSearchMultiselect(container, store, onChange, {
    get: (s) => s.venue || [],
    set: (st, arr) => st.set({ venue: arr }),
    loader: (gender, teamType) => searchVenues("", gender, teamType),
    emptyLabel: "Any venue",
    countLabel: (n) => `${n} venues`,
    searchPlaceholder: "Search venues…",
    itemMeta: gamesMeta,
  });
}
