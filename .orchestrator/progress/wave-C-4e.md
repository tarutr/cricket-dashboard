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
- [in progress] loaders + callers + cacheKey
## Next
- node --check, git status proof, independent DuckDB SQL for orchestrator.
## Gotchas
- Selection staleness on format/date change (picked team can leave the narrowed
  list; state not auto-cleared — clearing lives in filters.js, out of scope).
