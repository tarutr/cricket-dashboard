#!/usr/bin/env python3
"""
Wave-1 end-to-end driver. Replicates export_parquet.main()'s BUILD sequence
against the local read-only DB, writing all export files to --out. Optionally
runs the full gate suite (--gates).

Environment shim: the local data/cricket.duckdb snapshot lacks the pipeline-built
`player_profiles` table (built by pipeline/build_profiles.py in the real pipeline).
We register it as a read-only TEMP VIEW over the shipped data/export/
player_profiles.parquet so the profiles-dependent builders (matchup_*, fielding_
events, player_profiles) reproduce the shipped exports. This shim is LOCAL to
verification only — the production pipeline DB has the real table, and
export_parquet.py is untouched by it.

Usage:
  build_and_gate.py --module export_parquet.py --out data/wave1_out --gates
  build_and_gate.py --module /tmp/export_head.py --out data/head_out   # 9 files only
"""
import argparse, importlib.util, os, pathlib, time, duckdb

REPO = pathlib.Path(__file__).resolve().parents[2]

ap = argparse.ArgumentParser()
ap.add_argument("--module", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--gates", action="store_true")
args = ap.parse_args()

spec = importlib.util.spec_from_file_location("epmod", args.module)
ep = importlib.util.module_from_spec(spec); spec.loader.exec_module(ep)

out = str(REPO / args.out) if not os.path.isabs(args.out) else args.out
os.makedirs(out, exist_ok=True)

con = duckdb.connect(str(REPO / "data" / "cricket.duckdb"), read_only=True)
con.execute("PRAGMA temp_directory='/private/tmp/claude-501/wave1_tmp'")
con.execute("PRAGMA memory_limit='6GB'")
con.execute("CREATE TEMP VIEW player_profiles AS "
            f"SELECT * FROM read_parquet('{REPO/'data'/'export'/'player_profiles.parquet'}')")

t0 = time.time()
builders = [
    ("players.parquet", ep.sql_players),
    ("matches.parquet", ep.sql_matches),
    ("batting_innings.parquet", ep.sql_batting),
    ("bowling_innings.parquet", ep.sql_bowling),
    ("player_matches.parquet", ep.sql_player_matches),
    ("player_profiles.parquet", ep.sql_player_profiles),
    ("fielding_events.parquet", ep.sql_fielding_events),
    ("matchup_batting.parquet", ep.sql_matchup_batting),
    ("matchup_bowling.parquet", ep.sql_matchup_bowling),
]
for fn, fnbuild in builders:
    t = time.time()
    ep.write_parquet(con, fnbuild(), os.path.join(out, fn))
    print(f"[build] {fn}: {time.time()-t:.1f}s", flush=True)

# Ball files (only if this module has them).
if hasattr(ep, "sql_deliveries"):
    for g in ("m", "f"):
        for b in ("t20", "odi", "red"):
            fn = f"deliveries_{g}_{b}.parquet"
            t = time.time()
            ep.write_parquet(con, ep.sql_deliveries(ep.DELIVERY_GENDERS[g], b),
                             os.path.join(out, fn))
            print(f"[build] {fn}: {time.time()-t:.1f}s", flush=True)

print(f"[build] TOTAL {time.time()-t0:.0f}s", flush=True)

if args.gates:
    tg = time.time()
    ep.run_gates(con, out)
    ep.run_spot_checks(con, out)
    ep.write_manifest(con, out)
    print(f"[gates] TOTAL {time.time()-tg:.0f}s", flush=True)

con.close()
print("DONE")
