#!/usr/bin/env python3
"""
dev_test_matchup_extension.py — STEP 1/3 test harness for the D4-R3 matchup
extension (owner-mandated process: build + verify an alternate script FIRST,
only then patch export_parquet.py).

Adds, on top of the existing matchup_batting / matchup_bowling exports:

  matchup_batting: dis_bowled/lbw/caught/caught_and_bowled/stumped/hit_wicket
                   (six-way split of `dismissals`) + T20-range and ODI-range
                   phase runs/balls (pp_/mid_/death_ and odi_pp_/odi_mid_/odi_death_).
  matchup_bowling: wkt_bowled/lbw/caught/caught_and_bowled/stumped/hit_wicket
                   (six-way split of `wickets`) + T20-range and ODI-range phase
                   balls/runs_conceded/wickets trios.

Every rule is lifted from SPEC.md §4.1 and reuses export_parquet.py's own
expression helpers (build_delivery_cte, t20_phase_expr, ODI_PHASE_OVER,
t20_phase_expr_wba, odi_phase_wba, LEGAL_BOWLER, FACED_BATTER, HIT_BOUNDARY_4/6,
BOWLER_RUNS, _KINDS_IN) rather than re-deriving cricket rules from scratch.

SAFETY: the real Cricsheet DB (DB_files_scripts/cricket.duckdb) is ATTACHed
READ_ONLY to an in-memory DuckDB connection. DuckDB enforces the read-only
attach at the storage layer (any CREATE/DROP/INSERT against it raises), so it
is structurally impossible for this script to write to that file even by
accident. `player_profiles` -- which does not exist in the raw DB -- is built
in the writable in-memory catalog by running the REAL, unmodified
pipeline/build_profiles.py matching pipeline against the attached read-only
tables, so the profile join in the new SQL is tested against a faithful
profiles table, not a fabricated stand-in.

Usage:
    python pipeline/dev_test_matchup_extension.py
    python pipeline/dev_test_matchup_extension.py --patched   # STEP 3: use
        export_parquet.py's own (patched) sql_matchup_* functions instead of
        this file's dev copies, to prove the real script matches.
    python pipeline/dev_test_matchup_extension.py --scratch /custom/dir
"""

import argparse
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import duckdb

import export_parquet as ep
import build_profiles as bp

REAL_DB = "/Users/tarutr/Desktop/Cricket_DB/cricket.duckdb".replace(
    "cricket.duckdb", "DB_files_scripts/cricket.duckdb"
)
assert REAL_DB == "/Users/tarutr/Desktop/Cricket_DB/DB_files_scripts/cricket.duckdb"

DEFAULT_SCRATCH = os.path.join(_REPO, "scratchpad", "matchup_ext")

CHECKS_PASSED = []
CHECKS_FAILED = []


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def record(ok, name, detail=""):
    if ok:
        log(f"  PASS  {name}" + (f"  ({detail})" if detail else ""))
        CHECKS_PASSED.append(name)
    else:
        log(f"  FAIL  {name}  :: {detail}")
        CHECKS_FAILED.append((name, detail))


# --------------------------------------------------------------------------- #
# Connection setup: read-only real DB attached, player_profiles built for-real
# in the writable in-memory catalog via the unmodified build_profiles.py logic.
# --------------------------------------------------------------------------- #

def make_connection():
    con = duckdb.connect(":memory:")
    con.execute(f"ATTACH '{REAL_DB}' AS srcdb (READ_ONLY)")
    # 'memory' first => unqualified CREATE targets the writable in-memory
    # catalog; unqualified SELECT falls through to srcdb for the 16 raw tables.
    con.execute("SET search_path='memory,srcdb'")
    con.create_function("norm_alnum", bp.norm_alnum, ["VARCHAR"], "VARCHAR")
    con.create_function("team_contains", bp.team_contains,
                         ["VARCHAR", "VARCHAR[]"], "BOOLEAN")
    con.create_function("country_in_intl_teams", bp.country_in_intl_teams,
                         ["VARCHAR[]", "VARCHAR"], "BOOLEAN")
    return con


def build_player_profiles(con):
    """Mirrors build_profiles.main()'s pipeline body exactly (no argparse / no
    --db existence checks), against `con` (real tables via srcdb, output table
    written to the in-memory catalog). Never opens the real DB writably."""
    bp.run_sanity_gate(con)

    csv_path = os.path.join(_REPO, "source_data", "cricinfo_player_profiles.csv")
    bp.load_sheet(con, csv_path)
    held_ids = bp.load_held_ids(con)
    bp.ensure_manual_file()

    m_matches, m_no_match, m_no_profile = bp.load_manual()
    manual_src = {"matches": m_matches, "no_match": m_no_match, "no_profile": m_no_profile}
    reviewed_src = bp.load_resolution_file(bp.REVIEWED_CSV, "new_players_reviewed.csv")
    ambiguous_src = bp.load_resolution_file(bp.AMBIGUOUS_CSV, "ambiguous_matches.csv")
    matches, no_match_pairs, no_profile = bp.merge_override_sources([
        ("manual_matches.csv", manual_src),
        ("new_players_reviewed.csv", reviewed_src),
        ("ambiguous_matches.csv", ambiguous_src),
    ])

    bp.build_universe(con)
    bp.build_auto_tiers(con, held_ids)
    bp.combine(con, matches, no_match_pairs, no_profile)
    n_rows = bp.build_profiles_table(con)
    log(f"player_profiles built (real matching pipeline): {n_rows:,} rows")
    return n_rows


