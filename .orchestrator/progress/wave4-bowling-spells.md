# Wave 4 — Bowling spells (aggregate metrics)

Branch: `polish-b1-mechanical`. ADDITIVE only. Scratchpad DB (read-only):
`scratchpad/cricket_w2.duckdb` (copy of data/cricket.duckdb + profiles). Never
touched `data/cricket.duckdb`.

## What changed
- `export_parquet.py` `sql_bowling()`: added spell CTEs
  (`spell_over_map` → `spell_deliveries` → `spell_wkts` / `spell_agg` →
  `spell_full` → `spell_innings`) faithful to `reference/ingest.py`
  `identify_spells` (gap ≥3 over-numbers = new spell) + the build_bowlers spell
  loop. 12 new INT columns on `bowling_innings`: `spell_count`,
  `open_spell_{balls,runs,wkts,dots}`, `close_spell_{balls,runs,wkts,dots}`,
  `longest_spell_balls`, `best_spell_wkts`, `best_spell_runs`.
- `src/metrics.js` BOWLING_METRICS: +9 metrics — Spells per Innings (rate),
  Best Spell (peak, str, mirrors `best`, conditionInput bowlingFigures),
  Opening/Closing-Spell Economy/SR/Dot%, Longest Spell (overs peak = MAX).

## Verification (against /tmp/export_w4 vs /tmp/export_w4_base, DB cricket_w2)
- Byte-identical existing bowling_innings cols (EXCEPT both ways): 0 / 0. Rows
  291,001 == 291,001. 12 new cols, 0 removed.
- ORACLE 1 spell_count vs source innings_bowlers.spell_count: 291,001 joined,
  0 mismatches, 0 unmatched.
- ORACLE 2 open/close/longest/best (11 cols) vs source bowling_spells: 291,001
  joined, 0 mismatches on every column.
- node --check src/metrics.js OK; py_compile export_parquet.py OK.
- 9 metrics registered, no dup keys.

## Judgement calls (flagged)
- Best Spell display separator "/" ("4/12") per brief (Best Bowling uses "-").
- Best Spell given conditionInput:"bowlingFigures" so a str-format peak isn't
  offered as a broken generic single-box condition — mirrors `best` exactly.
- Longest Spell higherIsBetter=null (neutral: workload trait, not quality).

## Anchors (from /tmp/export_w4)
- Bowling baseline distinct bowler_id: 2,049 == w3 base 2,049 (unchanged).
- Bumrah vs RHB striker pos 1-2: 27 inns / 177 balls / 9 wkts. EXACT.
- Batting unaffected: baseline 2,810 (local snapshot) / Karanbir 2,454 /
  SA Yadav 60 / 1,544 / 29.13 / 150.34. EXACT.

## Internal invariants (0 violations each)
- spell_count=1 => open==close (all 4 components); spell_count>=1 always;
  longest >= open & close balls; best rank >= open & close rank; no negatives.

## Metric sanity (T20/Intl/Men)
- Population Opening-Spell Econ 7.03 vs Closing-Spell Econ 7.44 -> closing worse
  (expected; late/death spells cost more on aggregate).
- Rabada (typical death bowler): Open Econ 6.71 -> Close Econ 9.22 (worse, as
  expected); Best Spell 2/2.
- Bumrah: Open 6.48 vs Close 6.44 (near-equal — elite death econ), but Close SR
  9.82 vs Open 22.40 and Close Dot% 45.1 vs Open Dot% 57.4 confirm open=early /
  close=death orientation; Best Spell 3/6; Longest Spell 18 balls (3.0 overs);
  spells/inn 2.56.

## Size
- bowling_innings.parquet: 9,186,434 -> 10,927,039 bytes (+1.74 MB, +18.9%).
  (Load/size cleanup deferred per STEP2 spec.)

## Status: COMPLETE — all verifications green.
