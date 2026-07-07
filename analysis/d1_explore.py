#!/usr/bin/env python3
"""
Phase D1 — Explore & report (READ-ONLY).

Produces every D1 deliverable and prints the numbers used to compose D1_REPORT.md.

Writes ONLY to:
  - analysis/ (this script + intermediate CSVs of vocabularies)
  - review/   (unmatched_active_players.csv, ambiguous_matches.csv, fuzzy_sample_20.csv)

Opens the DB read-only. Never modifies the DB, source_data/, or site code.

Key definitions used (all traceable to the task spec / reference/db_reference.md):
  - active DB player = player_id appearing as batter_id OR bowler_id in >=1 deliveries row
  - country evidence = for internationals, the international team(s) a player appears for
    in match_players; for club-only players, teams played for (advisory only)
  - sheet is MEN-ONLY; its 3 gender=F rows are owner-confirmed typos -> treated as M
  - name normalisation: NFKD diacritic strip, lowercase, punctuation->space, collapse ws
"""
import os
import re
import unicodedata
import duckdb
import pandas as pd

ROOT = "/Users/tarutr/Desktop/live_db"
DB = os.path.join(ROOT, "data", "cricket.duckdb")
SHEET = os.path.join(ROOT, "source_data", "cricinfo_player_profiles.csv")
REVIEW = os.path.join(ROOT, "review")
ANALYSIS = os.path.join(ROOT, "analysis")
os.makedirs(REVIEW, exist_ok=True)

RECENCY_CUTOFF = "2023-01-01"

con = duckdb.connect(DB, read_only=True)


# --------------------------------------------------------------------------- #
# Name normalisation                                                          #
# --------------------------------------------------------------------------- #
def norm_name(s):
    if s is None:
        return None
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s or None


def surname_token(s):
    """Last whitespace token of a normalised name (rough surname key)."""
    n = norm_name(s)
    if not n:
        return None
    return n.split()[-1]


con.create_function("norm_name", norm_name, ["VARCHAR"], "VARCHAR")
con.create_function("surname_token", surname_token, ["VARCHAR"], "VARCHAR")


# --------------------------------------------------------------------------- #
# Load sheet (all varchar). Force gender=M for the 3 confirmed-typo F rows.    #
# --------------------------------------------------------------------------- #
con.execute(f"""
CREATE OR REPLACE TEMP TABLE sheet_raw AS
SELECT * FROM read_csv_auto('{SHEET}', header=true, all_varchar=true, sample_size=-1)
""")

con.execute("""
CREATE OR REPLACE TEMP TABLE sheet AS
SELECT
    player_id                       AS sheet_player_id,
    batting_name,
    full_name,
    country_name,
    date_of_birth,
    position_name,
    batting_style,
    bowling_style,
    major_team_names,
    headshot_url,
    'M'                             AS gender_fixed,     -- men-only by design
    norm_name(batting_name)         AS bn_norm,
    surname_token(batting_name)     AS bn_surname,
    lower(trim(country_name))       AS country_lc
FROM sheet_raw
""")

n_sheet = con.execute("SELECT COUNT(*) FROM sheet").fetchone()[0]


# --------------------------------------------------------------------------- #
# Active DB players + attributes                                              #
# --------------------------------------------------------------------------- #
con.execute("""
CREATE OR REPLACE TEMP TABLE active AS
SELECT DISTINCT pid FROM (
    SELECT batter_id AS pid FROM deliveries WHERE batter_id IS NOT NULL
    UNION
    SELECT bowler_id       FROM deliveries WHERE bowler_id IS NOT NULL
)
""")

# non_striker-only players (0-ball crease appearances) — definitional edge
n_ns_only = con.execute("""
WITH ns AS (SELECT DISTINCT non_striker_id AS pid FROM deliveries WHERE non_striker_id IS NOT NULL)
SELECT COUNT(*) FROM ns WHERE pid NOT IN (SELECT pid FROM active)
""").fetchone()[0]

# per-player match attributes from match_players + matches
con.execute("""
CREATE OR REPLACE TEMP TABLE pmatch AS
SELECT mp.player_id AS pid, mp.team, m.gender, m.team_type, m.match_date_1, m.match_id
FROM match_players mp
JOIN matches m ON mp.match_id = m.match_id
""")

