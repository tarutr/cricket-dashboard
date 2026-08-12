// src/addPalette.js
//
// The "+ Add condition" SEARCH PALETTE component (Option C, filter-rejig Wave
// R2, decision 68), extracted from src/drawer.js's mountFilterDrawer closure in
// Wave R3 so more than one surface can mount it (the leaderboard's Advanced
// Filters drawer today; the player pop-up drawer next). This module owns ONLY
// the generic, taxonomy-agnostic machinery:
//   • the palette DOM skeleton (paletteSkeletonHTML)
//   • the leak-free portal (opened doc listeners removed on close)
//   • the list build + search/highlight/▸-drill-down + open/close wiring
// It knows NOTHING about the 7-group taxonomy, the state shape, metrics, or the
// singleton editors — the CALLER supplies a `buildGroups(gi)` function that
// returns the group/leaf/family tree (see drawer.js's buildPaletteGroups for the
// leaderboard's), and every leaf's `run()` closure does the caller's own store
// mutation. So this extraction is behaviour-preserving: drawer.js produces the
// EXACT same palette it did before (numbers sacred — no query path lives here).
//
// The group/item shape `buildGroups(gi)` must return:
//   [{ name, note?, items:[ item… ] }]
//   item = { kind:'leaf', label, disabled?, run } |
//          { kind:'family', label, disabled?, variants:[ leaf… ] }
// (a variant is itself a leaf; a variant may carry `title` to explain a disabled
// state). Identical to what buildPaletteGroups returned inside drawer.js.

import { escHtml, escAttr } from "./html.js";

/** The palette's DOM skeleton for ONE add-condition control (one per numeric
 * group card, addressed by `gi`). Kept here so the component owns both its
 * markup and its wiring; drawer.js's groupCardHTML embeds this verbatim, so the
 * rendered DOM is byte-identical to the pre-extraction inline skeleton. */
export function paletteSkeletonHTML(gi, opts = {}) {
  // R0 Step 2 — ADDITIVE parametrisation. The leaderboard Columns picker mounts this
  // SAME skeleton four times as discipline dropdowns (Match / Batting / Bowling /
  // Fielding), so the toggle's class / label / inner markup / disabled state and the
  // search placeholder + empty text are overridable. EVERY default reproduces the
  // original "+ Add condition" trigger, so the filters-drawer and player-pop-up callers
  // (which call paletteSkeletonHTML(gi) with no opts) render exactly as before.
  const ctlClass = opts.ctlClass || "addctl";
  const toggleClass = opts.toggleClass || "select cond-builder__add-toggle";
  const toggleAttrs = opts.toggleAttrs || "";
  const toggleAriaLabel = opts.toggleAriaLabel || "Add a filter condition";
  const toggleInner =
    opts.toggleInner ||
    `<span class="cond-builder__add-plus" aria-hidden="true">+</span>
              <span class="cond-builder__add-text">Add condition</span>
              <span class="cond-builder__add-caret" aria-hidden="true"></span>`;
  const searchPlaceholder = opts.searchPlaceholder || "Search filters&hellip;";
  const searchAriaLabel = opts.searchAriaLabel || "Search filters";
  const emptyText = opts.emptyText || "No matching filter.";
  return `<div class="${ctlClass}" data-role="add-palette" data-gi="${gi}">
            <button type="button" class="${toggleClass}" data-role="palette-toggle" aria-haspopup="dialog" aria-expanded="false" aria-label="${escAttr(toggleAriaLabel)}"${toggleAttrs}>
              ${toggleInner}
            </button>
            <div class="palette" data-role="palette-panel" hidden>
              <input type="text" class="input palette__search" data-role="palette-search" placeholder="${searchPlaceholder}" autocomplete="off" aria-label="${escAttr(searchAriaLabel)}" />
              <div class="palette__list" data-role="palette-list"></div>
              <div class="palette__empty" data-role="palette-empty" hidden>${escHtml(emptyText)}</div>
            </div>
          </div>`;
}