# --------------------------------------------------------------------------- #
# EXTENDED sql_matchup_batting / sql_matchup_bowling (dev copies for STEP 1).
# Reuse export_parquet.py's own helpers throughout -- no cricket rule is
# re-derived here.
# --------------------------------------------------------------------------- #

def sql_matchup_batting_dev():
    cte = ep.build_delivery_cte(hundred_only=None)
    KINDS_IN = ep._KINDS_IN
    FACED_BATTER = ep.FACED_BATTER
    HIT_BOUNDARY_4 = ep.HIT_BOUNDARY_4
    HIT_BOUNDARY_6 = ep.HIT_BOUNDARY_6
    t20_phase = ep.t20_phase_expr()
    odi_phase = ep.ODI_PHASE_OVER
    return f"""
    WITH {cte},
    kept_wickets AS (
        SELECT w.match_id, w.innings_number, w.over_number, w.ball_index, w.kind
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
        WHERE w.kind IN ({KINDS_IN})
    ),
    cwkt AS (
        SELECT d.match_id, d.innings_number, d.over_number, d.ball_index,
               d.batter_id, d.bowler_id, COUNT(*) AS wkts
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        GROUP BY d.match_id, d.innings_number, d.over_number, d.ball_index,
                 d.batter_id, d.bowler_id
    ),
    -- Dismissal-kind split, keyed identically to mb's bowling_type so the join
    -- back is exact (same COALESCE expression, same pp alias, same join key).
    dis_kind AS (
        SELECT d.match_id, d.innings_number, d.batter_id,
               COALESCE(pp.bowling_type, pp.bowling_group, '(unmapped)') AS bowling_type,
               SUM(CASE WHEN kw.kind = 'bowled'            THEN 1 ELSE 0 END) AS dis_bowled,
               SUM(CASE WHEN kw.kind = 'lbw'               THEN 1 ELSE 0 END) AS dis_lbw,
               SUM(CASE WHEN kw.kind = 'caught'            THEN 1 ELSE 0 END) AS dis_caught,
               SUM(CASE WHEN kw.kind = 'caught and bowled' THEN 1 ELSE 0 END) AS dis_caught_and_bowled,
               SUM(CASE WHEN kw.kind = 'stumped'           THEN 1 ELSE 0 END) AS dis_stumped,
               SUM(CASE WHEN kw.kind = 'hit wicket'        THEN 1 ELSE 0 END) AS dis_hit_wicket
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        LEFT JOIN player_profiles pp ON d.bowler_id = pp.player_id
        GROUP BY d.match_id, d.innings_number, d.batter_id,
                 COALESCE(pp.bowling_type, pp.bowling_group, '(unmapped)')
    ),
    mb AS (
        SELECT
            d.match_id, d.innings_number, d.batter_id,
            COALESCE(pp.bowling_type, pp.bowling_group, '(unmapped)') AS bowling_type,
            COALESCE(pp.bowling_group, '(unmapped)')                  AS bowling_group,
            ANY_VALUE(d.batter) AS batter_name,
            ANY_VALUE(d.batting_team) AS batting_team,
            ANY_VALUE(CASE WHEN d.team_1 = d.batting_team THEN d.team_2 ELSE d.team_1 END) AS bowling_team,
            ANY_VALUE(d.match_type) AS match_type,
            ANY_VALUE(d.gender) AS gender,
            ANY_VALUE(d.team_type) AS team_type,
            ANY_VALUE(d.match_date) AS match_date,
            ANY_VALUE(d.year) AS year,
            ANY_VALUE(d.month) AS month,
            SUM(d.runs_batter) AS runs,
            SUM(CASE WHEN {FACED_BATTER} THEN 1 ELSE 0 END) AS balls_faced,
            SUM(CASE WHEN {FACED_BATTER} AND d.runs_batter = 0 THEN 1 ELSE 0 END) AS dots,
            SUM(CASE WHEN {HIT_BOUNDARY_4} THEN 1 ELSE 0 END) AS fours_hit,
            SUM(CASE WHEN {HIT_BOUNDARY_6} THEN 1 ELSE 0 END) AS sixes_hit,
            SUM(COALESCE(cwkt.wkts, 0)) AS dismissals,
            MAX(CASE WHEN d.balls_per_over = 5 THEN 1 ELSE 0 END) AS is_hundred,
            SUM(CASE WHEN {t20_phase} = 'pp'    THEN d.runs_batter ELSE 0 END) AS pp_runs,
            SUM(CASE WHEN {t20_phase} = 'pp'    AND {FACED_BATTER} THEN 1 ELSE 0 END) AS pp_balls,
            SUM(CASE WHEN {t20_phase} = 'mid'   THEN d.runs_batter ELSE 0 END) AS mid_runs,
            SUM(CASE WHEN {t20_phase} = 'mid'   AND {FACED_BATTER} THEN 1 ELSE 0 END) AS mid_balls,
            SUM(CASE WHEN {t20_phase} = 'death' THEN d.runs_batter ELSE 0 END) AS death_runs,
            SUM(CASE WHEN {t20_phase} = 'death' AND {FACED_BATTER} THEN 1 ELSE 0 END) AS death_balls,
            SUM(CASE WHEN ({odi_phase}) = 'pp'    THEN d.runs_batter ELSE 0 END) AS odi_pp_runs,
            SUM(CASE WHEN ({odi_phase}) = 'pp'    AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_pp_balls,
            SUM(CASE WHEN ({odi_phase}) = 'mid'   THEN d.runs_batter ELSE 0 END) AS odi_mid_runs,
            SUM(CASE WHEN ({odi_phase}) = 'mid'   AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_mid_balls,
            SUM(CASE WHEN ({odi_phase}) = 'death' THEN d.runs_batter ELSE 0 END) AS odi_death_runs,
            SUM(CASE WHEN ({odi_phase}) = 'death' AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_death_balls
        FROM d
        LEFT JOIN player_profiles pp ON d.bowler_id = pp.player_id
        LEFT JOIN cwkt
          ON d.match_id = cwkt.match_id AND d.innings_number = cwkt.innings_number
         AND d.over_number = cwkt.over_number AND d.ball_index = cwkt.ball_index
         AND d.batter_id = cwkt.batter_id AND d.bowler_id = cwkt.bowler_id
        WHERE d.batter_id IS NOT NULL
        GROUP BY d.match_id, d.innings_number, d.batter_id,
                 COALESCE(pp.bowling_type, pp.bowling_group, '(unmapped)'),
                 COALESCE(pp.bowling_group, '(unmapped)')
    )
    SELECT
        mb.match_id, mb.innings_number, mb.batter_id, mb.bowling_type, mb.bowling_group,
        mb.batter_name, mb.batting_team, mb.bowling_team, mb.match_type, mb.gender, mb.team_type,
        mb.match_date, mb.year, mb.month,
        mb.runs, mb.balls_faced, mb.dots, mb.fours_hit, mb.sixes_hit, mb.dismissals,
        COALESCE(dk.dis_bowled, 0)            AS dis_bowled,
        COALESCE(dk.dis_lbw, 0)               AS dis_lbw,
        COALESCE(dk.dis_caught, 0)            AS dis_caught,
        COALESCE(dk.dis_caught_and_bowled, 0) AS dis_caught_and_bowled,
        COALESCE(dk.dis_stumped, 0)           AS dis_stumped,
        COALESCE(dk.dis_hit_wicket, 0)        AS dis_hit_wicket,
        mb.pp_runs, mb.pp_balls, mb.mid_runs, mb.mid_balls, mb.death_runs, mb.death_balls,
        CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.odi_pp_runs    END AS odi_pp_runs,
        CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.odi_pp_balls   END AS odi_pp_balls,
        CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.odi_mid_runs   END AS odi_mid_runs,
        CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.odi_mid_balls  END AS odi_mid_balls,
        CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.odi_death_runs END AS odi_death_runs,
        CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.odi_death_balls END AS odi_death_balls
    FROM mb
    LEFT JOIN dis_kind dk
      ON mb.match_id = dk.match_id AND mb.innings_number = dk.innings_number
     AND mb.batter_id = dk.batter_id AND mb.bowling_type = dk.bowling_type
    ORDER BY mb.match_date, mb.match_id, mb.innings_number, mb.batter_id, mb.bowling_type
    """


