# Wave 1 — Batting composition (plain + matchup)

Branch: `polish-b1-mechanical`. Additive only; query builders untouched.

## What was done
- `export_parquet.py`
  - `sql_batting()`: added composition counts to `bat_agg` + team denominator CTE.
    New columns appended to the final SELECT (after `odi_death_dismissals`):
    `ones, twos, threes, fives, nb_fours, nb_sixes, non_boundary_runs, team_inns_balls`.
    - faced ball = `wides IS NULL` (no-balls count as faced).
    - `nb_fours`/`nb_sixes` = ran 4s/6s (`runs_batter 4/6 AND is_not_boundary IS TRUE`),
      complement of the existing `fours_hit`/`sixes_hit`.
    - `non_boundary_runs` = `SUM(runs_batter) - 4*fours_hit - 6*sixes_hit`.
    - `team_inns_balls` = whole side's faced balls per innings (new `team_inns` CTE,
      LEFT JOIN on match_id+innings_number).
  - `sql_matchup_batting()`: same seven counts in `mb` (at bowling_type grain),
    appended to final SELECT after `batting_position`. No `team_inns_balls` (plain only).
- `src/metrics.js`
  - `BATTING_METRICS` (+8): running_sr, boundary_runs_pct, runs_1s_pct, runs_2s_pct,
    runs_3s_pct, balls_per_four, balls_per_six, balls_faced_share.
  - `MATCHUP_BATTING_METRICS` (+7): same minus balls_faced_share.

## Verification (local July-4 snapshot; DB copied to scratchpad, profiles built there)
- Byte-identical existing columns: batting 0/0, matchup 0/0 (EXCEPT both ways).
- ORACLE vs source innings_batters: ones/twos/threes/fives/non_boundary_fours/
  non_boundary_sixes/non_boundary_runs = 0 mismatches over 417,392 matched rows.
  team_inns_balls == SUM(src.balls_faced)/innings = 0 mismatches over 49,044 innings.
- Matchup Σ-over-bowling_type == batting_innings per (match,inn,batter): 0 mismatches.
- Running SR / Balls-Faced Share vs source rate columns: exact (recompute-from-source
  match = 0; only float32-storage gap, max 1.0e-05 / 3.6e-06).
- Anchors: baseline 2,810 (local); Karanbir 2,454; SA Yadav 60/1,544/29.13/150.34;
  SA Yadav vs Spin 38/454/SR140.99.
- Full `export_parquet.py` run: all gates + 7 spot checks PASS.
- `node --check src/metrics.js`, `py_compile export_parquet.py` OK.

## Size deltas
- batting_innings.parquet: 9,570,754 -> 10,529,145 (+958,391, +10.0%)
- matchup_batting.parquet: 14,222,879 -> 15,716,024 (+1,493,145, +10.5%)

## Assumptions flagged
- higherIsBetter for `boundary_runs_pct` set true (brief: "%-from-boundaries neutral->true";
  matches existing boundary_pct). % in 1s/2s/3s + balls_faced_share = neutral (null),
  balls_per_four/six = false (lower better). Metadata only; not numbers-sacred.
