# Wave 6 pt2 — Event → Season nested picker

Branch: polish-b1-mechanical

## Approach
- New state field `eventSeasons: { [eventName]: string[] }` — presence of a non-empty
  array = narrowing to those seasons; absent/empty = "All seasons" (no narrowing).
- Query (filters.js buildScopeClauses event clause): when NO chosen event is narrowed,
  emit the EXACT pre-Wave-6 clause (byte-identical, backward-compatible). When some are
  narrowed, emit a per-event OR of `(event_name = X AND season IN (...))` / `event_name = X`.
- UI: mountEvent gains a nested season-groups block under the multiselect; one group per
  selected event; [All seasons] + a box per in-scope season (season_year_start DESC).
  All-checked ⟺ no narrowing (min-one guards, mirroring the format dropdown).
- Season options loader `searchEventSeasons` in playerData.js, scoped by the SAME
  matchOptionScope (gender/format/date/team_type) as searchEvents.

## Key risk / judgement call (FLAGGED)
- Standing decision 2026-07-18 clears state.event on ANY date change. wave6-design §B says
  the season list "recomputes when the date range changes". Implemented respecting the
  clear (loader is date-scoped; re-picking the event under a new window yields the new
  list). NOT reversing the clear. Flagged for owner.

## Status: in progress
