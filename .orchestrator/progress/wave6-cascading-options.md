# Wave 6 polish — cascading (cross-filtered) advanced-filter option lists

Branch: polish-b1-mechanical (from HEAD 393ba64) · Status: COMPLETE (verified on
localhost:8000 against the local export in `data/export/`; the config override is
the orchestrator's and is NOT committed).

## Owner rule implemented
Inside the advanced filters, a dropdown's OPTIONS respect every other active
selection. Removing a filter re-expands the options and never alters what is
already picked. Existing reconcile paths (Stage `reconcileSelection`, Season
`reconcileNarrowing`) untouched.

## Approach + key risk
The six DB-derived option lists all query `matches`, so every participating
sender is expressible as one extra WHERE fragment on a `matches` row. Two halves,
each implemented in exactly ONE place:

1. **SQL** — `playerData.js` `siblingOptionClauses(sel, exclude)`, folded into the
   existing `matchOptionScope(...)` as two new optional/additive params. It emits
   the sender fragments from SHARED builders now exported by `filters.js`:
   `eventPredicateSql` (event + per-event season narrowing), `venuePredicateSql`,
   `stagePredicateSql`, `resultConditionPredicateSql`, `tossDecisionPredicateSql`.
   Those five were EXTRACTED from `buildScopeClauses` / `buildMatchContextClauses`
   and are now called BY them, so the live query and the option lists share one
   definition of e.g. "Normal = method IS NULL AND NOT COALESCE(is_super_over,
   false)" and can never drift. `alias` ("mctx" for the live LEFT JOIN, "" for a
   bare `matches` scan) is the only difference between the two consumers.
2. **Cache keys** — `drawerInnings.js` `optionCacheKey(state, exclude)` =
   `optionScopeKey` (gender|teamType|formats|dates, unchanged) + `optionSiblingKey`
   (every sender except the excluded ones). Every mount now keys on it, so a
   sibling change actually reloads the list.

SELF-EXCLUSION is per list: Event ignores `event` (and its seasons), Venue ignores
`venue`, Stage ignores `stage`, Season ignores `eventSeasons` but still narrows by
`event`. Team/Opposition share `searchTeams` but are two different filters, so the
loader takes `role`: the Team list narrows by `opposition`, the Opposition list by
`teams`.

KEY RISK (Rule 1): the five extractions touch number-critical code. Proven
byte-identical over 22 filter states × 4 query shapes (below). Second risk: the
`other`-side formulation for Team↔Opposition — see the note in `searchTeams`.

NOT senders (per brief, owner-confirmed): result, tossResult, inningsOrder (all
player-relative — they compare the ROW's team to the match), vs, rpos,
strikerpos, hand, bowling, role, fld_*, and every numeric `m:*` condition.

## What changed
- `src/filters.js` — new shared section "`matches`-row predicate fragments":
  `matchCol`/`orJoin` helpers + the five exported predicate builders.
  `buildScopeClauses`' event/venue semi-joins and `buildMatchContextClauses`'
  Stage / Result Condition / Toss-decision blocks now CALL them (same strings).
- `src/playerData.js` — `matchOptionScope` gains `(sel, exclude)`;
  new `siblingOptionClauses`, `teamPairPredicateSql`, `optionInList`. All five
  loaders take a trailing options object: `searchTeams(…, {sel, role})`,
  `searchEvents/searchVenues/searchEventSeasons/searchStages(…, {sel})`.
  `searchTeams`' sides CTE now carries `other` (the opposite side) so the
  Team↔Opposition narrowing is exact. `searchStages`' old `eventNames` param is
  gone — event (and now season) narrowing arrives via `sel`.
- `src/drawerInnings.js` — `optionScopeKey`/`optionSiblingKey`/`optionCacheKey`;
  `mountScopedMultiSelect` takes `config.siblingExclude` and keys on it;
  mountTeam/mountOpposition pass `role`; mountEvent/mountVenue pass `sel`;
  `mountStage`'s `scopeKey` and `mountEventSeasons`' `dataKey` both go through
  `optionCacheKey`. Also fixed the in-flight-load guard in all three loaders
  (`loading` boolean → `loadingKey`), which with cascading would otherwise
  swallow a reload when a second sender changed mid-flight.

## Verified
- `node --check` on all three touched files: pass.
- BYTE-IDENTICAL harness (node, real `buildQuery` + `buildMatchupQuery` +
  graph-fetch SQL via a stubbed db.js; HEAD 393ba64 vs working tree) over 22
  states — empty, sentinel-only, event×2, event→season×3, venue, stage×4, result
  condition×6, toss decision×2, player-relative context, kitchen-sink — × 4 query
  shapes each: **IDENTICAL**, sha256
  `69abe5930bc76ee379121fcb86d7d3238d13ca461d6f84f1aaa69f32d2224817` (135,283
  bytes). Branch coverage confirmed by grep on the emitted SQL (`season IN (` 15×,
  `COALESCE(mctx.is_super_over, false)` 25×, `mctx.event_stage IS NULL` 15×,
  `mctx.toss_decision IN` 15×, `venue IN (` 10×, `event_name IN (` 30×,
  `mctx.method IN (` 20× — same counts both trees).
- ANCHORS in-app (Men / T20 / International, 2023-07-01 → 2026-07-02): 2,813
  players, Karanbir Singh 2,454; SA Yadav 60 inns / 1,544 runs / 29.13 / 150.34;
  JJ Bumrah vs Right-handers, striker positions 1–2 = 27 inns / 177 balls / 9
  wkts; SA Yadav vs Spin = 38 inns / 454 runs / SR 140.99, coverage 913 of 1,027.
  Re-checked 2,813 / 2,454 AFTER all the cascading interaction. Zero console
  messages of any kind throughout.
- OWNER SCENARIO (Red Ball + Domestic): Event list = 4 events; Event = County
  Championship → **Venue list = 28 options, only county grounds**. Independent
  hand-written SQL (own day-bounds, own shape): 28 distinct venues / 379 matches /
  Kennington Oval 21 — and a set comparison of all 28 labels+counts UI vs SQL:
  IDENTICAL, no extras either way. Picked Kennington Oval → list still 28, Oval
  selected. **Removed the Event row → Venue options expand 28 → 83** (= independent
  SQL for Red Ball + Domestic) **and Kennington Oval stays selected** (toggle + a
  ticked option). Oval's "21 games" is correct in both lists (all 21 of its
  red-ball domestic matches are County Championship).
