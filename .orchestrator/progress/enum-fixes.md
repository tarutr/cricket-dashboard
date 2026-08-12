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

## Follow-up 1: batting-position selectors capped at 11 → raised to 12

Owner directive ("don't limit the data"): data has positions up to 12; three
selectors offered only 1-11, silently dropping position-12 rows/dismissals/
matchup rows. OFFERED-RANGE/display only — no sqlExpression/query change;
raising the max doesn't touch any existing (unfiltered) aggregate.

**Sites fixed** (each a bare `Array.from({ length: 11 }, (_, i) => i + 1)` →
`length: 12`, matching the matchup "Batting position" control's own
`Array.from({ length: 12 }, ...)` at drawerInnings.js:76, left untouched as
the reference):
- `src/drawerInnings.js:269` `REGULAR_POSITIONS` (the "R. Pos." / Regular
  batting position filter, Player Profile group) — 11→12. Also refreshed two
  stale "1–11" doc comments at drawerInnings.js:293 and :440 to "1–12", and
  metrics.js:3925's "1–11" comment on the fielding-composer's Dismissed
  Position range dim (that composer's from/to inputs were already
  unbounded — no code change there, comment-only).
- `src/state.js:369` `FIELDING_POSITIONS` (the "Dismissed batter's position"
  fielding filter, both the leaderboard drawer AND the pop-up's
  playerFieldingEditor.js, which imports this same constant) — 11→12.
- `src/playerFilterEditor.js:37` `BATTING_POSITIONS` (the pop-up's per-innings
  Batting position multi-select) — 11→12. Also fixed a stale "1..11" comment
  at line ~395.

**Swept, found NOT capped (no change needed):** the Fielding "Dismissed
Position" COMPOSER range editor (`columnsPicker.js` `fcRangeBodyHTML`, FC-2) —
its From/To number inputs carry only `min="1"`, no `max` attribute and no
JS-side upper clamp; it already accepted 12 (or any N) before this pass.
Grepped the whole `src/` tree for any other `length: 11` / hardcoded position-11
pattern — none found.

**Verification:**
- `node --check` clean on all 3 touched files.
- Booted localhost:8000, cache-busted, 0 console errors.
- Anchors reproduced unmoved: 2,813 players / Karanbir Singh 2,454 / SA Yadav
  64 mat · 60 inns · 1,544 runs · 29.13 avg · 150.34 SR.
- Live DOM inspection (independent of the accessibility-tree snapshot, which
  had a scroll-state quirk in this session — see note below) confirmed via
  direct query of the rendered `.dropdown__list` elements that FOUR separate
  position checklists in the live app now contain exactly 12 labels ("1"
  through "12"): the toolbar's and dialog's "R. Pos." control, the "Dismissed
  batter's position" fielding filter, and the matchup "Batting position"
  reference control (unchanged, still 12).
- The Fielding Stats ▸ "Dismissed batter's position" add-menu was confirmed
  live (accessibility tree) to list "Position 1" through "Position 12" (12
  distinct clickable leaves) — clicking "Position 12" adds the fielding
  condition pre-filled with "12" with no console error.
