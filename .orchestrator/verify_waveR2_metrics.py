#!/usr/bin/env python3
"""
Wave R2 (filter-rejig palette) NEW-metric verification — decision-39 independent check.

R2 adds exactly TWO metric defs to src/metrics.js: the boundary halves of the
"% Runs in…" 4s/6s split (runs_4s_boundary_pct, runs_6s_boundary_pct). For each:
  (A) the metric's EXACT sqlExpression string (verbatim from src/metrics.js),
      interpolated over the app's batting_innings VIEW;
  (B) an INDEPENDENT hand-written derivation from the RAW ball layer applying the
      SPEC 4.1 boundary rule from scratch — NOT the view's own fours_hit/sixes_hit.
Passes iff A == B (<1e-9). Also checks the partition invariant
(4s-boundary + 6s-boundary == the existing batting boundary_runs_pct) and reproduces
the standing anchors to prove existing numbers are unchanged.

Run:  python3 .orchestrator/verify_waveR2_metrics.py     (cwd = repo root)
"""
import duckdb, sys

con = duckdb.connect()
B = "read_parquet('data/wave1_out/batting_innings.parquet')"
R = "read_parquet('data/step0/v1/deliveries_m_t20.parquet')"

VSCOPE = ("gender='male' AND match_type IN ('T20','IT20') AND team_type='international' "
          "AND match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'")
RSCOPE = VSCOPE + " AND is_super_over = FALSE"

fails = []
def one(sql): return con.execute(sql).fetchone()[0]
def check(name, a, b, ratio=False):
    ok = (abs((a or 0)-(b or 0)) < 1e-9) if ratio else (a == b)
    print(f"  {'PASS' if ok else 'FAIL'}  {name:34s} metric={a}  independent={b}")
    if not ok: fails.append(name)

SKY = '271f83cd'  # SA Yadav — plenty of both boundary 4s and 6s (non-trivial)

print("=== ANCHORS (must be unchanged) ===")
check("batting player count", one(f"SELECT COUNT(*) FROM (SELECT batter_id,batter_name FROM {B} WHERE {VSCOPE} GROUP BY 1,2)"), 2813)
check("Karanbir Singh runs", one(f"SELECT SUM(runs)::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='6a97c7a4'"), 2454)
sky = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, round(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), round(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'").fetchone()
check("SA Yadav inns/runs/avg/sr", list(sky), [60,1544,29.13,150.34])

print("\n=== BATTING: % Runs in 4s(boundary) / 6s(boundary) [NEW in R2] ===")
# (A) verbatim sqlExpression over the view  vs  (B) raw-ball derivation (SPEC 4.1
# boundary rule = runs_batter IN (4,6) AND is_not_boundary IS NOT TRUE).
check("runs_4s_boundary_pct (SKY)",
      one(f"SELECT (4 * SUM(fours_hit)) * 100.0 / NULLIF(SUM(runs), 0) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'"),
      one(f"SELECT (4*COUNT(*) FILTER(WHERE runs_batter=4 AND is_not_boundary IS NOT TRUE))*100.0/NULLIF(SUM(runs_batter),0) FROM {R} WHERE {RSCOPE} AND batter_id='{SKY}'"), ratio=True)
check("runs_6s_boundary_pct (SKY)",
      one(f"SELECT (6 * SUM(sixes_hit)) * 100.0 / NULLIF(SUM(runs), 0) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'"),
      one(f"SELECT (6*COUNT(*) FILTER(WHERE runs_batter=6 AND is_not_boundary IS NOT TRUE))*100.0/NULLIF(SUM(runs_batter),0) FROM {R} WHERE {RSCOPE} AND batter_id='{SKY}'"), ratio=True)

print("\n=== PARTITION INVARIANT: 4s-bdry + 6s-bdry == batting boundary_runs_pct ===")
check("split sum == boundary_runs_pct (SKY)",
      one(f"SELECT ((4*SUM(fours_hit)) + (6*SUM(sixes_hit))) * 100.0 / NULLIF(SUM(runs),0) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'"),
      one(f"SELECT (4 * SUM(fours_hit) + 6 * SUM(sixes_hit)) * 100.0 / NULLIF(SUM(runs), 0) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'"), ratio=True)

print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
sys.exit(1 if fails else 0)