def sql_matchup_bowling_dev():
    cte = ep.build_delivery_cte(hundred_only=None)
    KINDS_IN = ep._KINDS_IN
    LEGAL_BOWLER = ep.LEGAL_BOWLER
    HIT_BOUNDARY_4 = ep.HIT_BOUNDARY_4
    HIT_BOUNDARY_6 = ep.HIT_BOUNDARY_6
    BOWLER_RUNS = ep.BOWLER_RUNS
    t20_phase = ep.t20_phase_expr()
    odi_phase = ep.ODI_PHASE_OVER
    t20_wba = ep.t20_phase_expr_wba()
    odi_wba = ep.odi_phase_wba()
    return f"""
    WITH {cte},
    kept_wickets AS (
        SELECT w.match_id, w.innings_number, w.over_number, w.ball_index, w.kind
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
        WHERE w.kind IN ({KINDS_IN})
    ),
    cwkt AS (
        SELECT d.match_id, d.innings_number, d.over_number, d.ball_index,
               d.batter_id, d.bowler_id, COUNT(*) AS wkts
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        GROUP BY d.match_id, d.innings_number, d.over_number, d.ball_index,
                 d.batter_id, d.bowler_id
    ),
    -- Named wkt_by_ball (matching sql_bowling's CTE) so t20_phase_expr_wba() /
    -- odi_phase_wba() -- which hard-code the "wkt_by_ball." prefix -- apply
    -- unmodified. Extra dims here: batting_hand (dismissed batter's mapped
    -- style) and kind, so kind- and phase-wise splits share one CTE.
    wkt_by_ball AS (
        SELECT d.match_id, d.innings_number, d.bowler_id,
               COALESCE(pp.batting_style, '(unmapped)') AS batting_hand,
               d.over_number, d.balls_per_over, d.legal_ordinal,
               kw.kind,
               COUNT(*) AS wkts
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        LEFT JOIN player_profiles pp ON d.batter_id = pp.player_id
        GROUP BY d.match_id, d.innings_number, d.bowler_id,
                 COALESCE(pp.batting_style, '(unmapped)'),
                 d.over_number, d.balls_per_over, d.legal_ordinal, kw.kind
    ),
    wkt_agg AS (
        SELECT match_id, innings_number, bowler_id, batting_hand,
               SUM(wkts) AS wickets,
               SUM(CASE WHEN kind = 'bowled'            THEN wkts ELSE 0 END) AS wkt_bowled,
               SUM(CASE WHEN kind = 'lbw'               THEN wkts ELSE 0 END) AS wkt_lbw,
               SUM(CASE WHEN kind = 'caught'            THEN wkts ELSE 0 END) AS wkt_caught,
               SUM(CASE WHEN kind = 'caught and bowled' THEN wkts ELSE 0 END) AS wkt_caught_and_bowled,
               SUM(CASE WHEN kind = 'stumped'           THEN wkts ELSE 0 END) AS wkt_stumped,
               SUM(CASE WHEN kind = 'hit wicket'        THEN wkts ELSE 0 END) AS wkt_hit_wicket,
               SUM(CASE WHEN ({t20_wba}) = 'pp'    THEN wkts ELSE 0 END) AS pp_wickets,
               SUM(CASE WHEN ({t20_wba}) = 'mid'   THEN wkts ELSE 0 END) AS mid_wickets,
               SUM(CASE WHEN ({t20_wba}) = 'death' THEN wkts ELSE 0 END) AS death_wickets,
               SUM(CASE WHEN ({odi_wba}) = 'pp'    THEN wkts ELSE 0 END) AS odi_pp_wickets,
               SUM(CASE WHEN ({odi_wba}) = 'mid'   THEN wkts ELSE 0 END) AS odi_mid_wickets,
               SUM(CASE WHEN ({odi_wba}) = 'death' THEN wkts ELSE 0 END) AS odi_death_wickets
        FROM wkt_by_ball
        GROUP BY match_id, innings_number, bowler_id, batting_hand
    ),
    mbowl AS (
        SELECT
            d.match_id, d.innings_number, d.bowler_id,
            COALESCE(pp.batting_style, '(unmapped)') AS batting_hand,
            ANY_VALUE(d.bowler) AS bowler_name,
            ANY_VALUE(d.batting_team) AS batting_team,
            ANY_VALUE(CASE WHEN d.team_1 = d.batting_team THEN d.team_2 ELSE d.team_1 END) AS bowling_team,
            ANY_VALUE(d.match_type) AS match_type,
            ANY_VALUE(d.gender) AS gender,
            ANY_VALUE(d.team_type) AS team_type,
            ANY_VALUE(d.match_date) AS match_date,
            ANY_VALUE(d.year) AS year,
            ANY_VALUE(d.month) AS month,
            MAX(CASE WHEN d.balls_per_over = 5 THEN 1 ELSE 0 END) AS is_hundred,
            SUM(CASE WHEN {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS balls,
            SUM({BOWLER_RUNS}) AS runs_conceded,
            SUM(CASE WHEN {LEGAL_BOWLER} AND d.runs_batter = 0 THEN 1 ELSE 0 END) AS dots,
            SUM(CASE WHEN {HIT_BOUNDARY_4} THEN 1 ELSE 0 END) AS fours_conceded,
            SUM(CASE WHEN {HIT_BOUNDARY_6} THEN 1 ELSE 0 END) AS sixes_conceded,
            SUM(COALESCE(cwkt.wkts, 0)) AS wickets,
            SUM(CASE WHEN {t20_phase} = 'pp'    AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS pp_balls,
            SUM(CASE WHEN {t20_phase} = 'pp'    THEN {BOWLER_RUNS} ELSE 0 END) AS pp_runs_conceded,
            SUM(CASE WHEN {t20_phase} = 'mid'   AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS mid_balls,
            SUM(CASE WHEN {t20_phase} = 'mid'   THEN {BOWLER_RUNS} ELSE 0 END) AS mid_runs_conceded,
            SUM(CASE WHEN {t20_phase} = 'death' AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS death_balls,
            SUM(CASE WHEN {t20_phase} = 'death' THEN {BOWLER_RUNS} ELSE 0 END) AS death_runs_conceded,
            SUM(CASE WHEN ({odi_phase}) = 'pp'    AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_pp_balls,
            SUM(CASE WHEN ({odi_phase}) = 'pp'    THEN {BOWLER_RUNS} ELSE 0 END) AS odi_pp_runs_conceded,
            SUM(CASE WHEN ({odi_phase}) = 'mid'   AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_mid_balls,
            SUM(CASE WHEN ({odi_phase}) = 'mid'   THEN {BOWLER_RUNS} ELSE 0 END) AS odi_mid_runs_conceded,
            SUM(CASE WHEN ({odi_phase}) = 'death' AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_death_balls,
            SUM(CASE WHEN ({odi_phase}) = 'death' THEN {BOWLER_RUNS} ELSE 0 END) AS odi_death_runs_conceded
        FROM d
        LEFT JOIN player_profiles pp ON d.batter_id = pp.player_id
        LEFT JOIN cwkt
          ON d.match_id = cwkt.match_id AND d.innings_number = cwkt.innings_number
         AND d.over_number = cwkt.over_number AND d.ball_index = cwkt.ball_index
         AND d.batter_id = cwkt.batter_id AND d.bowler_id = cwkt.bowler_id
        WHERE d.bowler_id IS NOT NULL
        GROUP BY d.match_id, d.innings_number, d.bowler_id,
                 COALESCE(pp.batting_style, '(unmapped)')
    )
    SELECT
        mbowl.match_id, mbowl.innings_number, mbowl.bowler_id, mbowl.batting_hand,
        mbowl.bowler_name, mbowl.batting_team, mbowl.bowling_team, mbowl.match_type, mbowl.gender, mbowl.team_type,
        mbowl.match_date, mbowl.year, mbowl.month,
        mbowl.balls, mbowl.runs_conceded, mbowl.wickets, mbowl.dots, mbowl.fours_conceded, mbowl.sixes_conceded,
        COALESCE(wk.wkt_bowled, 0)            AS wkt_bowled,
        COALESCE(wk.wkt_lbw, 0)               AS wkt_lbw,
        COALESCE(wk.wkt_caught, 0)            AS wkt_caught,
        COALESCE(wk.wkt_caught_and_bowled, 0) AS wkt_caught_and_bowled,
        COALESCE(wk.wkt_stumped, 0)           AS wkt_stumped,
        COALESCE(wk.wkt_hit_wicket, 0)        AS wkt_hit_wicket,
        mbowl.pp_balls, mbowl.pp_runs_conceded, COALESCE(wk.pp_wickets,0) AS pp_wickets,
        mbowl.mid_balls, mbowl.mid_runs_conceded, COALESCE(wk.mid_wickets,0) AS mid_wickets,
        mbowl.death_balls, mbowl.death_runs_conceded, COALESCE(wk.death_wickets,0) AS death_wickets,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE mbowl.odi_pp_balls END AS odi_pp_balls,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE mbowl.odi_pp_runs_conceded END AS odi_pp_runs_conceded,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE COALESCE(wk.odi_pp_wickets,0) END AS odi_pp_wickets,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE mbowl.odi_mid_balls END AS odi_mid_balls,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE mbowl.odi_mid_runs_conceded END AS odi_mid_runs_conceded,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE COALESCE(wk.odi_mid_wickets,0) END AS odi_mid_wickets,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE mbowl.odi_death_balls END AS odi_death_balls,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE mbowl.odi_death_runs_conceded END AS odi_death_runs_conceded,
        CASE WHEN mbowl.is_hundred=1 THEN NULL ELSE COALESCE(wk.odi_death_wickets,0) END AS odi_death_wickets
    FROM mbowl
    LEFT JOIN wkt_agg wk
      ON mbowl.match_id = wk.match_id AND mbowl.innings_number = wk.innings_number
     AND mbowl.bowler_id = wk.bowler_id AND mbowl.batting_hand = wk.batting_hand
    ORDER BY mbowl.match_date, mbowl.match_id, mbowl.innings_number, mbowl.bowler_id, mbowl.batting_hand
    """


