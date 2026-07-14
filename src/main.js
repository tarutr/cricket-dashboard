// src/main.js
//
// Boot sequence for Compare Stats: initDB with a loading state, error state
// with Retry (never a blank page), then wire up state/filters/advanced/table
// and do the initial render.

import { initDB, getManifest } from "./db.js";
import { createStore, createInitialState, defaultColumnsFor, pruneIneligibleState, splitAllowed } from "./state.js";
import { mountFilters } from "./filters.js";
import { mountFilterDrawer } from "./drawer.js";
import { mountPills } from "./pills.js";
import { mountTable } from "./table.js";
import { mountOmnisearch } from "./omnisearch.js";
import { mountPlayerPopup } from "./playerPopup.js";
import { getMetric } from "./metrics.js";
import { mountGraph } from "./graph/graph.js";
import { showToast } from "./toast.js";

const DEFAULT_SORT_KEY = { batting: "runs", bowling: "wickets" };

const initStatusEl = document.getElementById("init-status");
const appContentEl = document.getElementById("app-content");
const scopeSentenceEl = document.getElementById("scope-sentence");
const footerDataDateEl = document.getElementById("footer-data-date");
// Discipline is now a compact <select> rendered by filters.js inside the Filters
// popup (ROUND 3 task 1) — no static toggle element, no click wiring here. Its
// change (default columns + sort-key fallback) is handled via the
// onDisciplineChanged callback passed to mountFilters below.
const viewToggleEl = document.querySelector('[data-role="view"]');
const filterBarEl = document.getElementById("filter-bar");
// F2: #pills-bar and #player-search-section are gone — pills and the table
// search box now live INSIDE #table-area's own results toolbar (built by
// table.js's ensureSkeleton()), so there's no static host element for either
// any more. See mountTableToolbarExtras() below, wired via mountTable's
// onSkeletonReady.
const headerSearchInputEl = document.getElementById("header-search-input");
const headerSearchResultsEl = document.getElementById("header-search-results");
const tableAreaEl = document.getElementById("table-area");
const playerPopupHostEl = document.getElementById("player-popup-host");
const graphAreaEl = document.getElementById("graph-area");

function describeProgress(progress) {
  switch (progress.stage) {
    case "manifest":
      return "Loading the database…";
    case "loading-duckdb":
    // db.js's loadDuckDB() reports fine-grained "instantiate" ticks while the
    // WASM module itself downloads — same step from the user's point of view.
    case "instantiate":
      return "Loading DuckDB-WASM…";
    case "connecting":
      return "Opening database connection…";
    // db.js's registerData() reports "register" once before its per-file
    // fetches — same step as the "registering-data" stage doInit() reports
    // just before calling it.
    case "register":
    case "registering-data":
      return progress.file ? `Loading ${progress.file}…` : "Loading data…";
    case "ready":
      return "Finalizing…";
    default:
      return "Loading the database…";
  }
}

function renderInitLoading(progress) {
  initStatusEl.innerHTML = `<p class="init-status__line init-status__line--loading">${describeProgress(progress)}</p>`;
}

function renderInitError(err, retryFn) {
  appContentEl.hidden = true;
  initStatusEl.innerHTML = `
    <div class="error-box">
      <p>${(err && (err.userMessage || err.message)) || "Could not load the data. Please try again."}</p>
      <button type="button" class="btn btn--primary" data-role="init-retry">Retry</button>
    </div>
  `;
  const btn = initStatusEl.querySelector('[data-role="init-retry"]');
  if (btn) btn.addEventListener("click", retryFn);
}

let store;
let tableController;
let filterController;
let graphController;
let drawerController;
let pillsController;
let playerPopupController;
let filtersPopup = null; // { open, close, isOpen } — the Filters popup controller (F1a), assigned in boot()
let maxDate = null; // manifest max match date "YYYY-MM-DD" — reference for date presets + input max (1B-2)
let minDate = null; // manifest min match date "YYYY-MM-DD" — input min bound

