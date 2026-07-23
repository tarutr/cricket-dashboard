# Backlog #3 — Phase-component columns — PLAN (awaiting owner go)

Branch: `polish-b1-mechanical` (== main). Do NOT merge to main until owner says go —
the CI pipeline runs on a cron every 6h from main, so **merging == deploying within 6h**.

## Goal / definition of done
Add per-phase *component* columns to the pipeline so these become chartable **by phase**
(Powerplay → Middle → Death on the X=Phase Line view, and available in column/condition pickers):
Dot% · Boundary% · Fours · Sixes · Batting Average · dismissal count. All standing anchors
byte-identical (2,813 / Karanbir 2,454 / SA Yadav 60·1,544·29.13·150.34 / matchup anchors).

## What already exists (verified in code)
- Batting parquet already stores phase RUNS + BALLS: `pp_runs/pp_balls`, `mid_*`, `death_*`,
  `odi_pp_*`, `odi_mid_*`, `odi_death_*` (export_parquet.py bat_agg, lines ~446–459 / 534–546).
  These power the existing Powerplay/Middle/Death **Strike Rate** metrics.
- Bowling stores `pp_balls/pp_runs_conceded/pp_wickets` (+ mid/death/odi) → Economy/Wickets by phase.
- The UI already has TWO ways to make a metric phase-chartable (src/graph/timeseries.js):
  1. **PHASE_MEMBERS** — explicit phase metric defs (e.g. pp_strike_rate). Existing.
  2. **PHASE_DERIVED** — textual prefix substitution: a base metric's OWN metrics.js formula with
     whole-innings columns swapped for `{prefix}_` columns (prefix ∈ pp/mid/death/odi_pp/odi_mid/
     odi_death). e.g. batting `runs`→`SUM(pp_runs)`. This is the lever: adding the component
     columns + a PHASE_DERIVED entry makes a metric phase-chartable with **zero query-builder change**.

## What's missing (the new columns)
Batting (`batting_innings.parquet`), for each prefix in {pp, mid, death, odi_pp, odi_mid, odi_death}:
- `{prefix}_dots`      — faced balls with runs_batter=0 in that phase  → Dot% by phase
- `{prefix}_fours`     — HIT_BOUNDARY_4 in that phase                  → Fours / Boundary% by phase
- `{prefix}_sixes`     — HIT_BOUNDARY_6 in that phase                  → Sixes / Boundary% / BpB by phase
- `{prefix}_dismissals`— batter dismissed (kind NOT IN non-dismissal) in that phase → Batting Average by phase
= 4 measures × 6 prefixes = **24 new integer columns** on batting.

odi_* columns are NULL for the Hundred (balls_per_over=5), matching the existing odi_ convention.

## Correctness notes (the tricky bits — must be nailed in the dev test)
- **dots/fours/sixes** fold directly into the existing `bat_agg` (same CASE-WHEN pattern already used
  for pp_runs), mirroring the overall `dots`/`fours_hit`/`sixes_hit` expressions exactly.
- **dismissals by phase** is the hard part. Overall `dismissed` comes from the `dis` CTE keyed on
  player_out, which does NOT join deliveries. To bucket by phase we need the wicket delivery's
  over_number (+ balls_per_over/legal_ordinal for the Hundred), i.e. join kept_wickets→d exactly like
  bowling's `wkt_by_ball`/`t20_phase_expr_wba`. RISK: an inner join drops any dismissal whose wickets
  row has no matching kept delivery (candidate kinds: timed out / retired out that may be recorded off
  a delivery). If so, Σ(pp+mid+death dismissals) < Σ(dismissed) → phase Batting Average slightly
  under-counts outs. **The dev test MUST check Σ phase dismissals vs Σ dismissed (T20; and odi within
  50-over) and report any residual before we commit.** Precedent: the existing phase BALLS already
  drop over_number≥20 scorer-overflow balls (tiny residual the owner has accepted); dismissals get the
  same honest treatment + an explicit number.
- Build as NEW additive CTE / new SELECT columns only — leave `dis`, `dots`, `fours_hit`, `sixes_hit`
  byte-identical so the overall numbers can't move.

## Approach — additive, test-first, gated (mirrors decision 36's matchup extension)
1. **Dev test first** (`pipeline/dev_test_phase_components.py`, disposable like dev_test_matchup_extension):
   builds the NEW batting SELECT from `data/cricket.duckdb` and proves:
   (a) every PRE-EXISTING column byte-identical to the current SELECT (row-for-row);
   (b) new-column invariants: 0 ≤ phase parts, Σ(pp+mid+death dots) ≤ dots, Σ phase fours ≤ fours_hit,
       etc., dismissals-sum-vs-total residual quantified;
   (c) odi_* NULL exactly when Hundred.
2. **Add columns** to `sql_batting()` (bat_agg CASE-WHENs + new dis-phase CTE + SELECT list) — additive.
3. **Add pipeline gates** for the new columns (export has ~21 additive upload gates; add consistency
   gates so a bad build refuses to upload).
4. **UI wiring** (src/graph/timeseries.js PHASE_DERIVED): add batting entries
   `dot_pct`, `boundary_pct`, `fours`, `sixes`, `average` → phase-column arithmetic mirroring their
   metrics.js formulas. (metrics.js base defs already exist; likely no metrics.js change — confirm.)
5. **Docs**: SPEC §4.1 note (owner-authorized), reference/db_reference.md column list, BACKLOG #3 status.

