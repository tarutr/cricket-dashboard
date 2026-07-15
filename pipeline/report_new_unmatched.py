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

Throttle-fix note (pipeline safety net, 2026-07-09): a player id is only
folded into the "seen" baseline (state["alerted_ids"]) once it has actually
been named in a SENT alert. Previously the code overwrote
state["unmatched_ids"] with the full current set on EVERY run, regardless of
whether the weekly throttle suppressed the email — so an id that appeared
during a suppressed week silently became "known" and could never trigger a
future alert. Now ids that show up while throttled stay in `new_ids` (and
keep being logged) until an alert actually fires for them. See
_load_alerted_ids() for the one-time migration of pre-fix state.

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


def _migrate_alerted_ids(state):
    """
    Return the pre-fix "seen" baseline to treat as `alerted_ids` on the first
    run after this fix deploys.

    Old state only ever had `unmatched_ids` (the raw current-set snapshot,
    overwritten every run regardless of whether an alert was sent — the bug
    this migration is undoing). We have no way to tell, after the fact, which
    of those ids were actually named in a past sent email vs. silently folded
    in behind a throttled week. Treating the whole old snapshot as
    already-alerted is the safe, non-flooding choice: it costs at most one
    extra throttle cycle for any id that was genuinely stuck behind the bug
    (it will surface again the next time it goes on to be dropped from
    current_ids and reappear later — see the reset in main()), but avoids
    re-alerting the owner about the entire historical backlog the run after
    this fix ships.
    """
    return set(state.get("unmatched_ids", []))


def _run():
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

    # First-ever run: no baseline exists at all — record the current set
    # quietly and never treat the historical backlog as "new" (it would email
    # thousands). Both keys are seeded identically: nothing has been alerted,
    # but nothing should be reported as new either.
    if "unmatched_ids" not in state and "alerted_ids" not in state:
        print(
            f"report_new_unmatched: first run — baselining "
            f"{len(current_ids)} existing unmatched players (no alert)"
        )
        state["unmatched_ids"] = sorted(current_ids)
        state["alerted_ids"] = sorted(current_ids)
        state["updated_at"] = now.isoformat()
        state_store.put_json(STATE_KEY, state)
        return 0

    # Migrate pre-fix state (has unmatched_ids but no alerted_ids yet) once.
    if "alerted_ids" not in state:
        state["alerted_ids"] = sorted(_migrate_alerted_ids(state))
        print("report_new_unmatched: migrating pre-fix state — seeding "
              f"alerted_ids from {len(state['alerted_ids'])} previously-known id(s)")

    # `alerted_ids` is the "seen via a SENT alert" baseline. Drop ids that are
    # no longer unmatched (resolved) so that if they regress later they are
    # correctly treated as new again rather than staying silently suppressed.
    alerted = set(state["alerted_ids"]) & current_ids

    new_ids = sorted(current_ids - alerted)
    # `recovered` is purely informational: ids present in the last snapshot
    # (alerted or not) that are no longer unmatched.
    recovered = sorted(set(state.get("unmatched_ids", [])) - current_ids)

    print(f"report_new_unmatched: {len(current_ids)} unmatched active players total")
    if recovered:
        print(f"  {len(recovered)} previously-unmatched now matched (resolved).")

    if new_ids:
        shown = new_ids[:25]
        listing = ", ".join(f"{pid} ({current[pid]})" for pid in shown)
        extra = f" … and {len(new_ids) - len(shown)} more" if len(new_ids) > len(shown) else ""
        print(f"NEW unmatched active players (not yet in a sent alert): {listing}{extra}")
    else:
        print("NEW unmatched active players (not yet in a sent alert): (none)")

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
        # Only NOW fold these ids into the seen baseline — they have actually
        # been named in a sent alert.
        alerted |= set(new_ids)
    elif new_ids:
        print("  new unmatched present but weekly advisory already sent — no "
              "email (they remain eligible for the next alert)")

    state["alerted_ids"] = sorted(alerted)
    state["unmatched_ids"] = sorted(current_ids)  # observability / back-compat snapshot only
    state["updated_at"] = now.isoformat()
    state_store.put_json(STATE_KEY, state)
    return 0


def main():
    # Advisory reporting step — a transient failure (e.g. an R2 pipeline-state blip
    # inside state_store) must NEVER fail the whole data refresh, which runs BEFORE
    # the export step. Mirror queue_new_for_review.py: log and exit 0 on any runtime
    # error. (SystemExit from bad CLI args is a BaseException and still propagates.)
    try:
        return _run()
    except Exception as e:  # noqa: BLE001 — never fail the run
        print(f"report_new_unmatched: non-fatal error: {e!r} — exiting 0")
        return 0


if __name__ == "__main__":
    sys.exit(main())
