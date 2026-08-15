// src/columnsPicker.js
//
// The leaderboard's "Columns" PICKER — the checkbox popover that chooses which
// metric columns show (Basic / Dismissals / Fielding / Impact / Phase), plus the
// batting-only "Show as %" + rare-dismissals disclosure — extracted OUT of the
// giant `mountTable()` closure in src/table.js (Tab-2 wave A, T-F2) so more than
// one surface can mount the SAME picker: the leaderboard today, the player
// pop-up's "Filters" tab (its own INDEPENDENT column selection, decision 3) next.
// This mirrors the earlier extraction of the "+ Add condition" search palette
// into src/addPalette.js — read that file's header for the shared pattern.
//
// This module owns ONLY the popover UI + its own open/close lifecycle. It knows
// NOTHING about the store, the query, the toolbar, or how a column change is
// applied — the CALLER supplies a small get/set contract, and every column
// mutation runs through the caller's own `setColumns`. So the extraction is
// behaviour-preserving: the leaderboard produces the EXACT same popover it did
// before (numbers sacred — no query/column-to-SQL path lives here). Adding a
// column, ticking a dismissal kind, flipping "Show as %" all call `setColumns`
// with the SAME column-key array the inline handlers used to hand to the host's
// column-apply path.
//
// What deliberately STAYS with the host (not part of this component):
//   • stageColumns/stageColumnSlots — the leaderboard's OWN `setColumns`/`applySlots`
//     (R1, 2026-08-09: STAGE into the pending store, applied on Search); the contract
//     impl, passed in here.
//   • the preset <select> — a toolbar control that also lights Search and applies on
//     Search; it shares columns via the SAME get/set contract, not via this component.
//   • column drag-to-reorder — table-body machinery (moves <th>/<td>, re-renders
//     the table); per-table, not per-picker. Also uses the same contract.
//
// The contract (createColumnsPicker):
//   getDiscipline() -> "batting" | "bowling" | "matchup_batting" | "matchup_bowling"
//     the EFFECTIVE metrics namespace the popover lists (matchup vocab while a Vs
//     selection is active — the caller resolves this).
//   getFormats()    -> string[]   the current format selection (feeds
//     eligibleMetrics + the per-format metric labels).
//   getColumns()    -> string[]   the CURRENT visible column-key list for the
//     effective namespace (the caller reads state.columns[ns]).
//   setColumns(cols) -> void      apply a new column-key list. The caller decides
//     what "apply" means (leaderboard R1: STAGE into the pending store, applied on
//     Search; pop-up: re-render its own table). Called with the full new array on
//     every change.

import { escHtml } from "./html.js";
import {
  DISMISSAL_KINDS, metricDisplayLabel, makeCrossKey, getMetric,
  resolveColumnMetric,
  OTHER_DISCIPLINE, COLUMN_TOGGLE_PAIRS,
  // Columns content rework D1 (phase composer): the composed-key scheme + pool.
  makeComposedPhaseKey, composedPhasePool, composedPhaseTokensForFormats, COMPOSED_PHASE_LABEL,
  parseComposedPhaseKey,
  // Columns content rework D2 (ball-range + innings-range composers).
  makeComposedBallKey, composedBallPool, composedBallTokens, COMPOSED_BALL_LABEL,
  parseComposedBallKey,
  makeComposedInningsKey, composedInningsPool, composedInningsTokensForFormats, COMPOSED_INNINGS_LABEL,
  parseComposedInningsKey,
  // Chunk 1B: the per-position breakdown composer (pos__) + the B. Pos. which-values column key.
  makeComposedPositionKey, composedPositionPool, composedPositionTokens, COMPOSED_POSITION_LABEL,
  parseComposedPositionKey, BATTING_POSITION_SET_KEY,
  // Wave 2A.3: the Innings-Number / Team / Opposition which-values column keys.
  INNINGS_NUMBER_SET_KEY, TEAM_SET_KEY, OPPOSITION_SET_KEY,
  // City & Season everywhere (2026-08-16): the City / Season which-values column keys.
  CITY_SET_KEY, SEASON_SET_KEY,
  // Columns content rework D3 (runs-by-source + wicket-type composers).
  composedRunSourceRows, makeComposedRunSourceKey, parseComposedRunSourceKey,
  makeComposedWicketTypeKey, parseComposedWicketTypeKey,
  // Wave C #24 (runs-conceded-by-source composer, bowling — mirrors runs-by-source).
  composedRunSourceConcededRows, makeComposedRunSourceConcededKey, parseComposedRunSourceConcededKey,
  // Columns content rework D4 (parametric Innings Score Range + Wicket Haul composers).
  composedParamDescriptor, makeComposedParamKey, parseComposedParamKey, COMPOSED_PARAM_OP_TOKEN,
  // FC-2: the fielding-composer key scheme (tally × dimension × value → fc__ column).
  makeComposedFieldingKey, parseComposedFieldingKey,
  // Wave D — D1: the player-profile attribute columns' offerable specs per discipline.
  profileColumnSpecs,
  // Standalone TEAM composer (2026-08-14): pool + key scheme + the session registry
  // that keeps a picked Team column alive across a Search-prune (metrics.js).
  composedTeamPool, makeComposedTeamKey, parseComposedTeamKey, registerComposedTeamKeys,
  // Standalone OPPOSITION composer (2026-08-14): the opponent-side MIRROR of the Team
  // composer above — same pool/key-scheme/registry shape, over the OTHER side.
  composedOppositionPool, makeComposedOppositionKey, parseComposedOppositionKey, registerComposedOppositionKeys,
  // Standalone STAGE composer (Step 3, 2026-08-14): a THIRD data-driven SEARCH composer,
  // same pool/key-scheme/registry shape — its picks are CANONICAL stage names, its
  // value source is the host's loadStageOptions (not the team loader).
  composedStagePool, makeComposedStageKey, parseComposedStageKey, registerComposedStageKeys,
  // Standalone EVENT + VENUE composers (Step 4, 2026-08-14): the FOURTH + FIFTH SEARCH
  // composers — same pool/key-scheme/registry shape. Event picks CANONICAL event names
  // (loadEventOptions); Venue picks RAW venue names (loadVenueOptions, no fold).
  composedEventPool, makeComposedEventKey, parseComposedEventKey, registerComposedEventKeys,
  composedVenuePool, makeComposedVenueKey, parseComposedVenueKey, registerComposedVenueKeys,
  // Standalone CITY + SEASON composers (City & Season everywhere, 2026-08-16): the
  // SIXTH + SEVENTH SEARCH composers — Venue-shape (RAW names, no fold).
  composedCityPool, makeComposedCityKey, parseComposedCityKey, registerComposedCityKeys,
  composedSeasonPool, makeComposedSeasonKey, parseComposedSeasonKey, registerComposedSeasonKeys,
} from "./metrics.js";
// Standalone TEAM/OPPOSITION composers: their value control is the SAME searchable
// multi-select the Team/Opposition/Event/Venue FILTERS use (drawerInnings.js mounts
// it identically).
import { mountSearchMultiSelect } from "./searchSelect.js";
// FC-2: the Bowler Style composer is gated on the presence of fielding.bowling_group
// (added by the FC-1b pipeline re-run) — a data-driven schema probe, cached per session.
import { getFieldingColumnPresent, ensureFieldingColumnProbed } from "./dataAvailability.js";
import { eligibleMetrics, eligibleCrossMetrics, makeSlot, STAGE_NONE, STAGE_NONE_LABEL } from "./state.js";
// D4: the composer's operator <select> reuses the SAME operator vocabulary as the
// pop-up / advanced filter (advanced.js is import-cycle-free — pure data model).
import { OPERATORS } from "./advanced.js";
// R0 Step 2: the four discipline dropdowns reuse the SAME floating searchable menu
// as the filters' "+ Add condition" (portal + search + one-open-at-a-time), instead
// of the old inline panels that reflowed the modal. No query path lives here.
import { createAddPalette, paletteSkeletonHTML } from "./addPalette.js";

// ── Per-column count/% (+ count/per-match) toggle (columns content rework Wave C) ─
// Each COUNT key in COLUMN_TOGGLE_PAIRS renders as a SINGLE picker row (leaderboard
// four-dropdown only) whose value the user flips between the count metric and its
// paired ALTERNATE (% or per-match) via a small segmented control — the display
// counterpart of the batting Dismissals "Show as %" toggle, but per-column. The
// alternate key is NEVER listed as its own row; it enters the visible column list
// only by flipping the toggle (default = count). These helpers resolve a key ⇄ pair
// within a namespace (dot_pct is a shared key with a different meaning per
// discipline, so the pairing is namespace-scoped). The pop-up popover passes no W2
// controls (controlsOn false) so it never renders these rows — it stays byte-identical.
const _TOGGLE_PAIRS_BY_NS = {};
const _TOGGLE_ALTS_BY_NS = {};
for (const ns of Object.keys(COLUMN_TOGGLE_PAIRS)) {
  const byCount = new Map();
  const alts = new Set();
  for (const p of COLUMN_TOGGLE_PAIRS[ns]) {
    byCount.set(p.count, p);
    alts.add(p.alt);
  }
  _TOGGLE_PAIRS_BY_NS[ns] = byCount;
  _TOGGLE_ALTS_BY_NS[ns] = alts;
}
/** The toggle pair whose COUNT key is `key` in namespace `ns`, or null. Static Wave-C
 * pairs (COLUMN_TOGGLE_PAIRS) first; then the D3 COMPOSED count/% pairs, which are
 * dynamic (never in COLUMN_TOGGLE_PAIRS) — the count key of a run-source
 * (rs__<src>__runs) / wicket-type (wt__<type>__count) composer row pairs with its %
 * alternate, resolved from the key structure so the per-row count/% control +
 * sort/highlight sync behave identically to the static pairs. ns-agnostic for the
 * composed case (the key self-encodes its source/type + axis). */
function togglePairByCount(key, ns) {
  const byCount = _TOGGLE_PAIRS_BY_NS[ns];
  const stat = (byCount && byCount.get(key)) || null;
  if (stat) return stat;
  const rs = parseComposedRunSourceKey(key);
  if (rs && rs.axis === "runs") {
    return { count: key, alt: makeComposedRunSourceKey(rs.token, "pct"), mode: "pct" };
  }
  // Wave C #24: a runs-conceded-by-source COUNT (rsc__…__runs) pairs with its %
  // alternate — same key-derived pairing as the batting rs__ family above.
  const rsc = parseComposedRunSourceConcededKey(key);
  if (rsc && rsc.axis === "runs") {
    return { count: key, alt: makeComposedRunSourceConcededKey(rsc.token, "pct"), mode: "pct" };
  }
  const wt = parseComposedWicketTypeKey(key);
  if (wt && wt.axis === "count") {
    return { count: key, alt: makeComposedWicketTypeKey(wt.token, "pct"), mode: "pct" };
  }
  // FC-2: a fielding composer COUNT (fc__…) pairs with its per-match variant
  // (fc__…_per_match) in PERMATCH mode — the display counterpart of the enumerated
  // fielding count/per-match toggle (catches ⇄ catches_per_match), resolved from the
  // key structure so it is never listed as its own row. ns-agnostic (the key
  // self-encodes tally/dim/value).
  const fc = parseComposedFieldingKey(key);
  if (fc && !fc.perMatch) {
    return { count: key, alt: makeComposedFieldingKey(fc.tally, fc.dim, fc.value, true), mode: "permatch" };
  }
  return null;
}
/** The set of ALTERNATE (%/per-match) keys hidden from the picker listing in `ns`. */
function toggleAltKeys(ns) {
  return _TOGGLE_ALTS_BY_NS[ns] || new Set();
}

// ── Phase×metric composer (columns content rework D1) ────────────────────────
// The composer REPLACES the flat enumerated phase columns in the leaderboard's
// picker with a family→phase matrix over a REAL metric pool: one sub-block per
// base metric the discipline can re-scope to a phase (Strike Rate, Average, Runs,
// … for batting; Economy, Wickets, … for bowling — see composedPhasePool in
// metrics.js), each listing the format-eligible phase(s) (Powerplay / Middle /
// Death, or their ODI-range variants) as checkbox rows. Each row's data-key is a
// COMPOSED key (`ph__<phase>__<base>`) whose sqlExpression getMetric rebuilds from
// the phase-prefixed raw components — so the picker no longer offers the enumerated
// keys (pp_strike_rate, …), the composer does. The equivalence gate (composed SQL
// == the retiring enumerated SQL for the overlapping SR/Economy/Wickets families)
// is enforced in metrics.js's spec templates. Rows flow through the SAME checkbox +
// W2 Sort-by/Highlight wiring as any other column (itemRowHTML).

// A monochrome highlighter/marker glyph, filled via currentColor — mirrors the
// pin toggle's PIN_GLYPH convention in src/table.js (owner fix: the old 🖍️
// emoji couldn't take a CSS `color`, so its "on" state was faked with a solid
// chip background; that chip is gone, this SVG lets .col-hl-btn recolour it
// exactly like .pin-toggle does). Defined locally rather than imported from
// table.js to avoid a circular import (table.js already imports this module).
const HIGHLIGHT_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g transform="rotate(45 12 12)"><rect x="9" y="2" width="6" height="12" rx="1"/><polygon points="9,14 15,14 12,19"/></g><rect x="4" y="19" width="10" height="2" rx="1"/></svg>';

// Columns content rework E1b: the "duplicate this column" glyph — the standard
// duplicate/copy symbol of two overlapping rectangles ("two cards, one in front of
// the other"). Drawn STROKED (fill:none; stroke:currentColor via .col-dup-btn svg)
// rather than filled like HIGHLIGHT_GLYPH/PIN_GLYPH, because two solid rectangles
// wouldn't read as overlapping cards — the front card must occlude the back one,
// which the outline shows cleanly and still recolours exactly like the sibling
// controls. Same 24×24 viewBox + monochrome-currentColor convention as the others.
const DUPLICATE_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/></svg>';

// Columns rework R4-A: the "edit this column" pencil — shown ONLY on composer-made
// standalone rows (Phase/Ball/Innings/Runs-by-Source/Wicket-Type), which have a
// stat×dimension to re-edit in place. Drawn STROKED like DUPLICATE_GLYPH (fill:none;
// stroke:currentColor via .col-edit-btn svg) and recolours exactly like its siblings.
// Plain rows carry no pencil (nothing to compose); parametric rows are already inline-
// editable via their operator+value.
const EDIT_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.83l-1.17-1.17a2 2 0 0 0-2.83 0L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';

// ── Dismissals column-picker grouping (decision 44/42, B2R wave 3) ───────────
// The plain "batting" namespace is the ONLY one where metrics.js's dismissal
// taxonomy produces a count+% pair per kind (12 kinds x 2 = 24 checkboxes,
// see DISMISSAL_KINDS/`section: "dismissal"` in metrics.js) — bowling's wkt_*
// metrics carry no `section` at all (so they render under Basic, unaffected
// by any of this) and both matchup namespaces' dismissal metrics are
// count-only (6 items each, no % sibling), so they're already a plain list
// and keep the plain `section()` rendering below untouched. This block is
// therefore scoped to ns === "batting" only.
//
// Grouping metadata lives HERE, not in metrics.js — this module owns picker
// rendering, metrics.js owns the metric catalogue, and "which 6 kinds are common
// vs rare" is a picker-layout judgment call, not a metric definition. Kind
// strings match DISMISSAL_KINDS' own `kind` field exactly.
const RARE_DISMISSAL_KINDS = new Set([
  "hit wicket",
  "retired out",
  "obstructing the field",
  "handled the ball",
  "timed out",
  "hit the ball twice",
]);

// Display labels for the picker rows — mostly identical to metrics.js's own
// `label` now that its "Out " prefix was dropped (enum-fixes pass); "Run out"
// / "Hit wicket" / etc. keep the picker's own sentence-case style here since
// the section header already reads "Dismissals".
const DISMISSAL_ROW_LABEL = {
  out_caught: "Caught",
  out_bowled: "Bowled",
  out_lbw: "LBW",
  out_run_out: "Run out",
  out_stumped: "Stumped",
  out_caught_and_bowled: "Caught & Bowled",
  out_hit_wicket: "Hit wicket",
  out_retired_out: "Retired out",
  out_obstructing_the_field: "Obstructing the field",
  out_handled_the_ball: "Handled the ball",
  out_timed_out: "Timed out",
  out_hit_the_ball_twice: "Hit the ball twice",
};

// ── Wicket Type composer row layout (columns content rework D3) ──────────────
// The D3 "Wicket Type" composer (leaderboard only) replaces the batting Dismissals
// section (out_*/out_*_pct) and the bowling wkt_* columns with per-row count/%
// toggle rows over composed keys (wt__<token>__<axis>). Row LAYOUT (which types are
// common vs rare, their row labels, order) is a picker-layout judgment call and
// lives HERE — same posture as RARE_DISMISSAL_KINDS / DISMISSAL_ROW_LABEL above; the
// composed-key scheme + metric identity + sqlExpression live in metrics.js.
//
// BATTING reuses DISMISSAL_KINDS + RARE_DISMISSAL_KINDS + DISMISSAL_ROW_LABEL, so the
// common/rare split + ordering + row labels are IDENTICAL to the pop-up's Dismissals
// section (which must stay byte-identical) — the two surfaces never disagree about
// which kinds are common. (NB: the D3 brief lists Hit-wicket among the common batting
// types; it is kept in the Rare disclosure here to match that established split — a
// one-line change to RARE_DISMISSAL_KINDS would promote it in BOTH surfaces.)
// BOWLING has its own six bowler-credited kinds (no rares), ordered per the audit.
const BOWLING_WICKET_TYPE_ROWS = [
  { token: "bowled", rowLabel: "Bowled" },
  { token: "lbw", rowLabel: "LBW" },
  { token: "caught", rowLabel: "Caught" },
  { token: "caught_and_bowled", rowLabel: "Caught & Bowled" },
  { token: "stumped", rowLabel: "Stumped" },
  { token: "hit_wicket", rowLabel: "Hit wicket" },
];

/** One dismissal-kind row: a single checkbox standing for EITHER the count or
 * the % column (metrics.js's `${key}` / `${key}_pct`), whichever the
 * section's "Show as %" toggle currently selects — checked iff either
 * variant is present in `visible` (mixed/legacy state is read honestly here;
 * see computeInitialShowPct's doc comment for when it gets normalised). */
