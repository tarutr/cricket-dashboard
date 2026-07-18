# Wave C / item 4f — popup dropdowns (pf-dateFrom/pf-dateTo/pf-opposition/pf-vs)

## Done
- src/playerFilters.js: converted the four native `<select>`s (Date From, Date
  To, Against/opposition, Vs bowling style) in the player-popup's own Filters
  drawer to `src/searchSelect.js`'s single-pick `mountSearchSelect`. Same
  option lists, same `pending.dateFrom/dateTo/opposition/vs` fields, same
  Apply/Clear/open() timing. Markup: 4 `<select class="select" data-role=...>`
  → 4 `<div data-role=...>` host elements (mountSearchSelect owns their inner
  markup/classes). Batting position untouched (stays the custom checkbox
  dropdown; not one of the four named controls).
- src/searchSelect.js: added `portal` support to `mountSearchSelect` (the
  single-pick variant) — it had none before, only `mountSearchMultiSelect`
  did. Ported verbatim: panelHome tracking, `positionPanel()`,
  `portalOpen()`/`portalClose()`, scroll/resize listeners, Escape
  stopPropagation-when-portaled, `onDocClick` panel-aware check, `destroy()`
  portalClose(). Needed because `.player-filters-drawer__panel` is
  `overflow-y: auto` — same clipping risk the multi-select's portal option
  was built for (see that JSDoc note). All four mounts pass `portal: true`.
- Removed now-dead `optionsHTML()` (native `<option>` HTML builder) and the
  `monthOptionsHTML` import; replaced with local `monthOptionsList()` (returns
  `{value,label}` pairs, duplicated-on-purpose from playerSections.js's own
  copy, same precedent already used for POSITIONS) and `withStaleSelected()`
  (preserves a stale Opposition pick not in a fresh fetch — same behaviour the
  old `optionsHTML()` gave, kept ONLY for Opposition, matching original: Vs
  never had this fallback).
- Also fixed (small, discovered while converting): clicking Clear reset
  `pending.opposition`/`pending.vs` in memory but the native selects never
  visually cleared until the whole drawer was reopened (dates/positions DID
  reset visually via `renderAll()`; opposition/vs did not — `renderAll()`
  never touched them). Now `oppositionSelect.setValue(null)` /
  `vsSelect.setValue(null)` run in the Clear handler too.

## Verified
- `node --check src/playerFilters.js` → pass.
- `node --check src/searchSelect.js` → pass.
- `git status` confirms only these two files touched by this task (see
  gotcha below for why git history looks messier than that).

## Gotcha (flag for orchestrator)
Shared working directory with concurrent Wave C siblings: the 4d-A5 agent's
commit `40ad503` ("Keep Selected Columns' toggle") ended up containing the
**entire** playerFilters.js diff for this task, plus a small slice of the
searchSelect.js JSDoc/param addition — almost certainly a broad `git add`
that swept up my uncommitted work. Verified nothing was lost: `git diff
df4a0ac 40ad503 -- src/playerFilters.js` is byte-for-byte exactly my intended
change, no foreign edits mixed in. I committed the remaining searchSelect.js
piece (the actual portal implementation) separately as `cd351ba`. Net effect:
my file-scope is still exactly {playerFilters.js, searchSelect.js} as briefed,
but the commit log doesn't cleanly show playerFilters.js under its own
message — worth a mention if anyone audits commit-to-task traceability later.

## Cosmetic loss (flagged, not fixed)
The old Vs `<select>` used two `<optgroup>`s ("Pace / spin" vs "Bowling type")
to visually cluster the coarse buckets from the specific bowling types.
searchSelect.js's single-pick list is flat (no group-header support) — this
is inherent to converting to the shared component, not something I added
group support for (task guardrail: only add to searchSelect.js if a required
variant is genuinely missing; grouping headers are cosmetic, not required).
Order preserved (Pace, Spin, then specific types alphabetically).

## Next
None — the four conversions are complete. Orchestrator to do the in-browser
verification pass (not done here per task instructions: "do NOT drive a
browser — orchestrator owns it").
