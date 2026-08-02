# Wave R2 — "+ Add condition" search palette (Option C) — progress

Branch `ball-layer`. Owner: frontend-heavy (Opus). Files owned: `src/drawer.js`,
`src/drawerInnings.js`, `styles.css`, + `src/metrics.js` (ONLY the 2 boundary-split defs).

## Approach (decided)
Replace the per-group native `<select data-role="add-cond">` (built by
`addSelectOptionsHTML` in drawer.js) with an **Option-C search palette**: a trigger
button opens a portaled popover with a pinned search box + the 7 spec groups as
headers; typing filters leaf labels AND ▸ variant names; ▸ families expand inline;
"No matching filter" empty state. Built as a small self-contained component in
drawer.js (NOT an extension of searchSelect.js — the palette's group/▸ shape is
structurally different from the flat listbox; brief says prefer not to extend it).
Portal + outside-click/Escape handled by a LEAK-FREE local helper (doc listeners
added on open, removed on close) — NOT `wirePortalDropdown`, which never removes its
doc listeners and would leak when re-created per numeric rebuild.

### The ▸ sub-filter mechanic (how it maps onto existing editors)
Each palette leaf carries a `run()` closure that fires the SAME store mutation the old
`<select>` did — so numbers are byte-identical:
- **Metric ▸ families** (Dismissal Type / Wicket Types / % Runs in… / Balls per… /
  Extras): each variant → `addConditionToGroup(store, gi, metricKey)` (an `m:` add).
- **Categorical singleton ▸ families** (Match/Toss Result, Phase, Fielding Wicket
  Type, Wickets by Batting Position, vs bowling style, vs batting hand): variant →
  reveal the singleton row AND pre-select that value in STATE, then `sync()`. The row
  editors DERIVE their display from state (phase chips, fielding checkboxes, vs select),
  so a state write + sync is equivalent to the user ticking it. Match/Toss Result's 3
  variants map to 3 DISTINCT singletons (mc_result / mc_toss_result / mc_toss_decision);
  "Match Condition" lives inside the mc_result row (nested Result Condition) as today.
- **Batter/Bowler Ball Range ▸** (win_player, edge First/Last): variant pre-sets the
  edge via a new `presetEdge(edge)` method on mountWindowPlayer's controller (the edge
  is a local draft, not derived from state, so a state write alone can't set it).

Regression-safe metric placement: the discipline metric groups are built from
`partitionFilterMetrics(eligibleMetrics(ns))` (SAME source as today), re-ordered/
re-grouped per the spec's Basic/Detailed split for KNOWN keys, with any eligible metric
not explicitly placed appended to Detailed (catch-all) — so matchup-mode metric sets
never regress.

## Key risk
Numbers sacred: the palette must produce EXACTLY the old `c:`/`m:` mutations. Renames/
regroup/deletes are display-only. The 2 new boundary-split metric defs are the only
number-producing work → independent DuckDB verify.

## BLOCKED by scope boundary (flagged, NOT built)
- **Live-N input** for parametrised Innings Score ≥ N / Wicket Hauls ≥ N: needs
  table.js's `conditionToHaving` to use `paramSqlExpression` + a per-condition N field
  (query-builder change — forbidden). Presented as plain leaves adding the metric with
  its DEFAULT N (50 / 4), exactly as today. Needs a wave that owns table.js.
- **Innings Number ▸** filter (INNINGS_NUMBER_FILTER, innings_number WHERE): needs
  `buildScopeClauses` in filters.js (forbidden). The old "Innings order" (batted/bowled
  first, state.inningsOrder) is KEPT working in Match Details. Needs a wave owning filters.js.

## Status
- [ ] Phase 1 — palette shell + ▸ primitive + 7-group restructure + renames + fold + deletes
- [ ] Phase 3 — 2 boundary-split metric defs + verify + wire into % Runs in…

## Palette API (drawer.js, internal)
- `buildPaletteGroups(s, gi)` → `[{ name, note?, items:[{kind:'leaf'|'family', label,
  disabled, run?, variants?}] }]` (variants same shape as leaves).
- `mountAddPalette(addctlEl)` — builds the list DOM from buildPaletteGroups, wires
  search + ▸ expand + row clicks + open/close; one call per `[data-role="add-palette"]`
  in wireNumeric.
- `pickSingleton(key, preselect?)` / `pickMetric(gi, key)` — the two mutation paths.

## Gotchas
- Close any open palette at the TOP of renderNumeric (rebuild removes the addctl; a
  portaled-open panel would orphan on <body>). `currentPaletteClose` tracks it; close is idempotent.
- Both surfaces (Stats popup + Graph popup) mount `mountFilterDrawer` → both get the
  palette automatically. Verify both.
