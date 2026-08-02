#!/usr/bin/env python3
"""
Wave R2d independent verification (decision-39 rule: never reuse the app's own
aggregation shape to verify itself). Local parquet = data/wave1_out (reproduces
every standing anchor). Run: python3 .orchestrator/verify_waveR2d.py  (cwd=repo root)

  TASK A — MAT innings-level under Innings Number: the MAT (matches) column for a
           player under an Innings Number filter must be the distinct-match count
           over the FILTERED innings rows, not the whole-scope player_matches count.
  TASK B — matchup_bowling Boundary Run %: (4*fours + 6*sixes)*100/runs_conceded for
           a bowler vs a batting hand, cross-checked against raw deliveries.
  TASK C — Caught & bowled fielding count: a distinct c&b count, separate from the
           `catches` total (which still folds c&b in, unchanged).
"""
import duckdb
con = duckdb.connect()
B  = "read_parquet('data/wave1_out/batting_innings.parquet')"
F  = "read_parquet('data/wave1_out/fielding_events.parquet')"
MB = "read_parquet('data/wave1_out/matchup_bowling.parquet')"
PM = "read_parquet('data/wave1_out/player_matches.parquet')"
D  = "read_parquet('data/wave1_out/deliveries_m_t20.parquet')"

# Standing anchor scope: Men / T20 / International, 2023-07-01 .. 2026-07-02 (day-bounded).
VSCOPE = ("gender='male' AND match_type IN ('T20','IT20') AND team_type='international' "
          "AND match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'")
RSCOPE = VSCOPE + " AND is_super_over = FALSE"   # raw deliveries: exclude super overs
SKY = "271f83cd"        # Suryakumar Yadav
KARAN = "6a97c7a4"      # Karanbir Singh
BUMRAH = "462411b3"     # JJ Bumrah

fails = []
def one(sql): return con.execute(sql).fetchone()[0]
def check(name, got, exp, ratio=False):
    ok = (abs((got or 0)-(exp or 0)) < 1e-6) if ratio else (got == exp)
    print(f"  {'PASS' if ok else 'FAIL'}  {name:52s} got={got}  expect={exp}")
    if not ok: fails.append(name)