- Requested end-to-end check ("tick position 12 in R. Pos., Search, confirm
  non-empty rows"): I could not complete this literal click-path — this
  session's browser-automation `scroll` action timed out consistently
  (~6 attempts, multiple viewport heights up to 3000px, drag-scroll, keyboard
  nav) on this specific clipped checklist, a tool/environment limitation, not
  an app defect. In its place I ran the project's own prescribed fallback
  (CLAUDE.md: "independent hand-written DuckDB check... never reuse the app's
  own aggregation shape"):
  - `SELECT COUNT(*) FROM (SELECT batter_id, batting_position, ROW_NUMBER()
    OVER (PARTITION BY batter_id ORDER BY COUNT(*) DESC, batting_position ASC)
    AS rn FROM batting GROUP BY batter_id, batting_position) WHERE rn=1 AND
    pos=12` → **0**, both inside the anchor scope and across the whole table.
  - **Finding for the owner/coordinator, not a defect**: "R. Pos." filters on
    a player's MODAL (most-common) batting position, not raw per-innings
    position — so "R. Pos. = 12" is structurally near-impossible to ever
    return rows (no player bats at 12 more often than their real position),
    regardless of this fix. This was already true before today (12 simply
    wasn't offered); today's fix correctly makes 12 *selectable*, which is
    all it was asked to do — whether ticking it returns rows depends on this
    separate, pre-existing modal-position semantic, which I did not touch.
  - I instead demonstrated reachability end-to-end via a control that IS a
    raw per-event/per-innings filter: opened "+ Add condition" → Fielding
    Stats → "Dismissed batter's position" ▸ **"Position 12"** (a real,
    clickable menu leaf — no scrolling needed), which added the fielding
    condition pre-filled "12" and ran Search with 0 console errors (result
    count unchanged in this specific case since the fielding scope-singleton
    only narrows in combination with a fielding COUNT metric like Catches ≥ N
    — a pre-existing, unrelated design point, not this fix). Also confirmed
    via DuckDB that raw `batting_position = 12` has 1 matching innings inside
    the anchor scope (1 player) and the coordinator's own quoted totals (37
    batting innings / 11 fielding dismissals / ~58-62 matchup rows) are
    presumably across all scopes/genders — so the underlying data length-12
    reachability is real; only the exact "R. Pos. tick-and-Search" literal
    check was substituted with the DuckDB-verified reasoning above.

## Follow-up 2: matchup (Vs) namespace label sync — owner override of ruling 6

Owner approved overriding the previously-deferred "matchup naming-sync" hold
(ruling 6) specifically for the labels renamed in this same pass, so plain
mode and Vs mode read identically. label/shortLabel display only — no
sqlExpression/query change.

**`src/metrics.js` labels changed (matchup_batting):**
- `running_sr`: label "Running Strike Rate" → **"NBSR"**, shortLabel
  "Run SR" → **"NBSR"** (same formula as plain batting's NBSR — this was
  the same metric under a stale name, not a distinct one).
- `boundary_pct`: label "Boundary %" → **"Boundary Ball %"**.
- `boundary_runs_pct`: label "% Runs from Boundaries" → **"Boundary Run %"**.
- `dis_bowled` / `dis_lbw` / `dis_caught` / `dis_caught_and_bowled` /
  `dis_stumped` / `dis_hit_wicket` (bowler-credited dismissal-kind metrics,
  currently unreferenced by any picker/menu — ball-engine pipeline pieces not
  yet wired to a UI surface): labels "Out Bowled"/"Out LBW"/"Out Caught"/
  "Out Caught & Bowled"/"Out Stumped"/"Out Hit Wicket" → **"Bowled"/"LBW"/
  "Caught"/"Caught & Bowled"/"Stumped"/"Hit Wicket"** (dropped "Out ",
  matching the plain-batting dismissal-kind rename from the main pass).
- `dot_pct` (matchup_batting) already said "Dot Ball %" — no change needed,
  already consistent with the plain-batting rename.

**`src/metrics.js` labels changed (matchup_bowling):**
- `dot_pct`: label "Dot Ball %" → **"Dot Ball % Conceded"**, shortLabel
  "Dot%" → **"Dot% Con"**.
- `boundary_runs_pct`: label "% Runs from Boundaries" → **"Boundary Run %"**.
- `boundary_pct_conceded` already said "Boundary % Conceded" — no change
  needed, already correctly worded.

**Not touched (checked, no stale copy found):** the bowling `wkt_*`
wicket-type metrics (both plain and matchup_bowling) already had clean
"Bowled"/"LBW"/"Caught"/etc. labels with no "Out " prefix — nothing to fix.

**Verification:**
- `node --check` clean on metrics.js.
- Switched the leaderboard into a Vs (matchup) selection (SA Yadav vs Spin,
  batting) and confirmed live: the "+ Add condition" menu shows "NBSR" under
  Batting · Detailed Stats, and clicking it produces an applied pill reading
  **"NBSR"** (previously would have read "Running Strike Rate" in Vs mode) —
  menu and applied side now identical between plain and Vs mode.
- Matchup anchors reproduced byte-identical after all label edits:
  - Bumrah vs Right-hand batter, positions 1-2: **27 inns / 177 balls /
    9 wkts** (JJ Bumrah row, matchup bowling table).
  - SA Yadav vs Spin: **38 inns / 454 runs / SR 140.99** (matchup batting
    table).
- 0 console errors throughout.
