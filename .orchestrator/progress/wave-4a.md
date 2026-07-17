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

## Status
- [ ] not started yet
