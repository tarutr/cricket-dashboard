#!/usr/bin/env python3
"""
build_profiles.py — Phase D2 of SPEC_ADDENDUM_DATA.md.

Rebuilds the `player_profiles` table inside cricket.duckdb from the Cricinfo
player-profiles sheet. This is a NEW table only; the 16 original tables are
NEVER modified. `player_profiles` is DROPped and recreated on every run so the
build is fully deterministic and idempotent.

Matching implements EXACTLY the owner-approved rules recorded in
review/owner_decisions.md (which override the addendum where they conflict):

  * Matching universe (decision 9): every player_id that was selected in a team
    XI, i.e. present in `match_players`. Deliveries are NOT required.
  * Global gender guard (decision 1): eligibility for any AUTOMATIC match
    requires the DB player to have played >=1 men's match (matches.gender='male').
  * The 10 both-gender player_ids (decision 2) are EXCLUDED from automatic
    matching. Their ids are read from review/ambiguous_matches.csv rows with
    ambiguity_type='E_both_gender_id_held_by_owner'.
  * Tier 1a (international, auto): sheet.batting_name == registry.player_name
    byte-exact, that name unique in BOTH player_registry and the sheet, DB player
    is international (>=1 international match), and sheet country_name
    (case-insensitive) is among the international teams the player appeared for.
  * Tier 1b (club-only, auto): same exact-unique-both + gender guard, DB player
    is club-only, and team evidence holds by CONTAINMENT (decision 3): normalized
    (lowercase, diacritics stripped, non-alphanumerics removed) substring
    containment in EITHER direction between any sheet major_team_names entry and
    any DB team the player played for. This containment rule subsumes D1's
    strict-equality overlap.
  * Nothing below these tiers ever auto-matches.
  * Manual overrides (review/manual_matches.csv) are applied LAST and are
    permanent: action 'match' forces a link (trumps every rule incl. the gender
    guard and the held-id exclusion), 'no_match' forbids one specific pair,
    'no_profile' removes a player from profiles entirely.

Before ANY write, a sanity gate runs (all 16 tables present + spot row-count
floors). Any failure exits non-zero WITHOUT touching the database.

CLI:  python build_profiles.py [--db PATH] [--csv PATH]

Deps: stdlib + duckdb only.
"""

import argparse
import csv
import datetime as _dt
import os
import re
import sys
import time
import unicodedata

import duckdb

import alerts

# --------------------------------------------------------------------------- #
# Paths / constants                                                           #
# --------------------------------------------------------------------------- #
DEFAULT_DB = "data/cricket.duckdb"
DEFAULT_CSV = "source_data/cricinfo_player_profiles.csv"

# Review files live next to this repo's review/ directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
REVIEW_DIR = os.path.join(_REPO, "review")
AMBIGUOUS_CSV = os.path.join(REVIEW_DIR, "ambiguous_matches.csv")
MANUAL_MATCHES_CSV = os.path.join(REVIEW_DIR, "manual_matches.csv")
# Owner-owned resolution file (decision 18): the owner moves completed rows here
# from new_players_for_review.csv. Pipeline READS it, never writes it.
REVIEWED_CSV = os.path.join(REVIEW_DIR, "new_players_reviewed.csv")

# YES/NO/NONE resolution vocabulary (review/README.md) used by the two
# resolution-column files (new_players_reviewed.csv, ambiguous_matches.csv).
#   YES  -> match(player_id <-> that row's sheet_player_id)
#   NO   -> no_match for that (player_id, sheet_player_id) pair
#   NONE -> no_profile for that player_id
#   ''   -> ignored
VALID_RESOLUTIONS = {"yes", "no", "none"}

# The 16 tables that MUST exist (owner decision 6: 16 is correct, not 17).
EXPECTED_TABLES = {
    "bowling_spells", "deliveries", "ingested_files", "innings",
    "innings_batters", "innings_bowlers", "match_dates_overflow",
    "match_player_of_match", "match_players", "matches", "officials",
    "officials_registry", "player_registry", "powerplays",
    "wicket_fielders", "wickets",
}

# Sanity-gate row-count FLOORS.
# Derived from the actual DB (matches=22,229; deliveries=11,320,284;
# player_registry=14,890; match_players=490,358) and set safely BELOW those
# values so normal forward growth never trips the gate but truncation/corruption
# does. NOTE: the addendum's example floor "player_registry > 15,000" EXCEEDS the
# real registry (14,890) and would wrongly fail the gate, so the floor here is
# 14,000 as instructed ("derive sensible floors from the actual DB").
ROW_FLOORS = {
    "matches": 20_000,
    "deliveries": 10_000_000,
    "player_registry": 14_000,
    "match_players": 400_000,
}

# The single ESPN default-player placeholder headshot URL (verified: exactly one
# distinct default URL across 13,110 sheet rows).
DEFAULT_HEADSHOT_URL = (
    "https://a.espncdn.com/i/headshots/cricket/players/default-player-logo-500.png"
)

# Manual-override actions.
VALID_ACTIONS = {"match", "no_match", "no_profile"}
MANUAL_HEADER = ["player_id", "sheet_player_id", "action", "note", "decided_on"]


def log(msg):
    ts = _dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# Normalisation helpers (registered as DuckDB UDFs)                            #
# --------------------------------------------------------------------------- #
def _strip_diacritics(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c))