/** Open the Filters popup (F1a). Exported for the table's empty-state prompt
 * button (via onOpenFilters) and F2's toolbar "Filters" button. No-op until
 * boot() wires the popup controller. */
export function openFiltersPopup() {
  if (filtersPopup) filtersPopup.open();
}

/** Reset everything (F1a step 5): wipe the table back to the initial "Open
 * filters" prompt, reset ALL scope/filter controls to createInitialState
 * defaults, and clear pinned players. F2 wires the red toolbar button here. */
export function clearAll() {
  if (!store) return;
  // Owner 1B-2: Clear returns to the initial state with the date UNSET (null) —
  // there is no default window; the user must pick one (or a preset) again.
  const fresh = createInitialState(null);
  store.set(fresh); // full replace — createInitialState returns every key
  lastAppliedDefaults.batting = [...fresh.columns.batting];
  lastAppliedDefaults.bowling = [...fresh.columns.bowling];
  // Re-render every control from the fresh defaults (the store.subscribe hook
  // refreshes pills/subtitle/badge; the controls need an explicit re-render).
  // filterController.render() re-syncs the Gender/Discipline selects.
  updateViewToggle();
  if (filterController) {
    filterController.render();
    filterController.setDateBounds(minDate, maxDate); // re-applies input bounds; inputs re-sync to the (now empty) date
  }
  if (drawerController) drawerController.sync();
  if (pillsController) pillsController.render();
  updateScopeSentence();
  updateDrawerBadge();
  // Empty the table back to the initial prompt, in the table view.
  showTableView();
  tableController.showPrompt();
}

// Tracks the columns array we last auto-applied as a "default preset" per
// discipline, so we can tell whether the user has since customized columns
// (in which case we must NOT clobber their choice) vs. still on the default
// (in which case we re-derive it, e.g. for the owner's Test/MDM SR->BPD swap).
const lastAppliedDefaults = { batting: null, bowling: null };

function columnsAreDefault(discipline) {
  const state = store.get();
  const applied = lastAppliedDefaults[discipline];
  if (!applied) return true; // never customized yet
  const current = state.columns[discipline];
  return applied.length === current.length && applied.every((k, i) => current[i] === k);
}

function reapplyDefaultColumnsIfUnmodified() {
  const state = store.get();
  const discipline = state.discipline;
  if (!columnsAreDefault(discipline)) return; // user customized — leave alone
  const next = defaultColumnsFor(discipline, state.formats);
  lastAppliedDefaults[discipline] = next;
  store.set({ columns: { ...state.columns, [discipline]: next } });
}

function updateScopeSentence() {
  scopeSentenceEl.textContent = store.describeScope();
}

/** Count badge on the toolbar's "Filters" button (F2 — repointed from the old
 * "All filters" button, which F1a removed) — how many drawer filters are
 * active. The badge only exists once the table's results toolbar has been
 * built (first Search, or the next one after Clear/an error rebuilds it);
 * the guard below is a harmless no-op the rest of the time, same as before. */
function updateDrawerBadge() {
  const countEl = tableAreaEl.querySelector('[data-role="toolbar-filters-count"]');
  if (!countEl || !drawerController) return;
  const n = drawerController.activeCount();
  countEl.hidden = n === 0;
  countEl.textContent = String(n);
}

function updateViewToggle() {
  const state = store.get();
  viewToggleEl.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.value === state.view);
  });
}

/** DOM visibility only, no controller side effects — factored out of
 * applyView() so the Batch 3 part 2 bridge callbacks (Stats→Graphs "Turn
 * into graph" / "Graph this player", Graphs→Stats "Back to your table") can
 * toggle the panels without necessarily invoking the SAME controller entry
 * point applyView() would (e.g. the bridge needs graphController's
 * enterFromBridge()/addPlayerFromOutside(), not a plain onShow()). */
function showGraphView() {
  tableAreaEl.hidden = true;
  graphAreaEl.hidden = false;
  updateViewToggle();
}
function showTableView() {
  graphAreaEl.hidden = true;
  tableAreaEl.hidden = false;
  updateViewToggle();
}

