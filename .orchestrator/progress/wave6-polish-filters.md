# Wave 6 polish — owner filter-UX batch (6 items + is_super_over defect)

Branch: polish-b1-mechanical (from HEAD 3c8c61b) · Status: COMPLETE (verified on
localhost:8000 against the local export in `data/export/`; config override left in
place for the orchestrator, NOT committed).

## Approach + key risk
All six items are display/UX/options-side. The KEY RISK was Rule 1: three new
no-narrowing sentinels (Stage "All", the Season empty selection, Result Condition
"All") had to keep `matchContextActive`/`anyEventSeasonNarrowing` FALSE so no LEFT
JOIN and no clause is added and the SQL stays byte-identical. Proven: all three
harness cases emit the identical sha256 as HEAD (1b279618c523…).

Second risk (realised): item 5's brief named `scopeSeedKey` as the graph gate, but
the deeper half of the defect was `applyGraphFilters` — its commit list omitted
eventSeasons + all six match-context fields, so those edits were DISCARDED on
"Apply to graph" and could never reach any query. Both halves fixed.

## What changed
- `export_parquet.py` `sql_matches()` — `is_super_over` wrapped in
  `COALESCE(..., false)`. The bare `result_type LIKE 'tie (%)'` is NULL for every
  ordinary win (20,527 of 22,229 rows), so any negation dropped them. Pipeline NOT
  run (SQL fix only). Proven against `data/cricket.duckdb`: TRUE count 108 → 108,
  NULLs 20,527 → 0.
- `state.js` — RESULT_OPTIONS loses `super_over` (All·Won·Lost·Drawn·Tied·No
  result; Drawn/Tied stay separate per owner). RESULT_TYPE_* → RESULT_CONDITION_*
  (+ `super_over` option, `resultConditionMethod`, `resultConditionFilterActive`,
  state key `resultType`→`resultCondition`). New `STAGE_ALL` / `STAGE_NONE` /
  `STAGE_NONE_LABEL`; `stageFilterActive` now treats All-only as inactive.
  describeScope: "Result condition: …"; Stage token drops All and reads the
  No-Stage sentinel out as its label.
- `filters.js` — Result clause drops the super-over branch. Stage clause gains the
  All sentinel + the `event_stage IS NULL` disjunct (OR'd with named stages).
  Result Condition clause: Normal = `(method IS NULL AND NOT COALESCE(is_super_over,
  false))`, Super Over = `COALESCE(is_super_over, false)`, methods = one IN-list,
  all OR'd. No scope-change clear handler needed changing (`stage: []` is still
  inactive under the new sentinel).
- `playerData.js` `searchStages` — now returns `{ stages, hasNoStage }` and takes an
  optional `eventNames` (canonical → raw aliases) so the vocabulary CROSS-FILTERS by
  the picked Event(s). Omitting it emits the pre-item-3 SQL unchanged.
- `drawerInnings.js` — `mountAllMultiSelect` generalised (function-or-array options,
  optional quick button, optional hide-when-nothing-to-choose note) and Stage now
  USES it, so Result / Result Condition / Stage share one component. `mountStage`
  rewritten as a thin async-vocabulary wrapper (+ `reconcileSelection` so a hidden
  control can never leave a filter applied). `mountEventSeasons` rewritten: one
  persistent portal DROPDOWN per selected event (Format/Team-type mechanics), "All
  seasons" a real select-all/clear-all toggle that is never disabled, empty stored
  as `[]` (still no narrowing), reconcile drops narrowing for ≤1-season events, and
  events with ≤1 in-scope season render no dropdown at all.
- `drawer.js` — `mc_stage` moved into the "Match" group between Event and Venue (in
  both the add-dropdown order AND SINGLETON_TYPES, so the applied row sits there
  too). Adding Stage seeds `stage: ["all"]`. Result seeds `resultCondition: ["all"]`.
- `pills.js` — "Result condition: …" pill (key `mc_result_condition`); Stage pill
  drops the All sentinel, renders "No Stage", and its × snaps back to All.
