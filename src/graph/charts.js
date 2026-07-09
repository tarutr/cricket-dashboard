// src/graph/charts.js
//
// Chart.js v4 builders for the Graph Builder (SPEC §6). Chart.js is loaded via
// a <script> tag in index.html (vendored UMD build) — this module uses the
// `Chart` global, never imports it as a module (per the vendoring brief).
//
// Data source: ONE grouped query on the selected players' ids
// (WHERE id IN (...) AND <current scope WHERE>), same GROUP BY pattern as
// table.js, but deliberately NO min-innings HAVING — selected players are
// explicit, so we never re-filter them out by sample size.
//
// §8.1 everywhere: a player failing hasMetricData() for a charted metric is
// excluded from that chart, with a visible "Excluded (no data): …" note.
// Ratios are never coalesced to 0 (NULL/0-for-rate-metrics stay excluded).

import { getMetric, hasMetricData } from "../metrics.js";
import { query } from "../db.js";
import { buildScopeClauses } from "../filters.js";
import { escSql as esc } from "../state.js";

const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };

/**
 * Query the metric values for exactly the selected player ids, honoring the
 * current scope WHERE (gender/format/date/team/team_type) but with NO
 * min-innings HAVING (selected players are explicit — SPEC §6). `metricKeys`
 * is a de-duplicated list of metric keys (batting or bowling discipline).
 * Returns a Map<id, {id, name, [metricKey]: value, ...}>.
 */
export async function fetchSelectedPlayerMetrics(state, playerIds, metricKeys) {
  if (playerIds.length === 0 || metricKeys.length === 0) return new Map();
  const discipline = state.discipline;
  const view = discipline;
  const idCol = ID_COL[discipline];
  const nameCol = NAME_COL[discipline];
  const teamCol = TEAM_COL[discipline];

  const uniqueKeys = [...new Set(metricKeys)];
  const metrics = uniqueKeys.map((k) => getMetric(k, discipline)).filter(Boolean);

  const selectParts = [`${idCol} AS id`, `${nameCol} AS name`];
  for (const m of metrics) {
    selectParts.push(`${m.sqlExpression} AS ${m.key}`);
    if (m.sortExpression) selectParts.push(`${m.sortExpression} AS ${m.key}__sort`);
  }

  // Opposition + batting-position filters (D4 Piece 3) apply here too — the
  // card's scope line describes them, so the charted numbers must honor them.
  const whereClauses = buildScopeClauses(state, {
    includeTeams: true,
    teamColumn: teamCol,
    oppositionColumn: discipline === "batting" ? "bowling_team" : "batting_team",
    includePositions: true,
  });
  whereClauses.push(`${idCol} IN (${playerIds.map((id) => `'${esc(id)}'`).join(", ")})`);

  const sql = [
    `SELECT ${selectParts.join(", ")}`,
    `FROM ${view}`,
    `WHERE ${whereClauses.join(" AND ")}`,
    `GROUP BY ${idCol}, ${nameCol}`,
  ].join("\n");

  const { rows } = await query(sql);
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

function formatMetricValue(metric, value) {
  if (!hasMetricData(metric, value)) return null;
  const n = Number(value);
  switch (metric.format) {
    case "int":
      return Math.round(n);
    case "dec1":
    case "dec2":
    case "pct1":
      return n;
    default:
      return n;
  }
}

function labelForValue(metric, value) {
  if (!hasMetricData(metric, value)) return "—";
  const n = Number(value);
  switch (metric.format) {
    case "int":
      return Math.round(n).toLocaleString();
    case "dec1":
      return n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    case "dec2":
      return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "pct1":
      return `${n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    default:
      return String(value);
  }
}

// Charts render INSIDE the paper card, which is a fixed light "printed
// artifact" regardless of the site theme (card.js). So chart colors are the
// fixed paper palette — never the live theme variables, which would produce
// light-on-light or dark-on-dark once the dark toggle ships.
function palette() {
  return {
    ink: "#1b2430",
    accent: "#9c2b2b",
    muted: "#6b6f76",
    line: "#ded7c8",
    panel: "#f2ede1",
    bg: "#ffffff",
  };
}

// A small qualitative series for multi-point charts (scatter/donut) that
// still reads fine against the editorial palette without inventing brand-new
// hex values outside styles.css's tokens where avoidable. These are the
// existing accent + a handful of desaturated variants derived from it purely
// for series differentiation — not new "metric vocabulary" (§8.2 is about
// metric definitions, not chart series colors).
const SERIES_COLORS = [
  "#9c2b2b", "#2f6b3f", "#3a5a9c", "#b8842f", "#6b4a9c",
  "#2f8a8a", "#9c2f6b", "#5a7a2f", "#2f4a9c", "#9c6b2f",
];

function destroyIfExists(chartRef) {
  if (chartRef.current) {
    chartRef.current.destroy();
    chartRef.current = null;
  }
}

/**
 * BAR: one metric, horizontal bars sorted by value (direction per
 * metric.higherIsBetter — lower-better sorts ascending so best is on top),
 * value labels at bar ends, ink bars with the accent for the top bar.
 * Players failing hasMetricData are excluded (visible note returned).
 */
export function buildBarChart(canvas, chartRef, { metric, rowsById, players }) {
  destroyIfExists(chartRef);

  const included = [];
  const excluded = [];
  for (const p of players) {
    const row = rowsById.get(p.id);
    const raw = row ? row[metric.key] : null;
    if (row && hasMetricData(metric, raw)) {
      included.push({ id: p.id, name: p.name, value: Number(raw) });
    } else {
      excluded.push(p.name);
    }
  }

  // Best-on-top: higherIsBetter true/null -> descending value; false -> ascending.
  const ascending = metric.higherIsBetter === false;
  included.sort((a, b) => (ascending ? a.value - b.value : b.value - a.value));
  // Chart.js horizontal bar renders category index 0 at the BOTTOM, so to show
  // the best performer at the TOP we reverse after sorting best-first.
  const displayOrder = included.slice().reverse();

  const pal = palette();
  const maxValue = included.length ? included[0].value : 0;

  chartRef.current = new Chart(canvas, {
    type: "bar",
    data: {
      labels: displayOrder.map((r) => r.name),
      datasets: [
        {
          data: displayOrder.map((r) => r.value),
          backgroundColor: displayOrder.map((r) => (r.value === maxValue ? pal.accent : pal.ink)),
          borderRadius: 3,
          maxBarThickness: 28,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${metric.label}: ${labelForValue(metric, ctx.raw)}`,
          },
        },
        datalabels: false,
      },
      scales: {
        x: {
          grid: { color: pal.line },
          ticks: { color: pal.muted },
          beginAtZero: true,
        },
        y: {
          grid: { display: false },
          ticks: { color: pal.ink },
        },
      },
    },
    plugins: [
      {
        id: "barValueLabels",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          ctx.fillStyle = pal.ink;
          ctx.font = "600 12px Inter, sans-serif";
          ctx.textBaseline = "middle";
          meta.data.forEach((bar, i) => {
            const val = displayOrder[i].value;
            const text = labelForValue(metric, val);
            ctx.textAlign = "left";
            ctx.fillText(text, bar.x + 6, bar.y);
          });
          ctx.restore();
        },
      },
    ],
  });

  return { excluded };
}

