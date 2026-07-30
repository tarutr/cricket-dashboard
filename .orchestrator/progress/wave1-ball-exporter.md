# Wave 1 — ball-grain exporter (productionise Step-0 into export_parquet.py)

Branch: `ball-layer`. Owner rulings: `review/owner_decisions.md` #67. Design:
`.orchestrator/ball-layer-design.md`. Starting point: `.orchestrator/step0/`.

Numbers-critical. PURELY ADDITIVE — existing 9 exports must stay byte-identical.

## DONE
- Added ball-layer constants (DELIVERY_BUCKETS/GENDERS/FILES/PK) + CONTENT_TYPES entries.
- Added `sql_deliveries(gender, bucket)` — ported build_ball_layer.py build_sql verbatim
  (schema v1, 41 cols). VERIFIED byte-identical to `data/step0/v1/*.parquet`
  (EXCEPT both ways = 0 on all 6 files; same row counts + sizes; 19s total build).

## NEXT
- run_ball_layer_gates(con, out_dir): THE oracle (re-aggregate balls -> reproduce
  batting_innings / bowling_innings / matchup_batting / matchup_bowling EXACTLY) +
  order gates (file_row_number adjacency + row-group match_date non-overlap) +
  super-over structural gates + anchor SPOT_CHECKS from balls. Wire into run_gates.
- main(): write the 6 ball files (additive) before the gates.
- write_manifest + r2_upload: include DELIVERY_FILES (additive).
- Full local build to data/wave1_out/ + all gates; existing-files EXCEPT vs HEAD build.

## GOTCHAS (from Step 0, preserved)
- Do NOT set PRAGMA preserve_insertion_order=false (corrupts sort / kills pruning).
- Reverse clocks are STORED (owner ruling); computed as tot-fwd+1 with FILTERed tot.
- wickets_extra (LIST) carries wicket_index>=1 only (14 rows); recovers 16 batter +
  1 bowler dismissal + 11 crease appearances the flat first-wicket columns drop.
- Super-over rows INCLUDED + flagged; UNCONDITIONALLY excluded from every stat gate.
- SA Yadav avg needs the overflow -> 53 dismissals (29.13, not 29.69 / 52).
- Oracle reads local `data/export/*.parquet` as the reference (built from same DB).
- Order-gate features verified available: read_parquet(file_row_number=true),
  parquet_metadata() stats_min_value/stats_max_value per row_group.
