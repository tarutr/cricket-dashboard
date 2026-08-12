# enum-fixes — display-only label / date-input / order / stale-comment pass

Date: 2026-08-12. Branch: ball-layer. Numbers-safe (labels/order arrays/input
type/comments only — no sqlExpression/query change). Anchors verified
byte-identical after the pass: 2,813 players / Karanbir Singh 2,454 runs /
SA Yadav 60 inns · 1,544 runs · 29.13 avg · 150.34 SR (Men/T20/International,
2023-07-01→2026-07-02).

## Fixes landed

1. `src/playerFieldingEditor.js` (~207/209): Scope ▸ Dates inputs `type="month"`
   → `type="date"` (aria-labels "From/To month" → "From/To date"), mirroring
   `src/playerFilterEditor.js` exactly. Live-checked in the pop-up's Fielding
   Filters ▸ Add Filter Row — dates now render dd/mm/yyyy day pickers.

2. Applied-label propagation (menu already had the new names; applied
   pill/row/column lagged):
   - `src/metrics.js`: `running_sr` (batting) label "Non-Boundary Strike Rate"
     → "NBSR"; `boundary_pct` (batting) "Boundary %" → "Boundary Ball %";
     `boundary_runs_pct` (batting AND bowling) "% Runs from Boundaries" →
     "Boundary Run %". DISMISSAL_KINDS labels (9 of 12 — the ones with a
     leading "Out ") dropped the prefix: Caught/Bowled/LBW/Stumped/Caught &
     Bowled/Hit Wicket/Obstructing the Field/Handled the Ball/Hit the Ball
     Twice (Run Out/Retired Out/Timed Out untouched — no prefix to drop).
     This also renames the `_pct` siblings (e.g. "Caught %" not "Out Caught
     %") and the columnsPicker.js dismissal-row comment that referenced the
     old prefixed label (now stale, fixed).
   - `src/drawer.js` SINGLETON_TYPES: `mc_result` "Result" → "Match Result";
     `win_balls` "Ball range" → "Team Ball Range"; `win_player` "Player balls"
     → "Batter/Bowler Ball Range".
   - `src/playerFilterScope.js` (pop-up store-adapter, same singletons):
     mirrored the same three renames for consistency in the pop-up's Filters
     tab applied rows.
   - `src/playerFiltersTab.js` describeFieldingRow: fielding-row summary chip
     "Result" → "Match Result" (same underlying value).
   - Live-verified via the browser: NBSR / Boundary Ball % / Boundary Run %
     (batting + bowling) / Caught / Match Result / Dismissed batter's
     position all now show the new name in BOTH the add-menu and the applied
     pill/row.

3. `src/metrics.js` bowling `dot_pct`: label "Dot Ball %" → "Dot Ball %
   Conceded", shortLabel "Dot%" → "Dot% Con". Batting's `dot_pct` untouched.

4. `src/columnsPicker.js` `BOWLING_DETAILED_ORDER`: added `boundary_pct_conceded`
   and `boundary_runs_pct` right after `strike_rate` (was `["economy",
   "average", "strike_rate"]`, now includes both trailing %s in a curated
   spot instead of falling off the end of the Detailed Stats picker list).

5. Stale comments fixed to match actual code behaviour (no code change):
   - `src/filters.js` (~356-359): removed the false "opposition applies ONLY
     while teamType === international" claim — decision 51 reversed that
     gate; comment now points at `oppositionFilterActive` in state.js.
   - `src/paletteGroups.js` (~161-168): removed the false "no longer offered
     as filters in Vs mode" claim for Balls Faced/Dismissals/Fours Conceded/
     Sixes Conceded — R2c/R4-B restored all four; comment now says so.

## Coordinator's 3 additional owner-ruled fixes (same pass)

6. `src/paletteGroups.js` fielding-position menu leaf: "Wickets by Batting
   Position" → "Dismissed batter's position" (now matches the applied row
   in `src/drawer.js`, which already had the R4 name). Live-verified: menu
   and applied row both read "Dismissed batter's position".

7. Batting `dot_pct` add-menu leaf (`src/paletteGroups.js`): "Dot %" → "Dot
   Ball %" (now matches the metric's own label, unchanged at "Dot Ball %").
   Bowling's add-menu leaf: "Dot %" → "Dot Ball % Conceded" (matches fix #3).

8. `src/columnsPicker.js` HIDDEN_COLUMN_KEYS: added `four_wicket_hauls` —
   "Four-Wicket Hauls" no longer offered in the Bowling columns dropdown.
   "Five-Wicket Hauls" (`five_wicket_hauls`) untouched. Metric def / any
   other consumer stays in metrics.js (hidden-not-deleted posture, same as
   `player_of_match`/`wickets_per_innings`/`boundary_runs`). Live-verified:
   picker search for "wicket haul" now returns only "Five-Wicket Hauls".

## Known, NOT fixed (flagged, not built — matchup-namespace naming-sync)

The menu leaves for NBSR / Boundary Ball % / Boundary Run % / batting Dot
Ball % are SHARED between plain and matchup (Vs) mode (same `leafMetric`
line resolves against whichever namespace is active). The brief's own text
scoped the rename to "(batting)" / "(batting AND bowling)" only — deliberately
excluding matchup — consistent with the existing "naming-sync is a DEFERRED
later task" ruling already on record for the 4s/6s-Conceded label (ruling 6).
Left AS-IS, so in Vs mode today:
  - matchup_batting `boundary_pct` still labels "Boundary %" (menu now says
    "Boundary Ball %")
  - matchup_batting `running_sr` still labels "Running Strike Rate" (a
    literally-identical formula to NBSR, menu now says "NBSR")
  - matchup_bowling `dot_pct` still labels "Dot Ball %" (menu now says "Dot
    Ball % Conceded")
  - matchup_batting/matchup_bowling `boundary_runs_pct` were NOT touched
    (they already said "% Runs from Boundaries" before this pass and still
    do) — task explicitly scoped this rename to plain batting+bowling only.
Owner call needed on whether to fold these into the deferred matchup
naming-sync task or handle now.

## Verification

- `node --check` clean on all 8 touched files: playerFieldingEditor.js,
  metrics.js, columnsPicker.js, drawer.js, paletteGroups.js, filters.js,
  playerFilterScope.js, playerFiltersTab.js.
- Booted localhost:8000, cache-busted all 8 files, 0 console errors.
- Anchors reproduced on screen exactly (see header). SA Yadav row: 64 mat /
  60 inns / 1,544 runs / 29.13 avg / 150.34 SR.
- Bowling default-preset column set unaffected (Player Matches/Bowling
  Innings/Wickets/Bowling Average/Economy/Bowling Strike Rate/Best Bowling
  still the same 7, in the same order).
- Ball-engine (`?engine=ball`) Ball Ranges group ("Team Ball Range"/
  "Batter/Bowler Ball Range") could NOT be live-clicked — this session's
  delivery parquet fetch failed ("Could not create the ball-engine 'batting'
  view... deliveries_m_t20.parquet"), a pre-existing local-data availability
  issue unrelated to this change (no query/engine code touched). Verified
  those two renames by source read only (drawer.js SINGLETON_TYPES +
  playerFilterScope.js SINGLETON_DEFS + the already-correct paletteGroups.js
  menu strings at lines 453/455).

No git commands run (per instructions — orchestrator commits).
