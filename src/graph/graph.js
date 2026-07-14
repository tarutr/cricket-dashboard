// src/graph/graph.js
//
// Graph Builder panel controller (SPEC §6). Mounts into a `#graph-area`
// section (no iframes — §6 bans them): layout = left controls column
// (chart type, metric picker(s), player selection/search), right stage (the
// paper card containing the Chart.js canvas + export button).
//
// Reuses (never duplicates): metrics.js catalogue + hasMetricData,
// state.js's eligibleMetrics/phaseMetricAllowed/describeScope, filters.js's
// buildScopeClauses (via charts.js/players.js), table.js's buildQuery (via
// players.js, for seeding).

import { eligibleMetrics, createStore, pruneIneligibleState } from "../state.js";
import { getMetric, hasMetricData } from "../metrics.js";
import { escHtml, escAttr } from "../html.js";
import { getManifest, query } from "../db.js";
import { mountFilters } from "../filters.js";
import { mountFilterDrawer } from "../drawer.js";
import {
  CHART_CAPS,
  createSelection,
  seedFromFilteredSet,
  searchPlayers,
} from "./players.js";
import {
  fetchSelectedPlayerMetrics,
  fetchWindowMetric,
  buildBarChart,
  buildDonutChart,
  buildScatterChart,
  buildRadarSmallMultiples,
  buildPhasesChart,
  buildSlopeChart,
} from "./charts.js";
import { mountCard } from "./card.js";
import { eligibleRadarGroups } from "./radarGroups.js";
import { eligiblePhaseFamilies } from "./phaseFamilies.js";
import { timeseriesSupported, buildTimeseriesQuery } from "./timeseries.js";
import { buildTimeseriesChart } from "./timeseriesChart.js";
// Dumbbell is now a TIME-WINDOW chart (owner correction: it is NOT a
// Pace-vs-Spin chart) — it draws the SAME data as Slope (one rate/percent
// metric across Window A vs Window B, via charts.js's fetchWindowMetric),
// rendered as dot-bar-dot. It therefore needs none of src/graph/dumbbell.js's
// matchup "Vs"-bucket machinery anymore; only the renderer is imported.
import { buildDumbbellChart } from "./dumbbellChart.js";
import {
  benchmarkEligibleMetrics,
  defaultBenchmarkMetricKeys,
  fetchBenchmarkPool,
  computeBenchmarkRows,
  groupMetricsByKind,
  benchmarkFloorNotes,
} from "./benchmark.js";
import { buildBenchmarkChart } from "./benchmarkChart.js";

const CHART_TYPES = [
  { key: "bar", label: "Bar" },
  { key: "donut", label: "Donut" },
  { key: "scatter", label: "Scatter" },
  { key: "radar", label: "Radar" },
  { key: "phases", label: "Phases" },
  { key: "slope", label: "Slope" },
  // Batch 4 wave 2 (the last two chart types).
  { key: "byyear", label: "Line" },
  { key: "dumbbell", label: "Dumbbell" },
  // B8b (decision 44e).
  { key: "benchmark", label: "Benchmark" },
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deep-copy a store state snapshot for the graph-local scope store (item 1).
 * State is pure JSON (strings/numbers/arrays/plain objects/null), so a JSON
 * round-trip is a correct, dependency-free deep clone that shares no nested
 * references (profile / advanced.groups / columns / the filter arrays) with
 * the Stats state — a graph edit can therefore never reach back into it. */
function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// ── Day-level date helpers (R3 Wave 3, item 10) ─────────────────────────────
// The Slope/Dumbbell Window A/B pickers are now DAY-level native <input
// type="date"> controls (they used to be month <select>s, which desynced their
// displayed value — noted at commit 2f847ee). Windows are stored as
// "YYYY-MM-DD" pairs; charts.js's fetchWindowMetric feeds them straight into
// buildScopeClauses, whose buildCoreScopeClauses already accepts a day-shaped
// dateFrom/dateTo (filters.js's isDayDate branch) — so no query shape changes,
// only the granularity of the two dates handed to it. All arithmetic is UTC
// (never local time) so it can never drift a day across a DST boundary.
const DAY_MS = 86400000;
function dayToMs(d) {
  const [y, m, dd] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, dd);
}
function msToDay(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
/** Coerce a stored date to a day-shaped "YYYY-MM-DD" ("" for a month-shaped
 * legacy value pads to the 1st; null/blank -> null). */
function toDay(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{4}-\d{2}$/.test(v)) return `${v}-01`;
  return null;
}
/** "YYYY-MM-DD" -> "D Mon YYYY", or null. */
function dayLabel(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** A window's {from,to} -> "D Mon YYYY – D Mon YYYY" (or a single day when
 * from and to are the same), or null if either bound is unset. */
function windowLabel(window) {
  if (!window || !window.from || !window.to) return null;
  const from = dayLabel(window.from);
  const to = dayLabel(window.to);
  return from === to ? from : `${from} – ${to}`;
}

/** Dataset-wide day bounds (the manifest's min/max match_date, "YYYY-MM-DD"),
 * for the Window A/B date pickers' min/max attributes — the FULL dataset range,
 * not the live scope's narrower dateFrom/dateTo, same posture as before. */
function datasetDayBounds() {
  const manifest = getManifest();
  return {
    minDay: manifest?.data?.min_match_date || null,
    maxDay: manifest?.data?.max_match_date || null,
  };
}

/** min/max attributes for the Window A/B <input type="date"> pickers, pinned to
 * the dataset's own day bounds (values come from the trusted manifest). */
function dayInputAttrs() {
  const { minDay, maxDay } = datasetDayBounds();
  return `${minDay ? `min="${minDay}"` : ""} ${maxDay ? `max="${maxDay}"` : ""}`.trim();
}

/** Shared open/close/outside-click/Escape wiring for the roster picker
 * dropdown below — byte-for-behavior identical to src/filters.js's own
 * wireDropdown() (Batch 8, task 1: "shared .dropdown component from
 * filters.js's pattern — reuse the classes"). Copied rather than imported:
 * filters.js does not export this helper and this batch's ownership is
 * src/graph/*.js only, so the ~20-line helper is duplicated here (same
 * precedent as timeseries.js/dumbbell.js duplicating table.js internals they
 * can't import) rather than editing a file outside this task's scope. */
function wireDropdown(toggleEl, panelEl) {
  function close() {
    panelEl.hidden = true;
    toggleEl.setAttribute("aria-expanded", "false");
  }
  function open() {
    panelEl.hidden = false;
    toggleEl.setAttribute("aria-expanded", "true");
  }
  toggleEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panelEl.hidden) open();
    else close();
  });
  document.addEventListener("click", (e) => {
    if (panelEl.hidden) return;
    if (panelEl.contains(e.target) || e.target === toggleEl) return;
    close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panelEl.hidden) close();
  });
}

// NOTE: the Dumbbell chart used to be batting+men-only (a matchup "vs Pace/vs
// Spin" chart, gated by a dumbbellAvailable()/dumbbellUnavailableReason() pair
// here). It is now a time-window chart drawing Slope's exact data source, so
// it works wherever Slope does — any gender, batting OR bowling — and needs no
// availability gate at all. Both helpers were removed with that rebuild.

/** Metrics eligible for the donut chart: additive totals only (Batch 3 fix 4 —
 * an explicit `additive: true` flag on the metric itself, set once in
 * metrics.js on genuinely summable counts/totals. Previously this inferred
 * additivity from format==="int" && zeroIsData===true, which let High Score
 * (MAX(runs), not a sum) slip in as a donut metric even though summing
 * several players' high scores is meaningless. Discipline/phase gating is
 * still applied via eligibleMetrics(). */
function donutEligibleMetrics(discipline, formats) {
  return eligibleMetrics(discipline, formats).filter((m) => m.additive === true);
}

// Owner decision 46 ("Graph this player" chooser, src/playerGraphChooser.js):
// mountGraph() is only ever called once per page load (one Graphs panel), so
// a module-level pointer to the live instance lets OTHER modules — the
// chooser, mounted from src/playerPopup.js, which has no reference to the
// controller object main.js holds — reach the two read/write entry points
// below (evaluateChartTypesForPlayer/enterWithChoice) as plain imports,
// without main.js needing to thread anything new through. Set at the bottom
// of mountGraph(), read by the two exported wrappers just below it.
let currentInstance = null;

