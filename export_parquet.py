#!/usr/bin/env python3
"""
export_parquet.py — cricdb data pipeline.

Reads the Cricsheet-derived DuckDB database (READ-ONLY), aggregates the four
Parquet exports that power the static cricket-stats explorer, validates them
against the base `deliveries` table, and (optionally) uploads them to R2.

All aggregation is done from the `deliveries` base table per the owner's
ABSOLUTE calculation rules. See the block comments in each section for the
exact rules applied.

CLI:
    python export_parquet.py [--db PATH] [--out DIR] [--download] [--upload]

Deps: stdlib + duckdb + boto3 only.
"""

import argparse
import datetime as _dt
import hashlib
import json
import os
import sys
import time

import duckdb

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

R2_BUCKET = "cricket-db"
R2_DB_KEY = "cricket.duckdb"
R2_EXPORT_PREFIX = "explorer/"

# Upload robustness (pipeline safety net, 2026-07-09): each file gets up to
# this many attempts with a short exponential backoff between retries before
# being declared failed.
UPLOAD_MAX_ATTEMPTS = 3
UPLOAD_BACKOFF_BASE_SECONDS = 2  # attempt 2 waits 2s, attempt 3 waits 4s

DEFAULT_DB = "data/cricket.duckdb"
DEFAULT_OUT = "data/export"

ROW_GROUP_SIZE = 100000
COMPRESSION = "zstd"

# Bowler-credited dismissal kinds.
BOWLER_WICKET_KINDS = (
    "bowled",
    "lbw",
    "caught",
    "caught and bowled",
    "stumped",
    "hit wicket",
)

# Dismissal kinds that DO NOT count as a batter dismissal.
NON_DISMISSAL_KINDS = ("retired hurt", "retired not out")

# Owner-approved vocabulary (decision 13, review/owner_decisions.md) for the
# matchup_batting.bowling_type column. The COALESCE key
# (COALESCE(profile.bowling_type, profile.bowling_group, '(unmapped)')) can
# legitimately surface either a specific type OR a bare group name when only
# the group is known, so 'Pace'/'Spin' are valid alongside the specific types.
# Verified 2026-07-09 against the real DB: 11 of these 12 values are actually
# populated ('Pace' does not currently occur -- see run_gates for detail); the
# 12th is kept in the allow-list because it is a legitimate COALESCE fallback
# the owner already approved, not a hypothetical.
BOWLING_TYPE_VOCAB = (
    "Off-spin", "Leg-spin", "Slow left-arm orthodox", "Left-arm wrist-spin",
    "Medium", "Medium-fast", "Fast-medium", "Fast", "Slow-medium",
    "Pace", "Spin", "(unmapped)",
)
BATTING_HAND_VOCAB = ("Right-hand bat", "Left-hand bat", "(unmapped)")
BOWLING_GROUP_VOCAB = ("Pace", "Spin", "(unmapped)")

# The export files and their primary keys (for the duplicate-PK gate).
EXPORT_FILES = {
    "players.parquet": ["player_id"],
    "matches.parquet": ["match_id"],
    "batting_innings.parquet": ["match_id", "innings_number", "batter_id"],
    "bowling_innings.parquet": ["match_id", "innings_number", "bowler_id"],
    "player_matches.parquet": ["match_id", "player_id"],
    "player_profiles.parquet": ["player_id"],
    # D4 matchup files (men-only in practice; unmapped opponents bucketed as
    # '(unmapped)' so the browser can compute an honest N-of-M denominator).
    "matchup_batting.parquet": ["match_id", "innings_number", "batter_id", "bowling_type"],
    # D4-R4: matchup_bowling grain gained batting_position (STRIKER's own
    # batting position at each delivery) as a 5th PK column.
    "matchup_bowling.parquet": ["match_id", "innings_number", "bowler_id", "batting_hand", "batting_position"],
}

CONTENT_TYPES = {
    "players.parquet": "application/vnd.apache.parquet",
    "matches.parquet": "application/vnd.apache.parquet",
    "batting_innings.parquet": "application/vnd.apache.parquet",
    "bowling_innings.parquet": "application/vnd.apache.parquet",
    "player_matches.parquet": "application/vnd.apache.parquet",
    "player_profiles.parquet": "application/vnd.apache.parquet",
    "matchup_batting.parquet": "application/vnd.apache.parquet",
    "matchup_bowling.parquet": "application/vnd.apache.parquet",
    "manifest.json": "application/json",
}

# ---------------------------------------------------------------------------
# SPOT_CHECKS — owner-verified career lines, asserted on every run.
# Add dicts of the shape below once the owner confirms them at Phase 1.
#   {
#     "player_name": "V Kohli",
#     "gender": "male",
#     "match_types": ["T20", "IT20"],
#     "date_from": "2008-01-01",   # inclusive, matches.match_date_1
#     "date_to":   "2026-07-06",   # inclusive
#     "expect": {"runs": 12345, "innings": 300, "wickets": 4, ...},
#   }
# Supported expect keys: batting -> runs, balls_faced, innings, dismissals,
# fours_hit, sixes_hit; bowling -> wickets, runs_conceded, balls, bowl_innings.
# (Batting "innings" = batting_innings rows; "bowl_innings" = bowling rows.)
# ---------------------------------------------------------------------------
# Owner-verified 2026-07-06 against ESPNcricinfo for span 2025-01-01..2025-12-31.
# NOTE: international T20s largely live under match_type 'T20' in Cricsheet
# (IT20 is sparsely used), so T20 checks span both types.
_T20S = ["T20", "IT20"]
_2025 = {"date_from": "2025-01-01", "date_to": "2025-12-31"}
SPOT_CHECKS = [
    {"player_name": "V Kohli", "gender": "male", "match_types": _T20S, **_2025,
     "expect": {"innings": 15, "runs": 657, "balls_faced": 454, "dismissals": 12,
                "fours_hit": 66, "sixes_hit": 19, "high_score": 73}},
    {"player_name": "S Mandhana", "gender": "female", "match_types": _T20S, **_2025,
     "expect": {"innings": 17, "runs": 538, "balls_faced": 395, "dismissals": 17,
                "fours_hit": 76, "sixes_hit": 14, "high_score": 112}},
    # Owner's pasted line (950/14) excluded the Sydney Test (started 3 Jan 2025,
    # season-vs-calendar quirk in the source); owner confirmed calendar-year rule.
    {"player_name": "Shubman Gill", "gender": "male", "match_types": ["Test"], **_2025,
     "expect": {"innings": 16, "runs": 983, "balls_faced": 1543, "dismissals": 14,
                "fours_hit": 112, "sixes_hit": 15, "high_score": 269}},
    {"player_name": "BA Stokes", "gender": "male", "match_types": ["Test"], **_2025,
     "expect": {"innings": 16, "runs": 496, "balls_faced": 1081, "dismissals": 16,
                "fours_hit": 50, "sixes_hit": 3, "high_score": 141,
                "bowl_innings": 17, "balls": 1350, "runs_conceded": 763, "wickets": 33}},
    {"player_name": "M Kapp", "gender": "female", "match_types": ["ODI"], **_2025,
     "expect": {"innings": 11, "runs": 395, "balls_faced": 401, "dismissals": 8,
                "fours_hit": 36, "sixes_hit": 10, "high_score": 121,
                "bowl_innings": 13, "balls": 492, "runs_conceded": 349, "wickets": 17}},
    {"player_name": "NR Sciver-Brunt", "gender": "female", "match_types": _T20S, **_2025,
     "expect": {"innings": 36, "runs": 1229, "balls_faced": 847, "dismissals": 32,
                "fours_hit": 184, "sixes_hit": 12, "high_score": 81,
                "bowl_innings": 21, "balls": 348, "runs_conceded": 482, "wickets": 18}},
    {"player_name": "Mohammed Siraj", "gender": "male", "match_types": ["Test"], **_2025,
     "expect": {"bowl_innings": 19, "balls": 1869, "runs_conceded": 1170, "wickets": 43}},
]


# ---------------------------------------------------------------------------
# Logging helper
# ---------------------------------------------------------------------------

def log(msg):
    ts = _dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


class GateError(Exception):
    """Raised when a validation gate fails."""


# ---------------------------------------------------------------------------
# Shared SQL fragments
# ---------------------------------------------------------------------------
#
# `super_over` innings are excluded EVERYWHERE. We build a CTE of the innings
# we keep (non-super-over) and always join deliveries/wickets through it.
#
# Denormalised match context (type/gender/team_type/date/year/month, plus the
# two teams) is joined from `matches`.
#
# Phase logic (over_number based) applies to all non-Hundred matches for both
# T20-family and ODI-family windows. For The Hundred (balls_per_over = 5) the
# T20-family phases use legal-ball ORDINAL position within the innings, and the
# ODI-family columns are NULL.

# CTE giving each kept delivery its match context and a legal-ball ordinal
# (used only for the Hundred). The ordinal counts legal balls (wides IS NULL
# AND noballs IS NULL); an illegal delivery inherits the *current* legal count
# (i.e. the count of legal balls strictly before it, + 0), so it belongs to the
# phase of the legal ball being (re)bowled. We implement this as:
#   legal_ordinal = number of legal balls at-or-before this delivery for legal
#                   deliveries; for illegal deliveries, (legal balls before) + 1
#                   so it lands in the window of the ball about to be bowled.
#
# Concretely: running count of legal balls INCLUDING current if legal, else the
# running legal count BEFORE current + 1. Both reduce to:
#   COALESCE(legal running count up to & including current, ...) — see SQL.


def build_delivery_cte(hundred_only=None):
    """
    Returns SQL for a `d` CTE: kept (non-super-over) deliveries enriched with
    match context and, for the Hundred, a legal-ball ordinal + T20 phase.

    hundred_only: if True restrict to balls_per_over=5 matches; if False restrict
    to balls_per_over=6; if None include all.
    """
    where_bpo = ""
    if hundred_only is True:
        where_bpo = "AND m.balls_per_over = 5"
    elif hundred_only is False:
        where_bpo = "AND m.balls_per_over = 6"
    return f"""
    kept_innings AS (
        SELECT i.match_id, i.innings_number, i.batting_team
        FROM innings i
        WHERE i.super_over IS NOT TRUE
    ),
    d AS (
        SELECT
            dv.*,
            m.match_type,
            m.gender,
            m.team_type,
            m.match_date_1 AS match_date,
            CAST(EXTRACT(year FROM m.match_date_1) AS INTEGER) AS year,
            CAST(EXTRACT(month FROM m.match_date_1) AS INTEGER) AS month,
            m.balls_per_over,
            m.team_1,
            m.team_2,
            ki.batting_team,
            -- legal-ball ordinal within the innings (1-based for legal balls).
            -- For an illegal ball, this equals the legal count *before* it + 1,
            -- i.e. the window of the legal ball being (re)bowled.
            CASE WHEN dv.wides IS NULL AND dv.noballs IS NULL
                 THEN SUM(CASE WHEN dv.wides IS NULL AND dv.noballs IS NULL THEN 1 ELSE 0 END)
                      OVER (PARTITION BY dv.match_id, dv.innings_number
                            ORDER BY dv.over_number, dv.ball_index
                            ROWS UNBOUNDED PRECEDING)
                 -- COALESCE: the frame is empty for an illegal delivery bowled
                 -- before any legal ball (e.g. a first-ball wide), which must
                 -- land in the window of legal ball 1, not NULL.
                 ELSE COALESCE(SUM(CASE WHEN dv.wides IS NULL AND dv.noballs IS NULL THEN 1 ELSE 0 END)
                      OVER (PARTITION BY dv.match_id, dv.innings_number
                            ORDER BY dv.over_number, dv.ball_index
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) + 1
            END AS legal_ordinal
        FROM deliveries dv
        JOIN kept_innings ki
          ON dv.match_id = ki.match_id AND dv.innings_number = ki.innings_number
        JOIN matches m ON dv.match_id = m.match_id
        WHERE 1=1 {where_bpo}
    )
    """


# T20-family phase expression (over_number based) for non-Hundred.
T20_PHASE_OVER = """
    CASE
        WHEN d.over_number BETWEEN 0 AND 5  THEN 'pp'
        WHEN d.over_number BETWEEN 6 AND 14 THEN 'mid'
        WHEN d.over_number BETWEEN 15 AND 19 THEN 'death'
        ELSE NULL
    END
"""

# T20-family phase expression for the Hundred (legal-ball ordinal based).
#   pp    = legal balls 1..25
#   mid   = 26..75
#   death = 76+ (owner ruling: overflow balls from scorer-miscounted overs —
#           two innings in the data have a 101st legal ball — count as death)
T20_PHASE_HUNDRED = """
    CASE
        WHEN d.legal_ordinal BETWEEN 1 AND 25   THEN 'pp'
        WHEN d.legal_ordinal BETWEEN 26 AND 75  THEN 'mid'
        WHEN d.legal_ordinal >= 76              THEN 'death'
        ELSE NULL
    END
"""

# ODI-family phase (over_number based). NULL for the Hundred.
ODI_PHASE_OVER = """
    CASE
        WHEN d.balls_per_over = 5 THEN NULL
        WHEN d.over_number BETWEEN 0 AND 9   THEN 'pp'
        WHEN d.over_number BETWEEN 10 AND 39 THEN 'mid'
        WHEN d.over_number BETWEEN 40 AND 49 THEN 'death'
        ELSE NULL
    END
"""