con.execute(f"""
CREATE OR REPLACE TEMP TABLE active_attr AS
WITH agg AS (
    SELECT
        p.pid,
        MAX(CASE WHEN gender='male'   THEN 1 ELSE 0 END) AS is_male,
        MAX(CASE WHEN gender='female' THEN 1 ELSE 0 END) AS is_female,
        MAX(CASE WHEN team_type='international' THEN 1 ELSE 0 END) AS is_intl,
        MAX(CASE WHEN team_type='club'          THEN 1 ELSE 0 END) AS is_club,
        MAX(match_date_1) AS last_match,
        COUNT(DISTINCT match_id) AS n_matches
    FROM pmatch p
    WHERE p.pid IN (SELECT pid FROM active)
    GROUP BY p.pid
),
intl_teams AS (
    SELECT pid, LIST(DISTINCT team) AS intl_team_list
    FROM pmatch
    WHERE team_type='international' AND pid IN (SELECT pid FROM active)
    GROUP BY pid
),
all_teams AS (
    SELECT pid, LIST(DISTINCT team) AS all_team_list
    FROM pmatch
    WHERE pid IN (SELECT pid FROM active)
    GROUP BY pid
)
SELECT
    a.pid,
    pr.player_name,
    norm_name(pr.player_name)     AS pn_norm,
    surname_token(pr.player_name) AS pn_surname,
    a.is_male, a.is_female, a.is_intl, a.is_club,
    a.last_match, a.n_matches,
    (a.last_match >= DATE '{RECENCY_CUTOFF}') AS recent,
    it.intl_team_list,
    alt.all_team_list
FROM agg a
JOIN player_registry pr ON pr.player_id = a.pid
LEFT JOIN intl_teams it  ON it.pid = a.pid
LEFT JOIN all_teams  alt ON alt.pid = a.pid
""")

n_active = con.execute("SELECT COUNT(*) FROM active_attr").fetchone()[0]


# --------------------------------------------------------------------------- #
# Uniqueness of names on each side                                            #
# --------------------------------------------------------------------------- #
# Registry: exact player_name uniqueness (restricted to ACTIVE players, since
# non-active registry rows can't be matched to active players anyway — but for
# a *match* we compare against player_registry.player_name uniqueness overall.
# Tier-1 requires the name unique on both sides; we compute registry uniqueness
# across ALL registry rows (a duplicated name anywhere = ambiguous target).
con.execute("""
CREATE OR REPLACE TEMP TABLE reg_name_counts AS
SELECT player_name, COUNT(*) AS n FROM player_registry GROUP BY player_name
""")
con.execute("""
CREATE OR REPLACE TEMP TABLE sheet_bn_counts AS
SELECT batting_name, COUNT(*) AS n FROM sheet GROUP BY batting_name
""")

# --------------------------------------------------------------------------- #
# EXACT batting_name == player_name matches                                   #
# --------------------------------------------------------------------------- #
con.execute("""
CREATE OR REPLACE TEMP TABLE exact_pairs AS
SELECT
    aa.pid,
    aa.player_name,
    s.sheet_player_id,
    s.batting_name,
    s.country_name,
    s.country_lc,
    aa.intl_team_list,
    aa.all_team_list,
    aa.is_intl, aa.is_club, aa.is_male, aa.is_female,
    aa.n_matches, aa.last_match, aa.recent,
    rc.n AS reg_name_n,
    sc.n AS sheet_bn_n
FROM active_attr aa
JOIN sheet s          ON s.batting_name = aa.player_name
JOIN reg_name_counts rc ON rc.player_name = aa.player_name
JOIN sheet_bn_counts sc ON sc.batting_name = s.batting_name
""")

# Country-consistency check for internationals:
# international teams the player appears for should include the sheet's country
# (case-insensitive). Some intl teams are non-country XIs (ICC World XI etc.) —
# those simply won't match a country and fall through to "no country evidence".
def country_consistent(intl_list, country_lc):
    if not intl_list:
        return None  # club-only: no intl evidence
    if not country_lc:
        return None
    teams = {t.strip().lower() for t in intl_list if t}
    return country_lc in teams

con.create_function(
    "country_consistent",
    country_consistent,
    ["VARCHAR[]", "VARCHAR"],
    "BOOLEAN",
)

con.execute("""
CREATE OR REPLACE TEMP TABLE exact_scored AS
SELECT *,
    country_consistent(intl_team_list, country_lc) AS country_ok_intl
FROM exact_pairs
""")

# --------------------------------------------------------------------------- #
# TIER 1 (confident, auto-matchable)                                          #
#   1a: name unique on BOTH sides, player is international, and the sheet      #
#       country matches an international team the player appeared for.         #
#   1b: name unique on BOTH sides, player is club-only, and sheet             #
#       major_team_names overlaps a DB team the player played for.            #
# --------------------------------------------------------------------------- #
# Club-only team overlap: compare normalised tokens of sheet major_team_names
# (pipe-separated) against DB all_team_list.
def team_overlap(major_names, all_list):
    if not major_names or not all_list:
        return False
    sheet_teams = {norm_name(t) for t in major_names.split("|") if t and norm_name(t)}
    db_teams = {norm_name(t) for t in all_list if t and norm_name(t)}
    return len(sheet_teams & db_teams) > 0

con.create_function("team_overlap", team_overlap, ["VARCHAR", "VARCHAR[]"], "BOOLEAN")

con.execute("""
CREATE OR REPLACE TEMP TABLE tier1 AS
SELECT e.*,
    s.major_team_names,
    team_overlap(s.major_team_names, e.all_team_list) AS club_team_ok
FROM exact_scored e
JOIN sheet s ON s.sheet_player_id = e.sheet_player_id
WHERE e.reg_name_n = 1 AND e.sheet_bn_n = 1     -- unique on both sides
  AND e.is_male = 1                              -- DB player played >=1 men's match
                                                 -- (sheet is men-only: a female-only
                                                 --  DB id cannot be a correct match)
  AND (
        (e.is_intl = 1 AND e.country_ok_intl = TRUE)       -- 1a intl w/ country
     OR (e.is_intl = 0 AND e.is_club = 1                    -- 1b club-only
           AND team_overlap(s.major_team_names, e.all_team_list) = TRUE)
  )
""")

