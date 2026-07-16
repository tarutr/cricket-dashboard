# Design phase plan — dashboard UX changes (7 owner items)

Branch: `polish-b1-mechanical` (main untouched). NOT the cleanup — these are
intentional behaviour/UI changes. Cricket numbers stay correct (anchors: batting
2,813 / SA Yadav 60/1,544/29.13/150.34 must hold; donut/slope/dumbbell must draw the
same values once inputs are given). Orchestrated per /opus-orchestrator.

## The 7 items → grounded scope (from the code map)

1. **Stats table height** — `styles.css:1074` `.table-scroll { max-height: 65vh }`. Lower it so header+toolbar+pills+table+footer fit one viewport; table scrolls internally. CSS-only. Keep `overflow:auto` (horizontal scroll of wide columns must survive).
2. **Header + graph left panel** — (a) `.app-header` (`styles.css:144-182`, `index.html:68-108`): shrink padding (`--space-5/6`) + title (2.25rem) to a slim strip. (b) `.graph-builder__controls` (`styles.css:2039-2054`): add `max-height`+`overflow-y:auto` so it scrolls internally like the table. Do BOTH (owner: "or both"). CSS (+ maybe index.html).
3. **Graph Players controls** — remove the "Show" label (`graph.js:395`); fix the 4-button roster toggle clipping (`styles.css:2210` — add `min-width:0` + smaller font/wrap, mirror the chart-type tiles at 2107-2117); rename "Top names"→"Top Names" (`graph.js:397` button + `graph.js:1598` `rosterModeLabel`). graph.js markup + styles.css.
4. **Slope/dumbbell windows** — (a) REMOVE auto-fill: skip the 3 `ensureSlope/DumbbellWindowDefaults()` calls (`graph.js:1284, 1365, 2761`). Windows stay `null`; the existing `windowsReady` gate (`graph.js:2619, 2762`) already shows "Pick both date windows to draw this chart." → free empty-state. (b) Fix date-box text clipping (`styles.css:2149`) — stack the two date inputs, shrink icon/font, enlarge boxes. graph.js (tiny) + styles.css.
5. **Donut team filter** — NEW donut-only control. Add `let donutTeamId = null` (per-type var, isolation pattern lines 505-546); render a team `<select>` in the donut branch of `renderMetricControls` (`graph.js:1115-1133`) whose options are teams present in the **already-filtered player set**; in `renderChart`'s donut branch (`graph.js:2981-2998`) replace the `state.teams.length !== 1` message-gate with `donutTeamId` validation + filter the roster to that team before drawing. Must NOT touch shared `state.teams`. graph.js (+ CSS for the select). NUMBER-ADJACENT (changes which players the donut shows) → verify donut values.
6. **"Needs input" red outline** — when a required control is empty (slope/dumbbell windows, donut team), red-outline that control. Logic in graph.js (toggle a class on the empty control when `renderChart` hits its guard), class in styles.css.
7. **"Update chart" button** — gate the in-panel controls so tweaks DON'T auto-draw. Add a button at the bottom of `.graph-builder__controls`; make the 18 `scheduleRender()` triggers (map in exploration) + `onScopeChanged` tail set a "dirty" flag instead of drawing; only the button calls `renderChart()`. Keep control-UI updates live (`syncChartTypeButtons`/`renderMetricControls`/`renderPlayerList`). Precedent: the graph's own "Apply to graph" filter gate (`graph.js:2100-2133`). graph.js (cross-cutting) + tiny CSS. HIGHEST RISK.

## Wave structure (sequential gates; parallel within a wave on DISJOINT files)

graph.js is touched by items 3,4,5,6,7 → it can only be edited by ONE agent at a time,
so graph.js work is serialized across waves. styles.css likewise one owner per wave.

**Wave 1 — Layout & cosmetics (low risk, high visible value).** Items 1, 2, 3, 4b.
- 1A design-stylist **Sonnet/high** — styles.css + index.html: table height (1), slim header (2a), graph panel internal scroll (2b), roster-toggle clipping (3-css), date-box sizing (4b). WHY: pure established-pattern CSS/markup, the stylist's core role; Sonnet/high is sufficient and cost-right.
- 1B frontend-engineer **Sonnet/medium** — graph.js ONLY: remove "Show" label, rename "Top names"→"Top Names" (both sites). WHY: trivial mechanical markup/string edits; low tier, tight spec. Disjoint file from 1A → runs in parallel.

**Wave 2 — Graph behaviour (medium/high risk).** Items 4a, 5, 6.
- 2A frontend-engineer **Opus/high** — graph.js: remove window auto-fill (4a), donut team filter (5, novel), red-outline toggling logic (6). WHY: donut filter is novel number-adjacent logic (new control + scoped options + roster filtering); Opus warranted; one owner for graph.js.
- 2B design-stylist **Sonnet/high** — styles.css: red-outline class (6), donut team-select styling (5). Disjoint from graph.js; class-name contract agreed up front with 2A.

**Wave 3 — Update chart button (highest risk, cross-cutting).** Item 7 alone.
- 3A frontend-engineer **Opus/xhigh** — graph.js: gate all 18 render triggers + onScopeChanged behind a dirty-flag; add "Update chart" button + wiring; disable export while dirty. WHY: architecture-touching render-model change; xhigh care. Must land AFTER Wave 2 so it gates the new slope/dumbbell/donut triggers too.
- Button CSS: small — folded into 3A's brief (match existing `.btn` styles) or an orchestrator touch.

**Phase 5 — Integrated review.** Opus/xhigh fresh reviewer over the whole diff +
orchestrator browser pass: anchors (2,813 / SA Yadav) hold; every chart type draws;
donut/slope/dumbbell values correct once inputs given; Update-chart gating captures
all triggers; console clean; one-viewport fit at desktop + mobile.

## Verification per wave
`node --check` touched .js; boot localhost:8000 zero console errors; on-screen anchor
2,813; exercise every chart type; screenshot desktop + 375px. Wave 2 also: donut value
spot-check vs a manual DuckDB team total. Wave 3 also: confirm no auto-draw on any
control change; Update chart draws; dirty indicator behaves.

## OWNER ANSWERS (resolved 2026-07-16)
- Q1 header: **compact ~50px strip** (one row: wordmark + search + toggle).
- Q2 font shrink: **graph controls only** — Stats table text UNCHANGED.
- Q3 Update-chart: **in-panel controls only** — KEEP the graph's 'Apply to graph'
  filter button; the new button gates chart type / metric / players / windows.
- Q4 red-outline: **the empty required control** (date-window inputs, donut team select).

## STATUS: Wave 1 spawned.
