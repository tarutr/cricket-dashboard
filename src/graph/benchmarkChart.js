// src/graph/benchmarkChart.js
//
// DOM renderer for the BENCHMARK chart (B8b, decision 44e). Built as plain
// DOM rows (divs), not a Chart.js canvas — the radar small-multiples chart
// (src/graph/charts.js's buildRadarSmallMultiples) already establishes that
// non-canvas content dropped into the paper card's `.paper-card__chart-area`
// (as a sibling of the hidden `<canvas>`) is captured fine by html2canvas on
// PNG export/copy, and follows the exact same lifecycle idiom: hide the
// canvas, append a DOM subtree, and hand back a `{ destroy() }` chartRef that
// tears the subtree down and restores the canvas — so switching to any other
// chart type (which always starts with charts.js's shared destroyIfExists())
// cleans this up for free.
//
// All data/ranking math lives in benchmark.js's computeBenchmarkRows() — this
// module only lays it out.

import { destroyIfExists, labelForValue } from "./charts.js";

// Visual track scale: the track represents 0%-130% of the anchor, so the
// 100% reference line sits at 100/130 ≈ 76.9% across the track — leaving
// headroom to the right for a bar that runs past 100% (anchor beaten) before
// visually capping. Bars are capped at 115% of the track's own 0-130% scale
// (i.e. 115/130 ≈ 88.5% of the track's pixel width); the real percentage is
// always stated in the row's text label even when the bar itself is capped.
const TRACK_MAX_PCT = 130;
const BAR_CAP_PCT = 115;
const REF_LEFT_PCT = (100 / TRACK_MAX_PCT) * 100;

function pctText(n) {
  return `${n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

/** One row's DOM, for a computeBenchmarkRows() descriptor. */
function buildRow(r, anchorName) {
  const row = document.createElement("div");
  row.className = "paper-card__benchmark-row";

  const label = document.createElement("span");
  label.className = "paper-card__benchmark-row__label";
  label.textContent = r.metric.label;
  row.appendChild(label);

  const main = document.createElement("div");
  main.className = "paper-card__benchmark-row__main";
  row.appendChild(main);

  const track = document.createElement("div");
  track.className = "paper-card__benchmark-track";
  main.appendChild(track);

  const meta = document.createElement("div");
  meta.className = "paper-card__benchmark-row__meta";
  row.appendChild(meta);

  const caption = document.createElement("span");
  caption.className = "paper-card__benchmark-caption";
  meta.appendChild(caption);

  const anchorValueEl = document.createElement("span");
  anchorValueEl.className = "paper-card__benchmark-anchor-value";
  meta.appendChild(anchorValueEl);

  const rankEl = document.createElement("span");
  rankEl.className = "paper-card__benchmark-anchor-rank";
  meta.appendChild(rankEl);

  if (r.noAnchorData) {
    row.classList.add("paper-card__benchmark-row--no-data");
    caption.textContent = `No data for ${anchorName}.`;
    anchorValueEl.textContent = "—";
    rankEl.textContent = "—";
    return row;
  }

  // Anchor value + rank (always shown, regardless of whether a bar could be drawn).
  anchorValueEl.textContent = labelForValue(r.metric, r.anchorValue);
  rankEl.textContent = `#${r.anchorRank}`;
  rankEl.title = `#${r.anchorRank} of ${r.poolSize} qualifying player${r.poolSize === 1 ? "" : "s"}`;

  if (!r.bestOther) {
    caption.textContent = "No qualifying comparison for this metric.";
    return row;
  }

  const bar = document.createElement("div");
  bar.className = "paper-card__benchmark-bar";
  track.appendChild(bar);

  if (r.ratioPct === null) {
    // Divide-by-zero guard case (see benchmark.js) — anchor has a genuine
    // zero and the best other has a positive value: always "beaten", shown
    // at the visual cap with raw values instead of a percentage.
    bar.classList.add("paper-card__benchmark-bar--beaten");
    bar.style.width = `${(BAR_CAP_PCT / TRACK_MAX_PCT) * 100}%`;
    caption.textContent = `#1 ${r.bestOther.name} · ${labelForValue(r.metric, r.bestOther.value)} vs ${anchorName}'s ${labelForValue(r.metric, r.anchorValue)}`;
  } else {
    const widthPct = (Math.min(r.ratioPct, BAR_CAP_PCT) / TRACK_MAX_PCT) * 100;
    bar.style.width = `${widthPct}%`;
    if (!r.anchorLeads) bar.classList.add("paper-card__benchmark-bar--beaten");
    const rankBadge = r.anchorLeads ? "#2" : "#1";
    const overflowNote = r.ratioPct > BAR_CAP_PCT ? " (off scale)" : "";
    caption.textContent = `${rankBadge} ${r.bestOther.name} · ${pctText(r.ratioPct)} of ${anchorName}${overflowNote}`;
  }

  return row;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{current: any}} chartRef
 * @param {object} params
 * @param {{id: string, name: string}} params.anchor
 * @param {Array<{kind: string, label: string, metrics: object[]}>} params.groups benchmark.js's groupMetricsByKind() output
 * @param {Array<object>} params.rows computeBenchmarkRows() output, SAME order/length as the flattened `groups` metrics
 * @returns {{excluded: string[], note: string|null}}
 */