def t20_phase_expr():
    """T20-family phase, branching on the Hundred (balls_per_over=5)."""
    return f"""
    CASE
        WHEN d.balls_per_over = 5 THEN ({T20_PHASE_HUNDRED})
        ELSE ({T20_PHASE_OVER})
    END
    """


# Boolean legality flags used repeatedly.
LEGAL_BOWLER = "(d.wides IS NULL AND d.noballs IS NULL)"
FACED_BATTER = "(d.wides IS NULL)"  # no-balls count as faced
HIT_BOUNDARY_4 = "(d.runs_batter = 4 AND d.is_not_boundary IS NOT TRUE)"
HIT_BOUNDARY_6 = "(d.runs_batter = 6 AND d.is_not_boundary IS NOT TRUE)"
BOWLER_RUNS = "(d.runs_batter + COALESCE(d.noballs,0) + COALESCE(d.wides,0))"

_KINDS_IN = ", ".join(f"'{k}'" for k in BOWLER_WICKET_KINDS)
_NON_DIS_IN = ", ".join(f"'{k}'" for k in NON_DISMISSAL_KINDS)


# ---------------------------------------------------------------------------
# Export builders — each returns the SQL SELECT producing the export rows.
# ---------------------------------------------------------------------------

def sql_players():
    return """
    SELECT pr.player_id, pr.player_name
    FROM player_registry pr
    WHERE pr.player_id IN (SELECT DISTINCT player_id FROM match_players WHERE player_id IS NOT NULL)
    ORDER BY pr.player_id
    """


def sql_player_profiles():
    # player_profiles is a NON-Cricsheet enrichment table built by
    # pipeline/build_profiles.py (Phase D2). Exported verbatim — one row per
    # matched player_id — with the same conventions as the other exports.
    return """
    SELECT *
    FROM player_profiles
    ORDER BY player_id
    """


def sql_matches():
    # matches.parquet excludes matches that have ONLY super-over innings? No:
    # matches list all matches; super-over exclusion applies to stats rows.
    # The spec sorts by match_date then match_id; a match always has ordinary
    # innings, so keep all matches.
    return """
    SELECT
        m.match_id,
        m.match_type,
        m.gender,
        m.team_type,
        m.match_date_1 AS match_date,
        CAST(EXTRACT(year FROM m.match_date_1) AS INTEGER) AS year,
        CAST(EXTRACT(month FROM m.match_date_1) AS INTEGER) AS month,
        m.venue,
        m.city,
        m.event_name,
        m.team_1,
        m.team_2,
        m.winner,
        m.result_type
    FROM matches m
    ORDER BY m.match_date_1, m.match_id
    """


def sql_batting():
    """
    One row per (match_id, innings_number, batter_id) for every player who came
    to the crease: appeared as batter OR non_striker in deliveries, OR as
    player_out in wickets (diamond ducks). Aggregates from `deliveries`.
    """
    cte = build_delivery_cte(hundred_only=None)
    return f"""
    WITH {cte},
    -- Every crease appearance: batter, non_striker (from kept deliveries), and
    -- player_out from wickets in kept innings (diamond ducks with 0 balls).
    kept_wickets AS (
        SELECT w.*
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
    ),
    crease AS (
        SELECT match_id, innings_number, batter_id AS pid, batter AS pname FROM d
        UNION
        SELECT match_id, innings_number, non_striker_id AS pid, non_striker AS pname FROM d
        UNION
        SELECT match_id, innings_number, player_out_id AS pid, player_out AS pname FROM kept_wickets
    ),
    crease_dedup AS (
        -- one (match,inn,pid); pick a representative name deterministically
        SELECT match_id, innings_number, pid AS batter_id, MIN(pname) AS any_name
        FROM crease
        GROUP BY match_id, innings_number, pid
    ),
    -- Batting position: rank of first appearance at the crease, ordered by the
    -- first delivery where the player is batter or non_striker; on that same
    -- delivery the striker (batter) ranks before the non-striker. Players whose
    -- only trace is a wickets row (came to the crease, never on record for a
    -- delivery, e.g. immediate retirement) slot in at the ball where their
    -- wicket/retirement is recorded, AFTER the two on-strike players of that
    -- ball (owner ruling: they take the position where they actually arrived,
    -- e.g. a #4 who retires immediately is position 4, not 11).
    appearances AS (
        SELECT match_id, innings_number, batter_id AS pid,
               over_number, ball_index, 0 AS role_rank  -- striker before non-striker
        FROM d
        UNION ALL
        SELECT match_id, innings_number, non_striker_id AS pid,
               over_number, ball_index, 1 AS role_rank
        FROM d
        UNION ALL
        SELECT match_id, innings_number, player_out_id AS pid,
               over_number, ball_index, 2 + wicket_index AS role_rank
        FROM kept_wickets
    ),
    first_app AS (
        SELECT match_id, innings_number, pid,
               MIN(ROW(over_number, ball_index, role_rank)) AS first_key
        FROM appearances
        GROUP BY match_id, innings_number, pid
    ),
    positions AS (
        SELECT match_id, innings_number, pid,
               ROW_NUMBER() OVER (
                   PARTITION BY match_id, innings_number
                   ORDER BY first_key
               ) AS batting_position
        FROM first_app
    ),
    -- Per-ball batting aggregates keyed by (match,inn,batter=striker).
    bat_agg AS (
        SELECT
            match_id, innings_number, batter_id,
            ANY_VALUE(batter) AS bat_name,
            ANY_VALUE(batting_team) AS batting_team,
            ANY_VALUE(match_type) AS match_type,
            ANY_VALUE(gender) AS gender,
            ANY_VALUE(team_type) AS team_type,
            ANY_VALUE(match_date) AS match_date,
            ANY_VALUE(year) AS year,
            ANY_VALUE(month) AS month,
            ANY_VALUE(team_1) AS team_1,
            ANY_VALUE(team_2) AS team_2,
            SUM(d.runs_batter) AS runs,
            SUM(CASE WHEN {FACED_BATTER} THEN 1 ELSE 0 END) AS balls_faced,
            SUM(CASE WHEN {FACED_BATTER} AND d.runs_batter = 0 THEN 1 ELSE 0 END) AS dots,
            SUM(CASE WHEN {HIT_BOUNDARY_4} THEN 1 ELSE 0 END) AS fours_hit,
            SUM(CASE WHEN {HIT_BOUNDARY_6} THEN 1 ELSE 0 END) AS sixes_hit,
            -- T20-family phase components (batter legality = faced)
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    THEN d.runs_batter ELSE 0 END) AS pp_runs,
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    AND {FACED_BATTER} THEN 1 ELSE 0 END) AS pp_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   THEN d.runs_batter ELSE 0 END) AS mid_runs,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   AND {FACED_BATTER} THEN 1 ELSE 0 END) AS mid_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' THEN d.runs_batter ELSE 0 END) AS death_runs,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' AND {FACED_BATTER} THEN 1 ELSE 0 END) AS death_balls,
            -- ODI-family phase components (NULL columns for the Hundred handled via phase expr)
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    THEN d.runs_batter ELSE 0 END) AS odi_pp_runs,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_pp_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   THEN d.runs_batter ELSE 0 END) AS odi_mid_runs,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_mid_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' THEN d.runs_batter ELSE 0 END) AS odi_death_runs,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_death_balls,
            MAX(CASE WHEN d.balls_per_over = 5 THEN 1 ELSE 0 END) AS is_hundred
        FROM d
        WHERE d.batter_id IS NOT NULL
        GROUP BY match_id, innings_number, batter_id
    ),
    -- Dismissal per (match,inn,player_out). A batter is dismissed if a wickets
    -- row exists with kind NOT IN the non-dismissal set. Store dismissal_kind
    -- as-is whenever ANY wickets row exists for that player in that innings.
    dis AS (
        SELECT match_id, innings_number, player_out_id AS pid,
               MAX(CASE WHEN kind NOT IN ({_NON_DIS_IN}) THEN 1 ELSE 0 END) AS dismissed,
               -- prefer a real dismissal kind's text; else keep whatever exists
               COALESCE(
                   ANY_VALUE(CASE WHEN kind NOT IN ({_NON_DIS_IN}) THEN kind END),
                   ANY_VALUE(kind)
               ) AS dismissal_kind
        FROM kept_wickets
        GROUP BY match_id, innings_number, player_out_id
    ),
    -- Innings-progression buckets (family E). A within-innings FACED-ball
    -- counter per (match,inn,batter): count only faced balls (wides IS NULL;
    -- no-balls count as faced), ordered by over/ball. faced_num is the 1-based
    -- faced-ball ordinal on a faced ball. Wide deliveries carry runs_batter = 0
    -- in kept (non-super-over) innings (verified), so bucketing runs on faced
    -- balls only still sums to the batter's total runs.
    faced_seq AS (
        SELECT
            match_id, innings_number, batter_id, runs_batter, wides,
            SUM(CASE WHEN {FACED_BATTER} THEN 1 ELSE 0 END) OVER (
                PARTITION BY match_id, innings_number, batter_id
                ORDER BY over_number, ball_index
                ROWS UNBOUNDED PRECEDING
            ) AS faced_num
        FROM d
        WHERE batter_id IS NOT NULL
    ),
    prog_agg AS (
        SELECT
            match_id, innings_number, batter_id,
            SUM(CASE WHEN wides IS NULL AND faced_num BETWEEN 1 AND 10  THEN runs_batter ELSE 0 END) AS fb1_10_runs,
            SUM(CASE WHEN wides IS NULL AND faced_num BETWEEN 1 AND 10  THEN 1 ELSE 0 END)           AS fb1_10_balls,
            SUM(CASE WHEN wides IS NULL AND faced_num BETWEEN 11 AND 20 THEN runs_batter ELSE 0 END) AS fb11_20_runs,
            SUM(CASE WHEN wides IS NULL AND faced_num BETWEEN 11 AND 20 THEN 1 ELSE 0 END)           AS fb11_20_balls,
            SUM(CASE WHEN wides IS NULL AND faced_num >= 21             THEN runs_batter ELSE 0 END) AS fb21p_runs,
            SUM(CASE WHEN wides IS NULL AND faced_num >= 21             THEN 1 ELSE 0 END)           AS fb21p_balls
        FROM faced_seq
        GROUP BY match_id, innings_number, batter_id
    )
    SELECT
        cd.match_id,
        cd.innings_number,
        cd.batter_id,
        COALESCE(ba.bat_name, cd.any_name) AS batter_name,
        -- context: from bat_agg if available, else from match/innings for 0-ball
        COALESCE(ba.batting_team, ki.batting_team) AS batting_team,
        CASE
            WHEN COALESCE(ba.team_1, mm.team_1) = COALESCE(ba.batting_team, ki.batting_team)
                THEN COALESCE(ba.team_2, mm.team_2)
            ELSE COALESCE(ba.team_1, mm.team_1)
        END AS bowling_team,
        COALESCE(ba.match_type, mm.match_type) AS match_type,
        COALESCE(ba.gender, mm.gender) AS gender,
        COALESCE(ba.team_type, mm.team_type) AS team_type,
        COALESCE(ba.match_date, mm.match_date_1) AS match_date,
        COALESCE(ba.year,  CAST(EXTRACT(year  FROM mm.match_date_1) AS INTEGER)) AS year,
        COALESCE(ba.month, CAST(EXTRACT(month FROM mm.match_date_1) AS INTEGER)) AS month,
        COALESCE(ba.runs, 0)         AS runs,
        COALESCE(ba.balls_faced, 0)  AS balls_faced,
        COALESCE(ba.dots, 0)         AS dots,
        COALESCE(ba.fours_hit, 0)    AS fours_hit,
        COALESCE(ba.sixes_hit, 0)    AS sixes_hit,
        COALESCE(dis.dismissed, 0)   AS dismissed,
        dis.dismissal_kind           AS dismissal_kind,
        pos.batting_position         AS batting_position,
        COALESCE(ba.pp_runs, 0)      AS pp_runs,
        COALESCE(ba.pp_balls, 0)     AS pp_balls,
        COALESCE(ba.mid_runs, 0)     AS mid_runs,
        COALESCE(ba.mid_balls, 0)    AS mid_balls,
        COALESCE(ba.death_runs, 0)   AS death_runs,
        COALESCE(ba.death_balls, 0)  AS death_balls,
        -- ODI-family: NULL for the Hundred, else the aggregate (0 default)
        CASE WHEN COALESCE(ba.is_hundred, CASE WHEN mm.balls_per_over=5 THEN 1 ELSE 0 END)=1 THEN NULL ELSE COALESCE(ba.odi_pp_runs, 0)    END AS odi_pp_runs,
        CASE WHEN COALESCE(ba.is_hundred, CASE WHEN mm.balls_per_over=5 THEN 1 ELSE 0 END)=1 THEN NULL ELSE COALESCE(ba.odi_pp_balls, 0)   END AS odi_pp_balls,
        CASE WHEN COALESCE(ba.is_hundred, CASE WHEN mm.balls_per_over=5 THEN 1 ELSE 0 END)=1 THEN NULL ELSE COALESCE(ba.odi_mid_runs, 0)   END AS odi_mid_runs,
        CASE WHEN COALESCE(ba.is_hundred, CASE WHEN mm.balls_per_over=5 THEN 1 ELSE 0 END)=1 THEN NULL ELSE COALESCE(ba.odi_mid_balls, 0)  END AS odi_mid_balls,
        CASE WHEN COALESCE(ba.is_hundred, CASE WHEN mm.balls_per_over=5 THEN 1 ELSE 0 END)=1 THEN NULL ELSE COALESCE(ba.odi_death_runs, 0) END AS odi_death_runs,
        CASE WHEN COALESCE(ba.is_hundred, CASE WHEN mm.balls_per_over=5 THEN 1 ELSE 0 END)=1 THEN NULL ELSE COALESCE(ba.odi_death_balls,0) END AS odi_death_balls,
        -- Innings-progression buckets (family E): faced-ball ordinal windows.
        COALESCE(pg.fb1_10_runs, 0)   AS fb1_10_runs,
        COALESCE(pg.fb1_10_balls, 0)  AS fb1_10_balls,
        COALESCE(pg.fb11_20_runs, 0)  AS fb11_20_runs,
        COALESCE(pg.fb11_20_balls, 0) AS fb11_20_balls,
        COALESCE(pg.fb21p_runs, 0)    AS fb21p_runs,
        COALESCE(pg.fb21p_balls, 0)   AS fb21p_balls
    FROM crease_dedup cd
    JOIN kept_innings ki
      ON cd.match_id = ki.match_id AND cd.innings_number = ki.innings_number
    JOIN matches mm ON cd.match_id = mm.match_id
    LEFT JOIN bat_agg ba
      ON cd.match_id = ba.match_id AND cd.innings_number = ba.innings_number AND cd.batter_id = ba.batter_id
    LEFT JOIN positions pos
      ON cd.match_id = pos.match_id AND cd.innings_number = pos.innings_number AND cd.batter_id = pos.pid
    LEFT JOIN dis
      ON cd.match_id = dis.match_id AND cd.innings_number = dis.innings_number AND cd.batter_id = dis.pid
    LEFT JOIN prog_agg pg
      ON cd.match_id = pg.match_id AND cd.innings_number = pg.innings_number AND cd.batter_id = pg.batter_id
    ORDER BY match_date, cd.match_id, cd.innings_number, cd.batter_id
    """