/**
 * Create a palette component bound to one surface's taxonomy. Returns
 * `{ mountAddPalette, closeCurrent }`:
 *   • mountAddPalette(addctlEl) — build + wire ONE add-condition palette (one per
 *     numeric group card). Call once per `[data-role="add-palette"]` after each
 *     rebuild, exactly as drawer.js's wireNumeric did.
 *   • closeCurrent() — close whichever palette is open (call before wiping the
 *     cards on a rebuild; a portaled-open panel would otherwise orphan on <body>).
 *   • repositionCurrent() — re-anchor the open panel to its trigger after the caller
 *     reflows the layout beneath a kept-open panel (see keepOpenOnPick). No-op if closed.
 *
 * `buildGroups(gi)` returns the group tree for the current state (see the shape
 * note at the top of the file). Each component instance owns its OWN
 * "only-one-open-at-a-time" close tracker, so two surfaces mounting their own
 * component never interfere — identical to the per-mountFilterDrawer closure the
 * tracker lived in before the extraction.
 *
 * `keepOpenOnPick` (R0 Step 2, owner ruling D2): default false = close the palette
 * after a pick (the filters drawer + player pop-up rely on this). The leaderboard
 * Columns picker passes true so its discipline menu STAYS OPEN after adding a column
 * (add several in a row); it closes only on an outside click / Escape / re-toggle.
 */
