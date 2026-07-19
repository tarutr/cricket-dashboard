// src/main.js
//
// Boot sequence for Compare Stats: initDB with a loading state, error state
// with Retry (never a blank page), then wire up state/filters/advanced/table
// and do the initial render.

import { initDB, getManifest } from "./db.js";
import { createStore, createInitialState, defaultColumnsFor, pruneIneligibleState } from "./state.js";
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

// No-data pin feedback (4d/A6): ids (as strings) of currently-pinned players
// with zero rows in the LAST completed load() — table.js's `missingPinnedIds`,
// recomputed fresh on every load (plain and matchup mode alike). Read by
// pills.js (via getNoInningsIds passed to mountPills) to annotate that pin's
// pill "(no innings)". Display-only bookkeeping — never read by any query.
let noInningsPinIds = new Set();

// R7 Wave B (item 4): the APPLIED filter state — a snapshot of the store as of
// the last query the table actually reflects (Search, or an immediate-apply
// action while the popup is closed: toolbar Vs/presets, pin add/remove, pill
// removal, omnisearch "filter the table"). The pills row and the Filters-button
// badge — both rendered inside the table area since F2 — render from THIS, not
// the live store, so editing a condition inside the Filters popup updates only
// the pending store and never moves the table area before Search. Advanced by
// runSearch() and by the store.subscribe hook while the popup is closed.
let appliedState = null;

const DATA_DATE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deep snapshot of the store for `appliedState` (item 4). Plain JSON clone —
 * the state is fully JSON-serializable, and a deep copy is required because
 * drawer.js mutates advanced-condition objects in place before store.set, so a
 * shallow copy would still see those pending edits. */
function snapshotAppliedState() {
  return JSON.parse(JSON.stringify(store.get()));
}

/** Format a "YYYY-MM-DD" data date as "13 Jul 2026" (item 3 — the footer's
 * "Data as of" date). Parsed by parts, not `new Date(str)`, to avoid the
 * UTC-midnight-in-a-negative-timezone off-by-one-day drift. */
function formatDataDate(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return `${d} ${DATA_DATE_MONTHS[m - 1]} ${y}`;
}

/** Open the Filters popup (F1a). Exported for the table's empty-state prompt
 * button (via onOpenFilters) and F2's toolbar "Filters" button. No-op until
 * boot() wires the popup controller. */
export function openFiltersPopup() {
  if (filtersPopup) filtersPopup.open();
}

/** Reset everything (F1a step 5): wipe the table back to the initial "Open
 * filters" prompt, reset ALL scope/filter controls to createInitialState
 * defaults, and clear pinned players. F2 wires the red toolbar button here.
 *
 * `returnToTable` (R7 Wave 2, item 19): the graph's own "Clear filters" button
 * shares this ONE reset path (the shared store means the graph's filters ARE
 * the Stats filters) but passes `false` so the clear doesn't yank the user out
 * of the Graphs tab — the view is left where it was and the graph re-renders
 * its own empty state. The default (`true`, the Stats toolbar Clear) still
 * lands on the blank table prompt exactly as before. Either way the cached
 * table result is forgotten (showPrompt), so hasResults() honestly reports
 * "nothing loaded" after a Clear from either side. */
