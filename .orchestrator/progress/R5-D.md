# R5-D — Line graph full redesign (progress note)

Branch: polish-b1-mechanical. Owns: src/graph/timeseries.js, timeseriesChart.js, graph.js, charts.js (if needed), styles.css.

## Approved design (decision 53)
Line = one Y-metric × one X-dimension × up to 6 player lines. Two dropdowns: **X axis** (dimension)
+ **Metric** (Y). Per-bucket Y = the metric's EXISTING sqlExpression, GROUP BY (player, X-bucket).
NO floors/fading. MIN_BALLS_PER_YEAR deleted.

## Verified schemas (DuckDB DESCRIBE, live R2)
- `matches` is UNIQUE per match_id (22327=22327) → safe to JOIN, no fan-out.
- `matches` SHARES match_type/gender/team_type/match_date/year/month with base views → join dims MUST
  use a CTE (build scope on base view first via bare names, then JOIN matches for event/venue/winner/result_type).
- bowling_group ∈ {Pace, Spin, (unmapped)} → vs_bowling excludes '(unmapped)'.
- result_type: NULL (decisive, winner set) / draw / no result / tie(+super-over variants). ALL 201 tie% rows
  have NO winner → decisive matches always have winner; ties/no-result/draw caught by result_type.

## Anchor SQL shapes verified (SA Yadav 271f83cd, men/T20/intl, 2023-07-01→2026-07-02)
- by year: 466+376+218+484 = 1544 ✓
- pos-4: 967 runs / SR 150.389 ✓
- vs Spin (bowling_group): 454 runs / SR 140.99 ✓

## X-dim engine plan
NS-aware via effectiveNamespace (matchup_* under active Vs → apply bucket predicate; else plain).
- groupby dims (GROUP BY ALL): year, month, position(batting-only), innings_of_match, opposition
- join dims (CTE + matches): event, venue, result
- window dim (CTE ROW_NUMBER): innings-index (PLAIN only; disabled under Vs — matchup grain is multi-row/innings)
- phase dim (wide→long pivot; reuses existing phase METRIC defs; runs/balls NOT offered — no phase metric def, Rule-1)
- vs_bowling dim (matchup_batting, group by bowling_group, matchup metrics; batting-only, plain-only)

## Exposed engine fn (console verification)
`fetchLineData({ xDim, metricKey, playerIds, filters })` exported from timeseries.js — async, runs the query,
returns { xDim, metricKey, ns, kind, sql, buckets, byPlayer, rows }.

## KEY FINDING (verified)
`innings_number` is 0-BASED (0 = team_1 = batting first in 100% of 15,155 rows; 1 = chasing).
Label fn maps 0→"Batting first", 1→"Chasing". (Brief assumed 1/2 — corrected.)

## Engine cross-checks (fetchLineData vs independent hand DuckDB) — SA Yadav, all EXACT
- year 466/376/218/484 = 1544 ✓ · month Σ=1544 ✓ · innings-index 60 buckets Σ=1544 ✓
- position pos-4 = 967 / SR 150.389 ✓ · opposition Australia=259, Σ=1544 ✓ · event Σ=1544 ✓
- innings_of_match Batting-first 948 / Chasing 596 ✓ · result Won1257/Lost228/Tie20/NoResult39 ✓
- phase PP 137.982 / Mid 150.505 / Death 192.708 ✓ (exact) · vs_bowling Spin 454 / SR 140.99 ✓, Pace 913

## Status — engine + wiring + all 11 dims BUILT & number-verified
- [x] engine (timeseries.js): fetchLineData + all 11 dim SQL builders (GROUP BY ALL, CTE joins, ROW_NUMBER, phase pivot, vs_bowling)
- [x] renderer (timeseriesChart.js): new lineData shape, no floors, MIN_BALLS_PER_YEAR gone
- [x] graph.js: two dropdowns (X axis + Metric), applicability gating, render path, eligibility, chooser, needs-input
- [x] MIN_BALLS_PER_YEAR + old year-line code deleted
- [ ] in-browser UI smoke test (draw a line, switch discipline, table anchors on screen)
- [ ] commit milestones
