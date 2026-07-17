# Wave B1 polish — progress notes

## Task: search-select checkbox — clean tick (styles.css only)

**Brief:** the searchable multi-select dropdowns in the Filters popup (Team /
Opposition / Event / Venue, `mountSearchMultiSelect` in `src/searchSelect.js`)
showed selection as a chunky solid dark-red filled square with a white tick.
Owner called it "very ugly." Task: keep a checkmark as the selected-state
indicator, but make it clean/well-placed in the editorial off-white/ink-navy
aesthetic. Display only — no change to toggle behaviour or state.

**What changed (styles.css only, `.search-select__check` rules ~L2566–2601):**
- Box shrunk 1rem → 0.85rem, corner radius softened (var(--radius-sm) → 3px).
- Unselected: border colour softened `--color-line-strong` → `--color-line`
  (a lighter tan line), background stays transparent — quiet, not a heavy
  bordered swatch.
- Selected: **no more solid accent fill.** Background stays transparent;
  only the border turns accent-red and a thin accent-coloured tick (border-
  trick, 1.5px stroke, no white-on-fill) is drawn inside. The accent is now
  spent only on the border + tick, not a filled block — "accent used
  sparingly" per the design brief.
- Disabled-row rule (`--color-line`) unchanged.
- No JS touched — `src/searchSelect.js` markup already supported this purely
  via CSS; kept the `search-select__check` element and its `is-selected`
  gating exactly as-is.

**Verified (localhost:8000, browser pane, viewport 800x450):**
- Opened Filters popup → Advanced Filters → added a Team condition → opened
  the Team dropdown.
- Unselected rows (India before selecting, later Sri Lanka/Pakistan/etc. per
  DOM check) show the new slim, quiet outline box — no chunky red square.
- Selected India + England + Australia (toggled via row click, confirmed
  `.is-selected` class present in DOM): each shows a clean thin accent tick
  on a transparent field, border accent-coloured — no solid fill block.
  Screenshot matches the target scenario described in the brief exactly.
- Un-toggled India again: box reverted cleanly to the quiet unselected
  state, "3 teams" pill label updated to "2 teams" — toggle logic
  unaffected (confirmed via DOM `is-selected` before/after, not just visual).
- Console: zero errors (`read_console_messages` onlyErrors clean) after the
  styles.css reload + hard page reload.
- `node --check src/searchSelect.js` — OK (file untouched, checked anyway
  since it's the module documented in the brief).
- No `[data-theme="dark"]` block exists yet anywhere in styles.css/HTML/JS
  (grepped) — dark mode isn't implemented in this codebase yet, so this was
  verified in light theme only. All new rules use existing `--color-*`
  custom properties (`--color-line`, `--color-accent`), so a future dark
  override just needs to re-declare those variables, per CLAUDE.md's
  "build all colors as CSS custom properties" instruction — nothing here
  hardcodes a light-mode-only value.

**Also fixed:** nothing incidental found in scope.

**Suggestions (not built, flagged only):**
- The checkbox sits at the row's far left before the label, which is the
  conventional reading order for a multi-select checkbox row; the brief's
  "and its placement" language reads as *describing* the old chunky box's
  position, not asking to relocate it, so position was left as-is. Flagging
  in case the owner meant something more (e.g. moving it to the trailing
  edge) — did not build this since it would exceed the stated brief.
- Same slim-tick treatment could be extended to any other checkbox-style
  control in the app for visual consistency (none obviously exist beyond
  this component), but that's outside this task's file ownership.

**Concerns:** none. Change is CSS-only, additive, and scoped to the one
component named in the brief.

Commit: `ee2b1dc` (wip) on branch `polish-b1-mechanical`.
