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
 *
 * `style`: "bars" (default) or "dots" — a lollipop rendering (thin stem +
 * endpoint dot) toggled from the sidebar (Batch 3, decision 43). Same data,
 * same sort, same caps — purely how the value is drawn.
 */
export function buildBarChart(canvas, chartRef, { metric, rowsById, players, style = "bars" }) {
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
  // displayOrder is best-first (index 0 = best). Chart.js's horizontal bar
  // (indexAxis: "y") places category index 0 at the TOP of the plot — verified
  // live: the previous `.reverse()` here (based on the opposite assumption)
  // put the leader at the BOTTOM with values ascending going down, which is
  // the bug this batch fixes. No reversal needed: index 0 (best) at index 0
  // renders at the top, exactly where it belongs.
  const displayOrder = included;

  const pal = palette();
  const maxValue = included.length ? included[0].value : 0;
  const isDots = style === "dots";

  chartRef.current = new Chart(canvas, {
    type: "bar",
    data: {
      labels: displayOrder.map((r) => r.name),
      datasets: [
        {
          data: displayOrder.map((r) => r.value),
          backgroundColor: displayOrder.map((r) => (r.value === maxValue ? pal.accent : pal.ink)),
          borderRadius: isDots ? 2 : 3,
          maxBarThickness: isDots ? 4 : 28,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      // Cushion for the value label at the max bar's end (fix: clipped
      // "2,454"-style leader label at the chart's right edge) — the
      // afterDatasetsDraw plugin below also clamps the label inside the bar
      // if this padding still isn't enough at very narrow widths.
      layout: { padding: { right: 16, top: 4, bottom: 4 } },
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
          // Every player gets a label — at 375px width this used to autoSkip
          // roughly half of them (verified live).
          ticks: { color: pal.ink, autoSkip: false },
        },
      },
    },
    plugins: [
      {
        id: "barDecorations",
        afterDatasetsDraw(chart) {
          const { ctx, chartArea } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          ctx.font = "600 12px Inter, sans-serif";
          ctx.textBaseline = "middle";
          meta.data.forEach((bar, i) => {
            const val = displayOrder[i].value;
            const isLeader = val === maxValue;
            if (isDots) {
              ctx.fillStyle = isLeader ? pal.accent : pal.ink;
              ctx.beginPath();
              ctx.arc(bar.x, bar.y, 5, 0, Math.PI * 2);
              ctx.fill();
            }
            const text = labelForValue(metric, val);
            const textWidth = ctx.measureText(text).width;
            const gap = isDots ? 10 : 6;
            const outsideX = bar.x + gap;
            const fitsOutside = outsideX + textWidth + 4 <= chartArea.right;
            if (fitsOutside) {
              ctx.textAlign = "left";
              ctx.fillStyle = pal.ink;
              ctx.fillText(text, outsideX, bar.y);
            } else {
              // Not enough room outside the bar/dot (e.g. the leader's label
              // right at the chart edge) — draw it clamped inside instead.
              // A real bar has fill behind it so white reads better there; a
              // dot has none, so keep dark ink text next to it.
              ctx.textAlign = "right";
              ctx.fillStyle = isDots ? pal.ink : "#ffffff";
              ctx.fillText(text, bar.x - gap, bar.y);
            }
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
        // Median guide lines (X and Y), computed from the plotted players
        // only — drawn BEFORE the dataset's own points so the dashed lines
        // read as quadrant dividers behind the dots, not over them.
        id: "medianGuides",
        beforeDatasetsDraw(chart) {
          if (included.length === 0) return;
          const { ctx, chartArea, scales } = chart;
          const median = (values) => {
            const sorted = values.slice().sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
          };
          const medianX = median(included.map((r) => r.x));
          const medianY = median(included.map((r) => r.y));
          const px = scales.x.getPixelForValue(medianX);
          const py = scales.y.getPixelForValue(medianY);
          ctx.save();
          ctx.strokeStyle = pal.muted;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(px, chartArea.top);
          ctx.lineTo(px, chartArea.bottom);
          ctx.moveTo(chartArea.left, py);
          ctx.lineTo(chartArea.right, py);
          ctx.stroke();
          ctx.restore();
        },
      },
      {
        id: "scatterPointLabels",
        afterDatasetsDraw(chart) {
          const { ctx, chartArea } = chart;
          const meta = chart.getDatasetMeta(0);
          ctx.save();
          ctx.font = "11px Inter, sans-serif";
          ctx.fillStyle = pal.muted;
          ctx.textBaseline = "middle";
          meta.data.forEach((point, i) => {
            const shortName = shortenName(included[i].name);
            const textWidth = ctx.measureText(shortName).width;
            // Clamp vertically inside the plot area (textBaseline "middle"
            // would otherwise let the glyph bleed past the top/bottom edge
            // for points right on the boundary).
            const y = Math.min(Math.max(point.y, chartArea.top + 8), chartArea.bottom - 8);
            const fitsRight = point.x + 8 + textWidth <= chartArea.right;
            if (fitsRight) {
              ctx.textAlign = "left";
              ctx.fillText(shortName, point.x + 8, y);
            } else {
              // Fix: labels for points near the right edge (e.g. "R. Gaikwad",
              // verified live) clipped past the chart boundary. Flip the label
              // to the point's LEFT instead, clamped so it doesn't also run
              // past the left edge.
              ctx.textAlign = "right";
              const x = Math.max(point.x - 8, chartArea.left + textWidth);
              ctx.fillText(shortName, x, y);
            }
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
 * RADAR → SMALL MULTIPLES (owner ruling, decision 43): kept radar, removed
 * the overlay-of-datasets rendering. One mini-radar PER PLAYER (min 1, cap
 * 6) in a responsive grid, each labelled with the player's name underneath;
 * ONE shared honest footer (card.js's, untouched) and NO per-mini legends.
 *
 * All minis share ONE scale: the same per-metric min-max normalisation the
 * old overlay radar used (0.1-1.0, inverting lower-is-better metrics so
 * outward always means better) — computed ONCE across every CHARTED player,
 * exactly as before, just rendered as N single-dataset charts instead of one
 * multi-dataset chart. Tooltips still show the REAL (unscaled) values. A
 * player missing hasMetricData for ANY metric in the group is excluded from
 * the whole grid (visible note, same rule as before).
 *
 * The grid is built as a sibling of `canvas` inside the paper card's chart
 * area (canvas.parentElement — card.js's `.paper-card__chart-area`), so it's
 * captured by html2canvas along with the rest of the card on PNG
 * export/copy. `canvas` itself is hidden while the grid is showing;
 * chartRef.current is a small wrapper whose destroy() tears down every mini
 * Chart instance, removes the grid, and restores the canvas — so switching
 * to any other chart type (which always starts with the shared
 * destroyIfExists(chartRef)) cleans this up for free, no special-casing
 * needed elsewhere.
 */
export function buildRadarSmallMultiples(canvas, chartRef, { group, metrics, rowsById, players }) {
  destroyIfExists(chartRef);

  const chartArea = canvas.parentElement;
  canvas.hidden = true;

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

  // Per-metric min/max across ALL charted (included) players — shared by
  // every mini, so the same spoke means the same thing on every one of them.
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

  const grid = document.createElement("div");
  grid.className = "paper-card__radar-grid";
  grid.dataset.role = "radar-grid";
  chartArea.appendChild(grid);

  const instances = included.map((r) => {
    const cell = document.createElement("div");
    cell.className = "paper-card__radar-mini";

    const canvasWrap = document.createElement("div");
    canvasWrap.className = "paper-card__radar-mini-canvas-wrap";
    const miniCanvas = document.createElement("canvas");
    canvasWrap.appendChild(miniCanvas);
    cell.appendChild(canvasWrap);

    const nameEl = document.createElement("p");
    nameEl.className = "paper-card__radar-mini-name";
    nameEl.textContent = r.name; // textContent, not innerHTML — no escaping needed
    cell.appendChild(nameEl);

    grid.appendChild(cell);

    return new Chart(miniCanvas, {
      type: "radar",
      data: {
        labels: metrics.map((m) => m.shortLabel),
        datasets: [
          {
            data: metrics.map((m, mi) => scaledValue(m, ranges[mi], Number(r.row[m.key]))),
            borderColor: pal.accent,
            backgroundColor: pal.accent + "33",
            pointBackgroundColor: pal.accent,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }, // no per-mini legends — the name below IS the legend
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const metric = metrics[ctx.dataIndex];
                const raw = Number(r.row[metric.key]);
                return `${metric.label}: ${labelForValue(metric, raw)}`;
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
            pointLabels: { color: pal.ink, font: { size: 9 } },
          },
        },
      },
    });
  });

  chartRef.current = {
    destroy() {
      instances.forEach((c) => c.destroy());
      grid.remove();
      canvas.hidden = false;
    },
  };

  return { excluded, group };
}