/** Show/hide the leaderboard vs graph panels for state.view (§6: same page, no iframe).
 * Player profiles are a POP-UP over either view (owner ruling at the R2 gate), not a view.
 * Returns the graph's onShow() promise (Promise.resolve() for the table branch) so bridge
 * callbacks can sequence work after the view has actually finished showing. */
function applyView() {
  const state = store.get();
  const view = state.view;
  if (view === "graph") {
    showGraphView();
    return graphController.onShow();
  }
  showTableView();
  // Decision 44d, extended by F2: a plain view switch must never wipe an
  // already-computed result set. enterView() restores the cached rows
  // instantly whenever any exist — even if the filters/scope have since
  // moved on unsearched — and only falls back to the blank prompt when
  // nothing has ever loaded (or Clear reset it). Under the F1a interaction
  // model a plain filter change no longer blanks the table at all
  // (onFiltersChanged just refreshes pills/subtitle); the table re-queries
  // only from the popup's "Search". This enterView() cache path just makes
  // bare tab switches / the graph's "Back to your table" bridge instant.
  tableController.enterView();
  return Promise.resolve();
}

/**
 * `requery` (task 3b, owner decision 46): pinning/unpinning a player is
 * explicitly NOT a plain filter change — the owner's ruling is "removing one
 * un-pins and re-queries" (and, symmetrically, adding one shows immediately,
 * same as the omnisearch "Filter the table" action already does). Every other
 * caller of this function is a plain filter change and keeps the default: the
 * table PERSISTS as-is (F1a — no more revert-to-blank-prompt), re-querying only
 * on the popup's "Search". Returns the table branch's promise
 * (tableController.load() or a resolved null) so a pin-add can chain off its
 * resolved {rowCount, missingPinnedIds} to detect a pin with no innings in scope.
 */
function onFiltersChanged({ requery = false } = {}) {
  // Drop columns/conditions orphaned by the new scope BEFORE anything renders,
  // so the drawer, badge, pills, and query all agree (§8.4 honesty).
  pruneIneligibleState(store);
  // A row grouping the new scope disallows (position/dismissal grouping in the
  // bowling view; opposition grouping outside international) resets to None —
  // never a ghost mode the controls can't show honestly.
  const s = store.get();
  if (s.splitBy && !splitAllowed(s, s.splitBy)) {
    store.set({ splitBy: null });
  }
  // Sync the popup's filter content only while the popup is VISIBLE (Batch 3
  // fix 2): syncing hidden content is wasted work, and syncing while open used
  // to rebuild the advanced panel's innerHTML on each keystroke, killing focus.
  // onShow() syncs directly on open.
  if (drawerController && filtersPopup && filtersPopup.isOpen()) drawerController.sync();
  if (pillsController) pillsController.render();
  updateScopeSentence();
  updateDrawerBadge();
  // NEW INTERACTION MODEL (F1a): touching a control NEVER blanks the table — in
  // table view the table persists as-is. The query re-runs ONLY via the popup's
  // "Search" (runSearch), the pin add/remove `requery` path below, and toolbar
  // presentation controls (which bypass this function). Graph view still
  // follows scope changes live.
  if (store.get().view === "graph") {
    graphController.onScopeChanged();
    return Promise.resolve(null);
  }
  if (requery) return tableController.load();
  return Promise.resolve(null);
}

