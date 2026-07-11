// src/playerGraphChooser.js
//
// "Graph this player" chooser (owner decision 46) — a small modal OVER the
// player popup, asking "what do you want to see?" before jumping to Graphs.
// Why this exists: the Graphs tab no longer pre-picks a chart type (decision
// 46f, commit b4d8ef1) — landing there cold now shows "Pick a chart type to
// get started", which is disorienting right after clicking a dedicated
// "Graph this player" button. This chooser collects the type + metric HERE,
// then src/graph/graph.js's enterWithChoice() renders immediately — an
// explicit user choice, so no-defaults isn't being violated (see that
// function's own doc comment).
//
// Ownership split: this module is dumb UI + one read (which types work for
// this player/scope, and what metric field each needs) — both come from
// src/graph/graph.js's evaluateChartTypesForPlayer(), never duplicated here.
// It knows nothing about closing the player popup or switching views — the
// caller's onConfirm({ chartType, metricKey, player }) handles all of that
// (see src/playerPopup.js).

import { evaluateChartTypesForPlayer } from "./graph/graph.js";
import { escHtml, escAttr } from "./html.js";

/**
 * Mount the chooser (hidden) into `hostEl`. `onConfirm({chartType, metricKey,
 * player})` fires on "Show graph"; Cancel/Escape/backdrop just close it —
 * the player popup underneath is untouched either way (owner decision 46,
 * requirement 3).
 */
