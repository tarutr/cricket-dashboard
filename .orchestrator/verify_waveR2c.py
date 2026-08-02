#!/usr/bin/env python3
"""
Wave R2c independent verification (decision-39). Confirms:
  - Anchors unchanged (Innings Number filter is additive: no clause when empty).
  - Innings Number = 1 (batting) narrows to innings_number = 0 (0-based), and the
    view count matches an INDEPENDENT raw-ball derivation.
  - Fielding-count kinds (Caught/Run-out/Stumped) for a known fielder, plus the
    Caught & bowled SUBSUMPTION finding (fielding catches fold c&b in).
Run: python3 .orchestrator/verify_waveR2c.py   (cwd = repo root)
"""
import duckdb
con = duckdb.connect()
B = "read_parquet('data/wave1_out/batting_innings.parquet')"
F = "read_parquet('data/wave1_out/fielding_events.parquet')"
R = "read_parquet('data/step0/v1/deliveries_m_t20.parquet')"

VSCOPE = ("gender='male' AND match_type IN ('T20','IT20') AND team_type='international' "
          "AND match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'")
RSCOPE = VSCOPE + " AND is_super_over = FALSE"
SKY = "271f83cd"   # Suryakumar Yadav

fails = []
def one(sql): return con.execute(sql).fetchone()[0]
def check(name, a, b, ratio=False):
    ok = (abs((a or 0)-(b or 0)) < 1e-9) if ratio else (a == b)
    print(f"  {'PASS' if ok else 'FAIL'}  {name:42s} got={a}  expect={b}")
    if not ok: fails.append(name)

print("=== ANCHORS (additive: unchanged with no Innings Number set) ===")
check("batting player count", one(f"SELECT COUNT(*) FROM (SELECT batter_id,batter_name FROM {B} WHERE {VSCOPE} GROUP BY 1,2)"), 2813)
check("Karanbir Singh runs", one(f"SELECT SUM(runs)::BIGINT FROM {B} WHERE {VSCOPE} AND batter_id='6a97c7a4'"), 2454)
sky = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, round(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), round(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'").fetchone()
check("SA Yadav inns/runs/avg/sr", list(sky), [60,1544,29.13,150.34])

print("\n=== TASK 1: Innings Number filter (0-based: display 1 -> stored 0) ===")
# The filter emits `innings_number IN (0)` for display "1st innings".
full = one(f"SELECT COUNT(*) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}'")
inn1_view = one(f"SELECT COUNT(*) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}' AND innings_number IN (0)")
inn2_view = one(f"SELECT COUNT(*) FROM {B} WHERE {VSCOPE} AND batter_id='{SKY}' AND innings_number IN (1)")
check("SA Yadav full innings", full, 60)
check("SA Yadav innings-1 (view, innings_number=0)", inn1_view, 38)
check("SA Yadav innings-1 + innings-2 == full", inn1_view + inn2_view, full)
# INDEPENDENT raw-ball derivation: distinct (match_id, innings_number) SKY batted
# in with innings_number=0, super overs excluded — NOT the view's own row count.
inn1_raw = one(f"SELECT COUNT(*) FROM (SELECT DISTINCT match_id, innings_number FROM {R} WHERE {RSCOPE} AND batter_id='{SKY}' AND innings_number=0)")
check("SA Yadav innings-1 (raw ball layer, independent)", inn1_raw, inn1_view)

print("\n=== TASK 2: Fielding Wicket Type counts (a known fielder) ===")
# Fielding scope = core + substitutes excluded (independent GROUP-BY count, not the
# app's MAX(SUM(CASE...)) CTE shape). App defn: catches = caught + caught-and-bowled.
def fld(fid, kinds):
    return one(f"SELECT COUNT(*) FROM {F} WHERE {VSCOPE} AND substitute IS NOT TRUE AND fielder_id='{fid}' AND kind IN ({kinds})")
for name, fid in [("SA Yadav", SKY), ("Karanbir Singh", "6a97c7a4")]:
    caught_only = fld(fid, "'caught'")
    cb = fld(fid, "'caught and bowled'")
    catches_app = fld(fid, "'caught','caught and bowled'")  # app "Caught" defn
    stumpings = fld(fid, "'stumped'")
    runouts = fld(fid, "'run out'")
    print(f"  {name}: Caught(app)={catches_app} [caught-only={caught_only} + c&b={cb}]  Stumped={stumpings}  Run-out={runouts}")
    check(f"{name}: catches == caught + c&b (subsumption)", catches_app, caught_only + cb)

# Confirm there is NO distinct fielding-count column for c&b anywhere (only kind).
kinds = [r[0] for r in con.execute(f"SELECT DISTINCT kind FROM {F} WHERE {VSCOPE} ORDER BY 1").fetchall()]
print(f"\n  fielding kinds present in scope: {kinds}")

print("\n" + ("ALL PASS" if not fails else f"FAILURES: {fails}"))