export function createAddPalette({ buildGroups, keepOpenOnPick = false }) {
  // Only one palette is open at a time (per this component); a rebuild closes it
  // before wiping the DOM (a portaled-open panel would orphan on <body>).
  let currentPaletteClose = null;
  // The open panel's reposition fn (R0 Step 2). With keepOpenOnPick the panel outlives
  // the pick, so a caller that reflows the layout under it (the Columns picker grows its
  // chosen-rows list ABOVE the trigger) can re-anchor the still-open panel to the trigger
  // via repositionCurrent(). null when nothing is open.
  let currentPaletteReposition = null;

  /** Leak-free portal for the palette panel: doc listeners are added on open and
   * REMOVED on close, so re-creating the palette on every numeric rebuild never
   * leaks (unlike wirePortalDropdown, whose doc listeners are permanent — fine for
   * its once-mounted callers, wrong here). Positioning mirrors wirePortalDropdown. */
  function portalPanel(toggleEl, panelEl, { onOpen } = {}) {
    const home = { parent: panelEl.parentNode, next: panelEl.nextSibling };
    let opened = false;
    // #23 (columns-popup rework Wave B): open into a FIXED full-view panel that shows
    // the whole list regardless of where the trigger sits — flipping UP when the
    // natural height doesn't fit below (so an add-menu low in the pop-up no longer
    // opens downward into a cramped sliver). This reuses the GRAPH dropdown technique
    // (src/graph/graph.js `positionFixedPanel`): measure the panel's natural height,
    // pick the side that fits (else the roomier one), and clamp maxHeight to that
    // side's free space with internal scroll. Purely presentational (no query path).
    function position() {
      const r = toggleEl.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      panelEl.style.position = "fixed";
      panelEl.style.zIndex = "1000"; // above the .filters-popup panel (z-index:100)
      panelEl.style.minWidth = `${Math.round(r.width)}px`;
      panelEl.style.maxHeight = ""; // clear any prior clamp so scrollHeight = natural height
      const width = panelEl.offsetWidth || Math.round(r.width);
      const desired = panelEl.scrollHeight;
      let left = Math.min(r.left, window.innerWidth - width - margin);
      left = Math.max(margin, left);
      panelEl.style.left = `${Math.round(left)}px`;
      panelEl.style.right = "auto";
      const spaceBelow = window.innerHeight - r.bottom - gap - margin;
      const spaceAbove = r.top - gap - margin;
      // Down if the natural height fits below; else up if it fits above; else the roomier side.
      let openDown;
      if (spaceBelow >= desired) openDown = true;
      else if (spaceAbove >= desired) openDown = false;
      else openDown = spaceBelow >= spaceAbove;
      if (openDown) {
        panelEl.style.top = `${Math.round(r.bottom + gap)}px`;
        panelEl.style.bottom = "auto";
        panelEl.style.maxHeight = `${Math.max(160, Math.round(spaceBelow))}px`;
      } else {
        panelEl.style.top = "auto";
        panelEl.style.bottom = `${Math.round(window.innerHeight - r.top + gap)}px`;
        panelEl.style.maxHeight = `${Math.max(160, Math.round(spaceAbove))}px`;
      }
      panelEl.style.overflowY = "auto";
    }
    const onScroll = () => { if (opened) position(); };
    const onResize = () => { if (opened) position(); };
    const onDocClick = (e) => {
      if (!opened) return;
      if (panelEl.contains(e.target) || toggleEl === e.target || toggleEl.contains(e.target)) return;
      // R0 Step 2, owner ruling D2: the dismiss click ONLY closes the palette — it is
      // CONSUMED (capture-phase preventDefault + stopPropagation) so it does not also
      // fall through to whatever is underneath (e.g. clicking the Columns-section
      // minimise toggle while a menu is open just closes the menu; a second click
      // would collapse the section). Owner OK'd the consistent filter-side effect.
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    const onKeydown = (e) => {
      if (e.key === "Escape" && opened) { close(); e.stopPropagation(); }
    };
    function open() {
      if (opened || toggleEl.disabled) return;
      if (currentPaletteClose && currentPaletteClose !== close) currentPaletteClose();
      opened = true;
      panelEl.hidden = false;
      document.body.appendChild(panelEl);
      position();
      toggleEl.setAttribute("aria-expanded", "true");
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onKeydown, true);
      currentPaletteClose = close;
      currentPaletteReposition = position;
      if (onOpen) onOpen();
    }
    function close() {
      if (!opened) return;
      opened = false;
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKeydown, true);
      panelEl.hidden = true;
      for (const p of ["position", "zIndex", "minWidth", "top", "left", "right", "bottom", "maxHeight", "overflowY"]) panelEl.style[p] = "";
      if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(panelEl, home.next);
      else home.parent.appendChild(panelEl);
      toggleEl.setAttribute("aria-expanded", "false");
      if (currentPaletteClose === close) currentPaletteClose = null;
      if (currentPaletteReposition === position) currentPaletteReposition = null;
    }
    toggleEl.addEventListener("click", () => { if (opened) close(); else open(); });
    return { open, close };
  }

  /** Build + wire ONE add-condition palette (one per numeric group card). */
  function mountAddPalette(addctlEl) {
    const gi = Number(addctlEl.dataset.gi);
    const toggleEl = addctlEl.querySelector('[data-role="palette-toggle"]');
    const panelEl = addctlEl.querySelector('[data-role="palette-panel"]');
    const searchEl = addctlEl.querySelector('[data-role="palette-search"]');
    const listEl = addctlEl.querySelector('[data-role="palette-list"]');
    const emptyEl = addctlEl.querySelector('[data-role="palette-empty"]');

    const portal = portalPanel(toggleEl, panelEl, {
      onOpen: () => { searchEl.value = ""; resetFilter(); searchEl.focus(); },
    });
    // D2: when keepOpenOnPick is set (Columns picker), a pick runs WITHOUT closing so
    // several columns can be added in a row; otherwise close-then-run (filters / pop-up).
    const doPick = keepOpenOnPick ? (run) => { run(); } : (run) => { portal.close(); run(); };

    // ── list DOM ────────────────────────────────────────────────────────────────
    const labelHTML = (label) =>
      `<span class="palette__row-label" data-text="${escAttr(label)}">${escHtml(label)}</span>`;
    for (const g of buildGroups(gi)) {
      const groupEl = document.createElement("div");
      groupEl.className = "palette__group";
      const header = document.createElement("div");
      header.className = "palette__group-header";
      header.innerHTML = `${escHtml(g.name)}${g.note ? `<span class="palette__group-note"> (${escHtml(g.note)})</span>` : ""}`;
      groupEl.appendChild(header);

      for (const item of g.items) {
        if (item.kind === "family") {
          const row = document.createElement("button");
          row.type = "button";
          row.className = `palette__row palette__row--family${item.disabled ? " is-disabled" : ""}`;
          row.dataset.label = item.label.toLowerCase();
          row.setAttribute("aria-expanded", "false");
          row.innerHTML = `${labelHTML(item.label)}<span class="palette__chevron" aria-hidden="true">›</span>`;
          groupEl.appendChild(row);
          const wrap = document.createElement("div");
          wrap.className = "palette__variants";
          wrap.hidden = true;
          for (const v of item.variants) {
            const vRow = document.createElement("button");
            vRow.type = "button";
            vRow.className = `palette__variant-row${v.disabled ? " is-disabled" : ""}`;
            vRow.dataset.label = v.label.toLowerCase();
            vRow.innerHTML = labelHTML(v.label);
            // A disabled variant may carry a `title` explaining WHY (e.g. Fielding
            // Wicket Type ▸ "Caught & bowled" — no separate fielding count yet).
            if (v.title) vRow.title = v.title;
            if (!v.disabled) vRow.addEventListener("click", (e) => { e.stopPropagation(); doPick(v.run); });
            wrap.appendChild(vRow);
          }
          groupEl.appendChild(wrap);
          if (!item.disabled) {
            row.addEventListener("click", () => {
              const willOpen = wrap.hidden;
              wrap.hidden = !willOpen;
              row.classList.toggle("is-open", willOpen);
              row.setAttribute("aria-expanded", String(willOpen));
            });
          }
        } else {
          const row = document.createElement("button");
          row.type = "button";
          row.className = `palette__row${item.disabled ? " is-disabled" : ""}`;
          row.dataset.label = item.label.toLowerCase();
          row.innerHTML = labelHTML(item.label);
          if (!item.disabled) row.addEventListener("click", () => doPick(item.run));
          groupEl.appendChild(row);
        }
      }
      listEl.appendChild(groupEl);
    }

    // ── search / highlight ────────────────────────────────────────────────────
    const labelSpan = (rowEl) => rowEl.querySelector(".palette__row-label");
    const clearHi = (rowEl) => { const sp = labelSpan(rowEl); if (sp) sp.textContent = sp.dataset.text; };
    const highlight = (rowEl, q) => {
      const sp = labelSpan(rowEl); if (!sp) return;
      const text = sp.dataset.text;
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) { sp.textContent = text; return; }
      sp.innerHTML = `${escHtml(text.slice(0, i))}<mark>${escHtml(text.slice(i, i + q.length))}</mark>${escHtml(text.slice(i + q.length))}`;
    };
    function resetFilter() {
      listEl.querySelectorAll(".palette__row, .palette__variant-row").forEach((r) => { r.style.display = ""; clearHi(r); });
      listEl.querySelectorAll(".palette__variants").forEach((v) => { v.hidden = true; });
      listEl.querySelectorAll(".palette__row--family").forEach((r) => { r.classList.remove("is-open"); r.setAttribute("aria-expanded", "false"); });
      listEl.querySelectorAll(".palette__group").forEach((g) => { g.style.display = ""; });
      emptyEl.hidden = true;
      listEl.style.display = "";
    }
    function filterList(query) {
      const q = query.trim().toLowerCase();
      if (!q) { resetFilter(); return; }
      let any = false;
      listEl.querySelectorAll(".palette__group").forEach((groupEl) => {
        let groupHas = false;
        groupEl.querySelectorAll(":scope > .palette__row").forEach((row) => {
          const isFamily = row.classList.contains("palette__row--family");
          const wrap = isFamily ? row.nextElementSibling : null;
          const selfMatch = row.dataset.label.includes(q);
          let variantMatch = false;
          if (wrap && wrap.classList.contains("palette__variants")) {
            wrap.querySelectorAll(".palette__variant-row").forEach((vRow) => {
              const show = selfMatch || vRow.dataset.label.includes(q);
              vRow.style.display = show ? "" : "none";
              if (vRow.dataset.label.includes(q)) { variantMatch = true; highlight(vRow, q); } else clearHi(vRow);
            });
            // Owner fix (2026-08-12): sub-options must never render inline until the
            // parent entry is PICKED (clicked) — a search match, even one that lands
            // on a variant, must NOT auto-open the family. The family row itself still
            // surfaces below (selfMatch || variantMatch) so it stays findable by typing
            // either its own name or a variant's; opening it stays a manual click, same
            // as the collapsed default. (Which variants end up display:none above is
            // still useful: if the row is later clicked open, it reflects the last
            // search rather than dumping every variant back in.)
            wrap.hidden = true;
            row.classList.remove("is-open");
            row.setAttribute("aria-expanded", "false");
          }
          const show = selfMatch || variantMatch;
          row.style.display = show ? "" : "none";
          if (selfMatch) highlight(row, q); else clearHi(row);
          if (show) groupHas = true;
        });
        groupEl.style.display = groupHas ? "" : "none";
        if (groupHas) any = true;
      });
      emptyEl.hidden = any;
      listEl.style.display = any ? "" : "none";
    }
    function pickFirstVisible() {
      for (const r of listEl.querySelectorAll(".palette__row, .palette__variant-row")) {
        if (r.style.display === "none" || r.classList.contains("is-disabled") || r.classList.contains("palette__row--family")) continue;
        // A variant row can carry style.display:"" (it matched the search) while its
        // family stays collapsed (owner fix above never auto-opens it) — offsetParent
        // catches that "matched but not actually shown" case so Enter can't act on an
        // option the user never saw, matching the same pick-then-choose rule.
        if (!r.offsetParent) continue;
        r.click();
        return;
      }
    }
    searchEl.addEventListener("input", () => filterList(searchEl.value));
    searchEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); pickFirstVisible(); }
      else if (e.key === "Escape") { e.stopPropagation(); portal.close(); toggleEl.focus(); }
    });
  }

  function closeCurrent() {
    if (currentPaletteClose) currentPaletteClose();
  }

  /** Re-anchor the currently-open panel to its trigger (R0 Step 2). No-op when nothing
   * is open. Callers that reflow the layout under a kept-open panel (the Columns picker)
   * call this after the reflow so the panel follows its trigger. */
  function repositionCurrent() {
    if (currentPaletteReposition) currentPaletteReposition();
  }

  return { mountAddPalette, closeCurrent, repositionCurrent };
}
