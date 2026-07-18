# Wave B1 — matchup-aware Graph (frontend-heavy / Opus)

Branch: polish-b1-mechanical. Owns: graph/graph.js, graph/charts.js, graph/benchmark.js,
graph/phaseFamilies.js, graph/players.js (+ styles.css only if a greyed-note needs it).
MUST NOT touch: table.js, filters.js, metrics.js, state.js, drawer.js, timeseries*.js.

## Approach (stated up front; key risk noted)
Reuse the ONE builder: `buildQuery` auto-dispatches to `buildMatchupQuery` when
`matchupVsActive(state)`. Un-null the graph store wrapper so real Vs flows; route
charts.js fetch through buildQuery in Vs mode (mirror fetchWindowMetric). Repoint every
graph metric-namespace lookup from `state.discipline` to `effectiveNamespace(state)`.
Keep config.discipline PLAIN (card eyebrow). PLAIN path stays byte-identical.

KEY RISK / FINDING: the four decision-47(c) Vs stats (matches, high_score,
runs_per_innings, best) carry `vsTableOnly:true` and metrics.js says explicitly
"never ... the graph". The brief expected High Score chartable. I HONORED the owner
flag: graphMetrics() excludes vsTableOnly + kind:"composition" from graph pickers.
=> FLAG for owner: High Score/Matches/RPI excluded from graph by the vsTableOnly ruling;
enabling them needs an owner decision (metrics.js change, outside my authority).

## Units / commits
- [ ] A: imports + un-null readScope + describeScope footer fix + graphMetrics/radarEligible helpers
- [ ] B: graph.js repoints (discipline->ns, eligibleMetrics->graphMetrics) + byyear Vs-grey
- [ ] C: charts.js fetchSelectedPlayerMetrics matchup branch (bar/scatter/phases)
- [ ] D: benchmark.js (preserve matchupVs + vsTableOnly filter) + phaseFamilies.js matchup families
- [ ] E: players.js seed ns fix; searchPlayers left plain (flagged)

## Gotchas
- config.discipline must stay "batting"/"bowling" (card.js eyebrow uppercases it).
- buildMatchupQuery pulls state.columns[ns] (defaults) regardless of requested metricKeys
  -> output always carries default matchup cols; harmless (read only my metric key).
- Line (byyear) GREY under Vs (B2's job): evaluateTypeStatus early Vs guard.
- searchPlayers uses plain view for name->id lookup; ids valid across namespaces, matchup
  value computed at chart time => correct for finding candidates. Left plain, flagged.
- applyGraphFilters ~2006 sort-key validity check left on plain discipline per brief.

## Status: COMPLETE — all units committed + self-verified in browser

Commits: B1a wrapper/footer/helpers · B1b repoints+Line-grey · B1c charts.js branch ·
B1d benchmark+phases · B1e players seed. Forbidden files (table/filters/metrics/state/
drawer/timeseries) untouched; charts.js PLAIN branch byte-identical.

VERIFIED (localhost:8000, 0 console errors throughout):
- PLAIN baseline via buildQuery: 2,813 players / Karanbir 2,454; plain fetch branch
  returns Karanbir 2,454 (matchupVsActive=false path untouched).
- Vs=Spin bar fetch == independent DuckDB: Waseem 701, Virandeep 688, Anshuman 677,
  K Kadowaki-Fleming 664, RK Paudel 644, SD Hope 615; charted Buttler 470 / de Kock 272 /
  Kohli 44 / Jadeja 11 all == DuckDB.
- benchmark/radar pool preserves Vs (701/688/677/664); window (slope/dumbbell) SR ==
  DuckDB (A. Russell WinA 193.33 / WinB 171.43).
- On screen under Vs=Spin: Bar, Scatter, Radar, Phases (3-phase), Benchmark, Slope,
  Dumbbell all render with correct/sane values + footer "…, vs Spin". Line = (unavailable).
- graphMetrics: plain byte-identical; matchup drops matches/high_score/runs_per_innings/
  comp_* (vsTableOnly+composition). benchmark drops runs_per_innings too.

FLAG (owner): vsTableOnly (decision 47c, "never the graph") EXCLUDES High Score / Matches /
Runs-per-Innings / Best Bowling from the graph. The B-plan expected High Score chartable;
honoring the owner flag instead. Enabling them = an owner decision (metrics.js change).
