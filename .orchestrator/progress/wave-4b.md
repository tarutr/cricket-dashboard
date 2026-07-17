# Wave 4b — Vs mode honors the full filter set (fix + harden)

Owner ruling: decision 47(a). Branch: polish-b1-mechanical. Agent: data-engineer (Opus/xhigh).

## Done
- filters.js: new shared pin-exemption helpers `pinnedIdSetSql` / `whereWithPinExemption`
  / `gateWithPinExemption` (one path both query builders call).
- table.js: buildQuery's three pin-wrap sites (main WHERE, HAVING, matchesSql WHERE)
  refactored onto the helpers — SQL byte-identical (djb2 fingerprint held). buildMatchupQuery
  gained pin exemption at step-1 WHERE (idCol) and step-3 gate (projected alias `id`).
- state.js: `regularPositionsFilterActive` now gates on `discipline === "batting"` (active in
  plain batting AND batting matchup; inactive in ALL bowling) — opens the R.Pos gate into Vs
  without touching the striker-position filter. Updated pinnedPlayers doc comment.
- pills.js: pin pills no longer inert/greyed in Vs mode.
- drawerInnings.js: mountRegularPositions shows in batting contexts (plain + matchup), hides in bowling.
- drawer.js: striker-position gets its own inline caption ("Batting position") when it coexists
  with R.Pos in batting matchup; row label + presence made discipline/mode-aware.
- styles.css: scoped stacked layout + caption weight for the R.Pos row.
- pipeline/dev_test_vs_filter_parity.mjs: NEW Node ESM parity guard — asserts each
  player-selecting filter's clause is present in the right mode(s); runs green.

## Verified (all green)
- Byte-identical fingerprints in Node AND live browser: PLAIN 3307620867/1430, CLEAN 1547662675/1790.
- Anchors (independent hand-written DuckDB): batting baseline 2,813 (leaderboard rows; top row
  Karanbir Singh 2,454), SA Yadav vs Spin 38/454/SR 140.99, Bumrah vs RHB pos 1,2 = 27/177/9.
- Parity guard PASS. node --check all touched files OK. Boot with ZERO console errors.
- CSK scenario (programmatic + hand DuckDB): all-CSK vs Pace 35 → R.Pos top-order 10 → +pins 12;
  pin (Kohli) shows FULL vs-Pace record 45/1340/170.05, non-pin (Gaikwad) team-restricted
  32/639/134.81 — both match independent queries exactly.
- Live UI drive: R.Pos pill + pin pill both LIVE (not greyed) in Vs; Filters badge counts R.Pos ("1");
  R.Pos + striker controls both present/labelled in batting-Vs drawer; pin ADDS a row in Vs;
  round-trip Vs↔Everyone with filters set works both ways.