/**
 * The omnisearch dropdown's explicit "Filter the table to names matching…"
 * row (B2R wave 2, decision 44): the ONE place typing in the search box still
 * reaches the leaderboard, and only when the user deliberately picks this
 * row/hits Enter with nothing highlighted — never as a side effect of typing.
 * Sets the search text, refreshes pills/subtitle via onFiltersChanged (which
 * no longer blanks the table — F1a), then explicitly runs the query with
 * tableController.load(), the same query trigger the popup's "Search" button
 * uses. This "Filter the table" row is a deliberate search action, so — unlike
 * a plain filter change — it DOES re-query. The search box only shows while the
 * table view is visible, so the view guard here just matches that.
 *
 * `matches` (B2R wave 3, decision 44c): the omnisearch dropdown's own
 * already-fetched player rows for this exact search text (see
 * omnisearch.js's choose()) — a gender/filter-agnostic name-history lookup
 * across the WHOLE database, independent of the leaderboard's current scope.
 * If the table query that follows comes back with zero rows despite `matches`
 * being non-empty, that's an honest, nameable case: the player(s) are real,
 * they're just excluded by the current filters (date range, format, team,
 * min-innings-adjacent conditions, etc.) — a plain empty table doesn't say
 * that on its own, so a toast does. This is the ONE toast this app shows;
 * every other empty-table case (no player anywhere matches the text either)
 * stays silent, same as before.
 */
function triggerTableSearch(text, matches) {
  store.set({ search: text });
  onFiltersChanged();
  if (store.get().view === "table") {
    tableController.load().then((result) => {
      const rowCount = result ? result.rowCount : null;
      if (rowCount === 0 && matches && matches.length > 0) {
        // Judgment call: a single unambiguous match names the player; more
        // than one (a common surname etc.) falls back to the search text
        // rather than guessing which of several real players the user meant.
        const message =
          matches.length === 1
            ? `No table rows match — ${matches[0].name}'s stats may be excluded by your current filters.`
            : `No table rows match — players matching "${text}" may be excluded by your current filters.`;
        showToast(message);
      }
    });
  }
}

/**
 * Pin a player from the table-search dropdown (task 3b, owner decision 46):
 * unlike triggerTableSearch's "Filter the table" action (which narrows the
 * result set to name matches), picking a SUGGESTED PLAYER row here instead
 * ADDS them to the current result set regardless of the other leaderboard
 * filters — a removable "+ name" pill (pills.js), backed by
 * state.pinnedPlayers and an additive WHERE/HAVING OR in table.js's
 * buildQuery. Their core scope (gender/format/date window/team type) still
 * applies — only the OTHER, leaderboard-only filters (team/opposition/
 * position/profile/R. Pos./search/stat conditions) are bypassed for their
 * row alone. Plain mode only (see pills.js/table.js) — matchup mode leaves
 * the pin inert rather than touching buildMatchupQuery.
 *
 * If the player genuinely has no innings even in the CORE scope, no bypass
 * could have produced a row for them either — load()'s missingPinnedIds
 * return value tells us that, and per the owner's ruling the optimistic pin
 * is rolled all the way back (no pill at all, not even a greyed one) with
 * the one toast this app shows for an honest "real player, wrong scope" case
 * (mirrors triggerTableSearch's own toast above).
 */
function pinPlayer(id, name) {
  const state = store.get();
  if ((state.pinnedPlayers || []).some((p) => p.id === id)) return; // already pinned
  store.set({ pinnedPlayers: [...(state.pinnedPlayers || []), { id, name }] });
  onFiltersChanged({ requery: true }).then((result) => {
    const missing = result && result.missingPinnedIds ? result.missingPinnedIds : [];
    if (missing.includes(id)) {
      store.set({ pinnedPlayers: (store.get().pinnedPlayers || []).filter((p) => p.id !== id) });
      if (pillsController) pillsController.render();
      showToast(`${name} has no innings in this scope.`);
    }
  });
}

/**
 * The HEADER search's own "Filter the table to names matching…" fallback
 * (task 3a): the header box is visible on both Stats/Graphs, so choosing
 * this row first switches to the Stats tab (the leaderboard it's about to
 * filter) before running the exact same triggerTableSearch flow the
 * table-search box's own fallback row uses.
 */
function triggerHeaderFilterTable(text, matches) {
  if (store.get().view !== "table") {
    store.set({ view: "table" });
    applyView();
  }
  triggerTableSearch(text, matches);
}

