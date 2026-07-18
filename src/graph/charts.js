// src/graph/charts.js
//
// Chart.js v4 builders for the Graph Builder (SPEC §6). Chart.js is loaded via
// a <script> tag in index.html (vendored UMD build) — this module uses the
// `Chart` global, never imports it as a module (per the vendoring brief).
//
// Data source: ONE grouped query on the selected players' ids
// (WHERE id IN (...) AND <current scope WHERE>), same GROUP BY pattern as
// table.js's buildQuery — which, since decision 44c removed the base
// min-innings gate there entirely, is itself gate-free now too. Selected
// players are explicit here regardless, so this was never about re-filtering
// them out by sample size; it's simply the same query shape either way.
//
// §8.1 everywhere: a player failing hasMetricData() for a charted metric is
// excluded from that chart, with a visible "Excluded (no data): …" note.
// Ratios are never coalesced to 0 (NULL/0-for-rate-metrics stay excluded).

import { getMetric, hasMetricData } from "../metrics.js";
import { query } from "../db.js";
import { buildScopeClauses } from "../filters.js";
import { buildQuery } from "../table.js";
import { escSql as esc, matchupVsActive } from "../state.js";

const ID_COL = { batting: "batter_id", bowling: "bowler_id" };
const NAME_COL = { batting: "batter_name", bowling: "bowler_name" };
const TEAM_COL = { batting: "batting_team", bowling: "bowling_team" };

/**
 * Query the metric values for exactly the selected player ids, honoring the
 * current scope WHERE (gender/format/date/team/team_type) — table.js's
 * buildQuery, which this shares no HAVING with either way (decision 44c
 * removed the min-innings gate there entirely), so selected players are never
 * re-filtered out by sample size (SPEC §6). `metricKeys`
 * is a de-duplicated list of metric keys (batting or bowling discipline).
 * Returns a Map<id, {id, name, [metricKey]: value, ...}>.
 */
