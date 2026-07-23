# Wave 1 — phase-component columns (backlog #3)

Branch: polish-b1-mechanical. Additive-only. Owner: data-engineer (Opus).

## Done
- Measured dismissal residual up front (data/cricket.duckdb):
  - deliveries UNIQUE on (match,inn,over,ball_index) — 0 dup groups.
  - Every wickets row (incl. 2 timed out, 106 retired out, 33 obstructing) HAS a
    matching kept delivery → inner-join residual = **0** globally.
  - 0 (match,inn,player_out) with >1 real-dismissal row (flag==rows==343,277).
  - T20/IT20: 174,641 real dismissals, 0 out-of-phase. ODI/ODM: 73,835, 0 out-of-phase.
  - matchup credited wickets: T20 159,229 / ODI 68,662, both 0 out-of-phase.
  → phase dismissals will reconcile EXACTLY; residual is genuinely 0.
- Snapshot pristine baseline export -> scratchpad/export_baseline.py (for byte-identical test).
- Added 84 columns across the 4 builders (all ADDITIVE, existing columns untouched):
  - batting: {prefix}_dots/_fours/_sixes into bat_agg + new dis_phase CTE for
    {prefix}_dismissals (all-kinds, join kept_wickets->d for phase). +24 cols.
  - bowling: {prefix}_dots/_fours_conceded/_sixes_conceded into bowl_agg. +18.
  - matchup_batting: {prefix}_dots/_fours/_sixes + {prefix}_dismissals
    (credited-only via COALESCE(cwkt.wkts,0), phase-gated on d). +24.
  - matchup_bowling: {prefix}_dots/_fours_conceded/_sixes_conceded. +18.
- Added gates (run_gates): phase dots/fours/sixes <= overall (all rows) + ==overall
  (T20/IT20); new odi_* NULL iff Hundred (all 4 files); matchup_batting phase
  dismissals == dismissals (exact); batting phase dismissals <= dismissed (+ residual log).
- py_compile OK.

## COMPLETE — all verification green
- Local DB lacked player_profiles (raw Cricsheet). Copied DB to scratchpad/cricket_b3.duckdb,
  built profiles offline via pipeline/build_profiles.py (7,220 rows, male mapped 72.4%).
  User's data/cricket.duckdb left PRISTINE.
- Full export to /tmp/export_b3: ALL gates PASS (incl. 20 new #3 gates) + 7 SPOT_CHECKS PASS.
  INFO line: batting phase-dismissal shortfall T20/IT20=0, ODI/ODM=0.
- dev_test_phase_components.py: 38 passed / 0 failed. Byte-identical EXCEPT both ways = 0 on all
  4 files; row counts unchanged; independent recompute (6 groups) all match; invariants all hold.
- RESIDUAL = 0 exactly: T20/IT20 174,641 dismissed == 174,641 phase; ODI/ODM 73,835 == 73,835.
  Root cause verified: every wickets row (incl 2 timed out, 106 retired out, 33 obstructing)
  HAS a matching delivery in this data, and 0 dismissals fall out-of-phase.
- Size delta: bat +29.0%, bowl +30.9%, matchup_batting +32.7% (10.7->14.2MB),
  matchup_bowling +28.5% (12.96->16.65MB). Flag for #12 load-speed.
- Anchors: Karanbir 2,454 / SA Yadav 60·1544·29.13·150.34 / SA Yadav vs Spin 38·454·140.99 /
  Bumrah vs RHB pos1-2 27·177·9 all EXACT. Batting baseline = 2810 on local DB (both baseline
  AND branch give 2810 from same copy -> NOT my change; R2 snapshot = 2,813, local Jul-4 snapshot drift).

## Handoff to Wave 2 (UI wiring) — exact new column names
- batting/matchup_batting (+24 each): {p}_dots, {p}_fours, {p}_sixes, {p}_dismissals
- bowling/matchup_bowling (+18 each): {p}_dots, {p}_fours_conceded, {p}_sixes_conceded
- prefixes p in: pp, mid, death, odi_pp, odi_mid, odi_death. odi_* NULL for the Hundred.

## Gotchas
- q() helper returns only fetchone()[0] — scalar queries only.
- t20-family phase cols (pp/mid/death) are computed for ALL formats (over 0-19),
  so for ODI/Test Σ(phase) < overall — the <= gate is for all rows, == only for T20/IT20.
- odi_* cols populated for T20 matches too (over-based); only NULL for the Hundred.
