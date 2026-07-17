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
// Team/Opposition/Event/Venue share mountScopedMultiSelect(): a thin wrapper
// over searchSelect.js's mountSearchMultiSelect (portal:true, so its panel
// escapes the Filters popup's overflow clip) fed the SAME relevance-ranked,
// gender- + team-type-scoped option lists as before (playerData.js's
// searchTeams/searchEvents/searchVenues). The loaders are UNCHANGED — called
// once per gender|teamType with term="" (the full scoped list, ordered
// games-desc; events also recency-desc) — and each picker writes the SAME state
// field it always did, so the built query and every leaderboard/graph number is
// unchanged; only the control's look/behaviour (typeahead + keyboard + ARIA)
// changes (Design Round 2, wave R2-2b-ii). Options load lazily (on the row
// becoming visible / first open) and reload when gender OR team type changes
// (ROUND 3 task 8 — on International the Event list must drop domestic-only
// competitions like IPL). Team/Event/Venue rows show a "<name>  N games" meta;
// Opposition keeps its plain list (no meta) and greys out off International
// (decision 20).

import { wirePortalDropdown } from "./filters.js";
import { matchupVsActive } from "./state.js";
import { searchTeams, searchEvents, searchVenues } from "./playerData.js";
import { mountSearchMultiSelect } from "./searchSelect.js";
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
 * BATTING contexts only (plain batting AND batting matchup, Wave 4b/decision 47a);
 * hides in every bowling context. Both genders. `embedded` suppresses the outer
 * filter-label. Returns `{ sync }`.
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
    // R. Pos. is a BATTING concept (Wave 4b, decision 47a): the control shows in
    // every batting context — plain batting AND batting matchup, where it sits
    // alongside the striker-position control — and hides in every bowling context
    // (plain or matchup), where the striker-position control is the only position
    // filter. (Previously plain-mode-only, both disciplines.)
    const show = state.discipline === "batting";
    els.group.hidden = !show;
    if (!show) {
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

// Game-count meta label (ROUND 3, task 4): "1,013 games" — localized thousands
// separator, the word "games" spelled out. Shown on Team/Event/Venue rows.
// (Opposition passes showGames:false — it keeps its own plain list, no meta.)
function gamesMeta(o) {
  return o && o.games != null ? `${Number(o.games).toLocaleString()} games` : "";
}

/**
 * Shared gender- + team-type-scoped searchable MULTI-select for Team /
 * Opposition / Event / Venue (Design Round 2, wave R2-2b-ii). Wraps
 * searchSelect.js's mountSearchMultiSelect (portal:true so its panel escapes the
 * Filters popup's overflow clip) and feeds it the SAME async, relevance-ranked
 * option lists as before via `config.loader` (playerData.js's searchTeams/
 * searchEvents/searchVenues — UNCHANGED). The picker writes the SAME state field
 * it always did, so the built query — and every leaderboard/graph number — is
 * unchanged; only the control changes.
 *
 * `config`:
 *   { get(state)->string[], set(store,arr), loader(gender,teamType)->Promise<rows>,
 *     emptyLabel, singular, plural, ariaLabel, searchPlaceholder,
 *     showGames?:bool, disabledWhen?(state)->bool, disabledNote?:string }
 *
 * Options load lazily — on the row becoming visible OR first toggle interaction
 * — and reload when the gender|teamType scope changes (filters.js clears the
 * selection on such a change, so a stale pick never survives). Returns `{ sync }`.
 */
function mountScopedMultiSelect(container, store, onChange, config) {
  container.innerHTML = `
    <div class="filter-group filter-group--ms" data-role="ms-group">
      <div data-role="ms-host"></div>
      ${config.disabledNote ? `<span class="profile-note" data-role="ms-note" hidden>${escHtml(config.disabledNote)}</span>` : ""}
    </div>`;
  const groupEl = container.querySelector('[data-role="ms-group"]');
  const hostEl = container.querySelector('[data-role="ms-host"]');
  const noteEl = container.querySelector('[data-role="ms-note"]');

  // Toggle label: 0 → placeholder; 1 → the single value's own name (getValues()
  // is up to date when summarize runs during a toggle/setValues); >1 → "N teams".
  let handle;
  const summarize = (count) => {
    const vals = handle ? handle.getValues() : [];
    if (vals.length === 1) return vals[0];
    return `${count} ${count === 1 ? config.singular : config.plural}`;
  };

  handle = mountSearchMultiSelect(hostEl, {
    options: [],
    values: config.get(store.get()),
    portal: true,
    placeholder: config.emptyLabel,
    filterPlaceholder: config.searchPlaceholder,
    summarize,
    ariaLabel: config.ariaLabel,
    renderRow: (o) => {
      const meta = config.showGames ? gamesMeta(o) : "";
      return (
        `<span class="search-select__check" aria-hidden="true"></span>` +
        `<span class="search-select__opt-label">${escHtml(o.label)}</span>` +
        (meta ? `<span class="search-select__meta">${escHtml(meta)}</span>` : "")
      );
    },
    onChange: (values) => {
      config.set(store, values); // SAME state field as before → query unchanged
      onChange();
    },
  });

  const toggleEl = hostEl.querySelector(".search-select__toggle");

  // ── Async option loading (gender|teamType scoped, lazy) ────────────────────
  let optionsCache = [];
  let loadedKey = null;
  let loadToken = 0;
  let loading = false;
  const cacheKey = () => {
    const s = store.get();
    return `${s.gender}|${s.teamType}`;
  };
  async function ensureLoaded() {
    const key = cacheKey();
    if (loadedKey === key || loading) return;
    loading = true;
    const token = ++loadToken;
    const s = store.get();
    let rows;
    try {
      rows = await config.loader(s.gender, s.teamType);
    } catch (e) {
      loading = false;
      return; // leave options empty; a later open retries
    }
    if (token !== loadToken) return;
    loading = false;
    optionsCache = rows || [];
    loadedKey = key;
    handle.setOptions(optionsCache);
    // Reflect the current selection against the fresh options (keeps the toggle
    // summary + checks honest; setOptions on its own would drop unknown values).
    handle.setValues(config.get(store.get()));
  }

  // Lazy-load fallback: first interaction with the toggle (before it opens).
  toggleEl.addEventListener("mousedown", ensureLoaded);
  toggleEl.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") ensureLoaded();
  });

  function sync() {
    const s = store.get();
    // Disabled state (Opposition = international only, decision 20): grey the
    // toggle (:disabled styling) + show the note; a disabled toggle can't open.
    // The query-side gate (oppositionFilterActive) keeps an inert selection from
    // ever filtering, so greying is purely a UI affordance.
    const disabled = config.disabledWhen ? config.disabledWhen(s) : false;
    if (noteEl) noteEl.hidden = !disabled;
    groupEl.classList.toggle("is-disabled", disabled);
    toggleEl.disabled = disabled;
    if (disabled) handle.close();

    if (loadedKey !== null && loadedKey !== cacheKey()) {
      // Gender/team-type changed since the last load — drop the cache and reload
      // for the new scope (the selection was already cleared upstream).
      loadedKey = null;
      ensureLoaded();
    } else if (loadedKey === null && hostEl.offsetParent !== null) {
      // Row is visible (popup open, condition present) and nothing loaded yet —
      // pre-load so the first open shows a populated list, not a flash of empty.
      ensureLoaded();
    } else {
      // Keep the toggle summary honest even without a reload (e.g. a pill
      // removal / Clear-all cleared the selection, or the other popup's instance
      // changed it). setValues filters against loaded options; when nothing is
      // loaded yet the selection is empty at boot, so this is a safe no-op.
      handle.setValues(config.get(s));
    }
  }

  sync();
  return { sync };
}

