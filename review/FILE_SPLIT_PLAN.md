# File-split plan — the five oversized files (PLAN ONLY, not executed)

Written 2026-07-15 as part of the codebase health review (Gate 1). Nothing in this
document has been done — it is a staged proposal for a later, owner-approved effort.

## What this is and why

Five files are far over the project's ~600-line guideline:

| File | Lines | What it is |
|---|---|---|
| `src/graph/graph.js` | 3,324 | The whole Graphs page: controls, roster, filters popup, chart dispatch |
| `src/table.js` | 2,218 | The Stats table: query builder + toolbar + rendering + column picker |
| `src/metrics.js` | 1,654 | The metric catalogue (every stat's SQL + display rules) |
| `src/graph/charts.js` | 1,066 | The individual chart renderers (bar, donut, scatter, …) |
| `styles.css` | 4,338 | All styling for the whole app |

Big files are risky to edit (agents and humans lose their place) and slow to review.
Splitting them changes **zero behaviour** when done right — every stage below moves
code verbatim and is verified against the standing anchor numbers plus a hands-on
browser pass before the next stage starts.

**The single most important technical fact, from the review's structural mapping:**
these five files are NOT equally risky to split.

- `charts.js` is **trivially safe** — it has zero shared internal state; three chart
  files were already split out of it in past rounds and the pattern is proven.
- `metrics.js` is **92% pure data** (four big lists of metric definitions) with a
  thin logic layer at the bottom — a clean two-file cut.
- `table.js` is **half pure functions, half one big stateful controller** — the pure
  half moves easily; the controller stays put this round.
- `styles.css` splits by section **only if load order is preserved** (later rules
  deliberately override earlier ones).
- `graph.js` is the hard one: ~25 shared internal variables thread through every
  function. It needs a preparatory untangling stage before any real split, so it
  goes **last**.

## Stage order (each stage = its own owner gate)

Ordered easiest/safest → hardest. Stop after any stage; each leaves the app whole.

---

### Stage 1 — `src/graph/charts.js` (1,066 → ~6 files of 100–300 lines)

**Cut lines:** the five shared helpers (`palette`, `SERIES_COLORS`, `labelForValue`,
`destroyIfExists`, `shortenName`) plus the two data-fetch functions
(`fetchSelectedPlayerMetrics`, `fetchWindowMetric`) become `src/graph/chartKit.js`.
Each remaining renderer gets its own file, mirroring the already-split
`timeseriesChart.js` / `dumbbellChart.js` / `benchmarkChart.js`:

- `barChart.js` (buildBarChart, lines 206–325)
- `donutChart.js` (343–432)
- `scatterChart.js` (439–566, incl. its label plugins)
- `phasesChart.js` (592–662)
- `slopeChart.js` (685–880, incl. the endpoint-label plugin)
- `radarSmallMultiples.js` (915–1066)

`charts.js` itself becomes a thin re-export barrel so `graph.js`'s imports don't
change (or `graph.js`'s import list is updated — either is fine; the barrel is the
smaller diff).

**Why safe:** zero module-level mutable state (verified in review); every function
is self-contained; the split pattern already exists in the same folder.
**Roster:** one **frontend-engineer agent, Sonnet, high thoroughness** — pure
mechanical moves, no logic edits allowed.
**Verify:** `node --check` all new files; boot localhost:8000, zero console errors;
draw every chart type once (bar, donut, scatter, phases, slope, radar, line,
dumbbell, benchmark); baseline 2,813 and SA Yadav 60/1,544/29.13/150.34 on-screen.

---

### Stage 2 — `src/metrics.js` (1,654 → 2 files)

**Cut:** lines 88–1601 (the four metric-definition arrays + `DISMISSAL_KINDS` and
its push-loop) move verbatim to `src/metricsCatalog.js`. `metrics.js` keeps the
logic layer (the combined list, the lookup index, `metricsFor`, `getMetric`,
`hasMetricData`, `matchupBucketLabel`) and imports the catalogue. **No external
import path changes** — the ten modules that import from `metrics.js` are untouched.

**Explicitly NOT in this stage:** generating the repetitive phase/matchup metric
blocks from a factory (which could shrink the catalogue by ~two-thirds). That edits
SQL-bearing data and is a separate, opt-in, test-first task (snapshot the current
metric list, generate, assert byte-identical) — flagged in the health report as
finding E2.

**Why safe:** a verbatim cut-and-import of constant data; the file's own structure
map shows a clean seam at line 1601.
**Roster:** one **frontend-engineer agent, Sonnet, high** (no SQL edits permitted —
move only).
**Verify:** `node --check`; boot; column picker shows the identical column list in
both disciplines + matchup mode; anchors on-screen (2,813 / 2,049 / SA Yadav row).

---

### Stage 3 — `src/table.js` (2,218 → ~4 files; controller stays)

**Cut (all pure, per the structural map):**
- `src/tableQuery.js` — lines 131–703: `appendFilterToAggregates`,
  `buildMatchupQuery`, `conditionToHaving`/`conditionApplicability`/
  `advancedToHaving`, `regularPositionCteSql`, `buildQuery`. `buildQuery` is
  imported by three graph modules → table.js re-exports it so their import paths
  survive (or they're repointed; barrel re-export = smaller diff).
- `src/tableFormat.js` — lines 762–920: `formatValue` (re-export kept for
  `playerSections.js`), `dataCellHTML`, dismissal-picker metadata, sort helpers.
- `src/tableStickyWidth.js` — lines 705–760: the name-column measuring probe trio
  (the file's ONLY module-level state — moves as one unit).
- `table.js` keeps: constant maps (29–129), `mountTable` (922–2218) unchanged.

**Explicitly NOT in this stage:** splitting the `mountTable` controller itself —
its sub-parts (toolbar, rendering, column popover, load) all share one closure's
variables. Same disease as graph.js, smaller dose; revisit only if Stage 5 goes well.

**Why mostly safe / where the care is:** everything moved is a pure function moved
verbatim — but `buildQuery` is THE number-producing query builder, so this stage
gets the full anchor treatment including an independent DuckDB console check.
**Roster:** one **frontend-engineer agent, Sonnet, high**; the orchestrator (not the
agent) does the anchor verification.
**Verify:** `node --check`; boot; anchors on-screen AND one independent browser-
console DuckDB query for the batting baseline (2,813) and SA Yadav's row; matchup
anchors (SA Yadav vs Spin 38/454/140.99; Bumrah vs RHB pos 1–2 = 27/177/9); graph
still draws (it imports `buildQuery`).

---

### Stage 4 — `styles.css` (4,338 → ordered section files)

**Mechanism (no build step exists, so order must be explicit):** split into section
files loaded by sequential `<link>` tags in `index.html`, following the audit's
section map: `styles/base.css` (fonts 10–29, palette/tokens 30–117, base 118–159),
`styles/shell.css` (header 160–281, main/layout 282–341, footer), `styles/controls.css`
(segmented 342–384, filter bar 385–645, buttons 787–854, condition builder 988–1065),
`styles/search.css` (omnisearch 1066–1167), `styles/table.css` (~1168–1736 + toolbar
presets 2064–2081 + matchup mode 4154–4259), `styles/overlays.css` (toast, pills,
the shared backdrop/popup chrome 1934–1961 + filters popup 3222–3401 + cond groups
3404–3451), `styles/graph.css` (2383–3157 — the largest single section),
`styles/player.css` (3452–4153 + graph chooser 4260–4338), `styles/responsive.css`
(2082–2382, LAST).

**Order/cascade constraints found by the audit (the checklist for this stage):**
- All ≤640px media rules must load BEFORE the ≤480px rules for selectors that
  appear in both (the file relies on source order there, per its own comments).
- The shared popover base rule (lines 504–524) styles classes owned by four
  different sections — it stays in a shared/common file, not duplicated.
- `.filters-popup` is styled in TWO regions (overlay chrome ~1944; panel chrome
  3229–3401) — the split should reunite them in one file (safe: the one
  cross-region override wins by specificity, not order, per the file's comment).
- The `.paper-card` block's private `--paper-*` token set (2749+) is deliberately
  theme-independent and moves as a unit with the graph file.

**Do the dead-CSS removal batch BEFORE this split** — ~350+ lines of the file are
proven dead (old advanced-filters block 855–986, old drawer 1964–2063, F1b player
section 668–730, etc.); no point carefully relocating corpses.

**Trade-off to note honestly:** ~7 stylesheet requests instead of 1. On Vercel +
HTTP/2 this is negligible; if the owner prefers, an alternative is keeping ONE file
but enforcing the section banners — say so at the gate.
**Roster:** one **design-stylist agent, Sonnet, high**.
**Verify:** boot; screenshot-compare the five core screens (empty load, loaded
table, filters popup, graph page, player popup) at desktop + 375px mobile against
before-shots; zero console errors. No numbers are involved, so this gate is purely
visual.

---

### Stage 5 — `src/graph/graph.js` (3,324 lines; three sub-stages, each gated)

The review found graph.js is one giant `mountGraph` closure where ~25 mutable
variables (chart type, per-chart metric choices, time windows, roster selection,
render tokens…) are read/written by nearly every function. It cannot be split at
function boundaries as-is. Plan:

**5a — extract the already-pure edges (low risk).**
- Day/date-window helpers (lines 179–228) → `src/graph/dateWindows.js`.
- `CHART_TYPES` / `CHART_RULES` / `chartPurposeMessage` + eligibility predicates
  (56–156, 275–296) → `src/graph/chartRules.js`.
- `wireDropdown` (238–260) → shared with the identical helper in filters.js (one
  home, both import). NOTE: the health report separately proposes fixing this
  helper's listener leak (finding L1) — do that fix FIRST, in the cleanup batches,
  so the split moves the fixed version.
- Roster: **frontend-engineer, Sonnet, high**. Verify: boot + all chart types +
  anchors on-screen.

**5b — the state-extraction refactor (the real work, highest care).**
Convert `mountGraph`'s closure variables into one explicit `ctx` object passed to
each function (mechanical but pervasive — hundreds of reference rewrites). NO file
split happens in 5b; the file gets slightly bigger and much more explicit. This is
the stage where subtle regressions could hide, so it runs solo.
- Roster: **one Opus agent, xhigh thoroughness**, no other agents in flight.
- Verify: full graph regression — every chart type; roster modes Top names/Best/
  Worst/Manual; graph Filters popup apply/clear; back-to-table link; shared-filter
  bidirectionality (graph → Stats discipline change); anchors 2,813/2,049 + graph
  pool counts (e.g. "2810 of 2813"); zero console errors.

**5c — the actual split (only after 5b is verified and gated).**
With `ctx` explicit, cut along the seams the review identified:
- `graphFiltersPopup.js` (1960–2141 — only touches store/applied-flag/onScopeChanged)
- `graphSeed.js` (2169–2230 seeding + scope keys)
- `graphMetricControls.js` (1025–1537 — the biggest sub-render)
- `graphRoster.js` (1575–1793 roster list + wiring)
- `graphRender.js` (2457–3012 `renderChart` dispatch + exclusions)
- `graphChooser.js` (3116–3276 the add-player chooser)
- `graph.js` keeps mount, store wrapper, controller API, `currentInstance` bridge.
- Roster: **two frontend-engineer agents, Sonnet, high, on disjoint new files**,
  sequenced so no two touch graph.js simultaneously; orchestrator integrates.
- Verify: same full graph regression as 5b + anchors.

---

## Cross-stage rules (apply to every stage)

1. **Move verbatim.** No renames, no "improvements while we're here", no logic
   edits. A split stage that changes a single expression has failed review.
2. **One stage in flight at a time**; checkpoint-commit before and after; the owner
   gates each stage on localhost:8000 (budget ~10–20 min per gate).
3. **Anchors after every stage** (on-screen; independent DuckDB check whenever the
   moved code includes query builders — Stages 3 and 5 qualify).
4. **Import-path stability**: prefer barrel re-exports from the original file so
   untouched modules keep working; collapse the barrels later once everything is
   stable.
5. Browser module caching: after each stage, hard-reload with cache disabled (or
   `fetch(path, {cache:'reload'})` per changed file) before verifying.

## Suggested overall order & effort

| Stage | Risk | Est. agent effort | Owner gate |
|---|---|---|---|
| 1. charts.js | Low | ~1–2 h | 10 min |
| 2. metrics.js | Low | ~1 h | 10 min |
| 3. table.js | Medium (query builder moves) | ~2 h | 15 min |
| 4. styles.css | Low-medium (visual only) | ~2 h | 15 min |
| 5a. graph edges | Low | ~1 h | 10 min |
| 5b. graph state extraction | **High** | ~3–4 h | 20 min |
| 5c. graph split | Medium | ~3 h | 20 min |

Stages 1–4 are independent of each other and could even be interleaved with other
work; 5a→5b→5c are strictly serial. If the owner wants only the cheap wins, doing
Stages 1–3 and stopping is a perfectly good outcome — graph.js can wait.