def norm_alnum(s):
    """Lowercase, strip diacritics, remove all non-alphanumerics. '' -> None."""
    if s is None:
        return None
    s = re.sub(r"[^a-z0-9]", "", _strip_diacritics(s).lower())
    return s or None


def team_contains(major_names, db_team_list):
    """
    Containment team-evidence rule (owner decision 3).

    True iff, after norm_alnum, ANY sheet major_team_names entry (pipe-separated)
    is a substring of ANY DB team the player played for, OR vice-versa.
    """
    if not major_names or not db_team_list:
        return False
    sheet_teams = {norm_alnum(t) for t in major_names.split("|")}
    sheet_teams.discard(None)
    db_teams = {norm_alnum(t) for t in db_team_list}
    db_teams.discard(None)
    for s in sheet_teams:
        for d in db_teams:
            if s in d or d in s:
                return True
    return False


def country_in_intl_teams(intl_team_list, country_lc):
    """Sheet country (lowercased) is among the DB international teams. None-safe."""
    if not intl_team_list or not country_lc:
        return None
    teams = {t.strip().lower() for t in intl_team_list if t}
    return country_lc in teams


# --------------------------------------------------------------------------- #
# Sanity gate                                                                 #
# --------------------------------------------------------------------------- #
class SanityError(RuntimeError):
    pass


def run_sanity_gate(con):
    """All 16 tables present + spot row-count floors. Raise on any failure."""
    log("Sanity gate: checking tables + row-count floors ...")
    present = {
        r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main'"
        ).fetchall()
    }
    missing = EXPECTED_TABLES - present
    if missing:
        raise SanityError(f"missing expected tables: {sorted(missing)}")
    extra_ok = present - EXPECTED_TABLES  # e.g. a pre-existing player_profiles
    if extra_ok:
        log(f"  note: additional tables present (not modified): {sorted(extra_ok)}")
    log(f"  PASS  all 16 expected tables present")

    for tbl, floor in ROW_FLOORS.items():
        n = con.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        if n < floor:
            raise SanityError(f"row-count floor failed: {tbl}={n:,} < {floor:,}")
        log(f"  PASS  {tbl} rows={n:,} (>= {floor:,})")


# --------------------------------------------------------------------------- #
# Load inputs                                                                 #
# --------------------------------------------------------------------------- #
def load_sheet(con, csv_path):
    """Load the profiles sheet (all VARCHAR). 3 gender=F rows are owner-confirmed
    typos; gender is irrelevant to the build so no fix needed here."""
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE sheet_raw AS
        SELECT * FROM read_csv_auto('{csv_path}', header=true,
                                    all_varchar=true, sample_size=-1)
    """)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE sheet AS
        SELECT
            player_id                  AS sheet_player_id,
            batting_name,
            full_name,
            country_name,
            date_of_birth,
            position_name,
            batting_style,
            bowling_style,
            major_team_names,
            headshot_url,
            lower(trim(country_name))  AS country_lc
        FROM sheet_raw
    """)
    n = con.execute("SELECT COUNT(*) FROM sheet").fetchone()[0]
    log(f"Loaded sheet: {n:,} rows from {csv_path}")
    return n


def load_held_ids(con):
    """The 10 both-gender player_ids held for owner review (decision 2)."""
    if not os.path.exists(AMBIGUOUS_CSV):
        raise SanityError(f"required file missing: {AMBIGUOUS_CSV}")
    ids = [
        r[0] for r in con.execute(f"""
            SELECT DISTINCT player_id
            FROM read_csv_auto('{AMBIGUOUS_CSV}', header=true, all_varchar=true)
            WHERE ambiguity_type = 'E_both_gender_id_held_by_owner'
              AND player_id IS NOT NULL
        """).fetchall()
    ]
    log(f"Held both-gender ids (excluded from auto-matching): {len(ids)} -> {ids}")
    return set(ids)


def ensure_manual_file():
    """Create review/manual_matches.csv with header only if it does not exist."""
    if os.path.exists(MANUAL_MATCHES_CSV):
        return
    os.makedirs(REVIEW_DIR, exist_ok=True)
    with open(MANUAL_MATCHES_CSV, "w", newline="") as fh:
        csv.writer(fh).writerow(MANUAL_HEADER)
    log(f"Created empty manual overrides file: {MANUAL_MATCHES_CSV}")


def load_manual():
    """Parse review/manual_matches.csv into (matches, no_match_pairs, no_profile).

    matches:         dict player_id -> sheet_player_id  (forced links)
    no_match_pairs:  set of (player_id, sheet_player_id) forbidden pairs
    no_profile:      set of player_id to drop entirely
    """
    matches, no_match_pairs, no_profile = {}, set(), set()
    with open(MANUAL_MATCHES_CSV, newline="") as fh:
        reader = csv.DictReader(fh)
        for i, row in enumerate(reader, start=2):
            pid = (row.get("player_id") or "").strip()
            spid = (row.get("sheet_player_id") or "").strip()
            action = (row.get("action") or "").strip().lower()
            if not pid and not action:
                continue  # blank line
            if action not in VALID_ACTIONS:
                raise SanityError(
                    f"manual_matches.csv line {i}: invalid action '{action}' "
                    f"(must be one of {sorted(VALID_ACTIONS)})"
                )
            if not pid:
                raise SanityError(f"manual_matches.csv line {i}: empty player_id")
            if action == "no_profile":
                no_profile.add(pid)
            elif action == "no_match":
                if not spid:
                    raise SanityError(
                        f"manual_matches.csv line {i}: no_match requires sheet_player_id"
                    )
                no_match_pairs.add((pid, spid))
            elif action == "match":
                if not spid:
                    raise SanityError(
                        f"manual_matches.csv line {i}: match requires sheet_player_id"
                    )
                if pid in matches and matches[pid] != spid:
                    raise SanityError(
                        f"manual_matches.csv: conflicting 'match' rows for player_id "
                        f"{pid} ({matches[pid]} vs {spid})"
                    )
                matches[pid] = spid
    return matches, no_match_pairs, no_profile


