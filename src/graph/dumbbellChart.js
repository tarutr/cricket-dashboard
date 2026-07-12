// src/graph/dumbbellChart.js
//
// Chart.js renderer for the DUMBBELL chart. Owner correction: this is a
// TIME-WINDOW chart, NOT a Pace-vs-Spin chart — it draws Slope's exact data
// (one rate/percent metric across Window A vs Window B) as one horizontal row
// per player: two dots (Window A hollow, Window B filled) joined by a muted
// connector, sorted by Window B's value. Data comes from charts.js's
// fetchWindowMetric (two independent calls, one per window — the same Maps
// Slope consumes), so this module only draws it. Kept in its own file for the
// same reason timeseriesChart.js is (charts.js is already well past the
// ~600-line guidance; see that file's header).
//
// Rendering technique: ONE real Chart.js dataset — a horizontal FLOATING bar
// per player (data = [min(a,b), max(a,b)]), thin and muted, which doubles as
// the "connector line" the task brief asks for (a floating bar IS a line
// segment between two values, drawn with the bar renderer). The two dots and
// their value labels are then drawn by a single afterDatasetsDraw plugin,
// computing pixel positions directly from the shared x scale
// (chart.scales.x.getPixelForValue(a/b)) and the bar element's own y pixel —
// the same "plugin draws exact marks Chart.js has no built-in mark for"
// idiom charts.js's bar/scatter/slope builders already use throughout this
// codebase. No new Chart.js chart TYPE is introduced (still "bar"), only a
// floating-bar data shape (a native, documented Chart.js feature) plus a
// canvas plugin.

import { hasMetricData } from "../metrics.js";
import { palette, labelForValue, destroyIfExists } from "./charts.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{current: any}} chartRef
 * @param {object} params
 * @param {object} params.metric a metrics.js metric (rate/percent, batting or bowling)
 * @param {string} params.labelA human label for Window A (e.g. "Jul 2023–Jan 2025")
 * @param {string} params.labelB human label for Window B (e.g. "Feb 2025–Jul 2026")
 * @param {Map<string, object>} params.rowsA charts.js's fetchWindowMetric result, Window A
 * @param {Map<string, object>} params.rowsB charts.js's fetchWindowMetric result, Window B
 * @param {Array<{id, name}>} params.players the selected roster
 * @returns {{excluded: string[], note: string|null}}
 */
export function buildDumbbellChart(canvas, chartRef, { metric, labelA, labelB, rowsA, rowsB, players }) {
  destroyIfExists(chartRef);

  const included = [];
  const excluded = [];
  for (const p of players) {
    const rowA = rowsA.get(p.id);
    const rowB = rowsB.get(p.id);
    const rawA = rowA ? rowA[metric.key] : null;
    const rawB = rowB ? rowB[metric.key] : null;
    // Same both-windows rule as Slope: a player needs real data in BOTH
    // windows to form a dumbbell (a value in only one window is not a
    // comparison). Missing either → excluded (visible note).
    if (rowA && rowB && hasMetricData(metric, rawA) && hasMetricData(metric, rawB)) {
      included.push({ id: p.id, name: p.name, a: Number(rawA), b: Number(rawB) });
    } else {
      excluded.push(p.name);
    }
  }

  // Nobody qualifies for both windows → draw nothing (the caller shows an
  // honest placeholder), never an empty bar box (§7 — mirrors buildSlopeChart).
  if (included.length === 0) {
    return { excluded, note: `${included.length} of ${players.length} selected players have data in both windows.` };
  }

  // Sorted by Window B's value, descending (kept from the original renderer).
  included.sort((a, b) => b.b - a.b);

  const pal = palette();
  // Declutter (mirrors the Slope chart's rule): drop per-dot value labels
  // once more than ~8 players are drawn — the tooltip still has the exact
  // numbers below that threshold.
  const showValues = included.length <= 8;

  chartRef.current = new Chart(canvas, {
    type: "bar",
    data: {
      labels: included.map((r) => r.name),
      datasets: [
        {
          // The floating-bar "connector" — order-independent (Chart.js draws
          // from the smaller to the larger value regardless of array order),
          // so the actual A/B identity for the dots comes from `included`
          // directly (via the plugin below), never from this bar's own
          // start/end.
          data: included.map((r) => [Math.min(r.a, r.b), Math.max(r.a, r.b)]),
          backgroundColor: pal.muted,
          borderRadius: 2,
          maxBarThickness: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: showValues ? 72 : 16, left: 8, top: 8, bottom: 8 } },
      plugins: {
        legend: {
          position: "top",
          labels: {
            color: pal.ink,
            usePointStyle: true,
            pointStyle: "circle",
            generateLabels() {
              return [
                { text: `○ ${labelA}`, fillStyle: pal.bg, strokeStyle: pal.ink, lineWidth: 2, pointStyle: "circle", datasetIndex: 0 },
                { text: `● ${labelB}`, fillStyle: pal.accent, strokeStyle: pal.accent, lineWidth: 2, pointStyle: "circle", datasetIndex: 0 },
              ];
            },
          },
          // Both fake legend items reference the one real dataset — clicking
          // either would just toggle it off with no way to tell them apart,
          // so disable the toggle-on-click behavior entirely.
          onClick: () => {},
        },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? included[items[0].dataIndex].name : ""),
            label: (ctx) => {
              const r = included[ctx.dataIndex];
              return [`${labelA}: ${labelForValue(metric, r.a)}`, `${labelB}: ${labelForValue(metric, r.b)}`];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: pal.line },
          ticks: { color: pal.muted },
          title: { display: true, text: metric.label, color: pal.muted },
        },
        y: {
          grid: { display: false },
          ticks: { color: pal.ink, autoSkip: false },
        },
      },
    },
    plugins: [
      {
        id: "dumbbellDots",
        afterDatasetsDraw(chart) {
          const { ctx, chartArea, scales } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          ctx.textBaseline = "middle";
          ctx.font = "600 11px Inter, sans-serif";

          meta.data.forEach((bar, i) => {
            const r = included[i];
            if (!r) return;
            const y = bar.y;
            const xA = scales.x.getPixelForValue(r.a);
            const xB = scales.x.getPixelForValue(r.b);

            // Side A: hollow dot (paper-white fill, ink outline).
            ctx.beginPath();
            ctx.arc(xA, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = pal.bg;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = pal.ink;
            ctx.stroke();

            // Side B: filled accent dot.
            ctx.beginPath();
            ctx.arc(xB, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = pal.accent;
            ctx.fill();

            if (!showValues) return;
            const leftIsA = xA <= xB;
            const aText = labelForValue(metric, r.a);
            const bText = labelForValue(metric, r.b);
            const aWidth = ctx.measureText(aText).width;
            const bWidth = ctx.measureText(bText).width;

            ctx.fillStyle = pal.ink;
            if (leftIsA) {
              ctx.textAlign = "right";
              ctx.fillText(aText, Math.max(xA - 8, chartArea.left + aWidth + 4), y);
              ctx.textAlign = "left";
              ctx.fillText(bText, Math.min(xB + 8, chartArea.right - bWidth - 4), y);
            } else {
              ctx.textAlign = "left";
              ctx.fillText(aText, Math.min(xA + 8, chartArea.right - aWidth - 4), y);
              ctx.textAlign = "right";
              ctx.fillText(bText, Math.max(xB - 8, chartArea.left + bWidth + 4), y);
            }
          });
          ctx.restore();
        },
      },
    ],
  });

  const note =
    included.length < players.length
      ? `${included.length} of ${players.length} selected players have data in both windows.`
      : null;

  return { excluded, note };
}