function dismissalRowHTML(d, visible) {
  const countKey = d.key;
  const pctKey = `${d.key}_pct`;
  const checked = visible.has(countKey) || visible.has(pctKey);
  const label = DISMISSAL_ROW_LABEL[countKey] ?? d.label;
  return `<label class="columns-popover__item">
    <input type="checkbox" data-count-key="${countKey}" data-pct-key="${pctKey}" ${checked ? "checked" : ""} />
    <span>${escHtml(label)}</span>
  </label>`;
}

/** Initial "Show as %" state for a freshly-opened popover, derived from the
 * CURRENT column list rather than any stored preference (there isn't one —
 * this is a transient picker-open computation, same lifetime as the popover
 * itself). Majority rule across the 12 kinds' checked rows: more % columns
 * checked than count columns -> starts on %; a tie (including "none checked
 * at all") starts on counts, the pre-existing convention. A mixed save from
 * before this redesign (e.g. 2 count + 1 %) is NOT silently rewritten by this
 * computation alone — it only decides which way the toggle SHOWS initially;
 * the actual column-list normalisation (collapsing every checked row onto one
 * variant) happens the first time the user flips the toggle or checks/
 * unchecks a row (see the toggle's own change handler below), never merely by
 * opening the popover. */
function computeInitialShowPct(cols) {
  const visible = new Set(cols);
  let pctCount = 0;
  let countCount = 0;
  for (const d of DISMISSAL_KINDS) {
    if (visible.has(`${d.key}_pct`)) pctCount += 1;
    else if (visible.has(d.key)) countCount += 1;
  }
  return pctCount > countCount;
}

/**
 * Create a Columns picker bound to one surface's column contract. Returns
 * `{ mount, open, close, refresh }`. Each instance owns its OWN open-popover
 * tracker, so two surfaces (leaderboard + pop-up) each mounting their own
 * picker never interfere — identical to the per-mountTable closure the tracker
 * (`openColumnsPopoverState`) lived in before the extraction.
 *
 *   • mount(triggerEl)   — wire a click on the "Columns" trigger button to open
 *     the popover anchored to it. Re-mountable: a host that rebuilds its toolbar
 *     (a fresh button each time) just calls mount again on the new button.
 *   • open(anchorEl)     — open the popover anchored to `anchorEl` (defaults to
 *     the last-mounted trigger). Closes any already-open popover first.
 *   • close()            — close the popover if open (leak-free: doc/window
 *     listeners added on open are removed here).
 *   • refresh(anchorEl)  — called by the host after it re-renders while the
 *     popover may be open: re-anchors to `anchorEl`, re-syncs every checkbox's
 *     checked state from getColumns() (the host may have silently pruned a
 *     column out from under it), and repositions. `anchorEl` null/absent (the
 *     trigger no longer exists, e.g. an error state) closes the popover.
 */
