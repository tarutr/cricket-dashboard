# T-F2 — Extract the shared Columns picker (progress)

Branch `ball-layer`; owns `src/table.js` (extract FROM) + NEW `src/columnsPicker.js` (extract INTO).
No git. UI-only; numbers sacred.

## Approach (decided after full read of the closure)
The genuinely-reusable, both-consumer picker is the **Columns POPOVER** (the checkbox picker +
dismissal-% / rare-dismissals disclosure). It is extracted into `src/columnsPicker.js` behind a
get/set contract:

    createColumnsPicker({ getColumns, setColumns, getDiscipline, getFormats })
      -> { mount(triggerEl), open(anchorEl), close(), refresh(anchorEl) }

The popover's change handlers, which used to call `applyColumnsInstant(curNs, cols)` directly,
now call `setColumns(cols)`. The leaderboard passes `setColumns = cols => applyColumnsInstant(ns, cols)`,
so behaviour is byte-identical.

## Scoping decision (flagged for orchestrator — see report)
The brief lists four things as "the picker": the popover, `applyColumnsInstant`, the preset
`<select>` wiring, and column drag-reorder. Only the **popover** is a surface-agnostic UI
component. The other three are the LEADERBOARD's host-specific implementation of the
column contract and stay in `table.js`:
- `applyColumnsInstant` = the leaderboard's `setColumns` (frozen-scope requery via
  `lastLoadedState`/`load`/`onColumnsApplied`); it IS the contract impl, passed in.
- preset `<select>` = a toolbar control with DELIBERATELY DIFFERENT semantics
  (PENDING / lights Search) vs the popover (INSTANT / no Search light — see table.js:2083);
  synced inside `syncToolbar` with matchup/results gating. Merging it into one picker would
  risk collapsing those two intended behaviours. It can share via COLUMN_PRESET_DEFS +
  activePresetKey (already exported) with each host's own select.
- column drag-reorder (`wireColumnDrag`/`reorderColumns`) = table-body machinery
  (moves `<th>`/`<td>`, calls `renderLoaded`, mutates `lastLoadedState`) — per-table, not per-picker.

Both share via the get/set/getDiscipline contract (a preset pick / a drag = `setColumns(cols)`).

## Steps
- [x] Write src/columnsPicker.js (popover + dismissal helpers, get/set contract).
- [x] Rewire table.js: create picker instance; replace 4 popover fns + call sites.
- [x] Remove now-unused imports (DISMISSAL_KINDS, metricDisplayLabel) from table.js.
- [x] node --check both files — both OK.

## DONE
- New: src/columnsPicker.js — createColumnsPicker({getColumns,setColumns,getDiscipline,getFormats})
  -> {mount(triggerEl), open(anchorEl), close(), refresh(anchorEl)}. Own openState + lastTrigger
  per instance (two consumers never interfere). Imports eligibleMetrics (state.js),
  DISMISSAL_KINDS + metricDisplayLabel (metrics.js), escHtml (html.js).
- table.js: removed positionColumnsPopover/closeColumnsPopover/refreshOpenColumnsPopover/
  openColumnsPopover + the dismissal helper block + openColumnsPopoverState; added the picker
  instance + rewired 5 call sites (mount @ensureSkeleton, close @renderPrompt, refresh @enterView
  + @load success + @load error). All popover change handlers now call setColumns instead of
  applyColumnsInstant directly; applyColumnsInstant STAYS as the leaderboard's setColumns impl.
- Query builders (buildMatchupQuery@288, conditionToHaving@624, advancedToHaving@703,
  buildQuery@898) untouched — all sit before the first picker edit (dismissal block ~1267);
  only edits above that line were the 2 import lines. NO styles.css change (all class names kept).
- Left in table.js by design (NOT the popover): preset <select> wiring (pending semantics) +
  wireColumnDrag/reorderColumns (table-body machinery). Both share columns via the same get/set
  contract. See report.
