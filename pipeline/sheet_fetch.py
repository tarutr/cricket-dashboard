"""
sheet_fetch.py — fetch an enrichment sheet from a share URL, with a durable
last-good-copy fallback, content-change detection, and honest alerting.

Design principle (SPEC_ADDENDUM_DATA.md D3): an enrichment sheet is copied into
our systems on every run. A broken or stale link must NEVER break the site and
must NEVER fail silently. On success we persist a "last good copy"; on failure
we serve that copy, email the owner specifically, and let a later workflow step
turn the run red. Everything self-heals when the source recovers.

Parameterized so every future sheet reuses it verbatim:

  python pipeline/sheet_fetch.py \
      --name profiles \
      --url-env DROPBOX_PROFILES_URL \
      --out data/profiles.csv \
      --expect-header player_id \
      --seed source_data/cricinfo_player_profiles.csv

Behavior:
  SUCCESS   fetched + header valid → write --out; hash it; update R2 state
            (content_changed_at bumps only when the hash changes); upload the
            fresh copy as the last-good copy; write local meta
            (source="dropbox"); optionally emit a staleness advisory. Exit 0.
  FAILURE   unreachable / bad header / HTTP error after retries → restore the
            last-good copy from R2 to --out (source="last-good-copy"); if none,
            fall back to the committed --seed (source="seed"); email + drop a
            `data/{name}_fetch_failed` marker; exit 0 so the pipeline keeps
            shipping. Only if neither last-good nor seed exists → exit 1.

R2 pipeline-state keys used (via state_store, prefix `pipeline-state/`):
  {name}_state.json        fetched_at / content_changed_at / sha / staleness
  {name}_last_good.csv     most recent successfully-fetched sheet

Local meta for the export step: data/{name}_fetch_meta.json
"""

import argparse
import datetime as _dt
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

import requests

import alerts
import state_store

TIMEOUT_SECONDS = 30
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 3
STALE_ALERT_INTERVAL_DAYS = 7  # re-alert cadence while staleness persists


def _now():
    return _dt.datetime.now(_dt.timezone.utc)


def _iso(dt):
    return dt.isoformat() if dt else None


def _parse(iso):
    if not iso:
        return None
    return _dt.datetime.fromisoformat(iso)


def _stale_days():
    raw = os.environ.get("STALE_DAYS", "21")
    try:
        return int(raw)
    except (TypeError, ValueError):
        print(f"WARN: STALE_DAYS={raw!r} is not an int; using default 21")
        return 21


def _direct_download(url):
    """Normalize a Dropbox share URL to its direct-download form (dl=1).

    Harmless if the URL already uses dl=1 or is not a Dropbox link.
    """
    if "dl=0" in url:
        return url.replace("dl=0", "dl=1")
    if "dl=1" in url or "dl=" in url:
        return url
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}dl=1"


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _fetch_to(url, dest, expect_header):
    """Fetch url → dest with retries. Returns None on success, else an error
    string describing why the fetch is considered failed."""
    dl_url = _direct_download(url)
    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.get(dl_url, timeout=TIMEOUT_SECONDS, stream=True)
            resp.raise_for_status()
            Path(dest).parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as fh:
                for chunk in resp.iter_content(chunk_size=1 << 16):
                    if chunk:
                        fh.write(chunk)
            # Header validation: first line must start with the expected prefix.
            with open(dest, "r", encoding="utf-8", errors="replace") as fh:
                first_line = fh.readline().lstrip("﻿").rstrip("\r\n")
            if not first_line.startswith(expect_header):
                last_err = (
                    f"header mismatch: first line {first_line[:80]!r} does not "
                    f"start with {expect_header!r}"
                )
                print(f"  attempt {attempt}: {last_err}")
            else:
                print(f"  attempt {attempt}: OK ({first_line[:60]!r} ...)")
                return None
        except Exception as e:  # noqa: BLE001 — any failure = fetch failure
            last_err = f"{type(e).__name__}: {e}"
            print(f"  attempt {attempt}: {last_err}")

        if attempt < MAX_ATTEMPTS:
            time.sleep(BACKOFF_BASE_SECONDS * attempt)

    return last_err or "unknown fetch failure"


def _write_meta(out_path, name, source, fetched_at, content_changed_at, sha):
    meta = {
        "name": name,
        "source": source,  # "dropbox" | "last-good-copy" | "seed"
        "fetched_at": fetched_at,
        "content_changed_at": content_changed_at,
        "sha": sha,
    }
    meta_path = Path("data") / f"{name}_fetch_meta.json"
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f"  wrote meta: {meta_path} (source={source})")
    return meta


def _maybe_staleness_alert(name, state, now):
    """Advisory (not run-failing) when content has not changed in STALE_DAYS.
    Alert once, then at most weekly while the condition persists."""
    stale_days = _stale_days()
    changed_at = _parse(state.get("content_changed_at"))
    if changed_at is None:
        return state
    age = now - changed_at
    if age <= _dt.timedelta(days=stale_days):
        return state

    last_alert = _parse(state.get("last_stale_alert_at"))
    due = last_alert is None or (now - last_alert) >= _dt.timedelta(
        days=STALE_ALERT_INTERVAL_DAYS
    )
    if not due:
        print(
            f"  staleness: content unchanged for {age.days}d (> {stale_days}) "
            f"but last advisory was {(now - last_alert).days}d ago — not re-alerting yet"
        )
        return state

    days = age.days
    alerts.send_alert(
        f"Sheet '{name}' hasn't changed in {days} days",
        f"The '{name}' sheet fetched fine, but its content has not changed in "
        f"{days} days (threshold {stale_days}).\n\n"
        f"Last content change: {state.get('content_changed_at')}\n"
        f"Last successful fetch: {state.get('fetched_at')}\n\n"
        f"Is the source still being updated? This is an advisory only — the "
        f"pipeline ran normally and the site is unaffected.",
    )
    state["last_stale_alert_at"] = _iso(now)
    return state


