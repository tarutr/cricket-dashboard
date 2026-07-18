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

import { eligibleMetrics, pruneIneligibleState } from "../state.js";
import { getMetric, hasMetricData } from "../metrics.js";
import { escHtml, escAttr } from "../html.js";
import { getManifest, query } from "../db.js";
import { mountFilters, buildScopeClauses } from "../filters.js";
import { mountFilterDrawer } from "../drawer.js";
import { mountSearchSelect, mountSearchMultiSelect } from "../searchSelect.js";
import {
  CHART_CAPS,
  createSelection,
  seedFromFilteredSet,
  searchPlayers,
  fetchCareerGames,
} from "./players.js";
import {
  fetchSelectedPlayerMetrics,
  fetchWindowMetric,
  buildBarChart,
  buildScatterChart,
  buildRadarSmallMultiples,
  buildPhasesChart,
  buildSlopeChart,
} from "./charts.js";
import { mountCard } from "./card.js";
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
} from "./benchmark.js";
import { buildBenchmarkChart } from "./benchmarkChart.js";

const CHART_TYPES = [
  { key: "bar", label: "Bar" },
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

// R5 Wave 1b (items 1 + 3): the ONE source of truth for every chart type's
// plain-English "what it is / what it needs" copy. Consumed by three surfaces
// so they can never drift: the empty-state RULES TABLE (item 1) and the honest
// invalid-metric / can't-render messages shown in the stage (item 3).
//   • tagline — the one-line "what it needs / how to use it" for the rules
//     table row (kept tight and accurate to THIS app's metric registry).
//   • purpose — a full sentence stating what the chart is FOR.
//   • needs   — a full sentence stating what metric(s)/inputs it needs.
// The invalid message shown when a chart can't render is `${purpose} ${needs}`
// (optionally prefixed with "<metric> can't be shown here." — see
// noMetricGuidance()), giving the two-part "what it's for + what it needs"
// message the owner asked for in item 3.
const CHART_RULES = {
  bar: {
    tagline: "Ranks players on one metric.",
    purpose: "A bar chart ranks players on one metric.",
    needs: "Pick one metric.",
  },
  scatter: {
    tagline: "Two metrics plotted across the whole field.",
    purpose: "A scatter plot maps every player on two metrics.",
    needs: "Pick an X metric and a Y metric.",
  },
  radar: {
    tagline: "Three or more metrics as percentile axes, up to 6 players.",
    purpose: "A radar chart compares players across several metrics as percentile axes.",
    needs: "Pick at least 3 metrics (up to 10).",
  },
  phases: {
    tagline: "Powerplay, middle and death splits of a metric.",
    purpose: "A phases chart breaks a metric family into powerplay, middle and death.",
    needs: "Pick a metric family.",
  },
  slope: {
    tagline: "One metric across two time windows.",
    purpose: "A slope chart compares one metric across two time windows.",
    needs: "Pick a per-innings rate or average, then set Window A and Window B.",
  },
  byyear: {
    tagline: "One metric tracked over time.",
    purpose: "A line chart tracks one metric over the seasons.",
    needs: "Pick a metric that recombines by year.",
  },
  dumbbell: {
    tagline: "One metric across two time windows, drawn as a gap.",
    purpose: "A dumbbell chart compares one metric across two time windows.",
    needs: "Pick a per-innings rate or average, then set Window A and Window B.",
  },
  benchmark: {
    tagline: "One player measured against the whole field.",
    purpose: "A benchmark chart measures one player against the whole field.",
    needs: "Pick at least 4 metrics.",
  },
};

/** The two-part "what it's for / what it needs" sentence for a chart type
 * (item 3), optionally prefixed with the reason a specific chosen metric was
 * rejected. ONE builder so every stage message reads the same way. */
function chartPurposeMessage(typeKey, rejectedMetricLabel) {
  const rule = CHART_RULES[typeKey];
  if (!rule) return "This chart type isn't available right now.";
  const base = `${rule.purpose} ${rule.needs}`;
  return rejectedMetricLabel ? `${rejectedMetricLabel} can't be shown here. ${base}` : base;
}

/** R5 Wave 1b (item 1): the distinct metric keys named by the graph scope's
 * applied advanced conditions (state.advanced.groups[].conds[].metricKey), in
 * first-seen order. This is what "metric condition(s) applied" means for the
 * empty-state / auto-select gate. Reads the state shape documented in
 * state.js: advanced = { op, groups:[{ op, conds:[{metricKey, operator, v1,
 * v2}] }] }. Conditions reaching an APPLIED graph scope are already validated
 * (applyGraphFilters -> graphDrawerController.validate()), so a present
 * metricKey is a real, complete "measure this" intent. */
function metricConditionKeys(state) {
  const keys = [];
  for (const g of (state.advanced && state.advanced.groups) || []) {
    for (const c of g.conds || []) {
      if (c && c.metricKey && !keys.includes(c.metricKey)) keys.push(c.metricKey);
    }
  }
  return keys;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// R7 Wave 2 (item 16): the graph-local scope clone is gone — the Graph Builder
// now SHARES the Stats filter store (see mountGraph's `store`). The only thing
// the old clone did beyond copying was strip matchupVs so the graph ignores
// matchup ("Vs") mode end-to-end (there is no matchup chart type). That job now
// lives in the shared-store read wrapper inside mountGraph, which nulls
// matchupVs on read WITHOUT mutating the shared state — so query paths ignore
// the "Vs" bucket while the Stats table keeps it. (describeScope already
// view-guards the matchup token to the table view, so the card footer stays
// honest on its own.)

// ── Day-level date helpers (R3 Wave 3, item 10) ─────────────────────────────
// The Slope/Dumbbell Window A/B pickers are now DAY-level native <input
// type="date"> controls (they used to be month <select>s, which desynced their
// displayed value — noted at commit 2f847ee). Windows are stored as
// "YYYY-MM-DD" pairs; charts.js's fetchWindowMetric feeds them straight into
// buildScopeClauses, whose buildCoreScopeClauses already accepts a day-shaped
// dateFrom/dateTo (filters.js's isDayDate branch) — so no query shape changes,
// only the granularity of the two dates handed to it. All arithmetic is UTC
// (never local time) so it can never drift a day across a DST boundary.
// NOTE (Wave 2, item 4a): the Slope/Dumbbell Window A/B pickers no longer
// auto-fill from a half-split of the scope's date range — they START EMPTY and
// the user must pick both ends, exactly like a metric that must be chosen. The
// old half-split seeder (computeHalfSplitWindows) and its UTC day-arithmetic
// helpers (dayToMs/msToDay/toDay/DAY_MS) were removed with that behaviour;
// only dayLabel (the picker VALUE -> label formatter) survives below.
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
  function onToggleClick(e) {
    e.stopPropagation();
    if (panelEl.hidden) open();
    else close();
  }
  function onDocClick(e) {
    if (panelEl.hidden) return;
    if (panelEl.contains(e.target) || e.target === toggleEl) return;
    close();
  }
  function onDocKeydown(e) {
    if (e.key === "Escape" && !panelEl.hidden) close();
  }
  toggleEl.addEventListener("click", onToggleClick);
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);
  // Returns a teardown that removes the EXACT listeners this call added, so a
  // caller that rebuilds its dropdown nodes can dispose the previous wiring
  // (which otherwise pins detached DOM on `document` for the page's life). The
  // roster dropdown (wired once over static markup) simply ignores this return.
  return function teardown() {
    toggleEl.removeEventListener("click", onToggleClick);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onDocKeydown);
  };
}

// NOTE: the Dumbbell chart used to be batting+men-only (a matchup "vs Pace/vs
// Spin" chart, gated by a dumbbellAvailable()/dumbbellUnavailableReason() pair
// here). It is now a time-window chart drawing Slope's exact data source, so
// it works wherever Slope does — any gender, batting OR bowling — and needs no
// availability gate at all. Both helpers were removed with that rebuild.

// R4 Wave 1b (item 3 + item 4): the radar-valid metric predicate — the ONE
// source both the radar checkbox picker's list AND the honest-refusal/enable
// checks read from (no second copy of the rule). A metric is radar-valid iff
// it's eligible for the scope AND has a defined better-direction
// (higherIsBetter !== null). The radar normalises each axis 0.1–1.0 by
// min/max across the charted players and inverts lower-is-better metrics so
// "outward = better" always holds (see charts.js buildRadarSmallMultiples), so
// a metric with NO better-direction (dismissal breakdowns, not-out %, raw
// matches/innings/balls) can't be honestly placed on an axis. This is a
// SUPERSET of every metric the old curated radarGroups.js groups ever offered
// (all of those had a defined direction), so nothing that was radar-able before
// is lost — the group *structure* is gone, the metric vocabulary is not.
function radarEligibleMetrics(discipline, formats) {
  return eligibleMetrics(discipline, formats).filter((m) => m.higherIsBetter !== null);
}
// Min axes to draw a meaningful radar polygon; max the user may check at once.
const RADAR_MIN_METRICS = 3;
const RADAR_MAX_METRICS = 10;

// Owner decision 46 ("Graph this player" chooser, src/playerGraphChooser.js):
// mountGraph() is only ever called once per page load (one Graphs panel), so
// a module-level pointer to the live instance lets OTHER modules — the
// chooser, mounted from src/playerPopup.js, which has no reference to the
// controller object main.js holds — reach the two read/write entry points
// below (evaluateChartTypesForPlayer/enterWithChoice) as plain imports,
// without main.js needing to thread anything new through. Set at the bottom
// of mountGraph(), read by the two exported wrappers just below it.
let currentInstance = null;

