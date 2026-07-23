#!/usr/bin/env python3
"""
dev_test_phase_components.py — DISPOSABLE dev test for backlog #3.

Proves the phase-component column additions to export_parquet.py's four builders
are PURELY ADDITIVE and correct, against the local DB (data/cricket.duckdb):

  (a) BYTE-IDENTICAL existing columns: build each of the 4 parquets from the
      pre-change baseline (git show <BASELINE_REF>:export_parquet.py) AND from the
      current working-tree builder, then DuckDB EXCEPT both directions on the
      shared (pre-existing) columns -> 0 rows both ways, and equal row counts.
  (b) INDEPENDENT new-column check: for sampled (match,inn,player) rows, recompute
      the new columns (dots/fours/sixes/dismissals per phase) straight from
      deliveries/wickets with a DIFFERENT query shape than the builder (over-range
      filter-counts; for the Hundred, a correlated-subquery legal-ball ordinal),
      and match. NEVER reuses the builder's own aggregation shape (CLAUDE.md rule).
  (c) INVARIANTS / RESIDUALS: phase-sum <= overall (all rows) and == overall
      (T20/IT20); odi_* NULL iff Hundred; matchup_batting phase dismissals ==
      dismissals; batting all-kinds phase dismissals vs `dismissed` flag with the
      residual number PRINTED explicitly.

Run:
  python pipeline/dev_test_phase_components.py [--db data/cricket.duckdb]
                                               [--baseline-ref bb12c9d]
Exit code 0 = all checks passed; 1 = a check failed.
"""

import argparse
import os
import subprocess
import sys
import tempfile
import importlib.util

