# polish-b1-mechanical — four mechanical fixes (Best/Worst direction, derive race, name round-trip, scatter default)

Branch `polish-b1-mechanical`, from HEAD `37caa76`. All four owner-approved, from a read-only
audit. None moves a leaderboard/graph NUMBER (Rule 1). `table.js` / `filters.js` (the query
builders) left **byte-identical** — `git diff` on both is empty.

## FIX 1 — grey out Best/Worst for a direction-neutral ranking metric
`src/graph/graph.js`. Best/Worst rank the roster by the chart's active metric (Bar's metric /
Scatter's Y, via `rankMetricForActiveType`). For a `higherIsBetter === null` metric the old
`metric.higherIsBetter ? vb-va : va-vb` fell to ASCENDING (null is falsy) → "Best" silently
picked the LOWEST values, drawn highest-first.
- New `activeRankMetricIsNeutral()` (metric exists AND `higherIsBetter === null`).
- New `syncRosterModeButtons()` sets `is-active` + blocks Best/Worst (`aria-disabled` +
  `.is-disabled` + tooltip "No 'best' for a metric with no better/worse direction."). Called
  from `renderPlayerList()` AND `syncChartTypeButtons()` → reacts live, even in Manual mode.
- `deriveChecked()` coerces `best`/`worst` → `topnames` when neutral (covers every entry point:
  mode click, config-change reselect, type switch, reseed) so a live Best/Worst re-derives
  sensibly instead of showing a backwards ranking.
- roster-mode click handler no-ops on `aria-disabled` buttons.
- `styles.css`: `.graph-roster-mode .segmented__btn.is-disabled` (muted + `cursor:not-allowed`).
- Radar/Slope/Dumbbell/Benchmark (`rankMetricForActiveType` → null) are NOT neutral → Best/Worst
  left ENABLED (existing seed-order fallback), untouched. REPORT item: those buttons stay live
  and do a seed-order reshuffle, so they read as "Best/Worst still function" even though there's
  no metric behind them — flagged for the owner to decide separately.

Live-verified on :8000 — Bar+Matches → Best/Worst greyed+tooltip, Top Names/Manual live, click
on blocked Best = no-op; Bar+Runs → all re-enabled; Best(Runs)→Matches → falls back to
"Auto-selected: Top Names"; same via Scatter Y (Y=Matches blocks). Radar → all enabled.

## FIX 2 — stale auto-derive must not clobber a manual roster edit
`src/graph/graph.js`. `rankDeriveToken` was bumped only inside `deriveChecked`. Closed the race
two ways (both cheap): (a) `rankDeriveToken++` at the three manual sites (checkbox toggle,
mode→Manual click, search-add both branches) so an in-flight derive's `token !== rankDeriveToken`
drops its result; (b) the two pre-`setChecked` guards also bail on
`selection.getMode() === "manual"`. Either alone discards the stale derive.

## FIX 3 — name-collapse round-trip asymmetry
`src/canonicalNames.js` `aliasesFor()`: symmetric expansion — emit each literal alias first (in
order) then any typography-normalised form not already present. On ALL current data every alias's
normalised twin is already literal, so the IN-lists are **byte-identical**; it only hardens future
typography variants of KNOWN aliases. `pipeline/dev_test_event_name_roundtrip.mjs` (committed,
manual-run, duckdb-CLI, SKIPs when data/CLI absent) is the tripwire.
- Proof (`scratchpad/fix3_check.mjs`, HEAD vs work over all 1,085 events / 53 stages): IN-lists
  byte-identical (0 diffs across 1,019 event + 46 stage canonicals), canonical-label parity 0
  diffs, round-trip guard 0 misses. Mechanism demo: a curly-only alias whose straight twin
  appears in a future refresh — HEAD drops it, WORK matches it.

## FIX 4 — scatter default must never be X == Y
`src/graph/graph.js` `metricFieldFor()` scatter case. `defaultY: metrics[1] || metrics[0]` set
X==Y with one eligible metric. Now: `<2` eligible → `kind:"none"` prompt (no axes offered);
`>=2` → `defaultX: metrics[0]`, `defaultY: metrics[1]` (distinct). Chose the prompt because with
one metric neither axis pairing is valid; the Builder already excludes each axis's metric from the
other so it can't produce X==Y either. Live-verified: `evaluateChartTypesForPlayer` scatter field
= {defaultX:"matches", defaultY:"innings"} (distinct). Single-metric branch not reproducible with
current data (every scope exposes ≥2 graph metrics) — guaranteed by code inspection.

## Verify
- `node --check` on graph.js / canonicalNames.js / the tripwire — all OK.
- Anchors reproduced on :8000 (Men/T20/International, 2023-07-01→2026-07-02): 2,813 players,
  Karanbir Singh 2,454, SA Yadav 64 MAT / 60 INNS / 1,544 / 29.13 / 150.34.
- 0 console errors throughout.
- Query builders byte-identical (git diff empty); canonicalNames feeds only event/stage IN-lists,
  proven byte-identical.

## Not committed (per brief): src/config.js (local-data override), review/BACKLOG.md,
## .orchestrator root *.md/*.json, reference/ingest.py, article_ideas/.