export function clearAll({ returnToTable = true } = {}) {
  if (!store) return;
  // Owner 1B-2: Clear returns to the initial state with the date UNSET (null) —
  // there is no default window; the user must pick one (or a preset) again.
  const fresh = createInitialState(null);
  // Item 19: a graph-side Clear keeps the current view (createInitialState
  // defaults view to "table"), so the user stays on Graphs.
  if (!returnToTable) fresh.view = store.get().view;
  store.set(fresh); // full replace — createInitialState returns every key
  lastAppliedDefaults.batting = [...fresh.columns.batting];
  lastAppliedDefaults.bowling = [...fresh.columns.bowling];
  // 4d/A6: a Clear wipes pinnedPlayers too — drop any stale no-innings flags
  // so a player re-pinned post-Clear never shows "(no innings)" left over
  // from the previous (now-discarded) scope before a fresh load() corrects it.
  noInningsPinIds = new Set();
  // Re-render every control from the fresh defaults (the store.subscribe hook
  // refreshes pills/badge; the controls need an explicit re-render).
  // filterController.render() re-syncs the Gender/Discipline selects.
  updateViewToggle();
  if (filterController) {
    filterController.render();
    filterController.setDateBounds(minDate, maxDate); // re-applies input bounds; inputs re-sync to the (now empty) date
  }
  if (drawerController) drawerController.sync();
  // R3.2: Clear resets the APPLIED baseline too (after setDateBounds fills the
  // default end date), so the toolbar's Search button returns to at-rest
  // (pending === applied) and the first-load gating re-applies.
  appliedState = snapshotAppliedState();
  // A4: a Clear discards any staged (soft-deleted) pill display too.
  if (pillsController) { pillsController.clearStaged(); pillsController.render(); }
  updateDrawerBadge();
  // Forget the cached result set and reset the table to its first-load empty
  // state (toolbar visible, empty body). Only switch back to the table view
  // when this was the Stats-side Clear.
  if (returnToTable) showTableView();
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
  // 4d/A5 "Keep Selected Columns" toggle: ON skips this resync entirely — the
  // columns currently showing (whatever they are) simply carry into the next
  // Search untouched, discipline/format change or not. OFF (default) is the
  // pre-existing behaviour below, gated only on the user not having already
  // customized this discipline's columns.
  if (state.keepColumns) return;
  const discipline = state.discipline;
  if (!columnsAreDefault(discipline)) return; // user customized — leave alone
  const next = defaultColumnsFor(discipline, state.formats);
  lastAppliedDefaults[discipline] = next;
  store.set({ columns: { ...state.columns, [discipline]: next } });
}

/** Count badge on the toolbar's "Filters" button (F2 — repointed from the old
 * "All filters" button, which F1a removed) — how many drawer filters are
 * active. The badge only exists once the table's results toolbar has been
 * built (first Search, or the next one after Clear/an error rebuilds it);
 * the guard below is a harmless no-op the rest of the time, same as before. */
