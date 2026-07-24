# Wave 6 pt2 — Event → Season nested picker

Branch: polish-b1-mechanical  ·  Status: COMPLETE (verified on localhost, anchors held)

## What was built
- `state.js`: new field `eventSeasons: { [event_name]: string[] }` (proper-subset narrowing;
  absent/empty = "All seasons" = no narrowing). Helpers `seasonsForEvent`,
  `anyEventSeasonNarrowing`.
- `filters.js` buildScopeClauses event clause: when NO chosen event is narrowed → emits the
  EXACT pre-pt2 clause (byte-identical, verified true). When some are narrowed → per-event OR
  of `(event_name = X AND season IN (...))` / `event_name = X`. Also `eventSeasons: {}` added to
  the five scope-change clears + the gender handler.
- `playerData.js`: `searchEventSeasons(events, gender, teamType, formats, from, to)` — distinct
  seasons per event in scope, season_year_start DESC (same matchOptionScope as searchEvents).
- `drawerInnings.js` `mountEvent`: nested season sub-picker below the event multiselect.
  Per-event group = [All seasons] + a box per in-scope season. Min-one guards (All disabled while
  checked; sole season disabled). <=1 season -> [All] only. `reconcileNarrowing()` prunes narrowing
  to in-scope seasons on every reload (keeps state honest when the window shrinks).
- `pills.js`: Event pill shows season suffix when narrowed ("Event: IPL (2024)"); x clears the
  event's narrowing too.
- `drawer.js`: clearSingleton('event') also clears eventSeasons. `styles.css`: `.event-seasons`.

## Verified (localhost:8000, local export w/ season cols; config-override reverted after)
- Anchors (no event filter): 2,813 players / Karanbir 2,454 / SA Yadav 60/1,544/29.13/150.34 — EXACT.
- Byte-identical: buildScopeClauses(All) === pre-pt2 clause (in-page import compare -> true).
- IPL 2024->2026 window: season group = 2026/2025/2024 (DESC, no 2023-), All checked+disabled.
- IPL All: V Kohli 46/2,073 == independent recompute; pill "Event: Indian Premier League".
- IPL 2024: V Kohli 15/741, Gaikwad 583, Parag 573 == recompute of `event_name=IPL AND season='2024'`;
  pill "Event: Indian Premier League (2024)".
- Date-reactivity + single-season + reconcile: toolbar date -> 2026-only window shrank seasons to
  [All] only, dropped stale 2024 narrowing, Search -> 177 players V Suryavanshi 776 == IPL-2026 recompute.
- 0 console errors throughout.

## Judgement calls (flagged for report)
- Toolbar date change keeps the event selected (season list live-recomputes -> the design's
  "recomputes when date range changes" works here); the POPUP date change clears it (owner decision
  2026-07-18). Pre-existing toolbar/popup asymmetry (affects event/venue/teams too) — NOT reversed.
- App player count runs ~2-3 above raw COUNT(DISTINCT batter_id) (pre-existing app count definition;
  per-player aggregates match exactly). Baseline anchor 2,813 reproduces in-app exactly.

## Close-out — Wave 6 four match-context fixes (COMPLETE; anchors held)
All additive; query byte-identical when no match-context filter is active. Verified on localhost
with the local Wave-6 export in `data/export/` (config override pointed there, then REVERTED to R2).

- FIX 1 — Knockout button: `drawerInnings.js` KNOCKOUT_RE/GROUP_RE/isKnockoutStage replaced by an
  explicit 42-value `KNOCKOUT_STAGES` Set (owner-vetted). Independent DuckDB check: the 42-set
  covers exactly the 42 knockout event_stage values in the data (0 absent) and the 11 excluded are
  precisely the group/junk list. Men scope: button selects 33 of 40 stages on screen (7 group ones
  stay off) — matches the raw split.
- FIX 2 — `filters.js`: `stage: []` added to the format-change and gender-change clear handlers
  (alongside eventSeasons). Verified via the real mountFilters handlers: format/gender change clears
  stage → []; result/toss/innings/method left untouched (control passed).
- FIX 3 — `state.excludeMethod` boolean → `state.method: string[]` multi-select ("Rain-affected
  matches"). METHOD_NONE = "(not affected)" sentinel (state.js) = method IS NULL. Clause in
  filters.js emits `IN(...)` for real methods, `IS NULL` for the sentinel, OR'd when both. UI renders
  "Not affected / Awarded / D/L / Lost fewer wickets / VJD" for men (gender-scoped). Pill "Rain
  method: D/L" / "N methods". SA Yadav split verified: Not-affected 58/1462 + D/L 2/82 = 60/1544.
- FIX 4 — `graph/charts.js` fetchSelectedPlayerMetrics plain branch now appends matchContextJoinSql +
  buildMatchContextClauses (as table.js does). Verified: SA Yadav graph runs 1544 (baseline) → 1277
  (Result=Won) → 82 (method=D/L); Won recompute from raw = 1277 runs / 815 balls / SR 156.69 (exact).

Byte-identical proof: node harness diffed buildQuery/buildMatchupQuery + the graph fetch SQL, HEAD vs
working tree, across batting/bowling/matchup with no context filter → IDENTICAL. Anchors reproduced
in-app: 2,813 / Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34. 0 console errors. Files touched:
state.js, filters.js, table.js (serializeQueryState key rename only), drawer.js, drawerInnings.js,
pills.js, graph/charts.js. Concern flagged in report: FIX 3 min-one guard + "Awarded"/"Lost fewer
wickets" inclusion.
