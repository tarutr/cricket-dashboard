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
 * @param {{from: number|null, to: number|null}} [params.scopeYears] the
 *   calendar-year span of the current filter scope's date window (graph.js
 *   derives it from state.dateFrom/dateTo). The x-axis is drawn across this
 *   full span (contiguously filled), so a Jul 2023–Jul 2026 scope always
 *   shows 2023·2024·2025·2026 — never collapsing to just the two years that
 *   happen to have data (the bug where a top-by-average roster of single-year
 *   players rendered lone dots crammed at the right edge on a 2-tick axis).
 * @returns {{excluded: string[], note: string|null}}
 */
export function buildTimeseriesChart(canvas, chartRef, { metric, rows, players, scopeYears }) {
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

  // Nobody has a qualifying year in range → draw nothing (graph.js shows an
  // honest placeholder), never an empty year-less plot (§7 — mirrors
  // buildSlopeChart / buildDumbbellChart).
  if (included.length === 0) {
    return { excluded, note: null };
  }

  // x axis: a CONTIGUOUS span of calendar years covering both the filter
  // scope's own date window (scopeYears — the meaningful, bounded range the
  // user actually asked for, e.g. 2023–2026) AND any year that has data,
  // then every year in between filled in. Filling contiguously (rather than
  // only listing years-with-data) does two things the old union-of-data-years
  // couldn't: it keeps single-year players from bunching at the right edge on
  // a 2-tick axis, and it gives a gap year its own slot so a break in a
  // player's line reads as "didn't play that year" at the right position. The
  // scope window already bounds the query's date filter, so this never
  // stretches back to 1877 the way the raw dataset range would.
  const dataYears = [];
  for (const p of included) for (const y of p.years.keys()) dataYears.push(Number(y));
  let minYear = dataYears.length ? Math.min(...dataYears) : null;
  let maxYear = dataYears.length ? Math.max(...dataYears) : null;
  const scopeFrom = scopeYears && Number.isInteger(scopeYears.from) ? scopeYears.from : null;
  const scopeTo = scopeYears && Number.isInteger(scopeYears.to) ? scopeYears.to : null;
  if (scopeFrom != null) minYear = minYear == null ? scopeFrom : Math.min(minYear, scopeFrom);
  if (scopeTo != null) maxYear = maxYear == null ? scopeTo : Math.max(maxYear, scopeTo);
  const years = [];
  if (minYear != null && maxYear != null) {
    for (let y = minYear; y <= maxYear; y++) years.push(y);
  }

  const pal = palette();
  let anyGreyPoint = false;
  let lonePointPlayers = 0;

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
      // (§8.1). The gap point stays null with radius 0 (no marker), so the
      // year is still honestly shown as blank for this player.
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
    // A player with exactly one real (non-null) year in range can't form a
    // line — draw that single point noticeably larger so it reads as a
    // deliberate datum (a "played one season here" marker) rather than a
    // stray dot, per the task brief. Counted for the honest footer note below.
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
      pointBackgroundColor: pointBg,
      pointBorderColor: pointBorder,
      pointBorderWidth: 2,
      pointRadius,
      pointHoverRadius: 7,
      borderWidth: 2,
      // spanGaps: true so a player with >=2 real year-points ALWAYS draws a
      // connecting line, even across a season they didn't play (the gap years
      // carry no marker, so the interpolation is visibly just a trend line
      // between measured points — the task's "a player with >=2 year-points
      // draws a line" requirement, which spanGaps:false could not guarantee
      // once gap years occupy their own axis slots).
      spanGaps: true,
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

  const notes = [];
  if (anyGreyPoint) notes.push(`Faded points: under ${MIN_BALLS_PER_YEAR} balls that year.`);
  if (lonePointPlayers > 0) {
    notes.push(
      `${lonePointPlayers} player${lonePointPlayers === 1 ? "" : "s"} with only one season in range ${
        lonePointPlayers === 1 ? "shows" : "show"
      } as a single point (no line).`
    );
  }
  const note = notes.length ? notes.join(" ") : null;
  return { excluded, note };
}
