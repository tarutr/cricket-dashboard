"""
state_store.py — tiny reusable persistence layer for pipeline state.

All pipeline "memory that must survive between CI runs" lives under the
`pipeline-state/` prefix in the same R2 bucket ('cricket-db') the rest of the
pipeline uses. This module is the ONLY place that talks to that prefix, so
sheet_fetch.py, check_ingest.py and report_new_unmatched.py all share one
implementation (and every future sheet gets it for free).

Keys are passed as plain names (e.g. "profiles_state.json"); the module roots
them under `pipeline-state/`.

Local-test override:
  Setting env STATE_LOCAL_DIR=<dir> swaps ALL R2 I/O for a local directory.
  Names map to files under that directory. This lets the whole D3 surface be
  tested end-to-end without ever touching real R2 pipeline-state.
"""

import json
import os
import shutil
from pathlib import Path

BUCKET = "cricket-db"
PREFIX = "pipeline-state"


def _local_root():
    d = os.environ.get("STATE_LOCAL_DIR")
    return Path(d) if d else None


def _r2():
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )


def _key(name):
    return f"{PREFIX}/{name}"


def get_json(name, default=None):
    """Return parsed JSON for `name`, or `default` if it does not exist."""
    root = _local_root()
    if root is not None:
        p = root / name
        if not p.exists():
            return default
        return json.loads(p.read_text())

    import botocore  # noqa: WPS433 — local import keeps boto3 optional in tests

    s3 = _r2()
    try:
        obj = s3.get_object(Bucket=BUCKET, Key=_key(name))
        return json.loads(obj["Body"].read())
    except botocore.exceptions.ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404", "NoSuchBucket"):
            return default
        raise


def put_json(name, obj):
    """Persist `obj` as pretty JSON under `name`."""
    root = _local_root()
    payload = json.dumps(obj, indent=2, sort_keys=True).encode("utf-8")
    if root is not None:
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(payload)
        return

    s3 = _r2()
    s3.put_object(
        Bucket=BUCKET,
        Key=_key(name),
        Body=payload,
        ContentType="application/json",
    )


def get_file(name, dest_path):
    """Download blob `name` to `dest_path`. Returns True if it existed."""
    root = _local_root()
    dest_path = str(dest_path)
    if root is not None:
        p = root / name
        if not p.exists():
            return False
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest_path)
        return True

    import botocore

    s3 = _r2()
    try:
        Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
        s3.download_file(BUCKET, _key(name), dest_path)
        return True
    except botocore.exceptions.ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("NoSuchKey", "404", "NoSuchBucket"):
            return False
        raise


def put_file(src_path, name):
    """Upload local file `src_path` to blob `name`."""
    root = _local_root()
    src_path = str(src_path)
    if root is not None:
        p = root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_path, p)
        return

    s3 = _r2()
    s3.upload_file(src_path, BUCKET, _key(name))
