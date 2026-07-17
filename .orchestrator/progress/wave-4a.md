# Wave 4a — instant/pending correction + pills

Branch: polish-b1-mechanical. Owns: src/table.js, src/main.js, src/pills.js, styles.css (root).

## Plan (from handoff + design-plan R4 4a)
- A1: sort / columns-picker / drag-reorder / (mobile name-expand verify) / player-search
  INSTANT & stop lighting Search; preset / filters / dates / Vs stay PENDING.
- A2: pills render from PENDING (live store), not the frozen applied snapshot.
- A3: recolour pin pills (`.pill--pinned`) red -> steel-blue.
- A4: pill soft-delete with undo (× -> red outline + "+", + restores) for ALL pills.

## Key design decisions
- serializeQueryState (table.js dirty fn): DROP `sort` (nothing pending changes sort,
  so excluding it stops sort from lighting Search). KEEP `columns` (the PENDING preset
  dropdown also sets columns and must keep lighting Search) — instead the INSTANT
  Columns picker + drag-reorder advance main.js's appliedState via a new onColumnsApplied
  callback so they read "not dirty". This is exactly why the spec keeps picker vs preset
  distinct.
- Columns picker ADD needs data not in lastRows (buildQuery only SELECTs visible cols) ->
  requery, but against the FROZEN applied scope (lastLoadedState), NOT the live store, so
  pending scope edits never leak (rows stay frozen). load() gains an optional scopeState arg.
- Player-search "instant": the ESCAPE HATCH — making the pin PILL appear instantly is
  delivered by A2 (pills reflect pending). The pin's ROW stays pending until Search
  (rows-frozen rule). No pinPlayer/data-fetch change. FLAG to owner.
- Pill soft-delete: staged Map inside mountPills; × stages + removes from pending store
  (lights Search honestly), + restores; cleared on Search/Clear commit via clearStaged().
  Staged pills render after active ones (position not preserved — noted).

## Status: COMPLETE + verified in-browser (localhost:8000), zero console errors.

### Files changed
- src/table.js: serializeQueryState drops `sort`; mountTable takes onColumnsApplied;
  applySortKey now INSTANT (client re-sort + re-render, no Search light);
  reorderColumns advances applied snapshot (drag no longer lights Search);
  new applyColumnsInstant() (frozen-scope requery, ns-match + phase-eligibility guards);
  load() gained optional scopeState arg; 3 columns-picker handlers -> applyColumnsInstant.
- src/main.js: pills mount from LIVE store (A2); clearStaged() in runSearch + clearAll (A4);
  onColumnsApplied callback advances appliedState.columns.
- src/pills.js: keys + restore() per pill; staged Map + stable orderList; ×=soft-delete,
  +=restore; clearStaged(); getState default = live store.
- styles.css: --color-steel* tokens; .pill--pinned -> steel-blue (A3);
  .pill--staged red outline (A4); .pill__x--restore hover.

### Verified on screen (Men/T20/Intl, 2023-07-01..2026-07-02)
- Anchors: 2,813 players; top Karanbir Singh 2,454; SA Yadav 60/1,544/29.13/150.34. EXACT.
- INSTANT (no Search light): sort (SR/runs/name + toggle), columns add (boundary_pct) +
  remove, drag-reorder (average->end), mobile name double-tap expand.
- PENDING (lights Search, table frozen): preset (Boundaries), Vs (Spin), date change.
- Pills: A2 pin + filter pills appear immediately from pending; A3 pin steel-blue
  (bg #e8eef5 / text #2f4761); A4 × -> red outline (#9c2b2b) + "+", + restores,
  Search commits the removal (pill gone).

### FLAG for later waves
- Player-search "instant" = pill appears instantly (A2); pin ROW stays pending until Search
  (rows-frozen rule; escape hatch taken, pinPlayer/data-fetch untouched). Wave 4b/4d may
  revisit if owner wants row-instant.
- Staged pills render AFTER active ones... actually kept in-place via orderList; noted.
- appliedState.columns advanced by onColumnsApplied — later waves touching appliedState
  should know columns can differ from a pure Search snapshot after an instant column edit.