# Breakdown counts for tier 1
tier1_total = con.execute("SELECT COUNT(*) FROM tier1").fetchone()[0]
tier1_1a = con.execute("SELECT COUNT(*) FROM tier1 WHERE is_intl=1").fetchone()[0]
tier1_1b = con.execute("SELECT COUNT(*) FROM tier1 WHERE is_intl=0").fetchone()[0]

# Sanity: a player_id could in principle appear in tier1 twice (only if two
# distinct unique sheet rows equalled the same unique registry name — impossible
# because sheet_bn_n=1 forces one sheet row per name). Confirm 1:1.
tier1_distinct_pid = con.execute("SELECT COUNT(DISTINCT pid) FROM tier1").fetchone()[0]

# Exact-unique-both pairs that FAILED the country/team evidence (near-miss):
exact_unique_both = con.execute("""
SELECT COUNT(*) FROM exact_scored WHERE reg_name_n=1 AND sheet_bn_n=1
""").fetchone()[0]
exact_unique_both_no_evidence = con.execute("""
SELECT COUNT(*) FROM exact_scored e
JOIN sheet s ON s.sheet_player_id=e.sheet_player_id
WHERE e.reg_name_n=1 AND e.sheet_bn_n=1
  AND NOT (
     (e.is_intl=1 AND e.country_ok_intl=TRUE)
   OR(e.is_intl=0 AND e.is_club=1 AND team_overlap(s.major_team_names, e.all_team_list)=TRUE)
  )
""").fetchone()[0]

# Club-only exact-unique bucket size (task asks to quantify this specifically)
club_only_exact_unique = con.execute("""
SELECT COUNT(*) FROM exact_scored WHERE reg_name_n=1 AND sheet_bn_n=1 AND is_intl=0 AND is_club=1
""").fetchone()[0]
club_only_exact_unique_matched = con.execute("SELECT COUNT(*) FROM tier1 WHERE is_intl=0").fetchone()[0]


# --------------------------------------------------------------------------- #
# Coverage rates (matching universe = MALE active players; sheet is men-only)  #
# --------------------------------------------------------------------------- #
def rate(where_extra=""):
    q = f"""
    WITH base AS (
        SELECT aa.pid, aa.is_male,
               (aa.pid IN (SELECT pid FROM tier1)) AS matched
        FROM active_attr aa
        {where_extra}
    )
    SELECT COUNT(*) AS n, SUM(CASE WHEN matched THEN 1 ELSE 0 END) AS m
    FROM base
    """
    r = con.execute(q).fetchone()
    return r[0], r[1]

overall_n, overall_m = rate()
male_n, male_m = rate("WHERE aa.is_male=1")
female_n, female_m = rate("WHERE aa.is_female=1 AND aa.is_male=0")
intl_n, intl_m = rate("WHERE aa.is_intl=1")
club_n, club_m = rate("WHERE aa.is_intl=0 AND aa.is_club=1")
recent_n, recent_m = rate("WHERE aa.recent=TRUE")
older_n, older_m = rate("WHERE aa.recent=FALSE OR aa.recent IS NULL")
# male + recent, male + intl for the men-only universe splits
male_intl_n, male_intl_m = rate("WHERE aa.is_male=1 AND aa.is_intl=1")
male_club_n, male_club_m = rate("WHERE aa.is_male=1 AND aa.is_intl=0 AND aa.is_club=1")
male_recent_n, male_recent_m = rate("WHERE aa.is_male=1 AND aa.recent=TRUE")
male_older_n, male_older_m = rate("WHERE aa.is_male=1 AND (aa.recent=FALSE OR aa.recent IS NULL)")


# --------------------------------------------------------------------------- #
# Sheet players with NO DB presence                                           #
#   present = sheet batting_name equals ANY player_registry.player_name        #
#   (exact). This is a loose "any presence" test as the task asks for a count. #
# --------------------------------------------------------------------------- #
sheet_no_db = con.execute("""
SELECT COUNT(*) FROM sheet s
WHERE s.batting_name NOT IN (SELECT player_name FROM player_registry)
""").fetchone()[0]
sheet_no_active = con.execute("""
SELECT COUNT(*) FROM sheet s
WHERE s.batting_name NOT IN (
    SELECT pr.player_name FROM player_registry pr
    WHERE pr.player_id IN (SELECT pid FROM active)
)
""").fetchone()[0]


# --------------------------------------------------------------------------- #
# FUZZY TIERS (candidates, NEVER auto-matched)                                #
# Built over ACTIVE players that DID NOT get a Tier-1 match.                   #
# --------------------------------------------------------------------------- #
con.execute("""
CREATE OR REPLACE TEMP TABLE unmatched_active AS
SELECT * FROM active_attr WHERE pid NOT IN (SELECT pid FROM tier1)
""")
n_unmatched = con.execute("SELECT COUNT(*) FROM unmatched_active").fetchone()[0]

