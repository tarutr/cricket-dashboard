# Wave 3 (UI, part A) — REWORK: four separate delivery-window filter entries

Branch `ball-layer`. Owner decision 67, "DESIGN CORRECTED at the UI-A review"
(2026-07-31): the combined single "Delivery window" entry with a Phase|Overs|Balls
mode-TOGGLE is a deprecated style (forces one mode, breaks the uniform per-filter
pattern) — REPLACE with FOUR separate "+ Add condition" entries that compose freely.
UI-ONLY rework: the ball predicate SQL + verified numbers are UNCHANGED.

## Spec shape — flat + composable (the key restructure)
`state.deliveryWindow` changed from the single-mode `{team:{mode,…}, player}` to
independent, AND-composed pieces:
```
{ phase?: ('pp'|'mid'|'death')[], overs?: {from,to}, balls?: {from,to}, player?: {edge,n} }
```
This restructure is REQUIRED to deliver the owner's stated design: with `team`
holding exactly one `mode`, Phase/Overs/Balls could never compose — the flat shape
lets each be picked independently and AND together (contradictory combos → honest
empty). The per-piece SQL is byte-identical to the signed-off engine wave, so the
numbers are untouched (see below).

## What changed (files, one line each)
- **src/deliveryWindow.js** — RESTRUCTURED the pure generator to the flat spec.
  `deliveryWindowPredicate(spec, discipline)` now ANDs whichever of phase/overs/
  balls/player are present, REUSING the exact per-piece SQL verbatim (phase→
  `phase IN(…)`; overs→`over_number BETWEEN from-1 AND to-1`; balls→`team_ball
  BETWEEN from AND to`; player→`bat_ball[_rev]`/`bowl_ball[_rev] BETWEEN 1 AND n`).
  `null`/`{}`/all-absent ⇒ `""` (the critical no-window invariant). Malformed active
  piece still THROWS. NEW `withDeliveryWindowPiece(spec,key,value)` (immutable
  set/clear of one piece; all-empty ⇒ null), `deliveryWindowTokens(spec,discipline)`
  (`[{key,label}]`, one per active piece — the ONE label source for the four pills +
  scope tokens), `DELIVERY_WINDOW_KEYS`. `describeDeliveryWindow` kept as a thin
  comma-joiner (no external caller now; retained for Part-B graph/popup).
- **src/drawerInnings.js** — removed `mountDeliveryWindow` (the combined editor).
  NEW `mountWindowPhase` (chips → spec.phase), `mountWindowOvers`/`mountWindowBalls`
  (shared `mountWindowRange`, from–to, format-capped → spec.overs/spec.balls),
  `mountWindowPlayer` (First|Last + N + unit → spec.player). Range/player editors
  keep a LOCAL DRAFT + per-piece `lastWritten` guard so a sibling editor's store
  write never stomps the caret; Phase is chips-only (reads state directly). NEW
  exported `windowPhaseBallsAllowed(s)` (single T20/50-over gate) + `setWindowPiece`.
- **src/drawer.js** — replaced the single `window` SINGLETON_TYPE with four
  (`win_phase`/`win_overs`/`win_balls`/`win_player`), all `ballOnly`, leading the
  array under the "Delivery" optgroup. Mounted the four editors; `syncSingletonRows`
  syncs all four; `hasValue` checks each piece; `isPresent` gates win_phase/win_balls
  to `windowPhaseBallsAllowed`; `clearSingleton` clears each piece via
  `withDeliveryWindowPiece`; `addSelectOptionsHTML` builds the format-gated Delivery
  optgroup (Phase/Ball-range only under single T20/50-over; Over-range + Player in
  all formats); `activeCount` adds `deliveryWindowTokens(...).length`.
- **src/pills.js** — replaced the single window pill with ONE pill PER active piece
  (via `deliveryWindowTokens`), each removable INDEPENDENTLY (×/+ clears/restores its
  own piece through `withDeliveryWindowPiece`, preserving the others).
- **src/state.js** — `describeScope` pushes ONE token per active piece
  (deliveryWindowTokens); `pruneDeliveryWindowForFormats` REWRITTEN for the flat
  shape (drops phase and/or balls pieces the format no longer permits; keeps overs +
  player; all-empty ⇒ null).
- **styles.css** — replaced the `.dwin` stacked-block styles + `[data-cond="window"]`
  with the four `[data-cond="win_*"]` rows + `.dwin-piece`/`.dwin__chips`/`.dwin__num`
  (compact inline editors that wrap at ~375px).
- NOT touched: main.js + db.js (the Search-gate wiring `setDeliveryWindow(applied
  State.deliveryWindow)` and the generator call are shape-agnostic — the spec is
  opaque to them). table.js/ballEngine*/metrics/filters untouched (MUST-NOT-TOUCH).

## Numbers invariant (why this is safe)
The engine reads the spec ONLY via `deliveryWindowPredicate(spec, discipline)` (db.js
line 75), whose signature is unchanged. A single-piece spec emits the SAME clause the
engine wave verified (e.g. `(phase IN ('death'))`); a multi-piece spec ANDs those
verbatim clauses. Verified in a pure-logic harness (node): single-piece SQL byte-
identical to the engine-verified clauses; `death ∧ first-10` ⇒
`(phase IN ('death')) AND (bat_ball BETWEEN 1 AND 10)` — textually identical to what
the OLD spec produced, so engine case-(f) 25/14/178.57 reproduces byte-for-byte;
null/{}/empty-phase ⇒ "".

## VERIFICATION — pending browser (flag-ON localhost:8000)
- [ ] Four entries appear (grouped "Delivery"), correct format gating; Red Ball =
      Over range + Player balls only.
- [ ] Each windowed number on screen + independent hand DuckDB check.
- [ ] Composition (Phase=Death ∧ Player First-10 = 25/14/178.57; Powerplay+Overs
      15–20 = empty), pills independently removable.
- [ ] Pins obey. No-window byte-identical (2,813 / Karanbir 2,454 / SKY 60·1,544·
      29.13·150.34) flag-ON; flag-OFF byte-untouched. Mobile 375px. 0 console errors.
- node --check clean on all touched files.
