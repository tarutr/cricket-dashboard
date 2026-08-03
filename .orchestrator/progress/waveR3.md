# Wave R3 (Part B) — palette into the player pop-up

Branch `ball-layer`. Owner: frontend-heavy (Opus). Owned files: `src/drawer.js`,
`src/addPalette.js` (NEW), `src/playerFilters.js`, `src/playerPage.js`/`playerPopup.js`,
`styles.css`, `src/searchSelect.js`. Must NOT touch: `buildQuery`/`buildMatchupQuery`/
`buildScopeClauses` core, `metrics.js`, filters.js gender/discipline controls.

## PHASE 1 — extract palette machinery to `src/addPalette.js`  ✅ DONE (commit `wip(waveR3-extract):`)

Moved the GENERIC, taxonomy-agnostic search-palette component out of `mountFilterDrawer`'s
closure into `src/addPalette.js`:
- `paletteSkeletonHTML(gi)` — the `.addctl` DOM skeleton (drawer.js's `groupCardHTML` embeds it).
- `createAddPalette({ buildGroups })` → `{ mountAddPalette, closeCurrent }`. Owns the leak-free
  `portalPanel` (doc listeners added on open / removed on close) + the list build +
  search/highlight/▸-drill-down + open/close wiring + the per-instance "only one open at a time"
  `currentPaletteClose` tracker.
- drawer.js's 7-group TAXONOMY (`buildPaletteGroups`), `pickSingleton`/`pickMetric` and every
  preselect closure STAY in drawer.js. It creates one component:
  `createAddPalette({ buildGroups: (gi) => buildPaletteGroups(store.get(), gi) })` and uses
  `palette.mountAddPalette(el)` (in `wireNumeric`) + `palette.closeCurrent()` (in `renderNumeric`).

The extracted code is VERBATIM (the only line that changed: `buildPaletteGroups(store.get(), gi)`
→ `buildGroups(gi)`). No query path lives in addPalette.js → numbers sacred.

### Proof the leaderboard drawer is byte-identical
- `node --check` clean on `src/addPalette.js` + `src/drawer.js`; no stale `currentPaletteClose` /
  `mountAddPalette` / `portalPanel` refs remain in drawer.js.
- Served localhost:8000, `fetch(cache:'reload')` on both changed files, reloaded. **0 console errors.**
- **Anchors EXACT** (Men/T20/Intl, 2023-07-01→2026-07-02): **2,813 players**, top row Karanbir
  Singh **2,454**, SA Yadav **64 MAT / 60 INNS / 1,544 / 29.13 / 150.34**.
- **Stats popup palette**: opens (portal), renders the 7 groups (Player Profile … Batting Basic/
  Detailed …), search+highlight+group-filter works ("score"→High Score/Innings Score ≥ N,
  "boundary run"→% Runs from Boundaries), pick adds the numeric condition row + auto-focuses the
  value input, closes via outside-click. NO Ball Ranges group flag-OFF (correct).
- **Graph filters popup palette**: same component, verified independently ("dot"→Dot Ball %
  condition added). Both surfaces mount `mountFilterDrawer` → both get the extracted component.
- styles.css UNTOUCHED, so 375px behaviour is identical to before the extraction.

(Harness note: the browser `key` action must send `"Enter"`, not `"Return"` — the palette's
keydown checks `e.key === "Enter"`. `read_page filter:all` surfaces the always-present HIDDEN
singleton skeleton rows — Phase/Over range/Ball range etc. — which are NOT active conditions.)

## PHASE 2 — full palette into the player pop-up  ⛔ STOPPED, ESCALATED (owner decision needed)

**Not built. The brief's approach — "wire each filter into the pop-up's EXISTING local overlay/
query path" — is not viable as written, and completing full scope needs an owner design ruling +
a number-critical build in a NON-OWNED file. Per tier rule "if the plan's approach is wrong, STOP
and report," I stopped rather than silently diverge (rewrite number code / ship inert filters).**

### Why (the architecture)
The pop-up is a rigid 4-dimension overlay `{ dateFrom, dateTo, positions, opposition, vs }`
hardwired end-to-end: `playerFilters.js` (produces it) → `playerPage.js`
(`activeOverlayCount`/`clearOverlayDim`/`cacheKeyFor`) → **`playerData.js`**
(`applyOverlay`/`requestedDims`/`PLAYER_SECTION_SUPPORT`, each of ~10 section fetches HAND-CODING
which columns its source carries) → `playerSections.js` (`overlayPillsHTML`/`scopeLine`). The
pop-up sections hand-build SQL — they NEVER go through `buildQuery`/`conditionToHaving`. So a
richer overlay does NOTHING unless **playerData.js** (NOT in this wave's owned set; the exact code
that produces the pop-up's baseline numbers) applies each new dimension per section.

### The full palette vs the pop-up's real query path
1. **Scope WHERE filters** (Opposition ✓already · Event · Venue · Stage · Match/Toss Result ·
   Innings Number): honorable IN PRINCIPLE — the innings views carry the columns (confirmed:
   `buildScopeClauses` emits venue/event_name/event_stage/toss_winner/toss_decision/result_type/
   innings_number against them). But only via applying scope clauses inside each playerData.js
   section fetch + per-source refusal + updating PLAYER_SECTION_SUPPORT. A real, number-critical
   build in a non-owned file.
2. **Player-profile filters** (Playing role · Batting hand · Bowling style · Regular position ·
   Team): for ONE already-chosen player these are a whole-record show/blank GATE, not a slice
   (role/hand/bowling), or a per-match slice (Team). Needs an owner intent ruling.
3. **Numeric metric filters** (Runs/Balls/4s/6s/… + Average/SR/Boundary%/… + the ▸ families): in
   the leaderboard these are HAVING-on-aggregate filters that SELECT PLAYERS — meaningless as
   aggregates for one player. The owner's "per-innings quantities are legitimate slices" reframes
   them as innings-grain WHERE (e.g. Runs ≥ 50 = innings scoring ≥50). Valid metric-by-metric:
   per-innings Runs/SR/6s make sense; per-innings **Average / Balls-per-Dismissal / most ratios do
   NOT** (they need multiple innings). This is a CRICKET-JUDGMENT design task → owner sign-off
   (memory: design-signoff-before-build; never delegate cricket judgment to subagents).
4. **Ball Ranges** (Phase · Over Range · Team Ball Range · Batter/Bowler Ball Range): GENUINELY
   not honorable on current sources — they need the delivery ball-grain parquet the pop-up never
   queries (and it is behind the default-OFF ball engine). A new ball-grain pop-up query layer.
5. **Matchup (Vs)**: "vs bowling style" partly there (the `vs` dim, batting); "vs batting hand"
   (bowling), striker Batting position, and the matchup metric filters are not fully wired —
   needs matchup-source application in playerData.js.
6. **Fielding Stats** (Fielding Wicket Type ▸ · Wickets by Batting Position ▸): the pop-up has NO
   fielding section/source at all. Not honorable without a new fielding query.

### Recommendation
Phase 2 is a design-then-build program, not a display/wiring change: (a) owner decides what each
non-scope filter MEANS for a single player (esp. the per-innings semantics of each numeric
metric, class 3); then (b) a scoped multi-step build that OWNS `playerData.js` (+ playerPage/
playerSections for pills/scope/cache-keys), extending the overlay per class with per-source
refusal logic — verifying a known player's baseline numbers hold at every step. Phase 1 (the
extraction) is the reusable palette foundation any Phase 2 shape will reuse.