import duckdb

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Pre-change baseline commit (HEAD of polish-b1-mechanical before backlog #3).
DEFAULT_BASELINE_REF = "bb12c9d"

NON_DIS = "('retired hurt', 'retired not out')"
CREDITED = "('bowled','lbw','caught','caught and bowled','stumped','hit wicket')"

BUILDERS = ["sql_batting", "sql_bowling", "sql_matchup_batting", "sql_matchup_bowling"]
PARQUET = {
    "sql_batting": "batting_innings.parquet",
    "sql_bowling": "bowling_innings.parquet",
    "sql_matchup_batting": "matchup_batting.parquet",
    "sql_matchup_bowling": "matchup_bowling.parquet",
}

_fails = []
_passes = 0


def check(cond, label, detail=""):
    global _passes
    if cond:
        _passes += 1
        print(f"  PASS  {label}")
    else:
        _fails.append(f"{label} :: {detail}")
        print(f"  FAIL  {label} :: {detail}")


def load_mod(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(REPO_ROOT, "data", "cricket.duckdb"))
    ap.add_argument("--baseline-ref", default=DEFAULT_BASELINE_REF)
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="dev_b3_")
    print(f"[setup] tmp dir: {tmp}")
    print(f"[setup] db: {args.db}")
    print(f"[setup] baseline ref: {args.baseline_ref}")

    # --- load baseline + branch builder modules ---
    base_src = subprocess.run(
        ["git", "show", f"{args.baseline_ref}:export_parquet.py"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    ).stdout
    base_path = os.path.join(tmp, "export_baseline.py")
    with open(base_path, "w") as fh:
        fh.write(base_src)
    base_mod = load_mod(base_path, "export_baseline")
    br_mod = load_mod(os.path.join(REPO_ROOT, "export_parquet.py"), "export_branch")

    con = duckdb.connect(args.db, read_only=True)
    scalar = lambda s: con.execute(s).fetchone()[0]

    # Build the 4 BRANCH parquets once (the real artifacts).
    for b in BUILDERS:
        out = os.path.join(tmp, PARQUET[b])
        print(f"[build] {PARQUET[b]} (branch) ...")
        br_mod.write_parquet(con, getattr(br_mod, b)(), out)

    hundred_ids = "SELECT match_id FROM matches WHERE balls_per_over = 5"

    # =====================================================================
    # (a) BYTE-IDENTICAL existing columns (baseline SQL vs branch parquet)
    # =====================================================================
    print("\n=== (a) byte-identical pre-existing columns ===")
    for b in BUILDERS:
        base_sql = getattr(base_mod, b)()
        br_parq = os.path.join(tmp, PARQUET[b]).replace("'", "''")
        # shared columns = the baseline's output columns (branch is a superset).
        desc = con.execute(f"SELECT * FROM ({base_sql}) LIMIT 0").description
        base_cols = [d[0] for d in desc]
        br_cols = [d[0] for d in con.execute(
            f"SELECT * FROM read_parquet('{br_parq}') LIMIT 0").description]
        missing = [c for c in base_cols if c not in br_cols]
        check(not missing, f"[{PARQUET[b]}] branch keeps every baseline column",
              f"missing: {missing}")
        added = [c for c in br_cols if c not in base_cols]
        print(f"        {PARQUET[b]}: +{len(added)} new columns")

        cols = ", ".join(base_cols)
        base_rows = scalar(f"SELECT COUNT(*) FROM ({base_sql}) t")
        br_rows = scalar(f"SELECT COUNT(*) FROM read_parquet('{br_parq}')")
        check(base_rows == br_rows, f"[{PARQUET[b]}] row count unchanged",
              f"baseline {base_rows} vs branch {br_rows}")

        d1 = scalar(
            f"SELECT COUNT(*) FROM (SELECT {cols} FROM ({base_sql}) t "
            f"EXCEPT SELECT {cols} FROM read_parquet('{br_parq}'))")
        d2 = scalar(
            f"SELECT COUNT(*) FROM (SELECT {cols} FROM read_parquet('{br_parq}') "
            f"EXCEPT SELECT {cols} FROM ({base_sql}) t)")
        check(d1 == 0 and d2 == 0,
              f"[{PARQUET[b]}] shared columns byte-identical (EXCEPT both ways)",
              f"baseline-only={d1}, branch-only={d2}")

    bat_p = os.path.join(tmp, "batting_innings.parquet").replace("'", "''")
    bowl_p = os.path.join(tmp, "bowling_innings.parquet").replace("'", "''")
    mbat_p = os.path.join(tmp, "matchup_batting.parquet").replace("'", "''")
    mbowl_p = os.path.join(tmp, "matchup_bowling.parquet").replace("'", "''")

    # =====================================================================
    # (b) INDEPENDENT new-column recompute (different query shape)
    # =====================================================================
    print("\n=== (b) independent new-column recompute ===")

    # kept-delivery / kept-wicket context, re-derived from scratch (NOT the builder).
    KEPT = """
    WITH ki AS (SELECT match_id, innings_number FROM innings WHERE super_over IS NOT TRUE)
    """

    def indep_bat_over(mid, inn, bid, lo, hi):
        """(dots, fours, sixes) for a batter over an over_number range [lo,hi]."""
        mid_e = mid.replace("'", "''")
        return con.execute(KEPT + f"""
          SELECT
            COUNT(*) FILTER (WHERE dv.wides IS NULL AND dv.runs_batter = 0),
            COUNT(*) FILTER (WHERE dv.runs_batter = 4 AND dv.is_not_boundary IS NOT TRUE),
            COUNT(*) FILTER (WHERE dv.runs_batter = 6 AND dv.is_not_boundary IS NOT TRUE)
          FROM deliveries dv JOIN ki ON dv.match_id=ki.match_id AND dv.innings_number=ki.innings_number
          WHERE dv.match_id='{mid_e}' AND dv.innings_number={inn} AND dv.batter_id='{bid}'
            AND dv.over_number BETWEEN {lo} AND {hi}
        """).fetchone()

    def indep_bat_dis_over(mid, inn, pid, lo, hi, kinds):
        mid_e = mid.replace("'", "''")
        return con.execute(KEPT + f"""
          SELECT COUNT(*)
          FROM wickets w JOIN ki ON w.match_id=ki.match_id AND w.innings_number=ki.innings_number
          WHERE w.match_id='{mid_e}' AND w.innings_number={inn} AND w.player_out_id='{pid}'
            AND w.kind {kinds} AND w.over_number BETWEEN {lo} AND {hi}
        """).fetchone()[0]

    def indep_bowl_over(mid, inn, bid, lo, hi):
        """(dots, fours_conceded, sixes_conceded) for a bowler over [lo,hi]."""
        mid_e = mid.replace("'", "''")
        return con.execute(KEPT + f"""
          SELECT
            COUNT(*) FILTER (WHERE dv.wides IS NULL AND dv.noballs IS NULL AND dv.runs_batter = 0),
            COUNT(*) FILTER (WHERE dv.runs_batter = 4 AND dv.is_not_boundary IS NOT TRUE),
            COUNT(*) FILTER (WHERE dv.runs_batter = 6 AND dv.is_not_boundary IS NOT TRUE)
          FROM deliveries dv JOIN ki ON dv.match_id=ki.match_id AND dv.innings_number=ki.innings_number
          WHERE dv.match_id='{mid_e}' AND dv.innings_number={inn} AND dv.bowler_id='{bid}'
            AND dv.over_number BETWEEN {lo} AND {hi}
        """).fetchone()

    # --- batting: T20 non-Hundred (over-based pp=0-5, death=15-19) ---
    rows = con.execute(f"""
        SELECT match_id, innings_number, batter_id,
               pp_dots, pp_fours, pp_sixes, pp_dismissals,
               death_dots, death_fours, death_sixes, death_dismissals
        FROM read_parquet('{bat_p}')
        WHERE match_type IN ('T20','IT20') AND match_id NOT IN ({hundred_ids})
          AND (pp_balls > 0 OR death_balls > 0) AND balls_faced >= 8
        ORDER BY pp_dots DESC, match_id, innings_number, batter_id
        LIMIT 20
    """).fetchall()
    ok = True
    for (mid, inn, bid, pd, pf, ps, pdis, dd, df, ds, ddis) in rows:
        exp_pp = indep_bat_over(mid, inn, bid, 0, 5)
        exp_de = indep_bat_over(mid, inn, bid, 15, 19)
        exp_pdis = indep_bat_dis_over(mid, inn, bid, 0, 5, f"NOT IN {NON_DIS}")
        exp_ddis = indep_bat_dis_over(mid, inn, bid, 15, 19, f"NOT IN {NON_DIS}")
        if (pd, pf, ps) != exp_pp or (dd, df, ds) != exp_de \
                or pdis != exp_pdis or ddis != exp_ddis:
            ok = False
            print(f"        MISMATCH bat T20 {mid}/{inn}/{bid}: "
                  f"builder pp={(pd,pf,ps,pdis)} indep={exp_pp+(exp_pdis,)}; "
                  f"builder death={(dd,df,ds,ddis)} indep={exp_de+(exp_ddis,)}")
    check(ok and len(rows) > 0, f"batting T20 non-Hundred pp/death components (n={len(rows)})")

    # --- batting: ODI (odi_pp=0-9, odi_death=40-49) ---
    rows = con.execute(f"""
        SELECT match_id, innings_number, batter_id,
               odi_pp_dots, odi_pp_fours, odi_pp_sixes, odi_pp_dismissals,
               odi_death_dots, odi_death_fours, odi_death_sixes, odi_death_dismissals
        FROM read_parquet('{bat_p}')
        WHERE match_type IN ('ODI','ODM') AND (odi_pp_balls > 0 OR odi_death_balls > 0)
        ORDER BY odi_pp_dots DESC, match_id, innings_number, batter_id
        LIMIT 15
    """).fetchall()
    ok = True
    for (mid, inn, bid, pd, pf, ps, pdis, dd, df, ds, ddis) in rows:
        exp_pp = indep_bat_over(mid, inn, bid, 0, 9)
        exp_de = indep_bat_over(mid, inn, bid, 40, 49)
        exp_pdis = indep_bat_dis_over(mid, inn, bid, 0, 9, f"NOT IN {NON_DIS}")
        exp_ddis = indep_bat_dis_over(mid, inn, bid, 40, 49, f"NOT IN {NON_DIS}")
        if (pd, pf, ps) != exp_pp or (dd, df, ds) != exp_de \
                or pdis != exp_pdis or ddis != exp_ddis:
            ok = False
            print(f"        MISMATCH bat ODI {mid}/{inn}/{bid}: "
                  f"builder odi_pp={(pd,pf,ps,pdis)} indep={exp_pp+(exp_pdis,)}; "
                  f"builder odi_death={(dd,df,ds,ddis)} indep={exp_de+(exp_ddis,)}")
    check(ok and len(rows) > 0, f"batting ODI odi_pp/odi_death components (n={len(rows)})")

    # --- batting: Hundred (odi_* must be NULL; pp_dots via correlated legal-ordinal) ---
    rows = con.execute(f"""
        SELECT match_id, innings_number, batter_id, pp_dots,
               odi_pp_dots, odi_mid_dots, odi_death_dots, odi_pp_dismissals
        FROM read_parquet('{bat_p}')
        WHERE match_id IN ({hundred_ids}) AND balls_faced >= 5
        ORDER BY pp_dots DESC LIMIT 6
    """).fetchall()
    ok = True
    for (mid, inn, bid, pd, o_ppd, o_midd, o_dd, o_pdis) in rows:
        if not (o_ppd is None and o_midd is None and o_dd is None and o_pdis is None):
            ok = False
            print(f"        MISMATCH Hundred odi_* not NULL {mid}/{inn}/{bid}")
        mid_e = mid.replace("'", "''")
        # legal_ordinal via CORRELATED subquery (different shape than the builder's
        # window function): legal balls strictly before + 1, in pp window 1..25.
        exp_pd = con.execute(KEPT + f"""
          SELECT COUNT(*) FROM deliveries x
          JOIN ki ON x.match_id=ki.match_id AND x.innings_number=ki.innings_number
          WHERE x.match_id='{mid_e}' AND x.innings_number={inn} AND x.batter_id='{bid}'
            AND x.wides IS NULL AND x.runs_batter = 0
            AND ((SELECT COUNT(*) FROM deliveries y
                  WHERE y.match_id=x.match_id AND y.innings_number=x.innings_number
                    AND y.wides IS NULL AND y.noballs IS NULL
                    AND (y.over_number < x.over_number
                         OR (y.over_number = x.over_number AND y.ball_index < x.ball_index)))
                 + 1) BETWEEN 1 AND 25
        """).fetchone()[0]
        if pd != exp_pd:
            ok = False
            print(f"        MISMATCH Hundred pp_dots {mid}/{inn}/{bid}: builder={pd} indep={exp_pd}")
    check(ok and len(rows) > 0, f"batting Hundred odi_* NULL + pp_dots via legal-ordinal (n={len(rows)})")

    # --- bowling: T20 non-Hundred pp components ---
    rows = con.execute(f"""
        SELECT match_id, innings_number, bowler_id,
               pp_dots, pp_fours_conceded, pp_sixes_conceded
        FROM read_parquet('{bowl_p}')
        WHERE match_type IN ('T20','IT20') AND match_id NOT IN ({hundred_ids}) AND pp_balls > 0
        ORDER BY pp_dots DESC, match_id, innings_number, bowler_id
        LIMIT 15
    """).fetchall()
    ok = True
    for (mid, inn, bid, pd, pf, ps) in rows:
        exp = indep_bowl_over(mid, inn, bid, 0, 5)
        if (pd, pf, ps) != exp:
            ok = False
            print(f"        MISMATCH bowl T20 {mid}/{inn}/{bid}: builder={(pd,pf,ps)} indep={exp}")
    check(ok and len(rows) > 0, f"bowling T20 non-Hundred pp components (n={len(rows)})")

    # --- matchup_batting: T20 pp_dismissals (credited kinds only, over 0-5) ---
    rows = con.execute(f"""
        SELECT match_id, innings_number, batter_id, pp_dots, pp_dismissals
        FROM read_parquet('{mbat_p}')
        WHERE match_type IN ('T20','IT20') AND match_id NOT IN ({hundred_ids})
          AND pp_dismissals > 0
        ORDER BY match_id, innings_number, batter_id LIMIT 15
    """).fetchall()
    ok = True
    for (mid, inn, bid, pdots, pdis) in rows:
        # credited dismissals of THIS striker in over 0-5 (independent shape).
        exp_dis = indep_bat_dis_over(mid, inn, bid, 0, 5, f"IN {CREDITED}")
        if pdis != exp_dis:
            ok = False
            print(f"        MISMATCH mbat pp_dismissals {mid}/{inn}/{bid}: builder={pdis} indep={exp_dis}")
    check(ok and len(rows) > 0, f"matchup_batting T20 pp_dismissals credited-only (n={len(rows)})")

    # --- matchup_bowling: T20 pp_dots ---
    rows = con.execute(f"""
        SELECT match_id, innings_number, bowler_id, pp_dots
        FROM read_parquet('{mbowl_p}')
        WHERE match_type IN ('T20','IT20') AND match_id NOT IN ({hundred_ids}) AND pp_balls > 0
        ORDER BY pp_dots DESC, match_id, innings_number, bowler_id LIMIT 10
    """).fetchall()
    # matchup_bowling is split by (batting_hand, batting_position); a bowler's pp_dots
    # in one row is a SUBSET of the bowler's total pp legal 0-run balls. Verify the
    # bowler-level ROLLUP equals the independent over-0-5 count instead (row grain differs).
    ok = True
    seen = set()
    for (mid, inn, bid, _pd) in rows:
        if (mid, inn, bid) in seen:
            continue
        seen.add((mid, inn, bid))
        roll = con.execute(f"""
            SELECT COALESCE(SUM(pp_dots),0) FROM read_parquet('{mbowl_p}')
            WHERE match_id=? AND innings_number=? AND bowler_id=?
        """, [mid, inn, bid]).fetchone()[0]
        exp = indep_bowl_over(mid, inn, bid, 0, 5)[0]
        if roll != exp:
            ok = False
            print(f"        MISMATCH mbowl pp_dots rollup {mid}/{inn}/{bid}: builder={roll} indep={exp}")
    check(ok and len(seen) > 0, f"matchup_bowling T20 pp_dots (bowler rollup) (n={len(seen)})")

    # =====================================================================
    # (c) INVARIANTS / RESIDUALS
    # =====================================================================
    print("\n=== (c) invariants / residuals ===")

    def phase_le_eq(p, fname, triples):
        le = " OR ".join(f"({pp}+{mid}+{de} > {ov})" for pp, mid, de, ov in triples)
        bad_le = scalar(f"SELECT COUNT(*) FROM read_parquet('{p}') WHERE {le}")
        check(bad_le == 0, f"[{fname}] phase dots/fours/sixes <= overall (all rows)", f"{bad_le} rows")
        eq = " OR ".join(f"({pp}+{mid}+{de} != {ov})" for pp, mid, de, ov in triples)
        bad_eq = scalar(f"SELECT COUNT(*) FROM read_parquet('{p}') WHERE match_type IN ('T20','IT20') AND ({eq})")
        check(bad_eq == 0, f"[{fname}] T20/IT20 phase dots/fours/sixes == overall (per row)", f"{bad_eq} rows")

    bat_tr = [("pp_dots", "mid_dots", "death_dots", "dots"),
              ("pp_fours", "mid_fours", "death_fours", "fours_hit"),
              ("pp_sixes", "mid_sixes", "death_sixes", "sixes_hit")]
    bowl_tr = [("pp_dots", "mid_dots", "death_dots", "dots"),
               ("pp_fours_conceded", "mid_fours_conceded", "death_fours_conceded", "fours_conceded"),
               ("pp_sixes_conceded", "mid_sixes_conceded", "death_sixes_conceded", "sixes_conceded")]
    phase_le_eq(bat_p, "batting_innings", bat_tr)
    phase_le_eq(bowl_p, "bowling_innings", bowl_tr)
    phase_le_eq(mbat_p, "matchup_batting", bat_tr)
    phase_le_eq(mbowl_p, "matchup_bowling", bowl_tr)

    # odi_* NULL iff Hundred
    bat_odi = ["odi_pp_dots", "odi_pp_fours", "odi_pp_sixes", "odi_pp_dismissals",
               "odi_mid_dots", "odi_mid_fours", "odi_mid_sixes", "odi_mid_dismissals",
               "odi_death_dots", "odi_death_fours", "odi_death_sixes", "odi_death_dismissals"]
    bowl_odi = ["odi_pp_dots", "odi_pp_fours_conceded", "odi_pp_sixes_conceded",
                "odi_mid_dots", "odi_mid_fours_conceded", "odi_mid_sixes_conceded",
                "odi_death_dots", "odi_death_fours_conceded", "odi_death_sixes_conceded"]

    def odi_null_iff(p, fname, cols):
        nn = " OR ".join(f"{c} IS NOT NULL" for c in cols)
        bad_h = scalar(f"SELECT COUNT(*) FROM read_parquet('{p}') WHERE match_id IN ({hundred_ids}) AND ({nn})")
        check(bad_h == 0, f"[{fname}] new odi_* NULL for Hundred", f"{bad_h} rows")
        nul = " OR ".join(f"{c} IS NULL" for c in cols)
        bad_nh = scalar(f"SELECT COUNT(*) FROM read_parquet('{p}') WHERE match_id NOT IN ({hundred_ids}) AND ({nul})")
        check(bad_nh == 0, f"[{fname}] new odi_* NOT NULL off Hundred", f"{bad_nh} rows")

    odi_null_iff(bat_p, "batting_innings", bat_odi)
    odi_null_iff(bowl_p, "bowling_innings", bowl_odi)
    odi_null_iff(mbat_p, "matchup_batting", bat_odi)
    odi_null_iff(mbowl_p, "matchup_bowling", bowl_odi)

    # matchup_batting phase dismissals == dismissals (exact)
    b1 = scalar(f"""SELECT COUNT(*) FROM read_parquet('{mbat_p}') WHERE match_type IN ('T20','IT20')
                    AND pp_dismissals+mid_dismissals+death_dismissals != dismissals""")
    check(b1 == 0, "[matchup_batting] T20/IT20 phase dismissals == dismissals (per row)", f"{b1} rows")
    b2 = scalar(f"""SELECT COUNT(*) FROM read_parquet('{mbat_p}') WHERE match_type IN ('ODI','ODM')
                    AND odi_pp_dismissals+odi_mid_dismissals+odi_death_dismissals != dismissals""")
    check(b2 == 0, "[matchup_batting] ODI/ODM phase dismissals == dismissals (per row)", f"{b2} rows")

    # ***** THE DISMISSAL RESIDUAL (batting all-kinds, phase vs dismissed flag) *****
    t20_dismissed = scalar(f"SELECT COALESCE(SUM(dismissed),0) FROM read_parquet('{bat_p}') WHERE match_type IN ('T20','IT20')")
    t20_phase_dis = scalar(f"SELECT COALESCE(SUM(pp_dismissals+mid_dismissals+death_dismissals),0) FROM read_parquet('{bat_p}') WHERE match_type IN ('T20','IT20')")
    odi_dismissed = scalar(f"SELECT COALESCE(SUM(dismissed),0) FROM read_parquet('{bat_p}') WHERE match_type IN ('ODI','ODM')")
    odi_phase_dis = scalar(f"SELECT COALESCE(SUM(odi_pp_dismissals+odi_mid_dismissals+odi_death_dismissals),0) FROM read_parquet('{bat_p}') WHERE match_type IN ('ODI','ODM')")
    print("\n  >>> DISMISSAL RESIDUAL (batting_innings, all-kinds) <<<")
    print(f"      T20/IT20: Sum(dismissed)={t20_dismissed}  Sum(pp+mid+death dismissals)={t20_phase_dis}  "
          f"shortfall={t20_dismissed - t20_phase_dis}")
    print(f"      ODI/ODM : Sum(dismissed)={odi_dismissed}  Sum(odi phase dismissals)={odi_phase_dis}  "
          f"shortfall={odi_dismissed - odi_phase_dis}")
    check(t20_phase_dis <= t20_dismissed, "batting T20 phase dismissals <= dismissed (global)",
          f"{t20_phase_dis} > {t20_dismissed}")
    check(odi_phase_dis <= odi_dismissed, "batting ODI phase dismissals <= dismissed (global)",
          f"{odi_phase_dis} > {odi_dismissed}")

    con.close()
    print(f"\n==== {_passes} passed, {len(_fails)} failed ====")
    if _fails:
        for f in _fails:
            print(f"  FAILED: {f}")
        sys.exit(1)
    print("ALL DEV-TEST CHECKS PASSED.")


if __name__ == "__main__":
    main()