- `table.js` — serializeQueryState `resultType`→`resultCondition`, plus `eventSeasons`
  ADDED (defect: a season change didn't light Search or bust the render cache).
- `graph/graph.js` — `scopeSeedKey` += event, eventSeasons, venue, result,
  resultCondition, tossResult, tossDecision, inningsOrder, stage. `applyGraphFilters`
  now commits eventSeasons + the six match-context fields (defect above).
- `styles.css` — nested-picker layout: `.cond-row__main` aligned flex-start for the
  event/result rows (the label used to float into the gap BETWEEN parent and child),
  child block (`.event-seasons` / `.result-condition`, renamed from `.result-type`)
  indented `--space-3` with its label and dropdown on one row, parent→child gap
  `--space-1` vs `--space-3` between groups.

## Verified
- `node --check` on all 8 touched .js: pass. `python3 -m py_compile export_parquet.py`: pass.
- BYTE-IDENTICAL harness (node, real buildQuery + buildMatchupQuery + graph-fetch
  SQL, HEAD 3c8c61b vs working tree): (a) no conditions, (b) Result added All+All,
  (c) Stage added with All → ALL THREE identical to HEAD, sha256
  1b279618c52322eeb5b9e06a0550aa3d6a05b0d32ec6983f5c9ae227db54ec85 (4,075 bytes).
- Anchors in-app (Men/T20/International 2023-07-01→2026-07-02): 2,813 players,
  Karanbir Singh 2,454 ON SCREEN; SA Yadav 60·1,544·29.13·150.34; Bumrah vs RHB
  pos 1–2 = 27 inns/177 balls/9 wkts; SA Yadav vs Spin = 38·454·SR 140.99.
  Zero console errors throughout.
- Independent DuckDB (hand-written, vs data/export + data/cricket.duckdb) == the
  app's REAL buildQuery: Result Condition Normal 56 inns/1,442 runs (NOT the
  brief's 58/1,462 — that was the OLD "method IS NULL" definition; item 4's
  redefinition correctly moves his 2 super-over innings / 20 runs out. 56+2+2 = 60
  ✓); D/L 2/82; Super Over 2/20; Result Won + All 48/1,277; Stage No Stage 55/1,482;
  Stage All 60/1,544 (= baseline, no narrowing). All-time: Normal 21,128 · Super
  Over 108 · D/L 984 · VJD 5 · Awarded 4 · Fewer Wickets 1 · overlap 1 · NULL stage
  20,689 — every figure matches the brief.
- is_super_over defect, via the app's own view: COALESCE TRUE = 108; bare
  `NOT is_super_over` = 1,594 (loses 20,527); `NOT COALESCE(...)` = 22,121 = 22,229−108.
- Stage cross-filter: Red Ball + Domestic + County Championship → `searchStages`
  returns 0 named stages (Super Eight/Final from other events do NOT leak); the
  dropdown is NOT rendered and the note "No tournament stages to choose in this
  scope." shows. Without the event filter the same scope lists Final + Super Eight.
- Stage hide + no stale filter: Stage=Final in T20-intl, then Event=East Asia Cup
  (≤1 named stage) → dropdown hidden and `reconcileSelection` snapped stage back to
  All (Search: the Stage pill is gone, 41 players unfiltered by stage).
- Combined new clauses cross-checked: Stage(Final|No Stage) + Super Over → app K
  Bhurtel 3 inns/157 runs == independent crosstab (NULL,so=true 2/126 + Final,
  so=true 1/31). 265 players.
- Season dropdown: County Championship lists 12 seasons 2014–2026 across all three
  sponsor eras (2020 absent = COVID). "All seasons" never disabled; uncheck →
  everything clears (toggle still honestly reads "All seasons" because empty = All);
  re-check → all selected; uncheck 2024 → "11 seasons". Empty `[]` emits the
  BYTE-IDENTICAL event clause to All (string-compared), and 2015 narrowing spans all
  three aliases.
