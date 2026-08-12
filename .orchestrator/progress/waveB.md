# Wave B — Dropdown & row UX (columns-popup rework)

Branch: ball-layer. NO git (orchestrator commits). Anchors baseline verified LIVE before edits:
2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34.

## Status per fix
- **#5 (inline sub-options → drill-in)** — INVESTIGATED, NO CODE CHANGE (STOP-RULE flag).
  Premise does NOT hold in the current build. Verified empirically (JS DOM probe) on all
  three surfaces: leaderboard filter "+ Add condition" palette, leaderboard column
  dropdowns, and pop-up "Add Filter Row" palette. Every multi-option entry is ALREADY a
  drill-in family (`.palette__variants` `display:none` until clicked) — "vs bowling style"
  (12 variants), "Dismissal Type" (12), "% Runs in…" (8), "Match/Toss Result", etc. Column
  dropdowns are flat leaves + composer entries that open the compose editor on pick (already
  the "top-level entry → reveals variants" pattern). Toolbar Vs is a native `<select>`. No
  code path renders variants inline (confirmed reading paletteGroups.js/addPalette.js/
  columnsPicker.js). Matches the plan's documented cache-ghost pattern (Wave 0 cache fix).

- **#35 (composer EDIT → dropdowns; count/% out of editor)** — DONE. `src/columnsPicker.js`.
  - EDIT mode now renders a single-select `<select>` of dimension values (compose-dim-select),
    not the tick grid. ADD keeps the multi-tick grid. `composeEditorBody` `single` branch.
  - `AXIS_ONLY_COMPOSER_KINDS = {runsource, wickettype}` — their compose editor shows NO
    stat/axis `<select>` (count/% is only the per-row toggle); sel defaults to count on ADD,
    preserved silently on EDIT. `composeEditorHTML` gates options.
  - Wired the dim `<select>` change handler in `wireComposeEditor`.
  - CSS: `.cols-compose-editor__dim`.

- **#6 (filter rows adopt columns-row design + 75%/full width)** — DONE. `styles.css`.
  - `.cond-row` font-size 0.9rem (matches `.cols-chosen-row__label`); remove × pushed hard
    right (`margin-left:auto`); `.cond-row__line` width:100%.
  - Shared rule: `.cond-row, .cols-chosen-row, .cols-param-row, .cols-compose-editor`
    width:75%; `@media (max-width:640px)` width:100%.

- **#21 (number filter inputs sized + centred)** — DONE. `styles.css`.
  - `.cond-row__value-input` width 4.25rem + text-align center (was flex 0 1 6rem).
  - `.cond-row__n-input` width 4rem + center; `.dwin__num` width 4rem + center.

- **#23 (add-more dropdowns open in fixed full-view panel like graph)** — DONE. `src/addPalette.js`.
  - Rewrote `portalPanel.position()` to reuse the graph's `positionFixedPanel` flip
    technique: measure natural `scrollHeight`, open UP when it doesn't fit below (else the
    roomier side), clamp maxHeight to that side. Added `bottom` to the close() reset list.
    Reaches BOTH the filter "+ Add condition" and the four column dropdowns (both surfaces).

- **#21 pop-up parity** — also applied to `.pfe-cond__val` (pop-up "Add Filter Row" numeric
  box): width 4.25rem + text-align center (was 5.5rem left). Verified computed = 68px, centered.

## VERIFICATION — COMPLETE (live, localhost:8000, hard reloads)
- Anchors held throughout: 2,813 players / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34
  (leaderboard table + pop-up Overview). No query builder touched → structurally safe.
- #23: leaderboard column dropdowns + pop-up column dropdowns flip UP when low (verified
  styleBottom/maxHeight + fully in-viewport, full 29-row list). Filter "+ Add condition" too.
- #35: leaderboard inline picker — ADD Phase = stat select + 3 checkboxes (no radios); EDIT =
  stat <select> + dimension <select> (compose-dim-select), 0 checkboxes/radios, Save swaps in
  place. Runs-by-Source (axis-only): ADD/EDIT have NO count/% select; per-row #/% toggle present.
- #6/#21: filter rows 0.9rem + 75% width + × hard-right; number box 4.25rem centered; columns
  rows 75% (both surfaces); pop-up pfe-cond__val 68px centered.
- Console: only pre-existing 404s (favicon.ico + ESPN headshots) — NO app-code errors.
- node --check: addPalette.js OK, columnsPicker.js OK. CSS braces balanced (813/813).

## FILES TOUCHED: src/addPalette.js, src/columnsPicker.js, styles.css. (NO git — orchestrator commits.)
