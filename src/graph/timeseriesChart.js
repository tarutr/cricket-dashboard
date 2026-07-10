// src/graph/timeseriesChart.js
//
// Chart.js renderer for the "By year" progression line chart (Batch 4 wave 2,
// task 1, decision 43's progression chart). Data comes from timeseries.js's
// buildTimeseriesQuery UNCHANGED — this module only turns those
// {player_id, player_name, year, value, sample} rows into a Chart.js line
// chart. Kept in its own file rather than added to charts.js, which is
// already ~1000 lines (well past SPEC §8.3's ~600-line guidance) before this
// batch — growing it further wasn't warranted when a new file works just as
// well and this chart type has no other renderer to share code with.

import { hasMetricData } from "../metrics.js";
import { MIN_BALLS_PER_YEAR } from "./timeseries.js";
import { palette, SERIES_COLORS, labelForValue, destroyIfExists } from "./charts.js";

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{current: any}} chartRef
 * @param {object} params
 * @param {object} params.metric a metrics.js metric (the charted stat)
 * @param {Array<{player_id, player_name, year, value, sample}>} params.rows
 *   timeseries.js's buildTimeseriesQuery result rows
 * @param {Array<{id, name}>} params.players the full selected roster (in
 *   selection order — determines series color assignment and the
 *   included/excluded split)
 * @returns {{excluded: string[], note: string|null}}
 */
export function buildTimeseriesChart(canvas, chartRef, { metric, rows, players }) {
  destroyIfExists(chartRef);

  // Group rows by player id -> Map<year, {value, sample}>.
  const byPlayer = new Map();
  for (const row of rows) {
    if (!byPlayer.has(row.player_id)) byPlayer.set(row.player_id, new Map());
    byPlayer.get(row.player_id).set(row.year, { value: row.value, sample: row.sample });
  }

  // §8.1 / decision 43: a player with NO qualifying years at all (zero rows —
  // e.g. every year they played fell below the metric's own zero-denominator
  // case, or they simply have no innings in this scope) is excluded with the
  // standard note, same as every other chart type.
  const included = [];
  const excluded = [];
  for (const p of players) {
    const years = byPlayer.get(p.id);
    if (years && years.size > 0) {
      included.push({ id: p.id, name: p.name, years });
    } else {
      excluded.push(p.name);
    }
  }

  // x axis: the union of every year with at least one INCLUDED player's row,
  // sorted ascending — never the raw dataset's full year range, so a chart of
  // just one modern player's short career doesn't stretch back to 1877.
  const yearSet = new Set();
  for (const p of included) for (const y of p.years.keys()) yearSet.add(y);
  const years = [...yearSet].sort((a, b) => a - b);

  const pal = palette();
  let anyGreyPoint = false;

  const datasets = included.map((p, i) => {
    const color = SERIES_COLORS[i % SERIES_COLORS.length];
    const data = [];
    const pointBg = [];
    const pointBorder = [];
    const pointRadius = [];
    for (const y of years) {
      const cell = p.years.get(y);
      // A year with no row, OR a row whose value is SQL NULL (a rate metric
      // with a zero denominator that year), is a GAP — never plotted as zero
      // (§8.1). spanGaps: false (below) keeps the line from bridging over it.
      if (!cell || !hasMetricData(metric, cell.value)) {
        data.push(null);
        pointBg.push(color);
        pointBorder.push(color);
        pointRadius.push(0);
        continue;
      }
      const thin = cell.sample < MIN_BALLS_PER_YEAR;
      if (thin) anyGreyPoint = true;
      data.push(Number(cell.value));
      // Thin-sample years are drawn GREYED — hollow (paper-white fill, muted
      // outline) — but still plotted, per the task brief: honesty about a
      // small sample means flagging it, not hiding the datum.
      pointBg.push(thin ? pal.bg : color);
      pointBorder.push(thin ? pal.muted : color);
      pointRadius.push(4);
    }
    return {
      label: p.name,
      data,
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: pointBg,
      pointBorderColor: pointBorder,
      pointBorderWidth: 2,
      pointRadius,
      pointHoverRadius: 6,
      borderWidth: 2,
      spanGaps: false,
      tension: 0.15,
    };
  });

  chartRef.current = new Chart(canvas, {
    type: "line",
    data: { labels: years.map(String), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { color: pal.ink, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? years[items[0].dataIndex] : ""),
            label: (ctx) => {
              const p = included[ctx.datasetIndex];
              const year = years[ctx.dataIndex];
              const cell = p.years.get(year);
              if (!cell || !hasMetricData(metric, cell.value)) return `${p.name}: no data`;
              return `${p.name}: ${metric.shortLabel} ${labelForValue(metric, cell.value)} · ${Number(
                cell.sample
              ).toLocaleString()} balls`;
            },
          },
        },
      },
      scales: {
        x: { grid: { color: pal.line }, ticks: { color: pal.ink } },
        y: { grid: { color: pal.line }, ticks: { color: pal.muted } },
      },
    },
  });

  const note = anyGreyPoint ? `Faded points: under ${MIN_BALLS_PER_YEAR} balls that year.` : null;
  return { excluded, note };
}