/**
 * F2: (re-)wire the pills row and the compact table-search box onto the
 * table's own results toolbar, called by mountTable's onSkeletonReady every
 * time table.js actually (re)builds that toolbar — the first Search of a
 * session, and again after Clear or a query error tears the previous one
 * down and a later Search rebuilds it fresh. Both mountPills and
 * mountOmnisearch attach their own listeners directly to the nodes they're
 * handed, so calling them again on new nodes each time is exactly as safe as
 * the very first mount (no teardown step needed — the old, now-detached
 * nodes and their listeners are simply left behind for GC).
 */
function mountTableToolbarExtras({ searchInputEl, searchResultsEl, pillsHostEl }) {
  pillsController = mountPills(
    pillsHostEl,
    store,
    () => {
      onFiltersChanged();
    },
    () => {
      // Pin pills only (task 3b): "removing one un-pins and re-queries", not
      // the standard persist-the-table filter-change path.
      onFiltersChanged({ requery: true });
    }
  );
  pillsController.render();

  // Table search (task 3b): Stats-view-only box, now inside the toolbar.
  // Picking a player row PINS them into the result set (pinPlayer) instead of
  // opening the popup — the popup is reachable via the header search or by
  // clicking the player's own row once it's showing. The trailing "Filter
  // the table to names matching…" fallback row is UNCHANGED.
  mountOmnisearch(searchInputEl, searchResultsEl, {
    onOpenPlayer: (id, name) => pinPlayer(id, name),
    onFilterTable: (text, matches) => triggerTableSearch(text, matches),
  });
}

