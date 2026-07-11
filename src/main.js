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
const disciplineToggleEl = document.querySelector('[data-role="discipline"]');
const viewToggleEl = document.querySelector('[data-role="view"]');
const filterBarEl = document.getElementById("filter-bar");
const pillsBarEl = document.getElementById("pills-bar");
const drawerHostEl = document.getElementById("filter-drawer-host");
const playerSearchSectionEl = document.getElementById("player-search-section");
const playerSearchInputEl = document.getElementById("player-search-input");
const playerSearchResultsEl = document.getElementById("player-search-results");
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

function updateDisciplineToggle() {
  const state = store.get();
  disciplineToggleEl.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.value === state.discipline);
  });
}

/** Count badge on the "All filters" button — how many drawer filters are active. */
function updateDrawerBadge() {
  const countEl = filterBarEl.querySelector('[data-role="open-drawer-count"]');
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
  playerSearchSectionEl.hidden = true;
  graphAreaEl.hidden = false;
  updateViewToggle();
}
function showTableView() {
  graphAreaEl.hidden = true;
  tableAreaEl.hidden = false;
  playerSearchSectionEl.hidden = false;
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
  // Decision 44d: a plain view switch must never wipe an already-computed
  // result set. enterView() restores the cached rows instantly if the
  // filters/scope haven't moved on since that query, and falls back to the
  // blank prompt (today's behavior) otherwise. Filter CHANGES still revert to
  // the blank prompt immediately via onFiltersChanged() (see below), which
  // calls tableController.showPrompt() directly whenever the table view is
  // active — the no-automated-search rule is unchanged; only bare tab
  // switches / the graph's "Back to your table" bridge benefit here.
  tableController.enterView();
  return Promise.resolve();
}

