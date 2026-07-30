# Wave 1 — ball-grain exporter (productionise Step-0 into export_parquet.py)

Branch: `ball-layer`. Owner rulings: `review/owner_decisions.md` #67. Design:
`.orchestrator/ball-layer-design.md`. Starting point: `.orchestrator/step0/`.

Numbers-critical. PURELY ADDITIVE — existing 9 exports must stay byte-identical.

## STATUS: COMPLETE — all gates green, existing files byte-identical.

## DONE
- Added ball-layer constants (DELIVERY_BUCKETS/GENDERS/FILES/PK) + CONTENT_TYPES entries.
- Added `sql_deliveries(gender, bucket)` — ported build_ball_layer.py build_sql verbatim
  (schema v1, 41 cols). VERIFIED byte-identical to `data/step0/v1/*.parquet`
  (EXCEPT both ways = 0 on all 6 files; same row counts + sizes; ~19s total build).
- Added `run_ball_layer_gates` + `_ball_structural_gates` + `_ball_anchor_gates`,
  CALLED from run_gates. THE oracle re-aggregates balls -> reproduces ALL reconcilable
  columns of batting_innings (76 checks) / bowling_innings (74) / matchup_batting (76) /
  matchup_bowling (67) EXACTLY (incl. team-relative FLOATs bit-exact + spell columns),
  row-set EXCEPT both ways = 0. Order gates (file_row_number adjacency + row-group
  match_date non-overlap per file), super-over structural gates, 6 anchors from balls.
  335 checks pass, 0 fail (via drive_gates.py against pre-built files).
- main() writes the 6 ball files (additive) before gates; write_manifest + r2_upload
  include DELIVERY_FILES.

## VERIFIED (full end-to-end, build_and_gate.py against the read-only DB)
- Full build (9 existing + 6 ball) + run_gates + run_spot_checks + write_manifest: exit 0,
  0 FAIL. Ball-layer oracle + anchors + all 7 owner SPOT_CHECKS pass. Gates ~42s.
- Existing-files EXCEPT proof: branch build vs HEAD (f72900d) build, all 9 existing files
  EXCEPT both ways = 0, row counts identical -> change is PURELY ADDITIVE.
- Manifest lists 15 files (9 + 6 ball) with rows/bytes/sha. Ball layer total 76.3 MB.

## ENV NOTE
- The local data/cricket.duckdb snapshot LACKS the pipeline-built `player_profiles` table
  (built by pipeline/build_profiles.py). The gate + build drivers register it as a
  read-only TEMP VIEW over the shipped data/export/player_profiles.parquet (identical to
  what the matchup exports used). export_parquet.py itself is UNTOUCHED by this shim; the
  production pipeline DB has the real table. The gate joins the SHIPPED profiles parquet
  from out_dir (robust either way).

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
