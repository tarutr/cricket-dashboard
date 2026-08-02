# Wave R2d — filter-rejig gap-close (3 numbers items)

Branch `ball-layer`. Three small, INDEPENDENTLY-verified gap closes surfaced by the
removal audit + Wave R2c. All ADDITIVE; anchors byte-identical with no new filter
active. Independent DuckDB in `.orchestrator/verify_waveR2d.py` (ALL PASS).

## TASK A — MAT innings-level under Innings Number (commit `2bba032`)
`buildQuery`'s `inningsLevel` gate (table.js) now includes `inningsNumberFilterActive(state)`
(imported from state.js) — the ONE gate line touched. So with an Innings Number filter
active, the Matches column routes through the innings-level `COUNT(DISTINCT match_id)` path
(consistent with INNS/RUNS), not the whole-scope player_matches count. Additive: gate
unchanged when Innings Number empty → anchors byte-identical.

Independent DuckDB: SA Yadav 1st innings MAT = **38** (distinct matches batted in innings 1;
was 64 whole-scope) == INNS 38 == raw-ball distinct-match derivation. Anchors hold.

## TASK B — matchup_bowling Boundary Run % (commit `2e9c92a`)
Added `boundary_runs_pct` def to the **matchup_bowling** namespace in metrics.js (identical
formula to plain bowling: `(4*fours_conceded+6*sixes_conceded)*100/NULLIF(runs_conceded,0)`).
The shared "Bowling · Detailed Stats" palette line `leafMetric("boundary_runs_pct")` (drawer.js,
already present) now RESOLVES in Vs mode → "Boundary Run %" appears in matchup-bowling Detailed.
NO drawer.js change needed (the placement was already there; it only lacked the namespace def).

Independent DuckDB: Bumrah vs Right-hand bat = **55.2%** (276 boundary runs / 500 conceded);
decomposed shape == app one-line expression; view fours/sixes/runs_conceded cross-checked
against raw deliveries (68 4s / 23 6s / 765 runs conceded, all hands).

## TASK C — distinct Caught & bowled fielding count (commit `5842320`)
`buildFieldingCteSql` gains a `caught_and_bowled` column (`SUM(CASE WHEN kind='caught and
bowled' …)`). `catches` UNCHANGED (still folds c&b in). New `caught_and_bowled` fielding
metric (MAX(fielding_cte.caught_and_bowled), section fielding → pushed to batting+bowling).
drawer.js Fielding Wicket Type ▸ now ENABLES the "Caught & bowled" variant (leafMetric),
replacing the disabled placeholder — flows through the fielding_cte join + conditionToHaving
as a count operator, exactly like Caught/Run-out/Stumped.

Independent DuckDB: Karanbir Singh c&b = **3** (catches 32 = 29 caught + 3 c&b, unchanged);
SA Yadav c&b = 0 (catches 24 unchanged).

CONSEQUENCE (owner glance): the new metric, mirroring its 3 siblings (section "fielding"),
also becomes an available NON-default column in the Columns popover — consistent with
Catches/Stumpings/Run-outs, not a new default column.

## In-app verification
(localhost:8000, R2 data — same Cricsheet source, identical SPEC §4.1 rules; fetch-reload
changed files; anchors on screen; 0 console errors; 375px.) — see report.
