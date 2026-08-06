#!/usr/bin/env python3
"""
Popup review R3 — INDEPENDENT number verification (decision-39 rule: never reuse the
app's own aggregation shape to verify itself). This gates the ball-layer production
cutover, so every headline figure is re-derived FROM SCRATCH off the RAW delivery base
table (`deliveries_m_t20.parquet`) + raw `fielding_events.parquet`, per SPEC.md §4.1 —
NOT off the app's pre-aggregated batting_innings / matchup_batting files. The pre-agg
files are shown alongside ONLY as a drift cross-check (RAW == PREAGG must hold).

Data source: data/wave1_out/  (same location the other verify_wave* scripts point at).
Run:  python3 .orchestrator/verify_popup_review_R3.py   (cwd = repo root)

Scope for ALL checks: Men / T20 / International, 2023-07-01 .. 2026-07-02 (day-bounded).
"""
import duckdb, sys

con = duckdb.connect()

# ---- data sources ---------------------------------------------------------
D    = "read_parquet('data/wave1_out/deliveries_m_t20.parquet')"   # RAW base table
B    = "read_parquet('data/wave1_out/batting_innings.parquet')"    # app pre-agg (cross-check only)
MBAT = "read_parquet('data/wave1_out/matchup_batting.parquet')"    # app pre-agg (cross-check only)
F    = "read_parquet('data/wave1_out/fielding_events.parquet')"    # raw fielding events
PROF = "read_parquet('data/wave1_out/player_profiles.parquet')"    # bowler style (spin/pace)

# Standing anchor scope.
VS = ("gender='male' AND match_type IN ('T20','IT20') AND team_type='international' "
      "AND match_date >= DATE '2023-07-01' AND match_date < DATE '2026-07-03'")
RS = VS + " AND is_super_over = FALSE"      # raw deliveries: exclude super overs (§4.1)

SKY  = '271f83cd'      # SA Yadav
BUT  = '99b75528'      # JC Buttler
# §4.1: dismissals for a batter's average = any wicket kind EXCEPT these two.
NON_DIS = "('retired hurt','retired not out')"

fails, warns = [], []
def one(sql): return con.execute(sql).fetchone()[0]
def r2(x):    return None if x is None else round(float(x), 2)
def check(name, got, exp, ratio=False, level='BLOCKER'):
    if exp is None:
        print(f"  ----  {name:46s} got={got}   (no anchor — derived for reconciliation)")
        return
    ok = (abs((got or 0)-(exp or 0)) < 5e-3) if ratio else (got == exp)
    print(f"  {'PASS' if ok else 'FAIL'}  {name:46s} got={got}   expect={exp}")
    if not ok: fails.append(f"[{level}] {name}: got {got} expect {exp}")

# ---------------------------------------------------------------------------
# Independent per-innings SKY table, built straight off the RAW delivery layer.
#   runs  = SUM(runs_batter)                                    (§4.1: batter runs)
#   balls = COUNT(wides IS NULL)      (no-balls DO count as faced) (§4.1 batter balls)
#   opp   = bowling_team
# Plus an independent wickets relation = primary wicket UNION unnested wickets_extra
# (multi-wicket balls), from which a per-innings dismissal flag is derived per §4.1.
# ---------------------------------------------------------------------------
WK_UNION = f"""
  SELECT match_id, innings_number, wicket_kind AS kind, player_out_id
    FROM {D} WHERE {RS} AND wicket_kind IS NOT NULL
  UNION ALL
  SELECT match_id, innings_number, t.we.kind, t.we.player_out_id
    FROM {D}, UNNEST(wickets_extra) AS t(we) WHERE {RS}
"""
SKY_INNS = f"""
  WITH ball AS (SELECT * FROM {D} WHERE {RS} AND batter_id='{SKY}'),
       runs AS (
         SELECT match_id, innings_number,
                SUM(runs_batter)                                  AS runs,
                SUM(CASE WHEN wides IS NULL THEN 1 ELSE 0 END)     AS balls,
                MAX(bowling_team)                                  AS opp
         FROM ball GROUP BY 1,2),
       wk AS (
         SELECT match_id, innings_number, COUNT(*) AS dis
         FROM ({WK_UNION})
         WHERE player_out_id='{SKY}' AND kind NOT IN {NON_DIS}
         GROUP BY 1,2)
  SELECT r.match_id, r.innings_number, r.runs, r.balls, r.opp,
         COALESCE(w.dis,0) AS dismissed
  FROM runs r LEFT JOIN wk w USING (match_id, innings_number)
"""

