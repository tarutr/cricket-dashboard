# Polish B1 mechanical — pin marker (Graph roster) + date-required legibility

Branch: `polish-b1-mechanical`. Two owner-approved, display-only UX additions.

## Item 1 — pinned-player marker in the Graph's player roster dropdown

- The roster picker is NOT a `mountSearchMultiSelect` (the brief's premise was
  slightly off) — it's the hand-built `renderPlayerList()` / `.graph-roster-item`
  markup in `src/graph/graph.js` (the "N of M selected" dropdown). Implemented
  the marker directly there instead of inventing a `pinnedValues` option on a
  component that isn't actually used for this control.
- Added `pinnedIdSet()` (reads `store.get().pinnedPlayers`) and `paintPinnedRows()`
  (patches `.is-pinned` class + toggles a pin-icon span in place — same
  "patch, don't rebuild" pattern as the existing `paintBadges()`), called at the
  end of `renderPlayerList()` and from a new `store.subscribe(...)` in `mountGraph`
  guarded by a sorted-id-signature compare so it only repaints on an actual pin
  add/remove, not every keystroke elsewhere.
- CSS: `.graph-roster-item.is-pinned` (background `--color-accent-tint`) and
  `.graph-roster-item__pin-icon` (color `--color-accent`), added to styles.css.
  Icon glyph is the same pushpin SVG table.js's PIN_GLYPH uses, duplicated as
  `ROSTER_PIN_GLYPH` (table.js doesn't export it; same "duplicate rather than
  reach across ownership" precedent this file already uses for wireDropdown()).
- Verified: pin Karanbir/SA Yadav in Stats -> Graphs roster dropdown shows red
  pin icon + red row tint; unpin clears it live (no tab switch needed, via the
  store subscribe).

## Item 2 — date-required legibility (table.js + styles.css)

**2a — edge-triggered pulse on the empty date field.** `syncToolbar()` already
computed `playerPicked && !dateFrom/!dateTo` for the static `.needs-input`
outline. Added `prevDatesNeedInput` (module-level, reset in `teardownSkeleton`)
tracking the combined `playerPicked && (!dateFrom || !dateTo)` condition;
`pulseDateFields()` (new) fires only on the false->true edge, adding/removing a
`.date-pulse` class (with a forced-reflow restart) on whichever field(s)
currently carry `.needs-input`. CSS keyframe `toolbar-date-pulse` in styles.css,
one-shot (`animation: ... 1`), muted under `prefers-reduced-motion: reduce`
(static outline unaffected).

**2b — blocked-Search click shows a red hint, no query.** The Search button
switched from native `disabled` to `aria-disabled="true"` + a new `.is-blocked`
class (CSS reproduces `.btn:disabled`'s exact look, including hover) — a
natively-disabled button emits no click event, so detecting the blocked click
requires it to stay a real, focusable, clickable button. The click handler
checks `aria-disabled`: if blocked AND dates are actually missing, it sets
`blockedHintVisible = true`, repaints, and pulses the date field(s); if blocked
only because nothing changed since the last Search (dates ARE set), it's a
silent no-op, matching the old native-disabled behavior exactly. If active, it
searches byte-for-byte as before.

Placement: reused the existing `table-body-hint` element (the "Set your
filters, then press Search" prompt) for the red hint whenever no table is
shown yet — never a second element there. Added ONE new small element,
`.table-toolbar__blocked-note`, directly under the toolbar, for the rare case
a table is already displayed (dirty + date cleared) — the table itself is
never touched. Both clear automatically the moment the block resolves (checked
fresh every `syncToolbar()` pass), no manual dismiss needed.

## Verification

- `node --check` on table.js, graph.js, state.js (state.js untouched — a
  temporary debug instrumentation pass used during testing was fully reverted;
  `git diff src/state.js` is empty).
- Anchors reproduced exactly off the standing scope (Men/T20/International,
  2023-07-01 -> 2026-07-02): 2,813 players; Karanbir Singh top row, 2,454 runs.
- 0 console errors through the whole test pass (pin/unpin, pulse edge-trigger,
  blocked-click hint, enabled Search, mobile 380px).
- Confirmed via a real DOM-mutation-count check that the pulse fires exactly
  ONCE per pin action, not spammed by subsequent unrelated store changes
  (verified with a window counter in the app code — NOT via console.log, which
  the browser-pane test harness appears to double-report; that double-report
  is a testing-tool artifact only, not a real app defect, and left no trace in
  the shipped code).
- Mobile (380px): both items verified visually — outline, pulse, and red hint
  all render correctly; table itself scrolls horizontally as already specced.

## Files changed

- `src/graph/graph.js` — roster pin marker (item 1)
- `src/table.js` — date-required pulse + blocked-Search hint (item 2a/2b)
- `styles.css` — CSS for both items

No query, metric, or `buildQuery`/`buildScopeClauses` changes. Display-only,
as scoped.
