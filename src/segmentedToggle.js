// src/segmentedToggle.js
//
// Wave F2 (control-harmonisation program, control-audit.md "Exclusive 2-way
// toggle"): the segmented toggle (`.segmented` / `.segmented__btn`, styled in
// styles.css) is the ONE pattern for an exclusive 2-4-option choice. It
// already backs the Stats/Graphs view toggle (index.html + main.js) and the
// player-page Batting/Bowling toggle (playerPage.js) — this module does not
// change either of those (out of this wave's file ownership; see the
// harmonisation plan). It exists so filters.js's Gender + Discipline controls
// (the two remaining native `<select>` outliers the audit flagged) can adopt
// the SAME markup + wiring without hand-rolling a third copy of the
// render/sync/click-delegate trio main.js and playerPage.js each wrote
// independently. If a future wave folds those two into this helper as well,
// there would be exactly one implementation instead of three — noted as a
// Wave S candidate, not done here (this wave only owns filters.js).
//
// Display/interaction only: this module never reads or writes app state — the
// caller's onSelect callback decides what a chosen value means (store.set(...),
// local variable, etc), exactly as the two existing bespoke toggles do.

/** Markup for a segmented toggle. `options` is [{value, label}]. `dataRole`
 * (optional) becomes the wrapping div's `data-role`, so callers can look the
 * element up the same way they would a `<select data-role="...">` — this is
 * what lets filters.js swap `<select>` for this markup without touching its
 * existing `container.querySelector('[data-role="..."]')` lookups. */
export function segmentedToggleHTML(options, { dataRole, ariaLabel = "" } = {}) {
  const roleAttr = dataRole ? ` data-role="${dataRole}"` : "";
  const ariaAttr = ariaLabel ? ` aria-label="${ariaLabel}"` : "";
  return `<div class="segmented"${roleAttr} role="group"${ariaAttr}>
    ${options
      .map((o) => `<button type="button" class="segmented__btn" data-value="${o.value}">${o.label}</button>`)
      .join("")}
  </div>`;
}

/** Wire a rendered segmented toggle (`el` = the `.segmented` wrapper from
 * segmentedToggleHTML above). `onSelect(value)` fires on click of ANY button,
 * including the already-active one — callers that need the native-`<select>`
 * "change" semantics (no-op on re-picking the current value) should guard for
 * that themselves, exactly as a `<select>`'s change handler would need to if
 * it cared. Returns `{ sync(value) }` so the caller can re-highlight the
 * active button after external state changes (a full form render(), an
 * onDisciplineChanged callback elsewhere, etc) without re-wiring the click
 * listener. */
export function wireSegmentedToggle(el, onSelect) {
  function sync(value) {
    el.querySelectorAll(".segmented__btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === value);
    });
  }
  el.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented__btn");
    if (!btn) return;
    onSelect(btn.dataset.value);
  });
  return { sync };
}