export async function fetchSelectedPlayerMetrics(state, playerIds, metricKeys) {
  if (playerIds.length === 0 || metricKeys.length === 0) return new Map();

  // Wave B — matchup ("Vs") branch: when a Vs bucket is active, the charted
  // numbers must be IDENTICAL to what the Stats table shows for that bucket, so
  // route through the SAME builder the table uses instead of this module's
  // bespoke plain-view SELECT. buildQuery auto-dispatches to buildMatchupQuery
  // when matchupVsActive(state) (table.js), emitting `id`, `name`, the metric
  // key columns (+ `<key>__sort` where defined), plus the coverage/composition
  // columns it always carries — we read only the requested metric keys. Then
  // restrict to the selected roster via the exact "wrap the builder's SQL,
  // filter in an outer SELECT ... WHERE id IN (...)" idiom fetchWindowMetric()
  // and benchmark.js's fetchBenchmarkPool() already use. NO new SQL grammar,
  // and the PLAIN branch below is left byte-identical.
  if (matchupVsActive(state)) {
    const { sql } = buildQuery(state, metricKeys);
    const idsSql = playerIds.map((id) => `'${esc(id)}'`).join(", ");
    const outerSql = `SELECT * FROM (\n${sql}\n) matchup_q\nWHERE id IN (${idsSql})`;
    const { rows } = await query(outerSql);
    const byId = new Map();
    for (const row of rows) byId.set(row.id, row);
    return byId;
  }

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
  // includePositions only for batting: the striker-position filter is
  // matchup-only (positionsFilterActive), and this fetch always queries the
  // PLAIN view — plain bowling_innings has no batting_position column, so
  // emitting the clause there is a binder error (hit via the chooser in
  // matchup-bowling mode with a position filter). Plain batting keeps it: the
  // column exists and means the batter's own position.
  const whereClauses = buildScopeClauses(state, {
    includeTeams: true,
    teamColumn: teamCol,
    oppositionColumn: discipline === "batting" ? "bowling_team" : "batting_team",
    includePositions: discipline === "batting",
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

/**
 * SLOPE chart data (Batch 4 part 1, decision 43): one metric value per
 * selected player for ONE date window. Reuses table.js's buildQuery
 * UNCHANGED — the same gate-free query (decision 44c removed the base
 * min-innings HAVING from buildQuery entirely; today it emits a row for any
 * player with at least one qualifying row, same as any plain GROUP BY) that
 * players.js's seedFromFilteredSet already wraps for seeding — parameterised
 * by the window's own dateFrom/dateTo instead of the live filter scope's
 * (buildScopeClauses already reads dateFrom/dateTo off the state object it's
 * given, so overriding those two fields is an existing parameter slot, not a
 * new one), then restricted to exactly the already-selected roster ids via
 * the identical "wrap the builder's SQL, filter in an outer SELECT" idiom
 * seedFromFilteredSet already uses for its ORDER BY/LIMIT wrapper.
 *
 * This is why a player can be genuinely ABSENT from a window's result map:
 * buildQuery's GROUP BY only emits a row for a player with at least one
 * qualifying row in that window's own date-filtered scope, independently per
 * window — a player with zero such rows (e.g. they didn't play at all during
 * Window A) simply has no row to emit there. That's the honest reason a
 * player can be present for one window and absent for the other; it's row
 * existence, not a sample-size threshold (there is no threshold to apply
 * since decision 44c). No new SQL shape is introduced: buildQuery itself is
 * untouched, only its two existing date parameters are overridden, and the
 * outer id-restriction wrapper mirrors an idiom that already exists in this
 * codebase (players.js).
 */
export async function fetchWindowMetric(state, window, playerIds, metric) {
  if (playerIds.length === 0) return new Map();
  const windowState = { ...state, dateFrom: window.from, dateTo: window.to };
  const { sql } = buildQuery(windowState, [metric.key]);
  const idsSql = playerIds.map((id) => `'${esc(id)}'`).join(", ");
  const outerSql = `SELECT * FROM (\n${sql}\n) window_q\nWHERE id IN (${idsSql})`;
  const { rows } = await query(outerSql);
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

export function labelForValue(metric, value) {
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

/**
 * The numeric value a chart PLOTS for one metric row — the ONE place a row is
 * turned into a bar height / axis coordinate / percentile input (Wave B3).
 *
 * For every normal numeric metric this is exactly `Number(row[key])` — the same
 * read the chart builders did inline before B3, so their numbers stay
 * byte-identical. The one exception is a str-format PEAK (Best Bowling, whose
 * display value `row[key]` is the compound "W-R" string, e.g. "2-9"): Number()
 * of that is NaN, so we fall back to the metric's NUMERIC peak rank in the
 * row's `<key>__sort` shadow column (wickets*1000 − runs, emitted by
 * buildQuery/buildMatchupQuery for any metric with a sortExpression). So Best
 * Bowling plots by RANK height (more wickets first, fewer runs breaking ties).
 *
 * The DISPLAY LABEL is never taken from this — callers label bars/points/
 * tooltips with `row[key]` via labelForValue, so a Best Bowling bar is drawn at
 * its rank height but LABELLED "2-9". Callers guard with hasMetricData(row[key])
 * before calling this, so `row[key]` is always real data here; if a str peak's
 * `__sort` column is somehow absent the fallback is NaN (never a throw).
 */
function chartValue(metric, row) {
  const v = Number(row[metric.key]);
  return Number.isFinite(v) ? v : Number(row[metric.key + "__sort"]);
}

// Charts render INSIDE the paper card, which is a fixed light "printed
// artifact" regardless of the site theme (card.js). So chart colors are the
// fixed paper palette — never the live theme variables, which would produce
// light-on-light or dark-on-dark once the dark toggle ships.
// Exported (Batch 4 wave 2): the two new chart types (By year, Dumbbell) live
// in their own files — src/graph/timeseriesChart.js / dumbbellChart.js — to
// keep this already-large file from growing further (SPEC §8.3's ~600-line
// guidance), but they still draw from the ONE fixed paper palette/series
// colors/value-formatter this file already owns, rather than redefining them.
export function palette() {
  return {
    ink: "#1b2430",
    accent: "#9c2b2b",
    // Matches --color-good's LIGHT-theme value (styles.css) — the paper card
    // is a fixed-light artifact regardless of site theme (see file header),
    // so this is the fixed hex equivalent of that token, not a live CSS var.
    // Used by the slope chart for "rose" lines (Batch 4 part 1, decision 43).
    good: "#2f6b3f",
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
export const SERIES_COLORS = [
  "#9c2b2b", "#2f6b3f", "#3a5a9c", "#b8842f", "#6b4a9c",
  "#2f8a8a", "#9c2f6b", "#5a7a2f", "#2f4a9c", "#9c6b2f",
];

export function destroyIfExists(chartRef) {
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
      // `value` is what the bar is drawn/sorted by (numeric — the peak RANK for
      // a str metric like Best Bowling, see chartValue); `raw` is the display
      // figure the label shows ("2-9" / the number itself), never Number()'d.
      included.push({ id: p.id, name: p.name, value: chartValue(metric, row), raw });
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
            // Label from the DISPLAY figure (displayOrder[i].raw), not the
            // plotted value — identical for numeric metrics, but shows "2-9"
            // (not the rank) for a str peak like Best Bowling.
            label: (ctx) => `${metric.label}: ${labelForValue(metric, displayOrder[ctx.dataIndex].raw)}`,
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
            const text = labelForValue(metric, displayOrder[i].raw);
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
 * DONUT: one metric restricted to additive totals. Shows share-of-total;
 * legend with values.
 *
 * RETAINED FOR LATER (owner decision, polish phase): the Donut chart type was
 * removed from the Graph Builder (src/graph/graph.js no longer imports or calls
 * this renderer), but this builder is kept ON FILE intact for a future reuse —
 * the player-popup donut. It draws purely from this file's own shared helpers
 * (palette / SERIES_COLORS / labelForValue / destroyIfExists / hasMetricData),
 * so it has no Graph-Builder-specific dependency and is ready to call as-is.
 * (Additive-total gating previously lived in graph.js's donutEligibleMetrics,
 * which was removed with the chart type; any future caller must re-supply an
 * additive metric — summing non-additive metrics is meaningless, see below.)
 *
 * Batch 8 (task 3, decision 44f): CHART_CAPS.donut.max widened 10 -> 20 (up to
 * 20 CHECKED players can now be compared at once — players.js), but a donut
 * with 20 slices is unreadable, so this always plots the TOP 7 checked
 * players by value plus ONE aggregated "Other (N players)" slice summing the
 * rest of the checked set — v1's own top-7/Other convention (see this file's
 * history/v1_reference/graph.html's DONUT_METRIC_OK section). Slices are
 * therefore always <= 8 regardless of how many are checked. "Other" is only
 * ever built from ADDITIVE metrics (donutEligibleMetrics already restricts
 * the metric picker to `additive === true`), so summing the rest is a
 * meaningful total, never a misleading average-of-averages.
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

  // Top 7 individually named; the rest (if any) collapse into one "Other"
  // slice. `included` (not the raw checked count) is what determines whether
  // there's an "Other" bucket at all — a player excluded for no data was
  // never a candidate for either bucket.
  const TOP_N = 7;
  const topSlices = included.slice(0, TOP_N);
  const rest = included.slice(TOP_N);
  const otherCount = rest.length;
  const otherValue = rest.reduce((sum, r) => sum + r.value, 0);
  const slices = otherCount > 0 ? [...topSlices, { id: "__other__", name: `Other (${otherCount} players)`, value: otherValue, isOther: true }] : topSlices;

  // The honest total is every CHECKED-and-included player's value (top 7 +
  // Other together), so percentages always reflect the whole checked set —
  // never just the 7 individually-named slices.
  const total = included.reduce((sum, r) => sum + r.value, 0);
  const pal = palette();

  chartRef.current = new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: slices.map((r) => r.name),
      datasets: [
        {
          data: slices.map((r) => r.value),
          backgroundColor: slices.map((s, i) => (s.isOther ? pal.muted : SERIES_COLORS[i % SERIES_COLORS.length])),
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
      // x/y are the plotted coordinates (numeric — peak RANK for a str metric,
      // see chartValue); rawX/rawY are the display figures the tooltip shows.
      included.push({ id: p.id, name: p.name, x: chartValue(metricX, row), y: chartValue(metricY, row), rawX, rawY });
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
              // Display figures (rawX/rawY), not the plotted coordinates —
              // identical for numeric metrics, "2-9" for a str peak.
              return [`${metricX.shortLabel}: ${labelForValue(metricX, r.rawX)}`, `${metricY.shortLabel}: ${labelForValue(metricY, r.rawY)}`];
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
 * PHASES: grouped bars, one metric FAMILY (2–3 related metrics — e.g. T20
 * powerplay/middle/death strike rate) shown side by side per player, players
 * along the x axis (Batch 4 part 1, decision 43). `metrics` is the family's
 * member metrics IN CHRONOLOGICAL ORDER (graph.js resolves the family's keys
 * via getMetric() before calling this); `family.members[i].phaseLabel` is the
 * short axis/legend name for `metrics[i]`.
 *
 * §8.1 semantics, applied per player: a player missing hasMetricData for SOME
 * (not all) family members is still charted, with that specific phase's bar
 * simply absent (Chart.js draws nothing for a `null` data point) — the value
 * genuinely doesn't exist for that phase, same as any other honest gap. A
 * player missing hasMetricData for EVERY family member has no phase data at
 * all and is dropped from the chart entirely (`excluded`), with a "N of M"
 * summary note the caller can show alongside the standard exclusion list.
 */
export function buildPhasesChart(canvas, chartRef, { family, metrics, rowsById, players }) {
  destroyIfExists(chartRef);

  const included = [];
  const excluded = [];
  for (const p of players) {
    const row = rowsById.get(p.id);
    const hasAny = row && metrics.some((m) => hasMetricData(m, row[m.key]));
    if (hasAny) {
      included.push({ id: p.id, name: p.name, row });
    } else {
      excluded.push(p.name);
    }
  }

  const pal = palette();
  // Editorial 3-series palette (judgment call, Batch 4 part 1): the first
  // three SERIES_COLORS entries — accent red, green, blue — read cleanly as
  // distinct phases against the paper card's cream/ink palette without
  // inventing new hex values; the same array the donut/radar charts already
  // draw from. Bowling's 2-phase family just uses the first two.
  const colors = SERIES_COLORS.slice(0, metrics.length);

  chartRef.current = new Chart(canvas, {
    type: "bar",
    data: {
      labels: included.map((r) => r.name),
      datasets: metrics.map((m, i) => ({
        label: family.members[i]?.phaseLabel ?? m.shortLabel,
        data: included.map((r) => (hasMetricData(m, r.row[m.key]) ? Number(r.row[m.key]) : null)),
        backgroundColor: colors[i % colors.length],
        borderRadius: 3,
        maxBarThickness: 26,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top", labels: { color: pal.ink, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const m = metrics[ctx.datasetIndex];
              const phaseLabel = family.members[ctx.datasetIndex]?.phaseLabel ?? m.label;
              return `${phaseLabel}: ${labelForValue(m, ctx.raw)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: pal.ink, autoSkip: false },
        },
        y: {
          grid: { color: pal.line },
          ticks: { color: pal.muted },
          beginAtZero: true,
        },
      },
    },
  });

  const note =
    included.length < players.length
      ? `${included.length} of ${players.length} selected players have phase data.`
      : null;

  return { excluded, note };
}

/**
 * SLOPE ("then vs now"): one metric, two explicit date windows (Batch 4 part
 * 1, decision 43). `rowsA`/`rowsB` are the Maps fetchWindowMetric() returned
 * for Window A / Window B respectively — each already independently
 * evaluated over that window's own date-filtered rows (see that function's
 * doc comment; there is no min-innings gate to apply per window any more,
 * decision 44c — a player is present iff they have at least one qualifying
 * row in that window). A player present in both maps with real data (§8.1)
 * gets one line from their Window A value to their Window B value; a player
 * missing from either window (no qualifying rows there at all, or NULL/0 for
 * a rate metric there) is dropped from the chart entirely — never partially
 * drawn — with a "N of M selected players have innings in both windows" note
 * the caller shows alongside the standard exclusion list.
 *
 * Line color means IMPROVEMENT, not raw direction (orchestrator ruling over
 * the earlier raw-movement draft): green/red universally read as good/bad, so
 * a bowler whose economy CLIMBS must read red even though the number "rose".
 * metrics.js's higherIsBetter says which way improvement points; for the
 * metrics where it's null (no better/worse exists) raw movement is used, which
 * is then genuinely judgment-free. Flat lines are muted either way.
 */
export function buildSlopeChart(canvas, chartRef, { metric, labelA, labelB, rowsA, rowsB, players }) {
  destroyIfExists(chartRef);

  const included = [];
  const excluded = [];
  for (const p of players) {
    const rowA = rowsA.get(p.id);
    const rowB = rowsB.get(p.id);
    const rawA = rowA ? rowA[metric.key] : null;
    const rawB = rowB ? rowB[metric.key] : null;
    if (rowA && rowB && hasMetricData(metric, rawA) && hasMetricData(metric, rawB)) {
      included.push({ id: p.id, name: p.name, a: Number(rawA), b: Number(rawB) });
    } else {
      excluded.push(p.name);
    }
  }

  // When NO selected player has data in BOTH windows (e.g. a roster of
  // small-sample players who each only appear in one half of the range —
  // exactly what a "top by a rate metric" seed surfaces now that the base
  // min-innings gate is gone, decision 44c), there is nothing to plot. Draw
  // no chart at all rather than an empty 0–1 axis box that reads as broken;
  // graph.js sees the all-excluded result and shows an honest placeholder.
  if (included.length === 0) {
    const note = `${included.length} of ${players.length} selected players have innings in both windows.`;
    return { excluded, note };
  }

  const pal = palette();

  // Owner point 11: the "Name (value)" endpoint labels now sit OUTSIDE the plot
  // (left margin for Window A, right margin for Window B) instead of inside it,
  // where they collided with the lines. Reserve exactly enough horizontal
  // padding for the widest label on each side so the plot never overlaps them
  // (measured here, before the chart exists, with the card's own label font;
  // the drawing plugin re-sets ctx.font, so this measure is self-contained).
  // Capped so a very long name can't starve the plot of width on narrow cards.
  const LABEL_FONT = "600 11px Inter, sans-serif";
  const measureCtx = canvas.getContext("2d");
  measureCtx.save();
  measureCtx.font = LABEL_FONT;
  const labelWidth = (name, value) => measureCtx.measureText(`${shortenName(name)} (${labelForValue(metric, value)})`).width;
  const maxAWidth = included.reduce((w, r) => Math.max(w, labelWidth(r.name, r.a)), 0);
  const maxBWidth = included.reduce((w, r) => Math.max(w, labelWidth(r.name, r.b)), 0);
  measureCtx.restore();
  const LABEL_GAP = 10; // gap between plot edge and the label column
  const padLeft = Math.min(Math.ceil(maxAWidth) + LABEL_GAP + 4, 220);
  const padRight = Math.min(Math.ceil(maxBWidth) + LABEL_GAP + 4, 220);

  chartRef.current = new Chart(canvas, {
    type: "line",
    data: {
      labels: [labelA, labelB],
      datasets: included.map((r) => {
        const rose = r.b > r.a;
        const fell = r.b < r.a;
        const improved = metric.higherIsBetter === false ? fell : rose;
        const worsened = metric.higherIsBetter === false ? rose : fell;
        const color = improved ? pal.good : worsened ? pal.accent : pal.muted;
        return {
          label: r.name,
          data: [r.a, r.b],
          borderColor: color,
          backgroundColor: color,
          pointBackgroundColor: color,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2,
          tension: 0,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Reserve a left margin for Window A's labels and a right margin for
      // Window B's — sized to the widest label on each side (owner point 11) so
      // the endpoint labels draw entirely OUTSIDE the plot area, never over the
      // lines.
      layout: { padding: { left: padLeft, right: padRight, top: 12, bottom: 12 } },
      plugins: {
        legend: { display: false }, // player identity comes from the endpoint name label, not a legend
        tooltip: {
          callbacks: {
            title: (items) => (items.length ? included[items[0].datasetIndex].name : ""),
            label: (ctx) => `${ctx.label}: ${labelForValue(metric, ctx.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: pal.line },
          ticks: { color: pal.ink, font: { weight: "600" } },
        },
        y: {
          grid: { color: pal.line },
          // Owner point 11: the numeric y-axis ticks are hidden — each endpoint
          // label now carries its own exact value, so the axis numbers were
          // redundant AND sat in the very left margin the Window A labels now
          // occupy (they would have collided). Gridlines stay for magnitude.
          ticks: { display: false },
        },
      },
    },
    plugins: [
      {
        // Endpoint labels (owner point 11): each endpoint carries ONE combined
        // "Name (value)" label — Window A's reads its Window A value, Window
        // B's its Window B value — so a player's identity travels with both
        // ends of their own line (no legend needed).
        //
        // These labels now draw entirely OUTSIDE the plot: Window A's in the
        // reserved LEFT margin (right-aligned, ending just left of the axis),
        // Window B's in the reserved RIGHT margin (left-aligned, starting just
        // right of the plot). The layout padding above reserves exactly the
        // width each column needs, so a label can never overlap the lines it
        // labels — the previous design anchored them just inside each endpoint,
        // which collided with the plotted lines/points.
        //
        // The two columns are still decluttered independently (they're
        // visually separate): sort top to bottom by desired pixel y, push any
        // label closer than MIN_GAP to its predecessor further down, then (if
        // that ran the column past the bottom edge) walk back up from the last
        // label enforcing the same minimum gap — keeping each column inside the
        // vertical plot bounds rather than letting it slide off.
        id: "slopeEndLabels",
        afterDatasetsDraw(chart) {
          const { ctx, chartArea } = chart;

          const rows = [];
          chart.data.datasets.forEach((ds, i) => {
            const meta = chart.getDatasetMeta(i);
            const r = included[i];
            const pointA = meta.data[0];
            const pointB = meta.data[1];
            if (pointA && pointB && r) rows.push({ r, pointA, pointB });
          });
          if (rows.length === 0) return;

          const MIN_GAP = 12; // px between adjacent label rows in one column

          function declutter(items) {
            const sorted = items.slice().sort((a, b) => a.y - b.y);
            for (const it of sorted) {
              it.y = Math.min(Math.max(it.y, chartArea.top + 8), chartArea.bottom - 8);
            }
            for (let i = 1; i < sorted.length; i++) {
              if (sorted[i].y < sorted[i - 1].y + MIN_GAP) sorted[i].y = sorted[i - 1].y + MIN_GAP;
            }
            if (sorted.length && sorted[sorted.length - 1].y > chartArea.bottom - 8) {
              sorted[sorted.length - 1].y = chartArea.bottom - 8;
              for (let i = sorted.length - 2; i >= 0; i--) {
                if (sorted[i].y > sorted[i + 1].y - MIN_GAP) sorted[i].y = sorted[i + 1].y - MIN_GAP;
              }
            }
            return sorted;
          }

          ctx.save();
          ctx.textBaseline = "middle";
          ctx.font = "600 11px Inter, sans-serif";
          ctx.fillStyle = pal.ink;

          // Window A: "Name (value)" right-aligned in the LEFT margin, ending
          // just left of the plot's left edge (never inside the plot).
          const aItems = declutter(rows.map((row) => ({ row, y: row.pointA.y })));
          ctx.textAlign = "right";
          const aEdge = chartArea.left - LABEL_GAP;
          for (const { row, y } of aItems) {
            const text = `${shortenName(row.r.name)} (${labelForValue(metric, row.r.a)})`;
            ctx.fillText(text, aEdge, y);
          }

          // Window B: "Name (value)" left-aligned in the RIGHT margin, starting
          // just right of the plot's right edge (never inside the plot).
          const bItems = declutter(rows.map((row) => ({ row, y: row.pointB.y })));
          ctx.textAlign = "left";
          const bEdge = chartArea.right + LABEL_GAP;
          for (const { row, y } of bItems) {
            const text = `${shortenName(row.r.name)} (${labelForValue(metric, row.r.b)})`;
            ctx.fillText(text, bEdge, y);
          }

          ctx.restore();
        },
      },
    ],
  });

  const note =
    included.length < players.length
      ? `${included.length} of ${players.length} selected players have innings in both windows.`
      : null;

  return { excluded, note };
}

/**
 * RADAR → SMALL MULTIPLES (owner ruling, decision 43): kept radar, removed
 * the overlay-of-datasets rendering. One mini-radar PER PLAYER (min 1, cap
 * 6) in a responsive grid, each labelled with the player's name underneath;
 * ONE shared honest footer (card.js's, untouched) and NO per-mini legends.
 *
 * All minis share ONE scale: each axis is a PERCENTILE RANK (0-100) over the
 * CANDIDATE SET (R6, owner fix 1 — `poolRows`, benchmark.js's
 * fetchBenchmarkPool result, now restricted to the candidate ids: the "N" in
 * the roster's "X of N selected"), inverting lower-is-better metrics so outward
 * always means better. So the same spoke means the same thing on every mini,
 * and it's a rank against the players the user is actually comparing (those N),
 * not a normalise within the <=6 plotted and not the whole scope. Tooltips
 * still show the REAL value plus its percentile. A player missing hasMetricData
 * for ANY of the selected metrics is excluded from the whole grid (visible
 * note, same rule as before); their raw values are read from the SAME pool
 * (every candidate is in it), so no second per-player query runs.
 *
 * R4 Wave 1b (item 3): `metrics` is now the user's individually-checked radar
 * metric set (up to 10), not a fixed group's members — this renderer never
 * cared where the array came from, so only the removed `group` passthrough
 * changed here.
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
export function buildRadarSmallMultiples(canvas, chartRef, { metrics, players, poolRows }) {
  destroyIfExists(chartRef);

  const chartArea = canvas.parentElement;
  canvas.hidden = true;

  // R6 (owner fix 1): each axis is a PERCENTILE RANK over the CANDIDATE SET
  // (`poolRows` = benchmark.js's fetchBenchmarkPool result, restricted to the
  // candidate ids — one row per candidate, checked ones included), NOT a
  // min/max normalise within the <=6 plotted players and NOT the whole scope.
  // So "80 on the Strike Rate axis" means "faster than 80% of the selected
  // players", the same reading on every mini.
  //
  // Per-metric distribution: every pool value that passes §8.1 hasMetricData
  // (a NULL/0 rate is genuine no-data, excluded from the ranking population),
  // sorted ascending. Direction is honoured — for a lower-is-better metric a
  // SMALLER raw value is the better percentile — so outward always = better.
  poolRows = poolRows || [];
  const distributions = metrics.map((m) =>
    poolRows
      // chartValue: the numeric ranking input — identical to Number(r[m.key])
      // for a normal metric, the peak RANK for a str peak (Best Bowling).
      .map((r) => chartValue(m, r))
      .filter((v, i) => hasMetricData(m, poolRows[i][m.key]))
      .sort((a, b) => a - b)
  );
  const poolCount = poolRows.length;

  /** Percentile (0-100) of `rawValue` for metric index `mi` within the full
   * pool distribution. 100 = best in the field; scales so outward = better
   * regardless of the metric's direction. Returns null if the pool has no
   * data for this metric (defensive — the caller only plots players who pass
   * hasMetricData for every axis, and such a player is themselves in the
   * pool, so the distribution is non-empty in practice). */
  function percentileFor(mi, rawValue) {
    const dist = distributions[mi];
    const n = dist.length;
    if (!n) return null;
    let atOrBetter;
    if (metrics[mi].higherIsBetter === false) {
      // lower is better: count pool values >= rawValue (rawValue is among the best)
      atOrBetter = dist.filter((v) => v >= rawValue).length;
    } else {
      // higher is better: count pool values <= rawValue
      atOrBetter = dist.filter((v) => v <= rawValue).length;
    }
    return (atOrBetter / n) * 100;
  }

  // Plotted players' own raw values come from the SAME pool (every in-scope
  // player is in it) — no separate per-player query. A player missing
  // hasMetricData for ANY selected axis is excluded from the whole grid.
  const poolById = new Map(poolRows.map((r) => [r.id, r]));
  const included = [];
  const excluded = [];
  for (const p of players) {
    const row = poolById.get(p.id);
    const ok = row && metrics.every((m) => hasMetricData(m, row[m.key]));
    if (ok) {
      included.push({ id: p.id, name: p.name, row });
    } else {
      excluded.push(p.name);
    }
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
            data: metrics.map((m, mi) => percentileFor(mi, chartValue(m, r.row)) ?? 0),
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
              // Tooltip shows the REAL value plus the percentile it maps to,
              // so the reader sees both "SR 142.0" and "89th pct of the field".
              label: (ctx) => {
                const metric = metrics[ctx.dataIndex];
                // Numeric value drives the percentile; the DISPLAY figure
                // (row[key]) is what the label shows — they differ only for a
                // str peak (Best Bowling: rank vs "2-9").
                const numericVal = chartValue(metric, r.row);
                const pct = percentileFor(ctx.dataIndex, numericVal);
                const pctText = pct == null ? "" : ` — ${Math.round(pct)}th pct`;
                return `${metric.label}: ${labelForValue(metric, r.row[metric.key])}${pctText}`;
              },
            },
          },
        },
        scales: {
          r: {
            // Percentile scale, 0-100 (item 4). No sample floor — a player at
            // the pool minimum simply sits near the centre.
            min: 0,
            max: 100,
            ticks: { display: false, stepSize: 20 },
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

  // Honest note (R6, owner fix 1 & 3): axes are percentiles vs the CANDIDATE
  // SET — the players in the current selection (the "N" the roster is working
  // with), not the plotted handful and not the whole gender/format/date scope.
  // Say so, and say how big that pool actually is.
  const note = poolCount > 0 ? `Axes show percentile rank against the ${poolCount} players in the current selection.` : null;

  return { excluded, note };
}
