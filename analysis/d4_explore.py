#!/usr/bin/env python3
"""
D4 STEP 1 exploration — read-only. Reproduces every number cited in
analysis/D4_PROPOSAL.md. Opens the DB with read_only=True and only reads the
current export parquets. Writes nothing to the DB.

Usage: python3 analysis/d4_explore.py
"""
import duckdb

# DB copy that has player_profiles built (repo data/cricket.duckdb does not).
DB = ("/private/tmp/claude-501/-Users-tarutr-Desktop-live-db/"
      "73dacd07-e2e8-4325-9328-46e8acc84fdf/scratchpad/d0_test/data/cricket.duckdb")
EXP = "/Users/tarutr/Desktop/live_db/data/export"

con = duckdb.connect(DB, read_only=True)

# Rolling "recent" window = last 3 years from the most recent match_date
# (owner decision 7). max match_date = 2026-07-02 -> cutoff 2023-07-02.
RECENT_CUTOFF = "DATE '2023-07-02'"

FMT_GROUP = """CASE WHEN m.match_type IN ('T20','IT20') THEN 'All T20'
                    WHEN m.match_type IN ('ODI','ODM') THEN 'All ODI'
                    WHEN m.match_type='Test' THEN 'Test'
                    WHEN m.match_type='MDM'  THEN 'MDM' END"""

NONSUPER = ("JOIN innings i ON i.match_id=d.match_id "
            "AND i.innings_number=d.innings_number WHERE i.super_over IS NOT TRUE")


def q(sql):
    return con.execute(sql).fetchall()


# --- 1. Profile field null rates (n = row count of player_profiles) -----------
print("PROFILE FIELD COVERAGE:", q("""
  SELECT COUNT(*) AS n,
    COUNT(*) - COUNT(NULLIF(role_group,''))      AS role_group_null,
    COUNT(*) - COUNT(NULLIF(batting_style,''))   AS batting_style_null,
    COUNT(*) - COUNT(NULLIF(bowling_group,''))   AS bowling_group_null,
    COUNT(*) - COUNT(NULLIF(bowling_type,''))    AS bowling_type_null,
    COUNT(*) - COUNT(NULLIF(teams_played_for,'')) AS teams_null
  FROM player_profiles"""))

# --- 2. Matchup coverage denominators (D4.3) ---------------------------------
def coverage(recent):
    where = f"AND m.match_date_1 >= {RECENT_CUTOFF}" if recent else ""
    return q(f"""
      WITH dd AS (
        SELECT d.batter_id, d.bowler_id, m.gender, {FMT_GROUP} AS fmt
        FROM deliveries d JOIN matches m USING(match_id)
        {NONSUPER} {where})
      SELECT gender, fmt, COUNT(*) AS balls,
        100.0*COUNT(pb.player_id) FILTER (WHERE NULLIF(pb.bowling_group,'') IS NOT NULL)/COUNT(*) AS bowl_grp_pct,
        100.0*COUNT(pb.player_id) FILTER (WHERE NULLIF(pb.bowling_type,'')  IS NOT NULL)/COUNT(*) AS bowl_type_pct,
        100.0*COUNT(pa.player_id) FILTER (WHERE NULLIF(pa.batting_style,'') IS NOT NULL)/COUNT(*) AS bat_style_pct
      FROM dd
      LEFT JOIN player_profiles pb ON pb.player_id = dd.bowler_id
      LEFT JOIN player_profiles pa ON pa.player_id = dd.batter_id
      GROUP BY 1,2 ORDER BY 1,2""")

print("\nMATCHUP COVERAGE (all-time):")
for r in coverage(False):
    print("  ", r)
print("\nMATCHUP COVERAGE (last 3y):")
for r in coverage(True):
    print("  ", r)

# --- 3. Filter readiness among current parquet universes (D4.2) --------------
def readiness(parquet, idcol, fmts, gender, since="2023-01-01", mininns=10):
    fmts_sql = ",".join(f"'{f}'" for f in fmts)
    return con.execute(f"""
      WITH u AS (
        SELECT {idcol} AS pid, COUNT(*) AS inns
        FROM '{EXP}/{parquet}'
        WHERE gender='{gender}' AND match_type IN ({fmts_sql})
          AND match_date >= DATE '{since}'
        GROUP BY 1 HAVING COUNT(*) >= {mininns})
      SELECT COUNT(*) AS players,
        100.0*COUNT(pp.player_id)/COUNT(*)                                   AS has_profile,
        100.0*COUNT(pp.player_id) FILTER (WHERE NULLIF(pp.role_group,'') IS NOT NULL)/COUNT(*)        AS role,
        100.0*COUNT(pp.player_id) FILTER (WHERE NULLIF(pp.batting_style,'') IS NOT NULL)/COUNT(*)     AS bat,
        100.0*COUNT(pp.player_id) FILTER (WHERE NULLIF(pp.bowling_group,'') IS NOT NULL)/COUNT(*)     AS bowl,
        100.0*COUNT(pp.player_id) FILTER (WHERE NULLIF(pp.teams_played_for,'') IS NOT NULL)/COUNT(*)  AS teams
      FROM u LEFT JOIN player_profiles pp ON pp.player_id = u.pid""").fetchone()

print("\nFILTER READINESS (>=10 inns since 2023):")
for lbl, args in [
    ("Men T20 batters", ("batting_innings.parquet","batter_id",["T20","IT20"],"male")),
    ("Men ODI batters", ("batting_innings.parquet","batter_id",["ODI","ODM"],"male")),
    ("Men Test batters",("batting_innings.parquet","batter_id",["Test"],"male")),
    ("Women T20 batters",("batting_innings.parquet","batter_id",["T20","IT20"],"female")),
    ("Men T20 bowlers", ("bowling_innings.parquet","bowler_id",["T20","IT20"],"male")),
    ("Men ODI bowlers", ("bowling_innings.parquet","bowler_id",["ODI","ODM"],"male")),
]:
    print(f"  {lbl:20}", readiness(*args))

# --- 4. Menu supporting numbers ----------------------------------------------
print("\nWICKET KINDS:", q("SELECT kind, COUNT(*) FROM wickets GROUP BY 1 ORDER BY 2 DESC"))
print("\nVENUES/CITIES:", q("SELECT COUNT(DISTINCT venue), COUNT(DISTINCT city) FROM matches"))
print("MATCHUP GRAIN (per-innings x bowling_type rows):", q("""
  SELECT COUNT(*) FROM (
    SELECT d.match_id,d.innings_number,d.batter_id,pb.bowling_type
    FROM deliveries d JOIN player_profiles pb ON pb.player_id=d.bowler_id
    JOIN innings i ON i.match_id=d.match_id AND i.innings_number=d.innings_number
    WHERE i.super_over IS NOT TRUE AND NULLIF(pb.bowling_type,'') IS NOT NULL
    GROUP BY 1,2,3,4)"""))
con.close()
