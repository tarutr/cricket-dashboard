# Shortcuts usability gate — progress

Task: player-selection shortcuts (Top Names / Best / Worst) must auto-select ONLY players
that have the COMPLETE data the current chart needs. Unify the roster "[usable]" badge to use
the SAME predicate. Branch: `polish-b1-mechanical`. Numbers-sacred safe (selection only).

## Checkpoint 1 — implementation (code complete, verification pending)

All edits in `src/graph/graph.js` (only file touched).

- `deriveChecked(newMode)`: added the USABILITY GATE. For every non-manual mode, when the chart
  is configured enough to judge (`chartabilitySignature !== null`) AND the type is not benchmark,
  it computes `computeChartabilityFor(poolIds, state)` (ONE batched read) and restricts the ranked
  list to the usable subset BEFORE capping. topnames ranks the usable subset by career games;
  best/worst rank the usable subset (bar/scatter by the active metric, others by seed order).
  Fewer usable than cap => all usable; zero usable => empty. Token-guarded with the existing
  `rankDeriveToken`; fetch failure falls back to the whole pool (never empties/crashes).
- `computeChartabilityFor` (the ONE shared predicate — badge + selection):
  - phases branch TIGHTENED `.some` -> `.every` (real value in ALL phase members).
  - byyear branch made X-dim-aware: X = "phase" -> need ALL buckets; open-ended X -> keep >=2.
  - benchmark branch LEFT as `.some` (owner-ruled single-subject; not a shortcut concern).
  - doc comment rewritten to state it is the one usability predicate + the tightened rules.
- Renamed `onRankMetricChanged` -> `onChartConfigChanged` and broadened it: re-derives ALL
  non-manual modes (topnames included, since usability now depends on config), + `reselectForConfigChange`
  helper that returns the derive promise. Wired it to every usability-affecting control:
  bar metric, scatter X + Y, radar axes, phases family, slope metric + both windows, line X-dim +
  metric, dumbbell metric + both windows. Benchmark controls left untouched (as-is).
- Initial auto-select: `maybeAutoSelectFromFilters` is now async and awaits `reselectForConfigChange`
  after picking an auto chart, and `onShow` / `onScopeChanged` await it before drawing — so the
  FIRST auto-selection is usability-gated, not just later edits.

`node --check src/graph/graph.js` passes. No references to the old name remain.

### Approach + key risk (stated up front)
Route ALL non-manual modes through the existing `computeChartabilityFor` so badge and selection
literally share one function (decision 2 — can never diverge). Risk: an extra batched query on
best/worst for bar/scatter (usability probe + rank fetch over the smaller usable subset). Accepted
per brief perf note (parquet scan dominates, not id-list length; user-initiated, < 1.5s target).

## Checkpoint 2 — verification COMPLETE (localhost:8000, browser pane)

- Boot: ZERO console errors, stayed clean through all interaction.
- Anchors on Stats (Men/T20/International, 2023-07-01→2026-07-02): 2,813 players, top row
  Karanbir Singh 2,454 — reproduced exactly.
- Line X=Phase, BATTING, Strike Rate:
  - Top Names picked Buttler/Maxwell/Miller/Warner/Shakib/Kohli — all badged [usable]. RG Sharma
    (a top-6-by-caps name, picked when ungated) was DROPPED and replaced by Warner. Independent
    DuckDB (raw pp_/mid_/death_balls sums, NOT the app SR aggregation): all 6 have balls in all 3
    phases; RG Sharma has death_balls=0 → correctly excluded.
  - Worst picked obscure low-run players (Manning/Dalyan/Ahmad/Ramautar/Hermann/Coulibaly) — all
    [usable]; independent DuckDB confirms all 3 phase buckets present (not empty/no-data rows).
- Line X=Phase, BOWLING, Bowling Strike Rate: Top Names picked Adil Rashid/Holder/Southee/
  S Curran/Russell/Maxwell — independent DuckDB confirms wickets>0 AND balls>0 in pp+mid+death.
- Grouped Bars, BOWLING, Phase economy (PP·death) — the `.some`→`.every` tightening:
  - Top Names (8) and Best (8) all [usable]; independent DuckDB: every pick has balls>0 in BOTH pp
    and death.
  - COUNTER-EXAMPLE proving the tightening + unification: SA Mohandas (pp_balls=276, death_balls=0)
    is now badged NOT usable (strikethrough) — under the old ≥1 rule he was usable. Badge = the same
    predicate the shortcut uses, so he can never be auto-picked here.
- All three shortcuts (Top Names / Best / Worst) exercised; badge and auto-pick always agreed.

VERDICT: PASS. Anchors intact (no query-builder/metric change). Selection now gated to usable
players via the unified predicate; re-derives on config change and initial auto-select.
