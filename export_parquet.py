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

# The export files and their primary keys (for the duplicate-PK gate).
EXPORT_FILES = {
    "players.parquet": ["player_id"],
    "matches.parquet": ["match_id"],
    "batting_innings.parquet": ["match_id", "innings_number", "batter_id"],
    "bowling_innings.parquet": ["match_id", "innings_number", "bowler_id"],
    "player_matches.parquet": ["match_id", "player_id"],
    "player_profiles.parquet": ["player_id"],
}

CONTENT_TYPES = {
    "players.parquet": "application/vnd.apache.parquet",
    "matches.parquet": "application/vnd.apache.parquet",
    "batting_innings.parquet": "application/vnd.apache.parquet",
    "bowling_innings.parquet": "application/vnd.apache.parquet",
    "player_matches.parquet": "application/vnd.apache.parquet",
    "player_profiles.parquet": "application/vnd.apache.parquet",
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
        CASE WHEN COALESCE(ba.is_hundred, CASE WHEN mm.balls_per_over=5 THEN 1 ELSE 0 END)=1 THEN NULL ELSE COALESCE(ba.odi_death_balls,0) END AS odi_death_balls
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


def r2_upload(out_dir):
    log(f"Uploading exports to s3://{R2_BUCKET}/{R2_EXPORT_PREFIX}")
    client = _r2_client()
    for f in list(EXPORT_FILES) + ["manifest.json"]:
        p = os.path.join(out_dir, f)
        key = f"{R2_EXPORT_PREFIX}{f}"
        client.upload_file(
            p, R2_BUCKET, key,
            ExtraArgs={"ContentType": CONTENT_TYPES[f]},
        )
        log(f"  uploaded {key}")
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
