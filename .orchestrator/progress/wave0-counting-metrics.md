# Wave 0 — Counting metrics (progress)

## 2026-07-23
- Added 4 batting counting metrics to BATTING_METRICS in src/metrics.js:
  fifties (50-99), hundreds (>=100), ducks (runs=0 AND dismissed=1), not_outs (dismissed=0).
  All kind:"total", format:"int", isPhaseMetric:null, zeroIsData:true, additive:true.
  Placed after `sixes`, before `not_out_pct`.
- Added 3 bowling counting metrics to BOWLING_METRICS:
  overs (SUM(balls), format "overs" O.B notation, placed after `balls`),
  four_wicket_hauls (wickets=4) + five_wicket_hauls (wickets>=5), placed after `maidens`.
- Added "overs" display format case to the TWO format renderers:
  table.js formatValue() and graph/charts.js labelForValue(). Display-only —
  stored/sorted value stays the raw ball count. floor(balls/6).(balls%6).
- Updated the format-enum doc comment in metrics.js header.
- NO change to query builders, presets, DEFAULT_COLUMNS, matchup namespaces, export_parquet.py.
- node --check passed on metrics.js, table.js, graph/charts.js.
- Note: batting + bowling landed in ONE mechanical commit (edits interleave one file;
  splitting mid-file adds risk with no benefit). Deviation from the 2-commit guide, disclosed.

## Verification (2026-07-23, localhost:8000, zero console errors)
- Query builders byte-identical: `git diff HEAD~1 HEAD -- src/table.js src/filters.js`
  shows only the new `overs` case in formatValue; buildQuery/buildMatchupQuery/
  buildScopeClauses untouched. (Rule 1 held.)
- Anchors reproduced ON SCREEN (Men/T20/International, 2023-07-01→2026-07-02):
  baseline 2,813 players; top row Karanbir Singh 2,454 runs; SA Yadav 60 inns /
  1,544 runs / 29.13 avg / 150.34 SR.
- Independent counts (JS row-scan + COUNT(*) FILTER — NOT the metric's SUM(CASE)):
  SA Yadav → fifties 11, hundreds 1, ducks 4, not-outs 7 — MATCH on-screen columns.
  Rizwan Butt (bowling) → 4W 3, 5W 3, balls 1591 → Overs "265.1" — MATCH on-screen.
- Overs renders cricket O.B notation on screen (265.1), not the raw ball count.
- New metrics present in: column picker, "+ Add condition…" (batting + bowling),
  graph metric pool. NOT in any default column set / preset. Confirmed via UI + code.