# Tier F1: normalised-equality (case/diacritic/punct) but NOT exact-equal.
# Fuzzy candidate generation is limited to DB players who played >=1 men's match
# (men-only sheet). Female-only actives still appear in the unmatched CSV but get
# no fuzzy candidate.
con.execute("""
CREATE OR REPLACE TEMP TABLE fuzzy_f1 AS
SELECT
    u.pid, u.player_name, u.pn_norm, u.is_intl, u.is_club, u.n_matches,
    u.last_match, u.intl_team_list, u.all_team_list,
    s.sheet_player_id, s.batting_name, s.country_name, s.country_lc,
    s.major_team_names, s.date_of_birth,
    'F1_normalised_equal' AS tier
FROM unmatched_active u
JOIN sheet s ON s.bn_norm = u.pn_norm AND s.batting_name <> u.player_name
WHERE u.is_male = 1
""")

# Tier F2: surname + country equality (surname token equal AND sheet country in
# the player's international teams). Excludes F1 hits.
con.execute("""
CREATE OR REPLACE TEMP TABLE fuzzy_f2 AS
SELECT
    u.pid, u.player_name, u.pn_norm, u.pn_surname, u.is_intl, u.is_club, u.n_matches,
    u.last_match, u.intl_team_list, u.all_team_list,
    s.sheet_player_id, s.batting_name, s.country_name, s.country_lc,
    s.major_team_names, s.date_of_birth,
    'F2_surname_plus_country' AS tier
FROM unmatched_active u
JOIN sheet s
  ON u.pn_surname = s.bn_surname
 AND u.pn_surname IS NOT NULL
 AND country_consistent(u.intl_team_list, s.country_lc) = TRUE
WHERE u.is_intl = 1 AND u.is_male = 1
  AND NOT EXISTS (SELECT 1 FROM fuzzy_f1 f WHERE f.pid=u.pid AND f.sheet_player_id=s.sheet_player_id)
""")

# Tier F3: initials-consistent surname+country match. The registry name is
# "INITIALS SURNAME" (e.g. "RG Sharma"). We compare against the sheet, requiring:
#   - same normalised surname token
#   - sheet country consistent with the player's international team(s)
#   - the DB initials letter-set == the initials derived from the sheet's
#     given names (full_name minus surname), first letter of each given token.
# This is far tighter than bare surname+country (F2) and captures the common
# "RG Sharma" vs "Rohit Gurunath Sharma" pattern.
def db_initials(reg_name):
    """Initials letters from a 'INITIALS SURNAME' registry name. '' if none."""
    n = norm_name(reg_name)
    if not n:
        return ""
    toks = n.split()
    if len(toks) < 2:
        return ""
    return "".join(t[0] for t in toks[:-1] if t)

def sheet_initials(full_name, batting_name):
    """Given-name initials from sheet full_name, dropping the surname token."""
    fn = norm_name(full_name)
    bn = norm_name(batting_name)
    if not fn:
        return ""
    sur = bn.split()[-1] if bn else None
    toks = fn.split()
    given = [t for t in toks if t != sur]
    if not given:
        return ""
    return "".join(t[0] for t in given if t)

con.create_function("db_initials", db_initials, ["VARCHAR"], "VARCHAR")
con.create_function("sheet_initials", sheet_initials, ["VARCHAR", "VARCHAR"], "VARCHAR")

con.execute("""
CREATE OR REPLACE TEMP TABLE fuzzy_f3 AS
SELECT
    u.pid, u.player_name, u.pn_surname, u.is_intl, u.is_club, u.n_matches,
    u.last_match, u.intl_team_list, u.all_team_list,
    s.sheet_player_id, s.batting_name, s.full_name, s.country_name, s.country_lc,
    s.major_team_names, s.date_of_birth,
    'F3_initials_surname_country' AS tier
FROM unmatched_active u
JOIN sheet s
  ON u.pn_surname = s.bn_surname
 AND u.pn_surname IS NOT NULL
 AND db_initials(u.player_name) <> ''
 AND db_initials(u.player_name) = sheet_initials(s.full_name, s.batting_name)
 AND country_consistent(u.intl_team_list, s.country_lc) = TRUE
WHERE u.is_intl = 1 AND u.is_male = 1
  AND NOT EXISTS (SELECT 1 FROM fuzzy_f1 f WHERE f.pid=u.pid AND f.sheet_player_id=s.sheet_player_id)
""")

n_f1 = con.execute("SELECT COUNT(*) FROM fuzzy_f1").fetchone()[0]
n_f1_pairs_distinct_pid = con.execute("SELECT COUNT(DISTINCT pid) FROM fuzzy_f1").fetchone()[0]
n_f2 = con.execute("SELECT COUNT(*) FROM fuzzy_f2").fetchone()[0]
n_f2_pairs_distinct_pid = con.execute("SELECT COUNT(DISTINCT pid) FROM fuzzy_f2").fetchone()[0]
n_f3 = con.execute("SELECT COUNT(*) FROM fuzzy_f3").fetchone()[0]
n_f3_pairs_distinct_pid = con.execute("SELECT COUNT(DISTINCT pid) FROM fuzzy_f3").fetchone()[0]
# F3 pids with a UNIQUE candidate (exactly one sheet row) — highest-value bucket
n_f3_unique = con.execute("""
SELECT COUNT(*) FROM (SELECT pid FROM fuzzy_f3 GROUP BY pid HAVING COUNT(*)=1)
""").fetchone()[0]


