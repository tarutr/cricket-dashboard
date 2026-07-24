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
