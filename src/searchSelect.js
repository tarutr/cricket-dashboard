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

  function normalizeOptions(opts) {
    if (!Array.isArray(opts)) return [];
    return opts.map((o) => (typeof o === "string" ? { value: o, label: o } : o)).filter((o) => o && o.value != null);
  }

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
    if (hostEl.contains(e.target)) return;
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
      toggleEl.removeEventListener("click", onToggleClick);
      toggleEl.removeEventListener("keydown", onToggleKeydown);
      filterEl.removeEventListener("input", onFilterInput);
      filterEl.removeEventListener("keydown", onFilterKeydown);
      listEl.removeEventListener("click", onListClick);
      document.removeEventListener("click", onDocClick);
    },
  };
}
