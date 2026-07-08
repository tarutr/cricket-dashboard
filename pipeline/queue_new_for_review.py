#!/usr/bin/env python3
"""
queue_new_for_review.py — Phase D-review (owner decision 18, two-sheet workflow).

Runs in CI AFTER the player_profiles rebuild and AFTER report_new_unmatched.py.
For each GENUINELY NEW unmatched active player it appends one advisory row per
candidate to review/new_players_for_review.csv (pipeline-owned, append-only). The
owner later fills the resolution column and moves completed rows into
review/new_players_reviewed.csv; build_profiles.py applies both automatically.

"Unmatched active player" = the same universe report_new_unmatched.py uses:
a player_id selected in an XI (owner decision 9: present in match_players) but
absent from the rebuilt player_profiles table.

Baseline / diff pattern
-----------------------
This reuses report_new_unmatched.py's baseline-on-first-run diff pattern, but with
its OWN state key. It CANNOT share report_new_unmatched.py's `known_unmatched.json`
because that step runs FIRST in the workflow and overwrites the key with the
current set, so a shared read here would always diff to empty. Using a dedicated
key keeps first-run baselining correct without touching report_new_unmatched.py.
State key: pipeline-state/queued_for_review.json  ({"unmatched_ids": [...], ...}).

Idempotency is doubly guaranteed:
  * the baseline diff only surfaces ids new since the previous run, AND
  * a player already present (by player_id) in ANY of the four review files
    (new_players_for_review, new_players_reviewed, ambiguous_matches,
    manual_matches) is never appended again.

Never fails the run: any unexpected error is logged and the script exits 0.
`--dry-run` prints what it WOULD queue and writes nothing (no CSV, no state).
"""

import argparse
import csv
import datetime as _dt
import os
import sys
from pathlib import Path

import state_store

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
REVIEW_DIR = os.path.join(_REPO, "review")

FOR_REVIEW_CSV = os.path.join(REVIEW_DIR, "new_players_for_review.csv")
REVIEWED_CSV = os.path.join(REVIEW_DIR, "new_players_reviewed.csv")
AMBIGUOUS_CSV = os.path.join(REVIEW_DIR, "ambiguous_matches.csv")
MANUAL_MATCHES_CSV = os.path.join(REVIEW_DIR, "manual_matches.csv")

STATE_KEY = "queued_for_review.json"

# The exact header shared by new_players_for_review.csv / new_players_reviewed.csv.
HEADER = [
    "resolution", "resolution_note",
    "player_id", "db_name", "db_matches", "db_intl_matches", "db_club_matches",
    "db_last_match", "db_team_type", "db_teams",
    "sheet_player_id", "sheet_batting_name", "sheet_country", "sheet_major_teams",
    "sheet_dob", "sheet_intl_innings", "sheet_club_t20_innings",
    "sheet_playercard_url",
]

DEFAULT_DB = "data/cricket.duckdb"
DEFAULT_PROFILES_CSV = "data/profiles.csv"


def _now():
    return _dt.datetime.now(_dt.timezone.utc)


def log(msg):
    print(f"queue_new_for_review: {msg}", flush=True)


# --------------------------------------------------------------------------- #
# DB queries                                                                  #
# --------------------------------------------------------------------------- #
def _current_unmatched(con):
    """dict pid -> name for players in an XI but absent from player_profiles.

    Returns None if player_profiles is missing (build didn't run)."""
    tables = {
        r[0] for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema='main'"
        ).fetchall()
    }
    if "player_profiles" not in tables:
        log("player_profiles table absent — nothing to do")
        return None
    rows = con.execute(
        """
        SELECT DISTINCT mp.player_id AS pid, pr.player_name AS name
        FROM match_players mp
        JOIN player_registry pr ON pr.player_id = mp.player_id
        WHERE mp.player_id IS NOT NULL
          AND mp.player_id NOT IN (SELECT player_id FROM player_profiles)
        """
    ).fetchall()
    return {pid: name for pid, name in rows}