export function mountPlayerGraphChooser(hostEl, { onConfirm } = {}) {
  hostEl.innerHTML = `
    <div class="player-graph-chooser" data-role="chooser" hidden>
      <div class="player-graph-chooser__backdrop" data-role="chooser-backdrop"></div>
      <div class="player-graph-chooser__panel" role="dialog" aria-modal="true" aria-label="Choose a chart" tabindex="-1" data-role="chooser-panel">
        <div class="player-graph-chooser__header">
          <h3 class="player-graph-chooser__title" data-role="chooser-title">Graph this player</h3>
          <button type="button" class="drawer__close" data-role="chooser-close" aria-label="Close">&times;</button>
        </div>
        <div class="player-graph-chooser__body">
          <div class="graph-control-group">
            <span class="graph-control-label">Chart type</span>
            <div class="segmented graph-chart-type" data-role="chooser-chart-type" role="group" aria-label="Chart type"></div>
          </div>
          <div class="graph-control-group" data-role="chooser-metric-area"></div>
        </div>
        <div class="player-graph-chooser__footer">
          <button type="button" class="btn btn--ghost" data-role="chooser-cancel">Cancel</button>
          <button type="button" class="btn btn--primary" data-role="chooser-confirm" disabled>Show graph</button>
        </div>
      </div>
    </div>
  `;

  const els = {
    root: hostEl.querySelector('[data-role="chooser"]'),
    backdrop: hostEl.querySelector('[data-role="chooser-backdrop"]'),
    panel: hostEl.querySelector('[data-role="chooser-panel"]'),
    title: hostEl.querySelector('[data-role="chooser-title"]'),
    closeBtn: hostEl.querySelector('[data-role="chooser-close"]'),
    typeGrid: hostEl.querySelector('[data-role="chooser-chart-type"]'),
    metricArea: hostEl.querySelector('[data-role="chooser-metric-area"]'),
    cancelBtn: hostEl.querySelector('[data-role="chooser-cancel"]'),
    confirmBtn: hostEl.querySelector('[data-role="chooser-confirm"]'),
  };

  let open_ = false;
  let player = null; // {id, name}
  let types = []; // evaluateChartTypesForPlayer(player) result
  let selectedType = null;
  let metricSingle = null; // single-metric types
  let metricX = null; // scatter only
  let metricY = null; // scatter only

  function isOpen() {
    return open_;
  }

  function selectedTypeInfo() {
    return types.find((t) => t.key === selectedType) || null;
  }

  function renderTypeGrid() {
    els.typeGrid.innerHTML = types
      .map(
        (t) =>
          `<button type="button" class="segmented__btn${t.ok ? "" : " is-unavailable"}${t.key === selectedType ? " is-active" : ""}" data-value="${escAttr(t.key)}">${escHtml(t.label)}</button>`
      )
      .join("");
    els.typeGrid.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        // decision 46: never HTML-disabled — same "clicking a greyed tile
        // just explains why" posture as the Graphs panel's own chart-type
        // buttons (graph.js's syncChartTypeButtons()/evaluateTypeStatus()).
        selectedType = btn.dataset.value;
        const info = selectedTypeInfo();
        const field = info?.metricField;
        metricSingle = field?.kind === "single" ? field.defaultKey : null;
        metricX = field?.kind === "xy" ? field.defaultX : null;
        metricY = field?.kind === "xy" ? field.defaultY : null;
        renderTypeGrid();
        renderMetricArea();
        syncConfirmButton();
      });
    });
  }

  function renderMetricArea() {
    const info = selectedTypeInfo();
    if (!info) {
      els.metricArea.innerHTML = `<p class="graph-metric-note">Pick a chart type above.</p>`;
      return;
    }
    if (!info.ok) {
      els.metricArea.innerHTML = `<p class="graph-metric-note">${escHtml(info.reason || "Not available right now.")}</p>`;
      return;
    }
    const field = info.metricField;
    if (!field || field.kind === "none") {
      els.metricArea.innerHTML = `<p class="graph-metric-note">${escHtml(field?.note || "No single metric to pick for this chart type.")}</p>`;
      return;
    }
    if (field.kind === "xy") {
      els.metricArea.innerHTML = `
        <span class="graph-control-label">X axis</span>
        <select class="select graph-metric-select" data-role="chooser-metric-x">
          ${field.xOptions.map((m) => `<option value="${escAttr(m.key)}" ${m.key === metricX ? "selected" : ""}>${escHtml(m.label)}</option>`).join("")}
        </select>
        <span class="graph-control-label">Y axis</span>
        <select class="select graph-metric-select" data-role="chooser-metric-y">
          ${field.yOptions.map((m) => `<option value="${escAttr(m.key)}" ${m.key === metricY ? "selected" : ""}>${escHtml(m.label)}</option>`).join("")}
        </select>`;
      els.metricArea.querySelector('[data-role="chooser-metric-x"]').addEventListener("change", (e) => {
        metricX = e.target.value;
      });
      els.metricArea.querySelector('[data-role="chooser-metric-y"]').addEventListener("change", (e) => {
        metricY = e.target.value;
      });
      return;
    }
    // "single"
    els.metricArea.innerHTML = field.options.length
      ? `<span class="graph-control-label">Metric</span>
         <select class="select graph-metric-select" data-role="chooser-metric-single">
           ${field.options.map((m) => `<option value="${escAttr(m.key)}" ${m.key === metricSingle ? "selected" : ""}>${escHtml(m.label)}</option>`).join("")}
         </select>`
      : `<p class="graph-metric-note">No metric available for this chart type in the current scope.</p>`;
    const sel = els.metricArea.querySelector('[data-role="chooser-metric-single"]');
    if (sel) {
      sel.addEventListener("change", (e) => {
        metricSingle = e.target.value;
      });
    }
  }

  function syncConfirmButton() {
    els.confirmBtn.disabled = !selectedType;
  }

  function close() {
    if (!open_) return;
    open_ = false;
    els.root.hidden = true;
  }

  function open(nextPlayer) {
    player = nextPlayer;
    types = evaluateChartTypesForPlayer(player);
    selectedType = null;
    metricSingle = null;
    metricX = null;
    metricY = null;
    els.title.textContent = `Graph ${player.name}`;
    renderTypeGrid();
    renderMetricArea();
    syncConfirmButton();
    open_ = true;
    els.root.hidden = false;
    els.panel.focus();
  }

  els.closeBtn.addEventListener("click", close);
  els.cancelBtn.addEventListener("click", close);
  els.backdrop.addEventListener("click", close);

  els.confirmBtn.addEventListener("click", () => {
    if (!selectedType || !player) return;
    const metricKey = selectedType === "scatter" ? { x: metricX, y: metricY } : metricSingle;
    const chosenPlayer = player;
    const chosenType = selectedType;
    close();
    if (onConfirm) onConfirm({ chartType: chosenType, metricKey, player: chosenPlayer });
  });

  // Escape closes ONLY this chooser, never the player popup underneath it
  // (requirement 3) — stopImmediatePropagation so the popup's OWN Escape
  // listener (registered after this one — see playerPopup.js's mount order)
  // never runs for this keypress and doesn't also close the popup.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !open_) return;
    e.stopImmediatePropagation();
    close();
  });

  return { open, close, isOpen };
}
