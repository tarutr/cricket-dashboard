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

## TODO
- Full export → /tmp/export_w4; anchors (Bumrah 27/177/9, bowling baseline);
  death-bowler open-vs-close economy + Bumrah Best Spell sanity; size delta.