export function mountGraph(container, statsStore, { hasStatsResults = () => false } = {}) {
  // ── Graph-local scope store (R3 Wave 3, item 1) ──────────────────────────
  // The Graph Builder owns its OWN filter scope, seeded (deep-copied) from the
  // Stats state's applied scope at graph entry and INDEPENDENT thereafter:
  // changing a graph filter mutates only this store, never `statsStore`, so it
  // can never move the Stats table underneath the user. Every scope read below
  // (`store.get()`, `store.describeScope()`, the seed/search queries) goes
  // through this local store; only seeding (from `statsStore`) and the "Back to
  // your table" link ever touch the Stats side. The clone is a pure-JSON deep
  // copy (state is all strings/numbers/arrays/plain objects/null — no dates or
  // functions), so it shares no nested references with the Stats state.
  const store = createStore(cloneState(statsStore.get()));
  // The Stats scope-key we last seeded FROM. Re-seed rule (item 1): on each
  // Graphs entry, if the Stats scope has changed since the last seed (i.e. a
  // NEW Stats search happened), re-inherit it wholesale — discarding the
  // graph's own filter edits and the scope-derived window defaults. If it is
  // unchanged (a bare tab toggle, or only the graph's own filters moved), keep
  // the graph's edits. Graph-filter edits never change this key because they
  // write to `store`, not `statsStore`.
  let lastStatsScopeKey = null;

  container.innerHTML = `
    <div class="graph-builder">
      <div class="graph-builder__controls">
        <div class="graph-builder__topbar">
          <button type="button" class="link-btn graph-back-link" data-role="graph-back">← Back to your table</button>
          <button type="button" class="btn btn--ghost graph-filters-btn" data-role="graph-filters-open">Filters</button>
        </div>
        <div class="graph-control-group">
          <span class="graph-control-label">Chart type</span>
          <div class="segmented graph-chart-type" data-role="chart-type" role="group" aria-label="Chart type">
            ${CHART_TYPES.map((t) => `<button type="button" class="segmented__btn" data-value="${t.key}">${t.label}</button>`).join("")}
          </div>
          <div class="graph-bar-style" data-role="bar-style" hidden>
            <span class="graph-control-label">Style</span>
            <div class="segmented segmented--small" data-role="bar-style-toggle" role="group" aria-label="Bar style">
              <button type="button" class="segmented__btn" data-value="bars">Bars</button>
              <button type="button" class="segmented__btn" data-value="dots">Dots</button>
            </div>
          </div>
        </div>

        <div class="graph-control-group" data-role="metric-controls"></div>

        <div class="graph-control-group">
          <div class="graph-control-group__head">
            <span class="graph-control-label">Players</span>
          </div>
          <div class="graph-player-search">
            <input type="text" class="input" data-role="player-search" placeholder="Add a player…" aria-label="Search players to add" />
            <div class="graph-player-search__results" data-role="player-search-results" hidden></div>
          </div>
          <div class="dropdown graph-roster-dropdown" data-role="roster-dropdown">
            <button type="button" class="select dropdown__toggle graph-roster-toggle" data-role="roster-toggle" aria-haspopup="true" aria-expanded="false"></button>
            <div class="dropdown__panel graph-roster-panel" data-role="roster-panel" hidden>
              <div class="segmented segmented--small graph-roster-mode" data-role="roster-mode" role="group" aria-label="Show" hidden>
                <button type="button" class="segmented__btn" data-value="manual">Manual</button>
                <button type="button" class="segmented__btn" data-value="best">Best</button>
                <button type="button" class="segmented__btn" data-value="worst">Worst</button>
              </div>
              <div class="graph-roster-filter" data-role="roster-filter-wrap" hidden>
                <input type="text" class="input graph-roster-filter__input" data-role="roster-filter" placeholder="Filter players…" aria-label="Filter the player list" />
              </div>
              <div class="dropdown__list graph-roster-list" data-role="roster-list"></div>
            </div>
          </div>
          <div class="graph-player-actions">
            <button type="button" class="link-btn" data-role="reset-players">Reset to filtered set</button>
          </div>
          <p class="graph-cap-note" data-role="cap-note" hidden></p>
        </div>
      </div>

      <div class="graph-builder__stage">
        <div class="graph-status" data-role="status" hidden></div>
        <div class="graph-stage-guidance" data-role="stage-guidance" hidden></div>
        <div class="graph-card-host" data-role="card-host"></div>
        <div class="graph-exclusions" data-role="exclusions" hidden></div>
        <div class="graph-export" data-role="export-row">
          <button type="button" class="btn btn--primary" data-role="export-png">Export PNG</button>
          <button type="button" class="btn btn--ghost" data-role="copy-png" hidden>Copy PNG</button>
          <span class="graph-export__status" data-role="export-status"></span>
        </div>
      </div>
    </div>
  `;

  const els = {
    chartType: container.querySelector('[data-role="chart-type"]'),
    barStyleGroup: container.querySelector('[data-role="bar-style"]'),
    barStyleToggle: container.querySelector('[data-role="bar-style-toggle"]'),
    metricControls: container.querySelector('[data-role="metric-controls"]'),
    playerSearch: container.querySelector('[data-role="player-search"]'),
    playerSearchResults: container.querySelector('[data-role="player-search-results"]'),
    rosterToggle: container.querySelector('[data-role="roster-toggle"]'),
    rosterPanel: container.querySelector('[data-role="roster-panel"]'),
    rosterMode: container.querySelector('[data-role="roster-mode"]'),
    rosterFilterWrap: container.querySelector('[data-role="roster-filter-wrap"]'),
    rosterFilter: container.querySelector('[data-role="roster-filter"]'),
    rosterList: container.querySelector('[data-role="roster-list"]'),
    resetPlayers: container.querySelector('[data-role="reset-players"]'),
    capNote: container.querySelector('[data-role="cap-note"]'),
    status: container.querySelector('[data-role="status"]'),
    stageGuidance: container.querySelector('[data-role="stage-guidance"]'),
    cardHost: container.querySelector('[data-role="card-host"]'),
    exclusions: container.querySelector('[data-role="exclusions"]'),
    exportRow: container.querySelector('[data-role="export-row"]'),
    exportBtn: container.querySelector('[data-role="export-png"]'),
    copyPngBtn: container.querySelector('[data-role="copy-png"]'),
    exportStatus: container.querySelector('[data-role="export-status"]'),
  };

  const card = mountCard(els.cardHost);
  const chartRef = { current: null };

  // Copy-to-clipboard is feature-detected (Clipboard API + ClipboardItem) —
  // hidden entirely on unsupported browsers rather than shown disabled.
  if (card.canCopyPNG()) els.copyPngBtn.hidden = false;

  // ── Local chart config state (separate from the global filter store) ─────
  // decision 46f: no chart type is pre-selected — the user must click one
  // before anything renders (see renderChart()'s top guard). Persists across
  // tab switches / chart-type re-picks for the rest of the session once set,
  // same as every other control below.
  let chartType = null;
  // R3 Wave 3, item 4 (no defaults / honest graph state):
  //  • chosenMetricKey — the ONE metric the user has picked, shared across the
  //    single-metric chart types (bar/donut/slope/byyear/dumbbell + scatter's Y
  //    axis) so it PERSISTS across chart-type switches. Adopted into a type's
  //    own key only when it's valid for that type; otherwise that type renders
  //    an honest "choose another metric" message rather than silently swapping.
  //  • metricEverChosen — has the user explicitly chosen ANY metric/group/
  //    family/axis this session? Gates the "Recommended" chart-type tag, which
  //    must not appear until a metric is chosen (no auto-pick, no auto-render).
  let chosenMetricKey = null;
  let metricEverChosen = false;
  function markMetricChosen(key) {
    if (key) chosenMetricKey = key;
    metricEverChosen = true;
  }
  let barStyle = "bars"; // "bars" | "dots" (lollipop) — bar chart only
  let barMetricKey = null;
  let donutMetricKey = null;
  let scatterXKey = null;
  let scatterYKey = null;
  let radarGroupId = null;
  let phaseFamilyId = null;
  let slopeMetricKey = null;
  // {from,to} "YYYY-MM" pairs, or null until ensureSlopeWindowDefaults() first
  // sets them (Batch 4 part 1, decision 43) — owner-picked after that, never
  // silently recomputed out from under the user.
  let slopeWindowA = null;
  let slopeWindowB = null;
  // Batch 4 wave 2 (the last two chart types).
  let byYearMetricKey = null;
  let dumbbellMetricKey = null;
  // Dumbbell is a time-window chart (owner correction): {from,to} "YYYY-MM"
  // pairs, mirroring slopeWindowA/B exactly — null until
  // ensureDumbbellWindowDefaults() first sets them (default half-split), then
  // owner-picked, never silently recomputed.
  let dumbbellWindowA = null;
  let dumbbellWindowB = null;

  // B8b (Benchmark, decision 44e). `benchmarkAnchorId` is the checked
  // roster's own id (never a candidate outside it — see renderMetricControls'
  // benchmark branch); `benchmarkMetricKeys` is the multi-select's chosen set
  // (>=4, <=12). `benchmarkPoolCache` memoizes the last pool fetch by an
  // identity key (scope + metric keys) so switching the ANCHOR alone
  // re-renders without a refetch (task brief) — see renderChart()'s benchmark
  // branch.
  let benchmarkAnchorId = null;
  let benchmarkMetricKeys = null;
  let benchmarkPoolCache = null; // { key, rows } | null

  let seeded = false; // has the selection ever been seeded for the current discipline+scope?
  let lastSeedKey = null;
  let loadToken = 0;
  // Owner point 13: the roster dropdown's filter-as-you-type text. The pool is
  // the entire filtered set now, so the list is filtered by name and rendered
  // in a capped slice (see renderPlayerList) — the pool itself is never capped.
  let rosterFilterText = "";

  // Batch 3 part 2 (honest titles, decision 43): which metric key ranked the
  // MOST RECENT successful seed, and under which discipline — this is what
  // the paper-card title's "top N" / "top N by X" phrasing is built from
  // (see resolveSeedMetric() and renderChart()'s `roster` below), rather than
  // inferring provenance from playerCount alone.
  let seedSortKey = null;
  let seedSortDiscipline = null;

  // Batch 8 (task 1): which metric key most recently ranked the CHECKED set
  // via an explicit per-type Best/Worst derivation (bar/donut/scatter-Y only
  // — see rankMetricForActiveType/deriveChecked below); null whenever the
  // "seed sort" fallback was used instead (radar/phases/slope/byyear/
  // dumbbell, or a candidate pool <= cap) or the roster is dirty. Set on
  // EVERY deriveChecked() call (including type switches), so it's always
  // fresh for the CURRENT chart type by the time currentRosterMeta() reads
  // it. resolveSeedMetric() below prefers this over the original seed's sort
  // metric when present — otherwise a Best-mode re-rank by a metric OTHER
  // than the table's original sort column (e.g. bar showing Average while the
  // table itself was sorted by Runs) would misattribute the title's "top N by
  // X" phrasing to the wrong metric, since the checked set's actual order no
  // longer has anything to do with the seed's own ORDER BY once re-ranked.
  let lastRankMetricKey = null;
  let lastRankMetricDiscipline = null;

  // decision 46f: the CHECKED-set cap before any chart type is picked — the
  // classic "top 15", same number Bar's own cap always was. Once a type is
  // picked, activeMaxCap() switches to that type's own CHART_CAPS entry.
  // NOTE (owner point 13): this caps only what's CHECKED/plotted, never the
  // candidate POOL — the pool is the entire filtered set (seedFromFilteredSet
  // no longer takes a cap). deriveChecked() picks the top N of the full pool
  // by rank up to this cap.
  const DEFAULT_PRETYPE_CAP = 15;
  function activeMaxCap() {
    return chartType ? CHART_CAPS[chartType].max : DEFAULT_PRETYPE_CAP;
  }
  /** "this chart type"/"the initial roster" — whichever the cap messages
   * above should call the thing capped at activeMaxCap(), depending on
   * whether a type has been picked yet. */
  function capSubjectLabel() {
    return chartType ? "this chart type" : "the initial roster";
  }

  /** Honest "nothing to plot" reason shared by the pre-type-selection stage
   * guidance AND every chart type's own evaluateTypeStatus() below (decision
   * 46f) — ONE predicate so both surfaces never disagree: null candidates
   * because Stats has never been searched vs. null candidates despite a real
   * search (current filters just match nobody) get different, honest wording;
   * a non-empty pool returns null (no pool-level reason — the type's own
   * eligibility/floor checks take over from there). */
  function poolStatusReason() {
    if (selection.candidateCount() > 0) return null;
    return hasStatsResults()
      ? "No players match your current filters — adjust them on the Stats tab and search again."
      : "Run a search on the Stats tab first.";
  }

  const selection = createSelection({
    getCap: () => activeMaxCap(),
    onChange: () => {
      renderPlayerList();
      // B8b: the Benchmark chart's ANCHOR select offers the CHECKED roster
      // (not the full candidate pool — see renderMetricControls' benchmark
      // branch) — a checked-set change (tick/untick/reseed/Best-Worst
      // re-derive) can add/remove/invalidate anchor choices, so the metric
      // controls must refresh to keep that select in sync. Every other chart
      // type's controls don't depend on the roster shape, so this is scoped
      // to benchmark only.
      if (chartType === "benchmark") renderMetricControls();
      // The recommend engine's ok/disabled state and "Recommended" tag
      // (task 2) depend on selection.candidateCount() — every candidate-pool
      // change (a fresh seed landing async, a manual add/remove, a Best/
      // Worst re-derivation) must re-sync the chart-type picker too, not just
      // the roster dropdown, or the buttons freeze at whatever their
      // pre-seed/pre-edit state happened to be (e.g. every type reading
      // "disabled" on first paint, before the initial seed's candidates ever
      // arrive, and never recovering).
      syncChartTypeButtons();
      scheduleRender({ paramsChanged: true });
    },
    onTruncate: (note) => showCapNote(note),
  });

  function showCapNote(note) {
    els.capNote.textContent = note;
    els.capNote.hidden = false;
  }
  function clearCapNote() {
    els.capNote.hidden = true;
    els.capNote.textContent = "";
  }

  /** Stage-level guidance shown IN PLACE OF the paper card whenever there's
   * nothing to chart yet: no chart type picked (decision 46f — no auto-render
   * on entry), or the picked type can't render right now for any reason
   * evaluateTypeStatus() reports (pool empty, wrong discipline/gender, no
   * eligible metric, below the type's own player floor). One plain-English
   * sentence, always in the stage — never a tooltip (task brief's honesty
   * rule for chart-type unavailability). */
  function showStageGuidance(text) {
    els.exportRow.hidden = true;
    els.cardHost.hidden = true;
    els.stageGuidance.textContent = text;
    els.stageGuidance.hidden = false;
  }
  function hideStageGuidance() {
    els.stageGuidance.hidden = true;
    els.cardHost.hidden = false;
    els.exportRow.hidden = false;
  }

  function showStatus(text) {
    els.status.textContent = text;
    els.status.hidden = false;
  }
  function hideStatus() {
    els.status.hidden = true;
  }
  function showErrorStatus(err, retryFn) {
    els.status.innerHTML = `
      <div class="error-box">
        <p>${escHtml((err && (err.userMessage || err.message)) || "Something went wrong building the chart.")}</p>
        <button type="button" class="btn btn--primary" data-role="graph-retry">Retry</button>
      </div>`;
    els.status.hidden = false;
    const btn = els.status.querySelector('[data-role="graph-retry"]');
    if (btn) btn.addEventListener("click", retryFn);
  }

  /**
   * Slope's Window A/B defaults (owner ruling, decision 43): "Window A = first
   * half of the current scope's date range, Window B = second half." Computed
   * ONCE — the first time the Slope chart type is used this session — from
   * the live filter scope's dateFrom/dateTo (falling back to the dataset's
   * full min/max if the scope isn't date-bounded yet). Never recomputed after
   * that, even if the scope's date range later moves: these are the user's
   * OWN pickers from that point on, not a mirror of the filter bar's.
   */
  function ensureSlopeWindowDefaults() {
    if (slopeWindowA && slopeWindowB) return;
    const state = store.get();
    const { minDay, maxDay } = datasetDayBounds();
    // Item 10: initialise from the GRAPH scope's EXACT dateFrom/dateTo (day
    // level), falling back to the dataset's full range if the scope isn't
    // date-bounded yet.
    const from = toDay(state.dateFrom) || minDay;
    const to = toDay(state.dateTo) || maxDay;
    if (!from || !to) return; // bounds not known yet — leave blank, user must pick both ends
    const fromMs = dayToMs(from);
    const toMs = dayToMs(to);
    const midMs = fromMs + Math.floor((toMs - fromMs) / 2);
    slopeWindowA = { from, to: msToDay(midMs) };
    const secondFromMs = Math.min(midMs + (toMs > fromMs ? DAY_MS : 0), toMs);
    slopeWindowB = { from: msToDay(secondFromMs), to };
  }

  /** Dumbbell's Window A/Window B defaults — IDENTICAL logic to
   * ensureSlopeWindowDefaults() above (first half of the scope's date range
   * vs second half), since the rebuilt Dumbbell is Slope's data drawn as
   * dumbbells. Kept as its own function (not shared with the slope one) so
   * each chart type owns its own independent, separately-repickable windows —
   * exactly as they were separate before, just both now date windows rather
   * than Slope=windows / Dumbbell=Vs-buckets. Set ONCE, then owner-picked. */
  function ensureDumbbellWindowDefaults() {
    if (dumbbellWindowA && dumbbellWindowB) return;
    const state = store.get();
    const { minDay, maxDay } = datasetDayBounds();
    const from = toDay(state.dateFrom) || minDay;
    const to = toDay(state.dateTo) || maxDay;
    if (!from || !to) return; // bounds not known yet — leave blank, user must pick both ends
    const fromMs = dayToMs(from);
    const toMs = dayToMs(to);
    const midMs = fromMs + Math.floor((toMs - fromMs) / 2);
    dumbbellWindowA = { from, to: msToDay(midMs) };
    const secondFromMs = Math.min(midMs + (toMs > fromMs ? DAY_MS : 0), toMs);
    dumbbellWindowB = { from: msToDay(secondFromMs), to };
  }

  // ── Selection model: Best/Worst ranking (Batch 8, task 1 — v1's
  // rankAndApply()) ──────────────────────────────────────────────────────────

  /** The metric to rank Best/Worst by for the CURRENT chart type. Bar/donut
   * rank by their own single displayed metric; scatter ranks by its Y axis
   * (the task brief's explicit choice — X is the OTHER axis, not "the"
   * metric). Every other chart type (radar/phases/slope/byyear/dumbbell)
   * shows either a GROUP of several metrics at once or needs its own
   * chart-specific query per player (two windows/sides) to get a single
   * value — too expensive/awkward to fetch just for a ranking preview across
   * the WHOLE candidate pool — so those fall back to "the seed sort" in
   * deriveChecked() below (returns null here to signal that fallback). */
  function rankMetricForActiveType(state) {
    if (chartType === "bar") return getMetric(barMetricKey, state.discipline);
    if (chartType === "donut") return getMetric(donutMetricKey, state.discipline);
    if (chartType === "scatter") return getMetric(scatterYKey, state.discipline);
    return null;
  }

  // Guards a rank fetch that's been superseded by a newer one (metric/type
  // changed again before the first fetch returned) — same "ignore stale async
  // result" idiom renderChart() already uses via loadToken.
  let rankDeriveToken = 0;

  /**
   * Re-derive the CHECKED set for "best"/"worst" mode by ranking the FULL
   * candidate pool (never just the currently-checked subset — a hidden
   * candidate must be able to become "the best" too) and keeping the top/
   * bottom `cap` many. A no-op for "manual" (just records the mode and
   * re-renders — "Manual leaves user picks alone", task brief).
   *
   * Players without real data for the ranking metric are never included —
   * SPEC §8.1's hasMetricData rule applied here exactly like it already is at
   * chart-render time (charts.js) and in v1's own rankAndApply ("never
   * include a 0/null player just to fill the cap"): a 0/null player has no
   * result to rank, so it can't be "best" or "worst".
   *
   * For chart types with no single rankable metric (rankMetricForActiveType
   * returns null), "the seed sort" fallback (task brief) is simply the
   * candidate pool's OWN existing order — which is either the seed query's
   * `ORDER BY <table sort> ... LIMIT cap` (players.js's seedFromFilteredSet)
   * or, for manually search-added players, append order. "Worst" under this
   * fallback is that order reversed (the tail of the seed's ranking), since
   * there's no per-type value to sort by directly.
   */
  async function deriveChecked(newMode) {
    selection.setMode(newMode);
    if (newMode === "manual") {
      renderPlayerList();
      return;
    }
    const token = ++rankDeriveToken;
    const state = store.get();
    const pool = selection.getFull();
    const cap = activeMaxCap();
    if (pool.length === 0) {
      selection.setChecked([], { dirty: false });
      lastRankMetricKey = null;
      lastRankMetricDiscipline = null;
      return;
    }
    let metric = rankMetricForActiveType(state);
    let ranked;
    let rankedByMetric = false;
    if (metric) {
      let rowsById = null;
      try {
        rowsById = await fetchSelectedPlayerMetrics(state, pool.map((p) => p.id), [metric.key]);
      } catch {
        // A failed ranking fetch shouldn't empty the roster or crash the
        // picker — fall back to seed order for this one derivation, exactly
        // as if no per-type metric applied; the next real chart render still
        // gets its own error handling/retry via renderChart()'s try/catch.
        rowsById = null;
      }
      if (token !== rankDeriveToken) return; // superseded by a later derive call
      if (rowsById) {
        const withData = pool.filter((p) => {
          const row = rowsById.get(p.id);
          return row && hasMetricData(metric, row[metric.key]);
        });
        withData.sort((a, b) => {
          const va = Number(rowsById.get(a.id)[metric.key]);
          const vb = Number(rowsById.get(b.id)[metric.key]);
          const diff = metric.higherIsBetter ? vb - va : va - vb; // best-first order
          return newMode === "worst" ? -diff : diff;
        });
        ranked = withData;
        rankedByMetric = true;
      }
    }
    if (!rankedByMetric) {
      metric = null; // seed-order fallback — no per-type metric actually ranked this
      ranked = newMode === "worst" ? pool.slice().reverse() : pool.slice();
    }
    if (token !== rankDeriveToken) return;
    selection.setChecked(ranked.slice(0, cap).map((p) => p.id), { dirty: false });
    lastRankMetricKey = metric ? metric.key : null;
    lastRankMetricDiscipline = metric ? state.discipline : null;
  }

  /** Wired to the bar/donut/scatter-Y metric selects only (the three that
   * feed rankMetricForActiveType) — re-derives Best/Worst when the metric
   * that ranks them changes ("switching to Best/Worst re-derives on metric
   * change too", task brief); a no-op in Manual mode beyond the render. Every
   * OTHER metric/group/family/window/side select (scatter-X, radar, phases,
   * slope, byyear, dumbbell) does NOT call this — their ranking fallback is
   * "the seed sort", which doesn't depend on which metric they display. */
  function onRankMetricChanged() {
    if (selection.getMode() !== "manual") deriveChecked(selection.getMode());
    scheduleRender({ paramsChanged: true });
  }

  // ── Metric controls (rebuilt per chart type) ──────────────────────────────

  /** <option>s for a single-metric select, with a "Choose a metric…"
   * placeholder first (item 4 — no auto-pick). `selectedKey` may be null. */
  function metricOptionsHTML(metrics, selectedKey) {
    const placeholder = `<option value="" ${!selectedKey ? "selected" : ""}>Choose a metric…</option>`;
    return (
      placeholder +
      metrics.map((m) => `<option value="${escAttr(m.key)}" ${m.key === selectedKey ? "selected" : ""}>${escHtml(m.label)}</option>`).join("")
    );
  }

  /** Adopt the shared chosen metric (item 4) into a per-type key ONLY when it's
   * valid for that type's own eligible list; otherwise null — the type then
   * shows an honest "choose a metric" message rather than silently auto-picking
   * one, and the user's metric survives every type switch where it IS valid. */
  function adoptChosenMetric(metrics) {
    return chosenMetricKey && metrics.some((m) => m.key === chosenMetricKey) ? chosenMetricKey : null;
  }

  function renderMetricControls() {
    // decision 46f: nothing to show before a chart type is picked.
    if (!chartType) {
      els.metricControls.innerHTML = "";
      return;
    }
    const state = store.get();
    const discipline = state.discipline;
    const formats = state.formats;

    if (chartType === "bar") {
      const metrics = eligibleMetrics(discipline, formats);
      barMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="bar-metric">
          ${metricOptionsHTML(metrics, barMetricKey)}
        </select>
      `;
      els.metricControls.querySelector('[data-role="bar-metric"]').addEventListener("change", (e) => {
        barMetricKey = e.target.value || null;
        if (barMetricKey) markMetricChosen(barMetricKey);
        syncChartTypeButtons();
        onRankMetricChanged();
      });
    } else if (chartType === "donut") {
      const metrics = donutEligibleMetrics(discipline, formats);
      donutMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric (total)</span>
        <select class="select graph-metric-select" data-role="donut-metric">
          ${metrics.length ? metricOptionsHTML(metrics, donutMetricKey) : `<option value="">No additive totals available</option>`}
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="donut-metric"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          donutMetricKey = e.target.value || null;
          if (donutMetricKey) markMetricChosen(donutMetricKey);
          syncChartTypeButtons();
          onRankMetricChanged();
        });
      }
    } else if (chartType === "scatter") {
      const metrics = eligibleMetrics(discipline, formats);
      // item 4: no auto-pick. The Y axis carries the shared chosen metric (it's
      // what ranks Best/Worst — see rankMetricForActiveType); X is scatter-local.
      // Both start on the "Choose a metric…" placeholder until explicitly picked.
      scatterYKey = adoptChosenMetric(metrics) || (scatterYKey && metrics.some((m) => m.key === scatterYKey) ? scatterYKey : null);
      scatterXKey = scatterXKey && metrics.some((m) => m.key === scatterXKey) ? scatterXKey : null;
      els.metricControls.innerHTML = `
        <span class="graph-control-label">X axis</span>
        <select class="select graph-metric-select" data-role="scatter-x">
          ${metricOptionsHTML(metrics, scatterXKey)}
        </select>
        <span class="graph-control-label">Y axis</span>
        <select class="select graph-metric-select" data-role="scatter-y">
          ${metricOptionsHTML(metrics, scatterYKey)}
        </select>
      `;
      els.metricControls.querySelector('[data-role="scatter-x"]').addEventListener("change", (e) => {
        scatterXKey = e.target.value || null;
        if (scatterXKey) metricEverChosen = true;
        syncChartTypeButtons();
        scheduleRender({ paramsChanged: true });
      });
      els.metricControls.querySelector('[data-role="scatter-y"]').addEventListener("change", (e) => {
        scatterYKey = e.target.value || null;
        if (scatterYKey) markMetricChosen(scatterYKey);
        syncChartTypeButtons();
        onRankMetricChanged();
      });
    } else if (chartType === "radar") {
      const groups = eligibleRadarGroups(discipline, formats);
      // item 4: no auto-pick — require an explicit group choice (radar has no
      // single "metric", so its group selector is the pick that specifies it).
      if (radarGroupId && !groups.some((g) => g.id === radarGroupId)) radarGroupId = null;
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric group</span>
        <select class="select graph-metric-select" data-role="radar-group">
          ${
            groups.length
              ? `<option value="" ${!radarGroupId ? "selected" : ""}>Choose a metric group…</option>` +
                groups.map((g) => `<option value="${escAttr(g.id)}" ${g.id === radarGroupId ? "selected" : ""}>${escHtml(g.label)}</option>`).join("")
              : `<option value="">No groups available for this scope</option>`
          }
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="radar-group"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          radarGroupId = e.target.value || null;
          if (radarGroupId) metricEverChosen = true;
          syncChartTypeButtons();
          scheduleRender({ paramsChanged: true });
        });
      }
    } else if (chartType === "phases") {
      const families = eligiblePhaseFamilies(discipline, formats);
      // item 4: no auto-pick — require an explicit family choice.
      if (phaseFamilyId && !families.some((f) => f.id === phaseFamilyId)) phaseFamilyId = null;
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric family</span>
        <select class="select graph-metric-select" data-role="phase-family">
          ${
            families.length
              ? `<option value="" ${!phaseFamilyId ? "selected" : ""}>Choose a metric family…</option>` +
                families.map((f) => `<option value="${escAttr(f.id)}" ${f.id === phaseFamilyId ? "selected" : ""}>${escHtml(f.label)}</option>`).join("")
              : `<option value="">No phase families available for this scope</option>`
          }
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="phase-family"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          phaseFamilyId = e.target.value || null;
          if (phaseFamilyId) metricEverChosen = true;
          syncChartTypeButtons();
          scheduleRender({ paramsChanged: true });
        });
      }
    } else if (chartType === "slope") {
      const metrics = eligibleMetrics(discipline, formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      slopeMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      ensureSlopeWindowDefaults();
      const slopeDayAttrs = dayInputAttrs();
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="slope-metric">
          ${
            metrics.length
              ? metricOptionsHTML(metrics, slopeMetricKey)
              : `<option value="">No rate/percent metrics available for this scope</option>`
          }
        </select>
        <span class="graph-control-label">Window A</span>
        <div class="date-range graph-slope-range">
          <input type="date" class="input date-range__input" data-role="slope-a-from" aria-label="Window A from" value="${escAttr(slopeWindowA?.from ?? "")}" ${slopeDayAttrs} />
          <span class="date-range__sep">–</span>
          <input type="date" class="input date-range__input" data-role="slope-a-to" aria-label="Window A to" value="${escAttr(slopeWindowA?.to ?? "")}" ${slopeDayAttrs} />
        </div>
        <span class="graph-control-label">Window B</span>
        <div class="date-range graph-slope-range">
          <input type="date" class="input date-range__input" data-role="slope-b-from" aria-label="Window B from" value="${escAttr(slopeWindowB?.from ?? "")}" ${slopeDayAttrs} />
          <span class="date-range__sep">–</span>
          <input type="date" class="input date-range__input" data-role="slope-b-to" aria-label="Window B to" value="${escAttr(slopeWindowB?.to ?? "")}" ${slopeDayAttrs} />
        </div>
      `;
      const metricSel = els.metricControls.querySelector('[data-role="slope-metric"]');
      if (metricSel) {
        metricSel.addEventListener("change", (e) => {
          slopeMetricKey = e.target.value || null;
          if (slopeMetricKey) markMetricChosen(slopeMetricKey);
          syncChartTypeButtons();
          scheduleRender({ paramsChanged: true });
        });
      }
      const bindWindowSelect = (role, setter) => {
        const el = els.metricControls.querySelector(`[data-role="${role}"]`);
        if (el) {
          el.addEventListener("change", (e) => {
            setter(e.target.value);
            scheduleRender({ paramsChanged: true });
          });
        }
      };
      bindWindowSelect("slope-a-from", (v) => (slopeWindowA = { ...slopeWindowA, from: v }));
      bindWindowSelect("slope-a-to", (v) => (slopeWindowA = { ...slopeWindowA, to: v }));
      bindWindowSelect("slope-b-from", (v) => (slopeWindowB = { ...slopeWindowB, from: v }));
      bindWindowSelect("slope-b-to", (v) => (slopeWindowB = { ...slopeWindowB, to: v }));
    } else if (chartType === "byyear") {
      // Batch 4 wave 2, task 1: metrics whose sqlExpression recombines
      // cleanly per (player, year) — timeseries.js's own whitelist (kind
      // total/rate, innings-sourced); never re-derived here (§8.2).
      const metrics = eligibleMetrics(discipline, formats).filter((m) => timeseriesSupported(m));
      byYearMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="byyear-metric">
          ${
            metrics.length
              ? metricOptionsHTML(metrics, byYearMetricKey)
              : `<option value="">No year-by-year metric available for this scope</option>`
          }
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="byyear-metric"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          byYearMetricKey = e.target.value || null;
          if (byYearMetricKey) markMetricChosen(byYearMetricKey);
          syncChartTypeButtons();
          scheduleRender({ paramsChanged: true });
        });
      }
    } else if (chartType === "dumbbell") {
      // Time-window Dumbbell (owner correction — NOT a Pace/Spin chart): the
      // SAME controls as Slope — one rate/percent metric + a Window A/Window B
      // month range each — since it draws Slope's exact data (fetchWindowMetric
      // per window) as dot-bar-dot. Works for batting AND bowling, any gender;
      // no availability gate.
      const metrics = eligibleMetrics(discipline, formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      dumbbellMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      ensureDumbbellWindowDefaults();
      const dumbbellDayAttrs = dayInputAttrs();
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="dumbbell-metric">
          ${
            metrics.length
              ? metricOptionsHTML(metrics, dumbbellMetricKey)
              : `<option value="">No rate/percent metric available for this scope</option>`
          }
        </select>
        <span class="graph-control-label">Window A</span>
        <div class="date-range graph-slope-range">
          <input type="date" class="input date-range__input" data-role="dumbbell-a-from" aria-label="Window A from" value="${escAttr(dumbbellWindowA?.from ?? "")}" ${dumbbellDayAttrs} />
          <span class="date-range__sep">–</span>
          <input type="date" class="input date-range__input" data-role="dumbbell-a-to" aria-label="Window A to" value="${escAttr(dumbbellWindowA?.to ?? "")}" ${dumbbellDayAttrs} />
        </div>
        <span class="graph-control-label">Window B</span>
        <div class="date-range graph-slope-range">
          <input type="date" class="input date-range__input" data-role="dumbbell-b-from" aria-label="Window B from" value="${escAttr(dumbbellWindowB?.from ?? "")}" ${dumbbellDayAttrs} />
          <span class="date-range__sep">–</span>
          <input type="date" class="input date-range__input" data-role="dumbbell-b-to" aria-label="Window B to" value="${escAttr(dumbbellWindowB?.to ?? "")}" ${dumbbellDayAttrs} />
        </div>
      `;
      const metricSel = els.metricControls.querySelector('[data-role="dumbbell-metric"]');
      if (metricSel) {
        metricSel.addEventListener("change", (e) => {
          dumbbellMetricKey = e.target.value || null;
          if (dumbbellMetricKey) markMetricChosen(dumbbellMetricKey);
          syncChartTypeButtons();
          scheduleRender({ paramsChanged: true });
        });
      }
      const bindWindowSelect = (role, setter) => {
        const el = els.metricControls.querySelector(`[data-role="${role}"]`);
        if (el) {
          el.addEventListener("change", (e) => {
            setter(e.target.value);
            scheduleRender({ paramsChanged: true });
          });
        }
      };
      bindWindowSelect("dumbbell-a-from", (v) => (dumbbellWindowA = { ...dumbbellWindowA, from: v }));
      bindWindowSelect("dumbbell-a-to", (v) => (dumbbellWindowA = { ...dumbbellWindowA, to: v }));
      bindWindowSelect("dumbbell-b-from", (v) => (dumbbellWindowB = { ...dumbbellWindowB, from: v }));
      bindWindowSelect("dumbbell-b-to", (v) => (dumbbellWindowB = { ...dumbbellWindowB, to: v }));
    } else if (chartType === "benchmark") {
      // B8b (decision 44e). Anchor picker: a plain <select> over the CHECKED
      // roster ONLY (task brief) — unlike every other chart type, the pool
      // this chart draws from is the WHOLE filtered set regardless of roster
      // size (CHART_CAPS.benchmark = {min:1, max:15} — see players.js's doc
      // comment on why the roster only sources the anchor choice here).
      // Metric picker: a multi-select checkbox dropdown (the shared
      // .dropdown pattern filters.js's Format/Team-type dropdowns already
      // established), grouped by kind (Volume/Tempo/Consistency —
      // benchmark.js's BENCHMARK_KIND_LABELS is the one source both this
      // picker and the chart's own section headers read from).
      const eligible = benchmarkEligibleMetrics(discipline, formats);

      // Prune any no-longer-eligible keys (phase gating / discipline switch),
      // then top back up to the floor of 4 from the discipline's defaults —
      // same "prune ineligible, keep the rest, refill toward the floor"
      // posture as every other metric select's own validity check in this
      // function, generalized to a multi-select.
      let keys = (benchmarkMetricKeys || []).filter((k) => eligible.some((m) => m.key === k));
      if (keys.length < 4) {
        const fill = defaultBenchmarkMetricKeys(discipline).filter((k) => !keys.includes(k));
        keys = [...keys, ...fill].slice(0, 12);
        // Defensive backstop only (shouldn't trigger for any real scope —
        // every default key is a plain, non-phase-gated metric): pad with
        // whatever else is eligible, catalogue order, if even the defaults
        // couldn't reach 4.
        for (const m of eligible) {
          if (keys.length >= 4) break;
          if (!keys.includes(m.key)) keys.push(m.key);
        }
      }
      benchmarkMetricKeys = keys;

      const roster = selection.get(); // CHECKED players only — see doc comment above
      if (!benchmarkAnchorId || !roster.some((p) => p.id === benchmarkAnchorId)) {
        benchmarkAnchorId = roster[0]?.id ?? null;
      }

      const groups = groupMetricsByKind(eligible);

      els.metricControls.innerHTML = `
        <span class="graph-control-label">Anchor</span>
        <select class="select graph-metric-select" data-role="benchmark-anchor" ${roster.length === 0 ? "disabled" : ""}>
          ${
            roster.length
              ? roster
                  .map((p) => `<option value="${escAttr(p.id)}" ${p.id === benchmarkAnchorId ? "selected" : ""}>${escHtml(p.name)}</option>`)
                  .join("")
              : `<option value="">Check a player below first</option>`
          }
        </select>
        <span class="graph-control-label">Metrics</span>
        <div class="dropdown graph-benchmark-metrics" data-role="benchmark-metrics-dropdown">
          <button type="button" class="select dropdown__toggle" data-role="benchmark-metrics-toggle" aria-haspopup="true" aria-expanded="false"></button>
          <div class="dropdown__panel graph-benchmark-metrics__panel" data-role="benchmark-metrics-panel" hidden>
            ${groups
              .map(
                (g) => `
              <div class="graph-benchmark-metrics__group-label">${escHtml(g.label)}</div>
              ${g.metrics
                .map(
                  (m) => `<label class="dropdown__item">
                    <input type="checkbox" data-metric-key="${escAttr(m.key)}" ${keys.includes(m.key) ? "checked" : ""} />
                    <span>${escHtml(m.label)}</span>
                  </label>`
                )
                .join("")}`
              )
              .join("")}
          </div>
        </div>
      `;

      const anchorSel = els.metricControls.querySelector('[data-role="benchmark-anchor"]');
      if (anchorSel) {
        anchorSel.addEventListener("change", (e) => {
          benchmarkAnchorId = e.target.value || null;
          // item 4: an explicit benchmark configuration counts as "a metric
          // chosen" for the Recommended-tag gate (benchmark has no single
          // metric — anchor + the metric set together specify it).
          metricEverChosen = true;
          syncChartTypeButtons();
          // "Changing anchor re-renders, no refetch" (task brief) — enforced
          // by renderChart()'s pool cache (keyed on scope+metrics, NOT
          // anchor), not by anything special here; scheduleRender is the
          // same call every other control makes.
          scheduleRender({ paramsChanged: true });
        });
      }

      const metricsToggle = els.metricControls.querySelector('[data-role="benchmark-metrics-toggle"]');
      const metricsPanel = els.metricControls.querySelector('[data-role="benchmark-metrics-panel"]');
      const metricCheckboxes = () => els.metricControls.querySelectorAll('[data-role="benchmark-metrics-panel"] input[type="checkbox"]');

      // Min-4/max-12 guard, same "disable the box(es) that would violate the
      // floor/cap" idiom as filters.js's format/team-type dropdowns (there,
      // a min-1 floor disables the sole remaining checked box; here the
      // floor is 4, so ALL checked boxes are disabled once exactly 4 remain,
      // and all UNchecked boxes are disabled once 12 are already checked).
      function syncBenchmarkMetricsUI() {
        metricsToggle.textContent = `${benchmarkMetricKeys.length} of ${eligible.length} metrics`;
        metricCheckboxes().forEach((cb) => {
          const checked = benchmarkMetricKeys.includes(cb.dataset.metricKey);
          cb.checked = checked;
          const atFloor = checked && benchmarkMetricKeys.length <= 4;
          const atCap = !checked && benchmarkMetricKeys.length >= 12;
          cb.disabled = atFloor || atCap;
          cb.closest(".dropdown__item").classList.toggle("is-disabled", atFloor || atCap);
          cb.title = atFloor ? "Pick at least 4 metrics" : atCap ? "Pick at most 12 metrics" : "";
        });
      }
      syncBenchmarkMetricsUI();

      metricCheckboxes().forEach((cb) => {
        cb.addEventListener("change", () => {
          const k = cb.dataset.metricKey;
          const set = new Set(benchmarkMetricKeys);
          if (cb.checked) {
            if (set.size >= 12) {
              cb.checked = false; // defensive: disabled should already prevent this
              return;
            }
            set.add(k);
          } else {
            if (set.size <= 4) {
              cb.checked = true; // defensive: disabled should already prevent this
              return;
            }
            set.delete(k);
          }
          benchmarkMetricKeys = [...set];
          metricEverChosen = true; // item 4: benchmark metric-set edit counts
          syncBenchmarkMetricsUI();
          syncChartTypeButtons();
          scheduleRender({ paramsChanged: true });
        });
      });

      // JUDGMENT CALL (flagged): unlike the roster dropdown (static markup,
      // wired once), this panel is rebuilt fresh on every renderMetricControls()
      // call while Benchmark is active (chart-type switch, scope change, or a
      // roster change via the onChange hook above) — each rebuild calls
      // wireDropdown() again on the FRESH toggle/panel nodes, which attaches
      // new document-level click/Escape listeners without tearing down the
      // previous rebuild's (now-detached) ones. Those stale listeners are
      // inert no-ops (a detached panel can never `.contains()` a live click
      // target) and bounded by "how many times this session rebuilds this
      // one dropdown" — not unbounded growth, and not a correctness bug — so
      // this is accepted rather than adding a teardown API to the shared
      // wireDropdown() helper for one control.
      if (metricsToggle && metricsPanel) wireDropdown(metricsToggle, metricsPanel);
    }
  }

  // ── Player list UI (Batch 8, task 1 — v1's two-list model) ─────────────────
  //
  // The vertical always-visible list is gone; in its place, a dropdown BUTTON
  // ("N of M selected") opens a checkbox panel with one row per CANDIDATE
  // (the full pool, never truncated): checkbox (checked = plotted) + name +
  // a muted meta + a small × (remove from the pool entirely). Above the rows,
  // a "Show: Manual | Best | Worst" segmented appears ONLY once there are more
  // candidates than the active chart type can plot (v1's rankAndApply gate) —
  // Best/Worst re-derive `checked` by rank (see deriveChecked() above);
  // Manual leaves whatever's checked alone.
  //
  // Checkbox interaction (judgment call, documented): ANY manual tick/untick
  // always works, regardless of which mode segment is currently highlighted —
  // the task brief describes the cap-disable rule for checkboxes without
  // gating them behind "Manual" mode, and v1's own toggleSelCheck() likewise
  // never checks state.selRank. But unlike v1 (which lets a manual override
  // sit quietly under a still-"Best"-labeled segmented until the next
  // recompute silently erases it), this app's whole roster-provenance model
  // (players.js's `dirty` flag -> card.js's honest "top N" vs "N players"
  // title phrasing) exists specifically so a manual edit is never silently
  // overwritten without the user noticing — so a checkbox toggle here ALSO
  // flips the mode to "manual" (freezing it from further auto-recompute)
  // rather than leaving Best/Worst still displayed as active over a set a
  // human just hand-edited. This is a deliberate, documented deviation from
  // v1's literal mechanics in favor of this codebase's existing honesty rule.
  //
  // "Muted meta" per row: this app's row shape only ever carries {id, name}
  // (players.js's seed/search queries project nothing else — team/country
  // isn't selected, and adding it would be a NEW SQL column, barred by this
  // batch's "zero SQL changes" rule). So the meta is the candidate's own
  // position in the pool ("#3"), which needs no query at all and is always
  // available immediately: for a fresh seed it doubles as "rank by the
  // table's active sort"; for search-added players it's simply append order.
  // A real per-player attribute (team, say) would be more informative but is
  // out of scope here — flagged in the batch report as a follow-up candidate.

  function rosterModeLabel(mode) {
    if (mode === "best") return "Best";
    if (mode === "worst") return "Worst";
    return "Manual";
  }

  // Owner point 13: at ~2,800 candidates, rendering every pool row is both a
  // DOM/perf hazard and unusable — so once the pool exceeds this, the roster
  // shows a filter-as-you-type box and renders only the first N matches, with
  // a "type to narrow" note. The POOL is never capped (that's the whole point
  // of point 13); only what's RENDERED here is.
  const ROSTER_RENDER_CAP = 50;

  function renderPlayerList() {
    const checkedCount = selection.checkedCount();
    const candidates = selection.getFull();
    const total = candidates.length;
    const cap = activeMaxCap();
    const mode = selection.getMode();

    els.rosterToggle.textContent = `${checkedCount} of ${total} selected`;
    els.rosterToggle.title = mode !== "manual" ? `Auto-selected: ${rosterModeLabel(mode)}` : "";

    // "Show: Manual | Best | Worst" only once there's an actual choice to make
    // (more candidates than this chart type can plot) — task brief.
    const showModeSwitch = total > cap;
    els.rosterMode.hidden = !showModeSwitch;
    if (showModeSwitch) {
      els.rosterMode.querySelectorAll(".segmented__btn").forEach((btn) => {
        btn.classList.toggle("is-active", btn.dataset.value === mode);
      });
    }

    // The filter box only appears when there are more candidates than we
    // render at once — a short pool needs no filtering.
    els.rosterFilterWrap.hidden = total <= ROSTER_RENDER_CAP;

    if (total === 0) {
      els.rosterList.innerHTML = `<p class="graph-player-search__empty">No players yet — search above or use Filters.</p>`;
      return;
    }

    // Filter by name (case-insensitive) but keep each candidate's REAL pool
    // position — the "#N" meta doubles as its seed rank, so it must reflect the
    // untouched pool order, not the filtered index. Map before filtering.
    const filter = rosterFilterText.trim().toLowerCase();
    const withIdx = candidates.map((p, i) => ({ p, i }));
    const matched = filter ? withIdx.filter(({ p }) => p.name.toLowerCase().includes(filter)) : withIdx;

    if (matched.length === 0) {
      els.rosterList.innerHTML = `<p class="graph-player-search__empty">No players match &ldquo;${escHtml(rosterFilterText.trim())}&rdquo;.</p>`;
      return;
    }

    const shown = matched.slice(0, ROSTER_RENDER_CAP);
    const hiddenCount = matched.length - shown.length;

    els.rosterList.innerHTML =
      shown
        .map(({ p, i }) => {
          const checked = selection.isChecked(p.id);
          const atCap = !checked && checkedCount >= cap;
          const title = atCap
            ? `Max ${cap}${chartType ? " for this chart type" : " before picking a chart type"} — untick one first`
            : checked
              ? "Remove from graph"
              : "Add to graph";
          return `<div class="dropdown__item graph-roster-item${atCap ? " is-disabled" : ""}" data-id="${escAttr(p.id)}">
              <input type="checkbox" data-role="roster-check" data-id="${escAttr(p.id)}" ${checked ? "checked" : ""} ${atCap ? "disabled" : ""} title="${escAttr(title)}" />
              <span class="graph-roster-item__name">${escHtml(p.name)}</span>
              <span class="graph-roster-item__meta">#${i + 1}</span>
              <button type="button" class="icon-btn graph-roster-item__remove" data-role="remove-candidate" data-id="${escAttr(p.id)}" title="Remove from list">&times;</button>
            </div>`;
        })
        .join("") +
      (hiddenCount > 0
        ? `<p class="graph-roster-more">Showing ${shown.length} of ${matched.length}${filter ? " matches" : ""} — type to narrow (${hiddenCount} more).</p>`
        : "");

    els.rosterList.querySelectorAll('[data-role="roster-check"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.id;
        // Freeze auto-recompute BEFORE toggling — see the doc comment above:
        // any manual tick means the mode segmented should already read
        // "Manual" by the time toggleChecked's own onChange (below) re-renders
        // the panel, not one render-pass later.
        selection.setMode("manual");
        const result = selection.toggleChecked(id);
        if (!result.ok && result.reason === "cap") {
          showCapNote(`Can't select — this chart type is capped at ${result.cap} players. Untick one first.`);
          cb.checked = false; // defensive: disabled should already prevent this
          renderPlayerList(); // toggleChecked's own onChange didn't fire on this failure path
          return;
        }
        clearCapNote();
      });
    });
    els.rosterList.querySelectorAll('[data-role="remove-candidate"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        selection.removeCandidate(id);
        // Removing a candidate may have freed a slot best/worst should refill
        // from the rest of the pool; a manual removal just re-renders as-is.
        if (selection.getMode() !== "manual") deriveChecked(selection.getMode());
      });
    });
  }

  wireDropdown(els.rosterToggle, els.rosterPanel);

  // Owner point 13: filter-as-you-type over the (full) pool. The input lives in
  // the static panel markup (not rebuilt by renderPlayerList), so typing keeps
  // focus while only the list below re-renders.
  els.rosterFilter.addEventListener("input", () => {
    rosterFilterText = els.rosterFilter.value;
    renderPlayerList();
  });
  // Keep the panel open when interacting with the filter box (wireDropdown's
  // document click-to-close ignores clicks inside the panel, so this is just
  // belt-and-braces against the toggle handler).
  els.rosterFilter.addEventListener("click", (e) => e.stopPropagation());

  els.rosterMode.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    const newMode = btn.dataset.value;
    if (newMode === selection.getMode()) return;
    if (newMode === "manual") {
      selection.setMode("manual");
      renderPlayerList();
    } else {
      deriveChecked(newMode);
    }
  });

  let searchDebounce = null;
  els.playerSearch.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    const term = els.playerSearch.value.trim();
    if (!term) {
      els.playerSearchResults.hidden = true;
      els.playerSearchResults.innerHTML = "";
      return;
    }
    searchDebounce = setTimeout(async () => {
      try {
        // Owner point 9: search no longer excludes pool members (the pool is
        // now the whole filtered set, so excluding it hid EVERYONE). Matches
        // already in the roster are marked and, on click, simply (re)checked.
        const results = await searchPlayers(store, term);
        els.playerSearchResults.innerHTML =
          results
            .map((r) => {
              const inPool = selection.has(r.id);
              const meta = inPool ? (selection.isChecked(r.id) ? " (on chart)" : " (in list)") : "";
              return `<button type="button" class="graph-player-search__item" data-id="${escAttr(r.id)}" data-name="${escAttr(r.name)}">${escHtml(r.name)}${
                meta ? `<span class="graph-player-search__item-meta">${escHtml(meta)}</span>` : ""
              }</button>`;
            })
            .join("") || `<p class="graph-player-search__empty">No matches.</p>`;
        els.playerSearchResults.hidden = false;

        els.playerSearchResults.querySelectorAll(".graph-player-search__item").forEach((btn) => {
          btn.addEventListener("click", () => {
            const id = btn.dataset.id;
            const name = btn.dataset.name;
            if (selection.has(id)) {
              // Already a candidate — check it (make it plot) instead of the
              // old dead "already selected" no-op, so a searched name is never
              // a dead end. Freeze auto-recompute first, same as the roster
              // checkbox does, since this is a deliberate manual pick.
              if (!selection.isChecked(id)) {
                selection.setMode("manual");
                const res = selection.toggleChecked(id);
                if (!res.ok && res.reason === "cap") {
                  showCapNote(`Can't plot ${name} — ${capSubjectLabel()} is capped at ${activeMaxCap()} players. Untick one first.`);
                } else {
                  clearCapNote();
                }
              } else {
                showCapNote(`${name} is already on the chart.`);
              }
            } else {
              // A brand-new candidate (e.g. from a wider search than the
              // current pool) — the pool is never truncated; `checked` is
              // false only if the active chart type is already at cap.
              const result = selection.addCandidate({ id, name });
              if (result.ok && !result.checked) {
                showCapNote(`Added to your list, but ${capSubjectLabel()} is capped at ${activeMaxCap()} players — untick one to plot them instead.`);
              } else {
                clearCapNote();
              }
            }
            els.playerSearch.value = "";
            els.playerSearchResults.hidden = true;
            els.playerSearchResults.innerHTML = "";
          });
        });
      } catch (e) {
        els.playerSearchResults.innerHTML = `<p class="graph-player-search__empty">Search failed: ${escHtml(e.message ?? "unknown error")}</p>`;
        els.playerSearchResults.hidden = false;
      }
    }, 250);
  });

  document.addEventListener("click", (e) => {
    if (container.contains(e.target) && (e.target === els.playerSearch || e.target.closest('[data-role="player-search"]'))) return;
    if (container.contains(e.target) && e.target.closest('[data-role="player-search-results"]')) return;
    els.playerSearchResults.hidden = true;
  });

  els.resetPlayers.addEventListener("click", async () => {
    await seedSelection({ force: true });
  });

  // ── Chart type switching ──────────────────────────────────────────────────

  // ── Recommend engine (Batch 8, task 2 — v1's recommend()) ──────────────────
  //
  // v1's own recommend() ranks chart types by how many METRICS the user has
  // checked in a single shared multi-select (1 metric -> Bar, exactly 2
  // rate/pct metrics -> Scatter, 3+ -> Radar, all-"total" -> Donut, …) — that
  // has no analogue here: every chart type in this app owns ITS OWN metric
  // picker (bar's one select, scatter's X+Y, radar's whole group, …), so
  // there is no single shared "how many metrics are checked" signal to rank
  // by. The dimension that actually varies chart-type fit in THIS app is the
  // PLAYER pool (each type's CHART_CAPS min/max) plus whether a metric/group/
  // family even exists for the type under the current discipline/format
  // scope — so this port keeps v1's STRUCTURE (ok/disabled + a reason per
  // type; one "exactly fits" type gets a Recommended tag) but re-derives the
  // ranking from player count + metric/group/family availability instead.

  /** ok/disabled + an honest one-line reason for `typeKey` under the CURRENT
   * scope/candidate pool. The player-count floor uses the CANDIDATE pool
   * (selection.candidateCount()), not the checked count — switching TO a
   * type re-derives checked from the whole pool up to that type's own cap,
   * so what actually gates a type is "can the pool satisfy this type's
   * minimum at all", not how many happen to be checked under some OTHER
   * type's cap right now. There is no equivalent "too many" gate — an
   * over-supply of candidates never disables a type here, it just leaves
   * some unchecked (players.js's cap-clamp), unlike v1 where exceeding a
   * metric-count max was a hard disqualifier. */
  function evaluateTypeStatus(typeKey, state, { candidateCountOverride, poolReasonOverride } = {}) {
    // decision 46f: an empty pool (never searched Stats, or a real search
    // that matched nobody) blocks EVERY type the same honest way, before any
    // type-specific check runs — see poolStatusReason()'s doc comment.
    // `poolReasonOverride`/`candidateCountOverride` (owner decision 46, the
    // "Graph this player" chooser) let a caller ask "would this type work if
    // `player` were already in the pool?" without touching the real
    // selection — see evaluateChartTypesForPlayerImpl() below, the chooser's
    // one reuse point for this exact predicate (never a second copy of these
    // reasons/strings).
    const poolReason = poolReasonOverride !== undefined ? poolReasonOverride : poolStatusReason();
    if (poolReason) return { ok: false, reason: poolReason };
    if (typeKey === "donut" && donutEligibleMetrics(state.discipline, state.formats).length === 0) {
      return { ok: false, reason: "Needs a countable stat" };
    }
    if (typeKey === "radar" && eligibleRadarGroups(state.discipline, state.formats).length === 0) {
      return { ok: false, reason: "No metric groups available for this scope" };
    }
    if (typeKey === "phases" && eligiblePhaseFamilies(state.discipline, state.formats).length === 0) {
      return { ok: false, reason: "No phase metric families available for this scope" };
    }
    if (typeKey === "slope" && eligibleMetrics(state.discipline, state.formats).filter((m) => m.kind === "rate" || m.kind === "percent").length === 0) {
      return { ok: false, reason: "No rate/percent metric available for this scope" };
    }
    if (typeKey === "byyear" && eligibleMetrics(state.discipline, state.formats).filter((m) => timeseriesSupported(m)).length === 0) {
      return { ok: false, reason: "No year-by-year metric available for this scope" };
    }
    if (typeKey === "dumbbell" && eligibleMetrics(state.discipline, state.formats).filter((m) => m.kind === "rate" || m.kind === "percent").length === 0) {
      return { ok: false, reason: "No rate/percent metric available for this scope" };
    }
    // B8b (decision 44e): needs >=1 checked player (the anchor — covered by
    // the generic candidateCount/capDef.min check below, since
    // CHART_CAPS.benchmark.min is 1) AND >=4 metrics available to choose from
    // right now. The picker itself (renderMetricControls' benchmark branch)
    // always keeps >=4 CHOSEN whenever >=4 are eligible, so the only way this
    // can actually fail is a scope so metric-starved fewer than 4 qualify at
    // all — kept as an explicit, honestly-worded disabled reason rather than
    // silently falling through to a confusing "Add at least 1 player" alone.
    if (typeKey === "benchmark" && benchmarkEligibleMetrics(state.discipline, state.formats).length < 4) {
      return { ok: false, reason: "Not enough eligible metrics for this scope" };
    }
    const capDef = CHART_CAPS[typeKey];
    const candidateCount = candidateCountOverride !== undefined ? candidateCountOverride : selection.candidateCount();
    if (candidateCount < capDef.min) {
      return { ok: false, reason: `Add at least ${capDef.min} player${capDef.min === 1 ? "" : "s"}` };
    }
    return { ok: true, reason: null };
  }

  /**
   * The single best-fit type among the OK ones, for the current candidate
   * pool size — v1's "prefer the type whose constraints the current state
   * exactly satisfies" re-expressed over player count (see the file header
   * comment above for why metric-count doesn't translate):
   *   1. Scatter, once there's a proper crowd (>= 10 candidates) — its whole
   *      niche (up to 60 players, uncapped-feeling) is the one type that
   *      wants MORE players, not fewer, so a big pool is its "exact fit".
   *   2. Radar, for a small handful within its own tight ceiling (2..6
   *      candidates) — shape comparison is cluttered past a few players,
   *      exactly radar's own cap.
   *   3. Donut, when the pool is modest enough (<= 8) that every player gets
   *      an individually-named slice with no "Other" bucket needed yet — the
   *      cleanest, most literal "share of a total" read.
   *   4. Bar — the general-purpose default once none of the above's tighter
   *      niche applies.
   *   5. Everything else (phases/slope/byyear/dumbbell, plus donut/scatter/
   *      radar outside their niches above) — specialized lenses, only ever
   *      recommended when they are the SOLE ok type (never displace the
   *      general-purpose picks above), mirroring how v1 never recommends its
   *      own specialized "arrow" type as a default either.
   */
  function recommendedChartType(state, statuses) {
    const okKeys = CHART_TYPES.map((t) => t.key).filter((k) => statuses[k].ok);
    if (okKeys.length === 0) return null;
    const candidateCount = selection.candidateCount();
    if (okKeys.includes("scatter") && candidateCount >= 10) return "scatter";
    if (okKeys.includes("radar") && candidateCount >= 2 && candidateCount <= CHART_CAPS.radar.max) return "radar";
    if (okKeys.includes("donut") && candidateCount <= 8) return "donut";
    if (okKeys.includes("bar")) return "bar";
    const fallbackOrder = ["donut", "scatter", "radar", "phases", "slope", "byyear", "dumbbell", "benchmark"];
    return fallbackOrder.find((k) => okKeys.includes(k)) ?? okKeys[0];
  }

  function syncChartTypeButtons() {
    const state = store.get();
    const statuses = {};
    for (const t of CHART_TYPES) statuses[t.key] = evaluateTypeStatus(t.key, state);
    // item 4: the "Recommended" tag appears only AFTER a metric has been chosen
    // — never on first paint, so a chart type is never nudged before the user
    // has expressed what they want to measure.
    const recommended = metricEverChosen ? recommendedChartType(state, statuses) : null;

    els.chartType.querySelectorAll(".segmented__btn").forEach((btn) => {
      const key = btn.dataset.value;
      const type = CHART_TYPES.find((t) => t.key === key);
      const status = statuses[key];
      btn.classList.toggle("is-active", key === chartType);
      // decision 46f: NEVER html-disabled — every tile stays clickable.
      // "Greyed" is a passive CSS hint only (is-unavailable, styles.css); the
      // actual explanation is a full sentence in the STAGE, written the
      // moment the user clicks the tile (see renderChart()'s evaluateTypeStatus
      // guard) — never a title-only tooltip, so no reason text lives here.
      btn.disabled = false;
      btn.title = "";
      btn.classList.toggle("is-unavailable", !status.ok);
      btn.innerHTML = `${type.label}${key === recommended ? '<span class="graph-chart-type-rec">Recommended</span>' : ""}`;
    });
  }

  // "Bars ⇄ Dots" style toggle — bar chart only (lollipop rendering, same
  // data/caps, purely a chart.js rendering choice — see charts.js). This is
  // NOT a chart "parameter" for the paper card's honesty rule (title/subtitle
  // describe the metric and type, not the drawing style), so switching it
  // re-renders without forcing a title/subtitle regeneration.
  function syncBarStyleVisibility() {
    els.barStyleGroup.hidden = chartType !== "bar";
  }
  function syncBarStyleButtons() {
    els.barStyleToggle.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === barStyle);
    });
  }
  syncBarStyleButtons();

  els.barStyleToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn || btn.dataset.value === barStyle) return;
    barStyle = btn.dataset.value;
    syncBarStyleButtons();
    scheduleRender();
  });

  els.chartType.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    // decision 46f: tiles are never disabled — clicking an unusable one still
    // selects it (renderChart() then shows the honest stage sentence instead
    // of a chart; see evaluateTypeStatus()).
    if (!btn || btn.dataset.value === chartType) return;
    chartType = btn.dataset.value;
    syncChartTypeButtons();
    syncBarStyleVisibility();
    clearCapNote();
    renderMetricControls();
    // The cap (and, for bar/donut/scatter, the ranking metric) just changed
    // with the chart type. In "manual" mode, only trim any genuine overflow
    // (never re-pick). In "best"/"worst" mode, a synchronous silent trim
    // keeps the checked<=cap invariant true for the brief window before the
    // real async re-derivation (which re-ranks from the UNTOUCHED candidate
    // pool under the new cap/metric — this is what makes "switch to a bigger
    // chart type brings hidden players back" still true, see players.js's
    // class doc comment) replaces it moments later.
    if (selection.getMode() === "manual") {
      selection.clampToCap();
    } else {
      selection.clampToCap({ silent: true });
      deriveChecked(selection.getMode());
    }
    renderPlayerList();
    scheduleRender({ paramsChanged: true });
  });

  // ── Export ────────────────────────────────────────────────────────────────

  els.exportBtn.addEventListener("click", async () => {
    els.exportStatus.textContent = "";
    const result = await card.exportPNG(els.exportBtn);
    els.exportStatus.textContent = result.ok ? `Saved ${result.filename}` : `Export failed: ${result.error?.message ?? "unknown error"}`;
  });

  els.copyPngBtn.addEventListener("click", async () => {
    els.exportStatus.textContent = "";
    const result = await card.copyPNG(els.copyPngBtn);
    els.exportStatus.textContent = result.ok ? "Copied to clipboard" : `Copy failed: ${result.error?.message ?? "unknown error"}`;
  });

  // ── Graph-local Filters popup (R3 Wave 3, items 1 + 2) ──────────────────────
  // The graph gets its OWN Filters popup, REUSING the Stats popup's section
  // factories (mountFilters / mountFilterDrawer) bound to the graph-local
  // `store` above — no fork of their internals. The shell is created and
  // appended to <body> by THIS module (index.html / main.js are untouched —
  // document.body append is the established popover pattern, e.g. filters.js's
  // wirePortalDropdown). Changing a graph filter here writes only to the
  // graph-local store; the trigger button ("Apply to graph") applies the graph
  // scope and re-renders the current chart via onScopeChanged().
  const DEFAULT_SORT_KEY = { batting: "runs", bowling: "wickets" };
  const gpopEl = document.createElement("div");
  gpopEl.className = "filters-popup";
  gpopEl.hidden = true;
  gpopEl.setAttribute("data-role", "graph-filters-popup");
  gpopEl.innerHTML = `
    <div class="filters-popup__backdrop" data-role="gfpop-backdrop"></div>
    <div class="filters-popup__panel" role="dialog" aria-modal="true" aria-label="Graph filters" tabindex="-1" data-role="gfpop-panel">
      <div class="filters-popup__header">
        <h2 class="filters-popup__title">Graph filters</h2>
        <button type="button" class="filters-popup__close" data-role="gfpop-close" aria-label="Close">&times;</button>
      </div>
      <div class="filters-popup__body">
        <section class="filters-popup__section">
          <button type="button" class="filters-popup__section-header" data-role="gfpop-section-toggle" aria-expanded="true">
            <span class="filters-popup__section-name">Search Conditions</span>
            <span class="filters-popup__chevron" aria-hidden="true">▾</span>
          </button>
          <div class="filters-popup__section-body">
            <div class="filter-bar" data-role="gfpop-filter-bar"></div>
          </div>
        </section>
        <section class="filters-popup__section">
          <button type="button" class="filters-popup__section-header" data-role="gfpop-section-toggle" aria-expanded="true">
            <span class="filters-popup__section-name">Advanced Filters</span>
            <span class="filters-popup__chevron" aria-hidden="true">▾</span>
          </button>
          <div class="filters-popup__section-body">
            <div data-role="gfpop-advanced-host"></div>
          </div>
        </section>
      </div>
      <div class="filters-popup__footer">
        <button type="button" class="btn btn--primary" data-role="gfpop-apply">Apply to graph</button>
      </div>
    </div>`;
  document.body.appendChild(gpopEl);

  const gfpop = {
    panel: gpopEl.querySelector('[data-role="gfpop-panel"]'),
    backdrop: gpopEl.querySelector('[data-role="gfpop-backdrop"]'),
    close: gpopEl.querySelector('[data-role="gfpop-close"]'),
    apply: gpopEl.querySelector('[data-role="gfpop-apply"]'),
    filterBar: gpopEl.querySelector('[data-role="gfpop-filter-bar"]'),
    advancedHost: gpopEl.querySelector('[data-role="gfpop-advanced-host"]'),
  };

  // Section collapse/expand (same behaviour as main.js's Stats-popup toggles,
  // but keyed off DOM structure so the two popups' section-body ids never
  // collide).
  gpopEl.querySelectorAll('[data-role="gfpop-section-toggle"]').forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const body = toggle.nextElementSibling;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      if (body) body.hidden = expanded;
      toggle.setAttribute("aria-expanded", String(!expanded));
    });
  });

  // The two shared section factories, bound to the graph-local store. Their
  // control changes write to `store` (graph-local) immediately; nothing
  // queries until "Apply to graph" runs onScopeChanged() below. onChange here
  // is a no-op (the graph has no pills/subtitle inside the popup — the card's
  // own footer, via store.describeScope(), is refreshed on apply/render).
  const graphFilterController = mountFilters(
    gfpop.filterBar,
    store,
    () => {},
    () => {},
    () => {}
  );
  const graphDrawerController = mountFilterDrawer(
    { advancedHost: gfpop.advancedHost },
    store,
    { onChange: () => {} }
  );
  {
    const manifest = getManifest();
    const gMin = manifest?.data?.min_match_date || null;
    const gMax = manifest?.data?.max_match_date || null;
    graphFilterController.setDateBounds(gMin, gMax);
  }

  function openGraphPopup() {
    gpopEl.hidden = false;
    graphFilterController.render();
    graphDrawerController.onShow();
    gfpop.panel.focus();
  }
  function closeGraphPopup() {
    gpopEl.hidden = true;
    graphDrawerController.onHide();
  }
  function applyGraphFilters() {
    // Date is required, same rule as the Stats popup (a graph scope seeded from
    // a searched Stats scope always starts with valid dates; block if cleared).
    if (!graphFilterController.validateDate()) {
      const body = gpopEl.querySelector('[data-role="gfpop-filter-bar"]').closest(".filters-popup__section-body");
      const toggle = body?.previousElementSibling;
      if (body) body.hidden = false;
      if (toggle) toggle.setAttribute("aria-expanded", "true");
      return;
    }
    if (!graphDrawerController.validate()) return;
    // Keep the graph-local store coherent after scope edits, exactly as the
    // Stats side does: drop columns/conditions the new scope orphaned, and fall
    // back the sort key when it no longer resolves in the (possibly switched)
    // discipline — seedFromFilteredSet ranks by state.sort, so a stale key
    // would break the seed query.
    pruneIneligibleState(store);
    const gs = store.get();
    if (!getMetric(gs.sort.key, gs.discipline)) {
      store.set({ sort: { key: DEFAULT_SORT_KEY[gs.discipline] || "runs", dir: "desc" } });
    }
    closeGraphPopup();
    onScopeChanged();
  }

  gfpop.close.addEventListener("click", closeGraphPopup);
  gfpop.backdrop.addEventListener("click", closeGraphPopup);
  gfpop.apply.addEventListener("click", applyGraphFilters);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !gpopEl.hidden) closeGraphPopup();
  });

  // The "Filters" button in the graph controls (item 2).
  container.querySelector('[data-role="graph-filters-open"]').addEventListener("click", openGraphPopup);

  // "← Back to your table" (item 5): return to the Stats view with the existing
  // table intact. main.js/index.html are off-limits, so this drives the
  // existing Stats view toggle button — whose main.js handler restores the
  // cached table rows via applyView()/enterView() with NO re-query and no state
  // loss — rather than re-implementing the view switch here.
  container.querySelector('[data-role="graph-back"]').addEventListener("click", () => {
    const statsBtn = document.querySelector('[data-role="view"] .segmented__btn[data-value="table"]');
    if (statsBtn) statsBtn.click();
  });

  /** Re-inherit the Stats scope into the graph-local store when a NEW Stats
   * search has changed it since the last seed (item 1's re-seed rule). Returns
   * true when it actually re-seeded. A re-seed discards the graph's own filter
   * edits AND the scope-derived window defaults (so Slope/Dumbbell windows
   * re-initialise from the fresh date range); it deliberately keeps the chosen
   * chart type + metric (decision 46f: scope never silently swaps the type). */
  function seedGraphScopeFromStats() {
    const statsState = statsStore.get();
    const key = scopeSeedKey(statsState);
    if (key === lastStatsScopeKey) return false;
    lastStatsScopeKey = key;
    store.set(cloneState(statsState));
    slopeWindowA = null;
    slopeWindowB = null;
    dumbbellWindowA = null;
    dumbbellWindowB = null;
    graphFilterController.render();
    return true;
  }

  // ── Seeding ───────────────────────────────────────────────────────────────

  /**
   * Every state field the seed query actually reads, so a scope change that
   * changes the underlying filtered SET always reseeds the roster (Batch 3
   * fix 5). Traced through players.js's seedFromFilteredSet -> table.js's
   * buildQuery/buildMatchupQuery -> filters.js's buildScopeClauses:
   *   discipline, gender, formats, dateFrom/dateTo, teams, teamType — the
   *     base scope clauses.
   *   positions, opposition — the innings-level filters (buildScopeClauses'
   *     includePositions/oppositionColumn options, both passed true/set by
   *     buildQuery); positionsFilterActive/oppositionFilterActive also read
   *     discipline/teamType/matchupVs/gender, all already covered.
   *   profile — profileSemiJoinSql's semi-join (reads gender + the profile
   *     fields as one block).
   *   minInnings, advanced — the HAVING gate + stat conditions.
   *   search — the name ILIKE clause (buildQuery/buildMatchupQuery apply it
   *     unconditionally, not just while the table view is showing it).
   *   sort — ranking, so the top-N slice itself changes.
   *   matchupVs — buildMatchupQuery's bucket predicate AND the
   *     discipline/matchupVs pair together decide whether buildQuery even
   *     takes the matchup path at all (state.js's matchupVsActive).
   * Previously omitted positions/opposition/profile/matchupVs/search, so e.g.
   * narrowing to openers-only (a position filter) left a stale middle-order
   * roster seeded from before the filter was applied.
   */
  function scopeSeedKey(state) {
    return JSON.stringify([
      state.discipline, state.gender, state.formats, state.dateFrom, state.dateTo,
      state.teams, state.teamType, state.minInnings, state.advanced, state.sort,
      state.search, state.positions, state.regularPositions, state.opposition,
      state.profile, state.matchupVs,
    ]);
  }

  async function seedSelection({ force = false } = {}) {
    // decision 46f: never query before Stats has been searched at least once
    // — Graphs entering the empty-state (no pool at all) must not run a query
    // of its own; the guidance line explains why (poolStatusReason()).
    if (!hasStatsResults()) return;
    const state = store.get();
    const key = scopeSeedKey(state);
    if (!force && seeded && key === lastSeedKey) return;
    try {
      // The candidate POOL is the ENTIRE filtered result set (owner point 13 —
      // no 15-cap): the roster dropdown filters/renders a slice of it and each
      // chart type caps only what's CHECKED (deriveChecked()), never the pool.
      const seedPlayers = await seedFromFilteredSet(store);
      seeded = true;
      lastSeedKey = key;
      // Record what ranked this seed (Batch 3 part 2 title honesty) — the
      // table's/graph's active sort at the moment seedFromFilteredSet ran,
      // tied to the discipline it ran under so a later discipline switch
      // can't misattribute a stale key to the wrong metric namespace.
      seedSortKey = state.sort.key;
      seedSortDiscipline = state.discipline;
      clearCapNote();
      // Batch 8 (task 1): a fresh seed replaces the candidate POOL only —
      // `checked` is then derived per the CURRENTLY active mode ("auto-check
      // per the active mode", task brief; default "best"). A reseed always
      // lands in "best" if the previous mode was "manual": manual picks were
      // made against the OLD pool and have no meaning against a brand new
      // one, whereas an explicit "best"/"worst" preference is about HOW to
      // auto-pick, not which specific pool it's applied to, so it persists.
      selection.setCandidates(seedPlayers);
      const modeForReseed = selection.getMode() === "manual" ? "best" : selection.getMode();
      await deriveChecked(modeForReseed);
    } catch (e) {
      showErrorStatus(e, () => seedSelection({ force: true }));
    }
  }

  /** The metric that actually ranked the CURRENT checked set, resolved for
   * `discipline` — or null if unknown/inapplicable. Prefers the per-type
   * Best/Worst ranking metric (lastRankMetricKey — bar/donut/scatter-Y only)
   * when one was used; otherwise falls back to whatever metric ranked the
   * original SQL seed (seedSortKey — the table's active sort at seed time),
   * which is exactly right for the "seed sort" fallback types (radar/phases/
   * slope/byyear/dumbbell) since their checked set's order literally IS that
   * seed order (or its reverse, for "worst"). Returns null if there's been no
   * seed yet, or either happened under a DIFFERENT discipline (a scope change
   * should have already triggered a reseed via onScopeChanged; if it somehow
   * hasn't, this falls back to "unknown provenance" rather than attributing a
   * metric from the wrong namespace). */
  function resolveSeedMetric(discipline) {
    if (lastRankMetricKey && lastRankMetricDiscipline === discipline) {
      return getMetric(lastRankMetricKey, discipline) || null;
    }
    if (!seedSortKey || seedSortDiscipline !== discipline) return null;
    return getMetric(seedSortKey, discipline) || null;
  }

  /** roster-provenance block passed to card.js on every config — see its
   * rankedCountPhrase() doc comment for how {dirty, seedByMetric} become the
   * title's "top N" / "top N by X" / "N players" phrasing. */
  function currentRosterMeta(discipline) {
    return { dirty: selection.isDirty(), seedByMetric: resolveSeedMetric(discipline) };
  }

  /** Item 4: honest "no metric chosen / chosen metric invalid here" sentence
   * for a single-metric chart type. Reached only when eligible metrics DO
   * exist for the type (evaluateTypeStatus already blocks metric-starved
   * scopes with their own reasons), so this is always about the user's own
   * pick — never a silent auto-swap. */
  function noMetricGuidance(typeLabel) {
    if (metricEverChosen && chosenMetricKey) {
      const m = getMetric(chosenMetricKey, store.get().discipline);
      return `${m ? m.label : "That metric"} can't be shown on ${typeLabel} — choose another metric.`;
    }
    return `Choose a metric to draw ${typeLabel}.`;
  }

  /** Show a one-line guidance sentence in the stage IN PLACE OF a chart (item 4
   * — no graph while under-specified) and tear down any chart still on screen. */
  function showChartGuidance(text) {
    hideStatus();
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    renderExclusions([]);
    showStageGuidance(text);
  }

  /** Build a title-only chart config for the CURRENT chart-type controls —
   * used when there isn't (yet) a real chart to draw (zero players, or below
   * the chart type's minimum) but the card must still show an honest title
   * naming the actual roster size instead of a stale one left over from the
   * last real chart (Batch 3 part 2, fix 3). Returns null only if the current
   * chart type has no valid metric/group selected at all (nothing to title). */
  function buildTitleOnlyConfig(playerCount) {
    const state = store.get();
    const discipline = state.discipline;
    const roster = currentRosterMeta(discipline);
    if (chartType === "bar") {
      const metric = getMetric(barMetricKey, discipline);
      return metric ? { type: "bar", discipline, metric, playerCount, roster } : null;
    }
    if (chartType === "donut") {
      const metric = getMetric(donutMetricKey, discipline);
      return metric ? { type: "donut", discipline, metric, playerCount, roster } : null;
    }
    if (chartType === "scatter") {
      const metricX = getMetric(scatterXKey, discipline);
      const metricY = getMetric(scatterYKey, discipline);
      return metricX && metricY ? { type: "scatter", discipline, metricX, metricY, playerCount, roster } : null;
    }
    if (chartType === "radar") {
      const groups = eligibleRadarGroups(discipline, state.formats);
      const group = groups.find((g) => g.id === radarGroupId); // item 4: no auto-pick
      return group ? { type: "radar", discipline, group, playerCount, roster } : null;
    }
    if (chartType === "phases") {
      const families = eligiblePhaseFamilies(discipline, state.formats);
      const family = families.find((f) => f.id === phaseFamilyId); // item 4: no auto-pick
      return family ? { type: "phases", discipline, family, playerCount, roster } : null;
    }
    if (chartType === "slope") {
      const metrics = eligibleMetrics(discipline, state.formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      const metric = metrics.find((m) => m.key === slopeMetricKey); // item 4: no auto-pick
      return metric
        ? {
            type: "slope",
            discipline,
            metric,
            windowA: slopeWindowA,
            windowB: slopeWindowB,
            windowALabel: windowLabel(slopeWindowA),
            windowBLabel: windowLabel(slopeWindowB),
            playerCount,
            roster,
          }
        : null;
    }
    if (chartType === "byyear") {
      const metrics = eligibleMetrics(discipline, state.formats).filter((m) => timeseriesSupported(m));
      const metric = metrics.find((m) => m.key === byYearMetricKey); // item 4: no auto-pick
      return metric ? { type: "byyear", discipline, metric, playerCount, roster } : null;
    }
    if (chartType === "dumbbell") {
      const metrics = eligibleMetrics(discipline, state.formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      const metric = metrics.find((m) => m.key === dumbbellMetricKey); // item 4: no auto-pick
      // labelA/labelB and sideAKey/sideBKey mirror what the render branch
      // emits (see below) so card.js's autoTitle/regenKeyFor read the same
      // window vocabulary here as there — sideAKey/sideBKey carry the window
      // ranges (not Vs buckets), so a window change invalidates a hand-edited
      // title exactly like a metric change does.
      return metric
        ? {
            type: "dumbbell",
            discipline,
            metric,
            labelA: windowLabel(dumbbellWindowA),
            labelB: windowLabel(dumbbellWindowB),
            sideAKey: dumbbellWindowA ? `${dumbbellWindowA.from}:${dumbbellWindowA.to}` : null,
            sideBKey: dumbbellWindowB ? `${dumbbellWindowB.from}:${dumbbellWindowB.to}` : null,
            windowA: dumbbellWindowA,
            windowB: dumbbellWindowB,
            playerCount,
            roster,
          }
        : null;
    }
    if (chartType === "benchmark") {
      // B8b: title provenance does NOT use the roster-count phrasing every
      // other type's config carries (rankedCountPhrase's "top N"/"N players")
      // — the title is just "<Anchor> vs the field" (card.js's autoTitle),
      // naming the anchor, never a count. `roster`/`playerCount` are still
      // threaded through the config for shape-consistency with every other
      // branch (and in case a later feature wants them), but autoTitle's
      // benchmark case never reads them. Flagged per the task brief's ask.
      const rosterList = selection.get();
      const anchor = rosterList.find((p) => p.id === benchmarkAnchorId) || rosterList[0] || null;
      const keys = benchmarkMetricKeys || [];
      const metrics = keys.map((k) => getMetric(k, discipline)).filter(Boolean);
      return keys.length
        ? {
            type: "benchmark",
            discipline,
            anchorId: anchor?.id ?? null,
            anchorName: anchor?.name ?? null,
            metricKeys: keys,
            metrics,
            playerCount,
            roster,
          }
        : null;
    }
    return null;
  }

  /** The scope/footer text for the card: the honest filter-scope sentence,
   * plus — for Slope ONLY — the two explicit date windows (§8.4: the footer
   * must state exactly what's applied, and the windows are real parameters
   * of that chart the global scope sentence knows nothing about). */
  function buildFooterScope(config) {
    const base = store.describeScope();
    if (config && config.type === "slope") {
      const a = config.windowALabel ?? windowLabel(config.windowA);
      const b = config.windowBLabel ?? windowLabel(config.windowB);
      if (!a || !b) return base;
      return `${base} · Window A: ${a} · Window B: ${b}`;
    }
    if (config && config.type === "dumbbell") {
      // Time-window Dumbbell: the footer states both windows explicitly (§8.4)
      // — identical shape to slope's window footer above (owner correction:
      // the sides are date windows, not Pace/Spin buckets).
      const a = config.labelA ?? windowLabel(config.windowA);
      const b = config.labelB ?? windowLabel(config.windowB);
      if (!a || !b) return base;
      return `${base} · Window A: ${a} · Window B: ${b}`;
    }
    if (config && config.type === "benchmark") {
      // B8b: "Footer states the pool honestly" (task brief) — the plain
      // filter scope sentence, plus the sample floors actually backing the
      // CURRENTLY selected rate/percent metrics (nothing stated if none of
      // them are rate/percent — no floor applies to pure totals).
      const floors = benchmarkFloorNotes(config.metrics || []);
      return floors.length ? `${base} · rates/percents: ${floors.join(", ")}` : base;
    }
    return base;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function renderExclusions(excluded, extra) {
    const notes = [];
    if (excluded && excluded.length) {
      notes.push(`Excluded (no data): ${excluded.map(escHtml).join(", ")}`);
    }
    if (extra) notes.push(extra);
    if (notes.length) {
      els.exclusions.innerHTML = notes.map((n) => `<p>${n}</p>`).join("");
      els.exclusions.hidden = false;
    } else {
      els.exclusions.hidden = true;
      els.exclusions.innerHTML = "";
    }
  }

  async function renderChart() {
    const state = store.get();
    const discipline = state.discipline;
    const token = ++loadToken;

    // decision 46f: no chart type picked yet — no chart, no chart-shaped
    // placeholder either. Just the honest stage guidance (empty-state /
    // "pick a chart type", per poolStatusReason()) in place of the whole card.
    if (!chartType) {
      hideStatus();
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
      renderExclusions([]);
      showStageGuidance(poolStatusReason() || "Pick a chart type to get started.");
      return;
    }

    // decision 46f: a type IS picked, but evaluateTypeStatus() says it can't
    // render right now (pool empty, wrong discipline/gender, no eligible
    // metric/group for this scope) — same stage-guidance treatment, one
    // plain-English sentence, never a tooltip. This is checked BEFORE the
    // roster's own min-cap below because it can be true even with plenty of
    // CHECKED players (e.g. Dumbbell on women's cricket has a full roster,
    // just the wrong discipline/gender).
    const typeStatus = evaluateTypeStatus(chartType, state);
    if (!typeStatus.ok) {
      hideStatus();
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
      renderExclusions([]);
      showStageGuidance(typeStatus.reason || "This chart type isn't available right now.");
      return;
    }
    hideStageGuidance();

    const players = selection.get();

    if (players.length === 0) {
      hideStatus();
      card.hidePlaceholder();
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
      // Batch 3 part 2, fix 3 (title honesty): regenerate the title for the
      // ACTUAL (empty) roster rather than leaving whatever a previous real
      // chart said — the card must never claim a chart it isn't drawing.
      const titleCfg = buildTitleOnlyConfig(0);
      if (titleCfg) card.regenerate(titleCfg, buildFooterScope(titleCfg));
      renderExclusions([], "No players selected. Add players or reset to the filtered set.");
      return;
    }

    // Batch 3 (graphs, part 1) — per-chart-type MIN, not just max (decision
    // 43): below it the chart can't be meaningfully drawn, so the paper card
    // shows a short note in place of a chart rather than attempting to draw
    // e.g. a 1-bar "ranking". (For radar, min is 1, so this is already
    // subsumed by the players.length === 0 branch above — kept anyway so the
    // rule reads the same for every chart type.)
    const capDef = CHART_CAPS[chartType];
    if (players.length < capDef.min) {
      hideStatus();
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
      // Batch 3 part 2, fix 3: same title-honesty regeneration as the
      // zero-player branch above — previously this placeholder state kept
      // whatever title the last real chart had (verified live: "Reliability
      // — 6 players" over a 1-player bar placeholder), which is exactly the
      // "claims a chart it isn't drawing" bug this batch fixes.
      const titleCfg = buildTitleOnlyConfig(players.length);
      if (titleCfg) card.regenerate(titleCfg, buildFooterScope(titleCfg));
      card.showPlaceholder(`Add at least ${capDef.min} player${capDef.min === 1 ? "" : "s"} to draw this chart.`);
      renderExclusions([]);
      return;
    }

    card.hidePlaceholder();
    showStatus("Running query…");

    try {
      const roster = currentRosterMeta(discipline);

      // Slope is handled entirely separately from the bar/donut/scatter/
      // radar/phases chain below: it needs TWO independent queries (one per
      // date window, via fetchWindowMetric — see charts.js) instead of the
      // single fetchSelectedPlayerMetrics call every other chart type shares,
      // and its charted player count (players who qualify in BOTH windows)
      // isn't known until after those queries return, unlike every other type
      // where playerCount is just the selection size.
      if (chartType === "slope") {
        const metrics = eligibleMetrics(discipline, state.formats).filter((m) => m.kind === "rate" || m.kind === "percent");
        const metric = metrics.find((m) => m.key === slopeMetricKey); // item 4: no auto-pick
        if (!metric) {
          showChartGuidance(noMetricGuidance("a slope chart"));
          return;
        }
        const windowsReady = Boolean(slopeWindowA?.from && slopeWindowA?.to && slopeWindowB?.from && slopeWindowB?.to);
        if (!windowsReady) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], "Pick both date windows to draw this chart.");
          return;
        }

        const ids = players.map((p) => p.id);
        const [rowsA, rowsB] = await Promise.all([
          fetchWindowMetric(state, slopeWindowA, ids, metric),
          fetchWindowMetric(state, slopeWindowB, ids, metric),
        ]);
        if (token !== loadToken) return;
        hideStatus();

        const canvas = card.getCanvas();
        const labelA = windowLabel(slopeWindowA);
        const labelB = windowLabel(slopeWindowB);
        const result = buildSlopeChart(canvas, chartRef, { metric, labelA, labelB, rowsA, rowsB, players });
        const drawn = players.length - (result?.excluded?.length ?? 0);
        if (drawn === 0) {
          // Every selected player is missing data in at least one window, so
          // there's no slope to draw. Show an honest message instead of the
          // empty axis box buildSlopeChart now declines to draw (§7 — never a
          // broken-looking blank plot). The card title still honestly reads
          // "0 players".
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.showPlaceholder("None of the selected players have data in both windows. Pick players with more innings, widen the windows, or choose a different metric.");
          renderExclusions(result?.excluded ?? [], result?.note);
          const titleCfg = buildTitleOnlyConfig(0);
          if (titleCfg) card.regenerate(titleCfg, buildFooterScope(titleCfg));
          return;
        }
        renderExclusions(result?.excluded ?? [], result?.note);

        const config = {
          type: "slope",
          discipline,
          metric,
          windowA: slopeWindowA,
          windowB: slopeWindowB,
          windowALabel: labelA,
          windowBLabel: labelB,
          // The honest count for THIS chart's title is how many actually got
          // drawn (qualify in both windows), not the raw selection size.
          playerCount: drawn,
          // If qualification dropped anyone, the survivors are no longer
          // exactly "the top N by <seed metric>" (a mid-ranked player may have
          // dropped while a lower-ranked one survived) — force the plain
          // "N players" phrasing rather than overclaim (§8.4).
          roster: (result?.excluded?.length ?? 0) > 0 ? { ...roster, dirty: true } : roster,
        };
        if (pendingRegenerate) {
          card.regenerate(config, buildFooterScope(config));
          pendingRegenerate = false;
        } else {
          card.updateFooterScope(buildFooterScope(config));
        }
        return;
      }

      // By year (Batch 4 wave 2, task 1): its own branch, same reasoning as
      // Slope above — a dedicated query (timeseries.js's buildTimeseriesQuery,
      // grouped by (player, year), never re-derived here per §8.2) instead of
      // fetchSelectedPlayerMetrics's flat per-player grouping.
      if (chartType === "byyear") {
        const metrics = eligibleMetrics(discipline, state.formats).filter((m) => timeseriesSupported(m));
        const metric = metrics.find((m) => m.key === byYearMetricKey); // item 4: no auto-pick
        if (!metric) {
          showChartGuidance(noMetricGuidance("a line chart"));
          return;
        }

        const ids = players.map((p) => p.id);
        const sql = buildTimeseriesQuery({ discipline, metricKey: metric.key, playerIds: ids, filters: state });
        const { rows } = await query(sql);
        if (token !== loadToken) return;
        hideStatus();

        // The calendar-year span the x-axis should cover — the live scope's
        // date window (state.dateFrom/dateTo are "YYYY-MM"), so the Line chart
        // draws every year in range even for a roster of single-year players
        // (was collapsing to just the years-with-data, cramming lone dots at
        // the right edge — the "Line looks broken" bug).
        const scopeYears = {
          from: state.dateFrom ? Number(state.dateFrom.slice(0, 4)) : null,
          to: state.dateTo ? Number(state.dateTo.slice(0, 4)) : null,
        };
        const canvas = card.getCanvas();
        const result = buildTimeseriesChart(canvas, chartRef, { metric, rows, players, scopeYears });
        const drawn = players.length - (result?.excluded?.length ?? 0);
        if (drawn === 0) {
          // Nobody has any qualifying year in range — show an honest message
          // in place of an empty (year-less) plot, never a blank card (§7).
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.showPlaceholder("None of the selected players have data in this date range. Pick players with innings in range, or widen the window.");
          renderExclusions(result?.excluded ?? [], result?.note);
          const titleCfg = buildTitleOnlyConfig(0);
          if (titleCfg) card.regenerate(titleCfg, buildFooterScope(titleCfg));
          return;
        }
        renderExclusions(result?.excluded ?? [], result?.note);

        const config = {
          type: "byyear",
          discipline,
          metric,
          playerCount: drawn,
          roster: (result?.excluded?.length ?? 0) > 0 ? { ...roster, dirty: true } : roster,
        };
        if (pendingRegenerate) {
          card.regenerate(config, buildFooterScope(config));
          pendingRegenerate = false;
        } else {
          card.updateFooterScope(buildFooterScope(config));
        }
        return;
      }

      // Dumbbell (owner correction): a TIME-WINDOW chart — Slope's exact data
      // (fetchWindowMetric per window, one rate/percent metric) drawn as
      // dot-bar-dot. Two independent per-window queries, same wrap-buildQuery
      // idiom Slope uses; works for batting AND bowling, any gender (no
      // availability gate — see the removed dumbbellAvailable note up top).
      if (chartType === "dumbbell") {
        const metrics = eligibleMetrics(discipline, state.formats).filter((m) => m.kind === "rate" || m.kind === "percent");
        const metric = metrics.find((m) => m.key === dumbbellMetricKey); // item 4: no auto-pick
        if (!metric) {
          showChartGuidance(noMetricGuidance("a dumbbell chart"));
          return;
        }
        ensureDumbbellWindowDefaults();
        const windowsReady = Boolean(dumbbellWindowA?.from && dumbbellWindowA?.to && dumbbellWindowB?.from && dumbbellWindowB?.to);
        if (!windowsReady) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], "Pick both date windows to draw this chart.");
          return;
        }

        const ids = players.map((p) => p.id);
        const [rowsA, rowsB] = await Promise.all([
          fetchWindowMetric(state, dumbbellWindowA, ids, metric),
          fetchWindowMetric(state, dumbbellWindowB, ids, metric),
        ]);
        if (token !== loadToken) return;
        hideStatus();

        const canvas = card.getCanvas();
        const labelA = windowLabel(dumbbellWindowA);
        const labelB = windowLabel(dumbbellWindowB);
        const result = buildDumbbellChart(canvas, chartRef, { metric, labelA, labelB, rowsA, rowsB, players });
        const drawn = players.length - (result?.excluded?.length ?? 0);
        if (drawn === 0) {
          // Same both-windows exclusion as Slope: nobody has data in both
          // windows, so there's no dumbbell to draw. Honest message, not an
          // empty bar box (§7).
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.showPlaceholder("None of the selected players have data in both windows. Pick players with more innings, widen the windows, or choose a different metric.");
          renderExclusions(result?.excluded ?? [], result?.note);
          const titleCfg = buildTitleOnlyConfig(0);
          if (titleCfg) card.regenerate(titleCfg, buildFooterScope(titleCfg));
          return;
        }
        renderExclusions(result?.excluded ?? [], result?.note);

        const config = {
          type: "dumbbell",
          discipline,
          metric,
          labelA,
          labelB,
          // sideAKey/sideBKey carry the window ranges (card.js's regenKeyFor
          // keys the title-edit guard off them) — see buildTitleOnlyConfig.
          sideAKey: `${dumbbellWindowA.from}:${dumbbellWindowA.to}`,
          sideBKey: `${dumbbellWindowB.from}:${dumbbellWindowB.to}`,
          windowA: dumbbellWindowA,
          windowB: dumbbellWindowB,
          playerCount: drawn,
          roster: (result?.excluded?.length ?? 0) > 0 ? { ...roster, dirty: true } : roster,
        };
        if (pendingRegenerate) {
          card.regenerate(config, buildFooterScope(config));
          pendingRegenerate = false;
        } else {
          card.updateFooterScope(buildFooterScope(config));
        }
        return;
      }

      // Benchmark (B8b, decision 44e): ONE pool query (benchmark.js's
      // fetchBenchmarkPool — table.js's buildQuery(), UNWRAPPED, over the
      // whole filtered pool, never restricted to the checked roster — see
      // that module's file header) instead of fetchSelectedPlayerMetrics's
      // roster-restricted query every bar/donut/scatter/radar/phases chart
      // uses below. Ranks are computed client-side (benchmark.js's
      // computeBenchmarkRows) from that one query's rows.
      if (chartType === "benchmark") {
        const eligible = benchmarkEligibleMetrics(discipline, state.formats);
        const keys = (benchmarkMetricKeys || []).filter((k) => eligible.some((m) => m.key === k));
        if (keys.length < 4) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], "Choose at least 4 metrics to draw this chart.");
          return;
        }
        // Stable catalogue order for the actual drawn rows, regardless of the
        // arbitrary check/uncheck order benchmarkMetricKeys may have
        // accumulated (renderMetricControls' own picker is already stable
        // this way — see groupMetricsByKind(eligible) there).
        const metrics = eligible.filter((m) => keys.includes(m.key));

        // `players` (set at the top of renderChart(), = selection.get()) is
        // the CHECKED roster — anchor source only, see benchmark.js's file
        // header on why the pool itself ignores it.
        if (!benchmarkAnchorId || !players.some((p) => p.id === benchmarkAnchorId)) {
          benchmarkAnchorId = players[0]?.id ?? null;
        }
        const anchor = players.find((p) => p.id === benchmarkAnchorId) || null;
        if (!anchor) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], "Check a player to anchor this chart.");
          return;
        }

        // Pool cache: keyed on scope + metric keys (NOT anchor) so switching
        // the anchor alone re-renders without a refetch (task brief) — see
        // the benchmarkPoolCache doc comment where it's declared.
        const poolKey = JSON.stringify([scopeSeedKey(state), keys.slice().sort()]);
        let pool;
        if (benchmarkPoolCache && benchmarkPoolCache.key === poolKey) {
          pool = benchmarkPoolCache.rows;
        } else {
          pool = await fetchBenchmarkPool(state, keys);
          if (token !== loadToken) return;
          benchmarkPoolCache = { key: poolKey, rows: pool };
        }
        hideStatus();

        const computed = computeBenchmarkRows(pool, metrics, anchor.id);
        const groups = groupMetricsByKind(metrics);
        const canvas = card.getCanvas();
        const result = buildBenchmarkChart(canvas, chartRef, { anchor, groups, rows: computed });
        renderExclusions([], result?.note);

        const config = {
          type: "benchmark",
          discipline,
          anchorId: anchor.id,
          anchorName: anchor.name,
          metricKeys: keys,
          metrics,
          playerCount: players.length,
          roster,
        };
        if (pendingRegenerate) {
          card.regenerate(config, buildFooterScope(config));
          pendingRegenerate = false;
        } else {
          card.updateFooterScope(buildFooterScope(config));
        }
        return;
      }

      let metricKeys = [];
      let config;

      if (chartType === "bar") {
        const metric = getMetric(barMetricKey, discipline); // item 4: no auto-pick
        if (!metric) { showChartGuidance(noMetricGuidance("a bar chart")); return; }
        metricKeys = [metric.key];
        config = { type: "bar", discipline, metric, playerCount: players.length, style: barStyle, roster };
      } else if (chartType === "donut") {
        const metric = getMetric(donutMetricKey, discipline); // item 4: no auto-pick
        if (!metric) { showChartGuidance(noMetricGuidance("a donut chart")); return; }
        metricKeys = [metric.key];
        config = { type: "donut", discipline, metric, playerCount: players.length, roster };
      } else if (chartType === "scatter") {
        const metricX = getMetric(scatterXKey, discipline);
        const metricY = getMetric(scatterYKey, discipline);
        if (!metricX || !metricY) {
          // item 4: scatter needs BOTH axes chosen — one honest sentence, no plot.
          showChartGuidance(metricEverChosen ? "Choose both an X and a Y metric to draw a scatter plot." : "Choose an X and a Y metric to draw a scatter plot.");
          return;
        }
        metricKeys = [metricX.key, metricY.key];
        config = { type: "scatter", discipline, metricX, metricY, playerCount: players.length, roster };
      } else if (chartType === "radar") {
        const groups = eligibleRadarGroups(discipline, state.formats);
        const group = groups.find((g) => g.id === radarGroupId); // item 4: no auto-pick
        if (!group) {
          showChartGuidance("Choose a metric group to draw a radar chart.");
          return;
        }
        const metrics = group.metricKeys.map((k) => getMetric(k, discipline)).filter(Boolean);
        metricKeys = metrics.map((m) => m.key);
        config = { type: "radar", discipline, group, metrics, playerCount: players.length, roster };
      } else if (chartType === "phases") {
        const families = eligiblePhaseFamilies(discipline, state.formats);
        const family = families.find((f) => f.id === phaseFamilyId); // item 4: no auto-pick
        if (!family) {
          showChartGuidance("Choose a metric family to draw a phases chart.");
          return;
        }
        const metrics = family.members.map((mm) => getMetric(mm.key, discipline)).filter(Boolean);
        metricKeys = metrics.map((m) => m.key);
        config = { type: "phases", discipline, family, metrics, playerCount: players.length, roster };
      }

      const rowsById = await fetchSelectedPlayerMetrics(state, players.map((p) => p.id), metricKeys);
      if (token !== loadToken) return;
      hideStatus();

      let result;
      const canvas = card.getCanvas();
      if (config.type === "bar") {
        result = buildBarChart(canvas, chartRef, { metric: config.metric, rowsById, players, style: config.style });
      } else if (config.type === "donut") {
        result = buildDonutChart(canvas, chartRef, { metric: config.metric, rowsById, players });
      } else if (config.type === "scatter") {
        result = buildScatterChart(canvas, chartRef, { metricX: config.metricX, metricY: config.metricY, rowsById, players });
      } else if (config.type === "radar") {
        result = buildRadarSmallMultiples(canvas, chartRef, { group: config.group, metrics: config.metrics, rowsById, players });
      } else if (config.type === "phases") {
        result = buildPhasesChart(canvas, chartRef, { family: config.family, metrics: config.metrics, rowsById, players });
      }

      renderExclusions(result?.excluded ?? [], result?.note);

      // Exclusions (no data for the metric/family) mean the drawn set is no
      // longer exactly the seeded "top N by X" — drop to honest "N players"
      // phrasing and count only what's actually drawn (§8.4).
      const excludedCount = result?.excluded?.length ?? 0;
      if (excludedCount > 0) {
        config.playerCount = Math.max(0, config.playerCount - excludedCount);
        config.roster = { ...config.roster, dirty: true };
      }

      if (pendingRegenerate) {
        card.regenerate(config, buildFooterScope(config));
        pendingRegenerate = false;
      } else {
        card.updateFooterScope(buildFooterScope(config));
      }
    } catch (e) {
      if (token !== loadToken) return;
      showErrorStatus(e, renderChart);
    }
  }

  let pendingRegenerate = false;
  let renderDebounce = null;
  function scheduleRender({ paramsChanged = false } = {}) {
    if (paramsChanged) pendingRegenerate = true;
    clearTimeout(renderDebounce);
    renderDebounce = setTimeout(renderChart, 60);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Organic entry (decision 46f): the Graphs TAB and the Stats toolbar's
   * "Graph" button now behave identically here (see enterFromBridge below) —
   * no chart type is pre-selected and no chart renders. If Stats has been
   * searched at least once, its result set becomes the candidate POOL (the
   * existing top-N-by-current-sort "best" derivation becomes the initial
   * CHECKED roster for free — see deriveChecked()'s seed-order fallback and
   * activeMaxCap()'s pre-type-selection default) so a type click can render
   * immediately with no re-ticking. If Stats has never been searched,
   * seedSelection() no-ops and renderChart() shows the empty-state guidance
   * instead (poolStatusReason()). Chart type / metrics / roster edits from an
   * earlier visit are never reset here — only explicit user actions change
   * them (requirement 2's persistence rule).
   */
  async function onShow() {
    // Item 1: re-inherit the Stats scope into the graph-local store when a new
    // Stats search has changed it since the last seed; a bare tab toggle (or a
    // graph that only changed its OWN filters) leaves the graph's scope alone.
    seedGraphScopeFromStats();
    syncChartTypeButtons();
    syncBarStyleVisibility();
    renderMetricControls();
    await seedSelection();
    scheduleRender({ paramsChanged: true });
  }

  /**
   * Stats toolbar "Graph" button: navigates to Graphs exactly like the tab
   * (onShow()) — no forced chart type, no auto-render (decision 46f).
   *
   * The old matchup special-case (land on Dumbbell with Side B = the table's
   * "Vs" bucket) was REMOVED: Dumbbell is no longer a matchup chart, it's a
   * time-window chart (owner correction), so there is no longer any chart type
   * that consumes the table's Pace/Spin vocabulary — carrying that bucket into
   * a chart would be dishonest. The bridge therefore now lands everywhere the
   * same way: the plain Graphs entry, where the user picks a chart type. The
   * `preferredMetricKey` arg (the table's current sort column) is accepted for
   * caller-signature compatibility but no longer consulted — there's no
   * pre-selected chart type for it to seed a metric onto.
   */
  async function enterFromBridge(_opts = {}) {
    await onShow();
  }

  /**
   * "Graph this player" (task 4, decision 43): called by the host app after
   * it has already ensured the Graphs view is showing (normally via onShow()
   * — see the host wiring). Adds ONE player to whatever roster already
   * exists — no reseed, no chart-type change — marking it dirty (via
   * players.js's createSelection.add()) so the title's "top N" phrasing
   * correctly drops to "N players" the moment the roster stops being exactly
   * the seeded set. Cap handling reuses the exact same note the manual
   * player-search "add" path already shows (no new copy for the same
   * situation).
   */
  function addPlayerFromOutside(id, name) {
    // Same "pool is never truncated, checked only if there's room" contract
    // as the manual search-add flow (Batch 8, task 1) — see that handler's
    // comment for why this can no longer fail outright on a full cap.
    const result = selection.addCandidate({ id, name });
    if (result.ok && !result.checked) {
      showCapNote(`Added to your list, but ${capSubjectLabel()} is capped at ${activeMaxCap()} players — untick one to plot them instead.`);
    } else if (result.ok) {
      clearCapNote();
    }
    // "already-selected": silent no-op — the player's already in the roster,
    // which is exactly what the task brief asks for ("adds ... if absent").
  }

  // ── "Graph this player" chooser (owner decision 46) ─────────────────────────
  // src/playerGraphChooser.js is a small modal over the player popup that asks
  // chart type + metric BEFORE jumping to Graphs, so the user never lands on
  // the bare "Pick a chart type to get started" stage (decision 46f) after
  // clicking "Graph this player". Two entry points below are this module's
  // only surface for that chooser: one read-only (what can this player be
  // charted as, right now?) and one write (make it so). Neither duplicates
  // any eligibility reason or metric list — both reuse exactly what
  // evaluateTypeStatus()/renderMetricControls() already derive.

  /** The metric field the chooser should show for `typeKey`, mirroring
   * renderMetricControls()'s own per-type shape WITHOUT mutating any of this
   * module's live metric-key variables (the chooser is a preview — nothing is
   * committed until Confirm, see enterWithChoiceImpl()). Multi-metric types
   * (radar/phases/benchmark) need no single pick — renderMetricControls()
   * already fills in their own sensible defaults (group/family/anchor+keys)
   * once enterWithChoiceImpl() sets chartType, so the chooser just says so. */
  function metricFieldFor(typeKey, state) {
    const { discipline, formats } = state;
    const single = (metrics) => ({
      kind: "single",
      options: metrics.map((m) => ({ key: m.key, label: m.label })),
      defaultKey: metrics[0]?.key ?? null,
    });
    switch (typeKey) {
      case "bar":
        return single(eligibleMetrics(discipline, formats));
      case "donut":
        return single(donutEligibleMetrics(discipline, formats));
      case "slope":
        return single(eligibleMetrics(discipline, formats).filter((m) => m.kind === "rate" || m.kind === "percent"));
      case "byyear":
        return single(eligibleMetrics(discipline, formats).filter((m) => timeseriesSupported(m)));
      case "dumbbell":
        // Time-window Dumbbell shares Slope's exact metric set (rate/percent).
        return single(eligibleMetrics(discipline, formats).filter((m) => m.kind === "rate" || m.kind === "percent"));
      case "scatter": {
        const metrics = eligibleMetrics(discipline, formats);
        const options = metrics.map((m) => ({ key: m.key, label: m.label }));
        return { kind: "xy", xOptions: options, yOptions: options, defaultX: metrics[0]?.key ?? null, defaultY: (metrics[1] || metrics[0])?.key ?? null };
      }
      case "radar":
        return { kind: "none", note: "Radar compares a whole metric group at once — no single metric to pick." };
      case "phases":
        return { kind: "none", note: "Phases compares a whole metric family at once — no single metric to pick." };
      case "benchmark":
        return { kind: "none", note: "Benchmark compares several metrics against the field at once — no single metric to pick." };
      default:
        return { kind: "none", note: "" };
    }
  }

  /** ok/reason for every chart type AS IF `player` were already added to the
   * candidate pool (it isn't yet — the chooser is still deciding) — reuses
   * evaluateTypeStatus() exactly, just with the pool-emptiness gate forced
   * open (this player is a real, guaranteed candidate; "run a search on
   * Stats first" would be dishonest here) and the min-player floor counted
   * against pool-size-plus-this-one. */
  function evaluateChartTypesForPlayerImpl(player) {
    const state = store.get();
    const candidateCount = selection.has(player.id) ? selection.candidateCount() : selection.candidateCount() + 1;
    return CHART_TYPES.map((t) => {
      const status = evaluateTypeStatus(t.key, state, { candidateCountOverride: candidateCount, poolReasonOverride: null });
      return { key: t.key, label: t.label, ok: status.ok, reason: status.reason, metricField: metricFieldFor(t.key, state) };
    });
  }

  /** Ensure `player` is both a CANDIDATE and CHECKED under the currently
   * active chart type's cap — an explicit chooser confirm is a deliberate,
   * single-player pick, so (unlike addPlayerFromOutside(), which leaves an
   * over-cap add unticked with a note) it must actually land on the chart.
   * If the cap is already full, the LAST checked player (candidate order —
   * see players.js's get()) is unticked to make room. Returns true iff a
   * replacement happened, so the caller can say so once. */
  function ensureCheckedWithReplacement(player) {
    if (!selection.has(player.id)) {
      const result = selection.addCandidate(player, { autoCheck: true });
      if (result.checked) return false; // room existed under the cap already
    } else if (selection.isChecked(player.id)) {
      return false; // already on the chart — nothing to do
    }
    let replaced = false;
    if (selection.checkedCount() >= activeMaxCap()) {
      const checkedNow = selection.get();
      const last = checkedNow[checkedNow.length - 1];
      if (last) {
        selection.toggleChecked(last.id);
        replaced = true;
      }
    }
    selection.toggleChecked(player.id);
    return replaced;
  }

  /**
   * The chooser's Confirm entry (owner decision 46) — the ONE programmatic
   * path into an explicit type+metric+player choice made OUTSIDE the Graph
   * Builder's own controls. Goes through the exact same state/selection
   * calls a manual pick would (chartType assignment, selection.addCandidate/
   * toggleChecked, the per-type metric variable), so everything downstream —
   * persistence across tab switches, cap notes, roster rendering — behaves
   * identically to a user who'd clicked through the controls by hand.
   *
   * Never reseeds/wipes the existing candidate pool itself (`player` is
   * ADDED to whatever's already there) — the one `await seedSelection()`
   * below is the SAME no-op-if-already-seeded call onShow() already makes
   * (see its own doc comment); it only actually queries the first time
   * Graphs is shown this session (or after a scope change), exactly as it
   * would have anyway had the user opened Graphs first. This must run BEFORE
   * chartType/the player are touched: seedSelection() replaces the whole
   * candidate pool wholesale when it does run, which would silently wipe
   * this player right back out if we'd already added them.
   *
   * `metricKey` is a single metric key for every type except scatter (which
   * needs both an X and a Y — pass `{ x, y }`) and radar/phases/benchmark
   * (which need none — see metricFieldFor()'s "none" kind); omitted/invalid
   * values are simply left for renderMetricControls()'s own defaulting.
   */
  async function enterWithChoiceImpl({ chartType: newType, metricKey, player } = {}) {
    if (!newType || !player) return;
    await seedSelection();

    chartType = newType;
    clearCapNote();
    selection.clampToCap(); // shrink an oversized checked set inherited from a roomier previous chart type

    const replaced = ensureCheckedWithReplacement(player);

    if (newType === "scatter") {
      if (metricKey && typeof metricKey === "object") {
        if (metricKey.x) scatterXKey = metricKey.x;
        if (metricKey.y) {
          scatterYKey = metricKey.y;
          markMetricChosen(metricKey.y); // item 4: chooser Y is the shared metric
        } else {
          metricEverChosen = true;
        }
      }
    } else if (typeof metricKey === "string" && metricKey) {
      if (newType === "bar") barMetricKey = metricKey;
      else if (newType === "donut") donutMetricKey = metricKey;
      else if (newType === "slope") slopeMetricKey = metricKey;
      else if (newType === "byyear") byYearMetricKey = metricKey;
      else if (newType === "dumbbell") dumbbellMetricKey = metricKey;
      markMetricChosen(metricKey); // item 4: chooser pick persists + arms Recommended
    } else {
      // radar/phases/benchmark: no single metric to pick. The chooser is an
      // EXPLICIT type confirm, so seed the first group/family (item 4's
      // no-auto-pick applies to the Builder's own controls; a deliberate
      // chooser confirm still lands on a drawn chart) and count it as a metric
      // choice for the Recommended-tag gate. Benchmark self-configures.
      const gs = store.get();
      if (newType === "radar") {
        const groups = eligibleRadarGroups(gs.discipline, gs.formats);
        if (groups[0] && !groups.some((g) => g.id === radarGroupId)) radarGroupId = groups[0].id;
      } else if (newType === "phases") {
        const families = eligiblePhaseFamilies(gs.discipline, gs.formats);
        if (families[0] && !families.some((f) => f.id === phaseFamilyId)) phaseFamilyId = families[0].id;
      }
      metricEverChosen = true;
    }

    syncChartTypeButtons();
    syncBarStyleVisibility();
    renderMetricControls();
    renderPlayerList();
    if (replaced) {
      showCapNote(`${capSubjectLabel()} is capped at ${activeMaxCap()} players — ${player.name} replaced the last one on the chart.`);
    }
    scheduleRender({ paramsChanged: true });
  }

  /** Called whenever the shared filter scope changes (discipline/format/filters). */
  function onScopeChanged() {
    // decision 46f: a scope change never silently swaps the chart type away
    // from the user's own pick anymore (e.g. Dumbbell staying selected on a
    // scope change into bowling/female) — evaluateTypeStatus()/renderChart()
    // already explain, in the stage, exactly why it can't render right now;
    // that's more honest than quietly jumping to Bar underneath the user.
    syncChartTypeButtons();
    renderMetricControls(); // metric eligibility may have changed (phase gating)
    // Re-seed from the new filtered set — the old selection may no longer make
    // sense for a different discipline; for pure filter tweaks we still refresh
    // to keep the "reset to filtered set" meaningful. seedSelection() itself
    // no-ops both if Stats has never been searched (still no query — the
    // empty-state stays honest) and if the filtered set's identity key hasn't
    // actually changed.
    seedSelection().then(() => scheduleRender({ paramsChanged: true }));
  }

  const controller = {
    onShow,
    onScopeChanged,
    enterFromBridge,
    addPlayerFromOutside,
    evaluateChartTypesForPlayer: evaluateChartTypesForPlayerImpl,
    enterWithChoice: enterWithChoiceImpl,
  };
  currentInstance = controller;
  return controller;
}

/** Read-only: the "Graph this player" chooser's per-type ok/reason + metric
 * field for `{id, name}`, as if it were already in the candidate pool. See
 * evaluateChartTypesForPlayerImpl() above for what this actually reuses. */
export function evaluateChartTypesForPlayer(player) {
  return currentInstance ? currentInstance.evaluateChartTypesForPlayer(player) : [];
}

/** Write: the chooser's Confirm action — `{ chartType, metricKey, player }`.
 * See enterWithChoiceImpl() above. A no-op before mountGraph() has ever run
 * (shouldn't happen — the chooser only exists once the app has booted). */
export function enterWithChoice(opts) {
  return currentInstance ? currentInstance.enterWithChoice(opts) : undefined;
}
