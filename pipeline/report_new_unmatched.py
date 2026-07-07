"""
report_new_unmatched.py — surface NEWLY-unmatched active players after each
player_profiles rebuild, so the owner can resolve them at leisure.

Does NOT touch build_profiles.py's matching. Read-only against cricket.duckdb:
the player universe is every player selected in an XI (owner decision 9:
present in match_players); "unmatched" = in that universe but absent from the
rebuilt player_profiles table.

Each run diffs the current unmatched set against R2
pipeline-state/known_unmatched.json, logs any NEW ones in the step output,
uploads the refreshed set, and — only when new ones appear — includes them in a
weekly-throttled advisory email. Never fails the run.

Adaptation note (see report_back): SPEC_ADDENDUM D3.5 said "append to a review
file in the repo." CI cannot safely commit, so this uses R2 + step log + email
instead; the orchestrator will surface this for owner sign-off.

R2 pipeline-state key: known_unmatched.json
"""

import argparse
import datetime as _dt
import sys
from pathlib import Path

import alerts
import state_store

STATE_KEY = "known_unmatched.json"
ALERT_INTERVAL_DAYS = 7


def _now():
    return _dt.datetime.now(_dt.timezone.utc)


def _current_unmatched(db_path):
    import duckdb

    con = duckdb.connect(db_path, read_only=True)
    try:
        tables = {
            r[0]
            for r in con.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema='main'"
            ).fetchall()
        }
        if "player_profiles" not in tables:
            print("report_new_unmatched: player_profiles table absent — skipping")
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
    finally:
        con.close()
    return {pid: name for pid, name in rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/cricket.duckdb")
    args = ap.parse_args()

    if not Path(args.db).exists():
        print(f"report_new_unmatched: {args.db} not found — exit 0")
        return 0

    current = _current_unmatched(args.db)
    if current is None:
        return 0

    now = _now()
    state = state_store.get_json(STATE_KEY, default={}) or {}
    current_ids = set(current)

    # First-ever run: no baseline exists — record the current set quietly and
    # never treat the historical backlog as "new" (it would email thousands).
    if "unmatched_ids" not in state:
        print(
            f"report_new_unmatched: first run — baselining "
            f"{len(current_ids)} existing unmatched players (no alert)"
        )
        state["unmatched_ids"] = sorted(current_ids)
        state["updated_at"] = now.isoformat()
        state_store.put_json(STATE_KEY, state)
        return 0

    known = set(state.get("unmatched_ids", []))
    new_ids = sorted(current_ids - known)
    recovered = sorted(known - current_ids)

    print(f"report_new_unmatched: {len(current_ids)} unmatched active players total")
    if recovered:
        print(f"  {len(recovered)} previously-unmatched now matched (resolved).")

    if new_ids:
        shown = new_ids[:25]
        listing = ", ".join(f"{pid} ({current[pid]})" for pid in shown)
        extra = f" … and {len(new_ids) - len(shown)} more" if len(new_ids) > len(shown) else ""
        print(f"NEW unmatched active players since last run: {listing}{extra}")
    else:
        print("NEW unmatched active players since last run: (none)")

    # Weekly-throttled advisory, only when new unmatched players appear.
    last_alert_at = state.get("last_alert_at")
    due = True
    if last_alert_at:
        try:
            due = (now - _dt.datetime.fromisoformat(last_alert_at)) >= _dt.timedelta(
                days=ALERT_INTERVAL_DAYS
            )
        except ValueError:
            due = True

    if new_ids and due:
        shown = new_ids[:50]
        body_lines = "\n".join(f"  - {pid}  {current[pid]}" for pid in shown)
        if len(new_ids) > len(shown):
            body_lines += f"\n  … and {len(new_ids) - len(shown)} more"
        alerts.send_alert(
            f"{len(new_ids)} new unmatched active player(s)",
            f"The latest player_profiles rebuild found "
            f"{len(new_ids)} newly-unmatched active player(s) (selected in an XI "
            f"but with no profile):\n\n{body_lines}\n\n"
            f"Resolve at your leisure via review/manual_matches.csv — profiles "
            f"appear on the next run. This is an advisory; the run is green.\n",
        )
        state["last_alert_at"] = now.isoformat()
    elif new_ids:
        print("  new unmatched present but weekly advisory already sent — no email")

    state["unmatched_ids"] = sorted(current_ids)
    state["updated_at"] = now.isoformat()
    state_store.put_json(STATE_KEY, state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