# --------------------------------------------------------------------------- #
# Resolution-column ingestion (new_players_reviewed.csv, ambiguous_matches.csv) #
# --------------------------------------------------------------------------- #
def _clean_cell(v):
    """Strip BOM/whitespace/wrapping quotes from a raw CSV cell. '' -> ''."""
    if v is None:
        return ""
    v = v.replace("﻿", "").strip()
    # Excel sometimes double-quotes an already-quoted cell.
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
        v = v[1:-1].strip()
    return v


def _clean_sheet_id(v):
    """Normalise a sheet_player_id cell.

    Excel/Numbers frequently coerce a numeric-looking id to a float and write
    it back as "12345.0" / "12345.00". Sheet ids are integer strings, so strip a
    pure ``.0*`` suffix. Non-numeric ids (rare) are returned as-is."""
    v = _clean_cell(v)
    if re.fullmatch(r"\d+\.0+", v):
        v = v.split(".", 1)[0]
    return v


def load_resolution_file(path, label):
    """Parse a YES/NO/NONE resolution-column file into override structures.

    Returns dict(matches=pid->spid, no_match=set((pid,spid)), no_profile=set(pid)).
    A missing file yields empty structures (both review CSVs are committed
    header-only, but be defensive). Raises SanityError (naming file + line) on:
      * an unknown resolution value (anything other than yes/no/none/blank),
      * YES with an empty sheet_player_id,
      * the same player_id given YES to two DIFFERENT sheet ids in THIS file.
    """
    matches, no_match, no_profile = {}, set(), set()
    if not os.path.exists(path):
        log(f"Resolution file absent (treated as empty): {label}")
        return {"matches": matches, "no_match": no_match, "no_profile": no_profile}

    # utf-8-sig transparently swallows a leading BOM on the first header cell.
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            log(f"Resolution file has no header (treated as empty): {label}")
            return {"matches": matches, "no_match": no_match, "no_profile": no_profile}
        needed = {"resolution", "player_id", "sheet_player_id"}
        missing_cols = needed - {(_clean_cell(c) or "") for c in reader.fieldnames}
        if missing_cols:
            raise SanityError(
                f"{label}: missing required column(s) {sorted(missing_cols)}"
            )
        for i, row in enumerate(reader, start=2):  # line 2 = first data row
            pid = _clean_cell(row.get("player_id"))
            spid = _clean_sheet_id(row.get("sheet_player_id"))
            res = _clean_cell(row.get("resolution")).lower()
            # Trailing blank lines / fully-empty rows are ignored.
            if not pid and not res and not spid:
                continue
            if res == "":
                continue  # undecided — safe default, skip
            if res not in VALID_RESOLUTIONS:
                raise SanityError(
                    f"{label} line {i}: unknown resolution '{res}' "
                    f"(allowed: YES / NO / NONE / blank, case-insensitive)"
                )
            if not pid:
                raise SanityError(
                    f"{label} line {i}: resolution '{res}' with empty player_id"
                )
            if res == "none":
                no_profile.add(pid)
            elif res == "no":
                if not spid:
                    # NO needs a pair to forbid; a NO with no sheet id is a
                    # no-op (nothing to forbid) — skip quietly.
                    continue
                no_match.add((pid, spid))
            elif res == "yes":
                if not spid:
                    raise SanityError(
                        f"{label} line {i}: YES with empty sheet_player_id "
                        f"(YES must name the matching sheet_player_id)"
                    )
                if pid in matches and matches[pid] != spid:
                    raise SanityError(
                        f"{label}: player_id {pid} has YES to two different "
                        f"sheet_player_ids ({matches[pid]} and {spid}) — "
                        f"exactly one candidate can be the match"
                    )
                matches[pid] = spid
    log(f"Loaded resolutions from {label}: "
        f"{len(matches)} YES, {len(no_match)} NO, {len(no_profile)} NONE")
    return {"matches": matches, "no_match": no_match, "no_profile": no_profile}