# --------------------------------------------------------------------------- #
# Reconciliation checks
# --------------------------------------------------------------------------- #

def q1(con, sql):
    return con.execute(sql).fetchone()[0]


def run_checks(con, scratch_dir, use_patched):
    os.makedirs(scratch_dir, exist_ok=True)
    mbat_p = os.path.join(scratch_dir, "matchup_batting_ext.parquet")
    mbowl_p = os.path.join(scratch_dir, "matchup_bowling_ext.parquet")
    mbat_orig_p = os.path.join(scratch_dir, "matchup_batting_orig.parquet")
    mbowl_orig_p = os.path.join(scratch_dir, "matchup_bowling_orig.parquet")

    if use_patched:
        log("Using export_parquet.py's OWN sql_matchup_batting/sql_matchup_bowling "
            "(STEP 3: proving the patched real script).")
        bat_sql = ep.sql_matchup_batting()
        bowl_sql = ep.sql_matchup_bowling()
    else:
        log("Using this file's dev copies of the extended SQL (STEP 1).")
        bat_sql = sql_matchup_batting_dev()
        bowl_sql = sql_matchup_bowling_dev()

    t0 = time.time()
    log("Materializing extended matchup_batting ...")
    ep.write_parquet(con, bat_sql, mbat_p)
    log(f"  done in {time.time()-t0:.1f}s")

    t0 = time.time()
    log("Materializing extended matchup_bowling ...")
    ep.write_parquet(con, bowl_sql, mbowl_p)
    log(f"  done in {time.time()-t0:.1f}s")

    # Original (unmodified) sql_matchup_* for the column-unchanged check (5).
    t0 = time.time()
    log("Materializing ORIGINAL (unmodified) sql_matchup_batting/bowling for check 5 ...")
    ep.write_parquet(con, ep.sql_matchup_batting(), mbat_orig_p)
    ep.write_parquet(con, ep.sql_matchup_bowling(), mbowl_orig_p)
    log(f"  done in {time.time()-t0:.1f}s")

    def rp(p):
        return f"read_parquet('{p}')"

    # ----------------------------------------------------------------- #
    # Check 1: batting dis_* six-way split sums to dismissals.
    # ----------------------------------------------------------------- #
    log("=" * 70)
    log("CHECK 1: matchup_batting dis_* six-way split == dismissals")

    tot_dis = q1(con, f"SELECT SUM(dismissals) FROM {rp(mbat_p)}")
    tot_split = q1(con, f"""
        SELECT SUM(dis_bowled + dis_lbw + dis_caught + dis_caught_and_bowled
                    + dis_stumped + dis_hit_wicket)
        FROM {rp(mbat_p)}
    """)
    record(tot_dis == tot_split, "1a global SUM(dis_*)==SUM(dismissals)",
           f"split={tot_split} vs dismissals={tot_dis}")

    bad_rows = q1(con, f"""
        SELECT COUNT(*) FROM {rp(mbat_p)}
        WHERE dis_bowled + dis_lbw + dis_caught + dis_caught_and_bowled
              + dis_stumped + dis_hit_wicket != dismissals
    """)
    record(bad_rows == 0, "1a per-row dis_* split == dismissals (all rows)",
           f"{bad_rows} mismatched rows")

    sample = con.execute(f"""
        SELECT match_id, innings_number, batter_id, bowling_type, dismissals,
               dis_bowled + dis_lbw + dis_caught + dis_caught_and_bowled
               + dis_stumped + dis_hit_wicket AS split_sum
        FROM {rp(mbat_p)}
        ORDER BY (dismissals = 0), random()
        LIMIT 20
    """).fetchall()
    sample_ok = all(r[4] == r[5] for r in sample)
    record(sample_ok, "1b 20 random (match,inn,batter,style) rows: dis_* split == dismissals",
           f"sampled {len(sample)} rows, nonzero-dismissal among them: "
           f"{sum(1 for r in sample if r[4] > 0)}")
    for r in sample[:5]:
        log(f"    sample: match={r[0]} inn={r[1]} batter={r[2]} style={r[3]!r} "
            f"dismissals={r[4]} split_sum={r[5]}")

    # ----------------------------------------------------------------- #
    # Check 2: batting phase trios sum to totals (T20-range on T20/IT20,
    # ODI-range on ODI/ODM).
    # ----------------------------------------------------------------- #
    log("=" * 70)
    log("CHECK 2: matchup_batting phase splits sum to totals")

    t20_bad = q1(con, f"""
        SELECT COUNT(*) FROM {rp(mbat_p)}
        WHERE match_type IN ('T20','IT20')
          AND (pp_runs + mid_runs + death_runs != runs
               OR pp_balls + mid_balls + death_balls != balls_faced)
    """)
    t20_total = q1(con, f"SELECT COUNT(*) FROM {rp(mbat_p)} WHERE match_type IN ('T20','IT20')")
    record(t20_bad == 0, "2a T20/IT20: pp+mid+death runs/balls == runs/balls_faced",
           f"{t20_bad} of {t20_total} rows mismatch")

    if t20_bad > 0:
        # Investigate: over_number outside [0,19] in T20/IT20 (excluding the
        # Hundred, which isn't T20/IT20 by match_type and uses legal_ordinal
        # anyway, so any exception here is a genuine data-edge case).
        exc = con.execute(f"""
            WITH {ep.build_delivery_cte(hundred_only=None)}
            SELECT COUNT(*), COUNT(DISTINCT match_id)
            FROM d
            WHERE match_type IN ('T20','IT20')
              AND (over_number < 0 OR over_number > 19)
        """).fetchone()
        log(f"    INVESTIGATION: deliveries with match_type IN (T20,IT20) and "
            f"over_number outside [0,19]: {exc[0]} deliveries across {exc[1]} matches")

    odi_bad = q1(con, f"""
        SELECT COUNT(*) FROM {rp(mbat_p)}
        WHERE match_type IN ('ODI','ODM')
          AND (odi_pp_runs + odi_mid_runs + odi_death_runs != runs
               OR odi_pp_balls + odi_mid_balls + odi_death_balls != balls_faced)
    """)
    odi_total = q1(con, f"SELECT COUNT(*) FROM {rp(mbat_p)} WHERE match_type IN ('ODI','ODM')")
    record(odi_bad == 0, "2b ODI/ODM: odi_pp+mid+death runs/balls == runs/balls_faced",
           f"{odi_bad} of {odi_total} rows mismatch")

    # ----------------------------------------------------------------- #
    # Check 3: bowling mirrors of 1 and 2.
    # ----------------------------------------------------------------- #
    log("=" * 70)
    log("CHECK 3: matchup_bowling wkt_* split + phase trios")

    tot_wkts = q1(con, f"SELECT SUM(wickets) FROM {rp(mbowl_p)}")
    tot_wsplit = q1(con, f"""
        SELECT SUM(wkt_bowled + wkt_lbw + wkt_caught + wkt_caught_and_bowled
                    + wkt_stumped + wkt_hit_wicket)
        FROM {rp(mbowl_p)}
    """)
    record(tot_wkts == tot_wsplit, "3a global SUM(wkt_*)==SUM(wickets)",
           f"split={tot_wsplit} vs wickets={tot_wkts}")

    bad_wrows = q1(con, f"""
        SELECT COUNT(*) FROM {rp(mbowl_p)}
        WHERE wkt_bowled + wkt_lbw + wkt_caught + wkt_caught_and_bowled
              + wkt_stumped + wkt_hit_wicket != wickets
    """)
    record(bad_wrows == 0, "3a per-row wkt_* split == wickets (all rows)",
           f"{bad_wrows} mismatched rows")

    wsample = con.execute(f"""
        SELECT match_id, innings_number, bowler_id, batting_hand, wickets,
               wkt_bowled + wkt_lbw + wkt_caught + wkt_caught_and_bowled
               + wkt_stumped + wkt_hit_wicket AS split_sum
        FROM {rp(mbowl_p)}
        ORDER BY (wickets = 0), random()
        LIMIT 20
    """).fetchall()
    wsample_ok = all(r[4] == r[5] for r in wsample)
    record(wsample_ok, "3b 20 random (match,inn,bowler,hand) rows: wkt_* split == wickets",
           f"sampled {len(wsample)} rows, nonzero-wicket among them: "
           f"{sum(1 for r in wsample if r[4] > 0)}")

    t20_bbad = q1(con, f"""
        SELECT COUNT(*) FROM {rp(mbowl_p)}
        WHERE match_type IN ('T20','IT20')
          AND (pp_balls + mid_balls + death_balls != balls
               OR pp_runs_conceded + mid_runs_conceded + death_runs_conceded != runs_conceded
               OR pp_wickets + mid_wickets + death_wickets != wickets)
    """)
    t20_btotal = q1(con, f"SELECT COUNT(*) FROM {rp(mbowl_p)} WHERE match_type IN ('T20','IT20')")
    record(t20_bbad == 0, "3c T20/IT20: pp+mid+death balls/runs_conceded/wickets == totals",
           f"{t20_bbad} of {t20_btotal} rows mismatch")

    odi_bbad = q1(con, f"""
        SELECT COUNT(*) FROM {rp(mbowl_p)}
        WHERE match_type IN ('ODI','ODM')
          AND (odi_pp_balls + odi_mid_balls + odi_death_balls != balls
               OR odi_pp_runs_conceded + odi_mid_runs_conceded + odi_death_runs_conceded != runs_conceded
               OR odi_pp_wickets + odi_mid_wickets + odi_death_wickets != wickets)
    """)
    odi_btotal = q1(con, f"SELECT COUNT(*) FROM {rp(mbowl_p)} WHERE match_type IN ('ODI','ODM')")
    record(odi_bbad == 0, "3d ODI/ODM: odi_pp+mid+death balls/runs_conceded/wickets == totals",
           f"{odi_bbad} of {odi_btotal} rows mismatch")

    # ----------------------------------------------------------------- #
    # Check 4: delivery-level hand checks.
    # ----------------------------------------------------------------- #
    log("=" * 70)
    log("CHECK 4: delivery-level two-way checks")

    # -- 4a: SA Yadav, men's T20+IT20 international, 2023-07-01..2026-08-01,
    #    death-overs runs+balls vs bowling_group='Spin'.
    scope_a = ("gender='male' AND team_type='international' "
               "AND match_type IN ('T20','IT20') "
               "AND match_date BETWEEN DATE '2023-07-01' AND DATE '2026-08-01'")
    via_agg = con.execute(f"""
        SELECT COALESCE(SUM(death_runs),0), COALESCE(SUM(death_balls),0)
        FROM {rp(mbat_p)}
        WHERE batter_name = 'SA Yadav' AND bowling_group = 'Spin' AND {scope_a}
    """).fetchone()

    # Same batter_id(s)/scope, straight from deliveries + the same profile join
    # the script uses (d.bowler_id -> player_profiles for bowling_group), no
    # dependency on the aggregated columns at all.
    batter_ids = [r[0] for r in con.execute(f"""
        SELECT DISTINCT batter_id FROM {rp(mbat_p)}
        WHERE batter_name = 'SA Yadav' AND {scope_a}
    """).fetchall()]
    bid_list = ", ".join(f"'{b}'" for b in batter_ids) if batter_ids else "NULL"
    cte = ep.build_delivery_cte(hundred_only=None)
    t20_phase = ep.t20_phase_expr()
    FACED_BATTER = ep.FACED_BATTER
    via_raw = con.execute(f"""
        WITH {cte}
        SELECT COALESCE(SUM(d.runs_batter),0) AS runs,
               COALESCE(SUM(CASE WHEN {FACED_BATTER} THEN 1 ELSE 0 END),0) AS balls
        FROM d
        LEFT JOIN player_profiles pp ON d.bowler_id = pp.player_id
        WHERE d.batter_id IN ({bid_list})
          AND COALESCE(pp.bowling_group, '(unmapped)') = 'Spin'
          AND {t20_phase} = 'death'
          AND d.gender='male' AND d.team_type='international'
          AND d.match_type IN ('T20','IT20')
          AND d.match_date BETWEEN DATE '2023-07-01' AND DATE '2026-08-01'
    """).fetchone()

    log(f"    SA Yadav death-overs vs Spin: via aggregated cols = runs={via_agg[0]}, balls={via_agg[1]}")
    log(f"    SA Yadav death-overs vs Spin: via raw deliveries  = runs={via_raw[0]}, balls={via_raw[1]}")
    log(f"    (batter_id(s) resolved for 'SA Yadav' in scope: {batter_ids})")
    record(tuple(via_agg) == tuple(via_raw),
           "4a SA Yadav death runs+balls vs Spin: aggregated == raw deliveries",
           f"agg={tuple(via_agg)} vs raw={tuple(via_raw)}")

    # -- 4b: JJ Bumrah pp_wickets vs Right-hand bat (all matches, no date/format
    #    filter -- pp_ is stored for all formats per spec).
    via_agg_w = q1(con, f"""
        SELECT COALESCE(SUM(pp_wickets),0) FROM {rp(mbowl_p)}
        WHERE bowler_name = 'JJ Bumrah' AND batting_hand = 'Right-hand bat'
    """)
    bowler_ids = [r[0] for r in con.execute(f"""
        SELECT DISTINCT bowler_id FROM {rp(mbowl_p)}
        WHERE bowler_name = 'JJ Bumrah'
    """).fetchall()]
    bwid_list = ", ".join(f"'{b}'" for b in bowler_ids) if bowler_ids else "NULL"
    KINDS_IN = ep._KINDS_IN
    via_raw_w = con.execute(f"""
        WITH {cte},
        kept_wickets AS (
            SELECT w.match_id, w.innings_number, w.over_number, w.ball_index, w.kind
            FROM wickets w
            JOIN kept_innings ki
              ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
            WHERE w.kind IN ({KINDS_IN})
        )
        SELECT COALESCE(COUNT(*), 0)
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        LEFT JOIN player_profiles pp ON d.batter_id = pp.player_id
        WHERE d.bowler_id IN ({bwid_list})
          AND COALESCE(pp.batting_style, '(unmapped)') = 'Right-hand bat'
          AND {t20_phase} = 'pp'
    """).fetchone()[0]

    log(f"    JJ Bumrah pp_wickets vs Right-hand bat: via aggregated cols = {via_agg_w}")
    log(f"    JJ Bumrah pp_wickets vs Right-hand bat: via raw deliveries  = {via_raw_w}")
    log(f"    (bowler_id(s) resolved for 'JJ Bumrah': {bowler_ids})")
    record(via_agg_w == via_raw_w,
           "4b JJ Bumrah pp_wickets vs Right-hand bat: aggregated == raw deliveries",
           f"agg={via_agg_w} vs raw={via_raw_w}")

    # ----------------------------------------------------------------- #
    # Check 5: column-count / old-column-unchanged.
    # ----------------------------------------------------------------- #
    log("=" * 70)
    log("CHECK 5: previously-existing columns unchanged vs current (unmodified) SQL")

    old_bat_cols = ["runs", "balls_faced", "dots", "fours_hit", "sixes_hit", "dismissals"]
    old_bowl_cols = ["balls", "runs_conceded", "wickets", "dots", "fours_conceded", "sixes_conceded"]

    orig_bat_rows = q1(con, f"SELECT COUNT(*) FROM {rp(mbat_orig_p)}")
    new_bat_rows = q1(con, f"SELECT COUNT(*) FROM {rp(mbat_p)}")
    record(orig_bat_rows == new_bat_rows, "5a matchup_batting row count unchanged",
           f"orig={orig_bat_rows} vs new={new_bat_rows}")

    for c in old_bat_cols:
        o = q1(con, f"SELECT SUM({c}) FROM {rp(mbat_orig_p)}")
        n = q1(con, f"SELECT SUM({c}) FROM {rp(mbat_p)}")
        record(o == n, f"5b matchup_batting SUM({c}) unchanged", f"orig={o} vs new={n}")

    orig_bowl_rows = q1(con, f"SELECT COUNT(*) FROM {rp(mbowl_orig_p)}")
    new_bowl_rows = q1(con, f"SELECT COUNT(*) FROM {rp(mbowl_p)}")
    record(orig_bowl_rows == new_bowl_rows, "5c matchup_bowling row count unchanged",
           f"orig={orig_bowl_rows} vs new={new_bowl_rows}")

    for c in old_bowl_cols:
        o = q1(con, f"SELECT SUM({c}) FROM {rp(mbowl_orig_p)}")
        n = q1(con, f"SELECT SUM({c}) FROM {rp(mbowl_p)}")
        record(o == n, f"5d matchup_bowling SUM({c}) unchanged", f"orig={o} vs new={n}")

    # Column counts / names, informational.
    new_bat_cols = [d[0] for d in con.execute(f"DESCRIBE SELECT * FROM {rp(mbat_p)}").fetchall()]
    new_bowl_cols = [d[0] for d in con.execute(f"DESCRIBE SELECT * FROM {rp(mbowl_p)}").fetchall()]
    log(f"    matchup_batting.parquet columns ({len(new_bat_cols)}): {new_bat_cols}")
    log(f"    matchup_bowling.parquet columns ({len(new_bowl_cols)}): {new_bowl_cols}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--patched", action="store_true",
                     help="use export_parquet.py's own sql_matchup_* (STEP 3)")
    ap.add_argument("--scratch", default=DEFAULT_SCRATCH)
    args = ap.parse_args()

    t0 = time.time()
    log(f"dev_test_matchup_extension starting (real_db={REAL_DB}, "
        f"scratch={args.scratch}, patched={args.patched})")

    con = make_connection()
    build_player_profiles(con)
    run_checks(con, args.scratch, args.patched)
    con.close()

    log("=" * 70)
    log(f"RESULT: {len(CHECKS_PASSED)} passed, {len(CHECKS_FAILED)} failed "
        f"(in {time.time()-t0:.1f}s)")
    if CHECKS_FAILED:
        for name, detail in CHECKS_FAILED:
            log(f"  FAILED: {name} :: {detail}")
        sys.exit(1)
    log("ALL CHECKS PASSED.")


if __name__ == "__main__":
    main()