# --------------------------------------------------------------------------- #
# Duplicated names -> ambiguous                                               #
# --------------------------------------------------------------------------- #
# Sheet: batting_name+country_name pairs duplicated within sheet
sheet_dup_pairs = con.execute("""
SELECT COUNT(*) FROM (
    SELECT batting_name, country_name FROM sheet
    GROUP BY batting_name, country_name HAVING COUNT(*)>1
)
""").fetchone()[0]
# DB: duplicate player_names among ACTIVE players
db_dup_active_names = con.execute("""
SELECT COUNT(*) FROM (
    SELECT player_name FROM player_registry
    WHERE player_id IN (SELECT pid FROM active)
    GROUP BY player_name HAVING COUNT(*)>1
)
""").fetchone()[0]


# --------------------------------------------------------------------------- #
# DELIVERABLE FILES                                                            #
# --------------------------------------------------------------------------- #
def list_to_str(v, top=None):
    if v is None:
        return ""
    items = [x for x in v if x]
    if top:
        items = items[:top]
    return "|".join(items)


# ---- review/unmatched_active_players.csv ----------------------------------- #
# active players with no Tier-1 match + best fuzzy candidate if any.
# best candidate: prefer F1 (normalised-equal) then F2 (surname+country).
def _first(tbl):
    return con.execute(f"""
    SELECT pid, sheet_player_id, batting_name, country_name, major_team_names, date_of_birth, tier,
           ROW_NUMBER() OVER (PARTITION BY pid ORDER BY sheet_player_id) rn
    FROM {tbl}
    """).fetchdf()

best_f1 = _first("fuzzy_f1")
best_f3 = _first("fuzzy_f3")
best_f2 = _first("fuzzy_f2")

um = con.execute("""
SELECT pid, player_name, is_male, is_female, is_intl, is_club, n_matches, last_match,
       intl_team_list, all_team_list
FROM unmatched_active
""").fetchdf()

# pick best candidate per pid: F1 (normalised-equal) > F3 (initials+country) > F2
f1_first = best_f1[best_f1["rn"] == 1].set_index("pid")
f3_first = best_f3[best_f3["rn"] == 1].set_index("pid")
f2_first = best_f2[best_f2["rn"] == 1].set_index("pid")
f1_counts = best_f1.groupby("pid").size()
f3_counts = best_f3.groupby("pid").size()
f2_counts = best_f2.groupby("pid").size()

rows = []
for _, r in um.iterrows():
    pid = r["pid"]
    team_type = ("international" if r["is_intl"] else "") + ("/club" if r["is_club"] else "")
    team_type = team_type.strip("/") or ""
    cand = None
    tier = ""
    ncand = 0
    if pid in f1_first.index:
        cand = f1_first.loc[pid]
        tier = "F1_normalised_equal"
        ncand = int(f1_counts.get(pid, 0))
    elif pid in f3_first.index:
        cand = f3_first.loc[pid]
        tier = "F3_initials_surname_country"
        ncand = int(f3_counts.get(pid, 0))
    elif pid in f2_first.index:
        cand = f2_first.loc[pid]
        tier = "F2_surname_plus_country"
        ncand = int(f2_counts.get(pid, 0))
    rows.append({
        "player_id": pid,
        "player_name": r["player_name"],
        "gender": "M" if r["is_male"] and not r["is_female"] else ("F" if r["is_female"] and not r["is_male"] else "M+F"),
        "team_types": team_type,
        "teams_played_for": list_to_str(r["all_team_list"], top=4),
        "matches": int(r["n_matches"]),
        "last_match_date": str(r["last_match"]),
        "best_candidate_tier": tier,
        "n_fuzzy_candidates": ncand,
        "cand_sheet_player_id": ("" if cand is None else cand["sheet_player_id"]),
        "cand_batting_name": ("" if cand is None else cand["batting_name"]),
        "cand_country_name": ("" if cand is None else cand["country_name"]),
        "cand_major_team_names": ("" if cand is None else (cand["major_team_names"] or "")),
        "cand_date_of_birth": ("" if cand is None else (cand["date_of_birth"] or "")),
    })

um_df = pd.DataFrame(rows)
# sort: most recently / most-played first
um_df["_lm"] = pd.to_datetime(um_df["last_match_date"], errors="coerce")
um_df = um_df.sort_values(["_lm", "matches"], ascending=[False, False]).drop(columns=["_lm"])
um_df.to_csv(os.path.join(REVIEW, "unmatched_active_players.csv"), index=False)


