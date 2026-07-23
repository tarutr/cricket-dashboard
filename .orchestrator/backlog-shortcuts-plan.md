# Fix: player-selection shortcuts must pick only USABLE players (owner 2026-07-23)

Status: PLAN — awaiting owner approval + two definition decisions. Do NOT build yet.
Not numbers-sacred (changes only WHICH players auto-select, never a computed value), but it lives in
`src/graph/graph.js` — the largest/most fragile browser file — and is cross-cutting + async.

## The bug (owner report)
Top Names and Worst surface players with no stats for the graph. Shortcuts should include ONLY
"usable" players (have the data the graph needs). For multi-point/multi-metric charts (Line, Radar,
Grouped Bars…) a usable player must have data at ALL points/metrics (e.g. bowled in powerplay AND
middle AND death). "Worst" should rank the worst AMONG usable players, not literal no-data players.

## Root cause (verified)
`deriveChecked(mode)` (graph.js ~1016–1107):
- **topnames** (default): ranks whole pool by whole-DB career games, takes top `cap`. NO usability check.
- **best/worst**: only `bar`/`scatter` have a single rank metric → those filter `hasMetricData` (so they
  already exclude no-data players on that ONE metric). Every OTHER type (radar/phases/slope/dumbbell/
  byyear=line) has no single rank metric → `rankMetricForActiveType` returns null → falls back to raw
  seed order (reversed for "worst"). NO usability check. ⇒ "worst" = bottom of seed sort = no-data players.

The usable set is ALREADY computed per chart type by `computeChartabilityFor(ids, state)` (~1769–1860),
used only for the roster "[usable]" badges (R6 #9 / decision 59). It is NOT consulted by selection.

## The fix (approach)
Gate ALL three shortcuts through the usability predicate before capping, reusing the existing probe:
1. Compute usability for the candidate pool under the current chart config (one batched read — the
   query cost is dominated by the parquet scan, not the id-list size, so whole-pool is fine; bar/scatter
   already fetch the metric for the whole pool, so no new fetch there).
2. topnames → rank USABLE players by career games, take top `cap`.
3. best/worst on bar/scatter → already filters data; unchanged (verify it still ranks within usable).
4. best/worst on multi-point/multi-metric types → rank USABLE players (seed order, reversed for worst),
   take `cap`. Fewer than `cap` usable ⇒ pick all usable (never pad with unusable).
5. Re-derive triggers: today only bar/scatter metric changes re-derive best/worst. After the fix,
   changing the X-dim / phase family / radar axes / windows must ALSO re-derive (usability changed).
6. Cover the INITIAL auto-select path (first filter apply / seed), not just the mode-button clicks —
   confirm `seedSelection`/`applyAutoSelect`/`maybeAutoSelectFromFilters` route through the same gate.
7. Keep all async token-guarded (deriveChecked already uses rankDeriveToken; the added usability fetch
   must respect it so a superseded derive can't overwrite a newer one). When the chart isn't configured
   enough to have a usability verdict (chartabilitySignature === null), skip the filter (can't know yet).

## DECISION 1 — RESOLVED (owner 2026-07-23): COMPLETE DATA, SMART PER X-AXIS
"Usable" = has the complete data the chart needs. Exact per-type rule:
- **bar / benchmark**: has a real value for the metric(s). (benchmark: keep ≥1-of-4? → treat as its current
  rule; benchmark is single-subject, not a multi-player shortcut concern — leave as-is unless it regresses.)
- **scatter**: real value on BOTH axes. (already correct)
- **radar**: real value on EVERY selected axis. (already correct)
- **slope / dumbbell**: real value in BOTH windows. (already correct)
- **Grouped Bars (phases)**: real value in ALL family members (all 3 phases) — TIGHTEN from current ≥1.
- **Line (byyear)**:
  - Fixed small bucket set (X = **Phase**): real value in ALL buckets (PP + middle + death) — TIGHTEN from ≥2.
  - Open-ended X (year / innings / event / month): keep the drawable rule (≥2 non-null points) — "all" is
    meaningless there (no player appears in every year).
  ⇒ the Line rule is X-dim-aware: Phase ⇒ all buckets; sequence dims ⇒ ≥2.

## DECISION 2 — RESOLVED (owner 2026-07-23): UNIFY badge + selection
The "[usable]" badge now means exactly "has the complete data this chart needs" — the SAME predicate the
shortcuts use. Badge and auto-pick always agree. This intentionally supersedes decision 59 #3's lenient
badge thresholds (Line ≥2 / phases ≥1) for the two tightened cases above (owner-authorized change).
Implementation consequence: there is ONE usability predicate (used by both `computeChartabilityFor`/badges
and the new selection gate) — not two — so they can never diverge.

## Sub-agent (Phase 3 assignment)
- Worker: **frontend-heavy** (Opus 4.8, effort **xhigh**) — this is the riskiest browser file, cross-cutting
  across all chart types, with async/token-guard correctness. (frontend-engineer/Sonnet is the fallback
  only if we want to try cheaper first; I recommend Opus given the fragility.)
- Owns: `src/graph/graph.js` (deriveChecked, the usability gate, re-derive triggers) and, IF decision 2 = unify,
  the badge predicate. MUST NOT touch query builders (table.js/filters.js) or metric sqlExpressions — this
  changes selection only, never a computed value.
- Deliver: usability-gated shortcuts for every chart type; re-derive on all relevant config changes; initial
  auto-select covered; token-guarded; node --check; boot localhost with 0 console errors.

## Verification plan
- Anchors unaffected by construction (no query-builder/metric change) — reproduce 2,813 / Karanbir 2,454.
- Per chart type, for each of Top Names / Best / Worst: every auto-selected player has the data the chart
  needs (spot-check a Line X=Phase bowling case — every picked bowler has PP+mid+death balls; a big name
  who never bowled in the powerplay is NOT picked). "Worst" shows the worst-performing USABLE players,
  not empty rows.
- Independent DuckDB check: for the picked set on a phase chart, confirm each has non-null pp/mid/death.
- Confirm the "[usable]" badges agree with who gets auto-picked (esp. if decision 2 = unify).