## Scope — DECIDED BY OWNER 2026-07-23
- **A. Discipline: BATTING + BOWLING** (both, symmetric).
- **B. Namespace: INCLUDE MATCHUP** — all four parquets.
- **C. Dismissals: TOTAL per phase** (no per-kind split by phase).

### Exact column additions (84 new columns total; prefixes = pp/mid/death/odi_pp/odi_mid/odi_death)
- **batting_innings** (+24): `{prefix}_dots`, `{prefix}_fours`, `{prefix}_sixes`, `{prefix}_dismissals`.
  dots/fours/sixes fold into `bat_agg` CASE-WHENs (mirror overall `dots`/`fours_hit`/`sixes_hit`).
  `{prefix}_dismissals` mirrors overall `dismissed` = ALL dismissal kinds (incl. run-outs); needs a
  NEW phase-aware dismissal CTE (join kept_wickets→d for over/bpo/legal_ordinal). ⚠ residual risk (below).
- **bowling_innings** (+18): `{prefix}_dots`, `{prefix}_fours_conceded`, `{prefix}_sixes_conceded`.
  All fold into `bowl_agg` CASE-WHENs. NO dismissal work — phase `{prefix}_wickets` already exist.
- **matchup_batting** (+24): `{prefix}_dots`, `{prefix}_fours`, `{prefix}_sixes`, `{prefix}_dismissals`.
  ⚠ matchup `dismissals` = bowler-CREDITED kinds only (via `cwkt`, striker, delivery-tied — decision 23),
  NOT the same definition as plain batting. Phase dismissals here bucket cleanly (all credited wickets
  are on a delivery). Mirror the EXISTING matchup `dismissals` definition, just phase-split.
- **matchup_bowling** (+18): `{prefix}_dots`, `{prefix}_fours_conceded`, `{prefix}_sixes_conceded`.
  Fold into agg. NO dismissal work — phase `{prefix}_wickets` already exist.

## Verification plan (Rule 1 ritual)
- Local DB present: `data/cricket.duckdb` (1 GB). All numeric verification runs LOCALLY pre-deploy.
- **Byte-identical (existing columns):** build the parquet from HEAD (`git show HEAD:export_parquet.py`)
  AND from the branch, then DuckDB `EXCEPT` both ways on the shared columns → must be 0 rows. (Changes
  are additive-only, so this proves no existing number moved.)
- **New-column correctness (independent):** for a sample of player-innings, recompute a phase counter
  by a DIFFERENT query shape than the builder (straight from `deliveries`/`wickets` with the phase
  CASE), and match. Never reuse the builder's own shape to check itself.
- **Invariants (gates):** Σ(pp+mid+death dots) ≤ dots; Σ phase fours = fours_hit for T20/IT20 rows
  (all balls in-phase) with any residual quantified; odi_* NULL iff Hundred; batting Σ phase dismissals
  vs Σ dismissed residual REPORTED with a number before commit.
- export_parquet.py SPOT_CHECKS (owner-verified career lines) must still pass on the run.
- **UI:** `node --check` touched .js; PHASE_DERIVED arithmetic reviewed to mirror metrics.js formulas.
  NOTE: on-screen phase charts can only be verified AFTER the columns are live on R2 (local app reads
  R2 parquet). Pre-deploy UI check = build parquet locally to /tmp and run the derived phase SQL against
  it in DuckDB (proves the derived expressions compute). Full on-screen check is a POST-DEPLOY step.
- Reproduce 2,813 / Karanbir 2,454 anchors on screen (unchanged — additive).

## Deploy gate
Everything stays on the branch. Parquet reaches R2 ONLY via a CI run (cron every 6h OR manual
workflow_dispatch) which checks out main. Owner's explicit go → merge to main → columns publish on the
next run. Nothing publishes while we work on the branch.

## Waves & worker assignment (Phase 3)
- **Wave 1 — Pipeline (data-engineer, Opus/high).** ONE worker owns `export_parquet.py` +
  `pipeline/dev_test_phase_components.py` + gates (single file, tightly coupled — do NOT parallelize).
  Deliver: dev test green (byte-identical HEAD-vs-branch + independent new-column checks), 84 columns
  added additively, gates added, residuals reported. Must NOT touch any `src/*.js`.
- **Wave 2 — UI wiring (orchestrator inline, dependent on Wave 1 column names).** Add PHASE_DERIVED
  entries in `src/graph/timeseries.js` for the base metrics per namespace (see below). Small,
  numbers-adjacent — keep tight. Confirm no metrics.js change needed.
  - batting: `dot_pct`, `boundary_pct`, `fours`, `sixes`, `average`
  - bowling: `dot_pct`, `boundary_pct`, `fours`(fours_conceded), `sixes`(sixes_conceded)  [avg/SR already there]
  - matchup_batting: `dot_pct`, `boundary_pct`, `fours`, `sixes`, `average`
  - matchup_bowling: `dot_pct`, `boundary_pct`, `fours`, `sixes`  [avg/SR already there]
  (Confirm exact base keys + formulas against metrics.js during build.)
- **Review:** fresh Opus reviewer on the whole diff + orchestrator anchor reproduction.

## Status
- [x] Owner go + scope A/B/C decided (2026-07-23)
- [ ] Wave 1: dev test written & green (byte-identical + independent new-column + invariants)
- [ ] Wave 1: 84 columns added (4 builders) + gates + residuals reported
- [ ] Wave 2: UI PHASE_DERIVED wiring + node --check + local derived-SQL check
- [ ] Integrated review (fresh Opus) + anchors reproduced
- [ ] Report → owner go to merge/deploy (merge == deploy within 6h)
