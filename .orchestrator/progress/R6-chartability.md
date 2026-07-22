# R6 #9 — Chartability UX (Graphs tab)

Status: COMPLETE + self-verified on localhost:8000. frontend/Opus. Branch polish-b1-mechanical.
Files touched: `src/graph/graph.js`, `styles.css` ONLY. table.js/filters.js/metrics.js/
timeseriesChart.js/charts.js/timeseries.js = 0 diff (Rule 1 safe — this is display/UX only;
chartability is derived from the SAME read-only fetch helpers the charts already run).

## Part A — CHARTABLE / NOT CHARTABLE badges in the roster dropdown
- Each roster row carries a right-side pill: green CHARTABLE / red NOT CHARTABLE / muted "…"
  while a probe is in flight.
- A verdict = "does this player have the data the CURRENT chart type needs?", per type:
  bar/benchmark = real value for the metric; scatter = both axes; radar = every axis;
  phases = ≥1 family member; slope/dumbbell = data in BOTH windows; **line = 2+ non-null
  buckets on the chosen X-axis** (a lone dot is not a line).
- Derived from the app's own fetches (fetchSelectedPlayerMetrics / fetchWindowMetric /
  fetchLineData) → same numbers the chart draws; NO new/duplicated aggregation.
- Computed only for the players that matter (checked roster ∪ the ≤50 rendered dropdown
  rows), cached per a chart-config signature (chartabilitySignature), async + debounced +
  token-guarded. Never the whole pool; keystroke filtering re-queries only genuinely-new
  visible rows. Repaint is in-place (paintBadges) — no list re-render, no focus/scroll churn.
- Recomputes on chart type / metric / X-axis / windows / scope change (hooked into markDirty
  + renderAndClearDirty, the two universal change signals). Signature null (no type / no
  metric / incomplete windows) → badges hide.

## Part B — don't draw an uninformative chart
- Gate in renderChart: draw iff ≥1 CHECKED player is chartable for the type; if 0 → show a
  plain-English message in the chart area instead of an empty/dots chart, title honest "0".
  - Line: gate changed from "≥1 player with any data" to "≥1 player with 2+ points" — this is
    the owner's all-dots screenshot fix (single-point players used to render as a field of
    dots). Message: "No selected player has enough data points to draw a line in this view.
    Try a wider date range, a different X-axis, or different players." When ≥1 qualifies the
    line draws and single-bucket players keep the existing one-dot + footnote handling.
  - bar/scatter/phases/radar: added the all-excluded gate (previously drew an empty axis box).
  - slope/dumbbell: already gated at drawn==0 (both-windows) — left as-is (threshold matches).
  - benchmark: left as-is (anchor-vs-field pool chart, not a roster-chartability case).

## Verification (localhost:8000, 1280x800)
- node --check OK on all touched .js. 0 console errors on Stats + Graphs.
- Anchors reproduce: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34.
- Part A independent DuckDB (COUNT(*) FILTER, not the app's SUM(CASE)): Bar + "Out Stumped %"
  → Karanbir & Virandeep stumped=0 → NOT CHARTABLE; Waseem=1 / SA Yadav=3 / Raza=2 →
  CHARTABLE. Badges matched exactly. Metric flip to Runs → all CHARTABLE (updates live).
- Part B: Line X=Date—year in a single-year scope (Jan–Dec 2024) → each player has exactly 1
  year bucket (engine-confirmed) → the message shows, NOT a dots chart. Widen to Jul 2023–Jul
  2026 → line draws (6 players; 3 single-bucket players show as dots + footnote). Line badges:
  JC Buttler (4 year-buckets) CHARTABLE, V Kohli (1 bucket) NOT CHARTABLE — DuckDB-confirmed.

## Concerns / notes
- Benchmark "chartable" = player has ≥1 of the selected benchmark metrics (the roster there
  only sources the anchor; the pool is the whole field). Somewhat arbitrary vs the other
  types — flagged.
- Badge probe is eager (fires on param change even if the roster panel is never opened) but
  bounded to ≤~56 ids and debounced; a param change with no genuine data change is a no-op.
