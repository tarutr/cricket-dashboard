# T-2d — Matches-column fix + Matchup "Vs" filters assessment (progress)

Branch `ball-layer`, main working tree. NO git (orchestrator commits). Numbers-sacred (Rule 1).

## TASK 1 — Matches (MAT) column fix for opponent/window rows — ✅ DONE + VERIFIED
### Root cause
`buildQuery` MAT path: `inningsLevel` TRUE → `COUNT(DISTINCT match_id)` in the MAIN sql (over the filtered
view rows); FALSE → separate `matchesSql` on `player_matches` (whole scope). Opponent-player / delivery-window
are BALL predicates threaded to `db.query(sql, {…})` AFTER buildQuery (they restrict the ball-engine
`batting`/`bowling` reconstruction to in-window/opponent balls), so a row whose ONLY filter is a ball predicate
never flips `inningsLevel` → MAT falls to the whole-scope `player_matches` count.

### Fix (ADDITIVE — byte-identical for every existing caller)
- `src/table.js`: new `opts.inningsMatches` boolean OR-ed into `inningsLevel`. Default false → every existing
  2-arg caller (leaderboard table.js:2787, graph benchmark/charts/players) unchanged.
- `src/playerFiltersTab.js` `fetchRow`: passes `inningsMatches: Boolean(row.deliveryWindow || row.opponentPlayer)`.
  When set, `matchesSql` is null → MAT reads the main sql's COUNT(DISTINCT match_id) over the ball-restricted view.

### Verification (SKY = 271f83cd, NT Ellis = 9eb1455b; Men/T20/Intl, 2023-07-01→2026-07-02 day-bounded)
- node --check both files OK. Only src/table.js + src/playerFiltersTab.js modified; config.js reverted git-clean; manifest untouched.
- FLAG-OFF (real R2): leaderboard 2,813 players / Karanbir 2,454 / SKY 64·60·1,544·29.13·150.34 — byte-identical.
- REAL code path (buildQuery+query, flag-on local snapshot), vs-Ellis opponent row:
  FIXED → hasMatchesSql=false, MAT=**8**, inns=8, runs=72.  OLD(inningsMatches=false) → MAT=**64** (the bug), inns=8, runs=72.
- Delivery-window (Powerplay) row: FIXED MAT=**41**, inns=41, runs=465.
- No-filter row: MAT=64, inns=60, runs=1544 (byte-identical to leaderboard; fix inert).
- INDEPENDENT DuckDB CLI: SKY vs Ellis distinct matches (with full crease-recovery) = 8; SKY powerplay distinct matches = 41. EXACT.
- 0 error-level console logs on all scoped pop-up queries.

## TASK 2 — Matchup "Vs" filters — ⛔ STOP + REPORT (not built; owner decisions needed)
- **vs bowling style / vs batting hand:** route through `buildMatchupQuery` (matchup views + coverage/composition,
  different namespace, no inningsWhere). A ball-predicate approximation (`bowler_id IN (SELECT player_id FROM
  profiles WHERE bowling_group=…)`) is a NEW predicate mechanism that (1) raises the grain-mixing semantics
  question and (2) diverges from the matchup anchor — plain batting does zero-ball crease recovery
  (non-striker/dismissed) that matchup_batting EXCLUDES, so the innings count can differ from the 38-inns anchor.
- **batting position:** BATTING = a genuine per-innings attribute (`batting_position` on the plain batting view) →
  cleanly sliceable via inningsWhere; BUT the brief's suggested reuse (leaderboard `mountBattingPosition` →
  `state.positions`) is INERT in plain mode (positionsFilterActive is matchup-gated), so it needs a numeric-operator
  slice OR bespoke `batting_position IN (…)` plumbing — an open editor-shape decision. BOWLING = striker-faced
  position = matchup/ball concept, no per-innings home. → surface to owner.