# ---- review/ambiguous_matches.csv ------------------------------------------ #
# Every collision / ambiguous case, as advisory rows for owner hand-editing.
# Sources of ambiguity:
#   A. DB active player whose name is duplicated among active registry names
#      AND matches a sheet batting_name (target ambiguous).
#   B. Sheet batting_name+country duplicated within sheet AND matches an active
#      DB player (source ambiguous).
#   C. Exact-unique-both pairs that FAILED evidence (country/team) — these are
#      exact-name but evidence-inconsistent, owner must confirm.
ambig_rows = []

# A: duplicated active registry names that hit a sheet row (exact)
a = con.execute("""
SELECT aa.pid, aa.player_name, aa.is_intl, aa.is_club, aa.n_matches, aa.last_match,
       aa.intl_team_list, aa.all_team_list,
       s.sheet_player_id, s.batting_name, s.country_name, s.major_team_names, s.date_of_birth,
       (SELECT COUNT(*) FROM player_registry pr2 WHERE pr2.player_name=aa.player_name) AS reg_name_n
FROM active_attr aa
JOIN sheet s ON s.batting_name = aa.player_name
WHERE aa.player_name IN (
    SELECT player_name FROM player_registry
    WHERE player_id IN (SELECT pid FROM active)
    GROUP BY player_name HAVING COUNT(*)>1
)
""").fetchdf()
for _, r in a.iterrows():
    ambig_rows.append({
        "ambiguity_type": "A_db_name_collision",
        "player_id": r["pid"], "db_name": r["player_name"],
        "db_matches": int(r["n_matches"]), "db_last_match": str(r["last_match"]),
        "db_team_type": ("international" if r["is_intl"] else "") + ("/club" if r["is_club"] else ""),
        "db_teams": list_to_str(r["all_team_list"], top=5),
        "db_reg_name_count": int(r["reg_name_n"]),
        "sheet_player_id": r["sheet_player_id"], "sheet_batting_name": r["batting_name"],
        "sheet_country": r["country_name"], "sheet_major_teams": (r["major_team_names"] or ""),
        "sheet_dob": (r["date_of_birth"] or ""),
    })

# B: duplicated sheet batting_name+country hitting an active DB player (exact)
b = con.execute("""
SELECT aa.pid, aa.player_name, aa.is_intl, aa.is_club, aa.n_matches, aa.last_match,
       aa.all_team_list,
       s.sheet_player_id, s.batting_name, s.country_name, s.major_team_names, s.date_of_birth
FROM sheet s
JOIN active_attr aa ON aa.player_name = s.batting_name
WHERE (s.batting_name, s.country_name) IN (
    SELECT batting_name, country_name FROM sheet
    GROUP BY batting_name, country_name HAVING COUNT(*)>1
)
""").fetchdf()
for _, r in b.iterrows():
    ambig_rows.append({
        "ambiguity_type": "B_sheet_name_country_collision",
        "player_id": r["pid"], "db_name": r["player_name"],
        "db_matches": int(r["n_matches"]), "db_last_match": str(r["last_match"]),
        "db_team_type": ("international" if r["is_intl"] else "") + ("/club" if r["is_club"] else ""),
        "db_teams": list_to_str(r["all_team_list"], top=5),
        "db_reg_name_count": None,
        "sheet_player_id": r["sheet_player_id"], "sheet_batting_name": r["batting_name"],
        "sheet_country": r["country_name"], "sheet_major_teams": (r["major_team_names"] or ""),
        "sheet_dob": (r["date_of_birth"] or ""),
    })

# C: exact-unique-both but evidence FAILED
c = con.execute("""
SELECT e.pid, e.player_name, e.is_intl, e.is_club, e.n_matches, e.last_match,
       e.intl_team_list, e.all_team_list, e.country_ok_intl,
       e.sheet_player_id, e.batting_name, e.country_name, e.reg_name_n, e.sheet_bn_n,
       s.major_team_names, s.date_of_birth,
       team_overlap(s.major_team_names, e.all_team_list) AS club_team_ok
FROM exact_scored e
JOIN sheet s ON s.sheet_player_id = e.sheet_player_id
WHERE e.reg_name_n=1 AND e.sheet_bn_n=1
  AND NOT (
     (e.is_intl=1 AND e.country_ok_intl=TRUE)
   OR(e.is_intl=0 AND e.is_club=1 AND team_overlap(s.major_team_names, e.all_team_list)=TRUE)
  )
""").fetchdf()
for _, r in c.iterrows():
    ambig_rows.append({
        "ambiguity_type": "C_exact_unique_evidence_failed",
        "player_id": r["pid"], "db_name": r["player_name"],
        "db_matches": int(r["n_matches"]), "db_last_match": str(r["last_match"]),
        "db_team_type": ("international" if r["is_intl"] else "") + ("/club" if r["is_club"] else ""),
        "db_teams": list_to_str(r["all_team_list"], top=5),
        "db_reg_name_count": int(r["reg_name_n"]),
        "sheet_player_id": r["sheet_player_id"], "sheet_batting_name": r["batting_name"],
        "sheet_country": r["country_name"], "sheet_major_teams": (r["major_team_names"] or ""),
        "sheet_dob": (r["date_of_birth"] or ""),
    })

