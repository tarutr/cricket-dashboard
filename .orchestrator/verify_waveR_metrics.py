#!/usr/bin/env python3
"""
Wave R1 (filter-rejig) metric verification — decision-39 independent check.

For every NEW metric added to src/metrics.js this script computes two numbers:
  (A) the metric's EXACT sqlExpression string, interpolated verbatim into the
      app's grouped query over the batting_innings / bowling_innings VIEW;
  (B) an INDEPENDENT hand-written derivation from the RAW ball layer
      (data/step0/v1/deliveries_*.parquet) applying SPEC section 4.1 rules from
      scratch — NOT the view's own pre-aggregated columns.
A metric passes iff A == B (exact for ints, <1e-9 for ratios).

It also reproduces the standing anchors to prove existing numbers are unchanged.

Run:  python3 .orchestrator/verify_waveR_metrics.py     (cwd = repo root)
"""
import duckdb, sys

con = duckdb.connect()
B = "read_parquet('data/wave1_out/batting_innings.parquet')"
W = "read_parquet('data/wave1_out/bowling_innings.parquet')"
R = "read_parquet('data/step0/v1/deliveries_m_t20.parquet')"

# Standing anchor scope: Men / T20 (T20+IT20) / International, 2023-07-01..2026-07-02 day-bounded.
VSCOPE = ("gender='male' AND match_type IN ('T20','IT20') AND team_type='international' "
          "AND match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'")
RSCOPE = VSCOPE + " AND is_super_over = FALSE"   # raw layer must also drop super overs

fails = []
def one(sql): return con.execute(sql).fetchone()[0]
def check(name, a, b, ratio=False):
    ok = (abs((a or 0)-(b or 0)) < 1e-9) if ratio else (a == b)
    print(f"  {'PASS' if ok else 'FAIL'}  {name:28s} metric={a}  independent={b}")
    if not ok: fails.append(name)

print("=== ANCHORS (must be unchanged) ===")
check("batting player count", one(f"SELECT COUNT(*) FROM (SELECT batter_id,batter_name FROM {B} WHERE {VSCOPE} GROUP BY 1,2)"), 2813)
check("Karanbir Singh runs", one(f"SELECT SUM(runs)::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='6a97c7a4'"), 2454)
sky = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, round(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), round(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VSCOPE} AND batter_id='271f83cd'").fetchone()
check("SA Yadav inns/runs/avg/sr", list(sky), [60,1544,29.13,150.34])

# Representative players (chosen for NON-ZERO components so tests are non-trivial)
RIZWAN='2f26ac1a'   # non-boundary four
RUNSEWE='c25d26dc'  # fives
SBAU='9a95bebb'     # non-boundary six + five
DAW='596982e6'      # bowler: wides/no-balls/boundaries conceded

print("\n=== BATTING: % Runs in 4s(run) / 5s / 6s(run) ===")
# metric sqlExpression strings (verbatim from src/metrics.js) vs raw ball derivation
check("runs_4s_run_pct (Rizwan)",
      one(f"SELECT (4 * SUM(nb_fours)) * 100.0 / NULLIF(SUM(runs), 0) FROM {B} WHERE {VSCOPE} AND batter_id='{RIZWAN}'"),
      one(f"SELECT (4*COUNT(*) FILTER(WHERE runs_batter=4 AND is_not_boundary IS TRUE))*100.0/NULLIF(SUM(runs_batter),0) FROM {R} WHERE {RSCOPE} AND batter_id='{RIZWAN}'"), ratio=True)
check("runs_5s_pct (Runsewe)",
      one(f"SELECT (5 * SUM(fives)) * 100.0 / NULLIF(SUM(runs), 0) FROM {B} WHERE {VSCOPE} AND batter_id='{RUNSEWE}'"),
      one(f"SELECT (5*COUNT(*) FILTER(WHERE runs_batter=5))*100.0/NULLIF(SUM(runs_batter),0) FROM {R} WHERE {RSCOPE} AND batter_id='{RUNSEWE}'"), ratio=True)
check("runs_6s_run_pct (S Bau)",
      one(f"SELECT (6 * SUM(nb_sixes)) * 100.0 / NULLIF(SUM(runs), 0) FROM {B} WHERE {VSCOPE} AND batter_id='{SBAU}'"),
      one(f"SELECT (6*COUNT(*) FILTER(WHERE runs_batter=6 AND is_not_boundary IS TRUE))*100.0/NULLIF(SUM(runs_batter),0) FROM {R} WHERE {RSCOPE} AND batter_id='{SBAU}'"), ratio=True)

