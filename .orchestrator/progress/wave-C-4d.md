# Wave C — 4d (C1a, frontend-engineer/Sonnet-high)

## Done
- **A8** (`src/graph/graph.js:400`): button text "Reset to filtered set" →
  "Reset to full filtered set". One string only; `data-role="reset-players"`
  and all logic untouched. Commit `5d95e4e`.
- **A5** "Keep Selected Columns" checkbox: `src/state.js` (`keepColumns: false`
  in `createInitialState`), `index.html` (checkbox in `.filters-popup__footer`,
  left of Search via `margin-right: auto`), `styles.css` (`.fpop-keep-columns`
  + input styling), `src/drawer.js` (wires the checkbox to `store.keepColumns`,
  syncs on `sync()`), `src/main.js` (passes the checkbox element into
  `mountFilterDrawer`; gated `reapplyDefaultColumnsIfUnmodified()` itself —
  single point of gating — on `state.keepColumns`, so both its call sites
  (format-changed, discipline-changed callbacks in `mountFilters` wiring) are
  covered without duplicating the check). Commit `40ad503`.
- **A6** no-data pin feedback: `src/table.js`'s `load()` already computed
  `missingPinnedIds`; found it was FORCED to `[]` for matchup mode via a stale
  comment/gate predating Wave 4b/decision 47a (which extended the pin bypass
  to `buildMatchupQuery` via `whereWithPinExemption`/`gateWithPinExemption`) —
  fixed so it's computed uniformly in both modes (display-side only, no SQL
  touched). Made `applyPinnedPlayers()` return `load()`'s promise (was
  fire-and-forget) so the instant-pin-add path can read the result too.
  `src/pills.js`: `mountPills` takes an optional `getNoInningsIds` accessor;
  pinned-player pills get `" (no innings)"` appended to their label + a
  `pill--no-innings` class + a `title` when flagged, propagated through the
  soft-delete/staged path too. `src/main.js`: module-level `noInningsPinIds`
  Set + `reportPinCoverage(result)` — recomputes the set from every completed
  `load()`, re-renders pills, and toasts ONCE naming only NEWLY-missing pins
  (not ones already flagged from an earlier Search/pin-add, to avoid re-toast
  spam on an unrelated later action). Wired into both `runSearch()`'s
  `tableController.load()` call and `onPinsChanged()`'s
  `tableController.applyPinnedPlayers()` call. Reset in `clearAll()` too.
  `styles.css`: `.pill--no-innings` (dashed border + italic, borrowing
  `.pill--inert`'s "not quite live" visual language while keeping the pin's
  steel tint). Commit `d127b1a`.

## Verification
- `node --check` on every touched `.js`: main.js, state.js, drawer.js,
  pills.js, table.js, graph/graph.js — all pass.
- `git diff dacca17 -- src/table.js | grep -iE "buildQuery|buildMatchupQuery|conditionToHaving|sqlExpression"`
  → comment-only lines (no function-body changes). `src/filters.js` diffstat
  vs `dacca17` is empty (never touched).
- Full diffstat of owned files vs `dacca17` (the commit right before this
  task's first commit — NOTE: this branch has concurrent agents committing
  work from other C1 tracks (4e/A9, 4f popup dropdowns) interleaved in git
  history; `dacca17` not `ba3d1ca` is the correct baseline for THIS task's own
  diff since no other commit in that range touches table.js/drawer.js):
  index.html +4, drawer.js +16/-1, graph.js +1/-1, main.js +88/-~10,
  pills.js +32/-~4, state.js +6, table.js +43/-25 (mostly comment expansion),
  styles.css +30.

## Gotchas / notes for the orchestrator
- Other agents (C1b/C1c) are committing to this SAME branch
  (`polish-b1-mechanical`) concurrently — git log shows their commits
  interleaved with mine (`cd351ba`, `65455e5`, `040229b`). No file overlap
  observed with my owned files (checked via `git show --stat` on each of
  their commits), but worth knowing before drawing diff baselines.
- A5: the "reset" the brief describes as happening "via main.js around line
  192 ... on a committed Search" is actually triggered by the format/
  discipline-changed callbacks in `mountFilters` wiring (immediately, as a
  pending edit) — NOT by `runSearch()`/`triggerTableSearch()` directly, which
  never touch columns. Functionally the effect only becomes VISIBLE at the
  next Search (table stays frozen till Search), so the owner-facing behaviour
  described in the brief is accurate; I gated the actual mechanism
  (`reapplyDefaultColumnsIfUnmodified`) rather than inventing a new reset
  inside `runSearch()` that doesn't otherwise exist. Flagging this in case the
  orchestrator expected a literal call in `runSearch()`.
- A6: also fixed two stale comments (main.js's `pinPlayer()` doc, table.js's
  `applyPinnedPlayers()`/`load()` doc) that pre-dated Wave 4b/decision 47a and
  claimed matchup mode has no pin bypass — it does (that decision explicitly
  extended it). Listed under "Also fixed" in the final report.

## Next
- Nothing outstanding for 4d. Ready for orchestrator's in-browser + anchor
  verification.
