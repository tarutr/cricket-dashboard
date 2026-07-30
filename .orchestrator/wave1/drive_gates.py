#!/usr/bin/env python3
"""
Wave-1 helper: run export_parquet.run_ball_layer_gates against ALREADY-BUILT ball
files (data/wave1_out/) + export refs (data/export/) WITHOUT a full rebuild, so
the oracle SQL can be iterated fast. Builds a temp dir of symlinks and calls the
REAL production gate function (zero drift vs the pipeline).
"""
import os, pathlib, importlib.util, duckdb, sys

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("ep", REPO / "export_parquet.py")
ep = importlib.util.module_from_spec(spec); spec.loader.exec_module(ep)

BALL_DIR = REPO / "data" / "wave1_out"
EXPORT = REPO / "data" / "export"
VERIFY = REPO / "data" / "wave1_verify"
VERIFY.mkdir(parents=True, exist_ok=True)

# symlink the 6 ball files + the 9 export files into one dir
for f in ep.DELIVERY_FILES:
    dst = VERIFY / f
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.symlink_to(BALL_DIR / f)
for f in ep.EXPORT_FILES:
    dst = VERIFY / f
    if dst.exists() or dst.is_symlink():
        dst.unlink()
    dst.symlink_to(EXPORT / f)

con = duckdb.connect(str(REPO / "data" / "cricket.duckdb"), read_only=True)
con.execute("PRAGMA temp_directory='/private/tmp/claude-501/wave1_tmp'")
con.execute("PRAGMA memory_limit='6GB'")
try:
    ep.run_ball_layer_gates(con, str(VERIFY))
    print("\n=== ALL BALL-LAYER GATES PASSED ===")
except ep.GateError as e:
    print(f"\n=== GATE FAILED: {e} ===")
    sys.exit(1)
finally:
    con.close()