/**
 * DONUT: one metric restricted to additive totals (format === "int" &&
 * zeroIsData === true). Shows share-of-total; legend with values.
 */
export function buildDonutChart(canvas, chartRef, { metric, rowsById, players }) {
  destroyIfExists(chartRef);

  const included = [];
  const excluded = [];
  for (const p of players) {
    const row = rowsById.get(p.id);
    const raw = row ? row[metric.key] : null;
    if (row && hasMetricData(metric, raw) && Number(raw) > 0) {
      included.push({ id: p.id, name: p.name, value: Number(raw) });
    } else if (row && hasMetricData(metric, raw) && Number(raw) === 0) {
      // Zero is legitimate data for a raw total (§8.1) but contributes 0 share;
      // keep it in the legend rather than excluding, since it's real data.
      included.push({ id: p.id, name: p.name, value: 0 });
    } else {
      excluded.push(p.name);
    }
  }

  included.sort((a, b) => b.value - a.value);
  const total = included.reduce((sum, r) => sum + r.value, 0);
  const pal = palette();

  chartRef.current = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: included.map((r) => r.name),
      datasets: [
        {
          data: included.map((r) => r.value),
          backgroundColor: included.map((_, i) => SERIES_COLORS[i % SERIES_COLORS.length]),
          borderColor: pal.bg,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "58%",
      plugins: {
        legend: {
          position: "right",
          labels: {
            color: pal.ink,
            generateLabels(chart) {
              const data = chart.data;
              return data.labels.map((label, i) => {
                const value = data.datasets[0].data[i];
                const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
                return {
                  text: `${label} — ${labelForValue(metric, value)} (${pct}%)`,
                  fillStyle: data.datasets[0].backgroundColor[i],
                  strokeStyle: data.datasets[0].backgroundColor[i],
                  index: i,
                };
              });
            },
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const value = ctx.raw;
              const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
              return `${ctx.label}: ${labelForValue(metric, value)} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  return { excluded };
}

/**
 * SCATTER: two metric selects (X and Y). One point per player, player-name
 * tooltip + short labels. A player failing hasMetricData for EITHER metric is
 * excluded (visible note).
 */
export function buildScatterChart(canvas, chartRef, { metricX, metricY, rowsById, players }) {
  destroyIfExists(chartRef);

  const included = [];
  const excluded = [];
  for (const p of players) {
    const row = rowsById.get(p.id);
    const rawX = row ? row[metricX.key] : null;
    const rawY = row ? row[metricY.key] : null;
    if (row && hasMetricData(metricX, rawX) && hasMetricData(metricY, rawY)) {
      included.push({ id: p.id, name: p.name, x: Number(rawX), y: Number(rawY) });
    } else {
      excluded.push(p.name);
    }
  }

  const pal = palette();

  chartRef.current = new Chart(canvas, {
    type: "scatter",
    data: {
      datasets: [
        {
          data: included.map((r) => ({ x: r.x, y: r.y })),
          backgroundColor: pal.accent,
          borderColor: pal.accent,
          pointRadius: 6,
          pointHoverRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? included[items[0].dataIndex].name : ""),
            label: (ctx) => {
              const r = included[ctx.dataIndex];
              return [`${metricX.shortLabel}: ${labelForValue(metricX, r.x)}`, `${metricY.shortLabel}: ${labelForValue(metricY, r.y)}`];
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: metricX.label, color: pal.muted },
          grid: { color: pal.line },
          ticks: { color: pal.muted },
        },
        y: {
          title: { display: true, text: metricY.label, color: pal.muted },
          grid: { color: pal.line },
          ticks: { color: pal.muted },
        },
      },
    },
    plugins: [
      {
        id: "scatterPointLabels",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          ctx.font = "11px Inter, sans-serif";
          ctx.fillStyle = pal.muted;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          meta.data.forEach((point, i) => {
            const shortName = shortenName(included[i].name);
            ctx.fillText(shortName, point.x + 8, point.y);
          });
          ctx.restore();
        },
      },
    ],
  });

  return { excluded };
}

function shortenName(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name;
  const last = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map((p) => p[0] + ".").join("");
  return `${initials} ${last}`;
}

/**
 * RADAR: metric GROUP (from radarGroups.js), cap 6 players. Per-metric
 * min-max scaling across the CHARTED players -> 0.1-1.0, inverting
 * lower-is-better metrics so outward always means better. Tooltips show the
 * REAL (unscaled) values. A player missing hasMetricData for ANY metric in
 * the group is excluded from the whole radar (visible note).
 */
export function buildRadarChart(canvas, chartRef, { group, metrics, rowsById, players }) {
  destroyIfExists(chartRef);

  const included = [];
  const excluded = [];
  for (const p of players) {
    const row = rowsById.get(p.id);
    const ok = row && metrics.every((m) => hasMetricData(m, row[m.key]));
    if (ok) {
      included.push({ id: p.id, name: p.name, row });
    } else {
      excluded.push(p.name);
    }
  }

  // Per-metric min/max across the charted (included) players only.
  const ranges = metrics.map((m) => {
    const values = included.map((r) => Number(r.row[m.key]));
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 0;
    return { min, max };
  });

  function scaledValue(metric, range, rawValue) {
    const { min, max } = range;
    if (max === min) return 0.55; // flat metric across selection -> mid scale
    let t = (rawValue - min) / (max - min); // 0..1, higher raw = higher t
    if (metric.higherIsBetter === false) t = 1 - t; // invert so outward = better
    return 0.1 + t * 0.9; // 0.1 - 1.0
  }

  const pal = palette();

  chartRef.current = new Chart(canvas, {
    type: "radar",
    data: {
      labels: metrics.map((m) => m.shortLabel),
      datasets: included.map((r, i) => ({
        label: r.name,
        data: metrics.map((m, mi) => scaledValue(m, ranges[mi], Number(r.row[m.key]))),
        borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
        backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length] + "33",
        pointBackgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
        borderWidth: 2,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: pal.ink } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const metric = metrics[ctx.dataIndex];
              const r = included[ctx.datasetIndex];
              const raw = Number(r.row[metric.key]);
              return `${ctx.dataset.label} — ${metric.label}: ${labelForValue(metric, raw)}`;
            },
          },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 1,
          ticks: { display: false, stepSize: 0.2 },
          grid: { color: pal.line },
          angleLines: { color: pal.line },
          pointLabels: { color: pal.ink, font: { size: 12 } },
        },
      },
    },
  });

  return { excluded, group };
}
