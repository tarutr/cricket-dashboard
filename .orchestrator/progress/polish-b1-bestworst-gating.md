# Best/Worst roster-mode gating — generalised beyond neutral-metric Bar

Follow-up to `polish-b1-mechanical-4-fixes.md`'s FIX 1. Owner ruling: Best/Worst roster modes are
available ONLY on a Bar chart whose metric has a better/worse direction; greyed everywhere else
(Top Names/Manual stay available on every chart type).

FIX 1 (prior commit `6fc0c0c`) already greyed Best/Worst when the Bar/Scatter rank metric is
direction-neutral (`higherIsBetter === null`), via `activeRankMetricIsNeutral()` +
`syncRosterModeButtons()` + `deriveChecked()`'s coercion to Top Names. It left Scatter (dual-metric
— "Best" silently ranked by the Y axis only) and Radar/Slope/Dumbbell/Benchmark (no single rank
metric — `rankMetricForActiveType` returns null; Best/Worst did a meaningless seed-order reshuffle)
enabled. This closes that gap.

## Change — `src/graph/graph.js`
Replaced `activeRankMetricIsNeutral()` with `bestWorstAvailable()`: `true` iff
`chartType === "bar"` AND the bar metric's `higherIsBetter !== null`. Everything else (Scatter,
Radar, Slope, Dumbbell, Benchmark, no metric chosen yet) is `false`.
- New `bestWorstDisabledReason()` — two tooltip strings: the original neutral-metric wording for
  Bar, and "Best/Worst rank by a single metric — not available on this chart." for every
  non-Bar chart type.
- `syncRosterModeButtons()` now blocks on `!bestWorstAvailable()` and shows the matching reason as
  `title`. No new wiring needed — it's already called from `renderPlayerList()` and
  `syncChartTypeButtons()` (FIX 1's call sites), so chart-type switches and bar-metric commits both
  react live for free.
- `deriveChecked()`'s Best/Worst→Top-Names coercion now fires on `!bestWorstAvailable()` instead of
  the neutral-only check, so switching chart type (or metric) OUT of the one enabled case while
  already in Best/Worst always drops back to Top Names — no stale backwards/seed ranking left on
  screen for any of the newly-disabled chart types either.
- Did not touch `table.js`, `filters.js`, or `canonicalNames.js` — `git diff` on all three is
  empty.

## Verify (on :8000, Men/T20/International, 2023-07-01→2026-07-02)
- `node --check src/graph/graph.js` — OK.
- Anchors: 2,813 players, row 1 Karanbir Singh 2,454 runs; SA Yadav 60 inns / 1,544 runs / 29.13
  avg / 150.34 SR — all exact, reproduced both on the Stats table and independently inside the
  Graph Builder's own roster-pool count. 0 console errors throughout.
- Per-chart-type `aria-disabled`/tooltip read directly off the DOM (`.segmented__btn[data-value]`):
  - Bar + Runs (directional): `aria-disabled="false"`, no tooltip. Clicked Best → rendered
    "Runs — top 15" bar chart matching the Runs leaderboard exactly (Karanbir Singh 2,454 top,
    SA Yadav 1,544 at #11).
  - Bar + Matches (neutral): `aria-disabled="true"`, tooltip "No 'best' for a metric with no
    better/worse direction." — unchanged from FIX 1.
  - Scatter: `aria-disabled="true"`, tooltip "Best/Worst rank by a single metric — not available
    on this chart." Switching from Bar+Runs+Best directly into Scatter auto-coerced the roster
    mode to Top Names (verified via `is-active` on the DOM).
  - Radar, Slope, Dumbbell, Benchmark, Grouped Bars (phases — not explicitly named in the brief
    but covered by the same general predicate, verified for consistency): all `aria-disabled="true"`
    with the scatter/multi-metric tooltip text.
  - Top Names / Manual: `aria-disabled="false"` on every chart type tested. Rendered a Grouped
    Bars chart (Phase strike rate) under Top Names successfully (8 most-capped players, 3 phase
    bars each) to confirm rendering is unaffected by the gating change.

## Not committed (per brief)
`src/config.js` (local-data override — do not touch), `reference/ingest.py`, `.obsidian/`,
`review/BACKLOG.md`, `.orchestrator/*.md`/`*.json` other than this progress note.

## Concerns
- With Bar selected but no metric chosen yet, `bestWorstAvailable()` is `false` (metric is null)
  and `bestWorstDisabledReason()` falls into the Bar branch, showing "No 'best' for a metric with
  no better/worse direction." even though the real reason is "no metric picked yet." This is a
  transient state before a metric is selected (Update chart is disabled at that point too) and
  wasn't one of the two cases named in the brief, so left as-is rather than adding a third tooltip
  string not requested — flagging in case the owner wants a third wording for that instant.