def _db_advisory(con, pids):
    """dict pid -> advisory db fields for the given player_ids.

    Fields mirror review/ambiguous_matches.csv:
      db_name, db_matches, db_intl_matches, db_club_matches, db_last_match,
      db_team_type ('international'/'international/club'/'/club'/''), db_teams
      (up to 5 distinct teams, pipe-joined).
    """
    if not pids:
        return {}
    con.execute("CREATE OR REPLACE TEMP TABLE _q_pids (pid VARCHAR)")
    con.executemany("INSERT INTO _q_pids VALUES (?)", [(p,) for p in pids])
    rows = con.execute(
        """
        WITH pm AS (
            SELECT mp.player_id AS pid, mp.team AS team,
                   m.team_type AS team_type, m.match_date_1 AS md, m.match_id AS mid
            FROM match_players mp
            JOIN matches m ON mp.match_id = m.match_id
            WHERE mp.player_id IN (SELECT pid FROM _q_pids)
        )
        SELECT p.pid,
               pr.player_name,
               COUNT(DISTINCT p.mid)                                       AS db_matches,
               COUNT(DISTINCT CASE WHEN p.team_type='international'
                                   THEN p.mid END)                         AS db_intl,
               COUNT(DISTINCT CASE WHEN p.team_type='club'
                                   THEN p.mid END)                         AS db_club,
               MAX(p.md)                                                   AS last_match,
               MAX(CASE WHEN p.team_type='international' THEN 1 ELSE 0 END) AS has_intl,
               MAX(CASE WHEN p.team_type='club'          THEN 1 ELSE 0 END) AS has_club,
               LIST(DISTINCT p.team)                                       AS teams
        FROM pm p
        JOIN player_registry pr ON pr.player_id = p.pid
        GROUP BY p.pid, pr.player_name
        """
    ).fetchall()
    out = {}
    for (pid, name, dbm, dbi, dbc, last_match, has_intl, has_club, teams) in rows:
        if has_intl and has_club:
            team_type = "international/club"
        elif has_intl:
            team_type = "international"
        elif has_club:
            team_type = "club"
        else:
            team_type = ""
        teams = [t for t in (teams or []) if t]
        out[pid] = {
            "db_name": name or "",
            "db_matches": dbm,
            "db_intl_matches": dbi,
            "db_club_matches": dbc,
            "db_last_match": ("" if last_match is None else str(last_match)),
            "db_team_type": team_type,
            "db_teams": "|".join(teams[:5]),
        }
    return out


# --------------------------------------------------------------------------- #
# Profiles-sheet candidate lookup                                             #
# --------------------------------------------------------------------------- #
def _int0(v):
    v = (v or "").strip()
    try:
        return int(float(v)) if v else 0
    except ValueError:
        return 0


