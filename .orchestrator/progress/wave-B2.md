# Wave B2 — Line (by-year) chart matchup-aware

## Task
Replace B1's interim "Line unavailable under Vs" grey-out with a real
matchup-by-year query. Line must trend a Vs metric (e.g. SR vs Spin, by year).

## Done
- src/graph/timeseries.js:
  - Added MATCHUP_* local column maps (VIEW/NS/ID/NAME/TEAM/OPP/BALLS),
    duplicated byte-identical from table.js (same rationale as the plain maps).
  - Widened timeseriesSupported() to accept source:"matchup" total/rate/percent
    metrics, EXCLUDING vsTableOnly (Matches / Runs per Innings / High Score /
    Best Bowling — table-only, decision 47c) and kind peak/composition. Plain
    (innings/player_matches) behaviour provably unchanged (refactor only).
  - buildTimeseriesQuery now dispatches to a new buildMatchupTimeseriesQuery()
    when matchupVsActive(filters) — mirrors table.js buildQuery's auto-dispatch
    to buildMatchupQuery. PLAIN branch body BYTE-IDENTICAL (no executable lines
    removed; dispatch added above it).
  - buildMatchupTimeseriesQuery: matchup_* view, bucket predicate in WHERE
    (numerically identical to buildMatchupQuery's per-aggregate FILTER; no
    coverage needed here), GROUP BY (id, year), MAX(name), metric's matchup
    sqlExpression verbatim (SPEC §8.2), sample = SUM(balls_faced|balls). Same
    buildScopeClauses opts buildMatchupQuery uses; explicit id-list roster (no
    pins/search, mirroring the plain path).
- src/graph/graph.js:
  - renderChart byyear branch: eligibleMetrics(discipline) -> (ns) and
    buildTimeseriesQuery({discipline}) -> ({discipline: ns}). Plain: ns===discipline
    so byte-identical. config.discipline stays plain (card eyebrow), mirrors Slope.
  - Removed B1 interim grey-out in evaluateTypeStatus (byyear+matchupVsActive ->
    "Not available for Vs metrics yet"). Availability now falls through to the
    generic byyear metric check (does effective namespace offer a trend-able
    metric). Removed now-unused matchupVsActive import.
- timeseriesChart.js: NOT touched (row shape unchanged; renderer already generic).

## Independent DuckDB verification (all EXACT, live R2 data)
Scope: gender=male, T20+IT20, international, 2023-07-01..(app: <2026-08-01).
- SA Yadav (271f83cd) RUNS vs Spin by year: 2023=141, 2024=92, 2025=63, 2026=158
  (sum 454 = standing anchor). App builder == independent query, digit-for-digit.
  SR vs Spin: 134.29 / 131.43 / 134.04 / 158.00 (== independent).
- JJ Bumrah (462411b3) ECON vs Right-hand bat: 5.44/3.72/6.96/7.74;
  WICKETS 3/8/9/8; samples(balls) 43/92/157/172. App builder == independent.

## Next
- git-diff proof of plain-branch untouched + plain "Runs by year" unchanged.
- Browser UI: Line selectable (not greyed) under Vs; renders; 0 console errors;
  plain Line still works.

## Gotchas
- timeseriesSupported required widening: matchup metrics are source:"matchup",
  not "innings" — the old guard returned false for ALL of them.
- The 4 vsTableOnly stats stay OUT (owner ruling; B1 precedent). Do NOT chart them.
- Bucket-in-WHERE == buildMatchupQuery's FILTER for the stat value; FILTER there
  exists only to co-compute coverage in one scan (not needed for the line).
