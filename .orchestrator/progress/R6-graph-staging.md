# R6 — Graph Filters popup fully staged (#5 + #10) — decision 55

Branch: `polish-b1-mechanical`. Owner file: `src/graph/graph.js` only.

## What was built
Part 1 (live-refresh) + Part 2 (fully staged behind "Apply to graph"), via the
recommended buffer-store approach — confined entirely to `graph.js`; `filters.js`,
`drawer.js`, `main.js`, `table.js`, `state.js`, `metrics.js` are BYTE-IDENTICAL.

- A private `bufferStore = createStore({ ...statsStore.get() })` is created at graph
  mount. The graph Filters popup's `mountFilters` / `mountFilterDrawer` are bound to
  the BUFFER, not the shared store — so every popup edit is staged.
- `openGraphPopup()` re-seeds the buffer from the shared store on each open (snapshot
  carries `advancedByDiscipline`, so `createStore.set()` treats it as a wholesale
  replace — no per-discipline swap). Close-without-Apply discards the buffer.
- Live-refresh: `bufferStore.subscribe(() => { if (open) graphDrawerController.sync(); })`
  mirrors main.js's store.subscribe → drawer.sync(). A discipline/Vs flip inside the
  popup immediately rebuilds the drawer's metric list, "+ Add condition" list, and any
  shown condition into the buffer's `effectiveNamespace` (#5). The filter bar selects
  self-sync via their own handlers, exactly like Stats.
- `applyGraphFilters()` COMMITS the buffer's scope fields to the shared store in ONE
  atomic `store.set(...)` (patch INCLUDES `advancedByDiscipline` → managesArchive, no
  double-swap), THEN runs the existing `pruneIneligibleState` + sort-key fallback +
  `onScopeChanged()`. The commit list is exactly the fields the popup can edit; view /
  sort / minInnings / pinnedPlayers / columns / search / keepColumns are left on shared.

## Verified on localhost:8000 (zero console errors on both tabs)
- Stats anchor reproduced before + after all graph activity: 2,813 players / Karanbir
  Singh 2,454 / SA Yadav 60·1,544·29.13·150.34.
- #5: popup flip Batting→Bowling rebuilds live — batting "Runs" condition vanished,
  "+ Add condition" list switched to bowling vocab (Wickets, Economy Rate, Best Bowling…).
- #10: flip→close-without-Apply then roster "Best"+Update → chart stays coherent under
  BATTING (Runs top 15, Karanbir 2,454, SA Yadav 1,544; no "pick a metric"). Then
  open→flip→Apply → everything switched to bowling together (metric picker→bowling,
  roster reseeded 2,813 batters → 2,049 bowlers, "Wickets — top 15" drew).
- #4: "Average (vs style)" absent in plain batting → appears under Vs=Spin+Apply →
  gone after clearing Vs+Apply.
- Part 2: flipping discipline in the graph popup WITHOUT Apply leaves the Stats scope
  batting (verified the Stats popup discipline select + the intact 2,813 batting table).
- Stats unaffected: Stats discipline toggle→Bowling + Search still works (2,049 bowlers,
  Ali Dawood 113), toggle back to batting restores 2,813.
- Independent DuckDB check (not the app's aggregation shape): SA Yadav vs Spin over
  matchup_batting = 38 inns / 454 runs / 322 balls / SR 140.99 — matches the anchor;
  the graph plots via the same (unchanged) buildMatchupQuery path.

## #6 finding ("Reset to full player set")
Appears RESOLVED by this fix. The reset handler is `seedSelection({force:true})`, which
re-derives from the COMMITTED shared scope. Before this fix, flipping discipline in the
popup wrote to the shared store instantly, so the committed discipline could drift out of
sync with the seeded roster — Reset then re-derived against the drifted discipline (the
investigator's hypothesized root). With staging, discipline only commits at "Apply to
graph", which reseeds the roster atomically, so that drift is structurally impossible.
Verified: dirtying the batting roster then Reset restored the full batting pool
(15 of 2,813, Top Names), reset link greyed, chart still batting — correct + discipline-
consistent. Could NOT reproduce any "wrong player set". If #6 had a different root it is
not this fix's concern (next task); I made no #6-specific change.

## Gotchas
- Custom searchSelect / native selects resist synthetic clicks — drove options via real
  `.search-select__option` dispatch and `select.value` + `change` events.
- `db.js` `query()` returns `{ rows, ms }` (no Arrow `.toArray()`); SUM → BigInt → Number().
- The Stats toolbar Filters button is `[data-role="toolbar-filters-btn"]` (text "Filters0"
  with a badge count), NOT an exact "Filters" match.

## Out of scope (not touched)
- "Batting hand" still shows in the bowling add-condition list — that is decision 54
  (Round-6 #2), a SEPARATE task, deliberately left alone.