- Season hide (coordinator's addition): Marsh Sheffield Shield (1 in-scope season) →
  no Season dropdown at all, whole child row hidden. Stale-narrowing guard: County
  Championship narrowed to 2014, then a TOOLBAR date change to a 2026-only window →
  Season row disappears AND the narrowing is dropped (pill reads "Event: County
  Championship" with no season suffix; 51 rows rendered, not 0).
- Graph re-query, each key changed in the graph's own Filters popup → "Apply to
  graph" → the drawn chart's Chart.js data changed (baseline JC Buttler = 1,324):
  result Won → 887 · resultCondition D/L → 81 · tossResult Won toss → 773 ·
  tossDecision Chose to bat → 205 (Miller 259 leads) · inningsOrder Batted first →
  672 · stage Final → whole roster changed (V Kohli 76) · event ICC T20 WC Europe
  Qualifier → Berrington 342 · eventSeasons 2023 → Berrington 248 · venue Udayana
  → Priandana 1,154.
- Add-condition menu: "Match: Event / Stage / Venue", "Match context: Result / Toss
  result / Toss decision / Innings order". Result options exactly All·Won·Lost·
  Drawn·Tied·No result. Result Condition exactly All·Normal·Super Over·D/L (Rain)·
  VJD (Rain)·Awarded·Fewer Wickets. Knockout button selects 19 in-scope knockout
  stages and never All / No Stage / group rounds (First Round, Qualifying Group,
  Super 10 correctly excluded).
- Pills + describeScope: "Stage: Final, No Stage", "Result condition: Super Over,
  D/L (Rain)"; with every sentinel on All the scope sentence adds nothing.
- Mobile 380px: no horizontal overflow; the nested pair wraps and keeps its indent.

## Concerns (flagged, NOT resolved)
1. The brief's expected "Normal → 58/1,462" is stale w.r.t. its own item-4
   redefinition. Correct new value is 56/1,442 (see above). Numbers move for anyone
   who used the old Normal.
2. Item 3's "hide the Stage dropdown when only ONE named stage" removes a REAL
   filter in some scopes — e.g. Red Ball + International lists only "Final" (the WTC
   finals), and "Final vs No Stage" is a meaningful split there. Implemented as
   instructed; worth an owner confirmation.
3. "No Stage" is offered only when the scope actually contains NULL-stage matches
   (same principle as FIX C's scope-filtered named list — an option that can only
   return zero rows isn't a choice). Judgement call, not spelled out in the brief.
4. A reconcile that corrects state during an async option load (Stage's
   `reconcileSelection`, and the pre-existing Season `reconcileNarrowing`) does not
   call `onChange`, so the PILL can briefly claim a filter the state no longer holds
   until the next interaction/Search. The state and every query are always correct.
   Not fixed here: `onChange` → `onFiltersChanged` → `graphController.onScopeChanged()`
   in graph view, so wiring it in from inside a load resolution needs its own
   re-entrancy verification.
5. `fielding` and `minInnings` are still absent from `applyGraphFilters`' commit list
   (the fielding slice conditions ARE editable in the graph drawer) — the same class
   of defect as item 5, but outside the brief's named key list. Not touched.
6. `src/playerData.js` contains a literal NUL byte (a Map-key separator in a template
   string at `searchEventSeasons`). Harmless at runtime but it makes `grep` treat the
   file as binary. Left alone; ` ` would be equivalent and greppable.

## Follow-up pass (two owner fixes + one scope addition, same branch)

Branch: polish-b1-mechanical (from HEAD f48bb8c). Status: COMPLETE, verified on
localhost:8000 against `data/export/`.

### FIX 1 — Stage "nothing to choose" must count No Stage as an option
`src/drawerInnings.js` `mountStage`'s `nothingToChoose()` counted only named
stages, so a scope with exactly 1 named stage + unlabelled matches (Red Ball +
International: "Final" + No Stage) wrongly hid the dropdown — the owner flagged
this as wrong. Fixed: total selectable options = named stages + 1 if
`hasNoStage`; hidden only when that total is <= 1. `reconcileSelection` uses the
same function, so it inherited the fix with no separate change.

### FIX 2 — fielding + minInnings missing from the graph's commit list
`src/graph/graph.js`: the fielding SLICE conditions (Dismissed position /
Dismissal kind / Fielding phase, `state.fielding`) are mounted onto the SAME
buffer store as `advanced` by drawer.js's shared `mountFilterDrawer` — so they
ARE editable in the graph's own Filters popup — but were missing from both
`scopeSeedKey` and `applyGraphFilters`' commit list, so an edit was silently
discarded on "Apply to graph" (the exact defect class item 5 fixed for
event/venue/match-context, one field short). Added `state.fielding` to
`scopeSeedKey` and `fielding: buf.fielding` to the commit list.
`minInnings` was ALREADY present in `scopeSeedKey` — but there is NO editable
control for it anywhere in the app (graph or Stats): decision 44c removed the
min-innings HAVING gate from `buildQuery` entirely and the brief's own comment
in `applyGraphFilters` already listed it among fields "the popup never edits".
Confirmed via grep: zero UI references outside state.js/table.js/graph.js
comments. Left untouched; flagged below rather than wiring dead state.

### FIX 3 (scope addition, owner via coordinator) - stale pill after an async reconcile
Concern #4 above: Stage's `reconcileSelection` and Event to Season's
`reconcileNarrowing` correct `state.stage` / `state.eventSeasons` after an async
vocabulary reload lands, but never signalled the pills row, which could keep
showing a filter the state had already dropped. Calling the general `onChange`
from inside a load resolution risks re-entering the graph's own
`onScopeChanged()` re-query. Added a narrow, additive `onReconcile` callback
(default no-op) threaded `mountFilterDrawer` -> `mountStage` /
`mountEvent` -> `mountEventSeasons`, invoked ONLY when a reconcile actually wrote
a change (reusing each function's existing `changed` flag). main.js wiring is
NOT part of this pass's diff (out of the touched-file list for this task) -
the hook is wired and proven at the component level; a future pass wires
`() => pillsController?.render()` in for the Stats popup specifically.

## Verified (follow-up pass)
- `node --check` on all 3 touched files: pass.
- Byte-identical: `src/table.js`, `src/filters.js`, `src/graph/charts.js`,
  `src/state.js` - SHA-256 identical to HEAD f48bb8c (none of them touched by
  this pass at all).
- Stage cases, via the real exported `mountStage` against the actual scoped
  vocabulary (real DuckDB, no mocked options):
  - Red Ball + International: options = All/Final/No Stage -> dropdown SHOWS
    (2 real choices). This is the case the owner flagged as wrong.
  - Red Ball + Domestic (`club`) + County Championship (1,429 unlabelled
    matches, 0 named stages): dropdown HIDDEN, note "No tournament stages to
    choose in this scope."
  - T20 + International: dropdown SHOWS with the full named-stage list + No
    Stage, unaffected.
- FIX 3, via the real exported `mountStage`/`mountEvent` against real data,
  with onChange/onReconcile spies:
  - Stage: seed T20-Intl scope, set stage=["Final"]; switch scope to
    Red Ball/Domestic/County Championship (no named stages) -> state snapped to
    ["all"], onReconcileCalls 1, onChangeCalls 0 throughout (no re-query).
  - Event to Season: County Championship 2014-2026 (12 seasons, 2020 absent =
    COVID, matches prior verification); narrow to {2014}; shrink the toolbar
    date to 2026-only -> eventSeasons collapsed to {}, onReconcileCalls 1,
    onChangeCalls 0.
- FIX 2, live in the app (Men/T20/International, 2023-07-01 to 2026-07-02, Bar
  chart, Catches, Top 15): baseline JC Buttler 33 (unfiltered) -> added Fielding
  phase = Powerplay in the Graph's own Filters popup -> Apply to graph -> roster
  AND numbers changed (Q de Kock 13 now #1, JC Buttler 7, GJ Maxwell 7, JO
  Holder 4 - a name that wasn't even in the unfiltered top 15). Independent
  DuckDB recompute over the `fielding` view for exactly these 15 names,
  kind='caught' AND phase='pp', same scope: Q de Kock 13 / JC Buttler 7 / GJ
  Maxwell 7 / JO Holder 4 / Shakib Al Hasan 3 / AU Rashid 3 / DA Miller 2 /
  seven players at 1 / RA Jadeja 0 - exact match to the chart, byte-for-byte.
- Anchors in-app (Men/T20/International 2023-07-01 to 2026-07-02): 2,813 players,
  Karanbir Singh 2,454; SA Yadav 60 inns/1,544 runs/29.13 avg/150.34 SR. Zero
  console errors throughout (checked repeatedly across the whole pass).

## Concerns (flagged, NOT resolved)
1. `minInnings`'s absence from `applyGraphFilters`' commit list is NOT a defect
   - there is no UI anywhere (Stats or Graph) that edits it; decision 44c
   removed the gate and its control. If the brief's premise assumed a live
   control exists, that premise doesn't match the current app.
2. FIX 3 is wired and proven at the `mountStage`/`mountEvent` component level
   (onReconcile fires exactly on a real state change, never alongside
   onChange). The actual `() => pillsController.render()` callback is NOT yet
   passed in from `main.js`'s own `mountFilterDrawer(...)` call (that file
   wasn't part of this pass's touched-file list) - so today's real Stats pills
   row does not yet repaint from this hook. Wiring that one call in main.js is
   a small, obvious follow-up; flagging rather than silently expanding scope
   into a file not named in the brief.
3. Season's `reconcileNarrowing` and Stage's `reconcileSelection` are the only
   two silent-mutation-after-async-load sites found; Event's own selection
   (`mountScopedMultiSelect`, shared by Team/Opposition/Event/Venue) never
   writes state back after a reload - `setOptions`/`setValues` only filter the
   WIDGET's local display, so there is no analogous defect to fix there.
