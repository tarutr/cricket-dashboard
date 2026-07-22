# R6 — item #2 (batting-hand discipline gating) + item #7 (Phases → Grouped Bars rename)

## Item #2 — decision 54

Files: `src/drawer.js`, `src/state.js`.

- `src/drawer.js`:
  - `hasValue("hand", s)` now also requires `s.discipline === "batting"` (mirrors the
    existing `rpos` gate immediately below it) — belt-and-suspenders so a stale value
    can never resurface as a visible row in bowling.
  - `singletonOpt("hand")` in the "+ Add condition…" builder now returns `""` when
    `s.discipline !== "batting"` — "Batting hand" is no longer offered in bowling's
    add-condition list. (R.Pos.'s equivalent gate lives in `basicOpts()` since it's
    injected after "Innings"; "hand" comes off the plain `PLAYER_ADD_ORDER` list, so
    the gate sits inside `singletonOpt` itself instead.)
- `src/state.js`:
  - `swapAdvancedForDiscipline(prev, next)` — the ONE place a discipline change is
    detected or a bare `store.set({discipline})` (this is also where the existing
    per-discipline `advanced`/`advancedByDiscipline` swap already lives) — now also
    clears `profile.battingHand` to `null` whenever `prev.discipline !== next.discipline`
    (either direction). No other profile field touched. Updated two nearby comments
    that documented "identity filters persist" to note the one carve-out.
  - `buildScopeClauses`/`profileSemiJoinSql`/`buildQuery`/`buildMatchupQuery` untouched —
    byte-identical. The fix is purely "never let battingHand be set while bowling is
    active", not a SQL change.

Note: the Graph Builder's own "Apply to graph" staged buffer (`bufferStore` in
graph.js) is a SEPARATE `createStore` instance, so its own internal discipline-select
edits ALSO run through `swapAdvancedForDiscipline` (same function, different store
instance) — the clear applies there too, automatically, no graph.js changes needed
for item #2.

## Item #7 — Phases → Grouped Bars (label only)

File: `src/graph/graph.js`.

- `CHART_TYPES`: `{ key: "phases", label: "Phases" }` → `label: "Grouped Bars"`.
  Every consumer (chart-type dropdown, "What each chart is for" table, chart-type
  status map) reads off this ONE array, so this is the only label edit needed for
  those three surfaces.
- `CHART_RULES.phases.purpose`: "A phases chart breaks…" → "A grouped bars chart
  breaks…" (guidance text shown in the empty-state stage / invalid-metric message).
- `evaluateTypeStatus()`'s `case "phases"` note: "Phases compares a whole metric
  family…" → "Grouped Bars compares a whole metric family…" (shown when the chart
  type has no single metric to pick).
- Internal key `"phases"` (CHART_TYPES.key, `chartType` variable, `case "phases"`
  switches, `config.type === "phases"`) is UNCHANGED everywhere, per the brief.
- Did NOT touch `src/state.js`'s COLUMN_PRESET_DEFS "Phases" labels (batting/bowling
  column presets, e.g. the leaderboard's "Core / Boundaries / Dismissals / Phases /
  Progression" dropdown) — that is a DIFFERENT feature (leaderboard column preset,
  not the Graph Builder chart type) and out of the item's scope.
- Did NOT touch `src/graph/phaseFamilies.js`'s file-header comment mentioning the
  Graph Builder's "Phases" chart type — it's a comment only (not user-visible), and
  that file isn't in my owned-files list for this task.

## Verification

- `node --check` on `src/drawer.js`, `src/state.js`, `src/graph/graph.js` — all pass.
- Booted on localhost:8000, zero console errors throughout.
- Anchors reproduced on screen: Men/T20/International, 01/07/2023–02/07/2026 →
  **2,813 players**, top row **Karanbir Singh 2,454** runs (batting); switching
  discipline to Bowling and back reproduces the same 2,813-player batting scope.
  **SA Yadav** row: 60 inns / 1,544 runs / 29.13 avg / 150.34 SR — matches exactly.
- Independent DuckDB check (NOT the app's own aggregation shape — a raw
  `SELECT COUNT(*)/SUM(...) FROM batting WHERE ...` scoped by `batter_name = 'SA
  Yadav'`) via the console: `{inns: 60, runs: 1544, balls: 1027}` → SR
  1544/1027*100 = 150.34. Confirms buildQuery/buildScopeClauses are unmodified.
- Item #2 checks (scripted via direct DOM/store manipulation for reliability —
  UI-ref-based clicks were flaky across dialog re-renders/async re-sync, see below):
  - Batting discipline: "+ Add condition…" list includes `c:hand` ("Batting hand").
  - Added the condition, set it to "Left-hand bat".
  - Switched discipline to Bowling: add-condition list no longer has `c:hand` (nor
    `c:rpos`, confirming the mirrored mechanism); the "Batting hand" row itself is
    hidden (not lingering).
  - Switched back to Batting: "Batting hand" reappears in the add-condition list,
    but the row stays hidden and its value is empty (`""`) — not resurrected.
  - Sanity check: reproduced the exact same "ghost row lingers until Search/reopen"
    quirk for R.Pos. (add it, switch discipline, row stays visible with an empty
    editor until Search commits) — confirms this is a PRE-EXISTING shared UI quirk
    of the `sessionAdded` mechanism (resets on popup reopen, not on every discipline
    flip), not something introduced by this change, and that my batting-hand gate
    mirrors it faithfully as instructed.
- Item #7 checks: Graphs tab → "What each chart is for" table row now reads
  "**Grouped Bars** — Powerplay, middle and death splits of a metric."; opened the
  chart-type dropdown and confirmed the option list reads Bar/Scatter/Radar/
  **Grouped Bars**/Slope/Line/Dumbbell/Benchmark; selected it and the stage guidance
  read "A grouped bars chart breaks a metric family into powerplay, middle and
  death. Pick a metric family."

## Also fixed

None beyond the task.

## Suggestions (not built)

None.

## Concerns

- During manual UI testing I hit several flaky moments where clicking the Filters
  popup's discipline `<select>` (or believing I had) actually landed on a SEPARATE
  DOM node — the Graph Builder's own staged-buffer copy of the same filter-bar
  component (mounted against `bufferStore`, not the live `store`) — which looks
  identical on screen. This is a pre-existing structural fact (two independent
  `mountFilters` instances share the same `data-role` attributes), not a defect I
  introduced or touched, but it's worth flagging: anyone hand-verifying via
  `document.querySelector('[data-role="discipline"]')` without scoping to `#filter-bar`
  can silently query the wrong instance and draw a wrong conclusion (I did, initially).
- Unrelated: `git status` at the end of this session shows uncommitted changes in
  `src/table.js`, `src/playerSections.js`, and `styles.css` that I did NOT make (not
  in my owned-files list, and the session's initial `git status` was clean apart from
  `.obsidian/`) — almost certainly a concurrent subagent working another Round-6 item
  in the same working tree. I left those files untouched and did not stage them.
