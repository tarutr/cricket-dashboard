// src/searchSelect.js
//
// ONE reusable single-pick searchable dropdown (Design Round 2, wave R2-2a).
// The owner wants every dropdown/search in the app to behave like the header
// player search (src/omnisearch.js): a control you click to open a small
// popover with a text filter at the top and a scrollable, filterable list of
// options you pick by click OR keyboard — instead of a native <select> whose
// only affordance is letter-jumping.
//
// This module mimics omnisearch's UX (dropdown render, keyboard nav,
// outside-click close, request-token guard for async) but for a SINGLE choice
// from a bounded option set, and it works two ways:
//   • STATIC   — pass `options`: an array of {value, label, hintSuffix?,
//                disabled?}. Used by the graph's chart-type + every per-type
//                metric picker.
//   • ASYNC    — pass `fetchOptions`: an async () => (array of the same shape,
//                OR plain strings, which are normalised to {value:s,label:s}).
//                Used by the donut team picker, whose option set depends on a
//                query. `onLoad(values)` fires once the fetch resolves so the
//                caller can reconcile the current pick against the fresh set.
//
// Accessibility: the toggle is a real <button> with aria-haspopup="listbox" +
// aria-expanded; the popover is a combobox (a filter <input> that owns
// aria-activedescendant) over a role="listbox" of role="option" rows. Arrow
// keys move the active row, Enter picks it, Escape closes and returns focus to
// the toggle. Fully keyboard- and touch-operable.
//
// Returns a small handle — { setValue, setOptions, getValue, setInvalid, open,
// close, destroy } — so a caller (graph.js) can drive it after mount (update
// options after an async fetch, reflect a programmatic value change, toggle the
// red "needs input" outline, or tear it down before rebuilding its host).

import { escHtml } from "./html.js";

let uidCounter = 0;

/** Normalise an options array shared by both variants: plain strings become
 * {value:s,label:s}; entries without a value are dropped. */
function normalizeOptions(opts) {
  if (!Array.isArray(opts)) return [];
  return opts.map((o) => (typeof o === "string" ? { value: o, label: o } : o)).filter((o) => o && o.value != null);
}

/**
 * Turn `hostEl` into a searchable single-select dropdown.
 *
 * @param {HTMLElement} hostEl
 * @param {object} opts
 * @param {Array<{value:string,label:string,hintSuffix?:string,disabled?:boolean}>} [opts.options]
 * @param {() => Promise<Array>} [opts.fetchOptions] async option source (array of the above shape or plain strings)
 * @param {(values:string[]) => void} [opts.onLoad] called after fetchOptions resolves, with the loaded values
 * @param {string|null} [opts.value] initially-selected value
 * @param {string} [opts.placeholder]
 * @param {string} [opts.filterPlaceholder]
 * @param {(value:string|null) => void} [opts.onChange]
 * @param {string} [opts.ariaLabel]
 * @param {boolean} [opts.disabled]
 * @param {(opt:object) => string} [opts.renderRow] custom option-row inner HTML
 * @param {boolean} [opts.portal] lift the OPEN panel to <body> (position:fixed,
 *   placed under the toggle, repositioned on scroll/resize) so it escapes a
 *   clipping `overflow` ancestor — same technique as mountSearchMultiSelect's
 *   own `portal` option below (added for src/playerFilters.js's popup drawer,
 *   whose panel is `overflow-y: auto`, Wave C item 4f).
 * @returns {{setValue:Function,setOptions:Function,getValue:Function,setInvalid:Function,open:Function,close:Function,destroy:Function}}
 */
