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
import { mountPlayerPopup } from "./playerPopup.js";
import { getMetric } from "./metrics.js";
import { mountGraph } from "./graph/graph.js";

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

/** Show/hide the leaderboard vs graph panels for state.view (§6: same page, no iframe).
 * Player profiles are a POP-UP over either view (owner ruling at the R2 gate), not a view. */
function applyView() {
  const state = store.get();
  const view = state.view;
  tableAreaEl.hidden = view !== "table";
  playerSearchSectionEl.hidden = view !== "table";
  graphAreaEl.hidden = view !== "graph";
  updateViewToggle();
  if (view === "graph") {
    graphController.onShow();
  } else {
    // Owner: no automated search — entering the table view shows the blank
    // prompt; the query runs only when "Show results" is clicked.
    tableController.showPrompt();
  }
}

function onFiltersChanged() {
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
  // the query runs on "Show results" / the drawer's "Apply and show results".
  // (The player popup blocks the filters while open; it refetches on reopen if
  // the scope moved, via its own cache key.)
  if (store.get().view === "graph") {
    graphController.onScopeChanged();
  } else {
    tableController.showPrompt();
  }
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

      pillsController = mountPills(pillsBarEl, store, () => {
        onFiltersChanged();
      });
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
        // store.set() fires this subscriber, including every keystroke in the
        // main player-search box (unrelated to the drawer) and every keystroke
        // in the advanced panel's own value inputs, so syncing a HIDDEN drawer
        // here was pure wasted work — and syncing while the drawer IS open
        // used to rebuild the advanced panel's innerHTML on every keystroke,
        // destroying the input the user was typing into. open() calls sync()
        // directly, so the drawer is still always current the moment it's
        // shown.
        if (drawerController && drawerController.isOpen()) drawerController.sync();
      });

      playerSearchInputEl.addEventListener("input", () => {
        store.set({ search: playerSearchInputEl.value });
        onFiltersChanged();
      });

      tableController = mountTable(tableAreaEl, store, {
        onPlayerClick: (id, name) => playerPopupController.open(id, name),
      });
      playerPopupController = mountPlayerPopup(playerPopupHostEl, store);
      graphController = mountGraph(graphAreaEl, store);

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