function boot() {
  renderInitLoading({ stage: "manifest" });
  initDB((progress) => renderInitLoading(progress))
    .then(() => {
      const manifest = getManifest();
      maxDate = manifest?.data?.max_match_date || null;
      minDate = manifest?.data?.min_match_date || null;

      // Owner 1B-2: the date filter starts UNSET (no default window) and is
      // REQUIRED before Search — so seed the store with null dates rather than
      // createInitialState's legacy 36-month default.
      store = createStore(createInitialState(null));
      const initial = store.get();
      lastAppliedDefaults.batting = [...initial.columns.batting];
      lastAppliedDefaults.bowling = [...initial.columns.bowling];

      initStatusEl.innerHTML = "";
      appContentEl.hidden = false;

      if (manifest?.generated_at) {
        const d = new Date(manifest.generated_at);
        footerDataDateEl.textContent = `Data as of ${d.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}`;
      }

      filterController = mountFilters(
        filterBarEl,
        store,
        () => {
          onFiltersChanged();
        },
        () => {
          reapplyDefaultColumnsIfUnmodified();
        },
        // onDisciplineChanged (ROUND 3 task 1): the Discipline <select> already
        // set state.discipline; re-apply the owner's Test/MDM default-column
        // swap (when columns are still default) and fall back the sort key if it
        // no longer resolves in the new discipline (e.g. "runs" → bowling). This
        // is exactly what the old segmented-toggle click handler used to do;
        // filters.js then calls onChange() → onFiltersChanged().
        () => {
          const state = store.get();
          reapplyDefaultColumnsIfUnmodified();
          if (!getMetric(state.sort.key, state.discipline)) {
            store.set({ sort: { key: DEFAULT_SORT_KEY[state.discipline], dir: "desc" } });
          }
        }
      );
      filterController.setDateBounds(minDate, maxDate);

      // Filters content: the ONE grouped condition builder (owner 1B-2) mounts
      // into the Advanced Filters section host. onChange refreshes pills/subtitle
      // (never blanks the table); the popup's "Search" button is the one query
      // trigger.
      drawerController = mountFilterDrawer(
        { advancedHost: document.getElementById("popup-advanced-host") },
        store,
        {
          onChange: () => {
            onFiltersChanged();
          },
        }
      );

      // ── Filters popup shell wiring (F1a) ─────────────────────────────────
      // main.js owns show/hide, ×, backdrop, Escape, the collapsible section
      // toggles, and the single "Search" query trigger. Closing NEVER queries.
      const filtersPopupEl = document.getElementById("filters-popup");
      const fpopPanelEl = filtersPopupEl.querySelector('[data-role="fpop-panel"]');
      const fpopBackdropEl = filtersPopupEl.querySelector('[data-role="fpop-backdrop"]');
      const fpopCloseEl = filtersPopupEl.querySelector('[data-role="fpop-close"]');
      const fpopSearchEl = filtersPopupEl.querySelector('[data-role="fpop-search"]');

      function fpopSetSection(bodyId, expanded) {
        const body = document.getElementById(bodyId);
        const toggle = filtersPopupEl.querySelector(
          `[data-role="fpop-section-toggle"][aria-controls="${bodyId}"]`
        );
        if (body) body.hidden = !expanded;
        if (toggle) toggle.setAttribute("aria-expanded", String(expanded));
      }
      filtersPopupEl.querySelectorAll('[data-role="fpop-section-toggle"]').forEach((toggle) => {
        toggle.addEventListener("click", () => {
          const bodyId = toggle.getAttribute("aria-controls");
          const expanded = toggle.getAttribute("aria-expanded") === "true";
          fpopSetSection(bodyId, !expanded);
        });
      });

      function openPopup() {
        filtersPopupEl.hidden = false;
        drawerController.onShow(); // re-derive team mode, snapshot advanced, refresh option lists
        fpopPanelEl.focus();
      }
      function closePopup() {
        // Closing NEVER runs a query (owner interaction model). onHide() only
        // re-syncs pills/subtitle for any mid-typed advanced condition.
        filtersPopupEl.hidden = true;
        drawerController.onHide();
      }
      function runSearch() {
        // The ONE query trigger from the popup. Date is REQUIRED (owner 1B-2):
        // block first and surface the inline message in Search Conditions if it
        // isn't set; then validate the advanced numeric conditions. Only when
        // both pass do we close and (in table view) load. Graphs already follow
        // scope changes live via onFiltersChanged → onScopeChanged.
        if (!filterController.validateDate()) {
          fpopSetSection("fpop-body-conditions", true); // expand + show the date-required note
          return;
        }
        if (!drawerController.validate()) {
          fpopSetSection("fpop-body-advanced", true); // surface the inline error
          return;
        }
        closePopup();
        if (store.get().view === "table") tableController.load();
      }

      filtersPopup = { open: openPopup, close: closePopup, isOpen: () => !filtersPopupEl.hidden };

      fpopCloseEl.addEventListener("click", closePopup);
      fpopBackdropEl.addEventListener("click", closePopup);
      fpopSearchEl.addEventListener("click", runSearch);
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && filtersPopup.isOpen()) closePopup();
      });

      // F2: pills now mount INSIDE the table's own results toolbar (a fresh
      // host every time table.js's skeleton is (re)built), not here at boot —
      // see mountTableToolbarExtras() below, wired via mountTable's
      // onSkeletonReady. pillsController stays null until the first Search;
      // every other use of it in this file already guards with
      // `if (pillsController)` for exactly that reason.

      // Presentation controls in the table toolbar (presets, Group rows, Vs)
      // set state and reload directly without onFiltersChanged — keep the
      // honest scope sentence, pills, and badge in step with EVERY state
      // change (e.g. entering matchup mode makes the position filter inert,
      // so its pill and badge count must drop immediately).
      store.subscribe(() => {
        updateScopeSentence();
        if (pillsController) pillsController.render();
        updateDrawerBadge();
        // The popup's filter content too: toolbar presentation controls (Vs,
        // Group rows, presets) bypass onFiltersChanged, but the position-chip
        // enablement and condition-builder vocabulary depend on the Vs
        // selection. sync() is scope-key-cached (option refetches no-op unless
        // scope moved), but is gated to the popup being VISIBLE (Batch 3 fix 2):
        // syncing hidden content is wasted work, and syncing while open used to
        // rebuild the advanced panel's innerHTML on each keystroke, destroying
        // the input being typed into. onShow() syncs directly on open.
        if (drawerController && filtersPopup && filtersPopup.isOpen()) drawerController.sync();
      });

      // Two omnisearch mounts (task 3, owner decision 46 search split) — same
      // component, different mount-site behaviour (see omnisearch.js's header
      // comment). This one closes over module-level `playerPopupController`,
      // not assigned until later in this same boot() call (same pattern
      // mountTable's onPlayerClick already uses below) — safe because the
      // callback only ever runs later, in response to user interaction after
      // boot() has finished.
      //
      // Header search (task 3a): visible on both Stats/Graphs (it lives in
      // the persistent app-header, never toggled hidden by
      // showTableView/showGraphView) — picking a player opens their popup,
      // exactly like the table-search box used to do everywhere before this
      // task split it in two.
      mountOmnisearch(headerSearchInputEl, headerSearchResultsEl, {
        onOpenPlayer: (id, name) => playerPopupController.open(id, name),
        onFilterTable: (text, matches) => triggerHeaderFilterTable(text, matches),
      });

      // Table search (task 3b) mounts inside mountTableToolbarExtras() below,
      // not here — F2 relocated its host INTO the table's own results
      // toolbar, which table.js's ensureSkeleton() only builds once a Search
      // actually runs (and rebuilds fresh after Clear/an error), so there's
      // no static element to mount onto at boot the way the header search
      // above still has.

      tableController = mountTable(tableAreaEl, store, {
        onPlayerClick: (id, name) => playerPopupController.open(id, name),
        // "Graph" toolbar button (decision 46f): navigates to Graphs exactly
        // like clicking the tab — graph.js's enterFromBridge() picks no chart
        // type and renders nothing by itself, EXCEPT when the table is in
        // matchup "Vs" mode, where it lands directly on Dumbbell (the one
        // chart type that understands matchup vocabulary) seeded from THIS
        // table's current sort column as the preferred metric.
        onTurnIntoGraph: () => {
          const sortKey = store.get().sort.key;
          store.set({ view: "graph" });
          showGraphView();
          graphController.enterFromBridge({ preferredMetricKey: sortKey });
        },
        // F1a: the empty-state prompt's "Open filters" button opens the Filters
        // popup (the query then runs from the popup's "Search").
        onOpenFilters: () => openFiltersPopup(),
        // F2: the toolbar's red "Clear" button — the same full reset as
        // everywhere else clearAll() is wired.
        onClear: () => clearAll(),
        // F2: table.js's persistent toolbar (Filters button/search box/pills
        // host) only exists once its skeleton is built — the first Search of
        // a session, and again after Clear or a query error tears the
        // previous one down and a later Search rebuilds it. This fires every
        // time that happens so the pills row and the relocated table-search
        // box get (re-)wired onto the fresh nodes.
        onSkeletonReady: (nodes) => mountTableToolbarExtras(nodes),
      });
      playerPopupController = mountPlayerPopup(playerPopupHostEl, store, {
        // "Graph this player" (task 4, decision 43): close the popup first
        // (playerPopup.js's wrapper does this before calling us), then show
        // Graphs and add just this one player to whatever roster already
        // exists there (onShow() first, in case Graphs has never been shown
        // this session and needs its initial seed).
        onGraphPlayer: (id, name) => {
          store.set({ view: "graph" });
          applyView().then(() => graphController.addPlayerFromOutside(id, name));
        },
      });
      graphController = mountGraph(graphAreaEl, store, {
        // Decision 46f: whether the Stats tab has ever been searched — gates
        // Graphs' own empty-state vs. seeding its player pool from the
        // current filtered set (see graph.js's onShow()/seedSelection()).
        hasStatsResults: () => tableController.hasResults(),
      });

      viewToggleEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".segmented__btn");
        if (!btn) return;
        const view = btn.dataset.value;
        if (view === store.get().view) return;
        store.set({ view });
        applyView();
      });

      updateScopeSentence();
      updateDrawerBadge();
      updateViewToggle();
      // Owner: blank on first load — show the prompt, don't auto-run the query.
      tableController.showPrompt();
    })
    .catch((err) => {
      renderInitError(err, boot);
    });
}

boot();
