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

### Pending
- Boot on localhost:8000, 0 console errors, anchors (2,813 / Karanbir 2,454).
- Per-chart-type manual verification incl. Line X=Phase bowling case.
- Independent DuckDB check of the picked set on a Line X=Phase chart.