def merge_override_sources(sources):
    """Merge override sources by precedence into one (matches, no_match, no_profile).

    `sources` is an ordered list of (label, dict) HIGH precedence first. Each
    dict has keys matches/no_match/no_profile as produced by load_manual (wrapped)
    or load_resolution_file.

    Precedence rules:
      * The player-level decision (a positive YES/'match' vs a NONE/'no_profile')
        is fixed by the FIRST (highest) source that expresses either for that
        player; lower sources cannot change it (they are logged as shadowed).
      * A YES/'match' is blocked if the SAME pair is forbidden (NO/'no_match') by
        a source of equal-or-higher precedence.
      * NO/'no_match' pairs accumulate across all sources EXCEPT a pair that a
        higher-precedence source turned into a positive match (that match wins).
    Every shadowed / blocked directive is logged so the effect is auditable.
    """
    matches, no_profile = {}, set()
    locked = {}                 # pid -> (rank, label) that fixed the decision
    forbidden = {}              # (pid, spid) -> (rank, label) highest-precedence
    shadow_log = []

    for rank, (label, src) in enumerate(sources):
        # 1. Record forbidden pairs first (so same-source NO blocks same-source YES).
        for (pid, spid) in sorted(src["no_match"]):
            prev = forbidden.get((pid, spid))
            if prev is None or rank < prev[0]:
                forbidden[(pid, spid)] = (rank, label)

        # 2. NONE / no_profile (player-level negative).
        for pid in sorted(src["no_profile"]):
            if pid in locked:
                lr, ll = locked[pid]
                if ll != label or pid not in no_profile:
                    shadow_log.append(
                        f"  {label}: no_profile({pid}) shadowed by higher-precedence "
                        f"decision from {ll}")
                continue
            no_profile.add(pid)
            locked[pid] = (rank, label)

        # 3. YES / match (player-level positive).
        for pid, spid in sorted(src["matches"].items()):
            if pid in locked:
                lr, ll = locked[pid]
                shadow_log.append(
                    f"  {label}: match({pid}->{spid}) shadowed by higher-precedence "
                    f"decision from {ll}")
                continue
            fb = forbidden.get((pid, spid))
            if fb is not None and fb[0] <= rank:
                shadow_log.append(
                    f"  {label}: match({pid}->{spid}) blocked by no_match from "
                    f"{fb[1]} (equal-or-higher precedence)")
                continue
            matches[pid] = spid
            locked[pid] = (rank, label)

    # 4. A higher-precedence positive match trumps any lower no_match on the same
    #    pair: drop such forbidden pairs so combine() sees no contradiction.
    no_match_pairs = set()
    for (pid, spid), (frank, flabel) in forbidden.items():
        if matches.get(pid) == spid:
            shadow_log.append(
                f"  {flabel}: no_match({pid},{spid}) overridden by higher-precedence "
                f"match from {locked[pid][1]}")
            continue
        no_match_pairs.add((pid, spid))

    if shadow_log:
        log(f"Override precedence — {len(shadow_log)} directive(s) shadowed/blocked:")
        for line in shadow_log:
            log(line)

    return matches, no_match_pairs, no_profile


# --------------------------------------------------------------------------- #
# Universe attributes + automatic tiers                                       #
# --------------------------------------------------------------------------- #
def build_universe(con):
    """Universe = distinct player_id selected in an XI (match_players)."""
    con.execute("""
        CREATE OR REPLACE TEMP TABLE universe AS
        SELECT DISTINCT player_id AS pid
        FROM match_players
        WHERE player_id IS NOT NULL
    """)
    # Per-appearance rows from match_players joined to matches.
    con.execute("""
        CREATE OR REPLACE TEMP TABLE pmatch AS
        SELECT mp.player_id AS pid, mp.team, m.gender, m.team_type,
               m.match_date_1, m.match_id
        FROM match_players mp
        JOIN matches m ON mp.match_id = m.match_id
        WHERE mp.player_id IS NOT NULL
    """)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE uni_attr AS
        WITH agg AS (
            SELECT pid,
                   MAX(CASE WHEN gender='male'            THEN 1 ELSE 0 END) AS is_male,
                   MAX(CASE WHEN gender='female'          THEN 1 ELSE 0 END) AS is_female,
                   MAX(CASE WHEN team_type='international' THEN 1 ELSE 0 END) AS is_intl,
                   MAX(CASE WHEN team_type='club'         THEN 1 ELSE 0 END) AS is_club,
                   MAX(match_date_1) AS last_match,
                   COUNT(DISTINCT match_id) AS n_matches
            FROM pmatch GROUP BY pid
        ),
        intl_teams AS (
            SELECT pid, LIST(DISTINCT team) AS intl_team_list
            FROM pmatch WHERE team_type='international' GROUP BY pid
        ),
        all_teams AS (
            SELECT pid, LIST(DISTINCT team) AS all_team_list
            FROM pmatch GROUP BY pid
        )
        SELECT a.pid, pr.player_name,
               a.is_male, a.is_female, a.is_intl, a.is_club,
               a.last_match, a.n_matches,
               it.intl_team_list, alt.all_team_list
        FROM agg a
        JOIN player_registry pr ON pr.player_id = a.pid
        LEFT JOIN intl_teams it  ON it.pid = a.pid
        LEFT JOIN all_teams  alt ON alt.pid = a.pid
    """)
    n_uni = con.execute("SELECT COUNT(*) FROM universe").fetchone()[0]
    n_attr = con.execute("SELECT COUNT(*) FROM uni_attr").fetchone()[0]
    if n_attr != n_uni:
        # A universe pid with no registry row would be dropped by the JOIN.
        missing = con.execute("""
            SELECT COUNT(*) FROM universe u
            WHERE u.pid NOT IN (SELECT pid FROM uni_attr)
        """).fetchone()[0]
        log(f"  WARNING: {missing} universe player_id(s) missing from player_registry")
    log(f"Universe (XI-selected players): {n_uni:,}")
    return n_uni


def build_auto_tiers(con, held_ids):
    """Compute Tier-1a and Tier-1b automatic matches into temp table `auto_match`.

    Returns (n_1a, n_1b)."""
    held_list = "(" + ",".join(f"'{h}'" for h in held_ids) + ")" if held_ids else "('')"

    # Name-uniqueness on both sides (registry across ALL rows; sheet across all rows).
    con.execute("""
        CREATE OR REPLACE TEMP TABLE reg_name_counts AS
        SELECT player_name, COUNT(*) AS n FROM player_registry GROUP BY player_name
    """)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE sheet_bn_counts AS
        SELECT batting_name, COUNT(*) AS n FROM sheet GROUP BY batting_name
    """)

    # Exact byte-for-byte batting_name == player_name pairs, scored with evidence.
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE exact_scored AS
        SELECT
            ua.pid, ua.player_name,
            ua.is_male, ua.is_intl, ua.is_club,
            ua.intl_team_list, ua.all_team_list,
            s.sheet_player_id, s.batting_name, s.country_lc, s.major_team_names,
            rc.n AS reg_name_n,
            sc.n AS sheet_bn_n,
            country_in_intl_teams(ua.intl_team_list, s.country_lc) AS country_ok,
            team_contains(s.major_team_names, ua.all_team_list)    AS club_team_ok
        FROM uni_attr ua
        JOIN sheet s            ON s.batting_name = ua.player_name
        JOIN reg_name_counts rc ON rc.player_name = ua.player_name
        JOIN sheet_bn_counts sc ON sc.batting_name = s.batting_name
    """)

    # Tier 1a / 1b. Gender guard + held-id exclusion applied to BOTH.
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE auto_match AS
        SELECT pid, sheet_player_id,
               CASE WHEN is_intl = 1 THEN '1a' ELSE '1b' END AS match_tier
        FROM exact_scored
        WHERE reg_name_n = 1 AND sheet_bn_n = 1          -- unique on BOTH sides
          AND is_male = 1                                 -- gender guard (decision 1)
          AND pid NOT IN {held_list}                      -- held both-gender ids (decision 2)
          AND (
                (is_intl = 1 AND country_ok = TRUE)                         -- 1a
             OR (is_intl = 0 AND is_club = 1 AND club_team_ok = TRUE)       -- 1b
          )
    """)

    # Sanity: auto_match must be 1:1 on pid (sheet_bn_n=1 guarantees one sheet row
    # per unique registry name, so this holds; assert it).
    dup = con.execute("""
        SELECT COUNT(*) FROM (
            SELECT pid FROM auto_match GROUP BY pid HAVING COUNT(*) > 1
        )
    """).fetchone()[0]
    if dup:
        raise SanityError(f"auto_match not 1:1 on player_id ({dup} dup pids)")

    n_1a = con.execute("SELECT COUNT(*) FROM auto_match WHERE match_tier='1a'").fetchone()[0]
    n_1b = con.execute("SELECT COUNT(*) FROM auto_match WHERE match_tier='1b'").fetchone()[0]
    return n_1a, n_1b


