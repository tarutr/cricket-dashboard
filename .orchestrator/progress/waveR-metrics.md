# Wave R1 — filter-rejig NEW metric definitions (data-engineer)

Branch `ball-layer`. Additive-only edits to `src/metrics.js` + verify script
`.orchestrator/verify_waveR_metrics.py`. No existing metric altered; query
builders untouched (Rule 1). Owner definitions from `.orchestrator/filter-rejig-spec.md`
"New metrics/filters to ADD".

## Done (all independently verified — see verify script, ALL PASS)
- BATTING `runs_4s_run_pct` `(4*SUM(nb_fours))*100/runs`; `runs_5s_pct`
  `(5*SUM(fives))*100/runs`; `runs_6s_run_pct` `(6*SUM(nb_sixes))*100/runs`.
- BATTING `innings_score_ge` (parametrised, default N=50):
  `SUM(CASE WHEN runs>={N} THEN 1 ELSE 0 END)`.
- BOWLING `boundary_runs_pct` `(4*fours_conceded+6*sixes_conceded)*100/runs_conceded`.
- BOWLING `extras_wides` `SUM(wides_runs)`, `extras_noballs` `SUM(noball_runs)`
  (RUN totals, not delivery counts; higherIsBetter null).
- BOWLING `wicket_hauls_ge` (parametrised, default N=4):
  `SUM(CASE WHEN wickets>={N} THEN 1 ELSE 0 END)`.
- Helpers: `paramSqlExpression(metric, n)` (validated-integer substitution, min-clamp,
  injection-safe fallback) + `INNINGS_NUMBER_FILTER` descriptor (innings_number is
  0-BASED — display "Innings 1" = stored 0; toStored = display-1).

## Verification
- `node --check src/metrics.js` OK; node harness: 0 dup keys, all 8 metrics resolve,
  paramSqlExpression substitutes/clamps/rejects injection.
- `python3 .orchestrator/verify_waveR_metrics.py` = ALL PASS (18 checks): anchors
  2813 / Karanbir 2454 / SKY 60·1544·29.13·150.34 unchanged; each new metric ==
  independent raw-ball derivation (SPEC 4.1 from scratch, super overs excluded).

## Flags for orchestrator (NOT built — brief boundary)
- Spec "% Runs in…" sub-filter also lists `4s-boundary` / `6s-boundary` variants;
  only the COMBINED `boundary_runs_pct` exists (batting) — the two splits are not
  in my brief. Not added.
- Matchup-namespace parity (existing runs_1s/2s/3s_pct + boundary_runs_pct are in
  matchup_batting) not extended to the 3 new % Runs variants — brief is plain
  batting/bowling only. matchup_batting DOES carry nb_fours/nb_sixes/fives if wanted.
- Extras higherIsBetter set null (neutral, like runs_conceded); one-word flip to
  false if owner wants "fewer extras = better" ranking. Extras are RUN totals.
- Parametrised metrics carry a safe default N until Wave R2 wires the N input.