print("\n=== BATTING: Innings Score >= N (parametrised) ===")
for N in (30, 50, 100):
    expr = f"SUM(CASE WHEN runs >= {N} THEN 1 ELSE 0 END)"   # == paramSqlExpression(innings_score_ge, N)
    check(f"innings_score_ge N={N} (SKY)",
          one(f"SELECT {expr}::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='271f83cd'"),
          one(f"SELECT COUNT(*) FROM (SELECT match_id,innings_number,SUM(runs_batter) r FROM {R} WHERE {RSCOPE} AND batter_id='271f83cd' GROUP BY 1,2) WHERE r>={N}"))

print("\n=== BOWLING: Boundary Run % ===")
check("boundary_runs_pct (Dawood)",
      one(f"SELECT (4 * SUM(fours_conceded) + 6 * SUM(sixes_conceded)) * 100.0 / NULLIF(SUM(runs_conceded), 0) FROM {W} WHERE {VSCOPE} AND bowler_id='{DAW}'"),
      one(f"""SELECT (4*COUNT(*) FILTER(WHERE runs_batter=4 AND is_not_boundary IS NOT TRUE)
               +6*COUNT(*) FILTER(WHERE runs_batter=6 AND is_not_boundary IS NOT TRUE))*100.0
               /NULLIF(SUM(runs_batter+COALESCE(noballs,0)+COALESCE(wides,0)),0) FROM {R} WHERE {RSCOPE} AND bowler_id='{DAW}'"""), ratio=True)

print("\n=== BOWLING: Extras (wides / no-balls, RUN totals) ===")
check("extras_wides (Dawood)",
      one(f"SELECT SUM(wides_runs)::BIGINT FROM {W} WHERE {VSCOPE} AND bowler_id='{DAW}'"),
      one(f"SELECT SUM(COALESCE(wides,0))::BIGINT FROM {R} WHERE {RSCOPE} AND bowler_id='{DAW}'"))
check("extras_noballs (Dawood)",
      one(f"SELECT SUM(noball_runs)::BIGINT FROM {W} WHERE {VSCOPE} AND bowler_id='{DAW}'"),
      one(f"SELECT SUM(COALESCE(noballs,0))::BIGINT FROM {R} WHERE {RSCOPE} AND bowler_id='{DAW}'"))

print("\n=== BOWLING: Wicket Hauls >= N (parametrised) ===")
for N in (3, 4, 5):
    expr = f"SUM(CASE WHEN wickets >= {N} THEN 1 ELSE 0 END)"  # == paramSqlExpression(wicket_hauls_ge, N)
    check(f"wicket_hauls_ge N={N} (Dawood)",
          one(f"SELECT {expr}::BIGINT FROM {W} WHERE {VSCOPE} AND bowler_id='{DAW}'"),
          one(f"SELECT COUNT(*) FROM (SELECT match_id,innings_number,SUM(bowler_credited_wkts) w FROM {R} WHERE {RSCOPE} AND bowler_id='{DAW}' GROUP BY 1,2) WHERE w>={N}"))
# generalisation cross-checks vs the existing fixed haul metrics
check("hauls>=4 == 4W + 5W",
      one(f"SELECT SUM(CASE WHEN wickets>=4 THEN 1 ELSE 0 END) FROM {W} WHERE {VSCOPE} AND bowler_id='{DAW}'"),
      one(f"SELECT SUM(CASE WHEN wickets=4 THEN 1 ELSE 0 END)+SUM(CASE WHEN wickets>=5 THEN 1 ELSE 0 END) FROM {W} WHERE {VSCOPE} AND bowler_id='{DAW}'"))

print("\n=== INNINGS NUMBER: 0-based mapping (INNINGS_NUMBER_FILTER) ===")
# display "Innings 1" == stored innings_number 0; white-ball max stored=1, red-ball max stored=3
wmax = one(f"SELECT MAX(innings_number) FROM {B} WHERE match_type IN ('T20','IT20','ODI','ODM')")
rmax = one(f"SELECT MAX(innings_number) FROM {B} WHERE match_type IN ('Test','MDM')")
check("white-ball max stored innings_number", wmax, 1)
check("red-ball max stored innings_number", rmax, 3)

print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
sys.exit(1 if fails else 0)
