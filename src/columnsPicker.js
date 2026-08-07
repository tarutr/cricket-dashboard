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
import { DISMISSAL_KINDS, metricDisplayLabel } from "./metrics.js";
import { eligibleMetrics } from "./state.js";

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
  function columnControlsHTML(key) {
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
    return `<span class="columns-popover__item-controls">
      <button type="button" class="col-sort-btn${isActiveSort ? " is-active" : ""}" data-sort-key="${key}" aria-pressed="${isActiveSort ? "true" : "false"}" title="${sortTitle}" aria-label="${sortTitle}"${dis}>${sortArrow}</button>
      <button type="button" class="col-hl-btn${hlOn ? " is-active" : ""}" data-hl-key="${key}" aria-pressed="${hlOn ? "true" : "false"}" title="${hlTitle}" aria-label="${hlTitle}"${dis}>${HIGHLIGHT_GLYPH}</button>
    </span>`;
  }

  /** Build the picker's inner HTML for a namespace/format selection: the same
   * Basic / Dismissals / Fielding / Impact / Phase sections the floating popover
   * always rendered. Reads the CURRENT visible column list (getColumns) for
   * checked state. Pure string builder — no DOM, no listeners. */
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

    // One metric row: the checkbox label, optionally followed (W2, leaderboard
    // only) by the per-column Sort-by + Highlight controls. The controls sit
    // OUTSIDE the <label> so a click on them never toggles the checkbox. The
    // batting Dismissals dual-key rows deliberately DON'T get these (they render
    // via dismissalRowHTML, not this helper) — their active count/% variant is
    // ambiguous from the row alone; those columns stay sortable via the table
    // header. See the report's flagged follow-up.
    const itemRow = (m) => {
      const label = `<label class="columns-popover__item">
        <input type="checkbox" data-key="${m.key}" ${visible.has(m.key) ? "checked" : ""} />
        <span>${metricDisplayLabel(m, formats)}</span>
      </label>`;
      return controlsOn
        ? `<div class="columns-popover__item-row">${label}${columnControlsHTML(m.key)}</div>`
        : label;
    };

    const section = (label, metrics) =>
      metrics.length
        ? `<div class="columns-popover__section-label">${label}</div>
           <div class="columns-popover__list">
             ${metrics.map(itemRow).join("")}
           </div>`
        : "";

    // Dismissals: the pruned real/rare + "Show as %" layout, batting ONLY (see
    // the RARE_DISMISSAL_KINDS doc comment for why every other namespace keeps
    // the plain `section()` list — they never had the 24-checkbox problem).
    let dismissalHTML;
    if (ns === "batting") {
      const showPct = computeInitialShowPct(getColumns());
      const realKinds = DISMISSAL_KINDS.filter((d) => !RARE_DISMISSAL_KINDS.has(d.kind));
      const rareKinds = DISMISSAL_KINDS.filter((d) => RARE_DISMISSAL_KINDS.has(d.kind));
      dismissalHTML = `
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
    } else {
      dismissalHTML = section("Dismissals", dismissal);
    }

    return (
      section("Basic", basic) +
      dismissalHTML +
      section("Fielding", fielding) +
      section("Impact", impact) +
      section("Phase", phase)
    );
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
    rootEl.querySelectorAll(".col-sort-btn[data-sort-key]").forEach((btn) => {
      const key = btn.dataset.sortKey;
      const isVisible = visible.has(key);
      btn.disabled = !isVisible;
      const isActiveSort = !!(sort && sort.active && sort.key === key);
      btn.classList.toggle("is-active", isActiveSort);
      btn.setAttribute("aria-pressed", isActiveSort ? "true" : "false");
      btn.textContent = isActiveSort ? (sort.dir === "asc" ? "▲" : "▼") : "↕";
    });
    rootEl.querySelectorAll(".col-hl-btn[data-hl-key]").forEach((btn) => {
      const key = btn.dataset.hlKey;
      btn.disabled = !visible.has(key);
      const on = hl.has(key);
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
      if (cb.dataset.key) {
        cb.checked = visible.has(cb.dataset.key);
      } else if (cb.dataset.countKey) {
        cb.checked = visible.has(cb.dataset.countKey) || visible.has(cb.dataset.pctKey);
      }
    });
    // W2: keep the Sort-by / Highlight buttons in step too (no-op in the pop-up).
    syncColumnControls(rootEl);
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

  /** Render the picker straight into an inline host (build + wire). */
  function renderInline(container, ns, formats) {
    container.innerHTML = buildPickerHTML(ns, formats);
    wireCheckboxes(container);
    wireColumnControls(container); // W2 (no-op unless the sort/highlight contract was supplied)
  }

  /**
   * INLINE mount (W1): render the picker into a fixed host element (the
   * leaderboard popup's "Columns" section) and remember it so refresh() keeps it
   * honest. Idempotent — re-mounting simply re-renders. Distinct from mount(),
   * which wires a trigger button to OPEN a floating popover; a given picker
   * instance uses one mode or the other, never both.
   */
  function mountInline(container) {
    if (!container) return;
    const ns = getDiscipline();
    const formats = getFormats();
    renderInline(container, ns, formats);
    inlineState = { el: container, ns, formats: formats.slice() };
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