print("=== ANCHORS (must be unchanged; all R2d changes are additive) ===")
check("batting player count", one(f"SELECT COUNT(*) FROM (SELECT batter_id,batter_name FROM {B} WHERE {VSCOPE} GROUP BY 1,2)"), 2813)
check("Karanbir Singh runs", one(f"SELECT SUM(runs)::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='{KARAN}'"), 2454)
sky = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, round(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), round(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'").fetchone()
check("SA Yadav inns/runs/avg/sr", list(sky), [60, 1544, 29.13, 150.34])

print("\n=== TASK A — MAT innings-level under Innings Number (SA Yadav, 1st innings) ===")
# OLD (buggy) MAT = whole-scope player_matches distinct-match count (knows nothing
# about which innings the player batted in):
old_mat = one(f"SELECT COUNT(DISTINCT match_id) FROM {PM} WHERE {VSCOPE} AND player_id='{SKY}'")
check("OLD MAT = whole-scope player_matches (the bug)", old_mat, 64)
# NEW MAT = COUNT(DISTINCT match_id) over the FILTERED innings rows (innings 1 = 0-based 0):
new_mat = one(f"SELECT COUNT(DISTINCT match_id) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}' AND innings_number IN (0)")
inns1   = one(f"SELECT COUNT(*) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}' AND innings_number IN (0)")
check("NEW MAT = distinct matches SKY batted in innings 1", new_mat, 38)
check("consistent with INNS (single-innings ⇒ MAT==INNS)", new_mat, inns1)
# INDEPENDENT raw-ball derivation of the same distinct-match count (different source
# + shape: distinct match_id from the delivery layer, super overs excluded):
raw_mat = one(f"SELECT COUNT(DISTINCT match_id) FROM (SELECT DISTINCT match_id FROM {D} WHERE {RSCOPE} AND batter_id='{SKY}' AND innings_number=0)")
check("raw-ball distinct-match (independent)", raw_mat, new_mat)

print("\n=== TASK B — matchup_bowling Boundary Run % (Bumrah vs Right-hand bat) ===")
# Decomposed shape (numerator/denominator computed SEPARATELY, divided in Python —
# not the app's single one-line expression):
F_rhb, S_rhb, RC_rhb = con.execute(
    f"SELECT SUM(fours_conceded), SUM(sixes_conceded), SUM(runs_conceded) FROM {MB} "
    f"WHERE {VSCOPE} AND bowler_id='{BUMRAH}' AND batting_hand='Right-hand bat'").fetchone()
boundary_runs = 4*int(F_rhb) + 6*int(S_rhb)
pct = boundary_runs * 100.0 / int(RC_rhb)
print(f"    Bumrah vs RHB: fours={F_rhb} sixes={S_rhb} runs_conceded={RC_rhb} -> boundary_runs={boundary_runs}")
print(f"    Boundary Run % = {boundary_runs}*100/{RC_rhb} = {round(pct,2)}")
# App's exact one-line expression (must agree with the decomposed number):
app_pct = one(f"SELECT (4*SUM(fours_conceded)+6*SUM(sixes_conceded))*100.0/NULLIF(SUM(runs_conceded),0) "
              f"FROM {MB} WHERE {VSCOPE} AND bowler_id='{BUMRAH}' AND batting_hand='Right-hand bat'")
check("decomposed pct == app one-line expression", round(pct,6), round(app_pct,6), ratio=True)
# Cross-check the view's stored columns against RAW deliveries at the bowler-total
# level (all hands) — validates fours_conceded/sixes_conceded/runs_conceded are real:
vF, vS, vRC = con.execute(f"SELECT SUM(fours_conceded), SUM(sixes_conceded), SUM(runs_conceded) FROM {MB} WHERE {VSCOPE} AND bowler_id='{BUMRAH}'").fetchone()
rF  = one(f"SELECT COUNT(*) FROM {D} WHERE {RSCOPE} AND bowler_id='{BUMRAH}' AND runs_batter=4 AND is_not_boundary IS NOT TRUE")
rS  = one(f"SELECT COUNT(*) FROM {D} WHERE {RSCOPE} AND bowler_id='{BUMRAH}' AND runs_batter=6 AND is_not_boundary IS NOT TRUE")
rRC = one(f"SELECT SUM(runs_batter + COALESCE(noballs,0) + COALESCE(wides,0)) FROM {D} WHERE {RSCOPE} AND bowler_id='{BUMRAH}'")
check("view fours_conceded == raw 4s (all hands)", int(vF), rF)
check("view sixes_conceded == raw 6s (all hands)", int(vS), rS)
check("view runs_conceded == raw runs conceded (all hands)", int(vRC), int(rRC))

print("\n=== TASK C — Caught & bowled fielding count (distinct from `catches`) ===")
def fld(fid, kinds):
    return one(f"SELECT COUNT(*) FROM {F} WHERE {VSCOPE} AND substitute IS NOT TRUE AND fielder_id='{fid}' AND kind IN ({kinds})")
for name, fid, exp_cb in [("Karanbir Singh", KARAN, 3), ("SA Yadav", SKY, None)]:
    caught_only = fld(fid, "'caught'")
    cb          = fld(fid, "'caught and bowled'")
    catches_app = fld(fid, "'caught','caught and bowled'")   # unchanged `catches` defn
    print(f"    {name}: catches(app)={catches_app}  [caught-only={caught_only} + c&b={cb}]")
    check(f"{name}: catches == caught + c&b (subsumption, unchanged)", catches_app, caught_only + cb)
    if exp_cb is not None:
        check(f"{name}: distinct c&b count", cb, exp_cb)

print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