def agg(where_extra=""):
    """inns / runs / avg / SR from the independent per-innings SKY table."""
    w = f"WHERE {where_extra}" if where_extra else ""
    return con.execute(f"""
      WITH s AS ({SKY_INNS})
      SELECT COUNT(*)                                          AS inns,
             SUM(runs)::BIGINT                                 AS runs,
             ROUND(SUM(runs)*1.0 /NULLIF(SUM(dismissed),0),2)  AS avg,
             ROUND(SUM(runs)*100.0/NULLIF(SUM(balls),0),2)     AS sr,
             SUM(dismissed)::BIGINT                            AS dis,
             SUM(balls)::BIGINT                                AS balls
      FROM s {w}""").fetchone()

print("=== S1 — SA Yadav, NO filter (ANCHOR 60 / 1544 / 29.13 / 150.34) ===")
inns, runs, avg, sr, dis, balls = agg()
print(f"    RAW-derived: inns={inns} runs={runs} avg={avg} sr={sr}  (dis={dis} balls={balls})")
check("S1 inns",  inns, 60)
check("S1 runs",  runs, 1544)
check("S1 avg",   avg, 29.13, ratio=True)
check("S1 SR",    sr, 150.34, ratio=True)
# drift cross-check vs the app's pre-aggregated batting_innings (must equal RAW):
b = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, ROUND(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), "
                f"ROUND(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VS} AND batter_id='{SKY}'").fetchone()
check("S1 RAW==preagg inns", inns, b[0]); check("S1 RAW==preagg runs", runs, b[1])
check("S1 RAW==preagg avg", avg, b[2], ratio=True); check("S1 RAW==preagg SR", sr, b[3], ratio=True)

print("\n=== S2 — SA Yadav, only innings where Innings Score (his own runs) >= 100 ===")
inns, runs, avg, sr, dis, balls = agg("runs >= 100")
print(f"    RAW-derived: inns={inns} runs={runs} avg={avg} sr={sr}  (dis={dis} balls={balls})")
# cross-check vs pre-agg batting_innings (per-innings runs>=100):
b2 = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, ROUND(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), "
                 f"ROUND(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VS} AND batter_id='{SKY}' AND runs>=100").fetchone()
print(f"    preagg cross : inns={b2[0]} runs={b2[1]} avg={b2[2]} sr={b2[3]}")
check("S2 RAW==preagg inns", inns, b2[0]); check("S2 RAW==preagg runs", runs, b2[1])
check("S2 RAW==preagg avg", avg, b2[2], ratio=True); check("S2 RAW==preagg SR", sr, b2[3], ratio=True)

print("\n=== S3 — SA Yadav, only NOT OUT innings (dismissed = 0) ===")
inns, runs, avg, sr, dis, balls = agg("dismissed = 0")
print(f"    RAW-derived: inns={inns} runs={runs} avg={avg} sr={sr}  (dis={dis} balls={balls})")
check("S3 dismissals in not-out set == 0", dis, 0)
if avg is not None:
    warns.append(f"S3 avg should be NULL (0 dismissals ⇒ div-by-zero ⇒ NULL) but got {avg}")
    print(f"    NOTE: avg={avg} — expected NULL under §4.1 div-by-zero rule")
else:
    print("    avg = NULL (correct: 0 dismissals ⇒ div-by-zero ⇒ NULL per §4.1)")
b3 = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, ROUND(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) "
                 f"FROM {B} WHERE {VS} AND batter_id='{SKY}' AND dismissed=0").fetchone()
print(f"    preagg cross : inns={b3[0]} runs={b3[1]} sr={b3[2]}")
check("S3 RAW==preagg inns", inns, b3[0]); check("S3 RAW==preagg runs", runs, b3[1])
check("S3 RAW==preagg SR", sr, b3[2], ratio=True)

print("\n=== S4 — SA Yadav vs Opposition = Australia ===")
inns, runs, avg, sr, dis, balls = agg("opp = 'Australia'")
print(f"    RAW-derived: inns={inns} runs={runs} avg={avg} sr={sr}  (dis={dis} balls={balls})")
b4 = con.execute(f"SELECT COUNT(*), SUM(runs)::BIGINT, ROUND(SUM(runs)*1.0/NULLIF(SUM(dismissed),0),2), "
                 f"ROUND(SUM(runs)*100.0/NULLIF(SUM(balls_faced),0),2) FROM {B} WHERE {VS} AND batter_id='{SKY}' AND bowling_team='Australia'").fetchone()
