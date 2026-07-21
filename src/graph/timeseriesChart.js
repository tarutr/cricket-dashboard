// src/graph/timeseriesChart.js
//
// Chart.js renderer for the Line chart (R5-D, decisions 51 + 53). Consumes the
// structured dataset from timeseries.js's fetchLineData UNCHANGED — this module
// only turns { buckets, byPlayer } into a Chart.js line chart. One Y-metric ×
// one X-dimension × up to 6 player lines.
//
// NO DATA-POLICING (decision 49): every point is drawn at full strength — there
// is NO thin-sample fading and NO minimum-ball floor (MIN_BALLS_PER_YEAR is
// gone). The only "missing" state is a genuine GAP: a bucket a player has no
// data for carries no marker; the line spans across it as a trend (spanGaps),
// exactly as the previous by-year line did.

import { hasMetricData, metricDisplayLabel } from "../metrics.js";
import { palette, SERIES_COLORS, labelForValue, destroyIfExists } from "./charts.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{current: any}} chartRef
 * @param {object} params
 * @param {object} params.metric   the charted Y-metric (metrics.js def)
 * @param {object} params.lineData fetchLineData() result:
 *   { xDim, kind, buckets:[{key,label,ord}], byPlayer:{id:{name,values:{key:{value,sample}}}} }
 * @param {Array<{id,name}>} params.players the selected roster in selection order
 *   (determines series-color assignment and the included/excluded split)
 * @param {string[]} [params.formats] scope formats (for the metric display label)
 * @returns {{excluded: string[], note: string|null}}
 */
export function buildTimeseriesChart(canvas, chartRef, { metric, lineData, players, formats = [] }) {
  destroyIfExists(chartRef);

  const buckets = lineData.buckets || [];
  const byPlayer = lineData.byPlayer || {};

  // Included = a roster player with at least one real (non-gap) value across the
  // buckets; everyone else is excluded with the standard note (same as every
  // other chart type — §8.1). A player present in byPlayer but whose every
  // bucket value is NULL (e.g. a rate with a zero denominator everywhere) is
  // excluded too, so we never draw a player as a dead flat nothing.
  const included = [];
  const excluded = [];
  for (const p of players) {
    const rec = byPlayer[p.id];
    const hasReal =
      rec && buckets.some((b) => rec.values[b.key] && hasMetricData(metric, rec.values[b.key].value));
    if (hasReal) included.push({ id: p.id, name: rec.name || p.name, rec });
    else excluded.push(p.name);
  }

  if (included.length === 0) return { excluded, note: null };

  const labels = buckets.map((b) => b.label);
  const pal = palette();
  let lonePointPlayers = 0;

  const datasets = included.map((p, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    const data = [];
    const pointRadius = [];
    for (const b of buckets) {
      const cell = p.rec.values[b.key];
      if (!cell || !hasMetricData(metric, cell.value)) {
        // Gap: no marker, no fake zero. spanGaps connects the measured points.
        data.push(null);
        pointRadius.push(0);
        continue;
      }
      data.push(Number(cell.value));
      pointRadius.push(4);
    }
    // A player with exactly one real point can't form a line — draw it a touch
    // larger so it reads as a deliberate datum, not a stray dot.
    const realIdxs = data.map((v, idx) => (v != null ? idx : -1)).filter((idx) => idx >= 0);
    if (realIdxs.length === 1) {
      pointRadius[realIdxs[0]] = 6;
      lonePointPlayers++;
    }
    return {
      label: p.name,
      data,
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: color,
      pointBorderColor: color,
      pointBorderWidth: 2,
      pointRadius,
      pointHoverRadius: 7,
      borderWidth: 2,
      spanGaps: true,
      tension: 0.15,
    };
  });

  const yLabel = metricDisplayLabel(metric, formats);

  chartRef.current = new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { color: pal.ink, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? labels[items[0].dataIndex] : ""),
            label: (ctx) => {
              const p = included[ctx.datasetIndex];
              const b = buckets[ctx.dataIndex];
              const cell = b && p.rec.values[b.key];
              if (!cell || !hasMetricData(metric, cell.value)) return `${p.name}: no data`;
              const ballsTxt =
                cell.sample != null ? ` · ${Number(cell.sample).toLocaleString()} balls` : "";
              return `${p.name}: ${metric.shortLabel} ${labelForValue(metric, cell.value)}${ballsTxt}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: pal.line }, ticks: { color: pal.ink } },
        y: {
          grid: { color: pal.line },
          ticks: { color: pal.muted },
          title: { display: true, text: yLabel, color: pal.muted },
        },
      },
    },
  });

  const note =
    lonePointPlayers > 0
      ? `${lonePointPlayers} player${lonePointPlayers === 1 ? "" : "s"} with only one bucket in range ${
          lonePointPlayers === 1 ? "shows" : "show"
        } as a single point (no line).`
      : null;
  return { excluded, note };
}
