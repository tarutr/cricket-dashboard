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

import { eligibleMetrics } from "../state.js";
import { getMetric, hasMetricData } from "../metrics.js";
import { escHtml, escAttr } from "../html.js";
import {
  CHART_CAPS,
  createSelection,
  seedFromFilteredSet,
  searchPlayers,
} from "./players.js";
import {
  fetchSelectedPlayerMetrics,
  buildBarChart,
  buildDonutChart,
  buildScatterChart,
  buildRadarSmallMultiples,
} from "./charts.js";
import { mountCard } from "./card.js";
import { eligibleRadarGroups } from "./radarGroups.js";

const CHART_TYPES = [
  { key: "bar", label: "Bar" },
  { key: "donut", label: "Donut" },
  { key: "scatter", label: "Scatter" },
  { key: "radar", label: "Radar" },
];

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

export function mountGraph(container, store, { onRequery } = {}) {
  container.innerHTML = `
    <div class="graph-builder">
      <div class="graph-builder__controls">
        <div class="graph-control-group">
          <span class="graph-control-label">Chart type</span>
          <div class="segmented graph-chart-type" data-role="chart-type" role="group" aria-label="Chart type">
            ${CHART_TYPES.map((t) => `<button type="button" class="segmented__btn" data-value="${t.key}">${t.label}</button>`).join("")}
          </div>
          <p class="graph-chart-type-caption" data-role="chart-type-caption"></p>
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
            <span class="graph-player-count" data-role="player-count"></span>
          </div>
          <div class="graph-player-search">
            <input type="text" class="input" data-role="player-search" placeholder="Add a player…" aria-label="Search players to add" />
            <div class="graph-player-search__results" data-role="player-search-results" hidden></div>
          </div>
          <ul class="graph-player-list" data-role="player-list"></ul>
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
    chartType: container.querySelector('[data-role="chart-type"]'),
    chartTypeCaption: container.querySelector('[data-role="chart-type-caption"]'),
    barStyleGroup: container.querySelector('[data-role="bar-style"]'),
    barStyleToggle: container.querySelector('[data-role="bar-style-toggle"]'),
    metricControls: container.querySelector('[data-role="metric-controls"]'),
    playerCount: container.querySelector('[data-role="player-count"]'),
    playerSearch: container.querySelector('[data-role="player-search"]'),
    playerSearchResults: container.querySelector('[data-role="player-search-results"]'),
    playerList: container.querySelector('[data-role="player-list"]'),
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

  let seeded = false; // has the selection ever been seeded for the current discipline+scope?
  let lastSeedKey = null;
  let loadToken = 0;

  const selection = createSelection({
    getCap: () => CHART_CAPS[chartType].max,
    onChange: () => {
      renderPlayerList();
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
        scheduleRender({ paramsChanged: true });
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
          scheduleRender({ paramsChanged: true });
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
        scheduleRender({ paramsChanged: true });
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
    }
  }

  // ── Player list UI ────────────────────────────────────────────────────────

  function renderPlayerList() {
    const players = selection.get();
    const cap = CHART_CAPS[chartType].max;
    els.playerCount.textContent = `${players.length} / ${cap}`;
    els.playerList.innerHTML = players
      .map(
        (p) => `<li class="graph-player-list__item" data-id="${p.id}">
          <span>${escHtml(p.name)}</span>
          <button type="button" class="icon-btn" data-role="remove-player" data-id="${p.id}" title="Remove">&times;</button>
        </li>`
      )
      .join("") || `<li class="graph-player-list__empty">No players selected.</li>`;

    els.playerList.querySelectorAll('[data-role="remove-player"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        selection.remove(btn.dataset.id);
      });
    });
  }

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
            const result = selection.add({ id: btn.dataset.id, name: btn.dataset.name });
            if (!result.ok && result.reason === "cap") {
              showCapNote(`Can't add — this chart type is capped at ${result.cap} players. Remove one first.`);
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
  const CHART_TYPE_CAPTIONS = {
    bar: "Rank players on one stat",
    donut: "Share of a total — needs a countable stat",
    scatter: "Two stats mapped against each other",
    radar: "Player shape profiles, side by side",
  };

  function syncChartTypeButtons() {
    els.chartType.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === chartType);
    });
    els.chartTypeCaption.textContent = CHART_TYPE_CAPTIONS[chartType] || "";
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
    if (!btn || btn.dataset.value === chartType) return;
    chartType = btn.dataset.value;
    syncChartTypeButtons();
    syncBarStyleVisibility();
    clearCapNote();
    renderMetricControls();
    selection.applyCapForNewType();
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
      clearCapNote();
      selection.setAll(seedPlayers);
    } catch (e) {
      showErrorStatus(e, () => seedSelection({ force: true }));
    }
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
      card.showPlaceholder(`Add at least ${capDef.min} player${capDef.min === 1 ? "" : "s"} to draw this chart.`);
      renderExclusions([]);
      return;
    }

    card.hidePlaceholder();
    showStatus("Running query…");

    try {
      let metricKeys = [];
      let config;

      if (chartType === "bar") {
        const metric = getMetric(barMetricKey, discipline);
        if (!metric) { hideStatus(); return; }
        metricKeys = [metric.key];
        config = { type: "bar", discipline, metric, playerCount: players.length, style: barStyle };
      } else if (chartType === "donut") {
        const metric = getMetric(donutMetricKey, discipline);
        if (!metric) {
          hideStatus();
          renderExclusions([], "No additive-total metric available for a donut chart in this scope.");
          return;
        }
        metricKeys = [metric.key];
        config = { type: "donut", discipline, metric, playerCount: players.length };
      } else if (chartType === "scatter") {
        const metricX = getMetric(scatterXKey, discipline);
        const metricY = getMetric(scatterYKey, discipline);
        if (!metricX || !metricY) { hideStatus(); return; }
        metricKeys = [metricX.key, metricY.key];
        config = { type: "scatter", discipline, metricX, metricY, playerCount: players.length };
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
        config = { type: "radar", discipline, group, metrics, playerCount: players.length };
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
      }

      renderExclusions(result?.excluded ?? []);

      if (pendingRegenerate) {
        card.regenerate(config, store.describeScope());
        pendingRegenerate = false;
      } else {
        card.updateFooterScope(store.describeScope());
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
    syncChartTypeButtons();
    syncBarStyleVisibility();
    renderMetricControls();
    await seedSelection();
    scheduleRender({ paramsChanged: true });
  }

  /** Called whenever the shared filter scope changes (discipline/format/filters). */
  function onScopeChanged() {
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

  return { onShow, onScopeChanged };
}
