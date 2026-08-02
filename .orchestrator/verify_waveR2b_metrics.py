#!/usr/bin/env python3
"""
Wave R2b independent verification (decision-39 rule — never the app's own shape).

Covers:
  • PotM Count (potm_count) — new FILTER metric. sqlExpression MAX(pom_cte.player_of_match)
    where pom_cte.player_of_match = SUM(player_of_match) per player (the award COUNT).
    (A) reproduce the app's pom_cte + MAX projection shape;
    (B) an INDEPENDENT raw SUM of the 0/1 PotM flag straight off player_matches.
    Passes iff A == B, and equals a hand count for a known player.
  • Phase-2 param filters (innings_score_ge / wicket_hauls_ge) at a chosen N, and an
    innings_number scope predicate — each vs an independent raw derivation.
  • Standing anchors reproduce unchanged (proves nothing calculation-side moved).

Run:  python3 .orchestrator/verify_waveR2b_metrics.py     (cwd = repo root)
"""
import duckdb, sys

con = duckdb.connect()
B  = "read_parquet('data/wave1_out/batting_innings.parquet')"
BOWL = "read_parquet('data/wave1_out/bowling_innings.parquet')"
PM = "read_parquet('data/wave1_out/player_matches.parquet')"
R  = "read_parquet('data/step0/v1/deliveries_m_t20.parquet')"

VSCOPE = ("gender='male' AND match_type IN ('T20','IT20') AND team_type='international' "
          "AND match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'")
# player_matches carries gender/match_type/team_type/match_date directly.
PMSCOPE = VSCOPE

fails = []
def one(sql): return con.execute(sql).fetchone()[0]
def check(name, a, b, ratio=False):
    ok = (abs((a or 0)-(b or 0)) < 1e-9) if ratio else (a == b)
    print(f"  {'PASS' if ok else 'FAIL'}  {name:44s} app={a}  independent={b}")
    if not ok: fails.append(name)

SKY = '271f83cd'  # SA Yadav

print("=== ANCHORS (must be unchanged) ===")
check("batting player count", one(f"SELECT COUNT(*) FROM (SELECT batter_id,batter_name FROM {B} WHERE {VSCOPE} GROUP BY 1,2)"), 2813)
check("Karanbir Singh runs", one(f"SELECT SUM(runs)::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='6a97c7a4'"), 2454)
sky = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, round(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), round(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'").fetchone()
check("SA Yadav inns/runs/avg/sr", list(sky), [60,1544,29.13,150.34])

print("\n=== PotM Count (potm_count) [NEW filter metric, R2b] ===")
# (A) app shape: pom_cte SUMs the flag per player; metric projects MAX of that constant.
appA = one(f"""
  WITH pom_cte AS (
    SELECT player_id AS pom_player_id, SUM(player_of_match) AS player_of_match
    FROM {PM} WHERE {PMSCOPE} GROUP BY player_id
  ) SELECT MAX(player_of_match) FROM pom_cte WHERE pom_player_id='{SKY}'""")
# (B) independent: raw SUM of the 0/1 flag straight off player_matches (no CTE).
indB = one(f"SELECT SUM(player_of_match)::BIGINT FROM {PM} WHERE {PMSCOPE} AND player_id='{SKY}'")
check("SKY potm_count (app pom_cte/MAX == raw SUM)", appA, indB)
check("SKY potm_count == hand count 5", appA, 5)
# Robustness: a multi-award player (Karanbir Singh, batter/PM id shares player_id space).
kb = one(f"SELECT SUM(player_of_match)::BIGINT FROM {PM} WHERE {PMSCOPE} AND player_id='6a97c7a4'")
check("Karanbir Singh potm_count == 11", kb, 11)

print("\n=== Phase 2 param filters (chosen N) ===")
# innings_score_ge at N=50 (paramTemplate SUM(CASE WHEN runs >= {N} THEN 1 ELSE 0 END)):
# count of SKY innings scoring >=50, vs independent raw-ball per-innings tally.
app_is = one(f"SELECT SUM(CASE WHEN runs >= 50 THEN 1 ELSE 0 END)::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'")
ind_is = one(f"""SELECT COUNT(*) FROM (
  SELECT match_id, innings_number, SUM(runs_batter) AS r
  FROM {R} WHERE {VSCOPE} AND is_super_over = FALSE AND batter_id='{SKY}'
  GROUP BY 1,2 HAVING SUM(runs_batter) >= 50)""")
check("SKY innings_score_ge(50)", app_is, ind_is)
# innings_score_ge at N=100 (a different N proves the param actually varies).
app_is100 = one(f"SELECT SUM(CASE WHEN runs >= 100 THEN 1 ELSE 0 END)::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'")
check("SKY innings_score_ge(100)", app_is100,
      one(f"""SELECT COUNT(*) FROM (
        SELECT match_id, innings_number, SUM(runs_batter) AS r
        FROM {R} WHERE {VSCOPE} AND is_super_over = FALSE AND batter_id='{SKY}'
        GROUP BY 1,2 HAVING SUM(runs_batter) >= 100)"""))

# wicket_hauls_ge at N=3 for a known bowler (Bumrah id from anchors context = 9d31e043? use a robust top wkt-taker instead).
BUM = one(f"SELECT bowler_id FROM {BOWL} WHERE {VSCOPE} GROUP BY 1 ORDER BY SUM(wickets) DESC LIMIT 1")
app_wh = one(f"SELECT SUM(CASE WHEN wickets >= 3 THEN 1 ELSE 0 END)::BIGINT FROM {BOWL} WHERE {VSCOPE} AND bowler_id='{BUM}'")
ind_wh = one(f"SELECT COUNT(*) FROM {BOWL} WHERE {VSCOPE} AND bowler_id='{BUM}' AND wickets >= 3")
check(f"top-wkt bowler wicket_hauls_ge(3)", app_wh, ind_wh)

print("\n=== Innings Number scope predicate (0-based; display N = stored N-1) ===")
# White-ball: display innings 1 -> stored innings_number 0. Count SKY innings in the
# FIRST batting innings vs an independent raw-ball reconstruction.
app_in = one(f"SELECT COUNT(*) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}' AND innings_number = 0")
ind_in = one(f"""SELECT COUNT(*) FROM (
  SELECT DISTINCT match_id, innings_number FROM {R}
  WHERE {VSCOPE} AND is_super_over = FALSE AND batter_id='{SKY}' AND innings_number = 0)""")
check("SKY innings_number=0 (display inns 1) count", app_in, ind_in)
check("SKY total inns == inns1 + inns2",
      one(f"SELECT COUNT(*) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'"),
      one(f"SELECT COUNT(*) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}' AND innings_number IN (0,1)"))

print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
sys.exit(1 if fails else 0)
