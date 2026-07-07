"""
check_ingest.py — turn ingest failures into a specific owner email while keeping
the run GREEN (owner decision 11: runs stay green and the site keeps updating
when individual Cricsheet files fail; the owner is emailed instead).

Parses data/ingest.log written by pipeline/ingest.py, whose summary block prints:

    ...  INFO  Errors    : N
    ...  ERROR FAILED: <filename> — <error text>

If N > 0:
  * collect the failed filenames from the FAILED lines,
  * track persistent failures in R2 pipeline-state/ingest_failures.json
    (file -> first_seen date) so the email can say "failing since [date]",
  * email at most once per day OR whenever the failing set changes,
  * exit 0 (stay green).

If N == 0:
  * prune any recovered files from the state, exit quietly.

R2 pipeline-state key: ingest_failures.json
"""

import datetime as _dt
import re
import sys
from pathlib import Path

import alerts
import state_store

LOG_PATH = Path("data/ingest.log")
STATE_KEY = "ingest_failures.json"
FAIL_SEP = " — "  # em dash used by ingest.py's "FAILED: name — err"
ERRORS_RE = re.compile(r"Errors\s*:\s*(\d+)")


def _today():
    return _dt.date.today().isoformat()


def _now():
    return _dt.datetime.now(_dt.timezone.utc)


def _parse_log(text):
    """Return (errors_count, [(filename, err), ...]). errors_count is taken from
    the summary line; the FAILED lines give the per-file detail."""
    errors_count = None
    failed = []
    for line in text.splitlines():
        m = ERRORS_RE.search(line)
        if m:
            errors_count = int(m.group(1))
        if "FAILED: " in line:
            detail = line.split("FAILED: ", 1)[1].strip()
            if FAIL_SEP in detail:
                fname, err = detail.split(FAIL_SEP, 1)
            else:
                fname, err = detail, ""
            failed.append((fname.strip(), err.strip()))
    return errors_count, failed


def main():
    if not LOG_PATH.exists():
        print(f"check_ingest: {LOG_PATH} not found — nothing to check; exit 0")
        return 0

    text = LOG_PATH.read_text(encoding="utf-8", errors="replace")
    errors_count, failed = _parse_log(text)

    if errors_count is None:
        print("check_ingest: no 'Errors : N' summary line found — exit 0")
        return 0

    state = state_store.get_json(STATE_KEY, default={}) or {}
    failures = state.get("failures", {})  # filename -> first_seen date

    failed_names = [f for f, _ in failed]

    if errors_count == 0 and not failed_names:
        # Clean run — prune everything that recovered.
        if failures:
            recovered = sorted(failures)
            print(f"check_ingest: ingest clean; pruning recovered files: {recovered}")
        else:
            print("check_ingest: ingest clean; no tracked failures. exit 0")
        state["failures"] = {}
        state["last_alert_files"] = []
        state_store.put_json(STATE_KEY, state)
        return 0

    today = _today()

    # Refresh state: keep first_seen for still-failing files, add today for new,
    # drop files that recovered this run.
    new_failures = {}
    for name in failed_names:
        new_failures[name] = failures.get(name, today)
    recovered = sorted(set(failures) - set(new_failures))
    if recovered:
        print(f"check_ingest: files recovered since last run: {recovered}")

    # Decide whether to email: at most once/day, but always when the set changes.
    last_alert_files = set(state.get("last_alert_files", []))
    last_alert_at = state.get("last_alert_at")
    set_changed = set(new_failures) != last_alert_files
    day_elapsed = True
    if last_alert_at and not set_changed:
        try:
            elapsed = _now() - _dt.datetime.fromisoformat(last_alert_at)
            day_elapsed = elapsed >= _dt.timedelta(days=1)
        except ValueError:
            day_elapsed = True

    should_alert = set_changed or day_elapsed

    lines = []
    err_by_name = dict(failed)
    for name in sorted(new_failures):
        first_seen = new_failures[name]
        since = "today" if first_seen == today else f"since {first_seen}"
        lines.append(f"  - {name} (failing {since}): {err_by_name.get(name, '')}")
    body_list = "\n".join(lines)

    print(f"check_ingest: {errors_count} ingest error(s):")
    print(body_list)

    if should_alert:
        alerts.send_alert(
            f"Ingestion: {len(new_failures)} Cricsheet file(s) failed",
            f"The latest pipeline run ingested successfully overall (the run is "
            f"green and the site is updating), but {len(new_failures)} file(s) "
            f"failed to ingest:\n\n{body_list}\n\n"
            f"These are tracked; you'll be reminded at most once a day while they "
            f"keep failing. A file drops off this list automatically once it "
            f"ingests cleanly.\n",
        )
        state["last_alert_files"] = sorted(new_failures)
        state["last_alert_at"] = _now().isoformat()
    else:
        print("check_ingest: same failing set alerted <24h ago — not re-emailing")

    state["failures"] = new_failures
    state_store.put_json(STATE_KEY, state)
    return 0  # stay green


if __name__ == "__main__":
    sys.exit(main())