# --------------------------------------------------------------------------- #
# Combine auto + manual -> final matched set                                  #
# --------------------------------------------------------------------------- #
def combine(con, matches, no_match_pairs, no_profile):
    """Produce temp table final_match(player_id, sheet_player_id, match_tier)."""
    # Pull auto matches into Python (small: a few thousand rows).
    auto = {
        pid: (spid, tier)
        for pid, spid, tier in con.execute(
            "SELECT pid, sheet_player_id, match_tier FROM auto_match"
        ).fetchall()
    }

    final = {}  # pid -> (sheet_player_id, match_tier)

    # 1. Auto matches, minus any pair explicitly forbidden by a no_match row.
    n_no_match_hits = 0
    for pid, (spid, tier) in auto.items():
        if (pid, spid) in no_match_pairs:
            n_no_match_hits += 1
            continue
        final[pid] = (spid, tier)

    # 2. Manual 'match' rows force/override the link (trump every rule).
    n_forced = 0
    for pid, spid in matches.items():
        if (pid, spid) in no_match_pairs:
            raise SanityError(
                f"manual_matches.csv: player {pid} has both 'match' and 'no_match' "
                f"for sheet_player_id {spid}"
            )
        final[pid] = (spid, "manual")
        n_forced += 1

    # 3. no_profile removes players entirely (highest-precedence removal).
    n_removed = 0
    for pid in no_profile:
        if pid in final:
            del final[pid]
            n_removed += 1

    # Validate manual 'match' targets exist (registry pid + sheet row).
    reg_ids = {r[0] for r in con.execute("SELECT player_id FROM player_registry").fetchall()}
    sheet_ids = {r[0] for r in con.execute("SELECT sheet_player_id FROM sheet").fetchall()}
    for pid, spid in matches.items():
        if pid not in no_profile:
            if pid not in reg_ids:
                raise SanityError(f"manual match player_id {pid} not in player_registry")
            if spid not in sheet_ids:
                raise SanityError(f"manual match sheet_player_id {spid} not in sheet")

    # Materialise.
    con.execute("""
        CREATE OR REPLACE TEMP TABLE final_match (
            player_id VARCHAR, sheet_player_id VARCHAR, match_tier VARCHAR
        )
    """)
    if final:
        con.executemany(
            "INSERT INTO final_match VALUES (?, ?, ?)",
            [(pid, spid, tier) for pid, (spid, tier) in final.items()],
        )

    log(f"Manual overrides applied: forced matches={n_forced}, "
        f"no_match removals={n_no_match_hits}, no_profile removals={n_removed}")
    return len(final)


