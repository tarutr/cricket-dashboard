# R6 — mechanical cleanups (2026-08-10)

Owner brief: `.orchestrator/columns-R3456-rulings.md` (R6 section). Display / dead-code /
cosmetic only — no query-logic change. Files owned: `src/drawer.js`, `src/drawerInnings.js`,
`src/paletteGroups.js`, `src/playerFilterEditor.js`.

## 1. Removed the orphan "Fielding phase" filter

Confirmed truly unreachable BEFORE touching anything: `paletteGroups.js`'s "Fielding Stats"
group (the only place a leaderboard condition row can be added from) offers exactly two
leaves — "Fielding Wicket Type" and "Wickets by Batting Position" (`fld_pos`) — grep across
the whole taxonomy builder shows zero references to `fld_phase`. Since `sessionAdded["fld_phase"]`
can only be set by a palette leaf calling `pickSingleton("fld_phase", ...)`, and no leaf ever
does, the row's `isPresent` can never become true and its `hasValue` (state.fielding.phases)
can never be written by anything reachable — the row, its editor, and its mount were 100%
dead on arrival. Removed:
- `src/drawer.js`: the `fld_phase` entry in `SINGLETON_TYPES`; the `fieldingPhaseController`
  mount; its `hasValue` / `clearSingleton` cases; its membership in `FIELDING_SLICE_KEYS`;
  its `.sync()` call; its `fieldingPhaseActive` active-count line; the now-unused
  `fieldingPhaseActive` / `mountFieldingPhase` imports.
- `src/drawerInnings.js`: the exported `mountFieldingPhase` function; the now-unused
  `FIELDING_PHASE_OPTIONS` import; updated the shared-factory doc comment (was describing
  "two pickers", now one) and left a pointer noting *why* it was dead and that
  `table.js`'s `buildFieldingSliceClauses` phase handling stays — it is still exercised by
  the player pop-up's own, separate per-row fielding editor (`playerFieldingEditor.js`,
  which has its own independent "Phase" control and does not import from `drawerInnings.js`
  at all, so it was never at risk here).
- `fld_pos` (Dismissed batter's position) — the sibling, reachable filter — is fully
  untouched; verified live in-browser (see Verified).

**Not touched (out of ownership scope):** `state.js`'s `fieldingPhaseActive()` and
`pills.js`'s `fld_phase` pill block are now ALSO orphaned (they read the top-level
`state.fielding.phases`, which nothing can write anymore since the only entry point —
this drawer row — never existed reachably in the first place). Both files are outside
this task's owned-file list (and `state.js`/`pills.js` weren't named in the brief), so I
left them as-is rather than risk colliding with a parallel wave. Flagged under Suggestions.

## 2. Dropped the nested bowling-style editor inside "Playing role"

`src/drawer.js`: removed the `prof-roleBowling` host div, the `roleBowlingHost` const, the
`roleBowlingSel` `mountSearchSelect(...)` block, and the `renderProfileEditors()` branch that
showed/hid it when `profile.roleGroup === "Bowler"`. The STANDALONE "Bowling style" filter
(`paletteGroups.js:284`, `bowlingSel` in `drawer.js`) is untouched — it still writes the same
`profile.bowlingType`. Updated two comments that referenced the old redundancy (the Role-editor
header comment, and the stale "Bowling style is no longer a standalone dropdown entry" line —
see item 4).

No loss of capability: `profile.bowlingType` is still fully settable, now via exactly one
control (the standalone filter) instead of two that fought over the same value.

## 3. Dates → day precision on the pop-up filter editor

`src/playerFilterEditor.js:216,218`: `type="month"` → `type="date"`, aria-labels "From
month"/"To month" → "From date"/"To date". Pure display change — `dateFrom`/`dateTo` were
already passed straight through as raw strings with no month-specific parsing anywhere in
this file or in `playerFiltersTab.js`/`playerFilterScope.js` (checked both), so widening the
native picker's precision needed no other change.

## 4. Fixed stale comments

- `paletteGroups.js` ~529-531: was claiming the Fielding Wicket Type count operator "is not
  yet wired" — false; each variant is a normal `leafMetric` leaf routing through `pickMetric`
  to the standard numeric condition editor exactly like any other metric. Reworded to say so.
- `drawer.js` ~112-113: was claiming "Bowling style is no longer a standalone dropdown entry
  (it is reachable via Role → Bowler...)" — backwards; it always was standalone (per
  `paletteGroups.js:284`) and now (post item 2) is the ONLY way to set it. Reworded.

## 5. Season "All seasons" toggle

No change, per ruling 11 (stays distinct from the general sentinel). Confirmed present and
untouched (`drawerInnings.js` "All seasons" toggle logic, ~line 1705).

## Verified

- `node --check` clean on all 4 touched files.
- App boot: zero console errors (fresh `cache:'reload'` fetch of all 4 files + hard reload).
- Anchors byte-identical on http://localhost:8000, scope Men/T20/International,
  2023-07-01→2026-07-02: **2,813 players**, top row Karanbir Singh **2,454** runs; **SA Yadav
  60 inns / 1,544 runs / 29.13 avg / 150.34 SR** (row 11).
- Leaderboard drawer, live: "+ Add condition" → Player Profile group shows "Playing role" and
  "Bowling style" as two separate, independent entries (as before). Added "Role", set it to
  "Bowler" — only a single "Bowler" select renders in the Role row, no third nested picker
  (previously a fine-bowling-style dropdown would appear here). Ran Search with Role=Bowler
  active — 277 players, pill reads "Bowler", zero console errors.
- Leaderboard drawer, live: "Fielding Stats" group in the palette shows only "Fielding Wicket
  Type" (Caught/Caught & bowled/Run-out/Stumped) and "Wickets by Batting Position" — no
  "Fielding phase" entry anywhere, confirming the removal didn't orphan a reachable path.
- Player pop-up → Filters tab → Add Filter Row: the Scope "Dates" row now renders as two
  `type="date"` day-precision pickers (`01/07/2023` to `02/07/2026`), not month pickers.

## Also fixed

Nothing beyond the brief's four items — this was a pure mechanical-cleanup pass with no
incidental defects tripped over.

## Suggestions (not built)

- `src/state.js`'s `fieldingPhaseActive()` export and `src/pills.js`'s `fld_phase` pill block
  (imports `fieldingPhaseActive`/`FIELDING_PHASE_OPTIONS`, renders a pill keyed on
  `state.fielding.phases`) are now fully orphaned by this removal — nothing in the reachable
  UI can ever set `state.fielding.phases` at the top level anymore. Both files are outside
  this task's owned-file list, so left as-is. A follow-up could remove them for full
  symmetry; low priority (genuinely inert, not user-visible, no query-path risk).

## Concerns

None. Nothing here touched `buildQuery`/`buildMatchupQuery`/`buildScopeClauses` or any
`sqlExpression`; every removal was traced to zero reachable call sites before deletion, per
the brief's STOP-rule.