def sql_bowling():
    """
    One row per (match_id, innings_number, bowler_id). Aggregates from
    `deliveries`; bowler-credited wickets join the `wickets` table (matched on
    the delivery key) and count only bowler-credit kinds. Maidens computed from
    per-over bowler sets.
    """
    cte = build_delivery_cte(hundred_only=None)
    return f"""
    WITH {cte},
    kept_wickets AS (
        SELECT w.match_id, w.innings_number, w.over_number, w.ball_index, w.kind
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
        WHERE w.kind IN ({_KINDS_IN})
    ),
    -- Bowler-credited wickets, attributed to the bowler of that delivery.
    -- Join to deliveries to get bowler_id + phase context. A delivery can carry
    -- more than one wicket row; each credited row counts once.
    wkt_by_ball AS (
        SELECT d.match_id, d.innings_number, d.bowler_id,
               d.over_number, d.balls_per_over, d.legal_ordinal,
               COUNT(*) AS wkts
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        GROUP BY d.match_id, d.innings_number, d.bowler_id,
                 d.over_number, d.balls_per_over, d.legal_ordinal
    ),
    -- Wicket totals + phase wicket totals per (match,inn,bowler).
    wkt_agg AS (
        SELECT match_id, innings_number, bowler_id,
               SUM(wkts) AS wickets,
               SUM(CASE WHEN ({t20_phase_expr_wba()}) = 'pp'    THEN wkts ELSE 0 END) AS pp_wickets,
               SUM(CASE WHEN ({t20_phase_expr_wba()}) = 'mid'   THEN wkts ELSE 0 END) AS mid_wickets,
               SUM(CASE WHEN ({t20_phase_expr_wba()}) = 'death' THEN wkts ELSE 0 END) AS death_wickets,
               SUM(CASE WHEN ({odi_phase_wba()}) = 'pp'    THEN wkts ELSE 0 END) AS odi_pp_wickets,
               SUM(CASE WHEN ({odi_phase_wba()}) = 'mid'   THEN wkts ELSE 0 END) AS odi_mid_wickets,
               SUM(CASE WHEN ({odi_phase_wba()}) = 'death' THEN wkts ELSE 0 END) AS odi_death_wickets
        FROM wkt_by_ball
        GROUP BY match_id, innings_number, bowler_id
    ),
    -- Bowler-credited wicket breakdown by kind per (match,inn,bowler). Mirrors
    -- wkt_by_ball's join (kept_wickets is already filtered to credited kinds),
    -- so the six counts sum exactly to `wickets`.
    wkt_kind_agg AS (
        SELECT d.match_id, d.innings_number, d.bowler_id,
               SUM(CASE WHEN kw.kind = 'bowled'            THEN 1 ELSE 0 END) AS wickets_bowled,
               SUM(CASE WHEN kw.kind = 'lbw'               THEN 1 ELSE 0 END) AS wickets_lbw,
               SUM(CASE WHEN kw.kind = 'caught'            THEN 1 ELSE 0 END) AS wickets_caught,
               SUM(CASE WHEN kw.kind = 'caught and bowled' THEN 1 ELSE 0 END) AS wickets_caught_and_bowled,
               SUM(CASE WHEN kw.kind = 'stumped'          THEN 1 ELSE 0 END) AS wickets_stumped,
               SUM(CASE WHEN kw.kind = 'hit wicket'       THEN 1 ELSE 0 END) AS wickets_hit_wicket
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        GROUP BY d.match_id, d.innings_number, d.bowler_id
    ),
    -- Per-over bowler set: a maiden is a complete over of balls_per_over LEGAL
    -- deliveries by ONE bowler with 0 runs conceded (bat+wides+noballs).
    over_sets AS (
        SELECT match_id, innings_number, over_number, bowler_id,
               ANY_VALUE(balls_per_over) AS bpo,
               SUM(CASE WHEN {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS legal_balls,
               SUM({BOWLER_RUNS}) AS conceded
        FROM d
        GROUP BY match_id, innings_number, over_number, bowler_id
    ),
    maiden_agg AS (
        SELECT match_id, innings_number, bowler_id,
               SUM(CASE WHEN legal_balls = bpo AND conceded = 0 THEN 1 ELSE 0 END) AS maidens
        FROM over_sets
        GROUP BY match_id, innings_number, bowler_id
    ),
    -- Per-ball bowling aggregates keyed by (match,inn,bowler).
    bowl_agg AS (
        SELECT
            match_id, innings_number, bowler_id,
            ANY_VALUE(bowler) AS bowler_name,
            ANY_VALUE(batting_team) AS batting_team,
            ANY_VALUE(match_type) AS match_type,
            ANY_VALUE(gender) AS gender,
            ANY_VALUE(team_type) AS team_type,
            ANY_VALUE(match_date) AS match_date,
            ANY_VALUE(year) AS year,
            ANY_VALUE(month) AS month,
            ANY_VALUE(team_1) AS team_1,
            ANY_VALUE(team_2) AS team_2,
            MAX(CASE WHEN balls_per_over = 5 THEN 1 ELSE 0 END) AS is_hundred,
            SUM(CASE WHEN {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS balls,
            SUM({BOWLER_RUNS}) AS runs_conceded,
            SUM(CASE WHEN {LEGAL_BOWLER} AND d.runs_batter = 0 THEN 1 ELSE 0 END) AS dots,
            SUM(CASE WHEN {HIT_BOUNDARY_4} THEN 1 ELSE 0 END) AS fours_conceded,
            SUM(CASE WHEN {HIT_BOUNDARY_6} THEN 1 ELSE 0 END) AS sixes_conceded,
            SUM(COALESCE(d.wides,0)) AS wides_runs,
            SUM(COALESCE(d.noballs,0)) AS noball_runs,
            -- T20-family phase components
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS pp_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    THEN {BOWLER_RUNS} ELSE 0 END) AS pp_runs_conceded,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS mid_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   THEN {BOWLER_RUNS} ELSE 0 END) AS mid_runs_conceded,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS death_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' THEN {BOWLER_RUNS} ELSE 0 END) AS death_runs_conceded,
            -- ODI-family phase components
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_pp_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    THEN {BOWLER_RUNS} ELSE 0 END) AS odi_pp_runs_conceded,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_mid_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   THEN {BOWLER_RUNS} ELSE 0 END) AS odi_mid_runs_conceded,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_death_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' THEN {BOWLER_RUNS} ELSE 0 END) AS odi_death_runs_conceded
        FROM d
        WHERE d.bowler_id IS NOT NULL
        GROUP BY match_id, innings_number, bowler_id
    )
    SELECT
        b.match_id,
        b.innings_number,
        b.bowler_id,
        b.bowler_name,
        -- bowling_team is the team NOT batting
        CASE WHEN b.team_1 = b.batting_team THEN b.team_2 ELSE b.team_1 END AS bowling_team,
        b.batting_team,
        b.match_type,
        b.gender,
        b.team_type,
        b.match_date,
        b.year,
        b.month,
        b.balls,
        b.runs_conceded,
        COALESCE(w.wickets, 0) AS wickets,
        b.dots,
        b.fours_conceded,
        b.sixes_conceded,
        COALESCE(mn.maidens, 0) AS maidens,
        b.wides_runs,
        b.noball_runs,
        COALESCE(wk.wickets_bowled, 0)            AS wickets_bowled,
        COALESCE(wk.wickets_lbw, 0)               AS wickets_lbw,
        COALESCE(wk.wickets_caught, 0)            AS wickets_caught,
        COALESCE(wk.wickets_caught_and_bowled, 0) AS wickets_caught_and_bowled,
        COALESCE(wk.wickets_stumped, 0)           AS wickets_stumped,
        COALESCE(wk.wickets_hit_wicket, 0)        AS wickets_hit_wicket,
        b.pp_balls,
        b.pp_runs_conceded,
        COALESCE(w.pp_wickets, 0) AS pp_wickets,
        b.mid_balls,
        b.mid_runs_conceded,
        COALESCE(w.mid_wickets, 0) AS mid_wickets,
        b.death_balls,
        b.death_runs_conceded,
        COALESCE(w.death_wickets, 0) AS death_wickets,
        -- ODI-family: NULL for the Hundred
        CASE WHEN b.is_hundred=1 THEN NULL ELSE b.odi_pp_balls          END AS odi_pp_balls,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE b.odi_pp_runs_conceded  END AS odi_pp_runs_conceded,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE COALESCE(w.odi_pp_wickets,0)    END AS odi_pp_wickets,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE b.odi_mid_balls         END AS odi_mid_balls,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE b.odi_mid_runs_conceded END AS odi_mid_runs_conceded,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE COALESCE(w.odi_mid_wickets,0)   END AS odi_mid_wickets,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE b.odi_death_balls          END AS odi_death_balls,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE b.odi_death_runs_conceded  END AS odi_death_runs_conceded,
        CASE WHEN b.is_hundred=1 THEN NULL ELSE COALESCE(w.odi_death_wickets,0) END AS odi_death_wickets
    FROM bowl_agg b
    LEFT JOIN wkt_agg w
      ON b.match_id = w.match_id AND b.innings_number = w.innings_number AND b.bowler_id = w.bowler_id
    LEFT JOIN maiden_agg mn
      ON b.match_id = mn.match_id AND b.innings_number = mn.innings_number AND b.bowler_id = mn.bowler_id
    LEFT JOIN wkt_kind_agg wk
      ON b.match_id = wk.match_id AND b.innings_number = wk.innings_number AND b.bowler_id = wk.bowler_id
    ORDER BY b.match_date, b.match_id, b.innings_number, b.bowler_id
    """


# Phase expressions specialised for the wkt_by_ball CTE (aliased columns, not `d`).
def t20_phase_expr_wba():
    return """
    CASE
        WHEN wkt_by_ball.balls_per_over = 5 THEN
            CASE
                WHEN wkt_by_ball.legal_ordinal BETWEEN 1 AND 25   THEN 'pp'
                WHEN wkt_by_ball.legal_ordinal BETWEEN 26 AND 75  THEN 'mid'
                WHEN wkt_by_ball.legal_ordinal >= 76              THEN 'death'
            END
        ELSE
            CASE
                WHEN wkt_by_ball.over_number BETWEEN 0 AND 5  THEN 'pp'
                WHEN wkt_by_ball.over_number BETWEEN 6 AND 14 THEN 'mid'
                WHEN wkt_by_ball.over_number BETWEEN 15 AND 19 THEN 'death'
            END
    END
    """


def odi_phase_wba():
    return """
    CASE
        WHEN wkt_by_ball.balls_per_over = 5 THEN NULL
        WHEN wkt_by_ball.over_number BETWEEN 0 AND 9   THEN 'pp'
        WHEN wkt_by_ball.over_number BETWEEN 10 AND 39 THEN 'mid'
        WHEN wkt_by_ball.over_number BETWEEN 40 AND 49 THEN 'death'
    END
    """


