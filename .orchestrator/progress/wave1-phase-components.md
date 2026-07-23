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

## Next
- Write pipeline/dev_test_phase_components.py (byte-identical HEAD-vs-branch EXCEPT +
  independent new-column recompute + invariants/residual print).
- Full build to /tmp/export_b3 (no --upload); confirm all gates + SPOT_CHECKS pass.
- Report residual (=0), sizes, anchors.

## Gotchas
- q() helper returns only fetchone()[0] — scalar queries only.
- t20-family phase cols (pp/mid/death) are computed for ALL formats (over 0-19),
  so for ODI/Test Σ(phase) < overall — the <= gate is for all rows, == only for T20/IT20.
- odi_* cols populated for T20 matches too (over-based); only NULL for the Hundred.
