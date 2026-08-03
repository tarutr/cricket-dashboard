# T-F1 — Tab scaffold (Overview | Filters) + retire the "Player Filters" overlay

Branch `ball-layer`. Owned files: `src/playerPage.js`, `src/playerFilters.js` (deleted),
`src/playerData.js` (overlay-application parts), `src/playerSections.js` (overlay parts),
`src/playerPopup.js` (stale-comment only), `styles.css`, new `src/playerFiltersTab.js`.

## Done

- **(a) Overlay retired entirely** (decision 70):
  - Deleted `src/playerFilters.js` (the whole drawer module — `mountPlayerFilters`,
    `fetchOppositionOptions`, `fetchVsTypeOptions`, `monthOptionsList`, etc). Confirmed via grep
    that nothing outside this file imported anything from it, so nothing needed relocating.
  - `src/playerData.js`: removed `applyOverlay`, `requestedDims`, `overlayDateClauses`,
    `overlayVsClause`, `PLAYER_SECTION_SUPPORT`, `fetchBattingCoreVs`, `VS_CORE_KEYS`. Every
    exported `fetch*` function dropped its `overlay` parameter and now builds its SQL from the
    plain page-scope `where` (`whereFor(state, idCol, playerId)`) directly — no `ov.where`/
    `ov.unsupported` indirection. SQL text is unchanged char-for-char versus the pre-overlay
    (overlay=null) path — see the report's before/after diff.
  - `src/playerSections.js`: removed `overlayPillsHTML`; `scopeLine(state, overlay)` →
    `scopeLine(state)` (the `overlay` arg was already unused in the body). Also removed the now-
    orphaned `monthLabel` helper (its only caller was `overlayPillsHTML`). Left
    `sectionOrUnsupported`/`wholeTabUnsupportedHTML`/`unsupportedNoteHTML`/`dimDisplayLabel`/
    `DIM_LABELS`/`howOutVsHTML`/`VS_DISMISSAL_KEYS`/the `isVs` branches in `normalizeBattingCore`
    and `battingGridHTML` in place, UNCHANGED — they're now unreachable dead code (nothing can
    ever set `.unsupported` or `core.source === "matchup_batting"` again) but touching them meant
    editing Tab-1's rendering functions beyond what the brief named; flagged under Concerns/
    Suggestions below instead of removed unilaterally.
  - `src/playerPage.js`: removed the `mountPlayerFilters` import/mount, the `filtersHost` sibling
    div, the "Player Filters" header button + count badge, `activeOverlayCount`, `clearOverlayDim`,
    `renderFiltersCount`, the `overlay` variable, and `cacheKeyFor(state, overlay)` (now just
    `scopeKeyFor(state)` — nothing else can invalidate the cache). `fetchDisciplineData` no longer
    takes/threads an `ov` param.
  - `src/playerPopup.js`: no functional overlay wiring existed here — fixed one stale comment
    referencing the deleted `playerFilters.js`/`.player-filters-drawer`.
  - `styles.css`: removed `.player-filters-drawer*` (the whole block + its mobile media query),
    `.player-page__filters-btn`, `.filter-open-btn__count` (now-dead — its only consumer was the
    retired button), `.player-page__filter-pills`, `.player-page__reset-filters`, and the
    `.player-filters-drawer__backdrop` selector out of the shared backdrop rule. Updated stale
    comments (header-row control count, `.player-graph-chooser`'s z-index note).

- **(b) Tab scaffold added**:
  - `pageShellHTML` now renders a tab bar (`tabBarHTML()`) between the scope line and the body:
    "Overview" (default-active) | "Filters". Overview panel = the pre-existing
    `discipline-body` div, unchanged. New `filters-body` div (`hidden` by default) holds the
    Filters panel.
  - New module `src/playerFiltersTab.js` exports `mountPlayerFiltersTab(container, { store,
    playerId, discipline, pageState }) -> { show(playerId, discipline, pageState), destroy() }`.
    Shell renders only `<p>No filtered rows yet</p>`. Full contract documented in the file's own
    header comment.
  - `playerPage.js` wiring: `mountFiltersTab()` (re)mounts the Filters-tab instance every time
    `pageShellHTML` is freshly rendered (player switch, scope change, retry); the tab-bar click
    handler toggles `hidden` on the two panels and calls `filtersTab.show(...)` when Filters
    becomes active; the discipline toggle also pushes an updated `show(...)` call through if
    Filters is already active. `activeTab` resets to `"overview"` on every `showPlayer()` (fresh
    player / reopen), mirroring the existing `activeDiscipline` reset.
  - `styles.css` additions: `.player-page__tabs` / `.player-page__tab` (plain underline tabs,
    not `.segmented__btn` pills — this is page-level panel navigation, not a value picker) +
    `.player-page__filters-body` (matches `.player-page__discipline-body`'s top padding).

## Verification run

- `node --check` on every touched/new `.js` file: PASS (playerData.js, playerSections.js,
  playerPage.js, playerFiltersTab.js, playerPopup.js) — also ran across all of `src/*.js` as a
  belt-and-suspenders check: all pass.
- `styles.css` brace count balanced (661 open / 661 close) after edits.
- grep sweep for the seven mandated-zero symbols across `src/*.js`: zero CODE hits (a few
  harmless historical/explanatory COMMENT mentions remain, e.g. "the overlay used to do X" —
  quoted in the final report).
- Byte-identity: diffed every touched `playerData.js` function before/after — in each case the
  only change is `overlay`-param removal + `ov.where` → `where`; the SQL template strings
  themselves are untouched (`ov.where` always equalled the base `where` string when `overlay`
  was empty/null, which — since nothing can ever construct a non-null overlay any more — is now
  the ONLY path). Live-browser anchor re-verification is DEFERRED to the orchestrator's
  integration pass (per the brief — this worktree doesn't boot the app).

## Gotchas / notes for later waves

- Left a sizeable amount of now-provably-dead code in `playerSections.js` on purpose (see "Done"
  above) rather than unilaterally deleting rendering logic not named in the brief. If a later
  wave (T-2) wants a clean slate, that dead code is a good first deletion target — but it's
  self-contained and doesn't block anything.
- `src/searchSelect.js` (not owned by this task) still has 3 comments mentioning
  `src/playerFilters.js`'s old drawer as the reason its `portal` option exists — cosmetic only,
  left untouched (out of scope).
- `monthOptionsHTML` in `playerSections.js` was ALREADY unused before this task (pre-existing,
  unrelated to the overlay) — noted, not touched.
