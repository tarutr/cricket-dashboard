// src/fieldingDims.js
//
// The FIELDING dim CATALOGUE + vocabularies — the single source of truth for the
// fielding filter set, shared by BOTH surfaces that offer it:
//   • the player pop-up's Fielding editor (src/playerFieldingEditor.js — a modal
//     with its own draft), and
//   • the leaderboard's Fielding board "+ Add condition" menu (src/fieldingDimsDrawer.js
//     + the `disc === "fielding"` branch of src/paletteGroups.js — inline drawer rows
//     writing state.fielding.*).
//
// Extracted verbatim from playerFieldingEditor.js (T-3b) so the two surfaces can never
// drift on WHICH dims exist, what state.fielding field each writes, its control type,
// or its option source. This module owns ONLY the catalogue/vocabulary DATA — it never
// mutates state and never touches a query builder (numbers sacred, CLAUDE.md Rule 1).
// Every dim's routing is grounded in table.js's buildFieldingSliceClauses /
// buildFieldingExtraSliceClauses (the SACRED fielding query), unchanged.

import {
  FIELDING_PHASE_OPTIONS,
  FIELDING_POSITIONS,
  RESULT_OPTIONS,
  RESULT_ALL,
  TOSS_RESULT_OPTIONS,
  TOSS_DECISION_OPTIONS,
  inningsNumberOptions,
} from "./state.js";
import { INNINGS_NUMBER_FILTER } from "./metrics.js";

// Wicket-type (kind) vocabulary — the EXACT literals fielding_events.kind stores
// (buildFieldingSliceClauses emits `kind IN (…)`); the sacred buildFieldingCteSql
// uses the same four literals for its tallies. Display-only labels here.
export const WICKET_TYPE_OPTIONS = [
  { value: "caught", label: "Caught" },
  { value: "caught and bowled", label: "Caught & bowled" },
  { value: "stumped", label: "Stumped" },
  { value: "run out", label: "Run out" },
];

// Match-outcome tokens the fielding mctx honors (buildMatchContextClauses) — the
// RESULT_OPTIONS minus the "All" no-narrowing sentinel (fielding needs no sentinel:
// an empty selection is already "no narrowing").
export const RESULT_OUTCOME_OPTIONS = RESULT_OPTIONS.filter((o) => o.value !== RESULT_ALL);

// A checklist longer than this gets an inline filter box (City / Season can be long).
export const CHECKLIST_FILTER_THRESHOLD = 12;

// ── The fielding dim catalogue ───────────────────────────────────────────────
// Each entry: a palette label + group + the state.fielding field it writes + how
// its control renders. `source`/`column` mark a DATA-DRIVEN dim (options from
// loadDimOptions → data-driven availability). `numeric` marks integer-valued
// checklists (positions / innings) whose values coerce to ints. `stored` on innings
// means the checklist VALUE is the 0-based stored innings_number (display via label).
export const DIMS = [
  { key: "kind",         field: "kinds",         group: "Dismissal", label: "Wicket type",       control: "checklist", options: () => WICKET_TYPE_OPTIONS },
  { key: "position",     field: "positions",     group: "Dismissal", label: "Dismissed batter's position",  control: "checklist", numeric: true,
    options: () => FIELDING_POSITIONS.map((n) => ({ value: n, label: `Position ${n}` })) },
  { key: "hand",         field: "hands",         group: "Dismissal", label: "Dismissed batter hand", control: "checklist", source: "fielding", column: "out_hand" },
  { key: "batter",       field: "outBatters",    group: "Dismissal", label: "Specific batter",   control: "player", nameField: "outBatterName", pickLabel: "Dismissed batter" },
  { key: "bowlerStyle",  field: "bowlerStyles",  group: "Bowler",    label: "Bowler style",      control: "checklist", source: "fielding", column: "bowler_style" },
  { key: "bowler",       field: "bowlers",       group: "Bowler",    label: "Specific bowler",   control: "player", nameField: "bowlerName", pickLabel: "Bowler" },
  { key: "phase",        field: "phases",        group: "Delivery",  label: "Phase",             control: "checklist", options: () => FIELDING_PHASE_OPTIONS },
  { key: "overs",        field: null,            group: "Delivery",  label: "Over range",        control: "overrange" },
  { key: "innings",      field: "inningsNumbers", group: "Delivery", label: "Innings number",    control: "checklist", numeric: true, stored: true,
    options: (ctx) => inningsNumberOptions(ctx.formats).map((o) => ({ value: INNINGS_NUMBER_FILTER.toStored(o.value), label: o.label })) },
  { key: "city",         field: "cities",        group: "Match",     label: "City",              control: "checklist", source: "fielding", column: "city" },
  // reverse: true — loadDimOptions returns ascending (ORDER BY 1); Season reads
  // newest-first (owner #13-adjacent), matching the Event ▸ Season sub-picker.
  // Canonical season ordering lives in playerData.js's searchSeasons (ORDER BY
  // syr DESC, season DESC) — this reverse:true flip agrees with it for every
  // season string beginning with its 4-digit start year (all of them).
  { key: "season",       field: "seasons",       group: "Match",     label: "Season",            control: "checklist", source: "matches", column: "season", reverse: true },
  { key: "stage",        field: "stage",         group: "Match",     label: "Stage",             control: "checklist", source: "matches", column: "event_stage", canonical: true },
  { key: "result",       field: "result",        group: "Match",     label: "Match result",      control: "checklist", options: () => RESULT_OUTCOME_OPTIONS },
  { key: "tossResult",   field: "tossResult",    group: "Match",     label: "Toss result",       control: "checklist", options: () => TOSS_RESULT_OPTIONS },
  { key: "tossDecision", field: "tossDecision",  group: "Match",     label: "Toss decision",     control: "checklist", options: () => TOSS_DECISION_OPTIONS },
];
export const DIM_BY_KEY = new Map(DIMS.map((d) => [d.key, d]));

// The scope singletons offered on the FIELDING editor: the ONLY four the sacred
// buildFieldingCteSql honors at the top level (via buildScopeClausesTagged). Their
// value editors are the reused store-adapter drawer editors (playerFilterScope.js);
// their picks land on row.singletons. (Stage / Result / Toss / Innings are fielding.*
// dims here, NOT scope singletons — see the header.)
export const FIELDING_SINGLETONS = [
  { key: "team", label: "Team" },
  { key: "opposition", label: "Opposition" },
  { key: "event", label: "Event" },
  { key: "venue", label: "Venue" },
];
export const SINGLETON_LABEL = new Map(FIELDING_SINGLETONS.map((s) => [s.key, s.label]));
