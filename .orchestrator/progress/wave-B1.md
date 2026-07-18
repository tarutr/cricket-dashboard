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

## Status: STARTING