- SELF-EXCLUSION: Event = County Championship → Event list still all 4 events with
  unchanged counts. Venue = Kennington Oval → Venue list still all 28. Stage =
  Final → Stage list still all 9 named stages + No Stage. Season narrowed to
  {2024, 2023} → Season list still offers all 3 (2026 included).
- TEAM ↔ OPPOSITION (T20 + International): both lists start at 105. Team = India →
  **Opposition list = 16**, exactly India's opponents per independent SQL
  (membership identical), **India itself not offered** (it cannot be its own
  opponent), while the **Team list stays 105** with India ticked. Reverse:
  Opposition = India → **Team list = 16** with per-team counts vs India (South
  Africa 12, Australia 11, England 8, … summing to 76 = India's own 76 games) and
  the Opposition list stays 105.
- RESULT CONDITION = D/L → Venue list 179 → **36**; all 36 labels + game counts
  IDENTICAL to independent SQL on `method='D/L'`.
- STAGE as receiver: Event = Continental Cup → Stage list narrows to exactly that
  event's 5 stages (raw "Semi Final" folded to canonical "Semi-Final") + No Stage
  (17 NULL-stage matches); independent SQL agrees exactly. Narrowing the SEASON to
  {2024, 2023} narrows it again to {3rd Place Play-Off, Final, Qualifier} + No
  Stage — exactly the SQL result, proving `eventSeasons` works as a sender.
  Venue = Udayana (all 80 matches unlabelled) → Stage row honestly shows "No
  tournament stages to choose in this scope." and no dropdown.
- STAGE as sender: Stage = Final → Event list = 37 canonical options whose games
  sum to **50** = the number of Final matches in scope (39 raw event names folding
  to 37 canonical). SEASON as receiver: Continental Cup ran in 4 seasons but only
  3 staged a Final → with Stage = Final the Season dropdown offers exactly those 3
  (2025 correctly absent).
- CACHE KEYS: every narrowing above is a live reload after a sender change
  (28→83, 179→36, 105→16, 10→7→5 stage options, 4→3 seasons); no stale list
  observed in any direction.
- END-TO-END: with the cascaded Venue = Udayana applied, Search gives 163 players,
  top row GA Priandana 51 inns / 1,154 runs — independent SQL: 163 distinct
  batters, top scorer 1,154 in 51 innings.
- GRAPH VIEW's own Filters drawer cascades identically (same shared drawer on the
  buffer store): Event = ICC Men's T20 World Cup (3 raw aliases) → Venue list = 17,
  matching independent SQL (17 venues across 93 matches).

## Also fixed
- The three option loaders guarded concurrency with a bare `loading` boolean, so a
  scope change arriving mid-flight was swallowed and the list kept stale options
  until the next interaction. Now keyed (`loadingKey`/`loadingScope`) with the
  existing loadToken still discarding superseded responses. Pre-existing, but
  cascading makes rapid sender changes normal.

## Concerns (flagged, NOT resolved)
1. **Team↔Opposition uses the OTHER side of the match, not "match involves X".**
   With Team = India the Opposition list is India's opponents and excludes India,
   because `batting_team = India AND bowling_team = India` returns nothing. With
   several teams picked a co-selected team is still offered when it is a legal
   opponent (Team = {India, Australia} keeps Australia). This is a product-judgment
   call (it matches the brief's stated expectation and the app's existing "an
   option that can only return zero rows is not a choice" principle) — worth an
   owner confirmation.
2. **A picked value that later falls out of its own list disappears from the
   toggle while the pill + query keep applying it.** `mountSearchMultiSelect`'s
   `setOptions`/`setValues` filter to loaded options; state is never touched, so
   the number stays right and the pill stays honest, but the drawer control reads
   e.g. "Any venue". Pre-existing (documented for format/date changes in the last
   pass's concern 3); cascading adds new routes to it — narrowing a Stage or Season
   can strand a picked venue/team. NOT changed here because the brief says leave
   reconcile behaviour exactly as is. The clean fix is to keep a
   selected-but-out-of-scope value in the widget's option list so it stays visible
   and removable. Owner call.
3. **Narrowing can silently drop a Stage pick** via the EXISTING reconcile: with
   Stage = Final, picking a venue/event that never staged a Final snaps Stage back
   to All. That is the ruled behaviour for impossible selections, now reachable
   from more directions. Flagged, untouched.
4. `searchStages`' `eventNames` parameter was REMOVED (event narrowing now flows
   through `sel`, which also applies the season narrowing the old param ignored).
   Only caller was mountStage.
5. `src/playerData.js` still contains the literal NUL byte noted last pass (use
   `grep -a`).
