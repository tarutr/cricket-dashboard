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
import { DISMISSAL_KINDS, metricDisplayLabel, makeCrossKey, parseCrossKey, getMetric, OTHER_DISCIPLINE, COLUMN_TOGGLE_PAIRS } from "./metrics.js";
import { eligibleMetrics, eligibleCrossMetrics } from "./state.js";

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
/** The toggle pair whose COUNT key is `key` in namespace `ns`, or null. */
function togglePairByCount(key, ns) {
  const byCount = _TOGGLE_PAIRS_BY_NS[ns];
  return (byCount && byCount.get(key)) || null;
}
/** The set of ALTERNATE (%/per-match) keys hidden from the picker listing in `ns`. */
function toggleAltKeys(ns) {
  return _TOGGLE_ALTS_BY_NS[ns] || new Set();
}
/** Which key of a toggle pair is CURRENTLY shown for `visible` — the alternate when
 * present, else the count key (the default). */
function activeToggleKey(pair, visible) {
  return visible.has(pair.alt) ? pair.alt : pair.count;
}

// ── Phase×metric composer (columns-rejig W4) ─────────────────────────────────
// The composer REPLACES the flat enumerated phase columns in the leaderboard's
// picker with a family→variant control: pick a metric family (SR / Economy /
// Wickets — the families that HAVE enumerated phase columns) + phase(s)
// (Powerplay / Middle / Death). Each variant checkbox's data-key IS the existing
// enumerated phase-metric key (pp_strike_rate, odi_death_economy, …), so the
// emitted columns are byte-identical to the old Phase section — the equivalence
// gate holds BY CONSTRUCTION (no new metric key is ever invented). phaseParts()
// decomposes a phase key by stripping an optional `odi_` prefix then the leading
// phase token; the enumerated phase metrics are the only keys carrying these
// prefixes, so the split is unambiguous.
const PHASE_ORDER = ["pp", "mid", "death"];
const PHASE_LABEL = { pp: "Powerplay", mid: "Middle", death: "Death" };
function phaseParts(key) {
  const k = key.startsWith("odi_") ? key.slice(4) : key;
  for (const ph of PHASE_ORDER) {
    const pref = `${ph}_`;
    if (k.startsWith(pref)) return { phase: ph, base: k.slice(pref.length) };
  }
  return null;
}

