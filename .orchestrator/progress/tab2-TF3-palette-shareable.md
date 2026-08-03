# T-F3 — make the "+ Add condition" palette taxonomy shareable + per-surface configurable

Branch `ball-layer`, worked directly in the shared tree (no git commands run, per instructions —
edits are on disk, uncommitted).

## What changed
- **NEW `src/paletteGroups.js`** — `buildPaletteGroups` (the 7-group taxonomy builder) moved here
  verbatim out of `src/drawer.js`'s `mountFilterDrawer` closure, wrapped in a factory
  `createPaletteGroupsBuilder(deps)` that returns `buildPaletteGroups(s, gi, { surface } = {})`.
  Also relocated (only ever used inside the taxonomy): `DELETED_FILTER_METRIC_KEYS` /
  `isDeletedFilterMetric` (decision-68 filter deletes) and `stripOutPrefix`.
- **`src/drawer.js`**:
  - Removed the taxonomy body + its now-dead local helpers (moved above).
  - Added `function ensureVsBowlingTypesLoaded()` right next to `loadVsBowlingTypes` — reproduces
    the exact inline guard buildPaletteGroups used to have (`if (!vsBowlingTypes) load…then(rerender)`),
    now exposed as a named dep instead of inline in the taxonomy body.
  - Instantiates `const buildPaletteGroups = createPaletteGroupsBuilder({ isPresent, SINGLETON_TYPES,
    pickSingleton, pickMetric, preselectPhase, preselectFielding, preselectMatchupVs, preselectEdge,
    preselectInningsNumber, getVsBowlingTypes, ensureVsBowlingTypesLoaded })` once, then the
    `createAddPalette({ buildGroups: (gi) => buildPaletteGroups(store.get(), gi, { surface:
    "leaderboard" }) })` call site pins `surface:"leaderboard"` explicitly.
  - Trimmed now-unused imports: `inningsNumberOptions`, `eligibleMetrics`, `FIELDING_POSITIONS`
    (from `state.js`), `partitionFilterMetrics` (from `advanced.js`) — all were used only inside
    the taxonomy body, which now imports them itself in `paletteGroups.js`.
  - `pickSingleton`, `pickMetric`, the 5 `preselect*` closures, and `isPresent`/`SINGLETON_TYPES`
    all STAY in drawer.js (they close over this instance's store/DOM/sessionAdded/winPlayerController)
    — only passed BY REFERENCE into the factory, not moved.

## API / surface-config shape
```js
// src/paletteGroups.js
export function createPaletteGroupsBuilder(deps) { ... return buildPaletteGroups; }
// deps: { isPresent, SINGLETON_TYPES, pickSingleton, pickMetric,
//         preselectPhase, preselectFielding, preselectMatchupVs, preselectEdge, preselectInningsNumber,
//         getVsBowlingTypes, ensureVsBowlingTypesLoaded }
// buildPaletteGroups(s, gi, { surface = "leaderboard" } = {}) -> [{ name, note?, items }]
```
`surface: "leaderboard"` (default) = today's full taxonomy, unchanged. `surface: "popup"` = same
taxonomy minus 5 Player-Profile leaves (see below) — defined, NOT consumed anywhere yet.

## Proof the leaderboard taxonomy is unchanged
- The moved function body is a verbatim copy (re-read the exact source 3× before/after moving to
  avoid transcription drift) — same group order, same `pushGroup`/`leafMetric`/`leafSingle`/
  `metricFamily`/`singleFamily` helpers, same conditionals, same 7 groups.
- The ONLY new logic is `excludeLeaf(key)` guarding 5 items in group 1 ("Player Profile"); it is
  `surface === "popup" && POPUP_EXCLUDED_PLAYER_PROFILE_LEAVES.has(key)`, which is always `false`
  when `surface === "leaderboard"` (the pinned call-site value and the default) — so every
  `!excludeLeaf(...)` guard is unconditionally `true` on the leaderboard path, i.e. a no-op vs.
  the pre-extraction code.
- `vsBowlingTypes`/`loadVsBowlingTypes` themselves were NOT moved (still used by `renderVsEditor`
  too) — only wrapped in `ensureVsBowlingTypesLoaded`, whose body is the exact original guard line,
  so the lazy-load / retry-on-failure / one-shot-rerender behaviour is unchanged.
- `node --check src/drawer.js` and `node --check src/paletteGroups.js` both pass.
- Did NOT boot the app / serve :8000 — deferred to the orchestrator's integration pass per brief.

## Exactly what "popup" drops vs keeps (defined, not yet wired anywhere)
Drops (5 leaves, all inside group 1 "Player Profile"):
- `role` — "Playing role"
- `hand` — "Batting hand"
- `bowling` — "Bowling style"
- `rpos` — "Regular batting position"
- `potm_count` — "PotM Count" (metric leaf, not a singleton)

Keeps everything else, including within group 1: `team` — "Team" (never excluded). Groups 2–7
(Match Details, Batting/Bowling Basic+Detailed Stats, Ball Ranges, Matchup (Vs), Fielding Stats)
are built identically regardless of `surface` — the brief only named the 4 profile filters +
PotM as drops and called out Team + the matchup filters (vs bowling style / vs batting hand / vs
opponent player) as explicitly kept, so nothing else was touched. The Matchup (Vs) group's
`strikerpos` ("Batting position") leaf is untouched too (it's matchup-only, not profile-only).
"vs opponent player" doesn't exist in the taxonomy yet — a different worker (T-1) adds it later
into the same Matchup group; nothing here blocks that.

## Files touched
- `src/drawer.js` (owned)
- `src/paletteGroups.js` (owned, new)
- No other files touched. `src/addPalette.js` untouched (reused as-is, per brief). `styles.css`,
  `src/table.js`, `src/filters.js`, `src/metrics.js`, `src/state.js`, `src/db.js`,
  `src/playerPage.js` untouched.

## Risks / notes for the orchestrator
- Not boot-tested in a browser (per brief — deferred to integration). The refactor is mechanical
  (relocate + dependency-inject a pure function) but a live anchor check after merge is still the
  real proof; I'd flag this as the one residual risk given "numbers sacred."
- The `surface:"popup"` path is inert — no caller passes it yet, so it can't have broken anything
  live. T-2 (the pop-up's own mount) will need to build its OWN `pickSingleton`/`pickMetric`/
  preselect closures (operating on a per-row `{op,groups}` object instead of the global store) and
  call `createPaletteGroupsBuilder({...}, )` a second time — this task deliberately stops short of
  that per the brief ("do NOT wire the pop-up here").
- Minor naming call I made without asking: kept the exclusion set name
  `POPUP_EXCLUDED_PLAYER_PROFILE_LEAVES` generic-looking but it is currently ONLY consulted for
  `surface === "popup"`; if a third surface ever needs a different exclusion set, this constant
  name would need revisiting — flagging so a future worker doesn't assume it's surface-agnostic.