/** "Played for" — single gender + team-type-scoped team picker (state.teams). */
export function mountTeam(container, store, onChange) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.teams || [],
    set: (st, arr) => st.set({ teams: arr }),
    loader: (gender, teamType) => searchTeams("", gender, teamType),
    emptyLabel: "All teams",
    singular: "team",
    plural: "teams",
    ariaLabel: "Played for team",
    searchPlaceholder: "Search teams…",
    showGames: true,
  });
}

/** "Event" — gender + team-type-scoped competition/series picker (state.event). */
export function mountEvent(container, store, onChange) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.event || [],
    set: (st, arr) => st.set({ event: arr }),
    loader: (gender, teamType) => searchEvents("", gender, teamType),
    emptyLabel: "Any event",
    singular: "event",
    plural: "events",
    ariaLabel: "Event",
    searchPlaceholder: "Search events…",
    showGames: true,
  });
}

/** "Venue" — gender + team-type-scoped ground picker (state.venue). */
export function mountVenue(container, store, onChange) {
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.venue || [],
    set: (st, arr) => st.set({ venue: arr }),
    loader: (gender, teamType) => searchVenues("", gender, teamType),
    emptyLabel: "Any venue",
    singular: "venue",
    plural: "venues",
    ariaLabel: "Venue",
    searchPlaceholder: "Search venues…",
    showGames: true,
  });
}

/**
 * "Against opposition" — team picker over state.opposition. The option list is
 * the EXACT SAME mechanism as the "Played for" Team picker (searchTeams, scoped
 * by gender + team type only, games-desc — R7 owner correction, item 5), so the
 * big cricketing nations lead. INTERNATIONAL-only (decision 20): the toggle
 * greys + shows the note off International, and oppositionFilterActive() keeps
 * the query/pill/subtitle honest regardless. No games meta (its historic plain
 * list). The `embedded` arg is accepted for call-site parity (the row's type
 * label already names it) but unused — the wrapper never renders its own label.
 */
export function mountOpposition(container, store, onChange, { embedded = false } = {}) {
  void embedded;
  return mountScopedMultiSelect(container, store, onChange, {
    get: (s) => s.opposition || [],
    set: (st, arr) => st.set({ opposition: arr }),
    loader: (gender, teamType) => searchTeams("", gender, teamType),
    emptyLabel: "Any opposition",
    singular: "opponent",
    plural: "opponents",
    ariaLabel: "Against opposition",
    searchPlaceholder: "Search teams…",
    showGames: false,
    disabledWhen: (s) => s.teamType !== "international",
    disabledNote: "International cricket only for now",
  });
}