# --------------------------------------------------------------------------- #
# Build player_profiles table                                                 #
# --------------------------------------------------------------------------- #
def build_profiles_table(con):
    """DROP + CREATE player_profiles from final_match. Never touches other tables."""
    con.execute("DROP TABLE IF EXISTS player_profiles")
    con.execute(f"""
        CREATE TABLE player_profiles AS
        SELECT
            fm.player_id,
            pr.player_name                                   AS registry_name,
            s.full_name,
            s.country_name                                   AS country,
            TRY_CAST(substr(s.date_of_birth, 1, 10) AS DATE) AS dob,
            s.position_name                                  AS playing_role,
            -- role_group (owner-approved 2026-07-07): wicketkeepers group under Batter.
            CASE
                WHEN s.position_name IN
                     ('Batter','Top-order batter','Middle-order batter','Opening batter',
                      'Wicketkeeper','Wicketkeeper batter')
                    THEN 'Batter'
                WHEN s.position_name IN
                     ('Allrounder','Bowling allrounder','Batting allrounder')
                    THEN 'Allrounder'
                WHEN s.position_name = 'Bowler'
                    THEN 'Bowler'
                ELSE NULL                                    -- 'Unknown' / anything else
            END                                              AS role_group,
            -- role_subgroup: position detail for batters, split for allrounders.
            CASE
                WHEN s.position_name IN ('Wicketkeeper','Wicketkeeper batter')
                    THEN 'Wicketkeeper'
                WHEN s.position_name = 'Opening batter'      THEN 'Opening'
                WHEN s.position_name = 'Top-order batter'    THEN 'Top-order'
                WHEN s.position_name = 'Middle-order batter' THEN 'Middle-order'
                WHEN s.position_name = 'Batting allrounder'  THEN 'Batting allrounder'
                WHEN s.position_name = 'Bowling allrounder'  THEN 'Bowling allrounder'
                ELSE NULL                                    -- plain Batter/Allrounder/Bowler/Unknown
            END                                              AS role_subgroup,
            s.batting_style,
            s.bowling_style,
            -- bowling_arm: parsed from the style text only, plus one owner-approved
            -- cricket definition: a legbreak (incl. googly) is right-arm by
            -- definition (the left-arm equivalent is listed as Left-arm wrist-spin).
            -- NEVER inferred from batting hand (owner directive).
            CASE
                WHEN s.bowling_style IS NULL OR trim(s.bowling_style) = '' THEN NULL
                WHEN lower(s.bowling_style) LIKE '%right-arm%' THEN 'Right'
                WHEN lower(s.bowling_style) LIKE '%left-arm%'  THEN 'Left'
                WHEN s.bowling_style IN ('Legbreak','Legbreak googly') THEN 'Right'
                ELSE NULL
            END                                              AS bowling_arm,
            -- bowling_type: specific-style filter vocabulary (owner-approved).
            -- NB slow-medium must be tested before medium (substring overlap).
            CASE
                WHEN s.bowling_style IS NULL OR trim(s.bowling_style) = '' THEN NULL
                WHEN s.bowling_style = 'Right-arm offbreak'            THEN 'Off-spin'
                WHEN s.bowling_style IN ('Legbreak','Legbreak googly') THEN 'Leg-spin'
                WHEN s.bowling_style = 'Slow left-arm orthodox'  THEN 'Slow left-arm orthodox'
                WHEN s.bowling_style = 'Left-arm wrist-spin'     THEN 'Left-arm wrist-spin'
                WHEN lower(s.bowling_style) LIKE '%slow-medium%' THEN 'Slow-medium'
                WHEN lower(s.bowling_style) LIKE '%medium-fast%' THEN 'Medium-fast'
                WHEN lower(s.bowling_style) LIKE '%fast-medium%' THEN 'Fast-medium'
                WHEN lower(s.bowling_style) LIKE '%medium%'      THEN 'Medium'
                WHEN lower(s.bowling_style) LIKE '%fast%'        THEN 'Fast'
                ELSE NULL       -- 'Right/Left-arm bowler', bare 'slow' (owner verdicts pending)
            END                                              AS bowling_type,
            CASE
                WHEN s.bowling_style IS NULL OR trim(s.bowling_style) = '' THEN NULL
                WHEN s.bowling_style IN ('Right-arm bowler','Left-arm bowler') THEN NULL
                WHEN lower(s.bowling_style) LIKE '%offbreak%'
                  OR lower(s.bowling_style) LIKE '%legbreak%'
                  OR lower(s.bowling_style) LIKE '%orthodox%'
                  OR lower(s.bowling_style) LIKE '%wrist-spin%'
                  OR lower(s.bowling_style) LIKE '%googly%'  THEN 'Spin'
                WHEN lower(s.bowling_style) LIKE '%medium%'
                  OR lower(s.bowling_style) LIKE '%fast%'    THEN 'Pace'
                -- Owner ruling 2026-07-07: bare "slow" in this dataset means spin.
                WHEN s.bowling_style IN ('Right-arm slow','Left-arm slow') THEN 'Spin'
                ELSE NULL
            END                                              AS bowling_group,
            s.major_team_names                               AS teams_played_for,
            s.headshot_url,
            (s.headshot_url IS NOT NULL AND trim(s.headshot_url) <> ''
             AND s.headshot_url <> '{DEFAULT_HEADSHOT_URL}')           AS has_real_headshot,
            fm.match_tier,
            fm.sheet_player_id
        FROM final_match fm
        JOIN sheet s            ON s.sheet_player_id = fm.sheet_player_id
        JOIN player_registry pr ON pr.player_id = fm.player_id
        ORDER BY fm.player_id
    """)
    n = con.execute("SELECT COUNT(*) FROM player_profiles").fetchone()[0]
    dup = con.execute("""
        SELECT COUNT(*) FROM (
            SELECT player_id FROM player_profiles GROUP BY player_id HAVING COUNT(*) > 1
        )
    """).fetchone()[0]
    if dup:
        raise SanityError(f"player_profiles has {dup} duplicate player_id groups")
    return n


