"""
download_db.py
Downloads cricket.duckdb from Cloudflare R2 to the local runner.
"""

import os
from pathlib import Path

import boto3
import duckdb

DB_PATH = Path('data/cricket.duckdb')

# Core tables the pipeline always expects (build_profiles.py's sanity gate
# checks all 16; player_profiles may legitimately be absent on a fresh DB, so
# this is a smaller floor of tables that must always be there).
CORE_TABLES = {"matches", "deliveries", "wickets", "innings", "match_players"}
MIN_FILE_BYTES = 100_000_000  # real DB is ~1 GB; floor is well below normal size
MIN_MATCHES_ROWS = 20_000


def _send_alert_safe(subject, body):
    """Best-effort alert -- a missing/broken alerts module must never crash a
    check that is trying to catch a bad download."""
    try:
        import alerts
        alerts.send_alert(subject, body)
    except Exception as e:
        print(f"!!! could not send alert (non-fatal): {e!r}")


def check_db_integrity(path):
    """Exists, non-trivially sized, opens read-only in duckdb, has the core
    tables, and matches row count is sane. Returns None if OK, else a reason."""
    if not path.exists():
        return f"file does not exist: {path}"
    size = path.stat().st_size
    if size < MIN_FILE_BYTES:
        return f"file too small ({size:,} bytes < {MIN_FILE_BYTES:,} floor) -- looks truncated/corrupt"
    try:
        con = duckdb.connect(str(path), read_only=True)
    except Exception as e:
        return f"could not open as duckdb: {e!r}"
    try:
        present = {
            r[0] for r in con.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"
            ).fetchall()
        }
        missing = CORE_TABLES - present
        if missing:
            return f"missing core table(s): {sorted(missing)}"
        n = con.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
        if n < MIN_MATCHES_ROWS:
            return f"matches row count too low: {n:,} < {MIN_MATCHES_ROWS:,}"
    finally:
        con.close()
    return None


def main():
    s3 = boto3.client(
        's3',
        endpoint_url=os.environ['R2_ENDPOINT_URL'],
        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY']
    )

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    print("Downloading cricket.duckdb from R2...")
    s3.download_file('cricket-db', 'cricket.duckdb', str(DB_PATH))
    print(f"Done. Saved to {DB_PATH}")

    reason = check_db_integrity(DB_PATH)
    if reason:
        msg = f"download_db: downloaded file failed integrity check: {reason}"
        print(msg)
        _send_alert_safe(
            "DB download integrity check failed",
            f"{msg}\n\nPath: {DB_PATH}\n",
        )
        raise SystemExit(1)
    print("Integrity check passed.")


if __name__ == "__main__":
    main()