export function mountSearchSelect(hostEl, {
  options = null,
  fetchOptions = null,
  onLoad = null,
  value = null,
  placeholder = "Choose…",
  filterPlaceholder = "Type to filter…",
  onChange = () => {},
  ariaLabel = null,
  disabled = false,
  renderRow = null,
  allowEmptyLabel = null,
  portal = false,
} = {}) {
  const uid = `ssel-${++uidCounter}`;
  let allOptions = normalizeOptions(options);
  let currentValue = value;
  let isOpen = false;
  let activeIndex = -1; // index into the CURRENTLY-FILTERED list
  let filtered = [];
  let destroyed = false;
  let fetchToken = 0;

  hostEl.classList.add("search-select");
  hostEl.innerHTML = `
    <button type="button" class="select search-select__toggle" aria-haspopup="listbox" aria-expanded="false"${ariaLabel ? ` aria-label="${escHtml(ariaLabel)}"` : ""}${disabled ? " disabled" : ""}>
      <span class="search-select__value"></span>
      <span class="search-select__caret" aria-hidden="true"></span>
    </button>
    <div class="search-select__panel" hidden>
      <input type="text" class="input search-select__filter" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${uid}-list" placeholder="${escHtml(filterPlaceholder)}" aria-label="${escHtml(ariaLabel ? `Filter ${ariaLabel.toLowerCase()}` : "Filter options")}" />
      <div class="search-select__list" id="${uid}-list" role="listbox"${ariaLabel ? ` aria-label="${escHtml(ariaLabel)}"` : ""}></div>
    </div>
  `;

  const toggleEl = hostEl.querySelector(".search-select__toggle");
  const valueEl = hostEl.querySelector(".search-select__value");
  const panelEl = hostEl.querySelector(".search-select__panel");
  const filterEl = hostEl.querySelector(".search-select__filter");
  const listEl = hostEl.querySelector(".search-select__list");

  function optionByValue(v) {
    return allOptions.find((o) => o.value === v) || null;
  }

  function displayLabel(o) {
    if (!o) return "";
    return o.hintSuffix ? `${o.label} ${o.hintSuffix}` : o.label;
  }

  function syncToggleLabel() {
    const o = optionByValue(currentValue);
    if (o) {
      valueEl.textContent = displayLabel(o);
      valueEl.classList.remove("search-select__value--placeholder");
    } else if (currentValue != null && allOptions.length === 0) {
      // Async source whose options haven't loaded yet: show the raw value as a
      // best-effort label so a re-render doesn't flash the placeholder over an
      // existing pick (donut team — value === team name). Once fetchOptions
      // resolves this resolves to the real option label.
      valueEl.textContent = String(currentValue);
      valueEl.classList.remove("search-select__value--placeholder");
    } else {
      valueEl.textContent = placeholder;
      valueEl.classList.add("search-select__value--placeholder");
    }
  }

  // The synthetic "clear" row (native-<select> placeholder parity): picking it
  // sets the value back to null and fires onChange(null). Value null, marked
  // __empty so choose() can special-case it; it participates in text filtering
  // by its own label like any other row.
  function emptyRow() {
    return { value: null, label: allowEmptyLabel, __empty: true };
  }

  function applyFilter(term) {
    const t = term.trim().toLowerCase();
    const matches = t ? allOptions.filter((o) => o.label.toLowerCase().includes(t)) : allOptions.slice();
    const empties = allowEmptyLabel && (!t || allowEmptyLabel.toLowerCase().includes(t)) ? [emptyRow()] : [];
    filtered = [...empties, ...matches];
  }

  function rowInnerHTML(o) {
    if (renderRow) return renderRow(o);
    const suffix = o.hintSuffix
      ? `<span class="search-select__hint">${escHtml(o.hintSuffix)}</span>`
      : "";
    return `<span class="search-select__opt-label">${escHtml(o.label)}</span>${suffix}`;
  }

  // ── Optional portal (ported from mountSearchMultiSelect's `portal` option
  // below — see this function's own JSDoc `portal` note) ───────────────────
  // Lifts the OPEN panel to <body> so it escapes a clipping `overflow`
  // ancestor (e.g. src/playerFilters.js's popup drawer, `overflow-y: auto`).
  // Non-portal callers (graph.js) leave this whole block inert.
  const panelHome = { parent: panelEl.parentNode, next: panelEl.nextSibling };
  let portaled = false;
  function positionPanel() {
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
    // Direction by fit: open below when the panel's natural height fits below;
    // else flip ABOVE when it fits above; else use the roomier side. So a toggle
    // low on the page opens upward instead of running off the bottom of the
    // window (owner R6b/R6c). Height is clamped to the chosen side, with scroll.
    const spaceBelow = window.innerHeight - r.bottom - gap - margin;
    const spaceAbove = r.top - gap - margin;
    let openDown;
    if (spaceBelow >= desired) openDown = true;
    else if (spaceAbove >= desired) openDown = false;
    else openDown = spaceBelow >= spaceAbove;
    if (openDown) {
      panelEl.style.top = `${Math.round(r.bottom + gap)}px`;
      panelEl.style.bottom = "auto";
      panelEl.style.maxHeight = `${Math.max(120, Math.round(spaceBelow))}px`;
    } else {
      panelEl.style.top = "auto";
      panelEl.style.bottom = `${Math.round(window.innerHeight - r.top + gap)}px`;
      panelEl.style.maxHeight = `${Math.max(120, Math.round(spaceAbove))}px`;
    }
    panelEl.style.overflowY = "auto";
  }
  const onPortalScroll = () => { if (portaled) positionPanel(); };
  const onPortalResize = () => { if (portaled) positionPanel(); };
  function portalOpen() {
    if (!portal || portaled) return;
    portaled = true;
    document.body.appendChild(panelEl);
    positionPanel();
    window.addEventListener("scroll", onPortalScroll, true);
    window.addEventListener("resize", onPortalResize);
  }
  function portalClose() {
    if (!portaled) return;
    portaled = false;
    window.removeEventListener("scroll", onPortalScroll, true);
    window.removeEventListener("resize", onPortalResize);
    for (const p of ["position", "zIndex", "minWidth", "top", "left", "right", "bottom", "maxHeight", "overflowY"]) {
      panelEl.style[p] = "";
    }
    if (panelHome.next && panelHome.next.parentNode === panelHome.parent) {
      panelHome.parent.insertBefore(panelEl, panelHome.next);
    } else {
      panelHome.parent.appendChild(panelEl);
    }
  }

  function renderList() {
    if (filtered.length === 0) {
      listEl.innerHTML = `<p class="search-select__empty">No matches</p>`;
      filterEl.removeAttribute("aria-activedescendant");
      return;
    }
    listEl.innerHTML = filtered
      .map((o, i) => {
        const selected = o.value === currentValue;
        const active = i === activeIndex;
        return (
          `<div id="${uid}-opt-${i}" class="search-select__option${active ? " is-active" : ""}${selected ? " is-selected" : ""}${o.disabled ? " is-disabled" : ""}${o.__empty ? " search-select__option--empty" : ""}"` +
          ` role="option" aria-selected="${selected}" data-idx="${i}">${rowInnerHTML(o)}</div>`
        );
      })
      .join("");
    if (activeIndex >= 0 && activeIndex < filtered.length) {
      filterEl.setAttribute("aria-activedescendant", `${uid}-opt-${activeIndex}`);
      const activeEl = listEl.querySelector(".search-select__option.is-active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    } else {
      filterEl.removeAttribute("aria-activedescendant");
    }
    // The list height changes as options/filter change — keep a portaled panel
    // pinned under its toggle (no-op unless portaled).
    if (portaled) positionPanel();
  }

  function open() {
    if (isOpen || disabled) return;
    isOpen = true;
    panelEl.hidden = false;
    toggleEl.setAttribute("aria-expanded", "true");
    filterEl.setAttribute("aria-expanded", "true");
    filterEl.value = "";
    applyFilter("");
    // Start the highlight on the current selection so Enter re-picks it and
    // Arrow keys move relative to it (falls back to the first row).
    const selIdx = filtered.findIndex((o) => o.value === currentValue);
    activeIndex = selIdx >= 0 ? selIdx : filtered.length ? 0 : -1;
    renderList();
    portalOpen(); // reparent to <body> BEFORE focus so focus is preserved
    // Focus the filter so typing filters immediately (same as omnisearch).
    filterEl.focus();
  }

  function close({ focusToggle = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    panelEl.hidden = true;
    toggleEl.setAttribute("aria-expanded", "false");
    filterEl.setAttribute("aria-expanded", "false");
    filterEl.removeAttribute("aria-activedescendant");
    activeIndex = -1;
    portalClose(); // restore the panel to its in-host slot
    if (focusToggle) toggleEl.focus();
  }

  function choose(idx) {
    const o = filtered[idx];
    if (!o || o.disabled) return;
    const changed = o.value !== currentValue;
    currentValue = o.value;
    syncToggleLabel();
    close({ focusToggle: true });
    if (changed) onChange(currentValue);
  }

  function moveActive(delta) {
    if (filtered.length === 0) return;
    if (activeIndex === -1) {
      activeIndex = delta > 0 ? 0 : filtered.length - 1;
    } else {
      activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
    }
    renderList();
  }

  // ── Events ──────────────────────────────────────────────────────────────
  function onToggleClick(e) {
    e.stopPropagation();
    if (isOpen) close({ focusToggle: true });
    else open();
  }
  function onToggleKeydown(e) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      open();
    }
  }
  function onFilterInput() {
    applyFilter(filterEl.value);
    activeIndex = filtered.length ? 0 : -1;
    renderList();
  }
  function onFilterKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0) choose(activeIndex);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // When portaled inside a scrolling popup (e.g. src/playerFilters.js's
      // Filters drawer), keep this Escape from bubbling to the popup's own
      // document-level Escape handler (which would close the whole popup) —
      // mirrors mountSearchMultiSelect's identical guard.
      if (portal) e.stopPropagation();
      close({ focusToggle: true });
    } else if (e.key === "Tab") {
      close();
    }
  }
  function onListClick(e) {
    const row = e.target.closest(".search-select__option");
    if (!row) return;
    choose(Number(row.dataset.idx));
  }
  function onDocClick(e) {
    if (!isOpen) return;
    // A portaled panel lives on <body>, OUTSIDE hostEl — so also treat clicks
    // within the panel itself as "inside" (harmless when not portaled, since
    // the panel is a hostEl descendant then and hostEl.contains already covers it).
    if (hostEl.contains(e.target) || panelEl.contains(e.target)) return;
    close();
  }

  toggleEl.addEventListener("click", onToggleClick);
  toggleEl.addEventListener("keydown", onToggleKeydown);
  filterEl.addEventListener("input", onFilterInput);
  filterEl.addEventListener("keydown", onFilterKeydown);
  listEl.addEventListener("click", onListClick);
  document.addEventListener("click", onDocClick);

  // ── Async option source ───────────────────────────────────────────────────
  async function loadAsync() {
    const myToken = ++fetchToken;
    let result = [];
    try {
      result = await fetchOptions();
    } catch {
      result = []; // degrade to "no options" — never a stuck/broken control
    }
    if (destroyed || myToken !== fetchToken) return; // superseded / torn down
    allOptions = normalizeOptions(result);
    if (isOpen) {
      applyFilter(filterEl.value);
      activeIndex = filtered.length ? 0 : -1;
    }
    syncToggleLabel();
    if (isOpen) renderList();
    if (onLoad) onLoad(allOptions.map((o) => o.value));
  }

  // Initial paint.
  syncToggleLabel();
  if (fetchOptions) loadAsync();

  // ── Handle ──────────────────────────────────────────────────────────────
  return {
    setValue(v) {
      currentValue = v == null ? null : v;
      syncToggleLabel();
      if (isOpen) renderList();
    },
    setOptions(opts) {
      allOptions = normalizeOptions(opts);
      // Value may no longer resolve — the toggle then falls back to placeholder;
      // callers own any prune/onChange decision (this never fires onChange).
      syncToggleLabel();
      if (isOpen) {
        applyFilter(filterEl.value);
        activeIndex = filtered.length ? 0 : -1;
        renderList();
      }
    },
    getValue() {
      return currentValue;
    },
    setInvalid(on) {
      toggleEl.classList.toggle("needs-input", !!on);
    },
    open,
    close,
    destroy() {
      destroyed = true;
      close();
      portalClose(); // idempotent — never leave an orphaned panel on <body>
      toggleEl.removeEventListener("click", onToggleClick);
      toggleEl.removeEventListener("keydown", onToggleKeydown);
      filterEl.removeEventListener("input", onFilterInput);
      filterEl.removeEventListener("keydown", onFilterKeydown);
      listEl.removeEventListener("click", onListClick);
      document.removeEventListener("click", onDocClick);
    },
  };
}