# --------------------------------------------------------------------------- #
# Reporting helpers                                                           #
# --------------------------------------------------------------------------- #
def coverage_report(con):
    """Print coverage rates using the ROLLING 3-year recency cutoff (decision 7)."""
    cutoff = con.execute(
        "SELECT (MAX(match_date_1) - INTERVAL 3 YEAR)::DATE FROM matches"
    ).fetchone()[0]
    maxd = con.execute("SELECT MAX(match_date_1) FROM matches").fetchone()[0]

    def rate(where):
        r = con.execute(f"""
            WITH base AS (
                SELECT ua.pid,
                       (ua.pid IN (SELECT player_id FROM player_profiles)) AS matched
                FROM uni_attr ua
                {where}
            )
            SELECT COUNT(*), SUM(CASE WHEN matched THEN 1 ELSE 0 END) FROM base
        """).fetchone()
        n, m = r[0], (r[1] or 0)
        return m, n, (100.0 * m / n if n else 0.0)

    log("-" * 60)
    log(f"Coverage (rolling recency cutoff = {cutoff}, max match_date = {maxd}):")
    for label, where in [
        ("overall (incl. women)", ""),
        ("male only", "WHERE ua.is_male=1"),
        ("male + international", "WHERE ua.is_male=1 AND ua.is_intl=1"),
        (f"male + recent (>= {cutoff})",
         f"WHERE ua.is_male=1 AND ua.last_match >= DATE '{cutoff}'"),
        ("female only", "WHERE ua.is_female=1 AND ua.is_male=0"),
    ]:
        m, n, pc = rate(where)
        log(f"  {label:32s}: {m:>6,}/{n:>6,} = {pc:5.1f}%")


# --------------------------------------------------------------------------- #
# Both-gender tripwire (pipeline safety net, 2026-07-09)                      #
# --------------------------------------------------------------------------- #
def detect_new_both_gender_ids(con, held_ids, resolved_pids):
    """
    Owner-approved safety net (extends decision 2's held-id mechanism to
    future data). Decision 2 hard-coded the 10 both-gender player_ids known at
    the time into review/ambiguous_matches.csv (ambiguity_type
    'E_both_gender_id_held_by_owner'); those are excluded from automatic
    matching via `held_ids` in build_auto_tiers(). But a FUTURE Cricsheet
    ingest can reveal a NEW player_id with both >=1 men's and >=1 women's
    appearance that isn't in that static list yet.

    This recomputes the both-gender set from live data every run (`uni_attr`,
    built by build_universe(), already carries is_male/is_female per
    decision-9's XI-selected universe) and diffs it against the held list PLUS
    anything already resolved via manual_matches.csv / new_players_reviewed.csv
    / ambiguous_matches.csv's own resolution column (the merged
    matches/no_match_pairs/no_profile override surface — `resolved_pids`).

    Any newly-appearing id is:
      (a) excluded from automatic matching this run (caller folds the
          returned set into `held_ids` before calling build_auto_tiers), same
          treatment as a decision-2 held id;
      (b) logged loudly;
      (c) alerted via alerts.send_alert (best-effort; never raises).
    This function itself never raises SanityError and must never fail the run
    — a bug in the tripwire is a missed alert, not a broken pipeline.
    """
    both = {
        r[0] for r in con.execute(
            "SELECT pid FROM uni_attr WHERE is_male = 1 AND is_female = 1"
        ).fetchall()
    }
    already_known = held_ids | resolved_pids
    new_ids = both - already_known

    if new_ids:
        sorted_ids = sorted(new_ids)
        log("=" * 60)
        log(f"BOTH-GENDER TRIPWIRE: {len(new_ids)} NEW both-gender player_id(s) "
            f"detected (>=1 men's AND >=1 women's appearance) not in the held "
            f"list ({len(held_ids)} ids) and not already resolved via "
            f"manual/reviewed files: {sorted_ids}")
        log("Excluding from automatic matching this run pending owner review "
            "(same treatment as decision-2 held ids). Add rows to "
            "review/manual_matches.csv or resolve via the review CSVs to "
            "clear this permanently.")
        log("=" * 60)
        names = {}
        try:
            rows = con.execute(
                f"""
                SELECT pid, player_name FROM uni_attr
                WHERE pid IN ({",".join("'" + i + "'" for i in sorted_ids)})
                """
            ).fetchall()
            names = dict(rows)
        except Exception as e:  # never let alert body formatting break the run
            log(f"  WARN: could not fetch names for tripwire alert body: {e!r}")
        body_lines = "\n".join(f"  - {pid}  {names.get(pid, '?')}" for pid in sorted_ids)
        alerts.send_alert(
            "New both-gender player_id detected — held from auto-matching, needs owner review",
            f"The player_profiles rebuild found {len(new_ids)} NEW both-gender "
            f"player_id(s) (appear in at least one men's AND one women's match) "
            f"that are not in the existing held list and have not been resolved:\n\n"
            f"{body_lines}\n\n"
            f"These have been excluded from automatic matching this run (same as "
            f"the original 10 held ids from decision 2). Resolve via "
            f"review/manual_matches.csv, or add a row to "
            f"review/ambiguous_matches.csv with ambiguity_type "
            f"'E_both_gender_id_held_by_owner' to hold permanently. This is an "
            f"advisory; the run is green.\n",
        )
    else:
        log(f"Both-gender tripwire: 0 new ids (held list of {len(held_ids)} "
            f"+ {len(resolved_pids)} already-resolved id(s) still covers all).")
    return new_ids