# D: female-only (or both-gender) active DB player exact-unique matching a
# men-only sheet row. These are excluded from Tier-1 by the gender guard and
# surfaced here because exact name+country alone would otherwise mis-match a
# female-only DB id to a male sheet person.
d = con.execute("""
SELECT e.pid, e.player_name, e.is_intl, e.is_club, e.is_male, e.is_female,
       e.n_matches, e.last_match, e.all_team_list, e.country_ok_intl,
       e.sheet_player_id, e.batting_name, e.country_name, e.reg_name_n,
       s.major_team_names, s.date_of_birth
FROM exact_scored e
JOIN sheet s ON s.sheet_player_id = e.sheet_player_id
WHERE e.reg_name_n=1 AND e.sheet_bn_n=1
  AND e.is_male = 0        -- female-only DB player (excluded from Tier-1)
""").fetchdf()
for _, r in d.iterrows():
    ambig_rows.append({
        "ambiguity_type": "D_female_db_vs_male_sheet",
        "player_id": r["pid"], "db_name": r["player_name"],
        "db_matches": int(r["n_matches"]), "db_last_match": str(r["last_match"]),
        "db_team_type": ("international" if r["is_intl"] else "") + ("/club" if r["is_club"] else ""),
        "db_teams": list_to_str(r["all_team_list"], top=5),
        "db_reg_name_count": int(r["reg_name_n"]),
        "sheet_player_id": r["sheet_player_id"], "sheet_batting_name": r["batting_name"],
        "sheet_country": r["country_name"], "sheet_major_teams": (r["major_team_names"] or ""),
        "sheet_dob": (r["date_of_birth"] or ""),
    })

amb_df = pd.DataFrame(ambig_rows)
if not amb_df.empty:
    amb_df["_lm"] = pd.to_datetime(amb_df["db_last_match"], errors="coerce")
    amb_df = amb_df.sort_values(["_lm", "db_matches"], ascending=[False, False]).drop(columns=["_lm"])
    col_order = ["ambiguity_type", "player_id", "db_name", "db_matches", "db_last_match",
                 "db_team_type", "db_teams", "db_reg_name_count",
                 "sheet_player_id", "sheet_batting_name", "sheet_country",
                 "sheet_major_teams", "sheet_dob"]
    amb_df = amb_df[col_order]
amb_df.to_csv(os.path.join(REVIEW, "ambiguous_matches.csv"), index=False)


# ---- fuzzy sample (20) ----------------------------------------------------- #
# Represent the different fuzzy patterns: a spread across F1, F3, F2.
def all_of(tbl):
    return con.execute(f"""
    SELECT tier, pid, player_name, batting_name, country_name, major_team_names,
           date_of_birth, n_matches, last_match, intl_team_list, all_team_list
    FROM {tbl}
    """).fetchdf()

def prep(df):
    if df.empty:
        return df
    df = df.copy()
    df["db_teams"] = df["all_team_list"].apply(lambda v: list_to_str(v, top=4))
    return df[["tier", "pid", "player_name", "db_teams", "batting_name",
               "country_name", "major_team_names", "date_of_birth",
               "n_matches", "last_match"]]

f1p = prep(all_of("fuzzy_f1"))
# F3: restrict the sample to pids where F3 gives a UNIQUE candidate (clean 1:1)
f3_unique_df = con.execute("""
SELECT tier, pid, player_name, batting_name, country_name, major_team_names,
       date_of_birth, n_matches, last_match, intl_team_list, all_team_list
FROM fuzzy_f3
WHERE pid IN (SELECT pid FROM fuzzy_f3 GROUP BY pid HAVING COUNT(*)=1)
""").fetchdf()
f3p = prep(f3_unique_df)
# F2: sample only pids where F2 also collapses to a unique candidate, to show
# the "surname+country but no initials evidence" pattern distinctly.
f2_unique_df = con.execute("""
SELECT tier, pid, player_name, batting_name, country_name, major_team_names,
       date_of_birth, n_matches, last_match, intl_team_list, all_team_list
FROM fuzzy_f2
WHERE pid IN (SELECT pid FROM fuzzy_f2 GROUP BY pid HAVING COUNT(*)=1)
""").fetchdf()
f2p = prep(f2_unique_df)

take_f1 = f1p.sort_values("n_matches", ascending=False).head(6) if not f1p.empty else f1p
take_f3 = f3p.sort_values("n_matches", ascending=False).head(9) if not f3p.empty else f3p
take_f2 = f2p.sort_values("n_matches", ascending=False).head(5) if not f2p.empty else f2p
sample = pd.concat([take_f1, take_f3, take_f2], ignore_index=True).head(20)
sample = sample.rename(columns={
    "pid": "db_player_id", "player_name": "db_registry_name",
    "batting_name": "sheet_batting_name", "country_name": "sheet_country",
    "major_team_names": "sheet_major_teams", "date_of_birth": "sheet_dob",
    "n_matches": "db_matches", "last_match": "db_last_match",
})
sample.to_csv(os.path.join(REVIEW, "fuzzy_sample_20.csv"), index=False)