def build_positions_cte():
    """
    Returns SQL for a `positions` CTE: one row per (match_id, innings_number,
    pid) giving `pid`'s batting_position -- the rank of first appearance at the
    crease (batter/non-striker order of first delivery, wicket-row arrivals
    ranked via wicket_index) -- EXACTLY MIRRORING sql_batting()'s own
    `appearances` / `first_app` / `positions` CTEs (see the comment there for
    the full rationale, incl. the owner ruling on wickets-only arrivals). The
    logic is duplicated verbatim rather than shared by import, because
    sql_batting()'s inline CTE feeds the already-deployed batting_innings.parquet
    and must not be touched by this (matchup-only) extension; the two are kept
    textually identical on purpose, and the dev test harness cross-checks this
    CTE's output against the real batting_innings.parquet-equivalent query.

    Requires `d` (the delivery CTE from build_delivery_cte) and `kept_innings`
    to already be in scope. Introduces CTE names prefixed `pos_` (pos_wickets,
    pos_appearances, pos_first_app) plus `positions`, chosen not to collide with
    the KINDS_IN-filtered `kept_wickets` CTE the matchup builders already define
    for dismissal-kind bucketing (that CTE serves a different, narrower purpose
    -- only bowler-credited kinds -- whereas position-of-arrival must consider
    ALL wickets rows, matching sql_batting()'s unfiltered kept_wickets).
    """
    return """
    pos_wickets AS (
        SELECT w.*
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
    ),
    pos_appearances AS (
        SELECT match_id, innings_number, batter_id AS pid,
               over_number, ball_index, 0 AS role_rank  -- striker before non-striker
        FROM d
        UNION ALL
        SELECT match_id, innings_number, non_striker_id AS pid,
               over_number, ball_index, 1 AS role_rank
        FROM d
        UNION ALL
        SELECT match_id, innings_number, player_out_id AS pid,
               over_number, ball_index, 2 + wicket_index AS role_rank
        FROM pos_wickets
    ),
    pos_first_app AS (
        SELECT match_id, innings_number, pid,
               MIN(ROW(over_number, ball_index, role_rank)) AS first_key
        FROM pos_appearances
        GROUP BY match_id, innings_number, pid
    ),
    positions AS (
        SELECT match_id, innings_number, pid,
               ROW_NUMBER() OVER (
                   PARTITION BY match_id, innings_number
                   ORDER BY first_key
               ) AS batting_position
        FROM pos_first_app
    )
    """


def sql_matchup_batting():
    """
    D4.3 batter x bowling-style. One row per
    (match_id, innings_number, batter_id, bowling_type): the batter's record
    against every distinct bowling_type they faced in that innings, keyed by the
    BOWLER's mapped style from player_profiles.

    bowling_type key = COALESCE(profile.bowling_type, profile.bowling_group,
    '(unmapped)'): a specific type when known; the pace/spin group when only that
    is known (the 10 owner-ruled "bare slow" = Spin bowlers surface here as
    'Spin'); '(unmapped)' when the bowler has no profile/style at all. The
    '(unmapped)' rows make the honest "N of M balls" denominator computable in the
    browser without a second file. bowling_group is carried alongside and is
    functionally determined by the key. Super-over innings excluded (via `d`).

    Dismissal attribution (owner ruling, to confirm at the D4 gate): a dismissal
    counts against the bowler's style ONLY for bowler-credited kinds
    ({bowled, lbw, caught, caught and bowled, stumped, hit wicket}); run-outs and
    other non-credited kinds are NOT "out to pace/spin".

    D4-R3 extension: dis_bowled/dis_lbw/dis_caught/dis_caught_and_bowled/
    dis_stumped/dis_hit_wicket are the six-way split of `dismissals` by kind
    (sum exactly to `dismissals`, per SPEC.md §4.1 / decision 23). pp_/mid_/
    death_ are T20-range phase runs+balls (over_number 0-5/6-14/15-19, via the
    shared t20_phase_expr() -- Hundred-aware); odi_pp_/odi_mid_/odi_death_ are
    the ODI-range equivalents (0-9/10-39/40-49), NULLed for the Hundred (same
    convention as batting_innings.parquet). Verified (dev harness, all formats,
    real DB): dis_* sums to dismissals row-for-row; phase trios sum to
    runs/balls_faced row-for-row for T20/IT20 and ODI/ODM rows respectively.

    D4-R4 extension: `batting_position` -- the batter's OWN position in that
    innings (order of first crease appearance, §4.2), EXACTLY the definition
    sql_batting() uses (see build_positions_cte()). Denormalized onto every
    bowling_type row of that innings; primary key UNCHANGED (a batter has one
    position per innings, regardless of how many bowling_type rows they split
    across). Verified (dev harness, real DB): 0 mismatching rows vs a direct
    join to the batting_innings-equivalent query; NOT NULL and within 1..12
    everywhere.
    """
    cte = build_delivery_cte(hundred_only=None)
    pos_cte = build_positions_cte()
    return f"""
    WITH {cte},
    {pos_cte},
    kept_wickets AS (
        SELECT w.match_id, w.innings_number, w.over_number, w.ball_index, w.kind
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
        WHERE w.kind IN ({_KINDS_IN})
    ),
    -- Credited-wicket count per delivery (mirrors the bowling export's join so
    -- totals reconcile). Credited kinds always dismiss the striker (d.batter_id).
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
    -- Dismissal-kind split, keyed identically to mb's bowling_type (same
    -- COALESCE expression, same pp alias/join) so the join back is exact.
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
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    THEN d.runs_batter ELSE 0 END) AS pp_runs,
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    AND {FACED_BATTER} THEN 1 ELSE 0 END) AS pp_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   THEN d.runs_batter ELSE 0 END) AS mid_runs,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   AND {FACED_BATTER} THEN 1 ELSE 0 END) AS mid_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' THEN d.runs_batter ELSE 0 END) AS death_runs,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' AND {FACED_BATTER} THEN 1 ELSE 0 END) AS death_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    THEN d.runs_batter ELSE 0 END) AS odi_pp_runs,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_pp_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   THEN d.runs_batter ELSE 0 END) AS odi_mid_runs,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_mid_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' THEN d.runs_batter ELSE 0 END) AS odi_death_runs,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' AND {FACED_BATTER} THEN 1 ELSE 0 END) AS odi_death_balls
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
        CASE WHEN mb.is_hundred=1 THEN NULL ELSE mb.odi_death_balls END AS odi_death_balls,
        pos.batting_position AS batting_position
    FROM mb
    LEFT JOIN dis_kind dk
      ON mb.match_id = dk.match_id AND mb.innings_number = dk.innings_number
     AND mb.batter_id = dk.batter_id AND mb.bowling_type = dk.bowling_type
    LEFT JOIN positions pos
      ON mb.match_id = pos.match_id AND mb.innings_number = pos.innings_number
     AND mb.batter_id = pos.pid
    ORDER BY mb.match_date, mb.match_id, mb.innings_number, mb.batter_id, mb.bowling_type
    """


def sql_matchup_bowling():
    """
    D4.3 bowler x batting-hand. One row per
    (match_id, innings_number, bowler_id, batting_hand): the bowler's record
    against right- vs left-handed batters, keyed by the BATTER's batting_style
    from player_profiles ('Right-hand bat' / 'Left-hand bat' / '(unmapped)').

    Components use the standard rules: legal balls (wides & no-balls excluded),
    runs_conceded = runs_batter + noballs + wides, bowler-credited wickets, dots
    (legal ball, 0 off bat), boundaries off the bat. Super-over innings excluded.

    D4-R3 extension: wkt_bowled/wkt_lbw/wkt_caught/wkt_caught_and_bowled/
    wkt_stumped/wkt_hit_wicket are the six-way split of `wickets` by kind (sum
    exactly to `wickets`). pp_/mid_/death_ are T20-range phase balls/
    runs_conceded/wickets trios (via the shared t20_phase_expr_wba() -- same
    Hundred-aware ordinal logic as bowling_innings.parquet); odi_pp_/odi_mid_/
    odi_death_ are the ODI-range equivalents, NULLed for the Hundred. Verified
    (dev harness, all formats, real DB): wkt_* sums to wickets row-for-row;
    phase trios sum to balls/runs_conceded/wickets row-for-row for T20/IT20 and
    ODI/ODM rows respectively.

    D4-R4 GRAIN CHANGE: the primary key gained a 5th column, `batting_position`
    -- the STRIKER's batting_position (§4.2, EXACTLY sql_batting()'s definition
    via build_positions_cte()) for each delivery. Every numeric column keeps
    its existing per-delivery attribution; it now simply splits across
    position buckets within a (match, innings, bowler, batting_hand) group
    instead of being summed into one row. Rolling the new grain back up to the
    OLD grain (GROUP BY match, innings, bowler, batting_hand) reproduces the
    pre-D4-R4 output exactly on every numeric column (verified in the dev
    harness against the real DB, 0 rows differing either direction).
    """
    cte = build_delivery_cte(hundred_only=None)
    pos_cte = build_positions_cte()
    return f"""
    WITH {cte},
    {pos_cte},
    kept_wickets AS (
        SELECT w.match_id, w.innings_number, w.over_number, w.ball_index, w.kind
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
        WHERE w.kind IN ({_KINDS_IN})
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
    -- style), batting_position (dismissed batter's own position, i.e. the
    -- STRIKER's position at that delivery) and kind, so the kind- and
    -- phase-wise splits share one CTE.
    wkt_by_ball AS (
        SELECT d.match_id, d.innings_number, d.bowler_id,
               COALESCE(pp.batting_style, '(unmapped)') AS batting_hand,
               pos.batting_position,
               d.over_number, d.balls_per_over, d.legal_ordinal,
               kw.kind,
               COUNT(*) AS wkts
        FROM kept_wickets kw
        JOIN d
          ON kw.match_id = d.match_id AND kw.innings_number = d.innings_number
         AND kw.over_number = d.over_number AND kw.ball_index = d.ball_index
        LEFT JOIN player_profiles pp ON d.batter_id = pp.player_id
        LEFT JOIN positions pos
          ON d.match_id = pos.match_id AND d.innings_number = pos.innings_number
         AND d.batter_id = pos.pid
        GROUP BY d.match_id, d.innings_number, d.bowler_id,
                 COALESCE(pp.batting_style, '(unmapped)'),
                 pos.batting_position,
                 d.over_number, d.balls_per_over, d.legal_ordinal, kw.kind
    ),
    wkt_agg AS (
        SELECT match_id, innings_number, bowler_id, batting_hand, batting_position,
               SUM(wkts) AS wickets,
               SUM(CASE WHEN kind = 'bowled'            THEN wkts ELSE 0 END) AS wkt_bowled,
               SUM(CASE WHEN kind = 'lbw'               THEN wkts ELSE 0 END) AS wkt_lbw,
               SUM(CASE WHEN kind = 'caught'            THEN wkts ELSE 0 END) AS wkt_caught,
               SUM(CASE WHEN kind = 'caught and bowled' THEN wkts ELSE 0 END) AS wkt_caught_and_bowled,
               SUM(CASE WHEN kind = 'stumped'           THEN wkts ELSE 0 END) AS wkt_stumped,
               SUM(CASE WHEN kind = 'hit wicket'        THEN wkts ELSE 0 END) AS wkt_hit_wicket,
               SUM(CASE WHEN ({t20_phase_expr_wba()}) = 'pp'    THEN wkts ELSE 0 END) AS pp_wickets,
               SUM(CASE WHEN ({t20_phase_expr_wba()}) = 'mid'   THEN wkts ELSE 0 END) AS mid_wickets,
               SUM(CASE WHEN ({t20_phase_expr_wba()}) = 'death' THEN wkts ELSE 0 END) AS death_wickets,
               SUM(CASE WHEN ({odi_phase_wba()}) = 'pp'    THEN wkts ELSE 0 END) AS odi_pp_wickets,
               SUM(CASE WHEN ({odi_phase_wba()}) = 'mid'   THEN wkts ELSE 0 END) AS odi_mid_wickets,
               SUM(CASE WHEN ({odi_phase_wba()}) = 'death' THEN wkts ELSE 0 END) AS odi_death_wickets
        FROM wkt_by_ball
        GROUP BY match_id, innings_number, bowler_id, batting_hand, batting_position
    ),
    mbowl AS (
        SELECT
            d.match_id, d.innings_number, d.bowler_id,
            COALESCE(pp.batting_style, '(unmapped)') AS batting_hand,
            pos.batting_position,
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
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS pp_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'pp'    THEN {BOWLER_RUNS} ELSE 0 END) AS pp_runs_conceded,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS mid_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'mid'   THEN {BOWLER_RUNS} ELSE 0 END) AS mid_runs_conceded,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS death_balls,
            SUM(CASE WHEN {t20_phase_expr()} = 'death' THEN {BOWLER_RUNS} ELSE 0 END) AS death_runs_conceded,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_pp_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'pp'    THEN {BOWLER_RUNS} ELSE 0 END) AS odi_pp_runs_conceded,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_mid_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'mid'   THEN {BOWLER_RUNS} ELSE 0 END) AS odi_mid_runs_conceded,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' AND {LEGAL_BOWLER} THEN 1 ELSE 0 END) AS odi_death_balls,
            SUM(CASE WHEN ({ODI_PHASE_OVER}) = 'death' THEN {BOWLER_RUNS} ELSE 0 END) AS odi_death_runs_conceded
        FROM d
        LEFT JOIN player_profiles pp ON d.batter_id = pp.player_id
        LEFT JOIN positions pos
          ON d.match_id = pos.match_id AND d.innings_number = pos.innings_number
         AND d.batter_id = pos.pid
        LEFT JOIN cwkt
          ON d.match_id = cwkt.match_id AND d.innings_number = cwkt.innings_number
         AND d.over_number = cwkt.over_number AND d.ball_index = cwkt.ball_index
         AND d.batter_id = cwkt.batter_id AND d.bowler_id = cwkt.bowler_id
        WHERE d.bowler_id IS NOT NULL
        GROUP BY d.match_id, d.innings_number, d.bowler_id,
                 COALESCE(pp.batting_style, '(unmapped)'),
                 pos.batting_position
    )
    SELECT
        mbowl.match_id, mbowl.innings_number, mbowl.bowler_id, mbowl.batting_hand,
        mbowl.batting_position,
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
     AND mbowl.batting_position = wk.batting_position
    ORDER BY mbowl.match_date, mbowl.match_id, mbowl.innings_number, mbowl.bowler_id,
             mbowl.batting_hand, mbowl.batting_position
    """