print(f"    preagg cross : inns={b4[0]} runs={b4[1]} avg={b4[2]} sr={b4[3]}")
check("S4 RAW==preagg inns", inns, b4[0]); check("S4 RAW==preagg runs", runs, b4[1])
check("S4 RAW==preagg avg", avg, b4[2], ratio=True); check("S4 RAW==preagg SR", sr, b4[3], ratio=True)

print("\n=== S5 — SA Yadav vs SPIN (matchup) (ANCHOR 38 / 454 / SR 140.99) ===")
# INDEPENDENT: raw deliveries JOIN profiles on the bowler's style; Spin = bowling_group='Spin'.
s5 = con.execute(f"""
  SELECT COUNT(DISTINCT (d.match_id,d.innings_number))          AS inns,
         SUM(d.runs_batter)::BIGINT                             AS runs,
         SUM(CASE WHEN d.wides IS NULL THEN 1 ELSE 0 END)::BIGINT AS balls
  FROM {D} d JOIN {PROF} p ON d.bowler_id = p.player_id
  WHERE {RS} AND d.batter_id='{SKY}' AND p.bowling_group='Spin'
""").fetchone()
sr5 = r2(s5[1]*100.0/s5[2]) if s5[2] else None
print(f"    RAW+profiles: inns={s5[0]} runs={s5[1]} balls={s5[2]} sr={sr5}")
check("S5 inns", s5[0], 38)
check("S5 runs", s5[1], 454)
check("S5 SR",   sr5, 140.99, ratio=True)
# drift cross-check vs the app's matchup_batting pre-agg (bowling_group='Spin'):
m = con.execute(f"SELECT COUNT(DISTINCT (match_id,innings_number)), SUM(runs)::BIGINT, SUM(balls_faced)::BIGINT "
                f"FROM {MBAT} WHERE {VS} AND batter_id='{SKY}' AND bowling_group='Spin'").fetchone()
srm = r2(m[1]*100.0/m[2]) if m[2] else None
print(f"    preagg cross : inns={m[0]} runs={m[1]} balls={m[2]} sr={srm}")
check("S5 RAW==preagg inns", s5[0], m[0]); check("S5 RAW==preagg runs", s5[1], m[1])
check("S5 RAW==preagg balls", s5[2], m[2]); check("S5 RAW==preagg SR", sr5, srm, ratio=True)

print("\n=== S6 — JC Buttler fielding (ANCHOR catches 33 / stumpings 10 / run-outs 11 / total 54) ===")
# Independent raw fielding_events tally. §-fielding record: exclude substitute fielders.
def fld(kinds, sub_excl=True):
    s = " AND substitute IS NOT TRUE" if sub_excl else ""
    return one(f"SELECT COUNT(*) FROM {F} WHERE {VS} AND fielder_id='{BUT}'{s} AND kind IN ({kinds})")
# full kind breakdown (transparency)
print("    Buttler kind breakdown (substitute excluded):")
for k, c in con.execute(f"SELECT kind, COUNT(*) FROM {F} WHERE {VS} AND fielder_id='{BUT}' AND substitute IS NOT TRUE GROUP BY 1 ORDER BY 2 DESC").fetchall():
    print(f"      {k:22s} {c}")
sub_rows = one(f"SELECT COUNT(*) FROM {F} WHERE {VS} AND fielder_id='{BUT}' AND substitute IS TRUE")
print(f"      (substitute rows for Buttler: {sub_rows})")
catches   = fld("'caught','caught and bowled'")   # catches fold c&b in (R2d-confirmed defn)
stumpings = fld("'stumped'")
runouts   = fld("'run out'")
total     = catches + stumpings + runouts
print(f"    catches={catches}  stumpings={stumpings}  run-outs={runouts}  total={total}")
check("S6 catches",   catches, 33)
check("S6 stumpings", stumpings, 10)
check("S6 run-outs",  runouts, 11)
check("S6 total",     total, 54)

print("\n" + ("ALL PASS — no drift; anchors reproduced independently" if not fails
             else "FAILURES:\n   " + "\n   ".join(fails)))
if warns:
    print("WARNINGS:\n   " + "\n   ".join(warns))
sys.exit(1 if fails else 0)