export function buildBenchmarkChart(canvas, chartRef, { anchor, groups, rows }) {
  destroyIfExists(chartRef);

  const chartArea = canvas.parentElement;
  canvas.hidden = true;

  const rowsByMetricKey = new Map(rows.map((r) => [r.metric.key, r]));

  const root = document.createElement("div");
  root.className = "paper-card__benchmark";
  root.dataset.role = "benchmark-root";

  for (const group of groups) {
    const section = document.createElement("div");
    section.className = "paper-card__benchmark-section";

    const heading = document.createElement("h3");
    heading.className = "paper-card__benchmark-section-title";
    heading.textContent = group.label;
    section.appendChild(heading);

    for (const metric of group.metrics) {
      const r = rowsByMetricKey.get(metric.key);
      if (!r) continue;
      section.appendChild(buildRow(r, anchor.name));
    }
    root.appendChild(section);
  }

  const refCaption = document.createElement("p");
  refCaption.className = "paper-card__benchmark-refcaption";
  refCaption.textContent = `${anchor.name} = 100%`;
  root.appendChild(refCaption);

  // ONE continuous 100% reference line spanning every row's track (owner
  // fix: previously each row drew its own short segment via CSS percentage
  // positioning, which left visible gaps at every row/section boundary —
  // this reads as a single unbroken guide instead. Every track shares the
  // same label-width + track-flex structure (see the CSS rule this class
  // replaces), so the first track's rect is a valid stand-in for "the
  // track column" as a whole; height/position are measured from the
  // actual rendered rows (not assumed), spanning first-track-top to
  // last-track-bottom only — it does not reach into the trailing
  // "<Anchor> = 100%" footnote below.
  const anchorLine = document.createElement("div");
  anchorLine.className = "paper-card__benchmark-anchorline";
  anchorLine.hidden = true;
  root.appendChild(anchorLine);

  function positionAnchorLine() {
    const tracks = root.querySelectorAll(".paper-card__benchmark-track");
    if (!tracks.length) {
      anchorLine.hidden = true;
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const firstRect = tracks[0].getBoundingClientRect();
    const lastRect = tracks[tracks.length - 1].getBoundingClientRect();
    const top = firstRect.top - rootRect.top;
    const bottom = lastRect.bottom - rootRect.top;
    const left = firstRect.left - rootRect.left + firstRect.width * (REF_LEFT_PCT / 100);
    anchorLine.hidden = false;
    anchorLine.style.top = `${top}px`;
    anchorLine.style.height = `${Math.max(0, bottom - top)}px`;
    anchorLine.style.left = `${left}px`;
  }

  chartArea.appendChild(root);
  positionAnchorLine();
  // Row/track widths are fluid (flex-basis, not a fixed px), so a resize can
  // move the reference point — reposition rather than let it go stale.
  window.addEventListener("resize", positionAnchorLine);

  chartRef.current = {
    destroy() {
      window.removeEventListener("resize", positionAnchorLine);
      root.remove();
      canvas.hidden = false;
    },
  };

  const noDataFor = rows.filter((r) => r.noAnchorData).map((r) => r.metric.label);
  const note = noDataFor.length ? `No data for ${anchor.name} on: ${noDataFor.join(", ")}.` : null;
  return { excluded: [], note };
}