def sql_player_matches():
    """
    One row per (match_id, player_id): every player who PLAYED a match.

    Purpose (owner): count matches PLAYED per player. A player can be in the XI
    yet bat/bowl in no innings; in Tests/MDMs a match has multiple innings but a
    player counts ONCE per match. Also powers a "teams this player has played
    for" selector.

    Base source is `match_players` (the playing XIs). COMPLETENESS rule: also
    include any (match_id, player) that appears in `deliveries`
    (batter_id / bowler_id / non_striker_id) or in `wickets` (player_out_id) but
    is MISSING from match_players (concussion / COVID replacements etc.). For
    those derived rows we take team = the batting team (batter / non_striker /
    player_out) or the bowling team (bowler); if genuinely underivable, NULL.

    Super-over exclusion: super overs are excluded from ALL stats, so the derived
    (deliveries/wickets) side only looks at non-super-over innings. This does not
    affect match_players rows (XI membership is per match, not per innings).

    Dedup: match_players has (in this data) two (match_id, player_id) pairs listed
    under two different teams — a scorecard quirk. The PK is (match_id, player_id)
    so we collapse to one row, picking team = MIN(team) deterministically. Derived
    extra rows likewise collapse to one row per (match_id, player_id) with a
    deterministic team choice (batting-side preferred, then MIN).
    """
    return """
    WITH kept_innings AS (
        SELECT match_id, innings_number, batting_team
        FROM innings
        WHERE super_over IS NOT TRUE
    ),
    m_ctx AS (
        SELECT
            match_id, team_1, team_2,
            match_type, gender, team_type,
            match_date_1 AS match_date,
            CAST(EXTRACT(year  FROM match_date_1) AS INTEGER) AS year,
            CAST(EXTRACT(month FROM match_date_1) AS INTEGER) AS month
        FROM matches
    ),
    -- Base XI membership, one row per (match, player). Two known dup pairs list
    -- a player under two teams; collapse deterministically with MIN(team).
    base AS (
        SELECT match_id, player_id,
               ANY_VALUE(player_name) AS player_name,
               MIN(team) AS team
        FROM match_players
        WHERE player_id IS NOT NULL
        GROUP BY match_id, player_id
    ),
    -- COMPLETENESS: active players from kept (non-super-over) deliveries/wickets
    -- with a derived candidate team. batter / non_striker / player_out -> the
    -- batting team; bowler -> the NON-batting team (the other of team_1/team_2).
    active AS (
        SELECT ki.match_id, dv.batter_id AS pid, dv.batter AS pname,
               ki.batting_team AS team, 0 AS side
        FROM deliveries dv
        JOIN kept_innings ki
          ON dv.match_id = ki.match_id AND dv.innings_number = ki.innings_number
        WHERE dv.batter_id IS NOT NULL
        UNION ALL
        SELECT ki.match_id, dv.non_striker_id AS pid, dv.non_striker AS pname,
               ki.batting_team AS team, 0 AS side
        FROM deliveries dv
        JOIN kept_innings ki
          ON dv.match_id = ki.match_id AND dv.innings_number = ki.innings_number
        WHERE dv.non_striker_id IS NOT NULL
        UNION ALL
        SELECT ki.match_id, w.player_out_id AS pid, w.player_out AS pname,
               ki.batting_team AS team, 0 AS side
        FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
        WHERE w.player_out_id IS NOT NULL
        UNION ALL
        SELECT ki.match_id, dv.bowler_id AS pid, dv.bowler AS pname,
               CASE WHEN mc.team_1 = ki.batting_team THEN mc.team_2 ELSE mc.team_1 END AS team,
               1 AS side
        FROM deliveries dv
        JOIN kept_innings ki
          ON dv.match_id = ki.match_id AND dv.innings_number = ki.innings_number
        JOIN m_ctx mc ON dv.match_id = mc.match_id
        WHERE dv.bowler_id IS NOT NULL
    ),
    -- Extra rows: active players NOT already in the XI base. Collapse to one row
    -- per (match, player); prefer the batting-side team (side=0) deterministically,
    -- then MIN(team). Name from the delivery/wicket record.
    extra AS (
        SELECT a.match_id, a.pid AS player_id,
               ANY_VALUE(a.pname) AS player_name,
               MIN(a.team) AS team_any,
               MIN(CASE WHEN a.side = 0 THEN a.team END) AS team_bat
        FROM active a
        LEFT JOIN base b
          ON a.match_id = b.match_id AND a.pid = b.player_id
        WHERE b.player_id IS NULL
        GROUP BY a.match_id, a.pid
    ),
    combined AS (
        SELECT match_id, player_id, player_name, team FROM base
        UNION ALL
        SELECT match_id, player_id, player_name,
               COALESCE(team_bat, team_any) AS team
        FROM extra
    )
    SELECT
        c.match_id,
        c.player_id,
        c.player_name,
        c.team,
        mc.match_type,
        mc.gender,
        mc.team_type,
        mc.match_date,
        mc.year,
        mc.month
    FROM combined c
    JOIN m_ctx mc ON c.match_id = mc.match_id
    ORDER BY mc.match_date, c.match_id, c.player_id
    """


# ---------------------------------------------------------------------------
# Parquet writing
# ---------------------------------------------------------------------------

def write_parquet(con, select_sql, out_path):
    con.execute(
        f"COPY ({select_sql}) TO '{out_path}' "
        f"(FORMAT PARQUET, COMPRESSION '{COMPRESSION}', ROW_GROUP_SIZE {ROW_GROUP_SIZE})"
    )


# ---------------------------------------------------------------------------
# Validation gates
# ---------------------------------------------------------------------------

def gate(cond, name, detail=""):
    if cond:
        log(f"  PASS  {name}")
    else:
        raise GateError(f"{name} :: {detail}")