/**
 * Turn `hostEl` into a searchable MULTI-select dropdown (Design Round 2, wave
 * R2-2b-i). Sibling of mountSearchSelect above: same typeahead filter box +
 * scrollable list (15rem cap, internal scroll) + keyboard nav + outside-click
 * close, but rows TOGGLE instead of pick. Clicking (or Enter/Space on the active
 * row) toggles a value and the panel STAYS OPEN so several can be checked in one
 * pass; the toggle shows a caller-controlled summary ("N of M metrics") or the
 * placeholder when nothing is selected. `onChange(values[])` fires with the full
 * selection (in OPTIONS order — stable regardless of tick order) after each
 * toggle.
 *
 * Min/max are the CALLER's business (brief): pass `isOptionDisabled(value,
 * selectedSet)` to grey a row that can't currently be toggled (e.g. an unchecked
 * row once a max is reached, or a checked row at the min floor) and an optional
 * `noteFor(selectedSet)` string shown atop the panel. A disabled row ignores
 * clicks/keys, so the component never hard-blocks on its own — it just reflects
 * the caller's rule.
 *
 * Accessibility: real <button> toggle (aria-haspopup="listbox" + aria-expanded);
 * a combobox filter <input> owning aria-activedescendant over a
 * role="listbox" aria-multiselectable="true" of role="option" aria-selected rows.
 *
 * @param {HTMLElement} hostEl
 * @param {object} opts
 * @param {Array<{value:string,label:string,hintSuffix?:string,disabled?:boolean}>} [opts.options]
 * @param {string[]} [opts.values] initially-selected values
 * @param {string} [opts.placeholder] toggle text when nothing is selected
 * @param {string} [opts.filterPlaceholder]
 * @param {(count:number,total:number)=>string} [opts.summarize] toggle text when >=1 selected
 * @param {(values:string[]) => void} [opts.onChange]
 * @param {(value:string, selected:Set<string>) => boolean} [opts.isOptionDisabled]
 * @param {(selected:Set<string>) => (string|null)} [opts.noteFor] panel note (e.g. an at-cap hint)
 * @param {string} [opts.ariaLabel]
 * @param {boolean} [opts.disabled]
 * @param {(opt:object) => string} [opts.renderRow] custom option-row inner HTML
 * @returns {{setValues:Function,getValues:Function,setOptions:Function,setInvalid:Function,open:Function,close:Function,destroy:Function}}
 */