export function createColumnsPicker({
  getColumns,
  setColumns,
  getDiscipline,
  getFormats,
  // Columns-rejig W2 (2026-08-07): OPTIONAL per-column Sort-by + Highlight
  // contract. The leaderboard's inline picker passes all four; the player pop-up
  // popover (playerFiltersTab.js) passes none, so `controlsOn` is false there and
  // the picker renders EXACTLY as before (checkboxes only — byte-identical).
  //   getSort()  -> { key, dir, active } — the table's LIVE sort state (the same
  //     one column-header clicks read/write; `active` == orderIsActiveSort, so a
  //     column only shows as "the sort" while it's actually ordering the rows).
  //   setSort(key) -> void — route through the host's sort path (toggle dir on
  //     the active key, default dir on a new one). Two-way bound with the header.
  //   getHighlights() -> string[] — the display-only highlighted metric keys for
  //     the effective namespace.
  //   setHighlights(keys) -> void — apply a new highlighted-key set (repaints the
  //     table's tint class; never a query change).
  getSort,
  setSort,
  getHighlights,
  setHighlights,
  // Columns content rework E1b (2026-08-08): OPT-IN multi-instance ("copies")
  // contract. When getSlots + applySlots are BOTH supplied (leaderboard only), the
  // inline picker renders per-COPY: a stat shown twice lists as two rows, each with
  // its own count/%, Sort-by, Highlight, duplicate and remove — and a metric's
  // offer checkbox APPENDS a fresh copy instead of toggling one on/off (owner: "no
  // longer binary on/off — re-picking appends a new instance"). The player pop-up
  // popover passes NEITHER, so multiInstance is false there and it keeps its
  // byte-identical key-based flat list. All of this is DISPLAY-only: the sacred
  // query builders never see slots (load() dedups to distinct keys; buildMatchupQuery
  // dedups internally), so two copies of a stat compute it exactly once.
  //   getSlots() -> Slot[]   the ordered {id,key} column slots for the effective ns.
  //   applySlots(slots) -> void   apply a freshly-built Slot[] (instant, no Search
  //     light) — add / remove / duplicate a copy, or swap one copy's count/% variant
  //     (a copy's variant IS its slot.key; its id is preserved so sort/highlight
  //     follow it across the swap).
  //   getHighlightIds() -> string[]   the highlighted SLOT IDS (per-copy highlight).
  //   setHighlightIds(ids) -> void    apply a new highlighted-slot-id set.
  getSlots,
  applySlots,
  getHighlightIds,
  setHighlightIds,
  // Columns-rejig W3 (2026-08-07): OPT-IN cross-discipline exposure. When true AND
  // the current namespace is plain batting/bowling, the picker appends a small,
  // clearly-interim group listing the OTHER discipline's columns (e.g. Bowling
  // columns while batting) so they can be ADDED + sorted in TODAY's single-popover
  // layout — the all-rounder view (OQ1). Only the leaderboard's picker passes this;
  // the player pop-up's popover leaves it false, so it stays byte-identical (no
  // cross group). This exposure is FUNCTIONAL-ONLY and DELIBERATELY THROWAWAY — W4
  // replaces it with the four-dropdown layout (Match · Batting · Bowling · Fielding)
  // + count badges. Cross keys flow through the SAME data-key checkbox + W2
  // sort/highlight machinery as any other column (their key is x__<disc>__<base>).
  crossDiscipline = false,
  // R5 (player pop-up column picker → filter-style, 2026-08-10): OPT-IN restriction
  // of the "Add columns" dropdown bar to Match + the CURRENT discipline's own
  // dropdown only — the player pop-up passes true because its picker is scoped to
  // its own discipline toggle (owner ruling: NO cross-discipline, and NO Fielding
  // column-family — Fielding is the pop-up's SEPARATE mode, not an addable column
  // family here). The leaderboard omits it (false) → all four dropdowns render, so
  // its bar is byte-identical. Purely which TRIGGERS emit; the palette CONTENT
  // (columnsPaletteModel) is unchanged, and gi stays the DISCIPLINE_ORDER index so
  // buildColumnsGroups(gi) still resolves the right discipline.
  ownDisciplineOnly = false,
  // Wave D — D1: OPT-IN player-profile ATTRIBUTE columns (Playing role / Detailed
  // role / Batting hand / Bowling style / Bowling hand). When true AND the current
  // namespace is plain batting/bowling, the picker adds a "Player Profile" section
  // to the current discipline's Add-columns dropdown, offering the discipline's
  // profileColumnSpecs (Batting hand batting-only; the rest both) as plain addable
  // columns. Leaderboard only — the player pop-up leaves it false, so its picker
  // stays byte-identical (profile columns in the pop-up are a later stage).
  profileColumns = false,
  // FC-2 (player pop-up Fielding mode → filter-style picker): OPT-IN callback, true
  // while the pop-up is in its FIELDING mode. The pop-up's getDiscipline() maps that
  // mode to a REAL metrics ns ("batting") so every metrics-layer call resolves
  // unchanged; this flag carries the fielding-only UI intent the ns can't express:
  //   • the Add-columns bar shows ONLY the Match + Fielding dropdowns (the fielding
  //     record is whole-player; there is no batting/bowling column family here), and
  //   • the Match dropdown drops Impact (PoM) — the pop-up's fielding query builds no
  //     pom_cte, so an Impact column would not compute (matches DOES, via fld_matches_cte).
  // The leaderboard omits it (→ false), so its four-dropdown bar + Match section stay
  // byte-identical. The fielding COMPOSER entries themselves live in the Fielding
  // section for ALL plain-ns callers (leaderboard included), gated only by data
  // availability — this flag governs WHICH dropdowns render, not the composers.
  getFieldingMode,
  // Standalone TEAM composer (2026-08-14): OPT-IN async loader for the team list the
  // composer's searchable value picker offers — `loadTeamOptions() -> Promise<[{value,
  // label, games?}]>`. Supplied by the leaderboard host (it closes over the store to
  // scope by gender/team-type/format/date, mirroring the Team FILTER's loader, but with
  // NO sibling cascade — the composer is INDEPENDENT of the scope filters). The picker
  // is store-decoupled by design, so the scope it can't read arrives through this
  // callback. When absent (the player pop-up), the Team composer is simply not offered,
  // so that surface stays byte-identical. Analogous to crossDiscipline / profileColumns
  // / getFieldingMode — an opt-in the leaderboard passes and the pop-up doesn't.
  // Standalone OPPOSITION composer (2026-08-14): reuses this SAME loader — an opponent
  // IS a team, so the leaderboard's Team/Opposition FILTERS already draw from the same
  // list; no second loader is needed or wired.
  loadTeamOptions,
  // Standalone STAGE composer (Step 3, 2026-08-14): the OWN async loader for the Stage
  // composer's value picker — `loadStageOptions() -> Promise<[{value,label}]>` of CLEAN
  // canonical stage names (a stage isn't a team, so it can't reuse loadTeamOptions).
  // Leaderboard-only opt-in (the pop-up passes neither loader), scoped like the Team
  // loader with NO sibling cascade. Absent → the Stage composer is simply not offered.
  loadStageOptions,
  // Standalone EVENT + VENUE composers (Step 4, 2026-08-14): their OWN async value
  // loaders — `loadEventOptions() -> Promise<[{value,label}]>` of CLEAN canonical event
  // names, and `loadVenueOptions() -> Promise<[{value,label}]>` of RAW venue names
  // (venue has no fold). Same leaderboard-only, no-sibling-cascade contract as the Team/
  // Stage loaders; absent → the Event/Venue composer is simply not offered (pop-up).
  loadEventOptions,
  loadVenueOptions,
  // Standalone CITY + SEASON composers (City & Season everywhere, 2026-08-16): their
  // OWN async value loaders — RAW city / season names (no fold), like loadVenueOptions.
  // Leaderboard-only; absent → the composer is simply not offered (pop-up).
  loadCityOptions,
  loadSeasonOptions,
}) {
  // Render the per-column Sort-by + Highlight controls only when the full W2
  // contract is supplied (leaderboard). Absent → the pop-up's plain checkbox
  // picker, unchanged.
  const controlsOn = !!(getSort && setSort && getHighlights && setHighlights);
  // E1b: the per-copy "instances" layout is active only when the host supplies the
  // slot-native contract (leaderboard). It implies controlsOn (the leaderboard
  // passes both quartets). The pop-up popover supplies neither → false → its flat
  // key-based rendering is untouched.
  const multiInstance = !!(getSlots && applySlots && getHighlightIds && setHighlightIds);
  // The currently-open FLOATING popover for THIS picker, if any (Batch 3 fix 3).
  // Tracked here (not just a DOM query) so the host's refresh() can find and
  // re-sync it after every re-render — see open()'s doc comment. NULL for a
  // picker used in INLINE mode (mountInline), which uses inlineState instead.
  let openState = null;
  // The last button mount() wired, so open() can be called with no explicit
  // anchor (the click handler passes it explicitly regardless).
  let lastTrigger = null;
  // W1 (columns rejig, 2026-08-07): the leaderboard mounts this picker INLINE
  // inside the leaderboard popup's "Columns" section (a fixed host element)
  // rather than as a floating popover off a toolbar button. In that mode there is
  // no anchor / positioning / close-on-outside-click; the SAME content and the
  // SAME checkbox handlers render straight into the host, and refresh() keeps it
  // in step with the (possibly pending) store. The two modes are mutually
  // exclusive per instance: the leaderboard is inline-only, the player pop-up
  // popover-only. { el, ns, formats } for the inline host, or null.
  let inlineState = null;

  function positionColumnsPopover(popover, anchor) {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    popover.style.position = "fixed";
    popover.style.top = `${Math.round(rect.bottom + 6)}px`;
    // Right-align to the anchor (matches the old right:0-in-parent look),
    // clamped so it never runs off either edge on a narrow (~380px) viewport.
    const width = popover.offsetWidth || 240;
    let left = rect.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    popover.style.left = `${Math.round(left)}px`;
    popover.style.right = "auto";
  }

  function close() {
    // Inline mode: also close any open floating discipline palette so it never orphans
    // on <body> — e.g. the player pop-up's destroy() (R5) tears the picker down while a
    // dropdown could be open. No-op when nothing is open; for the leaderboard's
    // renderPrompt/Clear this is reached only when no palette is open (its capturing
    // dismiss consumes any outside click first), so that behaviour is unchanged.
    if (inlineState && inlineState.paletteApi) inlineState.paletteApi.closeCurrent();
    if (!openState) return;
    const { el, onDocClick, onKeydown, onScroll, onResize } = openState;
    el.remove();
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
    openState = null;
  }

  // ── E1b multi-instance ("copies") rendering (leaderboard only, multiInstance) ─
  // A leaderboard column identity is either a plain metric key or a count/% (count/
  // per-match) PAIR whose canonical is its count key. Each identity renders as an
  // OFFER header (a checkbox that APPENDS a copy — re-picking never toggles off,
  // owner's "no longer binary" ruling) followed by one INSTANCE row per slot that
  // currently shows it. An instance row carries the per-copy controls: the count/%
  // segmented toggle (pairs only), Sort-by, Highlight, Duplicate, Remove — all keyed
  // by the slot's stable id so each copy acts independently. Numbers are never
  // touched here (display-only; the query dedups copies).

  /** The count/% pair a key belongs to (whether the key is the COUNT variant, the
   * ALT variant, or a composed run-source/wicket-type variant), or null for a plain
   * column. Lets a copy's count/% toggle resolve the pair from whichever variant the
   * slot currently shows. */
  function pairForAnyKey(key, ns) {
    const asCount = togglePairByCount(key, ns);
    if (asCount) return asCount; // key IS a count variant
    const altSet = _TOGGLE_ALTS_BY_NS[ns];
    if (altSet && altSet.has(key)) {
      for (const p of COLUMN_TOGGLE_PAIRS[ns] || []) if (p.alt === key) return p;
    }
    const rs = parseComposedRunSourceKey(key);
    if (rs) return { count: makeComposedRunSourceKey(rs.token, "runs"), alt: makeComposedRunSourceKey(rs.token, "pct"), mode: "pct" };
    // Wave C #24: resolve the count/% pair from EITHER runs-conceded-by-source variant.
    const rsc = parseComposedRunSourceConcededKey(key);
    if (rsc) return { count: makeComposedRunSourceConcededKey(rsc.token, "runs"), alt: makeComposedRunSourceConcededKey(rsc.token, "pct"), mode: "pct" };
    const wt = parseComposedWicketTypeKey(key);
    if (wt) return { count: makeComposedWicketTypeKey(wt.token, "count"), alt: makeComposedWicketTypeKey(wt.token, "pct"), mode: "pct" };
    // FC-2: resolve the count/per-match pair from EITHER a fielding composer variant.
    const fc = parseComposedFieldingKey(key);
    if (fc) return { count: makeComposedFieldingKey(fc.tally, fc.dim, fc.value, false), alt: makeComposedFieldingKey(fc.tally, fc.dim, fc.value, true), mode: "permatch" };
    return null;
  }

  /** The slots (in column order) belonging to a column identity `canonKey` (its
   * count key for a pair, its own key otherwise): a plain identity matches slots
   * whose key === canonKey; a pair matches slots whose key is EITHER variant. */
  function slotsForCanon(canonKey, ns) {
    const pair = togglePairByCount(canonKey, ns);
    const keys = pair ? new Set([pair.count, pair.alt]) : new Set([canonKey]);
    return (getSlots ? getSlots() : []).filter((s) => keys.has(s.key));
  }

  /** E1b: the count/% (count/per-match) segmented toggle for ONE copy. The active
   * segment is whichever variant this slot's key currently is; clicking a segment
   * swaps THIS slot's key (preserving its id). */
  function modeToggleInstanceHTML(slot, pair) {
    const isAlt = slot.key === pair.alt;
    const isPerMatch = pair.mode === "permatch";
    const altGlyph = isPerMatch ? "/M" : "%";
    const altTitle = isPerMatch ? "Show as per match" : "Show as percentage";
    const groupLabel = isPerMatch ? "Show as count or per match" : "Show as count or percentage";
    return `<span class="col-mode-toggle" role="group" aria-label="${groupLabel}">
      <button type="button" class="col-mode-seg${!isAlt ? " is-active" : ""}" data-mode-slot="${slot.id}" data-mode-target="count" aria-pressed="${!isAlt ? "true" : "false"}" title="Show as count">#</button>
      <button type="button" class="col-mode-seg${isAlt ? " is-active" : ""}" data-mode-slot="${slot.id}" data-mode-target="alt" aria-pressed="${isAlt ? "true" : "false"}" title="${altTitle}">${altGlyph}</button>
    </span>`;
  }

  /** E1b: the count/% toggle (pairs only) + Sort-by / Highlight / Duplicate / Remove
   * control cluster for ONE slot, as inner markup (no wrapping row). Extracted so both
   * the E1b instance row AND the picker-rework chosen-columns row (chosenColumnRowHTML)
   * render the IDENTICAL per-copy controls keyed by the slot's stable id. Sort +
   * Highlight attach to the id (act on exactly this copy); Duplicate appends another
   * copy of the current variant; Remove drops just this copy. */
  function instanceControlsMarkup(slot, pair) {
    const id = slot.id;
    const key = slot.key; // the copy's active variant
    const sort = getSort ? getSort() : null;
    const isActiveSort = !!(sort && sort.active && (sort.slotId != null ? sort.slotId === id : sort.key === key));
    const sortArrow = isActiveSort ? (sort.dir === "asc" ? "▲" : "▼") : "↕";
    const sortTitle = isActiveSort ? "Sorted by this copy — click to reverse direction" : "Sort the table by this copy";
    const hlOn = getHighlightIds ? new Set(getHighlightIds()).has(id) : false;
    const hlTitle = hlOn ? "Remove highlight" : "Highlight this copy";
    const mode = pair ? modeToggleInstanceHTML(slot, pair) : "";
    return `${mode}
      <span class="columns-popover__item-controls">
        <button type="button" class="col-sort-btn${isActiveSort ? " is-active" : ""}" data-sort-slot="${id}" data-sort-key="${key}" aria-pressed="${isActiveSort ? "true" : "false"}" title="${sortTitle}" aria-label="${sortTitle}">${sortArrow}</button>
        <button type="button" class="col-hl-btn${hlOn ? " is-active" : ""}" data-hl-slot="${id}" aria-pressed="${hlOn ? "true" : "false"}" title="${hlTitle}" aria-label="${hlTitle}">${HIGHLIGHT_GLYPH}</button>
        <button type="button" class="col-dup-btn" data-dup-slot="${id}" title="Add another copy of this column" aria-label="Add another copy of this column">${DUPLICATE_GLYPH}</button>
        <button type="button" class="col-remove-btn" data-remove-slot="${id}" title="Remove this copy" aria-label="Remove this copy">✕</button>
      </span>`;
  }


  // ── Shared leaf/section builders (used by BOTH the pop-up's flat picker and
  //    the leaderboard's four-dropdown layout, so the two render byte-identical
  //    rows) ─────────────────────────────────────────────────────────────────

  /** One metric row: a plain checkbox label. Used ONLY by the pop-up popover's flat
   * picker (buildPickerHTML) — that surface passes neither the multi-instance nor the
   * Sort-by/Highlight contract, so it always renders the bare checkbox. The batting
   * Dismissals dual-key rows render via dismissalRowHTML, not this helper. (The
   * leaderboard's inline picker no longer routes through here — it renders the
   * filter-style chosen-rows list; the W2/E1b checkbox layout has been retired.) */
  function itemRowHTML(m, formats, visible) {
    return `<label class="columns-popover__item">
        <input type="checkbox" data-key="${m.key}" ${visible.has(m.key) ? "checked" : ""} />
        <span>${metricDisplayLabel(m, formats)}</span>
      </label>`;
  }

  /** A labelled section of metric rows, or "" when the section is empty. */
  function sectionHTML(label, metrics, formats, visible) {
    return metrics.length
      ? `<div class="columns-popover__section-label">${label}</div>
           <div class="columns-popover__list">
             ${metrics.map((m) => itemRowHTML(m, formats, visible)).join("")}
           </div>`
      : "";
  }

  /** The Dismissals block: batting's pruned real/rare + "Show as %" layout
   * (batting ONLY — see the RARE_DISMISSAL_KINDS doc comment for why every other
   * namespace keeps the plain list), or a plain section for every other ns. */
  function dismissalSectionHTML(ns, formats, visible, dismissal) {
    if (ns === "batting") {
      const showPct = computeInitialShowPct(getColumns());
      const realKinds = DISMISSAL_KINDS.filter((d) => !RARE_DISMISSAL_KINDS.has(d.kind));
      const rareKinds = DISMISSAL_KINDS.filter((d) => RARE_DISMISSAL_KINDS.has(d.kind));
      return `
        <div class="columns-popover__section-label">Dismissals</div>
        <label class="columns-popover__pct-toggle">
          <input type="checkbox" data-role="dismissal-pct-toggle" ${showPct ? "checked" : ""} />
          <span>Show as %</span>
        </label>
        <div class="columns-popover__list">
          ${realKinds.map((d) => dismissalRowHTML(d, visible)).join("")}
        </div>
        <details class="columns-popover__disclosure">
          <summary><span class="columns-popover__disclosure-arrow">▸</span> Rare dismissals</summary>
          <div class="columns-popover__list">
            ${rareKinds.map((d) => dismissalRowHTML(d, visible)).join("")}
          </div>
        </details>`;
    }
    return sectionHTML("Dismissals", dismissal, formats, visible);
  }

  /** Build the picker's inner HTML for a namespace/format selection: the same
   * Basic / Dismissals / Fielding / Impact / Phase sections the FLOATING POPOVER
   * always rendered. Reads the CURRENT visible column list (getColumns) for
   * checked state. Pure string builder — no DOM, no listeners.
   *
   * This is the POP-UP path (playerFiltersTab.js's popover), left byte-identical:
   * that surface passes no W2 controls (controlsOn false) and crossDiscipline
   * false, so it renders plain checkbox rows with a flat Phase section, exactly
   * as before. The LEADERBOARD inline picker renders the filter-style chosen-rows
   * list instead (buildInlineHTML / renderInline). */
  function buildPickerHTML(ns, formats) {
    const all = eligibleMetrics(ns, formats);
    const basic = all.filter(
      (m) => !m.isPhaseMetric && m.section !== "dismissal" && m.section !== "fielding" && m.section !== "impact"
    );
    const dismissal = all.filter((m) => m.section === "dismissal");
    // Fielding / Impact (Wave 3): their own sub-headers in BOTH views. Plain
    // data-key checkboxes (same mechanics as Basic).
    const fielding = all.filter((m) => m.section === "fielding");
    const impact = all.filter((m) => m.section === "impact");
    const phase = all.filter((m) => m.isPhaseMetric);
    const visible = new Set(getColumns());

    // Cross-discipline group (W3, interim): the OTHER discipline's columns, offered
    // only on a plain batting/bowling table when the host opted in. Each row's
    // data-key is the CROSS key (x__<other>__<base>). Kept here for any host that
    // still uses the flat popover with crossDiscipline on; the leaderboard's own
    // cross columns now live in the W4 Batting/Bowling dropdown instead.
    let crossHTML = "";
    if (crossDiscipline && (ns === "batting" || ns === "bowling")) {
      const other = OTHER_DISCIPLINE[ns];
      const crossRows = eligibleCrossMetrics(ns, formats).map((base) => ({
        ...base,
        key: makeCrossKey(other, base.key),
      }));
      const crossLabel = `${other === "bowling" ? "Bowling" : "Batting"} (other discipline)`;
      crossHTML = sectionHTML(crossLabel, crossRows, formats, visible);
    }

    return (
      sectionHTML("Basic", basic, formats, visible) +
      dismissalSectionHTML(ns, formats, visible, dismissal) +
      sectionHTML("Fielding", fielding, formats, visible) +
      sectionHTML("Impact", impact, formats, visible) +
      sectionHTML("Phase", phase, formats, visible) +
      crossHTML
    );
  }

  // ── W4: four-dropdown layout (Match · Batting · Bowling · Fielding) + composer ─

  /** The batting/bowling "bucket" a namespace belongs to (matchup namespaces
   * fold onto their base discipline). Governs which physical dropdown holds the
   * current discipline's OWN columns vs the cross-discipline columns. */
  function disciplineBucket(ns) {
    return ns === "bowling" || ns === "matchup_bowling" ? "bowling" : "batting";
  }

  // ── Columns content rework Wave A (2026-08-07, display-only) ─────────────────
  // Owner-approved v5 rename/regroup: (1) `player_of_match` (the Y/N flag) and
  // `wickets_per_innings` are REMOVED from the columns picker only — they stay
  // in metrics.js (filters/advanced conditions still reference potm_count's
  // sibling def / wickets_per_innings) and are untouched everywhere else; (2)
  // the surviving plain columns get an explicit v5 display order within their
  // Basic/Detailed sections. Both are LOCAL to this module (picker-layout
  // judgment calls, same posture as RARE_DISMISSAL_KINDS above) — no
  // sqlExpression, no eligibleMetrics/state.js change, so filters/advanced
  // conditions and the pop-up's own popover (buildPickerHTML, untouched) keep
  // offering them exactly as before.
  //
  // Columns-popup rework Wave A (#28, owner 2026-08-12): the standalone
  // `boundary_runs` ("Boundary Runs") RESTORED as an own offered batting Detailed
  // column — the owner's flag-off review wanted it back as a plain column
  // alongside the Runs-by-Source composer's "Boundaries" source, not hidden
  // behind it. It stays a "count" key in COLUMN_TOGGLE_PAIRS.batting (toggle to
  // "Boundary Run %" / boundary_runs_pct still works). No longer in this set.
  //
  // enum-fixes pass (owner-authorized removal): `four_wicket_hauls` ("Four-Wicket
  // Hauls") is REMOVED from the Bowling columns offering — `five_wicket_hauls`
  // ("Five-Wicket Hauls") stays exactly as-is. Same hidden-not-deleted posture:
  // the metric DEF (and its sqlExpression) stays in metrics.js untouched, so any
  // other consumer (pop-up popover, filters, graph) keeps offering it — this only
  // hides the column from THIS picker.
  const HIDDEN_COLUMN_KEYS = new Set(["player_of_match", "wickets_per_innings", "four_wicket_hauls"]);

  const BATTING_BASIC_ORDER = [
    "innings", "runs", "balls_faced", "dismissals", "high_score", "fours", "sixes",
    "dot_balls", "fifties", "hundreds", "ducks", "not_outs",
  ];
  const BATTING_DETAILED_ORDER = [
    "average", "strike_rate", "running_sr", "balls_per_dismissal", "balls_per_boundary",
    "boundary_balls", "boundary_runs", "balls_per_four", "balls_per_six", "balls_faced_share",
  ];
  const BOWLING_BASIC_ORDER = [
    "innings", "wickets", "balls", "overs", "runs_conceded", "maidens",
    "extras_wides", "extras_noballs", "fours_conceded", "sixes_conceded", "dot_balls_conceded", "best",
  ];
  const BOWLING_DETAILED_ORDER = ["economy", "average", "strike_rate", "boundary_pct_conceded", "boundary_runs_pct"];

  // Columns content rework Wave B: the owner-approved v5 layout (columns-content-
  // audit) places two COUNTING totals — Boundary Balls / Boundary Runs — in the
  // batting Detailed sub-section (alongside the rate/% stats), not Basic. The
  // kind-based Basic/Detailed split below (isDetailed) can't express that on its own
  // (they're kind:"total"), so this DISPLAY-ONLY set lists the total keys the
  // four-dropdown layout treats as Detailed. metrics.js `kind` is untouched (charts/
  // donut/additivity unaffected) — this is purely picker sub-grouping, the same
  // posture as the order arrays / HIDDEN_COLUMN_KEYS above.
  const DETAILED_TOTAL_KEYS = new Set(["boundary_balls", "boundary_runs"]);

  // Columns content rework D2: the enumerated faced-ball-progression columns
  // (batting Detailed) are REPLACED by the Ball Range composer in the leaderboard
  // four-dropdown picker — hidden from the offered listing here so there is no
  // display-identical duplicate (the composer offers the equivalent bl__ keys).
  // Their metric DEFS stay in metrics.js (the pop-up popover, filters, graph and —
  // repointed — the Progression preset still reference them); this hides them only
  // from THIS picker, exactly as the enumerated phase metrics were replaced in D1.
  const BALL_RANGE_ENUMERATED_KEYS = new Set(["sr_first10", "sr_11_20", "sr_21plus"]);

  // Columns content rework D3: the enumerated run-source % columns (batting) and the
  // enumerated wicket-type columns (bowling wkt_*) are REPLACED by the Runs by Source
  // / Wicket Type composers in the leaderboard four-dropdown picker — hidden from the
  // OWN-discipline listing here so there is no display-identical duplicate. (The
  // batting Dismissals breakdown out_* is already section "dismissal", excluded from
  // `core`; it drops from the leaderboard simply by not rendering dismissalSectionHTML
  // below.) The metric DEFS stay in metrics.js (pop-up popover, filters, graph,
  // advanced conditions, presets still reference them). Cross-discipline columns are
  // NOT hidden — the other discipline's fingerprint stays available as an all-rounder
  // cross column (preserve existing functionality), and it has no own-discipline
  // duplicate on that table. Batting-only keys are inert on a bowling table and vice
  // versa (they aren't in that discipline's eligibleMetrics), so one combined set is
  // safe to apply on either plain namespace.
  const D3_ENUMERATED_HIDDEN_KEYS = new Set([
    // batting run-source % (boundary_runs_pct is the boundary_runs toggle alt — hidden
    // via hiddenAlts, and reused as the composer's "Boundaries" row — so NOT listed):
    "runs_1s_pct", "runs_2s_pct", "runs_3s_pct", "runs_4s_run_pct", "runs_4s_boundary_pct",
    "runs_5s_pct", "runs_6s_run_pct", "runs_6s_boundary_pct",
    // bowling wicket types:
    "wkt_bowled", "wkt_lbw", "wkt_caught", "wkt_caught_and_bowled", "wkt_stumped", "wkt_hit_wicket",
    // Wave C #24: bowling runs-conceded-by-source % — these catalogued metrics are the
    // FILTER surface ("% Runs Conceded in…"); their COLUMN home is the Runs Conceded by
    // Source composer (rsc__ keys), so hide the catalogued keys from the plain picker to
    // avoid a display-identical duplicate (exactly like the batting runs_*_pct above).
    "runs_conc_4s_pct", "runs_conc_6s_pct", "runs_conc_nonbdry_pct", "runs_conc_wides_pct", "runs_conc_noballs_pct",
  ]);

  // Columns content rework D4: the enumerated ≥-N-only threshold columns are REPLACED
  // by the parametric Innings Score Range (batting) / Wicket Haul (bowling) composers —
  // hidden from the OWN-discipline listing here so there is no duplicate. Their metric
  // DEFS stay in metrics.js (the pop-up filter, paletteGroups, and the drawer's param
  // HAVING path still reference them). Batting-only / bowling-only keys are inert on the
  // other discipline's table, so one combined set is safe on either plain namespace.
  const D4_ENUMERATED_HIDDEN_KEYS = new Set(["innings_score_ge", "wicket_hauls_ge"]);

  /** Reorder `list` so any metric whose key appears in `order` comes first (in
   * `order`'s sequence); every other metric keeps its ORIGINAL relative order,
   * appended after. Metrics not named in `order` are untouched siblings (the
   * v5 audit's "leave untouched" set — phase %, dismissal-kind %, run-source %,
   * wicket-haul counts, …) — this never drops or renames anything, purely a
   * stable display sort. */
  function orderByKeys(list, order) {
    const rank = new Map(order.map((k, i) => [k, i]));
    return list
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ra = rank.has(a.m.key) ? rank.get(a.m.key) : order.length + a.i;
        const rb = rank.has(b.m.key) ? rank.get(b.m.key) : order.length + b.i;
        return ra - rb;
      })
      .map((x) => x.m);
  }

  /** Wire every checkbox's change handler onto `rootEl` (the floating popover OR
   * the inline host). Behaviour-identical to the pre-extraction inline handlers:
   * every mutation runs through the caller's setColumns with the full new
   * column-key array — INSTANT apply, numbers sacred (no SQL here). */
  function wireCheckboxes(rootEl) {
    // Plain data-key checkboxes: Basic, Fielding, Impact, Phase, and (outside
    // batting) Dismissals.
    rootEl.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cols = getColumns().slice();
        if (cb.checked) {
          if (!cols.includes(cb.dataset.key)) cols.push(cb.dataset.key);
        } else {
          const idx = cols.indexOf(cb.dataset.key);
          if (idx >= 0) cols.splice(idx, 1);
        }
        // R4 Wave 4a (A1): INSTANT column change — the host's setColumns applies
        // it now (re-rendering / requerying the same rows) without lighting Search.
        setColumns(cols);
      });
    });

    // Wave C count/% (count/per-match) toggle rows: a DUAL-KEY checkbox. Ticking
    // adds the COUNT variant (default count); unticking removes BOTH. Distinct
    // data-toggle-* attributes so this never overlaps the batting-Dismissals
    // data-count-key handler below. Sync immediately (idempotent with the host's
    // async refresh) so the mode segs + sort/highlight controls follow the change.
    rootEl.querySelectorAll('input[type="checkbox"][data-toggle-count]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cols = getColumns().slice();
        const countKey = cb.dataset.toggleCount;
        const altKey = cb.dataset.toggleAlt;
        if (cb.checked) {
          if (!cols.includes(countKey) && !cols.includes(altKey)) cols.push(countKey);
        } else {
          [countKey, altKey].forEach((k) => {
            const idx = cols.indexOf(k);
            if (idx >= 0) cols.splice(idx, 1);
          });
        }
        setColumns(cols); // A1: INSTANT, no Search light
        syncCheckedState(rootEl);
      });
    });

    // Batting Dismissals rows: each checkbox stands for whichever variant (count
    // vs %) the toggle currently selects. Ticking adds THAT variant; unticking
    // removes BOTH (defensive against a legacy mixed-state save).
    const toggleEl = rootEl.querySelector('[data-role="dismissal-pct-toggle"]');
    rootEl.querySelectorAll('input[type="checkbox"][data-count-key]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cols = getColumns().slice();
        const countKey = cb.dataset.countKey;
        const pctKey = cb.dataset.pctKey;
        if (cb.checked) {
          const activeKey = toggleEl.checked ? pctKey : countKey;
          if (!cols.includes(activeKey)) cols.push(activeKey);
        } else {
          [countKey, pctKey].forEach((k) => {
            const idx = cols.indexOf(k);
            if (idx >= 0) cols.splice(idx, 1);
          });
        }
        setColumns(cols); // A1: INSTANT, no Search light
      });
    });

    // Section-level "Show as %" toggle: on every flip, normalise EVERY
    // currently-checked dismissal row onto the new variant (decision 44c —
    // "normalise on first interaction", never merely on open).
    if (toggleEl) {
      toggleEl.addEventListener("change", () => {
        const cols = getColumns().slice();
        const showPct = toggleEl.checked;
        for (const d of DISMISSAL_KINDS) {
          const countKey = d.key;
          const pctKey = `${d.key}_pct`;
          const wasChecked = cols.includes(countKey) || cols.includes(pctKey);
          if (!wasChecked) continue;
          [countKey, pctKey].forEach((k) => {
            const idx = cols.indexOf(k);
            if (idx >= 0) cols.splice(idx, 1);
          });
          cols.push(showPct ? pctKey : countKey);
        }
        setColumns(cols); // A1: INSTANT, no Search light
      });
    }
  }


  /** E1b: wire the multi-instance ("copies") controls — the leaderboard's inline
   * picker only. Every mutation is INSTANT + display-only (applySlots dedups copies
   * before the query, so numbers never move); the ones that change the NUMBER of rows
   * (add / duplicate / remove) rerenderInline so the copy list rebuilds, exactly like
   * the D4 param builder. A count/% swap keeps the row count, so it just applies +
   * lets the store subscription re-sync the segments. */
  function wireMultiInstance(rootEl) {
    // OFFER header checkbox: APPEND a fresh copy (default count variant) — whether the
    // column is currently shown or not (owner's non-binary re-pick). A new column goes
    // to the end of the list; to HIDE a column, remove its copy/copies via the ✕.
    rootEl.querySelectorAll(".cols-offer-cb[data-add-key]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const key = cb.dataset.addKey;
        applySlots([...(getSlots() || []), makeSlot(key)]);
        rerenderInline();
      });
    });
    // DUPLICATE: append another copy of THIS copy's current variant, right after it
    // (so copies group together). data-dup-slot identifies the source copy.
    rootEl.querySelectorAll(".col-dup-btn[data-dup-slot]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.dupSlot;
        const slots = (getSlots() || []).slice();
        const i = slots.findIndex((s) => s.id === id);
        if (i < 0) return;
        slots.splice(i + 1, 0, makeSlot(slots[i].key));
        applySlots(slots);
        rerenderInline();
      });
    });
    // REMOVE: drop just this copy; any other copy of the same stat stays.
    rootEl.querySelectorAll(".col-remove-btn[data-remove-slot]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.removeSlot;
        applySlots((getSlots() || []).filter((s) => s.id !== id));
        rerenderInline();
      });
    });
    // Per-copy SORT: route through the host's sort path with THIS copy's slot id, so
    // the arrow lands on this copy (two-way bound with the table header).
    rootEl.querySelectorAll(".col-sort-btn[data-sort-slot]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setSort(btn.dataset.sortKey, btn.dataset.sortSlot);
      });
    });
    // Per-copy HIGHLIGHT: toggle this copy's slot id in the display-only highlight set.
    rootEl.querySelectorAll(".col-hl-btn[data-hl-slot]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.hlSlot;
        const cur = (getHighlightIds ? getHighlightIds() : []).slice();
        const idx = cur.indexOf(id);
        if (idx >= 0) cur.splice(idx, 1);
        else cur.push(id);
        setHighlightIds(cur);
      });
    });
    // Per-copy count/% (count/per-match) SWAP: change THIS copy's variant in place
    // (preserving its slot id so its sort/highlight follow), then rebuild so the row's
    // controls reflect the new variant. No number moves (display-only variant).
    rootEl.querySelectorAll(".col-mode-seg[data-mode-slot]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.modeSlot;
        const target = btn.dataset.modeTarget; // "count" | "alt"
        const slots = (getSlots() || []).slice();
        const i = slots.findIndex((s) => s.id === id);
        if (i < 0) return;
        const pair = pairForAnyKey(slots[i].key, getDiscipline());
        if (!pair) return;
        const wantKey = target === "alt" ? pair.alt : pair.count;
        if (slots[i].key === wantKey) return; // already showing that variant
        slots[i] = { ...slots[i], key: wantKey }; // id preserved → sort/highlight follow
        applySlots(slots);
        rerenderInline();
      });
    });
  }

  /** E1b: re-sync the per-copy Sort-by + Highlight indicators from the live host
   * state WITHOUT rebuilding — called from syncInline so an EXTERNAL sort change
   * (e.g. a table-header click while the popup is open) or a highlight repaint keeps
   * the copy rows honest. Instance rows only ever exist for shown copies, so there is
   * no disabled state; the data-keys are always fresh (a variant swap rebuilds the row). */
  function syncInstanceControls(rootEl) {
    const sort = getSort ? getSort() : null;
    const hlSet = new Set(getHighlightIds ? getHighlightIds() : []);
    const slotById = new Map((getSlots ? getSlots() : []).map((s) => [s.id, s]));
    rootEl.querySelectorAll(".col-sort-btn[data-sort-slot]").forEach((btn) => {
      const id = btn.dataset.sortSlot;
      const slot = slotById.get(id);
      const key = slot ? slot.key : btn.dataset.sortKey;
      const isActive = !!(sort && sort.active && (sort.slotId != null ? sort.slotId === id : sort.key === key));
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.textContent = isActive ? (sort.dir === "asc" ? "▲" : "▼") : "↕";
    });
    rootEl.querySelectorAll(".col-hl-btn[data-hl-slot]").forEach((btn) => {
      const on = hlSet.has(btn.dataset.hlSlot);
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }


  /** Re-sync every checkbox's checked state from getColumns() WITHOUT rebuilding
   * — the host may have silently pruned a column out from under us. Two checkbox
   * shapes share this: plain data-key ones and the batting Dismissals dual-key
   * rows (checked iff EITHER underlying column is visible). The "Show as %"
   * toggle has neither dataset key and is skipped (its own state is plain UI
   * state, untouched by reloads). Shared by the popover and inline refresh. */
  function syncCheckedState(rootEl) {
    const visible = new Set(getColumns());
    rootEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      if (cb.dataset.addKey) {
        // E1b offer header: checked iff this column identity has ≥1 copy shown.
        cb.checked = slotsForCanon(cb.dataset.addKey, getDiscipline()).length > 0;
      } else if (cb.dataset.key) {
        cb.checked = visible.has(cb.dataset.key);
      } else if (cb.dataset.countKey) {
        cb.checked = visible.has(cb.dataset.countKey) || visible.has(cb.dataset.pctKey);
      } else if (cb.dataset.toggleCount) {
        // Wave C toggle rows: checked iff EITHER the count or alternate is shown.
        cb.checked = visible.has(cb.dataset.toggleCount) || visible.has(cb.dataset.toggleAlt);
      }
    });
  }

  /** Shallow array equality for the format selection (used to decide whether an
   * inline refresh needs a full re-render — a format change swaps per-format
   * metric labels / eligibility — or just a cheap checked-state re-sync). */
  function sameFormats(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ── PICKER REWORK to FILTER-STYLE (E1c, 2026-08-08; R4-A rework 2026-08-10) ───
  // Leaderboard inline only. The Columns section works EXACTLY like the Filters section:
  //   • a CHOSEN-ROWS list — one row per displayed column, EVERY row uniform (owner
  //     ruling R4-A): plain, composer-made, parametric and R2 auto-added rows all carry
  //     the full per-copy controls (count/% · sort · highlight · duplicate · ×, reusing
  //     E1b's instanceControlsMarkup). Composer-made rows ALSO carry an edit pencil that
  //     re-opens their compose editor in place (single-column re-edit); parametric rows
  //     (Innings Score / Wicket Haul) are re-edited via their inline op+value.
  //   • four click-to-add MENUS (Match · Batting · Bowling · Fielding) of addable plain
  //     column NAMES + composer + parametric entries. A plain name appends a slot
  //     (re-pick appends another copy — multi-instance E1). A composer entry opens a
  //     TRANSIENT compose editor ("compose then add", R4-A): pick one stat + tick several
  //     dimensions → on confirm spawn ONE standalone chosen-column row per ticked
  //     dimension. NO persistent composer row remains.
  // PRESENTATION-ONLY: composed slots still live in state.columns[ns] and are generated
  // by the UNCHANGED composer machinery (same composed keys → same slots) — this only
  // rearranges how columns are picked + shown. The sacred query builders never see any
  // of this (applySlots → load() dedups; buildMatchupQuery dedups). The pop-up popover
  // path (buildPickerHTML / open) is untouched — flat checkbox list, byte-identical.

  // Fixed order + labels for the dimension / category composers (compose editors).
  const DIM_COMPOSER_KINDS = ["phase", "ball", "innings", "battingposition", "team", "opposition", "stage", "event", "venue", "city", "season", "runsource", "runsourceconc", "wickettype"];
  const COMPOSER_KIND_LABEL = {
    phase: "Phase Range", ball: "Ball Range", innings: "Innings Range",
    // Chunk 1B: the per-position breakdown composer (batting-only; self-gates via
    // composerAvailable → composedPositionPool is [] for bowling). Menu-label choice.
    battingposition: "Batting Position",
    // Standalone TEAM composer (2026-08-14): data-driven value set → a SEARCH-and-pick
    // value control (not a fixed tick-box list); self-gates via composerAvailable on
    // loadTeamOptions + a non-empty pool. Both disciplines.
    team: "Team",
    // Standalone OPPOSITION composer (2026-08-14): the opponent-side mirror of Team —
    // same search-and-pick control (reuses loadTeamOptions), same gating. Both disciplines.
    opposition: "Opposition",
    // Standalone STAGE composer (Step 3, 2026-08-14): a THIRD search-and-pick composer —
    // its picks are CANONICAL stage names; self-gates on loadStageOptions. Both disciplines.
    stage: "Stage",
    // Standalone EVENT + VENUE composers (Step 4, 2026-08-14): the FOURTH + FIFTH search-
    // and-pick composers — Event picks CANONICAL event names (loadEventOptions), Venue
    // picks RAW venue names (loadVenueOptions). Both disciplines; self-gate on their loaders.
    event: "Event",
    venue: "Venue",
    // Standalone CITY + SEASON composers (City & Season everywhere, 2026-08-16): RAW
    // city / season names (no fold), both disciplines; self-gate on their loaders.
    city: "City",
    season: "Season",
    runsource: "Runs by Source", runsourceconc: "Runs Conceded by Source", wickettype: "Wicket Type",
  };
  // The composers whose value control is a data-driven SEARCH picker rather than a
  // fixed tick-box list (their `ticks` ARE the composed column keys, like the fielding
  // range kinds). Team, its Opposition mirror, and Stage.
  const SEARCH_COMPOSER_KINDS = new Set(["team", "opposition", "stage", "event", "venue", "city", "season"]);
  // Per-search-composer metadata: key codec + session registry + value loader +
  // display nouns/placeholders, keyed by kind — so the mount / stat-remap / confirm
  // blocks below stay kind-agnostic (add a fourth search composer by adding a row).
  // Team & Opposition share loadTeamOptions (an opponent IS a team); Stage has its OWN
  // loadStageOptions (a stage isn't a team) and its picks are CANONICAL stage names.
  // The loaders are captured here from the destructured params (undefined on the pop-up,
  // where the composer self-gates off via composerAvailable). This is the "generalise the
  // loader BY KIND" the plan calls for.
  const SEARCH_COMPOSER_META = {
    team: {
      parse: parseComposedTeamKey, make: makeComposedTeamKey, register: registerComposedTeamKeys,
      nameOf: (p) => p.teamName, loader: loadTeamOptions, noun: "team",
      placeholder: "Choose teams…", filterPlaceholder: "Type to filter teams…", ariaLabel: "Teams",
    },
    opposition: {
      parse: parseComposedOppositionKey, make: makeComposedOppositionKey, register: registerComposedOppositionKeys,
      nameOf: (p) => p.oppName, loader: loadTeamOptions, noun: "opponent",
      placeholder: "Choose opponents…", filterPlaceholder: "Type to filter opponents…", ariaLabel: "Opponents",
    },
    stage: {
      parse: parseComposedStageKey, make: makeComposedStageKey, register: registerComposedStageKeys,
      nameOf: (p) => p.stageName, loader: loadStageOptions, noun: "stage",
      placeholder: "Choose stages…", filterPlaceholder: "Type to filter stages…", ariaLabel: "Stages",
    },
    event: {
      parse: parseComposedEventKey, make: makeComposedEventKey, register: registerComposedEventKeys,
      nameOf: (p) => p.eventName, loader: loadEventOptions, noun: "event",
      placeholder: "Choose events…", filterPlaceholder: "Type to filter events…", ariaLabel: "Events",
    },
    venue: {
      parse: parseComposedVenueKey, make: makeComposedVenueKey, register: registerComposedVenueKeys,
      nameOf: (p) => p.venueName, loader: loadVenueOptions, noun: "venue",
      placeholder: "Choose venues…", filterPlaceholder: "Type to filter venues…", ariaLabel: "Venues",
    },
    city: {
      parse: parseComposedCityKey, make: makeComposedCityKey, register: registerComposedCityKeys,
      nameOf: (p) => p.cityName, loader: loadCityOptions, noun: "city",
      placeholder: "Choose cities…", filterPlaceholder: "Type to filter cities…", ariaLabel: "Cities",
    },
    season: {
      parse: parseComposedSeasonKey, make: makeComposedSeasonKey, register: registerComposedSeasonKeys,
      nameOf: (p) => p.seasonName, loader: loadSeasonOptions, noun: "season",
      placeholder: "Choose seasons…", filterPlaceholder: "Type to filter seasons…", ariaLabel: "Seasons",
    },
  };
  // #35 (columns-popup rework Wave B): the count/% AXIS is NOT a selectable choice in
  // the compose editor — it is ONLY the post-add per-row toggle. Runs by Source and
  // Wicket Type are the two composers whose "stat" IS that count/% axis, so their
  // compose editor renders NO stat/axis <select>: the axis defaults to the count
  // variant on ADD and is preserved silently on EDIT (composerSelForKey), while the
  // per-row count/% control does the switching. Every other composer keeps its real
  // stat select (base metric for Phase/Ball/Innings, base tally for the fc_ family).
  const AXIS_ONLY_COMPOSER_KINDS = new Set(["runsource", "runsourceconc", "wickettype"]);
  // opToken (ge/le/eq/bt) → the operator <select>'s value (gte/lte/eq/between).
  const _PARAM_OPTOKEN_TO_KEY = Object.fromEntries(
    Object.entries(COMPOSED_PARAM_OP_TOKEN).map(([k, v]) => [v, k])
  );

  // ── Fielding composers (FC-2) ────────────────────────────────────────────────
  // Six dimension composers over the fc__ family (metrics.js): pick a base TALLY +
  // tick/define a dimension's value(s) → one standalone fc__ column per value, each
  // with the count↔per-match toggle. Kinds are namespaced `fc_*` so they never
  // collide with the batting/bowling DIM_COMPOSER_KINDS, and route through the SAME
  // R4-A compose editor. Offered in the Fielding section for ALL plain-ns callers
  // (leaderboard Fielding dropdown AND the pop-up Fielding mode). NO metrics.js
  // change: these helpers only GENERATE fc__ keys; the resolver + prune already exist.
  const FC_COMPOSER_KINDS = ["fc_phase", "fc_over", "fc_inns", "fc_pos", "fc_hand", "fc_bstyle"];
  const FC_COMPOSER_LABEL = {
    fc_phase: "Phase", fc_over: "Over Range", fc_inns: "Innings",
    fc_pos: "Dismissed Position", fc_hand: "Dismissed Hand", fc_bstyle: "Bowler Style",
  };
  // The metrics.js fc__ `dim` token a composer kind carries, and back.
  const FC_KIND_DIM = { fc_phase: "phase", fc_over: "over", fc_inns: "inns", fc_pos: "pos", fc_hand: "hand", fc_bstyle: "bstyle" };
  const FC_DIM_KIND = { phase: "fc_phase", over: "fc_over", inns: "fc_inns", pos: "fc_pos", hand: "fc_hand", bstyle: "fc_bstyle" };
  // over / pos are USER-DEFINED numeric ranges (1-based) — a "define a range" editor,
  // not a fixed tick-box list.
  const FC_RANGE_KINDS = new Set(["fc_over", "fc_pos"]);
  // The 5 base tallies (fc__ `tally` tokens) — the compose editor's stat <select>.
  // These labels MIRROR metrics.js _FC_TALLIES for display; the KEY drives the SQL, so
  // a label can never move a number. (metrics.js is off-limits, so the UI carries the
  // display vocab.)
  const FC_TALLY_OPTIONS = [
    { value: "catches", label: "Catches" },
    { value: "cab", label: "Caught & bowled" },
    { value: "stumpings", label: "Stumpings" },
    { value: "runouts", label: "Run-outs" },
    { value: "dismissals", label: "Fielding Dismissals" },
  ];
  // Finite dimension value tokens + labels (mirror metrics.js _FC_PHASE / _FC_HAND /
  // _FC_BSTYLE_*). over / pos have no fixed list (user-defined ranges).
  const FC_PHASE_VALUES = [
    { token: "pp", label: "Powerplay" }, { token: "mid", label: "Middle Overs" }, { token: "death", label: "Death Overs" },
  ];
  const FC_HAND_VALUES = [{ token: "l", label: "vs LHB" }, { token: "r", label: "vs RHB" }];
  // Pace-first (owner #9): Fast · Fast-medium · Medium-fast · Medium ·
  // Slow-medium, then Spin: Off-spin · Leg-spin · Slow left-arm orthodox ·
  // Left-arm wrist-spin. Display order only — mirrors table.js's
  // BOWLING_TYPE_PREFERENCE and drawer.js's BOWLING_TYPE_ORDER.
  const FC_BSTYLE_VALUES = [
    { token: "pace", label: "Pace" }, { token: "spin", label: "Spin" },
    { token: "fast", label: "Fast" }, { token: "fastmedium", label: "Fast-medium" },
    { token: "mediumfast", label: "Medium-fast" }, { token: "medium", label: "Medium" },
    { token: "slowmedium", label: "Slow-medium" },
    { token: "offspin", label: "Off-spin" }, { token: "legspin", label: "Leg-spin" },
    { token: "slaorthodox", label: "Slow left-arm orthodox" }, { token: "lawristspin", label: "Left-arm wrist-spin" },
  ];
  // Innings ordinal labels (mirror metrics.js _fcOrdinal). Format-aware: red-ball adds 3rd/4th.
  const FC_INNINGS_LABEL = { "1": "1st inns", "2": "2nd inns", "3": "3rd inns", "4": "4th inns" };
  function fcInningsTokens(formats) {
    return (formats || []).includes("Red Ball") ? ["1", "2", "3", "4"] : ["1", "2"];
  }
  /** Label for a fielding COMPOSER kind (fielding kinds + the batting/bowling ones). */
  function composerKindLabel(kind) {
    return COMPOSER_KIND_LABEL[kind] || FC_COMPOSER_LABEL[kind] || kind;
  }
  /** The chip / row-suffix label for a user-defined over/pos range key. */
  function fcRangeChipLabel(key) {
    const p = parseComposedFieldingKey(key);
    if (!p) return key;
    const [lo, hi] = p.value.split("_");
    if (p.dim === "over") return hi ? `Overs ${lo}–${hi}` : `Over ${lo}`;
    return hi ? `Pos ${lo}–${hi}` : `Pos ${lo}`;
  }
  /** Remap a range composer's ticked keys to a new base tally (the stat <select>
   * change) — composerValueRows can't (ranges are user-defined), so swap the tally
   * on each key structurally, preserving the dimension range. */
  function fcRemapRangeTicks(newTally, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedFieldingKey(k);
      if (p) next.add(makeComposedFieldingKey(newTally, p.dim, p.value, false));
    }
    return next;
  }
  /** Remap the Team composer's ticked keys to a new base stat (the stat <select>
   * change) — the search picker holds TEAM NAMES, so swap the base key on each ticked
   * key structurally (team name preserved), analogous to fcRemapRangeTicks. */
  function teamRemapTicks(newBaseKey, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedTeamKey(k);
      if (p) next.add(makeComposedTeamKey(p.teamName, newBaseKey));
    }
    return next;
  }
  /** Remap the Opposition composer's ticked keys to a new base stat — the opponent-
   * side mirror of teamRemapTicks immediately above. */
  function oppRemapTicks(newBaseKey, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedOppositionKey(k);
      if (p) next.add(makeComposedOppositionKey(p.oppName, newBaseKey));
    }
    return next;
  }
  /** Remap the Stage composer's ticked keys to a new base stat — the CANONICAL-stage-
   * name mirror of teamRemapTicks/oppRemapTicks above (stage name preserved). */
  function stageRemapTicks(newBaseKey, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedStageKey(k);
      if (p) next.add(makeComposedStageKey(p.stageName, newBaseKey));
    }
    return next;
  }
  /** Remap the Event composer's ticked keys to a new base stat — the canonical-event-
   * name mirror of stageRemapTicks above (event name preserved). */
  function eventRemapTicks(newBaseKey, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedEventKey(k);
      if (p) next.add(makeComposedEventKey(p.eventName, newBaseKey));
    }
    return next;
  }
  /** Remap the Venue composer's ticked keys to a new base stat — the raw-venue-name
   * mirror of stageRemapTicks above (venue name preserved). */
  function venueRemapTicks(newBaseKey, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedVenueKey(k);
      if (p) next.add(makeComposedVenueKey(p.venueName, newBaseKey));
    }
    return next;
  }
  /** Remap the City composer's ticked keys to a new base stat (raw city name kept). */
  function cityRemapTicks(newBaseKey, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedCityKey(k);
      if (p) next.add(makeComposedCityKey(p.cityName, newBaseKey));
    }
    return next;
  }
  /** Remap the Season composer's ticked keys to a new base stat (raw season kept). */
  function seasonRemapTicks(newBaseKey, ticks) {
    const next = new Set();
    for (const k of ticks) {
      const p = parseComposedSeasonKey(k);
      if (p) next.add(makeComposedSeasonKey(p.seasonName, newBaseKey));
    }
    return next;
  }

  // A monotonic id for a PENDING (empty, no-column-yet) parametric composer row —
  // the owner's "starts empty" ruling: adding Innings Score Range / Wicket Haul
  // opens a blank op+value editor that mints a real column only once a valid value
  // is entered. A pending row has no slot, so it needs its own transient id.
  let pendingParamSeq = 0;
  const nextPendingId = () => `pending-${++pendingParamSeq}`;

  function slotsForNs() {
    return getSlots ? getSlots() : [];
  }

  /** The dimension/category composer KIND a column key belongs to, or null (plain,
   * cross, parametric, or boundary_runs — which stays a plain column despite its
   * dual composer home). Parametric keys are handled separately (isParamComposerKey). */
  function composerKindForKey(key) {
    if (parseComposedPhaseKey(key)) return "phase";
    if (parseComposedBallKey(key)) return "ball";
    if (parseComposedInningsKey(key)) return "innings";
    if (parseComposedPositionKey(key)) return "battingposition";
    // Team/Opposition composed keys deliberately return null here (ADD-only — no edit
    // pencil, mirroring the Team composer's own ruling; see teamComposeBodyHTML).
    if (parseComposedRunSourceKey(key)) return "runsource";
    if (parseComposedRunSourceConcededKey(key)) return "runsourceconc";
    if (parseComposedWicketTypeKey(key)) return "wickettype";
    const fc = parseComposedFieldingKey(key);
    if (fc) return FC_DIM_KIND[fc.dim] || null;
    return null;
  }

  // ── Compose-editor model (owner ruling R4-A, 2026-08-10) ─────────────────────
  // A composer is a TRANSIENT editor (not a persistent row): a SINGLE stat/axis
  // selection + dimension tick-boxes. For Phase/Ball/Innings the selection is ONE
  // base metric (Strike Rate, Average, …); for Runs by Source / Wicket Type it is
  // the count-or-% AXIS. On confirm it spawns one STANDALONE chosen-column row per
  // ticked dimension (each = selection × that value), then closes — no persistent
  // composer row survives. A composer-made row is re-edited in place (single-select).

  /** The row selection (base metric key, or count/% axis) a composed slot key
   * belongs to — the value we group slots by into rows. null for a non-composed key. */
  function composerSelForKey(kind, key) {
    if (kind === "phase") { const p = parseComposedPhaseKey(key); return p ? p.baseKey : null; }
    if (kind === "ball") { const p = parseComposedBallKey(key); return p ? p.baseKey : null; }
    if (kind === "innings") { const p = parseComposedInningsKey(key); return p ? p.baseKey : null; }
    if (kind === "battingposition") { const p = parseComposedPositionKey(key); return p ? p.baseKey : null; }
    if (kind === "runsource") { const p = parseComposedRunSourceKey(key); return p ? p.axis : null; }
    if (kind === "runsourceconc") { const p = parseComposedRunSourceConcededKey(key); return p ? p.axis : null; }
    if (kind === "wickettype") { const p = parseComposedWicketTypeKey(key); return p ? p.axis : null; }
    // FC-2: a fielding composer row groups by its base TALLY (the compose editor's stat).
    if (FC_KIND_DIM[kind]) { const p = parseComposedFieldingKey(key); return p ? p.tally : null; }
    return null;
  }

  /** The <select> options for a composer row's single selection: the metric pool
   * (Phase/Ball/Innings) or the count/% axis (Runs by Source / Wicket Type), as
   * [{ value, label }]. "" pool ⇒ the composer is not offered for this ns/format. */
  function composerSelectOptions(kind, ns, formats) {
    if (kind === "phase") return composedPhasePool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "ball") return composedBallPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "innings") return composedInningsPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "battingposition") return composedPositionPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "team") return composedTeamPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "opposition") return composedOppositionPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "stage") return composedStagePool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "event") return composedEventPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "venue") return composedVenuePool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "city") return composedCityPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "season") return composedSeasonPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "runsource") return ns === "batting" ? [{ value: "runs", label: "Count" }, { value: "pct", label: "%" }] : [];
    if (kind === "runsourceconc") return ns === "bowling" ? [{ value: "runs", label: "Count" }, { value: "pct", label: "%" }] : [];
    if (kind === "wickettype") return (ns === "batting" || ns === "bowling") ? [{ value: "count", label: "Count" }, { value: "pct", label: "%" }] : [];
    // FC-2: every fielding composer's stat <select> is the 5 base tallies.
    if (FC_KIND_DIM[kind]) return FC_TALLY_OPTIONS.slice();
    return [];
  }

  /** The dimension/category tick-box rows for a composer row's selection `sel`:
   * [{ label, key, rare }]. `key` is the composed (or, for Boundaries, catalogued)
   * column key ticking that value produces. rare = the batting-Dismissals rare split. */
  function composerValueRows(kind, ns, formats, sel) {
    if (kind === "phase") {
      return composedPhaseTokensForFormats(formats).map((ph) => ({ label: COMPOSED_PHASE_LABEL[ph], key: makeComposedPhaseKey(ph, sel), rare: false }));
    }
    if (kind === "ball") {
      return composedBallTokens().map((tok) => ({ label: COMPOSED_BALL_LABEL[tok], key: makeComposedBallKey(tok, sel), rare: false }));
    }
    if (kind === "innings") {
      return composedInningsTokensForFormats(formats).map((tok) => ({ label: COMPOSED_INNINGS_LABEL[tok], key: makeComposedInningsKey(tok, sel), rare: false }));
    }
    if (kind === "battingposition") {
      return composedPositionTokens().map((tok) => ({ label: COMPOSED_POSITION_LABEL[tok], key: makeComposedPositionKey(tok, sel), rare: false }));
    }
    if (kind === "runsource") {
      if (ns !== "batting") return [];
      // sel = "runs" (count) | "pct". Each source's key is its count OR % variant;
      // "Boundaries" reuses the catalogued boundary_runs / boundary_runs_pct pair.
      return composedRunSourceRows().map((r) => ({ label: r.rowLabel, key: sel === "pct" ? r.pctKey : r.countKey, rare: false }));
    }
    if (kind === "runsourceconc") {
      if (ns !== "bowling") return [];
      // Wave C #24: the bowling mirror. sel = "runs" (count) | "pct". Each of the 5
      // sources (4s / 6s / Non-Boundary / Wides / No-balls) is its count OR % variant.
      return composedRunSourceConcededRows().map((r) => ({ label: r.rowLabel, key: sel === "pct" ? r.pctKey : r.countKey, rare: false }));
    }
    if (kind === "wickettype") {
      if (ns === "batting") {
        return DISMISSAL_KINDS.map((d) => ({
          label: DISMISSAL_ROW_LABEL[d.key] ?? d.label,
          key: makeComposedWicketTypeKey(d.kind.replace(/ /g, "_"), sel),
          rare: RARE_DISMISSAL_KINDS.has(d.kind),
        }));
      }
      if (ns === "bowling") {
        return BOWLING_WICKET_TYPE_ROWS.map((r) => ({ label: r.rowLabel, key: makeComposedWicketTypeKey(r.token, sel), rare: false }));
      }
      return [];
    }
    // FC-2 fielding composers. sel = the base tally token. FINITE dims render fixed
    // tick-box rows; the USER-DEFINED range dims (over/pos) carry no fixed list and
    // are handled by the compose editor's range body (return [] here).
    if (FC_KIND_DIM[kind]) {
      const dim = FC_KIND_DIM[kind];
      const mk = (token) => makeComposedFieldingKey(sel, dim, token, false);
      if (dim === "phase") return FC_PHASE_VALUES.map((v) => ({ label: v.label, key: mk(v.token), rare: false }));
      if (dim === "hand") return FC_HAND_VALUES.map((v) => ({ label: v.label, key: mk(v.token), rare: false }));
      if (dim === "bstyle") return FC_BSTYLE_VALUES.map((v) => ({ label: v.label, key: mk(v.token), rare: false }));
      if (dim === "inns") return fcInningsTokens(formats).map((t) => ({ label: FC_INNINGS_LABEL[t], key: mk(t), rare: false }));
      return [];
    }
    return [];
  }

  /** True iff a composer `kind` is offerable for the current ns/format (≥1 metric/axis
   * option AND ≥1 tick-box value for the first option) — the add-menu gate. */
  function composerAvailable(kind, ns, formats) {
    // FC-2 fielding composers: Bowler Style is gated on the fielding.bowling_group
    // column's presence (FC-1b pipeline data — hidden until it lands); the range dims
    // (over/pos) are always offerable (their editor defines values); the finite dims
    // are offerable iff they have ≥1 value row for the first tally.
    if (FC_KIND_DIM[kind]) {
      if (kind === "fc_bstyle") return getFieldingColumnPresent("bowling_group");
      if (FC_RANGE_KINDS.has(kind)) return true;
      return composerValueRows(kind, ns, formats, FC_TALLY_OPTIONS[0].value).length > 0;
    }
    // Team / Opposition / Stage composers: a DATA-DRIVEN search picker (no fixed tick-
    // box rows), so each is offerable iff the host supplied THAT kind's value loader
    // (Team/Opposition → loadTeamOptions; Stage → loadStageOptions, picked by kind via
    // SEARCH_COMPOSER_META) AND the discipline has ≥1 base stat in its pool. Only the
    // leaderboard passes the loaders → pop-up unaffected.
    if (SEARCH_COMPOSER_KINDS.has(kind)) {
      return typeof SEARCH_COMPOSER_META[kind].loader === "function" && composerSelectOptions(kind, ns, formats).length > 0;
    }
    const opts = composerSelectOptions(kind, ns, formats);
    if (!opts.length) return false;
    return composerValueRows(kind, ns, formats, opts[0].value).length > 0;
  }

  /** The default stat/axis selection for a freshly-opened ADD compose editor of
   * `kind`: the first option. null when the kind is unavailable for this ns/format. */
  function defaultComposerSel(kind, ns, formats) {
    // FC-2: a fielding composer opens on the first base tally ("catches").
    if (FC_KIND_DIM[kind]) return FC_TALLY_OPTIONS[0].value;
    const opts = composerSelectOptions(kind, ns, formats).map((o) => o.value);
    return opts.length ? opts[0] : null;
  }

  /** True iff `key` is the OWN-discipline parametric composed column for `ns`. */
  function isParamComposerKey(key, ns) {
    const p = parseComposedParamKey(key);
    if (!p) return false;
    const desc = composedParamDescriptor(ns);
    return !!desc && p.prefix === desc.prefix;
  }

  // ── Chosen rows ─────────────────────────────────────────────────────────────

  /** One chosen-column row (R4-A: every column type shares this uniform row): the
   * column's label + its count/% toggle · sort · highlight · duplicate · × (E1b controls,
   * keyed by the slot id). `editKind` = the composer kind for a composer-made column
   * (adds an edit pencil that re-opens its compose editor in place), or null/undefined
   * for a plain column (no pencil — nothing to compose). "" for a stray/unresolvable key. */
  function chosenColumnRowHTML(slot, editKind) {
    const ns = getDiscipline();
    const formats = getFormats();
    const m = resolveColumnMetric(slot.key, ns);
    if (!m) return "";
    const pair = pairForAnyKey(slot.key, ns);
    const label = metricDisplayLabel(m, formats);
    const editBtn = editKind
      ? `<button type="button" class="col-edit-btn" data-edit-slot="${slot.id}" title="Edit this column" aria-label="Edit this column">${EDIT_GLYPH}</button>`
      : "";
    return `<div class="cols-chosen-row" data-slot-id="${slot.id}">
      <span class="cols-chosen-row__label" title="${escHtml(label)}">${escHtml(label)}</span>
      ${editBtn}
      ${instanceControlsMarkup(slot, pair)}
    </div>`;
  }

  /** One parametric composer chosen row (Innings Score Range / Wicket Haul): the
   * live operator <select> + value input(s) + unit + ×. Editing any control swaps
   * THIS slot's key in place (preserving its id); × removes it. Derived directly
   * from the param slot — no separate row state. "" for a mismatched/stray key. */
  function paramRowHTML(slot) {
    const ns = getDiscipline();
    const desc = composedParamDescriptor(ns);
    const parsed = parseComposedParamKey(slot.key);
    if (!desc || !parsed || parsed.prefix !== desc.prefix) return "";
    const opKey = _PARAM_OPTOKEN_TO_KEY[parsed.opToken] || "gte";
    const isBt = parsed.opToken === "bt";
    const v1 = parsed.values[0];
    const v2 = isBt ? parsed.values[1] : desc.default;
    const opts = OPERATORS.map(
      (o) => `<option value="${o.key}"${o.key === opKey ? " selected" : ""}>${escHtml(o.label)}</option>`
    ).join("");
    return `<div class="cols-param-row" data-slot-id="${slot.id}" data-param-prefix="${desc.prefix}" data-param-min="${desc.min}">
      <span class="cols-param-row__noun">${escHtml(desc.noun)}</span>
      <select class="select cols-param__op" data-role="param-op" aria-label="${escHtml(desc.noun)} operator">${opts}</select>
      <input type="number" class="input cols-param__val" data-role="param-v1" value="${v1}" min="${desc.min}" step="${desc.step}" aria-label="${escHtml(desc.noun)} value" />
      <span class="cols-param__and" data-role="param-and"${isBt ? "" : " hidden"}>and</span>
      <input type="number" class="input cols-param__val" data-role="param-v2" value="${v2}" min="${desc.min}" step="${desc.step}" aria-label="${escHtml(desc.noun)} upper value"${isBt ? "" : " hidden"} />
      <span class="cols-param__unit">${escHtml(desc.unit)}</span>
      <button type="button" class="col-remove-btn cols-param-row__remove" data-remove-slot="${slot.id}" title="Remove this column" aria-label="Remove this column">✕</button>
    </div>`;
  }

  /** A PENDING parametric composer row (owner ruling: parametric composers START
   * FULLY EMPTY). Same op-select + value input(s) + unit + × layout as paramRowHTML,
   * but E2 tidy T2 (owner 2026-08-08): the OPERATOR is unselected too (a leading blank
   * "Choose…" option, value="", selected — no default ≥) AND the value input is BLANK
   * (placeholder = the base default). NO column exists yet — it is minted only once
   * BOTH an operator and a valid value are set (wireParamRows / tryCommit). */
  function pendingParamRowHTML(id, ns) {
    const desc = composedParamDescriptor(ns);
    if (!desc) return "";
    // No `selected` on any real operator — the blank placeholder below carries it.
    const opts = OPERATORS.map(
      (o) => `<option value="${o.key}">${escHtml(o.label)}</option>`
    ).join("");
    return `<div class="cols-param-row cols-param-row--pending" data-param-pending="${id}" data-param-prefix="${desc.prefix}" data-param-min="${desc.min}">
      <span class="cols-param-row__noun">${escHtml(desc.noun)}</span>
      <select class="select cols-param__op" data-role="param-op" aria-label="${escHtml(desc.noun)} operator"><option value="" selected>Choose…</option>${opts}</select>
      <input type="number" class="input cols-param__val" data-role="param-v1" value="" placeholder="${escHtml(String(desc.default))}" min="${desc.min}" step="${desc.step}" aria-label="${escHtml(desc.noun)} value" />
      <span class="cols-param__and" data-role="param-and" hidden>and</span>
      <input type="number" class="input cols-param__val" data-role="param-v2" value="" placeholder="${escHtml(String(desc.default))}" min="${desc.min}" step="${desc.step}" aria-label="${escHtml(desc.noun)} upper value" hidden />
      <span class="cols-param__unit">${escHtml(desc.unit)}</span>
      <button type="button" class="col-remove-btn cols-param-row__remove" data-param-pending-remove="${id}" title="Remove this row" aria-label="Remove this row">✕</button>
    </div>`;
  }

  /** One dimension/category input row for the compose editor: a checkbox (ADD mode,
   * multi-select → several columns at once) or a radio (EDIT mode, single-select →
   * exactly one column). `checked` from the editor's staged tick set; the value is the
   * composed column `key`. A distinct class/attr (cols-compose-dim / data-compose-dim)
   * so it never collides with any other picker checkbox handler. */
  function composeDimInputHTML(key, label, single, checked) {
    const input = single
      ? `<input type="radio" name="cols-compose-dim" class="cols-compose-dim" data-compose-dim="${key}" ${checked ? "checked" : ""} />`
      : `<input type="checkbox" class="cols-compose-dim" data-compose-dim="${key}" ${checked ? "checked" : ""} />`;
    return `<label class="columns-popover__item cols-comp-check-row">${input}<span>${escHtml(label)}</span></label>`;
  }

  /** The BODY of the compose editor for `kind` + stat/axis `sel`: the dimension/category
   * input rows, checked from the staged tick set `ticks` (a Set of composed keys).
   * `single` = EDIT mode (radios, pick one) vs ADD mode (checkboxes, pick many). Reuses
   * the D1-D4 composerValueRows helper → byte-identical column keys. The batting Wicket
   * Type body keeps the common + Rare-disclosure split (opened when the current selection
   * is a rare kind). Returns { html, empty }. */
  function composeEditorBody(kind, ns, formats, sel, ticks, single) {
    const rows = composerValueRows(kind, ns, formats, sel);
    if (!rows.length) return { html: "", empty: true };
    // #35 (columns-popup rework Wave B): EDIT re-picks exactly ONE dimension value, so
    // it renders a single-select <select> ("like picking a filter"), not the ADD
    // multi-tick grid. Rare batting-Dismissals kinds sit under an <optgroup> so the
    // common/rare split still reads; the selected option is the row's one staged key.
    if (single) {
      const selectedKey = [...ticks][0];
      const opt = (r) =>
        `<option value="${escHtml(r.key)}"${r.key === selectedKey ? " selected" : ""}>${escHtml(r.label)}</option>`;
      const common = rows.filter((r) => !r.rare);
      const rare = rows.filter((r) => r.rare);
      const rareHTML = rare.length ? `<optgroup label="Rare dismissals">${rare.map(opt).join("")}</optgroup>` : "";
      return {
        html: `<select class="select cols-compose-editor__dim" data-role="compose-dim-select" aria-label="Dimension value">${common
          .map(opt)
          .join("")}${rareHTML}</select>`,
        empty: false,
      };
    }
    // ADD mode: the multi-tick grid (spawns several columns at once).
    const inp = (r) => composeDimInputHTML(r.key, r.label, single, ticks.has(r.key));
    if (rows.some((r) => r.rare)) {
      const common = rows.filter((r) => !r.rare);
      const rare = rows.filter((r) => r.rare);
      const rareOpen = rare.some((r) => ticks.has(r.key));
      const rareHTML = rare.length
        ? `<details class="columns-popover__disclosure"${rareOpen ? " open" : ""}><summary><span class="columns-popover__disclosure-arrow">▸</span> Rare dismissals</summary><div class="columns-popover__list">${rare.map(inp).join("")}</div></details>`
        : "";
      return { html: `<div class="columns-popover__list">${common.map(inp).join("")}</div>${rareHTML}`, empty: false };
    }
    return { html: `<div class="columns-popover__list">${rows.map(inp).join("")}</div>`, empty: false };
  }

  /** FC-2: the compose-editor body for a USER-DEFINED range dim (Over / Dismissed
   * Position). ADD mode = a From/To input pair + an "Add" button building a removable
   * CHIP list (the chips ARE the editor's ticked keys → one column each on confirm).
   * EDIT mode = a single From/To pair pre-filled from the one edited range (no chips);
   * a change re-mints the single ticked key, Save swaps it in place. `dim` = "over" |
   * "pos" (1-based; the metric maps over → 0-based over_number, pos stays 1-based). */
  function fcRangeBodyHTML(editor, dim) {
    const single = editor.mode === "edit";
    const noun = dim === "over" ? "over" : "position";
    const fields = (from, to) =>
      `<div class="cols-fc-range__fields">
        <label class="cols-fc-range__field">From <input type="number" class="input cols-fc-range__in" data-role="fc-range-from" min="1" step="1" value="${escHtml(from)}" placeholder="1" /></label>
        <label class="cols-fc-range__field">To <input type="number" class="input cols-fc-range__in" data-role="fc-range-to" min="1" step="1" value="${escHtml(to)}" placeholder="(same)" /></label>
        ${single ? "" : `<button type="button" class="btn btn--ghost cols-fc-range__add" data-role="fc-range-add">Add ${escHtml(noun)}</button>`}
      </div>`;
    if (single) {
      const parsed = [...editor.ticks].length ? parseComposedFieldingKey([...editor.ticks][0]) : null;
      const parts = parsed ? parsed.value.split("_") : [];
      return `<div class="cols-fc-range">${fields(parts[0] || "", parts[1] || "")}</div>`;
    }
    const chips = [...editor.ticks]
      .map(
        (k) =>
          `<span class="cols-fc-chip"><span class="cols-fc-chip__label">${escHtml(fcRangeChipLabel(k))}</span><button type="button" class="cols-fc-chip__x" data-fc-chip-remove="${escHtml(k)}" title="Remove" aria-label="Remove ${escHtml(fcRangeChipLabel(k))}">✕</button></span>`
      )
      .join("");
    return `<div class="cols-fc-range">
        ${fields("", "")}
        <div class="cols-fc-chips" data-role="fc-range-chips">${chips || `<span class="cols-compose-editor__empty">No ${escHtml(noun)} ranges added yet.</span>`}</div>
      </div>`;
  }

  /** The compose-editor body SHARED by the standalone TEAM and OPPOSITION composers
   * (SEARCH_COMPOSER_KINDS): a HOST element into which wireComposeEditor mounts the
   * SAME searchable multi-select the Team/Opposition FILTERS use (mountSearchMultiSelect,
   * fed by the host's loadTeamOptions loader — the opponent list IS the team list, so
   * one loader serves both). It is a live JS widget (async option load + client-side
   * filtering), so it is MOUNTED after render rather than emitted as static HTML — the
   * host is empty here; the DOM/host markup is identical for both kinds since only one
   * editor is ever open at a time. The widget's own toggle summarises the picked
   * teams/opponents; each picked value becomes one column on Add. ADD-only (Team and
   * Opposition columns carry no edit pencil — see composerKindForKey). */
  function teamComposeBodyHTML() {
    return `<div class="cols-team-compose"><div class="cols-team-compose__host" data-role="team-picker-host"></div></div>`;
  }

  /** The TRANSIENT compose editor (owner ruling R4-A, "compose then add"): a temporary
   * card holding the stat/axis <select> + dimension inputs + Add/Save + Cancel. It is NOT
   * a persistent column row — on confirm it spawns one standalone chosen-column row per
   * ticked dimension (ADD) or swaps the edited row's key in place (EDIT), then closes.
   * `editor` = inlineState.editor = { mode, kind, sel, ticks:Set<composedKey>, slotId }. */
  function composeEditorHTML(editor, ns, formats) {
    const { kind, sel, ticks, mode } = editor;
    const single = mode === "edit";
    const label = composerKindLabel(kind);
    // #35: axis-only composers (Runs by Source / Wicket Type) show NO stat/axis select —
    // count/% is the per-row toggle, not an editor choice. `sel` is still the count
    // variant (ADD) or the column's own preserved axis (EDIT); it just isn't offered.
    const options = AXIS_ONLY_COMPOSER_KINDS.has(kind) ? [] : composerSelectOptions(kind, ns, formats);
    const selectHTML = options.length
      ? `<select class="select cols-compose-editor__stat" data-role="compose-stat" aria-label="${escHtml(label)} stat">${options
          .map((o) => `<option value="${escHtml(o.value)}"${o.value === sel ? " selected" : ""}>${escHtml(o.label)}</option>`)
          .join("")}</select>`
      : "";
    // FC-2: the two USER-DEFINED range dims (Over / Dismissed Position) render a
    // "define a range" body (from/to inputs → chip list) instead of fixed tick-boxes.
    let bodyHTML;
    if (FC_RANGE_KINDS.has(kind)) {
      bodyHTML = fcRangeBodyHTML(editor, FC_KIND_DIM[kind]);
    } else if (SEARCH_COMPOSER_KINDS.has(kind)) {
      // Standalone TEAM / OPPOSITION composers: a mounted search-and-pick widget
      // (wired later), not a fixed tick-box grid.
      bodyHTML = teamComposeBodyHTML();
    } else {
      const body = composeEditorBody(kind, ns, formats, sel, ticks, single);
      bodyHTML = body.empty
        ? `<div class="cols-compose-editor__empty">No options for the current format.</div>`
        : body.html;
    }
    const confirmLabel = single ? "Save" : "Add";
    // Confirm needs ≥1 selected value — a ticked finite dimension, a defined range, or
    // (EDIT) the one radio/pre-filled range. (Finite EDIT always has exactly one.)
    const confirmDisabled = ticks.size === 0 ? " disabled" : "";
    return `<div class="cols-compose-editor" data-compose-mode="${mode}" data-compose-kind="${kind}">
      <div class="cols-compose-editor__head">
        <span class="cols-compose-editor__title">${escHtml(label)}</span>
        ${selectHTML}
      </div>
      <div class="cols-compose-editor__body">${bodyHTML}</div>
      <div class="cols-compose-editor__actions">
        <button type="button" class="cols-compose-confirm" data-role="compose-confirm"${confirmDisabled}>${confirmLabel}</button>
        <button type="button" class="cols-compose-cancel" data-role="compose-cancel">Cancel</button>
      </div>
    </div>`;
  }

  /** Remap a staged tick set from stat/axis `oldSel` to `newSel` (the compose editor's
   * stat <select> change): each ticked composed key becomes the same dimension's key
   * under the new stat/axis (values align 1:1 in composerValueRows order), so the chosen
   * dimensions carry across a stat change. Returns a NEW Set — display-only, no slots
   * touched. */
  function remapTicks(kind, ns, formats, oldSel, newSel, ticks) {
    if (oldSel === newSel) return new Set(ticks);
    const oldRows = composerValueRows(kind, ns, formats, oldSel);
    const newRows = composerValueRows(kind, ns, formats, newSel);
    const map = new Map();
    for (let i = 0; i < oldRows.length && i < newRows.length; i++) map.set(oldRows[i].key, newRows[i].key);
    const next = new Set();
    for (const k of ticks) if (map.has(k)) next.add(map.get(k));
    return next;
  }

  /** Build the CHOSEN-columns rows list (R4-A): every slot is a standalone row in slot
   * order — parametric slots render their inline op+value editor, plain AND composer-made
   * slots render the uniform chosenColumnRowHTML (composer-made carry an edit pencil).
   * The row being re-edited becomes its compose editor in place. Then any pending (empty)
   * parametric rows, then the transient ADD compose editor (if open) at the bottom. */
  function buildChosenHTML(ns, formats) {
    const slots = slotsForNs();
    const editor = inlineState && inlineState.editor;
    const rows = [];
    for (const s of slots) {
      // Edit-in-place: the composed row being re-edited becomes its compose editor.
      if (editor && editor.mode === "edit" && editor.slotId === s.id) {
        rows.push(composeEditorHTML(editor, ns, formats));
        continue;
      }
      if (isParamComposerKey(s.key, ns)) rows.push(paramRowHTML(s));
      else rows.push(chosenColumnRowHTML(s, composerKindForKey(s.key)));
    }
    for (const p of (inlineState && inlineState.pendingParams) || []) rows.push(pendingParamRowHTML(p.id, ns));
    // Compose-then-add: the transient ADD editor sits at the bottom of the list.
    if (editor && editor.mode === "add") rows.push(composeEditorHTML(editor, ns, formats));
    const body = rows.filter(Boolean).join("");
    const empty = body ? "" : `<div class="cols-chosen__empty">No columns yet — add some from the menus above.</div>`;
    return `<div class="cols-chosen" data-role="cols-chosen">${empty}${body}</div>`;
  }

  // ── Add menus (R0 Step 2: four floating searchable palettes, one per discipline) ─
  // The four discipline dropdowns (Match/Batting/Bowling/Fielding) reuse the SAME
  // floating searchable menu as the filters' "+ Add condition" (createAddPalette /
  // paletteSkeletonHTML), instead of the retired inline panels that reflowed the modal.
  // buildAddMenuHTML now emits only the four trigger skeletons (a bar); the panels are
  // portaled to <body> on open. columnsPaletteModel computes what each discipline offers
  // (byte-identical partitioning to the retired inline menu) and buildColumnsGroups turns
  // one discipline's model into the palette's group/leaf tree, each leaf's run() calling
  // the SAME slot-store add logic the old data-add-* click handlers used.

  /** The four discipline dropdowns, in bar order; the palette skeleton's data-gi is the
   * INDEX here, which buildColumnsGroups maps back to a discipline. */
  const DISCIPLINE_ORDER = ["match", "batting", "bowling", "fielding"];

  /** What each discipline dropdown OFFERS: { <discipline>: [{ name, items }] } where
   * item = { type:"plain", key, label } | { type:"composer", kind, label } |
   * { type:"param", prefix, label }. This is the EXACT partitioning the retired inline
   * menu did (same eligibleMetrics / hidden-key / ordering / cross-discipline / composer
   * rules) — it depends only on (ns, formats), NEVER on which columns are chosen, so an
   * open palette never needs rebuilding when a column is added. */
  function columnsPaletteModel(ns, formats) {
    const bucket = disciplineBucket(ns);
    const all = eligibleMetrics(ns, formats);
    const isDetailed = (m) => m.kind === "rate" || m.kind === "percent" || DETAILED_TOTAL_KEYS.has(m.key);
    const isPlainNs = ns === "batting" || ns === "bowling";
    const hiddenAlts = isPlainNs ? toggleAltKeys(ns) : new Set();

    const impact = all.filter(
      (m) => m.section === "impact" && !(isPlainNs && HIDDEN_COLUMN_KEYS.has(m.key)) && !hiddenAlts.has(m.key)
    );
    const fielding = all.filter((m) => m.section === "fielding" && !hiddenAlts.has(m.key));
    const dismissal = all.filter((m) => m.section === "dismissal");
    const matchesMetric = isPlainNs ? all.find((m) => m.key === "matches") || null : null;
    const core = all.filter(
      (m) =>
        !m.isPhaseMetric &&
        m.section !== "dismissal" &&
        m.section !== "fielding" &&
        m.section !== "impact" &&
        !(isPlainNs && m.key === "matches") &&
        !(isPlainNs && HIDDEN_COLUMN_KEYS.has(m.key)) &&
        !(isPlainNs && BALL_RANGE_ENUMERATED_KEYS.has(m.key)) &&
        !(isPlainNs && D3_ENUMERATED_HIDDEN_KEYS.has(m.key)) &&
        !(isPlainNs && D4_ENUMERATED_HIDDEN_KEYS.has(m.key)) &&
        !hiddenAlts.has(m.key)
    );
    const basicOrder = bucket === "bowling" ? BOWLING_BASIC_ORDER : BATTING_BASIC_ORDER;
    const detailedOrder = bucket === "bowling" ? BOWLING_DETAILED_ORDER : BATTING_DETAILED_ORDER;
    const coreBasic = core.filter((m) => !isDetailed(m));
    const coreDetailed = core.filter((m) => isDetailed(m));
    const ownBasic = isPlainNs ? orderByKeys(coreBasic, basicOrder) : coreBasic;
    const ownDetailed = isPlainNs ? orderByKeys(coreDetailed, detailedOrder) : coreDetailed;

    let crossBasic = [];
    let crossDetailed = [];
    if (crossDiscipline && isPlainNs) {
      const other = OTHER_DISCIPLINE[ns];
      const otherBasicOrder = other === "bowling" ? BOWLING_BASIC_ORDER : BATTING_BASIC_ORDER;
      const otherDetailedOrder = other === "bowling" ? BOWLING_DETAILED_ORDER : BATTING_DETAILED_ORDER;
      const crossSource = eligibleCrossMetrics(ns, formats).filter((m) => !HIDDEN_COLUMN_KEYS.has(m.key));
      const crossBasicSrc = orderByKeys(crossSource.filter((m) => !isDetailed(m)), otherBasicOrder);
      const crossDetailedSrc = orderByKeys(crossSource.filter((m) => isDetailed(m)), otherDetailedOrder);
      crossBasic = crossBasicSrc.map((base) => ({ ...base, key: makeCrossKey(other, base.key) }));
      crossDetailed = crossDetailedSrc.map((base) => ({ ...base, key: makeCrossKey(other, base.key) }));
    }

    const plainItems = (list) => list.map((m) => ({ type: "plain", key: m.key, label: metricDisplayLabel(m, formats) }));
    const section = (name, items) => (items.length ? [{ name, items }] : []);

    // Composers section (own discipline, plain ns only): only kinds applicable to this
    // discipline/format, plus the parametric composer.
    const composerItems = [];
    if (isPlainNs) {
      for (const kind of DIM_COMPOSER_KINDS) {
        if (composerAvailable(kind, ns, formats)) composerItems.push({ type: "composer", kind, label: COMPOSER_KIND_LABEL[kind] });
      }
      const desc = composedParamDescriptor(ns);
      if (desc) composerItems.push({ type: "param", prefix: desc.prefix, label: desc.sectionLabel });
    }

    // Wave D — D1: the player-profile attribute columns (Playing role / Detailed
    // role / Batting hand / Bowling style / Bowling hand) as a "Player Profile"
    // section in this discipline's OWN dropdown — leaderboard only (profileColumns),
    // plain ns only. profileColumnSpecs gates discipline (Batting hand batting-only).
    // They are NOT in eligibleMetrics (virtual text columns resolved by getMetric),
    // so they are listed explicitly here rather than partitioned out of `all`.
    const profileItems =
      profileColumns && isPlainNs
        ? profileColumnSpecs(ns).map((p) => ({ type: "plain", key: p.key, label: p.label }))
        : [];
    // Chunk 1B: the B. Pos. which-values column (batting-only, plain ns) is a virtual
    // list column (not in eligibleMetrics), so it is listed EXPLICITLY here like the
    // profile items. It also auto-appears with the Batting-position filter (state.js).
    // Owner 2026-08-14: place it in Basic Stats right AFTER "Innings" (mirroring the
    // Batting-position FILTER's spot after Innings Number), not at the end.
    const bposItem =
      isPlainNs && ns === "batting"
        ? [{ type: "plain", key: BATTING_POSITION_SET_KEY, label: "Batting Position" }]
        : [];
    // Wave 2A.3: the Innings-Number / Team / Opposition which-values columns (both
    // disciplines, plain ns) — same "virtual list column, listed explicitly" shape as
    // bposItem above, placed right after it (interim default placement pending owner
    // sign-off — see the Wave 2A worker report).
    const scopeSetItems = isPlainNs
      ? [
          { type: "plain", key: INNINGS_NUMBER_SET_KEY, label: "Innings Number" },
          { type: "plain", key: TEAM_SET_KEY, label: "Team" },
          { type: "plain", key: OPPOSITION_SET_KEY, label: "Opposition" },
          // City & Season everywhere (2026-08-16): the City / Season which-values columns.
          { type: "plain", key: CITY_SET_KEY, label: "City" },
          { type: "plain", key: SEASON_SET_KEY, label: "Season" },
        ]
      : [];
    const basicItems = plainItems(ownBasic);
    const bposInnIdx = basicItems.findIndex((it) => it.key === "innings");
    const basicWithBpos =
      bposInnIdx >= 0
        ? [...basicItems.slice(0, bposInnIdx + 1), ...bposItem, ...scopeSetItems, ...basicItems.slice(bposInnIdx + 1)]
        : [...basicItems, ...bposItem, ...scopeSetItems];
    const ownSections = [
      ...section("Basic Stats", basicWithBpos),
      ...section("Detailed Stats", plainItems(ownDetailed)),
      ...(isPlainNs ? [] : section("Dismissals", plainItems(dismissal))),
      ...section("Player Profile", profileItems),
      ...(composerItems.length ? [{ name: "Composers", items: composerItems }] : []),
    ];
    const crossSections = [
      ...section("Basic Stats", plainItems(crossBasic)),
      ...section("Detailed Stats", plainItems(crossDetailed)),
    ];

    // FC-2: fielding composer entries (Phase / Over Range / Innings / Dismissed
    // Position / Dismissed Hand / Bowler Style). Available on plain ns (fielding
    // metrics are registered under batting/bowling) → they enrich the Fielding
    // dropdown on the leaderboard AND drive the pop-up's Fielding mode. Bowler Style
    // self-gates on the data probe (composerAvailable). Additive to the 5 base tallies.
    const fieldingComposerItems = [];
    if (isPlainNs) {
      for (const kind of FC_COMPOSER_KINDS) {
        if (composerAvailable(kind, ns, formats)) fieldingComposerItems.push({ type: "composer", kind, label: FC_COMPOSER_LABEL[kind] });
      }
    }
    const fieldingSections = [
      ...section("Fielding Stats", plainItems(fielding)),
      ...(fieldingComposerItems.length ? [{ name: "Composers", items: fieldingComposerItems }] : []),
    ];

    // FC-2: in the pop-up's FIELDING mode the Match dropdown offers only "matches"
    // (its query builds fld_matches_cte); Impact/PoM is dropped (no pom_cte there, so
    // it would not compute). The leaderboard keeps Impact (fieldingMode false).
    //
    // Columns-popup rework Wave A (#26, owner 2026-08-12): the Match dropdown's
    // "Basic Stats" / "Impact" sub-headings were never owner-approved — flattened
    // to a SINGLE unnamed group (Player Matches, Player of the Match Count, Matches
    // Won/Lost/Tied, No Result, Toss Won). `section("", …)` still gates on non-empty
    // (unchanged behaviour), and the empty group-header this produces collapses via
    // styles.css `.palette__group-header:empty` — display/layout only, no metric
    // added/removed/reordered.
    const fieldingMode = getFieldingMode ? getFieldingMode() : false;
    const matchItems = fieldingMode
      ? plainItems(matchesMetric ? [matchesMetric] : [])
      : plainItems([...(matchesMetric ? [matchesMetric] : []), ...impact]);
    const matchSections = section("", matchItems);

    return {
      match: matchSections,
      batting: bucket === "batting" ? ownSections : crossSections,
      bowling: bucket === "bowling" ? ownSections : crossSections,
      fielding: fieldingSections,
    };
  }

  /** Build the four discipline dropdown TRIGGERS (a bar). Each is a paletteSkeleton whose
   * floating panel createAddPalette fills + wires (search + list). A discipline with no
   * offered columns renders its trigger disabled. NONE open by default (clean empty state,
   * like the filters section). */
  function buildAddMenuHTML(ns, formats) {
    const model = columnsPaletteModel(ns, formats);
    // R5: the player pop-up (ownDisciplineOnly) shows only Match + the CURRENT
    // discipline's dropdown — no cross-discipline bucket, no Fielding column-family.
    // The leaderboard leaves it off → all four. gi is still the DISCIPLINE_ORDER
    // index below, so a skipped dropdown never shifts another's buildColumnsGroups(gi).
    // FC-2: the pop-up's FIELDING mode shows only Match + Fielding (its ns maps to
    // "batting" for metrics, so disciplineBucket can't tell — the flag does).
    const fieldingMode = getFieldingMode ? getFieldingMode() : false;
    const allowedDisc = fieldingMode
      ? new Set(["match", "fielding"])
      : ownDisciplineOnly
      ? new Set(["match", disciplineBucket(ns)])
      : null;
    const skeletons = DISCIPLINE_ORDER.map((disc, gi) => {
      if (allowedDisc && !allowedDisc.has(disc)) return "";
      const label = disc.charAt(0).toUpperCase() + disc.slice(1);
      const disabled = (model[disc] || []).length === 0;
      return paletteSkeletonHTML(gi, {
        ctlClass: "addctl cols-dd-ctl",
        toggleClass: "cols-dd-trigger",
        toggleAttrs: disabled ? " disabled" : "",
        toggleAriaLabel: `Add a ${label} column`,
        toggleInner: `<span class="cols-dd-name">${escHtml(label)}</span><span class="cols-dd-caret" aria-hidden="true">▾</span>`,
        searchPlaceholder: "Search columns&hellip;",
        searchAriaLabel: "Search columns",
        emptyText: "No matching column.",
      });
    }).join("");
    return `<div class="cols-dropdowns cols-add"><div class="cols-add__label">Add columns</div><div class="cols-dd-bar">${skeletons}</div></div>`;
  }

  /** The palette group/leaf tree for ONE discipline dropdown (gi = its index in
   * DISCIPLINE_ORDER). Each leaf's run() does the SAME store mutation the retired inline
   * data-add-* handlers did (add a plain slot / materialise a composer row / materialise a
   * pending parametric row), then rerenders. */
  function buildColumnsGroups(gi) {
    const ns = getDiscipline();
    const formats = getFormats();
    const model = columnsPaletteModel(ns, formats);
    const sections = model[DISCIPLINE_ORDER[gi]] || [];
    return sections.map((sec) => ({
      name: sec.name,
      items: sec.items.map((it) => ({
        kind: "leaf",
        label: it.label,
        run:
          it.type === "plain"
            ? () => addPlainColumn(it.key)
            : it.type === "composer"
            ? () => openComposeEditor(it.kind)
            : () => addParamRow(),
      })),
    }));
  }

  // ── Add actions (the palette leaves' run() closures) — byte-identical store mutations
  //    to the retired inline data-add-* handlers. ──────────────────────────────────────
  /** Append a plain column slot (a fresh copy; duplicates allowed — owner's re-pick). */
  function addPlainColumn(key) {
    applySlots([...(getSlots() || []), makeSlot(key)]);
    rerenderInline();
  }
  /** Open the TRANSIENT compose editor for `kind` (owner ruling R4-A "compose then
   * add"): an ADD-mode editor pre-set to the first stat/axis with NO dimensions ticked.
   * Replaces any editor already open (one at a time). The columns are minted only on
   * confirm (compose-confirm), one standalone row per ticked dimension. */
  function openComposeEditor(kind) {
    if (!inlineState) return;
    const sel = defaultComposerSel(kind, getDiscipline(), getFormats());
    if (sel == null) return;
    inlineState.editor = { mode: "add", kind, sel, ticks: new Set(), slotId: null };
    rerenderInline();
  }
  /** Materialise a BLANK pending parametric row (owner ruling: parametric composers start
   * empty; the column is minted only once a valid operator + value is entered). */
  function addParamRow() {
    if (!inlineState) return;
    inlineState.pendingParams.push({ id: nextPendingId() });
    rerenderInline();
  }

  /** The whole leaderboard Columns section: add menus + chosen rows.
   * Columns-popup rework Wave A (#17, owner 2026-08-12): the four discipline
   * dropdowns now render ABOVE the chosen-columns list (previously below) —
   * layout/order only, `wireChosen`/`mountColumnPalettes`/`rerenderInline` all
   * locate their targets via querySelector (data-role attrs), not DOM position,
   * so this reorder is a no-op for wiring. */
  function buildInlineHTML(ns, formats) {
    return `<div class="cols-picker">${buildAddMenuHTML(ns, formats)}${buildChosenHTML(ns, formats)}</div>`;
  }

  // ── Compose editor + edit-pencil wiring (in the CHOSEN-rows region) ──────────
  // (The ADD entry points for plain columns / composers / params live in the four
  // floating discipline palettes — see buildColumnsGroups + addPlainColumn /
  // openComposeEditor / addParamRow above.) This wires the TRANSIENT compose editor
  // (R4-A) plus the per-row edit pencil on composer-made standalone rows.
  function wireComposeEditor(rootEl) {
    const editor = inlineState && inlineState.editor;

    // TEAM/OPPOSITION composer teardown: wireComposeEditor runs on EVERY (re)render,
    // and the previous render's search widget (if any) has just had its DOM replaced —
    // but its document-level listeners (outside-click, portal scroll/resize) linger
    // until destroy() runs. Tear it down here first; it is re-mounted below iff a
    // Team/Opposition ADD editor is (still) open. onChange never re-renders, so the
    // live widget survives ticking; only a stat change / confirm / cancel re-renders
    // (and re-mounts/closes). One shared field: only one editor is ever open at once.
    if (inlineState && inlineState.searchPickerHandle) {
      inlineState.searchPickerHandle.destroy();
      inlineState.searchPickerHandle = null;
    }

    // Edit pencil on a composer-made standalone row → open an EDIT-mode compose editor
    // pre-filled with that column's stat/axis + its single dimension (radio, single-
    // select — a re-edit is ONE column, never adds/removes siblings). Wired regardless
    // of whether an editor is currently open (this is how one gets opened).
    rootEl.querySelectorAll(".col-edit-btn[data-edit-slot]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!inlineState) return;
        const id = btn.dataset.editSlot;
        const slot = (getSlots() || []).find((s) => s.id === id);
        if (!slot) return;
        const kind = composerKindForKey(slot.key);
        if (!kind) return;
        const sel = composerSelForKey(kind, slot.key);
        inlineState.editor = { mode: "edit", kind, sel, ticks: new Set([slot.key]), slotId: id };
        rerenderInline();
      });
    });

    if (!editor) return;

    // Stat/axis <select>: change the editor's selection, remapping the staged ticks onto
    // the new stat/axis (the chosen dimensions carry over). Full re-render (rebuilds the
    // input rows for the new stat).
    const statEl = rootEl.querySelector('[data-role="compose-stat"]');
    if (statEl)
      statEl.addEventListener("change", () => {
        const ns = getDiscipline();
        const formats = getFormats();
        // FC-2 range dims (over/pos): composerValueRows can't remap user-defined ranges,
        // so swap the base tally on each ticked key structurally (range preserved).
        // Team/Opposition/Stage: the search picker holds team / opponent / canonical-
        // stage NAMES → swap the base stat on each key structurally, same idea.
        editor.ticks = FC_RANGE_KINDS.has(editor.kind)
          ? fcRemapRangeTicks(statEl.value, editor.ticks)
          : editor.kind === "team"
          ? teamRemapTicks(statEl.value, editor.ticks)
          : editor.kind === "opposition"
          ? oppRemapTicks(statEl.value, editor.ticks)
          : editor.kind === "stage"
          ? stageRemapTicks(statEl.value, editor.ticks)
          : editor.kind === "event"
          ? eventRemapTicks(statEl.value, editor.ticks)
          : editor.kind === "venue"
          ? venueRemapTicks(statEl.value, editor.ticks)
          : editor.kind === "city"
          ? cityRemapTicks(statEl.value, editor.ticks)
          : editor.kind === "season"
          ? seasonRemapTicks(statEl.value, editor.ticks)
          : remapTicks(editor.kind, ns, formats, editor.sel, statEl.value, editor.ticks);
        editor.sel = statEl.value;
        rerenderInline();
      });

    // FC-2: USER-DEFINED range dims (Over / Dismissed Position) — the "define a range"
    // controls. ADD: the "Add" button mints an fc__ key from From/To and stages it (a
    // chip); a chip's × unstages it. EDIT: From/To directly re-mint the single staged
    // key (no chips). Every mint validates From ≥ 1 (To blank ⇒ single value); the
    // metric's own _fcParseRange normalises lo ≤ hi, so To < From is accepted + swapped.
    if (FC_RANGE_KINDS.has(editor.kind)) {
      const dim = FC_KIND_DIM[editor.kind];
      const fromEl = rootEl.querySelector('[data-role="fc-range-from"]');
      const toEl = rootEl.querySelector('[data-role="fc-range-to"]');
      const mintKey = () => {
        const from = parseInt(fromEl && fromEl.value, 10);
        if (!Number.isInteger(from) || from < 1) return null;
        const hasTo = toEl && toEl.value !== "" && toEl.value != null;
        const to = hasTo ? parseInt(toEl.value, 10) : null;
        if (hasTo && (!Number.isInteger(to) || to < 1)) return null;
        const token = to != null ? `${from}_${to}` : `${from}`;
        return makeComposedFieldingKey(editor.sel, dim, token, false);
      };
      if (editor.mode === "add") {
        const addBtn = rootEl.querySelector('[data-role="fc-range-add"]');
        if (addBtn)
          addBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const key = mintKey();
            if (!key) return;
            editor.ticks.add(key);
            rerenderInline();
          });
        rootEl.querySelectorAll("[data-fc-chip-remove]").forEach((btn) => {
          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            editor.ticks.delete(btn.dataset.fcChipRemove);
            rerenderInline();
          });
        });
      } else {
        const sync = () => {
          const key = mintKey();
          editor.ticks = key ? new Set([key]) : new Set();
          const confirmBtn = rootEl.querySelector('[data-role="compose-confirm"]');
          if (confirmBtn) confirmBtn.disabled = editor.ticks.size === 0;
        };
        if (fromEl) fromEl.addEventListener("input", sync);
        if (toEl) toEl.addEventListener("input", sync);
      }
    }

    // Standalone TEAM / OPPOSITION / STAGE composers: mount the SAME searchable multi-
    // select the Team/Stage FILTERS use into the editor body, INDEPENDENT of any filter
    // state (the picks live on the editor, not on state.teams/opposition/stage). The
    // widget holds team / opponent / CANONICAL-stage NAMES; every per-kind bit — the
    // value loader (loadTeamOptions for team/opposition, loadStageOptions for stage),
    // the key make/parse pair, the display noun/placeholders — is read from
    // SEARCH_COMPOSER_META, so this block is kind-agnostic (its onChange re-derives the
    // staged composed keys under the current base stat via the kind's OWN make pair).
    // Options load async via the kind's loader (gender/format/date-scoped, no sibling
    // cascade); the widget filters that list client-side. ADD-only. onChange does NOT
    // re-render (so the open panel + search text survive ticking) — it just updates
    // ticks + the Add button.
    const searchMeta = SEARCH_COMPOSER_META[editor.kind];
    if (SEARCH_COMPOSER_KINDS.has(editor.kind) && editor.mode === "add" && searchMeta && typeof searchMeta.loader === "function" && inlineState) {
      const { parse: parseFn, make: makeFn, nameOf, noun, placeholder, filterPlaceholder, ariaLabel, loader } = searchMeta;
      const host = rootEl.querySelector('[data-role="team-picker-host"]');
      if (host) {
        // Seed the widget from the currently-staged keys (survives a stat-change
        // re-mount): each staged key → its team / opponent / stage name.
        const seedNames = [...editor.ticks]
          .map((k) => { const p = parseFn(k); return p ? nameOf(p) : null; })
          .filter(Boolean);
        let handle;
        const summarize = (count) => {
          const vals = handle ? handle.getValues() : [];
          // A single pick reads out as its own name. For every search composer the value
          // IS its display name (team / opponent / canonical-stage / event / venue name)
          // EXCEPT the Stage composer's "No Stage" sentinel, whose value is the internal
          // STAGE_NONE token — map it to STAGE_NONE_LABEL so the collapsed picker never
          // surfaces the raw "(no stage)" string.
          if (vals.length === 1) return vals[0] === STAGE_NONE ? STAGE_NONE_LABEL : vals[0];
          return `${count} ${count === 1 ? noun : noun + "s"}`;
        };
        handle = mountSearchMultiSelect(host, {
          options: [],
          values: seedNames,
          portal: true,
          placeholder,
          filterPlaceholder,
          ariaLabel,
          summarize,
          // A pick outlives a narrowed list (the composer never rewrites a pick), same
          // as the Team FILTER — keep it visible + pinned rather than silently dropped.
          keepMissingSelected: true,
          pinSelected: true,
          renderRow: (o) =>
            `<span class="search-select__check" aria-hidden="true"></span><span class="search-select__opt-label">${escHtml(o.label)}</span>`,
          onChange: (values) => {
            editor.ticks = new Set(values.map((v) => makeFn(v, editor.sel)));
            const confirmBtn = rootEl.querySelector('[data-role="compose-confirm"]');
            if (confirmBtn) confirmBtn.disabled = editor.ticks.size === 0;
          },
        });
        inlineState.searchPickerHandle = handle;
        // Async option load. Guard against a superseded editor: only apply if THIS
        // handle is still the mounted one (a stat change / close swaps it out).
        Promise.resolve()
          .then(() => loader())
          .then((rows) => {
            if (inlineState && inlineState.searchPickerHandle === handle) handle.setOptions(rows || []);
          })
          .catch(() => {});
      }
    }

    // Dimension inputs. ADD (checkbox): toggle the key in the staged set + keep the Add
    // button enabled iff ≥1 ticked — no re-render (native check state + a cheap disabled
    // flip, so focus/scroll hold). EDIT (radio): the staged set becomes exactly that key.
    rootEl.querySelectorAll(".cols-compose-dim[data-compose-dim]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const key = inp.dataset.composeDim;
        if (editor.mode === "edit") {
          editor.ticks = new Set([key]);
          return;
        }
        if (inp.checked) editor.ticks.add(key);
        else editor.ticks.delete(key);
        const confirmBtn = rootEl.querySelector('[data-role="compose-confirm"]');
        if (confirmBtn) confirmBtn.disabled = editor.ticks.size === 0;
      });
    });

    // #35: EDIT-mode dimension <select> — change the single staged key. Save (confirm)
    // stays enabled since a re-edit always has exactly one value selected. No re-render:
    // the <select> already shows its own new value, and the key is applied on Save.
    const dimSelectEl = rootEl.querySelector('[data-role="compose-dim-select"]');
    if (dimSelectEl)
      dimSelectEl.addEventListener("change", () => {
        editor.ticks = new Set([dimSelectEl.value]);
      });

    // Confirm: ADD spawns one standalone slot per ticked dimension (in composerValueRows
    // order); EDIT swaps the edited slot's key in place (id preserved → its sort/highlight/
    // copies follow). Then close the editor. Display-only — the query dedups keys, so the
    // same composed keys land as the same slots → byte-identical buildQuery output.
    const confirmEl = rootEl.querySelector('[data-role="compose-confirm"]');
    if (confirmEl)
      confirmEl.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ns = getDiscipline();
        const formats = getFormats();
        if (editor.mode === "edit") {
          const key = [...editor.ticks][0];
          if (key) {
            const slots = (getSlots() || []).slice();
            const i = slots.findIndex((s) => s.id === editor.slotId);
            if (i >= 0 && slots[i].key !== key) {
              slots[i] = { ...slots[i], key };
              applySlots(slots);
            }
          }
        } else {
          // FC-2 range dims AND the Team/Opposition/Stage composers: the staged ticks
          // ARE the composed keys (no fixed value list to filter against — user-defined
          // ranges / a data-driven team/stage search); every other composer filters
          // composerValueRows.
          const keys = FC_RANGE_KINDS.has(editor.kind) || SEARCH_COMPOSER_KINDS.has(editor.kind)
            ? [...editor.ticks]
            : composerValueRows(editor.kind, ns, formats, editor.sel)
                .map((r) => r.key)
                .filter((k) => editor.ticks.has(k));
          if (keys.length) {
            // TEAM / OPPOSITION / STAGE composers: record the minted keys so a chosen
            // column survives the Search-prune (its value space is data-driven, so it
            // can't be enumerated into eligibleColumnKeys ahead of time — see
            // metrics.registerComposed*Keys). Registry picked BY KIND via
            // SEARCH_COMPOSER_META.register (Team/Opposition/Stage each keep their own).
            if (SEARCH_COMPOSER_META[editor.kind]) SEARCH_COMPOSER_META[editor.kind].register(keys);
            applySlots([...(getSlots() || []), ...keys.map((k) => makeSlot(k))]);
          }
        }
        inlineState.editor = null;
        rerenderInline();
      });

    // Cancel: discard the editor (EDIT leaves the original row untouched).
    const cancelEl = rootEl.querySelector('[data-role="compose-cancel"]');
    if (cancelEl)
      cancelEl.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        inlineState.editor = null;
        rerenderInline();
      });
  }

  function wireParamRows(rootEl) {
    // Pending (empty) parametric rows: mint the real column only when a valid value
    // is entered (owner ruling: start empty, no default column on add). × drops the
    // pending row.
    rootEl.querySelectorAll(".cols-param-row[data-param-pending]").forEach((row) => {
      const id = row.dataset.paramPending;
      const prefix = row.dataset.paramPrefix;
      const min = Number(row.dataset.paramMin) || 0;
      const opEl = row.querySelector('[data-role="param-op"]');
      const v1El = row.querySelector('[data-role="param-v1"]');
      const v2El = row.querySelector('[data-role="param-v2"]');
      const andEl = row.querySelector('[data-role="param-and"]');
      const tryCommit = () => {
        // T2: the pending row starts with NO operator (blank "" option). An unset
        // operator maps to no token → no column yet, exactly like an unset value.
        const opToken = COMPOSED_PARAM_OP_TOKEN[opEl ? opEl.value : ""];
        if (!opToken) return; // operator unset → no column yet
        const raw1 = v1El ? v1El.value : "";
        if (raw1 === "" || raw1 == null) return; // value unset → no column yet
        const v1 = Math.max(min, Math.trunc(Number(raw1)));
        if (!Number.isFinite(v1)) return;
        let values;
        if (opToken === "bt") {
          const raw2 = v2El ? v2El.value : "";
          if (raw2 === "" || raw2 == null) return; // second value unset → no column yet
          const v2 = Math.max(min, Math.trunc(Number(raw2)));
          if (!Number.isFinite(v2)) return;
          values = [v1, v2];
        } else {
          values = [v1];
        }
        const key = makeComposedParamKey(prefix, opToken, values);
        applySlots([...(getSlots() || []), makeSlot(key)]);
        if (inlineState) inlineState.pendingParams = inlineState.pendingParams.filter((p) => p.id !== id);
        rerenderInline();
      };
      if (opEl)
        opEl.addEventListener("change", () => {
          const between = opEl.value === "between";
          if (v2El) v2El.hidden = !between;
          if (andEl) andEl.hidden = !between;
          tryCommit();
        });
      if (v1El) v1El.addEventListener("change", tryCommit);
      if (v2El) v2El.addEventListener("change", tryCommit);
    });
    rootEl.querySelectorAll("[data-param-pending-remove]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.dataset.paramPendingRemove;
        if (inlineState) inlineState.pendingParams = inlineState.pendingParams.filter((p) => p.id !== id);
        rerenderInline();
      });
    });
    // Live (already-added) parametric rows: editing op/value swaps THIS slot's key.
    rootEl.querySelectorAll(".cols-param-row[data-slot-id]").forEach((row) => {
      const id = row.dataset.slotId;
      const prefix = row.dataset.paramPrefix;
      const min = Number(row.dataset.paramMin) || 0;
      const opEl = row.querySelector('[data-role="param-op"]');
      const v1El = row.querySelector('[data-role="param-v1"]');
      const v2El = row.querySelector('[data-role="param-v2"]');
      const andEl = row.querySelector('[data-role="param-and"]');
      const apply = () => {
        const opToken = COMPOSED_PARAM_OP_TOKEN[opEl ? opEl.value : "gte"];
        if (!opToken) return;
        const v1 = Math.max(min, Math.trunc(Number(v1El && v1El.value)));
        if (!Number.isFinite(v1)) return;
        let values;
        if (opToken === "bt") {
          const v2 = Math.max(min, Math.trunc(Number(v2El && v2El.value)));
          if (!Number.isFinite(v2)) return;
          values = [v1, v2];
        } else {
          values = [v1];
        }
        const key = makeComposedParamKey(prefix, opToken, values);
        const slots = (getSlots() || []).slice();
        const i = slots.findIndex((s) => s.id === id);
        if (i < 0) return;
        if (slots[i].key === key) return;
        slots[i] = { ...slots[i], key };
        applySlots(slots);
        rerenderInline();
      };
      if (opEl)
        opEl.addEventListener("change", () => {
          const between = opEl.value === "between";
          if (v2El) v2El.hidden = !between;
          if (andEl) andEl.hidden = !between;
          apply();
        });
      if (v1El) v1El.addEventListener("change", apply);
      if (v2El) v2El.addEventListener("change", apply);
    });
  }

  /** A structural signature of the inline render — the effective ns, formats, the
   * ordered slot ids+keys, the open compose editor (mode/kind/stat/edited-row), and any
   * pending empty parametric rows. A change means the chosen list / menus must be REBUILT
   * (an external column change, e.g. a preset); an unchanged signature lets the sync path
   * do only a cheap sort/highlight re-sync. */
  function inlineSignature(ns, formats) {
    const ed = inlineState && inlineState.editor;
    return JSON.stringify({
      ns,
      formats,
      slots: slotsForNs().map((s) => `${s.id}:${s.key}`),
      // The transient compose editor's identity (open / for-what / which row) — NOT its
      // staged ticks: ticks toggle WITHOUT re-rendering, so they must not force a rebuild.
      editor: ed ? `${ed.mode}:${ed.kind}:${ed.sel}:${ed.slotId || ""}` : null,
      pending: ((inlineState && inlineState.pendingParams) || []).map((p) => p.id),
    });
  }

  /** The inline (leaderboard) sync path — the filter-style counterpart to
   * syncCheckedState. Rebuilds on a structural change (external column edit);
   * otherwise just re-syncs the per-copy Sort-by/Highlight indicators. */
  function syncInline(rootEl) {
    const ns = getDiscipline();
    const formats = getFormats();
    const sig = inlineSignature(ns, formats);
    if (!inlineState || inlineState.sig !== sig) {
      rerenderInline();
      return;
    }
    syncInstanceControls(rootEl);
  }

  /** Wire the CHOSEN-rows region controls (per-slot count/% · sort · highlight ·
   * duplicate · edit · × via the E1b data-*-slot markup; the transient compose editor;
   * param op/value/×). Shared by the full render and the chosen-only re-render. */
  function wireChosen(container) {
    wireMultiInstance(container);
    wireComposeEditor(container);
    wireParamRows(container);
  }

  /** Build + mount the four floating discipline palettes into `container` (one shared
   * createAddPalette instance → one-open-at-a-time + keepOpenOnPick). Stored on
   * inlineState so a subsequent FULL render can close an open palette before wiping. */
  function mountColumnPalettes(container) {
    const api = createAddPalette({ buildGroups: buildColumnsGroups, keepOpenOnPick: true });
    container.querySelectorAll('[data-role="add-palette"]').forEach((el) => api.mountAddPalette(el));
    if (inlineState) inlineState.paletteApi = api;
  }

  /** FULL render of the leaderboard's inline picker (chosen rows + the four discipline
   * palette triggers) into its host, then wire everything + mount the palettes. Called
   * on mount and on a discipline/format change (which swaps the whole metric vocabulary).
   * Inline-only: the pop-up popover renders via open() → buildPickerHTML, untouched. */
  function renderInline(container, ns, formats) {
    // Close any open floating column palette before wiping (a portaled-open panel would
    // orphan on <body>) — mirrors drawer.js's palette.closeCurrent() before a rebuild.
    if (inlineState && inlineState.paletteApi) inlineState.paletteApi.closeCurrent();
    container.innerHTML = buildInlineHTML(ns, formats);
    wireChosen(container);
    mountColumnPalettes(container);
    if (inlineState) inlineState.sig = inlineSignature(ns, formats);
  }

  /** Re-render ONLY the chosen-rows region (add / remove / duplicate / mode-swap /
   * composer / param edits), leaving the four discipline palettes MOUNTED — so a menu
   * that is open (owner ruling D2: stays open while adding several columns) survives the
   * pick, search text and all. The add menu is a pure function of (ns, formats), never of
   * the chosen columns, so it never needs rebuilding here; a discipline/format change goes
   * through the FULL renderInline path (refresh) instead. Falls back to a full render if
   * the chosen host is somehow missing. */
  function rerenderInline() {
    if (!inlineState) return;
    const container = inlineState.el;
    const ns = getDiscipline();
    const formats = getFormats();
    const chosenHost = container.querySelector('[data-role="cols-chosen"]');
    if (!chosenHost) {
      renderInline(container, ns, formats);
      return;
    }
    const tmp = document.createElement("div");
    tmp.innerHTML = buildChosenHTML(ns, formats);
    const fresh = tmp.firstElementChild;
    chosenHost.replaceWith(fresh);
    wireChosen(container);
    inlineState.sig = inlineSignature(ns, formats);
    // keepOpenOnPick: the dropdown bar now sits ABOVE the chosen list (#17), so
    // adding a column no longer shifts the (still-open) discipline trigger — this
    // reposition is now a defensive no-op, kept for any other layout shift (e.g.
    // window resize) while a palette is open.
    if (inlineState.paletteApi) inlineState.paletteApi.repositionCurrent();
  }

  /**
   * INLINE mount (W1): render the picker into a fixed host element (the
   * leaderboard popup's "Columns" section) and remember it so refresh() keeps it
   * honest. Idempotent — re-mounting simply re-renders. Distinct from mount(),
   * which wires a trigger button to OPEN a floating popover; a given picker
   * instance uses one mode or the other, never both. R0 Step 2: none of the four
   * discipline dropdowns opens by default (clean empty state, like the filters section).
   */
  function mountInline(container) {
    if (!container) return;
    const ns = getDiscipline();
    const formats = getFormats();
    // `editor` = the single open TRANSIENT compose editor (R4-A "compose then add"), or
    // null: { mode:"add"|"edit", kind, sel, ticks:Set<composedKey>, slotId }. ADD stages
    // ticks and mints one standalone column row per tick on confirm; EDIT swaps one
    // existing composer-made row's key in place. `pendingParams` = added-but-unset
    // parametric rows ({ id }; owner ruling: parametric composers start empty). Both
    // reset on a discipline / format vocabulary change (refresh). `sig` caches the last
    // render's structural signature for the sync fast-path. `paletteApi` holds the
    // mounted discipline-palette component so a full re-render can close an open menu.
    inlineState = { el: container, ns, formats: formats.slice(), editor: null, pendingParams: [], sig: null, paletteApi: null };
    renderInline(container, ns, formats);
    // FC-2: kick the Bowler Style data probe (idempotent, cached per session). It is
    // ABSENT on R2 today → stays hidden with no re-render; once the FC-1b pipeline
    // re-run lands the fielding.bowling_group column, the probe resolves TRUE and we
    // rebuild the menu so the Bowler Style entry auto-appears (only then — the common
    // absent path never disrupts an open menu).
    ensureFieldingColumnProbed("bowling_group", () => {
      if (inlineState && getFieldingColumnPresent("bowling_group")) {
        renderInline(inlineState.el, getDiscipline(), getFormats());
      }
    });
  }

  /** Called by the host to keep the picker honest after a re-render / store
   * change. INLINE mode (leaderboard): re-render on a namespace/format change,
   * else just re-sync checked state (the `anchor` arg is ignored). POPOVER mode
   * (player pop-up): re-anchor to the (possibly recreated) trigger, reposition,
   * and re-sync checked state — the host may have silently dropped a column out
   * from under it. A null anchor in popover mode means the trigger is gone (e.g.
   * the toolbar mode changed under it), so the popover closes. */
  function refresh(anchor) {
    // Inline mode (leaderboard, W1): the picker lives permanently in the popup's
    // Columns section — no anchor / reposition / close-on-null. Keep it honest
    // with the (possibly pending) store: a discipline or format change swaps the
    // whole metric vocabulary → full re-render; otherwise just re-sync checked
    // state (cheap, no focus loss).
    if (inlineState) {
      const ns = getDiscipline();
      const formats = getFormats();
      if (ns !== inlineState.ns || !sameFormats(formats, inlineState.formats)) {
        // ANY vocabulary change (discipline OR format) drops the open compose editor —
        // its stat/dimension options belong to the old vocabulary. A discipline switch
        // also drops pending-empty param rows (param descriptor is per-discipline; a
        // composed column with real slots re-derives from the new ns's slots). No dropdown
        // opens by default (R0 Step 2); the full renderInline closes any open menu first.
        inlineState.editor = null;
        if (ns !== inlineState.ns) {
          inlineState.pendingParams = [];
        }
        renderInline(inlineState.el, ns, formats);
        inlineState.ns = ns;
        inlineState.formats = formats.slice();
      } else {
        syncInline(inlineState.el);
      }
      return;
    }
    // Popover mode (player pop-up): re-anchor, re-sync checked state, reposition;
    // a null anchor means the trigger is gone (e.g. an error state), so close.
    if (!openState) return;
    if (!anchor) {
      close();
      return;
    }
    openState.anchor = anchor;
    syncCheckedState(openState.el);
    positionColumnsPopover(openState.el, anchor);
  }

  /**
   * The column picker (§ restricted picker, D4 R3 follow-up): lists every
   * eligible metric in the CURRENT effective namespace — the plain
   * batting/bowling vocabulary normally, or the matchup_batting/matchup_bowling
   * vocabulary while a "Vs" selection is active — in the same sections
   * (Basic / Dismissals / Fielding / Impact / Phase) either way. Every change
   * calls setColumns(cols), so a pick made in matchup mode never leaks into the
   * plain picker's list or vice versa (they're different namespaces/keys).
   *
   * Hosted on document.body, NOT inside the host's container: the host's own
   * re-render (renderLoaded / a full prompt/error transition) may replace its
   * container subtree wholesale, which would destroy a popover living inside it
   * the instant the first checkbox fired (the owner's original one-column-per-
   * open complaint). Living on body lets it survive re-renders for free;
   * positionColumnsPopover() places it from the anchor button's
   * getBoundingClientRect(), and refresh() (called by the host after each
   * re-render) re-finds the anchor and re-syncs checked state + position.
   */
  function open(anchorEl) {
    const anchor = anchorEl || lastTrigger;
    if (!anchor) return;
    close();
    const ns = getDiscipline();
    const formats = getFormats();
    const popover = document.createElement("div");
    popover.className = "columns-popover";
    popover.innerHTML = buildPickerHTML(ns, formats);
    document.body.appendChild(popover);
    positionColumnsPopover(popover, anchor);

    // Same checkbox handlers the popover always had (see wireCheckboxes). The popover
    // lives on document.body and survives an instant-apply requery via refresh(). The
    // pop-up passes no Sort-by/Highlight contract (controlsOn false), so there are no
    // per-column controls to wire here — its picker is the flat checkbox list.
    wireCheckboxes(popover);

    const onDocClick = (e) => {
      if (popover.contains(e.target) || e.target === anchor || anchor.contains?.(e.target)) return;
      close();
    };
    const onKeydown = (e) => {
      if (e.key === "Escape") close();
    };
    const onScroll = () => {
      if (!openState) return;
      const a = openState.anchor;
      if (!document.body.contains(a)) {
        close();
        return;
      }
      positionColumnsPopover(openState.el, a);
    };
    const onResize = () => close();

    // Deferred so the very click that opened the popover doesn't immediately
    // close it again via onDocClick.
    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
    document.addEventListener("keydown", onKeydown, true);
    // Capture:true — scroll doesn't bubble, but a capturing listener on
    // window still sees scrolls on nested scrollable ancestors (e.g.
    // .table-scroll's horizontal scrollbar).
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    openState = { el: popover, anchor, onDocClick, onKeydown, onScroll, onResize };
  }

  function mount(triggerEl) {
    if (!triggerEl) return;
    lastTrigger = triggerEl;
    triggerEl.addEventListener("click", (e) => {
      e.stopPropagation();
      open(triggerEl);
    });
  }

  return { mount, mountInline, open, close, refresh };
}