function updateDrawerBadge() {
  const countEl = tableAreaEl.querySelector('[data-role="toolbar-filters-count"]');
  if (!countEl || !drawerController) return;
  // Count the APPLIED snapshot (item 4), so the badge tracks what's actually
  // narrowing the table — not pending popup edits — and agrees with the pills.
  const n = drawerController.activeCount(appliedState || store.get());
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
 * R3.2 ("everything waits for Search"): any filter/control change — popup
 * filters, pill ×, pins, player search — is a PENDING edit. This refreshes the
 * derived views (pills/badge from the frozen applied snapshot, the popup while
 * open) and lights the toolbar Search button dirty via syncToolbar(), but NEVER
 * re-queries the Stats table (only runSearch() does). Graph view still follows
 * scope live via onScopeChanged. Returns a resolved promise for legacy callers.
 */
function onFiltersChanged() {
  // Drop columns/conditions orphaned by the new scope BEFORE anything renders,
  // so the drawer, badge, pills, and query all agree (§8.4 honesty).
  pruneIneligibleState(store);
  // Sync the popup's filter content only while the popup is VISIBLE (Batch 3
  // fix 2): syncing hidden content is wasted work, and syncing while open used
  // to rebuild the advanced panel's innerHTML on each keystroke, killing focus.
  // onShow() syncs directly on open.
  if (drawerController && filtersPopup && filtersPopup.isOpen()) drawerController.sync();
  if (pillsController) pillsController.render();
  updateDrawerBadge();
  // R3.2 ("everything waits for Search"): touching ANY control NEVER moves the
  // Stats table — it's a frozen snapshot until the next Search commits pending
  // → applied. So there is no requery path here anymore; the table re-runs ONLY
  // via runSearch() (the popup's or the toolbar's Search button). syncToolbar()
  // keeps the toolbar controls + the Search dirty cue in step. Graph view still
  // follows scope changes live.
  if (tableController) tableController.syncToolbar();
  if (store.get().view === "graph") {
    graphController.onScopeChanged();
  }
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
  // R3.2 ("everything waits for Search"): the "Filter the table to names
  // matching…" action is PENDING now — it sets state.search (a "Name: X" pill
  // appears on the next Search) and lights the Search button dirty via
  // onFiltersChanged → syncToolbar. The old immediate requery + "excluded by
  // your filters" toast depended on running the query here; that feedback now
  // comes from the Search result itself. `matches` is accepted for signature
  // compatibility with the header-search path but no longer consulted.
  void matches;
  store.set({ search: text });
  onFiltersChanged();
}

/**
 * No-data pin feedback (4d/A6): given the `{ rowCount, missingPinnedIds }`
 * result of a completed tableController.load() (or applyPinnedPlayers()) —
 * both plain and matchup mode alike, see table.js's load() — recompute which
 * pinned players currently have zero rows and (a) refresh noInningsPinIds so
 * pills.js's next render annotates each one "(no innings)", and (b) toast
 * ONCE, naming only the ids that just BECAME missing (not ones already known
 * missing from an earlier Search) so an unrelated later Search/pin-add never
 * re-toasts about the same stale pin. `result` is null on a query error (the
 * error-state path in load()) or the no-op early-return in
 * applyPinnedPlayers() (nothing ever searched yet) — either way there is no
 * new information, so this is a no-op.
 */
function reportPinCoverage(result) {
  if (!result) return;
  const missingIds = (result.missingPinnedIds || []).map(String);
  const missingSet = new Set(missingIds);
  const newlyMissing = missingIds.filter((id) => !noInningsPinIds.has(id));
  noInningsPinIds = missingSet;
  if (pillsController) pillsController.render();
  if (newlyMissing.length === 0) return;
  const pins = store.get().pinnedPlayers || [];
  const names = newlyMissing
    .map((id) => pins.find((p) => String(p.id) === id)?.name)
    .filter(Boolean);
  if (names.length === 0) return;
  if (names.length === 1) {
    showToast(`${names[0]} has no innings in this scope`);
  } else {
    showToast(`${names.length} pinned players have no innings in this scope`);
  }
}

/**
 * R4 Wave 4a ADDENDUM (owner ruling 2026-07-17): *picking* a player from the
 * results search is INSTANT — unlike a FILTER pill (PENDING, waits for Search)
 * AND unlike a pill's ×/+ (also PENDING), picking drops the player's row into
 * the table right now and must NOT light the Search button. Called by
 * pinPlayer() below (the ONLY caller) AFTER it has added the player to
 * state.pinnedPlayers on the live store. Removing/restoring a pin via its
 * pill ×/+ is deliberately NOT routed here — that stays on the pending path
 * (onFiltersChanged), committing on the next Search, same as approved 4a.
 *
 * Advances appliedState.pinnedPlayers to match the live store — so the
 * dirty comparison (serializeQueryState, which still includes pinnedPlayers)
 * reads no change and the Search button stays settled — then asks
 * table.js's applyPinnedPlayers() to requery its OWN frozen applied scope
 * with the new pin list. Any OTHER pending edit (dates/Vs/filters/preset)
 * is untouched by this and keeps lighting Search exactly as before.
 */
function onPinsChanged() {
  const pins = store.get().pinnedPlayers || [];
  if (appliedState) appliedState = { ...appliedState, pinnedPlayers: pins };
  if (pillsController) pillsController.render();
  updateDrawerBadge();
  if (tableController) {
    tableController.syncToolbar();
    // 4d/A6: applyPinnedPlayers() now returns its load() promise so a no-data
    // pin (the "later wave" this file used to flag right here) gets its pill
    // annotated + a toast fired, the instant the optimistic pin resolves.
    Promise.resolve(tableController.applyPinnedPlayers()).then((result) => reportPinCoverage(result));
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
 * row alone. Wave 4b (decision 47a) extended the same bypass to matchup
 * ("Vs") mode via buildMatchupQuery, so the pin is live in both.
 *
 * R4 Wave 4a ADDENDUM: pinning is now INSTANT (onPinsChanged, above) — the
 * row appears in the table immediately, no Search press. If the player
 * genuinely has no innings even in the CORE scope, load()'s own
 * missingPinnedIds return value tells us that — onPinsChanged's
 * reportPinCoverage() call (4d/A6) annotates their pill "(no innings)" and
 * toasts once; a no-data pin no longer just sits there silently.
 */
function pinPlayer(id, name) {
  const state = store.get();
  if ((state.pinnedPlayers || []).some((p) => p.id === id)) return; // already pinned
  store.set({ pinnedPlayers: [...(state.pinnedPlayers || []), { id, name }] });
  onPinsChanged();
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
  // R5-A #9: the FILTER pills render from the APPLIED snapshot (the frozen state
  // the table actually reflects), NOT the live/pending store — so a filter edited
  // inside the Filters popup (a High-Score condition, team/opp/event/venue, a
  // popup date, Vs) does NOT surface as a pill until the popup's Search commits it.
  // This REVERSES Wave 4a's "pills reflect pending" (owner was emphatic: a
  // High-Score pill leaking onto the table mid-edit is wrong). The already-approved
  // carve-outs are preserved inside pills.js: PIN pills read the LIVE store (so
  // picking a player from the results search drops its pill in immediately, and a
  // pin ×/+ soft-delete stays pending with its red-outline undo), and every pill's
  // ×/+ still soft-deletes and commits on Search (decision 47g).
  pillsController = mountPills(
    pillsHostEl,
    store,
    () => {
      onFiltersChanged();
    },
    undefined, // onPinChange defaults to onChange (a pin ×/+ stays pending)
    // getState = the APPLIED snapshot (filter pills render from it); pills.js reads
    // the live store directly for PIN pills so pin add/remove stay instant/pending.
    () => appliedState || store.get(),
    // 4d/A6: hands pills.js the live no-innings-pin id set so a pinned
    // player's own pill can read "(no innings)" once reportPinCoverage()
    // learns that from a completed load().
    () => noInningsPinIds
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
      // R3.2: appliedState is snapshotted AFTER setDateBounds (below) so the
      // default end date it fills is part of the applied baseline — otherwise
      // the toolbar's Search button would read "dirty" from boot on a date the
      // user never touched. (setDateBounds needs filterController, mounted next.)

      initStatusEl.innerHTML = "";
      appContentEl.hidden = false;

      // R7 Wave B (item 3): the footer reads the LATEST MATCH DATE in the data
      // (the same manifest max-date bound the presets + default end date use),
      // NOT the wall-clock/generated-at date — the honest "data as of" line is
      // "how current is the cricket," not "when did the build run."
      if (maxDate) {
        footerDataDateEl.textContent = `Data as of ${formatDataDate(maxDate)}`;
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
      // Now that setDateBounds has filled the default end date, snapshot the
      // applied baseline — pills/badge start empty and the toolbar Search button
      // starts at-rest (pending === applied).
      appliedState = snapshotAppliedState();

      // Filters content: the ONE grouped condition builder (owner 1B-2) mounts
      // into the Advanced Filters section host. onChange refreshes pills/subtitle
      // (never blanks the table); the popup's "Search" button is the one query
      // trigger.
      drawerController = mountFilterDrawer(
        {
          advancedHost: document.getElementById("popup-advanced-host"),
          // 4d/A5: static footer checkbox from index.html — present from page
          // load, so querying it here (ahead of the filtersPopupEl lookups
          // below) is safe.
          keepColumnsCheckbox: document.querySelector('[data-role="fpop-keep-columns"]'),
        },
        store,
        {
          onChange: () => {
            onFiltersChanged();
          },
          // R5-A #10: "Keep Selected Columns" is greyed when it can't do anything —
          // on a blank table (nothing searched yet) OR when the pending discipline
          // differs from the last-searched one (the columns it would carry belong
          // to the other view). Display-only; never read by a query builder.
          isKeepColumnsDisabled: () => {
            if (!tableController || !tableController.hasResults()) return true;
            const applied = appliedState || store.get();
            return store.get().discipline !== applied.discipline;
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
        // R7 #16: filters are now shared bidirectionally with the graph, so the
        // Search Conditions controls must re-sync from the (shared) store on
        // every open — otherwise a discipline/format/etc. change made on the
        // graph side would leave these selects showing a stale value here.
        filterController.render();
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
        // The ONE query trigger (R3.2: shared by BOTH the popup's "Search"
        // button AND the toolbar's SEARCH button). Date is REQUIRED (owner
        // 1B-2): block first and surface the message; then validate the advanced
        // numeric conditions. When called from the toolbar the popup may be
        // closed, so on a validation failure we OPEN it (if needed) and re-run
        // the failed validator so its inline error shows after onShow's reset.
        if (!filterController.validateDate()) {
          if (!filtersPopup.isOpen()) filtersPopup.open();
          filterController.validateDate();
          fpopSetSection("fpop-body-conditions", true); // expand + show the date-required note
          return;
        }
        if (!drawerController.validate()) {
          if (!filtersPopup.isOpen()) filtersPopup.open();
          drawerController.validate();
          fpopSetSection("fpop-body-advanced", true); // surface the inline error
          return;
        }
        closePopup();
        // R3.2: Search is the moment ALL pending edits (popup filters AND the
        // toolbar controls — dates, Vs, preset, columns, sort, player search /
        // pins) BECOME applied. Commit the snapshot and refresh the pills +
        // badge + toolbar from it (closePopup itself never queries), then load
        // the table. In graph view there's no table load — the graph already
        // follows scope live — but committing the snapshot keeps the pills/badge
        // correct for a later switch back to Stats.
        appliedState = snapshotAppliedState();
        // A4: this Search commits any soft-deleted (staged) pill removals — the
        // pending store already dropped their effects at × time, so clear the
        // staged display set before re-rendering so committed pills vanish.
        if (pillsController) { pillsController.clearStaged(); pillsController.render(); }
        updateDrawerBadge();
        if (tableController) tableController.syncToolbar(); // clear the dirty cue now
        // 4d/A6: a committed Search is the primary no-data-pin detection point
        // — recompute + annotate/toast for whichever pinned players (if any)
        // came back with zero rows in this scope, plain or matchup mode alike.
        if (store.get().view === "table") tableController.load().then((result) => reportPinCoverage(result));
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

      // R3.2 ("everything waits for Search"): appliedState now advances ONLY in
      // runSearch() (commit) and clearAll() (reset) — never here. EVERY store
      // mutation is a PENDING edit (toolbar controls, popup, pills ×, pins,
      // player search): it must NOT move the frozen table/pills/badge before
      // Search. This hook just keeps every derived view honest against the
      // (still-frozen) applied snapshot and lights the toolbar's Search button
      // dirty via syncToolbar(). The graph has its own scope path (onScopeChanged).
      store.subscribe(() => {
        // Pills + badge render from appliedState (frozen) — a pending edit never
        // surfaces there before Search.
        if (pillsController) pillsController.render();
        updateDrawerBadge();
        // Toolbar (dates, preset, Vs, columns-enabled, count, Search dirty):
        // re-sync from the live (pending) store on every change. No-op unless the
        // table skeleton exists.
        if (tableController) tableController.syncToolbar();
        // The popup's filter content: its condition-builder vocabulary + Vs
        // position-chip enablement depend on the Vs selection, so re-sync while
        // the popup is VISIBLE (Batch 3 fix 2: syncing hidden content is wasted
        // work, and syncing while open rebuilds innerHTML — kept gated).
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
        // R3 Wave 6: picking a player clears the header box back to empty
        // (ready for the next search) in addition to opening the popup —
        // unlike the table-search box, where the typed term stays put next
        // to the "+ name" pin so the user can see what's still narrowing the
        // result. Dispatching "input" (not just setting .value) keeps
        // omnisearch.js's own internal state (rows/currentTerm) in sync with
        // the now-empty box, exactly as if the user had cleared it by hand.
        // R4 Wave 2 (owner ruling): the header search is reachable regardless
        // of the table's applied filters, so its popup must not silently
        // inherit them either — { fixedScope: true } tells playerPopup.js /
        // playerPage.js to substitute the fixed full-history default (since
        // 2020, T20, both team types, this player's own gender) in place of
        // the live scope strip. Contrast with onPlayerClick below (table-row
        // entry, mountTable's callback further down) and the table-search
        // box's onOpenPlayer above (mountTableToolbarExtras) — neither passes
        // this flag, so both keep pinning/opening scoped to the table's
        // current filters exactly as before.
        onOpenPlayer: (id, name) => {
          playerPopupController.open(id, name, { fixedScope: true });
          headerSearchInputEl.value = "";
          headerSearchInputEl.dispatchEvent(new Event("input", { bubbles: true }));
        },
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
        // R3.2: the toolbar SEARCH button (which REPLACED the old "Graph"
        // button) is the toolbar's query trigger — the exact same runSearch()
        // the popup's Search uses (commit pending → applied, then load). The
        // Stats↔Graphs top-strip toggle now carries the "turn into graph" seed
        // instead (see the view-toggle handler below).
        onSearch: () => runSearch(),
        // R3.2: a toolbar date edit re-syncs the popup's own date inputs +
        // preset label + date-required note (both sets bind state.dateFrom/To);
        // syncToolbar (via the store hook) refreshes the toolbar side.
        onDateChange: () => {
          filterController.render();
          filterController.validateDate();
        },
        // R3.2: the toolbar's Search dirty cue = pending (live store) ≠ applied
        // snapshot. table.js computes it via this accessor.
        getAppliedState: () => appliedState,
        // R4 Wave 4a (A1): the Columns picker + column drag-reorder are INSTANT
        // (they change the frozen table in place) and must NOT light Search —
        // unlike the PENDING preset dropdown, which also sets columns. table.js
        // calls this to advance the applied snapshot's column list in lockstep
        // with the live store so the dirty comparison sees columns as unchanged.
        // The preset dropdown deliberately does NOT call this, so it stays dirty.
        onColumnsApplied: (ns, cols) => {
          if (appliedState) {
            appliedState = { ...appliedState, columns: { ...appliedState.columns, [ns]: cols } };
          }
        },
        // The empty-state prompt's "Open filters" button + the toolbar Filters
        // button open the Filters popup (the query runs from Search).
        onOpenFilters: () => openFiltersPopup(),
        // The toolbar's red "Clear" button — the same full reset as everywhere
        // else clearAll() is wired.
        onClear: () => clearAll(),
        // table.js's persistent toolbar (search box/pills host) exists once its
        // skeleton is built — on FIRST LOAD now (R3.2: the toolbar is always
        // visible), and again after Clear/a query error rebuilds it. This fires
        // each time so the pills row + table-search box get (re-)wired.
        onSkeletonReady: (nodes) => mountTableToolbarExtras(nodes),
      });
      // R3.2: the toolbar's From–To date inputs get the same manifest bounds the
      // popup's do (both bind state.dateFrom/dateTo). Applied here + re-applied
      // by ensureSkeleton on each rebuild.
      tableController.setDateBounds(minDate, maxDate);
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
        // R7 Wave 2 (item 19): the graph's "Clear filters" button clears the
        // SHARED filters through the one reset path, staying in the Graphs tab.
        onClearFilters: () => clearAll({ returnToTable: false }),
      });

      viewToggleEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".segmented__btn");
        if (!btn) return;
        const view = btn.dataset.value;
        if (view === store.get().view) return;
        store.set({ view });
        // R3.2 (item 7): the toolbar's "Graph" button was removed, so the
        // top-strip Stats→Graphs toggle now carries what that button did —
        // enterFromBridge({ preferredMetricKey: current sort key }). The
        // top-strip LAYOUT is unchanged; only the toggle's behaviour gains the
        // seed. enterFromBridge handles the empty/never-searched case itself.
        // Graphs→Stats keeps the plain applyView() (restores the frozen table).
        if (view === "graph") {
          showGraphView();
          graphController.enterFromBridge({ preferredMetricKey: store.get().sort.key });
        } else {
          applyView();
        }
      });

      updateDrawerBadge();
      updateViewToggle();
      // R3.2 (item 1): the toolbar is visible from first load — showPrompt now
      // builds the skeleton + toolbar with an empty table body (no "Open
      // filters" card); the query still runs only from a Search.
      tableController.showPrompt();
    })
    .catch((err) => {
      renderInitError(err, boot);
    });
}

boot();
