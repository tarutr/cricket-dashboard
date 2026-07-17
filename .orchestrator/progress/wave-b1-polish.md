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

## Task: format-switch team wipe fix + player-popup button renames

**Brief:** (A) `src/filters.js`'s FORMAT checkbox handler (~L595) cleared
`teams: []` on every format change — undocumented, and team options are
scoped by gender + team-type only (`searchTeams` takes no format), so a
selected team stays valid across formats. Remove the wipe. (B) Player
profile popup header button "Filters" → rename to "Player Filters". (C)
Same header's greyed-out "Graph this player" → rename to "Player Graphs",
text only, disabled state/behaviour untouched.

**What changed:**
- `src/filters.js` (~L595): `store.set({ formats: [...set], teams: [] })` →
  `store.set({ formats: [...set] })`. One line. Nothing else in the file
  touched — `buildScopeClauses`/`buildCoreScopeClauses` untouched, the
  TEAM-TYPE handler's own (documented, correct) `teams: []` wipe at ~L636
  left exactly as-is.
- `src/playerPage.js` — **not** `playerSections.js`/`playerFilters.js` as
  the brief guessed. The actual header-button markup (`headerRowHTML()`,
  ~L160–188) lives in `playerPage.js`; `playerSections.js` only owns tab
  content, `playerFilters.js` only owns the popup-local filters drawer
  (whose own `<h3>` title is separately "Filters" — left untouched, it's
  a drawer heading, not the header button named in the brief). Renamed
  the two button label strings only: `Filters` → `Player Filters` (kept
  the adjoining `filter-open-btn__count` badge span), `Graph this player`
  → `Player Graphs`. No markup structure, classes, data-roles, disabled
  logic, or click wiring touched.

**Verified (localhost:8000, browser pane, viewport 1280x800, cache-reloaded
both changed files before reload):**
- `node --check src/filters.js src/playerPage.js` — OK.
- Console: zero errors on boot and throughout.
- **Team-persists-across-format-switch:** opened Filters drawer, set dates
  01/07/2023–13/07/2026, added Team condition → checked India (pill "Team:
  India" appears). Opened Format dropdown, checked 50 Over (ODI) alongside
  T20 ("50 Over +1") — Team: India still shown. Unchecked T20 so format is
  ODI-only — Team: India still shown. Ran Search: 33 players, sane India-ODI
  batting list topped by V Kohli (1,844 runs) — team filter genuinely
  applied, not just visually surviving.
- **Legitimate pruning still works:** while format was ODI-only, added
  condition "ODI Powerplay Strike Rate ≥ 100" (phase metric, correctly
  offered only because format was exactly ODI, per rule 9). Switched format
  to Red Ball (Test) — as soon as format left "exactly ODI" the phase
  condition disappeared from Advanced Filters (pruned, per `pruneIneligibleState`
  in state.js — untouched by this task) while Team: India remained. Ran
  Search on Test-only + Team: India: 31 players, sane Test list topped by
  YBK Jaiswal (2,511 runs, BPD column shown instead of SR — correct for
  Test format).
- **Anchors (independent, after Clear + fresh scope):** Men/T20/International,
  01/07/2023–02/07/2026 → **2,813 players**, row 1 Karanbir Singh **2,454**
  runs. SA Yadav row: **60 inns / 1,544 runs / 29.13 avg / 150.34 SR** — all
  exact. Opened SA Yadav's player popup independently — its own stat tiles
  also show 60 / 1,544 / 29.13 / 150.34, second confirmation via a different
  code path.
- **B/C:** SA Yadav's popup header shows "Player Filters" and "Player
  Graphs" (still visibly greyed/disabled, tooltip "Coming soon — graphing a
  player from their profile isn't available yet." unchanged).

**Also fixed:** nothing incidental found beyond the three requested changes.

**Suggestions (not built):** none beyond what's below under Concerns.

**Concerns:**
- The brief said "own ONLY filters.js, playerSections.js/playerFilters.js"
  and to find the button "likely" in one of those two — but the actual
  button markup is in `src/playerPage.js`, a file not on that ownership
  list. Renaming the two labels required editing `playerPage.js` instead.
  This is a pure text-only change (no logic, no structure) so I made the
  call rather than stopping, but flagging it since it's a file-scope
  deviation from the literal brief — please confirm this is acceptable
  scope, or redirect if a parallel agent also touches `playerPage.js`.

Commit: (pending — see next commit on branch `polish-b1-mechanical`).
