# Wave 3 — Fielding + Impact (player_matches columns + buildQuery join + metrics + picker)

Branch: `polish-b1-mechanical`. Additive only. Wave-3 authorizes ONE new query-layer
join (the fielding LEFT JOIN in table.js buildQuery). buildScopeClauses / buildMatchupQuery
semantics for existing columns UNCHANGED.

## Export (export_parquet.py sql_player_matches) — DONE + VERIFIED
Added 4 columns (appended after `month`), re-derived STANDALONE from raw
wickets/wicket_fielders/deliveries/match_player_of_match (source DB has no fielding aggregate):
- `catches`  = 'caught' credited to each listed NON-substitute fielder (5-key wicket_fielders⋈wickets)
  PLUS 'caught and bowled' credited to the delivery's BOWLER (owner: c&b IS the bowler's catch;
  c&b carries NO wicket_fielders row here — verified 0 of 9,920 — so bowler taken from `deliveries`).
- `stumpings` = 'stumped' → listed non-substitute (keeper) fielder.
- `run_outs`  = 'run out' → ALL listed non-substitute fielders (a run-out may list several).
- `player_of_match` = 1 iff (match,player) in match_player_of_match else 0.
Super-over innings excluded (kept_innings join). Substitutes excluded (substitute IS NOT TRUE).
LEFT JOINs (fielding_agg by GROUP BY, pom by DISTINCT) are one-row-per-(match,player) → PK preserved.

New oracle gate in run_gates: independently recomputes grand totals from raw, asserts parquet SUMs match.

### Verify (scratchpad cricket_w2.duckdb → /tmp/export_w3)
- Full export: all structural/cross-check gates + 7 spot checks PASS; fielding oracle gates PASS.
- Byte-identical existing 10 player_matches cols vs HEAD-derived baseline: 0 / 0 (EXCEPT both ways).
- Row count unchanged 490,356 == 490,356 (no orphaned credit, no dup/drop).
- Grand totals parquet==raw: catches 201,520 / stumpings 9,397 / run_outs 26,252 / MoM 16,435.
- Player oracle (raw recompute == parquet SUM):
  MS Dhoni 766 catches / 235 stumpings / 169 run-outs / 40 MoM;
  V Kohli 462 catches / 0 stumpings / 45 run-outs / 91 MoM.
- No negative / null / non-0/1 rows.
- Size: player_matches 2,358,073 → 2,536,589 (+178,516, +7.6%). Other 7 files byte-identical.

## Next: metrics.js (fielding/impact defs, both views) + table.js (join + picker sections) + live verify.
