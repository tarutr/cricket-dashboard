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

import { eligibleMetrics, matchupVsActive } from "../state.js";
import { getMetric, hasMetricData } from "../metrics.js";
import { escHtml, escAttr } from "../html.js";
import { getManifest, query } from "../db.js";
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
import {
  dumbbellEligibleMetrics,
  fetchDumbbellBowlingTypes,
  fetchDumbbellSide,
  defaultDumbbellSides,
  oppositeDefaultSide,
  encodeVs,
  decodeVs,
  vsLabel,
  dumbbellVsOptionsHTML,
} from "./dumbbell.js";
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
  { key: "byyear", label: "By year" },
  { key: "dumbbell", label: "Dumbbell" },
  // B8b (decision 44e).
  { key: "benchmark", label: "Benchmark" },
];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Same tiny option-building idiom src/filters.js uses for its scope-strip
 * month dropdowns — copied rather than imported (filters.js is table/scope-
 * strip code, out of this module's ownership) so the Slope chart's Window A/B
 * pickers offer the identical "Jul 2023"-style vocabulary. */
function monthOptionsHTML(minMonth, maxMonth, selected) {
  if (!minMonth || !maxMonth) return "";
  const [minY, minM] = minMonth.split("-").map(Number);
  const [maxY, maxM] = maxMonth.split("-").map(Number);
  const opts = [];
  for (let y = maxY; y >= minY; y--) {
    const mFrom = y === maxY ? maxM : 12;
    const mTo = y === minY ? minM : 1;
    for (let m = mFrom; m >= mTo; m--) {
      const val = `${y}-${String(m).padStart(2, "0")}`;
      opts.push(`<option value="${val}" ${val === selected ? "selected" : ""}>${MONTH_NAMES[m - 1]} ${y}</option>`);
    }
  }
  return opts.join("");
}

/** "YYYY-MM" -> "Mon YYYY", or null. */
function monthLabel(yyyymm) {
  if (!yyyymm) return null;
  const [y, m] = yyyymm.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** A window's {from,to} -> "Mon YYYY–Mon YYYY" (or a single "Mon YYYY" when
 * from and to are the same month), or null if either bound is unset. */
function windowLabel(window) {
  if (!window || !window.from || !window.to) return null;
  const from = monthLabel(window.from);
  const to = monthLabel(window.to);
  return from === to ? from : `${from}–${to}`;
}

function monthIndex(yyyymm) {
  const [y, m] = yyyymm.split("-").map(Number);
  return y * 12 + (m - 1);
}
function monthFromIndex(idx) {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Dataset-wide date bounds (the manifest's min/max match_date), for the
 * Slope chart's Window A/B month-dropdown vocabulary — deliberately the FULL
 * dataset range, not the live filter scope's (narrower) dateFrom/dateTo, same
 * as the scope strip's own date pickers. */
function datasetMonthBounds() {
  const manifest = getManifest();
  const maxMonth = manifest?.data?.max_match_date ? manifest.data.max_match_date.slice(0, 7) : null;
  const minMonth = manifest?.data?.min_match_date ? manifest.data.min_match_date.slice(0, 7) : null;
  return { minMonth, maxMonth };
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

/**
 * Whether the Dumbbell chart can be used at all right now: batting discipline
 * (see dumbbell.js's file header — matchup_bowling has no symmetric "two
 * sides" grain to chart) AND gender === "male". The gender guard matters
 * beyond just UI polish: matchupVsActive() (state.js) — which decides whether
 * buildQuery() takes the matchup path at all — returns false whenever
 * gender !== "male" (matchup "Vs" style data doesn't exist for women yet,
 * decision 21; table.js's own "Vs" select is disabled the same way, same
 * wording). Without this guard, a female-gender dumbbell attempt would
 * silently fall through to buildQuery's PLAIN (non-matchup) path — several
 * matchup_batting metric keys (average, strike_rate, dot_pct, boundary_pct, …)
 * also exist, with a DIFFERENT sqlExpression, in the plain "batting"
 * namespace — so the chart would draw real career-wide numbers mislabeled as
 * "vs Pace"/"vs Spin" instead of an honest no-data state. Never assumed;
 * caught by re-reading matchupVsActive's own gender check while wiring this up.
 */
function dumbbellAvailable(state) {
  return state.discipline === "batting" && state.gender === "male";
}

/** Honest reason the Dumbbell chart isn't available right now, for whichever
 * condition in dumbbellAvailable() is failing (checked in the same order). */
function dumbbellUnavailableReason(state) {
  if (state.gender !== "male") return "No bowling-style data for women's cricket yet.";
  return "Batting view only for now.";
}

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

export function mountGraph(container, store, { onRequery, onBackToTable } = {}) {
  container.innerHTML = `
    <button type="button" class="link-btn graph-bridge-back" data-role="bridge-back" hidden>&larr; Back to your table</button>
    <div class="graph-builder">
      <div class="graph-builder__controls">
        <div class="graph-control-group">
          <span class="graph-control-label">Chart type</span>
          <div class="segmented graph-chart-type" data-role="chart-type" role="group" aria-label="Chart type">
            ${CHART_TYPES.map((t) => `<button type="button" class="segmented__btn" data-value="${t.key}">${t.label}</button>`).join("")}
          </div>
          <p class="graph-chart-type-caption" data-role="chart-type-caption"></p>
          <p class="graph-chart-type-reason" data-role="chart-type-reason" hidden></p>
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
        <div class="graph-card-host" data-role="card-host"></div>
        <div class="graph-exclusions" data-role="exclusions" hidden></div>
        <div class="graph-export">
          <button type="button" class="btn btn--primary" data-role="export-png">Export PNG</button>
          <button type="button" class="btn btn--ghost" data-role="copy-png" hidden>Copy PNG</button>
          <span class="graph-export__status" data-role="export-status"></span>
        </div>
      </div>
    </div>
  `;

  const els = {
    bridgeBack: container.querySelector('[data-role="bridge-back"]'),
    chartType: container.querySelector('[data-role="chart-type"]'),
    chartTypeCaption: container.querySelector('[data-role="chart-type-caption"]'),
    chartTypeReason: container.querySelector('[data-role="chart-type-reason"]'),
    barStyleGroup: container.querySelector('[data-role="bar-style"]'),
    barStyleToggle: container.querySelector('[data-role="bar-style-toggle"]'),
    metricControls: container.querySelector('[data-role="metric-controls"]'),
    playerSearch: container.querySelector('[data-role="player-search"]'),
    playerSearchResults: container.querySelector('[data-role="player-search-results"]'),
    rosterToggle: container.querySelector('[data-role="roster-toggle"]'),
    rosterPanel: container.querySelector('[data-role="roster-panel"]'),
    rosterMode: container.querySelector('[data-role="roster-mode"]'),
    rosterList: container.querySelector('[data-role="roster-list"]'),
    resetPlayers: container.querySelector('[data-role="reset-players"]'),
    capNote: container.querySelector('[data-role="cap-note"]'),
    status: container.querySelector('[data-role="status"]'),
    cardHost: container.querySelector('[data-role="card-host"]'),
    exclusions: container.querySelector('[data-role="exclusions"]'),
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
  let chartType = "bar";
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
  // {dim, value} pairs (dumbbell.js's shape), or null until
  // ensureDumbbellSideDefaults() first sets them — same "owner-picked, never
  // silently recomputed" posture as the Slope windows above.
  let dumbbellSideA = null;
  let dumbbellSideB = null;
  // The distinct fine "Bowling type" values, lazily fetched once and cached —
  // same idiom as table.js's own bowlingTypesCache (this module can't import
  // that one; see dumbbell.js's file header on the Vs-vocabulary duplication).
  let dumbbellBowlingTypesCache = null;

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

  // "Turn into graph" bridge (decision 43): true only when the Graphs view
  // was entered via the Stats-tab bridge button, until the user clicks the
  // back link or leaves via an organic tab visit (onShow() resets it — see
  // its doc comment). Never set by "Graph this player" (task 4) — that jump
  // has no analogous "your table" to return to.
  let bridgeFromTable = false;

  const selection = createSelection({
    getCap: () => CHART_CAPS[chartType].max,
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

  function syncBridgeBackVisibility() {
    els.bridgeBack.hidden = !bridgeFromTable;
  }

  els.bridgeBack.addEventListener("click", () => {
    bridgeFromTable = false;
    syncBridgeBackVisibility();
    if (onBackToTable) onBackToTable();
  });

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
    const { minMonth, maxMonth } = datasetMonthBounds();
    const from = state.dateFrom || minMonth;
    const to = state.dateTo || maxMonth;
    if (!from || !to) return; // bounds not known yet — leave blank, user must pick both ends
    const fromIdx = monthIndex(from);
    const toIdx = monthIndex(to);
    const span = Math.max(0, toIdx - fromIdx);
    const midIdx = fromIdx + Math.floor(span / 2);
    slopeWindowA = { from, to: monthFromIndex(midIdx) };
    const secondFromIdx = Math.min(midIdx + (span > 0 ? 1 : 0), toIdx);
    slopeWindowB = { from: monthFromIndex(secondFromIdx), to };
  }

  /** Dumbbell's Side A/Side B defaults (task brief): Pace vs Spin, set ONCE
   * (like the Slope windows above) then left alone until the user repicks. */
  function ensureDumbbellSideDefaults() {
    if (dumbbellSideA && dumbbellSideB) return;
    const d = defaultDumbbellSides();
    dumbbellSideA = d.sideA;
    dumbbellSideB = d.sideB;
  }

  /** Lazily fetch + cache the fine "Bowling type" vocabulary for the Dumbbell
   * chart's Side A/B selects (dumbbell.js's own duplicate of table.js's
   * distinct-bowling_type lookup — see that module's file header). No-op if
   * already cached; re-renders the metric controls once the fetch resolves
   * IF the Dumbbell chart is still the active type (a user who clicked away
   * before it loaded shouldn't have their current controls yanked out from
   * under them). */
  function ensureDumbbellBowlingTypes() {
    if (dumbbellBowlingTypesCache) return;
    fetchDumbbellBowlingTypes().then((types) => {
      dumbbellBowlingTypesCache = types;
      if (chartType === "dumbbell") renderMetricControls();
    });
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
    const cap = CHART_CAPS[chartType].max;
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

  function renderMetricControls() {
    const state = store.get();
    const discipline = state.discipline;
    const formats = state.formats;

    if (chartType === "bar") {
      const metrics = eligibleMetrics(discipline, formats);
      if (!barMetricKey || !metrics.some((m) => m.key === barMetricKey)) {
        const preferredKey = discipline === "batting" ? "runs" : "wickets";
        barMetricKey = (metrics.find((m) => m.key === preferredKey) || metrics[0])?.key ?? null;
      }
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="bar-metric">
          ${metrics.map((m) => `<option value="${m.key}" ${m.key === barMetricKey ? "selected" : ""}>${m.label}</option>`).join("")}
        </select>
      `;
      els.metricControls.querySelector('[data-role="bar-metric"]').addEventListener("change", (e) => {
        barMetricKey = e.target.value;
        onRankMetricChanged();
      });
    } else if (chartType === "donut") {
      const metrics = donutEligibleMetrics(discipline, formats);
      if (!donutMetricKey || !metrics.some((m) => m.key === donutMetricKey)) {
        const preferredKey = discipline === "batting" ? "runs" : "wickets";
        donutMetricKey = (metrics.find((m) => m.key === preferredKey) || metrics[0])?.key ?? null;
      }
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric (total)</span>
        <select class="select graph-metric-select" data-role="donut-metric">
          ${
            metrics.length
              ? metrics.map((m) => `<option value="${m.key}" ${m.key === donutMetricKey ? "selected" : ""}>${m.label}</option>`).join("")
              : `<option value="">No additive totals available</option>`
          }
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="donut-metric"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          donutMetricKey = e.target.value;
          onRankMetricChanged();
        });
      }
    } else if (chartType === "scatter") {
      const metrics = eligibleMetrics(discipline, formats);
      // Defaults that make an interesting first scatter: consistency vs tempo
      // (batting) / thrift vs penetration (bowling).
      const prefX = discipline === "batting" ? "average" : "economy";
      const prefY = discipline === "batting" ? "strike_rate" : "strike_rate";
      if (!scatterXKey || !metrics.some((m) => m.key === scatterXKey)) {
        scatterXKey = (metrics.find((m) => m.key === prefX) || metrics[0])?.key ?? null;
      }
      if (!scatterYKey || !metrics.some((m) => m.key === scatterYKey)) {
        scatterYKey = (metrics.find((m) => m.key === prefY) || metrics[1] || metrics[0])?.key ?? null;
      }
      els.metricControls.innerHTML = `
        <span class="graph-control-label">X axis</span>
        <select class="select graph-metric-select" data-role="scatter-x">
          ${metrics.map((m) => `<option value="${m.key}" ${m.key === scatterXKey ? "selected" : ""}>${m.label}</option>`).join("")}
        </select>
        <span class="graph-control-label">Y axis</span>
        <select class="select graph-metric-select" data-role="scatter-y">
          ${metrics.map((m) => `<option value="${m.key}" ${m.key === scatterYKey ? "selected" : ""}>${m.label}</option>`).join("")}
        </select>
      `;
      els.metricControls.querySelector('[data-role="scatter-x"]').addEventListener("change", (e) => {
        scatterXKey = e.target.value;
        scheduleRender({ paramsChanged: true });
      });
      els.metricControls.querySelector('[data-role="scatter-y"]').addEventListener("change", (e) => {
        scatterYKey = e.target.value;
        onRankMetricChanged();
      });
    } else if (chartType === "radar") {
      const groups = eligibleRadarGroups(discipline, formats);
      if (!radarGroupId || !groups.some((g) => g.id === radarGroupId)) {
        radarGroupId = groups[0]?.id ?? null;
      }
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric group</span>
        <select class="select graph-metric-select" data-role="radar-group">
          ${
            groups.length
              ? groups.map((g) => `<option value="${g.id}" ${g.id === radarGroupId ? "selected" : ""}>${g.label}</option>`).join("")
              : `<option value="">No groups available for this scope</option>`
          }
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="radar-group"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          radarGroupId = e.target.value;
          scheduleRender({ paramsChanged: true });
        });
      }
    } else if (chartType === "phases") {
      const families = eligiblePhaseFamilies(discipline, formats);
      if (!phaseFamilyId || !families.some((f) => f.id === phaseFamilyId)) {
        phaseFamilyId = families[0]?.id ?? null;
      }
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric family</span>
        <select class="select graph-metric-select" data-role="phase-family">
          ${
            families.length
              ? families.map((f) => `<option value="${f.id}" ${f.id === phaseFamilyId ? "selected" : ""}>${f.label}</option>`).join("")
              : `<option value="">No phase families available for this scope</option>`
          }
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="phase-family"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          phaseFamilyId = e.target.value;
          scheduleRender({ paramsChanged: true });
        });
      }
    } else if (chartType === "slope") {
      const metrics = eligibleMetrics(discipline, formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      if (!slopeMetricKey || !metrics.some((m) => m.key === slopeMetricKey)) {
        const preferredKey = discipline === "batting" ? "strike_rate" : "economy";
        slopeMetricKey = (metrics.find((m) => m.key === preferredKey) || metrics[0])?.key ?? null;
      }
      ensureSlopeWindowDefaults();
      const { minMonth, maxMonth } = datasetMonthBounds();
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="slope-metric">
          ${
            metrics.length
              ? metrics.map((m) => `<option value="${m.key}" ${m.key === slopeMetricKey ? "selected" : ""}>${m.label}</option>`).join("")
              : `<option value="">No rate/percent metrics available for this scope</option>`
          }
        </select>
        <span class="graph-control-label">Window A</span>
        <div class="date-range graph-slope-range">
          <select class="select" data-role="slope-a-from" aria-label="Window A from">${monthOptionsHTML(minMonth, maxMonth, slopeWindowA?.from)}</select>
          <span class="date-range__sep">–</span>
          <select class="select" data-role="slope-a-to" aria-label="Window A to">${monthOptionsHTML(minMonth, maxMonth, slopeWindowA?.to)}</select>
        </div>
        <span class="graph-control-label">Window B</span>
        <div class="date-range graph-slope-range">
          <select class="select" data-role="slope-b-from" aria-label="Window B from">${monthOptionsHTML(minMonth, maxMonth, slopeWindowB?.from)}</select>
          <span class="date-range__sep">–</span>
          <select class="select" data-role="slope-b-to" aria-label="Window B to">${monthOptionsHTML(minMonth, maxMonth, slopeWindowB?.to)}</select>
        </div>
      `;
      const metricSel = els.metricControls.querySelector('[data-role="slope-metric"]');
      if (metricSel) {
        metricSel.addEventListener("change", (e) => {
          slopeMetricKey = e.target.value;
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
      if (!byYearMetricKey || !metrics.some((m) => m.key === byYearMetricKey)) {
        const preferredKey = discipline === "batting" ? "strike_rate" : "economy";
        byYearMetricKey = (metrics.find((m) => m.key === preferredKey) || metrics[0])?.key ?? null;
      }
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="byyear-metric">
          ${
            metrics.length
              ? metrics.map((m) => `<option value="${m.key}" ${m.key === byYearMetricKey ? "selected" : ""}>${m.label}</option>`).join("")
              : `<option value="">No year-by-year metric available for this scope</option>`
          }
        </select>
      `;
      const sel = els.metricControls.querySelector('[data-role="byyear-metric"]');
      if (sel) {
        sel.addEventListener("change", (e) => {
          byYearMetricKey = e.target.value;
          scheduleRender({ paramsChanged: true });
        });
      }
    } else if (chartType === "dumbbell") {
      // Batch 4 wave 2, task 2: batting discipline + men's cricket only (see
      // dumbbellAvailable() above and dumbbell.js's file header for why). The
      // chart-type click handler / onScopeChanged already steer away from
      // "dumbbell" whenever it's unavailable, but render an honest note
      // defensively rather than assume that always ran first.
      if (!dumbbellAvailable(state)) {
        els.metricControls.innerHTML = `<p class="graph-chart-type-caption">${dumbbellUnavailableReason(state)}</p>`;
        return;
      }
      const metrics = dumbbellEligibleMetrics(formats);
      if (!dumbbellMetricKey || !metrics.some((m) => m.key === dumbbellMetricKey)) {
        dumbbellMetricKey = (metrics.find((m) => m.key === "strike_rate") || metrics[0])?.key ?? null;
      }
      ensureDumbbellSideDefaults();
      ensureDumbbellBowlingTypes(); // fire-and-forget; re-renders these controls once loaded
      const bowlingTypes = dumbbellBowlingTypesCache || [];
      els.metricControls.innerHTML = `
        <span class="graph-control-label">Metric</span>
        <select class="select graph-metric-select" data-role="dumbbell-metric">
          ${
            metrics.length
              ? metrics.map((m) => `<option value="${m.key}" ${m.key === dumbbellMetricKey ? "selected" : ""}>${m.label}</option>`).join("")
              : `<option value="">No matchup rate/percent metric available for this scope</option>`
          }
        </select>
        <span class="graph-control-label">Side A</span>
        <select class="select graph-metric-select" data-role="dumbbell-side-a" aria-label="Side A">
          ${dumbbellVsOptionsHTML(bowlingTypes, encodeVs(dumbbellSideA))}
        </select>
        <span class="graph-control-label">Side B</span>
        <select class="select graph-metric-select" data-role="dumbbell-side-b" aria-label="Side B">
          ${dumbbellVsOptionsHTML(bowlingTypes, encodeVs(dumbbellSideB))}
        </select>
      `;
      const metricSel = els.metricControls.querySelector('[data-role="dumbbell-metric"]');
      if (metricSel) {
        metricSel.addEventListener("change", (e) => {
          dumbbellMetricKey = e.target.value;
          scheduleRender({ paramsChanged: true });
        });
      }
      const sideASel = els.metricControls.querySelector('[data-role="dumbbell-side-a"]');
      if (sideASel) {
        sideASel.addEventListener("change", (e) => {
          dumbbellSideA = decodeVs(e.target.value);
          scheduleRender({ paramsChanged: true });
        });
      }
      const sideBSel = els.metricControls.querySelector('[data-role="dumbbell-side-b"]');
      if (sideBSel) {
        sideBSel.addEventListener("change", (e) => {
          dumbbellSideB = decodeVs(e.target.value);
          scheduleRender({ paramsChanged: true });
        });
      }
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
          syncBenchmarkMetricsUI();
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

  function renderPlayerList() {
    const checkedCount = selection.checkedCount();
    const candidates = selection.getFull();
    const total = candidates.length;
    const cap = CHART_CAPS[chartType].max;
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

    els.rosterList.innerHTML = total
      ? candidates
          .map((p, i) => {
            const checked = selection.isChecked(p.id);
            const atCap = !checked && checkedCount >= cap;
            const title = atCap ? `Max ${cap} for this chart type — untick one first` : checked ? "Remove from graph" : "Add to graph";
            return `<div class="dropdown__item graph-roster-item${atCap ? " is-disabled" : ""}" data-id="${escAttr(p.id)}">
              <input type="checkbox" data-role="roster-check" data-id="${escAttr(p.id)}" ${checked ? "checked" : ""} ${atCap ? "disabled" : ""} title="${escAttr(title)}" />
              <span class="graph-roster-item__name">${escHtml(p.name)}</span>
              <span class="graph-roster-item__meta">#${i + 1}</span>
              <button type="button" class="icon-btn graph-roster-item__remove" data-role="remove-candidate" data-id="${escAttr(p.id)}" title="Remove from list">&times;</button>
            </div>`;
          })
          .join("")
      : `<p class="graph-player-search__empty">No players yet — search above or use Filters.</p>`;

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
        // Full selection (not just the active/visible slice) — a player
        // hidden by a smaller cap is still selected and shouldn't show up as
        // addable in search (Batch 3 cap-switch-memory fix).
        const excludeIds = selection.getFull().map((p) => p.id);
        const results = await searchPlayers(store, term, excludeIds);
        els.playerSearchResults.innerHTML =
          results
            .map((r) => `<button type="button" class="graph-player-search__item" data-id="${r.id}" data-name="${escAttr(r.name)}">${escHtml(r.name)}</button>`)
            .join("") || `<p class="graph-player-search__empty">No matches.</p>`;
        els.playerSearchResults.hidden = false;

        els.playerSearchResults.querySelectorAll(".graph-player-search__item").forEach((btn) => {
          btn.addEventListener("click", () => {
            // The candidate pool is never truncated (task brief) — a search-
            // add always joins it; `checked` is false only if the active
            // chart type is already at cap, in which case the player still
            // shows up (unticked) in the roster dropdown rather than being
            // silently dropped.
            const result = selection.addCandidate({ id: btn.dataset.id, name: btn.dataset.name });
            if (result.ok && !result.checked) {
              showCapNote(`Added to your list, but this chart type is capped at ${CHART_CAPS[chartType].max} players — untick one to plot them instead.`);
            } else {
              clearCapNote();
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

  // Batch 3 (graphs, part 1) picker captions — decision 43, exact strings.
  // Batch 4 wave 2 adds the last two chart types' captions.
  const CHART_TYPE_CAPTIONS = {
    bar: "Rank players on one stat",
    donut: "Share of a total — needs a countable stat",
    scatter: "Two stats mapped against each other",
    radar: "Player shape profiles, side by side",
    phases: "One stat across match phases, side by side",
    slope: "One stat, two date windows — who rose, who fell",
    byyear: "One stat, year by year",
    dumbbell: "One stat, two bowling types — the gap is the story",
    benchmark: "One player against the best of the rest, stat by stat.",
  };

  /** The picker caption for `type` under the CURRENT state — an honest swap
   * for Dumbbell while it isn't usable (SPEC §8.4: only describe what the
   * control can actually do right now) — see dumbbellAvailable() above. */
  function chartTypeCaption(type, state) {
    if (type === "dumbbell" && !dumbbellAvailable(state)) return dumbbellUnavailableReason(state);
    return CHART_TYPE_CAPTIONS[type] || "";
  }

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
  function evaluateTypeStatus(typeKey, state) {
    if (typeKey === "dumbbell" && !dumbbellAvailable(state)) {
      return { ok: false, reason: dumbbellUnavailableReason(state) };
    }
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
    if (typeKey === "dumbbell" && dumbbellEligibleMetrics(state.formats).length === 0) {
      return { ok: false, reason: "No matchup rate/percent metric available for this scope" };
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
    const candidateCount = selection.candidateCount();
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
    const recommended = recommendedChartType(state, statuses);

    els.chartType.querySelectorAll(".segmented__btn").forEach((btn) => {
      const key = btn.dataset.value;
      const type = CHART_TYPES.find((t) => t.key === key);
      const status = statuses[key];
      btn.classList.toggle("is-active", key === chartType);
      btn.disabled = !status.ok;
      // Shown as the button's own title when disabled (task brief) — an ok
      // button carries no title (the caption below already describes it for
      // the ACTIVE type; a titled tooltip on every enabled button would be
      // noise, matching the existing "disabled + title" idiom elsewhere).
      btn.title = status.ok ? "" : status.reason || "";
      btn.innerHTML = `${type.label}${key === recommended ? '<span class="graph-chart-type-rec">Recommended</span>' : ""}`;
    });

    els.chartTypeCaption.textContent = chartTypeCaption(chartType, state);

    // Muted inline reason under the picker — the ACTIVE type's own status
    // only, shown whenever it's currently invalid (e.g. a scope change left
    // too few candidates, or removed the only eligible metric/group/family
    // for it) so the user immediately sees WHY nothing is drawing, beyond
    // just the placeholder text in the chart area itself.
    const activeStatus = statuses[chartType];
    if (activeStatus && !activeStatus.ok && activeStatus.reason) {
      els.chartTypeReason.textContent = activeStatus.reason;
      els.chartTypeReason.hidden = false;
    } else {
      els.chartTypeReason.hidden = true;
      els.chartTypeReason.textContent = "";
    }
  }

  /** Legacy name kept as a thin alias — syncChartTypeButtons() now computes
   * every type's availability (not just Dumbbell's) in one pass, so this
   * just re-runs it; kept separate (rather than deleting every call site)
   * since several callers already call both in sequence for other reasons
   * (bar-style visibility, metric controls, …) and reordering those calls is
   * unrelated to this batch's scope. */
  function syncChartTypeAvailability() {
    syncChartTypeButtons();
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
    if (!btn || btn.disabled || btn.dataset.value === chartType) return;
    chartType = btn.dataset.value;
    syncChartTypeButtons();
    syncChartTypeAvailability();
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
      state.search, state.positions, state.opposition, state.profile, state.matchupVs,
    ]);
  }

  async function seedSelection({ force = false } = {}) {
    const state = store.get();
    const key = scopeSeedKey(state);
    if (!force && seeded && key === lastSeedKey) return;
    try {
      const cap = CHART_CAPS[chartType].max;
      const seedPlayers = await seedFromFilteredSet(store, cap);
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
      const group = groups.find((g) => g.id === radarGroupId) || groups[0];
      return group ? { type: "radar", discipline, group, playerCount, roster } : null;
    }
    if (chartType === "phases") {
      const families = eligiblePhaseFamilies(discipline, state.formats);
      const family = families.find((f) => f.id === phaseFamilyId) || families[0];
      return family ? { type: "phases", discipline, family, playerCount, roster } : null;
    }
    if (chartType === "slope") {
      const metrics = eligibleMetrics(discipline, state.formats).filter((m) => m.kind === "rate" || m.kind === "percent");
      const metric = metrics.find((m) => m.key === slopeMetricKey) || metrics[0];
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
      const metric = metrics.find((m) => m.key === byYearMetricKey) || metrics[0];
      return metric ? { type: "byyear", discipline, metric, playerCount, roster } : null;
    }
    if (chartType === "dumbbell") {
      if (!dumbbellAvailable(state) || !dumbbellSideA || !dumbbellSideB) return null;
      const metrics = dumbbellEligibleMetrics(state.formats);
      const metric = metrics.find((m) => m.key === dumbbellMetricKey) || metrics[0];
      return metric
        ? {
            type: "dumbbell",
            discipline,
            metric,
            labelA: vsLabel(dumbbellSideA),
            labelB: vsLabel(dumbbellSideB),
            sideAKey: encodeVs(dumbbellSideA),
            sideBKey: encodeVs(dumbbellSideB),
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
      // Batch 4 wave 2, task 2: the footer must state both sides explicitly
      // (§8.4) — mirrors slope's window footer above.
      if (!config.labelA || !config.labelB) return base;
      return `${base} · Side A: vs ${config.labelA} · Side B: vs ${config.labelB}`;
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
    const players = selection.get();
    const token = ++loadToken;

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
        const metric = metrics.find((m) => m.key === slopeMetricKey) || metrics[0];
        const windowsReady = Boolean(slopeWindowA?.from && slopeWindowA?.to && slopeWindowB?.from && slopeWindowB?.to);
        if (!metric || !windowsReady) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], metric ? "Pick both date windows to draw this chart." : "No rate/percent metric available for this scope.");
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
          playerCount: players.length - (result?.excluded?.length ?? 0),
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
        const metric = metrics.find((m) => m.key === byYearMetricKey) || metrics[0];
        if (!metric) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], "No year-by-year metric available for this scope.");
          return;
        }

        const ids = players.map((p) => p.id);
        const sql = buildTimeseriesQuery({ discipline, metricKey: metric.key, playerIds: ids, filters: state });
        const { rows } = await query(sql);
        if (token !== loadToken) return;
        hideStatus();

        const canvas = card.getCanvas();
        const result = buildTimeseriesChart(canvas, chartRef, { metric, rows, players });
        renderExclusions(result?.excluded ?? [], result?.note);

        const config = {
          type: "byyear",
          discipline,
          metric,
          playerCount: players.length - (result?.excluded?.length ?? 0),
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

      // Dumbbell (Batch 4 wave 2, task 2): TWO independent matchup-mode
      // queries (one per side, via dumbbell.js's fetchDumbbellSide — the same
      // wrap-buildQuery idiom fetchWindowMetric uses for Slope's two windows)
      // instead of fetchSelectedPlayerMetrics's single plain-discipline query.
      if (chartType === "dumbbell") {
        if (!dumbbellAvailable(state)) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], dumbbellUnavailableReason(state));
          return;
        }
        const metrics = dumbbellEligibleMetrics(state.formats);
        const metric = metrics.find((m) => m.key === dumbbellMetricKey) || metrics[0];
        ensureDumbbellSideDefaults();
        if (!metric || !dumbbellSideA || !dumbbellSideB) {
          hideStatus();
          if (chartRef.current) {
            chartRef.current.destroy();
            chartRef.current = null;
          }
          card.hidePlaceholder();
          renderExclusions([], "No matchup rate/percent metric available for this scope.");
          return;
        }

        const ids = players.map((p) => p.id);
        const [rowsA, rowsB] = await Promise.all([
          fetchDumbbellSide(state, dumbbellSideA, ids, metric),
          fetchDumbbellSide(state, dumbbellSideB, ids, metric),
        ]);
        if (token !== loadToken) return;
        hideStatus();

        const canvas = card.getCanvas();
        const labelA = vsLabel(dumbbellSideA);
        const labelB = vsLabel(dumbbellSideB);
        const result = buildDumbbellChart(canvas, chartRef, { metric, labelA, labelB, rowsA, rowsB, players });
        renderExclusions(result?.excluded ?? [], result?.note);

        const config = {
          type: "dumbbell",
          discipline,
          metric,
          labelA,
          labelB,
          sideAKey: encodeVs(dumbbellSideA),
          sideBKey: encodeVs(dumbbellSideB),
          playerCount: players.length - (result?.excluded?.length ?? 0),
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
        const metric = getMetric(barMetricKey, discipline);
        if (!metric) { hideStatus(); return; }
        metricKeys = [metric.key];
        config = { type: "bar", discipline, metric, playerCount: players.length, style: barStyle, roster };
      } else if (chartType === "donut") {
        const metric = getMetric(donutMetricKey, discipline);
        if (!metric) {
          hideStatus();
          renderExclusions([], "No additive-total metric available for a donut chart in this scope.");
          return;
        }
        metricKeys = [metric.key];
        config = { type: "donut", discipline, metric, playerCount: players.length, roster };
      } else if (chartType === "scatter") {
        const metricX = getMetric(scatterXKey, discipline);
        const metricY = getMetric(scatterYKey, discipline);
        if (!metricX || !metricY) { hideStatus(); return; }
        metricKeys = [metricX.key, metricY.key];
        config = { type: "scatter", discipline, metricX, metricY, playerCount: players.length, roster };
      } else if (chartType === "radar") {
        const groups = eligibleRadarGroups(discipline, state.formats);
        const group = groups.find((g) => g.id === radarGroupId) || groups[0];
        if (!group) {
          hideStatus();
          renderExclusions([], "No metric groups available for this scope.");
          return;
        }
        const metrics = group.metricKeys.map((k) => getMetric(k, discipline)).filter(Boolean);
        metricKeys = metrics.map((m) => m.key);
        config = { type: "radar", discipline, group, metrics, playerCount: players.length, roster };
      } else if (chartType === "phases") {
        const families = eligiblePhaseFamilies(discipline, state.formats);
        const family = families.find((f) => f.id === phaseFamilyId) || families[0];
        if (!family) {
          hideStatus();
          renderExclusions([], "No phase metric families available for this scope.");
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

  async function onShow() {
    // Organic tab visit (clicking the "Graphs" tab directly) — as opposed to
    // a bridge jump (enterFromBridge/addPlayerFromOutside, which set this
    // themselves and do NOT call onShow before doing so). Decision 43: the
    // back link "only appears after a bridge jump, not on organic tab
    // visits" — resetting here is what makes that true even after a bridge
    // jump the user didn't click the link away from (switch to Stats, then
    // back to Graphs organically: the link should be gone).
    bridgeFromTable = false;
    syncBridgeBackVisibility();
    syncChartTypeButtons();
    syncChartTypeAvailability();
    syncBarStyleVisibility();
    renderMetricControls();
    await seedSelection();
    scheduleRender({ paramsChanged: true });
  }

  /**
   * "Turn into graph" bridge (task 1, decision 43): called by the host app
   * when the Stats toolbar's button is clicked. Forces the bar chart (the
   * "top N ranked by one stat" type — the closest analogue to a sorted
   * table, and the one whose cap the task brief's "top bar-max players"
   * seeding explicitly names), sets its metric to the table's current sort
   * column when that metric is graph-eligible for the live discipline/
   * formats (otherwise the bar chart's existing metric is left alone — there
   * may not even BE a "current" one yet if bar was never active), and force-
   * reseeds from the CURRENT filtered set (bypassing seedSelection's
   * unchanged-scope no-op, since this must always reflect "right now").
   * `seedSelection` already ranks by the store's live sort key and caps at
   * CHART_CAPS[chartType].max — which, since chartType is forced to "bar"
   * first, is exactly the top-15 the brief describes.
   */
  async function enterFromBridge({ preferredMetricKey } = {}) {
    bridgeFromTable = true;
    syncBridgeBackVisibility();
    const state = store.get();

    // Task 3 (matchup bridge, Batch 4 wave 2): if the table was in matchup
    // "Vs" mode when the bridge was clicked, land on the Dumbbell chart — the
    // one chart type that understands matchup vocabulary — instead of always
    // forcing Bar (a bar chart has no matchup-mode column set to draw from).
    if (state.discipline === "batting" && matchupVsActive(state)) {
      chartType = "dumbbell";
      syncChartTypeButtons();
      syncChartTypeAvailability();
      syncBarStyleVisibility();
      clearCapNote();

      // Side B = the table's own selection; Side A = the "opposite family"
      // default (dumbbell.js's classifyBowlingFamily heuristic) — a sensible
      // contrasting starting point the user can freely repick afterward.
      const tableVs = state.matchupVs;
      dumbbellSideB = tableVs;
      dumbbellSideA = oppositeDefaultSide(tableVs);

      const metrics = dumbbellEligibleMetrics(state.formats);
      dumbbellMetricKey =
        preferredMetricKey && metrics.some((m) => m.key === preferredMetricKey)
          ? preferredMetricKey
          : (metrics.find((m) => m.key === "strike_rate") || metrics[0])?.key ?? null;

      renderMetricControls();
      await seedSelection({ force: true });
      scheduleRender({ paramsChanged: true });
      return;
    }

    chartType = "bar";
    syncChartTypeButtons();
    syncChartTypeAvailability();
    syncBarStyleVisibility();
    clearCapNote();
    if (preferredMetricKey) {
      const eligible = eligibleMetrics(state.discipline, state.formats);
      if (eligible.some((m) => m.key === preferredMetricKey)) {
        barMetricKey = preferredMetricKey;
      }
    }
    renderMetricControls();
    await seedSelection({ force: true });
    scheduleRender({ paramsChanged: true });
  }

  /**
   * "Graph this player" (task 4, decision 43): called by the host app after
   * it has already ensured the Graphs view is showing (normally via onShow()
   * — see the host wiring). Adds ONE player to whatever roster already
   * exists — no reseed, no chart-type change — marking it dirty (via
   * players.js's createSelection.add()) so the title's "top N" phrasing
   * correctly drops to "N players" the moment the roster stops being exactly
   * the seeded set. Deliberately does NOT touch bridgeFromTable/the back
   * link — there's no "table" this jump came from to link back to.
   * Cap handling reuses the exact same note the manual player-search "add"
   * path already shows (no new copy for the same situation).
   */
  function addPlayerFromOutside(id, name) {
    // Same "pool is never truncated, checked only if there's room" contract
    // as the manual search-add flow (Batch 8, task 1) — see that handler's
    // comment for why this can no longer fail outright on a full cap.
    const result = selection.addCandidate({ id, name });
    if (result.ok && !result.checked) {
      showCapNote(`Added to your list, but this chart type is capped at ${CHART_CAPS[chartType].max} players — untick one to plot them instead.`);
    } else if (result.ok) {
      clearCapNote();
    }
    // "already-selected": silent no-op — the player's already in the roster,
    // which is exactly what the task brief asks for ("adds ... if absent").
  }

  /** Called whenever the shared filter scope changes (discipline/format/filters). */
  function onScopeChanged() {
    // Batch 4 wave 2: Dumbbell needs batting discipline + men's cricket (see
    // dumbbellAvailable() above). If a scope change lands outside that while
    // Dumbbell is the active chart type, fall back to Bar rather than leaving
    // the picker on a now-disabled type with a stale matchup chart still drawn.
    if (chartType === "dumbbell" && !dumbbellAvailable(store.get())) {
      chartType = "bar";
      syncChartTypeButtons();
      syncBarStyleVisibility();
      clearCapNote();
      // Same mode-aware cap reconciliation as the chart-type click handler
      // (this fallback can flip the cap/ranking metric just like a manual
      // switch would, and seedSelection() below may no-op if this alone
      // didn't change the scope key, so it can't be relied on to reconcile).
      if (selection.getMode() === "manual") {
        selection.clampToCap();
      } else {
        selection.clampToCap({ silent: true });
        deriveChecked(selection.getMode());
      }
      renderPlayerList();
    }
    syncChartTypeAvailability();
    renderMetricControls(); // metric eligibility may have changed (phase gating)
    // Re-seed from the new filtered set — the old selection may no longer make
    // sense for a different discipline; for pure filter tweaks we still refresh
    // to keep the "reset to filtered set" meaningful, but we only auto-reseed
    // (rather than just re-querying) when the discipline changed or nothing has
    // been manually customized yet in this scope. To keep behavior predictable
    // and honest, we re-seed whenever the underlying filtered set's identity key
    // changes; seedSelection() itself no-ops if nothing changed.
    seedSelection().then(() => scheduleRender({ paramsChanged: true }));
  }

  return { onShow, onScopeChanged, enterFromBridge, addPlayerFromOutside };
}