# ---- vocabularies to analysis/ --------------------------------------------- #
for f in ["position_name", "batting_style", "bowling_style"]:
    v = con.execute(f"""
        SELECT "{f}" AS value, COUNT(*) AS count FROM sheet_raw
        GROUP BY 1 ORDER BY count DESC
    """).fetchdf()
    v.to_csv(os.path.join(ANALYSIS, f"vocab_{f}.csv"), index=False)


# --------------------------------------------------------------------------- #
# PRINT SUMMARY (numbers for the report)                                      #
# --------------------------------------------------------------------------- #
def pct(m, n):
    return f"{100.0*m/n:.1f}%" if n else "n/a"

print("=" * 70)
print("SHEET PROFILE")
print(f"  rows={n_sheet}  cols={len(con.execute('DESCRIBE sheet_raw').fetchall())}")
print("=" * 70)
print("ACTIVE / EDGE")
print(f"  active (batter|bowler >=1 delivery) = {n_active}")
print(f"  non_striker-only (0-ball crease)    = {n_ns_only}")
print("=" * 70)
print("GENDER / TEAM_TYPE / RECENCY MIX (active)")
print(con.execute("""
SELECT
  SUM(CASE WHEN is_male=1 AND is_female=0 THEN 1 ELSE 0 END) male_only,
  SUM(CASE WHEN is_male=0 AND is_female=1 THEN 1 ELSE 0 END) female_only,
  SUM(CASE WHEN is_male=1 AND is_female=1 THEN 1 ELSE 0 END) both_gender,
  SUM(CASE WHEN is_intl=1 AND is_club=0 THEN 1 ELSE 0 END) intl_only,
  SUM(CASE WHEN is_intl=0 AND is_club=1 THEN 1 ELSE 0 END) club_only,
  SUM(CASE WHEN is_intl=1 AND is_club=1 THEN 1 ELSE 0 END) both_type,
  SUM(CASE WHEN recent THEN 1 ELSE 0 END) recent,
  SUM(CASE WHEN NOT recent OR recent IS NULL THEN 1 ELSE 0 END) older
FROM active_attr
""").fetchdf().to_string())
print("=" * 70)
print("TIER 1")
print(f"  exact-unique-both pairs           = {exact_unique_both}")
print(f"    of which club-only              = {club_only_exact_unique}")
print(f"  TIER1 total matched player_ids    = {tier1_total} (distinct pid {tier1_distinct_pid})")
print(f"    tier1a (intl+country)           = {tier1_1a}")
print(f"    tier1b (club-only+team overlap) = {tier1_1b}")
print(f"  exact-unique-both w/o evidence    = {exact_unique_both_no_evidence}  (-> ambiguous C)")
print("=" * 70)
print("COVERAGE (Tier-1 match rate among active)")
print(f"  overall (incl women): {overall_m}/{overall_n} = {pct(overall_m,overall_n)}")
print(f"  MALE only           : {male_m}/{male_n} = {pct(male_m,male_n)}")
print(f"  FEMALE only         : {female_m}/{female_n} = {pct(female_m,female_n)}")
print(f"  international        : {intl_m}/{intl_n} = {pct(intl_m,intl_n)}")
print(f"  club-only           : {club_m}/{club_n} = {pct(club_m,club_n)}")
print(f"  recent(>= {RECENCY_CUTOFF}): {recent_m}/{recent_n} = {pct(recent_m,recent_n)}")
print(f"  older               : {older_m}/{older_n} = {pct(older_m,older_n)}")
print("  -- men-only universe splits --")
print(f"  male+intl           : {male_intl_m}/{male_intl_n} = {pct(male_intl_m,male_intl_n)}")
print(f"  male+club-only      : {male_club_m}/{male_club_n} = {pct(male_club_m,male_club_n)}")
print(f"  male+recent         : {male_recent_m}/{male_recent_n} = {pct(male_recent_m,male_recent_n)}")
print(f"  male+older          : {male_older_m}/{male_older_n} = {pct(male_older_m,male_older_n)}")
print("=" * 70)
print("SHEET WITH NO DB PRESENCE")
print(f"  sheet rows w/ no exact registry name  = {sheet_no_db} / {n_sheet}")
print(f"  sheet rows w/ no exact ACTIVE name    = {sheet_no_active} / {n_sheet}")
print("=" * 70)
print("FUZZY TIERS (over unmatched active players)")
print(f"  unmatched active                  = {n_unmatched}")
print(f"  F1 normalised-equal pairs         = {n_f1}  (distinct pid {n_f1_pairs_distinct_pid})")
print(f"  F3 initials+surname+country pairs = {n_f3}  (distinct pid {n_f3_pairs_distinct_pid}, unique-cand pid {n_f3_unique})")
print(f"  F2 surname+country pairs          = {n_f2}  (distinct pid {n_f2_pairs_distinct_pid})")
print("=" * 70)
print("DUPLICATES / AMBIGUOUS")
print(f"  sheet batting_name+country dup pairs   = {sheet_dup_pairs}")
print(f"  DB active duplicated player_names      = {db_dup_active_names}")
print(f"  ambiguous_matches.csv rows             = {len(amb_df)}")
print(f"  unmatched_active_players.csv rows      = {len(um_df)}")
print("=" * 70)

con.close()
print("DONE")
