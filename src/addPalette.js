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
export function paletteSkeletonHTML(gi) {
  return `<div class="addctl" data-role="add-palette" data-gi="${gi}">
            <button type="button" class="select cond-builder__add-toggle" data-role="palette-toggle" aria-haspopup="dialog" aria-expanded="false" aria-label="Add a filter condition">
              <span class="cond-builder__add-plus" aria-hidden="true">+</span>
              <span class="cond-builder__add-text">Add condition</span>
              <span class="cond-builder__add-caret" aria-hidden="true"></span>
            </button>
            <div class="palette" data-role="palette-panel" hidden>
              <input type="text" class="input palette__search" data-role="palette-search" placeholder="Search filters&hellip;" autocomplete="off" aria-label="Search filters" />
              <div class="palette__list" data-role="palette-list"></div>
              <div class="palette__empty" data-role="palette-empty" hidden>No matching filter.</div>
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
 *
 * `buildGroups(gi)` returns the group tree for the current state (see the shape
 * note at the top of the file). Each component instance owns its OWN
 * "only-one-open-at-a-time" close tracker, so two surfaces mounting their own
 * component never interfere — identical to the per-mountFilterDrawer closure the
 * tracker lived in before the extraction.
 */
export function createAddPalette({ buildGroups }) {
  // Only one palette is open at a time (per this component); a rebuild closes it
  // before wiping the DOM (a portaled-open panel would orphan on <body>).
  let currentPaletteClose = null;

  /** Leak-free portal for the palette panel: doc listeners are added on open and
   * REMOVED on close, so re-creating the palette on every numeric rebuild never
   * leaks (unlike wirePortalDropdown, whose doc listeners are permanent — fine for
   * its once-mounted callers, wrong here). Positioning mirrors wirePortalDropdown. */
  function portalPanel(toggleEl, panelEl, { onOpen } = {}) {
    const home = { parent: panelEl.parentNode, next: panelEl.nextSibling };
    let opened = false;
    function position() {
      const r = toggleEl.getBoundingClientRect();
      const margin = 8;
      panelEl.style.position = "fixed";
      panelEl.style.zIndex = "1000"; // above the .filters-popup panel (z-index:100)
      panelEl.style.minWidth = `${Math.round(r.width)}px`;
      panelEl.style.top = `${Math.round(r.bottom + 6)}px`;
      const width = panelEl.offsetWidth || Math.round(r.width);
      let left = Math.min(r.left, window.innerWidth - width - margin);
      left = Math.max(margin, left);
      panelEl.style.left = `${Math.round(left)}px`;
      panelEl.style.right = "auto";
      const maxH = Math.max(160, Math.round(window.innerHeight - (r.bottom + 6) - margin));
      panelEl.style.maxHeight = `${maxH}px`;
      panelEl.style.overflowY = "auto";
    }
    const onScroll = () => { if (opened) position(); };
    const onResize = () => { if (opened) position(); };
    const onDocClick = (e) => {
      if (!opened) return;
      if (panelEl.contains(e.target) || toggleEl === e.target || toggleEl.contains(e.target)) return;
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
      for (const p of ["position", "zIndex", "minWidth", "top", "left", "right", "maxHeight", "overflowY"]) panelEl.style[p] = "";
      if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(panelEl, home.next);
      else home.parent.appendChild(panelEl);
      toggleEl.setAttribute("aria-expanded", "false");
      if (currentPaletteClose === close) currentPaletteClose = null;
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
    const doPick = (run) => { portal.close(); run(); };

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
            const open = selfMatch || variantMatch;
            wrap.hidden = !open;
            row.classList.toggle("is-open", open);
            row.setAttribute("aria-expanded", String(open));
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

  return { mountAddPalette, closeCurrent };
}
