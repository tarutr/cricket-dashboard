# Retrofit: hardcoded men-only filter gates → data-driven availability (living)

Branch `ball-layer`, main tree, NO git (orchestrator commits). Flag-OFF vs R2.
Owner ruling: filter availability DATA-DRIVEN, never gender-hardcoded; display/offer
ONLY — query builders (buildQuery/buildMatchupQuery/buildScopeClauses/conditionToHaving/
profileSemiJoinSql/matchupVsActive) UNTOUCHED (numbers sacred).

## Investigation (DONE — verified live vs R2, flag-off)
- `profiles` has NO gender/match_type/match_date/team_type cols → loadDimOptions CANNOT
  run on it. Gender-scope profiles via a `player_matches` semi-join (it carries gender +
  core scope + player_id).
- `matchup_batting.bowling_type` / `matchup_bowling.batting_hand` DO carry core-scope cols.
  Male has real styles/hands; female has ONLY '(unmapped)'. Signal = distinct minus
  '(unmapped)' non-empty.
- FORMAT_BUCKETS keys = ["Red Ball","50 Over","T20"]. Format keys are UPPERCASE ('T20').
- Empirical probe (all formats, gender axis): male → all 5 available TRUE; female → all
  FALSE. Reproduces today (men shown / women hidden), future-proof (women data → auto-show).

## Decision: GENDER-scoped availability (all formats), NOT format/date sub-scoped
- Reproduces today EXACTLY for every scope (men always shown / women hidden); zero edge
  regression; avoids a product decision about narrow-scope hiding (Rule 3). Data-driven on
  the axis that determines existence (gender). Reuses loadDimOptions for matchup.

## Plan
1. NEW src/filterAvailability.js — createFilterAvailability(): isAvailable(key,s) sync +
   ensureLoaded(s,onReady) async; cache keyed by gender; optimistic-true until loaded.
   5 keys: vsBowlingStyle, vsBattingHand, profileRole, profileHand, profileBowling.
2. paletteGroups.js — replace `!women` (role/hand/bowling lines 266-268) + `if(!women)`
   (matchup line 439) with isFilterAvailable(...); add deps isFilterAvailable +
   ensureFilterAvailabilityLoaded; drop `const women`.
3. drawer.js — instantiate availability; wire deps + onReady(sync+renderNumeric force);
   isPresent: replace `menOnly && female` gate with data-driven; drop `menOnly:` fields;
   activeCount: drop `if (gender !== female)` wrapper (values null for women anyway).
4. playerFilterEditor.js — instantiate availability; wire deps + onReady(rebuild+render).

## Status: COMPLETE + verified (flag-off vs R2). Awaiting orchestrator commit.

### Files changed
- NEW `src/filterAvailability.js` — createFilterAvailability(): sync isAvailable(key,s) +
  async ensureLoaded(s,onReady); per-gender cache; fast `SELECT 1 … LIMIT 1` existence probes
  (matchup: distinct minus '(unmapped)'; profile: profiles ∩ player_matches semi-join).
- `src/paletteGroups.js` — profile leaves (role/hand/bowling) + matchup Vs family now gated on
  isFilterAvailable(...) not `!women`; deps isFilterAvailable + ensureFilterAvailabilityLoaded;
  dropped `const women`.
- `src/drawer.js` — availability instance + mount/sync warm + onReady(sync+renderNumeric force);
  isPresent: menOnly gender gate → singletonDataAvailable (data-driven); dropped all `menOnly:`
  fields from SINGLETON_TYPES; activeCount: dropped `gender!=="female"` wrapper; structuralKey:
  `women:` field → data-driven avail signature.
- `src/playerFilterEditor.js` — availability instance + deps + onReady(rebuild+render).

### Verified (all PASS)
- Anchors: 2,813 / Karanbir 2,454 (app); SA Yadav 60·1,544·29.13·150.34 (independent DuckDB);
  SA Yadav vs Spin 38/454/140.99 (app). Profile filter Role=Bowler → app 277/S Muniandy 704 ==
  independent DuckDB 277/S Muniandy 704.
- Leaderboard MEN: profile + matchup OFFERED + working. WOMEN: hidden (deterministic
  buildPaletteGroups + live trace 93→77 leaves).
- Popup: MALE player matchup Vs offered (UI + deterministic); FEMALE hidden (deterministic);
  profile leaves always excluded (unchanged).
- No hardcode in gating (grep paletteGroups+drawer → comments only). Query builders UNTOUCHED.
  config.js clean. node --check all. 0 console errors.
- NOTE: app mounts drawer.js TWICE (Stats + Graphs via graph.js:2763) — each gets its own
  availability instance; both correct (shared code). Popup Tab-2 works flag-off.
