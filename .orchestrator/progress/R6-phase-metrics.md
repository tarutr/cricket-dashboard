# R6 #8 — Line X=Phase metric breadth

Broadened the Line chart's **X = Phase** metric options using ONLY columns already
in the parquets (no pipeline/data change). File touched: `src/graph/timeseries.js` only.

## Approach chosen: B (derive from component columns, no catalogue clutter)
- Kept the existing **PHASE_MEMBERS** path byte-for-byte for the metrics that already
  had standalone phase definitions (Batting Strike Rate; Bowling Economy/Wickets) —
  their SQL and values are untouched.
- Added **PHASE_DERIVED** (a per-namespace `baseKey → (phasePrefix) → SQL` map) +
  `phaseFamilyForFormat()` so new bases get their phase value from the base metric's
  OWN metrics.js formula applied to the phase-prefixed component columns. Nothing is
  added to `metrics.js`, so the normal column/metric pickers are unchanged.
- `phaseMembersFor()` now tries PHASE_MEMBERS first (wins verbatim when it yields a
  family) and only falls through to PHASE_DERIVED for base keys it cannot serve.
- `buildPhaseSql()` uses `member.expr` when present, else `getMetric(key).sqlExpression`
  (existing path unchanged → existing SQL byte-identical).

### New X=Phase options (format-aware: T20 pp/mid/death, 50-over odi_pp/mid/death)
- Batting (`batting`/`matchup_batting`): **Runs**, **Balls Faced** (+ Strike Rate stays)
- Bowling (`bowling`/`matchup_bowling`): **Runs Conceded**, **Balls Bowled**,
  **Bowling Strike Rate**, **Bowling Average** (+ Wickets, Economy stay)
- Correctly EXCLUDED (no phase components): Batting Average, Dot %, Boundary %, Fours,
  Sixes, dismissal-type %s, High Score, Best, Matches, Innings, R. Pos.

### Catalogue footprint: ZERO new metrics (approach B). Normal pickers unchanged
(guaranteed — `git diff` of `src/metrics.js` is empty).

## Independent DuckDB verification (hand-written per-phase sums, NOT the app shape)
Scope Men/T20/International, 2023-07-01 → 2026-07-02.
- **Existing UNCHANGED** — SA Yadav (271f83cd) X=Phase Strike Rate: PP 137.98219584569733 /
  Mid 150.5050505050505 / Death 192.70833333333334 (identical pre- and post-edit, matches
  hand SQL). Bumrah (462411b3) Economy PP 6.350877/Death 6.710204 and Wickets PP 15/Death 22
  — still 2 phases (PP+Death), unchanged.
- **New correct** — SA Yadav Runs: PP 465 / Mid 894 / Death 185 = SUM(pp/mid/death_runs);
  Balls Faced: 337 / 594 / 96 = SUM(pp/mid/death_balls). Bumrah Runs Conceded 362/129/274,
  Balls 342/120/245, Bowling SR 22.8/10.909/11.136 (= balls/wkts), Bowling Avg
  24.133/11.727/12.455 (= rc/wkts) — all == hand SQL exactly.
- **Matchup path** — SA Yadav vs Spin Runs 79/349/26, Balls 55/254/13 == hand SQL
  (bowling_group='Spin'); totals 454 runs / 38 inns reproduce the anchor; phase partition
  79+349+26=454.
- **Divide-by-zero** — bowler 57b3c398 (54 PP balls, 0 PP wickets): Bowling Avg PP = null,
  Bowling SR PP = null (NOT Infinity/0). SPEC §4.1 satisfied.
- **Anchors on Stats**: 2,813 players; Karanbir 2,454; SA Yadav 60/1,544/29.13/150.34. Held.
- In-browser: Line + X=Phase, batting metric dropdown lists exactly Runs / Balls Faced /
  Strike Rate; picking Runs draws Powerplay→Middle→Death (6 lines). Zero console errors.

## CONCERN flagged to owner (not fixed — would change a frozen X=Phase series)
On the PLAIN bowling view, the new metrics show **PP+Mid+Death** (all 3) but the frozen
Economy/Wickets show **PP+Death only** — because `metrics.js` never catalogued a
`mid_economy`/`mid_wickets` for plain bowling (matchup_bowling has them → 3 phases there).
The middle-overs data EXISTS (mid_balls/mid_runs_conceded/mid_wickets are populated). New
metrics include it per decision 49 (show all data) + the task's "T20 uses pp/mid/death";
adding it to Economy/Wickets would move an existing X=Phase series (Rule 1) → owner call.