def _handle_success(args, now):
    out = args.out
    sha = sha256_file(out)
    state = state_store.get_json(f"{args.name}_state.json", default={}) or {}
    prev_sha = state.get("sha")

    content_changed = prev_sha != sha
    if content_changed:
        state["content_changed_at"] = _iso(now)
        # Content moved — any prior staleness condition is cleared.
        state["last_stale_alert_at"] = None
        print(f"  content CHANGED (sha {str(prev_sha)[:12]} -> {sha[:12]})")
    else:
        state.setdefault("content_changed_at", _iso(now))
        print(f"  content unchanged (sha {sha[:12]})")

    state["name"] = args.name
    state["sha"] = sha
    state["fetched_at"] = _iso(now)

    # Persist last-good copy + state to R2 (or local override).
    state_store.put_file(out, f"{args.name}_last_good.csv")
    state = _maybe_staleness_alert(args.name, state, now)
    state_store.put_json(f"{args.name}_state.json", state)

    _write_meta(
        out,
        args.name,
        source="dropbox",
        fetched_at=state["fetched_at"],
        content_changed_at=state["content_changed_at"],
        sha=sha,
    )
    print(f"SUCCESS: '{args.name}' fetched to {out}")
    return 0


def _handle_failure(args, reason, now):
    print(f"FETCH FAILED for '{args.name}': {reason}")
    marker = Path("data") / f"{args.name}_fetch_failed"
    marker.parent.mkdir(parents=True, exist_ok=True)

    state = state_store.get_json(f"{args.name}_state.json", default={}) or {}

    # 1) Try the R2 last-good copy.
    restored = state_store.get_file(f"{args.name}_last_good.csv", args.out)
    if restored:
        last_good_fetched_at = state.get("fetched_at")
        _write_meta(
            args.out,
            args.name,
            source="last-good-copy",
            fetched_at=last_good_fetched_at,
            content_changed_at=state.get("content_changed_at"),
            sha=state.get("sha"),
        )
        marker.write_text(
            f"Fetch failed at {_iso(now)}: {reason}\n"
            f"Served last-good copy fetched {last_good_fetched_at}\n"
        )
        alerts.send_alert(
            f"Dropbox fetch failed for '{args.name}' — used last good copy",
            f"Fetching the '{args.name}' sheet failed:\n\n    {reason}\n\n"
            f"The pipeline continued using the last good copy from "
            f"{last_good_fetched_at}. The site is fine, but please check the "
            f"share link — the Actions run will be marked failed so this is "
            f"visible.\n",
        )
        print(f"  restored last-good copy to {args.out}; marker written; exit 0")
        return 0

    # 2) No last-good on R2 — fall back to the committed seed.
    if args.seed and Path(args.seed).exists():
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.seed, args.out)
        _write_meta(
            args.out,
            args.name,
            source="seed",
            fetched_at=None,
            content_changed_at=None,
            sha=sha256_file(args.out),
        )
        marker.write_text(
            f"Fetch failed at {_iso(now)}: {reason}\n"
            f"No last-good copy on R2; served committed seed {args.seed}\n"
        )
        alerts.send_alert(
            f"Dropbox fetch failed for '{args.name}' — used committed seed",
            f"Fetching the '{args.name}' sheet failed:\n\n    {reason}\n\n"
            f"There was NO last-good copy on R2 (first-ever failure), so the "
            f"pipeline fell back to the committed seed file {args.seed}. Please "
            f"check the share link — the Actions run will be marked failed.\n",
        )
        print(f"  used seed {args.seed} -> {args.out}; marker written; exit 0")
        return 0

    # 3) Nothing to serve — hard failure.
    alerts.send_alert(
        f"Dropbox fetch failed for '{args.name}' — NO fallback available",
        f"Fetching the '{args.name}' sheet failed:\n\n    {reason}\n\n"
        f"There is no last-good copy on R2 and no usable seed file "
        f"({args.seed!r}). The pipeline cannot produce {args.out}. This run "
        f"will hard-fail.\n",
    )
    marker.write_text(
        f"Fetch failed at {_iso(now)}: {reason}\nNo last-good copy and no seed.\n"
    )
    print("  no last-good copy and no seed — exit 1")
    return 1


def main():
    ap = argparse.ArgumentParser(description="Fetch an enrichment sheet with fallback.")
    ap.add_argument("--name", required=True, help="logical sheet name, e.g. profiles")
    ap.add_argument("--url-env", required=True, help="env var holding the share URL")
    ap.add_argument("--out", required=True, help="destination path for the sheet")
    ap.add_argument("--expect-header", required=True, help="required first-line prefix")
    ap.add_argument("--seed", default=None, help="committed seed used if no last-good copy")
    args = ap.parse_args()

    now = _now()
    url = os.environ.get(args.url_env)
    print(f"=== sheet_fetch: name={args.name} out={args.out} ===")

    if not url:
        # Missing URL env is itself a fetch failure — degrade gracefully.
        return _handle_failure(args, f"env {args.url_env} is not set", now)

    reason = _fetch_to(url, args.out, args.expect_header)
    if reason is None:
        return _handle_success(args, now)
    return _handle_failure(args, reason, now)


if __name__ == "__main__":
    sys.exit(main())
