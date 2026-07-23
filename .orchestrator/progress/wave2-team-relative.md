# Wave 2 — Team-relative (bat + bowl, plain + matchup)

Branch: `polish-b1-mechanical`. Additive only; query builders (table.js/filters.js) untouched.
Window-relative NOT built (dropped — flawed, per brief).

## What was done
- `export_parquet.py` — new per-innings DIFFERENTIAL columns (FLOAT), re-derived
  standalone from `deliveries`, faithful to `reference/ingest.py`:
  - `sql_batting()` (batting_innings) + `sql_matchup_batting()` (matchup_batting, at
    bowling_type grain): `team_rel_sr, team_rel_dot_pct, team_rel_bpb, team_rel_nbsr`
    = batter's per-innings rate MINUS the whole side's rate that innings
    (matchup: batter-vs-type − side-vs-type). team_stats over ALL batters,
    faced ball = wides IS NULL. Divide-by-zero → NULL; differential NULL if either side NULL.
  - `sql_bowling()` (bowling_innings) + `sql_matchup_bowling()` (matchup_bowling, at
    batting_hand/position grain): `team_rel_econ, team_rel_pbe, team_rel_dot_pct, team_rel_sr`
    = bowler − whole side.
  - PLAIN bowling economy reproduces the source's CRICKET-over divisor
    (rc / compute_overs_bowled, rebuilt from over_sets via CAST('c.i' AS DOUBLE)) —
    NOT balls/6 — because innings_bowlers.team_relative_economy encodes exactly that.
    Team econ uses t_runs/(t_balls/6) (decimal), per the source's own asymmetry.
  - MATCHUP bowling economy uses DECIMAL overs (balls/6) for BOTH sides (no source oracle;
    cricket-overs is meaningless per hand/position bucket). FLAGGED assumption.
- `src/metrics.js` — 16 new metric defs (kind:"total", format dec2, zeroIsData:true,
  non-additive so out of donut; higherIsBetter per cricket "positive=beat-your-side"):
  - batting + matchup_batting: net_rel_sr, net_rel_dot_pct, net_rel_bpb, net_rel_running_sr
  - bowling + matchup_bowling: net_rel_economy, net_rel_pbe, net_rel_dot_pct, net_rel_sr
  - batting SR/RunningSR higher=better; Dot%/BpB higher=worse. bowling Econ/PBE/SR
    lower=better (neg differential good); Dot% higher=better.

## Verification (July-4 local snapshot; scratchpad DB + profiles; base vs Wave-2 export)
- BYTE-IDENTICAL existing columns, all 4 files, EXCEPT ALL both directions: 0 / 0.
- ORACLE vs source precomputed columns (tol 1e-3):
  - batting_innings (417,392 matched): all 4 team_rel_* → 0 exceeding, maxdiff 0.0, 0 null-mismatch.
  - bowling_innings (291,001 matched): econ / pbe / dot_pct → 0 exceeding, maxdiff 0.0.
    sr → 536 rows differ (342 exceed + 194 null-mismatch). ROOT CAUSE (airtight 1:1):
    cricdb's SPEC §4.1 `wickets` (all credited kinds, byte-identical/production) EXCEEDS
    source innings_bowlers.wickets in EXACTLY 536 rows = the 539 credited wickets
    (bowled/caught/stumped/hit-wicket) recorded on NON-legal deliveries. Source build_bowlers
    counts the bowler's wickets over `legal` deliveries only (dropping these) but counts the
    TEAM's t_wkts over ALL deliveries — a source internal inconsistency. cricdb correctly
    counts all credited kinds for BOTH, so team_rel_sr is consistent with the app's own
    `wickets`/SR. NOT replicated (would contradict SPEC §4.1 + Rule 1). aux: my cricket-over
    reconstruction vs source `economy` maxdiff 2.26e-5.
- MATCHUP independent recompute from raw deliveries (SA Yadav vs Slow-left-arm-orthodox,
  3 innings): recomputed (batter SR − side SR) == stored team_rel_sr to 4 dp, all 3.
- Anchors (on screen + via app DuckDB-WASM): 2,813 players; Karanbir 2,454;
  SA Yadav 60/1,544/29.13/150.34; SA Yadav vs Spin 38/454/140.99.
- Metric sanity: SA Yadav Net Rel SR = SUM(team_rel_sr) = -1549.02 (== summing source
  team_relative_sr over same 60 innings). Negative is REAL: the unweighted per-innings sum
  (owner "pure addition" design) has population mean -14.86 (not 0) because team SR is
  ball-weighted while each batter contributes one differential regardless of balls faced.
  Faithful + finite; interpretation nuance flagged.
- Live app: boots zero console errors against local export; new columns present in both
  views; column picker + stat-condition dropdown list all four; "NET REL DOT%" column
  renders SA Yadav 541.70 (== DB net_rel_dot 541.7).
- `python -m py_compile export_parquet.py` OK; `node --check src/metrics.js` OK.
- All export gates + 7 spot checks PASS on the Wave-2 run.

## Size deltas (FLOAT differential cols are high-entropy; size cleanup deferred to #12)
- batting_innings.parquet   10,529,145 → 15,784,814  (+5,255,669, +49.9%)
- bowling_innings.parquet    6,245,558 →  9,186,434  (+2,940,876, +47.1%)
- matchup_batting.parquet   15,716,024 → 25,431,164  (+9,715,140, +61.8%)
- matchup_bowling.parquet   16,652,574 → 28,512,917  (+11,860,343, +71.2%)

## Assumptions / concerns flagged (see report)
1. bowling_innings team_rel_sr diverges from the source oracle on 536 rows — source bug
   (legal-only bowler wickets); cricdb's SPEC-compliant all-credited count kept. Owner note.
2. matchup_bowling economy uses decimal overs (no oracle; cricket-overs meaningless per bucket).
3. Net Rel SR (and the family) skews negative at population level — owner-designed unweighted
   sum; not a bug. Interpretation note for the owner.