export function mountGraph(container, statsStore, { hasStatsResults = () => false, onClearFilters = () => {} } = {}) {
  // ── Shared Stats filter store (R7 Wave 2, item 16) ───────────────────────
  // The Graph Builder now SHARES the Stats filter state, bidirectionally. It
  // reads AND writes the SAME store main.js owns — no graph-local clone, no
  // re-seed/re-inherit dance. A filter edited in the graph's own Filters popup
  // lands on the Stats side, and a filter set on the Stats side is already in
  // effect here: it's a shortcut to edit the same filters without leaving the
  // tab, NOT a separate scope.
  //
  // The one thing the old clone did that must survive: the graph ignores
  // matchup ("Vs") mode (there is no matchup chart type). So `store` is a thin
  // read-through wrapper over `statsStore` that nulls matchupVs ON READ only —
  // the shared state itself is never mutated, so the Stats table keeps its "Vs"
  // bucket. `set` passes straight through, so every graph filter edit is a real
  // write to the shared store (that's what makes sharing bidirectional). The
  // shallow spread preserves every nested reference (advanced.groups, profile,
  // the filter arrays), so drawer.js's in-place condition mutation still reaches
  // the shared store exactly as before.
  const readScope = () => {
    const s = statsStore.get();
    return s.matchupVs == null ? s : { ...s, matchupVs: null };
  };
  const store = {
    get: readScope,
    set: statsStore.set,
    subscribe: statsStore.subscribe,
    // Describe the SAME matchupVs-nulled scope the graph queries against, so the
    // card footer (§8.4) never states a matchup/positions filter the query
    // didn't apply.
    describeScope: () => statsStore.describeScope(readScope()),
  };
  // Item 16: seeding is gated on whether a scope has actually been committed —
  // a Stats search (hasStatsResults) OR the graph's own "Apply to graph". This
  // flag tracks the latter so the graph can seed from the shared filters even
  // when the Stats table was never searched (standalone graph use). It is NOT a
  // separate scope — the filters it applies are the shared ones — only a record
  // that the user has committed a scope from inside the graph. Preserves the
  // empty state: before EITHER trigger, opening Graphs directly shows the
  // rules-table empty state and runs no query of its own.
  let graphFiltersApplied = false;

  // R2 Wave R2-1 (owner layout restructure): the LEFT column is a normal
  // top-to-bottom stack — an action row (To Stats / Filters / Clear) ABOVE the
  // card, the toolbar CARD (a plain bordered card, no internal scroll), the
  // "Update chart" button BELOW the card, and the Export/Copy PNG row below
  // that. The whole column is sized to fit within ONE screen height alongside
  // the chart card (no outer scroll, no internal scroll). Chart type is now a
  // native <select> (was a 9-tile grid) to save vertical space; a later wave
  // swaps every dropdown for a custom searchable component.
  container.innerHTML = `
    <div class="graph-builder">
      <div class="graph-builder__left">
        <div class="graph-builder__topbar">
          <button type="button" class="link-btn graph-back-link" data-role="graph-back">To Stats</button>
          <div class="graph-topbar-actions">
            <button type="button" class="btn btn--ghost graph-filters-btn" data-role="graph-filters-open">Filters</button>
            <button type="button" class="btn btn--ghost graph-clear-btn" data-role="graph-clear">Clear filters</button>
          </div>
        </div>

        <div class="graph-builder__controls">
          <div class="graph-control-group">
            <span class="graph-control-label">Chart type</span>
            <!-- R2-2a: chart type is now the shared searchable dropdown
                 (src/searchSelect.js), mounted into this host below. Options
                 stay SELECTABLE even when unavailable (decision 46f) — an
                 "(unavailable)" hint suffix is the only availability cue. -->
            <div class="graph-chart-type-select" data-role="chart-type"></div>
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
            <!-- R7 Wave 2 (item 21): the roster-mode control is surfaced HERE in
                 the controls (was buried inside the "N of N selected" dropdown,
                 owner couldn't find it) so Top names | Best | Worst | Manual is
                 visible and directly switchable. -->
            <div class="graph-roster-mode-row" data-role="roster-mode-row" hidden>
              <div class="segmented segmented--small graph-roster-mode" data-role="roster-mode" role="group" aria-label="Show">
                <button type="button" class="segmented__btn" data-value="topnames">Top Names</button>
                <button type="button" class="segmented__btn" data-value="best">Best</button>
                <button type="button" class="segmented__btn" data-value="worst">Worst</button>
                <button type="button" class="segmented__btn" data-value="manual">Manual</button>
              </div>
            </div>
            <div class="graph-player-search">
              <input type="text" class="input" data-role="player-search" placeholder="Add a player…" aria-label="Search players to add" />
              <div class="graph-player-search__results" data-role="player-search-results" hidden></div>
            </div>
            <div class="dropdown graph-roster-dropdown" data-role="roster-dropdown">
              <button type="button" class="select dropdown__toggle graph-roster-toggle" data-role="roster-toggle" aria-haspopup="true" aria-expanded="false"></button>
              <div class="dropdown__panel graph-roster-panel" data-role="roster-panel" hidden>
                <div class="graph-roster-filter" data-role="roster-filter-wrap" hidden>
                  <input type="text" class="input graph-roster-filter__input" data-role="roster-filter" placeholder="Filter players…" aria-label="Filter the player list" />
                </div>
                <div class="dropdown__list graph-roster-list" data-role="roster-list"></div>
              </div>
            </div>
            <div class="graph-player-actions">
              <button type="button" class="link-btn" data-role="reset-players">Reset to full filtered set</button>
            </div>
            <p class="graph-cap-note" data-role="cap-note" hidden></p>
          </div>
        </div>

        <!-- Owner item 7 (Wave 3): in-panel control edits are PENDING (they
             update the controls UI live but don't redraw the chart) — only this
             button draws. R2-1: it now sits BELOW the card as a normal in-flow
             button (was a sticky bar inside the internally-scrolling column).
             The graph's own "Apply to graph" filter button is separate and keeps
             drawing on its own. -->
        <div class="graph-update-bar">
          <button type="button" class="btn btn--primary graph-update-btn" data-role="graph-update" disabled>Update chart</button>
        </div>

        <!-- R2-1: the Export/Copy PNG row lives in the LEFT column now (was in
             the stage). It still exports the chart card rendered in the stage —
             card.js's exportPNG/copyPNG target that card, not this row. -->
        <div class="graph-export" data-role="export-row">
          <button type="button" class="btn btn--primary" data-role="export-png">Export PNG</button>
          <button type="button" class="btn btn--ghost" data-role="copy-png" hidden>Copy PNG</button>
          <span class="graph-export__status" data-role="export-status"></span>
        </div>
      </div>

      <div class="graph-builder__stage">
        <div class="graph-status" data-role="status" hidden></div>
        <div class="graph-stage-guidance" data-role="stage-guidance" hidden></div>
        <div class="graph-card-host" data-role="card-host"></div>
        <div class="graph-exclusions" data-role="exclusions" hidden></div>
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
    rosterModeRow: container.querySelector('[data-role="roster-mode-row"]'),
    rosterMode: container.querySelector('[data-role="roster-mode"]'),
    rosterFilterWrap: container.querySelector('[data-role="roster-filter-wrap"]'),
    rosterFilter: container.querySelector('[data-role="roster-filter"]'),
    rosterList: container.querySelector('[data-role="roster-list"]'),
    resetPlayers: container.querySelector('[data-role="reset-players"]'),
    capNote: container.querySelector('[data-role="cap-note"]'),
    updateBtn: container.querySelector('[data-role="graph-update"]'),
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
  // R2-2a (searchable dropdowns): live handles for the shared searchSelect
  // component (src/searchSelect.js). `chartTypeSelect` is mounted ONCE (static
  // control, persists for the panel's life). `metricControlSelects` are the
  // per-render metric pickers inside els.metricControls (single-pick AND, since
  // R2-2b-i, the radar/benchmark MULTI-select pickers + the benchmark anchor) —
  // rebuilt on every renderMetricControls(), so each is destroy()'d before the
  // next rebuild (they each hold a document click listener).
  let chartTypeSelect = null;
  let metricControlSelects = [];
  // R3 Wave 3, item 4 (no defaults / honest graph state):
  //  • chosenMetricKey — the ONE metric the user has picked, shared across the
  //    single-metric chart types (bar/slope/byyear/dumbbell + scatter's Y
  //    axis) so it PERSISTS across chart-type switches. Adopted into a type's
  //    own key only when it's valid for that type; otherwise that type renders
  //    an honest "choose another metric" message rather than silently swapping.
  //  • metricEverChosen — has the user explicitly chosen ANY metric/group/
  //    family/axis this session? Distinguishes "no metric picked yet" from
  //    "picked a metric that's invalid on THIS chart type" in the honest
  //    invalid-metric guidance (noMetricGuidance) — nothing to do with any
  //    auto-pick (item 18: the Recommended engine is gone).
  let chosenMetricKey = null;
  let metricEverChosen = false;
  function markMetricChosen(key) {
    if (key) chosenMetricKey = key;
    metricEverChosen = true;
  }
  // R5 Wave 1b (item 1 — filter-driven auto-select): true iff the CURRENT
  // chart type + metric selection was auto-derived from the graph scope's
  // metric conditions (and not since manually overridden). It gates two
  // behaviours: (a) clearing all metric conditions reverts to the empty
  // rules-table state ONLY when the config was auto (a hand-built chart is
  // left alone); (b) auto-select re-derives only while the user hasn't taken
  // over (see maybeAutoSelectFromFilters()). Any manual chart-type click or
  // metric-control change flips it false via noteManualChartEdit().
  let autoSelectedFromFilters = false;
  function noteManualChartEdit() {
    autoSelectedFromFilters = false;
  }
  let barStyle = "bars"; // "bars" | "dots" (lollipop) — bar chart only
  let barMetricKey = null;
  let scatterXKey = null;
  let scatterYKey = null;
  // R4 Wave 1b (item 3): radar no longer uses fixed metric GROUPS. The user
  // now checks INDIVIDUAL radar-valid metrics (radarEligibleMetrics below) in a
  // dropdown, up to RADAR_MAX_METRICS, and ONE radar is drawn with them as
  // axes. `radarMetricKeys` is that ordered selection (catalogue order, pruned
  // to what's currently eligible on every render). >= RADAR_MIN_METRICS are
  // needed to draw a meaningful polygon (fewer shows honest guidance).
  let radarMetricKeys = [];
  let phaseFamilyId = null;
  let slopeMetricKey = null;
  // {from,to} day-pairs ("YYYY-MM-DD"), or null. Wave 2 (item 4a): these START
  // null and STAY null until the user edits a date input — no half-split
  // auto-fill anymore. Owner-picked from the first edit on, never silently
  // recomputed out from under the user.
  let slopeWindowA = null;
  let slopeWindowB = null;
  // Batch 4 wave 2 (the last two chart types).
  let byYearMetricKey = null;
  let dumbbellMetricKey = null;
  // Dumbbell is a time-window chart (owner correction): {from,to} day-pairs,
  // mirroring slopeWindowA/B exactly. Wave 2 (item 4a): START null and STAY
  // null until the user edits a date input — no half-split auto-fill; then
  // owner-picked, never silently recomputed.
  let dumbbellWindowA = null;
  let dumbbellWindowB = null;

  // B8b (Benchmark, decision 44e). `benchmarkAnchorId` is the checked
  // roster's own id (never a candidate outside it — see renderMetricControls'
  // benchmark branch); `benchmarkMetricKeys` is the multi-select's chosen set
  // (>=4, <=12). `benchmarkPoolCache` memoizes the last pool fetch by an
  // identity key (scope + metric keys + candidate id set — R6 owner fix 1: the
  // pool is restricted to the candidate set, so a change to it must invalidate
  // the cache) so switching the ANCHOR alone re-renders without a refetch (task
  // brief) — see renderChart()'s benchmark branch. The RADAR branch shares this
  // same cache (NIT4): its pool has the identical key shape, so an unchanged
  // scope/metrics/candidates re-render skips the refetch there too.
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

  // R6b (owner correction to 41b88b7): the roster's Best/Worst modes are
  // metric-based again — "Best" = the top of the filtered candidate set by the
  // chart's active metric, "Worst" = the bottom — so the card title's honest
  // phrasing for those modes is "top N" / "top N by <metric>" / "bottom N"
  // (see resolveSeedMetric() + card.js's rankedCountPhrase). Only the DEFAULT
  // auto-select ("Top names" mode, the initial one) ranks by whole-DB career
  // games (biggest names), titled "N most-capped players". These four vars
  // track the metric provenance for the Best/Worst titles, restored from the
  // pre-R6 machinery:
  //   • seedSortKey/Discipline — which metric ranked the MOST RECENT successful
  //     seed (the graph scope's active sort at seed time), the fallback title
  //     provenance for chart types with no single rankable metric.
  //   • lastRankMetricKey/Discipline — which metric most recently ranked the
  //     CHECKED set via a Best/Worst derivation (bar/scatter-Y only —
  //     see rankMetricForActiveType/deriveChecked); null whenever the
  //     seed-order fallback was used or the roster is dirty.
  let seedSortKey = null;
  let seedSortDiscipline = null;
  let lastRankMetricKey = null;
  let lastRankMetricDiscipline = null;

  // R7 Wave 2 (item 17b): NO premature player cap. Before a chart type is
  // picked the roster is UNCAPPED (Infinity) — the full selected/candidate set
  // is kept, never pre-truncated to 15. The cap kicks in only when a chart type
  // that actually caps the pool is chosen, at which point activeMaxCap()
  // switches to that type's own CHART_CAPS.max and deriveChecked() (re-run on
  // the type click) trims the checked set down to it.
  // NOTE (owner point 13): even then this caps only what's CHECKED/plotted,
  // never the candidate POOL — the pool is the entire filtered set
  // (seedFromFilteredSet no longer takes a cap).
  function activeMaxCap() {
    return chartType ? CHART_CAPS[chartType].max : Infinity;
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
    // The pool seeds from the SHARED scope (seedFromFilteredSet reads `store`,
    // the shared filter state), so an empty pool has exactly two honest causes:
    //  • a scope has been searched (Stats search, or a graph "Apply to graph")
    //    but matches nobody -> tell the user to adjust and search/apply again;
    //  • nothing has ever been searched -> point at BOTH entry points (the
    //    Stats tab AND this graph's own Filters button — item 1: the empty
    //    state must no longer dead-end on Stats alone).
    if (hasStatsResults() || graphFiltersApplied) {
      return "No players match the current filters — adjust them and apply again, or search on the Stats tab.";
    }
    return "Run a search on the Stats tab first, or set filters here and apply.";
  }

  /**
   * R5 Wave 1b (item 1) — FILTER-DRIVEN AUTO-SELECT.
   *
   * The archetype rule table (#metrics × #players -> chart type), keyed off the
   * metric keys the graph scope's applied advanced conditions name:
   *
   *   #metrics | condition                              | chart type
   *   ---------+----------------------------------------+-----------------
   *      >= 3  | (radar-valid subset, capped to 10)     | radar
   *        2   | —                                      | scatter (X,Y)
   *        1   | (single-metric ranking)                | bar
   *        0   | —                                      | (no auto-select)
   *
   * This is derived ENTIRELY from the applied filters — it is NOT a default:
   * with no metric conditions it does nothing (and the empty rules-table state
   * shows), and clearing the conditions later reverts (maybeAutoSelect…). It
   * sets the SAME per-type metric variables a manual pick would, so everything
   * downstream (persistence, the card title) behaves identically. Returns the
   * chosen chart type, or null if it couldn't derive one (no valid metric keys
   * for the discipline).
   */
  function applyAutoSelect(keys, state) {
    const discipline = state.discipline;
    const valid = keys.filter((k) => getMetric(k, discipline));
    if (!valid.length) return null;

    let type;
    if (valid.length >= 3) {
      // Radar needs radar-VALID axes (a defined better-direction). Fall back to
      // the 2-/1-metric archetypes if fewer than 3 of the conditions qualify.
      const eligible = radarEligibleMetrics(discipline, state.formats);
      const radarKeys = valid.filter((k) => eligible.some((m) => m.key === k)).slice(0, RADAR_MAX_METRICS);
      if (radarKeys.length >= RADAR_MIN_METRICS) {
        type = "radar";
        radarMetricKeys = radarKeys;
        metricEverChosen = true;
      } else if (valid.length >= 2) {
        type = "scatter";
        scatterXKey = valid[0];
        scatterYKey = valid[1];
        markMetricChosen(valid[1]);
      } else {
        type = "bar";
        barMetricKey = valid[0];
        markMetricChosen(valid[0]);
      }
    } else if (valid.length === 2) {
      type = "scatter";
      scatterXKey = valid[0];
      scatterYKey = valid[1];
      markMetricChosen(valid[1]);
    } else {
      // Exactly one metric condition -> bar (a single-metric ranking).
      type = "bar";
      barMetricKey = valid[0];
      markMetricChosen(valid[0]);
    }

    chartType = type;
    return type;
  }

  /** Run (or revert) filter-driven auto-select against the current graph scope.
   * Called after every seed that follows a scope change (graph "Apply to
   * graph", or an inherited Stats scope). Idempotent and safe: it only acts
   * when there ARE metric conditions and the user hasn't manually taken over,
   * and only reverts when the conditions are gone AND the last config was auto.
   * Never overrides a hand-built chart. */
  function maybeAutoSelectFromFilters() {
    const state = store.get();
    const keys = metricConditionKeys(state).filter((k) => getMetric(k, state.discipline));
    if (keys.length === 0) {
      // Conditions cleared. Revert to the empty rules-table state only if the
      // current config was itself auto-derived (a hand-built chart is left
      // exactly as the user made it).
      if (autoSelectedFromFilters) {
        chartType = null;
        chosenMetricKey = null;
        metricEverChosen = false;
        barMetricKey = scatterXKey = scatterYKey = null;
        slopeMetricKey = byYearMetricKey = dumbbellMetricKey = phaseFamilyId = null;
        radarMetricKeys = [];
        autoSelectedFromFilters = false;
        syncChartTypeButtons();
        syncBarStyleVisibility();
        renderMetricControls();
      }
      return;
    }
    // Conditions present. Auto-select unless the user has manually taken over
    // (picked/edited a chart by hand since the last auto/clear).
    if (chartType && !autoSelectedFromFilters) return;
    const picked = applyAutoSelect(keys, state);
    if (!picked) return;
    autoSelectedFromFilters = true;
    syncChartTypeButtons();
    syncBarStyleVisibility();
    renderMetricControls();
    renderPlayerList();
  }

  /** R5 Wave 1b (item 1) — the empty-state infographic RULES TABLE, shown in
   * the stage IN PLACE OF the paper card when no chart type is selected and no
   * metric conditions are applied (fresh load, or after Clear). One row per
   * chart type with a tight, accurate "what it needs / how to use it" line
   * from CHART_RULES. `leadText` (optional) is a single sentence shown above
   * the table — used to surface poolStatusReason() when the pool isn't ready
   * so the empty state still tells the user how to get data. */
  function showStageRulesTable(leadText) {
    els.exportRow.hidden = true;
    els.cardHost.hidden = true;
    const rows = CHART_TYPES.map(
      (t) => `<tr><th scope="row">${escHtml(t.label)}</th><td>${escHtml(CHART_RULES[t.key] ? CHART_RULES[t.key].tagline : "")}</td></tr>`
    ).join("");
    els.stageGuidance.innerHTML = `
      <div class="graph-rules">
        <p class="graph-rules__lead">${escHtml(leadText || "Pick a chart type below, or apply a metric filter to auto-build one.")}</p>
        <table class="graph-rules__table">
          <caption class="graph-rules__caption">What each chart is for</caption>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    els.stageGuidance.hidden = false;
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
      // evaluateTypeStatus()'s ok/greyed state depends on
      // selection.candidateCount() — every candidate-pool change (a fresh seed
      // landing async, a manual add/remove, a Best/Worst re-derivation) must
      // re-sync the chart-type picker too, not just the roster dropdown, or the
      // tiles freeze at whatever their pre-seed/pre-edit state happened to be
      // (e.g. every type reading "greyed" on first paint, before the initial
      // seed's candidates ever arrive, and never recovering).
      syncChartTypeButtons();
      markDirty({ paramsChanged: true });
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

  // Wave 2 (item 4a): the Slope/Dumbbell Window A/B defaults are GONE. The
  // windows start empty (slopeWindowA/B and dumbbellWindowA/B stay null on
  // entry) and stay null until the user actually edits a date input — the owner
  // wants both windows PICKED, like a metric, never pre-filled from a
  // half-split of the scope. renderChart()'s `windowsReady` guards already show
  // "Pick both date windows to draw this chart." while they're null, so no
  // seeder is needed anymore (the old computeHalfSplitWindows /
  // ensureSlope/DumbbellWindowDefaults helpers were removed with this change).

  // ── Selection model: three auto-select sources (R6b) ────────────────────────
  //
  // The roster's auto-selection has three modes plus Manual:
  //   • "topnames" (DEFAULT) — biggest names by whole-DB career games. This is
  //     the ONE new behaviour from R6: when a filter/graph is first set and the
  //     candidate pool exceeds the cap, the players auto-picked to fill it are
  //     the most-capped (biggest names), not a metric ranking. Uses
  //     players.js's fetchCareerGames (COUNT(DISTINCT match_id) over ALL
  //     player_matches — the same appearances measure the omnisearch player
  //     search ranks by), scope-independent by design.
  //   • "best"/"worst" — the FILTERED SET ranked by the chart's ACTIVE metric
  //     (owner correction to 41b88b7: these are metric-based again, as they
  //     were pre-R6). "Best" = the top of the pool by that metric, "Worst" =
  //     the bottom. Chart types with no single rankable metric (radar/phases/
  //     slope/byyear/dumbbell) fall back to the seed's own sort order (reversed
  //     for "worst").
  //   • "manual" — the user's literal hand-picks; nothing here recomputes them.

  /** The metric to rank Best/Worst by for the CURRENT chart type. Bar ranks by
   * its own single displayed metric; scatter ranks by its Y axis (X is the
   * OTHER axis, not "the" metric). Every other chart type
   * (radar/phases/slope/byyear/dumbbell) shows a GROUP of metrics at once or
   * needs its own per-player chart query (two windows/sides) to get a single
   * value — too expensive to fetch just for a ranking preview across the WHOLE
   * candidate pool — so those fall back to "the seed sort" in deriveChecked()
   * (returns null here to signal that fallback). */
  function rankMetricForActiveType(state) {
    if (chartType === "bar") return getMetric(barMetricKey, state.discipline);
    if (chartType === "scatter") return getMetric(scatterYKey, state.discipline);
    return null;
  }

  // Guards a rank fetch that's been superseded by a newer one (mode/metric/type
  // changed again before the first fetch returned) — same "ignore stale async
  // result" idiom renderChart() already uses via loadToken.
  let rankDeriveToken = 0;

  /**
   * Re-derive the CHECKED set for a non-manual mode by ranking the FULL
   * candidate pool (never just the currently-checked subset — a hidden
   * candidate must be able to become checked too) and keeping the top `cap`
   * many. A no-op for "manual" (just records the mode and re-renders — "Manual
   * leaves user picks alone").
   *
   * Ranking axis by mode:
   *   • "topnames" — whole-DB career games (fetchCareerGames), most-capped
   *     first. The DEFAULT auto-select ("biggest names"). Metric-independent.
   *   • "best"/"worst" — the chart's ACTIVE metric (rankMetricForActiveType),
   *     best-first / worst-first. SPEC §8.1's hasMetricData rule is applied
   *     exactly as at chart-render time: a 0/NULL rate player has no result to
   *     rank, so it can't be "best" or "worst" and is never included just to
   *     fill the cap. For chart types with no single rankable metric, the
   *     "seed sort" fallback is the candidate pool's OWN existing order (the
   *     seed query's table-sort order), reversed for "worst".
   *
   * NUMBERS RULE: this only decides WHICH players are auto-selected. It never
   * changes any metric value computed for a player.
   *
   * On any fetch failure we fall back to the candidate pool's own order
   * (reversed for "worst") so the picker never empties or crashes — the next
   * real chart render still gets its own retry via renderChart()'s try/catch.
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

    // DEFAULT auto-select: biggest names by whole-DB career games. Metric
    // provenance does not apply here — the title says "N most-capped players"
    // via currentCareerGamesRank(), so clear any stale rank-metric.
    if (newMode === "topnames") {
      let gamesById = null;
      try {
        gamesById = await fetchCareerGames();
      } catch {
        gamesById = null;
      }
      if (token !== rankDeriveToken) return; // superseded by a later derive call
      let ranked;
      if (gamesById) {
        ranked = pool.slice().sort((a, b) => {
          const ga = gamesById.get(a.id) ?? 0;
          const gb = gamesById.get(b.id) ?? 0;
          if (ga !== gb) return gb - ga; // most-capped first
          return String(a.id).localeCompare(String(b.id)); // deterministic tiebreak
        });
      } else {
        ranked = pool.slice();
      }
      if (token !== rankDeriveToken) return;
      selection.setChecked(ranked.slice(0, cap).map((p) => p.id), { dirty: false });
      lastRankMetricKey = null;
      lastRankMetricDiscipline = null;
      return;
    }

    // "best"/"worst": rank the filtered set by the chart's active metric.
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

  /** Wired to the bar/scatter-Y metric selects — the ones that feed
   * rankMetricForActiveType. R6b (owner correction): Best/Worst rank by the
   * chart's active metric again, so when that metric changes the Best/Worst
   * checked set must re-derive ("switching to Best/Worst re-derives on metric
   * change too"). A no-op beyond the render for "manual" (user picks are left
   * alone) and "topnames" (the DEFAULT ranks by career games, which is
   * metric-independent — the displayed metric only changes the chart's own
   * sort/axis, not WHICH players are selected). */
  function onRankMetricChanged() {
    const mode = selection.getMode();
    if (mode === "best" || mode === "worst") deriveChecked(mode);
    markDirty({ paramsChanged: true });
  }

  // ── Metric controls (rebuilt per chart type) ──────────────────────────────

  /** R2-2a: searchSelect options for a single-metric picker (value = metric
   * key, label from the catalogue). No placeholder ROW — the component's own
   * placeholder text covers the "no metric picked yet" state (item 4: no
   * auto-pick). */
  function metricSelectOptions(metrics) {
    return metrics.map((m) => ({ value: m.key, label: m.label }));
  }

  /** R2-2a: mount a per-type metric searchSelect into the metric-controls host
   * carrying `role`, register it for teardown, and return the handle. When the
   * scope offers no eligible metric the control renders DISABLED showing
   * `emptyLabel` — the same honest dead-end the old `<option>No … available…`
   * gave, but as a greyed, non-openable control. `onChangeVal(value|null)` is
   * the per-type change handler (identical body to the old select's `change`). */
  function mountMetricSelect(role, metrics, value, onChangeVal, { placeholder = "Choose a metric…", ariaLabel = "Metric", emptyLabel = null } = {}) {
    const host = els.metricControls.querySelector(`[data-role="${role}"]`);
    if (!host) return null;
    const hasMetrics = metrics.length > 0;
    const handle = mountSearchSelect(host, {
      options: hasMetrics ? metricSelectOptions(metrics) : [],
      value: hasMetrics ? value : null,
      placeholder: hasMetrics ? placeholder : (emptyLabel || placeholder),
      filterPlaceholder: "Search metrics…",
      ariaLabel,
      disabled: !hasMetrics,
      // Native-<select> parity: a clear row back to "no metric picked" (item 4:
      // no auto-pick). Only when there ARE metrics — the disabled empty state
      // has no list to open.
      allowEmptyLabel: hasMetrics ? placeholder : null,
      onChange: onChangeVal,
    });
    metricControlSelects.push(handle);
    return handle;
  }

  /** Adopt the shared chosen metric (item 4) into a per-type key ONLY when it's
   * valid for that type's own eligible list; otherwise null — the type then
   * shows an honest "choose a metric" message rather than silently auto-picking
   * one, and the user's metric survives every type switch where it IS valid. */
  function adoptChosenMetric(metrics) {
    return chosenMetricKey && metrics.some((m) => m.key === chosenMetricKey) ? chosenMetricKey : null;
  }

  // ── Item 6: "needs input" red outline ──────────────────────────────────────
  // A chart that can't draw because a REQUIRED control is empty red-outlines
  // exactly that control (the stylist styles `.needs-input`). ONE class string
  // everywhere; toggled wherever the control renders/changes and re-checked at
  // render time so it clears the instant the field is filled.
  function setNeedsInput(el, on) {
    if (el) el.classList.toggle("needs-input", !!on);
  }
  /** Red-outline whichever of a Slope/Dumbbell window's 4 date inputs are still
   * empty (item 6). `prefix` is "slope" | "dumbbell". Re-run on render and on
   * every window-input change so an input clears its outline as soon as it's
   * filled. */
  function syncWindowNeedsInput(prefix) {
    for (const role of [`${prefix}-a-from`, `${prefix}-a-to`, `${prefix}-b-from`, `${prefix}-b-to`]) {
      const el = els.metricControls.querySelector(`[data-role="${role}"]`);
      setNeedsInput(el, el && !el.value);
    }
  }

  function renderMetricControls() {
    // R2-2a/R2-2b-i: dispose the previous render's searchSelect pickers (each
    // holds a document click listener) before their host nodes are replaced by
    // the innerHTML rebuilds below. This is now the ONLY per-render teardown in
    // metricControls: radar/benchmark's old wireDropdown panels became
    // searchSelect components, so metricControlSelects covers them too.
    for (const h of metricControlSelects) {
      try { h.destroy(); } catch { /* already gone */ }
    }
    metricControlSelects = [];
    const state = store.get();
    const discipline = state.discipline;
    const formats = state.formats;

    // R7 Wave 2 (item 17a): a metric is pickable BEFORE any chart type. With no
    // type chosen, show a plain "Metric" select over every eligible metric for
    // the scope; picking one sets the SHARED chosenMetricKey, which then persists
    // and is adopted (adoptChosenMetric) into whichever chart type is chosen
    // next — so the flow is order-independent (metric first OR chart first). No
    // chart renders yet (renderChart still shows the rules-table empty state
    // until a type is picked); this only records the intended metric.
    if (!chartType) {
      const metrics = eligibleMetrics(discipline, formats);
      const selected = adoptChosenMetric(metrics);
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <div class="graph-metric-select" data-role="pretype-metric"></div>
      `;
      mountMetricSelect("pretype-metric", metrics, selected, (key) => {
        if (key) markMetricChosen(key);
        else chosenMetricKey = null;
        // Re-sync only — no chart to render without a type yet.
        syncChartTypeButtons();
      });
      return;
    }

    if (chartType === "bar") {
      const metrics = eligibleMetrics(discipline, formats);
      barMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <div class="graph-metric-select" data-role="bar-metric"></div>
      `;
      mountMetricSelect("bar-metric", metrics, barMetricKey, (val) => {
        noteManualChartEdit(); // item 1: user is refining by hand, not auto
        barMetricKey = val || null;
        if (barMetricKey) markMetricChosen(barMetricKey);
        syncChartTypeButtons();
        onRankMetricChanged();
      });
    } else if (chartType === "scatter") {
      const metrics = eligibleMetrics(discipline, formats);
      // item 4: no auto-pick. The Y axis carries the shared chosen metric; X is
      // scatter-local. Both start on the "Choose a metric…" placeholder until
      // explicitly picked. (R6: the checked set is auto-selected by whole-DB
      // career games, not by this metric — onRankMetricChanged only re-renders.)
      scatterYKey = adoptChosenMetric(metrics) || (scatterYKey && metrics.some((m) => m.key === scatterYKey) ? scatterYKey : null);
      scatterXKey = scatterXKey && metrics.some((m) => m.key === scatterXKey) ? scatterXKey : null;
      els.metricControls.innerHTML = `
        <span class="graph-control-label">X axis</span>
        <div class="graph-metric-select" data-role="scatter-x"></div>
        <span class="graph-control-label">Y axis</span>
        <div class="graph-metric-select" data-role="scatter-y"></div>
      `;
      mountMetricSelect("scatter-x", metrics, scatterXKey, (val) => {
        noteManualChartEdit();
        scatterXKey = val || null;
        if (scatterXKey) metricEverChosen = true;
        syncChartTypeButtons();
        markDirty({ paramsChanged: true });
      }, { ariaLabel: "X axis metric" });
      mountMetricSelect("scatter-y", metrics, scatterYKey, (val) => {
        noteManualChartEdit();
        scatterYKey = val || null;
        if (scatterYKey) markMetricChosen(scatterYKey);
        syncChartTypeButtons();
        onRankMetricChanged();
      }, { ariaLabel: "Y axis metric" });
    } else if (chartType === "radar") {
      // R4 Wave 1b (item 3): INDIVIDUAL radar-valid metrics (no fixed groups),
      // max RADAR_MAX_METRICS. R2-2b-i: the searchable MULTI-select component
      // (mountSearchMultiSelect) — type to filter axes, tick several in one open
      // panel. Max-only cap (no min FLOOR that auto-refills; item 3's "no
      // auto-pick" means an empty radar stays empty until the user picks), with
      // the at-cap note carried by the component's noteFor hook.
      const eligible = radarEligibleMetrics(discipline, formats);
      // Prune any keys no longer eligible (phase gating / discipline switch),
      // preserving selection order; NEVER auto-fill toward a floor.
      radarMetricKeys = eligible.map((m) => m.key).filter((k) => radarMetricKeys.includes(k));
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metrics (axes)</span>
        <div class="graph-metric-select" data-role="radar-metrics"></div>
      `;
      const radarHost = els.metricControls.querySelector('[data-role="radar-metrics"]');
      if (radarHost) {
        const handle = mountSearchMultiSelect(radarHost, {
          options: eligible.map((m) => ({ value: m.key, label: m.label })),
          values: radarMetricKeys,
          placeholder: eligible.length ? "Choose metrics…" : "No metrics available",
          filterPlaceholder: "Search metrics…",
          ariaLabel: "Radar metrics (axes)",
          disabled: eligible.length === 0,
          summarize: (n, total) => `${n} of ${total} metrics`,
          // Cap guard: once RADAR_MAX_METRICS are checked, every UNchecked row is
          // disabled (the established cap-block idiom) and the note appears. No
          // minimum floor here.
          isOptionDisabled: (val, selected) => !selected.has(val) && selected.size >= RADAR_MAX_METRICS,
          noteFor: (selected) =>
            selected.size >= RADAR_MAX_METRICS ? `Up to ${RADAR_MAX_METRICS} metrics — untick one to swap.` : null,
          onChange: (vals) => {
            noteManualChartEdit();
            // Preserve catalogue order so axes are stable regardless of tick order.
            radarMetricKeys = eligible.map((m) => m.key).filter((mk) => vals.includes(mk));
            if (radarMetricKeys.length) metricEverChosen = true;
            syncChartTypeButtons();
            markDirty({ paramsChanged: true });
          },
        });
        metricControlSelects.push(handle);
      }
    } else if (chartType === "phases") {
      const families = eligiblePhaseFamilies(discipline, formats);
      // item 4: no auto-pick — require an explicit family choice.
      if (phaseFamilyId && !families.some((f) => f.id === phaseFamilyId)) phaseFamilyId = null;
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric family</span>
        <div class="graph-metric-select" data-role="phase-family"></div>
      `;
      const phaseHost = els.metricControls.querySelector('[data-role="phase-family"]');
      if (phaseHost) {
        const handle = mountSearchSelect(phaseHost, {
          options: families.map((f) => ({ value: f.id, label: f.label })),
          value: phaseFamilyId,
          placeholder: families.length ? "Choose a metric family…" : "No phase families available for this scope",
          filterPlaceholder: "Search families…",
          ariaLabel: "Metric family",
          disabled: families.length === 0,
          allowEmptyLabel: families.length ? "Choose a metric family…" : null,
          onChange: (val) => {
            noteManualChartEdit();
            phaseFamilyId = val || null;
            if (phaseFamilyId) metricEverChosen = true;
            syncChartTypeButtons();
            markDirty({ paramsChanged: true });
          },
        });
        metricControlSelects.push(handle);
      }
    } else if (chartType === "slope") {
      const metrics = eligibleMetrics(discipline, formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      slopeMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      // Item 4a: no window auto-fill — the inputs render blank (value="") until
      // the user picks both ends.
      const slopeDayAttrs = dayInputAttrs();
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <div class="graph-metric-select" data-role="slope-metric"></div>
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
      mountMetricSelect("slope-metric", metrics, slopeMetricKey, (val) => {
        noteManualChartEdit();
        slopeMetricKey = val || null;
        if (slopeMetricKey) markMetricChosen(slopeMetricKey);
        syncChartTypeButtons();
        markDirty({ paramsChanged: true });
      }, { emptyLabel: "No rate/percent metrics available for this scope" });
      const bindWindowSelect = (role, setter) => {
        const el = els.metricControls.querySelector(`[data-role="${role}"]`);
        if (el) {
          el.addEventListener("change", (e) => {
            setter(e.target.value);
            syncWindowNeedsInput("slope"); // item 6: clear the outline as inputs fill
            markDirty({ paramsChanged: true });
          });
        }
      };
      bindWindowSelect("slope-a-from", (v) => (slopeWindowA = { ...slopeWindowA, from: v }));
      bindWindowSelect("slope-a-to", (v) => (slopeWindowA = { ...slopeWindowA, to: v }));
      bindWindowSelect("slope-b-from", (v) => (slopeWindowB = { ...slopeWindowB, from: v }));
      bindWindowSelect("slope-b-to", (v) => (slopeWindowB = { ...slopeWindowB, to: v }));
      syncWindowNeedsInput("slope"); // item 6: outline the empty date inputs on render
    } else if (chartType === "byyear") {
      // Batch 4 wave 2, task 1: metrics whose sqlExpression recombines
      // cleanly per (player, year) — timeseries.js's own whitelist (kind
      // total/rate, innings-sourced); never re-derived here (§8.2).
      const metrics = eligibleMetrics(discipline, formats).filter((m) => timeseriesSupported(m));
      byYearMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <div class="graph-metric-select" data-role="byyear-metric"></div>
      `;
      mountMetricSelect("byyear-metric", metrics, byYearMetricKey, (val) => {
        noteManualChartEdit();
        byYearMetricKey = val || null;
        if (byYearMetricKey) markMetricChosen(byYearMetricKey);
        syncChartTypeButtons();
        markDirty({ paramsChanged: true });
      }, { emptyLabel: "No year-by-year metric available for this scope" });
    } else if (chartType === "dumbbell") {
      // Time-window Dumbbell (owner correction — NOT a Pace/Spin chart): the
      // SAME controls as Slope — one rate/percent metric + a Window A/Window B
      // month range each — since it draws Slope's exact data (fetchWindowMetric
      // per window) as dot-bar-dot. Works for batting AND bowling, any gender;
      // no availability gate.
      const metrics = eligibleMetrics(discipline, formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      dumbbellMetricKey = adoptChosenMetric(metrics); // item 4: no auto-pick
      // Item 4a: no window auto-fill — the inputs render blank (value="") until
      // the user picks both ends.
      const dumbbellDayAttrs = dayInputAttrs();
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <div class="graph-metric-select" data-role="dumbbell-metric"></div>
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
      mountMetricSelect("dumbbell-metric", metrics, dumbbellMetricKey, (val) => {
        noteManualChartEdit();
        dumbbellMetricKey = val || null;
        if (dumbbellMetricKey) markMetricChosen(dumbbellMetricKey);
        syncChartTypeButtons();
        markDirty({ paramsChanged: true });
      }, { emptyLabel: "No rate/percent metric available for this scope" });
      const bindWindowSelect = (role, setter) => {
        const el = els.metricControls.querySelector(`[data-role="${role}"]`);
        if (el) {
          el.addEventListener("change", (e) => {
            setter(e.target.value);
            syncWindowNeedsInput("dumbbell"); // item 6: clear the outline as inputs fill
            markDirty({ paramsChanged: true });
          });
        }
      };
      bindWindowSelect("dumbbell-a-from", (v) => (dumbbellWindowA = { ...dumbbellWindowA, from: v }));
      bindWindowSelect("dumbbell-a-to", (v) => (dumbbellWindowA = { ...dumbbellWindowA, to: v }));
      bindWindowSelect("dumbbell-b-from", (v) => (dumbbellWindowB = { ...dumbbellWindowB, from: v }));
      bindWindowSelect("dumbbell-b-to", (v) => (dumbbellWindowB = { ...dumbbellWindowB, to: v }));
      syncWindowNeedsInput("dumbbell"); // item 6: outline the empty date inputs on render
    } else if (chartType === "benchmark") {
      // B8b (decision 44e). Anchor picker: the searchable SINGLE-pick component
      // over the CHECKED roster ONLY (task brief) — unlike every other chart
      // type, the pool this chart draws from is the WHOLE filtered set
      // regardless of roster size (CHART_CAPS.benchmark = {min:1, max:15} — see
      // players.js's doc comment on why the roster only sources the anchor
      // choice here). Metric picker: the searchable MULTI-select component
      // (R2-2b-i) — min-4/max-12, enforced via its isOptionDisabled hook. (The
      // draw still groups metrics by kind — benchmark.js's BENCHMARK_KIND_LABELS
      // remains the one source for the CHART's own section headers; the picker
      // is a flat searchable list now.)
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

      els.metricControls.innerHTML = `
        <span class="graph-control-label">Anchor</span>
        <div class="graph-metric-select" data-role="benchmark-anchor"></div>
        <span class="graph-control-label">Metrics</span>
        <div class="graph-metric-select" data-role="benchmark-metrics"></div>
      `;

      const anchorHost = els.metricControls.querySelector('[data-role="benchmark-anchor"]');
      if (anchorHost) {
        // No allowEmptyLabel — the anchor is mandatory (native-<select> parity:
        // one roster member is always selected when the roster is non-empty).
        const anchorHandle = mountSearchSelect(anchorHost, {
          options: roster.map((p) => ({ value: p.id, label: p.name })),
          value: benchmarkAnchorId,
          placeholder: roster.length ? "Choose an anchor player…" : "Check a player below first",
          filterPlaceholder: "Search players…",
          ariaLabel: "Anchor player",
          disabled: roster.length === 0,
          onChange: (val) => {
            benchmarkAnchorId = val || null;
            // An explicit benchmark configuration counts as "a metric chosen"
            // for the honest invalid-metric guidance (benchmark has no single
            // metric — anchor + the metric set together specify it).
            metricEverChosen = true;
            syncChartTypeButtons();
            // "Changing anchor re-renders, no refetch" (task brief) — enforced
            // by renderChart()'s pool cache (keyed on scope+metrics, NOT
            // anchor), not by anything special here; markDirty is the same call
            // every other control makes.
            markDirty({ paramsChanged: true });
          },
        });
        metricControlSelects.push(anchorHandle);
      }

      const metricsHost = els.metricControls.querySelector('[data-role="benchmark-metrics"]');
      if (metricsHost) {
        // Min-4/max-12 guard via the component's isOptionDisabled hook — same
        // "disable the box(es) that would violate the floor/cap" idiom as
        // filters.js's format/team-type dropdowns: at the floor of 4 every
        // CHECKED row disables (can't drop below 4); at the cap of 12 every
        // UNchecked row disables.
        const metricsHandle = mountSearchMultiSelect(metricsHost, {
          options: eligible.map((m) => ({ value: m.key, label: m.label })),
          values: benchmarkMetricKeys,
          placeholder: "Choose metrics…",
          filterPlaceholder: "Search metrics…",
          ariaLabel: "Benchmark metrics",
          summarize: (n, total) => `${n} of ${total} metrics`,
          isOptionDisabled: (val, selectedSet) => {
            const checked = selectedSet.has(val);
            const atFloor = checked && selectedSet.size <= 4;
            const atCap = !checked && selectedSet.size >= 12;
            return atFloor || atCap;
          },
          onChange: (vals) => {
            benchmarkMetricKeys = vals; // already in catalogue order (options order)
            metricEverChosen = true; // item 4: benchmark metric-set edit counts
            syncChartTypeButtons();
            markDirty({ paramsChanged: true });
          },
        });
        metricControlSelects.push(metricsHandle);
      }
    }
  }

  // ── Player list UI (Batch 8, task 1 — v1's two-list model) ─────────────────
  //
  // The vertical always-visible list is gone; in its place, a dropdown BUTTON
  // ("N of M selected") opens a checkbox panel with one row per CANDIDATE
  // (the full pool, never truncated): checkbox (checked = plotted) + name +
  // a muted meta + a small × (remove from the pool entirely). Above the rows,
  // a "Show: Top names | Best | Worst | Manual" segmented appears ONLY once
  // there are more candidates than the active chart type can plot (v1's
  // rankAndApply gate) — Top names/Best/Worst re-derive `checked` by rank (see
  // deriveChecked() above); Manual leaves whatever's checked alone.
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
    if (mode === "topnames") return "Top Names";
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

    // R7 Wave 2 (item 21): the "Show: Top names | Best | Worst | Manual" row is
    // visible whenever there's a roster at all (total > 0) — surfaced in the
    // controls, not hidden behind a "more candidates than the cap" gate as
    // before, so the user can always see and switch the roster mode directly.
    // (`cap` is retained below for the per-row checkbox at-cap disabling.)
    const showModeSwitch = total > 0;
    els.rosterModeRow.hidden = !showModeSwitch;
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

  // ── Chart-type availability engine (R7 Wave 2, item 18) ────────────────────
  //
  // The old "Recommend" engine — which nudged the user toward one "best-fit"
  // chart type with a Recommended badge — was REMOVED entirely (owner: it kept
  // tagging Scatter and was unwanted). What survives is the HONEST availability
  // check below: evaluateTypeStatus() decides whether a chart type CAN render
  // under the current scope/pool and, if not, gives one plain-English reason
  // (surfaced in the stage on click, and as a passive "greyed" hint on the
  // tile). It never picks a type for the user — the user picks freely, in any
  // order relative to the metric.

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
  function evaluateTypeStatus(typeKey, state, { candidateCountOverride, poolReasonOverride, eligibleMetricsForScope } = {}) {
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
    // NIT5: the base scope-eligible metric list is identical across the
    // slope/byyear/dumbbell branches below (all keyed on state.discipline +
    // state.formats). syncChartTypeButtons() computes it ONCE and threads it in
    // here so a single sync pass doesn't rebuild it per type; other callers
    // (the "Graph this player" chooser) omit the override and recompute exactly
    // as before. Note: the radar/benchmark branches read their own
    // wrapper predicates (benchmarkEligibleMetrics lives in benchmark.js,
    // outside this file), so those are intentionally left untouched.
    const eligibleForScope = eligibleMetricsForScope !== undefined ? eligibleMetricsForScope : eligibleMetrics(state.discipline, state.formats);
    if (typeKey === "radar" && radarEligibleMetrics(state.discipline, state.formats).length < RADAR_MIN_METRICS) {
      return { ok: false, reason: `Needs at least ${RADAR_MIN_METRICS} radar metrics for this scope` };
    }
    if (typeKey === "phases" && eligiblePhaseFamilies(state.discipline, state.formats).length === 0) {
      return { ok: false, reason: "No phase metric families available for this scope" };
    }
    if (typeKey === "slope" && eligibleForScope.filter((m) => m.kind === "rate" || m.kind === "percent").length === 0) {
      return { ok: false, reason: "No rate/percent metric available for this scope" };
    }
    if (typeKey === "byyear" && eligibleForScope.filter((m) => timeseriesSupported(m)).length === 0) {
      return { ok: false, reason: "No year-by-year metric available for this scope" };
    }
    if (typeKey === "dumbbell" && eligibleForScope.filter((m) => m.kind === "rate" || m.kind === "percent").length === 0) {
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

  /** searchSelect options for the chart-type picker under the current scope.
   * Every type stays SELECTABLE (never `disabled`) so picking an unavailable one
   * still shows the honest why-not sentence in the stage (decision 46f); an
   * "(unavailable)" hintSuffix is the only availability cue — the exact same cue
   * the R2-1 native <select> carried in its option text. */
  function chartTypeOptions(statuses) {
    return CHART_TYPES.map((t) => ({
      value: t.key,
      label: t.label,
      hintSuffix: statuses && statuses[t.key] && !statuses[t.key].ok ? "(unavailable)" : "",
    }));
  }

  function syncChartTypeButtons() {
    const state = store.get();
    // NIT5: compute the scope-eligible metric base ONCE and reuse it across
    // every evaluateTypeStatus() call in this pass (identical discipline +
    // formats for the whole loop) instead of rebuilding it in each type branch.
    const eligibleForScope = eligibleMetrics(state.discipline, state.formats);
    const statuses = {};
    for (const t of CHART_TYPES) statuses[t.key] = evaluateTypeStatus(t.key, state, { eligibleMetricsForScope: eligibleForScope });

    // R2-2a: chart type is the shared searchable dropdown now. Reflect the
    // current pick (null -> "Choose a chart type…" placeholder, decision 46f:
    // nothing is pre-selected) and refresh the "(unavailable)" hint suffixes.
    if (chartTypeSelect) {
      chartTypeSelect.setOptions(chartTypeOptions(statuses));
      chartTypeSelect.setValue(chartType);
    }
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
    markDirty();
  });

  // R2-2a: chart type is the shared searchable dropdown now — its onChange
  // (value string, or null for the "Choose a chart type…" placeholder) does
  // EXACTLY what the R2-1 native <select>'s "change" handler did. decision 46f
  // survives: unavailable types are never disabled, so picking one still sets it
  // (renderChart() then shows the honest stage sentence instead of a chart; see
  // evaluateTypeStatus()). Mounted here (once) rather than in the markup so the
  // onChange can close over the controller functions below.
  chartTypeSelect = mountSearchSelect(els.chartType, {
    options: chartTypeOptions(null),
    value: chartType,
    placeholder: "Choose a chart type…",
    filterPlaceholder: "Search chart types…",
    ariaLabel: "Chart type",
    // Native-<select> parity: a "Choose a chart type…" row clears the pick back
    // to null → the honest empty rules-table state (decision 46f), same as
    // re-selecting the old <select>'s placeholder option did.
    allowEmptyLabel: "Choose a chart type…",
    onChange: (val) => {
      if (val === chartType) return;
      chartType = val;
      // Item 1: a deliberate chart-type pick is the user taking over from any
      // filter-driven auto-selection — so clearing metric conditions later won't
      // wipe their chart.
      noteManualChartEdit();
      syncChartTypeButtons();
      syncBarStyleVisibility();
      clearCapNote();
      renderMetricControls();
      // The cap (and, for bar/scatter, the ranking metric) just changed
      // with the chart type. In "manual" mode, only trim any genuine overflow
      // (never re-pick). In "best"/"worst" mode, a synchronous silent trim
      // keeps the checked<=cap invariant true for the brief window before the
      // real async re-derivation (which re-ranks from the UNTOUCHED candidate
      // pool under the new cap/metric — this is what makes "switch to a bigger
      // chart type brings hidden players back" still true, see players.js's
      // class doc comment) replaces it moments later. Skipped when the placeholder
      // was re-selected (no type -> no cap): activeMaxCap() is Infinity then.
      if (chartType) {
        if (selection.getMode() === "manual") {
          selection.clampToCap();
        } else {
          selection.clampToCap({ silent: true });
          deriveChecked(selection.getMode());
        }
      }
      renderPlayerList();
      markDirty({ paramsChanged: true });
    },
  });

  // Owner item 7: the ONE control that actually draws the pending in-panel
  // state. Enabled/emphasised only while there are un-applied edits (see
  // updateUpdateBtn); Filters' own "Apply to graph" button draws separately.
  els.updateBtn.addEventListener("click", () => {
    renderAndClearDirty();
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

  // ── Graph Filters popup (R7 Wave 2, items 16 + 2) ───────────────────────────
  // The graph gets its OWN Filters popup, REUSING the Stats popup's section
  // factories (mountFilters / mountFilterDrawer) bound to the SHARED `store`
  // above — no fork of their internals. The shell is created and appended to
  // <body> by THIS module (index.html / main.js are untouched — document.body
  // append is the established popover pattern, e.g. filters.js's
  // wirePortalDropdown). Item 16: changing a filter here writes to the SHARED
  // store, so the edit is reflected on the Stats side too (and vice-versa); the
  // trigger button ("Apply to graph") re-seeds + re-renders the current chart
  // via onScopeChanged().
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

  // The two shared section factories, bound to the SHARED store (item 16).
  // Their control changes write to `store` (the shared filter state)
  // immediately — so the Stats pills/badge track them live — but nothing in the
  // GRAPH re-queries until "Apply to graph" runs onScopeChanged() below.
  // onChange here is a no-op (the graph has no pills/subtitle inside the popup —
  // the card's own footer, via store.describeScope(), is refreshed on
  // apply/render).
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
    // Keep the SHARED store coherent after scope edits, exactly as the Stats
    // side does: drop columns/conditions the new scope orphaned, and fall back
    // the sort key when it no longer resolves in the (possibly switched)
    // discipline — seedFromFilteredSet ranks by state.sort, so a stale key
    // would break the seed query. (These are the same corrections main.js runs
    // on its own Search, so applying from either side leaves the shared store
    // in the same coherent shape.)
    pruneIneligibleState(store);
    const gs = store.get();
    if (!getMetric(gs.sort.key, gs.discipline)) {
      store.set({ sort: { key: DEFAULT_SORT_KEY[gs.discipline] || "runs", dir: "desc" } });
    }
    // Item 16: filters have now been committed from inside the graph — a
    // first-class seed trigger, so onScopeChanged() -> seedSelection() will
    // populate the candidate pool from the shared scope even if the Stats table
    // was never searched. (Invalid/missing inputs never reach here —
    // validateDate() / graphDrawerController.validate() above both surface a
    // VISIBLE message in the popup and return early, so the failure is never
    // silent.)
    graphFiltersApplied = true;
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

  // "Clear filters" (R7 Wave 2, item 19): resets the SHARED filters to defaults
  // — the same reset the Stats "Clear" runs — then drops the graph back to its
  // fresh empty state (stale pool cleared, seed gate re-armed) WITHOUT leaving
  // the Graphs tab (onClearFilters passes returnToTable:false). The chart type
  // / metric the user picked are left alone (persistence rule) — this button
  // clears FILTERS, not the whole graph — so the stage honestly shows the
  // "set filters here and apply, or search on the Stats tab" empty state.
  container.querySelector('[data-role="graph-clear"]').addEventListener("click", () => {
    onClearFilters(); // reset the shared store to defaults (view stays on Graphs)
    graphFiltersApplied = false; // back behind the empty-state seed gate
    seeded = false;
    lastSeedKey = null;
    clearCapNote();
    // Drop the now-stale pool AND its checked set -> honest empty state.
    // setChecked([]) clamps to the (now empty) candidate ids and fires the
    // selection onChange, which re-renders the roster + chart-type tiles + stage.
    selection.setCandidates([]);
    selection.setChecked([], { dirty: false });
    // Metric eligibility may differ under the reset scope — refresh explicitly
    // (onChange only refreshes the metric controls for the benchmark type).
    renderMetricControls();
    // Item 7: "Clear filters" is a deliberate reset (like the graph's own
    // "Apply to graph"), NOT a pending in-panel tweak — so draw the resulting
    // honest empty state NOW and leave the gate clean. Before the Update-chart
    // gate, the selection.setChecked([]) above redrew via onChange; that hook
    // now only marks dirty, so this explicit draw restores the reset behaviour.
    renderAndClearDirty({ paramsChanged: true });
  });

  // "← Back to your table" (item 5): return to the Stats view with the existing
  // table intact. main.js/index.html are off-limits, so this drives the
  // existing Stats view toggle button — whose main.js handler restores the
  // cached table rows via applyView()/enterView() with NO re-query and no state
  // loss — rather than re-implementing the view switch here.
  container.querySelector('[data-role="graph-back"]').addEventListener("click", () => {
    const statsBtn = document.querySelector('[data-role="view"] .segmented__btn[data-value="table"]');
    if (statsBtn) statsBtn.click();
  });

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
    // decision 46f + item 16: seed the pool once a scope has actually been
    // committed — either a Stats search (hasStatsResults) OR the graph's own
    // "Apply to graph" (graphFiltersApplied). Before EITHER, Graphs sits in the
    // empty-state and runs no query of its own; the guidance line explains why
    // (poolStatusReason()). This is what makes the Graph Builder work
    // standalone: applyGraphFilters() sets graphFiltersApplied then calls
    // onScopeChanged() -> seedSelection(), which seeds from the shared scope
    // instead of silently no-opping.
    if (!hasStatsResults() && !graphFiltersApplied) return;
    const state = store.get();
    const key = scopeSeedKey(state);
    if (!force && seeded && key === lastSeedKey) return;
    // Item 16: a genuine scope change (new date range, discipline, …) resets the
    // Slope/Dumbbell Window A/B defaults so they re-derive from the fresh range
    // — the same reset the old Stats re-inherit (seedGraphScopeFromStats) did.
    // A force-reseed of the SAME scope ("Reset to filtered set") leaves the
    // user's own picked windows alone.
    if (key !== lastSeedKey) {
      slopeWindowA = null;
      slopeWindowB = null;
      dumbbellWindowA = null;
      dumbbellWindowB = null;
    }
    try {
      // The candidate POOL is the ENTIRE filtered result set (owner point 13 —
      // no 15-cap): the roster dropdown filters/renders a slice of it and each
      // chart type caps only what's CHECKED (deriveChecked()), never the pool.
      const seedPlayers = await seedFromFilteredSet(store);
      seeded = true;
      lastSeedKey = key;
      // Record what metric ranked this seed (the graph scope's active sort at
      // the moment seedFromFilteredSet ran), tied to the discipline it ran
      // under — this is the fallback title provenance resolveSeedMetric() uses
      // for Best/Worst on chart types with no single rankable metric.
      seedSortKey = state.sort.key;
      seedSortDiscipline = state.discipline;
      clearCapNote();
      // A fresh seed replaces the candidate POOL only — `checked` is then
      // derived per the CURRENTLY active mode ("auto-check per the active
      // mode"; DEFAULT "topnames" = biggest names by career games). A reseed
      // whose previous mode was "manual" lands in the DEFAULT "topnames":
      // manual picks were made against the OLD pool and have no meaning against
      // a brand new one, whereas an explicit "best"/"worst"/"topnames"
      // preference is about HOW to auto-pick, not which specific pool it's
      // applied to, so it persists.
      selection.setCandidates(seedPlayers);
      const modeForReseed = selection.getMode() === "manual" ? "topnames" : selection.getMode();
      await deriveChecked(modeForReseed);
    } catch (e) {
      showErrorStatus(e, () => seedSelection({ force: true }));
    }
  }

  /** R6b: 'most' only when the DEFAULT "topnames" auto-select actually chose a
   * subset — i.e. that mode is active, the roster is clean, and the pool
   * exceeds the cap (so a real "biggest names" selection happened). The card
   * title then reads "N most-capped players". Null (→ "N players") otherwise:
   *   - the roster was hand-edited (dirty), or the mode is "manual";
   *   - the mode is "best"/"worst" (a metric ranking — resolveSeedMetric drives
   *     that title instead, see currentRosterMeta);
   *   - every candidate fits within the cap (candidateCount <= cap): all are
   *     plotted, so no "top N by games" selection actually happened.
   * There is no 'least' — "topnames" is always most-capped-first. */
  function currentCareerGamesRank() {
    if (selection.getMode() !== "topnames") return null;
    if (selection.isDirty()) return null;
    if (selection.candidateCount() <= activeMaxCap()) return null;
    return "most";
  }

  /** The metric that actually ranked the CURRENT Best/Worst checked set,
   * resolved for `discipline` — or null if unknown/inapplicable. Prefers the
   * per-type Best/Worst ranking metric (lastRankMetricKey — bar/scatter-Y
   * only) when one was used; otherwise falls back to whatever metric ranked the
   * original SQL seed (seedSortKey — the graph scope's active sort at seed
   * time), which is exactly right for the "seed sort" fallback types
   * (radar/phases/slope/byyear/dumbbell) since their checked set's order
   * literally IS that seed order (or its reverse, for "worst"). Returns null if
   * there's been no seed yet, or either happened under a DIFFERENT discipline. */
  function resolveSeedMetric(discipline) {
    if (lastRankMetricKey && lastRankMetricDiscipline === discipline) {
      return getMetric(lastRankMetricKey, discipline) || null;
    }
    if (!seedSortKey || seedSortDiscipline !== discipline) return null;
    return getMetric(seedSortKey, discipline) || null;
  }

  /** roster-provenance block passed to card.js on every config — see its
   * rankedCountPhrase() doc comment for how {dirty, careerGamesRank,
   * seedByMetric, rankDir} become the title's phrasing:
   *   - "topnames" default (clean, pool>cap)  -> "N most-capped players"
   *   - "best"  (clean)                        -> "top N" / "top N by <metric>"
   *   - "worst" (clean)                        -> "bottom N" / "bottom N by <metric>"
   *   - manual / dirty / unknown provenance    -> "N players"
   * careerGamesRank (topnames) and seedByMetric (best/worst) are mutually
   * exclusive by mode, so card.js can check them in order. */
  function currentRosterMeta(discipline) {
    const mode = selection.getMode();
    return {
      dirty: selection.isDirty(),
      careerGamesRank: currentCareerGamesRank(),
      seedByMetric: mode === "best" || mode === "worst" ? resolveSeedMetric(discipline) : null,
      rankDir: mode === "worst" ? "bottom" : "top",
    };
  }

  /** Item 3 (richer invalid-metric messaging): the honest "no metric chosen /
   * chosen metric invalid here" sentence for a single-metric chart type, now a
   * two-part "what the chart is FOR + what metric it needs" message drawn from
   * CHART_RULES (never the old terse "X can't be shown on a dumbbell chart —
   * choose another metric."). Reached only when eligible metrics DO exist for
   * the type (evaluateTypeStatus already blocks metric-starved scopes with
   * their own reasons), so this is always about the user's own pick — never a
   * silent auto-swap. `typeKey` is a CHART_RULES key. */
  function noMetricGuidance(typeKey) {
    if (metricEverChosen && chosenMetricKey) {
      const m = getMetric(chosenMetricKey, store.get().discipline);
      return chartPurposeMessage(typeKey, m ? m.label : "That metric");
    }
    return chartPurposeMessage(typeKey, null);
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
    if (chartType === "scatter") {
      const metricX = getMetric(scatterXKey, discipline);
      const metricY = getMetric(scatterYKey, discipline);
      return metricX && metricY ? { type: "scatter", discipline, metricX, metricY, playerCount, roster } : null;
    }
    if (chartType === "radar") {
      // item 3: title is honest only once >= RADAR_MIN_METRICS axes are chosen.
      const eligible = radarEligibleMetrics(discipline, state.formats);
      const metrics = radarMetricKeys.map((k) => getMetric(k, discipline)).filter((m) => m && eligible.some((e) => e.key === m.key));
      return metrics.length >= RADAR_MIN_METRICS
        ? { type: "radar", discipline, metricKeys: metrics.map((m) => m.key), metrics, playerCount, roster }
        : null;
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
      // filter scope sentence. There are no sample floors to report anymore
      // (benchmark.js's floor mechanism was removed, R3 Wave 5), so this is
      // always just the base scope sentence.
      return base;
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
      // R5 Wave 1b (item 1): with no chart type AND no metric conditions
      // applied (fresh load, or after Clear), show the infographic RULES TABLE
      // rather than a one-line sentence. When there ARE metric conditions but
      // still no type (auto-select couldn't derive one — e.g. an empty pool),
      // fall back to the honest pool/guidance sentence. The pool-status reason,
      // when present, leads the rules table so the empty state still says how
      // to get data.
      if (metricConditionKeys(store.get()).length === 0) {
        showStageRulesTable(poolStatusReason());
      } else {
        showStageGuidance(poolStatusReason() || "Pick a chart type to get started.");
      }
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

      // Slope is handled entirely separately from the bar/scatter/
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
          showChartGuidance(noMetricGuidance("slope"));
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
          showChartGuidance(noMetricGuidance("byyear"));
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
          showChartGuidance(noMetricGuidance("dumbbell"));
          return;
        }
        // Item 4a: no window auto-fill here either — an empty window falls
        // straight through to the windowsReady guard below (empty-state).
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
      // fetchBenchmarkPool — table.js's buildQuery()) over the CANDIDATE SET
      // (R6, owner fix 1 — the "N" in the roster's "X of N selected", not the
      // whole scope and not just the checked roster; see that module's file
      // header). Ranks are computed client-side (benchmark.js's
      // computeBenchmarkRows) from that one query's rows, so the "#1 other" is
      // always one of the candidates the user is actually comparing.
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

        // Pool cache: keyed on scope + metric keys + candidate id set (NOT
        // anchor) so switching the anchor alone re-renders without a refetch
        // (task brief), while a change to the candidate set (a search-add/
        // remove, or a reseed) correctly invalidates the pool — see the
        // benchmarkPoolCache doc comment where it's declared. The candidate ids
        // are what the pool is now restricted to (R6, owner fix 1).
        const candidateIds = selection.getFull().map((p) => p.id);
        const poolKey = JSON.stringify([scopeSeedKey(state), keys.slice().sort(), candidateIds.slice().sort()]);
        let pool;
        if (benchmarkPoolCache && benchmarkPoolCache.key === poolKey) {
          pool = benchmarkPoolCache.rows;
        } else {
          pool = await fetchBenchmarkPool(state, keys, candidateIds);
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

      // Radar (R5 Wave 1b, item 4): its own branch, like Slope/Benchmark
      // above — it needs a SEPARATE query so each axis can be a PERCENTILE RANK
      // over the comparison pool (not a min/max normalise within the <=6
      // plotted players). Reuses benchmark.js's fetchBenchmarkPool(), which
      // (R6, owner fix 1) is now restricted to the CANDIDATE SET — the "N" in
      // the roster's "X of N selected" — so the percentiles rank against the
      // players the user is actually comparing (those N), NOT the whole
      // gender/format/date scope. The plotted players' own raw values are read
      // from that same pool (every candidate, checked ones included), so no
      // second per-player query is needed. Percentiles are computed
      // client-side in buildRadarSmallMultiples — the values themselves are
      // unchanged, just ranked (numbers rule).
      if (chartType === "radar") {
        const eligible = radarEligibleMetrics(discipline, state.formats);
        const metrics = radarMetricKeys.map((k) => getMetric(k, discipline)).filter((m) => m && eligible.some((e) => e.key === m.key));
        if (metrics.length < RADAR_MIN_METRICS) {
          showChartGuidance(chartPurposeMessage("radar", null));
          return;
        }
        const radarMetricKeyList = metrics.map((m) => m.key);
        const candidateIds = selection.getFull().map((p) => p.id);
        // NIT4: route radar's pool fetch through the SAME benchmarkPoolCache the
        // benchmark branch uses — identical key shape (scope + metric keys +
        // candidate id set), so an unchanged scope/metrics/candidates render
        // (e.g. a pure roster re-check) skips the redundant refetch, while any
        // key change still refetches. The rows and their use are unchanged.
        const poolKey = JSON.stringify([scopeSeedKey(state), radarMetricKeyList.slice().sort(), candidateIds.slice().sort()]);
        let poolRows;
        if (benchmarkPoolCache && benchmarkPoolCache.key === poolKey) {
          poolRows = benchmarkPoolCache.rows;
        } else {
          poolRows = await fetchBenchmarkPool(state, radarMetricKeyList, candidateIds);
          if (token !== loadToken) return;
          benchmarkPoolCache = { key: poolKey, rows: poolRows };
        }
        hideStatus();

        const canvas = card.getCanvas();
        const result = buildRadarSmallMultiples(canvas, chartRef, { metrics, players, poolRows });
        renderExclusions(result?.excluded ?? [], result?.note);

        const excludedCount = result?.excluded?.length ?? 0;
        const config = {
          type: "radar",
          discipline,
          metricKeys: radarMetricKeyList,
          metrics,
          playerCount: Math.max(0, players.length - excludedCount),
          roster: excludedCount > 0 ? { ...roster, dirty: true } : roster,
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
        if (!metric) { showChartGuidance(noMetricGuidance("bar")); return; }
        metricKeys = [metric.key];
        config = { type: "bar", discipline, metric, playerCount: players.length, style: barStyle, roster };
      } else if (chartType === "scatter") {
        const metricX = getMetric(scatterXKey, discipline);
        const metricY = getMetric(scatterYKey, discipline);
        if (!metricX || !metricY) {
          // item 3: scatter needs BOTH axes — the rich what-it's-for message.
          showChartGuidance(chartPurposeMessage("scatter", null));
          return;
        }
        metricKeys = [metricX.key, metricY.key];
        config = { type: "scatter", discipline, metricX, metricY, playerCount: players.length, roster };
      } else if (chartType === "phases") {
        const families = eligiblePhaseFamilies(discipline, state.formats);
        const family = families.find((f) => f.id === phaseFamilyId); // item 4: no auto-pick
        if (!family) {
          showChartGuidance(chartPurposeMessage("phases", null));
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
      } else if (config.type === "scatter") {
        result = buildScatterChart(canvas, chartRef, { metricX: config.metricX, metricY: config.metricY, rowsById, players });
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

  // ── Update-chart gate (owner item 7) ────────────────────────────────────────
  // In-panel control edits (chart type, per-type metric, radar/benchmark metric
  // sets, benchmark anchor, slope/dumbbell windows, bar style, and
  // every roster change) are now PENDING: they still update the controls UI and
  // the red `needs-input` cues LIVE (see the handlers, which keep calling
  // syncChartTypeButtons/renderMetricControls/renderPlayerList/syncWindowNeedsInput
  // etc.), but they no longer redraw the chart. Instead they call markDirty()
  // below, which lights the sticky "Update chart" button. Only that button
  // (renderAndClearDirty) actually renders the pending state.
  //
  // markDirty() accumulates `pendingRegenerate` EXACTLY as scheduleRender would,
  // so the eventual draw regenerates the title/subtitle iff a pending edit was a
  // real param change — the ONE thing withheld is the setTimeout(renderChart),
  // which the button supplies. renderChart() always reads live state/selection
  // at draw time, so a button-driven draw is byte-identical to the old
  // auto-render for the same inputs (IRON RULE).
  //
  // Three NON-panel draw triggers stay LIVE and CLEAR the gate (they route
  // through renderAndClearDirty instead of markDirty): the initial seed
  // (onShow/enterFromBridge), a scope apply from the graph's own Filters popup
  // (onScopeChanged — owner keeps "Apply to graph" separate from Update chart),
  // and the "Graph this player" chooser confirm (enterWithChoiceImpl — an
  // explicit "show me this player" action draws immediately).
  let chartDirty = false;
  function updateUpdateBtn() {
    const btn = els.updateBtn;
    if (!btn) return;
    btn.disabled = !chartDirty;
    btn.classList.toggle("is-dirty", chartDirty);
    btn.textContent = chartDirty ? "Update chart •" : "Update chart";
  }
  /** An in-panel edit: control UI already updated live by the caller; here we
   * only record that the DRAWN chart is now behind, without drawing. */
  function markDirty({ paramsChanged = false } = {}) {
    if (paramsChanged) pendingRegenerate = true;
    chartDirty = true;
    updateUpdateBtn();
  }
  /** Draw now and clear the pending gate — the shared tail of every LIVE draw
   * trigger (seed / scope apply / chooser confirm / the Update-chart button).
   * pendingRegenerate has already been accumulated by any markDirty() edits, so
   * the button passes no paramsChanged; the live triggers pass true to force a
   * fresh title exactly as they did when they called scheduleRender directly. */
  function renderAndClearDirty({ paramsChanged = false } = {}) {
    chartDirty = false;
    updateUpdateBtn();
    scheduleRender({ paramsChanged });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Organic entry (decision 46f): the Graphs TAB and the Stats toolbar's
   * "Graph" button now behave identically here (see enterFromBridge below) —
   * no chart type is pre-selected and no chart renders. If Stats has been
   * searched at least once, its result set becomes the candidate POOL (the
   * DEFAULT "Top names" derivation — biggest names by career games — becomes
   * the initial CHECKED roster for free, see deriveChecked() and
   * activeMaxCap()'s pre-type-selection default) so a type click can render
   * immediately with no re-ticking. If Stats has never been searched,
   * seedSelection() no-ops and renderChart() shows the empty-state guidance
   * instead (poolStatusReason()). Chart type / metrics / roster edits from an
   * earlier visit are never reset here — only explicit user actions change
   * them (requirement 2's persistence rule).
   *
   * Item 16 (shared store): there is no scope to re-inherit anymore — the graph
   * already reads the shared Stats scope live. seedSelection() detects whether
   * that scope has moved since the last seed (via scopeSeedKey) and re-seeds the
   * pool only when it actually changed, so a fresh Stats search is picked up on
   * entry and a bare tab toggle is a no-op — the same net behaviour as before.
   */
  async function onShow() {
    syncChartTypeButtons();
    syncBarStyleVisibility();
    renderMetricControls();
    await seedSelection();
    // After the pool is seeded, auto-select a chart type + metric(s) from any
    // applied metric conditions (or revert if they've been cleared). Runs
    // post-seed so the archetype's #players tie-breaks read the real pool.
    maybeAutoSelectFromFilters();
    // Initial seed / entry: draw as before and start with a clean (non-dirty)
    // gate — the Update-chart gate applies only to SUBSEQUENT in-panel edits.
    renderAndClearDirty({ paramsChanged: true });
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
    // Item 7: an external "Graph this player" add is an explicit show-me action
    // (like the chooser confirm), NOT an in-panel tweak — so draw it immediately
    // and clear the gate rather than leaving the added player pending. (The
    // add above already marked the chart dirty via selection.onChange.)
    renderAndClearDirty({ paramsChanged: true });
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
        return { kind: "none", note: "Radar compares several metrics at once — pick them in the Graph Builder." };
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
    noteManualChartEdit(); // item 1: an explicit chooser confirm is a manual pick
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
      else if (newType === "slope") slopeMetricKey = metricKey;
      else if (newType === "byyear") byYearMetricKey = metricKey;
      else if (newType === "dumbbell") dumbbellMetricKey = metricKey;
      markMetricChosen(metricKey); // item 4: chooser pick persists across type switches
    } else {
      // radar/phases/benchmark: no single metric to pick. The chooser is an
      // EXPLICIT type confirm, so seed a sensible default axis set / family
      // (item 3's no-auto-pick applies to the Builder's own controls; a
      // deliberate chooser confirm still lands on a drawn chart) and count it
      // as a metric choice for the honest invalid-metric guidance. Benchmark
      // self-configures.
      const gs = store.get();
      if (newType === "radar") {
        // Default to the first few radar-valid metrics (>= RADAR_MIN_METRICS)
        // when the user has none checked yet, so the chooser confirm draws.
        const eligible = radarEligibleMetrics(gs.discipline, gs.formats);
        const stillValid = radarMetricKeys.filter((k) => eligible.some((m) => m.key === k));
        radarMetricKeys = stillValid.length >= RADAR_MIN_METRICS
          ? stillValid
          : eligible.slice(0, Math.min(5, RADAR_MAX_METRICS)).map((m) => m.key);
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
    // "Graph this player" chooser confirm is an explicit "show me this player"
    // action → draw immediately (treated like an apply), not left pending.
    renderAndClearDirty({ paramsChanged: true });
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
    seedSelection().then(() => {
      // Item 1: filter-driven auto-select/revert, post-seed (same as onShow).
      maybeAutoSelectFromFilters();
      // A scope apply from the graph's own Filters popup ("Apply to graph")
      // keeps its OWN apply button (owner item 7): it draws with the current
      // (pending) in-panel values and counts as an update — so clear the gate.
      renderAndClearDirty({ paramsChanged: true });
    });
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
