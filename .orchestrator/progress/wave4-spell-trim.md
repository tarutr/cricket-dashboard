# Wave-4 spell trim (owner-directed) — progress

Branch: polish-b1-mechanical. No push/merge.

## Owner ruling applied
Spells are match-report-level, NOT leaderboard. Opening/closing spell deleted entirely.

## Done
### src/metrics.js
- Removed all 9 spell metric defs from BOWLING_METRICS + the orphaned
  "Bowling spells (Wave 4)" section comment (128 lines).
  Keys removed: spells_per_innings, best_spell, open_spell_economy, open_spell_sr,
  open_spell_dot_pct, close_spell_economy, close_spell_sr, close_spell_dot_pct,
  longest_spell_overs. `grep -i spell src/metrics.js` -> none. node --check OK.

### export_parquet.py sql_bowling()
- Deleted the 8 open/close columns from spell_innings CTE + the projection:
  open_spell_{balls,runs,wkts,dots}, close_spell_{balls,runs,wkts,dots}.
- Dropped dead per-spell s_dots (spell_agg + spell_full) — existed only for the
  deleted open/close dot metrics.
- KEPT 4 match-report columns: spell_count, longest_spell_balls, best_spell_wkts,
  best_spell_runs + the spell-CTE machinery (spell_over_map/deliveries/wkts/agg/full).
- Wave-4 all-credited spell-wicket fix kept intact (spell_wkts counts credited
  kinds on ALL balls). Retargeted the PART-B gate from open_spell_wkts to
  best_spell_wkts (for spell_count=1, best spell == the lone whole-innings spell).
  py_compile OK.

## Verification (scratchpad DB copy + built profiles; never touched data/cricket.duckdb; --out /tmp)
- PRE-TRIM baseline: /tmp/export_pretrim ; TRIM: /tmp/export_trim (both all gates PASS).
- bowling_innings: 79 cols -> 71; exactly the 8 open/close deleted, 0 others added.
- 71 kept cols byte-identical (EXCEPT both ways = 0). 4 kept spell cols identical.
- Other 8 parquets FILE-md5 identical (players/matches/batting/player_matches/
  profiles/fielding/matchup_batting/matchup_bowling).
- bowling_innings size 10,927,152 -> 9,715,627 bytes (-1,211,525 / -11.09%).
- Oracle: spell_count vs innings_bowlers = 0; longest_spell_balls vs
  MAX(bowling_spells.balls) = 0.
- Independent recompute from deliveries+wickets (all-credited) vs exported cols:
  0/0/0/0 for spell_count/longest/best_wkts/best_runs -> kept cols CORRECT.
- Source-oracle divergence (INTENDED, all-credited vs source legal-only):
  best_spell_wkts 429 innings, best_spell_runs 136 innings (all multi-spell;
  spell_count=1 -> 0). Delivery-level illegal-ball credited wickets = 539
  (matches CTE "~539"). NOTE: task expected best_spell_runs=0 vs source, but the
  all-credited convention flips which spell is "best" in 136 multi-spell innings,
  shifting runs too — proven correct by the independent recompute.

## Browser + anchor verification (DONE)
Served the trim build locally (temporary absolute-URL DATA_BASE_URL override in
src/config.js -> reverted; data/export_trim_local/ removed; both untracked/gitignored).
- App booted clean, 0 console errors. "Data as of 2 Jul 2026".
- metricsFor('bowling') = 39 metrics, metricsFor('batting') = 65 -> 0 spell in either.
- Live Bowling "+ Add condition" drawer list = 44 options, 0 spell (shows Wickets/
  Economy/Maidens/Best Bowling/PP-Mid-Death economy+wickets/kinds/fielding only).
- Columns picker: 0 spell labels; whole-page innerText has NO "spell" anywhere.
- Anchors (Men/T20/International, 2023-07-01..2026-07-02 day-bounded):
  * Batting baseline 2,813 players; row 1 Karanbir Singh 2,454 runs  [on-screen]
  * SA Yadav 60 inns / 1,544 runs / 29.13 avg / 150.34 SR             [on-screen]
  * Bumrah vs RHB striker pos 1-2 = 27 inns / 177 balls / 9 wkts
    [independent DuckDB over matchup_bowling.parquet; identical on pretrim+trim;
     matchup_bowling.parquet is md5-identical pretrim vs trim]

## Status: COMPLETE (branch polish-b1-mechanical; not pushed/merged)
