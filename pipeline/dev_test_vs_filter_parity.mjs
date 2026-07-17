// pipeline/dev_test_vs_filter_parity.mjs
//
// Wave 4b (owner decision 47a) permanent parity guard.
//
// The Vs (matchup) query and the normal query must select the SAME players from
// every player-selecting filter — nothing may silently drop when you switch to
// Vs. This test automates the audit the fix was built from: it emits
// buildQuery(state).sql in BOTH normal mode (matchupVs = null) and Vs mode
// (matchupVs set) for a batting state that has EVERY player-selecting filter on
// at once, then asserts each filter's signature clause appears in the query it
// should — encoding the ONE intentional exception (striker-position is a
// matchup-only feature) and the one namespace rule (R. Pos. is batting-only).
//
// A future filter that isn't wired into the Vs path fails this test loudly here
// instead of silently widening the Vs result set in production.
//
// Run: `node pipeline/dev_test_vs_filter_parity.mjs`  (Node 22+, ESM auto-detect).
// Pure SQL-string builder — no DuckDB, no network, no browser globals.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (m) => "file://" + path.join(here, "..", "src", m);

const { createInitialState } = await import(src("state.js"));
const { buildQuery } = await import(src("table.js"));

/** A batting state with every player-selecting filter turned on at once. */
function fullBattingState(extra) {
  const s = createInitialState("2026-07");
  Object.assign(s, {
    discipline: "batting",
    gender: "male",
    formats: ["T20"],
    teamType: "international",
    dateFrom: "2023-07-01",
    dateTo: "2026-07-02",
    teams: ["India"],
    opposition: ["Australia"],
    event: ["Indian Premier League"],
    venue: ["Eden Gardens"],
    profile: { ...s.profile, battingHand: "Right-hand bat" },
    regularPositions: [1, 2, 3], // R. Pos. (batting-only)
    positions: [1, 2], // striker-position (matchup-only)
    pinnedPlayers: [{ id: "PINID123", name: "Pinned" }],
    search: "kohli",
    matchupVs: null,
  });
  return Object.assign(s, extra);
}

const COLS = ["innings", "runs", "strike_rate"];

// Signature clause for each player-selecting filter, and where it MUST appear.
// `clause` substrings are chosen to be unambiguous (they cannot collide with a
// different filter's SQL): e.g. R. Pos.'s roster subquery ends `pos IN (1, 2, 3)`,
// which never appears for the striker filter (`batting_position IN (1, 2)`).
const FILTERS = [
  { name: "Team", clause: "batting_team IN (", inNormal: true, inVs: true },
  { name: "Opposition", clause: "bowling_team IN (", inNormal: true, inVs: true },
  { name: "Event", clause: "event_name IN (", inNormal: true, inVs: true },
  { name: "Venue", clause: "venue IN (", inNormal: true, inVs: true },
  { name: "Profile", clause: "FROM profiles WHERE", inNormal: true, inVs: true },
  { name: "R. Pos. (batting roster)", clause: "pos IN (1, 2, 3)", inNormal: true, inVs: true },
  { name: "Player-name search", clause: "ILIKE", inNormal: true, inVs: true },
  { name: "Pinned players", clause: "IN ('PINID123')", inNormal: true, inVs: true },
  // The one intentional exception: striker-position is a matchup-only feature
  // (Bumrah-vs-openers) — present in Vs, ABSENT from the normal query.
  { name: "Striker-position (matchup-only)", clause: "batting_position IN (1, 2)", inNormal: false, inVs: true },
];

const normalSql = buildQuery(fullBattingState({ matchupVs: null }), COLS).sql;
const vsSql = buildQuery(fullBattingState({ matchupVs: { dim: "group", value: "Spin" } }), COLS).sql;

const failures = [];
const line = (ok, msg) => `  ${ok ? "PASS" : "FAIL"}  ${msg}`;
const out = [];

out.push("Batting: normal vs Vs parity");
for (const f of FILTERS) {
  const gotN = normalSql.includes(f.clause);
  const gotV = vsSql.includes(f.clause);
  const okN = gotN === f.inNormal;
  const okV = gotV === f.inVs;
  out.push(line(okN, `${f.name} — normal ${f.inNormal ? "present" : "absent"} (got ${gotN ? "present" : "absent"})`));
  out.push(line(okV, `${f.name} — Vs ${f.inVs ? "present" : "absent"} (got ${gotV ? "present" : "absent"})`));
  if (!okN) failures.push(`${f.name}: normal expected ${f.inNormal ? "present" : "absent"}`);
  if (!okV) failures.push(`${f.name}: Vs expected ${f.inVs ? "present" : "absent"}`);
}

// R. Pos. is a BATTING concept — it must NOT leak into any bowling query (plain
// or Vs). The striker filter, by contrast, DOES apply in bowling Vs (Bumrah vs
// openers). Confirm both, so the batting-only namespace rule can't silently break.
out.push("");
out.push("Bowling: R. Pos. must not leak; striker still applies in Vs");
const bowlNormal = buildQuery(
  fullBattingState({ discipline: "bowling", matchupVs: null }),
  COLS
).sql;
const bowlVs = buildQuery(
  fullBattingState({ discipline: "bowling", matchupVs: { dim: "hand", value: "Right-hand bat" } }),
  COLS
).sql;
const bowlChecks = [
  { name: "R. Pos. roster", clause: "pos IN (1, 2, 3)", sql: bowlNormal, want: false, mode: "bowling-normal" },
  { name: "R. Pos. roster", clause: "pos IN (1, 2, 3)", sql: bowlVs, want: false, mode: "bowling-Vs" },
  { name: "Striker-position", clause: "batting_position IN (1, 2)", sql: bowlVs, want: true, mode: "bowling-Vs" },
];
for (const c of bowlChecks) {
  const got = c.sql.includes(c.clause);
  const ok = got === c.want;
  out.push(line(ok, `${c.name} — ${c.mode} ${c.want ? "present" : "absent"} (got ${got ? "present" : "absent"})`));
  if (!ok) failures.push(`${c.name} (${c.mode}): expected ${c.want ? "present" : "absent"}`);
}

console.log(out.join("\n"));
if (failures.length) {
  console.error(`\nVS-FILTER PARITY GUARD FAILED (${failures.length}):`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("\nVS-FILTER PARITY GUARD PASSED — every player-selecting filter carries into Vs (striker-position matchup-only, R. Pos. batting-only).");
