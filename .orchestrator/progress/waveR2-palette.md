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
- [x] Phase 1+2 — palette shell + ▸ primitive + 7-group restructure + renames + fold +
  deletes. COMMIT `ebf948d`. Verified flag-off: anchors 2,813 / Karanbir 2,454 / SA
  Yadav 60·1,544·29.13·150.34; search+highlight+▸ expand + empty state; metric +
  categorical picks land conditions; both surfaces; 375px no overflow; 0 console errors.
  Bowling groups verified (Wicket Types ▸, 4-WI/5-WI, Extras ▸, Boundary Run %; phase/
  WPI/Bdry%Conceded deleted).
- [x] Phase 3 — 2 boundary-split metric defs (runs_4s_boundary_pct `(4*fours_hit)*100/runs`,
  runs_6s_boundary_pct `(6*sixes_hit)*100/runs`) added to metrics.js; INDEPENDENTLY
  verified (`.orchestrator/verify_waveR2_metrics.py`, ALL PASS): SA Yadav 4s-bdry
  36.788% / 6s-bdry 31.088% == raw-ball derivation; sum == batting boundary_runs_pct
  67.876%; anchors unchanged. In-app: both wire into `% Runs in…` ▸ [1s,2s,3s,4s-boundary,
  4s-run,5s,6s-boundary,6s-run]; R1 spot-check in-app (SKY boundary_run_pct 67.876%,
  innings_score_ge(50)=12) matches R1.

## Palette API (drawer.js, internal)
- `buildPaletteGroups(s, gi)` → `[{ name, note?, items:[{kind:'leaf'|'family', label,
  disabled, run?, variants?}] }]` (variants same shape as leaves).
- `mountAddPalette(addctlEl)` — builds the list DOM from buildPaletteGroups, wires
  search + ▸ expand + row clicks + open/close; one call per `[data-role="add-palette"]`
  in wireNumeric.
- `pickSingleton(key, preselect?)` / `pickMetric(gi, key)` — the two mutation paths.

## Flag-ON verification (Ball Ranges) — DONE
Temp-set `DATA_BASE_URL` to `http://localhost:8000/data/wave1_out/` (R2 doesn't ship the
delivery parquet yet — 404) and loaded `?engine=ball`; REVERTED after (`git checkout
src/config.js`). Ball engine anchors reproduce (2,813 / Karanbir 2,454). Ball Ranges
group appears: Phase ▸ [Powerplay,Middle,Death] · Over Range · Team Ball Range ·
Batter/Bowler Ball Range ▸ [First N,Last N]. Phase ▸ Powerplay pre-selects the win_phase
chip; Search → count 2,813→1,570, top row Waseem Muhammad (powerplay), "Powerplay overs"
pill — the folded window drives the query byte-identically. 0 console errors flag-on.

## Handoff to R3 (player pop-up drawer, src/playerFilters.js)
R3 must replicate this palette in the PLAYER pop-up drawer. The reusable pieces all live
in drawer.js's `mountFilterDrawer` closure (NOT exported yet): `buildPaletteGroups(s,gi)`
(the 7-group taxonomy + ▸ + renames + deletes + fold), `mountAddPalette(addctlEl)`,
`portalPanel()` (leak-free), `pickSingleton`/`pickMetric`, the preselect closures, and the
palette DOM skeleton in `groupCardHTML`. If R3 shares them, consider extracting to a small
`src/addPalette.js` module (keep drawer.js callers byte-identical). The player drawer has
its OWN filter set / state — R3 owns mapping its filters onto the same leaf/family shape.
`mountWindowPlayer` gained `presetEdge(edge)` (drawerInnings.js) for the Ball Range ▸.

## Gotchas
- Close any open palette at the TOP of renderNumeric (rebuild removes the addctl; a
  portaled-open panel would orphan on <body>). `currentPaletteClose` tracks it; close is idempotent.
- Both surfaces (Stats popup + Graph popup) mount `mountFilterDrawer` → both get the
  palette automatically. Verify both. (Both are in the DOM at once: when scripting, scope
  to the VISIBLE popup; an OPEN palette panel is portaled to <body>, not under its host.)
- The `vs bowling style` fine styles load lazily; buildPaletteGroups triggers a one-shot
  renderNumeric rebuild once they arrive so they appear as ▸ variants.
