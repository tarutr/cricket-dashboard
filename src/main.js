// src/main.js
//
// Boot sequence for Compare Stats: initDB with a loading state, error state
// with Retry (never a blank page), then wire up state/filters/advanced/table
// and do the initial render.

import { initDB, getManifest } from "./db.js";
import { createStore, createInitialState, defaultColumnsFor, pruneIneligibleState, splitAllowed } from "./state.js";
import { mountFilters } from "./filters.js";
import { mountSplitControls } from "./splitControls.js";
import { mountAdvanced, activeConditionCount } from "./advanced.js";
import { mountTable } from "./table.js";
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
const splitsBarEl = document.getElementById("splits-bar");
const advancedToggleEl = document.getElementById("advanced-toggle");
const advancedCountEl = document.getElementById("advanced-count");
const advancedPanelEl = document.getElementById("advanced-panel");
const playerSearchSectionEl = document.getElementById("player-search-section");
const playerSearchInputEl = document.getElementById("player-search-input");
const tableAreaEl = document.getElementById("table-area");
const graphAreaEl = document.getElementById("graph-area");

function describeProgress(progress) {
  switch (progress.stage) {
    case "manifest":
      return "Fetching manifest…";
    case "loading-duckdb":
      return "Loading DuckDB-WASM…";
    case "connecting":
      return "Opening database connection…";
    case "registering-data":
      return progress.file ? `Loading ${progress.file}…` : "Loading data…";
    case "ready":
      return "Finalizing…";
    default:
      return "Working…";
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
let advancedController;
let filterController;
let graphController;
let splitControlsController;

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

function updateAdvancedCount() {
  const state = store.get();
  const n = activeConditionCount(state.advanced);
  advancedCountEl.hidden = n === 0;
  advancedCountEl.textContent = String(n);
}

function updateViewToggle() {
  const state = store.get();
  viewToggleEl.querySelectorAll(".segmented__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.value === state.view);
  });
}

/** Show/hide the table vs graph panels for the current state.view (§6: same page, no iframe). */
function applyView() {
  const state = store.get();
  const graph = state.view === "graph";
  tableAreaEl.hidden = graph;
  playerSearchSectionEl.hidden = graph;
  graphAreaEl.hidden = !graph;
  updateViewToggle();
  if (graph) {
    graphController.onShow();
  } else {
    // Owner: no automated search — entering the table view shows the blank
    // prompt; the query runs only when "Show results" is clicked.
    tableController.showPrompt();
  }
}

function onFiltersChanged() {
  // Drop columns/conditions orphaned by the new scope BEFORE anything renders,
  // so the advanced panel, count badge, and query all agree (§8.4 honesty).
  pruneIneligibleState(store);
  // A split that the new scope disallows (position/dismissal splits in the
  // bowling view; opposition split outside international) resets to None —
  // never a ghost mode the controls can't show honestly.
  const s = store.get();
  if (s.splitBy && !splitAllowed(s, s.splitBy)) {
    store.set({ splitBy: null });
  }
  if (splitControlsController) splitControlsController.sync();
  updateScopeSentence();
  updateAdvancedCount();
  // Re-render the advanced panel too: its metric dropdown must reflect the
  // current format scope (§8.9 phase-metric gating) whenever formats change.
  if (advancedController) advancedController.render();
  // Only the visible view re-queries; the other refreshes when switched to.
  // Table view: filter changes revert to the blank prompt (no automated search);
  // the user clicks "Show results" to run the query for the new scope.
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
      filterController.refreshTeamOptions();

      splitControlsController = mountSplitControls(splitsBarEl, store, () => {
        onFiltersChanged();
      });

      advancedController = mountAdvanced(advancedPanelEl, store, () => {
        onFiltersChanged();
      });

      advancedToggleEl.addEventListener("click", () => {
        const isOpen = !advancedPanelEl.hidden;
        advancedPanelEl.hidden = isOpen;
        advancedToggleEl.setAttribute("aria-expanded", String(!isOpen));
      });

      playerSearchInputEl.addEventListener("input", () => {
        store.set({ search: playerSearchInputEl.value });
        onFiltersChanged();
      });

      tableController = mountTable(tableAreaEl, store);
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
      updateAdvancedCount();
      updateViewToggle();
      // Owner: blank on first load — show the prompt, don't auto-run the query.
      tableController.showPrompt();
    })
    .catch((err) => {
      renderInitError(err, boot);
    });
}

boot();