def _load_candidates_index(profiles_csv):
    """batting_name (byte-exact) -> list of candidate sheet-field dicts."""
    index = {}
    with open(profiles_csv, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            bn = row.get("batting_name")
            if not bn:
                continue
            intl = (_int0(row.get("odi_batting_innings_count"))
                    + _int0(row.get("odi_bowling_innings_count"))
                    + _int0(row.get("t20i_batting_innings_count"))
                    + _int0(row.get("t20i_bowling_innings_count")))
            club = (_int0(row.get("t20_batting_innings_count"))
                    + _int0(row.get("t20_bowling_innings_count")))
            index.setdefault(bn, []).append({
                "sheet_player_id": row.get("player_id") or "",
                "sheet_batting_name": bn,
                "sheet_country": row.get("country_name") or "",
                "sheet_major_teams": row.get("major_team_names") or "",
                "sheet_dob": row.get("date_of_birth") or "",
                "sheet_intl_innings": intl,
                "sheet_club_t20_innings": club,
                "sheet_playercard_url": row.get("playercard_url") or "",
            })
    return index


# --------------------------------------------------------------------------- #
# Existing-ids scan across the four review files                              #
# --------------------------------------------------------------------------- #
def _ids_in_file(path):
    ids = set()
    if not os.path.exists(path):
        return ids
    with open(path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        if not reader.fieldnames or "player_id" not in [c.strip() for c in reader.fieldnames]:
            return ids
        for row in reader:
            pid = (row.get("player_id") or "").strip()
            if pid:
                ids.add(pid)
    return ids


def _already_present_ids():
    ids = set()
    for path in (FOR_REVIEW_CSV, REVIEWED_CSV, AMBIGUOUS_CSV, MANUAL_MATCHES_CSV):
        ids |= _ids_in_file(path)
    return ids


# --------------------------------------------------------------------------- #
# Row assembly + append                                                       #
# --------------------------------------------------------------------------- #
def _build_rows(pids, db_adv, cand_index):
    """List of full-header dict rows: one per candidate, or one empty-sheet row."""
    rows = []
    for pid in pids:
        adv = db_adv.get(pid, {})
        base = {c: "" for c in HEADER}
        base["player_id"] = pid
        base["db_name"] = adv.get("db_name", "")
        base["db_matches"] = adv.get("db_matches", "")
        base["db_intl_matches"] = adv.get("db_intl_matches", "")
        base["db_club_matches"] = adv.get("db_club_matches", "")
        base["db_last_match"] = adv.get("db_last_match", "")
        base["db_team_type"] = adv.get("db_team_type", "")
        base["db_teams"] = adv.get("db_teams", "")
        cands = cand_index.get(adv.get("db_name", ""), [])
        if not cands:
            rows.append(dict(base))
            continue
        for cand in cands:
            r = dict(base)
            r.update(cand)
            rows.append(r)
    return rows


def _ensure_for_review_header():
    if os.path.exists(FOR_REVIEW_CSV):
        return
    os.makedirs(REVIEW_DIR, exist_ok=True)
    with open(FOR_REVIEW_CSV, "w", newline="", encoding="utf-8") as fh:
        csv.DictWriter(fh, fieldnames=HEADER).writeheader()
    log(f"Created {FOR_REVIEW_CSV} (header only)")


def _append_rows(rows):
    """Append rows to new_players_for_review.csv, never rewriting existing rows."""
    _ensure_for_review_header()
    with open(FOR_REVIEW_CSV, "a", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=HEADER)
        for r in rows:
            writer.writerow(r)


# --------------------------------------------------------------------------- #
# Main                                                                        #
# --------------------------------------------------------------------------- #
def run(db_path, profiles_csv, dry_run):
    if not Path(db_path).exists():
        log(f"{db_path} not found — exit 0")
        return 0

    import duckdb

    con = duckdb.connect(db_path, read_only=True)
    try:
        current = _current_unmatched(con)
        if current is None:
            return 0
        current_ids = set(current)

        state = state_store.get_json(STATE_KEY, default={}) or {}
        now = _now()

        # First-ever run: baseline the existing backlog, queue NOTHING.
        if "unmatched_ids" not in state:
            log(f"first run — baselining {len(current_ids)} existing unmatched "
                f"players (queuing none)")
            if not dry_run:
                state_store.put_json(STATE_KEY, {
                    "unmatched_ids": sorted(current_ids),
                    "updated_at": now.isoformat(),
                })
            else:
                log("(dry-run) baseline NOT written")
            return 0

        baseline = set(state.get("unmatched_ids", []))
        new_since_last = sorted(current_ids - baseline)
        already = _already_present_ids()
        to_queue = [pid for pid in new_since_last if pid not in already]
        skipped = [pid for pid in new_since_last if pid in already]

        log(f"{len(current_ids)} unmatched active players total; "
            f"{len(new_since_last)} new since last run; "
            f"{len(skipped)} of those already in a review file; "
            f"{len(to_queue)} to queue")

        rows = []
        if to_queue:
            db_adv = _db_advisory(con, to_queue)
            cand_index = _load_candidates_index(profiles_csv)
            rows = _build_rows(to_queue, db_adv, cand_index)
            for pid in to_queue:
                ncand = len(cand_index.get(db_adv.get(pid, {}).get("db_name", ""), []))
                log(f"  queue {pid} ({current.get(pid, '?')}) — "
                    f"{ncand} candidate(s)")

        if dry_run:
            log(f"(dry-run) would append {len(rows)} row(s) for "
                f"{len(to_queue)} player(s); state NOT updated")
            return 0

        if rows:
            _append_rows(rows)
            log(f"appended {len(rows)} row(s) to {FOR_REVIEW_CSV}")
        else:
            log("nothing to append")

        state_store.put_json(STATE_KEY, {
            "unmatched_ids": sorted(current_ids),
            "updated_at": now.isoformat(),
        })
        return 0
    finally:
        con.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--profiles-csv", default=DEFAULT_PROFILES_CSV)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        return run(args.db, args.profiles_csv, args.dry_run)
    except Exception as e:  # noqa: BLE001 — never fail the run
        log(f"!!! non-fatal error: {e!r} — exiting 0")
        return 0


if __name__ == "__main__":
    sys.exit(main())