// A monochrome highlighter/marker glyph, filled via currentColor — mirrors the
// pin toggle's PIN_GLYPH convention in src/table.js (owner fix: the old 🖍️
// emoji couldn't take a CSS `color`, so its "on" state was faked with a solid
// chip background; that chip is gone, this SVG lets .col-hl-btn recolour it
// exactly like .pin-toggle does). Defined locally rather than imported from
// table.js to avoid a circular import (table.js already imports this module).
const HIGHLIGHT_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g transform="rotate(45 12 12)"><rect x="9" y="2" width="6" height="12" rx="1"/><polygon points="9,14 15,14 12,19"/></g><rect x="4" y="19" width="10" height="2" rx="1"/></svg>';

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

  // ── Shared content: build + wire (used by BOTH the floating popover and the
  //    inline host, so the two surfaces render byte-identical) ────────────────

  /** W2: the per-column Sort-by + Highlight controls for one metric `key`.
   * Rendered only when controlsOn (leaderboard). Both controls act on the actual
   * TABLE column, so they're DISABLED while the column is hidden (unchecked) —
   * you sort/highlight what you can see; checking the box enables them. Sort is
   * radio-like (only the active sort column shows ▲/▼, others show ↕); Highlight
   * is a multi-select toggle. syncColumnControls keeps these states honest after
   * every refresh without a re-render. */
  function columnControlsHTML(key, toggleCountKey = null) {
    const isVisible = new Set(getColumns()).has(key);
    const sort = getSort();
    const isActiveSort = !!(sort && sort.active && sort.key === key);
    const sortArrow = isActiveSort ? (sort.dir === "asc" ? "▲" : "▼") : "↕";
    const hlOn = new Set(getHighlights()).has(key);
    const dis = isVisible ? "" : " disabled";
    const sortTitle = !isVisible
      ? "Show this column to sort by it"
      : isActiveSort
        ? "Sorted by this column — click to reverse direction"
        : "Sort the table by this column";
    const hlTitle = !isVisible
      ? "Show this column to highlight it"
      : hlOn
        ? "Remove highlight"
        : "Highlight this column";
    // Wave C: on a count/% (or count/per-match) toggle row, the sort/highlight
    // controls must operate on WHICHEVER form is currently shown (`key` is the
    // ACTIVE key here). data-toggle-count lets syncColumnControls re-derive the
    // active key + repoint data-sort-key/data-hl-key when the shown form changes
    // (e.g. a preset swaps the variant) WITHOUT a full re-render.
    const tc = toggleCountKey ? ` data-toggle-count="${toggleCountKey}"` : "";
    return `<span class="columns-popover__item-controls">
      <button type="button" class="col-sort-btn${isActiveSort ? " is-active" : ""}" data-sort-key="${key}"${tc} aria-pressed="${isActiveSort ? "true" : "false"}" title="${sortTitle}" aria-label="${sortTitle}"${dis}>${sortArrow}</button>
      <button type="button" class="col-hl-btn${hlOn ? " is-active" : ""}" data-hl-key="${key}"${tc} aria-pressed="${hlOn ? "true" : "false"}" title="${hlTitle}" aria-label="${hlTitle}"${dis}>${HIGHLIGHT_GLYPH}</button>
    </span>`;
  }

  /** Wave C: the count/% (or count/per-match) segmented control for a toggle pair.
   * Two segments — count ("#") + alternate ("%" or "/M") — the active one carrying
   * `is-active`. DISABLED while the column is hidden (neither variant shown), matching
   * the sort/highlight "show it to act on it" convention. The click handler
   * (wireModeToggles) swaps the shown key in the column list. */
  function modeToggleHTML(pair) {
    const visible = new Set(getColumns());
    const shownAlt = visible.has(pair.alt);
    const shown = visible.has(pair.count) || shownAlt;
    const dis = shown ? "" : " disabled";
    const countActive = shown && !shownAlt;
    const altActive = shown && shownAlt;
    const isPerMatch = pair.mode === "permatch";
    const altGlyph = isPerMatch ? "/M" : "%";
    const altTitle = isPerMatch ? "Show as per match" : "Show as percentage";
    const groupLabel = isPerMatch ? "Show as count or per match" : "Show as count or percentage";
    return `<span class="col-mode-toggle" role="group" aria-label="${groupLabel}">
      <button type="button" class="col-mode-seg${countActive ? " is-active" : ""}" data-mode-count="${pair.count}" data-mode-alt="${pair.alt}" data-mode-target="count" aria-pressed="${countActive ? "true" : "false"}" title="Show as count"${dis}>#</button>
      <button type="button" class="col-mode-seg${altActive ? " is-active" : ""}" data-mode-count="${pair.count}" data-mode-alt="${pair.alt}" data-mode-target="alt" aria-pressed="${altActive ? "true" : "false"}" title="${altTitle}"${dis}>${altGlyph}</button>
    </span>`;
  }

  /** Wave C: one toggle-pair row (leaderboard only). A DUAL-KEY checkbox (checked iff
   * EITHER variant is shown; ticking adds the count variant — default count; unticking
   * removes both), the count metric's stable label, then the mode segmented control +
   * the Sort-by/Highlight controls bound to whichever form is currently shown. Mirrors
   * the batting Dismissals dual-key row, but per-column and with a per-row mode toggle
   * instead of a section-level "Show as %". */
  function toggleRowHTML(m, pair, formats, visible) {
    const shown = visible.has(pair.count) || visible.has(pair.alt);
    const active = activeToggleKey(pair, visible);
    const label = `<label class="columns-popover__item">
        <input type="checkbox" data-toggle-count="${pair.count}" data-toggle-alt="${pair.alt}" ${shown ? "checked" : ""} />
        <span>${metricDisplayLabel(m, formats)}</span>
      </label>`;
    return `<div class="columns-popover__item-row">${label}${modeToggleHTML(pair)}${columnControlsHTML(active, pair.count)}</div>`;
  }

  // ── Shared leaf/section builders (used by BOTH the pop-up's flat picker and
  //    the leaderboard's four-dropdown layout, so the two render byte-identical
  //    rows) ─────────────────────────────────────────────────────────────────

  /** One metric row: the checkbox label, optionally followed (W2, leaderboard
   * only) by the per-column Sort-by + Highlight controls. The controls sit
   * OUTSIDE the <label> so a click on them never toggles the checkbox. The
   * batting Dismissals dual-key rows deliberately DON'T get these (they render
   * via dismissalRowHTML, not this helper) — their active count/% variant is
   * ambiguous from the row alone; those columns stay sortable via the table
   * header. */
  function itemRowHTML(m, formats, visible) {
    // Wave C: on the leaderboard (controlsOn), a count/% (or count/per-match) toggle
    // PRIMARY renders as a single toggle row instead of a plain checkbox. Scoped to
    // plain batting/bowling by COLUMN_TOGGLE_PAIRS (matchup namespaces have no entry).
    // getDiscipline() == the ns this render was built for. Cross-discipline rows carry
    // a prefixed key that never matches a pair, so they render as normal rows.
    if (controlsOn) {
      const pair = togglePairByCount(m.key, getDiscipline());
      if (pair) return toggleRowHTML(m, pair, formats, visible);
    }
    const label = `<label class="columns-popover__item">
        <input type="checkbox" data-key="${m.key}" ${visible.has(m.key) ? "checked" : ""} />
        <span>${metricDisplayLabel(m, formats)}</span>
      </label>`;
    return controlsOn
      ? `<div class="columns-popover__item-row">${label}${columnControlsHTML(m.key)}</div>`
      : label;
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
   * as before. The LEADERBOARD inline picker now renders via buildDropdownsHTML
   * (the W4 four-dropdown layout) instead. */
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

  /** Which of the four dropdowns a COLUMN key belongs to, in namespace `ns`.
   * `matches` (Player Matches) and Impact → Match; Cross keys → their encoded
   * discipline's dropdown; Fielding → Fielding; everything else (Basic/
   * Detailed/Dismissals/Phase) → the ns's own discipline bucket. Returns null
   * for an unresolvable/stray key. */
  function dropdownForColumnKey(key, ns) {
    const parsed = parseCrossKey(key);
    if (parsed) return parsed.discipline; // "batting" | "bowling"
    const m = getMetric(key, ns);
    if (!m) return null;
    // Columns content rework Wave A (plain batting/bowling only — matchup's
    // OWN "matches" metric, vsTableOnly, is untouched): Player Matches is
    // display-consolidated into the MATCH dropdown as a single instance,
    // alongside Impact — same rule shape as the existing impact→match case
    // just below.
    if ((ns === "batting" || ns === "bowling") && m.key === "matches") return "match";
    if (m.section === "impact") return "match";
    if (m.section === "fielding") return "fielding";
    return disciplineBucket(ns);
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
  const HIDDEN_COLUMN_KEYS = new Set(["player_of_match", "wickets_per_innings"]);

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

  /** Per-dropdown count of columns currently SHOWN (the badge value). */
  function dropdownCounts(ns) {
    const counts = { match: 0, batting: 0, bowling: 0, fielding: 0 };
    for (const key of getColumns()) {
      const dd = dropdownForColumnKey(key, ns);
      if (dd && dd in counts) counts[dd] += 1;
    }
    return counts;
  }

  /** The phase×metric composer for the own-discipline dropdown: one family
   * sub-block per metric family that has enumerated phase columns in scope, each
   * listing its Powerplay/Middle/Death variants as normal itemRows (so they flow
   * through the same checkbox + W2 controls). "" when no phase metric is eligible
   * (red-ball / mixed formats). REPLACES the flat Phase section — same keys,
   * same values (equivalence gate). */
  function composerHTML(ns, formats, visible) {
    const phaseMetrics = eligibleMetrics(ns, formats).filter((m) => m.isPhaseMetric);
    if (!phaseMetrics.length) return "";
    const families = []; // base keys in first-seen (catalogue) order
    const byBase = new Map(); // base -> Map(phase -> metric)
    for (const m of phaseMetrics) {
      const parts = phaseParts(m.key);
      if (!parts) continue;
      if (!byBase.has(parts.base)) {
        byBase.set(parts.base, new Map());
        families.push(parts.base);
      }
      byBase.get(parts.base).set(parts.phase, m);
    }
    const blocks = families.map((base) => {
      const phaseMap = byBase.get(base);
      const baseMetric = getMetric(base, ns);
      const famLabel = baseMetric ? metricDisplayLabel(baseMetric, formats) : base;
      const rows = PHASE_ORDER.filter((ph) => phaseMap.has(ph))
        // Label the row by PHASE only — the family sub-header carries the metric.
        // Spreading the real metric keeps data-key = the enumerated phase key.
        .map((ph) => itemRowHTML({ ...phaseMap.get(ph), label: PHASE_LABEL[ph] }, formats, visible))
        .join("");
      return `<div class="cols-composer__family">
          <div class="cols-composer__family-label">${escHtml(famLabel)}</div>
          <div class="columns-popover__list">${rows}</div>
        </div>`;
    });
    return `<div class="columns-popover__section-label">Phases</div>
      <div class="cols-composer">${blocks.join("")}</div>`;
  }

  /** Build the leaderboard's four-dropdown Columns UI (W4). Order is fixed —
   * Match · Batting · Bowling · Fielding (Match first, OQ2). The current
   * discipline's OWN columns (Basic/Detailed/Dismissals/Phase composer) fill its
   * matching dropdown; the OTHER discipline's cross columns (Basic/Detailed) fill
   * the sibling dropdown; Impact → Match; Fielding → Fielding. Each trigger shows
   * a live count badge; an empty dropdown's trigger is disabled. */
  function buildDropdownsHTML(ns, formats) {
    const bucket = disciplineBucket(ns);
    const all = eligibleMetrics(ns, formats);
    const visible = new Set(getColumns());
    const isDetailed = (m) => m.kind === "rate" || m.kind === "percent" || DETAILED_TOTAL_KEYS.has(m.key);
    // Columns content rework Wave A: scoped to the PLAIN batting/bowling
    // namespaces only — matchup_batting/matchup_bowling (Vs mode) keep their
    // pre-Wave-A layout untouched (their own "matches"/wickets_per_innings defs
    // are separate catalogue entries this wave never renamed, see metrics.js).
    const isPlainNs = ns === "batting" || ns === "bowling";
    // Wave C: the ALTERNATE (%/per-match) key of every count/% (count/per-match)
    // toggle pair is consolidated INTO its count row's toggle — never its own picker
    // row. Hide those alt keys from every section's listing (they still reach the
    // visible column list via the toggle). Plain ns only (matchup has no pairs).
    const hiddenAlts = isPlainNs ? toggleAltKeys(ns) : new Set();

    const impact = all.filter(
      (m) => m.section === "impact" && !(isPlainNs && HIDDEN_COLUMN_KEYS.has(m.key)) && !hiddenAlts.has(m.key)
    );
    const fielding = all.filter((m) => m.section === "fielding" && !hiddenAlts.has(m.key));
    const dismissal = all.filter((m) => m.section === "dismissal");
    // Wave A: Player Matches consolidates into the Match dropdown (single
    // instance) instead of appearing in the discipline's own Basic section.
    const matchesMetric = isPlainNs ? all.find((m) => m.key === "matches") || null : null;
    const core = all.filter(
      (m) =>
        !m.isPhaseMetric &&
        m.section !== "dismissal" &&
        m.section !== "fielding" &&
        m.section !== "impact" &&
        !(isPlainNs && m.key === "matches") &&
        !(isPlainNs && HIDDEN_COLUMN_KEYS.has(m.key)) &&
        !hiddenAlts.has(m.key)
    );
    const basicOrder = bucket === "bowling" ? BOWLING_BASIC_ORDER : BATTING_BASIC_ORDER;
    const detailedOrder = bucket === "bowling" ? BOWLING_DETAILED_ORDER : BATTING_DETAILED_ORDER;
    const coreBasic = core.filter((m) => !isDetailed(m));
    const coreDetailed = core.filter((m) => isDetailed(m));
    const ownBasic = isPlainNs ? orderByKeys(coreBasic, basicOrder) : coreBasic;
    const ownDetailed = isPlainNs ? orderByKeys(coreDetailed, detailedOrder) : coreDetailed;

    // Cross columns (W3): the OTHER discipline's Basic/Detailed metrics, re-keyed
    // to their cross key. Plain batting/bowling only ([] in matchup namespaces).
    let crossBasic = [];
    let crossDetailed = [];
    if (crossDiscipline && isPlainNs) {
      const other = OTHER_DISCIPLINE[ns];
      const otherBasicOrder = other === "bowling" ? BOWLING_BASIC_ORDER : BATTING_BASIC_ORDER;
      const otherDetailedOrder = other === "bowling" ? BOWLING_DETAILED_ORDER : BATTING_DETAILED_ORDER;
      const crossSource = eligibleCrossMetrics(ns, formats).filter((m) => !HIDDEN_COLUMN_KEYS.has(m.key));
      // Order on the ORIGINAL key before re-keying to the cross-prefixed key,
      // so the v5 order arrays (plain metric keys) still match.
      const crossBasicSrc = orderByKeys(crossSource.filter((m) => !isDetailed(m)), otherBasicOrder);
      const crossDetailedSrc = orderByKeys(crossSource.filter((m) => isDetailed(m)), otherDetailedOrder);
      crossBasic = crossBasicSrc.map((base) => ({ ...base, key: makeCrossKey(other, base.key) }));
      crossDetailed = crossDetailedSrc.map((base) => ({ ...base, key: makeCrossKey(other, base.key) }));
    }

    const ownSections =
      sectionHTML("Basic Stats", ownBasic, formats, visible) +
      sectionHTML("Detailed Stats", ownDetailed, formats, visible) +
      dismissalSectionHTML(ns, formats, visible, dismissal) +
      composerHTML(ns, formats, visible);
    const crossSections =
      sectionHTML("Basic Stats", crossBasic, formats, visible) +
      sectionHTML("Detailed Stats", crossDetailed, formats, visible);

    // Wave A: the Match dropdown's own "Basic Stats" mini-section holds the
    // single consolidated Player Matches row (plain ns only — matchesMetric is
    // null in matchup mode, rendering "" and leaving Match = Impact-only, the
    // pre-Wave-A shape).
    const matchHTML =
      sectionHTML("Basic Stats", matchesMetric ? [matchesMetric] : [], formats, visible) +
      sectionHTML("Impact", impact, formats, visible);

    const dropdowns = [
      { id: "match", label: "Match", html: matchHTML },
      { id: "batting", label: "Batting", html: bucket === "batting" ? ownSections : crossSections },
      { id: "bowling", label: "Bowling", html: bucket === "bowling" ? ownSections : crossSections },
      { id: "fielding", label: "Fielding", html: sectionHTML("Fielding Stats", fielding, formats, visible) },
    ];

    const counts = dropdownCounts(ns);
    const open = (inlineState && inlineState.openDropdown) || null;

    const bar = dropdowns
      .map((d) => {
        const empty = !d.html;
        const isOpen = open === d.id && !empty;
        return `<button type="button" class="cols-dd-trigger${isOpen ? " is-open" : ""}" data-dd="${d.id}" aria-expanded="${isOpen ? "true" : "false"}" aria-controls="cols-dd-panel-${d.id}"${empty ? " disabled" : ""}>
          <span class="cols-dd-name">${d.label}</span>
          <span class="cols-dd-badge">${counts[d.id] || 0}</span>
          <span class="cols-dd-caret" aria-hidden="true">▾</span>
        </button>`;
      })
      .join("");

    const panels = dropdowns
      .map((d) => {
        const isOpen = open === d.id && !!d.html;
        return `<div class="cols-dd-panel" id="cols-dd-panel-${d.id}" data-dd-panel="${d.id}" role="region" aria-label="${d.label} columns"${isOpen ? "" : " hidden"}>${d.html || ""}</div>`;
      })
      .join("");

    return `<div class="cols-dropdowns">
        <div class="cols-dd-bar">${bar}</div>
        <div class="cols-dd-panels">${panels}</div>
      </div>`;
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

  /** W2: wire the per-column Sort-by + Highlight buttons (leaderboard only). No-op
   * when controlsOn is false (the pop-up popover has no such buttons). Each button
   * stops the click from reaching the surrounding row / label, and bails if it's
   * disabled (column hidden). Sort routes through setSort (the two-way-bound host
   * sort path); Highlight toggles the key in the display-only highlighted set. */
  function wireColumnControls(rootEl) {
    if (!controlsOn) return;
    rootEl.querySelectorAll(".col-sort-btn[data-sort-key]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        setSort(btn.dataset.sortKey);
      });
    });
    rootEl.querySelectorAll(".col-hl-btn[data-hl-key]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        const key = btn.dataset.hlKey;
        const cur = getHighlights().slice();
        const idx = cur.indexOf(key);
        if (idx >= 0) cur.splice(idx, 1);
        else cur.push(key);
        setHighlights(cur);
      });
    });
  }

  /** Wave C: wire the count/% (count/per-match) segmented mode controls (leaderboard
   * only). Clicking a segment swaps the shown key of that pair to the segment's form
   * (count or alternate), preserving the column's position, and MIGRATES any active
   * highlight onto the shown form so Highlight keeps working on whichever form is
   * shown. Disabled while the column is hidden (add it first). Sync immediately so
   * the segs + sort/highlight reflect the change before the async requery lands. */
  function wireModeToggles(rootEl) {
    if (!controlsOn) return;
    rootEl.querySelectorAll(".col-mode-seg[data-mode-count]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        const countKey = btn.dataset.modeCount;
        const altKey = btn.dataset.modeAlt;
        const wantKey = btn.dataset.modeTarget === "alt" ? altKey : countKey;
        const cols = getColumns().slice();
        const iCount = cols.indexOf(countKey);
        const iAlt = cols.indexOf(altKey);
        const present = [iCount, iAlt].filter((i) => i >= 0);
        if (present.length === 0) return; // hidden — disabled anyway
        const oldKey = iAlt >= 0 ? altKey : countKey;
        if (wantKey === oldKey) return; // already showing that form
        // Replace in place: drop both variants, insert the wanted one at the earliest
        // index so the column keeps its position (order-sensitive for preset matching).
        const at = Math.min(...present);
        const next = cols.filter((k) => k !== countKey && k !== altKey);
        next.splice(at, 0, wantKey);
        // Migrate an active highlight onto the shown form (Highlight keeps working on
        // whichever form is shown). Display-only — never a query change.
        if (getHighlights && setHighlights) {
          const hls = getHighlights();
          if (hls.includes(oldKey)) setHighlights(hls.map((k) => (k === oldKey ? wantKey : k)));
        }
        setColumns(next);
        syncCheckedState(rootEl);
      });
    });
  }

  /** W2: re-sync the Sort-by + Highlight buttons' state (active / direction /
   * disabled) from the live host state, WITHOUT rebuilding — the counterpart to
   * syncCheckedState for the controls. Called from syncCheckedState so every
   * refresh path keeps them honest (e.g. a header click that moved the sort, or a
   * column newly shown/hidden). No-op when controlsOn is false. */
  function syncColumnControls(rootEl) {
    if (!controlsOn) return;
    const visible = new Set(getColumns());
    const sort = getSort();
    const hl = new Set(getHighlights());
    const ns = getDiscipline();
    // For a toggle row, the sort/highlight controls act on WHICHEVER form is shown:
    // re-derive the active key from the current column list and repoint the button's
    // data-key so a variant swap (e.g. a preset) keeps the controls honest without a
    // full re-render. `data-toggle-count` marks such buttons; the count key is stable.
    const activeKeyFor = (btn, fallback) => {
      const countKey = btn.dataset.toggleCount;
      if (!countKey) return fallback;
      const pair = togglePairByCount(countKey, ns);
      return pair ? activeToggleKey(pair, visible) : fallback;
    };
    rootEl.querySelectorAll(".col-sort-btn[data-sort-key]").forEach((btn) => {
      const key = activeKeyFor(btn, btn.dataset.sortKey);
      btn.dataset.sortKey = key;
      const isVisible = visible.has(key);
      btn.disabled = !isVisible;
      const isActiveSort = !!(sort && sort.active && sort.key === key);
      btn.classList.toggle("is-active", isActiveSort);
      btn.setAttribute("aria-pressed", isActiveSort ? "true" : "false");
      btn.textContent = isActiveSort ? (sort.dir === "asc" ? "▲" : "▼") : "↕";
    });
    rootEl.querySelectorAll(".col-hl-btn[data-hl-key]").forEach((btn) => {
      const key = activeKeyFor(btn, btn.dataset.hlKey);
      btn.dataset.hlKey = key;
      btn.disabled = !visible.has(key);
      const on = hl.has(key);
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    // Wave C: keep the count/% (count/per-match) segmented controls in step too.
    rootEl.querySelectorAll(".col-mode-seg[data-mode-count]").forEach((btn) => {
      const countKey = btn.dataset.modeCount;
      const altKey = btn.dataset.modeAlt;
      const shownAlt = visible.has(altKey);
      const shown = visible.has(countKey) || shownAlt;
      btn.disabled = !shown;
      const active = shown && (btn.dataset.modeTarget === "alt" ? shownAlt : !shownAlt);
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
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

  /** W4: refresh the four count badges from the live column list, WITHOUT
   * rebuilding. No-op in popover mode (no `.cols-dropdowns` present). */
  function updateBadges(rootEl) {
    if (!rootEl.querySelector(".cols-dropdowns")) return;
    const counts = dropdownCounts(getDiscipline());
    rootEl.querySelectorAll(".cols-dd-trigger[data-dd]").forEach((btn) => {
      const badge = btn.querySelector(".cols-dd-badge");
      if (badge) badge.textContent = String(counts[btn.dataset.dd] || 0);
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
      if (cb.dataset.key) {
        cb.checked = visible.has(cb.dataset.key);
      } else if (cb.dataset.countKey) {
        cb.checked = visible.has(cb.dataset.countKey) || visible.has(cb.dataset.pctKey);
      } else if (cb.dataset.toggleCount) {
        // Wave C toggle rows: checked iff EITHER the count or alternate is shown.
        cb.checked = visible.has(cb.dataset.toggleCount) || visible.has(cb.dataset.toggleAlt);
      }
    });
    // W2: keep the Sort-by / Highlight buttons in step too (no-op in the pop-up).
    syncColumnControls(rootEl);
    // W4: keep the four count badges in step too (no-op in the pop-up popover).
    updateBadges(rootEl);
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

  /** Render the leaderboard's inline picker (W4 four-dropdown layout) straight
   * into its host (build + wire). Inline-only: the pop-up popover renders via
   * open() → buildPickerHTML, untouched. */
  function renderInline(container, ns, formats) {
    container.innerHTML = buildDropdownsHTML(ns, formats);
    wireCheckboxes(container);
    wireColumnControls(container); // W2 (no-op unless the sort/highlight contract was supplied)
    wireModeToggles(container); // Wave C count/% (count/per-match) segmented controls
    wireDropdowns(container); // W4
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
    inlineState = { el: container, ns, formats: formats.slice(), openDropdown: disciplineBucket(ns) };
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
        // W4: a discipline switch flips which dropdown holds the OWN columns —
        // default the newly-relevant own dropdown open (a format-only change
        // keeps whatever was open).
        if (ns !== inlineState.ns) inlineState.openDropdown = disciplineBucket(ns);
        renderInline(inlineState.el, ns, formats);
        inlineState.ns = ns;
        inlineState.formats = formats.slice();
      } else {
        syncCheckedState(inlineState.el);
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

    // Same checkbox handlers the popover always had — now shared with the inline
    // host so both surfaces behave identically (see wireCheckboxes). The popover
    // lives on document.body and survives an instant-apply requery via refresh().
    wireCheckboxes(popover);
    wireColumnControls(popover); // W2 (no-op for the pop-up — no sort/highlight contract)

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
