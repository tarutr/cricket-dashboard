// pipeline/dev_test_event_name_roundtrip.mjs
//
// Event / stage name-collapse ROUND-TRIP tripwire (backlog #5 follow-up).
//
// src/canonicalNames.js folds many raw event_name / event_stage spellings to
// ONE canonical the pickers display (canonicalize), and expands a selected
// canonical back to the raw alias set the query filters on (aliasesFor). Those
// two directions MUST stay in sync: every distinct raw value the data contains
// has to round-trip — aliasesFor(canonicalize(raw)) must contain the raw — or a
// selected canonical would DISPLAY a value it then silently DROPS from the
// `event_name IN (...)` / `event_stage IN (...)` filter (an under-count).
//
// This is EMPIRICALLY clean today. The tripwire exists for the future: a data
// refresh that introduces a new spelling (a sponsor rename, a new curly-
// apostrophe/whitespace variant of a raw value that isn't a listed alias) fails
// HERE, loudly, instead of silently under-counting in production — the signal
// to extend .orchestrator/event_canonical_map.json + regenerate the consts in
// src/canonicalNames.js.
//
// Run: `node pipeline/dev_test_event_name_roundtrip.mjs`   (Node 22+, ESM).
// Reads distinct values from data/export/matches.parquet via the `duckdb` CLI
// (the same data/ the local server serves). data/ is gitignored, so when it or
// the CLI is absent this SKIPS (exit 0) — there is nothing to check without a
// populated export; it only asserts (and can fail) against real data.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const parquet = path.join(repo, "data", "export", "matches.parquet");
const src = (m) => "file://" + path.join(repo, "src", m);

const { canonicalEvent, eventAliases, canonicalStage, stageAliases } = await import(src("canonicalNames.js"));

function distinct(col) {
  const sql = `SELECT DISTINCT ${col} AS v FROM read_parquet('${parquet.replace(/'/g, "''")}') WHERE ${col} IS NOT NULL`;
  const raw = execFileSync("duckdb", ["-json", "-c", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw).map((r) => r.v);
}

// SKIP cleanly when the data/CLI aren't here (data/ is gitignored).
if (!existsSync(parquet)) {
  console.log(`SKIP — ${parquet} not found. Populate data/export/ (local download) then re-run.`);
  process.exit(0);
}
try {
  execFileSync("duckdb", ["-c", "SELECT 1"], { stdio: "ignore" });
} catch {
  console.log("SKIP — `duckdb` CLI not on PATH. Install it (brew install duckdb) then re-run.");
  process.exit(0);
}

function check(kind, raws, canonFn, aliasFn) {
  const misses = [];
  for (const raw of raws) {
    if (!aliasFn(canonFn(raw)).includes(raw)) misses.push(raw);
  }
  console.log(`[${kind}] distinct raw values: ${raws.length}  round-trip misses: ${misses.length}`);
  for (const m of misses.slice(0, 20)) {
    console.log(`  MISS  raw=${JSON.stringify(m)}  ->  canon=${JSON.stringify(canonFn(m))}  ->  aliases=${JSON.stringify(aliasFn(canonFn(m)))}`);
  }
  return misses.length;
}

const eventMisses = check("event", distinct("event_name"), canonicalEvent, eventAliases);
const stageMisses = check("stage", distinct("event_stage"), canonicalStage, stageAliases);

if (eventMisses + stageMisses > 0) {
  console.error(`\nEVENT/STAGE ROUND-TRIP TRIPWIRE FAILED — ${eventMisses + stageMisses} raw value(s) collapse to a canonical whose alias set does NOT include them.`);
  console.error("Fix: add the missing spelling(s) as aliases in .orchestrator/event_canonical_map.json and regenerate EVENT_MERGES/STAGE_MERGES in src/canonicalNames.js.");
  process.exit(1);
}
console.log("\nEVENT/STAGE ROUND-TRIP TRIPWIRE PASSED — every distinct raw event_name/event_stage round-trips (0 misses).");
