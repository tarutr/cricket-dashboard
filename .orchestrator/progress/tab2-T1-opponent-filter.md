# Tab-2 T-1 — opponent-player filter ("X vs opponent Y") — progress

Branch `ball-layer`. data-engineer (Opus). Numbers-critical. Follows the delivery-window
(Wave 3) pattern EXACTLY: new state field + ball-engine predicate + palette entry + pill.

## Semantics (from the brief / decision 70)
- Subject BATTING (batting / matchup_batting): "vs opponent Y" ⇒ `bowler_id = Y`.
- Subject BOWLING (bowling / matchup_bowling): "vs opponent Y" ⇒ `batter_id = Y`.
- Ball-engine ONLY (needs per-delivery ids) → gated exactly like Ball Ranges (`?engine=ball`).
- Shared palette Matchup group → main leaderboard AND (later) pop-up Tab 2.

## Injection approach (grounded in code, mirrors the delivery window)
- New pure module `src/opponentFilter.js`: `opponentPlayerPredicate(opp, discipline)` →
  `bowler_id = '<id>'` / `batter_id = '<id>'` (SQL-escaped), "" when inactive. Independently testable.
- `src/db.js`: `activeOpponentPlayer` + `setOpponentPlayer()` (mirror setDeliveryWindow); folded
  INTO `windowPredicateFor(discipline)` so it rides the EXISTING windowPredicate thread
  (engineSignature / materialize / widenForPendingQueries / rebuildEngineFull all already carry
  windowPredicate). Zero new params through the engine layer. When opponent inactive,
  windowPredicateFor returns the window string verbatim ⇒ byte-identical to today.
- `src/main.js`: `setOpponentPlayer(null)` at init; `setOpponentPlayer(appliedState.opponentPlayer)`
  at the Search commit (beside setDeliveryWindow) — Search-gated, like the window.
- State field: `state.opponentPlayer = null | {id, name}` (id → predicate; name → pill label).
- Palette: `paletteGroups.js` Matchup group, leaf "vs opponent player", gated on `ballOn` only
  (gender-agnostic, exactly like Ball Ranges — NOT men-only; bowler_id/batter_id exist for women).
- Picker: reuse `mountOmnisearch` (the player-search component, `searchPlayers`-backed) via a new
  `mountOpponentPlayer` editor in drawerInnings.js. Added an additive `showFilterAction` opt to
  omnisearch (default true → existing mounts byte-identical) so the picker drops the "Filter the
  table" action row.
- Pill + describeScope token + activeCount: "vs {name}", mirroring the delivery-window pill.

## Status: COMPLETE + VERIFIED (2026-08-03)

### Files touched
- NEW src/opponentFilter.js (pure predicate; unit-tested)
- src/state.js (opponentPlayer field + opponentPlayerActive() + describeScope token)
- src/db.js (activeOpponentPlayer + setOpponentPlayer + folded into windowPredicateFor)
- src/main.js (setOpponentPlayer at init + Search commit)
- src/omnisearch.js (additive showFilterAction opt, default true = existing mounts byte-identical)
- src/drawerInnings.js (mountOpponentPlayer editor, reuses mountOmnisearch)
- src/drawer.js (SINGLETON_TYPES vs_opp + hasValue/clearSingleton/mount/sync/activeCount)
- src/paletteGroups.js (Matchup group leaf, gated on ballOn, gender-agnostic)
- src/pills.js (opponent pill)
- styles.css (.opp-picker normal-flow results panel)

### Verification (localhost:8000; ball data via TEMP local /data/wave1_out — R2 lacks delivery files; config.js REVERTED)
- Pure module: opponentPlayerPredicate unit tests PASS (mapping + escaping + throw); composition invariant PASS (opponent inactive ⇒ byte-identical to window-only string).
- FLAG-OFF (real R2 innings data): 2,813 players / Karanbir 2,454; SA Yadav 60·1,544·29.13·150.34. Palette shows normal groups; "vs opponent player" absent.
- FLAG-ON inactive (ball engine): 2,813 / Karanbir 2,454 — byte-identical.
- FLAG-ON palette: "vs opponent player" present under Matchup (Vs). Picker = reused omnisearch typeahead, NO "Filter the table" row. Persists across discipline switch.
- ACTIVE batting (bowler_id=Y): SA Yadav vs NT Ellis — app 72 runs / SR 194.59 / AVG 72.00 / INNS 8 == independent raw-ball 72 runs / 37 balls / 1 dismissal / 8 innings. EXACT.
- ACTIVE bowling (batter_id=Y): NT Ellis vs SA Yadav — app 1 wkt / Avg 76.00 / Econ 12.32 / SR 37.00 == independent 37 legal balls / 76 runs conceded / 1 bowler-wkt. EXACT.
- 0 console errors throughout. node --check clean on all touched files.

### Flags for owner
- Placement: gender-agnostic (ballOn gate, per "exactly like Ball Ranges") — surfaces the Matchup (Vs) group on the WOMEN view (opponent-only) under ?engine=ball. Group note still reads "men only" on the men view (cosmetic).
- Innings-count follows the established delivery-window crease-union semantics (matched exactly here; could differ in edge cases like the window's case-(f)).
