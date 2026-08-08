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
// with the SAME column-key array the inline handlers used to hand to
// applyColumnsInstant.
//
// What deliberately STAYS with the host (not part of this component):
//   • applyColumnsInstant — the leaderboard's OWN `setColumns` (a frozen-scope
//     instant requery); it is the contract impl, passed in here.
//   • the preset <select> — a toolbar control with different (PENDING, lights
//     Search) semantics from this popover (instant, no Search light); it shares
//     columns via the SAME get/set contract, not via this component.
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
//     what "apply" means (leaderboard: instant frozen-scope requery; pop-up:
//     re-render its own table). Called with the full new array on every change.

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
  // Columns content rework D3 (runs-by-source + wicket-type composers).
  composedRunSourceRows, makeComposedRunSourceKey, parseComposedRunSourceKey,
  makeComposedWicketTypeKey, parseComposedWicketTypeKey,
  // Columns content rework D4 (parametric Innings Score Range + Wicket Haul composers).
  composedParamDescriptor, makeComposedParamKey, parseComposedParamKey, COMPOSED_PARAM_OP_TOKEN,
} from "./metrics.js";
import { eligibleMetrics, eligibleCrossMetrics, makeSlot } from "./state.js";
// D4: the composer's operator <select> reuses the SAME operator vocabulary as the
// pop-up / advanced filter (advanced.js is import-cycle-free — pure data model).
import { OPERATORS } from "./advanced.js";

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
  const wt = parseComposedWicketTypeKey(key);
  if (wt && wt.axis === "count") {
    return { count: key, alt: makeComposedWicketTypeKey(wt.token, "pct"), mode: "pct" };
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

// Display labels for the picker rows — shorter than metrics.js's own `label`
// (which is prefixed "Out …" for the count metric's own column header, not
// needed again here since the section header already reads "Dismissals").
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
    const wt = parseComposedWicketTypeKey(key);
    if (wt) return { count: makeComposedWicketTypeKey(wt.token, "count"), alt: makeComposedWicketTypeKey(wt.token, "pct"), mode: "pct" };
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
   * the E1b instance row AND the picker-rework chosen-columns row (chosenPlainRowHTML)
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
  // E2 tidy T1 (owner 2026-08-08): the standalone `boundary_runs` (batting
  // "Boundary Runs") is also hidden from the OFFERING — the Runs-by-Source
  // composer's "Boundaries" source covers it. Same hidden-not-deleted posture:
  // the metric DEF stays in metrics.js (the composer's "Boundaries" row + its %
  // still reference boundary_runs / boundary_runs_pct, and the pop-up popover
  // keeps offering it). boundary_runs is a BATTING-only key (bowling carries only
  // boundary_runs_pct), so this is inert on the bowling table. "Boundary Balls"
  // is NOT hidden (it isn't dual-homed in a composer).
  const HIDDEN_COLUMN_KEYS = new Set(["player_of_match", "wickets_per_innings", "boundary_runs"]);

  const BATTING_BASIC_ORDER = [
    "innings", "r_pos", "runs", "balls_faced", "dismissals", "high_score", "fours", "sixes",
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
  const BOWLING_DETAILED_ORDER = ["economy", "average", "strike_rate"];

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


  /** W4: wire the four dropdown triggers (inline / leaderboard only — the pop-up
   * popover has no such bar). Clicking a trigger opens its panel and closes the
   * others (one open at a time); clicking the open one closes it. The open id is
   * remembered on inlineState so a re-render (namespace/format change) reopens it. */
  function wireDropdowns(rootEl) {
    rootEl.querySelectorAll(".cols-dd-trigger[data-dd]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        const id = btn.dataset.dd;
        const cur = (inlineState && inlineState.openDropdown) || null;
        const next = cur === id ? null : id;
        if (inlineState) inlineState.openDropdown = next;
        applyOpenDropdown(rootEl, next);
      });
    });
  }

  /** Show `openId`'s panel + mark its trigger active; hide/close the rest. Pure
   * DOM toggle — no re-render, so the wired checkboxes/controls survive. */
  function applyOpenDropdown(rootEl, openId) {
    rootEl.querySelectorAll(".cols-dd-trigger[data-dd]").forEach((btn) => {
      const on = btn.dataset.dd === openId && !btn.disabled;
      btn.classList.toggle("is-open", on);
      btn.setAttribute("aria-expanded", on ? "true" : "false");
    });
    rootEl.querySelectorAll(".cols-dd-panel[data-dd-panel]").forEach((p) => {
      p.hidden = p.dataset.ddPanel !== openId;
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

  // ── PICKER REWORK to FILTER-STYLE (E1c, 2026-08-08; leaderboard inline only) ──
  // The checkbox tick-lists (W4/E1b) were the wrong model (owner correction). The
  // leaderboard Columns section now works EXACTLY like the Filters section:
  //   • a CHOSEN-ROWS list (the "active conditions" equivalent) — one row per
  //     displayed column, each with its own count/% · sort · highlight · duplicate ·
  //     × (plain columns reuse E1b's instanceControlsMarkup); parametric columns
  //     (Innings Score / Wicket Haul) render a live op+value editor + ×; dimension /
  //     category composers (Phase/Ball/Innings/Runs-by-Source/Wicket-Type) render as
  //     ONE row holding the composer's tick-box / count-% editor inline + × (Option 2).
  //   • four click-to-add MENUS (Match · Batting · Bowling · Fielding) listing
  //     addable plain column NAMES (grouped by section) + composer entries. Clicking
  //     a name appends a slot; re-picking appends another copy (multi-instance E1).
  // PRESENTATION-ONLY: composed slots still live in state.columns[ns] and are
  // generated by the UNCHANGED composer machinery — this only rearranges how columns
  // are picked + shown. The sacred query builders never see any of this (applySlots →
  // load() dedups; buildMatchupQuery dedups). The pop-up popover path (buildPickerHTML
  // / open) is untouched — it keeps its flat checkbox list, byte-identical.

  // Fixed order + labels for the dimension / category composers (Option-2 rows).
  const DIM_COMPOSER_KINDS = ["phase", "ball", "innings", "runsource", "wickettype"];
  const COMPOSER_KIND_LABEL = {
    phase: "Phase Range", ball: "Ball Range", innings: "Innings Range",
    runsource: "Runs by Source", wickettype: "Wicket Type",
  };
  // opToken (ge/le/eq/bt) → the operator <select>'s value (gte/lte/eq/between).
  const _PARAM_OPTOKEN_TO_KEY = Object.fromEntries(
    Object.entries(COMPOSED_PARAM_OP_TOKEN).map(([k, v]) => [v, k])
  );

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
    if (parseComposedRunSourceKey(key)) return "runsource";
    if (parseComposedWicketTypeKey(key)) return "wickettype";
    return null;
  }

  // ── One-metric-per-row composer model (owner ruling 2026-08-07) ──────────────
  // A dimension/category composer row now carries a SINGLE selection + dimension
  // tick-boxes (NOT the full metric matrix). For Phase/Ball/Innings the selection
  // is ONE base metric (Strike Rate, Average, …); for Runs by Source / Wicket Type
  // it is the count-or-% AXIS. The row's columns = the selection × its ticked
  // dimension/category values. A second metric/axis = adding the composer again
  // (another row). A composer row is identified by (kind, sel).

  /** The row selection (base metric key, or count/% axis) a composed slot key
   * belongs to — the value we group slots by into rows. null for a non-composed key. */
  function composerSelForKey(kind, key) {
    if (kind === "phase") { const p = parseComposedPhaseKey(key); return p ? p.baseKey : null; }
    if (kind === "ball") { const p = parseComposedBallKey(key); return p ? p.baseKey : null; }
    if (kind === "innings") { const p = parseComposedInningsKey(key); return p ? p.baseKey : null; }
    if (kind === "runsource") { const p = parseComposedRunSourceKey(key); return p ? p.axis : null; }
    if (kind === "wickettype") { const p = parseComposedWicketTypeKey(key); return p ? p.axis : null; }
    return null;
  }

  /** The <select> options for a composer row's single selection: the metric pool
   * (Phase/Ball/Innings) or the count/% axis (Runs by Source / Wicket Type), as
   * [{ value, label }]. "" pool ⇒ the composer is not offered for this ns/format. */
  function composerSelectOptions(kind, ns, formats) {
    if (kind === "phase") return composedPhasePool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "ball") return composedBallPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "innings") return composedInningsPool(ns).map((b) => ({ value: b.key, label: metricDisplayLabel(b, formats) }));
    if (kind === "runsource") return ns === "batting" ? [{ value: "runs", label: "Count" }, { value: "pct", label: "%" }] : [];
    if (kind === "wickettype") return (ns === "batting" || ns === "bowling") ? [{ value: "count", label: "Count" }, { value: "pct", label: "%" }] : [];
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
    if (kind === "runsource") {
      if (ns !== "batting") return [];
      // sel = "runs" (count) | "pct". Each source's key is its count OR % variant;
      // "Boundaries" reuses the catalogued boundary_runs / boundary_runs_pct pair.
      return composedRunSourceRows().map((r) => ({ label: r.rowLabel, key: sel === "pct" ? r.pctKey : r.countKey, rare: false }));
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
    return [];
  }

  /** True iff a composer `kind` is offerable for the current ns/format (≥1 metric/axis
   * option AND ≥1 tick-box value for the first option) — the add-menu gate. */
  function composerAvailable(kind, ns, formats) {
    const opts = composerSelectOptions(kind, ns, formats);
    if (!opts.length) return false;
    return composerValueRows(kind, ns, formats, opts[0].value).length > 0;
  }

  /** The default selection for a freshly-added composer row of `kind`: the first
   * option NOT already shown as a row of that kind (so "add again" lands on a new
   * metric/axis), else the first option. null when the kind is unavailable. */
  function defaultComposerSel(kind, ns, formats) {
    const opts = composerSelectOptions(kind, ns, formats).map((o) => o.value);
    if (!opts.length) return null;
    const used = new Set(shownComposerRows(ns, formats).filter((r) => r.kind === kind).map((r) => r.sel));
    return opts.find((v) => !used.has(v)) ?? opts[0];
  }

  /** True iff `key` is the OWN-discipline parametric composed column for `ns`. */
  function isParamComposerKey(key, ns) {
    const p = parseComposedParamKey(key);
    if (!p) return false;
    const desc = composedParamDescriptor(ns);
    return !!desc && p.prefix === desc.prefix;
  }

  // ── Chosen rows ─────────────────────────────────────────────────────────────

  /** One plain-column chosen row: the column's label + its count/% toggle · sort ·
   * highlight · duplicate · × (E1b controls, keyed by the slot id). "" for a stray key. */
  function chosenPlainRowHTML(slot) {
    const ns = getDiscipline();
    const formats = getFormats();
    const m = resolveColumnMetric(slot.key, ns);
    if (!m) return "";
    const pair = pairForAnyKey(slot.key, ns);
    const label = metricDisplayLabel(m, formats);
    return `<div class="cols-chosen-row" data-slot-id="${slot.id}">
      <span class="cols-chosen-row__label" title="${escHtml(label)}">${escHtml(label)}</span>
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

  /** One dimension tick-box row for a composer editor (Phase/Ball/Innings): a simple
   * checkbox standing for the composed column `key`, checked iff it is shown. */
  function composedCheckRowHTML(key, label, visible) {
    return `<label class="columns-popover__item cols-comp-check-row">
      <input type="checkbox" class="cols-comp-check" data-composed-key="${key}" ${visible.has(key) ? "checked" : ""} />
      <span>${escHtml(label)}</span>
    </label>`;
  }

  /** The editor BODY for one composer row (kind + its single selection `sel`): a
   * flat list of dimension/category tick-boxes (checked iff their column is shown).
   * Reuses the D1-D4 composed-key helpers (byte-identical column generation). The
   * batting Wicket Type body keeps the common + Rare-disclosure split. Per-column
   * sort/highlight comes from the table header (E2), not these rows. Returns
   * { html, empty }. */
  function composerBody(kind, ns, formats, sel, visible) {
    const rows = composerValueRows(kind, ns, formats, sel);
    if (!rows.length) return { html: "", empty: true };
    const check = (r) => composedCheckRowHTML(r.key, r.label, visible);
    if (rows.some((r) => r.rare)) {
      const common = rows.filter((r) => !r.rare);
      const rare = rows.filter((r) => r.rare);
      const rareHTML = rare.length
        ? `<details class="columns-popover__disclosure"><summary><span class="columns-popover__disclosure-arrow">▸</span> Rare dismissals</summary><div class="columns-popover__list">${rare.map(check).join("")}</div></details>`
        : "";
      return { html: `<div class="columns-popover__list">${common.map(check).join("")}</div>${rareHTML}`, empty: false };
    }
    return { html: `<div class="columns-popover__list">${rows.map(check).join("")}</div>`, empty: false };
  }

  /** One dimension/category composer chosen row (owner ruling: ONE metric/axis per
   * row): title + a single metric-or-count/% <select> + × in the head, dimension
   * tick-boxes in the body. The row drives the columns = selection × ticked values;
   * × removes the row and every column it made. Add the composer again for another
   * metric/axis. */
  function composerRowHTML(kind, sel, ns, formats, visible) {
    const label = COMPOSER_KIND_LABEL[kind];
    const options = composerSelectOptions(kind, ns, formats);
    const selectHTML = options.length
      ? `<select class="select cols-composer-row__metric" data-composer-metric="${kind}" data-composer-sel="${escHtml(sel)}" aria-label="${escHtml(label)} metric">${options
          .map((o) => `<option value="${escHtml(o.value)}"${o.value === sel ? " selected" : ""}>${escHtml(o.label)}</option>`)
          .join("")}</select>`
      : "";
    const body = composerBody(kind, ns, formats, sel, visible);
    const bodyHTML = body.empty
      ? `<div class="cols-composer-row__empty">No options for the current format.</div>`
      : body.html;
    return `<div class="cols-composer-row" data-composer-kind="${kind}" data-composer-sel="${escHtml(sel)}">
      <div class="cols-composer-row__head">
        <span class="cols-composer-row__title">${escHtml(label)}</span>
        ${selectHTML}
        <button type="button" class="col-remove-btn cols-composer-remove" data-composer-remove-kind="${kind}" data-composer-remove-sel="${escHtml(sel)}" title="Remove ${escHtml(label)} and its columns" aria-label="Remove ${escHtml(label)} and its columns">✕</button>
      </div>
      <div class="cols-composer-row__body">${bodyHTML}</div>
    </div>`;
  }

  /** Remap a composer row from `oldSel` to `newSel` (a metric-or-count/% <select>
   * change): every ticked value under oldSel becomes the same value under newSel
   * (slot ids preserved), so the ticks carry over. Values align 1:1 across selections
   * (same dimension/category order). Updates the manual-row bookkeeping too. */
  function changeComposerSel(kind, oldSel, newSel) {
    if (oldSel === newSel) return;
    const ns = getDiscipline();
    const formats = getFormats();
    const oldRows = composerValueRows(kind, ns, formats, oldSel);
    const newRows = composerValueRows(kind, ns, formats, newSel);
    const remap = new Map();
    for (let i = 0; i < oldRows.length && i < newRows.length; i++) remap.set(oldRows[i].key, newRows[i].key);
    const slots = (getSlots() || []).map((s) => (remap.has(s.key) ? { ...s, key: remap.get(s.key) } : s));
    applySlots(slots);
    if (inlineState) {
      const entry = inlineState.composers.find((c) => c.kind === kind && c.sel === oldSel);
      if (entry) {
        if (inlineState.composers.some((c) => c.kind === kind && c.sel === newSel)) {
          inlineState.composers = inlineState.composers.filter((c) => c !== entry);
        } else {
          entry.sel = newSel;
        }
      }
    }
    rerenderInline();
  }

  /** The dimension/category composer ROWS to SHOW, as [{ kind, sel }]: manually-added
   * empty rows (inlineState.composers) UNIONed with rows derived from the current
   * slots, grouped by (kind, selection) — so presets, reloads and a discipline
   * switch-back all surface each metric/axis as its own row. Ordered by DIM_COMPOSER_
   * KINDS, then by each kind's select-option order (a leftover derived sel appended). */
  function shownComposerRows(ns, formats) {
    const manual = (inlineState && inlineState.composers) || [];
    const derived = {};
    for (const k of DIM_COMPOSER_KINDS) derived[k] = new Set();
    for (const s of slotsForNs()) {
      const kind = composerKindForKey(s.key);
      if (!kind) continue;
      const sel = composerSelForKey(kind, s.key);
      if (sel != null) derived[kind].add(sel);
    }
    const rows = [];
    for (const kind of DIM_COMPOSER_KINDS) {
      const wanted = new Set([
        ...manual.filter((c) => c.kind === kind).map((c) => c.sel),
        ...derived[kind],
      ]);
      if (!wanted.size) continue;
      const optOrder = composerSelectOptions(kind, ns, formats).map((o) => o.value);
      const ordered = [
        ...optOrder.filter((v) => wanted.has(v)),
        ...[...wanted].filter((v) => !optOrder.includes(v)),
      ];
      for (const sel of ordered) rows.push({ kind, sel });
    }
    return rows;
  }

  /** Build the CHOSEN-columns rows list: plain + parametric rows in slot order, then
   * any pending (empty) parametric rows, then the dimension/category composer rows. */
  function buildChosenHTML(ns, formats) {
    const slots = slotsForNs();
    const visible = new Set(slots.map((s) => s.key));
    const rows = [];
    for (const s of slots) {
      if (composerKindForKey(s.key)) continue; // owned by a composer row
      if (isParamComposerKey(s.key, ns)) rows.push(paramRowHTML(s));
      else rows.push(chosenPlainRowHTML(s));
    }
    for (const p of (inlineState && inlineState.pendingParams) || []) rows.push(pendingParamRowHTML(p.id, ns));
    for (const r of shownComposerRows(ns, formats)) rows.push(composerRowHTML(r.kind, r.sel, ns, formats, visible));
    const body = rows.filter(Boolean).join("");
    const empty = body ? "" : `<div class="cols-chosen__empty">No columns yet — add some from the menus below.</div>`;
    return `<div class="cols-chosen" data-role="cols-chosen">${empty}${body}</div>`;
  }

  // ── Add menus ───────────────────────────────────────────────────────────────

  /** One click-to-add menu item for a plain column. */
  function menuItemHTML(m, formats) {
    return `<button type="button" class="cols-add-item" data-add-plain-key="${m.key}">${escHtml(metricDisplayLabel(m, formats))}</button>`;
  }
  /** A labelled menu section of plain-column items, or "" when empty. */
  function menuSectionHTML(label, metrics, formats) {
    return metrics.length
      ? `<div class="columns-popover__section-label">${label}</div><div class="cols-add-list">${metrics.map((m) => menuItemHTML(m, formats)).join("")}</div>`
      : "";
  }

  /** Build the four click-to-add MENUS (Match · Batting · Bowling · Fielding),
   * partitioning the discipline's columns across the dropdowns and rendering clickable
   * NAMES (+ composer entries). Clicking a name appends a slot; a composer entry adds
   * its row. */
  function buildAddMenuHTML(ns, formats) {
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

    // Composers menu section (own discipline, plain ns only): only kinds applicable
    // to this discipline/format, plus the parametric composer.
    let composerSection = "";
    if (isPlainNs) {
      const items = [];
      for (const kind of DIM_COMPOSER_KINDS) {
        if (composerAvailable(kind, ns, formats)) {
          items.push(`<button type="button" class="cols-add-item" data-add-composer-kind="${kind}">${escHtml(COMPOSER_KIND_LABEL[kind])}</button>`);
        }
      }
      const desc = composedParamDescriptor(ns);
      if (desc) {
        items.push(`<button type="button" class="cols-add-item" data-add-param-prefix="${desc.prefix}">${escHtml(desc.sectionLabel)}</button>`);
      }
      composerSection = items.length
        ? `<div class="columns-popover__section-label">Composers</div><div class="cols-add-list">${items.join("")}</div>`
        : "";
    }

    const ownSections =
      menuSectionHTML("Basic Stats", ownBasic, formats) +
      menuSectionHTML("Detailed Stats", ownDetailed, formats) +
      (isPlainNs ? "" : menuSectionHTML("Dismissals", dismissal, formats)) +
      composerSection;
    const crossSections =
      menuSectionHTML("Basic Stats", crossBasic, formats) + menuSectionHTML("Detailed Stats", crossDetailed, formats);
    const matchHTML =
      menuSectionHTML("Basic Stats", matchesMetric ? [matchesMetric] : [], formats) +
      menuSectionHTML("Impact", impact, formats);

    const dropdowns = [
      { id: "match", label: "Match", html: matchHTML },
      { id: "batting", label: "Batting", html: bucket === "batting" ? ownSections : crossSections },
      { id: "bowling", label: "Bowling", html: bucket === "bowling" ? ownSections : crossSections },
      { id: "fielding", label: "Fielding", html: menuSectionHTML("Fielding Stats", fielding, formats) },
    ];
    const open = (inlineState && inlineState.openDropdown) || null;
    const bar = dropdowns
      .map((d) => {
        const empty = !d.html;
        const isOpen = open === d.id && !empty;
        return `<button type="button" class="cols-dd-trigger${isOpen ? " is-open" : ""}" data-dd="${d.id}" aria-expanded="${isOpen ? "true" : "false"}" aria-controls="cols-dd-panel-${d.id}"${empty ? " disabled" : ""}><span class="cols-dd-name">${d.label}</span><span class="cols-dd-caret" aria-hidden="true">▾</span></button>`;
      })
      .join("");
    const panels = dropdowns
      .map((d) => {
        const isOpen = open === d.id && !!d.html;
        return `<div class="cols-dd-panel" id="cols-dd-panel-${d.id}" data-dd-panel="${d.id}" role="region" aria-label="${d.label} columns"${isOpen ? "" : " hidden"}>${d.html || ""}</div>`;
      })
      .join("");
    return `<div class="cols-dropdowns cols-add"><div class="cols-add__label">Add columns</div><div class="cols-dd-bar">${bar}</div><div class="cols-dd-panels">${panels}</div></div>`;
  }

  /** The whole leaderboard Columns section: chosen rows + add menus. */
  function buildInlineHTML(ns, formats) {
    return `<div class="cols-picker">${buildChosenHTML(ns, formats)}${buildAddMenuHTML(ns, formats)}</div>`;
  }

  // ── Add-menu + composer + param wiring (filter-style inline) ─────────────────
  function wireAddMenus(rootEl) {
    rootEl.querySelectorAll(".cols-add-item[data-add-plain-key]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        applySlots([...(getSlots() || []), makeSlot(btn.dataset.addPlainKey)]);
        rerenderInline();
      });
    });
    rootEl.querySelectorAll(".cols-add-item[data-add-composer-kind]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const kind = btn.dataset.addComposerKind;
        if (!inlineState) return;
        // Owner ruling: ONE metric/axis per row. Add a manual empty row with the
        // first metric/axis not already shown for this kind (so "add again" lands on
        // a new metric). No-op if that (kind, sel) already has a row.
        const sel = defaultComposerSel(kind, getDiscipline(), getFormats());
        if (sel == null) return;
        if (!inlineState.composers.some((c) => c.kind === kind && c.sel === sel)) {
          inlineState.composers.push({ kind, sel });
        }
        rerenderInline();
      });
    });
    rootEl.querySelectorAll(".cols-add-item[data-add-param-prefix]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        // Owner ruling: parametric composers START EMPTY — add a blank pending row,
        // NOT a seeded column. The column is minted once the user enters a valid value.
        if (!inlineState) return;
        inlineState.pendingParams.push({ id: nextPendingId() });
        rerenderInline();
      });
    });
  }

  function wireComposerEditors(rootEl) {
    // Dimension/category tick-box: add / remove the composed slot for its value.
    rootEl.querySelectorAll(".cols-comp-check[data-composed-key]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const key = cb.dataset.composedKey;
        if (cb.checked) applySlots([...(getSlots() || []), makeSlot(key)]);
        else applySlots((getSlots() || []).filter((s) => s.key !== key));
        rerenderInline();
      });
    });
    // Metric / count-% <select>: change the row's single selection, remapping its
    // ticked values onto the new metric/axis (see changeComposerSel).
    rootEl.querySelectorAll(".cols-composer-row__metric[data-composer-metric]").forEach((sel) => {
      sel.addEventListener("change", () => {
        changeComposerSel(sel.dataset.composerMetric, sel.dataset.composerSel, sel.value);
      });
    });
    // Composer row × : drop the manual entry (kind, sel) + remove every column that
    // (kind, sel) made — the "× removes all its columns" behaviour, now per row.
    rootEl.querySelectorAll(".cols-composer-remove[data-composer-remove-kind]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const kind = btn.dataset.composerRemoveKind;
        const sel = btn.dataset.composerRemoveSel;
        if (inlineState) inlineState.composers = inlineState.composers.filter((c) => !(c.kind === kind && c.sel === sel));
        applySlots((getSlots() || []).filter((s) => !(composerKindForKey(s.key) === kind && composerSelForKey(kind, s.key) === sel)));
        rerenderInline();
      });
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
   * ordered slot ids+keys, the shown composer rows (kind + selection), and any pending
   * empty parametric rows. A change means the chosen list / menus must be REBUILT (an
   * external column change, e.g. a preset); an unchanged signature lets the sync path
   * do only a cheap sort/highlight re-sync. */
  function inlineSignature(ns, formats) {
    return JSON.stringify({
      ns,
      formats,
      slots: slotsForNs().map((s) => `${s.id}:${s.key}`),
      composers: shownComposerRows(ns, formats).map((r) => `${r.kind}:${r.sel}`),
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

  /** Render the leaderboard's inline picker (filter-style: chosen rows + add menus)
   * straight into its host (build + wire). Inline-only: the pop-up popover renders
   * via open() → buildPickerHTML, untouched. The inline host is always the multi-
   * instance (slot-native) leaderboard picker — the pre-rework four-dropdown checkbox
   * layout has been retired. */
  function renderInline(container, ns, formats) {
    container.innerHTML = buildInlineHTML(ns, formats);
    // Plain chosen-row controls (count/% · sort · highlight · duplicate · ×) reuse
    // the E1b per-slot wiring (data-*-slot markup). Param-row × also uses
    // data-remove-slot, so it wires here too.
    wireMultiInstance(container);
    wireAddMenus(container);
    wireComposerEditors(container);
    wireParamRows(container);
    wireDropdowns(container);
    if (inlineState) inlineState.sig = inlineSignature(ns, formats);
  }

  /** D4: re-render the inline picker in place (preserving the open dropdown). Called
   * after adding/removing a value-dynamic parametric column so its row list rebuilds.
   * No-op in popover mode (the pop-up has no param composer). */
  function rerenderInline() {
    if (inlineState) renderInline(inlineState.el, getDiscipline(), getFormats());
  }

  /**
   * INLINE mount (W1): render the picker into a fixed host element (the
   * leaderboard popup's "Columns" section) and remember it so refresh() keeps it
   * honest. Idempotent — re-mounting simply re-renders. Distinct from mount(),
   * which wires a trigger button to OPEN a floating popover; a given picker
   * instance uses one mode or the other, never both. W4: the current discipline's
   * OWN dropdown (Batting on a batting table) opens by default.
   */
  function mountInline(container) {
    if (!container) return;
    const ns = getDiscipline();
    const formats = getFormats();
    // `composers` = the dimension/category composer rows manually added this session
    // as { kind, sel } (one metric/axis per row) that don't yet have any ticked
    // columns (empty rows); once a (kind, sel) has ≥1 column it's re-derived from the
    // slots, so this only tracks the pending-empty set. `pendingParams` = added-but-
    // unset parametric rows ({ id }; owner ruling: parametric composers start empty).
    // Both reset on a discipline switch (refresh). `sig` caches the last render's
    // structural signature for the sync fast-path.
    inlineState = { el: container, ns, formats: formats.slice(), openDropdown: disciplineBucket(ns), composers: [], pendingParams: [], sig: null };
    renderInline(container, ns, formats);
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
        // A discipline switch flips which dropdown holds the OWN columns — default
        // the newly-relevant own dropdown open (a format-only change keeps whatever
        // was open) — and DROPS any pending-empty composer/param rows (their metric
        // vocabulary belongs to the old discipline; a composer with real columns
        // re-derives from the new ns's slots).
        if (ns !== inlineState.ns) {
          inlineState.openDropdown = disciplineBucket(ns);
          inlineState.composers = [];
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