/**
 * `requery` (task 3b, owner decision 46): pinning/unpinning a player is
 * explicitly NOT a "no automated search" filter change — the owner's ruling
 * is "removing one un-pins and re-queries" (and, symmetrically, adding one
 * shows immediately, same as the omnisearch "Filter the table" action
 * already does). Every other caller of this function is a genuine filter
 * change and keeps the default (revert to the blank prompt / wait for
 * "Show results"). Returns the table branch's promise (tableController.load()
 * or a resolved null) so a pin-add can chain off its resolved
 * {rowCount, missingPinnedIds} to detect a pin with no innings in scope.
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
  // Only sync the drawer while it's actually visible (Batch 3 fix 2) — syncing
  // a hidden drawer is wasted work, and (before this fix) was the path by
  // which typing in the advanced panel's value inputs or the main search box
  // triggered a full advanced-panel innerHTML rebuild on every keystroke via
  // the store.subscribe hook below, killing focus/cursor. open() still calls
  // sync() directly, so the drawer is always current the moment it's shown.
  if (drawerController && drawerController.isOpen()) drawerController.sync();
  if (pillsController) pillsController.render();
  updateScopeSentence();
  updateDrawerBadge();
  // Only the visible view re-queries; the other refreshes when switched to.
  // Table view: filter changes revert to the blank prompt (no automated search);
  // the query runs on "Show results" / the drawer's "Apply and show results" —
  // UNLESS `requery` says otherwise (pin add/remove only, see above).
  // (The player popup blocks the filters while open; it refetches on reopen if
  // the scope moved, via its own cache key.)
  if (store.get().view === "graph") {
    graphController.onScopeChanged();
    return Promise.resolve(null);
  }
  if (requery) return tableController.load();
  tableController.showPrompt();
  return Promise.resolve(null);
}

/**
 * The omnisearch dropdown's explicit "Filter the table to names matching…"
 * row (B2R wave 2, decision 44): the ONE place typing in the search box still
 * reaches the leaderboard, and only when the user deliberately picks this
 * row/hits Enter with nothing highlighted — never as a side effect of typing.
 * Mirrors exactly what used to happen on every keystroke (store.set the
 * search text, then run onFiltersChanged's honest revert-to-prompt) followed
 * by the same "Show results" trigger the prompt's button and the drawer's
 * Apply both use — tableController.load(). The search box only shows while
 * the table view is visible, so the view guard here just matches the
 * drawer's onApply for consistency.
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

function boot() {
  renderInitLoading({ stage: "manifest" });
  initDB((progress) => renderInitLoading(progress))
    .then(() => {
      const manifest = getManifest();
      const maxMonth = manifest?.data?.max_match_date ? manifest.data.max_match_date.slice(0, 7) : null;
      const minMonth = manifest?.data?.min_match_date ? manifest.data.min_match_date.slice(0, 7) : null;

      store = createStore(createInitialState(maxMonth));
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

      updateDisciplineToggle();

      disciplineToggleEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".segmented__btn");
        if (!btn) return;
        const discipline = btn.dataset.value;
        const state = store.get();
        if (discipline === state.discipline) return;
        // Re-apply the owner's Test/MDM default-column swap whenever discipline
        // changes, in case the user hasn't customized columns yet.
        store.set({ discipline });
        reapplyDefaultColumnsIfUnmodified();
        // If the current sort key doesn't exist for the new discipline (e.g.
        // "runs" when switching to bowling), fall back to that discipline's
        // default sort (runs/batting, wickets/bowling, both desc).
        if (!getMetric(state.sort.key, discipline)) {
          store.set({ sort: { key: DEFAULT_SORT_KEY[discipline], dir: "desc" } });
        }
        updateDisciplineToggle();
        onFiltersChanged();
      });

      filterController = mountFilters(
        filterBarEl,
        store,
        () => {
          onFiltersChanged();
        },
        () => {
          reapplyDefaultColumnsIfUnmodified();
        }
      );
      filterController.setDateBounds(minMonth, maxMonth);

      drawerController = mountFilterDrawer(drawerHostEl, store, {
        onChange: () => {
          onFiltersChanged();
        },
        onApply: () => {
          drawerController.close();
          // Apply = the one query trigger (no automated search, decision 25).
          // The graph already follows scope changes live via onFiltersChanged.
          if (store.get().view === "table") tableController.load();
        },
      });
      drawerController.sync();

      pillsController = mountPills(
        pillsBarEl,
        store,
        () => {
          onFiltersChanged();
        },
        () => {
          // Pin pills only (task 3b): "removing one un-pins and re-queries",
          // not the standard revert-to-blank-prompt filter-change path.
          onFiltersChanged({ requery: true });
        }
      );
      pillsController.render();

      const openDrawerBtn = filterBarEl.querySelector('[data-role="open-drawer"]');
      if (openDrawerBtn) openDrawerBtn.addEventListener("click", () => drawerController.open());

      // Presentation controls in the table toolbar (presets, Group rows, Vs)
      // set state and reload directly without onFiltersChanged — keep the
      // honest scope sentence, pills, and badge in step with EVERY state
      // change (e.g. entering matchup mode makes the position filter inert,
      // so its pill and badge count must drop immediately).
      store.subscribe(() => {
        updateScopeSentence();
        if (pillsController) pillsController.render();
        updateDrawerBadge();
        // The drawer too: toolbar presentation controls (Vs, Group rows,
        // presets) bypass onFiltersChanged, but since D4-R4 the drawer's
        // position-chip enablement and the condition builder's metric
        // vocabulary DEPEND on the Vs selection. drawer.sync() is cheap and
        // scope-key-cached internally, so calling it on every state change is
        // safe (its option-list refetches no-op unless the scope moved) — but
        // ONLY while the drawer is actually visible (Batch 3 fix 2): every
        // store.set() fires this subscriber, including every keystroke in
        // the advanced panel's own value inputs (the main player-search box
        // no longer store.sets on keystroke at all since B2R wave 2 — typing
        // there only drives the omnisearch dropdown; store.search only
        // changes on its explicit "Filter the table" action), so syncing a
        // HIDDEN drawer
        // here was pure wasted work — and syncing while the drawer IS open
        // used to rebuild the advanced panel's innerHTML on every keystroke,
        // destroying the input the user was typing into. open() calls sync()
        // directly, so the drawer is still always current the moment it's
        // shown.
        if (drawerController && drawerController.isOpen()) drawerController.sync();
      });

      // Two omnisearch mounts (task 3, owner decision 46 search split) — same
      // component, different mount-site behaviour (see omnisearch.js's header
      // comment). Both close over module-level `playerPopupController`/
      // `tableController`/`pillsController`, which aren't assigned until
      // later in this same boot() call (same pattern mountTable's
      // onPlayerClick already uses below) — safe because these callbacks
      // only ever run later, in response to user interaction after boot()
      // has finished.
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

      // Table search (task 3b): Stats-view-only box above the table. Picking
      // a player row now PINS them into the result set (pinPlayer) instead of
      // opening the popup — the popup is reachable via the header search or
      // by clicking the player's own row once it's showing. The trailing
      // "Filter the table to names matching…" fallback row is UNCHANGED.
      mountOmnisearch(playerSearchInputEl, playerSearchResultsEl, {
        onOpenPlayer: (id, name) => pinPlayer(id, name),
        onFilterTable: (text, matches) => triggerTableSearch(text, matches),
      });

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
