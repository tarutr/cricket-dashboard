# Wave C — 4e / A9: option lists scoped to full Search Conditions

## Task
Team / Opposition / Event / Venue advanced-drawer option lists were scoped to
gender + team-type only. A9 (decision 47e) = scope them to the FULL Search
Conditions: gender + format + date + team-type.

## Files owned
- src/playerData.js  (searchTeams/searchEvents/searchVenues loaders)
- src/drawerInnings.js (the four loader callers + the shared cache key)

## Verified facts before coding
- App view `matches` = data/export/matches.parquet. DESCRIBE confirms columns:
  match_id, match_type, gender, team_type, match_date (DATE), year, month, venue,
  city, event_name, team_1, team_2, winner, result_type.
  => all four scope dims (gender + match_type + match_date + team_type) present.
- expandFormats("T20") -> ["T20","IT20"] (state.js FORMAT_BUCKETS). Same buckets
  the main query uses on the innings views; match_type on `matches` == same values.
- Dates day-bounded: buildCoreScopeClauses (filters.js) handles both "YYYY-MM" and
  "YYYY-MM-DD", exclusive upper bound = following day/month. REUSED verbatim.
- sync propagation: main.js store.subscribe -> drawerController.sync() (only while
  the Filters popup is open) -> syncSingletonRows -> teamController.sync() etc.
  So format/date changes DO reach mountScopedMultiSelect.sync() while popup open.
- searchSelect setValues/setOptions DROP a selection not in the loaded options
  (no onChange) -> staleness edge case flagged (see CONCERNS).

## SQL fragments added
matchOptionScope(gender, teamType, formats, dateFrom, dateTo):
  - formats == null  -> `gender = '<g>'<teamTypeMatchClause>`  (pre-A9 fallback)
  - formats supplied -> buildCoreScopeClauses({gender,formats,dateFrom,dateTo,teamType}).join(" AND ")
    e.g. gender = 'male' AND match_type IN ('T20','IT20')
         AND match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'
         AND team_type = 'international'
Loaders: searchTeams UNION-branch WHERE ${scope}; searchEvents/searchVenues
WHERE ${scope} AND <entity> IS NOT NULL.
cacheKey now: `${gender}|${teamType}|${formats.join(",")}|${dateFrom}|${dateTo}`.

## Status
- [DONE] loaders + callers + cacheKey. Committed 040229b (only playerData.js +
  drawerInnings.js staged; other dirty files belong to concurrent C1a/C1c workers).
- node --check: both files OK. filters.js NO DIFF (buildScopeClauses untouched).
  buildCoreScopeClauses confirmed exported (filters.js:97).

## Independent DuckDB (raw parquet, hand-written; scratchpad/a9_verify.sql)
Scope: male / T20 bucket / international / 2023-07-01..2026-07-02 (day-bounded
=> match_date < 2026-07-03). Narrow = last 30d (2026-06-02..2026-07-03).
- teams : full 105, narrow 41, narrow-not-in-full 0  (subset, shorter)
- events: full 228, narrow 15, narrow-not-in-full 0  (subset, shorter)
- venues: full 179, narrow 13, narrow-not-in-full 0  (subset, shorter)
- pre-A9 teams (gender+intl only, all fmt/dates) = 110; A9 full = 105; A9-not-in-
  preA9 = 0 => A9 narrows by 5, all still ⊆ old list.
- T20 bucket = T20 (1723) + IT20 (1) => match_type IN ('T20','IT20') correct.
- exact loader Team SQL returns 105 distinct; top row Indonesia 105 games.

## Gotchas / CONCERNS
- Selection staleness on format/date change: picked team/event/venue can leave the
  narrowed list; searchSelect setValues/setOptions drop it from the picker display
  WITHOUT firing onChange, so state.teams/event/venue keeps the pick (pill + query
  still honor it). filters.js clears these on gender/teamType change but NOT on
  format/date — clearing lives in filters.js (out of scope, forbidden). Flagged to
  orchestrator; NOT fixed.