def run_gates(con, out_dir):
    log("Running validation gates ...")

    def rows(fname):
        p = os.path.join(out_dir, fname)
        return con.execute(f"SELECT COUNT(*) FROM read_parquet('{p}')").fetchone()[0]

    def q(sql):
        return con.execute(sql).fetchone()[0]

    paths = {f: os.path.join(out_dir, f) for f in EXPORT_FILES}

    # --- Gate 1: every file row count > 0 ---
    for f in EXPORT_FILES:
        n = rows(f)
        gate(n > 0, f"row_count>0 [{f}]", f"got {n}")

    # --- Gate 2: no duplicate primary keys ---
    for f, pk in EXPORT_FILES.items():
        p = paths[f]
        pk_cols = ", ".join(pk)
        dups = q(
            f"SELECT COUNT(*) FROM (SELECT {pk_cols} FROM read_parquet('{p}') "
            f"GROUP BY {pk_cols} HAVING COUNT(*) > 1)"
        )
        gate(dups == 0, f"no_dup_pk [{f}]", f"{dups} duplicated PK groups")

    # --- Reference totals from deliveries (non-super-over only) ---
    ref_cte = """
    WITH kept_innings AS (
        SELECT match_id, innings_number FROM innings WHERE super_over IS NOT TRUE
    ),
    d AS (
        SELECT dv.* FROM deliveries dv
        JOIN kept_innings ki
          ON dv.match_id = ki.match_id AND dv.innings_number = ki.innings_number
    )
    """

    ref_runs = q(f"{ref_cte} SELECT SUM(runs_batter) FROM d")
    ref_balls_faced = q(f"{ref_cte} SELECT COUNT(*) FROM d WHERE wides IS NULL")
    ref_conceded = q(
        f"{ref_cte} SELECT SUM(runs_batter + COALESCE(noballs,0) + COALESCE(wides,0)) FROM d"
    )
    ref_wkts = q(
        f"""
        WITH kept_innings AS (
            SELECT match_id, innings_number FROM innings WHERE super_over IS NOT TRUE
        )
        SELECT COUNT(*) FROM wickets w
        JOIN kept_innings ki
          ON w.match_id = ki.match_id AND w.innings_number = ki.innings_number
        WHERE w.kind IN ({_KINDS_IN})
        """
    )

    bat_p = paths["batting_innings.parquet"]
    bowl_p = paths["bowling_innings.parquet"]

    sum_runs = q(f"SELECT SUM(runs) FROM read_parquet('{bat_p}')")
    sum_bf = q(f"SELECT SUM(balls_faced) FROM read_parquet('{bat_p}')")
    sum_conceded = q(f"SELECT SUM(runs_conceded) FROM read_parquet('{bowl_p}')")
    sum_wkts = q(f"SELECT SUM(wickets) FROM read_parquet('{bowl_p}')")

    gate(sum_runs == ref_runs, "batting_runs == SUM(runs_batter)",
         f"{sum_runs} vs {ref_runs}")
    gate(sum_bf == ref_balls_faced, "balls_faced == COUNT(wides IS NULL)",
         f"{sum_bf} vs {ref_balls_faced}")
    gate(sum_conceded == ref_conceded, "runs_conceded == SUM(bat+nb+wd)",
         f"{sum_conceded} vs {ref_conceded}")
    gate(sum_wkts == ref_wkts, "bowling_wickets == credited-kind wickets rows",
         f"{sum_wkts} vs {ref_wkts}")

    # --- Gate: batting rows == independent distinct crease-appearance count ---
    indep = q(
        f"""
        WITH kept_innings AS (
            SELECT match_id, innings_number FROM innings WHERE super_over IS NOT TRUE
        ),
        d AS (
            SELECT dv.match_id, dv.innings_number, dv.batter_id, dv.non_striker_id
            FROM deliveries dv JOIN kept_innings ki
              ON dv.match_id=ki.match_id AND dv.innings_number=ki.innings_number
        ),
        kw AS (
            SELECT w.match_id, w.innings_number, w.player_out_id
            FROM wickets w JOIN kept_innings ki
              ON w.match_id=ki.match_id AND w.innings_number=ki.innings_number
        ),
        crease AS (
            SELECT match_id, innings_number, batter_id AS pid FROM d
            UNION
            SELECT match_id, innings_number, non_striker_id AS pid FROM d
            UNION
            SELECT match_id, innings_number, player_out_id AS pid FROM kw
        )
        SELECT COUNT(*) FROM (SELECT DISTINCT match_id, innings_number, pid FROM crease)
        """
    )
    bat_rows = rows("batting_innings.parquet")
    gate(bat_rows == indep, "batting_rows == crease-appearance count",
         f"{bat_rows} vs {indep}")

    # Every crease appearance gets a batting position (owner ruling).
    null_pos = q(
        f"SELECT COUNT(*) FROM read_parquet('{bat_p}') WHERE batting_position IS NULL"
    )
    gate(null_pos == 0, "batting_position never NULL", f"{null_pos} NULL positions")

    # --- Gate: Hundred sanity ---
    # For balls_per_over=5 matches, every odi_* column IS NULL in both files,
    # and SUM(pp_balls) per innings <= 25 in bowling_innings.
    hundred_ids_sql = "SELECT match_id FROM matches WHERE balls_per_over = 5"

    # odi_* NULL check (batting)
    bad_bat_odi = q(
        f"""
        SELECT COUNT(*) FROM read_parquet('{bat_p}')
        WHERE match_id IN ({hundred_ids_sql})
          AND (odi_pp_runs IS NOT NULL OR odi_pp_balls IS NOT NULL
            OR odi_mid_runs IS NOT NULL OR odi_mid_balls IS NOT NULL
            OR odi_death_runs IS NOT NULL OR odi_death_balls IS NOT NULL)
        """
    )
    gate(bad_bat_odi == 0, "hundred batting odi_* all NULL", f"{bad_bat_odi} bad rows")

    bad_bowl_odi = q(
        f"""
        SELECT COUNT(*) FROM read_parquet('{bowl_p}')
        WHERE match_id IN ({hundred_ids_sql})
          AND (odi_pp_balls IS NOT NULL OR odi_pp_runs_conceded IS NOT NULL OR odi_pp_wickets IS NOT NULL
            OR odi_mid_balls IS NOT NULL OR odi_mid_runs_conceded IS NOT NULL OR odi_mid_wickets IS NOT NULL
            OR odi_death_balls IS NOT NULL OR odi_death_runs_conceded IS NOT NULL OR odi_death_wickets IS NOT NULL)
        """
    )
    gate(bad_bowl_odi == 0, "hundred bowling odi_* all NULL", f"{bad_bowl_odi} bad rows")

    # SUM(pp_balls) per innings <= 25 in bowling for the Hundred
    over_pp = q(
        f"""
        SELECT COUNT(*) FROM (
            SELECT match_id, innings_number, SUM(pp_balls) AS s
            FROM read_parquet('{bowl_p}')
            WHERE match_id IN ({hundred_ids_sql})
            GROUP BY match_id, innings_number
            HAVING SUM(pp_balls) > 25
        )
        """
    )
    gate(over_pp == 0, "hundred bowling SUM(pp_balls)<=25 per innings",
         f"{over_pp} innings exceed 25")

    # Phase completeness: in Hundred matches every delivery belongs to a T20
    # phase (legal-ball ordinal 1..100), so the phase splits must sum exactly
    # to the totals. Guards the first-ball-wide ordinal edge case.
    hundred_phase_gap = q(
        f"""
        SELECT COUNT(*) FROM read_parquet('{bowl_p}')
        WHERE match_id IN ({hundred_ids_sql})
          AND (pp_runs_conceded + mid_runs_conceded + death_runs_conceded != runs_conceded
            OR pp_balls + mid_balls + death_balls != balls)
        """
    )
    gate(hundred_phase_gap == 0, "hundred phase splits sum to totals",
         f"{hundred_phase_gap} bowling rows with phase gaps")

    # --- Gate: bowler wicket-type breakdown sums to total wickets ---
    wk_split_bad = q(
        f"""
        SELECT COUNT(*) FROM read_parquet('{bowl_p}')
        WHERE wickets_bowled + wickets_lbw + wickets_caught
            + wickets_caught_and_bowled + wickets_stumped + wickets_hit_wicket
            != wickets
        """
    )
    gate(wk_split_bad == 0, "wicket-type split sums to wickets (per row)",
         f"{wk_split_bad} bowling rows mismatch")

    # --- Gate: innings-progression buckets sum to balls_faced / runs ---
    prog_bad = q(
        f"""
        SELECT COUNT(*) FROM read_parquet('{bat_p}')
        WHERE fb1_10_balls + fb11_20_balls + fb21p_balls != balls_faced
           OR fb1_10_runs  + fb11_20_runs  + fb21p_runs  != runs
        """
    )
    gate(prog_bad == 0, "progression buckets sum to balls_faced/runs (per row)",
         f"{prog_bad} batting rows mismatch")

    # --- Matchup files: totals reconcile to the raw deliveries ---
    ref_balls_bowled = q(
        f"{ref_cte} SELECT COUNT(*) FROM d WHERE wides IS NULL AND noballs IS NULL"
    )
    mbat_p = paths["matchup_batting.parquet"]
    mbowl_p = paths["matchup_bowling.parquet"]

    mbat_bf = q(f"SELECT SUM(balls_faced) FROM read_parquet('{mbat_p}')")
    mbat_runs = q(f"SELECT SUM(runs) FROM read_parquet('{mbat_p}')")
    mbat_dis = q(f"SELECT SUM(dismissals) FROM read_parquet('{mbat_p}')")
    gate(mbat_bf == ref_balls_faced, "matchup_batting balls == faced balls",
         f"{mbat_bf} vs {ref_balls_faced}")
    gate(mbat_runs == ref_runs, "matchup_batting runs == SUM(runs_batter)",
         f"{mbat_runs} vs {ref_runs}")
    gate(mbat_dis == ref_wkts, "matchup_batting dismissals == credited wickets",
         f"{mbat_dis} vs {ref_wkts}")

    mbowl_balls = q(f"SELECT SUM(balls) FROM read_parquet('{mbowl_p}')")
    mbowl_conceded = q(f"SELECT SUM(runs_conceded) FROM read_parquet('{mbowl_p}')")
    mbowl_wkts = q(f"SELECT SUM(wickets) FROM read_parquet('{mbowl_p}')")
    gate(mbowl_balls == ref_balls_bowled, "matchup_bowling balls == legal balls",
         f"{mbowl_balls} vs {ref_balls_bowled}")
    gate(mbowl_conceded == ref_conceded, "matchup_bowling runs_conceded == SUM(bat+nb+wd)",
         f"{mbowl_conceded} vs {ref_conceded}")
    gate(mbowl_wkts == ref_wkts, "matchup_bowling wickets == credited wickets",
         f"{mbowl_wkts} vs {ref_wkts}")

    # --- D4-R3: dismissal/wicket-kind splits + phase trios reconcile ---
    mbat_dis_split = q(
        f"""SELECT SUM(dis_bowled + dis_lbw + dis_caught + dis_caught_and_bowled
                        + dis_stumped + dis_hit_wicket)
            FROM read_parquet('{mbat_p}')"""
    )
    gate(mbat_dis_split == mbat_dis,
         "matchup_batting dis_* six-way split == dismissals (global)",
         f"{mbat_dis_split} vs {mbat_dis}")

    mbowl_wkt_split = q(
        f"""SELECT SUM(wkt_bowled + wkt_lbw + wkt_caught + wkt_caught_and_bowled
                        + wkt_stumped + wkt_hit_wicket)
            FROM read_parquet('{mbowl_p}')"""
    )
    gate(mbowl_wkt_split == mbowl_wkts,
         "matchup_bowling wkt_* six-way split == wickets (global)",
         f"{mbowl_wkt_split} vs {mbowl_wkts}")

    mbat_t20_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{mbat_p}')
            WHERE match_type IN ('T20','IT20')
              AND (pp_runs + mid_runs + death_runs != runs
                   OR pp_balls + mid_balls + death_balls != balls_faced)"""
    )
    gate(mbat_t20_bad == 0,
         "matchup_batting T20/IT20 phase splits sum to runs/balls_faced",
         f"{mbat_t20_bad} mismatched rows")

    mbat_odi_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{mbat_p}')
            WHERE match_type IN ('ODI','ODM')
              AND (odi_pp_runs + odi_mid_runs + odi_death_runs != runs
                   OR odi_pp_balls + odi_mid_balls + odi_death_balls != balls_faced)"""
    )
    gate(mbat_odi_bad == 0,
         "matchup_batting ODI/ODM phase splits sum to runs/balls_faced",
         f"{mbat_odi_bad} mismatched rows")

    mbowl_t20_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{mbowl_p}')
            WHERE match_type IN ('T20','IT20')
              AND (pp_balls + mid_balls + death_balls != balls
                   OR pp_runs_conceded + mid_runs_conceded + death_runs_conceded != runs_conceded
                   OR pp_wickets + mid_wickets + death_wickets != wickets)"""
    )
    gate(mbowl_t20_bad == 0,
         "matchup_bowling T20/IT20 phase splits sum to balls/runs_conceded/wickets",
         f"{mbowl_t20_bad} mismatched rows")

    mbowl_odi_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{mbowl_p}')
            WHERE match_type IN ('ODI','ODM')
              AND (odi_pp_balls + odi_mid_balls + odi_death_balls != balls
                   OR odi_pp_runs_conceded + odi_mid_runs_conceded + odi_death_runs_conceded != runs_conceded
                   OR odi_pp_wickets + odi_mid_wickets + odi_death_wickets != wickets)"""
    )
    gate(mbowl_odi_bad == 0,
         "matchup_bowling ODI/ODM phase splits sum to balls/runs_conceded/wickets",
         f"{mbowl_odi_bad} mismatched rows")

    # --- D4-R4: batting_position validity (matchup_batting + matchup_bowling) ---
    # batting_position is the batter's/striker's rank of first crease
    # appearance (§4.2); every crease appearance gets one (owner ruling, same
    # as batting_innings.parquet's own gate), so it must never be NULL and
    # must fall within a plausible XI+substitutes range.
    mbat_pos_null = q(
        f"SELECT COUNT(*) FROM read_parquet('{mbat_p}') WHERE batting_position IS NULL"
    )
    gate(mbat_pos_null == 0, "matchup_batting batting_position never NULL",
         f"{mbat_pos_null} NULL positions")

    mbat_pos_range = q(
        f"SELECT COUNT(*) FROM read_parquet('{mbat_p}') WHERE batting_position NOT BETWEEN 1 AND 12"
    )
    gate(mbat_pos_range == 0, "matchup_batting batting_position within 1..12",
         f"{mbat_pos_range} out-of-range rows")

    mbowl_pos_null = q(
        f"SELECT COUNT(*) FROM read_parquet('{mbowl_p}') WHERE batting_position IS NULL"
    )
    gate(mbowl_pos_null == 0, "matchup_bowling batting_position never NULL",
         f"{mbowl_pos_null} NULL positions")

    mbowl_pos_range = q(
        f"SELECT COUNT(*) FROM read_parquet('{mbowl_p}') WHERE batting_position NOT BETWEEN 1 AND 12"
    )
    gate(mbowl_pos_range == 0, "matchup_bowling batting_position within 1..12",
         f"{mbowl_pos_range} out-of-range rows")

    # --- D4-R4: matchup_bowling rollup-preservation (global SUMs of every
    # numeric column vs the deliveries-derived reference totals). balls /
    # runs_conceded / wickets are already gated above (unaffected by the grain
    # change: a global SUM is grain-agnostic). Extend to the remaining
    # per-delivery numeric columns not previously globally gated here.
    ref_dots = q(f"{ref_cte} SELECT COUNT(*) FROM d WHERE {LEGAL_BOWLER} AND d.runs_batter = 0")
    ref_fours = q(f"{ref_cte} SELECT COUNT(*) FROM d WHERE {HIT_BOUNDARY_4}")
    ref_sixes = q(f"{ref_cte} SELECT COUNT(*) FROM d WHERE {HIT_BOUNDARY_6}")

    mbowl_dots = q(f"SELECT SUM(dots) FROM read_parquet('{mbowl_p}')")
    mbowl_fours = q(f"SELECT SUM(fours_conceded) FROM read_parquet('{mbowl_p}')")
    mbowl_sixes = q(f"SELECT SUM(sixes_conceded) FROM read_parquet('{mbowl_p}')")
    gate(mbowl_dots == ref_dots,
         "matchup_bowling dots == legal 0-run balls (rollup-preservation, global)",
         f"{mbowl_dots} vs {ref_dots}")
    gate(mbowl_fours == ref_fours,
         "matchup_bowling fours_conceded == boundary 4s (rollup-preservation, global)",
         f"{mbowl_fours} vs {ref_fours}")
    gate(mbowl_sixes == ref_sixes,
         "matchup_bowling sixes_conceded == boundary 6s (rollup-preservation, global)",
         f"{mbowl_sixes} vs {ref_sixes}")

    # --- Coverage scope identity (task-required): a specific slice reconciles ---
    # Men's T20 (match_type='T20') in 2024: matchup_batting faced balls (all
    # bowling_type buckets incl. '(unmapped)') must equal batting_innings faced
    # balls for the same slice. This proves the '(unmapped)' bucket makes the
    # honest N-of-M denominator exact.
    scope = "gender='male' AND match_type='T20' AND year=2024"
    mbat_scope = q(
        f"SELECT COALESCE(SUM(balls_faced),0) FROM read_parquet('{mbat_p}') WHERE {scope}"
    )
    bat_scope = q(
        f"SELECT COALESCE(SUM(balls_faced),0) FROM read_parquet('{bat_p}') WHERE {scope}"
    )
    gate(mbat_scope == bat_scope,
         "matchup_batting scope balls == batting scope balls (men T20 2024)",
         f"{mbat_scope} vs {bat_scope}")

    # Coverage is meaningful: for men, mapped (non-'(unmapped)') balls are a large
    # majority; for women, effectively zero. Assert the men's mapped share is high
    # and women's is ~0 so a regression in profile joining is caught.
    male_mapped = q(
        f"""SELECT COALESCE(SUM(CASE WHEN bowling_type <> '(unmapped)' THEN balls_faced ELSE 0 END),0)
                 * 100.0 / NULLIF(SUM(balls_faced),0)
            FROM read_parquet('{mbat_p}') WHERE gender='male'"""
    )
    female_mapped = q(
        f"""SELECT COALESCE(SUM(CASE WHEN bowling_type <> '(unmapped)' THEN balls_faced ELSE 0 END),0)
                 * 100.0 / NULLIF(SUM(balls_faced),0)
            FROM read_parquet('{mbat_p}') WHERE gender='female'"""
    )
    gate(male_mapped is not None and male_mapped > 70,
         "matchup_batting men mapped-style share > 70%", f"got {male_mapped}")
    gate(female_mapped is None or female_mapped < 1,
         "matchup_batting women mapped-style share < 1%", f"got {female_mapped}")

    # --- player_matches gates ---
    pm_p = paths["player_matches.parquet"]

    # Gate 1a (coverage): every (match_id, batter_id) in batting_innings must
    # exist in player_matches. This also folds in the matches-vs-innings sanity
    # (gate 3): if every batting (match, batter) is covered, then the set of
    # distinct match_ids in batting_innings is a subset of those covered, so
    # SUM over players of matches-played >= distinct-match coverage of batting.
    bat_missing = q(
        f"""
        SELECT COUNT(*) FROM (
            SELECT DISTINCT match_id, batter_id FROM read_parquet('{bat_p}')
        ) b
        LEFT JOIN read_parquet('{pm_p}') pm
          ON b.match_id = pm.match_id AND b.batter_id = pm.player_id
        WHERE pm.player_id IS NULL
        """
    )
    gate(bat_missing == 0, "player_matches covers all batting (match,batter)",
         f"{bat_missing} batting (match,batter) pairs missing from player_matches")

    # Gate 1b (coverage): every (match_id, bowler_id) in bowling_innings must
    # exist in player_matches.
    bowl_missing = q(
        f"""
        SELECT COUNT(*) FROM (
            SELECT DISTINCT match_id, bowler_id FROM read_parquet('{bowl_p}')
        ) b
        LEFT JOIN read_parquet('{pm_p}') pm
          ON b.match_id = pm.match_id AND b.bowler_id = pm.player_id
        WHERE pm.player_id IS NULL
        """
    )
    gate(bowl_missing == 0, "player_matches covers all bowling (match,bowler)",
         f"{bowl_missing} bowling (match,bowler) pairs missing from player_matches")

    # Gate 2 (XI sanity): count (match, team) groups where a team has != 11 rows
    # with a non-null team. Historical data legitimately has XII / substitutes,
    # so this is a WARNING, never a hard failure.
    xi_anomalies = q(
        f"""
        SELECT COUNT(*) FROM (
            SELECT match_id, team
            FROM read_parquet('{pm_p}')
            WHERE team IS NOT NULL
            GROUP BY match_id, team
            HAVING COUNT(*) != 11
        )
        """
    )
    total_team_groups = q(
        f"""
        SELECT COUNT(*) FROM (
            SELECT DISTINCT match_id, team FROM read_parquet('{pm_p}')
            WHERE team IS NOT NULL
        )
        """
    )
    log(f"  WARN  XI sanity: {xi_anomalies} of {total_team_groups} (match,team) "
        f"groups have != 11 players (not a failure; XII/substitutes/data quirks)")

    # =========================================================================
    # Pipeline safety net (owner-approved batch, 2026-07-09) — additive gates.
    # None of these change any export SQL; they only add cross-checks.
    # =========================================================================

    # --- (a) Cross-file rollup gates: matchup files rolled up to the
    # foundational grain must equal the foundational file row-for-row.
    #
    # Hypothesis verified against the real DB before writing this gate (both
    # directions, 0 mismatches either way):
    #   matchup_bowling summed over (batting_hand, batting_position) ==
    #     bowling_innings on balls/runs_conceded/wickets/dots/fours_conceded/
    #     sixes_conceded. Both use the same universe (`d WHERE bowler_id IS
    #     NOT NULL`), so the rollup is exact -- no carve-out needed.
    #   matchup_batting summed over (bowling_type) == batting_innings on
    #     runs/balls_faced/dots/fours_hit/sixes_hit. matchup_batting has NO
    #     row at all for a batting_innings row that never faced a ball as
    #     striker (e.g. run out at the non-striker's end, 0 runs/0 balls) --
    #     but such rows are legitimately all-zero, so COALESCE(rollup,0)
    #     still matches exactly; verified 4,450 such rows in the real DB, all
    #     reconciling to 0. Dismissals are DELIBERATELY NOT gated here
    #     (matchup dismissals are bowler-credited only, a subset of the
    #     dismissed flag — SPEC.md §4.1 / decision 23).
    mbowl_rollup = q(
        f"""
        WITH rollup AS (
            SELECT match_id, innings_number, bowler_id,
                   SUM(balls) AS balls, SUM(runs_conceded) AS runs_conceded,
                   SUM(wickets) AS wickets, SUM(dots) AS dots,
                   SUM(fours_conceded) AS fours_conceded, SUM(sixes_conceded) AS sixes_conceded
            FROM read_parquet('{mbowl_p}')
            GROUP BY match_id, innings_number, bowler_id
        )
        SELECT COUNT(*) FROM read_parquet('{bowl_p}') bi
        LEFT JOIN rollup r
          ON bi.match_id = r.match_id AND bi.innings_number = r.innings_number
         AND bi.bowler_id = r.bowler_id
        WHERE COALESCE(r.balls, 0) <> bi.balls
           OR COALESCE(r.runs_conceded, 0) <> bi.runs_conceded
           OR COALESCE(r.wickets, 0) <> bi.wickets
           OR COALESCE(r.dots, 0) <> bi.dots
           OR COALESCE(r.fours_conceded, 0) <> bi.fours_conceded
           OR COALESCE(r.sixes_conceded, 0) <> bi.sixes_conceded
        """
    )
    gate(mbowl_rollup == 0,
         "matchup_bowling rolled up to (match,inn,bowler) == bowling_innings "
         "(balls/runs_conceded/wickets/dots/fours_conceded/sixes_conceded)",
         f"{mbowl_rollup} mismatched bowling_innings rows")

    mbowl_orphan = q(
        f"""
        SELECT COUNT(*) FROM (
            SELECT DISTINCT match_id, innings_number, bowler_id FROM read_parquet('{mbowl_p}')
        ) r
        LEFT JOIN read_parquet('{bowl_p}') bi
          ON r.match_id = bi.match_id AND r.innings_number = bi.innings_number
         AND r.bowler_id = bi.bowler_id
        WHERE bi.bowler_id IS NULL
        """
    )
    gate(mbowl_orphan == 0,
         "matchup_bowling has no (match,inn,bowler) absent from bowling_innings",
         f"{mbowl_orphan} orphan groups")

    mbat_rollup = q(
        f"""
        WITH rollup AS (
            SELECT match_id, innings_number, batter_id,
                   SUM(runs) AS runs, SUM(balls_faced) AS balls_faced,
                   SUM(dots) AS dots, SUM(fours_hit) AS fours_hit, SUM(sixes_hit) AS sixes_hit
            FROM read_parquet('{mbat_p}')
            GROUP BY match_id, innings_number, batter_id
        )
        SELECT COUNT(*) FROM read_parquet('{bat_p}') bi
        LEFT JOIN rollup r
          ON bi.match_id = r.match_id AND bi.innings_number = r.innings_number
         AND bi.batter_id = r.batter_id
        WHERE COALESCE(r.runs, 0) <> bi.runs
           OR COALESCE(r.balls_faced, 0) <> bi.balls_faced
           OR COALESCE(r.dots, 0) <> bi.dots
           OR COALESCE(r.fours_hit, 0) <> bi.fours_hit
           OR COALESCE(r.sixes_hit, 0) <> bi.sixes_hit
        """
    )
    gate(mbat_rollup == 0,
         "matchup_batting rolled up to (match,inn,batter) == batting_innings "
         "(runs/balls_faced/dots/fours_hit/sixes_hit; dismissals deliberately excluded)",
         f"{mbat_rollup} mismatched batting_innings rows")

    mbat_orphan = q(
        f"""
        SELECT COUNT(*) FROM (
            SELECT DISTINCT match_id, innings_number, batter_id FROM read_parquet('{mbat_p}')
        ) r
        LEFT JOIN read_parquet('{bat_p}') bi
          ON r.match_id = bi.match_id AND r.innings_number = bi.innings_number
         AND r.batter_id = bi.batter_id
        WHERE bi.batter_id IS NULL
        """
    )
    gate(mbat_orphan == 0,
         "matchup_batting has no (match,inn,batter) absent from batting_innings",
         f"{mbat_orphan} orphan groups")

    # --- (b) Position cross-check: matchup_batting's own batting_position must
    # agree with batting_innings.batting_position for every (match,inn,batter).
    mbat_pos_mismatch = q(
        f"""
        SELECT COUNT(*) FROM read_parquet('{mbat_p}') mb
        JOIN read_parquet('{bat_p}') bi
          ON mb.match_id = bi.match_id AND mb.innings_number = bi.innings_number
         AND mb.batter_id = bi.batter_id
        WHERE mb.batting_position <> bi.batting_position
        """
    )
    gate(mbat_pos_mismatch == 0,
         "matchup_batting.batting_position == batting_innings.batting_position (per row)",
         f"{mbat_pos_mismatch} mismatched rows")

    # --- (c) Phase-sum gates on the foundational files, mirroring the
    # existing matchup phase-gate pattern (match_type IN (...) includes the
    # Hundred, since The Hundred is stored with match_type='T20'; its rows
    # already reconcile because t20_phase_expr() branches to the Hundred's
    # legal-ball-ordinal windows -- verified 0 mismatches against the real DB).
    bat_t20_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{bat_p}')
            WHERE match_type IN ('T20','IT20')
              AND (pp_runs + mid_runs + death_runs != runs
                   OR pp_balls + mid_balls + death_balls != balls_faced)"""
    )
    gate(bat_t20_bad == 0,
         "batting_innings T20/IT20 phase splits sum to runs/balls_faced",
         f"{bat_t20_bad} mismatched rows")

    bat_odi_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{bat_p}')
            WHERE match_type IN ('ODI','ODM')
              AND (odi_pp_runs + odi_mid_runs + odi_death_runs != runs
                   OR odi_pp_balls + odi_mid_balls + odi_death_balls != balls_faced)"""
    )
    gate(bat_odi_bad == 0,
         "batting_innings ODI/ODM phase splits sum to runs/balls_faced",
         f"{bat_odi_bad} mismatched rows")

    bowl_t20_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{bowl_p}')
            WHERE match_type IN ('T20','IT20')
              AND (pp_balls + mid_balls + death_balls != balls
                   OR pp_runs_conceded + mid_runs_conceded + death_runs_conceded != runs_conceded
                   OR pp_wickets + mid_wickets + death_wickets != wickets)"""
    )
    gate(bowl_t20_bad == 0,
         "bowling_innings T20/IT20 phase splits sum to balls/runs_conceded/wickets",
         f"{bowl_t20_bad} mismatched rows")

    bowl_odi_bad = q(
        f"""SELECT COUNT(*) FROM read_parquet('{bowl_p}')
            WHERE match_type IN ('ODI','ODM')
              AND (odi_pp_balls + odi_mid_balls + odi_death_balls != balls
                   OR odi_pp_runs_conceded + odi_mid_runs_conceded + odi_death_runs_conceded != runs_conceded
                   OR odi_pp_wickets + odi_mid_wickets + odi_death_wickets != wickets)"""
    )
    gate(bowl_odi_bad == 0,
         "bowling_innings ODI/ODM phase splits sum to balls/runs_conceded/wickets",
         f"{bowl_odi_bad} mismatched rows")

    # --- (d) Global reconciliation gates vs deliveries for previously-ungated
    # columns. `ref_dots`/`ref_fours`/`ref_sixes` (bowler-side dots + shared
    # boundary counts) are already computed above for the D4-R4 matchup gates;
    # reuse them here. Batting-side dots uses FACED_BATTER (wides IS NULL
    # only), a different legality predicate from bowling-side dots
    # (LEGAL_BOWLER), so it needs its own reference.
    ref_dots_bat = q(f"{ref_cte} SELECT COUNT(*) FROM d WHERE {FACED_BATTER} AND d.runs_batter = 0")
    ref_wides_runs = q(f"{ref_cte} SELECT SUM(COALESCE(d.wides, 0)) FROM d")
    ref_noball_runs = q(f"{ref_cte} SELECT SUM(COALESCE(d.noballs, 0)) FROM d")
    # Independent maiden reference: a complete over (balls_per_over legal
    # balls, one bowler) conceding 0 runs (bat+wides+noballs) -- same
    # definition as sql_bowling()'s over_sets/maiden_agg, re-derived from
    # scratch here (not imported) so the gate is a genuine cross-check.
    ref_maidens = q(
        f"""
        WITH kept_innings AS (
            SELECT match_id, innings_number FROM innings WHERE super_over IS NOT TRUE
        ),
        d AS (
            SELECT dv.*, m.balls_per_over FROM deliveries dv
            JOIN kept_innings ki
              ON dv.match_id = ki.match_id AND dv.innings_number = ki.innings_number
            JOIN matches m ON dv.match_id = m.match_id
        ),
        over_sets AS (
            SELECT match_id, innings_number, over_number, bowler_id,
                   ANY_VALUE(balls_per_over) AS bpo,
                   SUM(CASE WHEN wides IS NULL AND noballs IS NULL THEN 1 ELSE 0 END) AS legal_balls,
                   SUM(runs_batter + COALESCE(noballs,0) + COALESCE(wides,0)) AS conceded
            FROM d
            GROUP BY match_id, innings_number, over_number, bowler_id
        )
        SELECT COUNT(*) FROM over_sets WHERE legal_balls = bpo AND conceded = 0
        """
    )

    sum_dots_bat = q(f"SELECT SUM(dots) FROM read_parquet('{bat_p}')")
    sum_fours_hit = q(f"SELECT SUM(fours_hit) FROM read_parquet('{bat_p}')")
    sum_sixes_hit = q(f"SELECT SUM(sixes_hit) FROM read_parquet('{bat_p}')")
    sum_dots_bowl = q(f"SELECT SUM(dots) FROM read_parquet('{bowl_p}')")
    sum_fours_conceded = q(f"SELECT SUM(fours_conceded) FROM read_parquet('{bowl_p}')")
    sum_sixes_conceded = q(f"SELECT SUM(sixes_conceded) FROM read_parquet('{bowl_p}')")
    sum_maidens = q(f"SELECT SUM(maidens) FROM read_parquet('{bowl_p}')")
    sum_wides_runs = q(f"SELECT SUM(wides_runs) FROM read_parquet('{bowl_p}')")
    sum_noball_runs = q(f"SELECT SUM(noball_runs) FROM read_parquet('{bowl_p}')")

    gate(sum_dots_bat == ref_dots_bat, "batting_innings dots == faced 0-run balls (global)",
         f"{sum_dots_bat} vs {ref_dots_bat}")
    gate(sum_fours_hit == ref_fours, "batting_innings fours_hit == boundary 4s (global)",
         f"{sum_fours_hit} vs {ref_fours}")
    gate(sum_sixes_hit == ref_sixes, "batting_innings sixes_hit == boundary 6s (global)",
         f"{sum_sixes_hit} vs {ref_sixes}")
    gate(sum_dots_bowl == ref_dots, "bowling_innings dots == legal 0-run balls (global)",
         f"{sum_dots_bowl} vs {ref_dots}")
    gate(sum_fours_conceded == ref_fours, "bowling_innings fours_conceded == boundary 4s (global)",
         f"{sum_fours_conceded} vs {ref_fours}")
    gate(sum_sixes_conceded == ref_sixes, "bowling_innings sixes_conceded == boundary 6s (global)",
         f"{sum_sixes_conceded} vs {ref_sixes}")
    gate(sum_maidens == ref_maidens, "bowling_innings maidens == independent maiden-over count (global)",
         f"{sum_maidens} vs {ref_maidens}")
    gate(sum_wides_runs == ref_wides_runs, "bowling_innings wides_runs == SUM(wides) (global)",
         f"{sum_wides_runs} vs {ref_wides_runs}")
    gate(sum_noball_runs == ref_noball_runs, "bowling_innings noball_runs == SUM(noballs) (global)",
         f"{sum_noball_runs} vs {ref_noball_runs}")

    # --- (e) Vocabulary gates. Allow-lists verified against the real DB
    # 2026-07-09 (see BOWLING_TYPE_VOCAB / BATTING_HAND_VOCAB / BOWLING_GROUP_VOCAB
    # comments for exactly which values are populated today).
    hand_in = ", ".join(f"'{v}'" for v in BATTING_HAND_VOCAB)
    group_in = ", ".join(f"'{v}'" for v in BOWLING_GROUP_VOCAB)
    type_in = ", ".join(f"'{v}'" for v in BOWLING_TYPE_VOCAB)

    bad_hand = q(
        f"SELECT COUNT(*) FROM read_parquet('{mbowl_p}') WHERE batting_hand NOT IN ({hand_in})"
    )
    gate(bad_hand == 0, "matchup_bowling.batting_hand within owner vocabulary",
         f"{bad_hand} rows outside {BATTING_HAND_VOCAB}")

    bad_group = q(
        f"SELECT COUNT(*) FROM read_parquet('{mbat_p}') WHERE bowling_group NOT IN ({group_in})"
    )
    gate(bad_group == 0, "matchup_batting.bowling_group within owner vocabulary",
         f"{bad_group} rows outside {BOWLING_GROUP_VOCAB}")

    bad_type = q(
        f"SELECT COUNT(*) FROM read_parquet('{mbat_p}') WHERE bowling_type NOT IN ({type_in})"
    )
    gate(bad_type == 0, "matchup_batting.bowling_type within decision-13 taxonomy",
         f"{bad_type} rows outside {BOWLING_TYPE_VOCAB}")

    log("All structural / cross-check gates passed.")


def run_spot_checks(con, out_dir):
    """Assert owner-verified career lines from SPOT_CHECKS against the exports."""
    if not SPOT_CHECKS:
        log("SPOT_CHECKS: none configured (skipping).")
        return

    bat_p = os.path.join(out_dir, "batting_innings.parquet")
    bowl_p = os.path.join(out_dir, "bowling_innings.parquet")

    def type_filter(mts):
        vals = ", ".join(f"'{t}'" for t in mts)
        return f"match_type IN ({vals})"

    for sc in SPOT_CHECKS:
        name = sc["player_name"]
        name_sql = name.replace("'", "''")  # e.g. KJ O'Brien
        gender = sc.get("gender")
        mts = sc.get("match_types", [])
        dfrom = sc.get("date_from")
        dto = sc.get("date_to")
        expect = sc["expect"]

        common = []
        if gender is not None:
            common.append(f"gender = '{gender}'")
        if mts:
            common.append(type_filter(mts))
        if dfrom is not None:
            common.append(f"match_date >= DATE '{dfrom}'")
        if dto is not None:
            common.append(f"match_date <= DATE '{dto}'")
        common_sql = " AND ".join(common) if common else "1=1"

        # Batting-side expectations (column order matches the SELECT below)
        bat_keys = ["runs", "balls_faced", "innings", "dismissals",
                    "fours_hit", "sixes_hit", "high_score"]
        bowl_keys = ["wickets", "runs_conceded", "balls", "bowl_innings"]

        if set(expect) & set(bat_keys):
            vals = con.execute(
                f"""
                SELECT
                    COALESCE(SUM(runs),0),
                    COALESCE(SUM(balls_faced),0),
                    COUNT(*),
                    COALESCE(SUM(dismissed),0),
                    COALESCE(SUM(fours_hit),0),
                    COALESCE(SUM(sixes_hit),0),
                    COALESCE(MAX(runs),0)
                FROM read_parquet('{bat_p}')
                WHERE batter_name = '{name_sql}' AND {common_sql}
                """
            ).fetchone()
            row = dict(zip(bat_keys, vals))
            for k in bat_keys:
                if k in expect:
                    got = int(row[k])
                    if got != int(expect[k]):
                        raise GateError(
                            f"SPOT_CHECK [{name}] batting {k}: got {got}, "
                            f"expected {expect[k]}"
                        )

        if set(expect) & set(bowl_keys):
            vals = con.execute(
                f"""
                SELECT
                    COALESCE(SUM(wickets),0),
                    COALESCE(SUM(runs_conceded),0),
                    COALESCE(SUM(balls),0),
                    COUNT(*)
                FROM read_parquet('{bowl_p}')
                WHERE bowler_name = '{name_sql}' AND {common_sql}
                """
            ).fetchone()
            row = dict(zip(bowl_keys, vals))
            for k in bowl_keys:
                if k in expect:
                    got = int(row[k])
                    if got != int(expect[k]):
                        raise GateError(
                            f"SPOT_CHECK [{name}] bowling {k}: got {got}, "
                            f"expected {expect[k]}"
                        )

        log(f"  PASS  SPOT_CHECK [{name}]")

    log(f"All {len(SPOT_CHECKS)} spot check(s) passed.")


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

def sha256_12(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def write_manifest(con, out_dir):
    files_meta = {}
    for f in list(EXPORT_FILES):
        p = os.path.join(out_dir, f)
        n = con.execute(f"SELECT COUNT(*) FROM read_parquet('{p}')").fetchone()[0]
        files_meta[f] = {
            "rows": int(n),
            "bytes": os.path.getsize(p),
            "sha256_12": sha256_12(p),
        }

    dmin, dmax, mcount = con.execute(
        "SELECT MIN(match_date_1), MAX(match_date_1), COUNT(*) FROM matches"
    ).fetchone()

    # Profiles-fetch provenance (D3): read the local meta written by
    # pipeline/sheet_fetch.py. Absent on local runs without a fetch — write
    # nulls, never crash.
    profiles_meta = {
        "profiles_updated_at": None,
        "profiles_content_changed_at": None,
        "profiles_source": None,
    }
    _pmeta_path = os.path.join("data", "profiles_fetch_meta.json")
    try:
        if os.path.exists(_pmeta_path):
            with open(_pmeta_path) as _fh:
                _pm = json.load(_fh)
            profiles_meta = {
                "profiles_updated_at": _pm.get("fetched_at"),
                "profiles_content_changed_at": _pm.get("content_changed_at"),
                "profiles_source": _pm.get("source"),
            }
    except Exception as _e:  # never let manifest provenance crash the export
        print(f"WARN: could not read {_pmeta_path}: {_e!r}; writing null profiles fields")

    manifest = {
        "generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
        "data": {
            "min_match_date": dmin.isoformat() if dmin else None,
            "max_match_date": dmax.isoformat() if dmax else None,
            "match_count": int(mcount),
        },
        "profiles": profiles_meta,
        "files": files_meta,
    }

    mpath = os.path.join(out_dir, "manifest.json")
    with open(mpath, "w") as fh:
        json.dump(manifest, fh, indent=2)
    # add manifest's own bytes/hash after writing (self-reference not required by spec)
    return manifest, mpath


# ---------------------------------------------------------------------------
# R2 (boto3) — download / upload
# ---------------------------------------------------------------------------

def _r2_client():
    import boto3

    missing = [
        k for k in ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT_URL")
        if not os.environ.get(k)
    ]
    if missing:
        raise SystemExit(
            "Missing required R2 env vars: " + ", ".join(missing)
        )
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )


def r2_download(db_path):
    log(f"Downloading s3://{R2_BUCKET}/{R2_DB_KEY} -> {db_path}")
    client = _r2_client()
    os.makedirs(os.path.dirname(os.path.abspath(db_path)) or ".", exist_ok=True)
    client.download_file(R2_BUCKET, R2_DB_KEY, db_path)
    log("Download complete.")


def _upload_one(client, out_dir, fname):
    """Upload one file with retry + short exponential backoff. Returns True/False."""
    p = os.path.join(out_dir, fname)
    key = f"{R2_EXPORT_PREFIX}{fname}"
    last_exc = None
    for attempt in range(1, UPLOAD_MAX_ATTEMPTS + 1):
        try:
            client.upload_file(
                p, R2_BUCKET, key,
                ExtraArgs={"ContentType": CONTENT_TYPES[fname]},
            )
            suffix = f" (attempt {attempt}/{UPLOAD_MAX_ATTEMPTS})" if attempt > 1 else ""
            log(f"  uploaded {key}{suffix}")
            return True
        except Exception as e:  # noqa: BLE001 — any boto3/network failure is retryable
            last_exc = e
            log(f"  WARN upload attempt {attempt}/{UPLOAD_MAX_ATTEMPTS} failed for {key}: {e!r}")
            if attempt < UPLOAD_MAX_ATTEMPTS:
                backoff = UPLOAD_BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                time.sleep(backoff)
    log(f"  FAILED all {UPLOAD_MAX_ATTEMPTS} attempts for {key}: {last_exc!r}")
    return False


def r2_upload(out_dir):
    """
    Upload every export file, then manifest.json STRICTLY LAST (the browser
    reads manifest.json first and trusts it to name files that already
    exist — publishing it before every data file has landed would let a
    client fetch a manifest pointing at a missing/half-written object).

    Each file gets UPLOAD_MAX_ATTEMPTS tries with a short exponential backoff.
    If ANY file ultimately fails, this raises (nonzero exit) with a clear
    summary of what uploaded and what didn't — never leaves the run looking
    green with a partial R2 state. manifest.json is only attempted if every
    data file succeeded.
    """
    log(f"Uploading exports to s3://{R2_BUCKET}/{R2_EXPORT_PREFIX}")
    client = _r2_client()

    data_files = list(EXPORT_FILES)
    succeeded, failed = [], []
    for f in data_files:
        (succeeded if _upload_one(client, out_dir, f) else failed).append(f)

    if failed:
        log(f"  SKIPPED manifest.json — {len(failed)} data file(s) failed to upload")
    else:
        (succeeded if _upload_one(client, out_dir, "manifest.json") else failed).append(
            "manifest.json"
        )

    if failed:
        raise SystemExit(
            "R2 upload FAILED for: " + ", ".join(failed) + ". "
            "Uploaded OK: " + (", ".join(succeeded) if succeeded else "(none)") + ". "
            "R2 explorer/ prefix is now in a PARTIAL state — do not treat this run as green."
        )
    log("Upload complete.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="cricdb parquet export pipeline")
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--download", action="store_true",
                        help="fetch cricket.duckdb from R2 before exporting")
    parser.add_argument("--upload", action="store_true",
                        help="upload exports to R2 after all gates pass")
    args = parser.parse_args()

    t0 = time.time()
    log(f"cricdb export starting (db={args.db}, out={args.out})")

    if args.download:
        r2_download(args.db)

    os.makedirs(args.out, exist_ok=True)

    if not os.path.exists(args.db):
        raise SystemExit(f"Database not found: {args.db}")

    con = duckdb.connect(args.db, read_only=True)

    # player_profiles is required from Phase D2 onward. Fail loudly on pre-D2 DBs
    # (the table is built by pipeline/build_profiles.py before this step runs).
    has_profiles = con.execute(
        "SELECT COUNT(*) FROM information_schema.tables "
        "WHERE table_schema = 'main' AND table_name = 'player_profiles'"
    ).fetchone()[0]
    if not has_profiles:
        raise SystemExit(
            "player_profiles table not found in the database. It must be built by "
            "pipeline/build_profiles.py (Phase D2) before export_parquet.py runs. "
            "Aborting rather than shipping exports without profiles."
        )

    # Build each export.
    log("Writing players.parquet ...")
    write_parquet(con, sql_players(), os.path.join(args.out, "players.parquet"))

    log("Writing matches.parquet ...")
    write_parquet(con, sql_matches(), os.path.join(args.out, "matches.parquet"))

    log("Writing batting_innings.parquet ...")
    write_parquet(con, sql_batting(), os.path.join(args.out, "batting_innings.parquet"))

    log("Writing bowling_innings.parquet ...")
    write_parquet(con, sql_bowling(), os.path.join(args.out, "bowling_innings.parquet"))

    log("Writing player_matches.parquet ...")
    write_parquet(con, sql_player_matches(), os.path.join(args.out, "player_matches.parquet"))

    log("Writing player_profiles.parquet ...")
    write_parquet(con, sql_player_profiles(), os.path.join(args.out, "player_profiles.parquet"))

    log("Writing matchup_batting.parquet ...")
    write_parquet(con, sql_matchup_batting(), os.path.join(args.out, "matchup_batting.parquet"))

    log("Writing matchup_bowling.parquet ...")
    write_parquet(con, sql_matchup_bowling(), os.path.join(args.out, "matchup_bowling.parquet"))

    # Gates + spot checks (all before any upload).
    try:
        run_gates(con, args.out)
        run_spot_checks(con, args.out)
    except GateError as e:
        log("=" * 60)
        log(f"VALIDATION FAILED: {e}")
        log("=" * 60)
        sys.exit(1)

    # Manifest.
    log("Writing manifest.json ...")
    manifest, _ = write_manifest(con, args.out)

    con.close()

    # Summary.
    log("-" * 60)
    log("Export summary:")
    for f, meta in manifest["files"].items():
        log(f"  {f:28s} rows={meta['rows']:>9,d}  "
            f"bytes={meta['bytes']:>12,d}  sha={meta['sha256_12']}")
    log(f"  data: {manifest['data']['min_match_date']} .. "
        f"{manifest['data']['max_match_date']}  matches={manifest['data']['match_count']:,}")

    if args.upload:
        r2_upload(args.out)

    log(f"Done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
