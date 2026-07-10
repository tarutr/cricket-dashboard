// src/toast.js
//
// Minimal shared toast (B2R wave 3, decision 44c). One honest, low-frequency
// use today: main.js's triggerTableSearch calls showToast() when the
// omnisearch's explicit "Filter the table" action comes back with zero rows
// even though the search text matched a real player elsewhere in the
// database — the table isn't broken, the player is just excluded by the
// current filters, and the empty table alone doesn't say that.
//
// Deliberately tiny by design (no queue, no stacking, no dismiss button): this
// app has exactly one honest case to report today. A second call while a
// toast is showing REPLACES it rather than piling up — if a future feature
// needs a queue, that's a real design decision for whoever adds it, not
// something to speculatively build now.

const AUTO_DISMISS_MS = 4000;

let currentEl = null;
let currentTimer = null;

function ensureHost() {
  let host = document.getElementById("toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "toast-host";
    host.className = "toast-host";
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Show a single toast with `text` at the bottom-center of the viewport,
 * auto-dismissing after 4s. Replaces any toast already showing.
 * `aria-live="polite"` on the host (not the toast itself, so it survives the
 * node being replaced) announces it to screen readers without interrupting
 * whatever the user was doing.
 */
export function showToast(text) {
  const host = ensureHost();
  host.setAttribute("aria-live", "polite");

  if (currentTimer) clearTimeout(currentTimer);
  if (currentEl) currentEl.remove();

  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = text;
  host.appendChild(el);
  currentEl = el;

  currentTimer = setTimeout(() => {
    el.remove();
    if (currentEl === el) currentEl = null;
    currentTimer = null;
  }, AUTO_DISMISS_MS);
}