export function mountSearchMultiSelect(hostEl, {
  options = [],
  values = [],
  placeholder = "Choose…",
  filterPlaceholder = "Type to filter…",
  summarize = (count, total) => `${count} of ${total} selected`,
  onChange = () => {},
  isOptionDisabled = null,
  noteFor = null,
  ariaLabel = null,
  disabled = false,
  renderRow = null,
  portal = false,
} = {}) {
  const uid = `smsel-${++uidCounter}`;
  let allOptions = normalizeOptions(options);
  let selected = new Set(values.filter((v) => allOptions.some((o) => o.value === v)));
  let isOpen = false;
  let activeIndex = -1; // index into the CURRENTLY-FILTERED list
  let filtered = [];

  hostEl.classList.add("search-select", "search-select--multi");
  hostEl.innerHTML = `
    <button type="button" class="select search-select__toggle" aria-haspopup="listbox" aria-expanded="false"${ariaLabel ? ` aria-label="${escHtml(ariaLabel)}"` : ""}${disabled ? " disabled" : ""}>
      <span class="search-select__value"></span>
      <span class="search-select__caret" aria-hidden="true"></span>
    </button>
    <div class="search-select__panel" hidden>
      <input type="text" class="input search-select__filter" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${uid}-list" placeholder="${escHtml(filterPlaceholder)}" aria-label="${escHtml(ariaLabel ? `Filter ${ariaLabel.toLowerCase()}` : "Filter options")}" />
      <p class="search-select__note" role="note" hidden></p>
      <div class="search-select__list" id="${uid}-list" role="listbox" aria-multiselectable="true"${ariaLabel ? ` aria-label="${escHtml(ariaLabel)}"` : ""}></div>
    </div>
  `;

  const toggleEl = hostEl.querySelector(".search-select__toggle");
  const valueEl = hostEl.querySelector(".search-select__value");
  const panelEl = hostEl.querySelector(".search-select__panel");
  const filterEl = hostEl.querySelector(".search-select__filter");
  const noteEl = hostEl.querySelector(".search-select__note");
  const listEl = hostEl.querySelector(".search-select__list");

  // ── Optional portal (R2-2b-ii) ─────────────────────────────────────────────
  // When mounted inside a scrolling / overflow-hidden container (the Filters
  // popup body is overflow-y:auto), an absolutely-positioned panel is CLIPPED by
  // that ancestor. `portal:true` lifts the OPEN panel to <body> (position:fixed,
  // placed under the toggle, repositioned on scroll/resize) so it escapes the
  // clip — the same technique filters.js's wirePortalDropdown uses for the old
  // in-popup dropdowns. Graph callers omit `portal` → this whole block is inert
  // and the control stays byte-identical to before.
  const panelHome = { parent: panelEl.parentNode, next: panelEl.nextSibling };
  let portaled = false;
  function positionPanel() {
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
    // Direction by fit: open below when the panel's natural height fits below;
    // else flip ABOVE when it fits above; else use the roomier side. So a toggle
    // low on the page opens upward instead of running off the bottom of the
    // window (owner R6b/R6c). Height is clamped to the chosen side, with scroll.
    const spaceBelow = window.innerHeight - r.bottom - gap - margin;
    const spaceAbove = r.top - gap - margin;
    let openDown;
    if (spaceBelow >= desired) openDown = true;
    else if (spaceAbove >= desired) openDown = false;
    else openDown = spaceBelow >= spaceAbove;
    if (openDown) {
      panelEl.style.top = `${Math.round(r.bottom + gap)}px`;
      panelEl.style.bottom = "auto";
      panelEl.style.maxHeight = `${Math.max(120, Math.round(spaceBelow))}px`;
    } else {
      panelEl.style.top = "auto";
      panelEl.style.bottom = `${Math.round(window.innerHeight - r.top + gap)}px`;
      panelEl.style.maxHeight = `${Math.max(120, Math.round(spaceAbove))}px`;
    }
    panelEl.style.overflowY = "auto";
  }
  const onPortalScroll = () => { if (portaled) positionPanel(); };
  const onPortalResize = () => { if (portaled) positionPanel(); };
  function portalOpen() {
    if (!portal || portaled) return;
    portaled = true;
    document.body.appendChild(panelEl);
    positionPanel();
    window.addEventListener("scroll", onPortalScroll, true);
    window.addEventListener("resize", onPortalResize);
  }
  function portalClose() {
    if (!portaled) return;
    portaled = false;
    window.removeEventListener("scroll", onPortalScroll, true);
    window.removeEventListener("resize", onPortalResize);
    for (const p of ["position", "zIndex", "minWidth", "top", "left", "right", "bottom", "maxHeight", "overflowY"]) {
      panelEl.style[p] = "";
    }
    if (panelHome.next && panelHome.next.parentNode === panelHome.parent) {
      panelHome.parent.insertBefore(panelEl, panelHome.next);
    } else {
      panelHome.parent.appendChild(panelEl);
    }
  }

  /** Selected values in OPTIONS order (stable, tick-order-independent). */
  function selectedValues() {
    return allOptions.filter((o) => selected.has(o.value)).map((o) => o.value);
  }

  function isRowDisabled(o) {
    if (!o) return true;
    if (o.disabled) return true;
    return !!(isOptionDisabled && isOptionDisabled(o.value, selected));
  }

  function syncToggleLabel() {
    const count = selected.size;
    if (count > 0) {
      valueEl.textContent = summarize(count, allOptions.length);
      valueEl.classList.remove("search-select__value--placeholder");
    } else {
      valueEl.textContent = placeholder;
      valueEl.classList.add("search-select__value--placeholder");
    }
  }

  function syncNote() {
    const text = noteFor ? noteFor(selected) : null;
    if (text) {
      noteEl.textContent = text;
      noteEl.hidden = false;
    } else {
      noteEl.textContent = "";
      noteEl.hidden = true;
    }
  }

  function applyFilter(term) {
    const t = term.trim().toLowerCase();
    filtered = t ? allOptions.filter((o) => o.label.toLowerCase().includes(t)) : allOptions.slice();
  }

  function rowInnerHTML(o) {
    if (renderRow) return renderRow(o);
    return `<span class="search-select__check" aria-hidden="true"></span><span class="search-select__opt-label">${escHtml(o.label)}</span>`;
  }

  function renderList() {
    if (filtered.length === 0) {
      listEl.innerHTML = `<p class="search-select__empty">No matches</p>`;
      filterEl.removeAttribute("aria-activedescendant");
      return;
    }
    listEl.innerHTML = filtered
      .map((o, i) => {
        const isSel = selected.has(o.value);
        const active = i === activeIndex;
        const rowDisabled = isRowDisabled(o);
        return (
          `<div id="${uid}-opt-${i}" class="search-select__option search-select__option--multi${active ? " is-active" : ""}${isSel ? " is-selected" : ""}${rowDisabled ? " is-disabled" : ""}"` +
          ` role="option" aria-selected="${isSel}" data-idx="${i}">${rowInnerHTML(o)}</div>`
        );
      })
      .join("");
    if (activeIndex >= 0 && activeIndex < filtered.length) {
      filterEl.setAttribute("aria-activedescendant", `${uid}-opt-${activeIndex}`);
      const activeEl = listEl.querySelector(".search-select__option.is-active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    } else {
      filterEl.removeAttribute("aria-activedescendant");
    }
    // The list height changes as options/filter change — keep a portaled panel
    // pinned under its toggle (no-op unless portaled).
    if (portaled) positionPanel();
  }

  function open() {
    if (isOpen || disabled) return;
    isOpen = true;
    panelEl.hidden = false;
    toggleEl.setAttribute("aria-expanded", "true");
    filterEl.setAttribute("aria-expanded", "true");
    filterEl.value = "";
    applyFilter("");
    activeIndex = filtered.length ? 0 : -1;
    syncNote();
    renderList();
    portalOpen(); // reparent to <body> BEFORE focus so focus is preserved
    filterEl.focus();
  }

  function close({ focusToggle = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    panelEl.hidden = true;
    toggleEl.setAttribute("aria-expanded", "false");
    filterEl.setAttribute("aria-expanded", "false");
    filterEl.removeAttribute("aria-activedescendant");
    activeIndex = -1;
    portalClose(); // restore the panel to its in-host slot
    if (focusToggle) toggleEl.focus();
  }

  /** Toggle the filtered row at `idx`; the panel STAYS OPEN. No-op on a disabled
   * row (the caller's min/max rule), so the component never violates it. */
  function toggle(idx) {
    const o = filtered[idx];
    if (!o || isRowDisabled(o)) return;
    if (selected.has(o.value)) selected.delete(o.value);
    else selected.add(o.value);
    // Re-render so cap/floor-driven disabled states, the note, and the summary
    // all reflect the new selection immediately (rows stay put — no reorder).
    syncToggleLabel();
    syncNote();
    renderList();
    onChange(selectedValues());
  }

  function moveActive(delta) {
    if (filtered.length === 0) return;
    if (activeIndex === -1) {
      activeIndex = delta > 0 ? 0 : filtered.length - 1;
    } else {
      activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
    }
    renderList();
  }

  // ── Events ──────────────────────────────────────────────────────────────
  function onToggleClick(e) {
    e.stopPropagation();
    if (isOpen) close({ focusToggle: true });
    else open();
  }
  function onToggleKeydown(e) {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      open();
    }
  }
  function onFilterInput() {
    applyFilter(filterEl.value);
    activeIndex = filtered.length ? 0 : -1;
    renderList();
  }
  function onFilterKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0) toggle(activeIndex);
    } else if (e.key === " " || e.key === "Spacebar") {
      // Space toggles ONLY when the filter box is empty (the natural "open →
      // space-tick" flow); once the user is typing a multi-word search it types
      // a space like any text input.
      if (filterEl.value === "" && activeIndex >= 0) {
        e.preventDefault();
        toggle(activeIndex);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      // When portaled inside the Filters popup, keep this Escape from bubbling
      // to the popup's own document-level Escape handler (which would close the
      // whole popup) — first Escape closes just this dropdown, matching the old
      // wirePortalDropdown behaviour. Non-portal (graph) callers are unaffected.
      if (portal) e.stopPropagation();
      close({ focusToggle: true });
    } else if (e.key === "Tab") {
      close();
    }
  }
  function onListClick(e) {
    const row = e.target.closest(".search-select__option");
    if (!row) return;
    // STAY OPEN on toggle: stop this click reaching the document listener.
    // toggle() re-renders the list synchronously, DETACHING the clicked row, so
    // by the time the click bubbled to onDocClick `hostEl.contains(e.target)`
    // would be false (target is now an orphaned node) and it would wrongly
    // close the panel. Stopping propagation keeps in-panel toggles open — the
    // whole point of the multi-select.
    e.stopPropagation();
    toggle(Number(row.dataset.idx));
  }
  function onDocClick(e) {
    if (!isOpen) return;
    // A portaled panel lives on <body>, OUTSIDE hostEl — so also treat clicks
    // within the panel itself as "inside" (harmless when not portaled, since the
    // panel is a hostEl descendant then and hostEl.contains already covers it).
    if (hostEl.contains(e.target) || panelEl.contains(e.target)) return;
    close();
  }

  toggleEl.addEventListener("click", onToggleClick);
  toggleEl.addEventListener("keydown", onToggleKeydown);
  filterEl.addEventListener("input", onFilterInput);
  filterEl.addEventListener("keydown", onFilterKeydown);
  listEl.addEventListener("click", onListClick);
  document.addEventListener("click", onDocClick);

  // Initial paint.
  syncToggleLabel();

  // ── Handle ──────────────────────────────────────────────────────────────
  return {
    setValues(vals) {
      selected = new Set((Array.isArray(vals) ? vals : []).filter((v) => allOptions.some((o) => o.value === v)));
      syncToggleLabel();
      if (isOpen) {
        syncNote();
        renderList();
      }
    },
    getValues() {
      return selectedValues();
    },
    setOptions(opts) {
      allOptions = normalizeOptions(opts);
      // Drop any selection that no longer resolves; callers own any onChange
      // decision (this never fires onChange, matching the single-pick handle).
      selected = new Set([...selected].filter((v) => allOptions.some((o) => o.value === v)));
      syncToggleLabel();
      if (isOpen) {
        applyFilter(filterEl.value);
        activeIndex = filtered.length ? 0 : -1;
        syncNote();
        renderList();
      }
    },
    setInvalid(on) {
      toggleEl.classList.toggle("needs-input", !!on);
    },
    open,
    close,
    destroy() {
      close();
      portalClose(); // idempotent — never leave an orphaned panel on <body>
      toggleEl.removeEventListener("click", onToggleClick);
      toggleEl.removeEventListener("keydown", onToggleKeydown);
      filterEl.removeEventListener("input", onFilterInput);
      filterEl.removeEventListener("keydown", onFilterKeydown);
      listEl.removeEventListener("click", onListClick);
      document.removeEventListener("click", onDocClick);
    },
  };
}