def unmatched_summary(con):
    n = con.execute("""
        SELECT COUNT(*) FROM uni_attr ua
        WHERE ua.pid NOT IN (SELECT player_id FROM player_profiles)
    """).fetchone()[0]
    n_recent_male = con.execute("""
        WITH cutoff AS (SELECT (MAX(match_date_1) - INTERVAL 3 YEAR)::DATE AS c FROM matches)
        SELECT COUNT(*) FROM uni_attr ua, cutoff
        WHERE ua.pid NOT IN (SELECT player_id FROM player_profiles)
          AND ua.is_male = 1 AND ua.last_match >= cutoff.c
    """).fetchone()[0]
    log(f"Unmatched actives (in XI universe, no profile): {n:,} "
        f"(of which male & recent: {n_recent_male:,})")


# --------------------------------------------------------------------------- #
# Main                                                                        #
# --------------------------------------------------------------------------- #
def main():
    p = argparse.ArgumentParser(description="Rebuild player_profiles (Phase D2).")
    p.add_argument("--db", default=DEFAULT_DB)
    p.add_argument("--csv", default=DEFAULT_CSV)
    args = p.parse_args()

    t0 = time.time()
    log(f"build_profiles starting (db={args.db}, csv={args.csv})")

    if not os.path.exists(args.db):
        log(f"FATAL: database not found: {args.db}")
        sys.exit(1)
    if not os.path.exists(args.csv):
        log(f"FATAL: profiles CSV not found: {args.csv}")
        sys.exit(1)

    con = duckdb.connect(args.db)  # read-write: we DROP/CREATE only player_profiles
    con.create_function("norm_alnum", norm_alnum, ["VARCHAR"], "VARCHAR")
    con.create_function("team_contains", team_contains,
                        ["VARCHAR", "VARCHAR[]"], "BOOLEAN")
    con.create_function("country_in_intl_teams", country_in_intl_teams,
                        ["VARCHAR[]", "VARCHAR"], "BOOLEAN")

    try:
        # 1. Sanity gate BEFORE any write.
        run_sanity_gate(con)

        # 2. Inputs.
        load_sheet(con, args.csv)
        held_ids = load_held_ids(con)
        ensure_manual_file()

        # Override sources merged by precedence HIGH -> LOW (decision 18):
        #   1. manual_matches.csv        (direct-entry, highest)
        #   2. new_players_reviewed.csv  (owner-owned YES/NO/NONE)
        #   3. ambiguous_matches.csv     (its resolution column, YES/NO/NONE)
        m_matches, m_no_match, m_no_profile = load_manual()
        manual_src = {
            "matches": m_matches, "no_match": m_no_match, "no_profile": m_no_profile,
        }
        reviewed_src = load_resolution_file(REVIEWED_CSV, "new_players_reviewed.csv")
        ambiguous_src = load_resolution_file(AMBIGUOUS_CSV, "ambiguous_matches.csv")
        matches, no_match_pairs, no_profile = merge_override_sources([
            ("manual_matches.csv", manual_src),
            ("new_players_reviewed.csv", reviewed_src),
            ("ambiguous_matches.csv", ambiguous_src),
        ])

        # 3. Universe + automatic tiers.
        build_universe(con)

        # Both-gender tripwire (pipeline safety net): recompute the both-
        # gender set from live data and hold any NEW ones from auto-matching,
        # same as the decision-2 held ids. Never allowed to fail the run.
        resolved_pids = set(matches) | {pid for (pid, _spid) in no_match_pairs} | set(no_profile)
        try:
            new_both_gender = detect_new_both_gender_ids(con, held_ids, resolved_pids)
        except Exception as e:  # tripwire must never take down the pipeline
            log(f"WARNING: both-gender tripwire check failed (non-fatal): {e!r}")
            new_both_gender = set()

        n_1a, n_1b = build_auto_tiers(con, held_ids | new_both_gender)
        log(f"Automatic matches: Tier 1a (intl)={n_1a:,}, "
            f"Tier 1b (club, containment)={n_1b:,}, total={n_1a + n_1b:,}")

        # 4. Manual overrides LAST.
        n_final = combine(con, matches, no_match_pairs, no_profile)

        # 5. Build the table (DROP + CREATE).
        n_rows = build_profiles_table(con)
        by_tier = con.execute(
            "SELECT match_tier, COUNT(*) FROM player_profiles GROUP BY 1 ORDER BY 1"
        ).fetchall()
    except SanityError as e:
        log("=" * 60)
        log(f"ABORTED (no changes written to the DB before this point unless "
            f"player_profiles was being (re)created): {e}")
        log("=" * 60)
        con.close()
        sys.exit(1)

    log("-" * 60)
    log(f"player_profiles rebuilt: {n_rows:,} rows "
        f"(combine expected {n_final:,})")
    for tier, c in by_tier:
        log(f"  match_tier={tier:6s} : {c:,}")
    coverage_report(con)
    unmatched_summary(con)
    con.close()
    log(f"Done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
